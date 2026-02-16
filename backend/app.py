from flask import Flask, jsonify, request
from flask_cors import CORS
import oracledb
import bcrypt
from flask_sqlalchemy import SQLAlchemy
import datetime
import os
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
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'pos-secret-key-change-in-production')

# Role display names from APPLICATIONUSER.rolecode (optional, for UI)
ROLE_CODE_TO_NAME = {1: 'manager', 3: 'cashier'}


def _hash(pw):
    return bcrypt.hashpw(pw.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


# Demo users for local/dev when Oracle is unavailable. Try: admin/admin, admin/password, cashier/cashier, 1/password
_demo_users = {
    'admin': {'password': _hash('admin'), 'role': 'manager', 'userid': 'admin', 'name': 'Admin', 'alt_password': 'password'},
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

# Oracle Connection Config
ORACLE_CONFIG = {
    'user': 'rfim',
    'password': 'rfim',
    'dsn': '192.168.1.225:1521/rgc'
}

# Initialize Oracle Client for Thick mode at startup
# Explicitly pointing to the x64 Instant Client in Downloads to resolve architecture mismatch
try:
    oracledb.init_oracle_client(lib_dir=r"C:\Users\USER\Downloads\instantclient-basic-windows.x64-21.20.0.0.0dbru\instantclient_21_20")
    print("Oracle Thick mode initialized successfully with x64 client.")
except oracledb.Error as err:
    print(f"Thick mode initialization note/failure: {err}")

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({"status": "ok"})


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
        query = """
            SELECT employeecode, password, rolecode, userid
            FROM APPLICATIONUSER
            WHERE UPPER(TRIM(employeecode)) = UPPER(:empcode)
        """
        cursor.execute(query, empcode=employeecode)
        row = cursor.fetchone()
        if not row:
            return None
        columns = [col[0] for col in cursor.description]
        rec = dict(zip(columns, row))
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
                return {'username': str(emp_code).strip(), 'role': role_name, 'userid': str(userid).strip()}
        except Exception:
            pass
        if (password or '') == (stored_pw or ''):
            return {'username': str(emp_code).strip(), 'role': role_name, 'userid': str(userid).strip()}
        return None
    except oracledb.Error as e:
        print(f"Oracle login error: {e}")
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


@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json(silent=True) or {}
    employeecode = (data.get('username') or data.get('employeecode') or '').strip()
    password = data.get('password') or ''
    user = _verify_demo_user(employeecode, password)
    if user is None:
        user = _verify_application_user(employeecode, password)
    if not user:
        return jsonify({"error": "Invalid employee code or password"}), 401
    token = _encode_token(user['username'], user['role'], user.get('userid'))
    return jsonify({
        "token": token,
        "user": {
            "username": user['username'],
            "role": user['role'],
            "userid": user.get('userid') or user['username']
        }
    })


@app.route('/api/me', methods=['GET'])
def me():
    auth = request.headers.get('Authorization') or ''
    if not auth.startswith('Bearer '):
        return jsonify({"error": "Missing or invalid authorization"}), 401
    try:
        payload = jwt.decode(
            auth[7:],
            app.config['SECRET_KEY'],
            algorithms=['HS256']
        )
        return jsonify({
            "user": {
                "username": payload.get('sub'),
                "role": payload.get('role'),
                "userid": payload.get('userid') or payload.get('sub')
            }
        })
    except jwt.ExpiredSignatureError:
        return jsonify({"error": "Token expired"}), 401
    except jwt.InvalidTokenError:
        return jsonify({"error": "Invalid token"}), 401


def _require_manager():
    auth = request.headers.get('Authorization') or ''
    payload = _decode_token(auth)
    if not payload:
        return None, (jsonify({"error": "Invalid or missing token"}), 401)
    role = (payload.get('role') or '').lower()
    if role != 'manager':
        return None, (jsonify({"error": "Manager role required"}), 403)
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
    if role not in ('manager', 'cashier', 'user'):
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
                g.categoryname 
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
                "CATEGORYNAME": "RETAIL"
            },
            {
                "LOCATIONCODE": "001",
                "CUSTOMERCODE": "C002",
                "CUST_FULL_NAME": "C002 JANE SMITH",
                "CATEGORYNAME": "WHOLESALE"
            }
        ]
        return jsonify(mock_data)
    finally:
        if 'cursor' in locals():
            cursor.close()
        if 'connection' in locals():
            connection.close()




