from flask import Flask, jsonify, request
from flask_cors import CORS
import oracledb
import bcrypt
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


def _hash(pw):
    return bcrypt.hashpw(pw.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


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


def _get_base_location():
    """Fetch LOCATIONCODE, LOCATIONNAME from LOCATIONMASTER where BASELOCATIONFLAG = 'Y'."""
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
            SELECT LOCATIONCODE, LOCATIONNAME
            FROM LOCATIONMASTER
            WHERE UPPER(TRIM(NVL(BASELOCATIONFLAG, 'N'))) = 'Y'
        """
        cursor.execute(query)
        row = cursor.fetchone()
        if not row:
            return None
        columns = [col[0] for col in cursor.description]
        rec = dict(zip(columns, row))
        loc_code = rec.get('LOCATIONCODE') or rec.get('locationcode')
        loc_name = rec.get('LOCATIONNAME') or rec.get('locationname')
        if loc_code is None and loc_name is None:
            return None
        return {
            'locationCode': str(loc_code).strip() if loc_code is not None else '',
            'locationName': str(loc_name).strip() if loc_name is not None else ''
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
    # Fetch base location from LOCATIONMASTER (BASELOCATIONFLAG = 'Y')
    location = _get_base_location()
    return jsonify({
        "token": token,
        "user": {
            "username": user['username'],
            "role": user['role'],
            "userid": user.get('userid') or user['username']
        },
        "location": location
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




# Format for Oracle TO_CHAR on numbers to avoid scientific notation (e.g. long barcodes)
_ORACLE_NUM_FMT = "FM99999999999999999999999999999999999999"


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
                SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid
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
                    SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid
                    FROM itemmaster
                    WHERE ((manufacturerid IS NOT NULL AND TRIM(TO_CHAR(manufacturerid, '{_ORACLE_NUM_FMT}')) = TRIM(:code))
                       OR (itemcode IS NOT NULL AND UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code)))
                    AND ROWNUM = 1
                """, code=code)
                row = cursor.fetchone()
            except oracledb.Error:
                try:
                    cursor.execute(f"""
                        SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid
                        FROM itemmaster
                        WHERE (TRIM(TO_CHAR(NVL(manufacturerid, 0), '{_ORACLE_NUM_FMT}')) = TRIM(:code)
                           OR UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code))
                        AND ROWNUM = 1
                    """, code=code)
                    row = cursor.fetchone()
                except oracledb.Error:
                    try:
                        cursor.execute("""
                            SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid
                            FROM itemmaster
                            WHERE (TRIM(manufacturerid) = TRIM(:code) OR TRIM(itemcode) = TRIM(:code))
                            AND ROWNUM = 1
                        """, code=code)
                        row = cursor.fetchone()
                    except oracledb.Error:
                        try:
                            cursor.execute("""
                                SELECT locationcode, itemcode, itemname, categorycode, retailprice
                                FROM itemmaster
                                WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1
                            """, code=code)
                            row = cursor.fetchone()
                        except oracledb.Error:
                            pass
        # 2) ITEMALTERNATEUOMMAP: MANUFACTURERID found here -> use this table's RETAILPRICE; name/category from itemmaster
        alt_retailprice = None
        if not row:
            itemcode_from_alt, locationcode_from_alt, alt_retailprice = _resolve_itemcode_location_from_alternate(cursor, code)
            if itemcode_from_alt:
                try:
                    if locationcode_from_alt:
                        cursor.execute("""
                            SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid
                            FROM itemmaster
                            WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:ic) AND (UPPER(TRIM(TO_CHAR(locationcode))) = UPPER(:lc) OR TRIM(locationcode) = TRIM(:lc))
                            AND ROWNUM = 1
                        """, ic=itemcode_from_alt, lc=locationcode_from_alt)
                    else:
                        cursor.execute("""
                            SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid
                            FROM itemmaster
                            WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1
                        """, code=itemcode_from_alt)
                    row = cursor.fetchone()
                except oracledb.Error:
                    try:
                        if locationcode_from_alt:
                            cursor.execute(f"""
                                SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid AS manufactureid
                                FROM itemmaster
                                WHERE TRIM(TO_CHAR(itemcode)) = TRIM(:ic) AND TRIM(TO_CHAR(NVL(locationcode, 0), '{_ORACLE_NUM_FMT}')) = TRIM(:lc) AND ROWNUM = 1
                            """, ic=itemcode_from_alt, lc=locationcode_from_alt)
                        else:
                            cursor.execute("""
                                SELECT locationcode, itemcode, itemname, categorycode, retailprice
                                FROM itemmaster
                                WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1
                            """, code=itemcode_from_alt)
                        row = cursor.fetchone()
                    except oracledb.Error:
                        pass
        if not row:
            return jsonify({"found": False, "code": code, "error": "Product not found"}), 200
        columns = [col[0] for col in cursor.description]
        result = dict(zip(columns, row))
        if itemcode_from_alt and alt_retailprice is not None:
            result['RETAILPRICE'] = alt_retailprice
            result['retailprice'] = alt_retailprice
        if result.get('manufactureid') is None and result.get('MANUFACTUREID') is None:
            result['manufactureid'] = str(result.get('ITEMCODE') or result.get('itemcode') or '')
        if itemcode_from_alt and code:
            result['manufactureid'] = str(code).strip()
            result['MANUFACTURERID'] = str(code).strip()
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
        # 1) All from ITEMMASTER (same columns)
        query = """
            SELECT
                p.locationcode,
                p.itemcode,
                p.itemname,
                p.categorycode,
                p.retailprice,
                p.manufacturerid
            FROM itemmaster p
        """
        cursor.execute(query)
        columns = [col[0] for col in cursor.description]
        rows = cursor.fetchall()
        results = []
        seen_itemcodes = set()
        for row in rows:
            rec = dict(zip(columns, row))
            ic = str(rec.get('ITEMCODE') or rec.get('itemcode') or '').strip()
            if ic:
                seen_itemcodes.add(ic.upper())
            results.append(rec)
        # 2) ITEMALTERNATEUOMMAP: fetch alternate rows then get RETAILPRICE (and name, etc.) from itemmaster in Python
        qualified_alt, itemcode_col_alt, alternate_cols_alt = _get_alternate_uom_table_info(cursor)
        alt_table = qualified_alt if qualified_alt else "ITEMALTERNATEUOMMAP"
        try:
            cursor.execute(f"""
                SELECT {itemcode_col_alt} AS itemcode, LOCATIONCODE AS locationcode, MANUFACTURERID AS manufacturerid, RETAILPRICE AS retailprice
                FROM {alt_table}
                WHERE {itemcode_col_alt} IS NOT NULL
            """)
            alt_rows = cursor.fetchall()
        except oracledb.Error:
            try:
                cursor.execute("""
                    SELECT ITEMCODE AS itemcode, LOCATIONCODE AS locationcode, MANUFACTURERID AS manufacturerid, RETAILPRICE AS retailprice
                    FROM ITEMALTERNATEUOMMAP
                    WHERE ITEMCODE IS NOT NULL
                """)
                alt_rows = cursor.fetchall()
            except oracledb.Error:
                try:
                    cursor.execute("""
                        SELECT ITEMCODE AS itemcode, LOCATIONCODE AS locationcode, MANUFACTURERID AS manufacturerid
                        FROM ITEMALTERNATEUOMMAP
                        WHERE ITEMCODE IS NOT NULL
                    """)
                    alt_rows = [(r[0], r[1] if len(r) > 1 else None, r[2] if len(r) > 2 else r[1] if len(r) == 2 else None, None) for r in cursor.fetchall()]
                except oracledb.Error:
                    try:
                        cursor.execute("""
                            SELECT ITEMCODE AS itemcode, MANUFACTURERID AS manufacturerid
                            FROM ITEMALTERNATEUOMMAP
                            WHERE ITEMCODE IS NOT NULL
                        """)
                        alt_rows = [(r[0], None, r[1], None) for r in cursor.fetchall()] if cursor.description and len(cursor.description) >= 2 else []
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
                        SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid
                        FROM itemmaster
                        WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:ic)
                    """, ic=ic)
                    im_cols = [c[0] for c in cursor.description]
                    for im_row in cursor.fetchall():
                        im_rec = dict(zip(im_cols, im_row))
                        ic_val = str(im_rec.get('ITEMCODE') or im_rec.get('itemcode') or '').strip()
                        lc_val = im_rec.get('LOCATIONCODE') or im_rec.get('locationcode')
                        if ic_val:
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
                if not ic:
                    continue
                if ic.upper() in added_from_alt:
                    continue
                im_rec = None
                if lc_alt is not None and str(lc_alt).strip():
                    im_rec = itemmaster_by_ic_lc.get((ic.upper(), str(lc_alt).strip().upper()))
                if im_rec is None:
                    im_rec = itemmaster_by_ic.get(ic.upper())
                if im_rec is None:
                    continue
                rec = {
                    'LOCATIONCODE': im_rec.get('LOCATIONCODE') or im_rec.get('locationcode'),
                    'ITEMCODE': im_rec.get('ITEMCODE') or im_rec.get('itemcode'),
                    'ITEMNAME': im_rec.get('ITEMNAME') or im_rec.get('itemname'),
                    'CATEGORYCODE': im_rec.get('CATEGORYCODE') or im_rec.get('categorycode'),
                    'RETAILPRICE': alt_retailprice if alt_retailprice is not None else (im_rec.get('RETAILPRICE') or im_rec.get('retailprice')),
                    'MANUFACTURERID': alt_manufacturerid or im_rec.get('MANUFACTURERID') or im_rec.get('manufacturerid'),
                }
                if rec.get('ITEMCODE') or rec.get('itemcode'):
                    seen_itemcodes.add(ic.upper())
                    added_from_alt.add(ic.upper())
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
                cursor.execute("""
                    SELECT locationcode, itemcode, itemname, categorycode, retailprice, manufacturerid
                    FROM itemmaster
                    WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1
                """, code=ic)
                row = cursor.fetchone()
                if row:
                    results.append(dict(zip(columns, row)))
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
# BILLNOTABLE columns: BILLNO NUMBER, FLAG CHAR(1) DEFAULT 'n' (n/y), BILLDATE (required), COUNTERCODE (optional).
# BILLDTL (paid bill detail): LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE. Insert on Pay.
# HOLD table (TEMPBILLHDR): BILLNO, LOCATIONCODE, FLAG. At HOLD time FLAG=0 (held); draft FLAG=1.
# HOLD detail (TEMPBILLDTL): BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID, FLAG. At hold FLAG=0.
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


def _ensure_tempbilldtl(cur):
    """Create TEMPBILLDTL if it does not exist. BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID, FLAG (default 1; when hold set 0)."""
    create_sql = f"""
        CREATE TABLE {HOLD_DTL_TABLE_NAME} (
            BILLNO NUMBER NOT NULL,
            SLNO NUMBER NOT NULL,
            ITEMCODE VARCHAR2(50),
            QUANTITY NUMBER DEFAULT 1,
            RATE NUMBER DEFAULT 0,
            MANUFACTURERID VARCHAR2(50),
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
            print(f"[Hold] {HOLD_DTL_TABLE_NAME} create failed: {e}")
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


def _resolve_itemcode_location_from_alternate(cur, code):
    """
    Resolve barcode/code to (ITEMCODE, LOCATIONCODE, RETAILPRICE) from ITEMALTERNATEUOMMAP.
    Returns (itemcode_str, locationcode_or_none, retailprice_or_none). Price from table that has MANUFACTURERID.
    """
    if not code or not str(code).strip():
        return None, None, None
    code_str = str(code).strip()
    # 1) ITEMALTERNATEUOMMAP: get ITEMCODE, LOCATIONCODE, RETAILPRICE (use this table's price when MANUFACTURERID matches)
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
            loc = str(row[1]).strip() if len(row) > 1 and row[1] is not None else None
            price = row[2] if len(row) > 2 and row[2] is not None else None
            return str(row[0]).strip(), (loc if loc else None), price
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
                loc = str(row[1]).strip() if len(row) > 1 and row[1] is not None else None
                return str(row[0]).strip(), (loc if loc else None), None
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
                    return str(row[0]).strip(), None, None
            except oracledb.Error as e:
                print(f"[ITEMALTERNATEUOMMAP] lookup fallback error: {e}")
    # 2) Discovered table/columns
    qualified, itemcode_col, alternate_cols = _get_alternate_uom_table_info(cur)
    if qualified and itemcode_col and alternate_cols:
        for col in alternate_cols:
            try:
                cur.execute(f"""
                    SELECT {itemcode_col}, LOCATIONCODE, RETAILPRICE FROM {qualified}
                    WHERE {col} IS NOT NULL AND TRIM(TO_CHAR(NVL({col}, 0), '{_ORACLE_NUM_FMT}')) = TRIM(:code)
                    AND ROWNUM = 1
                """, code=code_str)
                row = cur.fetchone()
                if row and row[0]:
                    loc = str(row[1]).strip() if len(row) > 1 and row[1] is not None else None
                    price = row[2] if len(row) > 2 and row[2] is not None else None
                    return str(row[0]).strip(), (loc if loc else None), price
            except oracledb.Error:
                try:
                    cur.execute(f"""
                        SELECT {itemcode_col}, LOCATIONCODE FROM {qualified}
                        WHERE TRIM({col}) = TRIM(:code) AND ROWNUM = 1
                    """, code=code_str)
                    row = cur.fetchone()
                    if row and row[0]:
                        loc = str(row[1]).strip() if len(row) > 1 and row[1] is not None else None
                        return str(row[0]).strip(), (loc if loc else None), None
                except oracledb.Error:
                    try:
                        cur.execute(f"""
                            SELECT {itemcode_col} FROM {qualified}
                            WHERE TRIM({col}) = TRIM(:code) AND ROWNUM = 1
                        """, code=code_str)
                        row = cur.fetchone()
                        if row and row[0]:
                            return str(row[0]).strip(), None, None
                    except oracledb.Error:
                        pass
    return None, None, None


def _resolve_itemcode_from_alternate(cur, code):
    """Resolve barcode/code to ITEMCODE from ITEMALTERNATEUOMMAP. Returns itemcode or None."""
    ic, _, _ = _resolve_itemcode_location_from_alternate(cur, code)
    return ic


def _get_item_names_from_master(cur, itemcodes):
    """Look up ITEMNAME from itemmaster by ITEMCODE; also resolve via ITEMALTERNATEUOMMAP. Returns dict itemcode_str -> itemname."""
    codes = [str(c).strip() for c in (itemcodes or []) if c is not None and str(c).strip()]
    if not codes:
        return {}
    names = {}
    for code in set(codes):
        try:
            cur.execute("""
                SELECT itemname FROM itemmaster
                WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1
            """, code=code)
            row = cur.fetchone()
            if row and row[0]:
                names[code] = str(row[0]).strip()
        except oracledb.Error:
            try:
                cur.execute("SELECT itemname FROM itemmaster WHERE TRIM(itemcode) = :code AND ROWNUM = 1", code=code)
                row = cur.fetchone()
                if row and row[0]:
                    names[code] = str(row[0]).strip()
            except oracledb.Error:
                pass
        if code not in names:
            itemcode = _resolve_itemcode_from_alternate(cur, code)
            if itemcode:
                try:
                    cur.execute("SELECT itemname FROM itemmaster WHERE UPPER(TRIM(TO_CHAR(itemcode))) = UPPER(:code) AND ROWNUM = 1", code=itemcode)
                    row = cur.fetchone()
                    if row and row[0]:
                        names[code] = str(row[0]).strip()
                except oracledb.Error:
                    pass
    return names


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
    """Create BILLNOTABLE if not exists. Columns: BILLNO NUMBER, FLAG CHAR(1) DEFAULT 'n', BILLDATE DATE, COUNTERCODE VARCHAR2(50)."""
    create_sql = f"""
        CREATE TABLE {BILLNO_TABLE_NAME} (
            BILLNO NUMBER NOT NULL,
            FLAG CHAR(1) DEFAULT 'n',
            BILLDATE DATE DEFAULT SYSDATE NOT NULL,
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
    """Create BILLDTL if not exists. Columns: LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE."""
    create_sql = f"""
        CREATE TABLE {BILLDTL_TABLE_NAME} (
            LOCATIONCODE VARCHAR2(50),
            BILLNO NUMBER NOT NULL,
            SLNO NUMBER NOT NULL,
            ITEMCODE VARCHAR2(50),
            QUANTITY NUMBER,
            RATE NUMBER
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


def _billno_flag_char(value):
    """Normalize FLAG for BILLNOTABLE to 'n' or 'y' (CHAR(1)). Default 'n'."""
    if value is None:
        return 'N'
    s = str(value).strip().lower()
    return 'Y' if s == 'Y' else 'N'


@app.route('/api/billno/next', methods=['GET', 'POST'])
def create_next_billno():
    """
    Create next bill no: fetch MAX(BILLNO), new_billno = last + 1.
    Insert new_billno into BILLNOTABLE (FLAG='N', BILLDATE=SYSDATE, COUNTERCODE from request).
    """
    data = request.get_json(silent=True) or {}
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
        cur.execute(f"SELECT NVL(MAX(BILLNO), 0) AS LAST_BILLNO FROM {BILLNO_TABLE_NAME}")
        row = cur.fetchone()
        last_billno = _to_int(row[0], 0) if row else 0   # lastBillNo = max(BILLNO) in DB
        maxoff = last_billno + 1                         # maxoff = lastBillNo + 1 (next number)
        new_billno = maxoff
        # Insert new_billno into BILLNOTABLE with FLAG='N', BILLDATE=SYSDATE, COUNTERCODE (if column exists)
        try:
            cur.execute(
                f"INSERT INTO {BILLNO_TABLE_NAME} (BILLNO, FLAG, BILLDATE, COUNTERCODE) VALUES (:billno, 'N', SYSDATE, :countercode)",
                {"billno": new_billno, "countercode": counter_code}
            )
        except oracledb.Error as col_err:
            err_str = str(col_err).upper()
            if 'ORA-00913' in err_str or 'ORA-00904' in err_str or '00913' in err_str or '00904' in err_str:
                cur.execute(
                    f"INSERT INTO {BILLNO_TABLE_NAME} (BILLNO, FLAG, BILLDATE) VALUES (:billno, 'N', SYSDATE)",
                    {"billno": new_billno}
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


@app.route('/api/billdtl/insert', methods=['POST'])
def billdtl_insert():
    """On Pay: insert into BILLDTL one row per cart line – LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO."""
    data = request.get_json(silent=True) or {}
    _loc = data.get('locationCode') or data.get('location_code')
    location_code = str(_loc).strip() if _loc is not None else ''
    location_code = location_code or None
    bill_no = data.get('billNo') or data.get('billno')
    items = data.get('items') or data.get('lines') or []
    if bill_no is None:
        return jsonify({"ok": False, "error": "billNo required"}), 400
    try:
        bill_no = int(bill_no)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "billNo must be a number"}), 400
    if not isinstance(items, list):
        return jsonify({"ok": False, "error": "items must be an array"}), 400
    conn = _get_connection()
    if not conn:
        return jsonify({"ok": False, "error": "Database unavailable"}), 503
    cur = None
    inserted = 0
    try:
        cur = conn.cursor()
        _ensure_billdtl(cur)
        for slno, it in enumerate(items, start=1):
            if not it or not isinstance(it, dict):
                continue
            _ic = it.get('itemCode') or it.get('ITEMCODE') or it.get('itemcode') or it.get('id')
            item_code = str(_ic).strip() if _ic is not None else ''
            if not item_code:
                continue
            qty = it.get('quantity') or it.get('QUANTITY') or 0
            rate = it.get('rate') or it.get('RATE') or it.get('price') or 0
            try:
                qty = float(qty) if qty is not None else 0
            except (TypeError, ValueError):
                qty = 0
            try:
                rate = float(rate) if rate is not None else 0
            except (TypeError, ValueError):
                rate = 0
            cur.execute(
                f"""
                INSERT INTO {BILLDTL_TABLE_NAME} (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, RESETNO)
                VALUES (:loc, :billno, :slno, :itemcode, :qty, :rate, 1)
                """,
                {"loc": location_code, "billno": bill_no, "slno": slno, "itemcode": item_code, "qty": qty, "rate": rate}
            )
            inserted += 1
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
    """Insert into COUNTER: systemName, systemIp, counterCode, counterName (from Counter Setup Save)."""
    data = request.get_json(silent=True) or {}
    system_ip = (data.get('systemIp') or data.get('systemIP') or '').strip()
    system_name = (data.get('systemName') or '').strip()
    counter_code = (data.get('counterCode') or '').strip() or '1'
    counter_name = (data.get('counterName') or '').strip() or 'Counter 1'
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
            {"sysip": system_ip or None, "sysname": system_name or None, "cntcode": counter_code, "cntname": counter_name, "loccode": "1"}
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


def _username_from_request():
    """Get username from Authorization Bearer token (JWT sub)."""
    auth = request.headers.get('Authorization') or ''
    payload = _decode_token(auth)
    if not payload:
        return None
    return (payload.get('sub') or payload.get('username') or '').strip() or None


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
            (DATEOFOPEN, OPENEDDATE, OPENFLAG, OPENEDBY, COUNTERCODE, LOCATIONCODE, CASHIERCODE)
            VALUES (TO_DATE(:d, 'YYYY-MM-DD'), TO_DATE(:oday, 'YYYY-MM-DD'), 'O', :openedby, :cntcode, :loccode, 0)
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


@app.route('/api/hold', methods=['POST'])
def hold_bill():
    """On hold: set FLAG=0 for current bill's cart rows (held). Draft cart uses FLAG=1; held uses FLAG=0."""
    try:
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
                _ensure_tempbilldtl(cur)
                # At HOLD time: set FLAG = 0 (held) for this bill in TEMPBILLHDR
                cur.execute(f"""
                    UPDATE {HOLD_TABLE_NAME} SET FLAG = :flag
                    WHERE BILLNO = :billno AND LOCATIONCODE = :loc AND (FLAG = {FLAG_DRAFT} OR FLAG IS NULL)
                """, billno=bill_no, loc=loc_num, flag=FLAG_HELD)
                updated = cur.rowcount
                if updated == 0:
                    params = []
                    for i, it in enumerate(items):
                        qty = _to_int(it.get('quantity') or it.get('qty'), 1)
                        for _ in range(max(1, qty)):
                            params.append({
                                'billno': bill_no,
                                'loc': loc_num,
                                'flag': FLAG_HELD,
                            })
                    cur.executemany(f"""
                        INSERT INTO {HOLD_TABLE_NAME} (BILLNO, LOCATIONCODE, FLAG)
                        VALUES (:billno, :loc, :flag)
                    """, params)
                # At hold: insert product data into TEMPBILLDTL (no FLAG=0; use table default)
                cur.execute(f"DELETE FROM {HOLD_DTL_TABLE_NAME} WHERE BILLNO = :billno", billno=bill_no)
                dtl_params = []
                for slno, it in enumerate(items, start=1):
                    if not isinstance(it, dict):
                        continue
                    itemcode = str(it.get('id') or it.get('itemcode') or it.get('ITEMCODE') or '').strip()
                    qty = _to_int(it.get('quantity') or it.get('qty') or it.get('QUANTITY'), 1)
                    rate = _to_float(it.get('price') or it.get('PRICE') or it.get('rate'), 0.0)
                    manufacturer_id = str(it.get('manufactureId') or it.get('MANUFACTURERID') or it.get('manufacturerId') or '').strip()
                    dtl_params.append({
                        'billno': bill_no,
                        'slno': slno,
                        'itemcode': itemcode or None,
                        'quantity': qty,
                        'rate': rate,
                        'manufacturerid': manufacturer_id or None,
                    })
                if dtl_params:
                    cur.executemany(f"""
                        INSERT INTO {HOLD_DTL_TABLE_NAME} (BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID)
                        VALUES (:billno, :slno, :itemcode, :quantity, :rate, :manufacturerid)
                    """, dtl_params)
                # On suspend/hold: insert into TBLCANCELEDHDR (LOCATIONCODE, BILLNO, BILLDATE, BILLTIME, COUNTERCODE, DISCOUNTAMOUNT, NETBILLAMOUNT)
                net_bill_amount = sum(p['quantity'] * p['rate'] for p in dtl_params)
                discount_amount = _to_float(data.get('discountAmount') or data.get('discount_amount') or data.get('DISCOUNTAMOUNT'), 0.0)
                billdate_str = datetime.datetime.now().strftime('%Y-%m-%d')
                billtime_str = datetime.datetime.now().strftime('%H:%M:%S')
                try:
                    cur.execute("""
                        INSERT INTO TBLCANCELEDHDR (LOCATIONCODE, BILLNO, BILLDATE, BILLTIME, COUNTERCODE, DISCOUNTAMOUNT, NETBILLAMOUNT)
                        VALUES (:loc, :billno, TO_DATE(:billdate, 'YYYY-MM-DD'), :billtime, :countercode, :discount, :netamount)
                    """, {
                        'loc': location_code,
                        'billno': bill_no,
                        'billdate': billdate_str,
                        'billtime': billtime_str,
                        'countercode': counter_code or None,
                        'discount': discount_amount,
                        'netamount': net_bill_amount,
                    })
                except oracledb.Error as e:
                    print(f"[Hold] TBLCANCELEDHDR insert failed: {e}")
                # On suspend/hold: insert into TBLCANCELEDDTL (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID)
                canceled_params = [
                    {
                        'loc': location_code,
                        'billno': p['billno'],
                        'slno': p['slno'],
                        'itemcode': p['itemcode'],
                        'quantity': p['quantity'],
                        'rate': p['rate'],
                        'manufacturerid': p['manufacturerid'],
                    }
                    for p in dtl_params
                ]
                if canceled_params:
                    try:
                        cur.executemany("""
                            INSERT INTO TBLCANCELEDDTL (LOCATIONCODE, BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID)
                            VALUES (:loc, :billno, :slno, :itemcode, :quantity, :rate, :manufacturerid)
                        """, canceled_params)
                    except oracledb.Error as e:
                        print(f"[Hold] TBLCANCELEDDTL insert failed: {e}")
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


def _cart_sync_execute(cur, conn, bill_no, location_code, items):
    """Execute cart sync: TEMPBILLHDR and TEMPBILLDTL with FLAG=1 (draft) when items added to cart."""
    loc_num = _location_to_num(location_code, 1)
    bill_no = _to_int(bill_no, 1)
    err_str = None
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
        params_with_flag = []
        for i, it in enumerate(items):
            qty = _to_int(it.get('quantity') or it.get('qty'), 1)
            for _ in range(max(1, qty)):
                params_with_flag.append({
                    'billno': bill_no,
                    'loc': loc_num,
                    'flag': FLAG_DRAFT,
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
    # TEMPBILLDTL: insert product data with FLAG=1 (draft) when cart items added – same as TEMPBILLHDR
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
        dtl_params.append({
            'billno': bill_no,
            'slno': slno,
            'itemcode': itemcode or None,
            'quantity': qty,
            'rate': rate,
            'manufacturerid': manufacturer_id or None,
            'flag': FLAG_DRAFT,
        })
    if dtl_params:
        try:
            cur.executemany(f"""
                INSERT INTO {HOLD_DTL_TABLE_NAME} (BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID, FLAG)
                VALUES (:billno, :slno, :itemcode, :quantity, :rate, :manufacturerid, :flag)
            """, dtl_params)
        except oracledb.Error as e:
            if 'ORA-00904' not in str(e).upper() and '00904' not in str(e).upper():
                raise
            dtl_no_flag = [{k: v for k, v in p.items() if k != 'flag'} for p in dtl_params]
            cur.executemany(f"""
                INSERT INTO {HOLD_DTL_TABLE_NAME} (BILLNO, SLNO, ITEMCODE, QUANTITY, RATE, MANUFACTURERID)
                VALUES (:billno, :slno, :itemcode, :quantity, :rate, :manufacturerid)
            """, dtl_no_flag)


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
        _ensure_tempbilldtl(cur)
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
    app.run(debug=True, host='0.0.0.0', port=5000)
