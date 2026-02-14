import { useState, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import ProductDisplay from './components/ProductDisplay'
import CartSummary from './components/CartSummary'
import CustomerList from './components/CustomerList'
import UserManagement from './components/UserManagement'
import CounterSetup from './components/CounterSetup'
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
    sessionStorage.setItem('pos_show_launcher_popup', '1')
    const cleanUrl = window.location.origin + window.location.pathname + (window.location.hash || '')
    window.history.replaceState({}, document.title, cleanUrl)
  }
}

function App() {
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(() => localStorage.getItem('pos_token') || null)
  const [authLoading, setAuthLoading] = useState(!!localStorage.getItem('pos_token'))
  const [loginError, setLoginError] = useState(null)
  const [activeView, setActiveView] = useState('dashboard')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [cart, setCart] = useState([])
  const [showHoldRetrieveModal, setShowHoldRetrieveModal] = useState(false)
  const [locationCode, setLocationCode] = useState(() => localStorage.getItem('pos_location') || 'LOC001')
  const [counterCode, setCounterCode] = useState(() => localStorage.getItem('pos_counter_code') || 'CNT01')
  const [counterName, setCounterName] = useState(() => localStorage.getItem('pos_counter_name') || 'Counter 1')
  const [billNo, setBillNo] = useState(() => parseInt(localStorage.getItem('pos_bill_no') || '1', 10))
  const [products, setProducts] = useState([])
  const [customers, setCustomers] = useState([])
  const [selectedCustomer, setSelectedCustomer] = useState(null)
  const [showPaymentPage, setShowPaymentPage] = useState(false)
  const [showLauncherPopup, setShowLauncherPopup] = useState(false)

  // Show launcher popup (name + IP) when opened via POS Launcher exe
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (sessionStorage.getItem('pos_show_launcher_popup') === '1') {
      sessionStorage.removeItem('pos_show_launcher_popup')
      setShowLauncherPopup(true)
    }
  }, [])

  // Restore user from token on load
  useEffect(() => {
    if (!token) {
      setAuthLoading(false)
      return
    }
    fetch(`${API_BASE}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data) => setUser(data.user))
      .catch(() => {
        localStorage.removeItem('pos_token')
        setToken(null)
        setUser(null)
      })
      .finally(() => setAuthLoading(false))
  }, [token])

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
    } catch (err) {
      setLoginError(err.message || 'Invalid username or password')
    } finally {
      setAuthLoading(false)
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('pos_token')
    setToken(null)
    setUser(null)
    setCart([])
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
    if (cart.length === 0) return
    const last = cart[cart.length - 1]
    removeFromCart(last.id)
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
          manufactureId: p.MANUFACTUREID ?? p.manufactureid ?? ''
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

  const addToCart = (product) => {
    const existingItem = cart.find(item => item.id === product.id)
    let newCart
    if (existingItem) {
      newCart = cart.map(item =>
        item.id === product.id
          ? { ...item, quantity: item.quantity + 1 }
          : item
      )
    } else {
      newCart = [...cart, { ...product, quantity: 1 }]
    }
    setCart(newCart)
    syncCartToDb(newCart)
  }

  const removeFromCart = (productId) => {
    const newCart = cart.filter(item => item.id !== productId)
    setCart(newCart)
    syncCartToDb(newCart)
  }

  const updateQuantity = (productId, quantity) => {
    if (quantity <= 0) {
      removeFromCart(productId)
    } else {
      const newCart = cart.map(item =>
        item.id === productId
          ? { ...item, quantity }
          : item
      )
      setCart(newCart)
      syncCartToDb(newCart)
    }
  }

  const clearCart = () => {
    setCart([])
    syncCartToDb([])
  }

  const handleSelectCustomer = (customer) => {
    setSelectedCustomer(customer)
  }

  const handleClearCustomer = () => {
    setSelectedCustomer(null)
  }

  const goToPayment = () => {
    if (cart.length > 0) setShowPaymentPage(true)
  }

  const completePayment = () => {
    clearCart()
    setBillNo((prev) => {
      const next = prev + 1
      localStorage.setItem('pos_bill_no', String(next))
      return next
    })
    setShowPaymentPage(false)
  }

  const backFromPayment = () => {
    setShowPaymentPage(false)
  }

  const showProducts = activeView === 'items'
  const showDashboard = activeView === 'dashboard' || activeView === 'dashboard'

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
            <span>Location: {locationCode}</span>
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
              {showProducts && (
                <>
                  <ProductDisplay
                    products={products}
                    onAddToCart={addToCart}
                    cartItems={cart}
                    apiBase={API_BASE}
                    onHold={handleHold}
                    onHoldRetrieve={handleHoldRetrieve}
                    hasHeldCart={true}
                  />
                  <CartSummary
                    cartItems={cart}
                    customers={customers}
                    selectedCustomer={selectedCustomer}
                    onClearCustomer={handleClearCustomer}
                    onUpdateQuantity={updateQuantity}
                    onRemove={removeFromCart}
                    onClear={clearCart}
                    onCheckout={goToPayment}
                    billNo={billNo}
                    products={products}
                    onAddToCart={addToCart}
                    apiBase={API_BASE}
                  />
                </>
              )}
              {showDashboard && (
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
                  onVoidLine={handleVoidLine}
                  onSuspendBill={handleSuspendBill}
                  hasHeldCart={true}
                  locationCode={locationCode}
                  counterCode={counterCode}
                  counterName={counterName}
                  billNo={billNo}
                />
              )}
            </>
          )}
          {activeView === 'customers' && (
            <CustomerList customers={customers} />
          )}
          {activeView === 'users' && (
            <UserManagement apiBase={API_BASE} token={token} />
          )}
          {activeView === 'counter-setup' && (
            <CounterSetup
              counterCode={counterCode}
              counterName={counterName}
              onSave={(code, name) => {
                setCounterCode(code)
                setCounterName(name)
              }}
            />
          )}
          {activeView === 'orders' && (
            <div className="content-placeholder">
              <h2>Orders</h2>
              <p>Track and manage orders</p>
            </div>
          )}
          {activeView === 'settings' && (
            <div className="content-placeholder">
              <h2>Settings</h2>
              <p>Store and tax settings</p>
            </div>
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
      {showLauncherPopup && (
        <div className="launcher-popup-overlay" onClick={() => setShowLauncherPopup(false)}>
          <div className="launcher-popup" onClick={(e) => e.stopPropagation()}>
            <h3 className="launcher-popup-title">System info</h3>
            <div className="launcher-popup-row">
              <span className="launcher-popup-label">Name:</span>
              <span className="launcher-popup-value">
                {typeof window !== 'undefined' ? sessionStorage.getItem('pos_system_name') || '—' : '—'}
              </span>
            </div>
            <div className="launcher-popup-row">
              <span className="launcher-popup-label">IP:</span>
              <span className="launcher-popup-value">
                {typeof window !== 'undefined' ? sessionStorage.getItem('pos_system_ip') || '—' : '—'}
              </span>
            </div>
            <button type="button" className="launcher-popup-ok" onClick={() => setShowLauncherPopup(false)}>
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
