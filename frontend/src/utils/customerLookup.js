/** Pre-normalized customer row for fast typeahead (avoids per-keystroke string work). */

const digitsOnly = (s) => String(s || '').replace(/\D/g, '')

export function getCustomerName(c) {
  if (!c) return ''
  const full = c.CUST_FULL_NAME || c.cust_full_name
  if (full) return String(full).trim()
  const code = String(c.CUSTOMERCODE || c.customercode || '').trim()
  const name = String(c.CUSTOMERNAME || c.customername || '').trim()
  return [code, name].filter(Boolean).join(' ')
}

export function getCustomerCode(c) {
  return String((c && (c.CUSTOMERCODE ?? c.customercode)) ?? '')
}

export function getCustomerMobile(c) {
  return String((c && (c.MOBILE ?? c.mobile)) ?? '').trim()
}

export function getCustomerQid(c) {
  return String((c && (c.QID ?? c.qid ?? c.QIDNO ?? c.qidno)) ?? '').trim()
}

export function getCategoryName(c) {
  return (c && (c.CATEGORYNAME || c.categoryname)) || ''
}

export function getInvoiceTypeLabel(c) {
  if (!c) return ''
  const code = c.INVOICECODE ?? c.invoicecode
  if (code === 1 || code === '1') return 'Cash'
  if (code === 2 || code === '2') return 'Credit'
  return ''
}

/**
 * @param {Array<Record<string, unknown>>} customers
 * @returns {Array<{ customer: Record<string, unknown>, nameLower: string, codeLower: string, mobileDigits: string, qidDigits: string, displayName: string, displayCode: string, displayMobile: string, displayCategory: string, displayInvoiceType: string }>}
 */
export function buildCustomerSearchIndex(customers) {
  if (!Array.isArray(customers) || customers.length === 0) return []
  const rows = new Array(customers.length)
  for (let i = 0; i < customers.length; i += 1) {
    const customer = customers[i]
    const displayName = getCustomerName(customer)
    const displayCode = getCustomerCode(customer)
    const displayMobile = getCustomerMobile(customer)
    rows[i] = {
      customer,
      nameLower: displayName.toLowerCase(),
      codeLower: displayCode.toLowerCase(),
      mobileDigits: digitsOnly(displayMobile),
      qidDigits: digitsOnly(getCustomerQid(customer)),
      displayName,
      displayCode,
      displayMobile,
      displayCategory: getCategoryName(customer),
      displayInvoiceType: getInvoiceTypeLabel(customer),
    }
  }
  return rows
}

const DEFAULT_MATCH_LIMIT = 80

/**
 * @param {ReturnType<typeof buildCustomerSearchIndex>} index
 * @param {string} query
 * @param {{ limit?: number, selectedCode?: string }} [options]
 */
export function filterCustomerSearchIndex(index, query, options = {}) {
  const q = String(query || '').trim().toLowerCase()
  if (!q || !index?.length) return []
  const qDigits = digitsOnly(query)
  const limit = options.limit ?? DEFAULT_MATCH_LIMIT
  const selectedCode = options.selectedCode ? String(options.selectedCode) : ''
  const out = []
  for (let i = 0; i < index.length; i += 1) {
    const row = index[i]
    const byText = row.nameLower.includes(q) || row.codeLower.includes(q)
    const byPhone =
      qDigits.length > 0 &&
      row.mobileDigits.length > 0 &&
      row.mobileDigits.includes(qDigits)
    const byQid =
      qDigits.length > 0 &&
      row.qidDigits.length > 0 &&
      row.qidDigits.includes(qDigits)
    if (byText || byPhone || byQid) {
      out.push(row)
      if (out.length >= limit) break
    }
  }
  if (selectedCode && out.length > 0) {
    out.sort((a, b) => {
      const aSel = a.displayCode === selectedCode
      const bSel = b.displayCode === selectedCode
      if (aSel === bSel) return 0
      return aSel ? -1 : 1
    })
  }
  return out
}
