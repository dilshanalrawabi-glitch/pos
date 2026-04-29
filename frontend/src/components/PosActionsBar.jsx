import '../styles/ProductDisplay.css'
import { useKeyboard } from '../context/KeyboardContext'

const QtyPlusIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
)

const QtyMinusIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
    <path d="M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
)

const POS_BUTTONS = [
  { id: 'sales-return', label: 'Sales Return', desc: 'Sales return' },
  { id: 'customer-add', label: 'Customer add', desc: 'Register a new customer' },
  { id: 'hold', label: 'Hold', desc: 'Hold bill' },
  { id: 'hold-retrieve', label: 'Hold Retrieve', desc: 'Release held bill' },
  { id: 'void-line', label: 'Void line', desc: 'Remove last line from bill' },
  { id: 'suspend-bill', label: 'Suspend bill', desc: 'Suspend current bill' },
  { id: 'qty', label: 'Quantity', desc: 'Increase or decrease cart quantity' },
  { id: 'pay', label: 'Pay', desc: 'Proceed to payment' },
]

function PosActionsBar({
  cartItems,
  selectedCartItemId,
  selectedCustomer,
  onHold,
  onHoldRetrieve,
  onVoidLine,
  onSuspendBill,
  onQtyIncrease,
  onQtyDecrease,
  onPosAction,
  onCheckout,
  checkoutLoading = false,
  isSalesReturn,
  /** When set, qty +/- tooltips use return wording if this or cart has return lines (toggle still uses `isSalesReturn`). */
  qtyReturnMode,
  onToggleSalesReturn,
  onCustomerAdd,
}) {
  const { clearFocusedInput } = useKeyboard()
  const qtyReturnContext = qtyReturnMode != null ? qtyReturnMode : isSalesReturn
  const isCreditCustomer = selectedCustomer && (selectedCustomer.INVOICECODE === 2 || selectedCustomer.INVOICECODE === '2' || selectedCustomer.invoicecode === 2 || selectedCustomer.invoicecode === '2')
  const payButtonLabel = isCreditCustomer ? 'Checkout' : 'Pay'
  const handleClick = (id) => {
    clearFocusedInput()
    if (id === 'sales-return') {
      if (onToggleSalesReturn) onToggleSalesReturn()
      else alert(isSalesReturn ? 'Sales' : 'Sales Return')
      return
    }
    if (id === 'customer-add') {
      if (onCustomerAdd) onCustomerAdd()
      return
    }
    if (id === 'hold') {
      if (onHold) onHold()
      else alert('Hold – bill saved')
      return
    }
    if (id === 'hold-retrieve') {
      if (onHoldRetrieve) onHoldRetrieve()
      else alert('Hold Retrieve – load held bill')
      return
    }
    if (id === 'void-line') {
      if (onVoidLine) onVoidLine()
      else alert('Void line – remove last line')
      return
    }
    if (id === 'suspend-bill') {
      if (onSuspendBill) onSuspendBill()
      else alert('Suspend bill – suspend current bill')
      return
    }
    if (id === 'pay' && onCheckout) {
      if (checkoutLoading) return
      onCheckout()
      return
    }
    if (onPosAction) onPosAction(id)
    else if (id === 'pay') alert('Pay – proceed to payment')
  }

  const qtyStepDisabled = !cartItems?.some((i) => !i.void)
  const qtyIncTitle = qtyReturnContext ? 'Increase return quantity' : 'Increase quantity'
  const qtyDecTitle = qtyReturnContext ? 'Decrease return quantity' : 'Decrease quantity'

  return (
    <div className="pos-actions pos-actions-standalone">
      {POS_BUTTONS.flatMap((btn) => {
        if (btn.id === 'qty') {
          return [
            <button
              key="qty-inc"
              type="button"
              className="pos-action-btn pos-action-btn-secondary pos-action-btn-qty-step"
              onClick={() => {
                clearFocusedInput()
                if (onQtyIncrease) onQtyIncrease()
                else alert('Increase quantity')
              }}
              title={qtyIncTitle}
              aria-label={qtyIncTitle}
              disabled={qtyStepDisabled}
            >
              <span className="pos-action-qty-step-icon">
                <QtyPlusIcon />
              </span>
            </button>,
            <button
              key="qty-dec"
              type="button"
              className="pos-action-btn pos-action-btn-secondary pos-action-btn-qty-step"
              onClick={() => {
                clearFocusedInput()
                if (onQtyDecrease) onQtyDecrease()
                else alert('Decrease quantity')
              }}
              title={qtyDecTitle}
              aria-label={qtyDecTitle}
              disabled={qtyStepDisabled}
            >
              <span className="pos-action-qty-step-icon">
                <QtyMinusIcon />
              </span>
            </button>,
          ]
        }
        return (
          <button
            key={btn.id}
            type="button"
            className={`pos-action-btn ${btn.id === 'pay' ? 'pos-action-btn-primary' : ''} ${['customer-add', 'hold', 'hold-retrieve', 'void-line', 'suspend-bill'].includes(btn.id) ? 'pos-action-btn-secondary' : ''} ${btn.id === 'void-line' ? 'pos-action-btn-void' : ''} ${btn.id === 'hold' ? 'pos-action-btn-hold' : ''} ${btn.id === 'suspend-bill' ? 'pos-action-btn-suspend' : ''} ${btn.id === 'sales-return' && isSalesReturn ? 'pos-action-btn-return-active' : ''}`}
            onClick={() => handleClick(btn.id)}
            title={
              btn.id === 'sales-return'
                ? isSalesReturn
                  ? 'Next add is a return, then back to normal sale. Click to cancel (stay on sale).'
                  : 'Click first: next item added is a return; after that, adds are normal sale without another click.'
                : btn.desc
            }
            aria-pressed={btn.id === 'sales-return' ? isSalesReturn : undefined}
            disabled={
              (btn.id === 'hold' && !cartItems?.length) ||
              (btn.id === 'void-line' && (!cartItems?.length || !selectedCartItemId)) ||
              (btn.id === 'suspend-bill' && !cartItems?.length) ||
              (btn.id === 'pay' && checkoutLoading)
            }
          >
            <span className="pos-action-label">
              {btn.id === 'pay' && checkoutLoading ? (
                <span className="pos-action-pay-loader" aria-hidden="true" />
              ) : btn.id === 'sales-return' ? (
                'Sales Return'
              ) : btn.id === 'pay' ? (
                payButtonLabel
              ) : (
                btn.label
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export default PosActionsBar