@app.route('/api/products/lookup', methods=['GET'])
def lookup_product():
    """Look up a single product by barcode (manufactureId) or item code from ITEMMASTER."""
    code = (request.args.get('code') or '').strip()
    if not code:
        return jsonify({"error": "code is required"}), 400
    connection = None
    cursor = None
    try:
        connection = oracledb.connect(
            user=ORACLE_CONFIG['user'],
            password=ORACLE_CONFIG['password'],
            dsn=ORACLE_CONFIG['dsn']
        )
        cursor = connection.cursor()
        # ITEMMASTER: match by manufacturerid (barcode) or itemcode
        query = """
            SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid
            FROM itemmaster
            WHERE (UPPER(TRIM(TO_CHAR(manufacturerid))) = UPPER(:code)
               OR UPPER(TRIM(itemcode)) = UPPER(:code))
            AND ROWNUM = 1
        """
        cursor.execute(query, code=code)
        row = cursor.fetchone()
        if not row:
            return jsonify({"found": False, "code": code, "error": "Product not found"}), 200
        columns = [col[0] for col in cursor.description]
        result = dict(zip(columns, row))
        result["found"] = True
        return jsonify(result)
    except oracledb.Error as e:
        err_msg = str(e).upper()
        # Column manufactureid may not exist; fallback to itemcode only
        if 'MANUFACTUREID' in err_msg or 'INVALID' in err_msg:
            try:
                if cursor:
                    cursor.close()
                if connection:
                    connection.close()
                connection = oracledb.connect(
                    user=ORACLE_CONFIG['user'],
                    password=ORACLE_CONFIG['password'],
                    dsn=ORACLE_CONFIG['dsn']
                )
                cursor = connection.cursor()
                query = """
                    SELECT locationcode, itemcode, itemname, categorycode, retailprice
                    FROM itemmaster
                    WHERE UPPER(TRIM(itemcode)) = UPPER(:code)
                    AND ROWNUM = 1
                """
                cursor.execute(query, code=code)
                row = cursor.fetchone()
                if not row:
                    return jsonify({"found": False, "code": code, "error": "Product not found"}), 200
                cols = [c[0] for c in cursor.description]
                result = dict(zip(cols, row))
                result['MANUFACTUREID'] = str(result.get('ITEMCODE', ''))
                result["found"] = True
                return jsonify(result)
            except oracledb.Error as e2:
                print(f"Oracle lookup error: {e2}")
        else:
            print(f"Oracle lookup error: {e}")
        return jsonify({"found": False, "code": code, "error": "Product not found"}), 200
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


