import '../styles/ProductDisplay.css'
import { useKeyboard } from '../context/KeyboardContext'

const POS_BUTTONS = [
  { id: 'sales-return', label: 'Sales Return', desc: 'Sales return' },
  { id: 'hold', label: 'Hold', desc: 'Hold bill' },
  { id: 'hold-retrieve', label: 'Hold Retrieve', desc: 'Release held bill' },
  { id: 'void-line', label: 'Void line', desc: 'Remove last line from bill' },
  { id: 'suspend-bill', label: 'Suspend bill', desc: 'Suspend current bill' },
  { id: 'qty', label: 'Quantity', desc: 'Edit cart quantity' },
  { id: 'discount', label: 'Discount', desc: 'Apply discount' },
  { id: 'pay', label: 'Pay', desc: 'Proceed to payment' },
]

function PosActionsBar({ cartItems, selectedCartItemId, selectedCustomer, onHold, onHoldRetrieve, onVoidLine, onSuspendBill, onQty, onPosAction, onCheckout, isSalesReturn, onToggleSalesReturn }) {
  const { clearFocusedInput } = useKeyboard()
  const isCreditCustomer = selectedCustomer && (selectedCustomer.INVOICECODE === 2 || selectedCustomer.INVOICECODE === '2' || selectedCustomer.invoicecode === 2 || selectedCustomer.invoicecode === '2')
  const payButtonLabel = isCreditCustomer ? 'Checkout' : 'Pay'
  const handleClick = (id) => {
    clearFocusedInput()
    if (id === 'sales-return') {
      if (onToggleSalesReturn) onToggleSalesReturn()
      else alert(isSalesReturn ? 'Sales' : 'Sales Return')
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
    if (id === 'qty') {
      if (onQty) onQty()
      else alert('Quantity – edit cart quantity')
      return
    }
    if (id === 'pay' && onCheckout) {
      onCheckout()
      return
    }
    if (onPosAction) onPosAction(id)
    else if (id === 'discount') alert('Discount – apply discount')
    else if (id === 'pay') alert('Pay – proceed to payment')
  }

  return (
    <div className="pos-actions pos-actions-standalone">
      {POS_BUTTONS.map((btn) => (
        <button
          key={btn.id}
          type="button"
          className={`pos-action-btn ${btn.id === 'pay' ? 'pos-action-btn-primary' : ''} ${['hold', 'hold-retrieve', 'void-line', 'suspend-bill', 'qty'].includes(btn.id) ? 'pos-action-btn-secondary' : ''} ${btn.id === 'void-line' ? 'pos-action-btn-void' : ''} ${btn.id === 'discount' ? 'pos-action-btn-discount' : ''} ${btn.id === 'hold' ? 'pos-action-btn-hold' : ''} ${btn.id === 'suspend-bill' ? 'pos-action-btn-suspend' : ''}`}
          onClick={() => handleClick(btn.id)}
          title={btn.id === 'sales-return' ? (isSalesReturn ? 'Switch to Sales' : 'Sales return') : btn.desc}
          disabled={
            (btn.id === 'hold' && !cartItems?.length) ||
            (btn.id === 'void-line' && (!cartItems?.length || !selectedCartItemId)) ||
            (btn.id === 'suspend-bill' && !cartItems?.length) ||
            (btn.id === 'qty' && !cartItems?.length)
          }
        >
          <span className="pos-action-label">{btn.id === 'sales-return' ? (isSalesReturn ? 'Sales' : 'Sales Return') : (btn.id === 'pay' ? payButtonLabel : btn.label)}</span>
        </button>
      ))}
    </div>
  )
}

export default PosActionsBar
