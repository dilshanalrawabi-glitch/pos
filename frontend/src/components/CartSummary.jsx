import { useState, useRef, useEffect } from 'react'
import '../styles/CartSummary.css'
import { useKeyboard } from '../context/KeyboardContext'
import cartIcon from '../assets/cart-icon.png'

function getItemId(item) {
  return item?.id ?? item?.ITEMCODE ?? item?.itemCode ?? ''
}

function getCustomerPoints(c) {
  if (!c) return 0
  const p = c.POINTS ?? c.points ?? c.LOYALTY_POINTS ?? c.loyalty_points
  return typeof p === 'number' ? p : parseInt(p, 10) || 0
}

function getCustomerCurrentCredit(c) {
  if (!c) return 0
  const v = c.CURRENTCREDITAMOUNT ?? c.currentcreditamount
  return typeof v === 'number' ? v : parseFloat(v) || 0
}

function CartSummary({
  cartItems,
  onUpdateQuantity,
  onRemove,
  onClear,
  onCheckout,
  billNo,
  products = [],
  onAddToCart,
  apiBase,
  selectedItemId,
  onSelectItem,
  selectedCustomer,
  onTotalPointsChange,
  onLinePointsChange,
}) {
  const [scanCode, setScanCode] = useState('')
  const [scanMsg, setScanMsg] = useState(null)
  const [fetchedPoints, setFetchedPoints] = useState(null)
  const [fetchedCurrentCredit, setFetchedCurrentCredit] = useState(null)
  const [itemDetailsCache, setItemDetailsCache] = useState({}) // code -> { costPrice, avgCost, factor, store, prevAmount }
  const scanInputRef = useRef(null)
  const cartItemsListRef = useRef(null)
  const cartScrollPrevRef = useRef({ len: 0, sig: '' })
  const fetchingCodesRef = useRef(new Set())
  const { toggleKeyboardForInput } = useKeyboard()

  const activeItems = cartItems.filter(item => !item.void)
  const total = activeItems.reduce((sum, item) => sum + (item.price * item.quantity), 0)
  const totalDisplay = Math.abs(total)
  const itemCount = activeItems.reduce((sum, item) => sum + item.quantity, 0)

  const findProductByManufactureId = (manufactureIdOrCode) => {
    const code = String(manufactureIdOrCode ?? '').trim()
    if (!code) return null
    return (products || []).find(
      (p) =>
        String(p.manufactureId ?? p.MANUFACTURERID ?? '').trim() === code ||
        String(p.id ?? p.ITEMCODE ?? '').trim() === code ||
        (Array.isArray(p.alternateCodes) && p.alternateCodes.some((alt) => String(alt ?? '').trim() === code))
    ) || null
  }

  const getPointForItem = (item, cached, productByManuf) => {
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

  const totalPoints = activeItems.reduce((sum, item) => {
    const cacheKey = String(item.manufactureId ?? item.MANUFACTURERID ?? item.id ?? item.ITEMCODE ?? '').trim()
    const cached = itemDetailsCache[cacheKey]
    const productByManuf = findProductByManufactureId(item.manufactureId ?? item.MANUFACTURERID ?? item.id ?? item.ITEMCODE)
    return sum + getPointForItem(item, cached, productByManuf)
  }, 0)

  const linePointsMap = useRef({})
  linePointsMap.current = {}
  activeItems.forEach((item) => {
    const cacheKey = String(item.manufactureId ?? item.MANUFACTURERID ?? item.id ?? item.ITEMCODE ?? '').trim()
    const cached = itemDetailsCache[cacheKey]
    const productByManuf = findProductByManufactureId(item.manufactureId ?? item.MANUFACTURERID ?? item.id ?? item.ITEMCODE)
    const pt = getPointForItem(item, cached, productByManuf)
    linePointsMap.current[getItemId(item)] = pt
  })

  useEffect(() => {
    onTotalPointsChange?.(totalPoints)
    onLinePointsChange?.({ ...linePointsMap.current })
  }, [totalPoints, onTotalPointsChange, onLinePointsChange, activeItems.length, itemDetailsCache])

  const formatNum = (v) => {
    if (v === undefined || v === null || v === '') return '—'
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isNaN(n) ? '—' : n.toFixed(2)
  }

  const formatQty = (v) => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n.toFixed(3) : '—'
  }

  useEffect(() => {
    if (!selectedCustomer || !apiBase) {
      setFetchedPoints(null)
      setFetchedCurrentCredit(null)
      return
    }
    const code = selectedCustomer.CUSTOMERCODE ?? selectedCustomer.customercode ?? ''
    if (!code) {
      setFetchedPoints(getCustomerPoints(selectedCustomer))
      setFetchedCurrentCredit(getCustomerCurrentCredit(selectedCustomer))
      return
    }
    let cancelled = false
    fetch(`${apiBase}/api/customers/balance?customerCode=${encodeURIComponent(code)}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data) {
          const p = data.points ?? data.POINTS
          const num = typeof p === 'number' ? p : parseInt(p, 10)
          setFetchedPoints(Number.isNaN(num) ? 0 : (num || 0))
          const cred = data.currentCreditAmount ?? data.CURRENTCREDITAMOUNT
          const credNum = typeof cred === 'number' ? cred : parseFloat(cred)
          setFetchedCurrentCredit(Number.isNaN(credNum) ? 0 : (credNum ?? 0))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFetchedPoints(getCustomerPoints(selectedCustomer))
          setFetchedCurrentCredit(getCustomerCurrentCredit(selectedCustomer))
        }
      })
    return () => { cancelled = true }
  }, [selectedCustomer, apiBase])

  useEffect(() => {
    if (!scanMsg) return
    const t = setTimeout(() => setScanMsg(null), 2500)
    return () => clearTimeout(t)
  }, [scanMsg])

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      scanInputRef.current?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [])

  // When cart has more than 5 lines, scroll so the newest / last line stays visible after add or qty merge on last line
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
      cartItemsListRef.current
        ?.querySelector('.cart-item-row:last-of-type')
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
    return () => cancelAnimationFrame(id)
  }, [cartItems])

  // Fallback: fetch cost/avgcost from lookup API for cart items that don't have them
  useEffect(() => {
    if (!apiBase || !cartItems?.length) return
    const codesToFetch = []
    for (const item of cartItems) {
      const code = String(item.manufactureId ?? item.MANUFACTURERID ?? item.id ?? item.ITEMCODE ?? '').trim()
      if (!code) continue
      const hasCost = item.costPrice != null || item.COSTPRICE != null || item.costprice != null
      const hasAvg = item.avgCost != null || item.AVERAGECOST != null || item.avgcost != null || item.averagecost != null
      const hasPrev = item.prevAmount != null || item.PREVAMOUNT != null || item.prevamount != null
      if ((!hasCost || !hasAvg || !hasPrev) && !fetchingCodesRef.current.has(code)) codesToFetch.push(code)
    }
    if (codesToFetch.length === 0) return
    let cancelled = false
    codesToFetch.forEach((code) => {
      fetchingCodesRef.current.add(code)
      fetch(`${apiBase}/api/products/lookup?code=${encodeURIComponent(code)}`)
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return
          if (data.found === false || !data) return
          const cp = data.COSTPRICE ?? data.costprice
          const ac = data.AVERAGECOST ?? data.averagecost ?? data.avgcost
          const convFactor = data.CONVERSIONFACTOR ?? data.conversionFactor ?? data.conversionfactor
          const st = data.STORE ?? data.store ?? data.LOCATIONCODE ?? data.locationcode
          const pa = data.PREVAMOUNT ?? data.prevamount
          if (cp != null || ac != null || convFactor != null || st != null || pa != null) {
            setItemDetailsCache((prev) => ({
              ...prev,
              [code]: {
                costPrice: cp,
                avgCost: ac,
                conversionFactor: convFactor,
                store: st,
                prevAmount: pa,
              },
            }))
          }
        })
        .catch(() => {})
        .finally(() => {
          fetchingCodesRef.current.delete(code)
        })
    })
    return () => { cancelled = true }
  }, [apiBase, cartItems])

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
          const isWeighted = !!(data.IS_WEIGHTED_ITEM ?? data.isWeightedItem)
          const weightKg = data.WEIGHTKG ?? data.weightKg
          product = {
            id: data.ITEMCODE ?? data.itemcode,
            name: data.ITEMNAME ?? data.itemname ?? '',
            nameAr: (data.ITEMNAMEARA ?? data.itemnameara ?? '').toString().trim() || undefined,
            price: parseFloat(data.RETAILPRICE ?? data.retailprice) || 0,
            category: data.CATEGORYCODE ?? data.categorycode,
            image: '📦',
            manufactureId: (data.MANUFACTUREID ?? data.manufactureid ?? data.ITEMCODE ?? data.itemcode ?? '').toString().trim(),
            uom: (data.BASEUOM ?? data.baseuom ?? '').toString().trim() || undefined,
            conversionFactor: data.CONVERSIONFACTOR ?? data.conversionFactor ?? data.conversionfactor,
            CONVERSIONFACTOR: data.CONVERSIONFACTOR ?? data.conversionFactor ?? data.conversionfactor,
            factor: data.CONVERSIONFACTOR ?? data.conversionFactor ?? data.conversionfactor ?? data.Factor ?? data.factor,
            Factor: data.CONVERSIONFACTOR ?? data.conversionFactor ?? data.conversionfactor ?? data.Factor ?? data.factor,
            costPrice: data.COSTPRICE ?? data.costprice,
            COSTPRICE: data.COSTPRICE ?? data.costprice,
            store: data.STORE ?? data.store,
            STORE: data.STORE ?? data.store,
            avgCost: data.AVERAGECOST ?? data.averagecost ?? data.avgcost,
            AVERAGECOST: data.AVERAGECOST ?? data.averagecost ?? data.avgcost,
            prevAmount: data.PREVAMOUNT ?? data.prevamount,
            PREVAMOUNT: data.PREVAMOUNT ?? data.prevamount,
            isWeightedItem: isWeighted,
            weightKg: weightKg != null ? Number(weightKg) : undefined,
            quantity: isWeighted && (weightKg != null && weightKg !== '') ? Number(weightKg) : undefined,
          }
        }
      } catch (err) {
        console.warn('Lookup error:', err)
      }
    }
    if (!product) {
      product = (products || []).find(
        (p) =>
          String(p.manufactureId ?? '').trim() === code ||
          String(p.id ?? '').trim() === code ||
          (Array.isArray(p.alternateCodes) && p.alternateCodes.some((alt) => String(alt ?? '').trim() === code))
      )
    }
    if (product) {
      onAddToCart?.(product)
      setScanMsg(`Added: ${product.name}`)
    } else {
      setScanMsg(`Not found – ${code}`)
    }
    scanInputRef.current?.focus()
  }

  return (
    <div className="cart-summary">
      <div className="cart-header">
        <div className="cart-header-title-row">
          {billNo != null && !Number.isNaN(Number(billNo)) && Number(billNo) >= 1 && (
            <span className="cart-bill-no">Bill # {billNo}</span>
          )}
          <h2 className="cart-title">Shopping Cart</h2>
        </div>
        {selectedCustomer != null && (
          <>
            <div className="cart-header-points">
              <span className="cart-header-points-label">Points</span>
              <span className="cart-header-points-value">
                {(() => {
                  const p = fetchedPoints !== null && fetchedPoints !== undefined
                    ? fetchedPoints
                    : getCustomerPoints(selectedCustomer)
                  return typeof p === 'number' && !Number.isNaN(p) ? p : 0
                })()}
              </span>
            </div>
            <div className="cart-header-points cart-header-credit">
              <span className="cart-header-points-label">Credit</span>
              <span className="cart-header-points-value">
                {(() => {
                  const c = fetchedCurrentCredit !== null && fetchedCurrentCredit !== undefined
                    ? fetchedCurrentCredit
                    : getCustomerCurrentCredit(selectedCustomer)
                  const num = typeof c === 'number' && !Number.isNaN(c) ? c : parseFloat(c)
                  return Number.isNaN(num) ? 0 : (num ?? 0)
                })()}
              </span>
            </div>
          </>
        )}
        {cartItems.length > 0 && (
          <button className="clear-btn" onClick={onClear}>Clear</button>
        )}
      </div>

      <div className="cart-scan-block">
        <form className="cart-scan-form" onSubmit={handleScanSubmit}>
          <div className="cart-scan-row">
            <input
              ref={scanInputRef}
              type="text"
              placeholder="Barcode or code"
              value={scanCode}
              onChange={(e) => setScanCode(e.target.value)}
              className="cart-scan-input"
              autoComplete="off"
              data-no-osk="true"
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
              {cartItems.map((item, index) => {
                const id = getItemId(item)
                const isSelected = selectedItemId != null && String(id) === String(selectedItemId)
                const isVoid = !!item.void
                const barcode = item.manufactureId ?? item.MANUFACTURERID ?? item.manufacturerId ?? ''
                const cacheKey = String(item.manufactureId ?? item.MANUFACTURERID ?? id ?? item.ITEMCODE ?? '').trim()
                const cached = itemDetailsCache[cacheKey]
                const productByManuf = findProductByManufactureId(barcode || id || item.id)
                const uom = item.uom ?? item.UOM ?? item.unit ?? '—'
                const discount = Number(item.discount) || 0
                const lineTotal = Math.max(0, Math.abs(item.price * item.quantity) - discount)
                const pointDisplay = getPointForItem(item, cached, productByManuf)
                // Factor: 1 for ITEMMASTER; CONVERSIONFACTOR for ITEMALTERNATEUOMMAP
                // Display factor = qty * factor (total conversion units)
                const baseFactor = item.conversionFactor ?? item.CONVERSIONFACTOR ?? productByManuf?.conversionFactor ?? productByManuf?.CONVERSIONFACTOR ?? cached?.conversionFactor ?? 1
                const factor = Number(baseFactor) * Number(item.quantity)
                const costprice = item.costPrice ?? item.COSTPRICE ?? item.costprice ?? productByManuf?.COSTPRICE ?? productByManuf?.costPrice ?? cached?.costPrice
                // Display cost = costprice * factor * quantity (line total cost)
                const costpriceNum = costprice != null ? (Number(costprice) * Number(factor) * Number(item.quantity)) : null
                const store = item.store ?? item.STORE ?? item.locationCode ?? item.LOCATIONCODE ?? productByManuf?.STORE ?? productByManuf?.store ?? cached?.store
                const avgcost = item.avgcost ?? item.AVGCOST ?? item.avgCost ?? item.AVERAGECOST ?? item.averagecost ?? productByManuf?.AVERAGECOST ?? productByManuf?.avgCost ?? productByManuf?.averagecost ?? cached?.avgCost
                // Display avg cost = avgcost * factor * quantity (line total avg cost)
                const avgcostNum = avgcost != null ? (Number(avgcost) * Number(factor) * Number(item.quantity)) : null
                return (
                  <div
                    key={id || index}
                    role="button"
                    tabIndex={0}
                    className={`cart-item-row ${isSelected ? 'cart-item-row-selected' : ''} ${isVoid ? 'cart-item-row-void' : ''}`}
                    onClick={() => !isVoid && onSelectItem?.(item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        if (!isVoid) onSelectItem?.(item)
                      }
                    }}
                    aria-pressed={isSelected}
                    aria-label={isVoid ? `${item.name} (void)` : item.name}
                  >
                    <span className="cart-td cart-td-sl">{index + 1}</span>
                    <span className="cart-td cart-td-barcode" title={barcode}>{barcode || '—'}</span>
                    <span className="cart-td cart-td-name" title={item.name}>
                      {item.name}
                      {isVoid && <span className="cart-item-void-badge">VOID</span>}
                    </span>
                    <span className="cart-td cart-td-uom">{uom}</span>
                    <span className="cart-td cart-td-qty">{formatQty(item.quantity)}</span>
                    <span className="cart-td cart-td-price">{item.price.toFixed(2)}</span>
                    <span className="cart-td cart-td-discount">{discount > 0 ? `${discount.toFixed(2)}` : '—'}</span>
                    <span className="cart-td cart-td-amount">{lineTotal.toFixed(2)}</span>
                    <span className="cart-td cart-td-point">{typeof pointDisplay === 'number' && Number.isFinite(pointDisplay) ? pointDisplay.toFixed(3) : '0.000'}</span>
                    <span className="cart-td cart-td-factor">{formatNum(factor)}</span>
                    <span className="cart-td cart-td-costprice">{formatNum(costpriceNum != null ? costpriceNum : costprice)}</span>
                    <span className="cart-td cart-td-store" title={store}>{store !== undefined && store !== null && store !== '' ? String(store).replace(/\s+/g, '') : 'STORE1'}</span>
                    <span className="cart-td cart-td-avgcost">{formatNum(avgcostNum != null ? avgcostNum : avgcost)}</span>
                  </div>
                )
              })}
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
          <button className="checkout-btn" onClick={onCheckout}>
            Checkout
          </button>
        </div>
      )}
    </div>
  )
}

export default CartSummary
