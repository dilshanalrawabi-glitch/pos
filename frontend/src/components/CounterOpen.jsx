import { useState, useEffect, useCallback } from 'react'
import '../styles/CounterSetup.css'

function todayStr() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function CounterOpen({ apiBase, token, locationCode }) {
  const [date, setDate] = useState(todayStr())
  const [shiftCode, setShiftCode] = useState('')
  const [counters, setCounters] = useState([])
  const [loading, setLoading] = useState(false)
  const [statusLoading, setStatusLoading] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const [isClosed, setIsClosed] = useState(false)
  const [actionError, setActionError] = useState(null)

  const systemIp = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('pos_system_ip') || '' : ''
  const counterCode = counters[0] ? (counters[0].counterCode ?? counters[0].COUNTERCODE ?? '').toString().trim() : ''

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
    if (!apiBase || !date) return
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

  useEffect(() => {
    fetchCounters()
  }, [fetchCounters])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

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
    if (!apiBase || !date) return
    setActionError(null)
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    fetch(`${apiBase}/api/counter-operations/close`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ date, counterCode: counterCode || undefined, locationCode: locationCode || undefined }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.ok) fetchStatus()
        else setActionError(data.error || 'Close failed')
      })
      .catch((err) => setActionError(err.message || 'Close failed'))
  }

  return (
    <div className="counter-setup">
      <div className="counter-open-card">
        <div className="counter-setup-header">
          <h2>Counter Open</h2>
          <p className="counter-setup-desc">Select date and open or close counter. DATEOFOPEN and OPENEDDATE are stored in COUNTEROPERATIONS.</p>
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
              <button type="button" className="counter-setup-save-btn counter-close-btn" onClick={postClose}>
                Close
              </button>
            ) : isClosed ? (
              <button type="button" className="counter-setup-save-btn counter-setup-readonly" disabled>
                Already closed
              </button>
            ) : (
              <button type="button" className="counter-setup-save-btn" onClick={postOpen}>
                Open
              </button>
            )}
            <button type="button" className="counter-setup-save-btn counter-setup-secondary" onClick={() => { fetchCounters(); fetchStatus(); }}>
              Refresh
            </button>
          </div>
          {actionError && <p className="login-error" style={{ marginTop: 8 }}>{actionError}</p>}
        </section>

        <section className="counter-setup-section counter-setup-list">
          <h3>Active system – counter details (one only)</h3>
          <p className="counter-setup-muted">Saved system name, counter code and name for this terminal only.</p>
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
      </div>
    </div>
  )
}

export default CounterOpen
