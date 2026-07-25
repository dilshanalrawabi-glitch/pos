/**
 * Local-first barcode scan helpers for instant cart adds.
 */

import { resolveManufactureId } from './cartItemUtils'

function normKey(code) {
  const k = String(code ?? '').trim().toUpperCase()
  return k || null
}

/** Vegetable/meat encoded-price barcodes (8+ chars, price in trailing digits). */
export function isWeightedVegetableBarcode(code) {
  const codeStr = String(code ?? '').trim().replace(/\s+/g, '')
  if (codeStr.length < 8) return false
  const remainder = codeStr.slice(7).trim()
  return remainder.length > 0 && /^\d+$/.test(remainder)
}

export function cartItemHasFullDetails(item) {
  if (!item || typeof item !== 'object') return false
  const hasCost = item.costPrice != null || item.COSTPRICE != null || item.costprice != null
  const hasAvg = item.avgCost != null || item.AVERAGECOST != null || item.avgcost != null || item.averagecost != null
  const hasPrev = item.prevAmount != null || item.PREVAMOUNT != null || item.prevamount != null
  const hasUom = (item.uom ?? item.UOM ?? item.baseuom ?? item.BASEUOM ?? '').toString().trim() !== ''
  const hasFactor = item.conversionFactor != null || item.CONVERSIONFACTOR != null || item.factor != null || item.Factor != null
  return hasCost && hasAvg && hasPrev && hasUom && hasFactor
}

export function shouldBackgroundEnrichLocalProduct(product, scannedCode) {
  if (!product) return false
  if (!resolveManufactureId(product)) return true
  if (!cartItemHasFullDetails(product)) return true
  const scanned = normKey(scannedCode)
  if (!scanned) return false
  const primary = new Set([
    normKey(product.id),
    normKey(product.ITEMCODE),
    normKey(product.itemcode),
    normKey(product.manufactureId),
    normKey(product.MANUFACTURERID),
    normKey(product.MANUFACTUREID),
  ].filter(Boolean))
  if (!primary.has(scanned)) return true
  return false
}

