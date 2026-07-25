import { memo, useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
import PosActionsBar from './PosActionsBar'
import CartSummary from './CartSummary'
import CustomerSearch from './CustomerSearch'
import PriceCheckModal from './PriceCheckModal'
import { getItemId } from '../utils/cartItemUtils'
import { PRICE_MODES } from '../utils/priceMode'
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
  productLookupMap,
  onAddToCart,
  onMergeCartLine,
  customers,
  selectedCustomer,
  onSelectCustomer,
  salesChannels,
  selectedSalesChannel,
  onSelectSalesChannel,
  onUpdateQuantity,
  onRemove,
  onCheckout,
  checkoutLoading = false,
  onCartPointsSnapshotChange,
  onItemDetailsCacheChange,
  onHold,
  onHoldRetrieve,
  selectedCartItemId,
  onSelectCartItem,
  onVoidLine,
  onSuspendBill,
  isSalesReturn = false,
  onToggleSalesReturn,
  priceMode = null,
  onSetPriceMode,
  onRequestQty,
  locationCode = 'LOC001',
  counterCode = '20',
  counterName = 'Counter 1',
  billNo = 1,
  apiBase,
  onRegisterQuickCustomer,
  orderNo = '',
  onOrderNoChange,
  productsReady = true,
  itemDetailsCacheResetKey = 0,
}) {
  const [customerPickerKey, setCustomerPickerKey] = useState(0)
  const [showCustomerAddModal, setShowCustomerAddModal] = useState(false)
  const [customerAddMobile, setCustomerAddMobile] = useState('')
  const [customerAddCardNo, setCustomerAddCardNo] = useState('')
  const [customerAddQid, setCustomerAddQid] = useState('')
  const [customerAddName, setCustomerAddName] = useState('')
  const [customerAddError, setCustomerAddError] = useState('')
  const [customerAddQidError, setCustomerAddQidError] = useState('')
  const [customerAddSaving, setCustomerAddSaving] = useState(false)
  const [showQtyModal, setShowQtyModal] = useState(false)
  const [qtySelectedId, setQtySelectedId] = useState(null)
  const [qtyKeypadInput, setQtyKeypadInput] = useState('')
  const [isQtyIncreaseOnly, setIsQtyIncreaseOnly] = useState(false)
  const [warningMessage, setWarningMessage] = useState('')
  const [showPriceCheckModal, setShowPriceCheckModal] = useState(false)
  const [showPriceModeModal, setShowPriceModeModal] = useState(false)
  const [showOrderNoModal, setShowOrderNoModal] = useState(false)
  const [orderNoInput, setOrderNoInput] = useState('')
  const customerAddMobileInputRef = useRef(null)
  const orderNoInputRef = useRef(null)

  const cartHasReturnLines = useMemo(
    () => Array.isArray(cartItems) && cartItems.some((i) => !i.void && Number(i.quantity) < 0),
    [cartItems]
  )
  const qtyReturnMode = isSalesReturn || cartHasReturnLines

  const handleCartItemSelect = useCallback((item) => {
    onSelectCartItem?.(getItemId(item))
  }, [onSelectCartItem])

  const handlePriceCheckOpen = useCallback(() => setShowPriceCheckModal(true), [])
  const handleOrderNoOpen = useCallback(() => setShowOrderNoModal(true), [])

  const handlePriceModeClick = useCallback(() => {
    if (priceMode) {
      onSetPriceMode?.(null)
      return
    }
    setShowPriceModeModal(true)
  }, [priceMode, onSetPriceMode])

  const handleSelectPriceMode = useCallback((mode) => {
    onSetPriceMode?.(mode)
    setShowPriceModeModal(false)
  }, [onSetPriceMode])

  const closePriceModeModal = useCallback(() => setShowPriceModeModal(false), [])

  const handleQtyKeypad = (key) => {
    if (key === '⌫') {
      setQtyKeypadInput((s) => s.slice(0, -1))
      return
    }
    if (key === 'OK') {
      if (qtySelectedId !== null && qtySelectedId !== undefined && qtySelectedId !== '') {
        const parsed = parseFloat(qtyKeypadInput)
        const num = Number.isNaN(parsed) ? 0 : parsed
        const val = qtyReturnMode
          ? (num === 0 ? 0 : -Math.abs(num))
          : Math.max(0, num)

        if (isQtyIncreaseOnly) {
          const existingItem = cartItems?.find(
            (i) => String(getItemId(i)) === String(qtySelectedId) && !i.void
          )
          const currentQty = existingItem ? (existingItem.quantity ?? 0) : 0
          const isIncrease = qtyReturnMode
            ? Math.abs(val) >= Math.abs(currentQty)
            : val >= currentQty
          if (!isIncrease) {
            setWarningMessage('Contact supervisor')
            return
          }
        }

        if (typeof onUpdateQuantity === 'function') {
          onUpdateQuantity(qtySelectedId, val)
        }
      }
      setQtyKeypadInput('')
      setQtySelectedId(null)
      setShowQtyModal(false)
      return
    }
    if (key === '.') {
       if (isQtyIncreaseOnly) return
      setQtyKeypadInput((s) => {
        if (s.includes('.')) return s
        if (!s) return '0.'
        return s + '.'
      })
      return
    }
    setQtyKeypadInput((s) => {
      const next = s + key
      let hasDot = false
      let cleaned = ''
      for (let i = 0; i < next.length; i++) {
        const char = next[i]
        if (char >= '0' && char <= '9') {
          cleaned += char
        } else if (char === '.' && !hasDot) {
          cleaned += char
          hasDot = true
        }
      }
      return cleaned.slice(0, 7)
    })
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
    const proceed = () => {
      setIsQtyIncreaseOnly(false)
      setShowQtyModal(true)
    }
    if (typeof onRequestQty === 'function') {
      onRequestQty(proceed)
    } else {
      proceed()
    }
  }

  const openQtyModalIncrease = () => {
    setIsQtyIncreaseOnly(true)
    setShowQtyModal(true)
  }

  const digitsOnly = (s) => String(s || '').replace(/\D/g, '')
  const orderNoSanitize = (s) => String(s || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 20)

  const handleSaveOrderNo = () => {
    if (typeof onOrderNoChange === 'function') {
      onOrderNoChange(orderNoInput)
    }
    setShowOrderNoModal(false)
  }

  const openCustomerAddModal = () => {
    setCustomerAddMobile('')
    setCustomerAddCardNo('')
    setCustomerAddQid('')
    setCustomerAddName('')
    setCustomerAddError('')
    setCustomerAddQidError('')
    setShowCustomerAddModal(true)
  }

  const closeCustomerAddModal = () => {
    setShowCustomerAddModal(false)
    setCustomerAddError('')
    setCustomerAddQidError('')
  }

  const customerAddMobileDigits = digitsOnly(customerAddMobile).slice(0, 8)
  const customerAddQidDigits = digitsOnly(customerAddQid).slice(0, 11)

  const checkCustomerAddQidUnique = async (qidDigits) => {
    if (!qidDigits || qidDigits.length !== 11) {
      setCustomerAddQidError('')
      return { ok: true }
    }
    if (!apiBase) {
      setCustomerAddQidError('')
      return { ok: true }
    }
    try {
      const res = await fetch(
        `${apiBase}/api/customers/check-qid?qid=${encodeURIComponent(qidDigits)}`
      )
      const data = await res.json().catch(() => ({}))
      if (data?.exists) {
        const msg =
          (typeof data.message === 'string' && data.message.trim()) ||
          'This Qatar ID is already registered.'
        setCustomerAddQidError(msg)
        return { ok: false, message: msg }
      }
      setCustomerAddQidError('')
      return { ok: true }
    } catch {
      setCustomerAddQidError('')
      return { ok: true }
    }
  }

  useEffect(() => {
    if (!showCustomerAddModal || customerAddQidDigits.length !== 11) {
      if (customerAddQidDigits.length !== 11) setCustomerAddQidError('')
      return undefined
    }
    let cancelled = false
    const timer = setTimeout(() => {
      if (!cancelled) checkCustomerAddQidUnique(customerAddQidDigits)
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [showCustomerAddModal, customerAddQidDigits, apiBase])

  const handleSaveCustomerAdd = async () => {
    const name = (customerAddName || '').trim()
    const mobile = customerAddMobileDigits
    const cardNo = digitsOnly(customerAddCardNo).slice(0, 8) || mobile
    const qid = customerAddQidDigits
    if (mobile.length !== 8 || cardNo.length !== 8 || qid.length !== 11 || !name) {
      setCustomerAddError('Please complete all columns.')
      return
    }
    if (customerAddQidError) {
      setCustomerAddError(customerAddQidError)
      return
    }
    const qidCheck = await checkCustomerAddQidUnique(qid)
    if (!qidCheck.ok) {
      setCustomerAddError(qidCheck.message || 'This Qatar ID is already registered.')
      return
    }
    if (typeof onRegisterQuickCustomer !== 'function') {
      setCustomerAddError('Customer registration is not available.')
      return
    }
    setCustomerAddSaving(true)
    setCustomerAddError('')
    try {
      await onRegisterQuickCustomer({ name, mobile, cardNo, qid, locationCode })
      setCustomerPickerKey((k) => k + 1)
      closeCustomerAddModal()
    } catch (err) {
      const msg = err && typeof err.message === 'string' ? err.message : 'Could not save customer.'
      setCustomerAddError(msg)
    } finally {
      setCustomerAddSaving(false)
    }
  }

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

  useEffect(() => {
    if (showOrderNoModal) {
      setOrderNoInput(orderNo ? String(orderNo) : '')
    }
  }, [showOrderNoModal, orderNo])

  useLayoutEffect(() => {
    if (!showOrderNoModal) return
    let cancelled = false
    const run = () => {
      if (cancelled) return
      orderNoInputRef.current?.focus({ preventScroll: true })
    }
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(run)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(id)
    }
  }, [showOrderNoModal])

  const balanceCustomer = selectedCustomer

  return (
    <div className="dashboard-pos">
      <div className="dashboard-main">
        <aside className="dashboard-left">
          <CustomerSearch
            key={customerPickerKey}
            customers={customers}
            selectedCustomer={selectedCustomer}
            onSelectCustomer={onSelectCustomer}
            salesChannels={salesChannels}
            selectedSalesChannel={selectedSalesChannel}
            onSelectSalesChannel={onSelectSalesChannel}
          />
          <section className="dashboard-actions-card">
            <PosActionsBar
              cartItems={cartItems}
              selectedCartItemId={selectedCartItemId}
              onHold={onHold}
              onHoldRetrieve={onHoldRetrieve}
              onVoidLine={onVoidLine}
              onSuspendBill={onSuspendBill}
              onQtyIncrease={openQtyModalIncrease}
              onQtyDecrease={openQtyModalWithSupervisor}
              isSalesReturn={isSalesReturn}
              qtyReturnMode={qtyReturnMode}
              onToggleSalesReturn={onToggleSalesReturn}
              onCustomerAdd={openCustomerAddModal}
              onPriceCheck={handlePriceCheckOpen}
              onOrderNo={handleOrderNoOpen}
              priceMode={priceMode}
              onPriceModeClick={handlePriceModeClick}
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
                      onChange={(e) => {
                        const next = digitsOnly(e.target.value).slice(0, 8)
                        setCustomerAddMobile(next)
                        setCustomerAddCardNo(next)
                      }}
                      placeholder="e.g. 55123456"
                      maxLength={8}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label className="customer-add-field">
                    <span className="customer-add-label">Card no.</span>
                    <input
                      type="tel"
                      inputMode="numeric"
                      className="dashboard-scan-input customer-add-input"
                      value={customerAddCardNo}
                      onChange={(e) => setCustomerAddCardNo(digitsOnly(e.target.value).slice(0, 8))}
                      placeholder="Same as mobile"
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
                      className={`dashboard-scan-input customer-add-input${customerAddQidError ? ' customer-add-input-invalid' : ''}`}
                      value={customerAddQid}
                      onChange={(e) => {
                        setCustomerAddQid(digitsOnly(e.target.value).slice(0, 11))
                        setCustomerAddQidError('')
                        setCustomerAddError('')
                      }}
                      onBlur={() => {
                        if (customerAddQidDigits.length === 11) {
                          checkCustomerAddQidUnique(customerAddQidDigits)
                        }
                      }}
                      placeholder="Qatar ID"
                      maxLength={11}
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={customerAddQidError ? 'true' : undefined}
                      aria-describedby={customerAddQidError ? 'customer-add-qid-error' : undefined}
                    />
                    {customerAddQidError ? (
                      <p id="customer-add-qid-error" className="customer-add-field-error" role="alert">
                        {customerAddQidError}
                      </p>
                    ) : null}
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
                      disabled={customerAddSaving || !!customerAddQidError}
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
                        {!isQtyIncreaseOnly && (
                        <button type="button" className="qty-keypad-key" onClick={() => handleQtyKeypad('.')}>
                          .
                        </button>
                      )}
                      <button
                        type="button"
                        className="qty-keypad-key"
                        onClick={() => handleQtyKeypad('0')}
                        style={isQtyIncreaseOnly ? { gridColumn: 'span 2' } : undefined}
                      >
                        0
                      </button>
                      <button type="button" className="qty-keypad-key qty-keypad-back" onClick={() => handleQtyKeypad('⌫')}>
                        ⌫
                      </button>
                      <button type="button" className="qty-keypad-key qty-keypad-ok" onClick={() => handleQtyKeypad('OK')} style={{ gridColumn: 'span 3' }}>
                        OK
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {showOrderNoModal && (
          <div className="qty-modal-overlay" onClick={() => setShowOrderNoModal(false)}>
            <div
              className="qty-modal customer-add-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="order-no-modal-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="qty-modal-header">
                <h3 id="order-no-modal-title">Enter Order Number</h3>
                <button type="button" className="qty-modal-close" onClick={() => setShowOrderNoModal(false)} aria-label="Close">
                  ×
                </button>
              </div>
              <div className="qty-modal-body">
                <form
                  className="customer-add-form"
                  autoComplete="off"
                  onSubmit={(e) => {
                    e.preventDefault()
                    handleSaveOrderNo()
                  }}
                >
                  <label className="customer-add-field">
                    <span className="customer-add-label">Order Number</span>
                    <input
                      ref={orderNoInputRef}
                      type="text"
                      className="dashboard-scan-input customer-add-input"
                      value={orderNoInput}
                      onChange={(e) => {
                        const val = orderNoSanitize(e.target.value)
                        setOrderNoInput(val)
                        if (typeof onOrderNoChange === 'function') {
                          onOrderNoChange(val)
                        }
                      }}
                      placeholder="e.g. 10045 or PO-123A"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <div className="customer-add-actions">
                    <button
                      type="button"
                      className="customer-add-btn-cancel"
                      onClick={() => setShowOrderNoModal(false)}
                    >
                      Close
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        )}
        {warningMessage && (
          <div className="qty-modal-overlay" onClick={() => setWarningMessage('')}>
            <div className="warning-modal" onClick={(e) => e.stopPropagation()}>
              <div className="warning-modal-icon-wrap" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 9v4m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <h3 className="warning-modal-title">Attention</h3>
              <p className="warning-modal-text">{warningMessage}</p>
              <button
                type="button"
                className="warning-modal-btn"
                onClick={() => setWarningMessage('')}
              >
                OK
              </button>
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
            productLookupMap={productLookupMap}
            onAddToCart={onAddToCart}
            onMergeCartLine={onMergeCartLine}
            apiBase={apiBase}
            isSalesReturn={isSalesReturn}
            selectedItemId={selectedCartItemId}
            onSelectItem={handleCartItemSelect}
            balanceCustomer={balanceCustomer}
            onCartPointsSnapshotChange={onCartPointsSnapshotChange}
            onItemDetailsCacheChange={onItemDetailsCacheChange}
            productsReady={productsReady}
            itemDetailsCacheResetKey={itemDetailsCacheResetKey}
            orderNo={orderNo}
          />
        </section>
      </div>
      <PriceCheckModal
        open={showPriceCheckModal}
        onClose={() => setShowPriceCheckModal(false)}
        apiBase={apiBase}
        products={products}
        productLookupMap={productLookupMap}
        priceMode={priceMode}
      />
      {showPriceModeModal && (
        <div className="qty-modal-overlay" onClick={closePriceModeModal}>
          <div
            className="qty-modal price-mode-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="price-mode-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="qty-modal-header">
              <h3 id="price-mode-modal-title">Price mode</h3>
              <button type="button" className="qty-modal-close" onClick={closePriceModeModal} aria-label="Close">
                ×
              </button>
            </div>
            <div className="qty-modal-body price-mode-modal-body">
              <p className="price-mode-modal-hint">
                Choose pricing for new items. Click the button again to return to retail price.
              </p>
              <div className="price-mode-modal-actions">
                <button
                  type="button"
                  className="pos-action-btn price-mode-option-btn"
                  onClick={() => handleSelectPriceMode(PRICE_MODES.WHOLESALE)}
                >
                  Wholesale
                </button>
                <button
                  type="button"
                  className="pos-action-btn price-mode-option-btn"
                  onClick={() => handleSelectPriceMode(PRICE_MODES.OFFER)}
                >
                  Offers
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function billingPropsAreEqual(prev, next) {
  return (
    prev.cartItems === next.cartItems
    && prev.products === next.products
    && prev.productLookupMap === next.productLookupMap
    && prev.customers === next.customers
    && prev.selectedCustomer === next.selectedCustomer
    && prev.salesChannels === next.salesChannels
    && prev.selectedSalesChannel === next.selectedSalesChannel
    && prev.selectedCartItemId === next.selectedCartItemId
    && prev.checkoutLoading === next.checkoutLoading
    && prev.isSalesReturn === next.isSalesReturn
    && prev.priceMode === next.priceMode
    && prev.billNo === next.billNo
    && prev.orderNo === next.orderNo
    && prev.productsReady === next.productsReady
    && prev.itemDetailsCacheResetKey === next.itemDetailsCacheResetKey
    && prev.apiBase === next.apiBase
    && prev.locationCode === next.locationCode
    && prev.counterCode === next.counterCode
    && prev.counterName === next.counterName
    && prev.onAddToCart === next.onAddToCart
    && prev.onMergeCartLine === next.onMergeCartLine
    && prev.onSelectCustomer === next.onSelectCustomer
    && prev.onSelectSalesChannel === next.onSelectSalesChannel
    && prev.onUpdateQuantity === next.onUpdateQuantity
    && prev.onRemove === next.onRemove
    && prev.onCheckout === next.onCheckout
    && prev.onCartPointsSnapshotChange === next.onCartPointsSnapshotChange
    && prev.onItemDetailsCacheChange === next.onItemDetailsCacheChange
    && prev.onHold === next.onHold
    && prev.onHoldRetrieve === next.onHoldRetrieve
    && prev.onSelectCartItem === next.onSelectCartItem
    && prev.onVoidLine === next.onVoidLine
    && prev.onSuspendBill === next.onSuspendBill
    && prev.onToggleSalesReturn === next.onToggleSalesReturn
    && prev.onSetPriceMode === next.onSetPriceMode
    && prev.onRequestQty === next.onRequestQty
    && prev.onRegisterQuickCustomer === next.onRegisterQuickCustomer
    && prev.onOrderNoChange === next.onOrderNoChange
  )
}

export default memo(Billing, billingPropsAreEqual)
