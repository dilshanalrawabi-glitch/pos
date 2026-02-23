import { useState, useEffect, useRef } from 'react'
import '../styles/ProductDisplay.css'

const POS_BUTTONS = [
  { id: 'member', label: 'Member', desc: 'Customer points' },
  { id: 'hold', label: 'Hold', desc: 'Hold bill' },
  { id: 'hold-retrieve', label: 'Hold Retrieve', desc: 'Release held bill' },
  { id: 'discount', label: 'Discount', desc: 'Apply discount' },
  { id: 'pay', label: 'Pay', desc: 'Proceed to payment' },
]

function mapLookupToProduct(p) {
  return {
    id: p.ITEMCODE,
    name: p.ITEMNAME,
    price: parseFloat(p.RETAILPRICE) || 0,
    category: p.CATEGORYCODE,
    image: '📦',
    manufactureId: (p.MANUFACTUREID ?? p.manufactureid ?? p.ITEMCODE ?? '').toString().trim(),
    uom: (p.BASEUOM ?? p.baseuom ?? '').toString().trim() || undefined,
  }
}

function ProductDisplay({ products, onAddToCart, cartItems, onPosAction, onHold, onHoldRetrieve, hasHeldCart, apiBase }) {
  const [scanCode, setScanCode] = useState('')
  const [scanMsg, setScanMsg] = useState(null)
  const scanInputRef = useRef(null)

  useEffect(() => {
    if (!scanMsg) return
    const t = setTimeout(() => setScanMsg(null), 2000)
    return () => clearTimeout(t)
  }, [scanMsg])

  const handleScanSubmit = async (e) => {
    e.preventDefault()
    const code = (scanCode || '').toString().trim()
    setScanCode('')
    if (!code) return
    let product = null
    if (apiBase) {
      try {
        const res = await fetch(`${apiBase}/api/products/lookup?code=${encodeURIComponent(code)}`)
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.found !== false && (data.ITEMCODE != null || data.itemcode != null)) {
          product = mapLookupToProduct(data)
        }
      } catch (err) {
        console.error('Lookup error:', err)
      }
    }
    if (!product) {
      product = products.find(
        (p) =>
          String(p.manufactureId ?? '').trim() === code ||
          String(p.id ?? '').trim() === code ||
          (Array.isArray(p.alternateCodes) && p.alternateCodes.some((alt) => String(alt ?? '').trim() === code))
      )
    }
    if (product) {
      onAddToCart(product)
      setScanMsg(`Added: ${product.name} (Barcode: ${code})`)
    } else {
      setScanMsg(`Not found – Barcode: ${code}`)
    }
    scanInputRef.current?.focus()
  }

  const handlePosAction = (id) => {
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
    if (onPosAction) onPosAction(id)
    else if (id === 'member') alert('Member – select customer for points')
    else if (id === 'discount') alert('Discount – apply discount')
    else if (id === 'pay') alert('Pay – proceed to payment')
  }

  return (
    <div className="product-display">
      <div className="search-scanner-bar">
        <form className="scan-form" onSubmit={handleScanSubmit}>
          <label htmlFor="scan-barcode" className="scan-label">Scan barcode / Enter code</label>
          <input
            id="scan-barcode"
            ref={scanInputRef}
            type="text"
            placeholder="Scan barcode or enter code number..."
            value={scanCode}
            onChange={(e) => setScanCode(e.target.value)}
            className="scan-input"
            autoComplete="off"
          />
          {scanMsg && <span className="scan-msg">{scanMsg}</span>}
        </form>
      </div>

      <div className="pos-actions">
        {POS_BUTTONS.map(btn => (
          <button
            key={btn.id}
            type="button"
            className="pos-action-btn"
            onClick={() => handlePosAction(btn.id)}
            title={btn.desc}
            disabled={(btn.id === 'hold' && !cartItems?.length) || (btn.id === 'hold-retrieve' && !hasHeldCart)}
          >
            <span className="pos-action-label">{btn.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export default ProductDisplay
