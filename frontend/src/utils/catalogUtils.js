/** Map GET /api/products rows to frontend catalog shape. */
export function mapProductsFromApi(data) {
  if (!Array.isArray(data)) return []
  return data.map((p) => ({
    id: p.ITEMCODE,
    name: p.ITEMNAME,
    nameAr: (p.ITEMNAMEARA ?? p.itemnameara ?? '').toString().trim() || undefined,
    price: parseFloat(p.RETAILPRICE) || 0,
    retailPrice: parseFloat(p.RETAILPRICE) || 0,
    RETAILPRICE: parseFloat(p.RETAILPRICE) || 0,
    wholesalePrice: p.WHOLESALEPRICE ?? p.wholesaleprice,
    WHOLESALEPRICE: p.WHOLESALEPRICE ?? p.wholesaleprice,
    thirdPrice: p.THIRDPRICE ?? p.thirdprice,
    THIRDPRICE: p.THIRDPRICE ?? p.thirdprice,
    category: p.CATEGORYCODE,
    image: '📦',
    manufactureId: String(p.MANUFACTURERID ?? p.MANUFACTUREID ?? p.manufacturerid ?? p.manufactureid ?? '').trim(),
    MANUFACTURERID: String(p.MANUFACTURERID ?? p.MANUFACTUREID ?? p.manufacturerid ?? p.manufactureid ?? '').trim() || undefined,
    alternateCodes: Array.isArray(p.ALTERNATECODES) ? p.ALTERNATECODES : [],
    uom: (p.BASEUOM ?? p.baseuom ?? '').toString().trim() || undefined,
    factor: p.CONVERSIONFACTOR ?? p.conversionFactor ?? p.Factor ?? p.factor,
    Factor: p.CONVERSIONFACTOR ?? p.conversionFactor ?? p.Factor ?? p.factor,
    conversionFactor: p.CONVERSIONFACTOR ?? p.conversionFactor,
    CONVERSIONFACTOR: p.CONVERSIONFACTOR ?? p.conversionFactor,
    costPrice: p.COSTPRICE ?? p.costprice,
    COSTPRICE: p.COSTPRICE ?? p.costprice,
    store: p.STORE ?? p.store,
    STORE: p.STORE ?? p.store,
    avgCost: p.AVERAGECOST ?? p.averagecost ?? p.avgcost,
    AVERAGECOST: p.AVERAGECOST ?? p.averagecost ?? p.avgcost,
    prevAmount: p.PREVAMOUNT ?? p.prevamount,
    PREVAMOUNT: p.PREVAMOUNT ?? p.prevamount,
  }))
}

/** Background catalog refresh while counter is open (ms). */
export const CATALOG_REFRESH_INTERVAL_MS = 45 * 60 * 1000
