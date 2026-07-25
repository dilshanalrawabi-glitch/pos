import { useState, useRef, useEffect } from 'react'
import '../styles/PriceCheckModal.css'
import { useKeyboard } from '../context/KeyboardContext'
import { lookupProductByCode } from '../utils/productLookup'
import { mapApiLookupToProduct, mapLocalProductToCart } from '../utils/scanProductLookup'
import { resolveEffectivePrice, priceModeAmountLabel } from '../utils/priceMode'

export default function PriceCheckModal({ open, onClose, apiBase, products, productLookupMap, priceMode }) {
  const { setFocusedInput } = useKeyboard()
  const [barcodeInput, setBarcodeInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [product, setProduct] = useState(null)

  const barcodeInputRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => {
      if (barcodeInputRef.current) {
        barcodeInputRef.current.focus({ preventScroll: true })
      }
    }, 100)
    return () => window.clearTimeout(id)
  }, [open])

  const handleSearch = async (e) => {
    e?.preventDefault()
    const code = barcodeInput.trim()
    if (!code) return

    setLoading(true)
    setError(null)
    setProduct(null)

    let foundProduct = null

    if (productLookupMap && productLookupMap.size > 0) {
      const raw = lookupProductByCode(productLookupMap, code)
      if (raw) foundProduct = mapLocalProductToCart(raw, code)
    } else if (products && products.length > 0) {
      const raw = products.find((p) =>
        String(p.id).toLowerCase() === code.toLowerCase()
        || String(p.manufactureId).toLowerCase() === code.toLowerCase()
        || (p.alternateCodes && p.alternateCodes.some((c) => String(c).toLowerCase() === code.toLowerCase()))
      )
      if (raw) foundProduct = mapLocalProductToCart(raw, code)
    }

    if (!foundProduct && apiBase) {
      try {
        const res = await fetch(`${apiBase}/api/products/lookup?code=${encodeURIComponent(code)}`)
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.found !== false && (data.ITEMCODE != null || data.itemcode != null)) {
          foundProduct = mapApiLookupToProduct(data)
        }
      } catch (err) {
        console.error('API Lookup error:', err)
      }
    }

    if (foundProduct) {
      setProduct({
        ...foundProduct,
        displayPrice: resolveEffectivePrice(foundProduct, priceMode),
      })
      setBarcodeInput('')
    } else {
      setError(`Item "${code}" not found.`)
    }
    setLoading(false)

    setTimeout(() => {
      if (barcodeInputRef.current) {
        barcodeInputRef.current.focus({ preventScroll: true })
      }
    }, 50)
  }

  const handleClose = () => {
    setBarcodeInput('')
    setError(null)
    setProduct(null)
    onClose()
  }

  if (!open) return null

  const handleInputClick = (e) => {
    setFocusedInput(e.currentTarget)
  }

  const priceLabel = priceModeAmountLabel(priceMode)

  return (
    <div className="price-check-overlay" onClick={handleClose}>
      <div className="price-check-modal" onClick={(e) => e.stopPropagation()}>
        <div className="price-check-header">
          <h3>Price Check</h3>
          <button type="button" className="price-check-close" onClick={handleClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="price-check-body">
          <form className="price-check-form" onSubmit={handleSearch} autoComplete="off">
            <label htmlFor="price-check-barcode" className="price-check-label">
              Scan Barcode / Enter Code
            </label>
            <input
              ref={barcodeInputRef}
              id="price-check-barcode"
              name="price-check-barcode"
              type="text"
              placeholder="Scan barcode or type code..."
              value={barcodeInput}
              onChange={(e) => {
                setBarcodeInput(e.target.value)
                setError(null)
              }}
              onClick={handleInputClick}
              className="price-check-input"
              autoComplete="off"
              spellCheck={false}
              data-no-osk="true"
              disabled={loading}
            />
          </form>

          {product && (
            <div className="price-check-result-simple">
              <div className="price-check-simple-row">
                <span className="price-check-simple-label">Product</span>
                <span className="price-check-simple-val">{product.name}</span>
              </div>
              <div className="price-check-simple-row">
                <span className="price-check-simple-label">Item ID</span>
                <span className="price-check-simple-val">{product.id}</span>
              </div>
              <div className="price-check-simple-row price-check-simple-price-row">
                <span className="price-check-simple-label">{priceLabel}</span>
                <span className="price-check-simple-price">
                  QAR {(product.displayPrice ?? product.price ?? 0).toFixed(2)}
                </span>
              </div>
              <div className="price-check-ready-simple">
                Ready for next scan
              </div>
            </div>
          )}

          {error && (
            <div className="price-check-error-simple">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
