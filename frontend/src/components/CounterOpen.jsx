import { useState, useEffect, useCallback, useMemo } from 'react'
import { mergeCounterCloseSource, printCounterCloseReport } from '../services/thermalPrint'
import '../styles/CounterSetup.css'

function todayStr() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function formatCloseConfirmDateTime() {
  return new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}

function parseMoney(v) {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const s = String(v).trim().replace(/,/g, '')
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : 0
}

/** First own key with a non-empty value wins (nested summary + snake_case). */
function pickMoney(row, ...keys) {
  if (!row || typeof row !== 'object') return 0
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, k)) continue
    const v = row[k]
    if (v !== undefined && v !== null && v !== '') return parseMoney(v)
  }
  return 0
}

function pickMoneyOptional(row, ...keys) {
  if (!row || typeof row !== 'object') return undefined
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, k)) continue
    const v = row[k]
    if (v !== undefined && v !== null && v !== '') return parseMoney(v)
  }
  return undefined
}

function heldBillNo(row) {
  const n = row?.BILLNO ?? row?.billNo
  if (n == null || n === '') return null
  return String(n).trim()
}

function heldDateRaw(row) {
  return row?.HELDDATE ?? row?.heldDate ?? row?.BILLDATE ?? row?.billDate ?? null
}

function heldMatchesBillDate(row, isoYyyyMmDd) {
  if (!isoYyyyMmDd) return true
  const hd = heldDateRaw(row)
  if (!hd) return true
  return String(hd).slice(0, 10) === String(isoYyyyMmDd).trim()
}

function heldLineCount(row) {
  const n = row?.lineCount ?? row?.LINECOUNT
  if (n != null && n !== '') return Number(n) || 0
  const items = row?.items
  return Array.isArray(items) ? items.length : 0
}

function heldEstimatedTotal(row) {
  const t = row?.estimatedTotal ?? row?.ESTIMATEDTOTAL
  if (t != null && t !== '') return Number(t) || 0
  const items = row?.items
  if (!Array.isArray(items)) return 0
  return items.reduce((sum, it) => {
    const q = Number(it?.quantity ?? it?.qty ?? 0) || 0
    const p = Number(it?.price ?? it?.PRICE ?? 0) || 0
    return sum + q * p
  }, 0)
}

function formatHeldWhen(hd) {
  if (!hd) return '—'
  const s = String(hd)
  if (s.includes('T')) {
    const [d, rest] = s.split('T')
    const t = (rest || '').replace(/Z$/i, '').slice(0, 8)
    return t ? `${d} ${t}` : d
  }
  return s.length > 19 ? s.slice(0, 19) : s
}

function holdItemCode(it) {
  return String(it?.ITEMCODE ?? it?.itemCode ?? it?.id ?? '').trim() || '—'
}

function holdItemName(it) {
  return String(it?.name ?? it?.NAME ?? '').trim() || '—'
}

function holdItemQty(it) {
  return Number(it?.quantity ?? it?.qty ?? it?.QUANTITY ?? 0) || 0
}

function holdItemRate(it) {
  return Number(it?.price ?? it?.rate ?? it?.RATE ?? 0) || 0
}

function holdItemLineTotal(it) {
  return holdItemQty(it) * holdItemRate(it)
}

function holdItemsTotal(items) {
  if (!Array.isArray(items)) return 0
  return items.reduce((sum, it) => sum + holdItemLineTotal(it), 0)
}

/** Normalize API payload and derive checks: net = sales − returns; cash approx = net − card(sales) + card(returns) − credit − voucher */
function buildSummaryView(data) {
  if (!data || data.ok === false) return null
  const row = mergeCounterCloseSource(data)
  const totalSales = pickMoney(row, 'totalSales', 'total_sales', 'TOTALSALES', 'TotalSales')
  const totalReturns = pickMoney(row, 'totalReturns', 'total_returns', 'TOTALRETURNS', 'TotalReturns')
  const netTotal = pickMoney(row, 'netTotal', 'net_total', 'NETTOTAL', 'NetTotal')
  const netCalc = Math.round((totalSales - totalReturns) * 100) / 100
  const totalCardAmount = pickMoney(row, 'totalCardAmount', 'total_card_amount', 'TOTALCARDAMOUNT', 'TotalCardAmount')
  const totalCardReturns = pickMoney(row, 'totalCardReturns', 'total_card_returns', 'TOTALCARDRETURNS', 'TotalCardReturns')
  const discountTotal = pickMoney(row, 'discountTotal', 'discount_total', 'DISCOUNTTOTAL', 'DiscountTotal')
  const creditTotal = pickMoney(row, 'creditTotal', 'credit_total', 'CREDITTOTAL', 'CreditTotal')
  const voucherTotal = pickMoney(row, 'voucherTotal', 'voucher_total', 'VOUCHERTOTAL', 'VoucherTotal')
  const cashInBox = pickMoney(row, 'cashInBox', 'cash_in_box', 'CASHINBOX', 'CashInBox')
  const cashApprox = Math.round((netTotal - totalCardAmount + totalCardReturns - creditTotal - voucherTotal) * 1000) / 1000
  return {
    date: row.date ?? data.date,
    counterCode: row.counterCode ?? row.counter_code ?? data.counterCode,
    locationCode: row.locationCode ?? row.location_code ?? data.locationCode,
    saleCount: Number(row.saleCount ?? row.sale_count ?? data.saleCount) || 0,
    returnCount: Number(row.returnCount ?? row.return_count ?? data.returnCount) || 0,
    totalSales,
    totalReturns,
    netTotal,
    netCalc,
    netMatches: Math.abs(netTotal - netCalc) < 0.02,
    discountTotal,
    creditTotal,
    totalCardAmount,
    totalCardReturns,
    voucherTotal,
    cashInBox,
    cashApprox,
    /** Server uses per-bill NET−CARD sums; this is the aggregate shortcut (should be close). */
    cashMatchesApprox: Math.abs(cashInBox - cashApprox) < 0.05,
    note: row.note ?? data.note,
    calculationNote: row.calculationNote ?? row.calculation_note ?? data.calculationNote,
  }
}

