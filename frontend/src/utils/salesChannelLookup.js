export function getSalesChannelCode(ch) {
  if (!ch) return 0
  const raw = ch.CODE ?? ch.code ?? ch.CHANNELCODE ?? ch.channelCode
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

export function getSalesChannelDescription(ch) {
  if (!ch) return ''
  return String(ch.DESCRIPTION ?? ch.description ?? '').trim()
}

export const DEFAULT_SALES_CHANNEL_DESCRIPTION = 'DIRECT'

export function isDirectSalesChannel(ch) {
  return getSalesChannelDescription(ch).toUpperCase() === DEFAULT_SALES_CHANNEL_DESCRIPTION
}

export function isOnlineSalesChannel(ch) {
  if (ch == null || ch === '') return false
  if (typeof ch === 'string') return ch.trim().toUpperCase() === 'ONLINE'
  return getSalesChannelDescription(ch).toUpperCase() === 'ONLINE'
}

/** Prefer DIRECT; otherwise first channel in list. */
export function getDefaultSalesChannel(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return null
  const direct = channels.find(isDirectSalesChannel)
  return direct ?? channels[0]
}

export function normalizeSalesChannel(row) {
  if (!row || typeof row !== 'object') return null
  const code = getSalesChannelCode(row)
  if (!code) return null
  const description = getSalesChannelDescription(row)
  return {
    CODE: code,
    code,
    DESCRIPTION: description || String(code),
    description: description || String(code),
  }
}
