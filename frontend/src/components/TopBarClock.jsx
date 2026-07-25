import { useState, useEffect } from 'react'

/** Isolated clock so 1s ticks do not re-render Billing / CartSummary. */
export default function TopBarClock() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const tick = () => setNow(new Date())
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <time className="top-bar-clock" dateTime={now.toISOString()} aria-live="polite">
      {now.toLocaleTimeString('en-GB', {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      })}
    </time>
  )
}
