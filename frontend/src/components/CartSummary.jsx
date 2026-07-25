import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, memo } from 'react'
import '../styles/CartSummary.css'
import { useKeyboard } from '../context/KeyboardContext'
import cartIcon from '../assets/cart-icon.png'
import { buildProductLookupMap, lookupProductByCode } from '../utils/productLookup'
import {
  isWeightedVegetableBarcode,
  cartItemHasFullDetails,
  shouldBackgroundEnrichLocalProduct,
  mapLocalProductToCart,
  mapApiLookupToProduct,
  fetchProductLookup,
  detailsCacheFromProduct,
} from '../utils/scanProductLookup'
import { getItemId, resolveManufactureId } from '../utils/cartItemUtils'
import CalculatorModal from './CalculatorModal'

function getCustomerPoints(c) {
  if (!c) return 0
  const p = c.POINTS ?? c.points ?? c.LOYALTY_POINTS ?? c.loyalty_points ?? c.TOTALPOINTS ?? c.totalpoints
  const n = typeof p === 'number' ? p : parseInt(p, 10) || 0
  return Math.max(0, n)
}

function getCustomerCurrentCredit(c) {
  if (!c) return 0
  const v = c.CURRENTCREDITAMOUNT ?? c.currentcreditamount
  return typeof v === 'number' ? v : parseFloat(v) || 0
}

function formatNum(v) {
  if (v === undefined || v === null || v === '') return '—'
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isNaN(n) ? '—' : n.toFixed(2)
}

function formatQty(v) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n.toFixed(3) : '—'
}

function getPointForItem(item, cached, productByManuf) {
  const discount = Number(item.discount) || 0
  const lineTotal = Math.max(0, Math.abs(item.price * item.quantity) - discount)
  const prevAmount = item.prevAmount ?? item.PREVAMOUNT ?? item.prevamount ?? productByManuf?.PREVAMOUNT ?? productByManuf?.prevAmount ?? productByManuf?.prevamount ?? cached?.prevAmount
  const prevNum = prevAmount != null && prevAmount !== '' ? Number(prevAmount) : NaN
  const lineTotalNum = Number(lineTotal)
  const point = (Number.isFinite(prevNum) && prevNum > 0 && Number.isFinite(lineTotalNum))
    ? lineTotalNum / prevNum
    : (item.point ?? item.POINT ?? item.points ?? item.POINTS)
  const p = (point != null && point !== '') ? (typeof point === 'number' ? point : parseFloat(point)) : 0
  return Number.isFinite(p) ? p : 0
}

