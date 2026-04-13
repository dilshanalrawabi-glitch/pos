import { useState } from 'react'
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

  const handleSubmit = (e) => {
    e.preventDefault()
    onLogin({ username: employeecode.trim(), password })
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>POS Login</h1>
        <p className="login-subtitle">Sign in with employee code and password</p>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="employeecode">Employee code</label>
            <input
              id="employeecode"
              type="text"
              value={employeecode}
              onChange={(e) => setEmployeecode(e.target.value)}
              placeholder="Employee code"
              autoComplete="username"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />
          </div>
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="login-btn" disabled={loading}>
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
