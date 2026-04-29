import { useState, useRef } from 'react'
import '../styles/Login.css'
import { getApiBase } from '../apiBase'

function launcherDownloadHref() {
  const override = import.meta.env.VITE_LAUNCHER_DOWNLOAD_URL
  if (override != null && String(override).trim() !== '') {
    return String(override).trim()
  }
  return `${getApiBase()}/downloads/PS_LAUNCHER.exe`
}

function Login({ onLogin, loading, error }) {
  const [employeecode, setEmployeecode] = useState('')
  const [password, setPassword] = useState('')
  const [passwordEditable, setPasswordEditable] = useState(false)
  const passwordRef = useRef(null)
  const submitRef = useRef(null)

  const focusNextFromEmployee = (e) => {
    if (e.key === 'Enter' && e.nativeEvent.isComposing) return
    if (e.key !== 'Enter' && e.key !== 'ArrowDown') return
    e.preventDefault()
    passwordRef.current?.focus()
  }

  const focusSubmitFromPassword = (e) => {
    if (e.key !== 'ArrowDown') return
    e.preventDefault()
    submitRef.current?.focus()
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    onLogin({ username: employeecode.trim(), password })
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>POS Login</h1>
        <p className="login-subtitle">Sign in with employee code and password</p>

        <form onSubmit={handleSubmit} className="login-form" autoComplete="off">
          <div className="form-group">
            <label htmlFor="employeecode">Employee code</label>
            <input
              id="employeecode"
              name="employeecode"
              type="text"
              value={employeecode}
              onChange={(e) => setEmployeecode(e.target.value)}
              onKeyDown={focusNextFromEmployee}
              placeholder="Employee code"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              ref={passwordRef}
              id="password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={focusSubmitFromPassword}
              placeholder="••••••••"
              autoComplete="off"
              spellCheck={false}
              readOnly={!passwordEditable}
              onFocus={() => setPasswordEditable(true)}
              required
            />
          </div>
          {error && <p className="login-error">{error}</p>}
          <button
            ref={submitRef}
            type="submit"
            className="login-btn"
            disabled={loading}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
      <a
        className="login-launcher-download"
        href={launcherDownloadHref()}
        download
      >
        Download PS Launcher
      </a>
    </div>
  )
}

export default Login
