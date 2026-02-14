import { useState, useEffect } from 'react'
import '../styles/UserManagement.css'

const ROLES = [
  { value: 'manager', label: 'Manager' },
  { value: 'cashier', label: 'Cashier' },
  { value: 'user', label: 'User' },
]

function UserManagement({ apiBase, token }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [role, setRole] = useState('cashier')
  const [password, setPassword] = useState('')

  const fetchUsers = () => {
    if (!token) return
    setLoading(true)
    setError(null)
    fetch(`${apiBase}/api/users`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error(res.status === 403 ? 'Manager role required' : 'Failed to load users')
        return res.json()
      })
      .then((data) => setUsers(Array.isArray(data) ? data : []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchUsers()
  }, [apiBase, token])

  const handleSubmit = (e) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    const trimmedName = name.trim()
    const trimmedCode = code.trim()
    if (!trimmedCode) {
      setError('Code (employee code) is required')
      return
    }
    if (!password) {
      setError('Password is required')
      return
    }
    fetch(`${apiBase}/api/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: trimmedName || trimmedCode,
        code: trimmedCode,
        role: role || 'cashier',
        password,
      }),
    })
      .then((res) => {
        const data = res.json().catch(() => ({}))
        if (!res.ok) {
          return data.then((d) => {
            throw new Error(d.error || `Error ${res.status}`)
          })
        }
        return data
      })
      .then(() => {
        setSuccess('User added successfully')
        setName('')
        setCode('')
        setPassword('')
        fetchUsers()
      })
      .catch((err) => setError(err.message || 'Failed to add user'))
  }

  return (
    <div className="user-management">
      <header className="user-management-header">
        <h2>User Management</h2>
        <p className="user-management-desc">Add users with name, code, and role. Manager role required.</p>
      </header>

      <form onSubmit={handleSubmit} className="user-form">
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="user-name">Name</label>
            <input
              id="user-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Display name"
            />
          </div>
          <div className="form-group">
            <label htmlFor="user-code">Code (Employee code)</label>
            <input
              id="user-code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. emp001"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="user-role">Role</label>
            <select
              id="user-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="user-password">Password</label>
            <input
              id="user-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
            />
          </div>
          <div className="form-group form-actions">
            <button type="submit" className="add-user-btn">
              Add User
            </button>
          </div>
        </div>
        {error && <p className="form-error">{error}</p>}
        {success && <p className="form-success">{success}</p>}
      </form>

      <div className="user-list-section">
        <h3>Users</h3>
        {loading ? (
          <p className="user-list-loading">Loading...</p>
        ) : (
          <div className="user-list">
            {users.length === 0 ? (
              <p className="user-list-empty">No users</p>
            ) : (
              <table className="user-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.code}>
                      <td>{u.code}</td>
                      <td>{u.name}</td>
                      <td>
                        <span className={`role-badge role-${u.role}`}>
                          {(u.role || 'user').charAt(0).toUpperCase() + (u.role || 'user').slice(1)}
                        </span>
                      </td>
                      <td>{u.source === 'added' ? 'Added' : 'System'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default UserManagement
