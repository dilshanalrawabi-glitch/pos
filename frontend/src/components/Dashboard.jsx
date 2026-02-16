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
  selectedCartItemId,
  onSelectCartItem,
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
  const [showQtyModal, setShowQtyModal] = useState(false)
  const [qtySelectedId, setQtySelectedId] = useState(null)
  const [qtyKeypadInput, setQtyKeypadInput] = useState('')
  const customerSearchRef = useRef(null)

  const getItemId = (item) => item?.id ?? item?.ITEMCODE ?? item?.itemCode ?? ''

  const handleQtyKeypad = (key) => {
    if (key === '⌫') {
      setQtyKeypadInput((s) => s.slice(0, -1))
      return
    }
    if (key === 'OK') {
      if (qtySelectedId !== null && qtySelectedId !== undefined && qtySelectedId !== '') {
        const val = Math.max(0, parseInt(qtyKeypadInput, 10) || 0)
        if (typeof onUpdateQuantity === 'function') {
          onUpdateQuantity(qtySelectedId, val)
        }
      }
      setQtyKeypadInput('')
      setQtySelectedId(null)
      setShowQtyModal(false)
      return
    }
    setQtyKeypadInput((s) => (s + key).slice(0, 6))
  }

  const prevShowQtyModalRef = useRef(false)
  const selectedCartItemIdRef = useRef(selectedCartItemId)
  selectedCartItemIdRef.current = selectedCartItemId
  useEffect(() => {
    if (showQtyModal && !prevShowQtyModalRef.current && cartItems.length > 0) {
      const sid = selectedCartItemIdRef.current
      const selectedItem = sid
        ? cartItems.find((i) => String(getItemId(i)) === String(sid) && !i.void)
        : null
      const item = selectedItem ?? cartItems.find((i) => !i.void) ?? cartItems[0]
      setQtySelectedId(getItemId(item))
      setQtyKeypadInput(String(item.quantity ?? 0))
    }
    prevShowQtyModalRef.current = showQtyModal
  }, [showQtyModal, cartItems])

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
              selectedCartItemId={selectedCartItemId}
              onHold={onHold}
              onHoldRetrieve={onHoldRetrieve}
              onVoidLine={onVoidLine}
              onSuspendBill={onSuspendBill}
              onQty={() => setShowQtyModal(true)}
              onCheckout={onCheckout}
            />
          </section>
        </aside>
        {showQtyModal && (
          <div className="qty-modal-overlay" onClick={() => setShowQtyModal(false)}>
            <div className="qty-modal qty-modal-with-keypad" onClick={e => e.stopPropagation()}>
              <div className="qty-modal-header">
                <h3>Edit quantity</h3>
                <button type="button" className="qty-modal-close" onClick={() => setShowQtyModal(false)} aria-label="Close">×</button>
              </div>
              <div className="qty-modal-body">
                {cartItems.length === 0 ? (
                  <p className="qty-modal-empty">Cart is empty.</p>
                ) : qtySelectedId == null || qtySelectedId === '' ? (
                  <p className="qty-modal-empty">Select an item in the cart, then click Quantity.</p>
                ) : (
                  <div className="qty-keypad-wrap">
                    <p className="qty-keypad-hint">
                      {cartItems.find(i => String(getItemId(i)) === String(qtySelectedId))?.name || 'Item'}
                    </p>
                    <div className="qty-keypad-label">Quantity</div>
                    <div className="qty-keypad-display">{qtyKeypadInput || '0'}</div>
                    <div className="qty-keypad">
                      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                        <button key={d} type="button" className="qty-keypad-key" onClick={() => handleQtyKeypad(d)}>{d}</button>
                      ))}
                      <button type="button" className="qty-keypad-key qty-keypad-back" onClick={() => handleQtyKeypad('⌫')}>⌫</button>
                      <button type="button" className="qty-keypad-key" onClick={() => handleQtyKeypad('0')}>0</button>
                      <button type="button" className="qty-keypad-key qty-keypad-ok" onClick={() => handleQtyKeypad('OK')}>OK</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
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
            selectedItemId={selectedCartItemId}
            onSelectItem={(item) => onSelectCartItem?.(getItemId(item))}
          />
        </section>
      </div>
    </div>
  )
}

export default Dashboard