function buildRowModel(item, itemDetailsCache, lookupMap) {
  const id = getItemId(item)
  const isVoid = !!item.void
  const barcode = resolveManufactureId(item)
  const cacheKey = barcode || String(item.ITEMCODE ?? item.id ?? '').trim()
  const cached = itemDetailsCache[cacheKey]
  const productByManuf = lookupProductByCode(lookupMap, barcode || id || item.id)
  const uom = item.uom ?? item.UOM ?? item.unit ?? cached?.uom ?? productByManuf?.uom ?? '—'
  const discount = Number(item.discount) || 0
  const lineTotal = Math.max(0, Math.abs(item.price * item.quantity) - discount)
  const pointDisplay = getPointForItem(item, cached, productByManuf)
  const baseFactor = item.conversionFactor ?? item.CONVERSIONFACTOR ?? item.factor ?? item.Factor ?? productByManuf?.conversionFactor ?? productByManuf?.CONVERSIONFACTOR ?? productByManuf?.factor ?? productByManuf?.Factor ?? cached?.conversionFactor ?? 1
  const factor = Number(baseFactor) * Number(item.quantity)
  const costprice = item.costPrice ?? item.COSTPRICE ?? item.costprice ?? productByManuf?.COSTPRICE ?? productByManuf?.costPrice ?? cached?.costPrice
  const costpriceNum = costprice != null ? (Number(costprice) * Number(factor) * Number(item.quantity)) : null
  const store = item.store ?? item.STORE ?? item.locationCode ?? item.LOCATIONCODE ?? productByManuf?.STORE ?? productByManuf?.store ?? cached?.store
  const avgcost = item.avgcost ?? item.AVGCOST ?? item.avgCost ?? item.AVERAGECOST ?? item.averagecost ?? productByManuf?.AVERAGECOST ?? productByManuf?.avgCost ?? productByManuf?.averagecost ?? cached?.avgCost
  const avgcostNum = avgcost != null ? (Number(avgcost) * Number(factor) * Number(item.quantity)) : null
  const storeDisplay = store !== undefined && store !== null && store !== '' ? String(store).replace(/\s+/g, '') : 'STORE1'

  return {
    id,
    isVoid,
    name: item.name,
    barcode: barcode || '—',
    barcodeTitle: barcode,
    uom,
    qtyDisplay: formatQty(item.quantity),
    priceDisplay: item.price.toFixed(2),
    discountDisplay: discount.toFixed(2),
    amountDisplay: lineTotal.toFixed(2),
    pointDisplay: typeof pointDisplay === 'number' && Number.isFinite(pointDisplay) ? pointDisplay.toFixed(3) : '0.000',
    factorDisplay: formatNum(factor),
    costpriceDisplay: formatNum(costpriceNum != null ? costpriceNum : costprice),
    storeDisplay,
    storeTitle: store,
    avgcostDisplay: formatNum(avgcostNum != null ? avgcostNum : avgcost),
  }
}

function rowModelSignature(item, itemDetailsCache) {
  const id = getItemId(item)
  const cacheKey = String(item.manufactureId ?? item.MANUFACTURERID ?? id ?? item.ITEMCODE ?? '').trim()
  const cached = itemDetailsCache[cacheKey]
  return [
    id,
    item.quantity,
    item.price,
    item.discount,
    item.void,
    item.name,
    cached?.costPrice,
    cached?.avgCost,
    cached?.conversionFactor,
    cached?.uom,
    cached?.store,
    cached?.prevAmount,
  ].join('|')
}

