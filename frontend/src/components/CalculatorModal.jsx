import { useState, useEffect } from 'react'
import '../styles/CalculatorModal.css'

const MAX_INPUT_LEN = 14
const MAX_EXPR_LEN = 40

const OP_SYMBOL = { '+': '+', '-': '−', '*': '×', '/': '÷' }

function compute(a, b, op) {
  switch (op) {
    case '+': return a + b
    case '-': return a - b
    case '*': return a * b
    case '/': return b === 0 ? NaN : a / b
    default: return b
  }
}

function formatResult(n) {
  if (!Number.isFinite(n)) return 'Error'
  const rounded = Math.round(n * 1e10) / 1e10
  const s = String(rounded)
  if (s.length > MAX_INPUT_LEN) return rounded.toExponential(6)
  return s
}

function formatOperand(n) {
  if (n == null || Number.isNaN(n)) return '0'
  return formatResult(n)
}

function parseInput(value) {
  if (value === 'Error' || value === '' || value === '-') return null
  const n = parseFloat(value)
  return Number.isNaN(n) ? null : n
}

const KEYPAD_ROWS = [
  [
    { key: 'clear', label: 'C', className: 'calc-key-fn' },
    { key: 'back', label: '⌫', className: 'calc-key-fn' },
    { key: 'op', op: '/', label: '÷', className: 'calc-key-op' },
  ],
  [
    { key: 'digit', digit: '7', label: '7' },
    { key: 'digit', digit: '8', label: '8' },
    { key: 'digit', digit: '9', label: '9' },
    { key: 'op', op: '*', label: '×', className: 'calc-key-op' },
  ],
  [
    { key: 'digit', digit: '4', label: '4' },
    { key: 'digit', digit: '5', label: '5' },
    { key: 'digit', digit: '6', label: '6' },
    { key: 'op', op: '-', label: '−', className: 'calc-key-op' },
  ],
  [
    { key: 'digit', digit: '1', label: '1' },
    { key: 'digit', digit: '2', label: '2' },
    { key: 'digit', digit: '3', label: '3' },
    { key: 'op', op: '+', label: '+', className: 'calc-key-op' },
  ],
  [
    { key: 'digit', digit: '0', label: '0', className: 'calc-key-zero' },
    { key: 'decimal', label: '.', className: 'calc-key-decimal' },
    { key: 'equals', label: '=', className: 'calc-key-equals' },
  ],
]

export default function CalculatorModal({ open, onClose }) {
  const [currentInput, setCurrentInput] = useState('0')
  const [stored, setStored] = useState(null)
  const [operator, setOperator] = useState(null)
  const [waitingForOperand, setWaitingForOperand] = useState(false)
  const [resultShown, setResultShown] = useState(false)

  useEffect(() => {
    if (!open) return
    setCurrentInput('0')
    setStored(null)
    setOperator(null)
    setWaitingForOperand(false)
    setResultShown(false)
  }, [open])

  if (!open) return null

  const buildExpression = () => {
    if (resultShown) return currentInput
    if (operator == null) return currentInput
    const sym = OP_SYMBOL[operator] || operator
    const left = formatOperand(stored)
    if (waitingForOperand) return `${left} ${sym} `
    return `${left} ${sym} ${currentInput}`
  }

  const expressionDisplay = buildExpression()

  const inputDigit = (digit) => {
    setResultShown(false)
    if (waitingForOperand) {
      setCurrentInput(digit)
      setWaitingForOperand(false)
      return
    }
    if (currentInput === 'Error') {
      setCurrentInput(digit)
      return
    }
    if (currentInput === '0') {
      setCurrentInput(digit)
      return
    }
    if (currentInput.replace('.', '').length >= MAX_INPUT_LEN) return
    setCurrentInput(currentInput + digit)
  }

  const inputDecimal = () => {
    setResultShown(false)
    if (waitingForOperand) {
      setCurrentInput('0.')
      setWaitingForOperand(false)
      return
    }
    if (currentInput === 'Error') {
      setCurrentInput('0.')
      return
    }
    if (!currentInput.includes('.')) setCurrentInput(`${currentInput}.`)
  }

  const clear = () => {
    setCurrentInput('0')
    setStored(null)
    setOperator(null)
    setWaitingForOperand(false)
    setResultShown(false)
  }

  const backspace = () => {
    if (resultShown) {
      clear()
      return
    }
    if (waitingForOperand) {
      setOperator(null)
      setWaitingForOperand(false)
      setCurrentInput(formatOperand(stored))
      setStored(null)
      return
    }
    if (currentInput === 'Error') {
      setCurrentInput('0')
      return
    }
    if (currentInput.length <= 1) {
      setCurrentInput('0')
      return
    }
    const next = currentInput.slice(0, -1)
    setCurrentInput(next === '-' ? '0' : next)
  }

  const performOperation = (nextOp) => {
    const current = parseInput(currentInput)
    if (current === null && !resultShown) return

    setResultShown(false)

    if (stored === null) {
      if (current === null) return
      setStored(current)
    } else if (!waitingForOperand && operator) {
      if (current === null) return
      const result = compute(stored, current, operator)
      const formatted = formatResult(result)
      const parsed = parseFloat(formatted)
      setStored(Number.isFinite(parsed) ? parsed : null)
      setCurrentInput(formatted)
    } else if (waitingForOperand) {
      // replace operator only
    }

    setOperator(nextOp)
    setWaitingForOperand(true)
  }

  const equals = () => {
    if (operator == null || stored === null) return
    const current = parseInput(currentInput)
    if (current === null) return
    const result = compute(stored, current, operator)
    const formatted = formatResult(result)
    setCurrentInput(formatted)
    setStored(null)
    setOperator(null)
    setWaitingForOperand(false)
    setResultShown(true)
  }

  const handleKey = (btn) => {
    if (btn.key === 'clear') clear()
    else if (btn.key === 'back') backspace()
    else if (btn.key === 'decimal') inputDecimal()
    else if (btn.key === 'digit') inputDigit(btn.digit)
    else if (btn.key === 'op') performOperation(btn.op)
    else if (btn.key === 'equals') equals()
  }

  return (
    <div className="calc-overlay" onClick={onClose} role="presentation">
      <div
        className="calc-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="calc-title"
      >
        <div className="calc-header">
          <h2 id="calc-title" className="calc-title">Calculator</h2>
          <button type="button" className="calc-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div
          className={`calc-display ${resultShown ? 'calc-display-result' : ''}`}
          aria-live="polite"
          data-no-osk="true"
          title={expressionDisplay}
        >
          {expressionDisplay.length > MAX_EXPR_LEN
            ? `…${expressionDisplay.slice(-MAX_EXPR_LEN)}`
            : expressionDisplay}
        </div>

        <div className="calc-keypad">
          {KEYPAD_ROWS.map((row, rowIdx) => (
            <div key={rowIdx} className="calc-keypad-row">
              {row.map((btn) => (
                <button
                  key={btn.label}
                  type="button"
                  className={`calc-key ${btn.className || ''}`}
                  onClick={() => handleKey(btn)}
                >
                  {btn.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
