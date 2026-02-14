import { useState } from 'react'
import '../styles/Payment.css'

const PAYMENT_METHODS = [
  { id: 'cash', label: 'Cash', icon: '💵' },
  { id: 'card', label: 'Card', icon: '💳' },
  { id: 'loyalty', label: 'Loyalty', icon: '🎫' },
  { id: 'points', label: 'Points', icon: '⭐' },
]

const KEYPAD_KEYS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['.', '0', 'back'],
]

function getCustomerName(c) {
  if (!c) return ''
  const full = c.CUST_FULL_NAME || c.cust_full_name
  if (full) return String(full).trim()
  const code = String(c.CUSTOMERCODE || c.customercode || '').trim()
  const name = String(c.CUSTOMERNAME || c.customername || '').trim()
  return [code, name].filter(Boolean).join(' ')
}

function getCustomerPoints(c) {
  if (!c) return 0
  const p = c.POINTS ?? c.points ?? c.LOYALTY_POINTS ?? c.loyalty_points
  return typeof p === 'number' ? p : parseInt(p, 10) || 0
}

function Payment({
  cartItems,
  selectedCustomer,
  billNo,
  locationCode,
  onComplete,
  onBack,
}) {
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [amountTendered, setAmountTendered] = useState('')
  const [pointsUsed, setPointsUsed] = useState(0)

  const subtotal = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0)
  const taxRate = 0.1
  const tax = subtotal * taxRate
  const total = subtotal + tax
  const amountNum = parseFloat(amountTendered) || 0
  const change = paymentMethod === 'cash' ? Math.max(0, amountNum - total) : 0
  const customerPoints = getCustomerPoints(selectedCustomer)

  const canComplete =
    paymentMethod === 'cash' ? amountNum >= total :
    paymentMethod === 'card' ? true :
    (paymentMethod === 'loyalty' || paymentMethod === 'points')
      ? pointsUsed > 0 && pointsUsed <= customerPoints
      : false

  const handleKeypad = (key) => {
    if (key === 'back') {
      if (paymentMethod === 'cash') {
        setAmountTendered((prev) => prev.slice(0, -1))
      } else if (paymentMethod === 'loyalty' || paymentMethod === 'points') {
        setPointsUsed((prev) => Math.floor(prev / 10))
      }
      return
    }
    if (paymentMethod === 'cash') {
      if (key === '.' && amountTendered.includes('.')) return
      const parts = (amountTendered + key).split('.')
      if (parts[1] && parts[1].length > 2) return
      setAmountTendered((prev) => prev + key)
    } else if (paymentMethod === 'loyalty' || paymentMethod === 'points') {
      if (key === '.') return
      const next = pointsUsed * 10 + parseInt(key, 10)
      if (next <= 999999) setPointsUsed(next)
    }
  }

  const handleComplete = () => {
    if (!canComplete) return
    onComplete?.()
  }

  return (
    <div className="payment-page">
      <button type="button" className="payment-back" onClick={onBack} aria-label="Back to cart">
        ← Back
      </button>

      <div className="payment-panels">
        {/* Left: dark panel – payment methods + order summary */}
        <aside className="payment-left-panel">
          <div className="payment-method-btns">
            {PAYMENT_METHODS.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`payment-method-btn ${paymentMethod === m.id ? 'active' : ''}`}
                onClick={() => setPaymentMethod(m.id)}
              >
                <span className="payment-method-icon">{m.icon}</span>
                <span>{m.label}</span>
              </button>
            ))}
          </div>
          <div className="payment-order-summary">
            <div className="payment-order-label">TOTAL AMOUNT</div>
            <div className="payment-order-total">QAR {total.toFixed(2)}</div>
            <ul className="payment-order-lines">
              {cartItems.map((item) => (
                <li key={item.id} className="payment-order-line">
                  {item.name} x{item.quantity}
                </li>
              ))}
            </ul>
            <span className="payment-order-detail" aria-hidden>🔍</span>
          </div>
        </aside>

        {/* Right: balance, bill + invoice, keypad, PAY */}
        <main className="payment-right-panel">
          <div className="payment-balance">
            <div className="payment-balance-label">BALANCE DUE</div>
            <div className="payment-balance-amount">QAR {total.toFixed(2)}</div>
          </div>
          <div className="payment-entered">
            {paymentMethod === 'cash' && (
              <>
                <span className="payment-entered-label">AMOUNT ENTERED</span>
                <span className="payment-entered-value">QAR {amountTendered || '0.00'}</span>
                {amountNum >= total && (
                  <span className="payment-change">Change: QAR {change.toFixed(2)}</span>
                )}
              </>
            )}
            {paymentMethod === 'card' && (
              <>
                <span className="payment-entered-label">AMOUNT ENTERED</span>
                <span className="payment-entered-value">QAR 0.00</span>
              </>
            )}
            {paymentMethod === 'loyalty' && (
              <>
                <span className="payment-entered-label">Loyalty (points max {customerPoints})</span>
                <span className="payment-entered-value">{pointsUsed}</span>
              </>
            )}
            {paymentMethod === 'points' && (
              <>
                <span className="payment-entered-label">Points to use (max {customerPoints})</span>
                <span className="payment-entered-value">{pointsUsed}</span>
              </>
            )}
          </div>
          <div className="payment-keypad">
            {KEYPAD_KEYS.map((row, i) => (
              <div key={i} className="payment-keypad-row">
                {row.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={`payment-key ${key === 'back' ? 'key-back' : ''}`}
                    onClick={() => handleKeypad(key)}
                  >
                    {key === 'back' ? '⌫' : key === '.' ? '.' : key}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="payment-pay-btn"
            onClick={handleComplete}
            disabled={!canComplete}
          >
            PAY
          </button>
        </main>
      </div>
    </div>
  )
}

export default Payment
