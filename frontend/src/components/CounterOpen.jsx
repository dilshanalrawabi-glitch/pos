import { useState, useEffect } from 'react'
import '../styles/CounterSetup.css'

function todayStr() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function CounterOpen({ apiBase }) {
  const [date, setDate] = useState(todayStr())
  const [shiftCode, setShiftCode] = useState('')
  const [counters, setCounters] = useState([])
  const [loading, setLoading] = useState(false)

  const fetchCounters = () => {
    if (!apiBase) return
    setLoading(true)
    fetch(`${apiBase}/api/counters`)
      .then((res) => res.json())
      .then((data) => {
        if (data.ok && Array.isArray(data.counters)) setCounters(data.counters)
        else setCounters([])
      })
      .catch(() => setCounters([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchCounters()
  }, [apiBase])

  return (
    <div className="counter-setup">
      <div className="counter-setup-header">
        <h2>Counter Open</h2>
        <p className="counter-setup-desc">Date, shift code and counter setup data.</p>
      </div>

      <section className="counter-setup-section">
        <h3>Date &amp; Shift code</h3>
        <div className="counter-setup-row">
          <label className="counter-setup-label" htmlFor="counter-open-date">Date</label>
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
        <button type="button" className="counter-setup-save-btn" onClick={fetchCounters}>
          Refresh
        </button>
      </section>

      <section className="counter-setup-section counter-setup-list">
        <h3>Counter code</h3>
        {loading ? (
          <p className="counter-setup-muted">Loading…</p>
        ) : counters.length === 0 ? (
          <p className="counter-setup-muted">No counter code.</p>
        ) : (
          <div className="counter-setup-table-wrap">
            <table className="counter-setup-table">
              <thead>
                <tr>
                  <th>Counter Code</th>
                </tr>
              </thead>
              <tbody>
                {counters.map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.counterCode ?? row.COUNTERCODE ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

export default CounterOpen
