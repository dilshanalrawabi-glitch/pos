import { useState, useRef, useEffect } from 'react'
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

function formatKeypadAmount(n) {
  if (n === 0) return ''
  const r = Math.round(n * 100) / 100
  return r % 1 === 0 ? String(r) : r.toFixed(2)
}

/** 2-decimal money to avoid float drift (e.g. change exploding to e+21). */
function roundMoney(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  return Math.round(x * 100) / 100
}

/** Compare in cents so split payment (cash+card) can complete without float failing >= */
function paidCoversBill(paid, bill) {
  const p = Math.round(roundMoney(paid) * 100)
  const b = Math.round(roundMoney(bill) * 100)
  return p >= b
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
  const [continueBalanceOnCard, setContinueBalanceOnCard] = useState(false)
  const [keypadTarget, setKeypadTarget] = useState('cash')
  const [cardKeypadInput, setCardKeypadInput] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const orderLinesRef = useRef(null)

  const activeItems = cartItems.filter((item) => !item.void)
  const subtotal = activeItems.reduce((sum, item) => sum + item.price * item.quantity, 0)

  const total = roundMoney(subtotal)
  const totalDisplay = Math.abs(total)
  const amountNum = roundMoney(parseFloat(amountTendered) || 0)
  const cardNum = roundMoney(parseFloat(cardKeypadInput) || 0)

  const splitKeypadMode = paymentMethod === 'cash' && continueBalanceOnCard

  const cashTendered = Math.max(
    0,
    splitKeypadMode || paymentMethod === 'cash' ? amountNum : 0,
  )
  const cardTendered = Math.max(
    0,
    splitKeypadMode ? cardNum : paymentMethod === 'card' ? amountNum : 0,
  )

  /** Sum tendered: cash-only, card-only, or cash + card when split. */
  const totalPaid = roundMoney(cashTendered + cardTendered)

  /** Remaining bill not covered by tenders (0 when paid or overpaid). */
  const balanceDue = roundMoney(Math.max(0, total - totalPaid))

  /** Change when customer pays more than the bill (e.g. cash 100 + card 50, bill 149 → 1). */
  const change = roundMoney(Math.max(0, totalPaid - total))

  /** Display in CASH / CARD columns: independent amounts in split mode. */
  let cashApplied
  let cardDue
  if (!splitKeypadMode) {
    if (paymentMethod === 'cash') {
      cashApplied = Math.min(cashTendered, total)
      cardDue = Math.max(0, total - cashApplied)
    } else {
      cashApplied = 0
      cardDue = Math.max(0, total - cardTendered)
    }
  } else {
    cashApplied = cashTendered
    cardDue = cardTendered
  }

  const cashGivenForReceipt = splitKeypadMode ? cashTendered : amountNum

  const customerPoints = getCustomerPoints(selectedCustomer)

  const showSplitCardBalance =
    !splitKeypadMode && total > 0 && cashApplied > 0 && cardDue > 0

  const balanceAmountShown = roundMoney(
    splitKeypadMode || paymentMethod === 'card' ? balanceDue : totalDisplay,
  )

  const canComplete =
    paymentMethod === 'cash'
      ? continueBalanceOnCard
        ? paidCoversBill(totalPaid, total)
        : paidCoversBill(amountNum, total)
      : paymentMethod === 'card'
        ? paidCoversBill(cardTendered, total)
        : paymentMethod === 'loyalty' || paymentMethod === 'points'
          ? pointsUsed > 0 && pointsUsed <= customerPoints
          : false

  useEffect(() => {
    const el = orderLinesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [cartItems.length])

  useEffect(() => {
    if (paymentMethod !== 'cash') setContinueBalanceOnCard(false)
    setKeypadTarget('cash')
  }, [paymentMethod])

  useEffect(() => {
    if (!continueBalanceOnCard) setKeypadTarget('cash')
  }, [continueBalanceOnCard])

  const cashOrCardKeypad = paymentMethod === 'cash' || paymentMethod === 'card'

  const appendDecimal = (prev, key) => {
    if (key === '.' && prev.includes('.')) return prev
    const next = prev + key
    const parts = next.split('.')
    if (parts[1] && parts[1].length > 2) return prev
    return next
  }

  const handleKeypad = (key) => {
    if (key === 'back') {
      if (cashOrCardKeypad) {
        if (splitKeypadMode && keypadTarget === 'card') {
          setCardKeypadInput((prev) => prev.slice(0, -1))
        } else {
          setAmountTendered((prev) => prev.slice(0, -1))
        }
      } else if (paymentMethod === 'loyalty' || paymentMethod === 'points') {
        setPointsUsed((prev) => Math.floor(prev / 10))
      }
      return
    }
    if (cashOrCardKeypad) {
      if (splitKeypadMode && keypadTarget === 'card') {
        setCardKeypadInput((prev) => {
          if (key === '.' && prev.includes('.')) return prev
          return appendDecimal(prev, key)
        })
      } else {
        setAmountTendered((prev) => {
          if (key === '.' && prev.includes('.')) return prev
          return appendDecimal(prev, key)
        })
      }
    } else if (paymentMethod === 'loyalty' || paymentMethod === 'points') {
      if (key === '.') return
      const next = pointsUsed * 10 + parseInt(key, 10)
      if (next <= 999999) setPointsUsed(next)
    }
  }

  const focusSplitCashKeypad = () => {
    setKeypadTarget('cash')
    setAmountTendered(formatKeypadAmount(cashTendered))
  }

  const focusSplitCardKeypad = () => {
    setKeypadTarget('card')
    setCardKeypadInput(formatKeypadAmount(cardTendered))
  }

  const handleComplete = () => {
    if (!canComplete || isProcessing) return
    setIsProcessing(true)
    const changeAmt = change

    if (splitKeypadMode) {
      if (cashTendered > 0 && cardTendered > 0) {
        onComplete?.({
          paymentMethod: 'split',
          cashAmount: cashTendered,
          cardAmount: cardTendered,
          amountTendered: cashTendered,
          change: changeAmt,
          total,
          subtotal,
          items: activeItems,
        })
        return
      }
      if (cardTendered > 0 && cashTendered <= 0) {
        onComplete?.({
          paymentMethod: 'card',
          cardAmount: cardTendered,
          amountTendered: 0,
          change: changeAmt,
          total,
          subtotal,
          items: activeItems,
        })
        return
      }
      if (cashTendered > 0 && cardTendered <= 0) {
        onComplete?.({
          paymentMethod: 'cash',
          cashAmount: cashTendered,
          cardAmount: 0,
          amountTendered: cashTendered,
          change: changeAmt,
          total,
          subtotal,
          items: activeItems,
        })
        return
      }
    }

    onComplete?.({
      paymentMethod,
      cashAmount: paymentMethod === 'cash' ? cashApplied : undefined,
      cardAmount:
        paymentMethod === 'card' ? cardTendered : paymentMethod === 'cash' ? 0 : undefined,
      amountTendered: paymentMethod === 'card' ? cardTendered : cashGivenForReceipt,
      change,
      total,
      subtotal,
      items: activeItems,
    })
  }

  return (
    <div className="payment-page">
      <button type="button" className="payment-back" onClick={onBack} aria-label="Back to cart">
        ← Back
      </button>

      <div className="payment-panels">
        {/* Left: dark panel – payment methods + order summary */}
        <aside className="payment-left-panel">
          {selectedCustomer && (
            <div className="payment-customer">
              <span className="payment-customer-label">Customer</span>
              <span className="payment-customer-name">{getCustomerName(selectedCustomer)}</span>
            </div>
          )}
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
            <div className="payment-order-heading-row">
              <div className="payment-order-heading">Item List</div>
              <div className="payment-order-billno">Bill # {billNo != null ? String(billNo) : '—'}</div>
            </div>
            <ul ref={orderLinesRef} className="payment-order-lines">
              {cartItems.map((item, idx) => (
                <li
                  key={item.id ?? item.ITEMCODE ?? idx}
                  className={`payment-order-line ${item.void ? 'payment-order-line-void' : ''}`}
                >
                  <span className="payment-order-line-num">{idx + 1}.</span>{' '}
                  {item.name} x{item.quantity}
                  {item.void && <span className="payment-void-badge">VOID</span>}
                </li>
              ))}
            </ul>
            <span className="payment-order-detail" aria-hidden>🔍</span>
          </div>
        </aside>

        {/* Right: balance, bill + invoice, keypad, PAY */}
        <main className="payment-right-panel">
          <div className="payment-balance">
            <div className="payment-balance-label">
              {paymentMethod === 'card' ? 'DUE ON CARD' : 'BALANCE DUE'}
            </div>
            <div className="payment-balance-amount">
              QAR {balanceAmountShown.toFixed(2)}
            </div>
            {paymentMethod === 'cash' && showSplitCardBalance && !continueBalanceOnCard && (
              <span className="payment-entered-sub payment-balance-remaining-card">
                Remaining on card: QAR {cardDue.toFixed(2)}
              </span>
            )}
            {(paymentMethod === 'cash' || paymentMethod === 'card') && change > 0 && (
              <span className="payment-change payment-balance-change">
                Change: QAR {change.toFixed(2)}
              </span>
            )}
          </div>
          <div className="payment-entered">
            {paymentMethod === 'cash' && continueBalanceOnCard && (
              <>
                <div className="payment-entered-split payment-entered-split-compact">
                  <button
                    type="button"
                    className={`payment-entered-col payment-entered-col-click ${keypadTarget === 'cash' ? 'payment-entered-col-active' : ''}`}
                    onClick={focusSplitCashKeypad}
                    aria-pressed={keypadTarget === 'cash'}
                    aria-label="Cash amount — use keypad to edit"
                  >
                    <span className="payment-entered-label">CASH (STORED)</span>
                    <div className="payment-amount-readonly" aria-live="polite">
                      <span className="payment-amount-prefix">QAR</span>
                      <span className="payment-amount-readonly-value">{cashApplied.toFixed(2)}</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className={`payment-entered-col payment-entered-col-card payment-entered-col-click ${keypadTarget === 'card' ? 'payment-entered-col-active' : ''}`}
                    onClick={focusSplitCardKeypad}
                    aria-pressed={keypadTarget === 'card'}
                    aria-label="Card amount — use keypad to edit"
                  >
                    <span className="payment-entered-label">CARD (STORED)</span>
                    <div className="payment-amount-readonly" aria-live="polite">
                      <span className="payment-amount-prefix">QAR</span>
                      <span className="payment-amount-readonly-value">{cardDue.toFixed(2)}</span>
                    </div>
                  </button>
                </div>
              </>
            )}
            {paymentMethod === 'cash' && !continueBalanceOnCard && (
              <>
                <span className="payment-entered-label">CASH ENTERED (STORED)</span>
                <span className="payment-entered-value">QAR {amountTendered || '0.00'}</span>
              </>
            )}
            {paymentMethod === 'card' && (
              <>
                <span className="payment-entered-label">CARD ENTERED (STORED)</span>
                <span className="payment-entered-value">QAR {amountTendered || '0.00'}</span>
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
          {paymentMethod === 'cash' && (
            <label className="payment-continue-card">
              <input
                type="checkbox"
                checked={continueBalanceOnCard}
                onChange={(e) => setContinueBalanceOnCard(e.target.checked)}
              />
              <span>Continue balance on card (split payment)</span>
            </label>
          )}
          <button
            type="button"
            className="payment-pay-btn"
            onClick={handleComplete}
            disabled={!canComplete || isProcessing}
          >
            {isProcessing ? (
              <span className="payment-pay-loader"></span>
            ) : (
              'PAY'
            )}
          </button>
        </main>
      </div>
    </div>
  )
}

export default Payment
