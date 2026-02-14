import { useState, useEffect } from 'react'
import '../styles/HoldRetrieveModal.css'

function formatHoldDate(heldDate) {
  if (!heldDate) return ''
  try {
    const d = new Date(heldDate)
    return isNaN(d.getTime()) ? String(heldDate) : d.toLocaleString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return String(heldDate)
  }
}

export default function HoldRetrieveModal({ open, onClose, locationCode, apiBase, onRetrieve }) {
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!open || !apiBase) return
    setError(null)
    setLoading(true)
    const loc = encodeURIComponent(locationCode || 'LOC001')
    fetch(`${apiBase}/api/hold?locationCode=${loc}`)
      .then((res) => res.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch((err) => {
        setError(err.message || 'Failed to load held bills')
        setList([])
      })
      .finally(() => setLoading(false))
  }, [open, locationCode, apiBase])

  const handleSelect = async (billNo) => {
    if (!apiBase || !onRetrieve) return
    setError(null)
    try {
      const loc = encodeURIComponent(locationCode || 'LOC001')
      const res = await fetch(`${apiBase}/api/hold/${billNo}?locationCode=${loc}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load bill')
      onRetrieve(data.billNo, data.items || [])
      await fetch(`${apiBase}/api/hold/${billNo}?locationCode=${loc}`, { method: 'DELETE' })
      onClose()
    } catch (err) {
      setError(err.message || 'Failed to retrieve bill')
    }
  }

  if (!open) return null

  return (
    <div className="hold-retrieve-overlay" onClick={onClose}>
      <div className="hold-retrieve-modal" onClick={(e) => e.stopPropagation()}>
        <div className="hold-retrieve-header">
          <h3>Held bills</h3>
          <button type="button" className="hold-retrieve-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="hold-retrieve-body">
          {loading && <p className="hold-retrieve-msg">Loading…</p>}
          {error && <p className="hold-retrieve-error">{error}</p>}
          {!loading && !error && list.length === 0 && (
            <p className="hold-retrieve-msg">No held bills.</p>
          )}
          {!loading && !error && list.length > 0 && (
            <ul className="hold-retrieve-list">
              {list.map((row) => (
                <li key={`${row.BILLNO}-${row.HELDDATE || ''}`}>
                  <button
                    type="button"
                    className="hold-retrieve-item"
                    onClick={() => handleSelect(row.BILLNO)}
                  >
                    <span className="hold-retrieve-billno">Bill #{row.BILLNO}</span>
                    {row.HELDDATE && (
                      <span className="hold-retrieve-date">{formatHoldDate(row.HELDDATE)}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
