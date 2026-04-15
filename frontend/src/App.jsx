import { useState, useEffect, useCallback, useRef } from 'react'
import Sidebar from './components/Sidebar'
import CustomerList from './components/CustomerList'
import CounterSetup from './components/CounterSetup'
import CounterOpen from './components/CounterOpen'
import Billing from './components/Billing'
import Dashboard from './components/Dashboard'
import Payment from './components/Payment'
import Login from './components/Login'
import HoldRetrieveModal from './components/HoldRetrieveModal'
import SupervisorValidateModal from './components/SupervisorValidateModal'
import PrinterSettings from './components/PrinterSettings'
import OnScreenKeyboard from './components/OnScreenKeyboard'
import { KeyboardProvider } from './context/KeyboardContext'
import { printReceipt, printHoldSlip } from './services/thermalPrint'
import './App.css'
import { getApiBase } from './apiBase'

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

function getLauncherSystemContext() {
  if (typeof sessionStorage === 'undefined') return { systemIp: '', systemName: '' }
  return {
    systemIp: (sessionStorage.getItem('pos_system_ip') || '').trim(),
    systemName: (sessionStorage.getItem('pos_system_name') || '').trim(),
  }
}

/** Normalize /api/billing/default-customer payload for Billing (mixed Oracle key casing). */
function normalizeDefaultCustomerPayload(c) {
  if (!c || typeof c !== 'object') return c
  const code = String(c.CUSTOMERCODE ?? c.customercode ?? '').trim()
  const name = String(c.CUSTOMERNAME ?? c.customername ?? '').trim()
  const fullRaw = c.CUST_FULL_NAME ?? c.cust_full_name
  const full = fullRaw != null && String(fullRaw).trim() !== '' ? String(fullRaw).trim() : [code, name].filter(Boolean).join(' ')
  return {
    ...c,
    CUSTOMERCODE: code,
    customercode: code || c.customercode,
    CUSTOMERNAME: name,
    customername: name || c.customername,
    CUST_FULL_NAME: full,
  }
}

/** Same query as Counter Setup / cashier: filters COUNTER by launcher IP and optional system name. */
function countersLookupUrl(apiBase) {
  const { systemIp, systemName } = getLauncherSystemContext()
  const params = new URLSearchParams()
  if (systemIp) params.set('systemIp', systemIp)
  if (systemName) params.set('systemName', systemName)
  const qs = params.toString()
  return qs ? `${apiBase}/api/counters?${qs}` : `${apiBase}/api/counters`
}

const SESSION_BILL_DATE_KEY = 'pos_session_bill_date'

/** YYYY-MM-DD (DATEOFOPEN) shown as DD-MM-YYYY; falls back to today if missing/invalid. */
function formatBillDateEnGbFromIso(isoYyyyMmDd) {
  if (!isoYyyyMmDd || !/^\d{4}-\d{2}-\d{2}$/.test(String(isoYyyyMmDd).trim())) {
    return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-')
  }
  const [y, m, d] = String(isoYyyyMmDd).trim().split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-')
}

/** Local noon for a calendar day string (receipts / slips avoid TZ shifting the printed date). */
function dateAtNoonFromIso(isoYyyyMmDd) {
  if (!isoYyyyMmDd || !/^\d{4}-\d{2}-\d{2}$/.test(String(isoYyyyMmDd).trim())) return new Date()
  const [y, m, d] = String(isoYyyyMmDd).trim().split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0)
}

/**
 * DATEOFOPEN of the latest OPEN counter session for this counter (when status says open).
 * Returns undefined if the request failed (caller should keep prior session date).
 */
