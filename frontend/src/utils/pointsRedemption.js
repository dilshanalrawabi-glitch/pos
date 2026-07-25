/** Round to 2 decimal places for money. */
export function roundMoney(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  return Math.round(x * 100) / 100
}

/** QAR value for a given number of points. */
export function pointsToQar(points, redemptionPoint, redemptionAmount) {
  const rp = Number(redemptionPoint)
  const ra = Number(redemptionAmount)
  const pts = Number(points)
  if (!Number.isFinite(rp) || !Number.isFinite(ra) || rp <= 0 || ra <= 0 || !Number.isFinite(pts) || pts <= 0) {
    return 0
  }
  return roundMoney((pts / rp) * ra)
}

/** Points required for a QAR amount (floor so we never over-redeem). */
export function qarToPoints(qar, redemptionPoint, redemptionAmount) {
  const rp = Number(redemptionPoint)
  const ra = Number(redemptionAmount)
  const amount = Number(qar)
  if (!Number.isFinite(rp) || !Number.isFinite(ra) || rp <= 0 || ra <= 0 || !Number.isFinite(amount) || amount <= 0) {
    return 0
  }
  return Math.floor((amount / ra) * rp)
}

/** Max points redeemable given customer balance and bill total. */
export function maxRedeemablePoints(customerPoints, balanceDue, redemptionPoint, redemptionAmount) {
  const available = Math.max(0, Number(customerPoints) || 0)
  const due = Number(balanceDue) || 0
  if (due <= 0 || available <= 0) return 0
  const billPts = qarToPoints(due, redemptionPoint, redemptionAmount)
  if (billPts <= 0) return 0
  return Math.min(available, billPts)
}

/** Clamp redemption to valid limits. Returns { points, amount }. */
export function clampRedemption(
  { points, amount },
  { customerPoints, balanceDue, redemptionPoint, redemptionAmount },
) {
  const maxPts = maxRedeemablePoints(customerPoints, balanceDue, redemptionPoint, redemptionAmount)
  let pts = Math.max(0, Math.min(Math.floor(Number(points) || 0), maxPts))
  let amt = pointsToQar(pts, redemptionPoint, redemptionAmount)
  if (amt > balanceDue) {
    pts = qarToPoints(balanceDue, redemptionPoint, redemptionAmount)
    amt = pointsToQar(pts, redemptionPoint, redemptionAmount)
  }
  amt = Math.min(roundMoney(amt), roundMoney(balanceDue))
  return { points: pts, amount: amt }
}
