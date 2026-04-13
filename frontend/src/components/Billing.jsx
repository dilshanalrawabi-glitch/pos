import { useState, useEffect, useRef } from 'react'
import PosActionsBar from './PosActionsBar'
import CartSummary from './CartSummary'
import '../styles/Billing.css'

function formatBillDate(date) {
  const d = date || new Date()
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).replace(/\//g, '-')
}

function Billing({
  cartItems,
  products = [],
  onAddToCart,
  customers,
  selectedCustomer,
  onSelectCustomer,
  onUpdateQuantity,
  onRemove,
  onClear,
  onCheckout,
  onTotalPointsChange,
  onLinePointsChange,
  onHold,
  onHoldRetrieve,
  selectedCartItemId,
  onSelectCartItem,
  onVoidLine,
  onSuspendBill,
  isSalesReturn = false,
  onToggleSalesReturn,
  onRequestQty,
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
  const customerInputRef = useRef(null)

  const getItemId = (item) => item?.id ?? item?.ITEMCODE ?? item?.itemCode ?? ''

  const handleQtyKeypad = (key) => {
    if (key === '⌫') {
      setQtyKeypadInput((s) => s.slice(0, -1))
      return
    }
    if (key === 'OK') {
      if (qtySelectedId !== null && qtySelectedId !== undefined && qtySelectedId !== '') {
        const parsed = parseInt(qtyKeypadInput, 10)
        const num = Number.isNaN(parsed) ? 0 : parsed
        const val = isSalesReturn
          ? (num === 0 ? 0 : -Math.abs(num))
          : Math.max(0, num)
        if (typeof onUpdateQuantity === 'function') {
          onUpdateQuantity(qtySelectedId, val)
        }
      }
      setQtyKeypadInput('')
      setQtySelectedId(null)
      setShowQtyModal(false)
      return
    }
    setQtyKeypadInput((s) => (s + key).replace(/\D/g, '').slice(0, 6))
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
      const q = item.quantity ?? 0
      setQtyKeypadInput(isSalesReturn ? String(Math.abs(q)) : String(q >= 0 ? q : Math.abs(q)))
    }
    prevShowQtyModalRef.current = showQtyModal
  }, [showQtyModal, cartItems, isSalesReturn])

  const getCustomerName = (c) => {
    if (!c) return ''
    const full = c.CUST_FULL_NAME || c.cust_full_name
    if (full) return String(full).trim()
    const code = String(c.CUSTOMERCODE || c.customercode || '').trim()
    const name = String(c.CUSTOMERNAME || c.customername || '').trim()
    return [code, name].filter(Boolean).join(' ')
  }
  const getCustomerCode = (c) => String((c && (c.CUSTOMERCODE ?? c.customercode)) ?? '')
  const getCustomerMobile = (c) =>
    String((c && (c.MOBILE ?? c.mobile)) ?? '').trim()
  const digitsOnly = (s) => String(s || '').replace(/\D/g, '')
  const getCategoryName = (c) => (c && (c.CATEGORYNAME || c.categoryname)) || ''
  const getInvoiceTypeLabel = (c) => {
    if (!c) return ''
    const code = c.INVOICECODE ?? c.invoicecode
    if (code === 1 || code === '1') return 'Cash'
    if (code === 2 || code === '2') return 'Credit'
    return ''
  }
  const q = (customerSearch || '').trim().toLowerCase()
  const qDigits = digitsOnly(customerSearch)
  const filteredCustomers = q
    ? (customers || []).filter((c) => {
        const name = getCustomerName(c).toLowerCase()
        const code = getCustomerCode(c).toLowerCase()
        const mobile = getCustomerMobile(c)
        const mobileDigits = digitsOnly(mobile)
        const byText = name.includes(q) || code.includes(q)
        const byPhone =
          qDigits.length > 0 &&
          mobileDigits.length > 0 &&
          mobileDigits.includes(qDigits)
        return byText || byPhone
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

  const openCustomerPicker = () => {
    setCustomerSearch('')
    setShowCustomerDropdown(true)
  }

  useEffect(() => {
    if (!showCustomerDropdown) return
    const t = requestAnimationFrame(() => {
      customerInputRef.current?.focus()
    })
    return () => cancelAnimationFrame(t)
  }, [showCustomerDropdown])

  const showSearchRow = !selectedCustomer || showCustomerDropdown

  return (
    <div className="dashboard-pos">
      <div className="dashboard-main">
        <aside className="dashboard-left">
          <section className="dashboard-add-card" ref={customerSearchRef}>
            <h2 className="dashboard-card-title">Customer</h2>
            {selectedCustomer && !showCustomerDropdown && (
              <button
                type="button"
                className="dashboard-customer-selected"
                onClick={openCustomerPicker}
                aria-expanded={false}
                aria-haspopup="listbox"
                aria-label="Change customer"
              >
                <span className="dashboard-customer-name">{getCustomerName(selectedCustomer)}</span>
                <span className="dashboard-customer-chevron" aria-hidden>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path
                      d="M6 9l6 6 6-6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </button>
            )}
            {showSearchRow && (
              <>
                <input
                  ref={customerInputRef}
                  type="text"
                  className="dashboard-scan-input"
                  placeholder="Search name, code, or phone..."
                  value={customerSearch}
                  onChange={(e) => {
                    setCustomerSearch(e.target.value)
                    setShowCustomerDropdown(true)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const first = filteredCustomers[0]
                      if (first) {
                        handleSelectCustomer(first)
                      }
                      setShowCustomerDropdown(false)
                    }
                    if (e.key === 'Escape' && selectedCustomer) {
                      setShowCustomerDropdown(false)
                      setCustomerSearch('')
                    }
                  }}
                  onFocus={() => setShowCustomerDropdown(true)}
                  autoComplete="off"
                />
                {showCustomerDropdown && (
                  <div className="dashboard-customer-dropdown" role="listbox">
                    {filteredCustomers.length === 0 ? (
                      <div className="dashboard-customer-empty">No customers found</div>
                    ) : (
                      filteredCustomers.slice(0, 20).map((c, index) => {
                        const cur =
                          selectedCustomer &&
                          getCustomerCode(c) &&
                          getCustomerCode(c) === getCustomerCode(selectedCustomer)
                        return (
                          <button
                            key={getCustomerCode(c) || index}
                            type="button"
                            className={
                              cur
                                ? 'dashboard-customer-option dashboard-customer-option-current'
                                : 'dashboard-customer-option'
                            }
                            role="option"
                            aria-selected={!!cur}
                            onClick={() => handleSelectCustomer(c)}
                          >
                            <span className="dashboard-customer-option-name">{getCustomerName(c)}</span>
                            {getCustomerMobile(c) && (
                              <span className="dashboard-customer-option-cat">{getCustomerMobile(c)}</span>
                            )}
                            {getCategoryName(c) && (
                              <span className="dashboard-customer-option-cat">{getCategoryName(c)}</span>
                            )}
                            {getInvoiceTypeLabel(c) && (
                              <span className="dashboard-customer-option-type">{getInvoiceTypeLabel(c)}</span>
                            )}
                          </button>
                        )
                      })
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
              selectedCartItemId={selectedCartItemId}
              selectedCustomer={selectedCustomer}
              onHold={onHold}
              onHoldRetrieve={onHoldRetrieve}
              onVoidLine={onVoidLine}
              onSuspendBill={onSuspendBill}
              onQty={() => (onRequestQty ? onRequestQty(() => setShowQtyModal(true)) : setShowQtyModal(true))}
              onCheckout={onCheckout}
              isSalesReturn={isSalesReturn}
              onToggleSalesReturn={onToggleSalesReturn}
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
                    <div className="qty-keypad-label">Quantity{isSalesReturn ? ' (return: negative)' : ''}</div>
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
            selectedCustomer={selectedCustomer}
            onTotalPointsChange={onTotalPointsChange}
            onLinePointsChange={onLinePointsChange}
          />
        </section>
      </div>
    </div>
  )
}

export default Billing
