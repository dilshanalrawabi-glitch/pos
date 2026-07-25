import { lookupProductByCode } from './productLookup'
import { getItemId, resolveManufactureId } from './cartItemUtils'

export const BACK_DISPLAY_CHANNEL = 'pos-back-display-v1'

function resolveItemName(item, itemDetailsCache, lookupMap) {
  const barcode = resolveManufactureId(item)
  const id = getItemId(item)
  const productByManuf = lookupProductByCode(lookupMap, barcode || id || item.id)
  return (
    (item.name && String(item.name).trim()) ||
    (item.ITEMNAME && String(item.ITEMNAME).trim()) ||
    (productByManuf?.name && String(productByManuf.name).trim()) ||
    (productByManuf?.ITEMNAME && String(productByManuf.ITEMNAME).trim()) ||
    String(barcode || id || '').trim() ||
    'Item'
  )
}

/** Build customer-facing cart lines from the same sources as CartSummary. */
export function buildBackDisplayPayload(cartItems, options = {}) {
  const {
    counterCode = '',
    locationCode = '',
    locationName = '',
    itemDetailsCache = {},
    lookupMap = {},
  } = options

  const activeItems = Array.isArray(cartItems) ? cartItems.filter((item) => !item.void) : []
  const items = activeItems.map((item) => {
    const qty = Number(item.quantity) || 0
    const price = Number(item.price) || 0
    const discount = Number(item.discount) || 0
    const amount = Math.max(0, Math.abs(qty * price) - discount)
    return {
      id: getItemId(item),
      name: resolveItemName(item, itemDetailsCache, lookupMap),
      quantity: qty,
      price,
      amount,
    }
  })
  const total = items.reduce((sum, line) => sum + line.amount, 0)

  return {
    type: 'sync',
    counterCode: String(counterCode || '').trim(),
    locationCode: String(locationCode || '').trim(),
    locationName: String(locationName || '').trim(),
    items,
    total,
    ts: Date.now(),
  }
}

export function publishBackDisplay(payload) {
  if (typeof BroadcastChannel === 'undefined' || !payload) return
  try {
    const channel = new BroadcastChannel(BACK_DISPLAY_CHANNEL)
    channel.postMessage(payload)
    channel.close()
  } catch (_) {
    /* ignore */
  }
}

export function requestBackDisplaySync(counterCode, locationCode) {
  publishBackDisplay({
    type: 'request-sync',
    counterCode: String(counterCode || '').trim(),
    locationCode: String(locationCode || '').trim(),
  })
}

export function subscribeBackDisplay(handler) {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(BACK_DISPLAY_CHANNEL)
  channel.onmessage = (event) => {
    if (event?.data && typeof event.data === 'object') handler(event.data)
  }
  return () => {
    channel.onmessage = null
    channel.close()
  }
}

export function matchesBackDisplayScope(payload, counterCode, locationCode) {
  if (!payload || payload.type !== 'sync') return false
  const cc = String(counterCode || '').trim()
  const loc = String(locationCode || '').trim()
  if (payload.counterCode && cc && payload.counterCode !== cc) return false
  if (payload.locationCode && loc && payload.locationCode !== loc) return false
  return true
}