function CounterOpen({
  apiBase,
  token,
  locationCode,
  locationName = '',
  user = null,
  counterCode: counterCodeFromParent = '',
  counterName: counterNameFromParent = '',
  onCounterOperationsChanged,
  onOpenHoldBill,
}) {
  const [date, setDate] = useState(todayStr())
  const [shiftCode, setShiftCode] = useState('')
  const [counters, setCounters] = useState([])
  const [loading, setLoading] = useState(false)
  const [statusLoading, setStatusLoading] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const [isClosed, setIsClosed] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [reportSummary, setReportSummary] = useState(null)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState(null)
  const [printNotice, setPrintNotice] = useState(null)
  const [openedDates, setOpenedDates] = useState([])
  const [openedDatesLoading, setOpenedDatesLoading] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [closeConfirmTimeLabel, setCloseConfirmTimeLabel] = useState('')
  const [closing, setClosing] = useState(false)
  const [heldBills, setHeldBills] = useState([])
  const [suspendedBills, setSuspendedBills] = useState([])
  const [pendingBillsLoading, setPendingBillsLoading] = useState(false)
  const [pendingBillsError, setPendingBillsError] = useState(null)
  const [holdDetailBillNo, setHoldDetailBillNo] = useState(null)
  const [holdDetailHeldWhen, setHoldDetailHeldWhen] = useState('')
  const [holdDetailItems, setHoldDetailItems] = useState([])
  const [holdDetailLoading, setHoldDetailLoading] = useState(false)
  const [holdDetailError, setHoldDetailError] = useState(null)

  const systemIp = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('pos_system_ip') || '' : ''
  const counterCodeFromRow = counters[0] ? (counters[0].counterCode ?? counters[0].COUNTERCODE ?? '').toString().trim() : ''
  const counterCodeLs = typeof localStorage !== 'undefined' ? (localStorage.getItem('pos_counter_code') || '').trim() : ''
  /** Row from /api/counters wins; until then use App/localStorage so status/opened-dates are not queried with an empty code (wrong DB match). */
  const counterCode = (counterCodeFromRow || String(counterCodeFromParent || '').trim() || counterCodeLs).trim()

  const fetchCounters = useCallback(() => {
    if (!apiBase) return
    const systemName = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('pos_system_name') || '' : ''
    const params = new URLSearchParams()
    if (systemIp) params.set('systemIp', systemIp)
    if (systemName) params.set('systemName', systemName)
    const qs = params.toString()
    const url = qs ? `${apiBase}/api/counters?${qs}` : `${apiBase}/api/counters`
    setLoading(true)
    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        if (data.ok && Array.isArray(data.counters)) setCounters(data.counters)
        else setCounters([])
      })
      .catch(() => setCounters([]))
      .finally(() => setLoading(false))
  }, [apiBase, systemIp])

  const fetchStatus = useCallback(() => {
    if (!apiBase || !date || !counterCode) return
    const params = new URLSearchParams({ date })
    if (systemIp) params.set('systemIp', systemIp)
    if (counterCode) params.set('counterCode', counterCode)
    setStatusLoading(true)
    fetch(`${apiBase}/api/counter-operations/status?${params}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.ok) {
          setIsOpen(!!data.open)
          setIsClosed(!!data.closed)
        } else {
          setIsOpen(false)
          setIsClosed(false)
        }
      })
      .catch(() => { setIsOpen(false); setIsClosed(false) })
      .finally(() => setStatusLoading(false))
  }, [apiBase, date, systemIp, counterCode])

  const fetchOpenedDates = useCallback(() => {
    if (!apiBase || !counterCode) return
    const params = new URLSearchParams()
    params.set('counterCode', counterCode)
    setOpenedDatesLoading(true)
    fetch(`${apiBase}/api/counter-operations/opened-dates?${params}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.ok && Array.isArray(data.dates)) {
          setOpenedDates(data.dates)
          // Set default date to last opened date if available
          if (data.lastOpenedDate) {
            setDate(data.lastOpenedDate)
          }
        } else {
          setOpenedDates([])
        }
      })
      .catch(() => setOpenedDates([]))
      .finally(() => setOpenedDatesLoading(false))
  }, [apiBase, counterCode])

  useEffect(() => {
    fetchCounters()
  }, [fetchCounters])

  useEffect(() => {
    fetchOpenedDates()
  }, [fetchOpenedDates])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  useEffect(() => {
    setReportSummary(null)
    setReportError(null)
    setPrintNotice(null)
  }, [date, counterCode, locationCode])

  const loadPendingBills = useCallback(async () => {
    if (!apiBase || !date) return { held: [], suspended: [] }
    setPendingBillsLoading(true)
    setPendingBillsError(null)
    const headers = {}
    if (token) headers.Authorization = `Bearer ${token}`
    try {
      const holdParams = new URLSearchParams()
      if (locationCode) holdParams.set('locationCode', locationCode)
      if (counterCode) holdParams.set('counterCode', counterCode)
      const suspParams = new URLSearchParams({ date })
      if (locationCode) suspParams.set('locationCode', locationCode)
      if (counterCode) suspParams.set('counterCode', counterCode)
      const holdQs = holdParams.toString()
      const [holdRes, suspRes] = await Promise.all([
        fetch(`${apiBase}/api/hold${holdQs ? `?${holdQs}` : ''}`, { headers }),
        fetch(`${apiBase}/api/bills/suspended-by-date?${suspParams}`, { headers }),
      ])
      const holdData = await holdRes.json().catch(() => null)
      const suspData = await suspRes.json().catch(() => ({}))
      if (!holdRes.ok) {
        const errObj = holdData && typeof holdData === 'object' && !Array.isArray(holdData) ? holdData : {}
        throw new Error(errObj.error || `Failed to load held bills (${holdRes.status})`)
      }
      if (!suspRes.ok || !suspData.ok) {
        throw new Error(suspData.error || `Failed to load suspended bills (${suspRes.status})`)
      }
      const held = Array.isArray(holdData) ? holdData : []
      const suspended = Array.isArray(suspData.bills) ? suspData.bills : []
      setHeldBills(held)
      setSuspendedBills(suspended)
      return { held, suspended }
    } catch (e) {
      setHeldBills([])
      setSuspendedBills([])
      setPendingBillsError(e?.message || String(e))
      return { held: [], suspended: [] }
    } finally {
      setPendingBillsLoading(false)
    }
  }, [apiBase, date, locationCode, counterCode, token])

  useEffect(() => {
    loadPendingBills()
  }, [loadPendingBills])

  useEffect(() => {
    if (!showCloseConfirm) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !closing) setShowCloseConfirm(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showCloseConfirm, closing])

  const closeHoldDetail = useCallback(() => {
    if (holdDetailLoading) return
    setHoldDetailBillNo(null)
    setHoldDetailHeldWhen('')
    setHoldDetailItems([])
    setHoldDetailError(null)
  }, [holdDetailLoading])

  const openHoldDetail = useCallback(
    async (row) => {
      const noStr = heldBillNo(row)
      if (!noStr || !apiBase) return
      const billNoNum = parseInt(noStr, 10)
      if (Number.isNaN(billNoNum) || billNoNum < 1) return
      if (typeof onOpenHoldBill === 'function') {
        onOpenHoldBill(billNoNum, row)
        return
      }
      const hd = heldDateRaw(row)
      setHoldDetailBillNo(billNoNum)
      setHoldDetailHeldWhen(formatHeldWhen(hd))
      setHoldDetailItems([])
      setHoldDetailError(null)
      setHoldDetailLoading(true)
      const headers = {}
      if (token) headers.Authorization = `Bearer ${token}`
      const loc = encodeURIComponent(locationCode || 'LOC001')
      try {
        const res = await fetch(`${apiBase}/api/hold/${billNoNum}?locationCode=${loc}`, { headers })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Could not load held bill')
        setHoldDetailItems(Array.isArray(data.items) ? data.items : [])
      } catch (e) {
        const fallbackItems = Array.isArray(row?.items) ? row.items : []
        if (fallbackItems.length > 0) {
          setHoldDetailItems(fallbackItems)
          setHoldDetailError(null)
        } else {
          setHoldDetailError(e?.message || String(e))
        }
      } finally {
        setHoldDetailLoading(false)
      }
    },
    [apiBase, locationCode, onOpenHoldBill, token]
  )

  useEffect(() => {
    if (holdDetailBillNo == null) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !holdDetailLoading) closeHoldDetail()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [holdDetailBillNo, holdDetailLoading, closeHoldDetail])

  const loadDailySummary = useCallback(async () => {
    if (!apiBase || !date) return null
    const params = new URLSearchParams({ date })
    if (counterCode) params.set('counterCode', counterCode)
    if (locationCode) params.set('locationCode', locationCode)
    const headers = {}
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(`${apiBase}/api/counter-operations/daily-summary?${params}`, { headers })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data.error || `Summary request failed (${res.status})`)
    }
    if (!data.ok) throw new Error(data.error || 'Could not load summary')
    return data
  }, [apiBase, date, counterCode, locationCode, token])

  const summaryView = useMemo(() => buildSummaryView(reportSummary), [reportSummary])

  const filteredHeld = useMemo(
    () => heldBills.filter((row) => heldBillNo(row) && heldMatchesBillDate(row, date)),
    [heldBills, date]
  )

  const filteredSuspended = useMemo(() => suspendedBills, [suspendedBills])

  const hasHoldBills = filteredHeld.length > 0
  const holdBlockMessage =
    filteredHeld.length === 1
      ? 'Cannot close counter: 1 hold bill is still open. Retrieve and complete or clear it first.'
      : `Cannot close counter: ${filteredHeld.length} hold bills are still open. Retrieve and complete or clear them first.`

  const makeClosePrintData = useCallback(
    (summary, slipKind) => {
      let s = {}
      if (summary && typeof summary === 'object') {
        try {
          s = JSON.parse(JSON.stringify(summary))
        } catch {
          s = { ...summary }
        }
      }
      const branchName = typeof localStorage !== 'undefined' ? (localStorage.getItem('pos_branch_name') || '').trim() : ''
      const locationTelephone =
        typeof localStorage !== 'undefined' ? (localStorage.getItem('pos_location_telephone') || '').trim() : ''
      const closedBy = (user?.username || user?.userid || '').toString().trim()
      const row = mergeCounterCloseSource(s)
      const loggedCashier = String(row.loggedCashier ?? row.logged_cashier ?? '').trim()
      const cashierDisplay = loggedCashier
      const cardByType = row.cardByType ?? row.card_by_type
      return {
        date,
        counterCode,
        locationCode: locationCode || '',
        locationName: locationName || '',
        branchName: branchName || undefined,
        locationTelephone: locationTelephone || undefined,
        totalSales: pickMoney(row, 'totalSales', 'total_sales', 'TOTALSALES', 'TotalSales'),
        totalReturns: pickMoney(row, 'totalReturns', 'total_returns', 'TOTALRETURNS', 'TotalReturns'),
        netTotal: pickMoney(row, 'netTotal', 'net_total', 'NETTOTAL', 'NetTotal'),
        closedBy,
        cashierDisplay,
        totalCardAmount: pickMoney(row, 'totalCardAmount', 'total_card_amount', 'TOTALCARDAMOUNT', 'TotalCardAmount'),
        totalCardReturns: pickMoney(row, 'totalCardReturns', 'total_card_returns', 'TOTALCARDRETURNS', 'TotalCardReturns'),
        cardByType: cardByType && typeof cardByType === 'object' ? cardByType : {},
        discountTotal: pickMoney(row, 'discountTotal', 'discount_total', 'DISCOUNTTOTAL', 'DiscountTotal'),
        creditTotal: pickMoney(row, 'creditTotal', 'credit_total', 'CREDITTOTAL', 'CreditTotal'),
        onlineTotal: pickMoney(row, 'onlineTotal', 'online_total', 'ONLINETOTAL', 'OnlineTotal'),
        voucherTotal: pickMoney(row, 'voucherTotal', 'voucher_total', 'VOUCHERTOTAL', 'VoucherTotal'),
        cashInBox: pickMoneyOptional(row, 'cashInBox', 'cash_in_box', 'CASHINBOX', 'CashInBox'),
        crReconciled: pickMoney(
          row,
          'crReconciled',
          'cr_reconciled',
          'creditReturnTotal',
          'credit_return_total',
          'CREDITRETURNTOTAL'
        ),
        slipKind,
      }
    },
    [date, counterCode, locationCode, locationName, user]
  )

  const checkReport = () => {
    setReportError(null)
    setPrintNotice(null)
    setReportLoading(true)
    loadDailySummary()
      .then(async (data) => {
        setReportSummary(data)
        try {
          await printCounterCloseReport(makeClosePrintData(data, 'check'))
        } catch (printErr) {
          setPrintNotice(printErr?.message || 'Time check copy could not be printed.')
        }
      })
      .catch((err) => {
        setReportSummary(null)
        setReportError(err.message || 'Summary failed')
      })
      .finally(() => setReportLoading(false))
  }

  const refreshSummaryOnly = () => {
    setReportError(null)
    setPrintNotice(null)
    setReportLoading(true)
    loadDailySummary()
      .then((data) => setReportSummary(data))
      .catch((err) => {
        setReportSummary(null)
        setReportError(err.message || 'Summary failed')
      })
      .finally(() => setReportLoading(false))
  }

  const postOpen = () => {
    if (!apiBase || !date) return
    setActionError(null)
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    fetch(`${apiBase}/api/counter-operations/open`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ date, counterCode: counterCode || undefined, locationCode: locationCode || undefined }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.ok) {
          fetchStatus()
          if (typeof onCounterOperationsChanged === 'function') onCounterOperationsChanged()
        } else setActionError(data.error || 'Open failed')
      })
      .catch((err) => setActionError(err.message || 'Open failed'))
  }

  const postClose = () => {
    if (!apiBase || !date || closing) return
    if (hasHoldBills) {
      setActionError(holdBlockMessage)
      setShowCloseConfirm(false)
      return
    }
    setActionError(null)
    setPrintNotice(null)
    setClosing(true)
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    fetch(`${apiBase}/api/counter-operations/close`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ date, counterCode: counterCode || undefined, locationCode: locationCode || undefined }),
    })
      .then((res) => res.json())
      .then(async (data) => {
        if (!data.ok) {
          setActionError(data.error || 'Close failed')
          if (data.holdBillCount > 0) loadPendingBills()
          return
        }
        await fetchStatus()
        if (typeof onCounterOperationsChanged === 'function') onCounterOperationsChanged()
        try {
          const summary = await loadDailySummary()
          setReportSummary(summary)
          await printCounterCloseReport(makeClosePrintData(summary, 'final'))
        } catch (printErr) {
          setPrintNotice(printErr?.message || 'Close saved; final receipt could not be printed.')
        }
      })
      .catch((err) => setActionError(err.message || 'Close failed'))
      .finally(() => {
        setClosing(false)
        setShowCloseConfirm(false)
      })
  }

  const openCloseConfirm = async () => {
    if (!apiBase || !date) return
    setActionError(null)
    const { held } = await loadPendingBills()
    const heldForDate = (held || []).filter((row) => heldBillNo(row) && heldMatchesBillDate(row, date))
    if (heldForDate.length > 0) {
      const msg =
        heldForDate.length === 1
          ? 'Cannot close counter: 1 hold bill is still open. Retrieve and complete or clear it first.'
          : `Cannot close counter: ${heldForDate.length} hold bills are still open. Retrieve and complete or clear them first.`
      setActionError(msg)
      return
    }
    setCloseConfirmTimeLabel(formatCloseConfirmDateTime())
    setShowCloseConfirm(true)
  }

  const dismissCloseConfirm = () => {
    if (closing) return
    setShowCloseConfirm(false)
  }

  return (
    <div className="counter-setup">
      <div className="counter-open-card">
        <div className="counter-setup-header">
          <h2>Counter Open</h2>
        </div>

        <section className="counter-setup-section">
          <div className="counter-setup-row">
            <label className="counter-setup-label" htmlFor="counter-open-date">Date of open</label>
            <input
              id="counter-open-date"
              type="date"
              className="counter-setup-input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="counter-setup-row">
            <label className="counter-setup-label" htmlFor="counter-open-shift">Shift code</label>
            <input
              id="counter-open-shift"
              type="text"
              className="counter-setup-input"
              value={shiftCode}
              onChange={(e) => setShiftCode(e.target.value)}
              placeholder="e.g. M, A, B"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="counter-setup-row counter-open-actions">
            {statusLoading ? (
              <span className="counter-setup-muted">Checking status…</span>
            ) : isOpen ? (
              <>
                <button
                  type="button"
                  className="counter-setup-save-btn counter-setup-secondary"
                  onClick={checkReport}
                  disabled={reportLoading || !counterCode}
                  title={!counterCode ? 'Counter code required for this terminal' : 'Print time-check copy and show today’s summary; then use Close for the official final print'}
                >
                  {reportLoading ? 'Loading…' : 'Copy print'}
                </button>
                <button
                  type="button"
                  className="counter-setup-save-btn counter-close-btn"
                  onClick={openCloseConfirm}
                  disabled={hasHoldBills || pendingBillsLoading}
                  title={
                    hasHoldBills
                      ? holdBlockMessage
                      : pendingBillsLoading
                        ? 'Checking hold bills…'
                        : 'Close counter for this business day'
                  }
                >
                  Close
                </button>
              </>
            ) : isClosed ? (
              <button type="button" className="counter-setup-save-btn counter-setup-readonly" disabled>
                Already closed
              </button>
            ) : (
              <button type="button" className="counter-setup-save-btn" onClick={postOpen}>
                Open
              </button>
            )}
            <button
              type="button"
              className="counter-setup-save-btn counter-setup-secondary"
              onClick={() => {
                fetchCounters()
                fetchOpenedDates()
                fetchStatus()
                loadPendingBills()
              }}
            >
              Refresh
            </button>
          </div>
          {actionError && <p className="login-error" style={{ marginTop: 8 }}>{actionError}</p>}
          {printNotice && <p className="counter-setup-muted" style={{ marginTop: 8, color: '#b45309' }}>{printNotice}</p>}
          {reportError && <p className="login-error" style={{ marginTop: 8 }}>{reportError}</p>}
          {summaryView && (
            <div className="counter-close-report">
              <div className="counter-close-report-head">
                <h4 className="counter-close-report-title">Day summary</h4>
                <button
                  type="button"
                  className="counter-setup-save-btn counter-setup-secondary"
                  style={{ padding: '6px 12px', fontSize: 13 }}
                  onClick={refreshSummaryOnly}
                  disabled={reportLoading || !counterCode}
                  title="Reload figures from the server"
                >
                  {reportLoading ? '…' : 'Refresh numbers'}
                </button>
              </div>
              <p className="counter-close-report-meta">
                Date <strong>{summaryView.date}</strong>
                {summaryView.locationCode != null && summaryView.locationCode !== '' && (
                  <> · Loc <strong>{summaryView.locationCode}</strong></>
                )}
                {summaryView.counterCode != null && summaryView.counterCode !== '' && (
                  <> · Counter <strong>{summaryView.counterCode}</strong></>
                )}
              </p>
              <dl className="counter-close-report-grid">
                <dt>Total sales</dt>
                <dd>QAR {summaryView.totalSales.toFixed(2)}</dd>
                <dt>Sale bills</dt>
                <dd>{summaryView.saleCount}</dd>
                <dt>Total returns</dt>
                <dd>QAR {summaryView.totalReturns.toFixed(2)}</dd>
                <dt>Return bills</dt>
                <dd>{summaryView.returnCount}</dd>
                <dt>Net (from DB)</dt>
                <dd>
                  <strong>QAR {summaryView.netTotal.toFixed(2)}</strong>
                  {!summaryView.netMatches && (
                    <span className="counter-close-report-warn" title="Sales − returns should match net">
                      {' '}(check: sales − returns = QAR {summaryView.netCalc.toFixed(2)})
                    </span>
                  )}
                </dd>
                <dt>Discount (line ITDISC)</dt>
                <dd>QAR {summaryView.discountTotal.toFixed(2)}</dd>
                <dt>Credit on account</dt>
                <dd>QAR {summaryView.creditTotal.toFixed(2)}</dd>
                <dt>Card (sales)</dt>
                <dd>QAR {summaryView.totalCardAmount.toFixed(2)}</dd>
                <dt>Card refunds (returns)</dt>
                <dd>QAR {summaryView.totalCardReturns.toFixed(2)}</dd>
                <dt>Voucher</dt>
                <dd>QAR {summaryView.voucherTotal.toFixed(2)}</dd>
                <dt>Cash in box (from DB)</dt>
                <dd>
                  <strong>QAR {summaryView.cashInBox.toFixed(2)}</strong>
                  {!summaryView.cashMatchesApprox && (
                    <span className="counter-close-report-warn" title="Aggregate check vs per-bill cash sum">
                      {' '}
                      (approx. net − card + card ret − credit − voucher = QAR {summaryView.cashApprox.toFixed(2)})
                    </span>
                  )}
                </dd>
              </dl>
              {summaryView.note && <p className="counter-setup-muted" style={{ marginTop: 8 }}>{summaryView.note}</p>}
            </div>
          )}
          {(isOpen || summaryView) && (
            <div className="counter-close-pending">
              <div className="counter-close-pending-head">
                <h4 className="counter-close-report-title">Hold &amp; suspended bills</h4>
                <button
                  type="button"
                  className="counter-setup-save-btn counter-setup-secondary"
                  style={{ padding: '6px 12px', fontSize: 13 }}
                  onClick={loadPendingBills}
                  disabled={pendingBillsLoading}
                  title="Reload hold and suspended lists"
                >
                  {pendingBillsLoading ? '…' : 'Refresh lists'}
                </button>
              </div>
              <p className="counter-close-report-meta">
                Business date <strong>{date}</strong>
                {locationCode ? <> · Loc <strong>{locationCode}</strong></> : null}
                {counterCode ? <> · Counter <strong>{counterCode}</strong></> : null}
              </p>
              {pendingBillsError && (
                <p className="login-error" style={{ marginTop: 0, marginBottom: 8 }}>{pendingBillsError}</p>
              )}
              <div className="counter-close-pending-grid">
                <div className="counter-close-pending-block">
                  <div className="counter-close-pending-block-head">
                    <span className="counter-close-pending-label">Hold bills</span>
                    <span className="counter-close-pending-count">{filteredHeld.length}</span>
                  </div>
                  <div className="counter-close-pending-scroll">
                    {pendingBillsLoading && heldBills.length === 0 && !pendingBillsError ? (
                      <p className="counter-setup-muted">Loading…</p>
                    ) : filteredHeld.length === 0 ? (
                      <p className="counter-setup-muted">No held bills for this date.</p>
                    ) : (
                      <ul className="counter-close-pending-list">
                        {filteredHeld.map((row) => {
                          const no = heldBillNo(row)
                          const hd = heldDateRaw(row)
                          const lines = heldLineCount(row)
                          const est = heldEstimatedTotal(row)
                          return (
                            <li key={`hold-${no}-${hd || ''}`} className="counter-close-pending-row">
                              <button
                                type="button"
                                className="counter-close-pending-bill counter-close-pending-bill-btn"
                                onClick={() => openHoldDetail(row)}
                                title={typeof onOpenHoldBill === 'function' ? 'Open held bill in cart summary' : 'View full bill detail'}
                              >
                                Bill {no}
                              </button>
                              <span className="counter-close-pending-meta">{formatHeldWhen(hd)}</span>
                              <span className="counter-close-pending-meta">
                                {lines} line{lines === 1 ? '' : 's'}
                              </span>
                              <span className="counter-close-pending-amt">QAR {est.toFixed(2)}</span>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                </div>
                <div className="counter-close-pending-block">
                  <div className="counter-close-pending-block-head">
                    <span className="counter-close-pending-label">Suspended bills</span>
                    <span className="counter-close-pending-count">{filteredSuspended.length}</span>
                  </div>
                  <div className="counter-close-pending-scroll">
                    {pendingBillsLoading && suspendedBills.length === 0 && !pendingBillsError ? (
                      <p className="counter-setup-muted">Loading…</p>
                    ) : filteredSuspended.length === 0 ? (
                      <p className="counter-setup-muted">No suspended bills for this date.</p>
                    ) : (
                      <ul className="counter-close-pending-list">
                        {filteredSuspended.map((b) => (
                          <li
                            key={`sus-${b.billNo}-${b.billTime || ''}`}
                            className="counter-close-pending-row counter-close-pending-row-suspended"
                          >
                            <span className="counter-close-pending-bill">Bill {b.billNo}</span>
                            <span className="counter-close-pending-meta">{b.billTime || '—'}</span>
                            <span className="counter-close-pending-meta">{b.customerName || '—'}</span>
                            <span className="counter-close-pending-amt">
                              QAR {Number(b.netBillAmount || 0).toFixed(2)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
              {hasHoldBills && (
                <p className="counter-close-pending-warn counter-close-pending-blocked">
                  {holdBlockMessage}
                </p>
              )}
              {!hasHoldBills && filteredSuspended.length > 0 && (
                <p className="counter-close-pending-warn">
                  Suspended bills are on record; you may still close after reviewing them.
                </p>
              )}
            </div>
          )}
        </section>

        <section className="counter-setup-section counter-setup-list">
          <h3>Active system </h3>
          {loading ? (
            <p className="counter-setup-muted">Loading…</p>
          ) : counters.length === 0 ? (
            <p className="counter-setup-muted">No counter for this system.</p>
          ) : (
            <div className="counter-setup-table-wrap">
              <table className="counter-setup-table">
                <thead>
                  <tr>
                    <th>System Name</th>
                    <th>Counter Code</th>
                    <th>Counter Name</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const row = counters[0]
                    const systemName = row.systemName ?? row.SYSTEMNAME ?? (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('pos_system_name') : '') ?? '—'
                    return (
                      <tr key="active">
                        <td>{systemName || '—'}</td>
                        <td>{row.counterCode ?? row.COUNTERCODE ?? '—'}</td>
                        <td>{row.counterName ?? row.COUNTERNAME ?? '—'}</td>
                      </tr>
                    )
                  })()}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="counter-setup-section counter-setup-list">
          <h3>Opened Dates</h3>
          {openedDatesLoading ? (
            <p className="counter-setup-muted">Loading…</p>
          ) : openedDates.length === 0 ? (
            <p className="counter-setup-muted">No opened dates found.</p>
          ) : (
            <div className="counter-setup-table-wrap">
              <table className="counter-setup-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Opened By</th>
                    <th>Opened Date</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {openedDates.map((row, idx) => (
                    <tr key={idx}>
                      <td>{row.date}</td>
                      <td>{row.openedBy || '—'}</td>
                      <td>{row.openedDate || '—'}</td>
                      <td>
                        <button
                          type="button"
                          className="counter-setup-save-btn counter-setup-secondary"
                          style={{ padding: '4px 8px', fontSize: 12 }}
                          onClick={() => setDate(row.date)}
                        >
                          Select
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {holdDetailBillNo != null && (
        <div
          className="counter-hold-detail-overlay"
          role="presentation"
          onClick={closeHoldDetail}
        >
          <div
            className="counter-hold-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="counter-hold-detail-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="counter-hold-detail-header">
              <h3 id="counter-hold-detail-title">Hold bill {holdDetailBillNo}</h3>
              <button
                type="button"
                className="counter-close-confirm-close"
                onClick={closeHoldDetail}
                disabled={holdDetailLoading}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="counter-hold-detail-body">
              <p className="counter-hold-detail-meta">
                Held <strong>{holdDetailHeldWhen}</strong>
                {locationCode ? (
                  <>
                    {' '}
                    · Loc <strong>{locationCode}</strong>
                  </>
                ) : null}
              </p>
              {holdDetailError && (
                <p className="login-error" role="alert">
                  {holdDetailError}
                </p>
              )}
              {holdDetailLoading ? (
                <p className="counter-setup-muted">Loading bill lines…</p>
              ) : holdDetailItems.length === 0 && !holdDetailError ? (
                <p className="counter-setup-muted">No line items on this held bill.</p>
              ) : (
                <div className="counter-hold-detail-table-wrap">
                  <table className="counter-hold-detail-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Code</th>
                        <th>Item</th>
                        <th className="counter-hold-detail-num">Qty</th>
                        <th className="counter-hold-detail-num">Rate</th>
                        <th className="counter-hold-detail-num">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {holdDetailItems.map((it, idx) => (
                        <tr key={`${holdDetailBillNo}-${idx}-${holdItemCode(it)}`}>
                          <td>{idx + 1}</td>
                          <td>{holdItemCode(it)}</td>
                          <td>{holdItemName(it)}</td>
                          <td className="counter-hold-detail-num">{holdItemQty(it)}</td>
                          <td className="counter-hold-detail-num">QAR {holdItemRate(it).toFixed(2)}</td>
                          <td className="counter-hold-detail-num">
                            QAR {holdItemLineTotal(it).toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={5} className="counter-hold-detail-total-label">
                          Total ({holdDetailItems.length} line
                          {holdDetailItems.length === 1 ? '' : 's'})
                        </td>
                        <td className="counter-hold-detail-num counter-hold-detail-total-amt">
                          <strong>QAR {holdItemsTotal(holdDetailItems).toFixed(2)}</strong>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
            <div className="counter-hold-detail-actions">
              <button
                type="button"
                className="counter-close-confirm-btn counter-close-confirm-btn-secondary"
                onClick={closeHoldDetail}
                disabled={holdDetailLoading}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showCloseConfirm && (
        <div
          className="counter-close-confirm-overlay"
          role="presentation"
          onClick={dismissCloseConfirm}
        >
          <div
            className="counter-close-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="counter-close-confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="counter-close-confirm-header">
              <h3 id="counter-close-confirm-title">Close counter</h3>
              <button
                type="button"
                className="counter-close-confirm-close"
                onClick={dismissCloseConfirm}
                disabled={closing}
                aria-label="Close dialog"
              >
                ×
              </button>
            </div>
            <div className="counter-close-confirm-body">
              <p className="counter-close-confirm-lead">
                You are about to close this counter for the selected business day. This cannot be undone.
              </p>
              <dl className="counter-close-confirm-details">
                <div className="counter-close-confirm-row">
                  <dt>Business date</dt>
                  <dd>{date}</dd>
                </div>
                {counterCode ? (
                  <div className="counter-close-confirm-row">
                    <dt>Counter</dt>
                    <dd>{counterCode}</dd>
                  </div>
                ) : null}
                {locationCode ? (
                  <div className="counter-close-confirm-row">
                    <dt>Location</dt>
                    <dd>{locationCode}</dd>
                  </div>
                ) : null}
                <div className="counter-close-confirm-row counter-close-confirm-row-emphasis">
                  <dt>Close time</dt>
                  <dd>{closeConfirmTimeLabel}</dd>
                </div>
                <div className="counter-close-confirm-row">
                  <dt>Hold bills</dt>
                  <dd>{filteredHeld.length}</dd>
                </div>
                <div className="counter-close-confirm-row">
                  <dt>Suspended bills</dt>
                  <dd>{filteredSuspended.length}</dd>
                </div>
              </dl>
              {hasHoldBills && (
                <p className="counter-close-pending-warn counter-close-confirm-pending-warn">
                  {holdBlockMessage}
                </p>
              )}
              <p className="counter-close-confirm-hint">Confirm only after cash and reports are finalized.</p>
            </div>
            <div className="counter-close-confirm-actions">
              <button
                type="button"
                className="counter-close-confirm-btn counter-close-confirm-btn-secondary"
                onClick={dismissCloseConfirm}
                disabled={closing}
              >
                Cancel
              </button>
              <button
                type="button"
                className="counter-close-confirm-btn counter-close-confirm-btn-danger"
                onClick={postClose}
                disabled={closing || hasHoldBills}
                title={hasHoldBills ? holdBlockMessage : undefined}
              >
                {closing ? 'Closing…' : 'Confirm close'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default CounterOpen
