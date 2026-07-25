/** Price mode: null = retail, 'wholesale' | 'offer' for alternate tiers. */
export const PRICE_MODES = {
  RETAIL: null,
  WHOLESALE: 'wholesale',
  OFFER: 'offer',
}

export function parsePriceValue(value) {
  if (value === undefined || value === null || value === '') return null
  const n = typeof value === 'number' ? value : parseFloat(value)
  return Number.isFinite(n) ? n : null
}

export function getRetailPrice(product) {
  if (!product) return 0
  return parsePriceValue(
    product.retailPrice
    ?? product.RETAILPRICE
    ?? product.retailprice
    ?? product.price
  ) ?? 0
}

export function getWholesalePrice(product) {
  if (!product) return null
  return parsePriceValue(
    product.wholesalePrice
    ?? product.WHOLESALEPRICE
    ?? product.wholesaleprice
  )
}

export function getOfferPrice(product) {
  if (!product) return null
  return parsePriceValue(
    product.thirdPrice
    ?? product.THIRDPRICE
    ?? product.thirdprice
  )
}

export function resolveEffectivePrice(product, priceMode) {
  const retail = getRetailPrice(product)
  if (!priceMode) return retail
  if (priceMode === PRICE_MODES.WHOLESALE) {
    const wp = getWholesalePrice(product)
    return wp != null && wp > 0 ? wp : retail
  }
  if (priceMode === PRICE_MODES.OFFER) {
    const op = getOfferPrice(product)
    return op != null && op > 0 ? op : retail
  }
  return retail
}

export function priceModeLabel(priceMode) {
  if (priceMode === PRICE_MODES.WHOLESALE) return 'Wholesale'
  if (priceMode === PRICE_MODES.OFFER) return 'Offers'
  return 'Price mode'
}

export function priceModeAmountLabel(priceMode) {
  if (priceMode === PRICE_MODES.WHOLESALE) return 'Wholesale price'
  if (priceMode === PRICE_MODES.OFFER) return 'Offer price'
  return 'Price'
}

export function applyPriceModeToProduct(product, priceMode) {
  if (!product) return product
  const retail = getRetailPrice(product)
  const wholesale = getWholesalePrice(product)
  const offer = getOfferPrice(product)
  const enriched = {
    ...product,
    retailPrice: retail,
    RETAILPRICE: retail,
    wholesalePrice: wholesale,
    WHOLESALEPRICE: wholesale,
    thirdPrice: offer,
    THIRDPRICE: offer,
  }
  return {
    ...enriched,
    price: resolveEffectivePrice(enriched, priceMode),
  }
}
