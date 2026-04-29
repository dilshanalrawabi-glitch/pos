import { useState, useEffect, useLayoutEffect, useRef } from 'react'
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
  onCheckout,
  checkoutLoading = false,
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
  onRegisterQuickCustomer,
}) {
  const cartHasReturnLines =
    Array.isArray(cartItems) && cartItems.some((i) => !i.void && Number(i.quantity) < 0)
  const qtyReturnMode = isSalesReturn || cartHasReturnLines

  const [customerSearch, setCustomerSearch] = useState('')
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false)
  const [showCustomerAddModal, setShowCustomerAddModal] = useState(false)
  const [customerAddMobile, setCustomerAddMobile] = useState('')
  const [customerAddQid, setCustomerAddQid] = useState('')
  const [customerAddName, setCustomerAddName] = useState('')
  const [customerAddError, setCustomerAddError] = useState('')
  const [customerAddSaving, setCustomerAddSaving] = useState(false)
  const [showQtyModal, setShowQtyModal] = useState(false)
  const [qtySelectedId, setQtySelectedId] = useState(null)
  const [qtyKeypadInput, setQtyKeypadInput] = useState('')
  const customerSearchRef = useRef(null)
  const customerInputRef = useRef(null)
  const customerAddMobileInputRef = useRef(null)

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
        const val = qtyReturnMode
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
      setQtyKeypadInput(qtyReturnMode ? String(Math.abs(q)) : String(q >= 0 ? q : Math.abs(q)))
    }
    prevShowQtyModalRef.current = showQtyModal
  }, [showQtyModal, cartItems, qtyReturnMode])

  const openQtyModalWithSupervisor = () => {
    if (typeof onRequestQty === 'function') {
      onRequestQty(() => setShowQtyModal(true))
    } else {
      setShowQtyModal(true)
    }
  }

  const openQtyModalIncrease = () => {
    setShowQtyModal(true)
  }

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
  const getCustomerQid = (c) =>
    String((c && (c.QID ?? c.qid ?? c.QIDNO ?? c.qidno)) ?? '').trim()
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
        const qidDigits = digitsOnly(getCustomerQid(c))
        const byText = name.includes(q) || code.includes(q)
        const byPhone =
          qDigits.length > 0 &&
          mobileDigits.length > 0 &&
          mobileDigits.includes(qDigits)
        const byQid =
          qDigits.length > 0 &&
          qidDigits.length > 0 &&
          qidDigits.includes(qDigits)
        return byText || byPhone || byQid
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

  const openCustomerAddModal = () => {
    setCustomerAddMobile('')
    setCustomerAddQid('')
    setCustomerAddName('')
    setCustomerAddError('')
    setShowCustomerAddModal(true)
  }

  const closeCustomerAddModal = () => {
    setShowCustomerAddModal(false)
    setCustomerAddError('')
  }

  const customerAddMobileDigits = digitsOnly(customerAddMobile).slice(0, 8)
  const customerAddQidDigits = digitsOnly(customerAddQid).slice(0, 11)

  const handleSaveCustomerAdd = async () => {
    const name = (customerAddName || '').trim()
    const mobile = customerAddMobileDigits
    const qid = customerAddQidDigits
    if (mobile.length !== 8 || qid.length !== 11 || !name) {
      setCustomerAddError('Please complete all columns.')
      return
    }
    if (typeof onRegisterQuickCustomer !== 'function') {
      setCustomerAddError('Customer registration is not available.')
      return
    }
    setCustomerAddSaving(true)
    setCustomerAddError('')
    try {
      await onRegisterQuickCustomer({ name, mobile, qid, locationCode })
      setShowCustomerDropdown(false)
      setCustomerSearch('')
      closeCustomerAddModal()
    } catch (err) {
      const msg = err && typeof err.message === 'string' ? err.message : 'Could not save customer.'
      setCustomerAddError(msg)
    } finally {
      setCustomerAddSaving(false)
    }
  }

  useEffect(() => {
    if (!showCustomerDropdown) return
    const t = requestAnimationFrame(() => {
      customerInputRef.current?.focus()
    })
    return () => cancelAnimationFrame(t)
  }, [showCustomerDropdown])

  // After "Customer add", focus stays on the action button (see PosActionsBar clearFocusedInput).
  // Keystrokes then go to the button, not the inputs — especially noticeable in Firefox.
  useLayoutEffect(() => {
    if (!showCustomerAddModal) return
    let cancelled = false
    const run = () => {
      if (cancelled) return
      customerAddMobileInputRef.current?.focus({ preventScroll: true })
    }
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(run)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(id)
    }
  }, [showCustomerAddModal])

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
                  spellCheck={false}
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
              onQtyIncrease={openQtyModalIncrease}
              onQtyDecrease={openQtyModalWithSupervisor}
              onCheckout={onCheckout}
              checkoutLoading={checkoutLoading}
              isSalesReturn={isSalesReturn}
              qtyReturnMode={qtyReturnMode}
              onToggleSalesReturn={onToggleSalesReturn}
              onCustomerAdd={openCustomerAddModal}
            />
          </section>
        </aside>
        {showCustomerAddModal && (
          <div className="qty-modal-overlay" onClick={closeCustomerAddModal}>
            <div
              className="qty-modal customer-add-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="customer-add-modal-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="qty-modal-header">
                <h3 id="customer-add-modal-title">Add customer</h3>
                <button type="button" className="qty-modal-close" onClick={closeCustomerAddModal} aria-label="Close">
                  ×
                </button>
              </div>
              <div className="qty-modal-body">
                <form
                  className="customer-add-form"
                  autoComplete="off"
                  onSubmit={(e) => e.preventDefault()}
                >
                  <label className="customer-add-field">
                    <span className="customer-add-label">Mobile no.</span>
                    <input
                      ref={customerAddMobileInputRef}
                      type="tel"
                      inputMode="numeric"
                      className="dashboard-scan-input customer-add-input"
                      value={customerAddMobile}
                      onChange={(e) => setCustomerAddMobile(digitsOnly(e.target.value).slice(0, 8))}
                      placeholder="e.g. 55123456"
                      maxLength={8}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label className="customer-add-field">
                    <span className="customer-add-label">QID no.</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      className="dashboard-scan-input customer-add-input"
                      value={customerAddQid}
                      onChange={(e) => setCustomerAddQid(digitsOnly(e.target.value).slice(0, 11))}
                      placeholder="Qatar ID"
                      maxLength={11}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label className="customer-add-field">
                    <span className="customer-add-label">Customer Name</span>
                    <input
                      type="text"
                      className="dashboard-scan-input customer-add-input"
                      value={customerAddName}
                      onChange={(e) => setCustomerAddName(e.target.value)}
                      placeholder="Full name"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  {customerAddError ? <p className="customer-add-error">{customerAddError}</p> : null}
                  <div className="customer-add-actions">
                    <button
                      type="button"
                      className="customer-add-btn-cancel"
                      onClick={closeCustomerAddModal}
                      disabled={customerAddSaving}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="customer-add-btn-save"
                      onClick={handleSaveCustomerAdd}
                      disabled={customerAddSaving}
                    >
                      {customerAddSaving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        )}
        {showQtyModal && (
          <div className="qty-modal-overlay" onClick={() => setShowQtyModal(false)}>
            <div className="qty-modal qty-modal-with-keypad" onClick={(e) => e.stopPropagation()}>
              <div className="qty-modal-header">
                <h3>Edit quantity</h3>
                <button type="button" className="qty-modal-close" onClick={() => setShowQtyModal(false)} aria-label="Close">
                  ×
                </button>
              </div>
              <div className="qty-modal-body">
                {cartItems.length === 0 ? (
                  <p className="qty-modal-empty">Cart is empty.</p>
                ) : qtySelectedId == null || qtySelectedId === '' ? (
                  <p className="qty-modal-empty">Select an item in the cart, then use Quantity + or −.</p>
                ) : (
                  <div className="qty-keypad-wrap">
                    <p className="qty-keypad-hint">
                      {cartItems.find((i) => String(getItemId(i)) === String(qtySelectedId))?.name || 'Item'}
                    </p>
                    <div className="qty-keypad-label">Quantity{qtyReturnMode ? ' (return: negative)' : ''}</div>
                    <div className="qty-keypad-display">{qtyKeypadInput || '0'}</div>
                    <div className="qty-keypad">
                      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                        <button key={d} type="button" className="qty-keypad-key" onClick={() => handleQtyKeypad(d)}>
                          {d}
                        </button>
                      ))}
                      <button type="button" className="qty-keypad-key qty-keypad-back" onClick={() => handleQtyKeypad('⌫')}>
                        ⌫
                      </button>
                      <button type="button" className="qty-keypad-key" onClick={() => handleQtyKeypad('0')}>
                        0
                      </button>
                      <button type="button" className="qty-keypad-key qty-keypad-ok" onClick={() => handleQtyKeypad('OK')}>
                        OK
                      </button>
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
            onCheckout={onCheckout}
            checkoutLoading={checkoutLoading}
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
