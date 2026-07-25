import { useState, useCallback, useEffect, useRef } from 'react'
import { printReceipt } from '../services/thermalPrint'
import { downloadSuspendedBillPdf, downloadAllSuspendedBillsPdf } from '../utils/suspendedBillPdf'
import '../styles/Dashboard.css'

function todayStr() {
  const d = new Date()
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  )
}

function isIsoDate(s) {
  return s != null && /^\d{4}-\d{2}-\d{2}$/.test(String(s).trim())
}

/** Match backend BILLHDR: C/R only; return = negative NETBILLAMOUNT (cash return C, credit return R). */
function isBillSalesReturn(row) {
  const bt = String(row?.billType ?? '').toUpperCase()
  const net = Number(row?.netBillAmount ?? 0)
  return (bt === 'C' || bt === 'R') && net < 0
}

function heldBillNo(row) {
  const n = row?.BILLNO ?? row?.billNo
  if (n == null || n === '') return null
  return String(n).trim()
}

function heldDateRaw(row) {
  return row?.HELDDATE ?? row?.heldDate ?? null
}

/** If HELDDATE is missing, keep row when filtering by calendar day (unknown time). */
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

export default function Dashboard({
  apiBase,
  locationCode = '',
  locationName = '',
  counterCode = '',
  counterName = '',
  user = null,
  /** YYYY-MM-DD: counter DATEOFOPEN while session is open (from App). */
  counterSessionBillDate = '',
}) {
  const [billDate, setBillDate] = useState(() =>
    isIsoDate(counterSessionBillDate) ? String(counterSessionBillDate).trim() : todayStr()
  )
  const [billNoFilter, setBillNoFilter] = useState('')
  const [bills, setBills] = useState([])
  const [suspendedBills, setSuspendedBills] = useState([])
  const [heldBills, setHeldBills] = useState([])
  const [loading, setLoading] = useState(false)
  const [suspendedLoading, setSuspendedLoading] = useState(false)
  const [heldLoading, setHeldLoading] = useState(false)
  const [error, setError] = useState(null)
  const [suspendedError, setSuspendedError] = useState(null)
  const [heldError, setHeldError] = useState(null)
  const [printingBillNo, setPrintingBillNo] = useState(null)
  const [pdfBillNo, setPdfBillNo] = useState(null)
  const [suspendedPdfAllLoading, setSuspendedPdfAllLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('paid')
  const billNoFilterRef = useRef(billNoFilter)
  billNoFilterRef.current = billNoFilter

  useEffect(() => {
    if (isIsoDate(counterSessionBillDate)) {
      setBillDate(String(counterSessionBillDate).trim())
    }
  }, [counterSessionBillDate])

  const loadBills = useCallback(async (opts = {}) => {
    const { useBillNoServerFilter = false } = opts
    if (!apiBase || !billDate) return
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ date: billDate })
      if (locationCode) params.set('locationCode', locationCode)
      if (counterCode) params.set('counterCode', counterCode)
      if (useBillNoServerFilter) {
        const bn = billNoFilterRef.current.trim()
        if (bn !== '' && /^\d+$/.test(bn)) params.set('billNo', bn)
      }
      const res = await fetch(`${apiBase}/api/bills/by-date?${params}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setBills([])
        setError(data.error || `Failed to load bills (${res.status})`)
        return
      }
      setBills(Array.isArray(data.bills) ? data.bills : [])
    } catch (e) {
      setBills([])
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [apiBase, billDate, locationCode, counterCode])

  const loadSuspendedBills = useCallback(async () => {
    if (!apiBase || !billDate) return
    setSuspendedLoading(true)
    setSuspendedError(null)
    try {
      const params = new URLSearchParams({ date: billDate })
      if (locationCode) params.set('locationCode', locationCode)
      if (counterCode) params.set('counterCode', counterCode)
      const res = await fetch(`${apiBase}/api/bills/suspended-by-date?${params}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setSuspendedBills([])
        setSuspendedError(data.error || `Failed to load suspended bills (${res.status})`)
        return
      }
      setSuspendedBills(Array.isArray(data.bills) ? data.bills : [])
    } catch (e) {
      setSuspendedBills([])
      setSuspendedError(e?.message || String(e))
    } finally {
      setSuspendedLoading(false)
    }
  }, [apiBase, billDate, locationCode, counterCode])

  const loadHeldBills = useCallback(async () => {
    if (!apiBase) return
    setHeldLoading(true)
    setHeldError(null)
    try {
      const params = new URLSearchParams()
      if (locationCode) params.set('locationCode', locationCode)
      const qs = params.toString()
      const res = await fetch(`${apiBase}/api/hold${qs ? `?${qs}` : ''}`)
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        const errObj = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
        setHeldBills([])
        setHeldError(errObj.error || `Failed to load held bills (${res.status})`)
        return
      }
      setHeldBills(Array.isArray(data) ? data : [])
    } catch (e) {
      setHeldBills([])
      setHeldError(e?.message || String(e))
    } finally {
      setHeldLoading(false)
    }
  }, [apiBase, locationCode])

  useEffect(() => {
    loadBills({ useBillNoServerFilter: false })
  }, [loadBills])

  useEffect(() => {
    loadSuspendedBills()
  }, [loadSuspendedBills])

  useEffect(() => {
    loadHeldBills()
  }, [loadHeldBills])

  const filteredBills = bills.filter((b) => {
    const q = billNoFilter.trim().toLowerCase()
    if (!q) return true
    const n = String(b.billNo ?? '')
    return n.includes(q)
  })

  const filteredSuspended = suspendedBills.filter((b) => {
    const q = billNoFilter.trim().toLowerCase()
    if (!q) return true
    const n = String(b.billNo ?? '')
    return n.includes(q)
  })

  const filteredHeld = heldBills.filter((row) => {
    if (!heldBillNo(row)) return false
    if (!heldMatchesBillDate(row, billDate)) return false
    const q = billNoFilter.trim().toLowerCase()
    if (!q) return true
    const n = String(heldBillNo(row) ?? '')
    return n.toLowerCase().includes(q)
  })

  const handlePrintBill = async (bill) => {
    const bno = bill.billNo
    if (bno == null || !apiBase) return
    setPrintingBillNo(bno)
    setError(null)
    try {
      const params = new URLSearchParams({ date: billDate })
      if (locationCode) params.set('locationCode', locationCode)
      const res = await fetch(`${apiBase}/api/bills/${bno}/receipt?${params}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setError(data.error || `Could not load bill ${bno}`)
        return
      }
      const h = data.header || {}
      const billDateObj = h.billDate ? new Date(h.billDate) : new Date(`${billDate}T12:00:00`)
      await printReceipt({
        openCashDrawer: false,
        copyPrintHeading: true,
        billNo: h.billNo ?? bno,
        date: billDateObj,
        locationCode: h.locationCode || locationCode || '',
        locationName: locationName || '',
        locationTelephone: (typeof localStorage !== 'undefined' && localStorage.getItem('pos_location_telephone')) || '',
        counterCode: h.counterCode || counterCode || '',
        counterName: counterName || '',
        userName: user?.userid ?? user?.username ?? '',
        customerName: h.customerName || '',
        companyName: (localStorage.getItem('pos_company_name') || '').trim() || undefined,
        companyNameAr: (localStorage.getItem('pos_company_name_ar') || '').trim() || undefined,
        branchName: localStorage.getItem('pos_branch_name') || '',
        items: data.items || [],
        subtotal: data.subtotal ?? 0,
        total: data.total ?? 0,
        discount: data.discount ?? 0,
        totalPoints: data.totalPoints ?? 0,
        paymentMethod: data.paymentMethod ?? 'cash',
        cashAmount: data.cashAmount,
        cardAmount: data.cardAmount,
        amountTendered: data.amountTendered ?? data.total ?? 0,
        change: data.change ?? 0,
        isSalesReturn: !!data.isSalesReturn,
      })
    } catch (e) {
      const msg = e?.message ?? String(e)
      setError(msg)
      if (msg.includes('QZ Tray is not running')) {
        alert('Receipt not printed. Please start QZ Tray (https://qz.io) for automatic receipt printing.')
      } else if (!msg.includes('No printers')) {
        alert('Receipt print failed: ' + msg)
      }
    } finally {
      setPrintingBillNo(null)
    }
  }

  const handleSuspendedPdf = async (b) => {
    const bno = b.billNo
    if (bno == null || !apiBase) return
    setPdfBillNo(bno)
    setSuspendedError(null)
    try {
      const branchName = (typeof localStorage !== 'undefined' && localStorage.getItem('pos_branch_name')) || ''
      const companyName = (typeof localStorage !== 'undefined' && localStorage.getItem('pos_company_name')?.trim()) || ''
      await downloadSuspendedBillPdf(apiBase, {
        billNo: bno,
        billDate,
        locationCode,
        counterCode,
        locationName,
        branchName,
        companyName,
      })
    } catch (e) {
      const msg = e?.message ?? String(e)
      setSuspendedError(msg)
    } finally {
      setPdfBillNo(null)
    }
  }

  const handleSuspendedPdfAll = async () => {
    if (!apiBase || filteredSuspended.length === 0) return
    setSuspendedPdfAllLoading(true)
    setSuspendedError(null)
    try {
      const branchName = (typeof localStorage !== 'undefined' && localStorage.getItem('pos_branch_name')) || ''
      const companyName = (typeof localStorage !== 'undefined' && localStorage.getItem('pos_company_name')?.trim()) || ''
      const billNos = filteredSuspended.map((b) => b.billNo).filter((n) => n != null)
      await downloadAllSuspendedBillsPdf(apiBase, {
        billNos,
        billDate,
        locationCode,
        counterCode,
        locationName,
        branchName,
        companyName,
      })
    } catch (e) {
      const msg = e?.message ?? String(e)
      setSuspendedError(msg)
    } finally {
      setSuspendedPdfAllLoading(false)
    }
  }

  return (
    <div className="dashboard-page">
      <div className="dashboard-header">
        <h1 className="dashboard-title">Dashboard</h1>
      </div>

      <form
        className="dashboard-bill-form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault()
          loadBills({ useBillNoServerFilter: true })
          loadSuspendedBills()
          loadHeldBills()
        }}
      >
        <div className="dashboard-form-row">
          <label className="dashboard-field">
            <span>Bill date</span>
            <input
              type="date"
              value={billDate}
              onChange={(e) => setBillDate(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="dashboard-field dashboard-field-grow">
            <span>Filter</span>
            <input
              type="text"
              inputMode="numeric"
              placeholder="Search bill no"
              value={billNoFilter}
              onChange={(e) => setBillNoFilter(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="dashboard-form-actions">
            <button
              type="submit"
              className="dashboard-btn primary"
              disabled={loading || suspendedLoading || heldLoading}
            >
              {loading || suspendedLoading || heldLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>
      </form>

      <div className="dashboard-tabs">
        <div className="dashboard-tablist" role="tablist" aria-label="Dashboard bill lists">
          <button
            type="button"
            role="tab"
            id="dashboard-tab-paid"
            aria-selected={activeTab === 'paid'}
            aria-controls="dashboard-panel-paid"
            tabIndex={activeTab === 'paid' ? 0 : -1}
            className={`dashboard-tab ${activeTab === 'paid' ? 'active' : ''}`}
            onClick={() => setActiveTab('paid')}
          >
            Paid bills
            <span className="dashboard-tab-count">{filteredBills.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            id="dashboard-tab-held"
            aria-selected={activeTab === 'held'}
            aria-controls="dashboard-panel-held"
            tabIndex={activeTab === 'held' ? 0 : -1}
            className={`dashboard-tab ${activeTab === 'held' ? 'active' : ''}`}
            onClick={() => setActiveTab('held')}
          >
            Hold bill nos.
            <span className="dashboard-tab-count">{filteredHeld.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            id="dashboard-tab-suspended"
            aria-selected={activeTab === 'suspended'}
            aria-controls="dashboard-panel-suspended"
            tabIndex={activeTab === 'suspended' ? 0 : -1}
            className={`dashboard-tab ${activeTab === 'suspended' ? 'active' : ''}`}
            onClick={() => setActiveTab('suspended')}
          >
            Suspended
            <span className="dashboard-tab-count">{filteredSuspended.length}</span>
          </button>
        </div>

        <div className="dashboard-tab-panels">
          {activeTab === 'paid' && (
            <div
              id="dashboard-panel-paid"
              role="tabpanel"
              aria-labelledby="dashboard-tab-paid"
              className="dashboard-tab-panel"
            >
              {error && <div className="dashboard-error dashboard-error-tab" role="alert">{error}</div>}
              <div className="dashboard-bill-list-wrap">
                <div className="dashboard-list-header">
                  <span>Bills on {billDate}</span>
                  <span className="dashboard-list-count">{filteredBills.length} shown</span>
                </div>
                <div className="dashboard-bill-list-scroll">
                  {loading && bills.length === 0 ? (
                    <div className="dashboard-empty">Loading bills…</div>
                  ) : filteredBills.length === 0 ? (
                    <div className="dashboard-empty">
                      No bills for this date{billNoFilter.trim() ? ' (with current filter)' : ''}.
                    </div>
                  ) : (
                    <ul className="dashboard-bill-list">
                      {filteredBills.map((b) => (
                        <li key={`${b.billNo}-${b.billDate}`} className="dashboard-bill-row">
                          <button
                            type="button"
                            className="dashboard-bill-no-btn"
                            disabled={printingBillNo === b.billNo}
                            onClick={() => handlePrintBill(b)}
                            title="Print receipt"
                          >
                            {printingBillNo === b.billNo ? 'Printing…' : `Bill ${b.billNo}`}
                          </button>
                          <span className="dashboard-bill-meta">{b.counterCode || '—'}</span>
                          <span className="dashboard-bill-meta">{b.customerName || '—'}</span>
                          <span className="dashboard-bill-amount">
                            QAR {Number(b.netBillAmount || 0).toFixed(2)}
                          </span>
                          <span className={`dashboard-bill-type ${isBillSalesReturn(b) ? 'return' : ''}`}>
                            {isBillSalesReturn(b) ? 'Return' : 'Sale'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'held' && (
            <div
              id="dashboard-panel-held"
              role="tabpanel"
              aria-labelledby="dashboard-tab-held"
              className="dashboard-tab-panel"
            >
              {heldError && (
                <div className="dashboard-error dashboard-error-tab" role="alert">
                  {heldError}
                </div>
              )}
              <div className="dashboard-bill-list-wrap">
                <div className="dashboard-list-header">
                  <span>
                    Held bill numbers{locationCode ? ` — ${locationCode}` : ''} (on {billDate})
                  </span>
                  <span className="dashboard-list-count">
                    {heldLoading ? 'Loading…' : `${filteredHeld.length} shown`}
                  </span>
                </div>
                <div className="dashboard-bill-list-scroll">
                  {heldLoading && heldBills.length === 0 && !heldError ? (
                    <div className="dashboard-empty">Loading held bills…</div>
                  ) : filteredHeld.length === 0 ? (
                    <div className="dashboard-empty">
                      No held bill numbers match this date or search
                      {billNoFilter.trim() ? ' (bill no filter)' : ''}. Use Hold Retrieve on Billing to load a cart.
                    </div>
                  ) : (
                    <ul className="dashboard-bill-list">
                      {filteredHeld.map((row) => {
                        const no = heldBillNo(row)
                        const hd = heldDateRaw(row)
                        const whenLabel = formatHeldWhen(hd)
                        const lines = heldLineCount(row)
                        const est = heldEstimatedTotal(row)
                        return (
                          <li
                            key={`held-${no}-${hd || ''}`}
                            className="dashboard-bill-row dashboard-hold-row"
                          >
                            <span className="dashboard-hold-bill-label">Bill no. {no}</span>
                            <span className="dashboard-bill-meta" title={hd ? String(hd) : ''}>
                              {whenLabel}
                            </span>
                            <span className="dashboard-bill-meta" title="Cashier name (userid)">
                              {row.CREATEDBY || row.createdby || '—'}
                            </span>
                            <span className="dashboard-bill-meta">
                              {lines} line{lines === 1 ? '' : 's'}
                            </span>
                            <span className="dashboard-bill-amount">QAR {est.toFixed(2)}</span>
                            <span className="dashboard-bill-type dashboard-hold-badge">Hold</span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'suspended' && (
            <div
              id="dashboard-panel-suspended"
              role="tabpanel"
              aria-labelledby="dashboard-tab-suspended"
              className="dashboard-tab-panel"
            >
              {suspendedError && (
                <div className="dashboard-error dashboard-error-tab" role="alert">
                  {suspendedError}
                </div>
              )}
              <div className="dashboard-bill-list-wrap">
                <div className="dashboard-list-header">
                  <span>Suspended on {billDate}</span>
                  <div className="dashboard-list-header-right">
                    <span className="dashboard-list-count">
                      {suspendedLoading ? 'Loading…' : `${filteredSuspended.length} shown`}
                    </span>
                    {filteredSuspended.length > 0 && (
                      <button
                        type="button"
                        className="dashboard-suspend-pdf-all-btn"
                        disabled={suspendedPdfAllLoading || pdfBillNo != null}
                        onClick={() => handleSuspendedPdfAll()}
                        title="Download one PDF with every suspended bill shown (full detail per page)"
                      >
                        {suspendedPdfAllLoading ? 'Building PDF…' : 'All PDF'}
                      </button>
                    )}
                  </div>
                </div>
                <div className="dashboard-bill-list-scroll">
                  {suspendedLoading && suspendedBills.length === 0 && !suspendedError ? (
                    <div className="dashboard-empty">Loading suspended bills…</div>
                  ) : filteredSuspended.length === 0 ? (
                    <div className="dashboard-empty">
                      No suspended bills for this date
                      {billNoFilter.trim() ? ' (with current filter)' : ''}.
                    </div>
                  ) : (
                    <ul className="dashboard-bill-list">
                      {filteredSuspended.map((b) => (
                        <li
                          key={`sus-${b.billNo}-${b.billTime || ''}-${b.billDate}`}
                          className="dashboard-bill-row dashboard-suspend-row"
                        >
                          <div className="dashboard-suspend-bill-cell">
                            <span className="dashboard-suspend-bill-label">Bill {b.billNo}</span>
                            <button
                              type="button"
                              className="dashboard-suspend-pdf-btn"
                              disabled={pdfBillNo === b.billNo}
                              onClick={() => handleSuspendedPdf(b)}
                              title="Download full detail as PDF"
                            >
                              {pdfBillNo === b.billNo ? 'PDF…' : 'PDF'}
                            </button>
                          </div>
                          <span className="dashboard-bill-meta">{b.billTime || '—'}</span>
                          <span className="dashboard-bill-meta">
                            {b.customerName || b.customerCode || '—'}
                          </span>
                          <span className="dashboard-bill-amount">
                            QAR {Number(b.netBillAmount || 0).toFixed(2)}
                          </span>
                          <span className="dashboard-bill-type dashboard-suspend-badge">Suspended</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
