/**
 * O(1) barcode / itemcode / alternate lookup for large product catalogs.
 * Keys are normalized with trim + toUpperCase for case-insensitive match.
 */

function normKey(code) {
  const k = String(code ?? '').trim().toUpperCase()
  return k || null
}

/**
 * @param {Array<Record<string, unknown>>} products
 * @returns {Map<string, Record<string, unknown>>}
 */
export function buildProductLookupMap(products) {
  const map = new Map()
  if (!Array.isArray(products)) return map
  for (const p of products) {
    if (!p || typeof p !== 'object') continue
    const add = (code) => {
      const k = normKey(code)
      if (k && !map.has(k)) map.set(k, p)
    }
    add(p.id)
    add(p.ITEMCODE)
    add(p.itemcode)
    add(p.manufactureId)
    add(p.MANUFACTURERID)
    add(p.manufacturerId)
    if (Array.isArray(p.alternateCodes)) {
      for (const alt of p.alternateCodes) add(alt)
    }
  }
  return map
}

/**
 * @param {Map<string, Record<string, unknown>>} map from buildProductLookupMap
 * @param {string} code scanned or typed code
 */
export function lookupProductByCode(map, code) {
  if (!map || map.size === 0) return null
  const k = normKey(code)
  return k ? map.get(k) ?? null : null
}
