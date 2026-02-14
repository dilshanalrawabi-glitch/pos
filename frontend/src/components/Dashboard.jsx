import { useState, useEffect, useRef } from 'react'
import PosActionsBar from './PosActionsBar'
import CartSummary from './CartSummary'
import '../styles/Dashboard.css'

function formatBillDate(date) {
  const d = date || new Date()
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).replace(/\//g, '-')
}

function Dashboard({
  cartItems,
  products = [],
  onAddToCart,
  customers,
  selectedCustomer,
  onSelectCustomer,
  onClearCustomer,
  onUpdateQuantity,
  onRemove,
  onClear,
  onCheckout,
  onHold,
  onHoldRetrieve,
  onVoidLine,
  onSuspendBill,
  hasHeldCart,
  locationCode = 'LOC001',
  counterCode = '20',
  counterName = 'Counter 1',
  billNo = 1,
  apiBase,
}) {
  const [customerSearch, setCustomerSearch] = useState('')
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false)
  const customerSearchRef = useRef(null)

  const getCustomerName = (c) => {
    if (!c) return ''
    const full = c.CUST_FULL_NAME || c.cust_full_name
    if (full) return String(full).trim()
    const code = String(c.CUSTOMERCODE || c.customercode || '').trim()
    const name = String(c.CUSTOMERNAME || c.customername || '').trim()
    return [code, name].filter(Boolean).join(' ')
  }
  const getCustomerCode = (c) => String((c && (c.CUSTOMERCODE ?? c.customercode)) ?? '')
  const getCategoryName = (c) => (c && (c.CATEGORYNAME || c.categoryname)) || ''
  const q = (customerSearch || '').trim().toLowerCase()
  const filteredCustomers = q
    ? (customers || []).filter((c) => {
        const name = getCustomerName(c).toLowerCase()
        const code = getCustomerCode(c).toLowerCase()
        return name.includes(q) || code.includes(q)
      })
    : (customers || [])

  useEffect(() => {
    function handleClickOutside(e) {
      if (customerSearchRef.current && !customerSearchRef.current.contains(e.target)) setShowCustomerDropdown(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleSelectCustomer = (customer) => {
    onSelectCustomer?.(customer)
    setCustomerSearch('')
    setShowCustomerDropdown(false)
  }

  return (
    <div className="dashboard-pos">
      <div className="dashboard-main">
        <aside className="dashboard-left">
          <section className="dashboard-add-card" ref={customerSearchRef}>
            <h2 className="dashboard-card-title">Customer</h2>
            <p className="dashboard-card-hint">Search customers</p>
            {selectedCustomer ? (
              <div className="dashboard-customer-selected">
                <span className="dashboard-customer-name">{getCustomerName(selectedCustomer)}</span>
                <button
                  type="button"
                  className="dashboard-customer-clear"
                  onClick={onClearCustomer}
                  title="Clear customer"
                  aria-label="Clear customer"
                >
                  ×
                </button>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  className="dashboard-scan-input"
                  placeholder="Search customers..."
                  value={customerSearch}
                  onChange={(e) => {
                    setCustomerSearch(e.target.value)
                    setShowCustomerDropdown(true)
                  }}
                  onFocus={() => setShowCustomerDropdown(true)}
                  autoComplete="off"
                />
                {showCustomerDropdown && (
                  <div className="dashboard-customer-dropdown">
                    {filteredCustomers.length === 0 ? (
                      <div className="dashboard-customer-empty">No customers found</div>
                    ) : (
                      filteredCustomers.slice(0, 20).map((c, index) => (
                        <button
                          key={getCustomerCode(c) || index}
                          type="button"
                          className="dashboard-customer-option"
                          onClick={() => handleSelectCustomer(c)}
                        >
                          <span className="dashboard-customer-option-name">{getCustomerName(c)}</span>
                          {getCategoryName(c) && (
                            <span className="dashboard-customer-option-cat">{getCategoryName(c)}</span>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </>
            )}
          </section>
          <section className="dashboard-actions-card">
            <h2 className="dashboard-card-title">Actions</h2>
            <PosActionsBar
              cartItems={cartItems}
              hasHeldCart={hasHeldCart}
              onHold={onHold}
              onHoldRetrieve={onHoldRetrieve}
              onVoidLine={onVoidLine}
              onSuspendBill={onSuspendBill}
              onCheckout={onCheckout}
            />
          </section>
        </aside>
        <section className="dashboard-cart-section">
          <CartSummary
            cartItems={cartItems}
            customers={customers}
            selectedCustomer={selectedCustomer}
            onClearCustomer={onClearCustomer}
            onUpdateQuantity={onUpdateQuantity}
            onRemove={onRemove}
            onClear={onClear}
            onCheckout={onCheckout}
            billNo={billNo}
            products={products}
            onAddToCart={onAddToCart}
            apiBase={apiBase}
          />
        </section>
      </div>
    </div>
  )
}

export default Dashboard

