import { useState, useRef, useEffect } from 'react'
import '../styles/CartSummary.css'

function CartSummary({
  cartItems,
  customers = [],
  selectedCustomer,
  onClearCustomer,
  onUpdateQuantity,
  onRemove,
  onClear,
  onCheckout,
  billNo,
  products = [],
  onAddToCart,
  apiBase,
}) {
  const [scanCode, setScanCode] = useState('')
  const [scanMsg, setScanMsg] = useState(null)
  const scanInputRef = useRef(null)

  const total = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0)
  const itemCount = cartItems.reduce((sum, item) => sum + item.quantity, 0)

  const getCustomerName = (c) => {
    if (!c) return ''
    const full = c.CUST_FULL_NAME || c.cust_full_name
    if (full) return String(full).trim()
    const code = String(c.CUSTOMERCODE || c.customercode || '').trim()
    const name = String(c.CUSTOMERNAME || c.customername || '').trim()
    return [code, name].filter(Boolean).join(' ')
  }

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
        if (res.ok) {
          const data = await res.json()
          product = {
            id: data.ITEMCODE,
            name: data.ITEMNAME,
            price: parseFloat(data.RETAILPRICE) || 0,
            category: data.CATEGORYCODE,
            image: '📦',
            manufactureId: (data.MANUFACTUREID ?? data.manufactureid ?? data.ITEMCODE ?? '').toString().trim(),
          }
        }
      } catch (err) {
        console.error('Lookup error:', err)
      }
    }
    if (!product) {
      product = (products || []).find(
        (p) =>
          String(p.manufactureId ?? '').trim() === code ||
          String(p.id ?? '').trim() === code
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
            <button type="submit" className="cart-scan-btn">Add</button>
          </div>
          {scanMsg && <span className="cart-scan-msg">{scanMsg}</span>}
        </form>
      </div>
      {selectedCustomer && (
        <div className="cart-customer">
          <span className="cart-customer-label">Customer</span>
          <div className="cart-customer-selected">
            <span className="cart-customer-name">{getCustomerName(selectedCustomer)}</span>
            <button
              type="button"
              className="cart-customer-clear"
              onClick={onClearCustomer}
              title="Clear customer"
              aria-label="Clear customer"
            >
              ×
            </button>
          </div>
        </div>
      )}

      <div className="cart-items">
        {cartItems.length === 0 ? (
          <div className="empty-state">
            <p>🛒</p>
            <p>Your cart is empty</p>
          </div>
        ) : (
          cartItems.map(item => (
            <div key={item.id} className="cart-item">
              <div className="item-info">
                <p className="item-emoji">{item.image}</p>
                <div className="item-details">
                  <p className="item-name">{item.name}</p>
                  <p className="item-price">QAR {item.price.toFixed(2)}</p>
                </div>
              </div>
              <div className="item-controls">
                <button
                  className="qty-btn"
                  onClick={() => onUpdateQuantity(item.id, item.quantity - 1)}
                >
                  −
                </button>
                <span className="qty-display">{item.quantity}</span>
                <button
                  className="qty-btn"
                  onClick={() => onUpdateQuantity(item.id, item.quantity + 1)}
                >
                  +
                </button>
              </div>
              <p className="item-total">QAR {(item.price * item.quantity).toFixed(2)}</p>
              <button
                className="remove-btn"
                onClick={() => onRemove(item.id)}
              >
                ✕
              </button>
            </div>
          ))
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
