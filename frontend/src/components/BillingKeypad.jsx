import '../styles/BillingKeypad.css'

function BillingKeypad({ value = '', onChange, onEnter }) {
  const handleKey = (key) => {
    if (key === '⌫') {
      onChange((v) => String(v).slice(0, -1))
      return
    }
    if (key === 'Clear') {
      onChange('')
      return
    }
    if (key === 'Enter') {
      onEnter?.()
      return
    }
    onChange((v) => String(v) + key)
  }

  const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
  return (
    <div className="billing-keypad-wrap">
      <div className="billing-keypad-display" aria-live="polite">
        {value || '\u00A0'}
      </div>
      <div className="billing-keypad">
        {digits.map((d) => (
          <button
            key={d}
            type="button"
            className="billing-keypad-key"
            onClick={() => handleKey(d)}
            aria-label={`Key ${d}`}
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          className="billing-keypad-key billing-keypad-back"
          onClick={() => handleKey('⌫')}
          aria-label="Backspace"
        >
          ⌫
        </button>
        <button
          type="button"
          className="billing-keypad-key"
          onClick={() => handleKey('0')}
          aria-label="Key 0"
        >
          0
        </button>
        <button
          type="button"
          className="billing-keypad-key billing-keypad-dot"
          onClick={() => handleKey('.')}
          aria-label="Decimal point"
        >
          .
        </button>
        <button
          type="button"
          className="billing-keypad-key billing-keypad-clear"
          onClick={() => handleKey('Clear')}
          aria-label="Clear"
        >
          Clear
        </button>
        <button
          type="button"
          className="billing-keypad-key billing-keypad-enter"
          onClick={() => handleKey('Enter')}
          aria-label="Enter"
        >
          Enter
        </button>
      </div>
    </div>
  )
}

export default BillingKeypad
