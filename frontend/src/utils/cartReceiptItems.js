import { lookupProductByCode } from './productLookup'

import { resolveManufactureId } from './cartItemUtils'

function getCartItemId(item) {
  return item?.id ?? item?.ITEMCODE ?? item?.itemCode ?? ''
}

function cacheKeyForItem(item) {
  const id = getCartItemId(item)
  return resolveManufactureId(item) || String(id ?? item?.ITEMCODE ?? '').trim()
}

/**
 * Merge cart line + in-memory catalog (same sources as CartSummary) for thermal print.
 * Does not call the network — use with productLookupMap and optional CartSummary itemDetailsCache.
 */
export function mergeCartLineForThermalReceipt(item, lookupMap, itemDetailsCache = {}) {
  if (!item || typeof item !== 'object') return item
  const id = getCartItemId(item)
  const barcode = resolveManufactureId(item)
  const key = cacheKeyForItem(item)
  const cached = key ? itemDetailsCache[key] : null
  const productByManuf = lookupProductByCode(lookupMap, barcode || id || item.id)

  const name =
    (item.name && String(item.name).trim()) ||
    (item.ITEMNAME && String(item.ITEMNAME).trim()) ||
    (productByManuf?.name && String(productByManuf.name).trim()) ||
    (productByManuf?.ITEMNAME && String(productByManuf.ITEMNAME).trim()) ||
    String(barcode || id || '').trim() ||
    'Item'

  const nameAr =
    (item.nameAr && String(item.nameAr).trim()) ||
    (item.ITEMNAMEARA && String(item.ITEMNAMEARA).trim()) ||
    (productByManuf?.nameAr && String(productByManuf.nameAr).trim()) ||
    (productByManuf?.ITEMNAMEARA && String(productByManuf.ITEMNAMEARA).trim()) ||
    ''

  const manufactureId = String(barcode || id || '').trim() || String(id).trim()

  const costPrice =
    item.costPrice ?? item.COSTPRICE ?? item.costprice ?? productByManuf?.COSTPRICE ?? productByManuf?.costPrice ?? cached?.costPrice
  const avgCost =
    item.avgCost ?? item.AVERAGECOST ?? item.averagecost ?? item.avgcost ?? productByManuf?.AVERAGECOST ?? productByManuf?.avgCost ?? productByManuf?.averagecost ?? cached?.avgCost
  const conversionFactor =
    item.conversionFactor ?? item.CONVERSIONFACTOR ?? productByManuf?.conversionFactor ?? productByManuf?.CONVERSIONFACTOR ?? cached?.conversionFactor
  const store =
    item.store ?? item.STORE ?? item.locationCode ?? item.LOCATIONCODE ?? productByManuf?.STORE ?? productByManuf?.store ?? cached?.store
  const prevAmount =
    item.prevAmount ?? item.PREVAMOUNT ?? item.prevamount ?? productByManuf?.PREVAMOUNT ?? productByManuf?.prevAmount ?? cached?.prevAmount

  return {
    ...item,
    name,
    ITEMNAME: name,
    nameAr,
    manufactureId,
    ...(costPrice != null && costPrice !== '' ? { costPrice: Number(costPrice) || costPrice, COSTPRICE: costPrice } : {}),
    ...(avgCost != null && avgCost !== '' ? { avgCost: Number(avgCost) || avgCost, AVERAGECOST: avgCost } : {}),
    ...(conversionFactor != null && conversionFactor !== '' ? { conversionFactor: Number(conversionFactor) || conversionFactor } : {}),
    ...(store != null && store !== '' ? { store, STORE: store } : {}),
    ...(prevAmount != null && prevAmount !== '' ? { prevAmount, PREVAMOUNT: prevAmount } : {}),
    price: Number(item.price) || 0,
    quantity: Number(item.quantity) || 0,
  }
}

export function mergeCartLinesForThermalReceipt(activeItems, lookupMap, itemDetailsCache) {
  if (!Array.isArray(activeItems)) return []
  const cache = itemDetailsCache && typeof itemDetailsCache === 'object' ? itemDetailsCache : {}
  return activeItems.map((row) => mergeCartLineForThermalReceipt(row, lookupMap, cache))
}
