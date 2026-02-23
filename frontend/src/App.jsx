import { useState, useEffect, useCallback } from 'react'
import Sidebar from './components/Sidebar'
import CustomerList from './components/CustomerList'
import UserManagement from './components/UserManagement'
import CounterSetup from './components/CounterSetup'
import CounterOpen from './components/CounterOpen'
import Dashboard from './components/Dashboard'
import Payment from './components/Payment'
import Login from './components/Login'
import HoldRetrieveModal from './components/HoldRetrieveModal'
import './App.css'

const API_BASE = `http://${typeof window !== 'undefined' ? window.location.hostname : ''}:5000`

// Read systemName and ip from URL (set by POS Launcher exe) and store in sessionStorage
if (typeof window !== 'undefined') {
  const params = new URLSearchParams(window.location.search)
  const systemName = params.get('systemName') || params.get('systemname')
  const ip = params.get('ip')
  if (systemName != null || ip != null) {
    if (systemName != null) sessionStorage.setItem('pos_system_name', systemName)
    if (ip != null) sessionStorage.setItem('pos_system_ip', ip)
    const cleanUrl = window.location.origin + window.location.pathname + (window.location.hash || '')
    window.history.replaceState({}, document.title, cleanUrl)
  }
}

function App() {
  const [user, setUser] = useState(() => {
    try {
      const t = localStorage.getItem('pos_token')
      const u = localStorage.getItem('pos_user')
      if (t && u) return JSON.parse(u)
    } catch (_) {}
    return null
  })
  const [token, setToken] = useState(() => localStorage.getItem('pos_token') || null)
  const [authLoading, setAuthLoading] = useState(!!localStorage.getItem('pos_token'))
  const [loginError, setLoginError] = useState(null)
  const [activeView, setActiveView] = useState('dashboard')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [cart, setCart] = useState([])
  const [showHoldRetrieveModal, setShowHoldRetrieveModal] = useState(false)
  const [locationCode, setLocationCode] = useState(() => localStorage.getItem('pos_location') || 'LOC001')
  const [locationName, setLocationName] = useState(() => localStorage.getItem('pos_location_name') || '')
  const [counterCode, setCounterCode] = useState(() => localStorage.getItem('pos_counter_code') || 'CNT01')
  const [counterName, setCounterName] = useState(() => localStorage.getItem('pos_counter_name') || 'Counter 1')
  const [billNo, setBillNo] = useState(() => parseInt(localStorage.getItem('pos_bill_no') || '1', 10))
  const [products, setProducts] = useState([])
  const [customers, setCustomers] = useState([])
  const [selectedCustomer, setSelectedCustomer] = useState(null)
  const [showPaymentPage, setShowPaymentPage] = useState(false)
  const [selectedCartItemId, setSelectedCartItemId] = useState(null)

  // Restore user from token on load (refresh: keep logged in; only relogin on 401)
  useEffect(() => {
    if (!token) {
      setAuthLoading(false)
      return
    }
    fetch(`${API_BASE}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (res.ok) return res.json()
        if (res.status === 401) {
          localStorage.removeItem('pos_token')
          localStorage.removeItem('pos_user')
          setToken(null)
          setUser(null)
        }
        return Promise.reject(res)
      })
      .then((data) => {
        if (data?.user) {
          setUser(data.user)
          localStorage.setItem('pos_user', JSON.stringify(data.user))
        }
      })
      .catch(() => {})
      .finally(() => setAuthLoading(false))
  }, [token])

  // Role-based view access: IT=all, Supervisor=Billing+CounterOpen, Cashier=Billing only
  const getAllowedViews = (r) => {
    const role = (r || '').toLowerCase()
    if (role === 'it' || role === 'manager' || role === 'admin') return ['dashboard', 'customers', 'counter-setup', 'counter-open', 'users', 'settings']
    if (role === 'supervisor') return ['dashboard', 'counter-open']
    return ['dashboard']
  }
  useEffect(() => {
    if (!user) return
    const allowed = getAllowedViews(user.role)
    if (!allowed.includes(activeView)) setActiveView('dashboard')
  }, [user?.role, activeView])

  const handleLogin = async ({ username, password }) => {
    setLoginError(null)
    setAuthLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Login failed')
      localStorage.setItem('pos_token', data.token)
      setToken(data.token)
      setUser(data.user)
      localStorage.setItem('pos_user', JSON.stringify(data.user))
      // Set location from LOCATIONMASTER (BASELOCATIONFLAG = Y) returned at login
      if (data.location) {
        const code = data.location.locationCode ?? data.location.location_code ?? ''
        const name = data.location.locationName ?? data.location.location_name ?? ''
        setLocationCode(code || locationCode)
        setLocationName(name)
        if (code) localStorage.setItem('pos_location', code)
        if (name) localStorage.setItem('pos_location_name', name)
      }
      // Create and insert new_billno only on actual login (not on refresh)
      await fetchAndSetNextBillNo()
      // New bill on login: clear cart so it matches the new billNo (cart is per bill)
      setCart([])
    } catch (err) {
      setLoginError(err.message || 'Invalid username or password')
    } finally {
      setAuthLoading(false)
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('pos_token')
    localStorage.removeItem('pos_user')
    setToken(null)
    setUser(null)
    setCart([])
  }

  const fetchAndSetNextBillNo = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/billno/next`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flag: 0, counterCode: counterCode || '' }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.billNo != null) {
        const next = Number(data.billNo)
        setBillNo(next)
        localStorage.setItem('pos_bill_no', String(next))
      } else {
        setBillNo((prev) => {
          const next = prev + 1
          localStorage.setItem('pos_bill_no', String(next))
          return next
        })
      }
    } catch {
      setBillNo((prev) => {
        const next = prev + 1
        localStorage.setItem('pos_bill_no', String(next))
        return next
      })
    }
  }

  const handleHold = async () => {
    if (cart.length === 0) return
    try {
      const res = await fetch(`${API_BASE}/api/hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          billNo,
          locationCode,
          counterCode,
          customerCode: selectedCustomer?.CUSTOMERCODE || selectedCustomer?.customercode || null,
          items: cart,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Hold failed')
      setCart([])
      await fetchAndSetNextBillNo()
    } catch (err) {
      alert(err.message || 'Failed to hold bill')
    }
  }

  const handleHoldRetrieve = () => {
    setShowHoldRetrieveModal(true)
  }

  const handleHoldRetrieveSelect = (retrievedBillNo, items) => {
    setCart(items)
    setBillNo(retrievedBillNo)
    localStorage.setItem('pos_bill_no', String(retrievedBillNo))
    setShowHoldRetrieveModal(false)
  }

  const handleVoidLine = () => {
    if (!selectedCartItemId) return
    setCart(prev => {
      const next = prev.map(item =>
        sameId(getItemId(item), selectedCartItemId) ? { ...item, void: true } : item
      )
      syncCartToDb(next)
      return next
    })
    setSelectedCartItemId(null)
  }

  const handleSuspendBill = () => {
    handleHold()
  }

  useEffect(() => {
    const handleKeyDown = (e) => {
      const blockedKeys = [
        "F1",  // Browser help
        "F3",  // Find
        "F5",  // Refresh
        "F11", // Fullscreen toggle
        "Escape"
      ];

      if (
        blockedKeys.includes(e.key) ||
        (e.ctrlKey && ["r", "w", "p"].includes(e.key.toLowerCase()))
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!user) return
    fetch(`${API_BASE}/api/products`)
      .then(response => response.json())
      .then(data => {
        // Map backend fields to frontend expected fields
        const mappedProducts = data.map(p => ({
          id: p.ITEMCODE,
          name: p.ITEMNAME,
          price: parseFloat(p.RETAILPRICE) || 0,
          category: p.CATEGORYCODE,
          image: '📦',
          manufactureId: p.MANUFACTUREID ?? p.manufactureid ?? '',
          alternateCodes: Array.isArray(p.ALTERNATECODES) ? p.ALTERNATECODES : [],
          uom: (p.BASEUOM ?? p.baseuom ?? '').toString().trim() || undefined,
        }))
        setProducts(mappedProducts)
      })
      .catch(error => console.error('Error fetching products:', error))
  }, [user])

  useEffect(() => {
    if (!user) return
    fetch(`${API_BASE}/api/customers`)
      .then(res => res.json())
      .then(data => setCustomers(Array.isArray(data) ? data : []))
      .catch(() => setCustomers([]))
  }, [user])

  // On load / reopen: restore cart from DB (TEMPBILLDTL) by current billNo; when billNo changes, cart must match that bill
  useEffect(() => {
    if (!user || billNo == null) return
    const params = new URLSearchParams({ billNo: String(billNo), locationCode: locationCode || '' })
    fetch(`${API_BASE}/api/cart/by-bill?${params}`)
      .then(res => res.json())
      .then(data => {
        const list = data?.items
        setCart(Array.isArray(list) ? list : [])
      })
      .catch(() => setCart([]))
  }, [user, billNo])

  const syncCartToDb = (cartItems) => {
    fetch(`${API_BASE}/api/cart/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        billNo,
        locationCode,
        items: cartItems,
      }),
    }).catch(err => console.error('Cart sync failed:', err))
  }

  const getItemId = (item) => item?.id ?? item?.ITEMCODE ?? item?.itemCode ?? ''
  const sameId = (a, b) => String(a ?? '') === String(b ?? '')

  const addToCart = (product) => {
    setCart(prev => {
      const pid = getItemId(product)
      const existingItem = prev.find(item => sameId(getItemId(item), pid))
      const newCart = existingItem
        ? prev.map(item =>
            sameId(getItemId(item), pid) ? { ...item, quantity: item.quantity + 1 } : item
          )
        : [...prev, { ...product, quantity: 1 }]
      syncCartToDb(newCart)
      return newCart
    })
  }

  const removeFromCart = (productId) => {
    setCart(prev => {
      const newCart = prev.filter(item => !sameId(getItemId(item), productId))
      syncCartToDb(newCart)
      return newCart
    })
  }

  const updateQuantity = useCallback((productId, quantity) => {
    const qty = Math.max(0, Number(quantity) || 0)
    setCart(prev => {
      if (qty <= 0) {
        const newCart = prev.filter(item => !sameId(getItemId(item), productId))
        syncCartToDb(newCart)
        return newCart
      }
      const newCart = prev.map(item =>
        sameId(getItemId(item), productId) ? { ...item, quantity: qty } : item
      )
      syncCartToDb(newCart)
      return newCart
    })
  }, [])

  const clearCart = () => {
    setCart([])
    setSelectedCartItemId(null)
    syncCartToDb([])
  }

  const handleSelectCustomer = (customer) => {
    const flag = (customer?.FLAG ?? customer?.flag ?? '').toString().trim().toUpperCase()
    if (flag === 'N') {
      alert('Customer Locked Please contact Accounts')
      return
    }
    setSelectedCustomer(customer)
  }

  const handleClearCustomer = () => {
    setSelectedCustomer(null)
  }

  const goToPayment = () => {
    if (cart.length > 0) setShowPaymentPage(true)
  }

  const completePayment = async () => {
    const activeItems = cart.filter((item) => !item.void)
    const invoiceCode = selectedCustomer?.INVOICECODE ?? selectedCustomer?.invoicecode ?? null
    const billdtlPayload = {
      locationCode: locationCode || '',
      billNo,
      counterCode: counterCode || '',
      invoiceCode: invoiceCode != null ? invoiceCode : undefined,
      items: activeItems.map((item) => ({
        itemCode: getItemId(item) || String(item.id ?? item.ITEMCODE ?? item.itemCode ?? ''),
        quantity: Number(item.quantity) || 0,
        rate: Number(item.price) || 0,
      })),
    }
    try {
      const res = await fetch(`${API_BASE}/api/billdtl/insert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(billdtlPayload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) console.error('[BILLDTL] insert failed:', data.error || res.status)
    } catch (e) {
      console.error('[BILLDTL] insert error:', e)
    }
    try {
      await fetch(`${API_BASE}/api/billno/paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billNo }),
      })
    } catch (_) { /* ignore */ }
    clearCart()
    setSelectedCartItemId(null)
    await fetchAndSetNextBillNo()
    setShowPaymentPage(false)
  }

  const backFromPayment = () => {
    setShowPaymentPage(false)
  }

  const showBilling = activeView === 'dashboard'

  if (authLoading) {
    return (
      <div className="app auth-loading">
        <div className="loading-spinner">Loading...</div>
      </div>
    )
  }

  if (!user) {
    return (
      <Login
        onLogin={handleLogin}
        loading={authLoading}
        error={loginError}
      />
    )
  }

  const roleLabel = user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : ''
  const displayName = user.userid ?? user.username ?? ''
  const allowedViews = getAllowedViews(user.role)
  const canView = (id) => allowedViews.includes(id)
  const handleMenuSelect = (id) => {
    setActiveView(id)
    setSidebarOpen(false)
  }

  return (
    <div className="app">
      <div
        className={`sidebar-backdrop ${sidebarOpen ? 'visible' : ''}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />
      <Sidebar
        activeMenu={activeView}
        onMenuSelect={handleMenuSelect}
        user={user}
        onLogout={handleLogout}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="main-area">
        <header className="top-bar">
          <button
            type="button"
            className="menu-toggle-btn"
            onClick={() => setSidebarOpen((o) => !o)}
            aria-label="Open menu"
          >
            <span className="menu-toggle-icon">☰</span>
          </button>
          <h1>POS System</h1>
          <div className="header-pos-info">
            <span>Location code: {locationCode}</span>
            <span>Location name: {locationName}</span>
            <span>Bill date: {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-')}</span>
            <span>Counter: {counterCode} {counterName}</span>
          </div>
          <div className="header-info">
            <span className="role-badge" title={`Logged in as ${roleLabel}`}>
              {displayName} ({roleLabel})
            </span>
          </div>
        </header>
        <div className="content-wrapper">
          {showPaymentPage ? (
            <Payment
              cartItems={cart}
              selectedCustomer={selectedCustomer}
              billNo={billNo}
              locationCode={locationCode}
              onComplete={completePayment}
              onBack={backFromPayment}
            />
          ) : (
            <>
              {showBilling && (
                <Dashboard
                  cartItems={cart}
                  products={products}
                  onAddToCart={addToCart}
                  apiBase={API_BASE}
                  customers={customers}
                  selectedCustomer={selectedCustomer}
                  onSelectCustomer={handleSelectCustomer}
                  onClearCustomer={handleClearCustomer}
                  onUpdateQuantity={updateQuantity}
                  onRemove={removeFromCart}
                  onClear={clearCart}
                  onCheckout={goToPayment}
                  onHold={handleHold}
                  onHoldRetrieve={handleHoldRetrieve}
                  selectedCartItemId={selectedCartItemId}
                  onSelectCartItem={setSelectedCartItemId}
                  onVoidLine={handleVoidLine}
                  onSuspendBill={handleSuspendBill}
                  hasHeldCart={true}
                  locationCode={locationCode}
                  counterCode={counterCode}
                  counterName={counterName}
                  billNo={billNo}
                />
              )}
              {activeView === 'customers' && canView('customers') && (
                <CustomerList customers={customers} />
              )}
              {activeView === 'users' && canView('users') && (
                <UserManagement apiBase={API_BASE} token={token} />
              )}
              {activeView === 'counter-setup' && canView('counter-setup') && (
                <CounterSetup
                  counterCode={counterCode}
                  counterName={counterName}
                  locationCode={locationCode}
                  apiBase={API_BASE}
                  onSave={(code, name) => {
                    setCounterCode(code)
                    setCounterName(name)
                  }}
                />
              )}
              {activeView === 'counter-open' && canView('counter-open') && (
                <CounterOpen apiBase={API_BASE} token={token} locationCode={locationCode} />
              )}
              {activeView === 'settings' && canView('settings') && (
                <div className="content-placeholder">
                  <h2>Settings</h2>
                  <p>Store and tax settings</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <HoldRetrieveModal
        open={showHoldRetrieveModal}
        onClose={() => setShowHoldRetrieveModal(false)}
        locationCode={locationCode}
        apiBase={API_BASE}
        onRetrieve={handleHoldRetrieveSelect}
      />
    </div>
  )
}

export default App
