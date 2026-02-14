import { useState } from 'react'
import '../styles/Sidebar.css'

function Sidebar({ activeMenu = 'items', onMenuSelect, user, onLogout, isOpen, onClose }) {
  const roleLabel = user?.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : ''
  const displayName = user?.userid ?? user?.username ?? ''
  const isManager = (user?.role || '').toLowerCase() === 'manager'
  const isAdmin = (user?.role || '').toLowerCase() === 'admin' || isManager
  const menuItems = [
    { id: 'dashboard', label: 'Billing', icon: '📊' },
    { id: 'items', label: 'Dashboard', icon: '📦' },
    { id: 'orders', label: 'Orders', icon: '🛒' },
    { id: 'customers', label: 'Customers', icon: '👥' },
    ...(isAdmin ? [{ id: 'counter-setup', label: 'Counter Setup', icon: '🖥️' }] : []),
    ...(isManager ? [{ id: 'users', label: 'Users', icon: '👤' }] : []),
    { id: 'settings', label: 'Settings', icon: '⚙️' },
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

        {/* Active Section Content */}
        <div className="menu-content">
          {activeMenu === 'dashboard' && (
            <section>
              <h3>Billing</h3>
              <div className="content-stats">
                <div className="stat-item">
                  <p>Total Sales</p>
                  <p className="stat-value">$0.00</p>
                </div>
                <div className="stat-item">
                  <p>Orders Today</p>
                  <p className="stat-value">0</p>
                </div>
                <div className="stat-item">
                  <p>Total Customers</p>
                  <p className="stat-value">0</p>
                </div>
              </div>
            </section>
          )}

          {activeMenu === 'items' && (
            <section>
              <h3>Dashboard</h3>
              <button className="action-btn">+ Add Item</button>
              <p className="info-text">Manage your product inventory here</p>
            </section>
          )}

          {activeMenu === 'orders' && (
            <section>
              <h3>Orders</h3>
              <button className="action-btn">View All Orders</button>
              <p className="info-text">Track and manage all customer orders</p>
            </section>
          )}

          {activeMenu === 'customers' && (
            <section>
              <h3>Customers</h3>
              <button className="action-btn">+ Add Customer</button>
              <p className="info-text">Manage customer information and history</p>
            </section>
          )}

          {activeMenu === 'counter-setup' && (
            <section>
              <h3>Counter Setup</h3>
              <p className="info-text">System name, IP (from .exe), counter code and name. Admin only.</p>
            </section>
          )}

          {activeMenu === 'settings' && (
            <section>
              <h3>Settings</h3>
              <div className="settings-list">
                <div className="settings-item">
                  <p>Store Name</p>
                  <input type="text" placeholder="Enter store name" />
                </div>
                <div className="settings-item">
                  <p>Tax Rate (%)</p>
                  <input type="number" placeholder="10" />
                </div>
                <button className="action-btn">Save Settings</button>
              </div>
            </section>
          )}
        </div>
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