export function mapApiLookupToProduct(data) {
  if (!data || data.found === false || (data.ITEMCODE == null && data.itemcode == null)) return null
  const isWeighted = !!(data.IS_WEIGHTED_ITEM ?? data.isWeightedItem)
  const weightKg = data.WEIGHTKG ?? data.weightKg
  const conv = data.CONVERSIONFACTOR ?? data.conversionFactor ?? data.conversionfactor
  return {
    id: data.ITEMCODE ?? data.itemcode,
    name: data.ITEMNAME ?? data.itemname ?? '',
    nameAr: (data.ITEMNAMEARA ?? data.itemnameara ?? '').toString().trim() || undefined,
    price: parseFloat(data.RETAILPRICE ?? data.retailprice) || 0,
    retailPrice: parseFloat(data.RETAILPRICE ?? data.retailprice) || 0,
    RETAILPRICE: parseFloat(data.RETAILPRICE ?? data.retailprice) || 0,
    wholesalePrice: data.WHOLESALEPRICE ?? data.wholesaleprice,
    WHOLESALEPRICE: data.WHOLESALEPRICE ?? data.wholesaleprice,
    thirdPrice: data.THIRDPRICE ?? data.thirdprice,
    THIRDPRICE: data.THIRDPRICE ?? data.thirdprice,
    category: data.CATEGORYCODE ?? data.categorycode,
    image: '📦',
    manufactureId: resolveManufactureId({
      MANUFACTURERID: data.MANUFACTURERID,
      MANUFACTUREID: data.MANUFACTUREID,
      manufactureid: data.manufactureid,
      id: data.ITEMCODE ?? data.itemcode,
      ITEMCODE: data.ITEMCODE ?? data.itemcode,
    }),
    uom: (data.BASEUOM ?? data.baseuom ?? '').toString().trim() || undefined,
    conversionFactor: conv,
    CONVERSIONFACTOR: conv,
    factor: conv ?? data.Factor ?? data.factor,
    Factor: conv ?? data.Factor ?? data.factor,
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

/** Normalize a catalog / lookup-map row for addToCart. */
export function mapLocalProductToCart(raw, scannedCode) {
  if (!raw) return null
  const conv = raw.conversionFactor ?? raw.CONVERSIONFACTOR ?? raw.factor ?? raw.Factor ?? 1
  const manufactureId = resolveManufactureId(raw, scannedCode)
  return {
    id: raw.id ?? raw.ITEMCODE ?? raw.itemcode,
    name: raw.name ?? raw.ITEMNAME ?? raw.itemname ?? '',
    nameAr: (raw.nameAr ?? raw.ITEMNAMEARA ?? raw.itemnameara ?? '').toString().trim() || undefined,
    price: parseFloat(raw.price ?? raw.RETAILPRICE ?? raw.retailprice) || 0,
    retailPrice: parseFloat(raw.retailPrice ?? raw.RETAILPRICE ?? raw.retailprice ?? raw.price) || 0,
    RETAILPRICE: parseFloat(raw.retailPrice ?? raw.RETAILPRICE ?? raw.retailprice ?? raw.price) || 0,
    wholesalePrice: raw.wholesalePrice ?? raw.WHOLESALEPRICE ?? raw.wholesaleprice,
    WHOLESALEPRICE: raw.WHOLESALEPRICE ?? raw.wholesalePrice ?? raw.wholesaleprice,
    thirdPrice: raw.thirdPrice ?? raw.THIRDPRICE ?? raw.thirdprice,
    THIRDPRICE: raw.THIRDPRICE ?? raw.thirdPrice ?? raw.thirdprice,
    category: raw.category ?? raw.CATEGORYCODE ?? raw.categorycode,
    image: raw.image ?? '📦',
    manufactureId,
    uom: (raw.uom ?? raw.UOM ?? raw.BASEUOM ?? raw.baseuom ?? '').toString().trim() || undefined,
    conversionFactor: conv,
    CONVERSIONFACTOR: conv,
    factor: conv,
    Factor: conv,
    costPrice: raw.costPrice ?? raw.COSTPRICE ?? raw.costprice,
    COSTPRICE: raw.COSTPRICE ?? raw.costprice ?? raw.costPrice,
    store: raw.store ?? raw.STORE,
    STORE: raw.STORE ?? raw.store,
    avgCost: raw.avgCost ?? raw.AVERAGECOST ?? raw.averagecost ?? raw.avgcost,
    AVERAGECOST: raw.AVERAGECOST ?? raw.averagecost ?? raw.avgCost,
    prevAmount: raw.prevAmount ?? raw.PREVAMOUNT ?? raw.prevamount,
    PREVAMOUNT: raw.PREVAMOUNT ?? raw.prevamount ?? raw.prevAmount,
    isWeightedItem: !!(raw.isWeightedItem ?? raw.IS_WEIGHTED_ITEM),
    weightKg: raw.weightKg ?? raw.WEIGHTKG,
    quantity: raw.quantity,
  }
}

export function mergeEnrichedProduct(existing, enriched) {
  if (!existing || !enriched) return existing
  return {
    ...existing,
    ...enriched,
    manufactureId: resolveManufactureId(enriched) || resolveManufactureId(existing),
    quantity: existing.quantity,
    void: existing.void,
    discount: existing.discount,
  }
}

export async function fetchProductLookup(apiBase, code) {
  if (!apiBase || !code) return null
  const res = await fetch(`${apiBase}/api/products/lookup?code=${encodeURIComponent(code)}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.found === false) return null
  return mapApiLookupToProduct(data)
}

/** Build itemDetailsCache entry from a product row. */
export function detailsCacheFromProduct(product) {
  if (!product) return null
  const cp = product.costPrice ?? product.COSTPRICE ?? product.costprice
  const ac = product.avgCost ?? product.AVERAGECOST ?? product.averagecost ?? product.avgcost
  const convFactor = product.conversionFactor ?? product.CONVERSIONFACTOR ?? product.factor ?? product.Factor
  const st = product.store ?? product.STORE
  const pa = product.prevAmount ?? product.PREVAMOUNT ?? product.prevamount
  const uomVal = (product.uom ?? product.UOM ?? product.BASEUOM ?? product.baseuom ?? '').toString().trim() || undefined
  if (cp == null && ac == null && convFactor == null && st == null && pa == null && !uomVal) return null
  return { costPrice: cp, avgCost: ac, conversionFactor: convFactor, uom: uomVal, store: st, prevAmount: pa }
}
