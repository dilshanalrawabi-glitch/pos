import { useState, useEffect, useRef } from 'react'
import '../styles/CounterSetup.css'

function CounterSetup({ counterCode, counterName, apiBase, onSave }) {
  const [systemName, setSystemName] = useState('')
  const [ipAddress, setIpAddress] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState(counterName || '')
  const [saved, setSaved] = useState(false)
  const [loadingCode, setLoadingCode] = useState(!!apiBase)
  const [hasExistingCounter, setHasExistingCounter] = useState(false)
  const onSaveRef = useRef(onSave)

  onSaveRef.current = onSave

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setSystemName(sessionStorage.getItem('pos_system_name') || '')
      setIpAddress(sessionStorage.getItem('pos_system_ip') || '')
    }
  }, [])

  // First check if this IP already has a counter in DB: show that code. Only if none, fetch next number for new setup.
  useEffect(() => {
    if (!apiBase) {
      setLoadingCode(false)
      return
    }
    if (!ipAddress?.trim()) {
      setLoadingCode(false)
      return
    }
    const sysName = (systemName || '').trim()
    const sysIp = ipAddress.trim()
    setLoadingCode(true)
    const params = new URLSearchParams({ systemIp: sysIp })
    if (sysName) params.set('systemName', sysName)
    fetch(`${apiBase}/api/counters?${params}`)
      .then((res) => res.json())
      .then((data) => {
        if (data?.ok && Array.isArray(data.counters) && data.counters.length > 0) {
          const first = data.counters[0]
          const c = (first.counterCode ?? '').toString().trim() || '1'
          const n = (first.counterName ?? '').toString().trim() || 'Counter 1'
          if (first.counterCode != null || first.counterName != null) {
            setCode(c)
            setName(n)
            setHasExistingCounter(true)
            if (typeof window !== 'undefined') {
              localStorage.setItem('pos_counter_code', c)
              localStorage.setItem('pos_counter_name', n)
            }
            onSaveRef.current?.(c, n)
            return
          }
        }
        // No counter for this IP: new setup — fetch next code only now
        return fetch(`${apiBase}/api/counters/next-code`)
          .then((r) => r.json())
          .then((nextData) => {
            if (nextData?.ok && nextData.nextCounterCode != null) {
              setCode(String(nextData.nextCounterCode).trim())
            }
            setHasExistingCounter(false)
          })
      })
      .catch(() => {})
      .finally(() => setLoadingCode(false))
  }, [apiBase, ipAddress, systemName])

  useEffect(() => {
    if (!hasExistingCounter) setName(counterName || '')
  }, [counterName, hasExistingCounter])

  const handleSubmit = (e) => {
    e.preventDefault()
    const trimmedCode = (code || '').trim() || '1'
    const trimmedName = (name || '').trim() || 'Counter 1'
    if (typeof window !== 'undefined') {
      localStorage.setItem('pos_counter_code', trimmedCode)
      localStorage.setItem('pos_counter_name', trimmedName)
    }
    onSave?.(trimmedCode, trimmedName)
    if (apiBase) {
      fetch(`${apiBase}/api/counter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemName: (systemName || '').trim(),
          systemIp: (ipAddress || '').trim(),
          counterCode: trimmedCode,
          counterName: trimmedName
        })
      }).catch(() => {})
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  return (
    <div className="counter-setup">
      <div className="counter-setup-inner">
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
              className={`counter-setup-input ${hasExistingCounter ? 'counter-setup-readonly' : ''}`}
              value={name}
              readOnly={hasExistingCounter}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Counter 1"
            />
          </div>
        </section>

        {!hasExistingCounter && (
          <div className="counter-setup-actions">
            <button type="submit" className="counter-setup-save-btn">
              Save counter setup
            </button>
            {saved && <span className="counter-setup-saved-msg">Saved.</span>}
          </div>
        )}
      </form>
      </div>
    </div>
  )
}

export default CounterSetup
