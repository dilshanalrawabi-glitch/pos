import { useState, useEffect, useCallback, useRef, useMemo, startTransition, lazy, Suspense } from 'react'
import Sidebar from './components/Sidebar'
import CustomerList from './components/CustomerList'
import CounterSetup from './components/CounterSetup'
import BillingView from './components/BillingView'
import Login from './components/Login'
import HoldRetrieveModal from './components/HoldRetrieveModal'
import SupervisorValidateModal from './components/SupervisorValidateModal'
import PrinterSettings from './components/PrinterSettings'
import TopBarClock from './components/TopBarClock'
import { KeyboardProvider } from './context/KeyboardContext'
import './App.css'
import { getApiBase } from './apiBase'
import { buildProductLookupMap } from './utils/productLookup'
import { mergeCartLinesForThermalReceipt } from './utils/cartReceiptItems'
import { getItemId, sameCartLineId } from './utils/cartItemUtils'
import { mapProductsFromApi, CATALOG_REFRESH_INTERVAL_MS } from './utils/catalogUtils'
import { applyPriceModeToProduct } from './utils/priceMode'
import { useCartStore } from './stores/useCartStore'
import {
  buildBackDisplayPayload,
  publishBackDisplay,
  subscribeBackDisplay,
} from './utils/backDisplayChannel'
import {
  getDefaultSalesChannel,
  getSalesChannelCode,
  getSalesChannelDescription,
  normalizeSalesChannel,
} from './utils/salesChannelLookup'

const Dashboard = lazy(() => import('./components/Dashboard'))
const CounterOpen = lazy(() => import('./components/CounterOpen'))
const PaymentView = lazy(() => import('./components/PaymentView'))
const OnScreenKeyboard = lazy(() => import('./components/OnScreenKeyboard'))

function ViewFallback({ label = 'Loading…' }) {
  return (
    <div className="content-placeholder">
      <p>{label}</p>
    </div>
  )
}

async function loadThermalPrint() {
  return import('./services/thermalPrint')
}

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

