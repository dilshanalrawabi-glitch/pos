import '../styles/Sidebar.css'

function Sidebar({ activeMenu = 'dashboard', onMenuSelect, user, onLogout, isOpen, onClose }) {
  const roleLabel = user?.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : ''
  const displayName = user?.userid ?? user?.username ?? ''
  const role = (user?.role || '').toLowerCase()
  // ROLECODE 1=IT (full), 2=Supervisor (Billing+CounterOpen), 3=Cashier (Billing only)
  const isIT = role === 'it' || role === 'manager' || role === 'admin'
  const isSupervisor = role === 'supervisor'
  const menuItems = [
    { id: 'dashboard', label: 'Billing', icon: '📊' },
    ...(isIT ? [{ id: 'customers', label: 'Customers', icon: '👥' }] : []),
    ...(isIT ? [{ id: 'counter-setup', label: 'Counter Setup', icon: '🖥️' }] : []),
    ...((isIT || isSupervisor) ? [{ id: 'counter-open', label: 'Counter Open', icon: '🖥️' }] : []),
    ...(isIT ? [{ id: 'users', label: 'Users', icon: '👤' }] : []),
    ...(isIT ? [{ id: 'settings', label: 'Settings', icon: '⚙️' }] : []),
  ]

  return (
    <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
      <div className="sidebar-header">
        <h2>POS Admin</h2>
        {onClose && (
          <button type="button" className="sidebar-close-btn" onClick={onClose} aria-label="Close menu">
            ×
          </button>
        )}
        {user && (
          <>
            <span className="sidebar-user-name">{displayName}</span>
            <span className="sidebar-role">{roleLabel}</span>
          </>
        )}
      </div>

      <div className="sidebar-content">
        {/* Navigation Menu */}
        <nav className="nav-menu">
          {menuItems.map(item => (
            <button
              key={item.id}
              className={`nav-item ${activeMenu === item.id ? 'active' : ''}`}
              onClick={() => onMenuSelect?.(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
      </div>

      {user && onLogout && (
        <div className="sidebar-footer">
          <button type="button" className="logout-btn" onClick={onLogout}>
            Logout
          </button>
        </div>
      )}
    </aside>
  )
}

export default Sidebar
