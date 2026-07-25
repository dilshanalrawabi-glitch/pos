import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import '../styles/ProductDisplay.css'
import { buildProductLookupMap, lookupProductByCode } from '../utils/productLookup'
import {
  isWeightedVegetableBarcode,
  shouldBackgroundEnrichLocalProduct,
  mapLocalProductToCart,
  fetchProductLookup,
} from '../utils/scanProductLookup'

const POS_BUTTONS = [
  { id: 'sales-return', label: 'Sales Return', desc: 'Sales return' },
  { id: 'hold', label: 'Hold', desc: 'Hold bill' },
  { id: 'hold-retrieve', label: 'Hold Retrieve', desc: 'Release held bill' },
  { id: 'pay', label: 'Pay', desc: 'Proceed to payment' },
]

function ProductDisplay({ products, productLookupMap: productLookupMapProp, onAddToCart, onMergeCartLine, cartItems, onPosAction, onHold, onHoldRetrieve, apiBase }) {
  const [scanCode, setScanCode] = useState('')
  const lookupMap = useMemo(
    () => (productLookupMapProp && productLookupMapProp.size > 0
      ? productLookupMapProp
      : buildProductLookupMap(products)),
    [productLookupMapProp, products]
  )
  const lookupMapRef = useRef(lookupMap)
  lookupMapRef.current = lookupMap
  const scanQueueRef = useRef([])
  const scanProcessingRef = useRef(false)
  const [scanMsg, setScanMsg] = useState(null)
  const [scanFieldEditable, setScanFieldEditable] = useState(false)
  const scanInputRef = useRef(null)

  useEffect(() => {
    if (!scanMsg) return
    const t = setTimeout(() => setScanMsg(null), 2000)
    return () => clearTimeout(t)
  }, [scanMsg])

  const runBackgroundEnrich = useCallback((code) => {
    if (!apiBase) return
    fetchProductLookup(apiBase, code)
      .then((enriched) => {
        if (enriched) onMergeCartLine?.(enriched)
      })
      .catch(() => {})
  }, [apiBase, onMergeCartLine])

  const processServerScan = useCallback(async (code) => {
    if (!apiBase) {
      setScanMsg(`Not found – Barcode: ${code}`)
      return
    }
    try {
      const product = await fetchProductLookup(apiBase, code)
      if (product) {
        onAddToCart(product)
        setScanMsg(`Added: ${product.name} (Barcode: ${code})`)
      } else {
        setScanMsg(`Not found – Barcode: ${code}`)
      }
    } catch (err) {
      console.error('Lookup error:', err)
      setScanMsg(`Not found – Barcode: ${code}`)
    }
  }, [apiBase, onAddToCart])

  const drainScanQueue = useCallback(async () => {
    if (scanProcessingRef.current) return
    scanProcessingRef.current = true
    try {
      while (scanQueueRef.current.length > 0) {
        const code = scanQueueRef.current.shift()
        await processServerScan(code)
      }
    } finally {
      scanProcessingRef.current = false
      scanInputRef.current?.focus()
    }
  }, [processServerScan])

  const handleScanCode = useCallback((code) => {
    const trimmed = String(code ?? '').trim()
    if (!trimmed) return

    if (isWeightedVegetableBarcode(trimmed)) {
      scanQueueRef.current.push(trimmed)
      void drainScanQueue()
      return
    }

    const localRaw = lookupProductByCode(lookupMapRef.current, trimmed)
    if (localRaw) {
      const product = mapLocalProductToCart(localRaw, trimmed)
      onAddToCart(product)
      setScanMsg(`Added: ${product.name} (Barcode: ${trimmed})`)
      if (shouldBackgroundEnrichLocalProduct(localRaw, trimmed)) {
        runBackgroundEnrich(trimmed)
      }
      scanInputRef.current?.focus()
      return
    }

    scanQueueRef.current.push(trimmed)
    void drainScanQueue()
  }, [onAddToCart, drainScanQueue, runBackgroundEnrich])

  const handleScanSubmit = (e) => {
    e.preventDefault()
    const code = (scanCode || '').toString().trim()
    setScanCode('')
    if (!code) return
    handleScanCode(code)
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
    else if (id === 'sales-return') alert('Sales Return – process sales return')
    else if (id === 'pay') alert('Pay – proceed to payment')
  }

  return (
    <div className="product-display">
      <div className="search-scanner-bar">
        <form className="scan-form" onSubmit={handleScanSubmit} autoComplete="off">
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
            spellCheck={false}
            readOnly={!scanFieldEditable}
            onFocus={() => setScanFieldEditable(true)}
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
            disabled={btn.id === 'hold' && !cartItems?.length}
          >
            <span className="pos-action-label">{btn.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export default ProductDisplay
