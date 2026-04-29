import { useState, useEffect, useCallback, useRef } from 'react'
import '../styles/BackDisplay.css'
import { getApiBase } from '../apiBase'

/** Piece counts and fractional kg (weighted items) — avoid trimming decimals to integers. */
function formatBackDisplayQty(n) {
  const q = Number(n)
  if (!Number.isFinite(q)) return '0'
  return new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
    useGrouping: false,
  }).format(q)
}

function BackDisplay() {
  const [items, setItems] = useState([])
  const [error, setError] = useState(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showThankYou, setShowThankYou] = useState(false)
  const [locationName, setLocationName] = useState('')
  const itemsScrollRef = useRef(null)
  const prevItemCountRef = useRef(0)

  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', onChange)
    onChange()
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {})
    } else {
      document.exitFullscreen?.().catch(() => {})
    }
  }, [])

  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams()
  const counterCode = params.get('counterCode') || params.get('counter_code') || sessionStorage.getItem('pos_counter_code') || 'CNT01'
  const locationCode = params.get('locationCode') || params.get('location_code') || sessionStorage.getItem('pos_location') || 'LOC001'

  useEffect(() => {
    const fetchCurrent = () => {
      const url = `${getApiBase()}/api/display/current?counterCode=${encodeURIComponent(counterCode)}&locationCode=${encodeURIComponent(locationCode)}`
      fetch(url)
        .then((res) => res.json())
        .then((data) => {
          if (data && data.ok !== false) {
            setItems(Array.isArray(data.items) ? data.items : [])
            setLocationName(typeof data.locationName === 'string' ? data.locationName.trim() : '')
            setError(null)
          } else {
            setError(data?.error || 'Failed to load')
          }
        })
        .catch((err) => {
          setError(err.message || 'Connection error')
          setItems([])
        })
    }

    fetchCurrent()
    const interval = setInterval(fetchCurrent, 2000)
    return () => clearInterval(interval)
  }, [counterCode, locationCode])

  /** First line at top, last line at bottom; keep scroll pinned to bottom so newest lines stay visible above total. */
  useEffect(() => {
    const el = itemsScrollRef.current
    if (!el || items.length === 0) return
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(id)
  }, [items])

  useEffect(() => {
    if (error) return
    const prev = prevItemCountRef.current
    if (items.length > 0) {
      setShowThankYou(false)
    } else if (prev > 0) {
      setShowThankYou(true)
    }
    prevItemCountRef.current = items.length
  }, [items, error])

  useEffect(() => {
    if (!showThankYou) return
    const t = window.setTimeout(() => setShowThankYou(false), 12000)
    return () => window.clearTimeout(t)
  }, [showThankYou])

  const total = items.reduce((sum, item) => {
    const qty = Number(item.quantity ?? item.QUANTITY)
    const price = Number(item.price ?? item.RATE)
    const q = Number.isFinite(qty) ? qty : 0
    const p = Number.isFinite(price) ? price : 0
    return sum + q * p
  }, 0)

  return (
    <div className="back-display">
      {locationName ? (
        <header className="back-display-page-heading">
          <h1 className="back-display-page-title">{locationName}</h1>
        </header>
      ) : null}

      <div className="back-display-main">
        {error && (
          <div className="back-display-error">
            {error}
          </div>
        )}

        {!error && items.length === 0 && (
          <div className="back-display-idle">
            {showThankYou ? (
              <p className="back-display-idle-text">Thank you</p>
            ) : (
              <>
                <p className="back-display-idle-text">Welcome</p>
                <p className="back-display-idle-sub">Your items will appear here</p>
              </>
            )}
          </div>
        )}

        {!error && items.length > 0 && (
          <div className="back-display-cart">
            <div className="back-display-items" ref={itemsScrollRef}>
              <div className="back-display-line back-display-header-row">
                <span className="back-display-line-sl">Sl</span>
                <span className="back-display-line-name">Item Name</span>
                <span className="back-display-line-qty">Qty</span>
                <span className="back-display-line-price">Price</span>
                <span className="back-display-line-total">Amount</span>
              </div>
              {items.map((item, index) => {
                const sl = index + 1
                const qtyRaw = Number(item.quantity ?? item.QUANTITY)
                const qty = Number.isFinite(qtyRaw) ? qtyRaw : 0
                const priceRaw = Number(item.price ?? item.RATE)
                const price = Number.isFinite(priceRaw) ? priceRaw : 0
                const amount = qty * price
                const name = (item.name || item.ITEMNAME || '').trim() || `Item ${item.ITEMCODE || item.id || sl}`
                return (
                  <div key={`${item.ITEMCODE || item.id || 'item'}-${sl}-${index}`} className="back-display-line">
                    <span className="back-display-line-sl">{sl}</span>
                    <span className="back-display-line-name">{name}</span>
                    <span className="back-display-line-qty">{formatBackDisplayQty(qty)}</span>
                    <span className="back-display-line-price">{price.toFixed(2)}</span>
                    <span className="back-display-line-total">{amount.toFixed(2)}</span>
                  </div>
                )
              })}
            </div>
            <div className="back-display-total-row">
              <span className="back-display-total-label">Total</span>
              <span className="back-display-total-value">{Math.abs(total).toFixed(2)}</span>
            </div>
          </div>
        )}
      </div>

      <footer className="back-display-footer">
        <span>Counter {counterCode}</span>
        <span>{new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
      </footer>

      <button
        type="button"
        className="back-display-fs-btn"
        onClick={toggleFullscreen}
        aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
        title={isFullscreen ? 'Exit full screen' : 'Full screen'}
      >
        {isFullscreen ? (
          <svg className="back-display-fs-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"
            />
          </svg>
        ) : (
          <svg className="back-display-fs-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"
            />
          </svg>
        )}
      </button>
    </div>
  )
}

export default BackDisplay
