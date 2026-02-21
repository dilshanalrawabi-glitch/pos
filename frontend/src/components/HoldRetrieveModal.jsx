import { useState } from 'react'
import '../styles/HoldRetrieveModal.css'

export default function HoldRetrieveModal({ open, onClose, locationCode, apiBase, onRetrieve }) {
  const [billNoInput, setBillNoInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const handleRetrieve = async (e) => {
    e?.preventDefault()
    const billNo = billNoInput.trim()
    if (!billNo) {
      setError('Enter a bill number')
      return
    }
    const billNoNum = parseInt(billNo, 10)
    if (Number.isNaN(billNoNum) || billNoNum < 1) {
      setError('Enter a valid bill number')
      return
    }
    if (!apiBase || !onRetrieve) return
    setError(null)
    setLoading(true)
    try {
      const loc = encodeURIComponent(locationCode || 'LOC001')
      const res = await fetch(`${apiBase}/api/hold/${billNoNum}?locationCode=${loc}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Held bill not found')
      onRetrieve(data.billNo, data.items || [])
      await fetch(`${apiBase}/api/hold/${billNoNum}?locationCode=${loc}`, { method: 'DELETE' })
      setBillNoInput('')
      onClose()
    } catch (err) {
      setError(err.message || 'Failed to retrieve bill')
    } finally {
      setLoading(false)
    }
  }

  const handleClose = () => {
    setBillNoInput('')
    setError(null)
    onClose()
  }

  if (!open) return null

  return (
    <div className="hold-retrieve-overlay" onClick={handleClose}>
      <div className="hold-retrieve-modal" onClick={(e) => e.stopPropagation()}>
        <div className="hold-retrieve-header">
          <h3>Retrieve held bill</h3>
          <button type="button" className="hold-retrieve-close" onClick={handleClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="hold-retrieve-body">
          <form className="hold-retrieve-form" onSubmit={handleRetrieve}>
            <label htmlFor="hold-retrieve-billno" className="hold-retrieve-label">
              Bill number
            </label>
            <input
              id="hold-retrieve-billno"
              type="text"
              inputMode="numeric"
              placeholder="Enter bill number"
              value={billNoInput}
              onChange={(e) => {
                setBillNoInput(e.target.value)
                setError(null)
              }}
              className="hold-retrieve-input"
              autoFocus
              disabled={loading}
            />
            {error && <p className="hold-retrieve-error">{error}</p>}
            <button type="submit" className="hold-retrieve-submit" disabled={loading}>
              {loading ? 'Loading…' : 'Retrieve'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
