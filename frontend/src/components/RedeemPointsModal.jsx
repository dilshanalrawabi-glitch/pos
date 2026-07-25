import { useState, useEffect } from 'react'
import '../styles/RedeemPointsModal.css'
import {
  pointsToQar,
  qarToPoints,
  maxRedeemablePoints,
  clampRedemption,
  roundMoney,
} from '../utils/pointsRedemption'

const KEYPAD_KEYS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['', '0', 'back'],
]

function appendDecimal(prev, key) {
  if (key === '.' && prev.includes('.')) return prev
  const next = prev + key
  const parts = next.split('.')
  if (parts[1] && parts[1].length > 2) return prev
  return next
}

export default function RedeemPointsModal({
  open,
  onClose,
  onConfirm,
  availablePoints = 0,
  balanceDue = 0,
  redemptionPoint = 10,
  redemptionAmount = 1,
  initialRedemption = null,
}) {
  const [inputMode, setInputMode] = useState('points')
  const [pointsInput, setPointsInput] = useState('')
  const [qarInput, setQarInput] = useState('')

  useEffect(() => {
    if (!open) return
    const initPts = initialRedemption?.points ?? 0
    const initAmt = initialRedemption?.amount ?? 0
    setPointsInput(initPts > 0 ? String(initPts) : '')
    setQarInput(initAmt > 0 ? (initAmt % 1 === 0 ? String(initAmt) : initAmt.toFixed(2)) : '')
    setInputMode('points')
  }, [open, initialRedemption])

  if (!open) return null

  const maxPts = maxRedeemablePoints(availablePoints, balanceDue, redemptionPoint, redemptionAmount)

  const parsedPoints =
    inputMode === 'points'
      ? Math.min(parseInt(pointsInput, 10) || 0, maxPts)
      : qarToPoints(parseFloat(qarInput) || 0, redemptionPoint, redemptionAmount)

  const parsedAmount = pointsToQar(parsedPoints, redemptionPoint, redemptionAmount)
  const displayPoints = inputMode === 'points' ? pointsInput || '0' : String(parsedPoints)
  const displayQar =
    inputMode === 'qar'
      ? qarInput || '0.00'
      : (parsedAmount % 1 === 0 ? parsedAmount.toFixed(2) : parsedAmount.toFixed(2))

  const handleKeypad = (key) => {
    if (key === 'back') {
      if (inputMode === 'points') {
        setPointsInput((prev) => prev.slice(0, -1))
      } else {
        setQarInput((prev) => prev.slice(0, -1))
      }
      return
    }
    if (key === '') return
    if (inputMode === 'points') {
      if (key === '.') return
      const next = (pointsInput + key).replace(/^0+(?=\d)/, '')
      const n = parseInt(next, 10) || 0
      if (n <= maxPts) setPointsInput(String(n))
    } else {
      setQarInput((prev) => appendDecimal(prev, key))
    }
  }

  const handleDone = () => {
    const raw =
      inputMode === 'points'
        ? { points: parseInt(pointsInput, 10) || 0, amount: 0 }
        : {
            points: qarToPoints(parseFloat(qarInput) || 0, redemptionPoint, redemptionAmount),
            amount: roundMoney(parseFloat(qarInput) || 0),
          }
    const clamped = clampRedemption(raw, {
      customerPoints: availablePoints,
      balanceDue,
      redemptionPoint,
      redemptionAmount,
    })
    onConfirm?.(clamped)
    onClose?.()
  }

  const rateLabel = `${redemptionPoint} pts = QAR ${Number(redemptionAmount).toFixed(2)}`

  return (
    <div className="redeem-points-overlay" onClick={onClose} role="presentation">
      <div
        className="redeem-points-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="redeem-points-title"
      >
        <div className="redeem-points-header">
          <h2 id="redeem-points-title" className="redeem-points-title">
            Redeem Points
          </h2>
          <button type="button" className="redeem-points-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="redeem-points-toggle">
          <button
            type="button"
            className={`redeem-points-toggle-btn ${inputMode === 'points' ? 'active' : ''}`}
            onClick={() => setInputMode('points')}
          >
            Points
          </button>
          <button
            type="button"
            className={`redeem-points-toggle-btn ${inputMode === 'qar' ? 'active' : ''}`}
            onClick={() => setInputMode('qar')}
          >
            QAR
          </button>
        </div>

        <div className="redeem-points-display">
          {inputMode === 'points' ? (
            <div className="redeem-points-primary">
              <span className="redeem-points-value">{displayPoints}</span>
              <span className="redeem-points-unit">PTS</span>
            </div>
          ) : (
            <div className="redeem-points-primary">
              <span className="redeem-points-unit redeem-points-unit-prefix">QAR</span>
              <span className="redeem-points-value">{displayQar}</span>
            </div>
          )}
          <div className="redeem-points-equiv">
            = QAR {inputMode === 'points' ? displayQar : roundMoney(parsedAmount).toFixed(2)}
          </div>
          <div className="redeem-points-meta">
            {availablePoints} available · {rateLabel}
          </div>
        </div>

        <div className="redeem-points-keypad">
          {KEYPAD_KEYS.map((row, i) => (
            <div key={i} className="redeem-points-keypad-row">
              {row.map((key) =>
                key === '' ? (
                  <span key="spacer" className="redeem-points-key redeem-points-key-spacer" aria-hidden />
                ) : (
                  <button
                    key={key}
                    type="button"
                    className={`redeem-points-key ${key === 'back' ? 'redeem-points-key-back' : ''}`}
                    onClick={() => handleKeypad(key)}
                  >
                    {key === 'back' ? '⌫' : key}
                  </button>
                ),
              )}
            </div>
          ))}
        </div>

        <button type="button" className="redeem-points-done" onClick={handleDone}>
          Done
        </button>
      </div>
    </div>
  )
}
