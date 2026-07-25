import { useState, useRef, useEffect } from 'react'
import '../styles/HoldRetrieveModal.css'

export default function SupervisorValidateModal({ open, onClose, onSuccess, actionLabel, apiBase }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [userEditable, setUserEditable] = useState(false)
  const [passEditable, setPassEditable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const passwordInputRef = useRef(null)
  const usernameInputRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => usernameInputRef.current?.focus(), 100)
    return () => window.clearTimeout(id)
  }, [open])

  const handleUsernameKeyDown = (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const trimmed = (e.target.value || '').trim()
    setUsername(trimmed)
    setTimeout(() => {
      passwordInputRef.current?.focus()
    }, 100)
  }

  const handleSubmit = async (e) => {
    e?.preventDefault()
    const u = (username || '').trim()
    const p = password || ''
    if (!u || !p) {
      setError('Enter username and password')
      return
    }
    if (!apiBase) return
    setError(null)
    setLoading(true)
    try {
      const res = await fetch(`${apiBase}/api/validate-supervisor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Validation failed')
      setUsername('')
      setPassword('')
      setUserEditable(false)
      setPassEditable(false)
      onSuccess?.()
      onClose()
    } catch (err) {
      setError(err.message || 'Validation failed')
    } finally {
      setLoading(false)
    }
  }

  const handleClose = () => {
    setUsername('')
    setPassword('')
    setUserEditable(false)
    setPassEditable(false)
    setError(null)
    onClose()
  }

  if (!open) return null

  return (
    <div className="hold-retrieve-overlay" onClick={handleClose}>
      <div className="hold-retrieve-modal supervisor-validate-modal" onClick={(e) => e.stopPropagation()}>
        <div className="hold-retrieve-header">
          <h3>Supervisor required – {actionLabel}</h3>
          <button type="button" className="hold-retrieve-close" onClick={handleClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="hold-retrieve-body">
          <form className="hold-retrieve-form" onSubmit={handleSubmit} autoComplete="off">
            <label htmlFor="supervisor-username" className="hold-retrieve-label">
              Username
            </label>
            <input
              ref={usernameInputRef}
              id="supervisor-username"
              name="supervisor-username"
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => { setUsername(e.target.value); setError(null) }}
              onKeyDown={handleUsernameKeyDown}
              className="hold-retrieve-input"
              autoComplete="off"
              spellCheck={false}
              readOnly={!userEditable}
              onFocus={() => setUserEditable(true)}
              disabled={loading}
            />
            <label htmlFor="supervisor-password" className="hold-retrieve-label">
              Password
            </label>
            <input
              ref={passwordInputRef}
              id="supervisor-password"
              name="supervisor-password"
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null) }}
              className="hold-retrieve-input"
              autoComplete="off"
              spellCheck={false}
              readOnly={!passEditable}
              onFocus={() => setPassEditable(true)}
              disabled={loading}
            />
            {error && <p className="hold-retrieve-error">{error}</p>}
            <button type="submit" className="hold-retrieve-submit" disabled={loading}>
              {loading ? 'Validating…' : 'Validate'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