@app.route('/api/products', methods=['GET'])
def get_products():
    try:
        # Establish connection
        connection = oracledb.connect(
            user=ORACLE_CONFIG['user'],
            password=ORACLE_CONFIG['password'],
            dsn=ORACLE_CONFIG['dsn']
        )
        cursor = connection.cursor()
        
        # Execute Query (Manufactureid used for QR/barcode scanner match)
        query = """
            SELECT 
                p.locationcode,
                p.itemcode,
                p.itemname,
                p.categorycode,
                p.retailprice,
                p.manufacturerid    
            FROM itemmaster p
            WHERE ROWNUM <= 100
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
                "LOCATIONCODE": "020",
                "ITEMCODE": "1001",
                "ITEMNAME": "COCA COLA 500ML",
                "CATEGORYCODE": "BEVERAGES",
                "RETAILPRICE": "100",
                "MANUFACTUREID": "8901234567890"
            },
            {
                "LOCATIONCODE": "020",
                "ITEMCODE": "1002",
                "ITEMNAME": "PEPSI 500ML",
                "CATEGORYCODE": "BEVERAGES",
                "RETAILPRICE": "100",
                "MANUFACTUREID": "8901234567891"
            },
            {
                "LOCATIONCODE": "020",
                "ITEMCODE": "2001",
                "ITEMNAME": "ALMARAI MILK 1L",
                "CATEGORYCODE": "DAIRY",
                "RETAILPRICE": "100",
                "MANUFACTUREID": "8901234567892"
            }
        ]
        return jsonify(mock_data)
    finally:
        if 'cursor' in locals():
            cursor.close()
        if 'connection' in locals():
            connection.close()


# --- Hold / cart bills (Oracle) or in-memory fallback ---
# Change this constant when you rename the DB table (one place for all hold/cart SQL).
HOLD_TABLE_NAME = 'TEMPBILLHDR'
BILLNO_TABLE_NAME = 'BILLNOTABLE'
# BILLNOTABLE columns: BILLNO NUMBER, FLAG CHAR(1) DEFAULT 'n' (n/y), BILLDATE (required).
# HOLD table (TEMPBILLHDR): BILLNO, LOCATIONCODE, FLAG. FLAG=0 held, FLAG=1 draft.
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


def _ensure_tempbillhdr(cur):
    """Create hold table if it does not exist. Ignore ORA-00955 (exists) and ORA-01031 (no create priv)."""
    create_sql = f"""
        CREATE TABLE {HOLD_TABLE_NAME} (
            BILLNO NUMBER NOT NULL,
            LOCATIONCODE NUMBER NOT NULL,
            FLAG NUMBER DEFAULT 1
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
    """Create BILLNOTABLE if not exists. Columns: BILLNO NUMBER, FLAG CHAR(1) DEFAULT 'n', BILLDATE DATE."""
    create_sql = f"""
        CREATE TABLE {BILLNO_TABLE_NAME} (
            BILLNO NUMBER NOT NULL,
            FLAG CHAR(1) DEFAULT 'n',
            BILLDATE DATE DEFAULT SYSDATE NOT NULL
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


def _billno_flag_char(value):
    """Normalize FLAG for BILLNOTABLE to 'n' or 'y' (CHAR(1)). Default 'n'."""
    if value is None:
        return 'n'
    s = str(value).strip().lower()
    return 'y' if s == 'y' else 'n'


@app.route('/api/billno/next', methods=['GET', 'POST'])
def create_next_billno():
    """
    Create next bill no: fetch last BILLNO from BILLNOTABLE, set new_billno = last + 1.
    new_billno is returned; same is inserted into BILLNOTABLE with FLAG = 'n' (or 'y') and BILLDATE.
    """
    data = request.get_json(silent=True) or {} if request.method == 'POST' else {}
    raw_flag = data.get('flag') or request.args.get('flag') or 'n'
    flag_val = _billno_flag_char(raw_flag)
    conn = _get_connection()
    if not conn:
        return jsonify({"error": "Database unavailable", "billNo": None}), 503
    cur = None
    try:
        cur = conn.cursor()
        _ensure_billnotable(cur)
        cur.execute(f"SELECT NVL(MAX(BILLNO), 0) AS LAST_BILLNO FROM {BILLNO_TABLE_NAME}")
        row = cur.fetchone()
        last_billno = _to_int(row[0], 0) if row else 0
        new_billno = last_billno + 1
        # Insert new_billno with FLAG 'n'/'y' (CHAR(1)) and BILLDATE
        cur.execute(
            f"INSERT INTO {BILLNO_TABLE_NAME} (BILLNO, FLAG, BILLDATE) VALUES (:billno, :flag, SYSDATE)",
            {"billno": new_billno, "flag": flag_val}
        )
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


# --- Counter table (fetch only COUNTERCODE for Counter Open) ---
COUNTER_TABLE_NAME = 'COUNTER'


def _ensure_counter_table(cur):
    """Create COUNTER table if not exists. Only COUNTERCODE column."""
    create_sql = f"""
        CREATE TABLE {COUNTER_TABLE_NAME} (
            COUNTERCODE VARCHAR2(50)
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
    """Fetch only COUNTERCODE from COUNTER."""
    conn = _get_connection()
    if not conn:
        return jsonify({"ok": False, "counters": [], "error": "Database unavailable"}), 503
    cur = None
    try:
        cur = conn.cursor()
        _ensure_counter_table(cur)
        cur.execute(f"SELECT COUNTERCODE FROM {COUNTER_TABLE_NAME}")
        rows = cur.fetchall()
        result = [{"counterCode": (row[0] or "").strip()} for row in rows]
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


@app.route('/api/hold', methods=['POST'])
def hold_bill():
    """On hold: set FLAG=0 for current bill's cart rows (held). Draft cart uses FLAG=1; held uses FLAG=0."""
    data = request.get_json(silent=True) or {}
    bill_no = data.get('billNo')
    location_code = (data.get('locationCode') or '').strip() or 'LOC001'
    counter_code = (data.get('counterCode') or '').strip() or '20'
    customer_code = (data.get('customerCode') or '').strip() or None
    items = data.get('items') or []
    if bill_no is None:
        return jsonify({"error": "billNo is required"}), 400
    if not items:
        return jsonify({"error": "items (cart) is required"}), 400
    bill_no = _to_int(bill_no, 1)
    loc_num = _location_to_num(location_code, 1)
    conn = _get_connection()
    if conn:
        cur = None
        try:
            cur = conn.cursor()
            _ensure_tempbillhdr(cur)
            # Mark existing draft rows (FLAG=1 or NULL) as held (FLAG=0)
            cur.execute(f"""
                UPDATE {HOLD_TABLE_NAME} SET FLAG = 0
                WHERE BILLNO = :billno AND LOCATIONCODE = :loc AND (FLAG = 1 OR FLAG IS NULL)
            """, billno=bill_no, loc=loc_num)
            updated = cur.rowcount
            conn.commit()
            # If no draft rows existed, insert items with FLAG=0 (held)
            if updated == 0:
                params = []
                for i, it in enumerate(items):
                    qty = _to_int(it.get('quantity') or it.get('qty'), 1)
                    for _ in range(max(1, qty)):
                        params.append({
                            'billno': bill_no,
                            'loc': loc_num,
                            'flag': 0,
                        })
                cur.executemany(f"""
                    INSERT INTO {HOLD_TABLE_NAME} (BILLNO, LOCATIONCODE, FLAG)
                    VALUES (:billno, :loc, :flag)
                """, params)
                conn.commit()
            return jsonify({"ok": True, "billNo": bill_no, "locationCode": location_code, "savedToDb": True})
        except oracledb.Error as e:
            if conn:
                try:
                    conn.rollback()
                except Exception:
                    pass
            print(f"[Hold] {HOLD_TABLE_NAME} insert failed (will use in-memory): {e}")
            # fallback to in-memory
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
    key = (location_code, bill_no)
    _held_bills_fallback[key] = {
        "counterCode": counter_code,
        "heldDate": datetime.datetime.now().isoformat(),
        "customerCode": customer_code,
        "items": [
            {
                "id": it.get('id') or it.get('itemcode'),
                "name": it.get('name') or it.get('itemname'),
                "price": float(it.get('price', 0)),
                "quantity": int(it.get('quantity', it.get('qty', 1))),
            }
            for it in items
        ],
    }
    return jsonify({"ok": True, "billNo": bill_no, "locationCode": location_code, "savedToDb": False})


def _cart_sync_execute(cur, conn, bill_no, location_code, items):
    """Execute cart sync: delete current bill draft rows (FLAG=1 or NULL), then insert items with FLAG=1 (draft)."""
    loc_num = _location_to_num(location_code, 1)
    bill_no = _to_int(bill_no, 1)
    err_str = None
    try:
        cur.execute(f"""
            DELETE FROM {HOLD_TABLE_NAME}
            WHERE BILLNO = :billno AND LOCATIONCODE = :loc AND (FLAG = 1 OR FLAG IS NULL)
        """, billno=bill_no, loc=loc_num)
    except oracledb.Error as e:
        err_str = str(e).upper()
        if 'ORA-00904' not in err_str and '00904' not in err_str:
            raise
        conn.rollback()
        cur.execute(f"DELETE FROM {HOLD_TABLE_NAME} WHERE BILLNO = :billno AND LOCATIONCODE = :loc",
                    billno=bill_no, loc=loc_num)
    if items:
        params_with_flag = []
        for i, it in enumerate(items):
            qty = _to_int(it.get('quantity') or it.get('qty'), 1)
            for _ in range(max(1, qty)):
                params_with_flag.append({
                    'billno': bill_no,
                    'loc': loc_num,
                    'flag': 1,
                })
        try:
            cur.executemany(f"""
                INSERT INTO {HOLD_TABLE_NAME} (BILLNO, LOCATIONCODE, FLAG)
                VALUES (:billno, :loc, :flag)
            """, params_with_flag)
        except oracledb.Error as e:
            err_str = str(e).upper()
            if 'ORA-00904' not in err_str and '00913' not in err_str:
                raise
            conn.rollback()
            cur.execute(f"DELETE FROM {HOLD_TABLE_NAME} WHERE BILLNO = :billno AND LOCATIONCODE = :loc",
                        billno=bill_no, loc=loc_num)
            params_no_flag = [{'billno': p['billno'], 'loc': p['loc']} for p in params_with_flag]
            cur.executemany(f"""
                INSERT INTO {HOLD_TABLE_NAME} (BILLNO, LOCATIONCODE)
                VALUES (:billno, :loc)
            """, params_no_flag)


@app.route('/api/cart/sync', methods=['GET', 'POST'])
def cart_sync():
    """Sync current cart to hold table with FLAG=1 (draft). POST only; GET returns hint."""
    if request.method == 'GET':
        return jsonify({"ok": True, "message": "Use POST with body: billNo, locationCode, items"}), 200
    data = request.get_json(silent=True) or {}
    bill_no = data.get('billNo')
    location_code = (data.get('locationCode') or '').strip() or 'LOC001'
    items = data.get('items') or []
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
        _cart_sync_execute(cur, conn, bill_no, location_code, items)
        conn.commit()
        return jsonify({"ok": True})
    except oracledb.Error as e:
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        print(f"[Cart sync] {HOLD_TABLE_NAME} error: {e}")
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
    """List held bill numbers for the given location."""
    location_code = (request.args.get('locationCode') or '').strip() or 'LOC001'
    loc_num = _location_to_num(location_code, 1)
    conn = _get_connection()
    result = []
    if conn:
        cur = None
        try:
            cur = conn.cursor()
            _ensure_tempbillhdr(cur)
            cur.execute(f"""
                SELECT DISTINCT BILLNO, LOCATIONCODE
                FROM {HOLD_TABLE_NAME}
                WHERE LOCATIONCODE = :loc AND FLAG = 0
                ORDER BY BILLNO DESC
            """, loc=loc_num)
            rows = cur.fetchall()
            cols = [c[0] for c in cur.description]
            result = [dict(zip(cols, row)) for row in rows]
            db_bill_nos = {r["BILLNO"] for r in result}
            for (loc, bill_no), v in _held_bills_fallback.items():
                if loc == location_code and bill_no not in db_bill_nos:
                    result.append({
                        "BILLNO": bill_no,
                        "LOCATIONCODE": loc,
                        "HELDDATE": v.get("heldDate"),
                    })
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
        if loc == location_code:
            result.append({
                "BILLNO": bill_no,
                "LOCATIONCODE": loc,
                "HELDDATE": v.get("heldDate"),
            })
    result.sort(key=lambda x: -(x.get("BILLNO") or 0))
    return jsonify(result)


@app.route('/api/hold/<int:bill_no>', methods=['GET'])
def get_held_bill(bill_no):
    """Get held bill details (cart items) for retrieve."""
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
                WHERE BILLNO = :billno AND LOCATIONCODE = :loc
            """, billno=bill_no, loc=loc_num)
            rows = cur.fetchall()
            # No ITEMCODE in table: one row per unit. Return one placeholder item per row (id=0, qty=1).
            items = [
                {"id": 0, "name": "", "price": 0.0, "quantity": 1}
                for _ in rows
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
    # In-memory fallback
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
    """Remove held bill after retrieve (so it no longer appears in list)."""
    location_code = (request.args.get('locationCode') or '').strip() or 'LOC001'
    loc_num = _location_to_num(location_code, 1)
    conn = _get_connection()
    if conn:
        cur = None
        try:
            cur = conn.cursor()
            cur.execute(f"DELETE FROM {HOLD_TABLE_NAME} WHERE BILLNO = :billno AND LOCATIONCODE = :loc",
                        billno=bill_no, loc=loc_num)
            conn.commit()
            return jsonify({"ok": True})
        except oracledb.Error as e:
            if conn:
                try:
                    conn.rollback()
                except Exception:
                    pass
            print(f"{HOLD_TABLE_NAME} delete error: {e}")
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
    # In-memory fallback
    key = (location_code, bill_no)
    if key in _held_bills_fallback:
        del _held_bills_fallback[key]
    return jsonify({"ok": True})


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
