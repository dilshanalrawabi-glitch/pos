import { useState, useEffect } from 'react'
import '../styles/CounterSetup.css'

function CounterSetup({ counterCode, counterName, apiBase, onSave }) {
  const [systemName, setSystemName] = useState('')
  const [ipAddress, setIpAddress] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState(counterName || '')
  const [saved, setSaved] = useState(false)
  const [loadingCode, setLoadingCode] = useState(!!apiBase)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setSystemName(sessionStorage.getItem('pos_system_name') || '')
      setIpAddress(sessionStorage.getItem('pos_system_ip') || '')
    }
  }, [])

  // Fetch counter code from COUNTER table (last COUNTERCODE + 1); show only, not editable
  useEffect(() => {
    if (!apiBase) {
      setLoadingCode(false)
      return
    }
    setLoadingCode(true)
    fetch(`${apiBase}/api/counters/next-code`)
      .then((res) => res.json())
      .then((data) => {
        if (data.ok && data.nextCounterCode != null) {
          setCode(String(data.nextCounterCode).trim())
        }
      })
      .catch(() => {})
      .finally(() => setLoadingCode(false))
  }, [apiBase])

  useEffect(() => {
    setName(counterName || '')
  }, [counterName])

  const handleSubmit = (e) => {
    e.preventDefault()
    const trimmedCode = (code || '').trim() || '1'
    const trimmedName = (name || '').trim() || 'Counter 1'
    if (typeof window !== 'undefined') {
      localStorage.setItem('pos_counter_code', trimmedCode)
      localStorage.setItem('pos_counter_name', trimmedName)
    }
    onSave?.(trimmedCode, trimmedName)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  return (
    <div className="counter-setup">
      <div className="counter-setup-header">
        <h2>Counter Setup</h2>
        <p className="counter-setup-desc">System info from .exe launcher and counter settings for this terminal.</p>
      </div>

      <form className="counter-setup-form" onSubmit={handleSubmit}>
        <section className="counter-setup-section">
          <h3>System info (from launcher .exe)</h3>
          <div className="counter-setup-row">
            <label className="counter-setup-label">System name</label>
            <input
              type="text"
              className="counter-setup-input counter-setup-readonly"
              value={systemName}
              readOnly
              placeholder="Set by launcher when opened via .exe"
            />
          </div>
          <div className="counter-setup-row">
            <label className="counter-setup-label">IP address</label>
            <input
              type="text"
              className="counter-setup-input counter-setup-readonly"
              value={ipAddress}
              readOnly
              placeholder="Set by launcher when opened via .exe"
            />
          </div>
        </section>

        <section className="counter-setup-section">
          <h3>Counter settings</h3>
          <div className="counter-setup-row">
            <label className="counter-setup-label" htmlFor="counter-code">Counter code</label>
            {loadingCode ? (
              <span className="counter-setup-code-loading">Loading…</span>
            ) : (
              <input
                id="counter-code"
                type="text"
                className="counter-setup-input counter-setup-readonly"
                value={code}
                readOnly
                placeholder="From DB: last COUNTERCODE + 1"
                aria-label="Counter code (from database)"
              />
            )}
          </div>
          <div className="counter-setup-row">
            <label className="counter-setup-label" htmlFor="counter-name">Counter name</label>
            <input
              id="counter-name"
              type="text"
              className="counter-setup-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Counter 1"
            />
          </div>
        </section>

        <div className="counter-setup-actions">
          <button type="submit" className="counter-setup-save-btn">
            Save counter setup
          </button>
          {saved && <span className="counter-setup-saved-msg">Saved.</span>}
        </div>
      </form>
    </div>
  )
}

export default CounterSetup
