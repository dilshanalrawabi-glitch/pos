import '../styles/ProductDisplay.css'

const POS_BUTTONS = [
  { id: 'member', label: 'Member', desc: 'Customer points' },
  { id: 'hold', label: 'Hold', desc: 'Hold bill' },
  { id: 'hold-retrieve', label: 'Hold Retrieve', desc: 'Release held bill' },
  { id: 'void-line', label: 'Void line', desc: 'Remove last line from bill' },
  { id: 'suspend-bill', label: 'Suspend bill', desc: 'Suspend current bill' },
  { id: 'discount', label: 'Discount', desc: 'Apply discount' },
  { id: 'pay', label: 'Pay', desc: 'Proceed to payment' },
]

function PosActionsBar({ cartItems, hasHeldCart, onHold, onHoldRetrieve, onVoidLine, onSuspendBill, onPosAction, onCheckout }) {
  const handleClick = (id) => {
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
      onCheckout()
      return
    }
    if (onPosAction) onPosAction(id)
    else if (id === 'member') alert('Member – select customer for points')
    else if (id === 'discount') alert('Discount – apply discount')
    else if (id === 'pay') alert('Pay – proceed to payment')
  }

  return (
    <div className="pos-actions pos-actions-standalone">
      {POS_BUTTONS.map((btn) => (
        <button
          key={btn.id}
          type="button"
          className={`pos-action-btn ${btn.id === 'pay' ? 'pos-action-btn-primary' : ''} ${['hold', 'hold-retrieve', 'void-line', 'suspend-bill'].includes(btn.id) ? 'pos-action-btn-secondary' : ''}`}
          onClick={() => handleClick(btn.id)}
          title={btn.desc}
          disabled={
            (btn.id === 'hold' && !cartItems?.length) ||
            (btn.id === 'hold-retrieve' && !hasHeldCart) ||
            (btn.id === 'void-line' && !cartItems?.length) ||
            (btn.id === 'suspend-bill' && !cartItems?.length)
          }
        >
          <span className="pos-action-label">{btn.label}</span>
        </button>
      ))}
    </div>
  )
}

export default PosActionsBar
