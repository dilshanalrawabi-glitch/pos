import { useState, useEffect, useCallback, useMemo } from 'react'
import { printCounterCloseReport } from '../services/thermalPrint'
import '../styles/CounterSetup.css'

function todayStr() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function formatCloseConfirmDateTime() {
  return new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}

function parseMoney(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Normalize API payload and derive checks: net = sales − returns; cash approx = net − card(sales) + card(returns) − credit − voucher */
function buildSummaryView(data) {
  if (!data || data.ok === false) return null
  const totalSales = parseMoney(data.totalSales)
  const totalReturns = parseMoney(data.totalReturns)
  const netTotal = parseMoney(data.netTotal)
  const netCalc = Math.round((totalSales - totalReturns) * 100) / 100
  const totalCardAmount = parseMoney(data.totalCardAmount)
  const totalCardReturns = parseMoney(data.totalCardReturns)
  const discountTotal = parseMoney(data.discountTotal)
  const creditTotal = parseMoney(data.creditTotal)
  const voucherTotal = parseMoney(data.voucherTotal)
  const cashInBox = parseMoney(data.cashInBox)
  const cashApprox = Math.round((netTotal - totalCardAmount + totalCardReturns - creditTotal - voucherTotal) * 1000) / 1000
  return {
    date: data.date,
    counterCode: data.counterCode,
    locationCode: data.locationCode,
    saleCount: Number(data.saleCount) || 0,
    returnCount: Number(data.returnCount) || 0,
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
    note: data.note,
    calculationNote: data.calculationNote,
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

  useEffect(() => {
    if (!showCloseConfirm) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !closing) setShowCloseConfirm(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showCloseConfirm, closing])

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

  const makeClosePrintData = useCallback(
    (summary, slipKind) => {
      const companyName = typeof localStorage !== 'undefined' ? (localStorage.getItem('pos_company_name') || '').trim() : ''
      const companyNameAr = typeof localStorage !== 'undefined' ? (localStorage.getItem('pos_company_name_ar') || '').trim() : ''
      const branchName = typeof localStorage !== 'undefined' ? (localStorage.getItem('pos_branch_name') || '').trim() : ''
      const closedBy = (user?.username || user?.userid || '').toString().trim()
      const uid = (user?.userid ?? '').toString().trim()
      const un = (user?.username ?? '').toString().trim()
      const cashierDisplay = [uid, un].filter(Boolean).join(' ').trim()
      return {
        date,
        counterCode,
        locationCode: locationCode || '',
        locationName: locationName || '',
        companyName: companyName || undefined,
        companyNameAr: companyNameAr || undefined,
        branchName: branchName || undefined,
        totalSales: summary.totalSales ?? 0,
        totalReturns: summary.totalReturns ?? 0,
        netTotal: summary.netTotal ?? 0,
        closedBy,
        cashierDisplay: cashierDisplay || closedBy,
        totalCardAmount: summary.totalCardAmount ?? 0,
        totalCardReturns: summary.totalCardReturns ?? 0,
        cardByType: summary.cardByType ?? {},
        discountTotal: summary.discountTotal ?? 0,
        creditTotal: summary.creditTotal ?? 0,
        voucherTotal: summary.voucherTotal ?? 0,
        cashInBox: summary.cashInBox != null ? summary.cashInBox : undefined,
        crReconciled: 0,
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
        if (data.ok) fetchStatus()
        else setActionError(data.error || 'Open failed')
      })
      .catch((err) => setActionError(err.message || 'Open failed'))
  }

  const postClose = () => {
    if (!apiBase || !date || closing) return
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
          return
        }
        await fetchStatus()
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

  const openCloseConfirm = () => {
    if (!apiBase || !date) return
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
          <h3>Date &amp; Shift code</h3>
          <div className="counter-setup-row">
            <label className="counter-setup-label" htmlFor="counter-open-date">Date (DATEOFOPEN)</label>
            <input
              id="counter-open-date"
              type="date"
              className="counter-setup-input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
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
                <button type="button" className="counter-setup-save-btn counter-close-btn" onClick={openCloseConfirm}>
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
              {summaryView.calculationNote && (
                <p className="counter-setup-muted" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.4 }}>
                  {summaryView.calculationNote}
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
              </dl>
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
                disabled={closing}
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
