import { useState, useEffect, useRef } from 'react'
import '../styles/Login.css'
import { getApiBase } from '../apiBase'
import { useKeyboard } from '../context/KeyboardContext'

function launcherDownloadHref() {
  const override = import.meta.env.VITE_LAUNCHER_DOWNLOAD_URL
  if (override != null && String(override).trim() !== '') {
    return String(override).trim()
  }
  return `${getApiBase()}/downloads/PS_LAUNCHER.exe`
}

function Login({ onLogin, loading, error }) {
  const { setFocusedInput } = useKeyboard()
  const [employeecode, setEmployeecode] = useState('')
  const [password, setPassword] = useState('')
  const employeecodeRef = useRef(null)
  const passwordRef = useRef(null)
  const submitRef = useRef(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      if (employeecodeRef.current) {
        employeecodeRef.current.focus({ preventScroll: true })
      }
    }, 100)
    return () => clearTimeout(timer)
  }, [])

  const handleInputClick = (e) => {
    setFocusedInput(e.currentTarget)
  }

  const focusNextFromEmployee = (e) => {
    if (e.key === 'Enter' && e.nativeEvent.isComposing) return
    if (e.key !== 'Enter' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const delay = e.key === 'Enter' ? 100 : 0
    setTimeout(() => {
      const next = passwordRef.current
      next?.focus({ preventScroll: true })
    }, delay)
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
              ref={employeecodeRef}
              id="employeecode"
              name="employeecode"
              type="text"
              value={employeecode}
              onChange={(e) => setEmployeecode(e.target.value)}
              onClick={handleInputClick}
              onKeyDown={focusNextFromEmployee}
              placeholder="Employee code"
              autoComplete="off"
              spellCheck={false}
              data-no-osk="true"
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
              onClick={handleInputClick}
              onKeyDown={focusSubmitFromPassword}
              placeholder="••••••••"
              autoComplete="off"
              spellCheck={false}
              data-no-osk="true"
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