const CartItemRow = memo(function CartItemRow({ row, serialNo, isSelected, onSelectById }) {
  const handleClick = useCallback(() => {
    if (!row.isVoid) onSelectById(row.id)
  }, [row.id, row.isVoid, onSelectById])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!row.isVoid) onSelectById(row.id)
    }
  }, [row.id, row.isVoid, onSelectById])

  return (
    <div
      role="button"
      tabIndex={0}
      className={`cart-item-row ${isSelected ? 'cart-item-row-selected' : ''} ${row.isVoid ? 'cart-item-row-void' : ''}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-pressed={isSelected}
      aria-label={row.isVoid ? `${row.name} (void)` : row.name}
    >
      <span className="cart-td cart-td-sl">{serialNo}</span>
      <span className="cart-td cart-td-barcode" title={row.barcodeTitle}>{row.barcode}</span>
      <span className="cart-td cart-td-name" title={row.name}>
        {row.name}
        {row.isVoid && <span className="cart-item-void-badge">VOID</span>}
      </span>
      <span className="cart-td cart-td-uom">{row.uom}</span>
      <span className="cart-td cart-td-qty">{row.qtyDisplay}</span>
      <span className="cart-td cart-td-price">{row.priceDisplay}</span>
      <span className="cart-td cart-td-discount">{row.discountDisplay}</span>
      <span className="cart-td cart-td-amount">{row.amountDisplay}</span>
      <span className="cart-td cart-td-point">{row.pointDisplay}</span>
      <span className="cart-td cart-td-factor">{row.factorDisplay}</span>
      <span className="cart-td cart-td-costprice">{row.costpriceDisplay}</span>
      <span className="cart-td cart-td-store" title={row.storeTitle}>{row.storeDisplay}</span>
      <span className="cart-td cart-td-avgcost">{row.avgcostDisplay}</span>
    </div>
  )
})

function CartSummary({
  cartItems,
  onUpdateQuantity,
  onRemove,
  onCheckout,
  checkoutLoading = false,
  billNo,
  products = [],
  productLookupMap: productLookupMapProp,
  onAddToCart,
  onMergeCartLine,
  apiBase,
  selectedItemId,
  onSelectItem,
  balanceCustomer,
  /** Ref-only snapshot for payment (no App re-render). */
  onCartPointsSnapshotChange,
  onItemDetailsCacheChange,
  isSalesReturn = false,
  orderNo = '',
  productsReady = true,
  itemDetailsCacheResetKey = 0,
}) {
  const [scanCode, setScanCode] = useState('')
  const [scanMsg, setScanMsg] = useState(null)
  const [fetchedBalancePoints, setFetchedBalancePoints] = useState(null)
  const [fetchedBalanceCredit, setFetchedBalanceCredit] = useState(null)
  const [itemDetailsCache, setItemDetailsCache] = useState({})
  const [showNotFoundModal, setShowNotFoundModal] = useState(false)
  const [showCalculator, setShowCalculator] = useState(false)
  const [notFoundBarcode, setNotFoundBarcode] = useState('')
  const scanInputRef = useRef(null)
  const prevIsSalesReturnRef = useRef(isSalesReturn)
  const cartItemsListRef = useRef(null)
  const cartScrollPrevRef = useRef({ len: 0, sig: '' })
  const fetchingCodesRef = useRef(new Set())
  const scanQueueRef = useRef([])
  const scanProcessingRef = useRef(false)
  const rowModelCacheRef = useRef(new Map())
  const onSelectItemRef = useRef(onSelectItem)
  const onCartPointsSnapshotChangeRef = useRef(onCartPointsSnapshotChange)
  const cartItemsRef = useRef(cartItems)
  const { toggleKeyboardForInput } = useKeyboard()

  onSelectItemRef.current = onSelectItem
  onCartPointsSnapshotChangeRef.current = onCartPointsSnapshotChange
  cartItemsRef.current = cartItems

  useEffect(() => {
    setItemDetailsCache({})
    rowModelCacheRef.current.clear()
    fetchingCodesRef.current.clear()
  }, [itemDetailsCacheResetKey])

  const lookupMap = useMemo(
    () => (productLookupMapProp && productLookupMapProp.size > 0
      ? productLookupMapProp
      : buildProductLookupMap(products)),
    [productLookupMapProp, products]
  )
  const lookupMapRef = useRef(lookupMap)
  lookupMapRef.current = lookupMap

  const activeItems = useMemo(
    () => (Array.isArray(cartItems) ? cartItems.filter((item) => !item.void) : []),
    [cartItems]
  )

  const total = useMemo(
    () => activeItems.reduce((sum, item) => sum + (item.price * item.quantity), 0),
    [activeItems]
  )
  const totalDisplay = Math.abs(total)

  const { totalPoints, linePointsByItemId } = useMemo(() => {
    const linePointsByItemIdInner = {}
    let sum = 0
    for (const item of activeItems) {
      const cacheKey = String(item.manufactureId ?? item.MANUFACTURERID ?? item.id ?? item.ITEMCODE ?? '').trim()
      const cached = itemDetailsCache[cacheKey]
      const lookupCode = item.manufactureId ?? item.MANUFACTURERID ?? item.id ?? item.ITEMCODE
      const productByManuf = lookupProductByCode(lookupMap, lookupCode)
      const pt = getPointForItem(item, cached, productByManuf)
      linePointsByItemIdInner[getItemId(item)] = pt
      sum += pt
    }
    return { totalPoints: sum, linePointsByItemId: linePointsByItemIdInner }
  }, [activeItems, itemDetailsCache, lookupMap])

  useEffect(() => {
    onCartPointsSnapshotChangeRef.current?.({ totalPoints, linePointsByItemId })
  }, [totalPoints, linePointsByItemId])

  useEffect(() => {
    onItemDetailsCacheChange?.(itemDetailsCache)
  }, [itemDetailsCache, onItemDetailsCacheChange])

  const rowModels = useMemo(() => {
    const cache = rowModelCacheRef.current
    const usedIds = new Set()
    const rows = []

    for (let index = 0; index < cartItems.length; index += 1) {
      const item = cartItems[index]
      const id = getItemId(item)
      usedIds.add(id)
      const sig = rowModelSignature(item, itemDetailsCache)
      const cached = cache.get(id)
      if (cached && cached.sig === sig) {
        rows.push(cached.row)
      } else {
        const row = buildRowModel(item, itemDetailsCache, lookupMap)
        cache.set(id, { sig, row })
        rows.push(row)
      }
    }

    for (const id of cache.keys()) {
      if (!usedIds.has(id)) cache.delete(id)
    }

    return rows
  }, [cartItems, itemDetailsCache, lookupMap])

  const handleSelectById = useCallback((id) => {
    const item = cartItemsRef.current.find((i) => getItemId(i) === id)
    if (item && !item.void) onSelectItemRef.current?.(item)
  }, [])

  useEffect(() => {
    if (!balanceCustomer || !apiBase) {
      setFetchedBalancePoints(null)
      setFetchedBalanceCredit(null)
      return
    }
    const code = balanceCustomer.CUSTOMERCODE ?? balanceCustomer.customercode ?? ''
    if (!code) {
      setFetchedBalancePoints(getCustomerPoints(balanceCustomer))
      setFetchedBalanceCredit(getCustomerCurrentCredit(balanceCustomer))
      return
    }
    let cancelled = false
    fetch(`${apiBase}/api/customers/balance?customerCode=${encodeURIComponent(code)}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data) {
          const p = data.points ?? data.POINTS ?? data.totalpoints ?? data.TOTALPOINTS
          const ptNum = typeof p === 'number' ? p : parseInt(p, 10)
          setFetchedBalancePoints(Number.isNaN(ptNum) ? 0 : Math.max(0, ptNum || 0))
          const cred = data.currentCreditAmount ?? data.CURRENTCREDITAMOUNT
          const credNum = typeof cred === 'number' ? cred : parseFloat(cred)
          setFetchedBalanceCredit(Number.isNaN(credNum) ? 0 : (credNum ?? 0))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFetchedBalancePoints(getCustomerPoints(balanceCustomer))
          setFetchedBalanceCredit(getCustomerCurrentCredit(balanceCustomer))
        }
      })
    return () => { cancelled = true }
  }, [balanceCustomer, apiBase])

  useEffect(() => {
    if (!scanMsg) return
    const t = setTimeout(() => setScanMsg(null), 2500)
    return () => clearTimeout(t)
  }, [scanMsg])

  useEffect(() => {
    if (!showNotFoundModal) return
    const handleKeyDown = (e) => {
      if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') {
        e.preventDefault()
        setShowNotFoundModal(false)
        scanInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showNotFoundModal])

  useLayoutEffect(() => {
    scanInputRef.current?.focus({ preventScroll: true })
  }, [])

  useLayoutEffect(() => {
    const was = prevIsSalesReturnRef.current
    prevIsSalesReturnRef.current = isSalesReturn
    if (!isSalesReturn || was) return
    let cancelled = false
    const run = () => {
      if (!cancelled) scanInputRef.current?.focus({ preventScroll: true })
    }
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(run)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(id)
    }
  }, [isSalesReturn])

  useEffect(() => {
    const len = cartItems.length
    const last = len ? cartItems[len - 1] : null
    const sig = last ? `${getItemId(last)}:${last.quantity}:${!!last.void}` : ''
    const prev = cartScrollPrevRef.current
    const grew = len > prev.len
    const lastLineUpdated = len > 5 && len === prev.len && sig !== prev.sig && prev.len > 0
    cartScrollPrevRef.current = { len, sig }

    if (len <= 5) return
    if (!grew && !lastLineUpdated) return
    if (grew && prev.len === 0) return

    const id = requestAnimationFrame(() => {
      const listEl = cartItemsListRef.current
      const lastRow = listEl?.querySelector('.cart-item-row:last-of-type')
      if (lastRow) {
        lastRow.scrollIntoView({ behavior: 'auto', block: 'nearest' })
      } else if (listEl) {
        listEl.scrollTop = listEl.scrollHeight
      }
    })
    return () => cancelAnimationFrame(id)
  }, [cartItems])

  const missingDetailCodesSig = useMemo(() => {
    if (!Array.isArray(cartItems) || cartItems.length === 0) return ''
    const keys = []
    for (const item of cartItems) {
      const code = String(item.manufactureId ?? item.MANUFACTURERID ?? item.id ?? item.ITEMCODE ?? '').trim()
      if (!code) continue
      if (cartItemHasFullDetails(item)) continue
      const fromMap = lookupProductByCode(lookupMap, code)
      if (fromMap && cartItemHasFullDetails(mapLocalProductToCart(fromMap, code))) continue
      keys.push(code)
    }
    return [...new Set(keys)].sort().join('|')
  }, [cartItems, lookupMap])

  useEffect(() => {
    if (!cartItems?.length) return
    const cacheUpdates = {}
    for (const item of cartItems) {
      const code = String(item.manufactureId ?? item.MANUFACTURERID ?? item.id ?? item.ITEMCODE ?? '').trim()
      if (!code || cartItemHasFullDetails(item)) continue
      const fromMap = lookupProductByCode(lookupMap, code)
      if (!fromMap) continue
      const mapped = mapLocalProductToCart(fromMap, code)
      const entry = detailsCacheFromProduct(mapped)
      if (entry) cacheUpdates[code] = entry
    }
    if (Object.keys(cacheUpdates).length > 0) {
      setItemDetailsCache((prev) => {
        let next = prev
        for (const [code, entry] of Object.entries(cacheUpdates)) {
          next = { ...next, [code]: { ...next[code], ...entry } }
        }
        return next
      })
    }
  }, [cartItems, lookupMap])

  useEffect(() => {
    if (!apiBase || !missingDetailCodesSig || !cartItems?.length) return
    const codesToFetch = []
    for (const item of cartItems) {
      const code = String(item.manufactureId ?? item.MANUFACTURERID ?? item.id ?? item.ITEMCODE ?? '').trim()
      if (!code) continue
      if (cartItemHasFullDetails(item)) continue
      const fromMap = lookupProductByCode(lookupMap, code)
      if (fromMap && cartItemHasFullDetails(mapLocalProductToCart(fromMap, code))) continue
      if (!fetchingCodesRef.current.has(code)) codesToFetch.push(code)
    }
    if (codesToFetch.length === 0) return
    let cancelled = false
    codesToFetch.forEach((code) => {
      fetchingCodesRef.current.add(code)
      fetch(`${apiBase}/api/products/lookup?code=${encodeURIComponent(code)}`)
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return
          const product = mapApiLookupToProduct(data)
          if (!product) return
          onMergeCartLine?.(product)
          const cacheEntry = detailsCacheFromProduct(product)
          if (cacheEntry) {
            setItemDetailsCache((prev) => ({
              ...prev,
              [code]: { ...prev[code], ...cacheEntry },
            }))
          }
        })
        .catch(() => {})
        .finally(() => {
          fetchingCodesRef.current.delete(code)
        })
    })
    return () => { cancelled = true }
  }, [apiBase, missingDetailCodesSig, cartItems, lookupMap, onMergeCartLine])

  const runBackgroundEnrich = useCallback((code) => {
    if (!apiBase) return
    fetchProductLookup(apiBase, code)
      .then((enriched) => {
        if (!enriched) return
        onMergeCartLine?.(enriched)
        const cacheEntry = detailsCacheFromProduct(enriched)
        if (cacheEntry) {
          const cacheKey = String(enriched.manufactureId ?? code).trim()
          setItemDetailsCache((prev) => ({
            ...prev,
            [cacheKey]: { ...prev[cacheKey], ...cacheEntry },
          }))
        }
      })
      .catch(() => {})
  }, [apiBase, onMergeCartLine])

  const processServerScan = useCallback(async (code) => {
    if (!apiBase) {
      setNotFoundBarcode(code)
      setShowNotFoundModal(true)
      return
    }
    try {
      const product = await fetchProductLookup(apiBase, code)
      if (product) {
        onAddToCart?.(product)
        setScanMsg(`Added: ${product.name}`)
      } else {
        setNotFoundBarcode(code)
        setShowNotFoundModal(true)
      }
    } catch (err) {
      console.warn('Lookup error:', err)
      setNotFoundBarcode(code)
      setShowNotFoundModal(true)
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
      onAddToCart?.(product)
      setScanMsg(`Added: ${product.name}`)
      const cacheEntry = detailsCacheFromProduct(product)
      if (cacheEntry) {
        const cacheKey = String(product.manufactureId ?? trimmed).trim()
        setItemDetailsCache((prev) => ({
          ...prev,
          [cacheKey]: { ...prev[cacheKey], ...cacheEntry },
        }))
      }
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
  }

  const selectedIdStr = selectedItemId != null ? String(selectedItemId) : null

  return (
    <div className="cart-summary">
      <div className="cart-header">
        <div className="cart-header-title-row">
          {billNo != null && !Number.isNaN(Number(billNo)) && Number(billNo) >= 1 && (
            <span className="cart-bill-no">Bill # {billNo}</span>
          )}
          {orderNo != null && orderNo !== '' && orderNo !== 0 && (
            <span className="cart-order-no">Order # {orderNo}</span>
          )}
          <h2 className="cart-title">Shopping Cart</h2>
        </div>
        <div className="cart-header-actions">
          {balanceCustomer != null && (
            <>
              <div className="cart-header-points">
                <span className="cart-header-points-label">Points</span>
                <span className="cart-header-points-value">
                  {(() => {
                    const p = fetchedBalancePoints !== null && fetchedBalancePoints !== undefined
                      ? fetchedBalancePoints
                      : getCustomerPoints(balanceCustomer)
                    return typeof p === 'number' && !Number.isNaN(p) ? p : 0
                  })()}
                </span>
              </div>
              <div className="cart-header-points cart-header-credit">
                <span className="cart-header-points-label">Credit</span>
                <span className="cart-header-points-value">
                  {(() => {
                    const c = fetchedBalanceCredit !== null && fetchedBalanceCredit !== undefined
                      ? fetchedBalanceCredit
                      : getCustomerCurrentCredit(balanceCustomer)
                    const num = typeof c === 'number' && !Number.isNaN(c) ? c : parseFloat(c)
                    return Number.isNaN(num) ? 0 : (num ?? 0)
                  })()}
                </span>
              </div>
            </>
          )}
          <button
            type="button"
            className="cart-header-calc-btn"
            onClick={() => setShowCalculator(true)}
            aria-label="Open calculator"
            title="Calculator"
          >
            <svg className="cart-header-calc-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="4" y="2" width="16" height="20" rx="2" stroke="currentColor" strokeWidth="1.75" />
              <rect x="7" y="5" width="10" height="4" rx="1" fill="currentColor" opacity="0.35" />
              <circle cx="8" cy="13" r="1.25" fill="currentColor" />
              <circle cx="12" cy="13" r="1.25" fill="currentColor" />
              <circle cx="16" cy="13" r="1.25" fill="currentColor" />
              <circle cx="8" cy="17" r="1.25" fill="currentColor" />
              <circle cx="12" cy="17" r="1.25" fill="currentColor" />
              <circle cx="16" cy="17" r="1.25" fill="currentColor" />
            </svg>
          </button>
        </div>
      </div>

      <div className="cart-scan-block">
        <form className="cart-scan-form" onSubmit={handleScanSubmit} autoComplete="off">
          <div className="cart-scan-row">
            <input
              ref={scanInputRef}
              type="text"
              name="cartScan"
              placeholder="Barcode or code"
              value={scanCode}
              onChange={(e) => setScanCode(e.target.value)}
              className="cart-scan-input"
              autoComplete="off"
              spellCheck={false}
              data-no-osk="true"
              aria-busy={!productsReady}
            />
            <button
              type="button"
              className="cart-scan-btn"
              data-keyboard-toggle="true"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggleKeyboardForInput(scanInputRef.current)}
              aria-label="Toggle on-screen keyboard"
            >
              Keyboard
            </button>
          </div>
          {!productsReady && (
            <span className="cart-scan-msg cart-scan-msg-loading">
              Loading catalog — using server lookup until ready
            </span>
          )}
          {scanMsg && <span className="cart-scan-msg">{scanMsg}</span>}
        </form>
      </div>

      <div className="cart-items">
        {cartItems.length === 0 ? (
          <div className="empty-state">
            <img src={cartIcon} alt="" className="empty-state-icon" />
            <p>Your cart is empty</p>
          </div>
        ) : (
          <div className="cart-items-scroll-wrap">
            <div className="cart-items-table">
              <div className="cart-items-header">
                <span className="cart-th cart-th-sl">Sl</span>
                <span className="cart-th cart-th-barcode">Barcode</span>
                <span className="cart-th cart-th-name">Item Name</span>
                <span className="cart-th cart-th-uom">UOM</span>
                <span className="cart-th cart-th-qty">Qty</span>
                <span className="cart-th cart-th-price">Price</span>
                <span className="cart-th cart-th-discount">Discount</span>
                <span className="cart-th cart-th-amount">Amount</span>
                <span className="cart-th cart-th-point">Point</span>
                <span className="cart-th cart-th-factor">Factor</span>
                <span className="cart-th cart-th-costprice">Cost Price</span>
                <span className="cart-th cart-th-store">Store</span>
                <span className="cart-th cart-th-avgcost">Avg Cost</span>
              </div>
              <div className="cart-items-list" ref={cartItemsListRef}>
                {rowModels.map((row, index) => (
                  <CartItemRow
                    key={row.id}
                    row={row}
                    serialNo={index + 1}
                    isSelected={selectedIdStr != null && selectedIdStr === String(row.id)}
                    onSelectById={handleSelectById}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {cartItems.length > 0 && (
        <div className="cart-footer">
          <div className="summary-row">
            <span>Point:</span>
            <span>{Number.isFinite(totalPoints) ? totalPoints.toFixed(3) : '0.000'}</span>
          </div>
          <div className="summary-row">
            <span>Subtotal:</span>
            <span>QAR {totalDisplay.toFixed(2)}</span>
          </div>
          <div className="summary-row total">
            <span>Total:</span>
            <span>QAR {(totalDisplay).toFixed(2)}</span>
          </div>
          <button
            type="button"
            className="checkout-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onCheckout}
            disabled={checkoutLoading}
          >
            {checkoutLoading ? <span className="cart-checkout-loader" aria-hidden="true" /> : 'Checkout'}
          </button>
        </div>
      )}

      <CalculatorModal
        open={showCalculator}
        onClose={() => {
          setShowCalculator(false)
          scanInputRef.current?.focus()
        }}
      />

      {showNotFoundModal && (
        <div className="not-found-modal-overlay" onClick={() => {
          setShowNotFoundModal(false)
          scanInputRef.current?.focus()
        }}>
          <div className="not-found-modal" onClick={(e) => e.stopPropagation()}>
            <div className="not-found-icon" aria-hidden="true">🔍</div>
            <h3>Item Not Found</h3>
            <p>The barcode or item code does not match any product:<strong>{notFoundBarcode}</strong></p>
            <button
              type="button"
              className="not-found-close-btn"
              onClick={() => {
                setShowNotFoundModal(false)
                scanInputRef.current?.focus()
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default CartSummary