/** Session bill calendar day + current system time (thermal print date/time). */
function sessionBillDateWithSystemTime(isoYyyyMmDd) {
  const now = new Date()
  if (!isoYyyyMmDd || !/^\d{4}-\d{2}-\d{2}$/.test(String(isoYyyyMmDd).trim())) return now
  const [y, m, d] = String(isoYyyyMmDd).trim().split('-').map(Number)
  return new Date(
    y,
    m - 1,
    d,
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    now.getMilliseconds()
  )
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
    } catch (_) { }
    return null
  })
  const [token, setToken] = useState(() => localStorage.getItem('pos_token') || null)
  const [authLoading, setAuthLoading] = useState(!!localStorage.getItem('pos_token'))
  const [loginError, setLoginError] = useState(null)
  const loginInFlightRef = useRef(false)
  /** Ignore stale /api/cart/by-bill responses when billNo changes quickly (e.g. login). */
  const cartFetchGenRef = useRef(0)
  const holdInFlightRef = useRef(false)
  const [activeView, setActiveView] = useState(() => {
    try {
      const v = sessionStorage.getItem('pos_active_view')
      if (v && typeof v === 'string') return v
    } catch (_) { }
    return 'dashboard'
  })
  const [sidebarOpen, setSidebarOpen] = useState(false)
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
  const [productsLoading, setProductsLoading] = useState(false)
  const [itemDetailsCacheResetKey, setItemDetailsCacheResetKey] = useState(0)
  const productsReady = !productsLoading
  const productLookupMap = useMemo(() => buildProductLookupMap(products), [products])
  const [customers, setCustomers] = useState([])
  const [selectedCustomer, setSelectedCustomer] = useState(null)
  const [salesChannels, setSalesChannels] = useState([])
  const [selectedSalesChannel, setSelectedSalesChannel] = useState(null)
  const [lastBillAmount, setLastBillAmount] = useState(() => {
    return Number(localStorage.getItem('pos_last_bill_amount')) || 0
  })
  const [lastBillChange, setLastBillChange] = useState(() => {
    return Number(localStorage.getItem('pos_last_bill_change')) || 0
  })
  const [orderNo, setOrderNo] = useState('')
  /** Counter default bill customer (cash walk-in). */
  const defaultBillingCustomerRef = useRef(null)
  const [showPaymentPage, setShowPaymentPage] = useState(false)
  const [creditCheckoutLoading, setCreditCheckoutLoading] = useState(false)
  const creditCheckoutInFlightRef = useRef(false)
  /** Blocks duplicate goToPayment before billing unmounts (e.g. double Enter / double tap Pay). */
  const goToPaymentLockRef = useRef(false)
  /** While completePayment runs: skip cart/by-bill refetch and defer setBillNo until pay finishes. */
  const payInFlightRef = useRef(false)
  /** Serialize /api/cart/sync so a slower older POST cannot overwrite a newer cart (e.g. qty decrease). */
  const cartSyncTailRef = useRef(Promise.resolve())
  /** Latest cart scheduled for Oracle sync (debounced). */
  const pendingCartSyncRef = useRef(null)
  const cartSyncDebounceTimerRef = useRef(null)
  /** Set after performCartSyncToDb is defined; used by handlers declared above (hold, retrieve). */
  const performCartSyncToDbRef = useRef(() => { })
  const [showSupervisorModal, setShowSupervisorModal] = useState(false)
  const [supervisorModalActionLabel, setSupervisorModalActionLabel] = useState('')
  const pendingSupervisorCallbackRef = useRef(null)
  /** Latest cart points from CartSummary — refs avoid App re-render on every scan. */
  const cartTotalPointsRef = useRef(0)
  const cartLinePointsRef = useRef({})
  /** CartSummary item-details cache (same as on-screen cart) — used for thermal print, not re-read from DB at pay. */
  const cartItemDetailsCacheRef = useRef({})
  const publishBackDisplaySnapshotRef = useRef(() => {})
  const commitCartItemDetailsCacheForPrint = useCallback((cache) => {
    cartItemDetailsCacheRef.current = cache && typeof cache === 'object' ? cache : {}
    publishBackDisplaySnapshotRef.current?.()
  }, [])
  const commitCartPointsSnapshot = useCallback(({ totalPoints, linePointsByItemId }) => {
    cartTotalPointsRef.current = typeof totalPoints === 'number' && Number.isFinite(totalPoints) ? totalPoints : 0
    cartLinePointsRef.current = linePointsByItemId && typeof linePointsByItemId === 'object' ? linePointsByItemId : {}
  }, [])

  const publishBackDisplaySnapshot = useCallback(() => {
    if (!user) return
    const payload = buildBackDisplayPayload(useCartStore.getState().items, {
      counterCode,
      locationCode,
      locationName,
      itemDetailsCache: cartItemDetailsCacheRef.current,
      lookupMap: productLookupMap,
    })
    publishBackDisplay(payload)
  }, [user, counterCode, locationCode, locationName, productLookupMap])

  publishBackDisplaySnapshotRef.current = publishBackDisplaySnapshot

  useEffect(() => {
    if (!user) return undefined
    publishBackDisplaySnapshot()
    const unsub = useCartStore.subscribe((state, prevState) => {
      if (state.items !== prevState.items) publishBackDisplaySnapshot()
    })
    return unsub
  }, [user, publishBackDisplaySnapshot])

  useEffect(() => {
    if (!user) return undefined
    return subscribeBackDisplay((msg) => {
      if (msg?.type !== 'request-sync') return
      const reqCc = String(msg.counterCode || '').trim()
      const reqLoc = String(msg.locationCode || '').trim()
      const myCc = String(counterCode || '').trim()
      const myLoc = String(locationCode || '').trim()
      if (reqCc && myCc && reqCc !== myCc) return
      if (reqLoc && myLoc && reqLoc !== myLoc) return
      publishBackDisplaySnapshot()
    })
  }, [user, counterCode, locationCode, publishBackDisplaySnapshot])

  const refreshOpenSessionBillDate = useCallback(async () => {
    const iso = await fetchSessionBillDateFromOpenCounter(getApiBase(), counterCode)
    if (iso === undefined) return
    if (iso) {
      setSessionBillDate(iso)
      try {
        localStorage.setItem(SESSION_BILL_DATE_KEY, iso)
      } catch (_) { }
    } else {
      setSessionBillDate('')
      try {
        localStorage.removeItem(SESSION_BILL_DATE_KEY)
      } catch (_) { }
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
      .catch(() => { })
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
      document.documentElement.requestFullscreen().catch(() => { })
    }
  }, [user])

  useEffect(() => {
    if (!user) return
    try {
      sessionStorage.setItem('pos_active_view', activeView)
    } catch (_) { }
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
        if (!systemIp) {
          setLoginError('Open using app.')
          setAuthLoading(false)
          return
        }
        const countersRes = await fetch(countersLookupUrl(getApiBase()))
        const countersData = await countersRes.json()
        const counters = (countersData.ok && Array.isArray(countersData.counters)) ? countersData.counters : []
        if (counters.length === 0) {
          setLoginError('Open using app.')
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
        } catch (_) { }
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
            } catch (_) { }
          }
        }
      }

      localStorage.setItem('pos_token', data.token)
      setToken(data.token)
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
      // New bill before setUser so cart/by-bill restore uses the correct billNo (not previous session)
      await fetchAndSetNextBillNo()
      useCartStore.getState().clearCart()
      cartFetchGenRef.current += 1
      setUser(data.user)
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
      document.exitFullscreen().catch(() => { })
    }
    localStorage.removeItem('pos_token')
    localStorage.removeItem('pos_user')
    localStorage.removeItem('pos_location_telephone')
    setLocationTelephone('')
    setToken(null)
    setUser(null)
    useCartStore.getState().clearCart()
    setProducts([])
    cartItemDetailsCacheRef.current = {}
    try {
      sessionStorage.removeItem('pos_active_view')
    } catch (_) { }
    setShowPaymentPage(false)
    goToPaymentLockRef.current = false
    setActiveView('dashboard')
    setSessionBillDate('')
    try {
      localStorage.removeItem(SESSION_BILL_DATE_KEY)
    } catch (_) { }
  }

  const fetchNextBillNoFromApi = async ({ updateState = true } = {}) => {
    const commitBillNo = (next) => {
      const n = Number(next)
      const safe = Number.isNaN(n) || n < 1 ? 1 : n
      if (updateState) {
        setBillNo(safe)
      }
      try {
        localStorage.setItem('pos_bill_no', String(safe))
      } catch (_) { }
      return safe
    }
    const bumpLocalBillNo = () => {
      const stored = Number(localStorage.getItem('pos_bill_no') || String(billNo) || '1')
      const p = Number.isNaN(stored) || stored < 1 ? 1 : stored
      return commitBillNo(p + 1)
    }
    try {
      const res = await fetch(`${getApiBase()}/api/billno/next`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flag: 0,
          counterCode: counterCode || '',
          locationCode: locationCode || '',
          ...(sessionBillDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionBillDate) ? { billDate: sessionBillDate } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.billNo != null) {
        return commitBillNo(data.billNo)
      }
      return bumpLocalBillNo()
    } catch {
      return bumpLocalBillNo()
    }
  }

  const fetchAndSetNextBillNo = async () => fetchNextBillNoFromApi({ updateState: true })

  const handleHold = async (isSuspend = false) => {
    const cart = useCartStore.getState().items
    if (cart.length === 0 || holdInFlightRef.current) return
    holdInFlightRef.current = true
    const activeForHold = cart.filter((item) => !item.void)
    const holdCartTotal = activeForHold.reduce(
      (sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0),
      0
    )
    const cartSnapshot = cart
    const heldBillNo = billNo
    try {
      if (cartSyncDebounceTimerRef.current) {
        clearTimeout(cartSyncDebounceTimerRef.current)
        cartSyncDebounceTimerRef.current = null
      }
      pendingCartSyncRef.current = cartSnapshot
      await flushCartSyncToDb(cartSnapshot).catch(() => { })

      const headers = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch(`${getApiBase()}/api/hold`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          billNo: heldBillNo,
          locationCode,
          counterCode,
          customerCode: selectedCustomer?.CUSTOMERCODE || selectedCustomer?.customercode || null,
          items: cartSnapshot,
          suspend: isSuspend,
          cartAlreadySynced: !isSuspend,
          ...(sessionBillDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionBillDate) ? { billDate: sessionBillDate } : {}),
          username: user?.username || '',
          userid: user?.userid || '',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Hold failed')

      pendingCartSyncRef.current = []
      useCartStore.getState().setSelectedCartItemId(null)
      useCartStore.getState().clearCart()
      setSelectedCustomer(null)
      cartFetchGenRef.current += 1

      const printPayload = {
        billNo: heldBillNo,
        date: sessionBillDateWithSystemTime(sessionBillDate),
        locationCode: locationCode || '',
        locationName: locationName || '',
        locationTelephone: locationTelephone || '',
        branchName: (localStorage.getItem('pos_branch_name') || '').trim() || '',
        counterCode: counterCode || '',
        counterName: counterName || '',
        userName: user?.userid ?? user?.username ?? '',
        suspend: isSuspend,
        totalAmount: holdCartTotal,
      }
      void loadThermalPrint().then(({ printHoldSlip }) => printHoldSlip(printPayload)).catch((printErr) => {
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
      })

      await fetchAndSetNextBillNo()
    } catch (err) {
      alert(err.message || 'Failed to hold bill')
    } finally {
      holdInFlightRef.current = false
    }
  }

  const handleHoldRetrieve = () => {
    setShowHoldRetrieveModal(true)
  }

  const handleHoldRetrieveSelect = (retrievedBillNo, items) => {
    const safeBillNo = Number(retrievedBillNo)
    const bill = Number.isNaN(safeBillNo) || safeBillNo < 1 ? 1 : safeBillNo
    const list = Array.isArray(items) ? items : []
    // Cancel any debounced sync for the *previous* bill so it cannot POST next-bill lines to the held billNo.
    if (cartSyncDebounceTimerRef.current) {
      clearTimeout(cartSyncDebounceTimerRef.current)
      cartSyncDebounceTimerRef.current = null
    }
    pendingCartSyncRef.current = list
    useCartStore.getState().setItems(items)
    setBillNo(bill)
    localStorage.setItem('pos_bill_no', String(bill))
    setShowHoldRetrieveModal(false)
    // Ref still points to performCartSyncToDb from the last render (previous billNo). Pass bill explicitly.
    performCartSyncToDbRef.current(list, { billNoOverride: bill })
  }

  const handleOpenHoldBill = useCallback(
    async (billNo, row) => {
      if (!billNo) return
      const safeBillNo = Number(billNo)
      if (Number.isNaN(safeBillNo) || safeBillNo < 1) return
      const loc = encodeURIComponent(locationCode || 'LOC001')
      try {
        const res = await fetch(`${getApiBase()}/api/hold/${safeBillNo}?locationCode=${loc}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Could not load held bill')
        const items = Array.isArray(data.items) ? data.items : []
        const bill = safeBillNo
        if (cartSyncDebounceTimerRef.current) {
          clearTimeout(cartSyncDebounceTimerRef.current)
          cartSyncDebounceTimerRef.current = null
        }
        pendingCartSyncRef.current = items
        useCartStore.getState().setItems(items)
        setBillNo(bill)
        localStorage.setItem('pos_bill_no', String(bill))
        useCartStore.getState().setSelectedCartItemId(null)
        setSelectedCustomer(null)
        setShowPaymentPage(false)
        performCartSyncToDbRef.current(items, { billNoOverride: bill })
        setActiveView('billing')
        void fetch(`${getApiBase()}/api/hold/${safeBillNo}?locationCode=${loc}`, { method: 'DELETE' }).catch(() => { })
      } catch (err) {
        alert(err.message || 'Failed to open held bill')
      }
    },
    [locationCode]
  )

  const handleVoidLine = () => {
    const selectedCartItemId = useCartStore.getState().selectedCartItemId
    if (!selectedCartItemId) return
    const cart = useCartStore.getState().items
    const itemToVoid = cart.find(item => sameCartLineId(getItemId(item), selectedCartItemId))
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
    const newCart = useCartStore.getState().voidSelectedLine(selectedCartItemId)
    scheduleCartSyncToDb(newCart)
  }

  const handleSuspendBill = () => {
    handleHold(true)
  }

  const requestSupervisorAction = (actionLabel, callback) => {
    if (typeof callback !== 'function') return
    pendingSupervisorCallbackRef.current = callback
    setSupervisorModalActionLabel(actionLabel)
    setShowSupervisorModal(true)
  }

  const handleSalesReturnClick = () => {
    if (useCartStore.getState().isSalesReturn) {
      requestSupervisorAction('Sale', () => useCartStore.getState().setIsSalesReturn(false))
    } else {
      requestSupervisorAction('Sales Return', () => useCartStore.getState().setIsSalesReturn(true))
    }
  }

  const handleSetPriceMode = (mode) => {
    // Turning price mode off (back to retail) needs no supervisor validation.
    if (!mode) {
      useCartStore.getState().setPriceMode(null)
      return
    }
    // Choosing Wholesale / Offers requires supervisor validation before it applies.
    const label = mode === 'wholesale' ? 'Wholesale price' : 'Offer price'
    requestSupervisorAction(label, () => useCartStore.getState().setPriceMode(mode))
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
    if (!user) return undefined

    let cancelled = false

    const loadProductsCatalog = (options = {}) => {
      const { silent = false } = options
      if (!silent) setProductsLoading(true)
      return fetch(`${getApiBase()}/api/products`)
        .then((response) => response.json())
        .then((data) => {
          if (cancelled) return
          startTransition(() => setProducts(mapProductsFromApi(data)))
        })
        .catch((error) => console.error('Error fetching products:', error))
        .finally(() => {
          if (!cancelled && !silent) setProductsLoading(false)
        })
    }

    loadProductsCatalog({ silent: false })

    const refreshTimer = setInterval(
      () => loadProductsCatalog({ silent: true }),
      CATALOG_REFRESH_INTERVAL_MS
    )

    return () => {
      cancelled = true
      clearInterval(refreshTimer)
    }
  }, [user])

  useEffect(() => {
    if (!user) return
    fetch(`${getApiBase()}/api/customers`)
      .then(res => res.json())
      .then(data => setCustomers(Array.isArray(data) ? data : []))
      .catch(() => setCustomers([]))
  }, [user])

  useEffect(() => {
    if (!user) return
    let cancelled = false
    fetch(`${getApiBase()}/api/sales-channels`)
      .then((res) => res.json().catch(() => ({})))
      .then((data) => {
        if (cancelled) return
        const list = Array.isArray(data?.channels) ? data.channels : []
        const normalized = list.map(normalizeSalesChannel).filter(Boolean)
        setSalesChannels(normalized)
        setSelectedSalesChannel((curr) => {
          if (curr && normalized.some((ch) => getSalesChannelCode(ch) === getSalesChannelCode(curr))) {
            return curr
          }
          return getDefaultSalesChannel(normalized)
        })
      })
      .catch(() => {
        if (cancelled) return
        setSalesChannels([])
        setSelectedSalesChannel(null)
      })
    return () => {
      cancelled = true
    }
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
        const normalized = normalizeDefaultCustomerPayload(data.customer)
        defaultBillingCustomerRef.current = normalized
        setSelectedCustomer((curr) => (curr ? curr : normalized))
      })
      .catch(() => { })
    return () => {
      cancelled = true
    }
  }, [user, counterCode, locationCode, billNo])

  // On load / reopen: restore cart from DB (TEMPBILLDTL) by current billNo; when billNo changes, cart must match that bill
  useEffect(() => {
    if (!user || billNo == null) return
    if (payInFlightRef.current) return undefined
    if (loginInFlightRef.current) return undefined
    let cancelled = false
    const fetchGen = cartFetchGenRef.current + 1
    cartFetchGenRef.current = fetchGen
    const params = new URLSearchParams({ billNo: String(billNo), locationCode: locationCode || '' })
    fetch(`${getApiBase()}/api/cart/by-bill?${params}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || fetchGen !== cartFetchGenRef.current) return
        const list = data?.items
        useCartStore.getState().setItems(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        if (cancelled || fetchGen !== cartFetchGenRef.current) return
        useCartStore.getState().clearCart()
      })
    return () => {
      cancelled = true
    }
  }, [user, billNo, locationCode])

  const performCartSyncToDb = useCallback((cartItems, syncOptions = null) => {
    const cust = selectedCustomer?.CUSTOMERCODE ?? selectedCustomer?.customercode ?? null
    const list = Array.isArray(cartItems) ? cartItems : []
    const syncReturnFlag =
      useCartStore.getState().isSalesReturn || list.some((i) => !i.void && Number(i.quantity) < 0)
    const overrideBill =
      syncOptions && typeof syncOptions === 'object' && syncOptions.billNoOverride != null
        ? Number(syncOptions.billNoOverride)
        : null
    const billForSync =
      overrideBill != null && !Number.isNaN(overrideBill) && overrideBill >= 1 ? overrideBill : billNo
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const body = JSON.stringify({
      billNo: billForSync,
      locationCode,
      counterCode: counterCode || '',
      customerCode: cust != null && String(cust).trim() !== '' ? String(cust).trim() : null,
      items: list,
      isSalesReturn: syncReturnFlag,
      username: user?.username || '',
      userid: user?.userid || '',
    })
    cartSyncTailRef.current = cartSyncTailRef.current
      .catch(() => { })
      .then(() =>
        fetch(`${getApiBase()}/api/cart/sync`, {
          method: 'POST',
          headers,
          body,
        }).catch((err) => console.error('Cart sync failed:', err))
      )
    return cartSyncTailRef.current
  }, [billNo, locationCode, counterCode, selectedCustomer, token, user])

  performCartSyncToDbRef.current = performCartSyncToDb

  const CART_SYNC_DEBOUNCE_MS = 800

  const scheduleCartSyncToDb = useCallback((cartItems) => {
    pendingCartSyncRef.current = cartItems
    if (cartSyncDebounceTimerRef.current) {
      clearTimeout(cartSyncDebounceTimerRef.current)
      cartSyncDebounceTimerRef.current = null
    }
    cartSyncDebounceTimerRef.current = setTimeout(() => {
      cartSyncDebounceTimerRef.current = null
      performCartSyncToDb(pendingCartSyncRef.current ?? [])
    }, CART_SYNC_DEBOUNCE_MS)
  }, [performCartSyncToDb])

  const flushCartSyncToDb = useCallback((cartOverride) => {
    if (cartSyncDebounceTimerRef.current) {
      clearTimeout(cartSyncDebounceTimerRef.current)
      cartSyncDebounceTimerRef.current = null
    }
    const list = cartOverride !== undefined && cartOverride !== null
      ? (Array.isArray(cartOverride) ? cartOverride : [])
      : (pendingCartSyncRef.current ?? [])
    pendingCartSyncRef.current = list
    return performCartSyncToDb(list)
  }, [performCartSyncToDb])

  useEffect(() => () => {
    if (cartSyncDebounceTimerRef.current) {
      clearTimeout(cartSyncDebounceTimerRef.current)
      cartSyncDebounceTimerRef.current = null
    }
  }, [])

  // Debounced cart sync when customer identity changes (not immediate flush).
  useEffect(() => {
    const cartItems = useCartStore.getState().items
    if (!user || cartItems.length === 0 || !selectedCustomer) return
    if (payInFlightRef.current) return
    scheduleCartSyncToDb(cartItems)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only when bill or customer identity changes
  }, [user, billNo, selectedCustomer?.CUSTOMERCODE, selectedCustomer?.customercode, scheduleCartSyncToDb])

  const addToCart = useCallback((product) => {
    const priceMode = useCartStore.getState().priceMode
    const adjusted = applyPriceModeToProduct(product, priceMode)
    const newCart = useCartStore.getState().addToCart(adjusted)
    scheduleCartSyncToDb(newCart)
  }, [scheduleCartSyncToDb])

  const mergeCartLine = useCallback((enrichedProduct) => {
    const newCart = useCartStore.getState().mergeCartLine(enrichedProduct)
    scheduleCartSyncToDb(newCart)
  }, [scheduleCartSyncToDb])

  const removeFromCart = useCallback((productId) => {
    const newCart = useCartStore.getState().removeFromCart(productId)
    scheduleCartSyncToDb(newCart)
  }, [scheduleCartSyncToDb])

  const updateQuantity = useCallback((productId, quantity) => {
    const newCart = useCartStore.getState().updateQuantity(productId, quantity)
    scheduleCartSyncToDb(newCart)
  }, [scheduleCartSyncToDb])

  const clearCart = useCallback(() => {
    pendingCartSyncRef.current = []
    if (cartSyncDebounceTimerRef.current) {
      clearTimeout(cartSyncDebounceTimerRef.current)
      cartSyncDebounceTimerRef.current = null
    }
    useCartStore.getState().clearCart()
    cartTotalPointsRef.current = 0
    cartLinePointsRef.current = {}
    cartItemDetailsCacheRef.current = {}
    setItemDetailsCacheResetKey((key) => key + 1)
    performCartSyncToDb([])
  }, [performCartSyncToDb])

  const handleSelectCartItem = useCallback((id) => {
    useCartStore.getState().setSelectedCartItemId(id)
  }, [])

  const handleSelectCustomer = useCallback((customer) => {
    const flag = (customer?.FLAG ?? customer?.flag ?? '').toString().trim().toUpperCase()
    if (flag === 'N') {
      alert('Customer Locked Please contact Accounts')
      return
    }
    setSelectedCustomer(customer)
  }, [])

  /** Quick-add from POS: INSERT CUSTOMER. */
  const handleRegisterQuickCustomer = async ({ name, mobile, cardNo, qid, locationCode: locFromForm }) => {
    const trimmedName = (name || '').trim()
    if (!trimmedName) throw new Error('Please enter a name.')
    const loc = String(locFromForm || locationCode || '').trim() || '001'
    const mobileStr = String(mobile || '').trim()
    const cardNoStr = String(cardNo || mobileStr || '').trim()
    const qidStr = String(qid || '').trim()

    const applyLocalAdHocCustomer = () => {
      const code = `POS${Date.now()}`
      const row = {
        CUSTOMERCODE: code,
        customercode: code,
        CUSTOMERNAME: trimmedName,
        customername: trimmedName,
        CUST_FULL_NAME: `${code} ${trimmedName}`.trim(),
        cust_full_name: `${code} ${trimmedName}`.trim(),
        MOBILE: mobileStr,
        mobile: mobileStr,
        QID: qidStr,
        qid: qidStr,
        QIDNO: qidStr,
        qidno: qidStr,
        FLAG: 'A',
        flag: 'A',
        INVOICECODE: 1,
        invoicecode: 1,
        CATEGORYNAME: 'RETAIL',
        categoryname: 'RETAIL',
        LOCATIONCODE: loc,
        locationcode: loc,
        CURRENTCREDITAMOUNT: 0,
        currentcreditamount: 0,
        CREDITLIMIT: 0,
        creditlimit: 0,
        POINTS: 0,
        points: 0,
        _posAdHoc: true,
      }
      setCustomers((prev) => {
        const list = Array.isArray(prev) ? prev : []
        return [row, ...list.filter((c) => String(c.CUSTOMERCODE ?? c.customercode ?? '') !== code)]
      })
      setSelectedCustomer(row)
    }

    try {
      const res = await fetch(`${getApiBase()}/api/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          customerName: trimmedName,
          mobile: mobileStr || null,
          qid: qidStr || null,
          locationCode: loc,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok && data?.customer) {
        const merged = normalizeDefaultCustomerPayload(data.customer)
        const code = String(merged.CUSTOMERCODE ?? merged.customercode ?? '').trim()
        const row = {
          ...merged,
          MOBILE: mobileStr || merged.MOBILE || merged.mobile || '',
          mobile: mobileStr || merged.mobile || merged.MOBILE || '',
          QID: qidStr || merged.QID || merged.qid || merged.QIDNO || merged.qidno || '',
          qid: qidStr || merged.qid || merged.QID || merged.qidno || merged.QIDNO || '',
          QIDNO: qidStr || merged.QIDNO || merged.qidno || '',
          qidno: qidStr || merged.qidno || merged.QIDNO || '',
          CATEGORYNAME: merged.CATEGORYNAME ?? merged.categoryname ?? 'RETAIL',
          categoryname: merged.categoryname ?? merged.CATEGORYNAME ?? 'RETAIL',
          LOCATIONCODE: merged.LOCATIONCODE ?? merged.locationcode ?? loc,
          locationcode: merged.locationcode ?? merged.LOCATIONCODE ?? loc,
        }
        setCustomers((prev) => {
          const list = Array.isArray(prev) ? prev : []
          return [row, ...list.filter((c) => String(c.CUSTOMERCODE ?? c.customercode ?? '') !== code)]
        })
        setSelectedCustomer(row)
        return
      }
      if (res.status === 503) {
        applyLocalAdHocCustomer()
        return
      }
      throw new Error(data?.error || `Could not save customer (${res.status})`)
    } catch (e) {
      const msg = e && typeof e.message === 'string' ? e.message : String(e)
      if (msg === 'Failed to fetch' || msg.includes('NetworkError')) {
        applyLocalAdHocCustomer()
        return
      }
      throw e instanceof Error ? e : new Error(msg)
    }
  }

  const completePaymentRef = useRef(async () => {})

  const completePayment = async (receiptData) => {
    let fetchedCurrentCredit = null
    let fetchedCreditLimit = null
    const cart = useCartStore.getState().items
    const activeItems = cart.filter((item) => !item.void)
    const payAsReturn =
      useCartStore.getState().isSalesReturn || activeItems.some((item) => Number(item.quantity) < 0)

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
      let netTotal = Number(receiptData?.total)
      if (Number.isNaN(netTotal)) {
        netTotal = activeItems.reduce(
          (sum, item) => sum + (item.price ?? 0) * (item.quantity ?? 0),
          0
        )
      }
      const billAmountAbs = Math.abs(netTotal)
      const newBalanceCredit =
        netTotal < 0
          ? fetchedCurrentCredit - billAmountAbs
          : fetchedCurrentCredit + billAmountAbs
      if (newBalanceCredit > fetchedCreditLimit) {
        alert('Contact accounts')
        return
      }
    }

    const billCustomer = selectedCustomer
    const invoiceCode = billCustomer?.INVOICECODE ?? billCustomer?.invoicecode ?? null
    const netBillAmount = receiptData?.total ?? activeItems.reduce((sum, item) => sum + (item.price ?? 0) * (item.quantity ?? 0), 0)
    const customerCode = billCustomer?.CUSTOMERCODE ?? billCustomer?.customercode ?? ''
    const customerName =
      billCustomer?.CUST_FULL_NAME ??
      billCustomer?.cust_full_name ??
      billCustomer?.CUSTOMERNAME ??
      billCustomer?.customername ??
      ''
    const pm = receiptData?.paymentMethod
    let cardAmountForDb = 0
    if (pm === 'split') {
      cardAmountForDb = Number(receiptData?.cardAmount) || 0
    } else if (pm === 'card' || pm === 'card_points') {
      cardAmountForDb = Number(receiptData?.cardAmount ?? receiptData?.total ?? netBillAmount) || 0
    } else if (pm === 'cash' || pm === 'cash_points') {
      cardAmountForDb = Number(receiptData?.cardAmount) || 0
    }

    const redemptionPoints = Math.max(0, parseInt(receiptData?.redemptionPoints, 10) || 0)
    const redemptionAmount = Math.max(0, Number(receiptData?.redemptionAmount) || 0)
    const grossTotal =
      receiptData?.grossTotal != null ? Number(receiptData.grossTotal) : netBillAmount
    const netAfterRedemption =
      redemptionAmount > 0
        ? Math.round((Number(grossTotal) - redemptionAmount) * 100) / 100
        : netBillAmount

    const billdtlLineItems = activeItems.map((item) => {
      const storeRaw = item.store ?? item.STORE ?? item.locationCode ?? item.LOCATIONCODE ?? ''
      const store = storeRaw != null && storeRaw !== '' ? String(storeRaw).replace(/\s+/g, '') : undefined
      const convRaw = item.conversionFactor ?? item.CONVERSIONFACTOR ?? item.factor ?? item.Factor
      const costRaw = item.costPrice ?? item.COSTPRICE ?? item.costprice
      const uomRaw = item.uom ?? item.UOM ?? item.BASEUOM ?? item.baseuom
      const line = {
        itemCode: String(item.id ?? item.ITEMCODE ?? item.itemCode ?? ''),
        quantity: Number(item.quantity) || 0,
        rate: Number(item.price) || 0,
        point: cartLinePointsRef.current[getItemId(item)] ?? item.point ?? item.POINT ?? 0,
        store,
      }
      if (uomRaw != null && String(uomRaw).trim() !== '') {
        line.uom = String(uomRaw).trim()
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
    })

    const buildBilldtlPayload = (billNoForSave) => ({
      locationCode: locationCode || '',
      billNo: billNoForSave,
      counterCode: counterCode || '',
      ...(sessionBillDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionBillDate) ? { billDate: sessionBillDate } : {}),
      isSalesReturn: payAsReturn,
      invoiceCode: invoiceCode != null ? invoiceCode : undefined,
      totalPoints: cartTotalPointsRef.current,
      netBillAmount: netAfterRedemption != null ? Number(netAfterRedemption) : undefined,
      redemptionPoints: redemptionPoints > 0 ? redemptionPoints : undefined,
      redemptionAmount: redemptionAmount > 0 ? redemptionAmount : undefined,
      cardAmount: cardAmountForDb,
      ...(cardAmountForDb > 0
        ? {
          cardNo: receiptData?.cardNo ?? '1234',
          cardType: receiptData?.cardType ?? 'Master',
        }
        : {}),
      customerCode: customerCode != null && customerCode !== '' ? String(customerCode).trim() : undefined,
      customerName: customerName != null && customerName !== '' ? String(customerName).trim() : undefined,
      ...(getSalesChannelCode(selectedSalesChannel) > 0
        ? {
          channelCode: getSalesChannelCode(selectedSalesChannel),
          channelDescription: getSalesChannelDescription(selectedSalesChannel),
        }
        : {}),
      ...(orderNo && String(orderNo).trim() ? { orderNo: String(orderNo).trim() } : {}),
      items: billdtlLineItems,
    })

    const headers = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const originalBillNo = billNo
    let billNoForSave = billNo

    const commitSessionBillNo = (nextBill) => {
      const n = Number(nextBill)
      if (Number.isNaN(n) || n < 1) return
      setBillNo(n)
      try {
        localStorage.setItem('pos_bill_no', String(n))
      } catch (_) { }
    }

    const finalizeFailedPay = () => {
      if (Number(billNoForSave) !== Number(originalBillNo)) {
        commitSessionBillNo(billNoForSave)
        useCartStore.getState().setItems(activeItems)
      }
      setShowPaymentPage(false)
      goToPaymentLockRef.current = false
    }

    const receiptPrintItems = mergeCartLinesForThermalReceipt(
      activeItems,
      productLookupMap,
      cartItemDetailsCacheRef.current
    )
    const buildReceiptPrintPayload = (bn) => ({
      billNo: bn,
      date: sessionBillDateWithSystemTime(sessionBillDate),
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
      items: receiptPrintItems,
      subtotal: receiptData?.subtotal ?? 0,
      total: receiptData?.grossTotal ?? receiptData?.total ?? 0,
      discount: redemptionAmount > 0 ? redemptionAmount : 0,
      redemptionPoints: redemptionPoints > 0 ? redemptionPoints : undefined,
      redemptionAmount: redemptionAmount > 0 ? redemptionAmount : undefined,
      totalPoints: cartTotalPointsRef.current,
      paymentMethod: receiptData?.paymentMethod ?? 'cash',
      cashAmount: receiptData?.cashAmount,
      cardAmount: receiptData?.cardAmount,
      amountTendered: receiptData?.amountTendered ?? 0,
      change: receiptData?.change ?? 0,
      isSalesReturn: payAsReturn,
      ...(getSalesChannelCode(selectedSalesChannel) > 0
        ? { channelDescription: getSalesChannelDescription(selectedSalesChannel) }
        : {}),
      ...(orderNo && String(orderNo).trim() ? { orderNo: String(orderNo).trim() } : {}),
    })

    let receiptPrintStarted = false
    let insertSucceeded = false

    const handleReceiptPrintError = (printErr) => {
      console.error('[Receipt] Print failed:', printErr)
      const msg = printErr?.message ?? String(printErr)
      const savedPrefix = insertSucceeded ? 'Payment saved but ' : ''
      if (msg.includes('QZ Tray is not running')) {
        alert(`${savedPrefix}receipt not printed. Please start QZ Tray (https://qz.io).`)
      } else if (!msg.includes('No printers')) {
        alert(`${savedPrefix}receipt print failed: ${msg}`)
      }
    }

    const startReceiptPrint = (bn) => {
      receiptPrintStarted = true
      void loadThermalPrint()
        .then(({ printReceipt }) => printReceipt(buildReceiptPrintPayload(bn)))
        .catch(handleReceiptPrintError)
    }

    const notifyInsertFailed = (message) => {
      const base = message || 'Payment could not be saved. Please try again.'
      const extra = receiptPrintStarted
        ? ' A receipt may have printed — void it and do not complete the sale until you retry.'
        : ''
      alert(base + extra)
    }

    payInFlightRef.current = true
    let insertBillMarkedPaid = false
    let insertOk = false
    const MAX_BILL_INSERT_ATTEMPTS = 2

    try {
      try {
        for (let attempt = 0; attempt < MAX_BILL_INSERT_ATTEMPTS; attempt++) {
          if (attempt === 0) {
            startReceiptPrint(billNoForSave)
          }

          const res = await fetch(`${getApiBase()}/api/billdtl/insert`, {
            method: 'POST',
            headers,
            body: JSON.stringify(buildBilldtlPayload(billNoForSave)),
          })
          const data = await res.json().catch(() => ({}))
          insertOk = res.ok && data.ok === true
          insertBillMarkedPaid = data.billMarkedPaid === true

          if (insertOk) {
            break
          }

          const isDuplicateBill =
            res.status === 409 &&
            (data.code === 'BILL_ALREADY_PAID_OTHER_SESSION' || data.code === 'BILL_ALREADY_PAID')

          if (isDuplicateBill && attempt < MAX_BILL_INSERT_ATTEMPTS - 1) {
            const newBillNo = await fetchNextBillNoFromApi({ updateState: false })
            if (newBillNo == null || Number.isNaN(Number(newBillNo))) {
              notifyInsertFailed('Could not allocate a new bill number. Please try again.')
              finalizeFailedPay()
              return
            }
            billNoForSave = newBillNo
            performCartSyncToDb(activeItems, { billNoOverride: newBillNo })
            await cartSyncTailRef.current.catch(() => { })
            continue
          }

          if (isDuplicateBill) {
            notifyInsertFailed(
              data.error ||
                (data.code === 'BILL_ALREADY_PAID_OTHER_SESSION'
                  ? 'This bill number was already paid on another counter. Payment could not be completed.'
                  : 'This bill number is already paid. Payment could not be completed.')
            )
          } else {
            notifyInsertFailed(data.error)
          }
          console.error('[BILLDTL] insert failed:', data.error || res.status)
          finalizeFailedPay()
          return
        }
      } catch (e) {
        console.error('[BILLDTL] insert error:', e)
        notifyInsertFailed()
        finalizeFailedPay()
        return
      }

      if (!insertOk) {
        notifyInsertFailed()
        finalizeFailedPay()
        return
      }

      insertSucceeded = true

      if (billNoForSave !== originalBillNo) {
        commitSessionBillNo(billNoForSave)
        startReceiptPrint(billNoForSave)
        alert(
          `Bill #${originalBillNo} was already used. Payment saved as Bill #${billNoForSave}. A corrected receipt is printing.`
        )
      }

    // Mark paid before /billno/next: backend reuses open (FLAG='N') rows per counter until paid.
    const paidUrl = `${getApiBase()}/api/billno/paid`
    const paidBody = JSON.stringify({ billNo: billNoForSave, counterCode: counterCode || '' })
    const paidFetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: paidBody,
    }

    const paidPromise = fetch(paidUrl, paidFetchOpts)
      .then((r) => {
        if (!r.ok) console.warn('[BILLNO/paid] non-OK:', r.status)
        return r.text().catch(() => '')
      })
      .catch((e) => console.warn('[BILLNO/paid] fetch error:', e))

    let creditSettlementPromise = Promise.resolve()
    if (receiptData?.paymentMethod === 'credit') {
      const custCode = selectedCustomer?.CUSTOMERCODE ?? selectedCustomer?.customercode ?? ''
      creditSettlementPromise = fetch(`${getApiBase()}/api/creditsettlement`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          locationCode: locationCode || '',
          customerCode: custCode,
          billNo: billNoForSave,
          billAmount: receiptData.total ?? 0,
          billDate:
            sessionBillDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionBillDate)
              ? sessionBillDate
              : new Date().toISOString().slice(0, 10),
          isSalesReturn: payAsReturn,
        }),
      })
        .then((r) => {
          if (!r.ok) console.warn('[CreditSettlement] non-OK:', r.status)
          return r.text().catch(() => '')
        })
        .catch((e) => {
          console.error('[CreditSettlement] error:', e)
        })
    }

    if (insertBillMarkedPaid) {
      void paidPromise
    } else {
      await paidPromise
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

    const totalAmt = receiptData?.amountTendered ?? receiptData?.total ?? 0
    const changeAmt = receiptData?.change ?? 0
    setLastBillAmount(totalAmt)
    setLastBillChange(changeAmt)
    try {
      localStorage.setItem('pos_last_bill_amount', String(totalAmt))
      localStorage.setItem('pos_last_bill_change', String(changeAmt))
    } catch (_) { }

    clearCart()
    useCartStore.getState().setIsSalesReturn(false)
    setSelectedCustomer(null)
    setOrderNo('')
    setShowPaymentPage(false)
    goToPaymentLockRef.current = false

    // Credit settlement can be slower than /paid; do not block return to billing.
    void creditSettlementPromise
    void fetchAndSetNextBillNo()
    } finally {
      payInFlightRef.current = false
    }
  }

  completePaymentRef.current = completePayment

  const goToPayment = useCallback(() => {
    const cart = useCartStore.getState().items
    if (cart.length === 0) return
    flushCartSyncToDb(cart)
    const invoiceCode = selectedCustomer?.INVOICECODE ?? selectedCustomer?.invoicecode ?? null
    const isCreditCustomer = invoiceCode === 2 || invoiceCode === '2'
    if (selectedCustomer && isCreditCustomer) {
      if (creditCheckoutInFlightRef.current) return
      creditCheckoutInFlightRef.current = true
      setCreditCheckoutLoading(true)
      const activeItems = cart.filter((item) => !item.void)
      const subtotal = activeItems.reduce((sum, item) => sum + (item.price ?? 0) * (item.quantity ?? 0), 0)

      const total = subtotal
      completePaymentRef.current({
        paymentMethod: 'credit',
        amountTendered: 0,
        change: 0,
        total,
        subtotal,
        items: activeItems,
      }).finally(() => {
        creditCheckoutInFlightRef.current = false
        setCreditCheckoutLoading(false)
      })
      return
    }
    if (goToPaymentLockRef.current) return
    goToPaymentLockRef.current = true
    setShowPaymentPage(true)
  }, [selectedCustomer, flushCartSyncToDb])

  const backFromPayment = () => {
    goToPaymentLockRef.current = false
    setShowPaymentPage(false)
  }

  const showBilling = activeView === 'billing'

  if (authLoading) {
    return (
      <KeyboardProvider>
        <div className="app auth-loading">
          <div className="loading-spinner">Loading...</div>
        </div>
        <Suspense fallback={null}>
          <OnScreenKeyboard />
        </Suspense>
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
        <Suspense fallback={null}>
          <OnScreenKeyboard />
        </Suspense>
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
            <h1>
              POS System
              {activeView === 'billing' && (
                <span className="header-last-bill-info" aria-live="polite">
                  <span>Last Bill: <strong>QAR {lastBillAmount.toFixed(2)}</strong></span>
                  <span className="divider">|</span>
                  <span>Balance: <strong>QAR {lastBillChange.toFixed(2)}</strong></span>
                </span>
              )}
            </h1>
            <div className="header-pos-info">
              <span>Location code: {locationCode}</span>
              <span>Location name: {locationName}</span>
              <span>Bill date: {formatBillDateEnGbFromIso(sessionBillDate)}</span>
              <span>Counter: {counterCode} {counterName}</span>
            </div>
            <div className="header-info">
              <TopBarClock />
              <span className="role-badge" title={`Logged in as ${roleLabel}`}>
                {displayName} ({roleLabel})
              </span>
            </div>
          </header>
          <div className="content-wrapper">
            {showPaymentPage ? (
              <Suspense fallback={<ViewFallback label="Loading payment…" />}>
                <PaymentView
                  selectedCustomer={selectedCustomer}
                  apiBase={getApiBase()}
                  billNo={billNo}
                  locationCode={locationCode}
                  onComplete={completePayment}
                  onBack={backFromPayment}
                />
              </Suspense>
            ) : (
              <>
                {activeView === 'dashboard' && (
                  <Suspense fallback={<ViewFallback label="Loading dashboard…" />}>
                    <Dashboard
                      apiBase={getApiBase()}
                      locationCode={locationCode}
                      locationName={locationName}
                      counterCode={counterCode}
                      counterName={counterName}
                      user={user}
                      counterSessionBillDate={sessionBillDate}
                    />
                  </Suspense>
                )}
                {showBilling && (
                  <BillingView
                    products={products}
                    productLookupMap={productLookupMap}
                    productsReady={productsReady}
                    itemDetailsCacheResetKey={itemDetailsCacheResetKey}
                    onAddToCart={addToCart}
                    onMergeCartLine={mergeCartLine}
                    apiBase={getApiBase()}
                    customers={customers}
                    selectedCustomer={selectedCustomer}
                    onSelectCustomer={handleSelectCustomer}
                    salesChannels={salesChannels}
                    selectedSalesChannel={selectedSalesChannel}
                    onSelectSalesChannel={setSelectedSalesChannel}
                    onUpdateQuantity={updateQuantity}
                    onRemove={removeFromCart}
                    onCheckout={goToPayment}
                    checkoutLoading={creditCheckoutLoading}
                    onCartPointsSnapshotChange={commitCartPointsSnapshot}
                    onItemDetailsCacheChange={commitCartItemDetailsCacheForPrint}
                    onHold={() => requestSupervisorAction('Hold bill', handleHold)}
                    onHoldRetrieve={handleHoldRetrieve}
                    onSelectCartItem={handleSelectCartItem}
                    onVoidLine={() => requestSupervisorAction('Void line', handleVoidLine)}
                    onSuspendBill={() => requestSupervisorAction('Suspend bill', handleSuspendBill)}
                    onToggleSalesReturn={handleSalesReturnClick}
                    onSetPriceMode={handleSetPriceMode}
                    onRequestQty={(openQtyModal) => requestSupervisorAction('Quantity', openQtyModal)}
                    locationCode={locationCode}
                    counterCode={counterCode}
                    counterName={counterName}
                    billNo={billNo}
                    onRegisterQuickCustomer={handleRegisterQuickCustomer}
                    orderNo={orderNo}
                    onOrderNoChange={setOrderNo}
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
                  <Suspense fallback={<ViewFallback label="Loading counter…" />}>
                    <CounterOpen
                      apiBase={getApiBase()}
                      token={token}
                      locationCode={locationCode}
                      locationName={locationName}
                      user={user}
                      counterCode={counterCode}
                      counterName={counterName}
                      onCounterOperationsChanged={refreshOpenSessionBillDate}
                      onOpenHoldBill={handleOpenHoldBill}
                    />
                  </Suspense>
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
        <Suspense fallback={null}>
          <OnScreenKeyboard />
        </Suspense>
      </div>
    </KeyboardProvider>
  )
}

export default App
