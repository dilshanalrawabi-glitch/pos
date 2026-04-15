import base64

from flask import Flask, Response, jsonify, request, send_file
from flask_cors import CORS
import os
import sys
from pathlib import Path

_backend_root = Path(__file__).resolve().parent
try:
    from dotenv import load_dotenv
    load_dotenv(_backend_root / '.env')
except ImportError:
    pass

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    _CRYPTOGRAPHY_AVAILABLE = True
except ImportError:
    _CRYPTOGRAPHY_AVAILABLE = False

# Import oracledb (thick mode required for Oracle server versions not supported in thin mode).
# If you see "DLL load failed... Application Control policy has blocked", unblock the Oracle
# Instant Client path in Windows Security / Application Control, or run where it is allowed.
try:
    import oracledb
except ImportError as e:
    if "thick_impl" in str(e) or "DLL" in str(e):
        sys.exit(
            "Oracle thick mode failed to load (often due to Windows Application Control blocking the DLL).\n"
            "Your database server requires thick mode (DPY-3010). Either:\n"
            "  1) Unblock Oracle Instant Client in Windows Security / Application Control, or\n"
            "  2) Run this app on a machine where the Instant Client is allowed.\n"
            "Set ORACLE_CLIENT_LIB_DIR in backend/.env to your Instant Client folder (the one that contains oci.dll)."
        )
    raise

import bcrypt
import datetime
import difflib
import jwt

app = Flask(__name__)
# Enable CORS for all routes with proper configuration
CORS(app, resources={
    r"/api/*": {
        "origins": "*",
        "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization"]
    }
})
# Ensure CORS headers on every response (including 500 errors)
@app.after_request
def add_cors_after(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return response


@app.errorhandler(500)
def handle_500(err):
    print(f"[Server] 500 error: {err}")
    return jsonify({"error": "Internal server error", "message": str(err)}), 500


app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'pos-secret-key-change-in-production')

# Role from APPLICATIONUSER.ROLECODE: 1=IT (full), 2=Supervisor (Billing+CounterOpen), 3=Cashier (Billing only)
ROLE_CODE_TO_NAME = {1: 'it', 2: 'supervisor', 3: 'cashier'}


class OracleAuthError(Exception):
    """Oracle unreachable or query failed during auth — not the same as wrong password."""
    pass


