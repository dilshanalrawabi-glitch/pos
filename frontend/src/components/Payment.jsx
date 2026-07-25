import { useState, useRef, useEffect } from 'react'
import '../styles/Payment.css'
import RedeemPointsModal from './RedeemPointsModal'

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
  const p =
    c.POINTS ?? c.points ?? c.LOYALTY_POINTS ?? c.loyalty_points ?? c.TOTALPOINTS ?? c.totalpoints
  const n = typeof p === 'number' ? p : parseInt(p, 10) || 0
  return Math.max(0, n)
}

function formatKeypadAmount(n) {
  if (n === 0) return ''
  const r = Math.round(n * 100) / 100
  return r % 1 === 0 ? String(r) : r.toFixed(2)
}

function roundMoney(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  return Math.round(x * 100) / 100
}

function paidCoversBill(paid, bill) {
  const p = Math.round(roundMoney(paid) * 100)
  const b = Math.round(roundMoney(bill) * 100)
  return p >= b
}

function Payment({
  cartItems,
  selectedCustomer,
  apiBase,
  billNo,
  locationCode,
  onComplete,
  onBack,
}) {
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [loyaltyPointsAvailable, setLoyaltyPointsAvailable] = useState(null)
  const [amountTendered, setAmountTendered] = useState('')
  const [pointsUsed, setPointsUsed] = useState(0)
  const [continueBalanceOnCard, setContinueBalanceOnCard] = useState(false)
  const [keypadTarget, setKeypadTarget] = useState('cash')
  const [cardKeypadInput, setCardKeypadInput] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [redemptionConfig, setRedemptionConfig] = useState({ redemptionPoint: 10, redemptionAmount: 1 })
  const [pointsRedemption, setPointsRedemption] = useState(null)
  const [pointsComboMode, setPointsComboMode] = useState('cash')
  const [showRedeemModal, setShowRedeemModal] = useState(false)
  const orderLinesRef = useRef(null)
  const completeInFlightRef = useRef(false)
  const prevPaymentMethodRef = useRef('cash')

  const activeItems = cartItems.filter((item) => !item.void)
  const subtotal = activeItems.reduce((sum, item) => sum + item.price * item.quantity, 0)

  const total = roundMoney(subtotal)
  const totalDisplay = Math.abs(total)
  const amountNum = roundMoney(parseFloat(amountTendered) || 0)
  const cardNum = roundMoney(parseFloat(cardKeypadInput) || 0)

  const splitKeypadMode = paymentMethod === 'cash' && continueBalanceOnCard
  const pointsMode = paymentMethod === 'points'
  const redemptionAmt = pointsMode && pointsRedemption ? roundMoney(pointsRedemption.amount) : 0
  const redemptionPts = pointsMode && pointsRedemption ? pointsRedemption.points : 0
  const billAfterRedemption = roundMoney(Math.max(0, total - redemptionAmt))

  const cashTendered = Math.max(
    0,
    pointsMode && pointsComboMode === 'cash'
      ? amountNum
      : splitKeypadMode || paymentMethod === 'cash'
        ? amountNum
        : 0,
  )
  const cardTendered = Math.max(
    0,
    pointsMode && pointsComboMode === 'card'
      ? amountNum
      : splitKeypadMode
        ? cardNum
        : paymentMethod === 'card'
          ? amountNum
          : 0,
  )

  const totalPaid = roundMoney(cashTendered + cardTendered)

  const balanceDue = pointsMode
    ? roundMoney(Math.max(0, billAfterRedemption - totalPaid))
    : roundMoney(Math.max(0, total - totalPaid))

  const change = pointsMode
    ? roundMoney(Math.max(0, totalPaid - billAfterRedemption))
    : roundMoney(Math.max(0, totalPaid - total))

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

  useEffect(() => {
    if (!apiBase) return undefined
    let cancelled = false
    fetch(`${apiBase}/api/points/redemption-config`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        const rp = Number(data?.redemptionPoint ?? data?.REDEMPTIONPOINT)
        const ra = Number(data?.redemptionAmount ?? data?.REDEMPTIONAMOUNT)
        setRedemptionConfig({
          redemptionPoint: rp > 0 ? rp : 10,
          redemptionAmount: ra > 0 ? ra : 1,
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [apiBase])

  useEffect(() => {
    if (!selectedCustomer || !apiBase) {
      setLoyaltyPointsAvailable(getCustomerPoints(selectedCustomer))
      return undefined
    }
    const code = selectedCustomer.CUSTOMERCODE ?? selectedCustomer.customercode ?? ''
    if (!code) {
      setLoyaltyPointsAvailable(getCustomerPoints(selectedCustomer))
      return undefined
    }
    let cancelled = false
    fetch(`${apiBase}/api/customers/balance?customerCode=${encodeURIComponent(code)}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        const p = data?.points ?? data?.POINTS ?? data?.totalpoints ?? data?.TOTALPOINTS
        const ptNum = typeof p === 'number' ? p : parseInt(p, 10)
        setLoyaltyPointsAvailable(Number.isNaN(ptNum) ? 0 : Math.max(0, ptNum || 0))
      })
      .catch(() => {
        if (!cancelled) setLoyaltyPointsAvailable(getCustomerPoints(selectedCustomer))
      })
    return () => {
      cancelled = true
    }
  }, [selectedCustomer, apiBase])

  const customerPoints = loyaltyPointsAvailable ?? getCustomerPoints(selectedCustomer)
  const hasCustomer = Boolean(
    selectedCustomer &&
      (selectedCustomer.CUSTOMERCODE ?? selectedCustomer.customercode ?? '').toString().trim(),
  )

  const balanceAmountShown = pointsMode
    ? billAfterRedemption
    : roundMoney(splitKeypadMode || paymentMethod === 'card' ? balanceDue : totalDisplay)

  const canCompletePoints = () => {
    if (!hasCustomer || redemptionPts <= 0) return false
    if (billAfterRedemption <= 0) return true
    if (pointsComboMode === 'cash') return paidCoversBill(cashTendered, billAfterRedemption)
    if (pointsComboMode === 'card') return paidCoversBill(cardTendered, billAfterRedemption)
    return false
  }

  const canComplete =
    paymentMethod === 'cash'
      ? continueBalanceOnCard
        ? paidCoversBill(totalPaid, total)
        : paidCoversBill(amountNum, total)
      : paymentMethod === 'card'
        ? paidCoversBill(cardTendered, total)
        : paymentMethod === 'loyalty'
          ? pointsUsed > 0 && pointsUsed <= customerPoints
          : paymentMethod === 'points'
            ? canCompletePoints()
            : false

  useEffect(() => {
    const el = orderLinesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [cartItems.length])

  useEffect(() => {
    const prev = prevPaymentMethodRef.current
    prevPaymentMethodRef.current = paymentMethod

    if (paymentMethod !== 'cash') setContinueBalanceOnCard(false)
    setKeypadTarget('cash')

    if (paymentMethod === 'points') {
      setPointsRedemption(null)
      setPointsComboMode('cash')
      setKeypadTarget('points')
      setAmountTendered('')
      setCardKeypadInput('')
    } else {
      setPointsRedemption(null)
      setPointsComboMode('cash')
    }

    if (paymentMethod === 'cash' && prev === 'card') {
      setAmountTendered('')
      setCardKeypadInput('')
    }
  }, [paymentMethod])

  useEffect(() => {
    if (paymentMethod !== 'card') return
    const t = roundMoney(total)
    if (t <= 0) {
      setAmountTendered('')
      return
    }
    setAmountTendered(t % 1 === 0 ? String(t) : t.toFixed(2))
  }, [paymentMethod, total])

  useEffect(() => {
    if (!continueBalanceOnCard) setKeypadTarget('cash')
  }, [continueBalanceOnCard])

  useEffect(() => {
    if (!pointsMode || !pointsComboMode) return
    const due = billAfterRedemption
    if (due <= 0) {
      setAmountTendered('')
      return
    }
    if (keypadTarget === 'cash' || keypadTarget === 'card') {
      setAmountTendered(due % 1 === 0 ? String(due) : due.toFixed(2))
    }
  }, [pointsMode, pointsComboMode, billAfterRedemption, keypadTarget])

  const cashOrCardKeypad =
    paymentMethod === 'cash' ||
    paymentMethod === 'card' ||
    (pointsMode && pointsComboMode && (keypadTarget === 'cash' || keypadTarget === 'card'))

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
      } else if (paymentMethod === 'loyalty') {
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
    } else if (paymentMethod === 'loyalty') {
      if (key === '.') return
      const next = pointsUsed * 10 + parseInt(key, 10)
      if (next <= 999999) setPointsUsed(Math.min(next, customerPoints))
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

  const handleOpenRedeem = () => {
    if (!hasCustomer) {
      alert('Select a customer to redeem points.')
      return
    }
    if (customerPoints <= 0) {
      alert('Customer has no points available.')
      return
    }
    setShowRedeemModal(true)
  }

  const handleRedeemConfirm = (redemption) => {
    setPointsRedemption(redemption)
    setAmountTendered('')
    if (redemption.amount >= total) {
      setPointsComboMode('cash')
      setKeypadTarget('points')
    } else {
      setKeypadTarget(pointsComboMode === 'card' ? 'card' : 'cash')
    }
  }

  const handlePointsComboChange = (mode) => {
    setPointsComboMode(mode)
    setKeypadTarget(mode)
    setAmountTendered('')
  }

  const focusPointsRedeem = () => {
    setKeypadTarget('points')
    handleOpenRedeem()
  }

  const focusPointsCashKeypad = () => {
    setKeypadTarget('cash')
    setAmountTendered(formatKeypadAmount(cashTendered))
  }

  const focusPointsCardKeypad = () => {
    setKeypadTarget('card')
    setAmountTendered(formatKeypadAmount(cardTendered))
  }

  const handleComplete = () => {
    if (!canComplete || isProcessing || completeInFlightRef.current) return
    completeInFlightRef.current = true
    setIsProcessing(true)
    const changeAmt = change

    let payload
    if (pointsMode && pointsRedemption) {
      const netTotal = roundMoney(total - redemptionAmt)
      const pm =
        billAfterRedemption <= 0
          ? 'points'
          : pointsComboMode === 'cash'
            ? 'cash_points'
            : 'card_points'
      payload = {
        paymentMethod: pm,
        redemptionPoints: redemptionPts,
        redemptionAmount: redemptionAmt,
        cashAmount: pointsComboMode === 'cash' ? cashTendered : 0,
        cardAmount: pointsComboMode === 'card' ? cardTendered : 0,
        amountTendered: pointsComboMode === 'cash' ? cashTendered : pointsComboMode === 'card' ? 0 : 0,
        change: changeAmt,
        total: netTotal,
        grossTotal: total,
        subtotal,
        items: activeItems,
      }
    } else if (splitKeypadMode) {
      if (cashTendered > 0 && cardTendered > 0) {
        payload = {
          paymentMethod: 'split',
          cashAmount: cashTendered,
          cardAmount: cardTendered,
          amountTendered: cashTendered,
          change: changeAmt,
          total,
          subtotal,
          items: activeItems,
        }
      } else if (cardTendered > 0 && cashTendered <= 0) {
        payload = {
          paymentMethod: 'card',
          cardAmount: cardTendered,
          amountTendered: 0,
          change: changeAmt,
          total,
          subtotal,
          items: activeItems,
        }
      } else if (cashTendered > 0 && cardTendered <= 0) {
        payload = {
          paymentMethod: 'cash',
          cashAmount: cashTendered,
          cardAmount: 0,
          amountTendered: cashTendered,
          change: changeAmt,
          total,
          subtotal,
          items: activeItems,
        }
      }
    }

    if (!payload) {
      payload = {
        paymentMethod,
        cashAmount: paymentMethod === 'cash' ? cashApplied : undefined,
        cardAmount:
          paymentMethod === 'card' ? cardTendered : paymentMethod === 'cash' ? 0 : undefined,
        amountTendered: paymentMethod === 'card' ? cardTendered : cashGivenForReceipt,
        change,
        total,
        subtotal,
        items: activeItems,
      }
    }

    const runComplete = () => {
      void Promise.resolve(onComplete?.(payload)).finally(() => {
        completeInFlightRef.current = false
        setIsProcessing(false)
      })
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        requestAnimationFrame(runComplete)
      })
    } else {
      setTimeout(runComplete, 0)
    }
  }

  const showChangeColumn =
    ((paymentMethod === 'cash' || paymentMethod === 'card') && change > 0) ||
    (pointsMode && pointsComboMode === 'cash' && change > 0)

  const showKeypad =
    paymentMethod !== 'points' || pointsComboMode != null

  return (
    <div className="payment-page">
      <button type="button" className="payment-back" onClick={onBack} aria-label="Back to cart">
        ← Back
      </button>

      <RedeemPointsModal
        open={showRedeemModal}
        onClose={() => setShowRedeemModal(false)}
        onConfirm={handleRedeemConfirm}
        availablePoints={customerPoints}
        balanceDue={total}
        redemptionPoint={redemptionConfig.redemptionPoint}
        redemptionAmount={redemptionConfig.redemptionAmount}
        initialRedemption={pointsRedemption}
      />

      <div className="payment-panels">
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
                onClick={() => {
                  setPaymentMethod(m.id)
                  if (m.id === 'points') {
                    setTimeout(() => handleOpenRedeem(), 0)
                  }
                }}
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
                  key={`${item.id ?? item.ITEMCODE}_${item.manufactureId ?? ''}_${idx}`}
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

        <main className="payment-right-panel">
          <div className="payment-balance">
            <div
              className={`payment-balance-main ${showChangeColumn ? 'payment-balance-main--split' : ''}`}
            >
              <div className="payment-balance-col">
                <div className="payment-balance-label">
                  {paymentMethod === 'card'
                    ? 'DUE ON CARD'
                    : pointsMode && pointsComboMode === 'card'
                      ? 'DUE ON CARD'
                      : 'BALANCE DUE'}
                </div>
                <div className="payment-balance-amount-row" aria-live="polite" aria-atomic="true">
                  <span className="payment-balance-currency">QAR</span>
                  <span className="payment-balance-amount">{balanceAmountShown.toFixed(2)}</span>
                </div>
              </div>
              {showChangeColumn && (
                <div className="payment-balance-col payment-balance-col-change" role="status">
                  <div className="payment-balance-label">Change</div>
                  <div className="payment-balance-amount-row">
                    <span className="payment-balance-currency">QAR</span>
                    <span className="payment-balance-amount">{change.toFixed(2)}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="payment-entered">
            {pointsMode && (
              <div className="payment-entered-split payment-entered-split-compact payment-points-stored-row">
                <button
                  type="button"
                  className={`payment-entered-col payment-entered-col-points payment-entered-col-click ${keypadTarget === 'points' ? 'payment-entered-col-active' : ''}`}
                  onClick={focusPointsRedeem}
                  aria-label="Points redemption — tap to change"
                >
                  <span className="payment-entered-label">POINTS (STORED)</span>
                  <div className="payment-amount-readonly payment-points-stored-value" aria-live="polite">
                    <span className="payment-points-stored-text">
                      {redemptionPts} = QAR {redemptionAmt.toFixed(2)}
                    </span>
                  </div>
                </button>
                <button
                  type="button"
                  className={`payment-entered-col payment-entered-col-click ${pointsComboMode === 'card' ? 'payment-entered-col-card' : ''} ${keypadTarget === 'cash' || keypadTarget === 'card' ? 'payment-entered-col-active' : ''}`}
                  onClick={pointsComboMode === 'card' ? focusPointsCardKeypad : focusPointsCashKeypad}
                  aria-label={
                    pointsComboMode === 'card'
                      ? 'Card amount — use keypad to edit'
                      : 'Cash amount — use keypad to edit'
                  }
                >
                  <span className="payment-entered-label">
                    {pointsComboMode === 'card' ? 'CARD (STORED)' : 'CASH (STORED)'}
                  </span>
                  <div className="payment-amount-readonly" aria-live="polite">
                    <span className="payment-amount-prefix">QAR</span>
                    <span className="payment-amount-readonly-value">
                      {amountTendered || '0.00'}
                    </span>
                  </div>
                </button>
              </div>
            )}
            {paymentMethod === 'cash' && continueBalanceOnCard && (
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
          </div>

          {showKeypad && (
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
          )}

          {paymentMethod === 'cash' && (
            <label className="payment-continue-card">
              <input
                type="checkbox"
                checked={continueBalanceOnCard}
                onChange={(e) => setContinueBalanceOnCard(e.target.checked)}
              />
              <span>Card + Cash</span>
            </label>
          )}

          {pointsMode && (
            <div className="payment-points-combo">
              <label className="payment-continue-card">
                <input
                  type="checkbox"
                  checked={pointsComboMode === 'cash'}
                  onChange={() => handlePointsComboChange('cash')}
                />
                <span>Cash + Points</span>
              </label>
              <label className="payment-continue-card">
                <input
                  type="checkbox"
                  checked={pointsComboMode === 'card'}
                  onChange={() => handlePointsComboChange('card')}
                />
                <span>Card + Points</span>
              </label>
            </div>
          )}

          <button
            type="button"
            className="payment-pay-btn"
            onClick={handleComplete}
            disabled={!canComplete || isProcessing}
            aria-busy={isProcessing}
          >
            {isProcessing ? (
              <span className="payment-pay-loading">
                <span className="payment-pay-loader" aria-hidden />
                <span className="payment-pay-loading-text">Saving bill…</span>
              </span>
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
