import { useState } from 'react'
import '../styles/CustomerList.css'

function getCustomerName(c) {
  if (!c) return ''
  const full = c.CUST_FULL_NAME || c.cust_full_name
  if (full) return String(full).trim()
  const code = String(c.CUSTOMERCODE || c.customercode || '').trim()
  const name = String(c.CUSTOMERNAME || c.customername || '').trim()
  return [code, name].filter(Boolean).join(' ')
}

function getCustomerCode(c) {
  return String((c && (c.CUSTOMERCODE ?? c.customercode)) ?? '')
}

function getCategoryName(c) {
  return (c && (c.CATEGORYNAME || c.categoryname)) || ''
}

function CustomerList({ customers = [] }) {
  const [searchQuery, setSearchQuery] = useState('')

  const q = (searchQuery || '').trim().toLowerCase()
  const filtered = q
    ? customers.filter((c) => {
        const name = getCustomerName(c).toLowerCase()
        const code = getCustomerCode(c).toLowerCase()
        return name.includes(q) || code.includes(q)
      })
    : customers

  return (
    <div className="customer-list-view">
      <header className="customer-list-header">
        <h2>Customers</h2>
        <input
          type="text"
          className="customer-list-search"
          placeholder="Search by name or code..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </header>
      <div className="customer-list-content">
        {filtered.length === 0 ? (
          <div className="customer-list-empty">No customers found</div>
        ) : (
          <ul className="customer-list">
            {filtered.map((c, index) => (
              <li key={getCustomerCode(c) || index} className="customer-list-item">
                <span className="customer-list-name">{getCustomerName(c)}</span>
                {getCategoryName(c) && (
                  <span className="customer-list-cat">{getCategoryName(c)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export default CustomerList