def _hash(pw):
    return bcrypt.hashpw(pw.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def _decode_arabic_from_db(s):
    """Fix Arabic mojibake: text stored in DB as Windows-1256 (Arabic) but read as Latin-1."""
    if s is None or not isinstance(s, str):
        return s
    s = s.strip()
    if not s:
        return s
    try:
        return s.encode('iso-8859-1').decode('cp1256')
    except (UnicodeDecodeError, UnicodeEncodeError, LookupError):
        return s


# Demo users for local/dev when Oracle is unavailable. Try: admin/admin (IT), supervisor/supervisor, cashier/cashier
_demo_users = {
    'admin': {'password': _hash('admin'), 'role': 'it', 'userid': 'admin', 'name': 'Admin', 'alt_password': 'password'},
    'supervisor': {'password': _hash('supervisor'), 'role': 'supervisor', 'userid': 'supervisor', 'name': 'Supervisor', 'alt_password': 'password'},
    'cashier': {'password': _hash('cashier'), 'role': 'cashier', 'userid': 'cashier', 'name': 'Cashier', 'alt_password': 'password'},
    '1': {'password': _hash('password'), 'role': 'cashier', 'userid': '1', 'name': 'User 1'},
}
# Admin-created users (in-memory; code -> {password, role, userid, name})
_added_users = {}


def _get_user_by_code(code):
    code = (code or '').strip().lower()
    if not code:
        return None
    if code in _demo_users:
        return _demo_users[code]
    if code in _added_users:
        return _added_users[code]
    return None


def _verify_demo_user(employeecode, password):
    code = (employeecode or '').strip().lower()
    if not code or not (password or '').strip():
        return None
    u = _get_user_by_code(code)
    if not u:
        return None
    pw = (password or '').strip()
    stored = u.get('password')
    if stored:
        try:
            stored_b = stored.encode('utf-8') if isinstance(stored, str) else stored
            if bcrypt.checkpw(pw.encode('utf-8'), stored_b):
                return {'username': code, 'role': u['role'], 'userid': u.get('userid') or code}
        except Exception:
            pass
    if pw == u.get('alt_password', ''):
        return {'username': code, 'role': u['role'], 'userid': u.get('userid') or code}
    return None


def _encode_token(username, role, userid=None):
    payload = {'sub': username, 'role': role, 'exp': datetime.datetime.utcnow() + datetime.timedelta(hours=24)}
    if userid is not None:
        payload['userid'] = userid
    return jwt.encode(payload, app.config['SECRET_KEY'], algorithm='HS256')


def _decode_token(auth_header):
    if not auth_header or not auth_header.startswith('Bearer '):
        return None
    try:
        return jwt.decode(
            auth_header[7:].strip(),
            app.config['SECRET_KEY'],
            algorithms=['HS256']
        )
    except Exception:
        return None

# Oracle: override with ORACLE_USER, ORACLE_PASSWORD, ORACLE_DSN, ORACLE_CLIENT_LIB_DIR (backend/.env or environment).
ORACLE_CONFIG = {
    'user': (os.environ.get('ORACLE_USER') or 'RFSR').strip(),
    'password': os.environ.get('ORACLE_PASSWORD') or 'rfsr',
    'dsn': (os.environ.get('ORACLE_DSN') or '192.168.1.225:1521/rgc').strip(),
}

# Thick mode: lib_dir from env, else Instant Client on PATH (typical Windows install).
_oracle_lib = (os.environ.get('ORACLE_CLIENT_LIB_DIR') or '').strip()
try:
    if _oracle_lib:
        oracledb.init_oracle_client(lib_dir=_oracle_lib)
    else:
        oracledb.init_oracle_client()
    print("Oracle Thick mode initialized successfully.")
except oracledb.Error as err:
    print(f"Thick mode init failed: {err}")
    if not _oracle_lib:
        print("Hint: set ORACLE_CLIENT_LIB_DIR in backend/.env to the folder containing oci.dll")

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({"status": "ok"})


def _resolve_launcher_exe_path():
    """Path to built launcher exe for GET /downloads/PS_LAUNCHER.exe (login page link)."""
    env = (os.environ.get('LAUNCHER_EXE_PATH') or '').strip()
    if env:
        p = Path(env)
        if p.is_file():
            return p
    dist = _backend_root.parent / 'launcher' / 'dist'
    # PyInstaller name= 'PS LAUNCHER' -> "PS LAUNCHER.exe"; allow underscore variant too
    for name in ('PS LAUNCHER.exe', 'PS_LAUNCHER.exe'):
        candidate = dist / name
        if candidate.is_file():
            return candidate
    return None


@app.route('/downloads/PS_LAUNCHER.exe', methods=['GET'])
def download_ps_launcher():
    path = _resolve_launcher_exe_path()
    if not path:
        return jsonify({
            'error': 'Launcher not available',
            'hint': 'Build the launcher (launcher/dist) or set LAUNCHER_EXE_PATH in backend/.env',
        }), 404
    return send_file(
        path,
        as_attachment=True,
        download_name=path.name,
        mimetype='application/octet-stream',
    )


# QZ Tray signing files (same folder as backend; used by Settings download buttons).
_QZ_CERT_FILES = {
    'digital-certificate': ('digital-certificate.txt', 'text/plain'),
    'private-key': ('private-key.pem', 'application/x-pem-file'),
}


def _require_auth_qz_certs():
    """Bearer JWT; same roles as POS Settings (it / manager / admin)."""
    auth = request.headers.get('Authorization') or ''
    payload = _decode_token(auth)
    if not payload:
        return None, (jsonify({"error": "Invalid or missing token"}), 401)
    role = str(payload.get('role') or '').lower()
    if role not in ('it', 'manager', 'admin'):
        return None, (jsonify({"error": "Forbidden"}), 403)
    return payload, None


@app.route('/api/qz-certs/<string:name>', methods=['GET', 'OPTIONS'])
def download_qz_cert(name):
    """Download QZ Tray digital certificate or private key from backend/certs/."""
    if request.method == 'OPTIONS':
        return '', 200
    _err = _require_auth_qz_certs()
    if _err[1] is not None:
        return _err[1]
    entry = _QZ_CERT_FILES.get(name)
    if not entry:
        return jsonify({"error": "Unknown file"}), 404
    filename, mimetype = entry
    path = _backend_root / 'certs' / filename
    if not path.is_file():
        return jsonify({"error": "File not available on server", "path": filename}), 404
    return send_file(
        path,
        as_attachment=True,
        download_name=filename,
        mimetype=mimetype,
    )


def _qz_sign_message(message: str) -> str:
    """RSA PKCS#1 v1.5 signature (SHA-512) over UTF-8 bytes of `message` (QZ Tray passes a SHA-256 hex digest string)."""
    if not _CRYPTOGRAPHY_AVAILABLE:
        raise RuntimeError('cryptography package not installed')
    key_path = _backend_root / 'certs' / 'private-key.pem'
    if not key_path.is_file():
        raise FileNotFoundError(str(key_path))
    with open(key_path, 'rb') as f:
        pem = f.read()
    key = serialization.load_pem_private_key(pem, password=None)
    sig = key.sign(
        message.encode('utf-8'),
        padding.PKCS1v15(),
        hashes.SHA512(),
    )
    return base64.b64encode(sig).decode('ascii')


@app.route('/api/qz-tray/certificate', methods=['GET', 'OPTIONS'])
def qz_tray_public_certificate():
    """Public PEM for QZ Tray `setCertificatePromise` (same file as Settings download)."""
    if request.method == 'OPTIONS':
        return '', 200
    path = _backend_root / 'certs' / 'digital-certificate.txt'
    if not path.is_file():
        return jsonify({"error": "Certificate not available on server"}), 404
    return send_file(path, mimetype='text/plain')


@app.route('/api/qz-tray/sign', methods=['POST', 'OPTIONS'])
def qz_tray_sign():
    """Sign QZ Tray websocket payloads with private-key.pem (any logged-in POS user)."""
    if request.method == 'OPTIONS':
        return '', 200
    auth = request.headers.get('Authorization') or ''
    if not _decode_token(auth):
        return jsonify({"error": "Invalid or missing token"}), 401
    if not _CRYPTOGRAPHY_AVAILABLE:
        return jsonify({"error": "Server signing unavailable (install cryptography)"}), 503
    data = request.get_json(silent=True) or {}
    to_sign = data.get('request')
    if to_sign is None:
        to_sign = request.get_data(as_text=True) or ''
    if isinstance(to_sign, (dict, list)):
        return jsonify({"error": "Invalid request"}), 400
    to_sign = str(to_sign)
    try:
        sig_b64 = _qz_sign_message(to_sign)
    except FileNotFoundError as e:
        return jsonify({"error": "Private key not configured", "detail": str(e)}), 503
    except Exception as e:
        print(f"[QZ] sign error: {e}")
        return jsonify({"error": "Signing failed"}), 500
    return Response(sig_b64, mimetype='text/plain')


def _verify_application_user(employeecode, password):
    """Validate against APPLICATIONUSER: employeecode and password only."""
    if not (employeecode and employeecode.strip()) or not password:
        return None
    employeecode = employeecode.strip()
    connection = None
    cursor = None
    try:
        connection = oracledb.connect(
            user=ORACLE_CONFIG['user'],
            password=ORACLE_CONFIG['password'],
            dsn=ORACLE_CONFIG['dsn']
        )
        cursor = connection.cursor()
        try:
            query = """
                SELECT employeecode, password, rolecode, userid, store
                FROM APPLICATIONUSER
                WHERE UPPER(TRIM(employeecode)) = UPPER(:empcode)
            """
            cursor.execute(query, empcode=employeecode)
        except oracledb.Error as e:
            if 'ORA-00904' in str(e).upper() or '00904' in str(e).upper():
                query = """
                    SELECT employeecode, password, rolecode, userid
                    FROM APPLICATIONUSER
                    WHERE UPPER(TRIM(employeecode)) = UPPER(:empcode)
                """
                cursor.execute(query, empcode=employeecode)
            else:
                raise
        row = cursor.fetchone()
        if not row:
            return None
        columns = [col[0] for col in cursor.description]
        rec = dict(zip(columns, row))
        store = rec.get('STORE') or rec.get('store')
        if store is not None:
            store = str(store).strip() or None
        stored_pw = rec.get('PASSWORD') or rec.get('password') or ''
        rolecode = rec.get('ROLECODE') or rec.get('rolecode')
        emp_code = rec.get('EMPLOYEECODE') or rec.get('employeecode') or employeecode
        userid = rec.get('USERID') or rec.get('userid') or emp_code
        if rolecode is not None:
            try:
                rolecode = int(rolecode)
            except (TypeError, ValueError):
                rolecode = 0
        else:
            rolecode = 0
        role_name = ROLE_CODE_TO_NAME.get(rolecode, 'user')
        if not stored_pw:
            return None
        stored_b = stored_pw.encode('utf-8') if isinstance(stored_pw, str) else (stored_pw or b'')
        try:
            if bcrypt.checkpw(password.encode('utf-8'), stored_b):
                out = {'username': str(emp_code).strip(), 'role': role_name, 'userid': str(userid).strip()}
                if store is not None:
                    out['store'] = store
                return out
        except Exception:
            pass
        if (password or '') == (stored_pw or ''):
            out = {'username': str(emp_code).strip(), 'role': role_name, 'userid': str(userid).strip()}
            if store is not None:
                out['store'] = store
            return out
        return None
    except oracledb.Error as e:
        print(f"Oracle login error: {e}")
        raise OracleAuthError(str(e)) from e
    finally:
        if cursor:
            try:
                cursor.close()
            except Exception:
                pass
        if connection:
            try:
                connection.close()
            except Exception:
                pass


def _oracle_cell_to_plain(val):
    """CLOB/BLOB or scalars -> string-safe value for LOCATIONMASTER row."""
    if val is None:
        return None
    if hasattr(val, 'read'):
        try:
            return val.read()
        except Exception:
            return str(val)
    return val


def _is_meaningful_phone_string(s):
    if s is None:
        return False
    t = str(s).strip()
    if len(t) < 4:
        return False
    if t.upper() in ('NA', 'N/A', '-', '--', 'NIL', 'NONE'):
        return False
    return True


def _extract_telephone_from_locationmaster_row(rec):
    """Pick the best non-empty phone from a LOCATIONMASTER row (handles varying column names).

    Many DBs store the number in MOBILE while TELEPHONE is empty; older code only read TELEPHONE.
    """
    if not rec:
        return ''
    upper_map = {}
    for k, v in rec.items():
        if k is None:
            continue
        ku = str(k).upper().strip()
        v = _oracle_cell_to_plain(v)
        upper_map[ku] = v

    # Priority: specific names first (MOBILE before generic PHONE when both exist)
    priority = (
        'MOBILE', 'MOBILENO', 'MOBILE_NO', 'MOBILEPHONE', 'MOBILENUMBER', 'MOB',
        'TELEPHONE', 'TELEPHONE1', 'TELEPHONE2', 'TEL_NO', 'TELNO', 'TEL',
        'PHONE', 'PHONENO', 'PHONENUMBER', 'PHONE_NO', 'PHONENUMBER1',
        'CONTACTNO', 'CONTACTNUMBER', 'CONTACT_NO', 'CONTACTPHONE', 'CONTACT',
        'GSM', 'CELL', 'CELLNO', 'CELL_NO', 'WHATSAPP',
    )
    for name in priority:
        v = upper_map.get(name)
        if v is None:
            continue
        s = str(v).strip()
        if _is_meaningful_phone_string(s):
            return s

    # Heuristic by column name (skip address/geo false positives)
    skip_name = ('POST', 'ZIP', 'LAT', 'LON', 'LONG', 'EMAIL', 'WEB', 'URL')
    candidates = []
    for ku, v in upper_map.items():
        if v is None:
            continue
        if any(x in ku for x in skip_name):
            continue
        s = str(_oracle_cell_to_plain(v)).strip()
        if not _is_meaningful_phone_string(s):
            continue
        if any(x in ku for x in ('MOBILE', 'TELEPHONE', 'PHONE', 'PHONENO', 'TELNO', 'CELL', 'GSM', 'CONTACT', 'WHATSAPP')):
            candidates.append((ku, s))
    if candidates:
        for prefer in ('MOBILE', 'TELEPHONE', 'PHONE', 'PHONENO', 'TEL', 'CELL'):
            for ku, s in candidates:
                if prefer in ku:
                    return s
        return candidates[0][1]

    # Last resort: FAX column only if nothing else matched
    for ku, v in upper_map.items():
        if v is None or 'FAX' not in ku:
            continue
        s = str(_oracle_cell_to_plain(v)).strip()
        if _is_meaningful_phone_string(s):
            return s
    return ''


def _get_base_location():
    """Fetch LOCATIONCODE, LOCATIONNAME, telephone from LOCATIONMASTER where BASELOCATIONFLAG = 'Y'.

    Uses SELECT * so every phone-related column is available; value chosen by _extract_telephone_from_locationmaster_row.
    """
    connection = None
    cursor = None
    where = "WHERE UPPER(TRIM(NVL(BASELOCATIONFLAG, 'N'))) = 'Y'"
    query = f"SELECT * FROM LOCATIONMASTER {where}"
    try:
        connection = oracledb.connect(
            user=ORACLE_CONFIG['user'],
            password=ORACLE_CONFIG['password'],
            dsn=ORACLE_CONFIG['dsn']
        )
        cursor = connection.cursor()
        cursor.execute(query)
        row = cursor.fetchone()
        if not row:
            return None
        columns = [col[0] for col in cursor.description]
        rec = {}
        for i, col in enumerate(columns):
            rec[col] = _oracle_cell_to_plain(row[i])
        loc_code = rec.get('LOCATIONCODE') or rec.get('locationcode')
        loc_name = rec.get('LOCATIONNAME') or rec.get('locationname')
        if loc_code is None and loc_name is None:
            return None
        tel = _extract_telephone_from_locationmaster_row(rec)
        if not tel:
            try:
                keys = sorted(rec.keys())
                print(f"[LOCATIONMASTER] Base row loaded but no phone parsed. Column names: {keys}")
            except Exception:
                pass
        return {
            'locationCode': str(loc_code).strip() if loc_code is not None else '',
            'locationName': str(loc_name).strip() if loc_name is not None else '',
            'telephone': tel,
        }
    except oracledb.Error as e:
        print(f"LOCATIONMASTER fetch error: {e}")
        return None
    finally:
        if cursor:
            try:
                cursor.close()
            except Exception:
                pass
        if connection:
            try:
                connection.close()
            except Exception:
                pass


def _get_locationmaster_location_name(cur, location_code):
    """Return LOCATIONMASTER.LOCATIONNAME for the given LOCATIONCODE (e.g. customer back display heading)."""
    if not location_code:
        return ''
    lc = str(location_code).strip()
    if not lc:
        return ''
    try:
        cur.execute(
            """
            SELECT LOCATIONNAME FROM LOCATIONMASTER
            WHERE UPPER(TRIM(LOCATIONCODE)) = UPPER(TRIM(:lc))
            AND ROWNUM = 1
            """,
            {"lc": lc},
        )
        row = cur.fetchone()
        if row and row[0] is not None:
            return str(_oracle_cell_to_plain(row[0])).strip()
    except oracledb.Error:
        pass
    return ''


@app.route('/api/login', methods=['POST', 'OPTIONS'])
def login():
    if request.method == 'OPTIONS':
        return '', 200
    # force=True: parse JSON even if a proxy strips or changes Content-Type (avoids empty body -> 401).
    data = request.get_json(silent=True, force=True) or {}
    employeecode = (data.get('username') or data.get('employeecode') or '').strip()
    password = data.get('password') or ''
    user = _verify_demo_user(employeecode, password)
    if user is None:
        try:
            user = _verify_application_user(employeecode, password)
        except OracleAuthError:
            return jsonify({
                "error": "Sign-in service unavailable (database not reachable). Contact IT or run the backend on the same network as Oracle."
            }), 503
    if not user:
        return jsonify({"error": "Invalid employee code or password"}), 401
    token = _encode_token(user['username'], user['role'], user.get('userid'))
    # Fetch base location from LOCATIONMASTER (BASELOCATIONFLAG = 'Y')
    location = _get_base_location()
    payload = {
        "token": token,
        "user": {
            "username": user['username'],
            "role": user['role'],
            "userid": user.get('userid') or user['username']
        },
        "location": location
    }
    if user.get('store') is not None:
        payload["store"] = user.get('store')
    return jsonify(payload)


@app.route('/api/validate-supervisor', methods=['POST', 'OPTIONS'])
def validate_supervisor():
    """Validate username/password and require APPLICATIONUSER rolecode = 2 (Supervisor). Returns 200 if allowed, 401/403 otherwise."""
    if request.method == 'OPTIONS':
        return '', 200
    data = request.get_json(silent=True, force=True) or {}
    employeecode = (data.get('username') or data.get('employeecode') or '').strip()
    password = data.get('password') or ''
    user = _verify_demo_user(employeecode, password)
    if user is None:
        try:
            user = _verify_application_user(employeecode, password)
        except OracleAuthError:
            return jsonify({
                "error": "Sign-in service unavailable (database not reachable). Contact IT."
            }), 503
    if not user:
        return jsonify({"error": "Invalid username or password"}), 401
    role = (user.get('role') or '').strip().lower()
    if role != 'supervisor':
        return jsonify({"error": "Only Supervisor (rolecode 2) can perform this action"}), 403
    return jsonify({"ok": True})


@app.route('/api/me', methods=['GET', 'OPTIONS'])
def me():
    if request.method == 'OPTIONS':
        return '', 200
    auth = request.headers.get('Authorization') or ''
    if not auth.startswith('Bearer '):
        return jsonify({"error": "Missing or invalid authorization"}), 401
    try:
        payload = jwt.decode(
            auth[7:],
            app.config['SECRET_KEY'],
            algorithms=['HS256']
        )
        out = {
            "user": {
                "username": payload.get('sub'),
                "role": payload.get('role'),
                "userid": payload.get('userid') or payload.get('sub')
            }
        }
        # Refresh LOCATIONMASTER (incl. telephone) on each session check — fixes stale localStorage after DB updates
        loc = _get_base_location()
        if loc:
            out["location"] = loc
        return jsonify(out)
    except jwt.ExpiredSignatureError:
        return jsonify({"error": "Token expired"}), 401
    except jwt.InvalidTokenError:
        return jsonify({"error": "Invalid token"}), 401


def _require_manager():
    """Require IT or manager role for admin APIs (users, etc.)."""
    auth = request.headers.get('Authorization') or ''
    payload = _decode_token(auth)
    if not payload:
        return None, (jsonify({"error": "Invalid or missing token"}), 401)
    role = (payload.get('role') or '').lower()
    if role not in ('manager', 'it'):
        return None, (jsonify({"error": "Manager or IT role required"}), 403)
    return payload, None


@app.route('/api/users', methods=['GET'])
def list_users():
    payload, err = _require_manager()
    if err:
        return err
    users = []
    for code, u in _demo_users.items():
        users.append({
            'code': code,
            'name': u.get('name') or code,
            'role': u.get('role') or 'user',
            'userid': u.get('userid') or code,
            'source': 'system',
        })
    for code, u in _added_users.items():
        users.append({
            'code': code,
            'name': u.get('name') or code,
            'role': u.get('role') or 'user',
            'userid': u.get('userid') or code,
            'source': 'added',
        })
    return jsonify(users)


@app.route('/api/users', methods=['POST'])
def add_user():
    payload, err = _require_manager()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    name = (data.get('name') or '').strip()
    code = (data.get('code') or data.get('employeecode') or '').strip()
    role = (data.get('role') or 'cashier').strip().lower()
    password = data.get('password') or ''
    if not code:
        return jsonify({"error": "Code (employee code) is required"}), 400
    if not password:
        return jsonify({"error": "Password is required"}), 400
    if role not in ('it', 'manager', 'supervisor', 'cashier', 'user'):
        role = 'cashier'
    code_lower = code.lower()
    if code_lower in _demo_users or code_lower in _added_users:
        return jsonify({"error": "User with this code already exists"}), 409
    _added_users[code_lower] = {
        'password': _hash(password),
        'role': role,
        'userid': code,
        'name': name or code,
    }
    return jsonify({
        'code': code_lower,
        'name': name or code,
        'role': role,
        'userid': code,
    }), 201


@app.route('/api/customers', methods=['GET'])
def get_customers():
    try:
        # Establish connection
        connection = oracledb.connect(
            user=ORACLE_CONFIG['user'],
            password=ORACLE_CONFIG['password'],
            dsn=ORACLE_CONFIG['dsn']
        )
        cursor = connection.cursor()
        
        # Execute Query
        query = """
            SELECT 
                c.locationcode, 
                c.customercode, 
                c.customercode || ' ' || c.customername AS cust_full_name, 
                g.categoryname,
                c.flag,
                c.invoicecode,
                c.currentcreditamount,
                c.creditlimit,
                NVL(c.points, 0) AS points,
                NVL(TRIM(c.mobile), '') AS mobile
            FROM customer c
            INNER JOIN (SELECT DISTINCT customercode FROM billhdrhistory) b 
                ON c.customercode = b.customercode
            INNER JOIN tblcustomercategory g 
                ON c.customercategory = g.categorycode
        """
        cursor.execute(query)
        
        # Fetch rows and column names
        columns = [col[0] for col in cursor.description]
        rows = cursor.fetchall()
        
        # Convert to list of dicts
        results = []
        for row in rows:
            results.append(dict(zip(columns, row)))
            
        return jsonify(results)
        
    except oracledb.Error as e:
        print(f"Oracle Connection Error: {e}")
        # Fallback to mock data for development
        mock_data = [
            {
                "LOCATIONCODE": "001",
                "CUSTOMERCODE": "C001",
                "CUST_FULL_NAME": "C001 JOHN DOE",
                "CATEGORYNAME": "RETAIL",
                "FLAG": "A",
                "INVOICECODE": None,
                "CURRENTCREDITAMOUNT": 0,
                "CREDITLIMIT": 1000,
                "POINTS": 0,
                "MOBILE": "0771234567"
            },
            {
                "LOCATIONCODE": "001",
                "CUSTOMERCODE": "C002",
                "CUST_FULL_NAME": "C002 JANE SMITH",
                "CATEGORYNAME": "WHOLESALE",
                "FLAG": "A",
                "INVOICECODE": None,
                "CURRENTCREDITAMOUNT": 0,
                "CREDITLIMIT": 5000,
                "POINTS": 0,
                "MOBILE": "0779876543"
            }
        ]
        return jsonify(mock_data)
    finally:
        if 'cursor' in locals():
            cursor.close()
        if 'connection' in locals():
            connection.close()


@app.route('/api/customers/balance', methods=['GET'])
def get_customer_balance():
    """Fetch latest CURRENTCREDITAMOUNT, CREDITLIMIT and points for a customer by customerCode."""
    customer_code = (request.args.get('customerCode') or request.args.get('customer_code') or '').strip()
    if not customer_code:
        return jsonify({"error": "customerCode required", "currentCreditAmount": 0, "creditLimit": 0, "points": 0}), 400
    conn = _get_connection()
    if not conn:
        return jsonify({"currentCreditAmount": 0, "creditLimit": 0, "points": 0})
    cur = None
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT NVL(c.currentcreditamount, 0) AS currentcreditamount,
                   NVL(c.creditlimit, 0) AS creditlimit,
                   NVL(c.points, 0) AS points
            FROM customer c
            WHERE TRIM(c.customercode) = TRIM(:custcode)
            AND ROWNUM = 1
            """,
            {"custcode": customer_code}
        )
        row = cur.fetchone()
        if row:
            return jsonify({
                "currentCreditAmount": _to_float(row[0], 0.0),
                "creditLimit": _to_float(row[1], 0.0),
                "points": _to_int(row[2], 0) if len(row) > 2 else 0,
            })
        return jsonify({"currentCreditAmount": 0, "creditLimit": 0, "points": 0})
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00904' in err_str or '00904' in err_str:
            try:
                cur.execute(
                    """
                    SELECT NVL(c.currentcreditamount, 0) AS currentcreditamount, NVL(c.creditlimit, 0) AS creditlimit
                    FROM customer c
                    WHERE TRIM(c.customercode) = TRIM(:custcode)
                    AND ROWNUM = 1
                    """,
                    {"custcode": customer_code}
                )
                row = cur.fetchone()
                if row:
                    return jsonify({
                        "currentCreditAmount": _to_float(row[0], 0.0),
                        "creditLimit": _to_float(row[1], 0.0),
                        "points": 0,
                    })
            except oracledb.Error:
                pass
        print(f"[CustomerBalance] error: {e}")
        return jsonify({"currentCreditAmount": 0, "creditLimit": 0, "points": 0})
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


# Format for Oracle TO_CHAR on numbers to avoid scientific notation (e.g. long barcodes)
_ORACLE_NUM_FMT = "FM99999999999999999999999999999999999999"


def _is_category_eligible_for_price(cur, category_code):
    """
    Check CATEGORY table: CODE = category_code, FLAG = 'C', CATEGORYTYPE = 'G'.
    Returns True if such a row exists (price may be shown); False otherwise.
    If CATEGORY table or columns do not exist, returns False.
    """
    if not category_code or not str(category_code).strip():
        return False
    cat = str(category_code).strip()
    try:
        cur.execute("""
            SELECT 1 FROM CATEGORY
            WHERE UPPER(TRIM(NVL(CODE, ' '))) = UPPER(:code)
              AND UPPER(TRIM(NVL(FLAG, ' '))) = 'C'
              AND UPPER(TRIM(NVL(CATEGORYTYPE, ' '))) = 'G'
            AND ROWNUM = 1
        """, code=cat)
        return cur.fetchone() is not None
    except oracledb.Error:
        try:
            cur.execute("""
                SELECT 1 FROM CATEGORY
                WHERE TRIM(CODE) = TRIM(:code) AND TRIM(FLAG) = 'C' AND TRIM(CATEGORYTYPE) = 'G'
                AND ROWNUM = 1
            """, code=cat)
            return cur.fetchone() is not None
        except oracledb.Error:
            return False


def _is_category_type_h(cur, category_code):
    """
    Check CATEGORY table: CODE = category_code, CATEGORYTYPE = 'H' (vegetable/meat weighted).
    Returns True if such a row exists; False otherwise.
    """
    if not category_code or not str(category_code).strip():
        return False
    cat = str(category_code).strip()
    try:
        cur.execute("""
            SELECT 1 FROM CATEGORY
            WHERE UPPER(TRIM(NVL(CODE, ' '))) = UPPER(:code)
              AND UPPER(TRIM(NVL(CATEGORYTYPE, ' '))) = 'H'
            AND ROWNUM = 1
        """, code=cat)
        return cur.fetchone() is not None
    except oracledb.Error:
        try:
            cur.execute("""
                SELECT 1 FROM CATEGORY
                WHERE TRIM(CODE) = TRIM(:code) AND TRIM(CATEGORYTYPE) = 'H'
                AND ROWNUM = 1
            """, code=cat)
            return cur.fetchone() is not None
        except oracledb.Error:
            return False


def get_price_after_category_check(cur, category_code, price_value, from_itemmaster_or_alternate):
    """
    When price is fetched and the item comes from ITEMMASTER or ITEMALTERNATEUOMMAP,
    only show price if CATEGORY has CODE = category_code, FLAG = 'C', CATEGORYTYPE = 'G'.
    Returns price_value if eligible, else None (do not show price).
    If from_itemmaster_or_alternate is False, returns price_value unchanged.
    """
    if not from_itemmaster_or_alternate:
        return price_value
    if not _is_category_eligible_for_price(cur, category_code):
        return None
    return price_value


def _truncate_2dp(x):
    """Truncate toward zero to 2 decimal places (e.g. 2.678 → 2.67), not round."""
    try:
        xf = float(x)
    except (TypeError, ValueError):
        return x
    return int(xf * 100) / 100.0


def _round_qty_for_db(x, ndp=6):
    """Round quantity for DB binds (half-up to ndp decimals). ITEMLOG / bill journal lines use ndp=3 for display-style qty (e.g. 1.024)."""
    try:
        return round(float(x), int(ndp))
    except (TypeError, ValueError):
        return 0.0


def _line_is_weighted_veg_meat(it):
    """Vegetable/meat (sold by weight). Lookup sets isWeightedItem; cart may carry WEIGHTKG from barcode (price/price-per-kg)."""
    if not it or not isinstance(it, dict):
        return False
    return bool(
        it.get('isWeightedItem')
        or it.get('IS_WEIGHTED_ITEM')
        or it.get('is_weighted_item')
        or it.get('weighted')
    )


def _try_vegetable_meat_barcode(cur, code):
    """
    Vegetable/meat barcode: first 7 characters = manufacturer ID (PLU lookup in ITEMMASTER/ITEMALTERNATEUOMMAP).
    Remainder digits = total price (e.g. 015596 → 15.596, i.e. remainder/1000); truncated to 2 dp (15.59).
    Quantity = weight in kg = price_from_barcode / unit_price_per_kg (rounded to 6 dp for DB/cart parity).
    Item must have category with CATEGORYTYPE = 'H'.
    Returns (result_dict, weight_kg, unit_price_per_kg) or (None, None, None).
    """
    code_str = (code or '').strip().replace(' ', '')
    if len(code_str) < 8:
        return None, None, None
    prefix_7 = code_str[:7]
    remainder_str = code_str[7:].strip()
    if not remainder_str or not remainder_str.isdigit():
        return None, None, None
    try:
        price_from_barcode = _truncate_2dp(int(remainder_str) / 1000.0)
    except ValueError:
        return None, None, None
    if price_from_barcode <= 0:
        return None, None, None

    row = None
    from_alternate = False
    alt_retailprice = None
    try:
        cur.execute(f"""
            SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid, baseuom, prevamount
            FROM itemmaster
            WHERE (UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) OR (manufacturerid IS NOT NULL AND TRIM(TO_CHAR(manufacturerid, '{_ORACLE_NUM_FMT}')) = TRIM(:code)))
            AND ROWNUM = 1
        """, code=prefix_7)
        row = cur.fetchone()
    except oracledb.Error:
        try:
            cur.execute("""
                SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid, baseuom, prevamount
                FROM itemmaster
                WHERE TRIM(itemcode) = TRIM(:code) OR TRIM(manufacturerid) = TRIM(:code)
                AND ROWNUM = 1
            """, code=prefix_7)
            row = cur.fetchone()
        except oracledb.Error:
            pass
    if not row:
        itemcode_alt, loc_alt, alt_retailprice, alt_uom, _ = _resolve_itemcode_location_from_alternate(cur, prefix_7)
        if itemcode_alt:
            from_alternate = True
            try:
                if loc_alt:
                    cur.execute("""
                        SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid, baseuom, prevamount
                        FROM itemmaster
                        WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:ic) AND (UPPER(TRIM(TO_CHAR(locationcode))) = UPPER(:lc) OR TRIM(locationcode) = TRIM(:lc))
                        AND ROWNUM = 1
                    """, ic=itemcode_alt, lc=loc_alt)
                else:
                    cur.execute("""
                        SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid, baseuom, prevamount
                        FROM itemmaster
                        WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1
                    """, code=itemcode_alt)
                row = cur.fetchone()
            except oracledb.Error:
                pass
    if not row:
        return None, None, None
    columns = [col[0] for col in cur.description]
    result = dict(zip(columns, row))
    category_code = result.get('CATEGORYCODE') or result.get('categorycode')
    if not _is_category_type_h(cur, category_code):
        return None, None, None
    unit_price = result.get('RETAILPRICE') or result.get('retailprice')
    if from_alternate and alt_retailprice is not None:
        unit_price = alt_retailprice
    try:
        unit_price_f = float(unit_price)
    except (TypeError, ValueError):
        return None, None, None
    if unit_price_f <= 0:
        return None, None, None
    weight_kg = _round_qty_for_db(price_from_barcode / unit_price_f, 6)
    return result, weight_kg, unit_price_f


def _get_alternate_uom_table_info(cur):
    """
    Discover ITEMALTERNATEUOMMAP table and columns from Oracle (USER or ALL_TAB_COLUMNS).
    Returns (qualified_table, itemcode_col, alternate_cols) or (None, None, []).
    alternate_cols = list of column names to match barcode/code against.
    """
    try:
        owner = None
        cur.execute("""
            SELECT OWNER FROM ALL_TABLES
            WHERE UPPER(TABLE_NAME) = 'ITEMALTERNATEUOMMAP' AND ROWNUM = 1
        """)
        row = cur.fetchone()
        if row and row[0]:
            owner = str(row[0]).strip()
        if not owner:
            cur.execute("""
                SELECT 1 FROM USER_TABLES
                WHERE UPPER(TABLE_NAME) = 'ITEMALTERNATEUOMMAP' AND ROWNUM = 1
            """)
            if not cur.fetchone():
                return None, None, []
        qualified = f'"{owner}".ITEMALTERNATEUOMMAP' if owner else 'ITEMALTERNATEUOMMAP'
        if owner:
            cur.execute("""
                SELECT COLUMN_NAME FROM ALL_TAB_COLUMNS
                WHERE UPPER(TABLE_NAME) = 'ITEMALTERNATEUOMMAP' AND OWNER = :owner
                ORDER BY COLUMN_ID
            """, owner=owner)
        else:
            cur.execute("""
                SELECT COLUMN_NAME FROM USER_TAB_COLUMNS
                WHERE UPPER(TABLE_NAME) = 'ITEMALTERNATEUOMMAP'
                ORDER BY COLUMN_ID
            """)
        columns = [str(r[0]).strip().upper() for r in cur.fetchall() if r and r[0]]
        if not columns:
            return None, None, []
        itemcode_col = next((c for c in columns if c in ('ITEMCODE', 'ITEM_CODE')), columns[0])
        # Your table: ALTERNATEUOMCODE (VARCHAR), MANUFACTURERID (VARCHAR) for barcode/code lookup
        alt_names = ('ALTERNATEUOMCODE', 'MANUFACTURERID', 'ALTERNATECODE', 'ALTERNATEITEMCODE', 'BARCODE', 'ALTERNATEUOM', 'UOM')
        alternate_cols = [c for c in columns if c in alt_names or (c != itemcode_col and ('ALT' in c or 'CODE' in c or 'BAR' in c or 'MANUFACTURER' in c))]
        if not alternate_cols:
            alternate_cols = [c for c in columns if c != itemcode_col][:5]
        return qualified, itemcode_col, alternate_cols
    except oracledb.Error:
        return None, None, []


@app.route('/api/products/lookup', methods=['GET'])
def lookup_product():
    """Look up a single product by code for cart add: check BOTH ITEMMASTER and ITEMALTERNATEUOMMAP."""
    code = (request.args.get('code') or '').strip()
    if not code:
        return jsonify({"error": "code is required"}), 400
    conn = _get_connection()
    if not conn:
        return jsonify({"found": False, "code": code, "error": "Product not found"}), 200
    cursor = None
    try:
        cursor = conn.cursor()
        row = None
        itemcode_from_alt = None
        # 1) ITEMMASTER: match by manufacturerid (barcode) or itemcode
        try:
            cursor.execute(f"""
                SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid, baseuom
                FROM itemmaster
                WHERE ((manufacturerid IS NOT NULL AND (TRIM(TO_CHAR(manufacturerid, '{_ORACLE_NUM_FMT}')) = TRIM(:code)
                   OR UPPER(TRIM(TO_CHAR(manufacturerid))) = UPPER(:code)))
                   OR (itemcode IS NOT NULL AND UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code)))
                AND ROWNUM = 1
            """, code=code)
            row = cursor.fetchone()
        except oracledb.Error:
            try:
                cursor.execute(f"""
                    SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid, baseuom
                    FROM itemmaster
                    WHERE ((manufacturerid IS NOT NULL AND TRIM(TO_CHAR(manufacturerid, '{_ORACLE_NUM_FMT}')) = TRIM(:code))
                       OR (itemcode IS NOT NULL AND UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code)))
                    AND ROWNUM = 1
                """, code=code)
                row = cursor.fetchone()
            except oracledb.Error:
                try:
                    cursor.execute(f"""
                        SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid, baseuom
                        FROM itemmaster
                        WHERE (TRIM(TO_CHAR(NVL(manufacturerid, 0), '{_ORACLE_NUM_FMT}')) = TRIM(:code)
                           OR UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code))
                        AND ROWNUM = 1
                    """, code=code)
                    row = cursor.fetchone()
                except oracledb.Error:
                    try:
                        cursor.execute("""
                            SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid, baseuom
                            FROM itemmaster
                            WHERE (TRIM(manufacturerid) = TRIM(:code) OR TRIM(itemcode) = TRIM(:code))
                            AND ROWNUM = 1
                        """, code=code)
                        row = cursor.fetchone()
                    except oracledb.Error:
                        try:
                            cursor.execute("""
                                SELECT locationcode, itemcode, itemname, categorycode, retailprice, baseuom
                                FROM itemmaster
                                WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1
                            """, code=code)
                            row = cursor.fetchone()
                        except oracledb.Error:
                            pass
        # 2) ITEMALTERNATEUOMMAP: MANUFACTURERID found here -> use this table's RETAILPRICE, ALTERNATEUOMCODE, CONVERSIONFACTOR; name/category from itemmaster
        alt_retailprice = None
        alt_alternateuomcode = None
        alt_conversionfactor = None
        if not row:
            itemcode_from_alt, locationcode_from_alt, alt_retailprice, alt_alternateuomcode, alt_conversionfactor = _resolve_itemcode_location_from_alternate(cursor, code)
            if itemcode_from_alt:
                try:
                    if locationcode_from_alt:
                        cursor.execute("""
                            SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid, baseuom
                            FROM itemmaster
                            WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:ic) AND (UPPER(TRIM(TO_CHAR(locationcode))) = UPPER(:lc) OR TRIM(locationcode) = TRIM(:lc))
                            AND ROWNUM = 1
                        """, ic=itemcode_from_alt, lc=locationcode_from_alt)
                    else:
                        cursor.execute("""
                            SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid, baseuom
                            FROM itemmaster
                            WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1
                        """, code=itemcode_from_alt)
                    row = cursor.fetchone()
                except oracledb.Error:
                    try:
                        if locationcode_from_alt:
                            cursor.execute(f"""
                                SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid, baseuom
                                FROM itemmaster
                                WHERE TRIM(TO_CHAR(itemcode)) = TRIM(:ic) AND TRIM(TO_CHAR(NVL(locationcode, 0), '{_ORACLE_NUM_FMT}')) = TRIM(:lc) AND ROWNUM = 1
                            """, ic=itemcode_from_alt, lc=locationcode_from_alt)
                        else:
                            cursor.execute("""
                                SELECT locationcode, itemcode, itemname, categorycode, retailprice, baseuom
                                FROM itemmaster
                                WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1
                            """, code=itemcode_from_alt)
                        row = cursor.fetchone()
                    except oracledb.Error:
                        pass
        if not row:
            veg_result, weight_kg, unit_price = _try_vegetable_meat_barcode(cursor, code)
            if veg_result is not None and unit_price is not None and weight_kg is not None:
                result = dict(veg_result)
                result['RETAILPRICE'] = unit_price
                result['retailprice'] = unit_price
                result['WEIGHTKG'] = weight_kg
                result['weightKg'] = weight_kg
                result['IS_WEIGHTED_ITEM'] = True
                result['isWeightedItem'] = True
                result['manufactureid'] = str(code).strip()
                result['MANUFACTUREID'] = str(code).strip()
                result['MANUFACTURERID'] = str(code).strip()
                ic = str(result.get('ITEMCODE') or result.get('itemcode') or '').strip()
                if ic and ('ITEMNAMEARA' not in result and 'itemnameara' not in result):
                    try:
                        cursor.execute("SELECT itemnameara FROM itemmaster WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1", code=ic)
                        ara_row = cursor.fetchone()
                        if ara_row and ara_row[0]:
                            result['ITEMNAMEARA'] = _decode_arabic_from_db(str(ara_row[0]))
                            result['itemnameara'] = result['ITEMNAMEARA']
                    except oracledb.Error:
                        pass
                if ic:
                    details_map = _get_item_details_from_master(cursor, [ic])
                    details = details_map.get(ic) or {}
                    if details.get('store') is not None and result.get('STORE') is None:
                        result['STORE'] = details['store']
                        result['store'] = result['STORE']
                if result.get('STORE') is None:
                    loc = result.get('LOCATIONCODE') or result.get('locationcode')
                    if loc is not None:
                        result['STORE'] = _normalize_store(loc) or loc
                        result['store'] = result['STORE']
                if result.get('STORE') is None:
                    result['STORE'] = 'STORE1'
                    result['store'] = 'STORE1'
                if result.get('CATEGORYCODE') is None and result.get('categorycode') is None:
                    try:
                        cursor.execute("SELECT categorycode FROM itemmaster WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1", code=ic)
                        cat_row = cursor.fetchone()
                        if cat_row and cat_row[0] is not None:
                            result['CATEGORYCODE'] = str(cat_row[0]).strip()
                            result['categorycode'] = result['CATEGORYCODE']
                    except oracledb.Error:
                        pass
                result["found"] = True
                return jsonify(result)
            return jsonify({"found": False, "code": code, "error": "Product not found"}), 200
        columns = [col[0] for col in cursor.description]
        result = dict(zip(columns, row))
        # Fetch ITEMNAMEARA if not in result (column may not exist in all schemas)
        ic = str(result.get('ITEMCODE') or result.get('itemcode') or '').strip()
        if ic and 'ITEMNAMEARA' not in result and 'itemnameara' not in result:
            try:
                cursor.execute("SELECT itemnameara FROM itemmaster WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1", code=ic)
                ara_row = cursor.fetchone()
                if ara_row and ara_row[0]:
                    result['ITEMNAMEARA'] = _decode_arabic_from_db(str(ara_row[0]))
                    result['itemnameara'] = result['ITEMNAMEARA']
            except oracledb.Error:
                pass
        if itemcode_from_alt and alt_retailprice is not None:
            result['RETAILPRICE'] = alt_retailprice
            result['retailprice'] = alt_retailprice
        if itemcode_from_alt and alt_alternateuomcode:
            result['BASEUOM'] = alt_alternateuomcode
            result['baseuom'] = alt_alternateuomcode
        if result.get('manufactureid') is None and result.get('MANUFACTUREID') is None:
            result['manufactureid'] = str(result.get('ITEMCODE') or result.get('itemcode') or '')
        if itemcode_from_alt and code:
            result['manufactureid'] = str(code).strip()
            result['MANUFACTUREID'] = str(code).strip()
            result['MANUFACTURERID'] = str(code).strip()
        # Enrich with COSTPRICE, AVERAGECOST, STORE from itemmaster; ITEMALTERNATEUOMMAP also CONVERSIONFACTOR
        if ic:
            details_map = _get_item_details_from_master(cursor, [ic])
            details = details_map.get(ic) or {}
            cp = details.get('costprice')
            if cp is not None:
                try:
                    cp_f = float(cp)
                except (TypeError, ValueError):
                    cp_f = None
                if itemcode_from_alt and alt_conversionfactor is not None and cp_f is not None:
                    try:
                        fac = float(alt_conversionfactor)
                        result['COSTPRICE'] = fac * cp_f   # cost per alternate unit = costPrice * ConversionFactor
                        result['costprice'] = result['COSTPRICE']
                        result['CONVERSIONFACTOR'] = fac
                        result['conversionFactor'] = fac
                    except (TypeError, ValueError):
                        result['COSTPRICE'] = cp
                        result['costprice'] = cp
                else:
                    result['COSTPRICE'] = cp
                    result['costprice'] = cp
            # When item is from ITEMALTERNATEUOMMAP, always expose CONVERSIONFACTOR for Factor display
            if itemcode_from_alt and alt_conversionfactor is not None and result.get('CONVERSIONFACTOR') is None:
                try:
                    fac = float(alt_conversionfactor)
                    result['CONVERSIONFACTOR'] = fac
                    result['conversionFactor'] = fac
                except (TypeError, ValueError):
                    pass
            ac = details.get('averagecost')
            if ac is not None:
                result['AVERAGECOST'] = ac
                result['averagecost'] = ac
                result['avgcost'] = ac
            pa = details.get('prevamount')
            if pa is not None:
                result['PREVAMOUNT'] = pa
                result['prevamount'] = pa
            st = details.get('store')
            if st is not None:
                result['STORE'] = st
                result['store'] = st
        if result.get('STORE') is None and result.get('store') is None:
            loc = result.get('LOCATIONCODE') or result.get('locationcode')
            if loc is not None:
                result['STORE'] = _normalize_store(loc) or loc
                result['store'] = result['STORE']
        if result.get('STORE') is None and result.get('store') is None:
            result['STORE'] = 'STORE1'
            result['store'] = 'STORE1'
        if result.get('CATEGORYCODE') is None and result.get('categorycode') is None:
            try:
                cursor.execute("SELECT categorycode FROM itemmaster WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1", code=ic or code)
                cat_row = cursor.fetchone()
                if cat_row and cat_row[0] is not None:
                    result['CATEGORYCODE'] = str(cat_row[0]).strip()
                    result['categorycode'] = result['CATEGORYCODE']
            except oracledb.Error:
                pass
        elif result.get('CATEGORYCODE') is not None or result.get('categorycode') is not None:
            val = result.get('CATEGORYCODE') or result.get('categorycode')
            result['CATEGORYCODE'] = val
            result['categorycode'] = val
        # When item is from ITEMMASTER or ITEMALTERNATEUOMMAP, only show price if CATEGORY has FLAG='C' and CATEGORYTYPE='G'
        price_to_check = result.get('RETAILPRICE') or result.get('retailprice')
        category_code = result.get('CATEGORYCODE') or result.get('categorycode')
        display_price = get_price_after_category_check(cursor, category_code, price_to_check, from_itemmaster_or_alternate=True)
        result['RETAILPRICE'] = display_price
        result['retailprice'] = display_price
        result["found"] = True
        return jsonify(result)
    except oracledb.Error as e:
        print(f"Oracle lookup error: {e}")
        return jsonify({"found": False, "code": code, "error": "Product not found"}), 200
    finally:
        if cursor:
            try:
                cursor.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


@app.route('/api/products', methods=['GET'])
def get_products():
    """Fetch products from ITEMMASTER and ITEMALTERNATEUOMMAP; show if either table has the product."""
    conn = _get_connection()
    if not conn:
        return jsonify(_get_products_mock_data()), 200
    cursor = None
    try:
        cursor = conn.cursor()
        # 1) All from ITEMMASTER (COSTPRICE, AVERAGECOST, STORE)
        query = """
            SELECT
                p.locationcode,
                p.itemcode,
                p.itemname,
                p.categorycode,
                p.retailprice,
                p.costprice,
                p.averagecost,
                p.store,
                p.manufacturerid,
                p.baseuom,
                p.itemnameara,
                p.prevamount
            FROM itemmaster p
        """
        try:
            cursor.execute(query)
        except oracledb.Error as e:
            if 'ORA-00904' in str(e).upper() or '00904' in str(e).upper():
                query = """
                    SELECT
                        p.locationcode,
                        p.itemcode,
                        p.itemname,
                        p.categorycode,
                        p.retailprice,
                        p.COST_PRICE AS costprice,
                        p.AVERAGE_COST AS averagecost,
                        p.manufacturerid,
                        p.baseuom,
                        p.itemnameara
                    FROM itemmaster p
                """
                try:
                    cursor.execute(query)
                except oracledb.Error:
                    query = """
                        SELECT
                            p.locationcode,
                            p.itemcode,
                            p.itemname,
                            p.categorycode,
                            p.retailprice,
                            p.costprice,
                            p.manufacturerid,
                            p.baseuom,
                            p.itemnameara
                        FROM itemmaster p
                    """
                    try:
                        cursor.execute(query)
                    except oracledb.Error as e2:
                        if 'ORA-00904' in str(e2).upper() or '00904' in str(e2).upper():
                            query = """
                                SELECT
                                    p.locationcode,
                                    p.itemcode,
                                    p.itemname,
                                    p.categorycode,
                                    p.retailprice,
                                    p.manufacturerid,
                                    p.baseuom
                                FROM itemmaster p
                            """
                            cursor.execute(query)
                        else:
                            raise
            else:
                raise
        columns = [col[0] for col in cursor.description]
        rows = cursor.fetchall()
        results = []
        seen_itemcodes = set()
        for row in rows:
            rec = dict(zip(columns, row))
            ic = str(rec.get('ITEMCODE') or rec.get('itemcode') or '').strip()
            if ic:
                seen_itemcodes.add(ic.upper())
            for key in ('itemnameara', 'ITEMNAMEARA'):
                if key in rec and rec[key]:
                    rec[key] = _decode_arabic_from_db(str(rec[key]))
            if rec.get('averagecost') is not None and rec.get('AVERAGECOST') is None:
                rec['AVERAGECOST'] = rec['averagecost']
            results.append(rec)
        # 2) ITEMALTERNATEUOMMAP: fetch alternate rows then get RETAILPRICE (and name, etc.) from itemmaster in Python
        qualified_alt, itemcode_col_alt, alternate_cols_alt = _get_alternate_uom_table_info(cursor)
        alt_table = qualified_alt if qualified_alt else "ITEMALTERNATEUOMMAP"
        try:
            cursor.execute(f"""
                SELECT {itemcode_col_alt} AS itemcode, LOCATIONCODE AS locationcode, MANUFACTURERID AS manufacturerid, RETAILPRICE AS retailprice, ALTERNATEUOMCODE AS alternateuomcode, CONVERSIONFACTOR AS conversionfactor
                FROM {alt_table}
                WHERE {itemcode_col_alt} IS NOT NULL
            """)
            alt_rows = cursor.fetchall()
        except oracledb.Error:
            try:
                cursor.execute("""
                    SELECT ITEMCODE AS itemcode, LOCATIONCODE AS locationcode, MANUFACTURERID AS manufacturerid, RETAILPRICE AS retailprice, ALTERNATEUOMCODE AS alternateuomcode, CONVERSIONFACTOR AS conversionfactor
                    FROM ITEMALTERNATEUOMMAP
                    WHERE ITEMCODE IS NOT NULL
                """)
                alt_rows = cursor.fetchall()
            except oracledb.Error:
                try:
                    cursor.execute("""
                        SELECT ITEMCODE AS itemcode, LOCATIONCODE AS locationcode, MANUFACTURERID AS manufacturerid, RETAILPRICE AS retailprice, ALTERNATEUOMCODE AS alternateuomcode
                        FROM ITEMALTERNATEUOMMAP
                        WHERE ITEMCODE IS NOT NULL
                    """)
                    alt_rows = [(r[0], r[1] if len(r) > 1 else None, r[2] if len(r) > 2 else r[1] if len(r) == 2 else None, r[3] if len(r) > 3 else None, r[4] if len(r) > 4 else None, None) for r in cursor.fetchall()]
                except oracledb.Error:
                    try:
                        cursor.execute("""
                            SELECT ITEMCODE AS itemcode, LOCATIONCODE AS locationcode, MANUFACTURERID AS manufacturerid, RETAILPRICE AS retailprice
                            FROM ITEMALTERNATEUOMMAP
                            WHERE ITEMCODE IS NOT NULL
                        """)
                        alt_rows = [(r[0], r[1] if len(r) > 1 else None, r[2] if len(r) > 2 else r[1] if len(r) == 2 else None, r[3] if len(r) > 3 else None, None, None) for r in cursor.fetchall()]
                    except oracledb.Error:
                        try:
                            cursor.execute("""
                                SELECT ITEMCODE AS itemcode, LOCATIONCODE AS locationcode, MANUFACTURERID AS manufacturerid
                                FROM ITEMALTERNATEUOMMAP
                                WHERE ITEMCODE IS NOT NULL
                            """)
                            alt_rows = [(r[0], r[1] if len(r) > 1 else None, r[2] if len(r) > 2 else r[1] if len(r) == 2 else None, None, None, None) for r in cursor.fetchall()]
                        except oracledb.Error:
                            try:
                                cursor.execute("""
                                    SELECT ITEMCODE AS itemcode, MANUFACTURERID AS manufacturerid
                                    FROM ITEMALTERNATEUOMMAP
                                    WHERE ITEMCODE IS NOT NULL
                                """)
                                alt_rows = [(r[0], None, r[1], None, None, None) for r in cursor.fetchall()] if cursor.description and len(cursor.description) >= 2 else []
                            except oracledb.Error:
                                alt_rows = []
        if alt_rows:
            alt_itemcodes = list({str(r[0]).strip() for r in alt_rows if r and r[0]})
            itemmaster_by_ic_lc = {}
            itemmaster_by_ic = {}
            for ic in alt_itemcodes:
                if not ic:
                    continue
                try:
                    cursor.execute("""
                        SELECT locationcode, itemcode, itemname, categorycode, retailprice, costprice, averagecost, store, manufacturerid, baseuom, prevamount
                        FROM itemmaster
                        WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:ic)
                    """, ic=ic)
                    im_cols = [c[0] for c in cursor.description]
                    for im_row in cursor.fetchall():
                        im_rec = dict(zip(im_cols, im_row))
                        ic_val = str(im_rec.get('ITEMCODE') or im_rec.get('itemcode') or '').strip()
                        lc_val = im_rec.get('LOCATIONCODE') or im_rec.get('locationcode')
                        if ic_val:
                            if ic_val.upper() not in itemmaster_by_ic:
                                itemmaster_by_ic[ic_val.upper()] = im_rec
                            if lc_val is not None:
                                itemmaster_by_ic_lc[(ic_val.upper(), str(lc_val).strip().upper())] = im_rec
                except oracledb.Error:
                    try:
                        cursor.execute("""
                            SELECT locationcode, itemcode, itemname, categorycode, retailprice, costprice, manufacturerid, baseuom
                            FROM itemmaster
                            WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:ic)
                        """, ic=ic)
                        im_cols = [c[0] for c in cursor.description]
                        for im_row in cursor.fetchall():
                            im_rec = dict(zip(im_cols, im_row))
                            ic_val = str(im_rec.get('ITEMCODE') or im_rec.get('itemcode') or '').strip()
                            lc_val = im_rec.get('LOCATIONCODE') or im_rec.get('locationcode')
                            if ic_val:
                                if ic_val.upper() not in itemmaster_by_ic:
                                    itemmaster_by_ic[ic_val.upper()] = im_rec
                                if lc_val is not None:
                                    itemmaster_by_ic_lc[(ic_val.upper(), str(lc_val).strip().upper())] = im_rec
                    except oracledb.Error:
                        pass
            added_from_alt = set()
            for row in alt_rows:
                if not row:
                    continue
                ic = str(row[0]).strip() if row[0] is not None else ''
                lc_alt = row[1] if len(row) > 1 else None
                alt_manufacturerid = row[2] if len(row) > 2 else (row[1] if len(row) == 2 else None)
                alt_retailprice = row[3] if len(row) > 3 else None
                alt_alternateuomcode = row[4] if len(row) > 4 else None
                alt_conversionfactor = row[5] if len(row) > 5 else None
                if alt_alternateuomcode is not None:
                    alt_alternateuomcode = str(alt_alternateuomcode).strip() or None
                if ic and alt_alternateuomcode:
                    _lc_u = str(lc_alt).strip() if lc_alt is not None and str(lc_alt).strip() else None
                    alt_alternateuomcode = _finalize_alternate_uom_for_map_row(cursor, ic, _lc_u, alt_alternateuomcode)
                if not ic:
                    continue
                im_rec = None
                if lc_alt is not None and str(lc_alt).strip():
                    im_rec = itemmaster_by_ic_lc.get((ic.upper(), str(lc_alt).strip().upper()))
                if im_rec is None:
                    im_rec = itemmaster_by_ic.get(ic.upper())
                if im_rec is None:
                    continue
                costprice_im = im_rec.get('COSTPRICE') if im_rec.get('COSTPRICE') is not None else im_rec.get('costprice')
                if costprice_im is not None:
                    try:
                        cp = float(costprice_im)
                        fac = float(alt_conversionfactor) if alt_conversionfactor is not None else 1.0
                        cost_computed = fac * cp   # costPrice × ConversionFactor; result shown as Factor
                    except (TypeError, ValueError):
                        cost_computed = costprice_im
                else:
                    cost_computed = None
                rec = {
                    'LOCATIONCODE': im_rec.get('LOCATIONCODE') or im_rec.get('locationcode'),
                    'ITEMCODE': im_rec.get('ITEMCODE') or im_rec.get('itemcode'),
                    'ITEMNAME': im_rec.get('ITEMNAME') or im_rec.get('itemname'),
                    'CATEGORYCODE': im_rec.get('CATEGORYCODE') or im_rec.get('categorycode'),
                    'RETAILPRICE': alt_retailprice if alt_retailprice is not None else (im_rec.get('RETAILPRICE') or im_rec.get('retailprice')),
                    'MANUFACTURERID': alt_manufacturerid or im_rec.get('MANUFACTURERID') or im_rec.get('manufacturerid'),
                    'MANUFACTUREID': alt_manufacturerid or im_rec.get('MANUFACTURERID') or im_rec.get('manufacturerid') or im_rec.get('MANUFACTUREID') or im_rec.get('manufactureid'),
                    'manufactureid': alt_manufacturerid or im_rec.get('MANUFACTURERID') or im_rec.get('manufacturerid') or im_rec.get('MANUFACTUREID') or im_rec.get('manufactureid'),
                    'BASEUOM': alt_alternateuomcode if alt_alternateuomcode else (im_rec.get('BASEUOM') or im_rec.get('baseuom')),
                }
                if cost_computed is not None:
                    rec['COSTPRICE'] = cost_computed
                    rec['costprice'] = cost_computed
                if alt_conversionfactor is not None:
                    try:
                        rec['CONVERSIONFACTOR'] = float(alt_conversionfactor)
                        rec['conversionFactor'] = rec['CONVERSIONFACTOR']
                    except (TypeError, ValueError):
                        pass
                if im_rec.get('AVERAGECOST') is not None or im_rec.get('averagecost') is not None:
                    rec['AVERAGECOST'] = im_rec.get('AVERAGECOST') if im_rec.get('AVERAGECOST') is not None else im_rec.get('averagecost')
                if im_rec.get('STORE') is not None or im_rec.get('store') is not None:
                    rec['STORE'] = im_rec.get('STORE') if im_rec.get('STORE') is not None else im_rec.get('store')
                if im_rec.get('PREVAMOUNT') is not None or im_rec.get('prevamount') is not None:
                    rec['PREVAMOUNT'] = im_rec.get('PREVAMOUNT') if im_rec.get('PREVAMOUNT') is not None else im_rec.get('prevamount')
                    rec['prevamount'] = rec['PREVAMOUNT']
                if rec.get('ITEMCODE') or rec.get('itemcode'):
                    seen_itemcodes.add(ic.upper())
                    results.append(rec)
        # 3) Add products by ITEMCODE from alternate table that are not already in list (itemmaster may not have them)
        qualified_alt, itemcode_col_alt, alternate_cols_alt = _get_alternate_uom_table_info(cursor)
        alt_itemcodes = []
        if qualified_alt and itemcode_col_alt:
            try:
                cursor.execute(f"""
                    SELECT DISTINCT {itemcode_col_alt} FROM {qualified_alt}
                    WHERE {itemcode_col_alt} IS NOT NULL
                """)
                alt_itemcodes = [str(row[0]).strip() for row in cursor.fetchall() if row and row[0]]
            except oracledb.Error:
                pass
        if not alt_itemcodes:
            try:
                cursor.execute("""
                    SELECT DISTINCT ITEMCODE FROM ITEMALTERNATEUOMMAP
                    WHERE ITEMCODE IS NOT NULL
                """)
                alt_itemcodes = [str(row[0]).strip() for row in cursor.fetchall() if row and row[0]]
            except oracledb.Error:
                pass
        for ic in alt_itemcodes:
            if not ic or ic.upper() in seen_itemcodes:
                continue
            try:
                select_clause = ", ".join(c.lower() for c in columns)
                cursor.execute(f"""
                    SELECT {select_clause}
                    FROM itemmaster
                    WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1
                """, code=ic)
                row = cursor.fetchone()
                if row:
                    rec = dict(zip(columns, row))
                    results.append(rec)
                    seen_itemcodes.add(ic.upper())
            except oracledb.Error:
                pass
        # 4) Attach alternate codes per ITEMCODE (use discovered table/columns)
        alt_map = {}
        if qualified_alt and itemcode_col_alt and alternate_cols_alt:
            alt_col = alternate_cols_alt[0]
            try:
                cursor.execute(f"""
                    SELECT {itemcode_col_alt}, {alt_col} FROM {qualified_alt}
                    WHERE {itemcode_col_alt} IS NOT NULL AND {alt_col} IS NOT NULL
                """)
                for row in cursor.fetchall():
                    ic = str(row[0]).strip() if row[0] else None
                    alt = str(row[1]).strip() if row[1] else None
                    if ic and alt:
                        alt_map.setdefault(ic, []).append(alt)
            except oracledb.Error:
                pass
        if not alt_map:
            # Your table: ALTERNATEUOMCODE, MANUFACTURERID (VARCHAR)
            try:
                cursor.execute("""
                    SELECT ITEMCODE, ALTERNATEUOMCODE FROM ITEMALTERNATEUOMMAP
                    WHERE ITEMCODE IS NOT NULL AND ALTERNATEUOMCODE IS NOT NULL
                """)
                for row in cursor.fetchall():
                    ic = str(row[0]).strip() if row[0] else None
                    alt = str(row[1]).strip() if row[1] else None
                    if ic and alt:
                        alt_map.setdefault(ic, []).append(alt)
                cursor.execute("""
                    SELECT ITEMCODE, MANUFACTURERID FROM ITEMALTERNATEUOMMAP
                    WHERE ITEMCODE IS NOT NULL AND MANUFACTURERID IS NOT NULL
                """)
                for row in cursor.fetchall():
                    ic = str(row[0]).strip() if row[0] else None
                    alt = str(row[1]).strip() if row[1] else None
                    if ic and alt:
                        lst = alt_map.setdefault(ic, [])
                        if alt not in lst:
                            lst.append(alt)
            except oracledb.Error:
                try:
                    cursor.execute("""
                        SELECT ITEMCODE, ALTERNATECODE FROM ITEMALTERNATEUOMMAP
                        WHERE ITEMCODE IS NOT NULL AND ALTERNATECODE IS NOT NULL
                    """)
                    for row in cursor.fetchall():
                        ic, alt = (str(row[0]).strip() if row[0] else None), (str(row[1]).strip() if row[1] else None)
                        if ic and alt:
                            alt_map.setdefault(ic, []).append(alt)
                except oracledb.Error:
                    pass
        for rec in results:
            itemcode = str(rec.get('ITEMCODE') or rec.get('itemcode') or '').strip()
            rec['ALTERNATECODES'] = alt_map.get(itemcode, [])
        return jsonify(results)
    except oracledb.Error as e:
        print(f"Oracle get_products error: {e}")
        return jsonify(_get_products_mock_data()), 200
    finally:
        if cursor:
            try:
                cursor.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


@app.route('/api/products/search', methods=['GET'])
def search_products():
    """Search products: check both ITEMMASTER and ITEMALTERNATEUOMMAP; return if either table has a match."""
    q = (request.args.get('q') or request.args.get('code') or request.args.get('search') or '').strip()
    if not q:
        return jsonify([])
    conn = _get_connection()
    if not conn:
        return jsonify([])
    cursor = None
    try:
        cursor = conn.cursor()
        seen = set()
        results = []
        search_pct = '%' + q.replace('%', '\\%').replace('_', '\\_') + '%'
        # 1) ITEMMASTER: match itemcode, itemname, or manufacturerid
        try:
            cursor.execute("""
                SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid
                FROM itemmaster
                WHERE UPPER(TRIM(TO_CHAR(itemcode))) LIKE UPPER(:q)
                   OR UPPER(TRIM(itemname)) LIKE UPPER(:q)
                   OR UPPER(TRIM(TO_CHAR(manufacturerid))) LIKE UPPER(:q)
            """, q=search_pct)
            cols = [c[0] for c in cursor.description]
            for row in cursor.fetchall():
                rec = dict(zip(cols, row))
                ic = str(rec.get('ITEMCODE') or rec.get('itemcode') or '').strip()
                if ic and ic.upper() not in seen:
                    seen.add(ic.upper())
                    rec['ALTERNATECODES'] = []
                    results.append(rec)
        except oracledb.Error:
            try:
                cursor.execute("""
                    SELECT locationcode, itemcode, itemname, categorycode, retailprice
                    FROM itemmaster
                    WHERE UPPER(TRIM(TO_CHAR(itemcode))) LIKE UPPER(:q)
                       OR UPPER(TRIM(itemname)) LIKE UPPER(:q)
                """, q=search_pct)
                cols = [c[0] for c in cursor.description]
                for row in cursor.fetchall():
                    rec = dict(zip(cols, row))
                    rec['manufacturerid'] = rec.get('ITEMCODE') or rec.get('itemcode')
                    ic = str(rec.get('ITEMCODE') or rec.get('itemcode') or '').strip()
                    if ic and ic.upper() not in seen:
                        seen.add(ic.upper())
                        rec['ALTERNATECODES'] = []
                        results.append(rec)
            except oracledb.Error:
                pass
        # 2) ITEMALTERNATEUOMMAP: match ALTERNATEUOMCODE / MANUFACTURERID (your columns), then get from ITEMMASTER
        def add_from_alt_itemcodes(alt_itemcodes):
            for row in (alt_itemcodes or []):
                if not row or not row[0]:
                    continue
                ic = str(row[0]).strip()
                if ic.upper() in seen:
                    continue
                seen.add(ic.upper())
                try:
                    cursor.execute("""
                        SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid
                        FROM itemmaster
                        WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1
                    """, code=ic)
                    r = cursor.fetchone()
                    if r:
                        cols = [c[0] for c in cursor.description]
                        rec = dict(zip(cols, r))
                        rec['ALTERNATECODES'] = []
                        results.append(rec)
                except oracledb.Error:
                    pass
        try:
            cursor.execute("""
                SELECT DISTINCT ITEMCODE FROM ITEMALTERNATEUOMMAP
                WHERE UPPER(TRIM(ALTERNATEUOMCODE)) LIKE UPPER(:q) OR UPPER(TRIM(MANUFACTURERID)) LIKE UPPER(:q)
            """, q=search_pct)
            add_from_alt_itemcodes(cursor.fetchall())
        except oracledb.Error:
            try:
                cursor.execute("""
                    SELECT DISTINCT ITEMCODE FROM ITEMALTERNATEUOMMAP
                    WHERE UPPER(TRIM(TO_CHAR(ALTERNATECODE))) LIKE UPPER(:q)
                """, q=search_pct)
                add_from_alt_itemcodes(cursor.fetchall())
            except oracledb.Error:
                try:
                    cursor.execute("""
                        SELECT DISTINCT ITEMCODE FROM ITEMALTERNATEUOMMAP
                        WHERE UPPER(TRIM(TO_CHAR(ALTERNATEITEMCODE))) LIKE UPPER(:q)
                    """, q=search_pct)
                    add_from_alt_itemcodes(cursor.fetchall())
                except oracledb.Error:
                    pass
        return jsonify(results)
    except oracledb.Error as e:
        print(f"Product search error: {e}")
        return jsonify([])
    finally:
        if cursor:
            try:
                cursor.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


def _get_products_mock_data():
    """Fallback mock data when Oracle unavailable."""
    return [
        {"LOCATIONCODE": "020", "ITEMCODE": "1001", "ITEMNAME": "COCA COLA 500ML", "CATEGORYCODE": "BEVERAGES", "RETAILPRICE": "100", "MANUFACTUREID": "8901234567890", "ALTERNATECODES": []},
        {"LOCATIONCODE": "020", "ITEMCODE": "1002", "ITEMNAME": "PEPSI 500ML", "CATEGORYCODE": "BEVERAGES", "RETAILPRICE": "100", "MANUFACTUREID": "8901234567891", "ALTERNATECODES": []},
        {"LOCATIONCODE": "020", "ITEMCODE": "2001", "ITEMNAME": "ALMARAI MILK 1L", "CATEGORYCODE": "DAIRY", "RETAILPRICE": "100", "MANUFACTUREID": "8901234567892", "ALTERNATECODES": []},
    ]


# --- Hold / cart bills (Oracle) or in-memory fallback ---
# Change this constant when you rename the DB table (one place for all hold/cart SQL).
HOLD_TABLE_NAME = 'TEMPBILLHDR'
HOLD_DTL_TABLE_NAME = 'TEMPBILLDTL'
BILLNO_TABLE_NAME = 'BILLNOTABLE'
BILLDTL_TABLE_NAME = 'BILLDTL'
BILLDTLHISTORY_TABLE_NAME = 'BILLDTLHISTORY'
BILLHDR_TABLE_NAME = 'BILLHDR'
BILLHDRHISTORY_TABLE_NAME = 'BILLHDRHISTORY'
ITEMJOURNAL_TABLE_NAME = 'ITEMJOURNAL'
ITEMLOG_TABLE_NAME = 'ITEMLOG'
# BILLNOTABLE columns: BILLNO NUMBER, FLAG CHAR(1) DEFAULT 'n' (n/y), BILLDATE (required), COUNTERCODE (optional).
# BILLDTL (paid bill detail): LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, ITDISC=0, STORE1..5=0, COST=costprice, AVERAGECOST=itemmaster.averagecost (or line), BASEQTY=COSTPRICE*1 (ITEMMASTER) or COSTPRICE*CONVERSIONFACTOR (ITEMALTERNATEUOMMAP), UNITOFMEASUREMENT=ITEMMASTER.baseuom. Insert on Pay.
# BILLDTLHISTORY: same columns and rows as BILLDTL on Pay (parallel insert).
# BILLHDR (bill header on Pay): LOCATIONCODE, BILLNO, BILLDATE, BILLTYPE (C=cash sale, R=credit sale from INVOICECODE only), COUNTERCODE, RESETNO=1, SESSIONCODE=0.
# BILLHDRHISTORY: same header row as BILLHDR on Pay (parallel insert/update).
# HOLD table (TEMPBILLHDR): BILLNO, LOCATIONCODE, FLAG. At HOLD time FLAG=0 (held); draft FLAG=1.
# HOLD detail (TEMPBILLDTL): BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID, ITEMFLAG.
# ITEMJOURNAL: journal of item lines at payment; never deleted. RECEIPTNO=BILLNO, LINENO=SLNO, SOURCE_NO=billNo, TRANSTYPE=SALES, SOURCE_DOC=BILL.
# ITEMLOG: snapshot per bill at payment (delete rows for DOCUMENTNO+LOCATIONCODE, then insert); SALE qty negative, SALE RETURN positive; FACTOR = integer (conversion × line QTY, rounded); QUANTITY keeps decimals; CREATEDDATE on insert (SYSDATE).
FLAG_HELD = 0   # TEMPBILLHDR/TEMPBILLDTL: when bill is held
FLAG_DRAFT = 1  # TEMPBILLHDR: when bill is draft/current cart
_held_bills_fallback = {}  # key: (location_code, bill_no) -> { "counterCode", "heldDate", "customerCode", "items": [...] }


def _get_connection():
    try:
        return oracledb.connect(
            user=ORACLE_CONFIG['user'],
            password=ORACLE_CONFIG['password'],
            dsn=ORACLE_CONFIG['dsn']
        )
    except oracledb.Error as e:
        print(f"[Hold] Oracle connection failed: {e}")
        return None


def _dedupe_tempbillhdr_for_bill(cur, bill_no, loc_num):
    """TEMPBILLHDR must be one row per (BILLNO, LOCATIONCODE); remove legacy duplicates."""
    try:
        cur.execute(
            f"""
            DELETE FROM {HOLD_TABLE_NAME} t
            WHERE BILLNO = :billno AND LOCATIONCODE = :loc
            AND t.ROWID <> (
                SELECT MIN(t2.ROWID) FROM {HOLD_TABLE_NAME} t2
                WHERE t2.BILLNO = :billno2 AND t2.LOCATIONCODE = :loc2
            )
            """,
            billno=bill_no,
            loc=loc_num,
            billno2=bill_no,
            loc2=loc_num,
        )
    except oracledb.Error as e:
        print(f"[Hold] {HOLD_TABLE_NAME} dedupe warning: {e}")


def _hold_request_has_timestamp(data):
    """If client sends bill date/time for hold, update header timestamps; otherwise FLAG-only."""
    if not isinstance(data, dict):
        return False
    bt = data.get("billTime") or data.get("billtime") or data.get("BILLTIME")
    bd = data.get("billDate") or data.get("billdate") or data.get("BILLDATE")
    if bt not in (None, ""):
        return True
    if bd not in (None, ""):
        return True
    if data.get("setHoldTimestamp") in (True, "true", "1", 1):
        return True
    return False


def _ensure_tempbillhdr(cur):
    """Create hold table if it does not exist. Ignore ORA-00955 (exists) and ORA-01031 (no create priv)."""
    create_sql = f"""
        CREATE TABLE {HOLD_TABLE_NAME} (
            BILLNO NUMBER NOT NULL,
            LOCATIONCODE NUMBER NOT NULL,
            FLAG NUMBER DEFAULT 1,
            BILLDATE DATE,
            BILLTYPE VARCHAR2(10),
            CARDTYPE VARCHAR2(50),
            CARDNO VARCHAR2(50),
            CUSTOMERCODE VARCHAR2(50),
            BILLTIME VARCHAR2(10),
            COUNTERCODE VARCHAR2(50),
            RESETNO NUMBER DEFAULT 1,
            PREVPOINTS NUMBER DEFAULT 0
        )
    """
    try:
        cur.execute(create_sql)
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00955' in err_str or '00955' in err_str:
            pass
        elif 'ORA-01031' in err_str or '01031' in err_str:
            pass
        else:
            print(f"[Hold] {HOLD_TABLE_NAME} create failed: {e}")
            raise


def _ensure_tempbilldtl(cur):
    """Create TEMPBILLDTL if it does not exist. LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID, ITEMFLAG."""
    create_sql = f"""
        CREATE TABLE {HOLD_DTL_TABLE_NAME} (
            LOCATIONCODE VARCHAR2(50),
            BILLNO NUMBER NOT NULL,
            SLNO NUMBER NOT NULL,
            ITEMCODE VARCHAR2(50),
            QUANTITY NUMBER DEFAULT 1,
            RATE NUMBER DEFAULT 0,
            MANUFACTURERID VARCHAR2(50),
            UNITOFMEASUREMENT VARCHAR2(50),
            RESETNO NUMBER DEFAULT 1,
            PREVPOINTS NUMBER DEFAULT 0,
            COSTPRICE NUMBER DEFAULT 0,
            RETAILPRICE NUMBER DEFAULT 0,
            STORE VARCHAR2(50),
            ITEMFLAG NUMBER DEFAULT 0
        )
    """
    try:
        cur.execute(create_sql)
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00955' in err_str or '00955' in err_str:
            pass
        elif 'ORA-01031' in err_str or '01031' in err_str:
            pass
        else:
            print(f"[Hold] {HOLD_DTL_TABLE_NAME} create failed: {e}")
            raise


def _ensure_itemjournal(cur):
    """Create ITEMJOURNAL if not exists. Journal of paid lines: LOCATIONCODE, RECEIPTNO(=BILLNO), LINENO(=SLNO), ITEMCODE, QTY, RATE, AMOUNT, SOURCE_NO(=billNo), TRANSTYPE=SALES, SOURCE_DOC=BILL. Never delete."""
    create_sql = f"""
        CREATE TABLE {ITEMJOURNAL_TABLE_NAME} (
            LOCATIONCODE VARCHAR2(50),
            RECEIPTNO NUMBER NOT NULL,
            LINENO NUMBER NOT NULL,
            ITEMCODE VARCHAR2(50),
            QTY NUMBER DEFAULT 1,
            RATE NUMBER DEFAULT 0,
            AMOUNT NUMBER DEFAULT 0,
            SOURCE_NO NUMBER NOT NULL,
            TRANSTYPE VARCHAR2(20) DEFAULT 'SALES',
            SOURCE_DOC VARCHAR2(20) DEFAULT 'BILL',
            RESETNO NUMBER DEFAULT 1
        )
    """
    try:
        cur.execute(create_sql)
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00955' in err_str or '00955' in err_str:
            pass
        elif 'ORA-01031' in err_str or '01031' in err_str:
            pass
        else:
            print(f"[ItemJournal] {ITEMJOURNAL_TABLE_NAME} create failed: {e}")
            raise


def _ensure_itemlog(cur):
    """Create ITEMLOG if not exists. LOGNO from MAX+1 at insert time."""
    create_sql = f"""
        CREATE TABLE {ITEMLOG_TABLE_NAME} (
            LOGNO NUMBER NOT NULL,
            ITEMCODE VARCHAR2(50),
            CURRENTSTOCK NUMBER DEFAULT 0,
            TRANSACTIONTYPE VARCHAR2(30),
            QUANTITY NUMBER,
            UOM VARCHAR2(50),
            DOCUMENTNO NUMBER,
            LOCATIONCODE VARCHAR2(50),
            RATE NUMBER DEFAULT 0,
            FACTOR NUMBER DEFAULT 0,
            CREATEDDATE DATE DEFAULT SYSDATE
        )
    """
    try:
        cur.execute(create_sql)
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00955' in err_str or '00955' in err_str:
            pass
        elif 'ORA-01031' in err_str or '01031' in err_str:
            pass
        else:
            print(f"[ItemLog] {ITEMLOG_TABLE_NAME} create failed: {e}")
            raise
    try:
        cur.execute(f"ALTER TABLE {ITEMLOG_TABLE_NAME} ADD (FACTOR NUMBER)")
    except oracledb.Error as e:
        err_str = str(e).upper()
        if (
            'ORA-01430' in err_str
            or '01430' in err_str
            or 'ORA-00955' in err_str
            or '00955' in err_str
            or 'ORA-01031' in err_str
            or '01031' in err_str
        ):
            pass
        else:
            pass
    try:
        cur.execute(f"ALTER TABLE {ITEMLOG_TABLE_NAME} ADD (CREATEDDATE DATE)")
    except oracledb.Error as e:
        err_str = str(e).upper()
        if (
            'ORA-01430' in err_str
            or '01430' in err_str
            or 'ORA-00955' in err_str
            or '00955' in err_str
            or 'ORA-01031' in err_str
            or '01031' in err_str
        ):
            pass
        else:
            pass


def _to_int(val, default=0):
    """Coerce to int for Oracle NUMBER; avoid ORA-01722."""
    if val is None:
        return default
    try:
        return int(float(val))
    except (TypeError, ValueError):
        return default


def _to_float(val, default=0.0):
    """Coerce to float for Oracle NUMBER; avoid ORA-01722."""
    if val is None:
        return default
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _normalize_store(store):
    """Return store string with spaces removed (e.g. 'STORE 3' -> 'STORE3'), or None if empty."""
    if store is None or (isinstance(store, str) and not store.strip()):
        return None
    return str(store).strip().replace(' ', '')


_POS_UOM_UNSET = object()


def _discover_unitofmeasurement_master(cur):
    """Return (qualified_table, code_column) for UNITOFMEASUREMENT, or (None, None) if missing."""
    pref_cols = (
        'UOMCODE', 'UNITCODE', 'UNITOFCODE', 'MEASUREMENTCODE', 'UOM', 'CODE',
        'UNITOFMEASUREMENT', 'UNITNAME', 'DESCRIPTION',
    )
    try:
        owner = None
        cur.execute("""
            SELECT OWNER FROM ALL_TABLES
            WHERE UPPER(TABLE_NAME) = 'UNITOFMEASUREMENT' AND ROWNUM = 1
        """)
        row = cur.fetchone()
        if row and row[0]:
            owner = str(row[0]).strip()
        if not owner:
            cur.execute("""
                SELECT 1 FROM USER_TABLES
                WHERE UPPER(TABLE_NAME) = 'UNITOFMEASUREMENT' AND ROWNUM = 1
            """)
            if not cur.fetchone():
                return None, None
        qualified = f'"{owner}".UNITOFMEASUREMENT' if owner else 'UNITOFMEASUREMENT'
        if owner:
            cur.execute("""
                SELECT COLUMN_NAME FROM ALL_TAB_COLUMNS
                WHERE UPPER(TABLE_NAME) = 'UNITOFMEASUREMENT' AND OWNER = :owner
                ORDER BY COLUMN_ID
            """, owner=owner)
        else:
            cur.execute("""
                SELECT COLUMN_NAME FROM USER_TAB_COLUMNS
                WHERE UPPER(TABLE_NAME) = 'UNITOFMEASUREMENT'
                ORDER BY COLUMN_ID
            """)
        columns = [str(r[0]).strip().upper() for r in cur.fetchall() if r and r[0]]
        if not columns:
            return None, None
        code_col = next((c for c in pref_cols if c in columns), None)
        if not code_col:
            for c in columns:
                if 'CODE' in c or c in ('UOM', 'UNITNAME'):
                    code_col = c
                    break
        if not code_col:
            return None, None
        return qualified, code_col
    except oracledb.Error:
        return None, None


def _fetch_uom_canonical_map(cur):
    """
    Load UNITOFMEASUREMENT codes: dict UPPER(trim) -> canonical spelling, and list of all codes.
    Returns (None, None) if table missing or empty.
    """
    qt, col = _discover_unitofmeasurement_master(cur)
    if not qt or not col:
        return None, None
    try:
        cur.execute(f"SELECT DISTINCT {col} FROM {qt} WHERE {col} IS NOT NULL")
        rows = cur.fetchall()
    except oracledb.Error:
        try:
            cur.execute(f"SELECT DISTINCT TRIM(TO_CHAR({col})) FROM {qt} WHERE {col} IS NOT NULL")
            rows = cur.fetchall()
        except oracledb.Error:
            return None, None
    m = {}
    all_codes = []
    for r in rows:
        if not r or r[0] is None:
            continue
        s = str(r[0]).strip()
        if not s:
            continue
        k = s.upper()
        if k not in m:
            m[k] = s
        all_codes.append(s)
    if not m:
        return None, None
    return m, all_codes


def _get_uom_canonical_cache(cur):
    """Per-connection cache for UNITOFMEASUREMENT codes (one scan per physical connection)."""
    try:
        conn = cur.connection
    except Exception:
        return None, None
    cached = getattr(conn, '_pos_uom_canonical', _POS_UOM_UNSET)
    if cached is not _POS_UOM_UNSET:
        return cached
    pair = _fetch_uom_canonical_map(cur)
    conn._pos_uom_canonical = pair
    return pair


def _correct_alternate_uomcode(raw, canonical_map, all_codes):
    """
    Match ALTERNATEUOMCODE to UNITOFMEASUREMENT: exact (case-insensitive), else one fuzzy match.
    Returns (corrected_str, changed_bool).
    """
    if canonical_map is None or all_codes is None:
        return str(raw).strip() if raw else raw, False
    if raw is None or not str(raw).strip():
        return (str(raw).strip() if raw else ''), False
    raw_s = str(raw).strip()
    k = raw_s.upper()
    if k in canonical_map:
        canon = canonical_map[k]
        return canon, canon != raw_s
    if len(raw_s) >= 3 and all_codes:
        matches = difflib.get_close_matches(raw_s, all_codes, n=1, cutoff=0.88)
        if len(matches) == 1:
            return matches[0], True
    return raw_s, False


def _update_alternate_uomcode_in_map(cur, itemcode, old_uom, new_uom):
    """Persist corrected ALTERNATEUOMCODE on ITEMALTERNATEUOMMAP (first matching row only)."""
    if not itemcode or old_uom is None or new_uom is None:
        return False
    old_s = str(old_uom).strip()
    new_s = str(new_uom).strip()
    if not old_s or not new_s or old_s == new_s:
        return False
    qualified, _, _ = _get_alternate_uom_table_info(cur)
    targets = []
    if qualified:
        targets.append(qualified)
    if not any('ITEMALTERNATEUOMMAP' in t.upper().replace('"', '') for t in targets):
        targets.append('ITEMALTERNATEUOMMAP')
    for tbl in targets:
        try:
            cur.execute(
                f"""
                UPDATE {tbl} m
                SET m.ALTERNATEUOMCODE = :nu
                WHERE m.ROWID = (
                    SELECT rid FROM (
                        SELECT ROWID rid FROM {tbl} x
                        WHERE TRIM(TO_CHAR(x.ITEMCODE)) = TRIM(TO_CHAR(:ic))
                          AND TRIM(TO_CHAR(x.ALTERNATEUOMCODE)) = TRIM(TO_CHAR(:ou))
                        AND ROWNUM = 1
                    )
                )
                """,
                nu=new_s,
                ic=str(itemcode).strip(),
                ou=old_s,
            )
            if cur.rowcount and cur.rowcount > 0:
                return True
        except oracledb.Error:
            try:
                cur.execute(
                    f"""
                    UPDATE {tbl} m
                    SET m.ALTERNATEUOMCODE = :nu
                    WHERE m.ROWID = (
                        SELECT rid FROM (
                            SELECT ROWID rid FROM {tbl} x
                            WHERE TRIM(TO_CHAR(x.ITEMCODE)) = TRIM(TO_CHAR(:ic))
                              AND TRIM(x.ALTERNATEUOMCODE) = TRIM(:ou)
                            AND ROWNUM = 1
                        )
                    )
                    """,
                    nu=new_s,
                    ic=str(itemcode).strip(),
                    ou=old_s,
                )
                if cur.rowcount and cur.rowcount > 0:
                    return True
            except oracledb.Error:
                continue
    return False


def _finalize_alternate_uom_for_map_row(cur, itemcode, locationcode, alt_uom):
    """
    If ALTERNATEUOMCODE is not a valid UNITOFMEASUREMENT code (or spelling differs), normalize
    and UPDATE ITEMALTERNATEUOMMAP when a canonical code is found. locationcode reserved for future narrower UPDATE.
    """
    _ = locationcode
    if not itemcode or not alt_uom or not str(alt_uom).strip():
        return alt_uom
    m, lst = _get_uom_canonical_cache(cur)
    corrected, changed = _correct_alternate_uomcode(alt_uom, m, lst)
    if not changed:
        return corrected
    old_s = str(alt_uom).strip()
    new_s = str(corrected).strip()
    if not new_s:
        return alt_uom
    if _update_alternate_uomcode_in_map(cur, itemcode, old_s, new_s):
        try:
            cur.connection.commit()
        except Exception as ex:
            print(f"[ITEMALTERNATEUOMMAP] UOM correction commit failed: {ex}")
    return new_s


def _resolve_itemcode_location_from_alternate(cur, code):
    """
    Resolve barcode/code to (ITEMCODE, LOCATIONCODE, RETAILPRICE, ALTERNATEUOMCODE, CONVERSIONFACTOR) from ITEMALTERNATEUOMMAP.
    Returns (itemcode_str, locationcode_or_none, retailprice_or_none, alternateuomcode_or_none, conversionfactor_or_none).
    When UNITOFMEASUREMENT exists, ALTERNATEUOMCODE is validated against it; wrong spellings are corrected and persisted.
    """
    if not code or not str(code).strip():
        return None, None, None, None, None
    code_str = str(code).strip()

    def _out(ic_raw, loc_raw, price, alt_uom, conv_factor):
        if ic_raw is None:
            return None, None, None, None, None
        ic_s = str(ic_raw).strip()
        if not ic_s:
            return None, None, None, None, None
        loc_n = None
        if loc_raw is not None:
            ls = str(loc_raw).strip()
            if ls:
                loc_n = ls
        au = alt_uom
        if au is not None:
            au = str(au).strip() or None
        if ic_s and au:
            au = _finalize_alternate_uom_for_map_row(cur, ic_s, loc_n, au)
        return ic_s, loc_n, price, au, conv_factor

    # 1) ITEMALTERNATEUOMMAP: get ITEMCODE, LOCATIONCODE, RETAILPRICE, ALTERNATEUOMCODE, CONVERSIONFACTOR
    try:
        cur.execute("""
            SELECT ITEMCODE, LOCATIONCODE, RETAILPRICE, ALTERNATEUOMCODE, CONVERSIONFACTOR FROM ITEMALTERNATEUOMMAP
            WHERE ((MANUFACTURERID IS NOT NULL AND TRIM(MANUFACTURERID) = TRIM(:code))
               OR (ALTERNATEUOMCODE IS NOT NULL AND TRIM(ALTERNATEUOMCODE) = TRIM(:code))
               OR (ITEMCODE IS NOT NULL AND TRIM(TO_CHAR(ITEMCODE)) = TRIM(:code)))
            AND ROWNUM = 1
        """, code=code_str)
        row = cur.fetchone()
        if row and row[0]:
            price = row[2] if len(row) > 2 and row[2] is not None else None
            alt_uom = row[3] if len(row) > 3 and row[3] is not None else None
            conv_factor = row[4] if len(row) > 4 and row[4] is not None else None
            if alt_uom is not None:
                alt_uom = str(alt_uom).strip() or None
            return _out(row[0], row[1] if len(row) > 1 else None, price, alt_uom, conv_factor)
    except oracledb.Error:
        try:
            cur.execute("""
                SELECT ITEMCODE, LOCATIONCODE, RETAILPRICE, ALTERNATEUOMCODE FROM ITEMALTERNATEUOMMAP
                WHERE ((MANUFACTURERID IS NOT NULL AND TRIM(MANUFACTURERID) = TRIM(:code))
                   OR (ALTERNATEUOMCODE IS NOT NULL AND TRIM(ALTERNATEUOMCODE) = TRIM(:code))
                   OR (ITEMCODE IS NOT NULL AND TRIM(TO_CHAR(ITEMCODE)) = TRIM(:code)))
                AND ROWNUM = 1
            """, code=code_str)
            row = cur.fetchone()
            if row and row[0]:
                price = row[2] if len(row) > 2 and row[2] is not None else None
                alt_uom = row[3] if len(row) > 3 and row[3] is not None else None
                if alt_uom is not None:
                    alt_uom = str(alt_uom).strip() or None
                return _out(row[0], row[1] if len(row) > 1 else None, price, alt_uom, None)
        except oracledb.Error:
            try:
                cur.execute("""
                    SELECT ITEMCODE, LOCATIONCODE, RETAILPRICE FROM ITEMALTERNATEUOMMAP
                    WHERE ((MANUFACTURERID IS NOT NULL AND TRIM(MANUFACTURERID) = TRIM(:code))
                       OR (ALTERNATEUOMCODE IS NOT NULL AND TRIM(ALTERNATEUOMCODE) = TRIM(:code))
                       OR (ITEMCODE IS NOT NULL AND TRIM(TO_CHAR(ITEMCODE)) = TRIM(:code)))
                AND ROWNUM = 1
                """, code=code_str)
                row = cur.fetchone()
                if row and row[0]:
                    price = row[2] if len(row) > 2 and row[2] is not None else None
                    return _out(row[0], row[1] if len(row) > 1 else None, price, None, None)
            except oracledb.Error:
                try:
                    cur.execute("""
                        SELECT ITEMCODE, LOCATIONCODE FROM ITEMALTERNATEUOMMAP
                        WHERE ((MANUFACTURERID IS NOT NULL AND TRIM(MANUFACTURERID) = TRIM(:code))
                           OR (ALTERNATEUOMCODE IS NOT NULL AND TRIM(ALTERNATEUOMCODE) = TRIM(:code))
                           OR (ITEMCODE IS NOT NULL AND TRIM(TO_CHAR(ITEMCODE)) = TRIM(:code)))
                    AND ROWNUM = 1
                    """, code=code_str)
                    row = cur.fetchone()
                    if row and row[0]:
                        return _out(row[0], row[1] if len(row) > 1 else None, None, None, None)
                except oracledb.Error:
                    try:
                        cur.execute("""
                            SELECT ITEMCODE FROM ITEMALTERNATEUOMMAP
                            WHERE ((MANUFACTURERID IS NOT NULL AND TRIM(MANUFACTURERID) = TRIM(:code))
                               OR (ALTERNATEUOMCODE IS NOT NULL AND TRIM(ALTERNATEUOMCODE) = TRIM(:code))
                               OR (ITEMCODE IS NOT NULL AND TRIM(TO_CHAR(ITEMCODE)) = TRIM(:code)))
                        AND ROWNUM = 1
                        """, code=code_str)
                        row = cur.fetchone()
                        if row and row[0]:
                            return _out(row[0], None, None, None, None)
                    except oracledb.Error as e:
                        print(f"[ITEMALTERNATEUOMMAP] lookup fallback error: {e}")
    # 2) Discovered table/columns
    qualified, itemcode_col, alternate_cols = _get_alternate_uom_table_info(cur)
    if qualified and itemcode_col and alternate_cols:
        for col in alternate_cols:
            try:
                cur.execute(f"""
                    SELECT {itemcode_col}, LOCATIONCODE, RETAILPRICE, ALTERNATEUOMCODE, CONVERSIONFACTOR FROM {qualified}
                    WHERE {col} IS NOT NULL AND TRIM(TO_CHAR(NVL({col}, 0), '{_ORACLE_NUM_FMT}')) = TRIM(:code)
                    AND ROWNUM = 1
                """, code=code_str)
                row = cur.fetchone()
                if row and row[0]:
                    price = row[2] if len(row) > 2 and row[2] is not None else None
                    alt_uom = row[3] if len(row) > 3 and row[3] is not None else None
                    conv_factor = row[4] if len(row) > 4 and row[4] is not None else None
                    if alt_uom is not None:
                        alt_uom = str(alt_uom).strip() or None
                    return _out(row[0], row[1] if len(row) > 1 else None, price, alt_uom, conv_factor)
            except oracledb.Error:
                try:
                    cur.execute(f"""
                        SELECT {itemcode_col}, LOCATIONCODE, RETAILPRICE, ALTERNATEUOMCODE FROM {qualified}
                        WHERE TRIM({col}) = TRIM(:code) AND ROWNUM = 1
                    """, code=code_str)
                    row = cur.fetchone()
                    if row and row[0]:
                        price = row[2] if len(row) > 2 and row[2] is not None else None
                        alt_uom = row[3] if len(row) > 3 and row[3] is not None else None
                        if alt_uom is not None:
                            alt_uom = str(alt_uom).strip() or None
                        return _out(row[0], row[1] if len(row) > 1 else None, price, alt_uom, None)
                except oracledb.Error:
                    try:
                        cur.execute(f"""
                            SELECT {itemcode_col}, LOCATIONCODE, RETAILPRICE FROM {qualified}
                            WHERE TRIM({col}) = TRIM(:code) AND ROWNUM = 1
                        """, code=code_str)
                        row = cur.fetchone()
                        if row and row[0]:
                            price = row[2] if len(row) > 2 and row[2] is not None else None
                            return _out(row[0], row[1] if len(row) > 1 else None, price, None, None)
                    except oracledb.Error:
                        try:
                            cur.execute(f"""
                                SELECT {itemcode_col}, LOCATIONCODE FROM {qualified}
                                WHERE TRIM({col}) = TRIM(:code) AND ROWNUM = 1
                            """, code=code_str)
                            row = cur.fetchone()
                            if row and row[0]:
                                return _out(row[0], row[1] if len(row) > 1 else None, None, None, None)
                        except oracledb.Error:
                            try:
                                cur.execute(f"""
                                    SELECT {itemcode_col} FROM {qualified}
                                    WHERE TRIM({col}) = TRIM(:code) AND ROWNUM = 1
                                """, code=code_str)
                                row = cur.fetchone()
                                if row and row[0]:
                                    return _out(row[0], None, None, None, None)
                            except oracledb.Error:
                                pass
    return None, None, None, None, None


def _resolve_itemcode_from_alternate(cur, code):
    """Resolve barcode/code to ITEMCODE from ITEMALTERNATEUOMMAP. Returns itemcode or None."""
    ic, _, _, _, _ = _resolve_itemcode_location_from_alternate(cur, code)
    return ic


def _get_item_names_from_master(cur, itemcodes):
    """Look up ITEMNAME from itemmaster by ITEMCODE; also resolve via ITEMALTERNATEUOMMAP. Returns dict itemcode_str -> itemname."""
    details = _get_item_details_from_master(cur, itemcodes)
    return {k: (v.get('name') or '') for k, v in details.items()}


def _get_item_details_from_master(cur, itemcodes):
    """Look up ITEMNAME, BASEUOM, ITEMNAMEARA, COSTPRICE, AVERAGECOST, PREVAMOUNT, STORE from itemmaster by ITEMCODE; STORE from ITEMSTORE view by ITEMCODE. Returns dict itemcode_str -> { name, baseuom, itemnameara, costprice, averagecost, prevamount, store }."""
    codes = [str(c).strip() for c in (itemcodes or []) if c is not None and str(c).strip()]
    if not codes:
        return {}
    result = {}
    for code in set(codes):
        rec = {'name': '', 'baseuom': '', 'itemnameara': '', 'costprice': None, 'averagecost': None, 'prevamount': None, 'store': None}
        try:
            cur.execute("""
                SELECT itemname, baseuom, itemnameara, costprice, averagecost, prevamount FROM itemmaster
                WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1
            """, code=code)
            row = cur.fetchone()
            if row:
                rec['name'] = str(row[0]).strip() if row[0] else ''
                rec['baseuom'] = str(row[1]).strip() if len(row) > 1 and row[1] else ''
                rec['itemnameara'] = _decode_arabic_from_db(str(row[2]).strip() if len(row) > 2 and row[2] else '')
                if len(row) > 3 and row[3] is not None:
                    rec['costprice'] = row[3]
                if len(row) > 4 and row[4] is not None:
                    rec['averagecost'] = row[4]
                if len(row) > 5 and row[5] is not None:
                    rec['prevamount'] = row[5]
            result[code] = rec
        except oracledb.Error as e:
            err_str = str(e).upper()
            if 'ORA-00904' in err_str or '00904' in err_str:
                try:
                    cur.execute("""
                        SELECT itemname, baseuom, itemnameara, costprice, averagecost FROM itemmaster
                        WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1
                    """, code=code)
                    row = cur.fetchone()
                    if row:
                        rec['name'] = str(row[0]).strip() if row[0] else ''
                        rec['baseuom'] = str(row[1]).strip() if len(row) > 1 and row[1] else ''
                        rec['itemnameara'] = _decode_arabic_from_db(str(row[2]).strip() if len(row) > 2 and row[2] else '')
                        if len(row) > 3 and row[3] is not None:
                            rec['costprice'] = row[3]
                        if len(row) > 4 and row[4] is not None:
                            rec['averagecost'] = row[4]
                    result[code] = rec
                except oracledb.Error:
                    try:
                        cur.execute("""
                            SELECT itemname, baseuom, itemnameara FROM itemmaster
                            WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1
                        """, code=code)
                        row = cur.fetchone()
                        if row:
                            rec['name'] = str(row[0]).strip() if row[0] else ''
                            rec['baseuom'] = str(row[1]).strip() if len(row) > 1 and row[1] else ''
                            rec['itemnameara'] = _decode_arabic_from_db(str(row[2]).strip() if len(row) > 2 and row[2] else '')
                        result[code] = rec
                    except oracledb.Error:
                        try:
                            cur.execute("""
                                SELECT itemname, baseuom FROM itemmaster
                                WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1
                            """, code=code)
                            row = cur.fetchone()
                            if row:
                                rec['name'] = str(row[0]).strip() if row[0] else ''
                                rec['baseuom'] = str(row[1]).strip() if len(row) > 1 and row[1] else ''
                            result[code] = rec
                        except oracledb.Error:
                            result[code] = rec
            else:
                result[code] = rec
        if not (result.get(code) or {}).get('name'):
            itemcode = _resolve_itemcode_from_alternate(cur, code)
            if itemcode:
                try:
                    cur.execute("""
                        SELECT itemname, baseuom, itemnameara FROM itemmaster
                        WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1
                    """, code=itemcode)
                    row = cur.fetchone()
                    if row:
                        result[code] = {
                            'name': str(row[0]).strip() if row[0] else '',
                            'baseuom': str(row[1]).strip() if len(row) > 1 and row[1] else '',
                            'itemnameara': _decode_arabic_from_db(str(row[2]).strip() if len(row) > 2 and row[2] else ''),
                        }
                    else:
                        result[code] = {'name': '', 'baseuom': '', 'itemnameara': ''}
                except oracledb.Error:
                    try:
                        cur.execute("SELECT itemname FROM itemmaster WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1", code=itemcode)
                        row = cur.fetchone()
                        result[code] = {
                            'name': str(row[0]).strip() if row and row[0] else '',
                            'baseuom': '',
                            'itemnameara': '',
                        }
                    except oracledb.Error:
                        result[code] = {'name': '', 'baseuom': '', 'itemnameara': ''}
            else:
                result[code] = result.get(code, {'name': '', 'baseuom': '', 'itemnameara': ''})
    # Fetch STORE from ITEMSTORE view by ITEMCODE (normalized: spaces removed)
    for code in result:
        try:
            cur.execute("""
                SELECT STORE FROM ITEMSTORE WHERE UPPER(TRIM(TO_CHAR(ITEMCODE))) = UPPER(:code) AND ROWNUM = 1
            """, code=code)
            row = cur.fetchone()
            if row and row[0] is not None:
                result[code]['store'] = _normalize_store(row[0])
        except oracledb.Error:
            pass
        if result[code].get('store') is None or result[code].get('store') == '':
            result[code]['store'] = 'STORE1'
    return result


def _location_to_num(location_code, default=1):
    """Convert location code to NUMBER for hold table (LOCATIONCODE is NUMBER)."""
    s = str(location_code or '').strip()
    if not s:
        return default
    if s.isdigit():
        return _to_int(s, default)
    digits = ''.join(c for c in s if c.isdigit())
    return _to_int(digits, default) if digits else default


def _ensure_billnotable(cur):
    """Create BILLNOTABLE if not exists. BILLDATE=date, BILLTIME=time only (12-hour with AM/PM), COUNTERCODE."""
    create_sql = f"""
        CREATE TABLE {BILLNO_TABLE_NAME} (
            BILLNO NUMBER NOT NULL,
            FLAG CHAR(1) DEFAULT 'n',
            BILLDATE DATE DEFAULT SYSDATE NOT NULL,
            BILLTIME VARCHAR2(15) DEFAULT TO_CHAR(SYSDATE, 'HH12:MI:SS AM'),
            COUNTERCODE VARCHAR2(50)
        )
    """
    try:
        cur.execute(create_sql)
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00955' in err_str or '00955' in err_str:
            pass
        elif 'ORA-01031' in err_str or '01031' in err_str:
            pass
        else:
            print(f"[BillNo] {BILLNO_TABLE_NAME} create failed: {e}")
            raise


def _ensure_billdtl(cur):
    """Create BILLDTL if not exists. Includes ITDISC, STORE1..STORE5, COST (costprice), AVERAGECOST, BASEQTY, RESETNO, POINTS, STORE."""
    create_sql = f"""
        CREATE TABLE {BILLDTL_TABLE_NAME} (
            LOCATIONCODE VARCHAR2(50),
            BILLNO NUMBER NOT NULL,
            SLNO NUMBER NOT NULL,
            ITEMCODE VARCHAR2(50),
            QUANTITY NUMBER,
            RATE NUMBER,
            RESETNO NUMBER DEFAULT 1,
            POINTS NUMBER,
            STORE VARCHAR2(50),
            ITDISC NUMBER DEFAULT 0,
            STORE1 NUMBER DEFAULT 0,
            STORE2 NUMBER DEFAULT 0,
            STORE3 NUMBER DEFAULT 0,
            STORE4 NUMBER DEFAULT 0,
            STORE5 NUMBER DEFAULT 0,
            COST NUMBER,
            AVERAGECOST NUMBER,
            BASEQTY NUMBER,
            UNITOFMEASUREMENT VARCHAR2(50)
        )
    """
    try:
        cur.execute(create_sql)
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00955' in err_str or '00955' in err_str:
            pass
        elif 'ORA-01031' in err_str or '01031' in err_str:
            pass
        else:
            print(f"[BILLDTL] create failed: {e}")
            raise


def _ensure_billdtlhistory(cur):
    """Create BILLDTLHISTORY if not exists. Same layout as BILLDTL for mirrored detail lines."""
    create_sql = f"""
        CREATE TABLE {BILLDTLHISTORY_TABLE_NAME} (
            LOCATIONCODE VARCHAR2(50),
            BILLNO NUMBER NOT NULL,
            SLNO NUMBER NOT NULL,
            ITEMCODE VARCHAR2(50),
            QUANTITY NUMBER,
            RATE NUMBER,
            RESETNO NUMBER DEFAULT 1,
            POINTS NUMBER,
            STORE VARCHAR2(50),
            ITDISC NUMBER DEFAULT 0,
            STORE1 NUMBER DEFAULT 0,
            STORE2 NUMBER DEFAULT 0,
            STORE3 NUMBER DEFAULT 0,
            STORE4 NUMBER DEFAULT 0,
            STORE5 NUMBER DEFAULT 0,
            COST NUMBER,
            AVERAGECOST NUMBER,
            BASEQTY NUMBER,
            UNITOFMEASUREMENT VARCHAR2(50)
        )
    """
    try:
        cur.execute(create_sql)
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00955' in err_str or '00955' in err_str:
            pass
        elif 'ORA-01031' in err_str or '01031' in err_str:
            pass
        else:
            print(f"[BILLDTLHISTORY] create failed: {e}")
            raise


def _ensure_billhdr(cur):
    """Create BILLHDR if not exists. Columns: LOCATIONCODE, BILLNO, BILLDATE, BILLTYPE, COUNTERCODE, RESETNO, SESSIONCODE, PREVPOINTS, NETBILLAMOUNT, CUSTOMERCODE, CUSTOMERNAME."""
    create_sql = f"""
        CREATE TABLE {BILLHDR_TABLE_NAME} (
            LOCATIONCODE VARCHAR2(50),
            BILLNO NUMBER NOT NULL,
            BILLDATE DATE DEFAULT SYSDATE NOT NULL,
            BILLTYPE CHAR(1) DEFAULT 'C',
            COUNTERCODE VARCHAR2(50),
            RESETNO NUMBER DEFAULT 1,
            SESSIONCODE NUMBER DEFAULT 0,
            PREVPOINTS NUMBER DEFAULT 0,
            NETBILLAMOUNT NUMBER,
            CUSTOMERCODE VARCHAR2(100),
            CUSTOMERNAME VARCHAR2(255)
        )
    """
    try:
        cur.execute(create_sql)
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00955' in err_str or '00955' in err_str:
            pass
        elif 'ORA-01031' in err_str or '01031' in err_str:
            pass
        else:
            print(f"[BILLHDR] create failed: {e}")
            raise


def _ensure_billhdrhistory(cur):
    """Create BILLHDRHISTORY if not exists. Same layout as BILLHDR for mirrored header rows."""
    create_sql = f"""
        CREATE TABLE {BILLHDRHISTORY_TABLE_NAME} (
            LOCATIONCODE VARCHAR2(50),
            BILLNO NUMBER NOT NULL,
            BILLDATE DATE DEFAULT SYSDATE NOT NULL,
            BILLTYPE CHAR(1) DEFAULT 'C',
            COUNTERCODE VARCHAR2(50),
            RESETNO NUMBER DEFAULT 1,
            SESSIONCODE NUMBER DEFAULT 0,
            PREVPOINTS NUMBER DEFAULT 0,
            NETBILLAMOUNT NUMBER,
            CUSTOMERCODE VARCHAR2(100),
            CUSTOMERNAME VARCHAR2(255)
        )
    """
    try:
        cur.execute(create_sql)
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00955' in err_str or '00955' in err_str:
            pass
        elif 'ORA-01031' in err_str or '01031' in err_str:
            pass
        else:
            print(f"[BILLHDRHISTORY] create failed: {e}")
            raise


def _ensure_billhdr_cardamount_column(cur):
    """Add CARDAMOUNT to BILLHDR / BILLHDRHISTORY when missing (card portion for split payment)."""
    for tbl in (BILLHDR_TABLE_NAME, BILLHDRHISTORY_TABLE_NAME):
        try:
            cur.execute(f"ALTER TABLE {tbl} ADD (CARDAMOUNT NUMBER)")
        except oracledb.Error as e:
            err_str = str(e).upper()
            if (
                'ORA-01430' in err_str
                or '01430' in err_str
                or 'ORA-00955' in err_str
                or '00955' in err_str
                or 'ORA-01031' in err_str
                or '01031' in err_str
            ):
                pass
            else:
                pass


def _ensure_billhdr_cardno_cardtype_columns(cur):
    """Add CARDNO, CARDTYPE to BILLHDR / BILLHDRHISTORY when missing (card payment metadata)."""
    for tbl in (BILLHDR_TABLE_NAME, BILLHDRHISTORY_TABLE_NAME):
        for col_sql in (
            f"ALTER TABLE {tbl} ADD (CARDNO VARCHAR2(50))",
            f"ALTER TABLE {tbl} ADD (CARDTYPE VARCHAR2(50))",
        ):
            try:
                cur.execute(col_sql)
            except oracledb.Error as e:
                err_str = str(e).upper()
                if (
                    'ORA-01430' in err_str
                    or '01430' in err_str
                    or 'ORA-00955' in err_str
                    or '00955' in err_str
                    or 'ORA-01031' in err_str
                    or '01031' in err_str
                ):
                    pass
                else:
                    pass


def _ensure_billhdr_extended_columns(cur):
    """Add BILLHDR columns used on Pay (discount, employee, audit, status, loyalty helpers) when missing."""
    _cols = (
        ("DISCOUNTAMOUNT", "NUMBER"),
        ("EMPLOYEECODE", "VARCHAR2(50)"),
        ("BILLTIME", "VARCHAR2(20)"),
        ("DELFLAG", "CHAR(1)"),
        ("CREATEDBY", "VARCHAR2(100)"),
        ("CREATEDDATE", "DATE"),
        ("BILLSTATUS", "CHAR(1)"),
        ("SALESMANCODE", "NUMBER"),
        ("TRANSACTIONNO", "NUMBER"),
        ("ORDERNO", "NUMBER"),
        ("ENTRYNO", "NUMBER"),
        ("ADDRESS", "VARCHAR2(255)"),
        ("PREVCARDNO", "VARCHAR2(100)"),
        ("LPONO", "NUMBER"),
        ("REDEMPTIONAMOUNT", "NUMBER"),
        ("REDEMPTIONPOINT", "NUMBER"),
        ("TOTALPOINT", "NUMBER"),
        ("HELPERCODE1", "NUMBER"),
        ("HELPERCODE2", "NUMBER"),
        ("GVTYPE", "VARCHAR2(50)"),
        ("CHANNELCODE", "NUMBER"),
        ("ITEMCOUNT", "NUMBER"),
    )
    for tbl in (BILLHDR_TABLE_NAME, BILLHDRHISTORY_TABLE_NAME):
        for col_name, col_type in _cols:
            try:
                cur.execute(f"ALTER TABLE {tbl} ADD ({col_name} {col_type})")
            except oracledb.Error as e:
                err_str = str(e).upper()
                if (
                    "ORA-01430" in err_str
                    or "01430" in err_str
                    or "ORA-00955" in err_str
                    or "00955" in err_str
                    or "ORA-01031" in err_str
                    or "01031" in err_str
                ):
                    pass
                else:
                    pass


def _billtype_from_invoicecode(invoice_code):
    """BILLHDR.BILLTYPE: only C or R — cash vs credit from customer INVOICECODE ('2' -> R, else C)."""
    if invoice_code is None:
        return 'C'
    v = str(invoice_code).strip()
    if v == '2':
        return 'R'
    return 'C'


def _prevcardno_from_customer(customer_code):
    """PREVCARDNO stores the same value as CUSTOMERCODE (VARCHAR2); NUMBER columns fall back in _execute_hdr_ext_safe."""
    if customer_code is None:
        return None
    s = str(customer_code).strip()
    return s if s else None


def _billdtl_store_index(store_val):
    """Legacy BILLDTL.STORE is often NUMBER (1..10). Parse STORE1 / STORE2 / '3' → 1..10; default 1."""
    s = str(store_val or "").strip()
    if not s:
        return 1
    for part in (s.replace("STORE", "").replace("store", ""), s):
        part = (part or "").strip()
        try:
            n = int(part)
            if 1 <= n <= 10:
                return n
        except (TypeError, ValueError):
            pass
    return 1


def _itemcode_numeric_if_possible(item_code):
    """If ITEMCODE column is NUMBER, bind int; keep str for alphanumeric codes."""
    if item_code is None:
        return item_code
    if isinstance(item_code, (int, float)) and not isinstance(item_code, bool):
        try:
            if float(item_code) == int(float(item_code)):
                return int(item_code)
        except (TypeError, ValueError):
            pass
        return item_code
    s = str(item_code).strip()
    if not s:
        return item_code
    if s.isdigit():
        try:
            return int(s)
        except ValueError:
            return item_code
    try:
        f = float(s)
        if f == int(f):
            return int(f)
    except (TypeError, ValueError):
        pass
    return item_code


def _billdtl_candidate_binds_for_01722(bind, store_val, location_code):
    """Alternate binds when legacy NUMBER columns reject strings (LOCATIONCODE, STORE, ITEMCODE)."""
    cands = []
    seen = set()

    def _sig(b):
        return tuple(sorted((k, repr(v)) for k, v in b.items()))

    def _add(b):
        if b == bind:
            return
        s = _sig(b)
        if s in seen:
            return
        seen.add(s)
        cands.append(b)

    combo = dict(bind)
    if "store" in combo:
        combo["store"] = _billdtl_store_index(store_val)
    if "itemcode" in combo:
        combo["itemcode"] = _itemcode_numeric_if_possible(combo["itemcode"])
    if "loc" in combo and location_code is not None:
        combo["loc"] = _location_to_num(location_code, 1)
    _add(combo)

    loc_item = dict(bind)
    if "loc" in loc_item and location_code is not None:
        loc_item["loc"] = _location_to_num(location_code, 1)
    if "itemcode" in loc_item:
        loc_item["itemcode"] = _itemcode_numeric_if_possible(loc_item["itemcode"])
    _add(loc_item)

    loc_only = dict(bind)
    if "loc" in loc_only and location_code is not None:
        loc_only["loc"] = _location_to_num(location_code, 1)
    _add(loc_only)

    # Legacy VARCHAR2 LOCATIONCODE: keep string form (e.g. '8') when numeric bind failed.
    if location_code is not None and "loc" in bind:
        loc_str = str(location_code).strip()
        if loc_str:
            ls = dict(bind)
            ls["loc"] = loc_str
            _add(ls)

    # Legacy UNITOFMEASUREMENT as NUMBER or incompatible type — bind NULL.
    if bind.get("uom") is not None:
        for base in (bind, combo, loc_item, loc_only):
            if "uom" not in base:
                continue
            u = dict(base)
            u["uom"] = None
            _add(u)

    # POINTS sometimes INTEGER-only; whole floats → int.
    if "points" in bind and isinstance(bind.get("points"), float):
        try:
            pv = bind["points"]
            if pv == int(pv):
                pf = dict(bind)
                pf["points"] = int(pv)
                _add(pf)
        except (TypeError, ValueError):
            pass

    return cands


def _execute_hdr_ext_safe(cur, sql, bind):
    """If INSERT/UPDATE fails with ORA-01722, retry PREVCARDNO NULL and/or EMPLOYEECODE as numeric or NULL."""
    try:
        cur.execute(sql, bind)
        return
    except oracledb.Error as e:
        if "01722" not in str(e).upper():
            raise
    if bind.get("prev_card_no") is not None:
        b0 = dict(bind)
        b0["prev_card_no"] = None
        try:
            cur.execute(sql, b0)
            return
        except oracledb.Error as e0:
            if "01722" not in str(e0).upper():
                raise
    b2 = dict(bind)
    b2["prev_card_no"] = None
    if bind.get("employeecode") is not None:
        b2["employeecode"] = _itemcode_numeric_if_possible(str(bind.get("employeecode")))
    try:
        cur.execute(sql, b2)
        return
    except oracledb.Error as e2:
        if "01722" not in str(e2).upper():
            raise
    b3 = dict(bind)
    b3["prev_card_no"] = None
    b3["employeecode"] = None
    cur.execute(sql, b3)


def _billno_flag_char(value):
    """Normalize FLAG for BILLNOTABLE to 'n' or 'y' (CHAR(1)). Default 'n'."""
    if value is None:
        return 'N'
    s = str(value).strip().lower()
    return 'Y' if s == 'Y' else 'N'


def _bill_date_business_iso_from_request(data):
    """
    Session / business bill date from client (counter DATEOFOPEN), YYYY-MM-DD or None.
    Aligns BILLHDR.BILLDATE and BILLNOTABLE.BILLDATE with the counter-open day instead of wall-clock SYSDATE.
    """
    if not data:
        return None
    _bd = data.get('billDate') or data.get('bill_date') or data.get('BILLDATE')
    if _bd is None or _bd == '':
        return None
    s = str(_bd).strip()
    if len(s) < 10:
        return None
    head = s[:10]
    if head[4:5] != '-' or head[7:8] != '-':
        return None
    y, m, d = head.split('-')
    if not (y.isdigit() and m.isdigit() and d.isdigit()):
        return None
    return head


@app.route('/api/billno/next', methods=['GET', 'POST'])
def create_next_billno():
    """
    Create next bill no:
    1) If counter code given: check DB for existing row with same COUNTERCODE and FLAG='N'; if found, return that BILLNO.
    2) Else: new_billno = MAX(BILLNO)+1, insert into BILLNOTABLE, return new_billno.
    """
    data = request.get_json(silent=True) or {}
    _bill_date_lookup = dict(data)
    _arg_bd = request.args.get('billDate') or request.args.get('bill_date')
    if _arg_bd and not (_bill_date_lookup.get('billDate') or _bill_date_lookup.get('bill_date')):
        _bill_date_lookup['billDate'] = _arg_bd
    bill_date_business = _bill_date_business_iso_from_request(_bill_date_lookup)
    _billdate_sql = "TO_DATE(:billdate_business, 'YYYY-MM-DD')" if bill_date_business else "SYSDATE"
    _billno_ins_bind_extra = {"billdate_business": bill_date_business} if bill_date_business else {}
    _cnt = data.get('counterCode') or data.get('counter_code') or request.args.get('counterCode') or request.args.get('counter_code')
    counter_code = str(_cnt).strip() if _cnt is not None else ''
    counter_code = counter_code or None
    conn = _get_connection()
    if not conn:
        return jsonify({"error": "Database unavailable", "billNo": None}), 503
    cur = None
    try:
        cur = conn.cursor()
        _ensure_billnotable(cur)
        counter_code_val = (counter_code if isinstance(counter_code, str) else str(counter_code or '').strip()) or None
        # First: if we have a counter code, try to reuse an existing BILLNO for this counter with FLAG='N'
        if counter_code_val:
            try:
                cur.execute(f"""
                    SELECT BILLNO FROM (
                        SELECT BILLNO FROM {BILLNO_TABLE_NAME}
                        WHERE COUNTERCODE = :cc AND (FLAG = 'N' OR FLAG IS NULL)
                        ORDER BY BILLNO
                    ) WHERE ROWNUM = 1
                """, {"cc": counter_code_val})
                row = cur.fetchone()
                if row and row[0] is not None:
                    existing_billno = _to_int(row[0], None)
                    if existing_billno is not None:
                        return jsonify({"ok": True, "billNo": existing_billno})
            except oracledb.Error as e:
                err_str = str(e).upper()
                # ORA-00904: invalid identifier; ORA-01722: invalid number (e.g. COUNTERCODE type mismatch)
                if 'ORA-00904' not in err_str and '00904' not in err_str and 'ORA-01722' not in err_str and '01722' not in err_str:
                    raise
        # Else: no matching row or no counter code – create new: MAX(BILLNO)+1, insert
        try:
            cur.execute(f"SELECT NVL(MAX(BILLNO), 0) AS LAST_BILLNO FROM {BILLNO_TABLE_NAME}")
            row = cur.fetchone()
            last_billno = _to_int(row[0], 0) if row else 0
        except oracledb.Error as e:
            err_str = str(e).upper()
            if 'ORA-01722' in err_str or '01722' in err_str:
                # BILLNO may be VARCHAR with non-numeric data; use 0 and rely on insert
                last_billno = 0
            else:
                raise
        new_billno = int(last_billno + 1)
        try:
            cur.execute(
                f"INSERT INTO {BILLNO_TABLE_NAME} (BILLNO, FLAG, BILLDATE, BILLTIME, COUNTERCODE) VALUES (:billno, 'N', {_billdate_sql}, TO_CHAR(SYSDATE, 'HH12:MI:SS AM'), :countercode)",
                {**{"billno": new_billno, "countercode": counter_code_val}, **_billno_ins_bind_extra},
            )
        except oracledb.Error as col_err:
            err_str = str(col_err).upper()
            if 'ORA-00913' in err_str or 'ORA-00904' in err_str or '00913' in err_str or '00904' in err_str:
                cur.execute(
                    f"INSERT INTO {BILLNO_TABLE_NAME} (BILLNO, FLAG, BILLDATE, BILLTIME) VALUES (:billno, 'N', {_billdate_sql}, TO_CHAR(SYSDATE, 'HH12:MI:SS AM'))",
                    {**{"billno": new_billno}, **_billno_ins_bind_extra},
                )
            elif 'ORA-01722' in err_str or '01722' in err_str:
                cur.execute(
                    f"INSERT INTO {BILLNO_TABLE_NAME} (BILLNO, FLAG, BILLDATE, BILLTIME) VALUES (:billno, 'N', {_billdate_sql}, TO_CHAR(SYSDATE, 'HH12:MI:SS AM'))",
                    {**{"billno": new_billno}, **_billno_ins_bind_extra},
                )
            else:
                raise
        conn.commit()
        return jsonify({"ok": True, "billNo": new_billno})
    except oracledb.Error as e:
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        print(f"[BillNo] {BILLNO_TABLE_NAME} error: {e}")
        return jsonify({"ok": False, "error": str(e), "billNo": None}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


@app.route('/api/billno/paid', methods=['POST'])
def mark_bill_paid():
    """Set FLAG='Y' for the given billNo in BILLNOTABLE (call when bill is paid)."""
    data = request.get_json(silent=True) or {}
    bill_no = data.get('billNo') or data.get('billno')
    if bill_no is None:
        return jsonify({"ok": False, "error": "billNo required"}), 400
    try:
        bill_no = int(bill_no)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "billNo must be a number"}), 400
    conn = _get_connection()
    if not conn:
        return jsonify({"ok": False, "error": "Database unavailable"}), 503
    cur = None
    try:
        cur = conn.cursor()
        cur.execute(
            f"UPDATE {BILLNO_TABLE_NAME} SET FLAG = 'Y' WHERE BILLNO = :billno",
            {"billno": bill_no}
        )
        conn.commit()
        return jsonify({"ok": True})
    except oracledb.Error as e:
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        print(f"[BillNo] paid update error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


TBLCOUNTERSALE_TABLE_NAME = 'TBLCOUNTERSALE'

# TBLCOUNTERSALE counter column names seen in the wild (ORA-00904 skips invalid ones).
_TCS_COUNTER_COLS = (
    'COUNTERCODE',
    'CNTCODE',
    'COUNTER',
    'POSCOUNTERCODE',
    'COUNTERNO',
    'CNT_NO',
    'POSCOUNTER',
)


def _json_safe_db_value(v):
    """Make Oracle row values JSON-serializable for Flask jsonify."""
    if v is None:
        return None
    if isinstance(v, datetime.datetime):
        return v.isoformat()
    if isinstance(v, datetime.date):
        return v.isoformat()
    if type(v).__name__ == 'Decimal':
        try:
            f = float(v)
            return int(f) if f == int(f) else f
        except (TypeError, ValueError):
            return str(v)
    return v


def _row_dict_json_safe(row):
    if not row:
        return row
    return {k: _json_safe_db_value(v) for k, v in row.items()}


def _countersale_first_row_global(cur):
    """If no row matches counter: first row of TBLCOUNTERSALE (CODE + NAME), ROWNUM = 1."""
    for code_col in ('CODE', 'CUSTOMERCODE'):
        for name_col in ('NAME', 'CUSTOMERNAME'):
            try:
                cur.execute(
                    f'SELECT TRIM(cs.{code_col}), TRIM(cs.{name_col}) '
                    f'FROM {TBLCOUNTERSALE_TABLE_NAME} cs WHERE ROWNUM = 1'
                )
                row = cur.fetchone()
                if row and row[0] is not None:
                    c = str(row[0]).strip()
                    if c:
                        n = None
                        if len(row) > 1 and row[1] is not None:
                            n = str(row[1]).strip() or None
                        return c, n
            except oracledb.Error as e:
                err = str(e).upper()
                if 'ORA-00904' in err or '00904' in err:
                    continue
                if 'ORA-00942' in err or '00942' in err:
                    return None, None
                continue
        try:
            cur.execute(
                f'SELECT TRIM(cs.{code_col}) FROM {TBLCOUNTERSALE_TABLE_NAME} cs WHERE ROWNUM = 1'
            )
            row = cur.fetchone()
            if row and row[0] is not None:
                c = str(row[0]).strip()
                if c:
                    return c, None
        except oracledb.Error:
            continue
    return None, None


def _customer_name_for_customercode(cur, customer_code):
    """Return CUSTOMERNAME for CUSTOMERCODE, or the code if the row exists but name is empty."""
    if not customer_code:
        return None
    code_s = str(customer_code).strip()
    try:
        cur.execute(
            """
            SELECT TRIM(c.customername) FROM customer c
            WHERE TRIM(c.customercode) = TRIM(:code) AND ROWNUM = 1
            """,
            {"code": code_s},
        )
        row = cur.fetchone()
        if not row:
            return None
        if row[0] is not None:
            n = str(row[0]).strip()
            if n:
                return n
        return code_s
    except oracledb.Error:
        pass
    return None


def _default_customer_from_tbl_countersale(cur, counter_code, location_code=None):
    """
    Walk-in default: first TBLCOUNTERSALE row for this counter (ROWNUM = 1 after filter).
    Uses CODE/CUSTOMERCODE and NAME/CUSTOMERNAME. If no counter match, uses first row of the table.
    Name prefers customer.master; else TBLCOUNTERSALE name; else customer code string.
    """
    cc = str(counter_code).strip() if counter_code is not None else ''
    loc = str(location_code).strip() if location_code not in (None, '') else None

    def row_attempts(counter_cc):
        for code_col in ('CODE', 'CUSTOMERCODE'):
            for counter_col in _TCS_COUNTER_COLS:
                for use_loc in (False, True):
                    if use_loc and not loc:
                        continue
                    binds = {'cnt': counter_cc}
                    wh = f'TRIM(cs.{counter_col}) = TRIM(:cnt)'
                    if use_loc:
                        wh += (
                            ' AND (cs.LOCATIONCODE IS NULL OR TRIM(cs.LOCATIONCODE) = TRIM(:loc))'
                        )
                        binds['loc'] = loc
                    base = f'FROM {TBLCOUNTERSALE_TABLE_NAME} cs WHERE {wh} AND ROWNUM = 1'
                    for name_col in ('NAME', 'CUSTOMERNAME'):
                        yield (
                            f'SELECT TRIM(cs.{code_col}), TRIM(cs.{name_col}) {base}',
                            binds,
                            True,
                        )
                    yield f'SELECT TRIM(cs.{code_col}) {base}', binds, False

    code_val = None
    name_tbl = None
    if cc:
        for sql, binds, has_name_col in row_attempts(cc):
            try:
                cur.execute(sql, binds)
                row = cur.fetchone()
                if not row or row[0] is None:
                    continue
                s = str(row[0]).strip()
                if not s:
                    continue
                code_val = s
                if has_name_col and len(row) > 1 and row[1] is not None:
                    nt = str(row[1]).strip()
                    if nt:
                        name_tbl = nt
                break
            except oracledb.Error as e:
                err = str(e).upper()
                if 'ORA-00904' in err or '00904' in err:
                    continue
                if 'ORA-00942' in err or '00942' in err:
                    return None, None
                continue

    if not code_val:
        gv, gn = _countersale_first_row_global(cur)
        if gv:
            code_val = gv
            if gn:
                name_tbl = gn

    if not code_val:
        return None, None
    cname = _customer_name_for_customercode(cur, code_val)
    if not cname and name_tbl:
        cname = name_tbl
    if not cname:
        cname = str(code_val)
    return code_val, cname


def _customer_row_for_pos(cur, customer_code):
    """Single customer row shaped like /api/customers (no billhdrhistory filter)."""
    code_s = str(customer_code).strip() if customer_code is not None else ''
    if not code_s:
        return None
    try:
        cur.execute(
            """
            SELECT
                c.locationcode,
                c.customercode,
                c.customercode || ' ' || c.customername AS cust_full_name,
                NVL(TRIM(g.categoryname), '') AS categoryname,
                c.flag,
                c.invoicecode,
                c.currentcreditamount,
                c.creditlimit,
                NVL(c.points, 0) AS points,
                NVL(TRIM(c.mobile), '') AS mobile
            FROM customer c
            LEFT JOIN tblcustomercategory g ON c.customercategory = g.categorycode
            WHERE TRIM(c.customercode) = TRIM(:code) AND ROWNUM = 1
            """,
            {'code': code_s},
        )
        row = cur.fetchone()
        if not row:
            return None
        columns = [col[0] for col in cur.description]
        return _row_dict_json_safe(dict(zip(columns, row)))
    except oracledb.Error:
        return None


@app.route('/api/billing/default-customer', methods=['GET', 'OPTIONS'])
def billing_default_customer():
    """Default walk-in customer for Billing: first TBLCOUNTERSALE row for this counter (CODE + NAME)."""
    if request.method == 'OPTIONS':
        return '', 204
    counter_code = (request.args.get('counterCode') or request.args.get('counter_code') or '').strip()
    _loc = request.args.get('locationCode') or request.args.get('location_code')
    location_code = str(_loc).strip() if _loc not in (None, '') else ''
    location_code = location_code or None
    conn = _get_connection()
    if not conn:
        return jsonify({'ok': False, 'error': 'Database unavailable', 'customer': None}), 503
    cur = None
    try:
        cur = conn.cursor()
        dc, dn = _default_customer_from_tbl_countersale(cur, counter_code, location_code)
        if not dc:
            return jsonify({'ok': True, 'customer': None})
        full = _customer_row_for_pos(cur, dc)
        if full:
            merged = dict(full)
            merged['CUSTOMERCODE'] = merged.get('CUSTOMERCODE') or merged.get('customercode') or dc
            merged['customercode'] = merged.get('customercode') or merged.get('CUSTOMERCODE') or dc
            if not merged.get('CUST_FULL_NAME') and not merged.get('cust_full_name'):
                merged['CUST_FULL_NAME'] = f'{dc} {dn}'.strip()
            return jsonify({'ok': True, 'customer': merged})
        fallback = {
            'CUSTOMERCODE': dc,
            'customercode': dc,
            'CUSTOMERNAME': dn,
            'customername': dn,
            'CUST_FULL_NAME': f'{dc} {dn}'.strip(),
            'CATEGORYNAME': '',
            'FLAG': 'A',
            'INVOICECODE': None,
            'CURRENTCREDITAMOUNT': 0,
            'CREDITLIMIT': 0,
            'POINTS': 0,
            'MOBILE': '',
        }
        return jsonify({'ok': True, 'customer': fallback})
    except Exception as e:
        print(f'[billing/default-customer] {e}')
        return jsonify({'ok': False, 'error': str(e), 'customer': None}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


@app.route('/api/billdtl/insert', methods=['POST'])
def billdtl_insert():
    """On Pay: insert BILLHDR + BILLHDRHISTORY (header), then BILLDTL + BILLDTLHISTORY (lines). BILLTYPE is C or R only (from INVOICECODE)."""
    data = request.get_json(silent=True) or {}
    _loc = data.get('locationCode') or data.get('location_code')
    location_code = str(_loc).strip() if _loc is not None else ''
    location_code = location_code or None
    bill_no = data.get('billNo') or data.get('billno')
    items = data.get('items') or data.get('lines') or []
    _cnt = data.get('counterCode') or data.get('counter_code')
    counter_code = str(_cnt).strip() if _cnt is not None else None
    counter_code = counter_code or None
    invoice_code = data.get('invoiceCode') or data.get('invoice_code') or data.get('INVOICECODE')
    is_sales_return = data.get('isSalesReturn') in (True, 'true', '1', 1)
    bill_type = _billtype_from_invoicecode(invoice_code)
    if bill_no is None:
        return jsonify({"ok": False, "error": "billNo required"}), 400
    # PREVPOINTS: integer part of totalPoints only (e.g. 1.65 -> 1)
    _pts = data.get('totalPoints') or data.get('total_points') or data.get('prevPoints') or data.get('prevpoints')
    try:
        prev_points = int(float(_pts)) if _pts is not None and _pts != '' else 0
    except (TypeError, ValueError):
        prev_points = 0
    # NETBILLAMOUNT, CUSTOMERCODE, CUSTOMERNAME for BILLHDR
    _net = data.get('netBillAmount') or data.get('net_bill_amount') or data.get('total') or data.get('billAmount')
    try:
        net_bill_amount = float(_net) if _net is not None and _net != '' else None
    except (TypeError, ValueError):
        net_bill_amount = None
    _cust_code = data.get('customerCode') or data.get('customer_code') or data.get('CUSTOMERCODE')
    customer_code = str(_cust_code).strip() if _cust_code is not None and _cust_code != '' else None
    _cust_name = data.get('customerName') or data.get('customer_name') or data.get('CUSTOMERNAME')
    customer_name = str(_cust_name).strip() if _cust_name is not None and _cust_name != '' else None
    _ec_hdr = data.get('employeeCode') or data.get('employeecode') or data.get('EMPLOYEECODE')
    employee_code = str(_ec_hdr).strip() if _ec_hdr is not None and str(_ec_hdr).strip() != '' else None
    if employee_code is None:
        employee_code = _employee_code_from_request()
    _cb_hdr = data.get('createdBy') or data.get('created_by') or data.get('CREATEDBY')
    if _cb_hdr is not None and str(_cb_hdr).strip() != '':
        created_by = str(_cb_hdr).strip()
    else:
        created_by = _username_from_request() or _employee_code_from_request() or 'POS'
    _card_amt = data.get('cardAmount') or data.get('card_amount') or data.get('CARDAMOUNT')
    try:
        card_amount = float(_card_amt) if _card_amt is not None and _card_amt != '' else None
    except (TypeError, ValueError):
        card_amount = None
    try:
        ca_num = float(card_amount) if card_amount is not None else 0.0
    except (TypeError, ValueError):
        ca_num = 0.0
    _cn = data.get('cardNo') or data.get('card_no') or data.get('CARDNO')
    card_no = str(_cn).strip() if _cn is not None and str(_cn).strip() != '' else None
    # CARDTYPE: NULL when no card; when any card amount, store MASTER only (ignore client cardType)
    card_type = 'MASTER' if ca_num > 0 else None
    # BILLHDR.CARDNO is NOT NULL in many schemas; bind 0 when no card was captured.
    if card_no is None:
        card_no = 0
    try:
        bill_no = int(bill_no)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "billNo must be a number"}), 400
    if not isinstance(items, list):
        return jsonify({"ok": False, "error": "items must be an array"}), 400
    item_count = len(items)
    bill_date_business = _bill_date_business_iso_from_request(data)
    billdate_hdr_sql = "TO_DATE(:billdate_business, 'YYYY-MM-DD')" if bill_date_business else "SYSDATE"
    _hdr_date_bind = {"billdate_business": bill_date_business} if bill_date_business else {}

    def _hdr_bind(bd):
        return {**bd, **_hdr_date_bind} if _hdr_date_bind else bd

    conn = _get_connection()
    if not conn:
        return jsonify({"ok": False, "error": "Database unavailable"}), 503
    cur = None
    inserted = 0
    try:
        cur = conn.cursor()
        # Store per item from ITEMSTORE by ITEMCODE (same as items fetch); no APPLICATIONUSER store
        _ensure_billhdr(cur)
        _ensure_billhdrhistory(cur)
        _ensure_billhdr_cardamount_column(cur)
        _ensure_billhdr_cardno_cardtype_columns(cur)
        _ensure_billhdr_extended_columns(cur)
        _ensure_billdtl(cur)
        _ensure_billdtlhistory(cur)
        if not customer_code:
            _dc, _dn = _default_customer_from_tbl_countersale(cur, counter_code, location_code)
            if _dc:
                customer_code = _dc
            if _dn and not customer_name:
                customer_name = _dn
        # Insert BILLHDR (+ BILLHDRHISTORY): ... NETBILLAMOUNT, CARDAMOUNT, CUSTOMERCODE, CUSTOMERNAME
        _hdr_bind_full = {
            "loc": location_code,
            "billno": bill_no,
            "billtype": bill_type,
            "countercode": counter_code,
            "prevpoints": prev_points,
            "netbillamount": net_bill_amount,
            "cardamount": card_amount,
            "cardno": card_no,
            "cardtype": card_type,
            "customercode": customer_code,
            "customername": customer_name,
        }
        _hdr_bind_min = {"loc": location_code, "billno": bill_no, "billtype": bill_type, "countercode": counter_code, "prevpoints": prev_points}
        _hdr_bind_no_card = {
            "loc": location_code,
            "billno": bill_no,
            "billtype": bill_type,
            "countercode": counter_code,
            "prevpoints": prev_points,
            "netbillamount": net_bill_amount,
            "customercode": customer_code,
            "customername": customer_name,
        }
        hdr_employeecode = (
            _username_from_request()
            or employee_code
            or _employee_code_from_request()
            or created_by
            or 'POS'
        )
        _hdr_bind_ext = {
            **_hdr_bind_full,
            "employeecode": hdr_employeecode,
            "createdby": created_by,
            "totalpoint": prev_points,
            "itemcount": item_count,
            "prev_card_no": _prevcardno_from_customer(customer_code),
        }
        for _hdr_tbl in (BILLHDR_TABLE_NAME, BILLHDRHISTORY_TABLE_NAME):
            try:
                _execute_hdr_ext_safe(
                    cur,
                    f"""
                    INSERT INTO {_hdr_tbl} (
                        LOCATIONCODE, BILLNO, BILLDATE, BILLTYPE, COUNTERCODE, RESETNO, SESSIONCODE, PREVPOINTS,
                        NETBILLAMOUNT, CARDAMOUNT, CARDNO, CARDTYPE, CUSTOMERCODE, CUSTOMERNAME,
                        DISCOUNTAMOUNT, EMPLOYEECODE, BILLTIME, DELFLAG, CREATEDBY, CREATEDDATE, BILLSTATUS,
                        SALESMANCODE, TRANSACTIONNO, ORDERNO, ENTRYNO, ADDRESS, PREVCARDNO, LPONO,
                        REDEMPTIONAMOUNT, REDEMPTIONPOINT, TOTALPOINT, HELPERCODE1, HELPERCODE2, GVTYPE, CHANNELCODE, ITEMCOUNT
                    ) VALUES (
                        :loc, :billno, {billdate_hdr_sql}, :billtype, :countercode, 1, 0, :prevpoints,
                        :netbillamount, :cardamount, :cardno, :cardtype, :customercode, :customername,
                        0, :employeecode, TO_CHAR(SYSDATE, 'HH24:MI:SS'), 'N', :createdby, SYSDATE, 'P',
                        1, 0, 0, 1, 'DIRECT SALE', :prev_card_no, 0,
                        0, 0, :totalpoint, 0, 0, 'NORMAL', 1, :itemcount
                    )
                    """,
                    _hdr_bind(_hdr_bind_ext),
                )
            except oracledb.Error as hdr_err:
                err_str = str(hdr_err).upper()
                if 'ORA-00904' in err_str or '00904' in err_str:
                    try:
                        cur.execute(
                            f"""
                            INSERT INTO {_hdr_tbl} (LOCATIONCODE, BILLNO, BILLDATE, BILLTYPE, COUNTERCODE, RESETNO, SESSIONCODE, PREVPOINTS, NETBILLAMOUNT, CARDAMOUNT, CARDNO, CARDTYPE, CUSTOMERCODE, CUSTOMERNAME)
                            VALUES (:loc, :billno, {billdate_hdr_sql}, :billtype, :countercode, 1, 0, :prevpoints, :netbillamount, :cardamount, :cardno, :cardtype, :customercode, :customername)
                            """,
                            _hdr_bind(_hdr_bind_full),
                        )
                    except oracledb.Error:
                        try:
                            cur.execute(
                                f"""
                                INSERT INTO {_hdr_tbl} (LOCATIONCODE, BILLNO, BILLDATE, BILLTYPE, COUNTERCODE, RESETNO, SESSIONCODE, PREVPOINTS, NETBILLAMOUNT, CARDAMOUNT, CUSTOMERCODE, CUSTOMERNAME)
                                VALUES (:loc, :billno, {billdate_hdr_sql}, :billtype, :countercode, 1, 0, :prevpoints, :netbillamount, :cardamount, :customercode, :customername)
                                """,
                                _hdr_bind(_hdr_bind_full),
                            )
                        except oracledb.Error:
                            try:
                                cur.execute(
                                    f"""
                                    INSERT INTO {_hdr_tbl} (LOCATIONCODE, BILLNO, BILLDATE, BILLTYPE, COUNTERCODE, RESETNO, SESSIONCODE, PREVPOINTS, NETBILLAMOUNT, CUSTOMERCODE, CUSTOMERNAME)
                                    VALUES (:loc, :billno, {billdate_hdr_sql}, :billtype, :countercode, 1, 0, :prevpoints, :netbillamount, :customercode, :customername)
                                    """,
                                    _hdr_bind(_hdr_bind_no_card),
                                )
                            except oracledb.Error:
                                try:
                                    cur.execute(
                                        f"""
                                        INSERT INTO {_hdr_tbl} (LOCATIONCODE, BILLNO, BILLDATE, BILLTYPE, COUNTERCODE, RESETNO, SESSIONCODE, PREVPOINTS)
                                        VALUES (:loc, :billno, {billdate_hdr_sql}, :billtype, :countercode, 1, 0, :prevpoints)
                                        """,
                                        _hdr_bind(_hdr_bind_min),
                                    )
                                except oracledb.Error:
                                    raise
                elif 'ORA-00001' not in err_str and '00001' not in err_str:
                    raise
                try:
                    _execute_hdr_ext_safe(
                        cur,
                        f"""
                        UPDATE {_hdr_tbl} SET LOCATIONCODE = :loc, BILLDATE = {billdate_hdr_sql}, BILLTYPE = :billtype, COUNTERCODE = :countercode, RESETNO = 1, SESSIONCODE = 0, PREVPOINTS = :prevpoints, NETBILLAMOUNT = :netbillamount, CARDAMOUNT = :cardamount, CARDNO = :cardno, CARDTYPE = :cardtype, CUSTOMERCODE = :customercode, CUSTOMERNAME = :customername, DISCOUNTAMOUNT = 0, EMPLOYEECODE = :employeecode, BILLTIME = TO_CHAR(SYSDATE, 'HH24:MI:SS'), DELFLAG = 'N', CREATEDBY = :createdby, CREATEDDATE = SYSDATE, BILLSTATUS = 'P', SALESMANCODE = 1, TRANSACTIONNO = 0, ORDERNO = 0, ENTRYNO = 1, ADDRESS = 'DIRECT SALE', PREVCARDNO = :prev_card_no, LPONO = 0, REDEMPTIONAMOUNT = 0, REDEMPTIONPOINT = 0, TOTALPOINT = :totalpoint, HELPERCODE1 = 0, HELPERCODE2 = 0, GVTYPE = 'NORMAL', CHANNELCODE = 1, ITEMCOUNT = :itemcount
                        WHERE BILLNO = :billno
                        """,
                        _hdr_bind(_hdr_bind_ext),
                    )
                except oracledb.Error as upd_err:
                    err_str = str(upd_err).upper()
                    if 'ORA-00904' in err_str or '00904' in err_str:
                        try:
                            cur.execute(
                                f"""
                                UPDATE {_hdr_tbl} SET LOCATIONCODE = :loc, BILLDATE = {billdate_hdr_sql}, BILLTYPE = :billtype, COUNTERCODE = :countercode, RESETNO = 1, SESSIONCODE = 0, PREVPOINTS = :prevpoints, NETBILLAMOUNT = :netbillamount, CARDAMOUNT = :cardamount, CARDNO = :cardno, CARDTYPE = :cardtype, CUSTOMERCODE = :customercode, CUSTOMERNAME = :customername
                                WHERE BILLNO = :billno
                                """,
                                _hdr_bind(_hdr_bind_full),
                            )
                        except oracledb.Error:
                            try:
                                cur.execute(
                                    f"""
                                    UPDATE {_hdr_tbl} SET LOCATIONCODE = :loc, BILLDATE = {billdate_hdr_sql}, BILLTYPE = :billtype, COUNTERCODE = :countercode, RESETNO = 1, SESSIONCODE = 0, PREVPOINTS = :prevpoints, NETBILLAMOUNT = :netbillamount, CARDAMOUNT = :cardamount, CUSTOMERCODE = :customercode, CUSTOMERNAME = :customername
                                    WHERE BILLNO = :billno
                                    """,
                                    _hdr_bind(_hdr_bind_no_card),
                                )
                            except oracledb.Error:
                                try:
                                    cur.execute(
                                        f"""
                                        UPDATE {_hdr_tbl} SET LOCATIONCODE = :loc, BILLDATE = {billdate_hdr_sql}, BILLTYPE = :billtype, COUNTERCODE = :countercode, RESETNO = 1, SESSIONCODE = 0, PREVPOINTS = :prevpoints, NETBILLAMOUNT = :netbillamount, CUSTOMERCODE = :customercode, CUSTOMERNAME = :customername
                                        WHERE BILLNO = :billno
                                        """,
                                        _hdr_bind(_hdr_bind_no_card),
                                    )
                                except oracledb.Error:
                                    cur.execute(
                                        f"""
                                        UPDATE {_hdr_tbl} SET LOCATIONCODE = :loc, BILLDATE = {billdate_hdr_sql}, BILLTYPE = :billtype, COUNTERCODE = :countercode, RESETNO = 1, SESSIONCODE = 0, PREVPOINTS = :prevpoints
                                        WHERE BILLNO = :billno
                                        """,
                                        _hdr_bind(_hdr_bind_min),
                                    )
                    else:
                        pass
        # Remove any existing rows for this bill so insert is idempotent (avoids ORA-00001 on double Pay / re-submit)
        try:
            cur.execute(f"DELETE FROM {BILLDTL_TABLE_NAME} WHERE BILLNO = :billno", {"billno": bill_no})
        except oracledb.Error:
            pass
        try:
            cur.execute(f"DELETE FROM {BILLDTLHISTORY_TABLE_NAME} WHERE BILLNO = :billno", {"billno": bill_no})
        except oracledb.Error:
            pass
        _precodes = []
        for _it in items:
            if not _it or not isinstance(_it, dict):
                continue
            _pc = _it.get('itemCode') or _it.get('ITEMCODE') or _it.get('itemcode') or _it.get('id')
            _pcs = str(_pc).strip() if _pc is not None else ''
            if _pcs:
                _precodes.append(_pcs)
        _im_cost_by_code = _get_item_details_from_master(cur, _precodes)
        dtl_params_pay = []
        for slno, it in enumerate(items, start=1):
            if not it or not isinstance(it, dict):
                continue
            _ic = it.get('itemCode') or it.get('ITEMCODE') or it.get('itemcode') or it.get('id')
            item_code = str(_ic).strip() if _ic is not None else ''
            if not item_code:
                continue
            qty = it.get('quantity') or it.get('QUANTITY') or 0
            rate = it.get('rate') or it.get('RATE') or it.get('price') or 0
            _pt = it.get('points') or it.get('point') or it.get('POINTS') or it.get('POINT')
            try:
                points_val = float(_pt) if _pt is not None and _pt != '' else 0
            except (TypeError, ValueError):
                points_val = 0
            # Store from ITEMSTORE by ITEMCODE (normalized, default STORE1)
            item_store = 'STORE1'
            try:
                cur.execute("""
                    SELECT STORE FROM ITEMSTORE WHERE UPPER(TRIM(TO_CHAR(ITEMCODE))) = UPPER(:code) AND ROWNUM = 1
                """, code=item_code)
                row = cur.fetchone()
                if row and row[0] is not None:
                    item_store = _normalize_store(row[0]) or 'STORE1'
            except oracledb.Error:
                pass
            if not item_store or not str(item_store).strip():
                item_store = 'STORE1'
            store_val = item_store
            try:
                qty = float(qty) if qty is not None else 0
            except (TypeError, ValueError):
                qty = 0
            try:
                rate = float(rate) if rate is not None else 0
            except (TypeError, ValueError):
                rate = 0
            _cp_line = it.get('costPrice') or it.get('COSTPRICE') or it.get('costprice')
            cost_val = None
            if _cp_line is not None and _cp_line != '':
                try:
                    cost_val = float(_cp_line)
                except (TypeError, ValueError):
                    cost_val = None
            if cost_val is None:
                _imr = _im_cost_by_code.get(item_code) or {}
                _cp_im = _imr.get('costprice')
                if _cp_im is not None and _cp_im != '':
                    try:
                        cost_val = float(_cp_im)
                    except (TypeError, ValueError):
                        cost_val = None
            _ac_line = it.get('averageCost') or it.get('AVERAGECOST') or it.get('averagecost') or it.get('avgcost')
            avg_cost_val = None
            if _ac_line is not None and str(_ac_line).strip() != '':
                try:
                    avg_cost_val = float(_ac_line)
                except (TypeError, ValueError):
                    avg_cost_val = None
            if avg_cost_val is None:
                _imr_ac = _im_cost_by_code.get(item_code) or {}
                _ac_im = _imr_ac.get('averagecost')
                if _ac_im is not None and _ac_im != '':
                    try:
                        avg_cost_val = float(_ac_im)
                    except (TypeError, ValueError):
                        avg_cost_val = None
            # BASEQTY: ITEMMASTER line → 1 * COSTPRICE; ITEMALTERNATEUOMMAP → CONVERSIONFACTOR * COSTPRICE (factor from cart / lookup)
            _cf_line = it.get('conversionFactor') or it.get('CONVERSIONFACTOR') or it.get('factor') or it.get('Factor')
            try:
                _conv_mult = float(_cf_line) if _cf_line is not None and str(_cf_line).strip() != '' else 1.0
            except (TypeError, ValueError):
                _conv_mult = 1.0
            if _conv_mult <= 0:
                _conv_mult = 1.0
            baseqty_val = None
            if cost_val is not None:
                try:
                    baseqty_val = _conv_mult * float(cost_val)
                except (TypeError, ValueError):
                    baseqty_val = None
            _dtl_bind_full = {"loc": location_code, "billno": bill_no, "slno": slno, "itemcode": item_code, "qty": qty, "rate": rate, "points": points_val, "store": store_val}
            _dtl_bind_no_store = {"loc": location_code, "billno": bill_no, "slno": slno, "itemcode": item_code, "qty": qty, "rate": rate, "points": points_val}
            _dtl_bind_ext = {**_dtl_bind_full, "cost": cost_val}
            _dtl_bind_ext_baseqty = {**_dtl_bind_ext, "baseqty": baseqty_val}
            _dtl_bind_full_baseqty = {**_dtl_bind_full, "baseqty": baseqty_val}
            _dtl_bind_no_store_baseqty = {**_dtl_bind_no_store, "baseqty": baseqty_val}
            _im_row_pay = _im_cost_by_code.get(item_code) or {}
            _base_uom_pay = str(_im_row_pay.get('baseuom') or '').strip() or None
            _dtl_bind_ext_baseqty_uom = {**_dtl_bind_ext_baseqty, "uom": _base_uom_pay}
            _dtl_bind_ext_uom = {**_dtl_bind_ext, "uom": _base_uom_pay}
            _dtl_bind_full_baseqty_uom = {**_dtl_bind_full_baseqty, "uom": _base_uom_pay}
            _dtl_bind_full_uom = {**_dtl_bind_full, "uom": _base_uom_pay}
            _dtl_bind_no_store_baseqty_uom = {**_dtl_bind_no_store_baseqty, "uom": _base_uom_pay}
            _dtl_bind_no_store_uom = {**_dtl_bind_no_store, "uom": _base_uom_pay}
            _dtl_bind_ext_baseqty_uom_avg = {**_dtl_bind_ext_baseqty_uom, "avgcost": avg_cost_val}
            _dtl_bind_ext_uom_avg = {**_dtl_bind_ext_uom, "avgcost": avg_cost_val}
            _dtl_bind_ext_baseqty_avg = {**_dtl_bind_ext_baseqty, "avgcost": avg_cost_val}
            _dtl_bind_ext_avg = {**_dtl_bind_ext, "avgcost": avg_cost_val}
            for _dtl_tbl in (BILLDTL_TABLE_NAME, BILLDTLHISTORY_TABLE_NAME):
                _dtl_ok = False
                _dtl_last_err = None
                for _sql, _bind in (
                    (
                        f"""
                        INSERT INTO {_dtl_tbl} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO, POINTS, STORE, ITDISC, STORE1, STORE2, STORE3, STORE4, STORE5, COST, AVERAGECOST, BASEQTY, UNITOFMEASUREMENT)
                        VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1, :points, :store, 0, 0, 0, 0, 0, 0, :cost, :avgcost, :baseqty, :uom)
                        """,
                        _dtl_bind_ext_baseqty_uom_avg,
                    ),
                    (
                        f"""
                        INSERT INTO {_dtl_tbl} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO, POINTS, STORE, ITDISC, STORE1, STORE2, STORE3, STORE4, STORE5, COST, AVERAGECOST, UNITOFMEASUREMENT)
                        VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1, :points, :store, 0, 0, 0, 0, 0, 0, :cost, :avgcost, :uom)
                        """,
                        _dtl_bind_ext_uom_avg,
                    ),
                    (
                        f"""
                        INSERT INTO {_dtl_tbl} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO, POINTS, STORE, ITDISC, STORE1, STORE2, STORE3, STORE4, STORE5, COST, BASEQTY, UNITOFMEASUREMENT)
                        VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1, :points, :store, 0, 0, 0, 0, 0, 0, :cost, :baseqty, :uom)
                        """,
                        _dtl_bind_ext_baseqty_uom,
                    ),
                    (
                        f"""
                        INSERT INTO {_dtl_tbl} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO, POINTS, STORE, ITDISC, STORE1, STORE2, STORE3, STORE4, STORE5, COST, UNITOFMEASUREMENT)
                        VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1, :points, :store, 0, 0, 0, 0, 0, 0, :cost, :uom)
                        """,
                        _dtl_bind_ext_uom,
                    ),
                    (
                        f"""
                        INSERT INTO {_dtl_tbl} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO, POINTS, STORE, BASEQTY, UNITOFMEASUREMENT)
                        VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1, :points, :store, :baseqty, :uom)
                        """,
                        _dtl_bind_full_baseqty_uom,
                    ),
                    (
                        f"""
                        INSERT INTO {_dtl_tbl} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO, POINTS, STORE, UNITOFMEASUREMENT)
                        VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1, :points, :store, :uom)
                        """,
                        _dtl_bind_full_uom,
                    ),
                    (
                        f"""
                        INSERT INTO {_dtl_tbl} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO, POINTS, BASEQTY, UNITOFMEASUREMENT)
                        VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1, :points, :baseqty, :uom)
                        """,
                        _dtl_bind_no_store_baseqty_uom,
                    ),
                    (
                        f"""
                        INSERT INTO {_dtl_tbl} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO, POINTS, UNITOFMEASUREMENT)
                        VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1, :points, :uom)
                        """,
                        _dtl_bind_no_store_uom,
                    ),
                    (
                        f"""
                        INSERT INTO {_dtl_tbl} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO, POINTS, STORE, ITDISC, STORE1, STORE2, STORE3, STORE4, STORE5, COST, AVERAGECOST, BASEQTY)
                        VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1, :points, :store, 0, 0, 0, 0, 0, 0, :cost, :avgcost, :baseqty)
                        """,
                        _dtl_bind_ext_baseqty_avg,
                    ),
                    (
                        f"""
                        INSERT INTO {_dtl_tbl} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO, POINTS, STORE, ITDISC, STORE1, STORE2, STORE3, STORE4, STORE5, COST, AVERAGECOST)
                        VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1, :points, :store, 0, 0, 0, 0, 0, 0, :cost, :avgcost)
                        """,
                        _dtl_bind_ext_avg,
                    ),
                    (
                        f"""
                        INSERT INTO {_dtl_tbl} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO, POINTS, STORE, ITDISC, STORE1, STORE2, STORE3, STORE4, STORE5, COST, BASEQTY)
                        VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1, :points, :store, 0, 0, 0, 0, 0, 0, :cost, :baseqty)
                        """,
                        _dtl_bind_ext_baseqty,
                    ),
                    (
                        f"""
                        INSERT INTO {_dtl_tbl} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO, POINTS, STORE, ITDISC, STORE1, STORE2, STORE3, STORE4, STORE5, COST)
                        VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1, :points, :store, 0, 0, 0, 0, 0, 0, :cost)
                        """,
                        _dtl_bind_ext,
                    ),
                    (
                        f"""
                        INSERT INTO {_dtl_tbl} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO, POINTS, STORE, BASEQTY)
                        VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1, :points, :store, :baseqty)
                        """,
                        _dtl_bind_full_baseqty,
                    ),
                    (
                        f"""
                        INSERT INTO {_dtl_tbl} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO, POINTS, STORE)
                        VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1, :points, :store)
                        """,
                        _dtl_bind_full,
                    ),
                    (
                        f"""
                        INSERT INTO {_dtl_tbl} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO, POINTS, BASEQTY)
                        VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1, :points, :baseqty)
                        """,
                        _dtl_bind_no_store_baseqty,
                    ),
                    (
                        f"""
                        INSERT INTO {_dtl_tbl} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO, POINTS)
                        VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1, :points)
                        """,
                        _dtl_bind_no_store,
                    ),
                ):
                    try:
                        cur.execute(_sql, _bind)
                        _dtl_ok = True
                        break
                    except oracledb.Error as ins_err:
                        err_str = str(ins_err).upper()
                        if 'ORA-00904' in err_str or '00904' in err_str:
                            _dtl_last_err = ins_err
                            continue
                        if 'ORA-01722' in err_str or '01722' in err_str:
                            for _cand in _billdtl_candidate_binds_for_01722(_bind, store_val, location_code):
                                try:
                                    cur.execute(_sql, _cand)
                                    _dtl_ok = True
                                    break
                                except oracledb.Error:
                                    pass
                            if _dtl_ok:
                                break
                        raise
                if not _dtl_ok:
                    raise _dtl_last_err if _dtl_last_err else RuntimeError("BILLDTL insert failed")
            inserted += 1
            uom_line = str(it.get('uom') or it.get('BASEUOM') or it.get('baseuom') or '').strip()
            _weighted_line = _line_is_weighted_veg_meat(it)
            # ITEMLOG / ITEMJOURNAL: 3 decimal places (e.g. 1.024); BILLDTL keeps full float from cart.
            _qty_jl = _round_qty_for_db(qty, 3)
            dtl_params_pay.append({
                'loc': location_code,
                'billno': bill_no,
                'slno': slno,
                'itemcode': item_code,
                'quantity': _qty_jl,
                'isWeightedItem': _weighted_line,
                'rate': rate,
                'uom': uom_line or None,
                'void': bool(it.get('void')),
                'factor': _conv_mult,
            })
            # Decrease ITEMMASTER: CURRENTSTOCK - (quantity * conversionfactor) and STOREn - (quantity * conversionfactor)
            # For ITEMALTERNATEUOMMAP products, stock decreases by QTY * CONVERSIONFACTOR
            _cf_stock = it.get('conversionFactor') or it.get('CONVERSIONFACTOR') or it.get('factor') or it.get('Factor')
            try:
                _conv_factor_stock = float(_cf_stock) if _cf_stock is not None and str(_cf_stock).strip() != '' else 1.0
            except (TypeError, ValueError):
                _conv_factor_stock = 1.0
            if _conv_factor_stock <= 0:
                _conv_factor_stock = 1.0
            try:
                qty_for_stock = float(qty) * _conv_factor_stock
            except (TypeError, ValueError):
                qty_for_stock = qty
            qty_num = int(qty_for_stock) if qty_for_stock == int(qty_for_stock) else qty_for_stock
            store_col = None  # e.g. STORE1, STORE2, ... STORE10 from item_store (store_val)
            s = str(store_val or '').strip()
            if s:
                for part in (s.replace('STORE', '').replace('store', ''), s):
                    part = (part or '').strip()
                    try:
                        n = int(part)
                        if 1 <= n <= 10:
                            store_col = f"STORE{n}"
                            break
                    except (TypeError, ValueError):
                        pass
            try:
                if store_col:
                    # Decrease CURRENTSTOCK and the login store column (STORE1 .. STORE10)
                    cur.execute(
                        f"""
                        UPDATE itemmaster
                        SET CURRENTSTOCK = NVL(CURRENTSTOCK, 0) - :qty,
                            {store_col} = NVL({store_col}, 0) - :qty
                        WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(TRIM(:itemcode))
                        """,
                        {"qty": qty_num, "itemcode": item_code}
                    )
                elif location_code:
                    cur.execute(
                        """
                        UPDATE itemmaster
                        SET CURRENTSTOCK = NVL(CURRENTSTOCK, 0) - :qty
                        WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(TRIM(:itemcode))
                        AND UPPER(TRIM(NVL(TO_CHAR(locationcode), ''))) = UPPER(TRIM(:loc))
                        """,
                        {"qty": qty_num, "itemcode": item_code, "loc": str(location_code)}
                    )
                else:
                    cur.execute(
                        """
                        UPDATE itemmaster
                        SET CURRENTSTOCK = NVL(CURRENTSTOCK, 0) - :qty
                        WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(TRIM(:itemcode))
                        """,
                        {"qty": qty_num, "itemcode": item_code}
                    )
            except oracledb.Error as e:
                err_str = str(e).upper()
                # STOREn may be non-numeric in legacy DB → ORA-01722 on arithmetic; retry CURRENTSTOCK only
                if 'ORA-01722' in err_str or '01722' in err_str:
                    try:
                        cur.execute(
                            """
                            UPDATE itemmaster
                            SET CURRENTSTOCK = NVL(CURRENTSTOCK, 0) - :qty
                            WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(TRIM(:itemcode))
                            """,
                            {"qty": qty_num, "itemcode": item_code},
                        )
                    except oracledb.Error:
                        pass
                elif 'ORA-00904' not in err_str and '00904' not in err_str:
                    raise
                # If STOREn column missing, retry CURRENTSTOCK only
                elif store_col and ('ORA-00904' in err_str or '00904' in err_str):
                    try:
                        cur.execute(
                            """
                            UPDATE itemmaster
                            SET CURRENTSTOCK = NVL(CURRENTSTOCK, 0) - :qty
                            WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(TRIM(:itemcode))
                            """,
                            {"qty": qty_num, "itemcode": item_code}
                        )
                    except oracledb.Error:
                        pass
        if dtl_params_pay:
            _insert_itemjournal_and_itemlog(cur, bill_no, location_code, dtl_params_pay, is_sales_return=is_sales_return)
        # Loyalty: same integer as BILLHDR.PREVPOINTS (int of totalPoints; no fractional points on customer)
        if customer_code and inserted > 0 and prev_points != 0:
            try:
                _pt_delta = -int(prev_points) if is_sales_return else int(prev_points)
                cur.execute(
                    """
                    UPDATE customer
                    SET points = NVL(points, 0) + :delta
                    WHERE TRIM(customercode) = TRIM(:custcode)
                    """,
                    {"delta": _pt_delta, "custcode": customer_code},
                )
            except oracledb.Error as _pt_err:
                _pt_up = str(_pt_err).upper()
                if "ORA-00904" in _pt_up or "00904" in _pt_up:
                    print(f"[BILLDTL] customer.points column missing or invalid; skip loyalty update: {_pt_err}")
                else:
                    raise
        if inserted > 0:
            try:
                _clear_draft_temp_cart(cur, bill_no, location_code)
            except oracledb.Error as _tmp_err:
                print(f"[BILLDTL] clear draft temp cart warning: {_tmp_err}")
        conn.commit()
        if items and inserted == 0:
            return jsonify({"ok": False, "error": "No valid rows inserted (check itemCode/quantity/rate)"}), 400
        return jsonify({"ok": True, "inserted": inserted})
    except oracledb.Error as e:
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        print(f"[BILLDTL] insert error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


@app.route('/api/bills/by-date', methods=['GET'])
def bills_by_date():
    """List paid bills from BILLHDRHISTORY for a calendar day (optional location/counter/billNo filter)."""
    date_str = (request.args.get('date') or '').strip()
    location_code = (request.args.get('locationCode') or request.args.get('location_code') or '').strip()
    counter_code = (request.args.get('counterCode') or request.args.get('counter_code') or '').strip()
    bill_no_filter = request.args.get('billNo') or request.args.get('bill')
    if not date_str:
        return jsonify({"ok": False, "error": "date required (YYYY-MM-DD)"}), 400
    conn = _get_connection()
    if not conn:
        return jsonify({"ok": False, "error": "Database unavailable"}), 503
    cur = None
    try:
        cur = conn.cursor()
        _ensure_billhdrhistory(cur)
        base_where = "TRIM(TO_CHAR(TRUNC(BILLDATE), 'YYYY-MM-DD')) = :d"
        bind = {"d": date_str}
        if location_code:
            base_where += " AND NVL(TRIM(LOCATIONCODE), ' ') = NVL(TRIM(:loccode), ' ') "
            bind["loccode"] = location_code
        if counter_code:
            base_where += " AND NVL(TRIM(COUNTERCODE), ' ') = NVL(TRIM(:cntcode), ' ') "
            bind["cntcode"] = counter_code
        if bill_no_filter not in (None, ''):
            try:
                bn = int(bill_no_filter)
                base_where += " AND BILLNO = :billfilter "
                bind["billfilter"] = bn
            except (TypeError, ValueError):
                return jsonify({"ok": False, "error": "billNo must be a number"}), 400
        sql = f"""
            SELECT BILLNO, BILLDATE, BILLTYPE, COUNTERCODE, LOCATIONCODE,
                   NVL(NETBILLAMOUNT, 0), NVL(TRIM(CUSTOMERNAME), '')
            FROM {BILLHDRHISTORY_TABLE_NAME}
            WHERE {base_where}
            ORDER BY BILLNO
        """
        try:
            cur.execute(sql, bind)
        except oracledb.Error as e:
            err_up = str(e).upper()
            if 'ORA-00904' in err_up or '00904' in err_up:
                sql_fb = f"""
                    SELECT BILLNO, BILLDATE, BILLTYPE, COUNTERCODE, LOCATIONCODE, 0, ''
                    FROM {BILLHDRHISTORY_TABLE_NAME}
                    WHERE {base_where}
                    ORDER BY BILLNO
                """
                cur.execute(sql_fb, bind)
            else:
                raise
        rows_out = []
        for row in cur.fetchall() or []:
            bno = _to_int(row[0], None)
            bdt = row[1]
            if hasattr(bdt, 'isoformat'):
                bdt_s = bdt.isoformat()
            elif bdt is not None:
                bdt_s = str(bdt)
            else:
                bdt_s = None
            rows_out.append({
                "billNo": bno,
                "billDate": bdt_s,
                "billType": (str(row[2]).strip() if row[2] is not None else '') or 'C',
                "counterCode": (str(row[3]).strip() if row[3] is not None else '') or '',
                "locationCode": (str(row[4]).strip() if row[4] is not None else '') or '',
                "netBillAmount": _to_float(row[5], 0.0) if len(row) > 5 else 0.0,
                "customerName": (str(row[6]).strip() if len(row) > 6 and row[6] is not None else '') or '',
            })
        return jsonify({"ok": True, "date": date_str, "bills": rows_out})
    except oracledb.Error as e:
        print(f"[Bills] by-date error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


@app.route('/api/bills/<int:bill_no>/receipt', methods=['GET'])
def bill_receipt_reprint(bill_no):
    """Header + lines from BILLHDRHISTORY / BILLDTLHISTORY for thermal reprint (same shape as checkout)."""
    date_str = (request.args.get('date') or '').strip()
    location_code = (request.args.get('locationCode') or request.args.get('location_code') or '').strip()
    if not date_str:
        return jsonify({"ok": False, "error": "date required (YYYY-MM-DD)"}), 400
    conn = _get_connection()
    if not conn:
        return jsonify({"ok": False, "error": "Database unavailable"}), 503
    cur = None
    try:
        cur = conn.cursor()
        _ensure_billhdrhistory(cur)
        _ensure_billdtlhistory(cur)
        _ensure_billhdr_cardamount_column(cur)
        hdr_where = """
            BILLNO = :billno
            AND TRIM(TO_CHAR(TRUNC(BILLDATE), 'YYYY-MM-DD')) = :d
        """
        hdr_bind = {"billno": bill_no, "d": date_str}
        if location_code:
            hdr_where += " AND NVL(TRIM(LOCATIONCODE), ' ') = NVL(TRIM(:loccode), ' ') "
            hdr_bind["loccode"] = location_code
        sel_cols = (
            "LOCATIONCODE, BILLNO, BILLDATE, BILLTYPE, COUNTERCODE, "
            "NVL(PREVPOINTS, 0), NVL(NETBILLAMOUNT, 0), NVL(TRIM(CUSTOMERNAME), ''), "
            "NVL(CARDAMOUNT, 0), NVL(TRIM(CARDNO), ''), NVL(TRIM(CARDTYPE), '')"
        )
        sql_hdr = f"SELECT {sel_cols} FROM {BILLHDRHISTORY_TABLE_NAME} WHERE {hdr_where}"
        try:
            cur.execute(sql_hdr, hdr_bind)
        except oracledb.Error as e:
            err_up = str(e).upper()
            if 'ORA-00904' in err_up or '00904' in err_up:
                sel_cols_min = (
                    "LOCATIONCODE, BILLNO, BILLDATE, BILLTYPE, COUNTERCODE, "
                    "NVL(PREVPOINTS, 0), NVL(NETBILLAMOUNT, 0), NVL(TRIM(CUSTOMERNAME), ''), "
                    "0, '', ''"
                )
                sql_hdr = f"SELECT {sel_cols_min} FROM {BILLHDRHISTORY_TABLE_NAME} WHERE {hdr_where}"
                cur.execute(sql_hdr, hdr_bind)
            else:
                raise
        hrow = cur.fetchone()
        if not hrow:
            return jsonify({"ok": False, "error": "Bill not found for this date"}), 404
        loc_hdr = (str(hrow[0]).strip() if hrow[0] is not None else '') or ''
        bdt = hrow[2]
        if hasattr(bdt, 'isoformat'):
            bill_date_iso = bdt.isoformat()
        elif bdt is not None:
            bill_date_iso = str(bdt)
        else:
            bill_date_iso = None
        bill_type = (str(hrow[3]).strip() if hrow[3] is not None else '') or 'C'
        counter_hdr = (str(hrow[4]).strip() if hrow[4] is not None else '') or ''
        prev_pts = _to_float(hrow[5], 0.0)
        net_amt = _to_float(hrow[6], 0.0)
        cust_name = (str(hrow[7]).strip() if len(hrow) > 7 and hrow[7] is not None else '') or ''
        card_amt = _to_float(hrow[8], 0.0) if len(hrow) > 8 else 0.0
        card_no = (str(hrow[9]).strip() if len(hrow) > 9 and hrow[9] is not None else '') or ''
        card_type = (str(hrow[10]).strip() if len(hrow) > 10 and hrow[10] is not None else '') or ''

        cur.execute(
            f"""
            SELECT SLNO, ITEMCODE, NVL(QUANTITY, 0), NVL(RATE, 0), NVL(POINTS, 0)
            FROM {BILLDTLHISTORY_TABLE_NAME}
            WHERE BILLNO = :billno
            AND NVL(TRIM(LOCATIONCODE), ' ') = NVL(TRIM(:loc), ' ')
            ORDER BY SLNO
            """,
            {"billno": bill_no, "loc": loc_hdr or ' '},
        )
        dtl_rows = cur.fetchall() or []
        if not dtl_rows:
            cur.execute(
                f"""
                SELECT SLNO, ITEMCODE, NVL(QUANTITY, 0), NVL(RATE, 0), NVL(POINTS, 0)
                FROM {BILLDTLHISTORY_TABLE_NAME}
                WHERE BILLNO = :billno
                ORDER BY SLNO
                """,
                {"billno": bill_no},
            )
            dtl_rows = cur.fetchall() or []

        item_codes = []
        for r in dtl_rows:
            if len(r) > 1 and r[1] is not None:
                item_codes.append(str(r[1]).strip())
        details_map = _get_item_details_from_master(cur, item_codes)

        items_out = []
        subtotal = 0.0
        for r in dtl_rows:
            slno = _to_int(r[0], 0) if r else 0
            icode = str(r[1]).strip() if len(r) > 1 and r[1] is not None else ''
            qty = _to_float(r[2], 0.0) if len(r) > 2 else 0.0
            rate = _to_float(r[3], 0.0) if len(r) > 3 else 0.0
            pts = _to_float(r[4], 0.0) if len(r) > 4 else 0.0
            line_amt = qty * rate
            subtotal += line_amt
            dm = details_map.get(icode) or {}
            items_out.append({
                "slNo": slno,
                "itemCode": icode,
                "quantity": qty,
                "rate": rate,
                "price": rate,
                "points": pts,
                "name": dm.get("name") or icode,
                "ITEMNAME": dm.get("name") or icode,
                "nameAr": dm.get("itemnameara") or "",
                "manufactureId": icode,
            })

        _bt_up = str(bill_type).strip().upper()
        is_ret = _bt_up == "X" or (_bt_up in ("C", "R", "1", "2") and net_amt < 0)
        ca = float(card_amt)
        net = float(net_amt)
        if ca <= 0.001:
            payment_method = "cash"
            cash_amount = net
            card_amount_out = 0.0
        elif abs(ca - net) < 0.02:
            payment_method = "card"
            cash_amount = 0.0
            card_amount_out = net
        else:
            payment_method = "split"
            cash_amount = max(net - ca, 0.0)
            card_amount_out = ca

        return jsonify({
            "ok": True,
            "header": {
                "billNo": bill_no,
                "billDate": bill_date_iso,
                "billType": bill_type,
                "locationCode": loc_hdr,
                "counterCode": counter_hdr,
                "netBillAmount": net_amt,
                "customerName": cust_name,
                "prevPoints": prev_pts,
                "cardAmount": card_amt,
                "cardNo": card_no,
                "cardType": card_type,
            },
            "items": items_out,
            "subtotal": round(subtotal, 3),
            "total": net_amt,
            "discount": 0.0,
            "totalPoints": prev_pts,
            "paymentMethod": payment_method,
            "cashAmount": round(cash_amount, 3),
            "cardAmount": round(card_amount_out, 3),
            "amountTendered": net_amt,
            "change": 0.0,
            "isSalesReturn": is_ret,
        })
    except oracledb.Error as e:
        print(f"[Bills] receipt error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


@app.route('/api/creditsettlement', methods=['POST'])
def credit_settlement_insert():
    """On credit sale: insert TBLCREDITSETTLEMENT with PENDINGNO = MAX(PENDINGNO)+1, PFLAG='N', FLAG='B', STATUS='pending', etc."""
    data = request.get_json(silent=True) or {}
    location_code = str(data.get('locationCode') or data.get('location_code') or '').strip() or None
    customer_code = str(data.get('customerCode') or data.get('customer_code') or data.get('CUSTOMERCODE') or '').strip() or None
    bill_no = data.get('billNo') or data.get('billno')
    bill_amount = data.get('billAmount') or data.get('bill_amount') or data.get('total')
    bill_date = data.get('billDate') or data.get('bill_date')
    employee_code = (data.get('employeeCode') or data.get('employee_code') or '').strip() or _username_from_request() or '1'
    salesman_code = data.get('salesmanCode') or data.get('salesman_code') or 1
    # Oracle NUMBER columns: coerce to int when possible to avoid ORA-01722
    try:
        emp_num = int(employee_code)
    except (TypeError, ValueError):
        emp_num = 1
    try:
        salesman_num = int(salesman_code) if salesman_code not in (None, '') else 1
    except (TypeError, ValueError):
        salesman_num = 1

    if not location_code:
        return jsonify({"ok": False, "error": "locationCode required"}), 400
    if not customer_code:
        return jsonify({"ok": False, "error": "customerCode required"}), 400
    if bill_no is None:
        return jsonify({"ok": False, "error": "billNo required"}), 400
    try:
        bill_no = int(bill_no)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "billNo must be a number"}), 400
    bill_amount = _to_float(bill_amount, 0.0)
    is_sales_return = data.get('isSalesReturn') in (True, 'true', '1', 1)
    if bill_date is None or bill_date == '':
        bill_date_str = datetime.datetime.now().strftime('%Y-%m-%d')
    else:
        try:
            if isinstance(bill_date, (int, float)):
                bill_date_str = datetime.datetime.fromtimestamp(bill_date / 1000.0 if bill_date > 1e12 else bill_date).strftime('%Y-%m-%d')
            else:
                bill_date_str = datetime.datetime.now().strftime('%Y-%m-%d') if not bill_date else str(bill_date).strip()[:10]
        except Exception:
            bill_date_str = datetime.datetime.now().strftime('%Y-%m-%d')

    conn = _get_connection()
    if not conn:
        return jsonify({"ok": False, "error": "Database unavailable"}), 503
    cur = None
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT NVL(MAX(PENDINGNO), 0) + 1 AS NEXT_PENDING
            FROM TBLCREDITSETTLEMENT
            WHERE NVL(TRIM(LOCATIONCODE), ' ') = NVL(TRIM(:loc), ' ')
            """,
            {"loc": location_code}
        )
        row = cur.fetchone()
        pending_no = _to_int(row[0], 1) if row else 1
        cur.execute(
            """
            INSERT INTO TBLCREDITSETTLEMENT
            (LOCATIONCODE, PFLAG, FLAG, EMPLOYEECODE, BALANCE, STATUS, SALESMANCODE, CUSTOMERCODE, BILLAMOUNT, BILLDATE, BILLNO, PENDINGNO)
            VALUES (:loc, 'N', 'B', :empcode, :balance, 'pending', :salesmancode, :custcode, :billamount, TO_DATE(:billdate, 'YYYY-MM-DD'), :billno, :pendingno)
            """,
            {
                "loc": location_code,
                "empcode": emp_num,
                "balance": bill_amount,
                "salesmancode": salesman_num,
                "custcode": customer_code,
                "billamount": bill_amount,
                "billdate": bill_date_str,
                "billno": bill_no,
                "pendingno": pending_no,
            }
        )
        cur.execute(
            """
            INSERT INTO TBLCRSETTLEMENT
            (LOCATIONCODE, PENDINGNO, BILLNUMBER, BILLDATE, BILLAMOUNT, CUSTOMERCODE, SALESMANCODE, FLAG, PUSER, STATUS)
            VALUES (:loc, :pendingno, :billno, TO_DATE(:billdate, 'YYYY-MM-DD'), :billamount, :custcode, 1, 'B', :puser, 'pending')
            """,
            {
                "loc": location_code,
                "pendingno": pending_no,
                "billno": bill_no,
                "billdate": bill_date_str,
                "billamount": bill_amount,
                "custcode": customer_code,
                "puser": employee_code or '1',
            }
        )
        cur.execute(
            "SELECT NVL(currentcreditamount, 0) FROM customer WHERE TRIM(customercode) = TRIM(:custcode) AND ROWNUM = 1",
            {"custcode": customer_code}
        )
        cust_row = cur.fetchone()
        current_credit = _to_float(cust_row[0], 0.0) if cust_row else 0.0
        # Sale: currentCreditAmount + amount. Sales-return: currentCreditAmount - amount. Use abs so sign of bill_amount does not invert logic.
        bill_amount_abs = abs(bill_amount)
        new_balance = (current_credit - bill_amount_abs) if is_sales_return else (current_credit + bill_amount_abs)
        cur.execute(
            """
            UPDATE customer SET currentcreditamount = :newbal
            WHERE TRIM(customercode) = TRIM(:custcode)
            """,
            {"newbal": new_balance, "custcode": customer_code}
        )
        conn.commit()
        return jsonify({"ok": True, "pendingNo": pending_no})
    except oracledb.Error as e:
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        print(f"[CreditSettlement] insert error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


@app.route('/api/billno/check', methods=['GET'])
def check_billno():
    """Check last and next bill no from BILLNOTABLE (read-only, no insert)."""
    conn = _get_connection()
    if not conn:
        return jsonify({"error": "Database unavailable", "lastBillNo": None, "nextBillNo": None}), 503
    cur = None
    try:
        cur = conn.cursor()
        _ensure_billnotable(cur)
        cur.execute(f"SELECT NVL(MAX(BILLNO), 0) AS LAST_BILLNO FROM {BILLNO_TABLE_NAME}")
        row = cur.fetchone()
        last_billno = _to_int(row[0], 0) if row else 0
        next_billno = last_billno + 1
        return jsonify({
            "ok": True,
            "lastBillNo": last_billno,
            "nextBillNo": next_billno,
        })
    except oracledb.Error as e:
        print(f"[BillNo] check error: {e}")
        return jsonify({"ok": False, "error": str(e), "lastBillNo": None, "nextBillNo": None}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


# --- Counter table: SYSTEMIP, SYSTEMNAME, COUNTERCODE, COUNTERNAME ---
COUNTER_TABLE_NAME = 'COUNTER'


def _ensure_counter_table(cur):
    """Create COUNTER table if not exists. Columns: SYSTEMIP, SYSTEMNAME, COUNTERCODE, COUNTERNAME."""
    create_sql = f"""
        CREATE TABLE {COUNTER_TABLE_NAME} (
            SYSTEMIP VARCHAR2(45),
            SYSTEMNAME VARCHAR2(255),
            COUNTERCODE VARCHAR2(50),
            COUNTERNAME VARCHAR2(255)
        )
    """
    try:
        cur.execute(create_sql)
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00955' in err_str or '00955' in err_str:
            pass
        else:
            print(f"[Counter] {COUNTER_TABLE_NAME} create failed: {e}")


@app.route('/api/counters', methods=['GET'])
def list_counters():
    """Fetch SYSTEMNAME, COUNTERCODE, COUNTERNAME. If systemIp (and optional systemName) given, only active system's row(s); one row for current terminal."""
    system_ip = (request.args.get('systemIp') or request.args.get('system_ip') or '').strip()
    system_name = (request.args.get('systemName') or request.args.get('system_name') or '').strip()
    conn = _get_connection()
    if not conn:
        return jsonify({"ok": False, "counters": [], "error": "Database unavailable"}), 503
    cur = None
    try:
        cur = conn.cursor()
        _ensure_counter_table(cur)
        try:
            if system_ip and system_name:
                cur.execute(
                    f"SELECT SYSTEMNAME, COUNTERCODE, COUNTERNAME FROM {COUNTER_TABLE_NAME} WHERE SYSTEMIP = :sysip AND SYSTEMNAME = :sysname",
                    {"sysip": system_ip, "sysname": system_name}
                )
            elif system_ip:
                cur.execute(
                    f"SELECT SYSTEMNAME, COUNTERCODE, COUNTERNAME FROM {COUNTER_TABLE_NAME} WHERE SYSTEMIP = :sysip",
                    {"sysip": system_ip}
                )
            else:
                cur.execute(f"SELECT SYSTEMNAME, COUNTERCODE, COUNTERNAME FROM {COUNTER_TABLE_NAME}")
        except oracledb.Error as e:
            if 'ORA-00904' not in str(e).upper() and '00904' not in str(e).upper():
                raise
            if system_ip:
                cur.execute(
                    f"SELECT COUNTERCODE, COUNTERNAME FROM {COUNTER_TABLE_NAME} WHERE SYSTEMIP = :sysip",
                    {"sysip": system_ip}
                )
            else:
                cur.execute(f"SELECT COUNTERCODE, COUNTERNAME FROM {COUNTER_TABLE_NAME}")
        rows = cur.fetchall()
        cols = [c[0].upper() if c else '' for c in cur.description]
        result = []
        for row in rows:
            def get_col(name):
                try:
                    i = cols.index(name)
                    return row[i] if i >= 0 and i < len(row) else None
                except (ValueError, IndexError):
                    return None
            result.append({
                "systemName": str(get_col('SYSTEMNAME') or "").strip(),
                "counterCode": str(get_col('COUNTERCODE') or row[0] if row else "").strip(),
                "counterName": str(get_col('COUNTERNAME') or (row[1] if len(row) > 1 else None) or "").strip(),
            })
        return jsonify({"ok": True, "counters": result})
    except oracledb.Error as e:
        print(f"[Counter] list error: {e}")
        return jsonify({"ok": False, "counters": [], "error": str(e)}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


@app.route('/api/counters/next-code', methods=['GET'])
def next_counter_code():
    """Return next counter code: last COUNTERCODE from COUNTER + 1 (numeric)."""
    conn = _get_connection()
    if not conn:
        return jsonify({"ok": False, "nextCounterCode": "1", "error": "Database unavailable"}), 503
    cur = None
    try:
        cur = conn.cursor()
        _ensure_counter_table(cur)
        cur.execute(f"SELECT COUNTERCODE FROM {COUNTER_TABLE_NAME} WHERE COUNTERCODE IS NOT NULL")
        rows = cur.fetchall()
        max_num = 0
        for row in rows:
            val = row[0]
            if val is None:
                continue
            s = str(val).strip()
            digits = ''.join(c for c in s if c.isdigit())
            if digits:
                try:
                    n = int(digits)
                    if n > max_num:
                        max_num = n
                except ValueError:
                    pass
        next_code = str(max_num + 1)
        return jsonify({"ok": True, "nextCounterCode": next_code})
    except oracledb.Error as e:
        print(f"[Counter] next-code error: {e}")
        return jsonify({"ok": False, "nextCounterCode": "1", "error": str(e)}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


@app.route('/api/counter', methods=['POST'])
def save_counter():
    """Insert into COUNTER: systemName, systemIp, counterCode, counterName, locationCode (from Counter Setup Save)."""
    data = request.get_json(silent=True) or {}
    system_ip = (data.get('systemIp') or data.get('systemIP') or '').strip()
    system_name = (data.get('systemName') or '').strip()
    counter_code = (data.get('counterCode') or '').strip() or '1'
    counter_name = (data.get('counterName') or '').strip() or 'Counter 1'
    location_code = (data.get('locationCode') or data.get('location_code') or '').strip() or None
    if location_code is None:
        location_code = '1'
    conn = _get_connection()
    if not conn:
        return jsonify({"ok": False, "error": "Database unavailable"}), 503
    cur = None
    try:
        cur = conn.cursor()
        _ensure_counter_table(cur)
        cur.execute(
            f"""
            INSERT INTO {COUNTER_TABLE_NAME} (SYSTEMIP, SYSTEMNAME, COUNTERCODE, COUNTERNAME, LOCATIONCODE)
            VALUES (:sysip, :sysname, :cntcode, :cntname, :loccode)
            """,
            {"sysip": system_ip or None, "sysname": system_name or None, "cntcode": counter_code, "cntname": counter_name, "loccode": location_code}
        )
        conn.commit()
        return jsonify({"ok": True})
    except oracledb.Error as e:
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        print(f"[Counter] insert error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


# --- COUNTEROPERATIONS: DATEOFOPEN, OPENEDDATE, OPENFLAG (O/C), OPENEDBY, CLOSEDBY, CLOSEDDATE ---
COUNTEROPERATIONS_TABLE_NAME = 'COUNTEROPERATIONS'


def _ensure_counter_operations_table(cur):
    """Create COUNTEROPERATIONS table if not exists."""
    create_sql = f"""
        CREATE TABLE {COUNTEROPERATIONS_TABLE_NAME} (
            DATEOFOPEN DATE,
            OPENEDDATE DATE,
            OPENFLAG VARCHAR2(1),
            OPENEDBY VARCHAR2(100),
            CLOSEDBY VARCHAR2(100),
            CLOSEDDATE DATE,
            COUNTERCODE VARCHAR2(50),
            POSFLAG VARCHAR2(1)
        )
    """
    try:
        cur.execute(create_sql)
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00955' in err_str or '00955' in err_str:
            pass
        else:
            print(f"[CounterOperations] create failed: {e}")


@app.route('/api/counter-operations/status', methods=['GET'])
def counter_operations_status():
    """For given date, counterCode: return open=True if OPENFLAG='O', closed=True if OPENFLAG='C' (already closed, cannot open again)."""
    date_str = (request.args.get('date') or request.args.get('dateOfOpen') or '').strip()
    counter_code = (request.args.get('counterCode') or request.args.get('counter_code') or '').strip()
    if not date_str:
        return jsonify({"ok": False, "open": False, "closed": False, "error": "date required"}), 400
    conn = _get_connection()
    if not conn:
        return jsonify({"ok": False, "open": False, "closed": False, "error": "Database unavailable"}), 503
    cur = None
    try:
        cur = conn.cursor()
        _ensure_counter_operations_table(cur)
        cnt_val = (counter_code or '').strip()
        cur.execute(
            f"""
            SELECT OPENFLAG FROM {COUNTEROPERATIONS_TABLE_NAME}
            WHERE TRIM(TO_CHAR(DATEOFOPEN, 'YYYY-MM-DD')) = :d
            AND NVL(TRIM(COUNTERCODE), ' ') = NVL(:cntcode, ' ')
            AND ROWNUM = 1
            """,
            {"d": date_str, "cntcode": cnt_val}
        )
        row = cur.fetchone()
        open_flag = (row[0] or '').strip().upper() if row and len(row) > 0 else None
        is_open = open_flag == 'O'
        is_closed = open_flag == 'C'
        return jsonify({"ok": True, "open": is_open, "closed": is_closed})
    except oracledb.Error as e:
        print(f"[CounterOperations] status error: {e}")
        return jsonify({"ok": False, "open": False, "closed": False, "error": str(e)}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


@app.route('/api/counter-operations/opened-dates', methods=['GET'])
def counter_operations_opened_dates():
    """Return list of opened dates (OPENFLAG='O') ordered by DATEOFOPEN desc. Optional: counterCode filter."""
    counter_code = (request.args.get('counterCode') or request.args.get('counter_code') or '').strip()
    conn = _get_connection()
    if not conn:
        return jsonify({"ok": False, "dates": [], "error": "Database unavailable"}), 503
    cur = None
    try:
        cur = conn.cursor()
        _ensure_counter_operations_table(cur)
        cnt_val = (counter_code or '').strip()
        sql = f"""
            SELECT TRIM(TO_CHAR(DATEOFOPEN, 'YYYY-MM-DD')) as d, OPENEDBY, TRIM(TO_CHAR(OPENEDDATE, 'YYYY-MM-DD')) as od
            FROM {COUNTEROPERATIONS_TABLE_NAME}
            WHERE OPENFLAG = 'O'
            AND NVL(TRIM(COUNTERCODE), ' ') = NVL(:cntcode, ' ')
            ORDER BY DATEOFOPEN DESC
        """
        cur.execute(sql, {"cntcode": cnt_val})
        rows = cur.fetchall()
        dates = [{"date": r[0], "openedBy": r[1], "openedDate": r[2]} for r in rows if r[0]]
        last_opened = dates[0]["date"] if dates else None
        return jsonify({"ok": True, "dates": dates, "lastOpenedDate": last_opened})
    except oracledb.Error as e:
        print(f"[CounterOperations] opened-dates error: {e}")
        return jsonify({"ok": False, "dates": [], "error": str(e)}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


def _username_from_request():
    """Get username from Authorization Bearer token (JWT sub)."""
    auth = request.headers.get('Authorization') or ''
    payload = _decode_token(auth)
    if not payload:
        return None
    return (payload.get('sub') or payload.get('username') or '').strip() or None


def _employee_code_from_request():
    """Employee / user id from JWT (userid, else sub)."""
    auth = request.headers.get('Authorization') or ''
    payload = _decode_token(auth)
    if not payload:
        return None
    return (payload.get('userid') or payload.get('sub') or '').strip() or None


@app.route('/api/counter-operations/open', methods=['POST'])
def counter_operations_open():
    """Insert COUNTEROPERATIONS: DATEOFOPEN=selected date, OPENEDDATE=today, OPENFLAG='O', OPENEDBY=username, LOCATIONCODE from login."""
    data = request.get_json(silent=True) or {}
    date_str = (data.get('date') or data.get('dateOfOpen') or '').strip()
    counter_code = (data.get('counterCode') or data.get('counter_code') or '').strip() or '1'
    location_code = (data.get('locationCode') or data.get('location_code') or '').strip()
    if not location_code:
        base_loc = _get_base_location()
        location_code = (base_loc or {}).get('locationCode') or (base_loc or {}).get('location_code') or '1'
    location_code = location_code or '1'
    username = _username_from_request() or (data.get('username') or '').strip()
    if not date_str:
        return jsonify({"ok": False, "error": "date required"}), 400
    conn = _get_connection()
    if not conn:
        return jsonify({"ok": False, "error": "Database unavailable"}), 503
    cur = None
    try:
        cur = conn.cursor()
        _ensure_counter_operations_table(cur)
        cur.execute(
            f"""
            SELECT OPENFLAG FROM {COUNTEROPERATIONS_TABLE_NAME}
            WHERE TRIM(TO_CHAR(DATEOFOPEN, 'YYYY-MM-DD')) = :d
            AND NVL(TRIM(COUNTERCODE), ' ') = NVL(TRIM(:cntcode), ' ')
            AND ROWNUM = 1
            """,
            {"d": date_str, "cntcode": counter_code or ''}
        )
        existing = cur.fetchone()
        if existing and len(existing) > 0:
            open_flag = (existing[0] or '').strip().upper()
            if open_flag == 'C':
                return jsonify({"ok": False, "error": "Counter already closed for this date; cannot open again."}), 400
            if open_flag == 'O':
                return jsonify({"ok": False, "error": "Counter already open for this date."}), 400
        from datetime import date as date_type
        today_str = date_type.today().strftime('%Y-%m-%d')
        cur.execute(
            f"""
            INSERT INTO {COUNTEROPERATIONS_TABLE_NAME}
            (DATEOFOPEN, OPENEDDATE, OPENFLAG, OPENEDBY, COUNTERCODE, LOCATIONCODE, CASHIERCODE, POSFLAG)
            VALUES (TO_DATE(:d, 'YYYY-MM-DD'), TO_DATE(:oday, 'YYYY-MM-DD'), 'O', :openedby, :cntcode, :loccode, 0, 'C')
            """,
            {"d": date_str, "oday": today_str, "openedby": username or None, "cntcode": counter_code or None, "loccode": location_code}
        )
        conn.commit()
        return jsonify({"ok": True})
    except oracledb.Error as e:
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        print(f"[CounterOperations] open error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


@app.route('/api/counter-operations/close', methods=['POST'])
def counter_operations_close():
    """Update COUNTEROPERATIONS: set OPENFLAG='C', CLOSEDBY=username, CLOSEDDATE=sysdate for matching DATEOFOPEN and OPENFLAG='O'."""
    data = request.get_json(silent=True) or {}
    date_str = (data.get('date') or data.get('dateOfOpen') or '').strip()
    counter_code = (data.get('counterCode') or data.get('counter_code') or '').strip() or '1'
    username = _username_from_request() or (data.get('username') or '').strip()
    if not date_str:
        return jsonify({"ok": False, "error": "date required"}), 400
    conn = _get_connection()
    if not conn:
        return jsonify({"ok": False, "error": "Database unavailable"}), 503
    cur = None
    try:
        cur = conn.cursor()
        _ensure_counter_operations_table(cur)
        cur.execute(
            f"""
            UPDATE {COUNTEROPERATIONS_TABLE_NAME}
            SET OPENFLAG = 'C', CLOSEDBY = :closedby, CLOSEDDATE = SYSDATE
            WHERE TRIM(TO_CHAR(DATEOFOPEN, 'YYYY-MM-DD')) = :d AND OPENFLAG = 'O'
            AND NVL(TRIM(COUNTERCODE), ' ') = NVL(TRIM(:cntcode), ' ')
            """,
            {"closedby": username or None, "d": date_str, "cntcode": counter_code or ''}
        )
        conn.commit()
        return jsonify({"ok": True, "updated": cur.rowcount})
    except oracledb.Error as e:
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        print(f"[CounterOperations] close error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


@app.route('/api/counter-operations/daily-summary', methods=['GET'])
def counter_operations_daily_summary():
    """Sum paid bills from BILLHDRHISTORY for a calendar day (BILLDATE).
    BILLTYPE: C/R = cash/credit sales; X = sales return. Legacy: negative NET on C/R treated as return."""
    date_str = (request.args.get('date') or request.args.get('dateOfOpen') or '').strip()
    counter_code = (request.args.get('counterCode') or request.args.get('counter_code') or '').strip()
    location_code = (request.args.get('locationCode') or request.args.get('location_code') or '').strip()
    if not date_str:
        return jsonify({"ok": False, "error": "date required"}), 400
    conn = _get_connection()
    if not conn:
        return jsonify({"ok": False, "error": "Database unavailable"}), 503
    cur = None
    try:
        cur = conn.cursor()
        _ensure_billhdrhistory(cur)
        cnt_val = (counter_code or '').strip()
        loc_val = (location_code or '').strip()
        base_where = """
            TRIM(TO_CHAR(TRUNC(BILLDATE), 'YYYY-MM-DD')) = :d
            AND NVL(TRIM(COUNTERCODE), ' ') = NVL(TRIM(:cntcode), ' ')
        """
        bind = {"d": date_str, "cntcode": cnt_val}
        if loc_val:
            base_where += " AND NVL(TRIM(LOCATIONCODE), ' ') = NVL(TRIM(:loccode), ' ') "
            bind["loccode"] = loc_val
        sql = f"""
            SELECT
              NVL(SUM(CASE
                WHEN TRIM(BILLTYPE) IN ('C', '1', 'R', '2') AND NVL(NETBILLAMOUNT, 0) > 0
                THEN NVL(NETBILLAMOUNT, 0) ELSE 0 END), 0),
              NVL(SUM(CASE
                WHEN TRIM(BILLTYPE) = 'X' THEN ABS(NVL(NETBILLAMOUNT, 0))
                WHEN TRIM(BILLTYPE) IN ('C', '1', 'R', '2') AND NVL(NETBILLAMOUNT, 0) < 0
                THEN ABS(NVL(NETBILLAMOUNT, 0)) ELSE 0 END), 0),
              NVL(SUM(CASE
                WHEN TRIM(BILLTYPE) IN ('C', '1', 'R', '2') AND NVL(NETBILLAMOUNT, 0) > 0 THEN 1 ELSE 0 END), 0),
              NVL(SUM(CASE
                WHEN TRIM(BILLTYPE) = 'X' THEN 1
                WHEN TRIM(BILLTYPE) IN ('C', '1', 'R', '2') AND NVL(NETBILLAMOUNT, 0) < 0 THEN 1 ELSE 0 END), 0)
            FROM {BILLHDRHISTORY_TABLE_NAME}
            WHERE {base_where}
        """
        try:
            cur.execute(sql, bind)
        except oracledb.Error as e:
            err_up = str(e).upper()
            if 'ORA-00904' in err_up or '00904' in err_up:
                sql_fallback = f"""
                    SELECT
                      NVL(SUM(CASE
                        WHEN TRIM(BILLTYPE) IN ('C', '1', 'R', '2') THEN 1 ELSE 0 END), 0),
                      NVL(SUM(CASE WHEN TRIM(BILLTYPE) = 'X' THEN 1 ELSE 0 END), 0)
                    FROM {BILLHDRHISTORY_TABLE_NAME}
                    WHERE {base_where}
                """
                cur.execute(sql_fallback, bind)
                row = cur.fetchone()
                sale_count = int(_to_int(row[0], 0) if row and len(row) > 0 else 0)
                ret_count = int(_to_int(row[1], 0) if row and len(row) > 1 else 0)
                return jsonify({
                    "ok": True,
                    "date": date_str,
                    "counterCode": counter_code or None,
                    "locationCode": location_code or None,
                    "totalSales": 0.0,
                    "totalReturns": 0.0,
                    "saleCount": sale_count,
                    "returnCount": ret_count,
                    "netTotal": 0.0,
                    "totalCardAmount": 0.0,
                    "totalCardReturns": 0.0,
                    "cardByType": {},
                    "discountTotal": 0.0,
                    "creditTotal": 0.0,
                    "voucherTotal": 0.0,
                    "cashInBox": 0.0,
                    "note": "NETBILLAMOUNT column unavailable; amounts are zero.",
                })
            raise
        row = cur.fetchone()
        sales_amt = float(row[0]) if row and row[0] is not None else 0.0
        ret_amt = float(row[1]) if row and len(row) > 1 and row[1] is not None else 0.0
        sale_count = int(row[2]) if row and len(row) > 2 and row[2] is not None else 0
        ret_count = int(row[3]) if row and len(row) > 3 and row[3] is not None else 0
        try:
            sql_net = f"""
                SELECT NVL(SUM(NVL(NETBILLAMOUNT, 0)), 0)
                FROM {BILLHDRHISTORY_TABLE_NAME}
                WHERE {base_where}
            """
            cur.execute(sql_net, bind)
            nrow = cur.fetchone()
            net_total = float(nrow[0]) if nrow and nrow[0] is not None else (sales_amt - ret_amt)
        except oracledb.Error:
            net_total = sales_amt - ret_amt
        # Card totals by CARDTYPE (sales bills only) — optional columns
        card_by_type = {}
        total_card = 0.0
        try:
            _ensure_billhdr_cardamount_column(cur)
            _ensure_billhdr_cardno_cardtype_columns(cur)
            sql_card = f"""
                SELECT NVL(TRIM(CARDTYPE), 'CARD'), NVL(SUM(NVL(CARDAMOUNT, 0)), 0)
                FROM {BILLHDRHISTORY_TABLE_NAME}
                WHERE {base_where}
                AND TRIM(BILLTYPE) IN ('C', '1', 'R', '2')
                AND NVL(NETBILLAMOUNT, 0) > 0
                GROUP BY NVL(TRIM(CARDTYPE), 'CARD')
            """
            cur.execute(sql_card, bind)
            for cr in cur.fetchall():
                k = (cr[0] or 'CARD').strip() or 'CARD'
                v = float(cr[1]) if cr[1] is not None else 0.0
                if abs(v) > 1e-9:
                    card_by_type[k.upper()] = round(v, 3)
                    total_card += v
        except oracledb.Error as card_err:
            print(f"[CounterOperations] daily-summary card totals (optional): {card_err}")
        # Card amount on return bills (refunds to card) — used for reporting; cash formula below uses full bill rows
        total_card_returns = 0.0
        try:
            _ensure_billhdr_cardamount_column(cur)
            sql_card_ret = f"""
                SELECT NVL(SUM(NVL(CARDAMOUNT, 0)), 0)
                FROM {BILLHDRHISTORY_TABLE_NAME}
                WHERE {base_where}
                AND (
                    TRIM(BILLTYPE) = 'X'
                    OR (TRIM(BILLTYPE) IN ('C', '1', 'R', '2') AND NVL(NETBILLAMOUNT, 0) < 0)
                )
            """
            cur.execute(sql_card_ret, bind)
            rr = cur.fetchone()
            total_card_returns = float(rr[0]) if rr and rr[0] is not None else 0.0
        except oracledb.Error:
            total_card_returns = 0.0
        discount_total = 0.0
        credit_total = 0.0
        voucher_total = 0.0
        # Join predicate for header alias h (same filters as base_where on BILLHDRHISTORY)
        base_where_h = (
            "TRIM(TO_CHAR(TRUNC(h.BILLDATE), 'YYYY-MM-DD')) = :d "
            "AND NVL(TRIM(h.COUNTERCODE), ' ') = NVL(TRIM(:cntcode), ' ') "
        )
        if loc_val:
            base_where_h += " AND NVL(TRIM(h.LOCATIONCODE), ' ') = NVL(TRIM(:loccode), ' ') "
        # Line discounts (ITDISC) for bills on this day/counter/location
        try:
            sql_disc = f"""
                SELECT NVL(SUM(NVL(d.ITDISC, 0)), 0)
                FROM {BILLDTLHISTORY_TABLE_NAME} d
                INNER JOIN {BILLHDRHISTORY_TABLE_NAME} h
                  ON d.BILLNO = h.BILLNO
                 AND NVL(TRIM(d.LOCATIONCODE), ' ') = NVL(TRIM(h.LOCATIONCODE), ' ')
                WHERE {base_where_h}
            """
            cur.execute(sql_disc, bind)
            dr = cur.fetchone()
            discount_total = float(dr[0]) if dr and dr[0] is not None else 0.0
        except oracledb.Error as disc_err:
            print(f"[CounterOperations] daily-summary discount (ITDISC): {disc_err}")
            discount_total = 0.0
        # Credit-on-account bills (cash drawer did not receive this amount)
        try:
            sql_cred = f"""
                SELECT NVL(SUM(NVL(cs.BILLAMOUNT, 0)), 0)
                FROM TBLCREDITSETTLEMENT cs
                INNER JOIN {BILLHDRHISTORY_TABLE_NAME} h
                  ON cs.BILLNO = h.BILLNO
                 AND NVL(TRIM(cs.LOCATIONCODE), ' ') = NVL(TRIM(h.LOCATIONCODE), ' ')
                WHERE {base_where_h}
            """
            cur.execute(sql_cred, bind)
            cr = cur.fetchone()
            credit_total = float(cr[0]) if cr and cr[0] is not None else 0.0
        except oracledb.Error as cred_err:
            print(f"[CounterOperations] daily-summary credit (TBLCREDITSETTLEMENT): {cred_err}")
            credit_total = 0.0
        # Cash in drawer = sum per bill: sales +(NET-CARD), returns -(NET-CARD), then subtract credit & vouchers
        # (Credit bills were counted as cash in the raw sum because CARDAMOUNT=0; subtract credit_total.)
        cash_in_box = round(net_total - total_card + total_card_returns - credit_total - voucher_total, 3)
        try:
            _ensure_billhdr_cardamount_column(cur)
            sql_cash = f"""
                SELECT NVL(SUM(
                    CASE
                        WHEN TRIM(BILLTYPE) IN ('C', '1', 'R', '2') AND NVL(NETBILLAMOUNT, 0) > 0
                        THEN NVL(NETBILLAMOUNT, 0) - NVL(CARDAMOUNT, 0)
                        WHEN TRIM(BILLTYPE) = 'X'
                        OR (TRIM(BILLTYPE) IN ('C', '1', 'R', '2') AND NVL(NETBILLAMOUNT, 0) < 0)
                        THEN -(ABS(NVL(NETBILLAMOUNT, 0)) - NVL(CARDAMOUNT, 0))
                        ELSE 0
                    END
                ), 0)
                FROM {BILLHDRHISTORY_TABLE_NAME}
                WHERE {base_where}
            """
            cur.execute(sql_cash, bind)
            crow = cur.fetchone()
            if crow and crow[0] is not None:
                cash_in_box = round(float(crow[0]) - float(credit_total) - float(voucher_total), 3)
        except oracledb.Error as cash_err:
            print(f"[CounterOperations] daily-summary cash-in-box (per-row): {cash_err}")
        return jsonify({
            "ok": True,
            "date": date_str,
            "counterCode": counter_code or None,
            "locationCode": location_code or None,
            "totalSales": round(sales_amt, 3),
            "totalReturns": round(ret_amt, 3),
            "saleCount": sale_count,
            "returnCount": ret_count,
            "netTotal": round(net_total, 3),
            "totalCardAmount": round(total_card, 3),
            "totalCardReturns": round(total_card_returns, 3),
            "cardByType": card_by_type,
            "discountTotal": round(discount_total, 3),
            "creditTotal": round(credit_total, 3),
            "voucherTotal": round(voucher_total, 3),
            "cashInBox": cash_in_box,
            "calculationNote": (
                "Totals from BILLHDRHISTORY: C/R = cash/credit sales, X = sales return; "
                "legacy returns may show as negative NET on C/R. "
                "Cash in box = per-bill cash (sale: NET−CARD; return: −(ABS(NET)−CARD)) "
                "minus credit-on-account and vouchers; credit from TBLCREDITSETTLEMENT; "
                "discount from BILLDTLHISTORY.ITDISC."
            ),
        })
    except oracledb.Error as e:
        print(f"[CounterOperations] daily-summary error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


@app.route('/api/hold', methods=['POST'])
def hold_bill():
    """Hold: save cart to TEMPBILLHDR with FLAG=0 (held) and TEMPBILLDTL with ITEMFLAG=1. Suspend: TBLCANCELED* only; clear TEMP for this bill."""
    try:
        data = request.get_json(silent=True) or {}
        bill_no = data.get('billNo')
        location_code = str(data.get('locationCode') or '').strip() or 'LOC001'
        counter_code = str(data.get('counterCode') or '').strip() or '20'
        customer_code = (str(data.get('customerCode') or '').strip()) or None
        items = data.get('items') or []
        if bill_no is None:
            return jsonify({"error": "billNo is required"}), 400
        if not items:
            return jsonify({"error": "items (cart) is required"}), 400
        bill_no = _to_int(bill_no, 1)
        loc_num = _location_to_num(location_code, 1)
        suspend = data.get('suspend') in (True, 'true', '1', 1)
        conn = _get_connection()
        if conn:
            cur = None
            try:
                cur = conn.cursor()
                _ensure_tempbillhdr(cur)
                _ensure_tempbilldtl(cur)

                def _dtl_params_from_cart():
                    out = []
                    for slno, it in enumerate(items, start=1):
                        if not isinstance(it, dict):
                            continue
                        itemcode = str(it.get('id') or it.get('itemcode') or it.get('ITEMCODE') or '').strip()
                        qty = _to_int(it.get('quantity') or it.get('qty') or it.get('QUANTITY'), 1)
                        rate = _to_float(it.get('price') or it.get('PRICE') or it.get('rate'), 0.0)
                        manufacturer_id = str(it.get('manufactureId') or it.get('MANUFACTURERID') or it.get('manufacturerId') or '').strip()
                        uom_line = str(it.get('uom') or it.get('BASEUOM') or it.get('baseuom') or it.get('UNITOFMEASUREMENT') or '').strip()
                        prevpoints = _to_float(it.get('prevpoints') or it.get('PREVPOINTS') or it.get('points') or 0, 0)
                        costprice = _to_float(it.get('costprice') or it.get('COSTPRICE') or it.get('cost') or 0, 0)
                        out.append({
                            'loc': location_code,
                            'billno': bill_no,
                            'slno': slno,
                            'itemcode': itemcode or None,
                            'quantity': qty,
                            'rate': rate,
                            'manufacturerid': manufacturer_id or None,
                            'unitofmeasurement': uom_line or None,
                            'resetno': 1,
                            'prevpoints': prevpoints,
                            'costprice': costprice,
                        })
                    return out

                if suspend:
                    # Suspend: log canceled bill; clear TEMPBILLHDR/TEMPBILLDTL for this bill (do not keep as hold)
                    dtl_params = _dtl_params_from_cart()
                    net_bill_amount = sum(p['quantity'] * p['rate'] for p in dtl_params)
                    discount_amount = _to_float(data.get('discountAmount') or data.get('discount_amount') or data.get('DISCOUNTAMOUNT'), 0.0)
                    bill_date_business = _bill_date_business_iso_from_request(data)
                    billdate_str = bill_date_business or datetime.datetime.now().strftime('%Y-%m-%d')
                    billtime_str = datetime.datetime.now().strftime('%H:%M:%S')
                    bill_type = str(data.get('billtype') or data.get('BILLTYPE') or 'C').strip() or 'C'
                    card_type = (str(data.get('cardtype') or data.get('CARDTYPE') or '').strip()) or None
                    card_no = (str(data.get('cardno') or data.get('CARDNO') or '').strip()) or None
                    hdr_prevpoints = _to_float(data.get('prevpoints') or data.get('PREVPOINTS') or data.get('totalPoints') or 0, 0)
                    _canceled_hdr_bind = {
                        'loc': location_code,
                        'billno': bill_no,
                        'billdate': billdate_str,
                        'billtime': billtime_str,
                        'countercode': counter_code or None,
                        'discount': discount_amount,
                        'netamount': net_bill_amount,
                        'billtype': bill_type,
                        'cardtype': card_type,
                        'cardno': card_no,
                        'customercode': customer_code,
                        'resetno': 1,
                        'prevpoints': hdr_prevpoints,
                    }
                    try:
                        cur.execute("""
                            INSERT INTO TBLCANCELEDHDR (LOCATIONCODE, BILLNO, BILLDATE, BILLTIME, COUNTERCODE, DISCOUNTAMOUNT, NETBILLAMOUNT, BILLSTATUS, BILLTYPE, CARDTYPE, CARDNO, CUSTOMERCODE, RESETNO, PREVPOINTS, CREATEDDATE)
                            VALUES (:loc, :billno, TO_DATE(:billdate, 'YYYY-MM-DD'), :billtime, :countercode, :discount, :netamount, 'C', :billtype, :cardtype, :cardno, :customercode, :resetno, :prevpoints, SYSDATE)
                        """, _canceled_hdr_bind)
                    except oracledb.Error as e:
                        err_u = str(e).upper()
                        if 'ORA-00904' not in err_u and '00904' not in err_u:
                            print(f"[Hold] TBLCANCELEDHDR insert failed: {e}")
                        else:
                            try:
                                cur.execute("""
                                    INSERT INTO TBLCANCELEDHDR (LOCATIONCODE, BILLNO, BILLDATE, BILLTIME, COUNTERCODE, DISCOUNTAMOUNT, NETBILLAMOUNT, BILLSTATUS, BILLTYPE, CARDTYPE, CARDNO, CUSTOMERCODE, RESETNO, PREVPOINTS)
                                    VALUES (:loc, :billno, TO_DATE(:billdate, 'YYYY-MM-DD'), :billtime, :countercode, :discount, :netamount, 'C', :billtype, :cardtype, :cardno, :customercode, :resetno, :prevpoints)
                                """, _canceled_hdr_bind)
                            except oracledb.Error as e1:
                                if 'ORA-00904' not in str(e1).upper() and '00904' not in str(e1).upper():
                                    print(f"[Hold] TBLCANCELEDHDR insert failed: {e1}")
                                else:
                                    try:
                                        cur.execute("""
                                            INSERT INTO TBLCANCELEDHDR (LOCATIONCODE, BILLNO, BILLDATE, BILLTIME, COUNTERCODE, DISCOUNTAMOUNT, NETBILLAMOUNT, BILLSTATUS)
                                            VALUES (:loc, :billno, TO_DATE(:billdate, 'YYYY-MM-DD'), :billtime, :countercode, :discount, :netamount, 'C')
                                        """, {
                                            'loc': location_code,
                                            'billno': bill_no,
                                            'billdate': billdate_str,
                                            'billtime': billtime_str,
                                            'countercode': counter_code or None,
                                            'discount': discount_amount,
                                            'netamount': net_bill_amount,
                                        })
                                    except oracledb.Error as e2:
                                        print(f"[Hold] TBLCANCELEDHDR insert failed: {e2}")
                    canceled_bind = [
                        {
                            'loc': location_code,
                            'billno': p['billno'],
                            'slno': p['slno'],
                            'itemcode': p['itemcode'],
                            'quantity': p['quantity'],
                            'rate': p['rate'],
                            'manufacturerid': p['manufacturerid'],
                            'unitofmeasurement': p['unitofmeasurement'],
                            'resetno': p['resetno'],
                            'prevpoints': p['prevpoints'],
                            'costprice': p['costprice'],
                        }
                        for p in dtl_params
                    ]
                    if canceled_bind:
                        try:
                            cur.executemany("""
                                INSERT INTO TBLCANCELEDDTL (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID, UNITOFMEASUREMENT, RESETNO, PREVPOINTS, COSTPRICE)
                                VALUES (:loc, :billno, :slno, :itemcode, :quantity, :rate, :manufacturerid, :unitofmeasurement, :resetno, :prevpoints, :costprice)
                            """, canceled_bind)
                        except oracledb.Error as e:
                            if 'ORA-00904' not in str(e).upper() and '00904' not in str(e).upper():
                                print(f"[Hold] TBLCANCELEDDTL insert failed: {e}")
                            else:
                                try:
                                    cur.executemany("""
                                        INSERT INTO TBLCANCELEDDTL (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID)
                                        VALUES (:loc, :billno, :slno, :itemcode, :quantity, :rate, :manufacturerid)
                                    """, [
                                        {
                                            'loc': p['loc'],
                                            'billno': p['billno'],
                                            'slno': p['slno'],
                                            'itemcode': p['itemcode'],
                                            'quantity': p['quantity'],
                                            'rate': p['rate'],
                                            'manufacturerid': p['manufacturerid'],
                                        }
                                        for p in dtl_params
                                    ])
                                except oracledb.Error as e2:
                                    print(f"[Hold] TBLCANCELEDDTL insert failed: {e2}")
                    _clear_all_temp_bill_rows(cur, bill_no, location_code)
                    try:
                        cur.execute(
                            f"UPDATE {BILLNO_TABLE_NAME} SET FLAG = :flag WHERE BILLNO = :billno",
                            {"flag": 'Y', "billno": bill_no}
                        )
                    except oracledb.Error as e:
                        print(f"[Hold] BILLNOTABLE FLAG update failed: {e}")
                    conn.commit()
                    return jsonify({"ok": True, "billNo": bill_no, "locationCode": location_code, "savedToDb": True})

                # Hold (not suspend): keep cart in TEMPBILLHDR/TEMPBILLDTL with FLAG=0 (held)
                _dedupe_tempbillhdr_for_bill(cur, bill_no, loc_num)
                now = datetime.datetime.now()
                billdate_str = now.strftime('%Y-%m-%d')
                billtime_str = now.strftime('%H:%M:%S')
                set_ts = _hold_request_has_timestamp(data)

                # One header row: update draft row to held; if no billTime/billDate in request, only FLAG changes
                if set_ts:
                    try:
                        cur.execute(f"""
                            UPDATE {HOLD_TABLE_NAME}
                            SET FLAG = :flag,
                                BILLDATE = TO_DATE(:billdate, 'YYYY-MM-DD'),
                                BILLTIME = :billtime,
                                COUNTERCODE = :countercode,
                                CUSTOMERCODE = :customercode,
                                RESETNO = 1
                            WHERE BILLNO = :billno AND LOCATIONCODE = :loc AND (FLAG = {FLAG_DRAFT} OR FLAG IS NULL)
                        """, billno=bill_no, loc=loc_num, flag=FLAG_HELD, billdate=billdate_str,
                             billtime=billtime_str, countercode=counter_code, customercode=customer_code)
                    except oracledb.Error as e:
                        cur.execute(f"""
                            UPDATE {HOLD_TABLE_NAME} SET FLAG = :flag
                            WHERE BILLNO = :billno AND LOCATIONCODE = :loc AND (FLAG = {FLAG_DRAFT} OR FLAG IS NULL)
                        """, billno=bill_no, loc=loc_num, flag=FLAG_HELD)
                else:
                    try:
                        cur.execute(f"""
                            UPDATE {HOLD_TABLE_NAME} SET FLAG = :flag
                            WHERE BILLNO = :billno AND LOCATIONCODE = :loc AND (FLAG = {FLAG_DRAFT} OR FLAG IS NULL)
                        """, billno=bill_no, loc=loc_num, flag=FLAG_HELD)
                    except oracledb.Error as e:
                        print(f"[Hold] {HOLD_TABLE_NAME} FLAG-only update failed: {e}")

                updated = cur.rowcount
                if updated == 0:
                    # Single header row for this bill (not one row per line/qty)
                    hdr = {
                        'billno': bill_no,
                        'loc': loc_num,
                        'flag': FLAG_HELD,
                        'billdate': billdate_str,
                        'billtype': 'C',
                        'cardtype': None,
                        'cardno': None,
                        'customercode': customer_code,
                        'billtime': billtime_str,
                        'countercode': counter_code,
                        'resetno': 1,
                        'prevpoints': 0,
                    }
                    try:
                        cur.execute(f"""
                            INSERT INTO {HOLD_TABLE_NAME} (BILLNO, LOCATIONCODE, FLAG, BILLDATE, BILLTYPE, CARDTYPE, CARDNO, CUSTOMERCODE, BILLTIME, COUNTERCODE, RESETNO, PREVPOINTS)
                            VALUES (:billno, :loc, :flag, TO_DATE(:billdate, 'YYYY-MM-DD'), :billtype, :cardtype, :cardno, :customercode, :billtime, :countercode, :resetno, :prevpoints)
                        """, hdr)
                    except oracledb.Error:
                        cur.execute(f"""
                            INSERT INTO {HOLD_TABLE_NAME} (BILLNO, LOCATIONCODE, FLAG)
                            VALUES (:billno, :loc, :flag)
                        """, {'billno': hdr['billno'], 'loc': hdr['loc'], 'flag': hdr['flag']})
                
                # Sync TEMPBILLDTL when holding (ITEMFLAG=1 for held items)
                _cart_sync_tempbilldtl(cur, conn, bill_no, location_code, items, item_flag=1)
                try:
                    cur.execute(
                        f"UPDATE {BILLNO_TABLE_NAME} SET FLAG = :flag WHERE BILLNO = :billno",
                        {"flag": 'H', "billno": bill_no}
                    )
                except oracledb.Error as e:
                    print(f"[Hold] BILLNOTABLE FLAG update failed: {e}")
                conn.commit()
                return jsonify({"ok": True, "billNo": bill_no, "locationCode": location_code, "savedToDb": True})
            except oracledb.Error as e:
                if conn:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                print(f"[Hold] {HOLD_TABLE_NAME} insert failed (will use in-memory): {e}")
            finally:
                if cur:
                    try:
                        cur.close()
                    except Exception:
                        pass
                try:
                    conn.close()
                except Exception:
                    pass
        # In-memory fallback (used when Oracle is down or INSERT failed)
        if suspend:
            return jsonify({"ok": True, "billNo": bill_no, "locationCode": location_code, "savedToDb": False})
        hold_items = []
        for it in items:
            if not isinstance(it, dict):
                continue
            try:
                hold_items.append({
                    "id": it.get("id") or it.get("itemcode") or it.get("ITEMCODE"),
                    "name": it.get("name") or it.get("itemname") or it.get("ITEMNAME") or "",
                    "price": float(it.get("price", it.get("PRICE", 0)) or 0),
                    "quantity": int(it.get("quantity", it.get("qty", it.get("QUANTITY", 1))) or 1),
                })
            except (TypeError, ValueError):
                hold_items.append({"id": it.get("id"), "name": "", "price": 0.0, "quantity": 1})
        key = (location_code, bill_no)
        _held_bills_fallback[key] = {
            "counterCode": counter_code,
            "heldDate": datetime.datetime.now().isoformat(),
            "customerCode": customer_code,
            "items": hold_items,
        }
        return jsonify({"ok": True, "billNo": bill_no, "locationCode": location_code, "savedToDb": False})
    except Exception as e:
        print(f"[Hold] unexpected error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route('/api/void-line', methods=['POST'])
def void_line():
    """On Void Line: insert into TBLCANCELEDHDR (BILLSTATUS='V') and TBLCANCELEDDTL for the voided line."""
    try:
        data = request.get_json(silent=True) or {}
        bill_no = data.get('billNo')
        location_code = str(data.get('locationCode') or '').strip() or 'LOC001'
        counter_code = str(data.get('counterCode') or '').strip() or '20'
        item = data.get('item') or data.get('items')
        if isinstance(item, list):
            item = item[0] if item else None
        if bill_no is None:
            return jsonify({"error": "billNo is required"}), 400
        if not item or not isinstance(item, dict):
            return jsonify({"error": "item (voided line) is required"}), 400
        bill_no = _to_int(bill_no, 1)
        itemcode = str(item.get('id') or item.get('itemcode') or item.get('ITEMCODE') or '').strip()
        qty = _to_int(item.get('quantity') or item.get('qty') or item.get('QUANTITY'), 1)
        rate = _to_float(item.get('price') or item.get('PRICE') or item.get('rate'), 0.0)
        manufacturer_id = str(item.get('manufactureId') or item.get('MANUFACTURERID') or item.get('manufacturerId') or '').strip()
        net_line_amount = qty * rate
        bill_date_business = _bill_date_business_iso_from_request(data)
        billdate_str = bill_date_business or datetime.datetime.now().strftime('%Y-%m-%d')
        billtime_str = datetime.datetime.now().strftime('%H:%M:%S')
        conn = _get_connection()
        if conn:
            cur = None
            try:
                cur = conn.cursor()
                _void_hdr_bind = {
                    'loc': location_code,
                    'billno': bill_no,
                    'billdate': billdate_str,
                    'billtime': billtime_str,
                    'countercode': counter_code or None,
                    'netamount': net_line_amount,
                }
                try:
                    cur.execute("""
                        INSERT INTO TBLCANCELEDHDR (LOCATIONCODE, BILLNO, BILLDATE, BILLTIME, COUNTERCODE, DISCOUNTAMOUNT, NETBILLAMOUNT, BILLSTATUS, CREATEDDATE)
                        VALUES (:loc, :billno, TO_DATE(:billdate, 'YYYY-MM-DD'), :billtime, :countercode, 0, :netamount, 'V', SYSDATE)
                    """, _void_hdr_bind)
                except oracledb.Error as e:
                    err_u = str(e).upper()
                    if 'ORA-00904' in err_u or '00904' in err_u:
                        try:
                            cur.execute("""
                                INSERT INTO TBLCANCELEDHDR (LOCATIONCODE, BILLNO, BILLDATE, BILLTIME, COUNTERCODE, DISCOUNTAMOUNT, NETBILLAMOUNT, BILLSTATUS)
                                VALUES (:loc, :billno, TO_DATE(:billdate, 'YYYY-MM-DD'), :billtime, :countercode, 0, :netamount, 'V')
                            """, _void_hdr_bind)
                        except oracledb.Error as e2:
                            print(f"[VoidLine] TBLCANCELEDHDR insert failed: {e2}")
                    else:
                        print(f"[VoidLine] TBLCANCELEDHDR insert failed: {e}")
                try:
                    cur.execute("""
                        INSERT INTO TBLCANCELEDDTL (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID)
                        VALUES (:loc, :billno, 1, :itemcode, :quantity, :rate, :manufacturerid)
                    """, {
                        'loc': location_code,
                        'billno': bill_no,
                        'itemcode': itemcode or None,
                        'quantity': qty,
                        'rate': rate,
                        'manufacturerid': manufacturer_id or None,
                    })
                except oracledb.Error as e:
                    print(f"[VoidLine] TBLCANCELEDDTL insert failed: {e}")
                conn.commit()
                return jsonify({"ok": True, "billNo": bill_no, "locationCode": location_code, "savedToDb": True})
            except oracledb.Error as e:
                if conn:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                print(f"[VoidLine] DB error: {e}")
            finally:
                if cur:
                    try:
                        cur.close()
                    except Exception:
                        pass
                try:
                    conn.close()
                except Exception:
                    pass
        return jsonify({"ok": True, "billNo": bill_no, "locationCode": location_code, "savedToDb": False})
    except Exception as e:
        print(f"[VoidLine] unexpected error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500


def _insert_itemjournal_and_itemlog(cur, bill_no, location_code, dtl_params, is_sales_return=False):
    """Insert ITEMJOURNAL and ITEMLOG for finalized bill lines (payment time). ITEMLOG.QUANTITY is decimal (3dp); ITEMLOG.FACTOR is integer (rounded conv × qty)."""
    if not dtl_params:
        return
    loc_num = _location_to_num(location_code, 1)
    _uom_codes = [p['itemcode'] for p in dtl_params if p.get('itemcode') and not (str(p.get('uom') or '').strip())]
    _uom_from_master = _get_item_details_from_master(cur, _uom_codes)
    for p in dtl_params:
        if not (str(p.get('uom') or '').strip()) and p.get('itemcode'):
            bu = (_uom_from_master.get(p['itemcode']) or {}).get('baseuom')
            p['uom'] = str(bu).strip() if bu else None
    _ensure_itemjournal(cur)
    journal_params = []
    for p in dtl_params:
        qty = p.get('quantity', 1)
        rate = p.get('rate', 0.0)
        amount = _to_float(qty, 1) * _to_float(rate, 0.0)
        _rn = p.get('billno')
        _ln = p.get('slno')
        journal_params.append({
            'loc_sel': loc_num,
            'loc_chk': loc_num,
            'receiptno_sel': _rn,
            'receiptno_chk': _rn,
            'lineno_sel': _ln,
            'lineno_chk': _ln,
            'itemcode': str(p.get('itemcode')) if p.get('itemcode') is not None else None,
            'qty': qty,
            'rate': rate,
            'amount': amount,
            'source_no': _rn,
            'transtype': 'SALES',
            'source_doc': 'BILL',
            'resetno': 1,
        })
    # Compare location with TO_CHAR on both sides: NVL(NUMBER, ' ') raises ORA-01722 when LOCATIONCODE is NUMBER.
    insert_sql = f"""
        INSERT INTO {ITEMJOURNAL_TABLE_NAME} (LOCATIONCODE, RECEIPTNO, LINENO, ITEMCODE, QTY, RATE, AMOUNT, SOURCE_NO, TRANSTYPE, SOURCE_DOC, RESETNO)
        SELECT :loc_sel, :receiptno_sel, :lineno_sel, :itemcode, :qty, :rate, :amount, :source_no, :transtype, :source_doc, :resetno FROM DUAL
        WHERE NOT EXISTS (
            SELECT 1 FROM {ITEMJOURNAL_TABLE_NAME}
            WHERE NVL(TO_CHAR(LOCATIONCODE), ' ') = NVL(TO_CHAR(:loc_chk), ' ') AND RECEIPTNO = :receiptno_chk AND LINENO = :lineno_chk
        )
    """
    for j in journal_params:
        try:
            cur.execute(insert_sql, j)
        except oracledb.Error as e:
            err_str = str(e).upper()
            if 'ORA-00001' not in err_str:
                # Handle ORA-01722: try with string itemcode if numeric failed, or vice versa
                if '01722' in err_str:
                    try:
                        # Try alternative: if itemcode was numeric, try as string; if string, try as None
                        alt_j = dict(j)
                        if isinstance(alt_j.get('itemcode'), (int, float)):
                            alt_j['itemcode'] = str(alt_j['itemcode'])
                        else:
                            alt_j['itemcode'] = None
                        cur.execute(insert_sql, alt_j)
                    except oracledb.Error as e2:
                        print(f"[ItemJournal] insert warning (retry also failed): {e2}")
                else:
                    print(f"[ItemJournal] insert warning: {e}")
    _ensure_itemlog(cur)
    try:
        loc_str = str(location_code or '').strip()
        cur.execute(
            f"""
            DELETE FROM {ITEMLOG_TABLE_NAME}
            WHERE DOCUMENTNO = :doc
              AND TRIM(TO_CHAR(LOCATIONCODE)) IN (TRIM(TO_CHAR(:loc_num)), :loc_str)
            """,
            doc=bill_no,
            loc_num=loc_num,
            loc_str=loc_str,
        )
    except oracledb.Error as e:
        print(f"[ItemLog] delete for bill warning: {e}")
    transtype_log = 'SALE RETURN' if is_sales_return else 'SALE'
    itemlog_sql = f"""
        INSERT INTO {ITEMLOG_TABLE_NAME} (LOGNO, ITEMCODE, CURRENTSTOCK, TRANSACTIONTYPE, QUANTITY, UOM, DOCUMENTNO, LOCATIONCODE, RATE, FACTOR, CREATEDDATE)
        SELECT (SELECT NVL(MAX(L.LOGNO), 0) + 1 FROM {ITEMLOG_TABLE_NAME} L), :itemcode, 0, :transtype, :quantity, :uom, :documentno, :locationcode, :rate, :factor, SYSDATE
        FROM DUAL
    """
    for p in dtl_params:
        if p.get('void'):
            continue
        if not (p.get('itemcode') or '').strip():
            continue
        qline = _round_qty_for_db(p.get('quantity', 1), 3)
        if abs(qline) < 1e-12:
            continue
        log_qty = abs(qline) if is_sales_return else -abs(qline)
        _cf_log = p.get('factor') or p.get('FACTOR') or p.get('conversionFactor') or p.get('CONVERSIONFACTOR')
        try:
            conv_per_unit = float(_cf_log) if _cf_log is not None and str(_cf_log).strip() != '' else 1.0
        except (TypeError, ValueError):
            conv_per_unit = 1.0
        if conv_per_unit <= 0:
            conv_per_unit = 1.0
        qty_abs = abs(float(qline))
        try:
            factor_col = int(round(conv_per_unit * qty_abs))
        except (TypeError, ValueError, OverflowError):
            factor_col = 0
        il_bind = {
            'itemcode': _itemcode_numeric_if_possible(p.get('itemcode')),
            'transtype': transtype_log,
            'quantity': log_qty,
            'uom': p.get('uom') or None,
            'documentno': bill_no,
            'locationcode': loc_num,
            'rate': p.get('rate', 0.0),
            'factor': factor_col,
        }
        try:
            cur.execute(itemlog_sql, il_bind)
        except oracledb.Error as e:
            err_str = str(e).upper()
            if '00904' in err_str or 'ORA-00904' in err_str:
                itemlog_sql_no_factor = f"""
                    INSERT INTO {ITEMLOG_TABLE_NAME} (LOGNO, ITEMCODE, CURRENTSTOCK, TRANSACTIONTYPE, QUANTITY, UOM, DOCUMENTNO, LOCATIONCODE, RATE, CREATEDDATE)
                    SELECT (SELECT NVL(MAX(L.LOGNO), 0) + 1 FROM {ITEMLOG_TABLE_NAME} L), :itemcode, 0, :transtype, :quantity, :uom, :documentno, :locationcode, :rate, SYSDATE
                    FROM DUAL
                """
                try:
                    _il2 = {k: v for k, v in il_bind.items() if k != 'factor'}
                    cur.execute(itemlog_sql_no_factor, _il2)
                except oracledb.Error as e2:
                    print(f"[ItemLog] insert warning: {e2}")
            else:
                print(f"[ItemLog] insert warning: {e}")


def _clear_draft_temp_cart(cur, bill_no, location_code):
    """After payment: remove draft cart rows (FLAG=1) from TEMPBILLHDR for this billNo.
    Held bills (FLAG=0) for other or same bill numbers are left unchanged.
    For TEMPBILLDTL, delete all rows for this billNo."""
    loc_num = _location_to_num(location_code, 1)
    bill_no = _to_int(bill_no, 1)
    try:
        _ensure_tempbillhdr(cur)
        _ensure_tempbilldtl(cur)
        cur.execute(f"""
            DELETE FROM {HOLD_TABLE_NAME}
            WHERE BILLNO = :billno AND LOCATIONCODE = :loc AND (FLAG = :flag OR FLAG IS NULL)
        """, billno=bill_no, loc=loc_num, flag=FLAG_DRAFT)
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00904' not in err_str and '00904' not in err_str:
            raise
        cur.execute(
            f"DELETE FROM {HOLD_TABLE_NAME} WHERE BILLNO = :billno AND LOCATIONCODE = :loc",
            billno=bill_no, loc=loc_num,
        )
    try:
        cur.execute(f"DELETE FROM {HOLD_DTL_TABLE_NAME} WHERE BILLNO = :billno", billno=bill_no)
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00904' not in err_str and '00904' not in err_str:
            raise


def _clear_all_temp_bill_rows(cur, bill_no, location_code):
    """Remove all TEMPBILLHDR/TEMPBILLDTL rows for billNo (e.g. after suspend). Held-only carts use FLAG=0; suspend clears entirely."""
    loc_num = _location_to_num(location_code, 1)
    bill_no = _to_int(bill_no, 1)
    try:
        _ensure_tempbillhdr(cur)
        _ensure_tempbilldtl(cur)
        cur.execute(
            f"DELETE FROM {HOLD_TABLE_NAME} WHERE BILLNO = :billno AND LOCATIONCODE = :loc",
            billno=bill_no, loc=loc_num,
        )
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00904' not in err_str and '00904' not in err_str:
            raise
        cur.execute(f"DELETE FROM {HOLD_TABLE_NAME} WHERE BILLNO = :billno", billno=bill_no)
    try:
        cur.execute(f"DELETE FROM {HOLD_DTL_TABLE_NAME} WHERE BILLNO = :billno", billno=bill_no)
    except oracledb.Error as e:
        print(f"[Hold] {HOLD_DTL_TABLE_NAME} delete (suspend) warning: {e}")


def _cart_sync_tempbillhdr(cur, conn, bill_no, location_code, items, extra_data=None):
    """Sync TEMPBILLHDR (header) with FLAG=1 (draft) when items added to cart.
    
    Args:
        extra_data: Optional dict with BILLDATE, BILLTYPE, CARDTYPE, CARDNO, CUSTOMERCODE, BILLTIME, COUNTERCODE, PREVPOINTS
    """
    loc_num = _location_to_num(location_code, 1)
    bill_no = _to_int(bill_no, 1)
    err_str = None
    
    # Get current date/time defaults
    now = datetime.datetime.now()
    billdate_str = now.strftime('%Y-%m-%d')
    billtime_str = now.strftime('%H:%M:%S')
    
    # Extract extra data if provided
    ed = extra_data or {}
    billdate = ed.get('billdate') or ed.get('BILLDATE') or billdate_str
    billtype = ed.get('billtype') or ed.get('BILLTYPE') or 'C'  # Default Cash
    cardtype = ed.get('cardtype') or ed.get('CARDTYPE') or None
    cardno = ed.get('cardno') or ed.get('CARDNO') or None
    customercode = ed.get('customercode') or ed.get('CUSTOMERCODE') or ed.get('customerCode') or None
    billtime = ed.get('billtime') or ed.get('BILLTIME') or billtime_str
    countercode = ed.get('countercode') or ed.get('COUNTERCODE') or ed.get('counterCode') or None
    prevpoints = _to_float(ed.get('prevpoints') or ed.get('PREVPOINTS') or ed.get('totalPoints') or 0, 0)
    
    try:
        cur.execute(f"""
            DELETE FROM {HOLD_TABLE_NAME}
            WHERE BILLNO = :billno AND LOCATIONCODE = :loc AND (FLAG = :flag OR FLAG IS NULL)
        """, billno=bill_no, loc=loc_num, flag=FLAG_DRAFT)
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00904' not in err_str and '00904' not in err_str:
            raise
        conn.rollback()
        cur.execute(f"DELETE FROM {HOLD_TABLE_NAME} WHERE BILLNO = :billno AND LOCATIONCODE = :loc",
                    billno=bill_no, loc=loc_num)
    if items:
        # One TEMPBILLHDR row per bill (not per cart line or quantity)
        hdr_one = {
            'billno': bill_no,
            'loc': loc_num,
            'flag': FLAG_DRAFT,
            'billdate': billdate,
            'billtype': billtype,
            'cardtype': cardtype,
            'cardno': cardno,
            'customercode': customercode,
            'billtime': billtime,
            'countercode': countercode,
            'resetno': 1,
            'prevpoints': prevpoints,
        }
        try:
            cur.execute(f"""
                INSERT INTO {HOLD_TABLE_NAME} (BILLNO, LOCATIONCODE, FLAG, BILLDATE, BILLTYPE, CARDTYPE, CARDNO, CUSTOMERCODE, BILLTIME, COUNTERCODE, RESETNO, PREVPOINTS)
                VALUES (:billno, :loc, :flag, TO_DATE(:billdate, 'YYYY-MM-DD'), :billtype, :cardtype, :cardno, :customercode, :billtime, :countercode, :resetno, :prevpoints)
            """, hdr_one)
        except oracledb.Error as e:
            err_str = str(e).upper()
            if 'ORA-00904' not in err_str and '00913' not in err_str:
                raise
            conn.rollback()
            cur.execute(f"DELETE FROM {HOLD_TABLE_NAME} WHERE BILLNO = :billno AND LOCATIONCODE = :loc",
                        billno=bill_no, loc=loc_num)
            cur.execute(f"""
                INSERT INTO {HOLD_TABLE_NAME} (BILLNO, LOCATIONCODE)
                VALUES (:billno, :loc)
            """, {'billno': hdr_one['billno'], 'loc': hdr_one['loc']})


def _cart_sync_tempbilldtl(cur, conn, bill_no, location_code, items, item_flag=None):
    """Sync TEMPBILLDTL (detail) with ITEMFLAG when items added to cart.

    Args:
        item_flag: If provided, uses this value for ITEMFLAG column (for hold operations)
    """
    loc_num = _location_to_num(location_code, 1)
    bill_no = _to_int(bill_no, 1)
    _ensure_tempbilldtl(cur)
    cur.execute(f"DELETE FROM {HOLD_DTL_TABLE_NAME} WHERE BILLNO = :billno", billno=bill_no)
    dtl_params = []
    for slno, it in enumerate(items or [], start=1):
        if not isinstance(it, dict):
            continue
        itemcode = str(it.get('id') or it.get('itemcode') or it.get('ITEMCODE') or '').strip()
        qty = _to_int(it.get('quantity') or it.get('qty') or it.get('QUANTITY'), 1)
        rate = _to_float(it.get('price') or it.get('PRICE') or it.get('rate'), 0.0)
        manufacturer_id = str(it.get('manufactureId') or it.get('MANUFACTURERID') or it.get('manufacturerId') or '').strip()
        uom_line = str(it.get('uom') or it.get('BASEUOM') or it.get('baseuom') or it.get('UNITOFMEASUREMENT') or '').strip()
        prevpoints = _to_float(it.get('prevpoints') or it.get('PREVPOINTS') or it.get('points') or 0, 0)
        costprice = _to_float(it.get('costprice') or it.get('COSTPRICE') or it.get('cost') or 0, 0)
        retailprice = _to_float(it.get('retailprice') or it.get('RETAILPRICE') or it.get('retail') or rate, 0)
        store = str(it.get('store') or it.get('STORE') or location_code or '').strip()
        dtl_params.append({
            'loc': location_code,
            'billno': bill_no,
            'slno': slno,
            'itemcode': itemcode or None,
            'quantity': qty,
            'rate': rate,
            'manufacturerid': manufacturer_id or None,
            'uom': uom_line or None,
            'void': bool(it.get('void')),
            'unitofmeasurement': uom_line or None,
            'resetno': 1,
            'prevpoints': prevpoints,
            'costprice': costprice,
            'retailprice': retailprice,
            'store': store or location_code,
            'itemflag': item_flag if item_flag is not None else (1 if itemcode else 0),
        })
    if dtl_params:
        # executemany bind dicts must match SQL only — extra keys (e.g. uom) cause ORA-01036 with thin driver.
        dtl_bind = [
            {
                'loc': p['loc'],
                'billno': p['billno'],
                'slno': p['slno'],
                'itemcode': p['itemcode'],
                'quantity': p['quantity'],
                'rate': p['rate'],
                'manufacturerid': p['manufacturerid'],
                'unitofmeasurement': p['unitofmeasurement'],
                'resetno': p['resetno'],
                'prevpoints': p['prevpoints'],
                'costprice': p['costprice'],
                'retailprice': p['retailprice'],
                'store': p['store'],
                'itemflag': p['itemflag'],
            }
            for p in dtl_params
        ]
        try:
            cur.executemany(f"""
                INSERT INTO {HOLD_DTL_TABLE_NAME} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID, UNITOFMEASUREMENT, RESETNO, PREVPOINTS, COSTPRICE, RETAILPRICE, STORE, ITEMFLAG)
                VALUES (:loc, :billno, :slno, :itemcode, :quantity, :rate, :manufacturerid, :unitofmeasurement, :resetno, :prevpoints, :costprice, :retailprice, :store, :itemflag)
            """, dtl_bind)
        except oracledb.Error as e:
            if 'ORA-00904' not in str(e).upper() and '00904' not in str(e).upper():
                raise
            # Fallback: insert without new columns for backward compatibility
            dtl_bind_fallback = [
                {
                    'loc': p['loc'],
                    'billno': p['billno'],
                    'slno': p['slno'],
                    'itemcode': p['itemcode'],
                    'quantity': p['quantity'],
                    'rate': p['rate'],
                    'manufacturerid': p['manufacturerid'],
                }
                for p in dtl_params
            ]
            cur.executemany(f"""
                INSERT INTO {HOLD_DTL_TABLE_NAME} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID)
                VALUES (:loc, :billno, :slno, :itemcode, :quantity, :rate, :manufacturerid)
            """, dtl_bind_fallback)


def _cart_sync_execute(cur, conn, bill_no, location_code, items, extra_data=None):
    """Execute cart sync: TEMPBILLHDR with FLAG=1 (draft) and TEMPBILLDTL when items added to cart.
    This is a convenience wrapper that calls both _cart_sync_tempbillhdr and _cart_sync_tempbilldtl."""
    _cart_sync_tempbillhdr(cur, conn, bill_no, location_code, items, extra_data=extra_data)
    _cart_sync_tempbilldtl(cur, conn, bill_no, location_code, items)


@app.route('/api/display/current', methods=['GET'])
def display_current_cart():
    """Return current billNo and cart items for a counter (for customer back display)."""
    counter_code = (request.args.get('counterCode') or request.args.get('counter_code') or '').strip() or None
    location_code = (request.args.get('locationCode') or request.args.get('location_code') or '').strip() or 'LOC001'
    if not counter_code:
        return jsonify({"ok": True, "billNo": None, "items": [], "locationName": ""}), 200
    conn = _get_connection()
    if not conn:
        return jsonify({"ok": True, "billNo": None, "items": [], "locationName": ""}), 200
    cur = None
    bill_no = None
    items = []
    location_name = ''
    try:
        cur = conn.cursor()
        location_name = _get_locationmaster_location_name(cur, location_code)
        _ensure_billnotable(cur)
        try:
            cur.execute("""
                SELECT BILLNO FROM (
                    SELECT BILLNO FROM """ + BILLNO_TABLE_NAME + """
                    WHERE COUNTERCODE = :cc AND (FLAG = 'N' OR FLAG IS NULL)
                    ORDER BY BILLNO
                ) WHERE ROWNUM = 1
            """, {"cc": counter_code})
            row = cur.fetchone()
            if row and row[0] is not None:
                bill_no = _to_int(row[0], None)
        except oracledb.Error as e:
            if 'ORA-00904' not in str(e).upper() and '00904' not in str(e).upper():
                raise
        if bill_no is None:
            return jsonify({"ok": True, "billNo": None, "items": [], "locationName": location_name}), 200
        _ensure_tempbilldtl(cur)
        cur.execute("""
            SELECT SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID
            FROM """ + HOLD_DTL_TABLE_NAME + """
            WHERE BILLNO = :billno
            ORDER BY SLNO
        """, billno=bill_no)
        dtl_rows = cur.fetchall()
        cols = [c[0].upper() if c else '' for c in cur.description] if cur.description else []
        for row in dtl_rows:
            def _col(name, default=None):
                try:
                    i = cols.index(name)
                    return row[i] if i >= 0 and i < len(row) else default
                except (ValueError, IndexError):
                    return default
            itemcode = _col('ITEMCODE')
            qty = _to_int(_col('QUANTITY'), 1)
            rate = _to_float(_col('RATE'), 0.0)
            manufacturer_id = _col('MANUFACTURERID')
            code_str = str(itemcode).strip() if itemcode else ""
            items.append({
                "id": code_str or 0,
                "name": "",
                "price": rate,
                "quantity": qty,
                "manufactureId": str(manufacturer_id).strip() if manufacturer_id else "",
                "ITEMCODE": code_str,
                "MANUFACTURERID": str(manufacturer_id).strip() if manufacturer_id else "",
            })
        itemcodes = [str(it.get("ITEMCODE") or it.get("id") or "").strip() for it in items if it.get("ITEMCODE") or it.get("id")]
        if itemcodes:
            details_map = _get_item_details_from_master(cur, itemcodes)
            for it in items:
                code = str(it.get("ITEMCODE") or it.get("id") or "").strip()
                details = details_map.get(code) or {}
                it["name"] = details.get("name") or ""
                it["uom"] = details.get("baseuom") or ""
                it["ITEMNAMEARA"] = details.get("itemnameara") or ""
        return jsonify({"ok": True, "billNo": bill_no, "items": items, "locationName": location_name}), 200
    except oracledb.Error as e:
        print(f"[Display current] error: {e}")
        return jsonify({"ok": True, "billNo": bill_no, "items": items, "locationName": location_name}), 200
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


@app.route('/api/cart/by-bill', methods=['GET'])
def cart_by_bill():
    """Fetch cart items from TEMPBILLDTL by BILLNO (for restore on tab reopen)."""
    bill_no = request.args.get('billNo') or request.args.get('billno')
    location_code = (request.args.get('locationCode') or '').strip() or 'LOC001'
    if not bill_no:
        return jsonify({"ok": False, "error": "billNo required", "items": []}), 400
    try:
        bill_no = int(bill_no)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "billNo must be a number", "items": []}), 400
    conn = _get_connection()
    if not conn:
        return jsonify({"ok": True, "items": []}), 200
    cur = None
    items = []
    try:
        cur = conn.cursor()
        _ensure_tempbilldtl(cur)
        cur.execute(f"""
            SELECT SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID
            FROM {HOLD_DTL_TABLE_NAME}
            WHERE BILLNO = :billno
            ORDER BY SLNO
        """, billno=bill_no)
        dtl_rows = cur.fetchall()
        cols = [c[0].upper() if c else '' for c in cur.description] if cur.description else []
        for row in dtl_rows:
            def _col(name, default=None):
                try:
                    i = cols.index(name)
                    return row[i] if i >= 0 and i < len(row) else default
                except (ValueError, IndexError):
                    return default
            itemcode = _col('ITEMCODE')
            qty = _to_int(_col('QUANTITY'), 1)
            rate = _to_float(_col('RATE'), 0.0)
            manufacturer_id = _col('MANUFACTURERID')
            code_str = str(itemcode).strip() if itemcode else ""
            items.append({
                "id": code_str or 0,
                "name": "",
                "price": rate,
                "quantity": qty,
                "manufactureId": str(manufacturer_id).strip() if manufacturer_id else "",
                "ITEMCODE": code_str,
                "MANUFACTURERID": str(manufacturer_id).strip() if manufacturer_id else "",
            })
        itemcodes = [str(it.get("ITEMCODE") or it.get("id") or "").strip() for it in items if it.get("ITEMCODE") or it.get("id")]
        if itemcodes:
            details_map = _get_item_details_from_master(cur, itemcodes)
            for it in items:
                code = str(it.get("ITEMCODE") or it.get("id") or "").strip()
                details = details_map.get(code) or {}
                it["name"] = details.get("name") or ""
                it["uom"] = details.get("baseuom") or ""
                it["ITEMNAMEARA"] = details.get("itemnameara") or ""
                cp = details.get("costprice")
                if cp is not None:
                    it["costPrice"] = cp
                    it["COSTPRICE"] = cp
                ac = details.get("averagecost")
                if ac is not None:
                    it["avgCost"] = ac
                    it["AVERAGECOST"] = ac
    except oracledb.Error as e:
        print(f"[Cart by-bill] {HOLD_DTL_TABLE_NAME} error: {e}")
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass
    return jsonify({"ok": True, "items": items})


@app.route('/api/cart/sync', methods=['GET', 'POST'])
def cart_sync():
    """Sync current cart to hold table with FLAG=1 (draft). POST only; GET returns hint."""
    if request.method == 'GET':
        return jsonify({"ok": True, "message": "Use POST with body: billNo, locationCode, items"}), 200
    data = request.get_json(silent=True) or {}
    bill_no = data.get('billNo')
    location_code = (data.get('locationCode') or '').strip() or 'LOC001'
    items = data.get('items') or []
    _cnt_sync = (data.get('counterCode') or data.get('counter_code') or '').strip() or None
    _cust_sync = data.get('customerCode') or data.get('customer_code') or data.get('CUSTOMERCODE')
    customer_code_sync = str(_cust_sync).strip() if _cust_sync not in (None, '') else None
    if bill_no is None:
        return jsonify({"error": "billNo is required"}), 400
    bill_no = _to_int(bill_no, 1)
    conn = _get_connection()
    if not conn:
        return jsonify({"ok": False, "error": "Database unavailable"}), 503
    cur = None
    try:
        cur = conn.cursor()
        _ensure_tempbillhdr(cur)
        _ensure_tempbilldtl(cur)
        _loc_d = str(location_code).strip() if location_code else None
        if not _loc_d:
            _loc_d = None
        if not customer_code_sync:
            try:
                _dc_sync, _ = _default_customer_from_tbl_countersale(cur, _cnt_sync or '', _loc_d)
                if _dc_sync:
                    customer_code_sync = _dc_sync
            except Exception:
                pass
        extra = {
            'countercode': _cnt_sync,
            'customercode': customer_code_sync,
        }
        _cart_sync_execute(cur, conn, bill_no, location_code, items, extra_data=extra)
        conn.commit()
        return jsonify({"ok": True})
    except oracledb.Error as e:
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        print(f"[Cart sync] error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        if cur:
            try:
                cur.close()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


@app.route('/api/hold', methods=['GET'])
def list_held_bills():
    """List held bills from TEMPBILLHDR (FLAG=0). Return BILLNO, HELDDATE, items per bill."""
    location_code = (request.args.get('locationCode') or '').strip() or 'LOC001'
    loc_num = _location_to_num(location_code, 1)
    conn = _get_connection()
    result = []
    if conn:
        cur = None
        try:
            cur = conn.cursor()
            _ensure_tempbillhdr(cur)
            # Held bills: distinct BILLNO for this location with FLAG=0 (held)
            cur.execute(f"""
                SELECT DISTINCT BILLNO, LOCATIONCODE
                FROM {HOLD_TABLE_NAME}
                WHERE LOCATIONCODE = :loc AND (FLAG = :flag OR FLAG IS NULL)
                ORDER BY BILLNO DESC
            """, loc=loc_num, flag=FLAG_HELD)
            rows = cur.fetchall()
            cols = [c[0] for c in cur.description]
            result = [dict(zip(cols, row)) for row in rows]
            for r in result:
                r["HELDDATE"] = None
                r["items"] = []
            # Try to get HELDDATE if column exists (MAX per bill)
            try:
                cur.execute(f"""
                    SELECT BILLNO, MAX(HELDDATE) AS HELDDATE
                    FROM {HOLD_TABLE_NAME}
                    WHERE LOCATIONCODE = :loc AND (FLAG = :flag OR FLAG IS NULL)
                    GROUP BY BILLNO
                """, loc=loc_num, flag=FLAG_HELD)
                for row in cur.fetchall():
                    billno, hd = row[0], row[1] if len(row) > 1 else None
                    for r in result:
                        if r.get("BILLNO") == billno and hd is not None:
                            r["HELDDATE"] = hd.isoformat() if hasattr(hd, 'isoformat') else str(hd)
                            break
            except oracledb.Error:
                pass
            # Fetch product details from TEMPBILLDTL per bill; look up product name from ITEMMASTER
            for r in result:
                billno = r.get("BILLNO")
                r["items"] = []
                try:
                    cur.execute(f"""
                        SELECT SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID
                        FROM {HOLD_DTL_TABLE_NAME}
                        WHERE BILLNO = :billno
                        ORDER BY SLNO
                    """, billno=billno)
                    dtl_rows = cur.fetchall()
                    cols = [c[0].upper() if c else '' for c in cur.description] if cur.description else []
                    for row in dtl_rows:
                        def _col(name, default=None):
                            try:
                                i = cols.index(name)
                                return row[i] if i >= 0 and i < len(row) else default
                            except (ValueError, IndexError):
                                return default
                        itemcode = _col('ITEMCODE')
                        qty = _to_int(_col('QUANTITY'), 1)
                        rate = _to_float(_col('RATE'), 0.0)
                        manufacturer_id = _col('MANUFACTURERID')
                        code_str = str(itemcode).strip() if itemcode else ""
                        r["items"].append({
                            "id": code_str or 0,
                            "name": "",
                            "price": rate,
                            "quantity": qty,
                            "manufactureId": str(manufacturer_id).strip() if manufacturer_id else "",
                            "ITEMCODE": code_str,
                        })
                    # Look up product names from ITEMMASTER by ITEMCODE
                    itemcodes = [str(it.get("ITEMCODE") or it.get("id") or "").strip() for it in r["items"] if it.get("ITEMCODE") or it.get("id")]
                    names_map = _get_item_names_from_master(cur, itemcodes)
                    for it in r["items"]:
                        code = str(it.get("ITEMCODE") or it.get("id") or "").strip()
                        it["name"] = names_map.get(code, "") or ""
                except oracledb.Error:
                    pass
                if not r["items"]:
                    cur.execute(f"""
                        SELECT BILLNO FROM {HOLD_TABLE_NAME}
                        WHERE BILLNO = :billno AND LOCATIONCODE = :loc AND (FLAG = :flag OR FLAG IS NULL)
                    """, billno=billno, loc=loc_num, flag=FLAG_HELD)
                    hold_rows = cur.fetchall()
                    r["items"] = [{"id": 0, "name": "Item", "price": 0.0, "quantity": 1} for _ in hold_rows]
            result.sort(key=lambda x: (x.get("HELDDATE") or "", x.get("BILLNO") or 0), reverse=True)
            return jsonify(result)
        except oracledb.Error as e:
            print(f"{HOLD_TABLE_NAME} list error: {e}")
        finally:
            if cur:
                try:
                    cur.close()
                except Exception:
                    pass
            try:
                conn.close()
            except Exception:
                pass
    for (loc, bill_no), v in _held_bills_fallback.items():
        if loc == location_code and not v.get("retrieved"):
            result.append({
                "BILLNO": bill_no,
                "LOCATIONCODE": loc,
                "HELDDATE": v.get("heldDate"),
                "items": v.get("items", []),
            })
    result.sort(key=lambda x: -(x.get("BILLNO") or 0))
    return jsonify(result)


@app.route('/api/hold/<int:bill_no>', methods=['GET'])
def get_held_bill(bill_no):
    """Get held bill details: fetch product details from TEMPBILLDTL, return billNo and items for cart retrieve."""
    location_code = (request.args.get('locationCode') or '').strip() or 'LOC001'
    loc_num = _location_to_num(location_code, 1)
    conn = _get_connection()
    if conn:
        cur = None
        try:
            cur = conn.cursor()
            cur.execute(f"""
                SELECT BILLNO
                FROM {HOLD_TABLE_NAME}
                WHERE BILLNO = :billno AND LOCATIONCODE = :loc AND (FLAG = :flag OR FLAG IS NULL)
            """, billno=bill_no, loc=loc_num, flag=FLAG_HELD)
            hdr_rows = cur.fetchall()
            if not hdr_rows:
                return jsonify({"error": "Held bill not found in database"}), 404
            # Fetch product details from TEMPBILLDTL for this bill (cart items for retrieve)
            items = []
            try:
                cur.execute(f"""
                    SELECT SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID
                    FROM {HOLD_DTL_TABLE_NAME}
                    WHERE BILLNO = :billno
                    ORDER BY SLNO
                """, billno=bill_no)
                dtl_rows = cur.fetchall()
                cols = [c[0].upper() if c else '' for c in cur.description] if cur.description else []
                for row in dtl_rows:
                    def col(name, default=None):
                        try:
                            i = cols.index(name)
                            return row[i] if i >= 0 and i < len(row) else default
                        except (ValueError, IndexError):
                            return default
                    itemcode = col('ITEMCODE')
                    qty = _to_int(col('QUANTITY'), 1)
                    rate = _to_float(col('RATE'), 0.0)
                    manufacturer_id = col('MANUFACTURERID')
                    code_str = str(itemcode).strip() if itemcode else ""
                    items.append({
                        "id": code_str or 0,
                        "name": "",
                        "price": rate,
                        "quantity": qty,
                        "manufactureId": str(manufacturer_id).strip() if manufacturer_id else "",
                        "ITEMCODE": code_str,
                        "MANUFACTURERID": str(manufacturer_id).strip() if manufacturer_id else "",
                    })
                # Look up product names from ITEMMASTER by ITEMCODE and set name on each item
                itemcodes = [str(it.get("ITEMCODE") or it.get("id") or "").strip() for it in items if it.get("ITEMCODE") or it.get("id")]
                names_map = _get_item_names_from_master(cur, itemcodes)
                for it in items:
                    code = str(it.get("ITEMCODE") or it.get("id") or "").strip()
                    it["name"] = names_map.get(code, "") or ""
            except oracledb.Error:
                pass
            if not items:
                items = [
                    {"id": 0, "name": "Item", "price": 0.0, "quantity": 1}
                    for _ in hdr_rows
                ]
            return jsonify({"billNo": bill_no, "locationCode": location_code, "items": items})
        except oracledb.Error as e:
            print(f"{HOLD_TABLE_NAME} get error: {e}")
        finally:
            if cur:
                try:
                    cur.close()
                except Exception:
                    pass
            try:
                conn.close()
            except Exception:
                pass
    # In-memory fallback only when DB unavailable
    key = (location_code, bill_no)
    if key not in _held_bills_fallback:
        return jsonify({"error": "Held bill not found"}), 404
    v = _held_bills_fallback[key]
    return jsonify({
        "billNo": bill_no,
        "locationCode": location_code,
        "items": v.get("items", []),
    })


@app.route('/api/hold/<int:bill_no>', methods=['DELETE'])
def delete_held_bill(bill_no):
    """On retrieve: only change FLAG (held=0 -> draft=1), do not delete from DB."""
    location_code = (request.args.get('locationCode') or '').strip() or 'LOC001'
    loc_num = _location_to_num(location_code, 1)
    conn = _get_connection()
    if conn:
        cur = None
        try:
            cur = conn.cursor()
            cur.execute(f"""
                UPDATE {HOLD_TABLE_NAME} SET FLAG = :flag
                WHERE BILLNO = :billno AND LOCATIONCODE = :loc AND (FLAG = :flag_held OR FLAG IS NULL)
            """, billno=bill_no, loc=loc_num, flag=FLAG_DRAFT, flag_held=FLAG_HELD)
            conn.commit()
            return jsonify({"ok": True})
        except oracledb.Error as e:
            if conn:
                try:
                    conn.rollback()
                except Exception:
                    pass
            print(f"{HOLD_TABLE_NAME} update flag error: {e}")
        finally:
            if cur:
                try:
                    cur.close()
                except Exception:
                    pass
            try:
                conn.close()
            except Exception:
                pass
    # In-memory fallback: mark as retrieved so it no longer appears in held list
    key = (location_code, bill_no)
    if key in _held_bills_fallback:
        _held_bills_fallback[key]["retrieved"] = True
    return jsonify({"ok": True})


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=7227)
