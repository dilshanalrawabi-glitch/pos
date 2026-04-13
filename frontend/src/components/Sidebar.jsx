import '../styles/Sidebar.css'

function Sidebar({ activeMenu = 'dashboard', onMenuSelect, user, onLogout, isOpen, onClose, locationCode = '', locationName = '', counterCode = '', counterName = '' }) {
  const roleLabel = user?.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : ''
  const displayName = user?.userid ?? user?.username ?? ''
  const role = (user?.role || '').toLowerCase()
  const roll = Number(user?.rollcode ?? user?.rolecode ?? NaN)
  const billDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-')
  // ROLECODE 1=IT (full), 2=Supervisor (Billing+CounterOpen), 3=Cashier (Billing only)
  const isIT = role === 'it' || role === 'manager' || role === 'admin'
  const isSupervisor = role === 'supervisor'
  const isCashier = role === 'cashier' || roll === 3
  const menuItems = [
    ...(!isCashier ? [{ id: 'dashboard', label: 'Dashboard', icon: '📋' }] : []),
    { id: 'billing', label: 'Billing', icon: '📊' },
    ...(isIT ? [{ id: 'customers', label: 'Customers', icon: '👥' }] : []),
    ...(isIT ? [{ id: 'counter-setup', label: 'Counter Setup', icon: '🖥️' }] : []),
    ...(isSupervisor ? [{ id: 'counter-open', label: 'Counter Open', icon: '🖥️' }] : []),
    ...(isIT ? [{ id: 'settings', label: 'Settings', icon: '⚙️' }] : []),
  ]

  return (
    <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
      <div className="sidebar-header">
        <h2>POS Admin</h2>
        {onClose && (
          <button type="button" className="sidebar-close-btn" onClick={onClose} aria-label="Close menu">
            X
          </button>
        )}
        {user && (
          <>
            <span className="sidebar-user-name">{displayName} - {roleLabel}</span>
          
          </>
        )}
      </div>

      <div className="sidebar-pos-info">
        <span>Location code: {locationCode || '—'}</span>
        <span>Location name: {locationName || '—'}</span>
        <span>Bill date: {billDate}</span>
        <span>Counter: {counterCode} {counterName}</span>
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
          <button
            type="button"
            className="sidebar-back-display-btn"
            onClick={() => {
              const base = window.location.origin + window.location.pathname.replace(/\/$/, '')
              const params = new URLSearchParams({
                display: 'back',
                counterCode: counterCode || sessionStorage.getItem('pos_counter_code') || 'CNT01',
                locationCode: locationCode || sessionStorage.getItem('pos_location') || 'LOC001',
              })
              window.open(`${base}?${params.toString()}`, 'pos-back-display', 'width=480,height=720,menubar=no,toolbar=no')
            }}
            title="Open customer display in new window"
            aria-label="Open back display"
          >
            🖥️ Back display
          </button>
          <button type="button" className="logout-btn" onClick={onLogout}>
            Logout
          </button>
        </div>
      )}
    </aside>
  )
}

export default Sidebar
