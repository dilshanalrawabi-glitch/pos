/** Shared cart line identity helpers (itemcode + barcode/manufactureId). */

export function itemCodeOf(item) {
  return String(item?.ITEMCODE ?? item?.itemCode ?? item?.id ?? '').trim()
}

/** First non-empty manufacture / barcode field (ignores blank strings). */
export function resolveManufactureId(item, scannedCode) {
  const candidates = [
    item?.manufactureId,
    item?.MANUFACTURERID,
    item?.MANUFACTUREID,
    item?.manufacturerId,
    scannedCode,
    item?.id,
    item?.ITEMCODE,
    item?.itemcode,
  ]
  for (const value of candidates) {
    const trimmed = String(value ?? '').trim()
    if (trimmed) return trimmed
  }
  return ''
}

export function getItemId(item) {
  if (!item) return ''
  const itemCode = itemCodeOf(item)
  const manufactureId = resolveManufactureId(item)
  if (manufactureId && manufactureId !== itemCode) {
    return `${itemCode}_${manufactureId}`
  }
  if (manufactureId) return manufactureId
  return itemCode
}

function linesWithSameItemCode(items, itemCodeUpper) {
  return items
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => itemCodeOf(item).toUpperCase() === itemCodeUpper)
}

/**
 * Find cart line index for add/merge — avoids updating the wrong line when one item
 * has multiple barcodes (same ITEMCODE, different MANUFACTURERID).
 */
export function findCartLineIndexForMerge(items, incoming) {
  if (!incoming || !Array.isArray(items) || items.length === 0) return -1

  const incomingId = getItemId(incoming)
  const exactIdx = items.findIndex((item) => sameCartLineId(getItemId(item), incomingId))
  if (exactIdx >= 0) return exactIdx

  const inCode = itemCodeOf(incoming).toUpperCase()
  if (!inCode) return -1

  const sameCode = linesWithSameItemCode(items, inCode)
  if (sameCode.length === 0) return -1

  const inMan = resolveManufactureId(incoming).toUpperCase()

  if (inMan) {
    const byMan = sameCode.find(({ item }) => resolveManufactureId(item).toUpperCase() === inMan)
    if (byMan) return byMan.idx

    const emptyLines = sameCode.filter(({ item }) => !resolveManufactureId(item))
    if (emptyLines.length === 1) {
      const targetIdx = emptyLines[0].idx
      const barcodeTaken = items.some(
        (item, idx) =>
          idx !== targetIdx &&
          itemCodeOf(item).toUpperCase() === inCode &&
          resolveManufactureId(item).toUpperCase() === inMan
      )
      if (!barcodeTaken) return targetIdx
    }
    return -1
  }

  const emptyLines = sameCode.filter(({ item }) => !resolveManufactureId(item))
  if (emptyLines.length >= 1) return emptyLines[0].idx
  return -1
}

/** @deprecated Prefer findCartLineIndexForMerge with full items array. */
export function cartLinesMatchForMerge(existing, incoming) {
  if (!existing || !incoming) return false
  const codeA = itemCodeOf(existing).toUpperCase()
  const codeB = itemCodeOf(incoming).toUpperCase()
  if (!codeA || codeA !== codeB) return false
  const manA = resolveManufactureId(existing).toUpperCase()
  const manB = resolveManufactureId(incoming).toUpperCase()
  if (manA && manB) return manA === manB
  if (!manA && !manB) return true
  return false
}

export function sameCartLineId(a, b) {
  return String(a ?? '') === String(b ?? '')
}

export function cartLineSyncKey(item) {
  if (!item || typeof item !== 'object') return ''
  const itemcode = itemCodeOf(item).toUpperCase()
  const manuf = resolveManufactureId(item).toUpperCase()
  return `${itemcode}\0${manuf}`
}