async function fetchSessionBillDateFromOpenCounter(apiBase, counterCode) {
  const cc = String(counterCode || '').trim()
  if (!apiBase || !cc) return null
  try {
    const openedParams = new URLSearchParams()
    openedParams.set('counterCode', cc)
    const openedRes = await fetch(`${apiBase}/api/counter-operations/opened-dates?${openedParams}`)
    const openedData = await openedRes.json().catch(() => ({}))
    if (!openedRes.ok || openedData.ok !== true) return undefined
    const last = openedData.lastOpenedDate || null
    if (!last) return null
    const { systemIp } = getLauncherSystemContext()
    const statusParams = new URLSearchParams({ date: last })
    if (systemIp) statusParams.set('systemIp', systemIp)
    statusParams.set('counterCode', cc)
    const statusRes = await fetch(`${apiBase}/api/counter-operations/status?${statusParams}`)
    const statusData = await statusRes.json().catch(() => ({}))
    if (!statusRes.ok || statusData.ok !== true) return undefined
    if (!statusData.open) return null
    return last
  } catch (e) {
    console.error('[SessionBillDate] fetch failed:', e)
    return undefined
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
  const loginInFlightRef = useRef(false)
  const [activeView, setActiveView] = useState(() => {
    try {
      const v = sessionStorage.getItem('pos_active_view')
      if (v && typeof v === 'string') return v
    } catch (_) {}
    return 'dashboard'
  })
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [cart, setCart] = useState([])
  const [showHoldRetrieveModal, setShowHoldRetrieveModal] = useState(false)
  const [locationCode, setLocationCode] = useState(() => localStorage.getItem('pos_location') || 'LOC001')
  const [locationName, setLocationName] = useState(() => localStorage.getItem('pos_location_name') || '')
  const [locationTelephone, setLocationTelephone] = useState(() => localStorage.getItem('pos_location_telephone') || '')
  const [counterCode, setCounterCode] = useState(() => localStorage.getItem('pos_counter_code') || 'CNT01')
  const [counterName, setCounterName] = useState(() => localStorage.getItem('pos_counter_name') || 'Counter 1')
  /** Business bill date = counter DATEOFOPEN while session is OPEN (YYYY-MM-DD). */
  const [sessionBillDate, setSessionBillDate] = useState(() => {
    try {
      const s = (localStorage.getItem(SESSION_BILL_DATE_KEY) || '').trim()
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
    } catch (_) {
      return ''
    }
  })
  const [billNo, setBillNo] = useState(() => {
    const stored = localStorage.getItem('pos_bill_no') || '1'
    const n = parseInt(stored, 10)
    return Number.isNaN(n) || n < 1 ? 1 : n
  })
  const [products, setProducts] = useState([])
  const [customers, setCustomers] = useState([])
  const [selectedCustomer, setSelectedCustomer] = useState(null)
  const [showPaymentPage, setShowPaymentPage] = useState(false)
  const [selectedCartItemId, setSelectedCartItemId] = useState(null)
  const [showSupervisorModal, setShowSupervisorModal] = useState(false)
  const [supervisorModalActionLabel, setSupervisorModalActionLabel] = useState('')
  const [isSalesReturn, setIsSalesReturn] = useState(false)
  const pendingSupervisorCallbackRef = useRef(null)
  const [cartTotalPoints, setCartTotalPoints] = useState(0)
  const [cartLinePoints, setCartLinePoints] = useState({})

  const refreshOpenSessionBillDate = useCallback(async () => {
    const iso = await fetchSessionBillDateFromOpenCounter(getApiBase(), counterCode)
    if (iso === undefined) return
    if (iso) {
      setSessionBillDate(iso)
      try {
        localStorage.setItem(SESSION_BILL_DATE_KEY, iso)
      } catch (_) {}
    } else {
      setSessionBillDate('')
      try {
        localStorage.removeItem(SESSION_BILL_DATE_KEY)
      } catch (_) {}
    }
  }, [counterCode])

  useEffect(() => {
    if (!user) return
    refreshOpenSessionBillDate()
  }, [user, counterCode, refreshOpenSessionBillDate])

  // Restore user from token on load (refresh: keep logged in; only relogin on 401)
  useEffect(() => {
    if (!token) {
      setAuthLoading(false)
      return
    }
    fetch(`${getApiBase()}/api/me`, {
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
          // On refresh: do NOT call /api/billno/next — it creates a new billno. Use localStorage billNo only.
          // New billno is created only on actual login (handleLogin -> fetchAndSetNextBillNo).
        }
        // Same as login: refresh LOCATIONMASTER fields (telephone) from DB — fixes missing phone until re-login
        if (data?.location) {
          const code = data.location.locationCode ?? data.location.location_code ?? ''
          const name = data.location.locationName ?? data.location.location_name ?? ''
          const tel = (data.location.telephone ?? data.location.TELEPHONE ?? data.location.mobile ?? data.location.MOBILE ?? '').toString().trim()
          setLocationCode((prev) => code || prev)
          setLocationName(name)
          setLocationTelephone(tel)
          if (code) localStorage.setItem('pos_location', code)
          if (name) localStorage.setItem('pos_location_name', name)
          if (tel) localStorage.setItem('pos_location_telephone', tel)
          else localStorage.removeItem('pos_location_telephone')
        }
      })
      .catch(() => {})
      .finally(() => setAuthLoading(false))
  }, [token])

  // Role-based view access: IT=all, Supervisor=Billing+CounterOpen+Dashboard, Cashier (rollcode 3)=Billing only
  const getAllowedViews = (u) => {
    const role = (u?.role || '').toLowerCase()
    const roll = Number(u?.rollcode ?? u?.rolecode ?? NaN)
    const isCashier = role === 'cashier' || roll === 3
    if (role === 'it' || role === 'manager' || role === 'admin') return ['dashboard', 'billing', 'customers', 'counter-setup', 'counter-open', 'settings']
    if (role === 'supervisor') return ['dashboard', 'billing', 'counter-open']
    if (isCashier) return ['billing']
    return ['dashboard', 'billing']
  }
  useEffect(() => {
    if (!user) return
    const allowed = getAllowedViews(user)
    if (!allowed.includes(activeView)) setActiveView(allowed[0] || 'billing')
  }, [user, activeView])

  // Cashier (rollcode 3): enter fullscreen on login
  useEffect(() => {
    if (!user) return
    const roll = Number(user?.rollcode ?? user?.rolecode ?? NaN)
    const role = (user?.role || '').toLowerCase()
    const isCashier = role === 'cashier' || roll === 3
    if (isCashier && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {})
    }
  }, [user])

  useEffect(() => {
    if (!user) return
    try {
      sessionStorage.setItem('pos_active_view', activeView)
    } catch (_) {}
  }, [user, activeView])

  const handleLogin = async ({ username, password }) => {
    if (loginInFlightRef.current) return
    loginInFlightRef.current = true
    setLoginError(null)
    setAuthLoading(true)
    try {
      const res = await fetch(`${getApiBase()}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Login failed')

      // Cashier (rollcode 3): allow login only if counter is open; otherwise show contact-supervisor message
      const role = (data.user?.role || '').toLowerCase().trim()
      const rollRaw = data.user?.rollcode ?? data.user?.rolecode
      const roll = rollRaw != null && rollRaw !== '' ? Number(rollRaw) : NaN
      const isCashierLogin = roll === 3 || (Number.isNaN(roll) && role === 'cashier')
      const isSupervisorLogin = roll === 2 || (Number.isNaN(roll) && role === 'supervisor')
      /** Supervisor: land on Counter Open if not open yet; otherwise Dashboard (same open check as cashier). */
      let supervisorInitialView = 'counter-open'
      if (isCashierLogin) {
        const { systemIp } = getLauncherSystemContext()
        const countersRes = await fetch(countersLookupUrl(getApiBase()))
        const countersData = await countersRes.json()
        const counters = (countersData.ok && Array.isArray(countersData.counters)) ? countersData.counters : []
        if (counters.length === 0) {
          setLoginError('Counter is not open. Please contact your supervisor.')
          setAuthLoading(false)
          return
        }
        const counterCode = (counters[0].counterCode ?? counters[0].COUNTERCODE ?? '').toString().trim()
        // Fetch last opened date from API
        const openedDatesParams = new URLSearchParams()
        if (counterCode) openedDatesParams.set('counterCode', counterCode)
        const openedDatesRes = await fetch(`${getApiBase()}/api/counter-operations/opened-dates?${openedDatesParams}`)
        const openedDatesData = await openedDatesRes.json()
        const lastOpenedDate = openedDatesData.ok ? openedDatesData.lastOpenedDate : null
        if (!lastOpenedDate) {
          setLoginError('Counter is not open. Please contact your supervisor.')
          setAuthLoading(false)
          return
        }
        // Check status using last opened date
        const statusParams = new URLSearchParams({ date: lastOpenedDate })
        if (systemIp) statusParams.set('systemIp', systemIp)
        if (counterCode) statusParams.set('counterCode', counterCode)
        const statusRes = await fetch(`${getApiBase()}/api/counter-operations/status?${statusParams}`)
        const statusData = await statusRes.json()
        if (!statusData.ok || !statusData.open) {
          setLoginError('Counter is closed or not open. Please contact your supervisor.')
          setAuthLoading(false)
          return
        }
        setSessionBillDate(lastOpenedDate)
        try {
          localStorage.setItem(SESSION_BILL_DATE_KEY, lastOpenedDate)
        } catch (_) {}
      }

      // Supervisor: this workstation must already exist in COUNTER (IT counter setup); do not require counter "open"
      if (isSupervisorLogin) {
        const { systemIp, systemName } = getLauncherSystemContext()
        // Require both so /api/counters filters by SYSTEMIP + SYSTEMNAME (same as counter setup row); avoids no-params API returning all counters
        if (!systemIp || !systemName) {
          setLoginError(
            'Counter setup could not be verified. Open POS from PS Launcher (system name and IP required), or contact IT for counter setup.'
          )
          setAuthLoading(false)
          return
        }
        const supCountersRes = await fetch(countersLookupUrl(getApiBase()))
        const supCountersData = await supCountersRes.json()
        const supCounters = (supCountersData.ok && Array.isArray(supCountersData.counters)) ? supCountersData.counters : []
        if (supCounters.length === 0) {
          setLoginError(
            'This computer has no counter setup for this system name / IP. Contact IT for counter setup.'
          )
          setAuthLoading(false)
          return
        }
        const row0 = supCounters[0]
        const setupCode = (row0.counterCode ?? row0.COUNTERCODE ?? '').toString().trim()
        const setupName = (row0.counterName ?? row0.COUNTERNAME ?? '').toString().trim()
        if (setupCode) {
          localStorage.setItem('pos_counter_code', setupCode)
          setCounterCode(setupCode)
        }
        if (setupName) {
          localStorage.setItem('pos_counter_name', setupName)
          setCounterName(setupName)
        }
        const { systemIp: supSystemIp } = getLauncherSystemContext()
        const supOpenedParams = new URLSearchParams()
        if (setupCode) supOpenedParams.set('counterCode', setupCode)
        const supOpenedRes = await fetch(`${getApiBase()}/api/counter-operations/opened-dates?${supOpenedParams}`)
        const supOpenedData = await supOpenedRes.json()
        const supLastOpened = supOpenedData.ok ? supOpenedData.lastOpenedDate : null
        if (supLastOpened) {
          const supStatusParams = new URLSearchParams({ date: supLastOpened })
          if (supSystemIp) supStatusParams.set('systemIp', supSystemIp)
          if (setupCode) supStatusParams.set('counterCode', setupCode)
          const supStatusRes = await fetch(`${getApiBase()}/api/counter-operations/status?${supStatusParams}`)
          const supStatusData = await supStatusRes.json()
          if (supStatusData.ok && supStatusData.open) {
            supervisorInitialView = 'dashboard'
            setSessionBillDate(supLastOpened)
            try {
              localStorage.setItem(SESSION_BILL_DATE_KEY, supLastOpened)
            } catch (_) {}
          }
        }
      }

      localStorage.setItem('pos_token', data.token)
      setToken(data.token)
      setUser(data.user)
      localStorage.setItem('pos_user', JSON.stringify(data.user))
      // Set location from LOCATIONMASTER (BASELOCATIONFLAG = 'Y') returned at login
      if (data.location) {
        const code = data.location.locationCode ?? data.location.location_code ?? ''
        const name = data.location.locationName ?? data.location.location_name ?? ''
        const tel = (data.location.telephone ?? data.location.TELEPHONE ?? data.location.mobile ?? data.location.MOBILE ?? '').toString().trim()
        setLocationCode(code || locationCode)
        setLocationName(name)
        setLocationTelephone(tel)
        if (code) localStorage.setItem('pos_location', code)
        if (name) localStorage.setItem('pos_location_name', name)
        if (tel) localStorage.setItem('pos_location_telephone', tel)
        else localStorage.removeItem('pos_location_telephone')
      }
      // Store from APPLICATIONUSER (returned at login when using DB auth)
      if (data.store != null && data.store !== '') {
        localStorage.setItem('pos_store', String(data.store))
        console.log('Store:', data.store)
      }
      // Create and insert new_billno only on actual login (not on refresh)
      await fetchAndSetNextBillNo()
      // New bill on login: clear cart so it matches the new billNo (cart is per bill)
      setCart([])
      // IT/Manager/Admin: skip system name+IP registration check and go directly to Counter Setup
      if (role === 'it' || role === 'manager' || role === 'admin') {
        setActiveView('counter-setup')
      } else if (isCashierLogin) {
        setActiveView('billing')
      } else if (isSupervisorLogin) {
        setActiveView(supervisorInitialView)
      }
    } catch (err) {
      setLoginError(err.message || 'Invalid username or password')
    } finally {
      setAuthLoading(false)
      loginInFlightRef.current = false
    }
  }

  const handleLogout = () => {
    // Exit fullscreen on logout
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {})
    }
    localStorage.removeItem('pos_token')
    localStorage.removeItem('pos_user')
    localStorage.removeItem('pos_location_telephone')
    setLocationTelephone('')
    setToken(null)
    setUser(null)
    setCart([])
    try {
      sessionStorage.removeItem('pos_active_view')
    } catch (_) {}
    setShowPaymentPage(false)
    setActiveView('dashboard')
    setSessionBillDate('')
    try {
      localStorage.removeItem(SESSION_BILL_DATE_KEY)
    } catch (_) {}
  }

  const fetchAndSetNextBillNo = async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/billno/next`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flag: 0,
          counterCode: counterCode || '',
          ...(sessionBillDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionBillDate) ? { billDate: sessionBillDate } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.billNo != null) {
        const next = Number(data.billNo)
        const safe = Number.isNaN(next) || next < 1 ? 1 : next
        setBillNo(safe)
        localStorage.setItem('pos_bill_no', String(safe))
      } else {
        setBillNo((prev) => {
          const p = Number.isNaN(prev) || prev < 1 ? 1 : prev
          const next = p + 1
          localStorage.setItem('pos_bill_no', String(next))
          return next
        })
      }
    } catch {
      setBillNo((prev) => {
        const p = Number.isNaN(prev) || prev < 1 ? 1 : prev
        const next = p + 1
        localStorage.setItem('pos_bill_no', String(next))
        return next
      })
    }
  }

  const handleHold = async (isSuspend = false) => {
    if (cart.length === 0) return
    try {
      const res = await fetch(`${getApiBase()}/api/hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          billNo,
          locationCode,
          counterCode,
          customerCode: selectedCustomer?.CUSTOMERCODE || selectedCustomer?.customercode || null,
          items: cart,
          suspend: isSuspend,
          ...(sessionBillDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionBillDate) ? { billDate: sessionBillDate } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Hold failed')
      try {
        await printHoldSlip({
          billNo,
          date: dateAtNoonFromIso(sessionBillDate),
          locationCode: locationCode || '',
          locationName: locationName || '',
          locationTelephone: locationTelephone || '',
          branchName: (localStorage.getItem('pos_branch_name') || '').trim() || '',
          counterCode: counterCode || '',
          counterName: counterName || '',
          userName: user?.userid ?? user?.username ?? '',
          suspend: isSuspend,
        })
      } catch (printErr) {
        console.error('[Hold] Slip print failed:', printErr)
        const msg = printErr?.message ?? String(printErr)
        if (msg.includes('QZ Tray is not running')) {
          alert(
            (isSuspend ? 'Suspend saved' : 'Hold saved') +
              ' but slip not printed. Start QZ Tray (https://qz.io) for thermal printing.'
          )
        } else if (!msg.includes('No printers')) {
          alert((isSuspend ? 'Suspend saved' : 'Hold saved') + ' but print failed: ' + msg)
        }
      }
      setCart([])
      setSelectedCustomer(null)
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
    const safeBillNo = Number(retrievedBillNo)
    const bill = Number.isNaN(safeBillNo) || safeBillNo < 1 ? 1 : safeBillNo
    setBillNo(bill)
    localStorage.setItem('pos_bill_no', String(bill))
    setShowHoldRetrieveModal(false)
  }

  const handleVoidLine = () => {
    if (!selectedCartItemId) return
    const itemToVoid = cart.find(item => sameId(getItemId(item), selectedCartItemId))
    if (itemToVoid) {
      fetch(`${getApiBase()}/api/void-line`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          billNo,
          locationCode,
          counterCode,
          item: itemToVoid,
          ...(sessionBillDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionBillDate) ? { billDate: sessionBillDate } : {}),
        }),
      }).catch(err => console.error('Void line API failed:', err))
    }
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
    handleHold(true)
  }

  const toggleSalesReturn = useCallback(() => {
    setIsSalesReturn(prev => {
      const next = !prev
      if (!next) {
        setCart(c => {
          const updated = c.map(item => ({
            ...item,
            quantity: item.void ? item.quantity : Math.max(1, Math.abs(Number(item.quantity) || 0)),
          }))
          syncCartToDb(updated)
          return updated
        })
      }
      return next
    })
  }, [])

  const requestSupervisorAction = (actionLabel, callback) => {
    if (typeof callback !== 'function') return
    pendingSupervisorCallbackRef.current = callback
    setSupervisorModalActionLabel(actionLabel)
    setShowSupervisorModal(true)
  }

  const handleSalesReturnClick = () => {
    if (isSalesReturn) {
      requestSupervisorAction('Sale', toggleSalesReturn)
    } else {
      requestSupervisorAction('Sales Return', toggleSalesReturn)
    }
  }

  const handleSupervisorValidated = () => {
    const cb = pendingSupervisorCallbackRef.current
    pendingSupervisorCallbackRef.current = null
    setShowSupervisorModal(false)
    setSupervisorModalActionLabel('')
    if (typeof cb === 'function') cb()
  }

  useEffect(() => {
    const handleKeyDown = (e) => {
      const blockedKeys = [
        "F1",  // Browser help
        "F3",  // Find
        "F5",  // Refresh
        "F9", 
        "F11", // Fullscreen toggle
        "F12", 
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

  // Disable text copy, cut, and context menu (right-click) across the app
  useEffect(() => {
    const prevent = (e) => e.preventDefault();
    document.addEventListener('copy', prevent);
    document.addEventListener('cut', prevent);
    document.addEventListener('contextmenu', prevent);
    return () => {
      document.removeEventListener('copy', prevent);
      document.removeEventListener('cut', prevent);
      document.removeEventListener('contextmenu', prevent);
    };
  }, []);

  useEffect(() => {
    if (!user) return
    fetch(`${getApiBase()}/api/products`)
      .then(response => response.json())
      .then(data => {
        // Map backend fields to frontend expected fields
        const mappedProducts = data.map(p => ({
          id: p.ITEMCODE,
          name: p.ITEMNAME,
          nameAr: (p.ITEMNAMEARA ?? p.itemnameara ?? '').toString().trim() || undefined,
          price: parseFloat(p.RETAILPRICE) || 0,
          category: p.CATEGORYCODE,
          image: '📦',
          manufactureId: p.MANUFACTUREID ?? p.manufactureid ?? '',
          alternateCodes: Array.isArray(p.ALTERNATECODES) ? p.ALTERNATECODES : [],
          uom: (p.BASEUOM ?? p.baseuom ?? '').toString().trim() || undefined,
          factor: p.Factor ?? p.factor,
          Factor: p.Factor ?? p.factor,
          costPrice: p.COSTPRICE ?? p.costprice,
          COSTPRICE: p.COSTPRICE ?? p.costprice,
          store: p.STORE ?? p.store,
          STORE: p.STORE ?? p.store,
          avgCost: p.AVERAGECOST ?? p.averagecost ?? p.avgcost,
          AVERAGECOST: p.AVERAGECOST ?? p.averagecost ?? p.avgcost,
        }))
        setProducts(mappedProducts)
      })
      .catch(error => console.error('Error fetching products:', error))
  }, [user])

  useEffect(() => {
    if (!user) return
    fetch(`${getApiBase()}/api/customers`)
      .then(res => res.json())
      .then(data => setCustomers(Array.isArray(data) ? data : []))
      .catch(() => setCustomers([]))
  }, [user])

  // Default customer from TBLCOUNTERSALE (first row for this counter; else first row of table) when none selected.
  useEffect(() => {
    if (!user) return
    let cancelled = false
    const params = new URLSearchParams({
      counterCode: String(counterCode || '').trim(),
      locationCode: locationCode || '',
    })
    fetch(`${getApiBase()}/api/billing/default-customer?${params}`)
      .then((res) => {
        if (!res.ok) return null
        return res.json()
      })
      .then((data) => {
        if (cancelled || !data?.ok || !data?.customer) return
        setSelectedCustomer((curr) => curr ?? normalizeDefaultCustomerPayload(data.customer))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [user, counterCode, locationCode, billNo])

  // On load / reopen: restore cart from DB (TEMPBILLDTL) by current billNo; when billNo changes, cart must match that bill
  useEffect(() => {
    if (!user || billNo == null) return
    const params = new URLSearchParams({ billNo: String(billNo), locationCode: locationCode || '' })
    fetch(`${getApiBase()}/api/cart/by-bill?${params}`)
      .then(res => res.json())
      .then(data => {
        const list = data?.items
        setCart(Array.isArray(list) ? list : [])
      })
      .catch(() => setCart([]))
  }, [user, billNo])

  const syncCartToDb = (cartItems) => {
    const cust =
      selectedCustomer?.CUSTOMERCODE ??
      selectedCustomer?.customercode ??
      null
    fetch(`${getApiBase()}/api/cart/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        billNo,
        locationCode,
        counterCode: counterCode || '',
        customerCode: cust != null && String(cust).trim() !== '' ? String(cust).trim() : null,
        items: cartItems,
        isSalesReturn,
      }),
    }).catch(err => console.error('Cart sync failed:', err))
  }

  // If lines were synced before default customer loaded, push CUSTOMERCODE into TEMPBILLHDR once selection exists.
  useEffect(() => {
    if (!user || cart.length === 0 || !selectedCustomer) return
    syncCartToDb(cart)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only when bill or customer identity changes
  }, [user, billNo, selectedCustomer?.CUSTOMERCODE, selectedCustomer?.customercode])

  const getItemId = (item) => item?.id ?? item?.ITEMCODE ?? item?.itemCode ?? ''
  const sameId = (a, b) => String(a ?? '') === String(b ?? '')

  const addToCart = (product) => {
    const qtyDelta = isSalesReturn ? -1 : 1
    const useQty = product.isWeightedItem && product.quantity != null && product.quantity > 0
      ? product.quantity
      : qtyDelta
    setCart(prev => {
      const pid = getItemId(product)
      const existingItem = prev.find(item => sameId(getItemId(item), pid))
      let newCart
      if (existingItem) {
        if (existingItem.void) {
          newCart = prev.map(item =>
            sameId(getItemId(item), pid) ? { ...item, void: false, quantity: useQty } : item
          )
        } else {
          newCart = prev.map(item =>
            sameId(getItemId(item), pid) ? { ...item, quantity: item.quantity + useQty } : item
          )
        }
      } else {
        newCart = [...prev, { ...product, quantity: useQty }]
      }
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
    const raw = Number(quantity)
    const qty = isSalesReturn
      ? (Number.isNaN(raw) ? 0 : raw)
      : Math.max(0, Number(quantity) || 0)
    setCart(prev => {
      if (qty === 0) {
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
  }, [isSalesReturn])

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

  const goToPayment = () => {
    if (cart.length === 0) return
    const invoiceCode = selectedCustomer?.INVOICECODE ?? selectedCustomer?.invoicecode ?? null
    const isCreditCustomer = invoiceCode === 2 || invoiceCode === '2'
    if (selectedCustomer && isCreditCustomer) {
      const activeItems = cart.filter((item) => !item.void)
      const subtotal = activeItems.reduce((sum, item) => sum + (item.price ?? 0) * (item.quantity ?? 0), 0)

      const total = subtotal 
      completePayment({
        paymentMethod: 'credit',
        amountTendered: 0,
        change: 0,
        total,
        subtotal,
        items: activeItems,
      })
      return
    }
    setShowPaymentPage(true)
  }

  const completePayment = async (receiptData) => {
    let fetchedCurrentCredit = null
    let fetchedCreditLimit = null

    if (receiptData?.paymentMethod === 'credit' && selectedCustomer) {
      const custCode = selectedCustomer?.CUSTOMERCODE ?? selectedCustomer?.customercode ?? ''
      try {
        const res = await fetch(`${getApiBase()}/api/customers/balance?customerCode=${encodeURIComponent(custCode)}`)
        const balanceData = await res.json().catch(() => ({}))
        fetchedCurrentCredit = Number(balanceData.currentCreditAmount ?? 0) || 0
        fetchedCreditLimit = Number(balanceData.creditLimit ?? 0) || 0
      } catch (e) {
        console.error('[CustomerBalance] fetch error:', e)
        fetchedCurrentCredit = Number(selectedCustomer.CURRENTCREDITAMOUNT ?? selectedCustomer.currentcreditamount ?? 0) || 0
        fetchedCreditLimit = Number(selectedCustomer.CREDITLIMIT ?? selectedCustomer.creditlimit ?? 0) || 0
      }
      const billAmount = Math.abs(Number(receiptData.total ?? 0))
      const newBalanceCredit = isSalesReturn
        ? fetchedCurrentCredit - billAmount
        : fetchedCurrentCredit + billAmount
      if (newBalanceCredit > fetchedCreditLimit) {
        alert('Contact accounts')
        return
      }
    }

    const activeItems = cart.filter((item) => !item.void)
    const invoiceCode = selectedCustomer?.INVOICECODE ?? selectedCustomer?.invoicecode ?? null
    const netBillAmount = receiptData?.total ?? activeItems.reduce((sum, item) => sum + (item.price ?? 0) * (item.quantity ?? 0), 0)
    const customerCode = selectedCustomer?.CUSTOMERCODE ?? selectedCustomer?.customercode ?? ''
    const customerName = selectedCustomer?.CUST_FULL_NAME ?? selectedCustomer?.cust_full_name ?? selectedCustomer?.CUSTOMERNAME ?? selectedCustomer?.customername ?? ''
    const pm = receiptData?.paymentMethod
    let cardAmountForDb = 0
    if (pm === 'split') {
      cardAmountForDb = Number(receiptData?.cardAmount) || 0
    } else if (pm === 'card') {
      cardAmountForDb = Number(receiptData?.cardAmount ?? receiptData?.total ?? netBillAmount) || 0
    } else if (pm === 'cash') {
      cardAmountForDb = Number(receiptData?.cardAmount) || 0
    }

    const billdtlPayload = {
      locationCode: locationCode || '',
      billNo,
      counterCode: counterCode || '',
      ...(sessionBillDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionBillDate) ? { billDate: sessionBillDate } : {}),
      isSalesReturn,
      invoiceCode: invoiceCode != null ? invoiceCode : undefined,
      totalPoints: cartTotalPoints,
      netBillAmount: netBillAmount != null ? Number(netBillAmount) : undefined,
      cardAmount: cardAmountForDb,
      ...(cardAmountForDb > 0
        ? {
            cardNo: receiptData?.cardNo ?? '1234',
            cardType: receiptData?.cardType ?? 'Master',
          }
        : {}),
      customerCode: customerCode != null && customerCode !== '' ? String(customerCode).trim() : undefined,
      customerName: customerName != null && customerName !== '' ? String(customerName).trim() : undefined,
      items: activeItems.map((item) => {
        const storeRaw = item.store ?? item.STORE ?? item.locationCode ?? item.LOCATIONCODE ?? ''
        const store = storeRaw != null && storeRaw !== '' ? String(storeRaw).replace(/\s+/g, '') : undefined
        const convRaw = item.conversionFactor ?? item.CONVERSIONFACTOR ?? item.factor ?? item.Factor
        const costRaw = item.costPrice ?? item.COSTPRICE ?? item.costprice
        const line = {
          itemCode: getItemId(item) || String(item.id ?? item.ITEMCODE ?? item.itemCode ?? ''),
          quantity: Number(item.quantity) || 0,
          rate: Number(item.price) || 0,
          point: cartLinePoints[getItemId(item)] ?? item.point ?? item.POINT ?? 0,
          store,
        }
        if (convRaw != null && String(convRaw).trim() !== '') {
          const n = Number(convRaw)
          if (!Number.isNaN(n)) line.conversionFactor = n
        }
        if (costRaw != null && String(costRaw).trim() !== '') {
          const c = Number(costRaw)
          if (!Number.isNaN(c)) line.costPrice = c
        }
        return line
      }),
    }
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    try {
      const res = await fetch(`${getApiBase()}/api/billdtl/insert`, {
        method: 'POST',
        headers,
        body: JSON.stringify(billdtlPayload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) console.error('[BILLDTL] insert failed:', data.error || res.status)
    } catch (e) {
      console.error('[BILLDTL] insert error:', e)
    }
    if (receiptData?.paymentMethod === 'credit') {
      try {
        const custCode = selectedCustomer?.CUSTOMERCODE ?? selectedCustomer?.customercode ?? ''
        await fetch(`${getApiBase()}/api/creditsettlement`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            locationCode: locationCode || '',
            customerCode: custCode,
            billNo,
            billAmount: receiptData.total ?? 0,
            billDate: (sessionBillDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionBillDate)
              ? sessionBillDate
              : new Date().toISOString().slice(0, 10)),
            isSalesReturn,
          }),
        })
      } catch (e) {
        console.error('[CreditSettlement] error:', e)
      }
    }
    try {
      await fetch(`${getApiBase()}/api/billno/paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billNo }),
      })
    } catch (_) { /* ignore */ }

    // Auto-print receipt to USB thermal printer via QZ Tray (no system print dialog)
    try {
      const customerName = selectedCustomer?.CUST_FULL_NAME ?? selectedCustomer?.cust_full_name ?? selectedCustomer?.CUSTOMERNAME ?? selectedCustomer?.customername ?? ''
      await printReceipt({
        billNo,
        date: dateAtNoonFromIso(sessionBillDate),
        locationCode: locationCode || '',
        locationName: locationName || '',
        locationTelephone: locationTelephone || '',
        counterCode: counterCode || '',
        counterName: counterName || '',
        userName: user?.userid ?? user?.username ?? '',
        customerName: customerName || '',
        companyName: (localStorage.getItem('pos_company_name') || '').trim() || undefined,
        companyNameAr: (localStorage.getItem('pos_company_name_ar') || '').trim() || undefined,
        branchName: localStorage.getItem('pos_branch_name') || '',
        items: activeItems,
        subtotal: receiptData?.subtotal ?? 0,
        total: receiptData?.total ?? 0,
        discount: 0,
        totalPoints: cartTotalPoints,
        paymentMethod: receiptData?.paymentMethod ?? 'cash',
        cashAmount: receiptData?.cashAmount,
        cardAmount: receiptData?.cardAmount,
        amountTendered: receiptData?.amountTendered ?? 0,
        change: receiptData?.change ?? 0,
        isSalesReturn,
      })
    } catch (printErr) {
      console.error('[Receipt] Print failed:', printErr)
      const msg = printErr?.message ?? String(printErr)
      if (msg.includes('QZ Tray is not running')) {
        alert('Receipt not printed. Please start QZ Tray (https://qz.io) for automatic receipt printing.')
      } else if (!msg.includes('No printers')) {
        alert('Receipt print failed: ' + msg)
      }
    }

    try {
      localStorage.setItem(
        'pos_back_display_thank_you',
        JSON.stringify({
          at: Date.now(),
          counterCode: counterCode || '',
          locationCode: locationCode || '',
        })
      )
    } catch (_) {
      /* ignore */
    }

    clearCart()
    setSelectedCartItemId(null)
    setSelectedCustomer(null)
    await fetchAndSetNextBillNo()
    setShowPaymentPage(false)
  }

  const backFromPayment = () => {
    setShowPaymentPage(false)
  }

  const showBilling = activeView === 'billing'

  if (authLoading) {
    return (
      <KeyboardProvider>
        <div className="app auth-loading">
          <div className="loading-spinner">Loading...</div>
        </div>
        <OnScreenKeyboard />
      </KeyboardProvider>
    )
  }

  if (!user) {
    return (
      <KeyboardProvider>
        <Login
          onLogin={handleLogin}
          loading={authLoading}
          error={loginError}
        />
        <OnScreenKeyboard />
      </KeyboardProvider>
    )
  }

  const roleLabel = user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : ''
  const displayName = user.userid ?? user.username ?? ''
  const allowedViews = getAllowedViews(user)
  const canView = (id) => allowedViews.includes(id)
  const handleMenuSelect = (id) => {
    setActiveView(id)
    setSidebarOpen(false)
  }

  return (
    <KeyboardProvider>
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
        locationCode={locationCode}
        locationName={locationName}
        counterCode={counterCode}
        counterName={counterName}
        billDateDisplay={formatBillDateEnGbFromIso(sessionBillDate)}
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
            <span>Bill date: {formatBillDateEnGbFromIso(sessionBillDate)}</span>
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
              {activeView === 'dashboard' && (
                <Dashboard
                  apiBase={getApiBase()}
                  locationCode={locationCode}
                  locationName={locationName}
                  counterCode={counterCode}
                  counterName={counterName}
                  user={user}
                  counterSessionBillDate={sessionBillDate}
                />
              )}
              {showBilling && (
                <Billing
                  cartItems={cart}
                  products={products}
                  onAddToCart={addToCart}
                  apiBase={getApiBase()}
                  customers={customers}
                  selectedCustomer={selectedCustomer}
                  onSelectCustomer={handleSelectCustomer}
                  onUpdateQuantity={updateQuantity}
                  onRemove={removeFromCart}
                  onClear={clearCart}
                  onCheckout={goToPayment}
                  onTotalPointsChange={setCartTotalPoints}
                  onLinePointsChange={setCartLinePoints}
                  onHold={() => requestSupervisorAction('Hold bill', handleHold)}
                  onHoldRetrieve={() => requestSupervisorAction('Hold Retrieve', handleHoldRetrieve)}
                  selectedCartItemId={selectedCartItemId}
                  onSelectCartItem={setSelectedCartItemId}
                  onVoidLine={() => requestSupervisorAction('Void line', handleVoidLine)}
                  onSuspendBill={() => requestSupervisorAction('Suspend bill', handleSuspendBill)}
                  isSalesReturn={isSalesReturn}
                  onToggleSalesReturn={handleSalesReturnClick}
                  onRequestQty={(openQtyModal) => requestSupervisorAction('Quantity', openQtyModal)}
                  locationCode={locationCode}
                  counterCode={counterCode}
                  counterName={counterName}
                  billNo={billNo}
                />
              )}
              {activeView === 'customers' && canView('customers') && (
                <CustomerList customers={customers} />
              )}
              {activeView === 'counter-setup' && canView('counter-setup') && (
                <CounterSetup
                  counterCode={counterCode}
                  counterName={counterName}
                  locationCode={locationCode}
                  apiBase={getApiBase()}
                  onSave={(code, name) => {
                    setCounterCode(code)
                    setCounterName(name)
                  }}
                  onSavedNavigate={() => setActiveView('dashboard')}
                />
              )}
              {activeView === 'counter-open' && canView('counter-open') && (
                <CounterOpen
                  apiBase={getApiBase()}
                  token={token}
                  locationCode={locationCode}
                  locationName={locationName}
                  user={user}
                  counterCode={counterCode}
                  counterName={counterName}
                  onCounterOperationsChanged={refreshOpenSessionBillDate}
                />
              )}
              {activeView === 'settings' && canView('settings') && (
                <div className="content-placeholder">
                  <h2>Settings</h2>
                  <PrinterSettings />
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
        apiBase={getApiBase()}
        onRetrieve={handleHoldRetrieveSelect}
      />
      <SupervisorValidateModal
        open={showSupervisorModal}
        onClose={() => { setShowSupervisorModal(false); pendingSupervisorCallbackRef.current = null; setSupervisorModalActionLabel('') }}
        onSuccess={handleSupervisorValidated}
        actionLabel={supervisorModalActionLabel}
        apiBase={getApiBase()}
      />
      <OnScreenKeyboard />
    </div>
    </KeyboardProvider>
  )
}

export default App
