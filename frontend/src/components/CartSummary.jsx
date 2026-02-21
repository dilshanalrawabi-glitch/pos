import { useState, useRef, useEffect } from 'react'
import '../styles/CartSummary.css'

function getItemId(item) {
  return item?.id ?? item?.ITEMCODE ?? item?.itemCode ?? ''
}

function CartSummary({
  cartItems,
  onUpdateQuantity,
  onRemove,
  onClear,
  onCheckout,
  billNo,
  products = [],
  onAddToCart,
  apiBase,
  selectedItemId,
  onSelectItem,
}) {
  const [scanCode, setScanCode] = useState('')
  const [scanMsg, setScanMsg] = useState(null)
  const scanInputRef = useRef(null)

  const activeItems = cartItems.filter(item => !item.void)
  const total = activeItems.reduce((sum, item) => sum + (item.price * item.quantity), 0)
  const itemCount = activeItems.reduce((sum, item) => sum + item.quantity, 0)

  useEffect(() => {
    if (!scanMsg) return
    const t = setTimeout(() => setScanMsg(null), 2500)
    return () => clearTimeout(t)
  }, [scanMsg])

  const handleScanSubmit = async (e) => {
    e.preventDefault()
    const code = (scanCode || '').toString().trim()
    setScanCode('')
    if (!code) return
    let product = null
    if (apiBase) {
      try {
        const res = await fetch(`${apiBase}/api/products/lookup?code=${encodeURIComponent(code)}`)
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.found !== false && (data.ITEMCODE != null || data.itemcode != null)) {
          product = {
            id: data.ITEMCODE ?? data.itemcode,
            name: data.ITEMNAME ?? data.itemname ?? '',
            price: parseFloat(data.RETAILPRICE ?? data.retailprice) || 0,
            category: data.CATEGORYCODE ?? data.categorycode,
            image: '📦',
            manufactureId: (data.MANUFACTUREID ?? data.manufactureid ?? data.ITEMCODE ?? data.itemcode ?? '').toString().trim(),
          }
        }
      } catch (err) {
        console.warn('Lookup error:', err)
      }
    }
    if (!product) {
      product = (products || []).find(
        (p) =>
          String(p.manufactureId ?? '').trim() === code ||
          String(p.id ?? '').trim() === code ||
          (Array.isArray(p.alternateCodes) && p.alternateCodes.some((alt) => String(alt ?? '').trim() === code))
      )
    }
    if (product) {
      onAddToCart?.(product)
      setScanMsg(`Added: ${product.name}`)
    } else {
      setScanMsg(`Not found – ${code}`)
    }
    scanInputRef.current?.focus()
  }

  return (
    <div className="cart-summary">
      <div className="cart-header">
        <div className="cart-header-title-row">
          {billNo != null && <span className="cart-bill-no">Bill # {billNo}</span>}
          <h2 className="cart-title">Shopping Cart</h2>
        </div>
        {cartItems.length > 0 && (
          <button className="clear-btn" onClick={onClear}>Clear</button>
        )}
      </div>

      <div className="cart-scan-block">
        <span className="cart-scan-label">Scan barcode</span>
        <form className="cart-scan-form" onSubmit={handleScanSubmit}>
          <div className="cart-scan-row">
            <input
              ref={scanInputRef}
              type="text"
              placeholder="Barcode or code"
              value={scanCode}
              onChange={(e) => setScanCode(e.target.value)}
              className="cart-scan-input"
              autoComplete="off"
            />
          </div>
          {scanMsg && <span className="cart-scan-msg">{scanMsg}</span>}
        </form>
      </div>

      <div className="cart-items">
        {cartItems.length === 0 ? (
          <div className="empty-state">
            <p>🛒</p>
            <p>Your cart is empty</p>
          </div>
        ) : (
          <>
            <div className="cart-items-header">
              <span className="cart-th cart-th-sno">Sl No</span>
              <span className="cart-th cart-th-name">Name</span>
              <span className="cart-th cart-th-qty">Qty</span>
              <span className="cart-th cart-th-price">Price</span>
              <span className="cart-th cart-th-total">Total</span>
            </div>
            <div className="cart-items-list">
              {cartItems.map((item, index) => {
                const id = getItemId(item)
                const isSelected = selectedItemId != null && String(id) === String(selectedItemId)
                const isVoid = !!item.void
                return (
                  <div
                    key={id || index}
                    role="button"
                    tabIndex={0}
                    className={`cart-item-row ${isSelected ? 'cart-item-row-selected' : ''} ${isVoid ? 'cart-item-row-void' : ''}`}
                    onClick={() => !isVoid && onSelectItem?.(item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        if (!isVoid) onSelectItem?.(item)
                      }
                    }}
                    aria-pressed={isSelected}
                    aria-label={isVoid ? `${item.name} (void)` : item.name}
                  >
                    <span className="cart-td cart-td-sno">{index + 1}</span>
                    <span className="cart-td cart-td-name" title={item.name}>
                      {item.name}
                      {isVoid && <span className="cart-item-void-badge">VOID</span>}
                    </span>
                    <span className="cart-td cart-td-qty">{item.quantity}</span>
                    <span className="cart-td cart-td-price">QAR {item.price.toFixed(2)}</span>
                    <span className="cart-td cart-td-total">QAR {(item.price * item.quantity).toFixed(2)}</span>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {cartItems.length > 0 && (
        <div className="cart-footer">
          <div className="summary-row">
            <span>Items:</span>
            <span>{itemCount}</span>
          </div>
          <div className="summary-row">
            <span>Subtotal:</span>
            <span>QAR {total.toFixed(2)}</span>
          </div>
          <div className="summary-row tax">
            <span>Tax (10%):</span>
            <span>QAR {(total * 0.1).toFixed(2)}</span>
          </div>
          <div className="summary-row total">
            <span>Total:</span>
            <span>QAR {(total * 1.1).toFixed(2)}</span>
          </div>
          <button className="checkout-btn" onClick={onCheckout}>
            Checkout
          </button>
        </div>
      )}
    </div>
  )
}

export default CartSummary
