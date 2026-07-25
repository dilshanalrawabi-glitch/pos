/**
 * Thermal receipt printing via QZ Tray.
 * Prints directly to USB thermal printer without opening system print dialogs.
 * Requires QZ Tray desktop app to be running: https://qz.io/
 *
 * Signing: certificate from backend + RSA-SHA512 signatures via POST /api/qz-tray/sign
 * removes the "unrestricted website" / anonymous-site warning in QZ Tray.
 */

import { getApiBase } from '../apiBase'
import { getSalesChannelDescription, isOnlineSalesChannel } from '../utils/salesChannelLookup'
import JsBarcode from 'jsbarcode'

const ESC = '\x1B'
const GS = '\x1D'
const LF = '\x0A'

// ESC/POS commands
const INIT = ESC + '\x40'
const CENTER = ESC + '\x61\x31'
const LEFT = ESC + '\x61\x30'
const RIGHT = ESC + '\x61\x32'
const BOLD_ON = ESC + '\x45\x0D'
const BOLD_OFF = ESC + '\x45\x0A'
const UNDERLINE_1 = ESC + '\x2D\x01'
const UNDERLINE_0 = ESC + '\x2D\x00'
// ESC ! n: Select print mode: 0x08=bold, 0x10=double-height, 0x20=double-width
const NORMAL = ESC + '\x21\x00'
const DOUBLE_H = ESC + '\x21\x10'
const DOUBLE_W = ESC + '\x21\x20'
const DOUBLE_HW = ESC + '\x21\x30'
const BOLD_DOUBLE = ESC + '\x21\x38'
// ESC M n: Font A (12x24) = 0, Font B (9x17 smaller) = 1 — use Font A for Arabic support
const FONT_NORMAL = ESC + '\x4D\x00'
const FONT_SMALL = ESC + '\x4D\x01'
// ESC t n: Select character table — 0x25 (37) = IBM864 Arabic (Epson)
const ARABIC_CODEPAGE = ESC + '\x74\x25'
// After Arabic header, PC437 (table 0) keeps Latin digits/ASCII labels readable on many printers under IBM864 jobs
const LATIN_CODEPAGE_PC437 = ESC + '\x74\x00'
const CUT = GS + '\x56\x00' // full cut

/** ESC/POS cash drawer pulse (Epson-style). Pin 2 = m 0, pin 5 = m 1. t1/t2 = on/off times (×2 ms). */
function escPosDrawerKick(pin = 0) {
  const m = pin === 1 ? 1 : 0
  return ESC + '\x70' + String.fromCharCode(m) + '\x19\xFA'
}

const PRINTER_KEY = 'pos_receipt_printer'
const ENCODING_KEY =
  'pos_receipt_encoding' // 'IBM864' (Epson Arabic + QZ shaping) | 'Cp1256' | 'UTF-8' — Settings; IBM864 failures retry once as Cp1256
const DRAWER_ENABLE_KEY = 'pos_cash_drawer_enabled' // '1' on (default), '0' off
const DRAWER_PIN_KEY = 'pos_cash_drawer_pin' // '0' = pin 2, '1' = pin 5
const RECEIPT_WIDTH = 48 // ~80mm thermal, Font B (9×17) column count
/** Font A (12×24) on 80mm — fewer columns, larger glyphs (better on some POS brands e.g. Adler). */
const RECEIPT_WIDTH_FONT_A_80MM = 42

/**
 * @typedef {{ receiptWidth: number, bodyFont: 'small' | 'normal', barcode: 'default' | 'large' }} ThermalProfile
 */

/** @returns {ThermalProfile} */
export function getThermalProfileFromPrinterName(printerName) {
  const pl = String(printerName || '').toLowerCase()
  if (pl.includes('adler')) {
    return {
      receiptWidth: RECEIPT_WIDTH_FONT_A_80MM,
      bodyFont: 'normal',
      barcode: 'large',
    }
  }
  return { receiptWidth: RECEIPT_WIDTH, bodyFont: 'small', barcode: 'default' }
}

const DEFAULT_THERMAL_PROFILE = getThermalProfileFromPrinterName('')

/** Register once: public cert + server-side signing (matches backend SHA-512). */
let _qzSecurityConfigured = false
/** In-memory cert after first successful load (QZ may invoke the cert promise more than once). */
let _qzCachedCertificateText = null
/** Single in-flight cert fetch so parallel QZ calls do not duplicate network work. */
let _qzCertificateLoadPromise = null

/** One dynamic import shared by receipt / hold / counter / printer list (faster repeat prints). */
let _qzModulePromise = null
function loadQzTrayModule() {
  if (!_qzModulePromise) {
    _qzModulePromise = import('qz-tray').then((m) => m.default)
  }
  return _qzModulePromise
}

/** Short-lived cache when no saved printer — avoids qz.printers.find() on every receipt. */
let _printerListCache = { names: null, expires: 0 }
const PRINTER_LIST_CACHE_MS = 45000

/** Bill-no barcode raster chunks (JsBarcode is relatively heavy). */
const BARCODE_CACHE_MAX = 80
const _billNoBarcodeCache = new Map()

/** Public path — Vite serves `frontend/public` at site root (`BASE_URL` ends with `/`). */
const RECEIPT_HEADER_LOGO_URL = `${import.meta.env.BASE_URL || '/'}wholesaleplus.png`

/** Max raster width for 80mm thermal (dots); height scales, capped for feed length.
 *  512 dots ≈ ~64mm on 80mm thermal; slightly under full width for margins. */
const RECEIPT_LOGO_MAX_WIDTH = 512
const RECEIPT_LOGO_MAX_HEIGHT = 210
/** Shown centered under the header logo on every thermal slip (receipt, hold, counter close). */
const RECEIPT_LOCATION_LINE = 'RAYYAN'

let _receiptHeaderLogoChunkPromise = null

function invalidatePrinterListCache() {
  _printerListCache = { names: null, expires: 0 }
}

async function ensureQzSecurity(qz) {
  if (_qzSecurityConfigured) return
  const base = getApiBase()
  if (!base) {
    throw new Error('API base URL not configured')
  }
  qz.security.setCertificatePromise((resolve, reject) => {
    if (_qzCachedCertificateText) {
      resolve(_qzCachedCertificateText)
      return
    }
    const certUrl = `${base}/api/qz-tray/certificate`
    if (!_qzCertificateLoadPromise) {
      _qzCertificateLoadPromise = fetch(certUrl, { cache: 'default' })
        .then((r) => {
          if (!r.ok) {
            throw new Error(
              `Certificate fetch failed (${certUrl}): ${r.status}. Is the API running and backend/certs/digital-certificate.txt present?`
            )
          }
          return r.text()
        })
        .then((text) => {
          if (!text || !text.includes('BEGIN CERTIFICATE')) {
            throw new Error(`Invalid certificate from ${certUrl}. Check backend/certs/digital-certificate.txt.`)
          }
          _qzCachedCertificateText = text
          return text
        })
        .catch((e) => {
          _qzCertificateLoadPromise = null
          throw e
        })
    }
    _qzCertificateLoadPromise.then((text) => resolve(text)).catch(reject)
  })
  qz.security.setSignatureAlgorithm('SHA512')
  qz.security.setSignaturePromise((toSign) => (resolve, reject) => {
    const token = localStorage.getItem('pos_token')
    fetch(`${base}/api/qz-tray/sign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ request: toSign }),
    })
      .then((r) => {
        if (!r.ok) {
          return r.text().then((t) => {
            let msg = t || r.statusText
            try {
              const j = JSON.parse(t)
              if (j.error) msg = j.error
            } catch {
              /* ignore */
            }
            throw new Error(msg)
          })
        }
        return r.text()
      })
      .then(resolve)
      .catch(reject)
  })
  _qzSecurityConfigured = true
}

/**
 * QZ Tray’s IBM864 path uses Bidi + ICU ArabicShaping on any chunk containing non–Latin-1
 * characters; tashkeel (combining diacritics) on product names often triggers
 * "Cannot parse (PLAIN)… into a raw COMMAND command: Input length = 1".
 * Removing Unicode combining marks (Mc, Me, Mn) keeps letters readable and avoids that failure.
 */
function stripThermalCombiningMarks(value) {
  if (value == null || value === '') return ''
  try {
    return String(value).normalize('NFC').replace(/\p{M}+/gu, '')
  } catch {
    return String(value)
  }
}

/** True if QZ print failed in a way that may be fixed by Cp1256 (skips IBM864 shaping). */
function isQzThermalEncodingFailure(err) {
  const msg = err?.message || String(err)
  return /cannot parse\s*\(plain\)|arabicshaping/i.test(msg)
}

// Arabic labels (bilingual receipt) — UTF-8; QZ Tray converts to IBM864 when encoding set
const AR = {
  grandTotal: '\u0627\u0644\u0645\u062C\u0645\u0648\u0639 \u0627\u0644\u0625\u062C\u0645\u0627\u0644\u064A', // المجموع الإجمالي
  discount: '\u062E\u0635\u0645', // خصم
  netTotal: '\u0635\u0627\u0641\u064A \u0645\u062C\u0645\u0648\u0639', // صافي مجموع
  cash: '\u0646\u0642\u062F', // نقد
  change: '\u062A\u063A\u064A\u064A\u0631', // تغيير
  cashierName: '\u0627\u0633\u0645 \u0623\u0645\u064A\u0646 \u0627\u0644\u0635\u0646\u062F\u0648\u0642', // اسم أمين الصندوق
  thankYou: '\u0634\u0643\u0631\u0627 \u0644\u0643 \u0639\u0644\u0649 \u0627\u0644\u062A\u0633\u0648\u0642', // شكرا لك على التسوق
}

/**
 * Pad string to width
 */
function pad(str, width, align = 'left') {
  const s = String(str ?? '')
  if (s.length >= width) return s.slice(0, width)
  const padLen = width - s.length
  if (align === 'right') return ' '.repeat(padLen) + s
  return s + ' '.repeat(padLen)
}

function dashedLine(len, maxW = RECEIPT_WIDTH) {
  const cap = maxW ?? RECEIPT_WIDTH
  const n = len == null ? cap : Math.min(len, cap)
  return '-'.repeat(n) + LF
}

/**
 * CODE128 barcode of bill number as ESC/POS raster via QZ Tray (raw image).
 */
async function createBillNoBarcodeQzImage(billNo, profile = DEFAULT_THERMAL_PROFILE) {
  const text = String(billNo ?? '').trim() || '0'
  const largeBc = profile?.barcode === 'large'
  const cacheKey = largeBc ? `${text}\0L` : text
  const cached = _billNoBarcodeCache.get(cacheKey)
  if (cached) return cached

  const canvas = document.createElement('canvas')
  JsBarcode(canvas, text, {
    format: 'CODE128',
    width: largeBc ? 3 : 2,
    height: largeBc ? 72 : 56,
    displayValue: true,
    margin: largeBc ? 8 : 6,
    fontSize: largeBc ? 14 : 12,
    textMargin: largeBc ? 5 : 4,
  })
  const dataUrl = canvas.toDataURL('image/png')
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
  const chunk = {
    type: 'raw',
    format: 'image',
    flavor: 'base64',
    data: base64,
    options: {
      language: 'ESCPOS',
      dotDensity: 'double',
    },
  }
  if (_billNoBarcodeCache.size >= BARCODE_CACHE_MAX) {
    const oldest = _billNoBarcodeCache.keys().next().value
    if (oldest != null) _billNoBarcodeCache.delete(oldest)
  }
  _billNoBarcodeCache.set(cacheKey, chunk)
  return chunk
}

/**
 * Raster for receipt header logo (QZ ESC/POS). Cached after first successful load.
 * Dark-on-black PNGs are inverted + thresholded so they read on white thermal paper.
 */
async function createReceiptHeaderLogoQzImage() {
  if (_receiptHeaderLogoChunkPromise) return _receiptHeaderLogoChunkPromise

  _receiptHeaderLogoChunkPromise = (async () => {
    const res = await fetch(RECEIPT_HEADER_LOGO_URL, { cache: 'force-cache' })
    if (!res.ok) throw new Error(`Header logo fetch failed: ${res.status}`)
    const blob = await res.blob()
    const bmp = await createImageBitmap(blob).catch(() => null)

    let srcW
    let srcH
    /** @type {CanvasImageSource | null} */
    let source = bmp
    if (!bmp) {
      const url = URL.createObjectURL(blob)
      const img = new Image()
      try {
        await new Promise((resolve, reject) => {
          img.onload = resolve
          img.onerror = () => reject(new Error('Header logo decode failed'))
          img.src = url
        })
        srcW = img.naturalWidth
        srcH = img.naturalHeight
        source = img
      } finally {
        URL.revokeObjectURL(url)
      }
    } else {
      srcW = bmp.width
      srcH = bmp.height
    }

    if (!srcW || !srcH || !source) throw new Error('Header logo has no dimensions')

    const scale = Math.min(1, RECEIPT_LOGO_MAX_WIDTH / srcW, RECEIPT_LOGO_MAX_HEIGHT / srcH)
    const w = Math.max(8, Math.round((srcW * scale) / 8) * 8)
    const h = Math.max(8, Math.round(srcH * (w / srcW)))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Header logo: no canvas context')

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(source, 0, 0, w, h)
    bmp?.close?.()

    const id = ctx.getImageData(0, 0, w, h)
    const d = id.data
    let cornerL = 0
    const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4]
    for (const i of corners) {
      cornerL += (d[i] + d[i + 1] + d[i + 2]) / 3
    }
    cornerL /= 4
    const darkBackdrop = cornerL < 55
    for (let i = 0; i < d.length; i += 4) {
      let L = (d[i] + d[i + 1] + d[i + 2]) / 3
      if (darkBackdrop) L = 255 - L
      const out = L > 200 ? 255 : 0
      d[i] = d[i + 1] = d[i + 2] = out
      d[i + 3] = 255
    }
    ctx.putImageData(id, 0, 0)

    const dataUrl = canvas.toDataURL('image/png')
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    return {
      type: 'raw',
      format: 'image',
      flavor: 'base64',
      data: base64,
      options: {
        language: 'ESCPOS',
        dotDensity: 'double',
      },
    }
  })().catch((e) => {
    _receiptHeaderLogoChunkPromise = null
    throw e
  })

  return _receiptHeaderLogoChunkPromise
}

function pushReceiptHeaderLogoEscPos(lines, logoChunk) {
  if (!logoChunk) return
  lines.push(CENTER)
  lines.push(logoChunk)
}

/**
 * One line: English label left, Arabic + amount right (uses full line width `maxW`)
 */
function lineEnArAmount(english, arabic, amountStr, maxW = RECEIPT_WIDTH) {
  const leftW = Math.min(22, Math.max(12, Math.floor(maxW * 0.46)))
  const rightW = maxW - leftW
  const rightPart = arabic ? `${arabic} ${amountStr}` : amountStr
  const right = rightPart.length > rightW ? rightPart.slice(-rightW) : rightPart
  return pad(english.slice(0, leftW), leftW) + pad(right, rightW, 'right') + LF
}

/**
 * Parse a monetary or numeric value from API/localStorage (handles strings, commas).
 */
function parseReceiptAmount(v) {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const s = String(v).trim().replace(/,/g, '')
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : 0
}

/** Two-decimal amount string for thermal lines; never "NaN". */
function formatReceiptAmount2(v) {
  const n = Math.round(parseReceiptAmount(v) * 100) / 100
  return n.toFixed(2)
}

function _isPlainObject(o) {
  return Boolean(o) && typeof o === 'object' && !Array.isArray(o)
}

/**
 * Merge nested summary objects (some gateways wrap the payload).
 * Outer envelope last must NOT win over nested totals — use `{ ...data, ...nest }` so
 * e.g. `{ totalSales: 0, data: { totalSales: 150 } }` resolves to 150.
 */
function cashDrawerKickEscPos() {
  if (typeof localStorage === 'undefined') return null
  const en = localStorage.getItem(DRAWER_ENABLE_KEY)
  if (en === '0' || en === 'false') return null
  const pin = localStorage.getItem(DRAWER_PIN_KEY) === '1' ? 1 : 0
  return escPosDrawerKick(pin)
}

/**
 * Whether to send a drawer kick with this receipt (respects Settings + payment).
 * Pass openCashDrawer: false from reprints. Omit or use payment inference for checkout.
 */
function shouldOpenCashDrawerForReceipt(receiptData) {
  if (!receiptData || typeof receiptData !== 'object') return false
  if (typeof localStorage !== 'undefined') {
    const en = localStorage.getItem(DRAWER_ENABLE_KEY)
    if (en === '0' || en === 'false') return false
  }
  if (receiptData.openCashDrawer === false) return false
  if (receiptData.openCashDrawer === true) return true
  const pm = String(receiptData.paymentMethod || 'cash').toLowerCase()
  if (pm === 'credit') return false
  if (pm === 'split') return parseReceiptAmount(receiptData.cashAmount) > 0
  return true
}

export function mergeCounterCloseSource(data) {
  if (!data || typeof data !== 'object') return {}
  const nest =
    (_isPlainObject(data.summary) && data.summary) ||
    (_isPlainObject(data.totals) && data.totals) ||
    (_isPlainObject(data.result) && data.result) ||
    (_isPlainObject(data.data) && data.data) ||
    null
  return nest ? { ...data, ...nest } : { ...data }
}

/** First present key wins; then parse as money (never NaN). */
function amountFromRow(row, keys) {
  if (!row || typeof row !== 'object') return 0
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, k)) continue
    const v = row[k]
    if (v !== undefined && v !== null && v !== '') return parseReceiptAmount(v)
  }
  return 0
}

/**
 * One line: label left, value right – uses full line width `maxW`.
 * Value column grows with content (up to max) so amounts are not left-truncated.
 */
function lineLabelValue(label, value, maxW = RECEIPT_WIDTH) {
  const valueStr = String(value ?? '')
  const minLabelChars = 8
  const maxValueW = maxW - minLabelChars
  const valW = Math.min(Math.max(valueStr.length, 12), maxValueW)
  const labelW = maxW - valW
  const labStr = label.slice(0, labelW)
  const valCell =
    valueStr.length <= valW ? pad(valueStr, valW, 'right') : pad(valueStr.slice(-valW), valW, 'right')
  return pad(labStr, labelW) + valCell + LF
}

/**
 * Same top block as sales receipt: fixed location line, optional telephone, dashed line.
 */
function pushLocationHeaderEscPos(
  lines,
  _locationHeading,
  locationTelephone,
  maxW = RECEIPT_WIDTH,
  detailFont = FONT_SMALL
) {
  lines.push(CENTER)
  lines.push(detailFont)
  lines.push(stripThermalCombiningMarks(RECEIPT_LOCATION_LINE).slice(0, maxW) + LF)
  const tel = stripThermalCombiningMarks(String(locationTelephone ?? '').trim())
  if (tel) {
    lines.push(tel.slice(0, maxW) + LF)
  }
  lines.push(dashedLine(undefined, maxW))
}

/**
 * Hold / suspend slip — same header as receipt, then ** BILL ON HOLD ***, Bill No, User,
 * Location Code, Counter, Date, Time, total (optional), bill barcode, dashed line, cut.
 */
async function buildEscPosHoldSlip(data, encoding = 'IBM864', headerLogoChunk = null, profile = DEFAULT_THERMAL_PROFILE) {
  const w = profile.receiptWidth
  const detailFont = profile.bodyFont === 'normal' ? FONT_NORMAL : FONT_SMALL
  const {
    billNo,
    date = new Date(),
    locationCode = '',
    locationName = '',
    locationTelephone = '',
    branchName = '',
    counterCode = '',
    counterName = '',
    userName = '',
    /** true = Suspend bill slip; false = Hold bill slip */
    suspend = false,
    /** Cart total (same sense as POS); shown as QAR on slip when finite */
    totalAmount,
  } = data

  const d = date instanceof Date ? date : new Date(date)
  const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/\s/g, ' ')
  const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).toLowerCase()

  const lines = []
  lines.push(INIT)
  if (encoding === 'IBM864') {
    lines.push(ARABIC_CODEPAGE)
  }
  pushReceiptHeaderLogoEscPos(lines, headerLogoChunk)
  pushLocationHeaderEscPos(lines, '', locationTelephone, w, detailFont)
  lines.push(CENTER)
  lines.push(detailFont)
  lines.push(BOLD_ON)
  lines.push((suspend ? '** BILL SUSPENDED ***' : '** BILL ON HOLD ***') + LF)
  lines.push(BOLD_OFF)
  lines.push(LF)
  lines.push(LEFT)
  lines.push(detailFont)
  lines.push(lineLabelValue('Bill No', String(billNo ?? ''), w))
  lines.push(
    lineLabelValue('User', stripThermalCombiningMarks((userName || '--').toString()).slice(0, 22), w)
  )
  const counterLine =
    stripThermalCombiningMarks([counterCode, counterName].filter(Boolean).join(' ').trim()) || '--'
  lines.push(lineLabelValue('Counter', counterLine.slice(0, w), w))
  lines.push(lineLabelValue('Date', dateStr, w))
  lines.push(lineLabelValue('Time', timeStr, w))
  const totalNum = Number(totalAmount)
  if (Number.isFinite(totalNum)) {
    lines.push(lineLabelValue('Total', 'QAR ' + formatReceiptAmount2(Math.abs(totalNum)), w))
  }
  lines.push(LF)
  lines.push(CENTER)
  lines.push(detailFont)
  try {
    lines.push(await createBillNoBarcodeQzImage(billNo, profile))
  } catch (e) {
    console.warn('[ThermalPrint] Hold slip barcode skipped:', e)
    lines.push(String(billNo ?? '') + LF)
  }
  lines.push(LF)
  lines.push(LEFT)
  lines.push(dashedLine(undefined, w))
  lines.push(LF + LF + LF + LF)
  lines.push(CUT)
  return lines
}

/**
 * Build ESC/POS receipt – bilingual design (English / Arabic)
 * @param {object|null} headerLogoChunk - QZ raw image chunk from {@link createReceiptHeaderLogoQzImage}; optional
 * @param {ThermalProfile} [profile]
 */
function buildEscPosReceipt(data, encoding = 'IBM864', headerLogoChunk = null, profile = DEFAULT_THERMAL_PROFILE) {
  const w = profile.receiptWidth
  const bodyFontCmd = profile.bodyFont === 'normal' ? FONT_NORMAL : FONT_SMALL
  const detailFont = bodyFontCmd
  const {
    billNo,
    date = new Date(),
    locationCode = '',
    locationName = '',
    // From LOCATIONMASTER (TELEPHONE / MOBILE), under location line
    locationTelephone = '',
    counterCode = '',
    counterName = '',
    userName = '',
    customerName = '',
    branchName = '',
    items = [],
    subtotal = 0,
    total = 0,
    discount = 0,
    totalPoints = 0,
    paymentMethod = 'cash',
    cashAmount,
    cardAmount,
    amountTendered = 0,
    change = 0,
    isSalesReturn = false,
    /** true = show “COPY PRINT” banner at top (e.g. Dashboard reprint) */
    copyPrintHeading = false,
    channelDescription = '',
    orderNo = '',
    salesChannel = null,
  } = data

  const resolvedChannelDescription =
    String(
      channelDescription ||
        data?.channel_description ||
        data?.CHANNELDESCRIPTION ||
        (salesChannel ? getSalesChannelDescription(salesChannel) : '')
    ).trim()
  const isOnlineSale =
    isOnlineSalesChannel(resolvedChannelDescription) || isOnlineSalesChannel(salesChannel)
  const orderNoDisplay =
    orderNo != null && String(orderNo).trim() !== '' ? String(orderNo).trim() : '--'

  const d = date instanceof Date ? date : new Date(date)
  const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/\s/g, ' ')
  const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).toLowerCase()

  const netTotal = total - (Number(discount) || 0)

  const lines = []

  lines.push(INIT)
  if (encoding === 'IBM864') {
    lines.push(ARABIC_CODEPAGE)
  }
  pushReceiptHeaderLogoEscPos(lines, headerLogoChunk)
  if (copyPrintHeading) {
    lines.push(CENTER)
    lines.push(FONT_NORMAL)
    lines.push(BOLD_ON)
    lines.push('COPY PRINT'.slice(0, w) + LF)
    lines.push(BOLD_OFF)
    lines.push(LF)
  }
  pushLocationHeaderEscPos(lines, '', locationTelephone, w, detailFont)
  lines.push(CENTER)  // center all body content

  // ----- BODY: Font B (small) or Font A (normal / larger on narrow POS drivers) -----
  lines.push(bodyFontCmd)
  const SP = ' '
  const colSlNo = 4
  const colQty = w >= 48 ? 6 : 5
  const colRate = w >= 48 ? 6 : 5
  const colAmt = w >= 48 ? 6 : 5
  const colItemName = Math.max(12, w - colSlNo - colQty - colRate - colAmt - 4)
  const headerRow = pad('Sl.No', colSlNo) + SP + pad('Item Name', colItemName) + SP + pad('Qty', colQty, 'right') + SP + pad('Rate', colRate, 'right') + SP + pad('Amount', colAmt, 'right')
  lines.push(headerRow.slice(0, w) + LF)
  lines.push(dashedLine(undefined, w))

  const getManufactureId = (item) => String(
    item?.manufactureId ??
    item?.MANUFACTUREID ??
    item?.manufactureid ??
    item?.MANUFACTURERID ??
    item?.manufacturerId ??
    item?.manufacturerid ??
    ''
  ).trim()
  const getItemName = (item) => (item?.name ?? item?.ITEMNAME ?? item?.itemname ?? '').toString().trim()
  const getItemDetails = (item) => (item?.details ?? item?.DETAILS ?? item?.size ?? item?.SIZE ?? item?.pack ?? '').toString().trim()
  const getItemNameAr = (item) => (item?.nameAr ?? item?.NAME_AR ?? item?.itemname_ar ?? item?.itemNameAra ?? item?.ITEMNAMEARA ?? '').toString().trim()

  items.forEach((item, idx) => {
    const slNo = idx + 1
    const manufId = stripThermalCombiningMarks(getManufactureId(item))
    const name = stripThermalCombiningMarks(getItemName(item))
    const details = stripThermalCombiningMarks(getItemDetails(item))
    const nameAr = stripThermalCombiningMarks(getItemNameAr(item))
    const qty = Number(item.quantity) || 0
    const rate = Number(item.price) || 0
    const amt = qty * rate
    const qtyStr = qty.toFixed(3)
    const rateStr = rate.toFixed(2)
    const amtStr = amt.toFixed(2)
    // First line: Sl.No | Item Name column = manufactureId | Qty | Rate | Amount
    const row1 = pad(String(slNo), colSlNo) + SP + pad(manufId.slice(0, colItemName), colItemName) + SP + pad(qtyStr, colQty, 'right') + SP + pad(rateStr, colRate, 'right') + SP + pad(amtStr, colAmt, 'right')
    lines.push(row1.slice(0, w) + LF)
    // Subsequent lines (name / details / Arabic name) span the full receipt width.
    // Indent under the Item Name column and wrap long text instead of truncating it.
    const textIndent = colSlNo + SP.length
    const textWidth = Math.max(1, w - textIndent)
    const indentStr = pad('', colSlNo) + SP
    const wrapToWidth = (text, width) => {
      const out = []
      const words = String(text).split(/\s+/).filter(Boolean)
      let cur = ''
      for (const word of words) {
        if (word.length > width) {
          if (cur) { out.push(cur); cur = '' }
          for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width))
          continue
        }
        const candidate = cur ? cur + ' ' + word : word
        if (candidate.length > width) {
          out.push(cur)
          cur = word
        } else {
          cur = candidate
        }
      }
      if (cur) out.push(cur)
      return out.length ? out : ['']
    }
    const pushFullWidthText = (text) => {
      const segments = wrapToWidth(text, textWidth)
      for (const seg of segments) {
        lines.push((indentStr + seg).slice(0, w) + LF)
      }
    }
    if (name) pushFullWidthText(name)
    if (details) pushFullWidthText(details)
    if (nameAr) {
      pushFullWidthText(nameAr)
      lines.push(LF)           // break after Arabic name
    }
  })

  lines.push(dashedLine(undefined, w))
  lines.push(LF)

  // ----- SUMMARY -----
  lines.push(lineEnArAmount('Grand Total', AR.grandTotal, 'QAR ' + total.toFixed(2), w))
  lines.push(lineEnArAmount('Discount', AR.discount, 'QAR ' + (Number(discount) || 0).toFixed(2), w))
  lines.push(lineEnArAmount('Net Total', AR.netTotal, 'QAR ' + netTotal.toFixed(2), w))
  lines.push(dashedLine(undefined, w))
  const pmNorm = String(paymentMethod || 'cash').toLowerCase()
  if (pmNorm === 'split' && (Number(cashAmount) > 0 || Number(cardAmount) > 0)) {
    lines.push(lineEnArAmount('Cash paid', AR.cash, (Number(cashAmount) || 0).toFixed(2), w))
    lines.push(lineEnArAmount('Card', '', (Number(cardAmount) || 0).toFixed(2), w))
  } else {
    lines.push(lineEnArAmount('Qatar Riyals QAR', AR.cash, amountTendered.toFixed(2), w))
  }
  lines.push(lineEnArAmount('Change Qatar Riyals QAR', AR.change, change.toFixed(2), w))
  lines.push(LF)

  // ----- TRANSACTION DETAILS -----
  lines.push(dashedLine(undefined, w))
  lines.push(CENTER)  // content centered on receipt
  lines.push(
    (customerName
      ? `Customer : ${stripThermalCombiningMarks(customerName)}`
      : 'Customer : --') + LF
  )
  const pmDisplay =
    pmNorm === 'cash'
      ? 'Cash'
      : pmNorm === 'split'
        ? 'Cash + Card'
        : pmNorm === 'card'
          ? 'Card'
          : String(paymentMethod || 'card')
  lines.push(lineLabelValue('Payment Type', pmDisplay, w))
  if (isOnlineSale) {
    lines.push(lineLabelValue('Sales Channel', 'Online', w))
    lines.push(lineLabelValue('Order No', orderNoDisplay, w))
  }
  lines.push(lineLabelValue('Total Points', (Number(totalPoints) || 0).toFixed(3), w))
  lines.push(
    lineLabelValue('Served By : ' + stripThermalCombiningMarks((userName || '--').toString()), AR.cashierName, w)
  )
  lines.push(LF)

  // Receipt | Date | Time | POS – full width (Adler Font A: wider Date/Time so values are not truncated)
  const isAdlerLayout = w === RECEIPT_WIDTH_FONT_A_80MM
  const colR = isAdlerLayout ? 8 : Math.floor(w / 4)
  const colD = isAdlerLayout ? 12 : colR
  const colT = isAdlerLayout ? 12 : colR
  const colP = w - colR - colD - colT
  lines.push(pad('Receipt', colR) + pad('Date', colD) + pad('Time', colT) + pad('POS', colP, 'right') + LF)
  lines.push(pad(String(billNo), colR) + pad(dateStr, colD) + pad(timeStr, colT) + pad(counterCode || 'CNT01', colP, 'right') + LF)
  lines.push(LF)

  // ----- FOOTER -----
  lines.push(dashedLine(undefined, w))
  lines.push(CENTER)
  lines.push(AR.thankYou + LF)
  lines.push(LF)  // break line, next line below
  lines.push('Thank you for shopping' + LF)
  lines.push('Please keep your receipt in case of exchange or return.' + LF)
  lines.push('Terms & Conditions Apply' + LF)

  return lines
}

/**
 * Date like 25/Mar/2026 for counter closing title lines
 */
function formatCounterCloseDate(isoDate) {
  if (!isoDate) return ''
  const parts = String(isoDate).trim().split('-')
  if (parts.length < 3) return String(isoDate)
  const y = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  const day = parseInt(parts[2], 10)
  if (!y || !m || !day) return String(isoDate)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${String(day).padStart(2, '0')}/${months[m - 1]}/${y}`
}

function shortDashLine(len = 22, maxW = RECEIPT_WIDTH) {
  const n = Math.min(Math.max(len, 8), maxW)
  return '-'.repeat(n) + LF
}

function pushSectionHeading(lines, title, maxW = RECEIPT_WIDTH, sectionFont = FONT_SMALL) {
  lines.push(LEFT)
  lines.push(sectionFont)
  lines.push(title + LF)
  lines.push(shortDashLine(Math.min(title.length + 6, maxW), maxW))
}

/**
 * ESC/POS counter closing slip — layout matches thermal “Counter Closing” report
 */
export function buildEscPosCounterCloseReport(
  data,
  encoding = 'IBM864',
  headerLogoChunk = null,
  profile = DEFAULT_THERMAL_PROFILE
) {
  const w = profile.receiptWidth
  const bodyFontCmd = profile.bodyFont === 'normal' ? FONT_NORMAL : FONT_SMALL
  const row = mergeCounterCloseSource(data)
  const {
    date = '',
    counterCode = '',
    locationCode = '',
    locationName = '',
    branchName = '',
    locationTelephone = '',
    cashierDisplay = '',
    cardByType = null,
    cashInBox = null,
    /** 'check' = pre-close time-check copy; 'final' = official slip after Close */
    slipKind = 'final',
  } = row

  const totalSales = amountFromRow(row, ['totalSales', 'total_sales', 'TOTALSALES'])
  const totalReturns = amountFromRow(row, ['totalReturns', 'total_returns', 'TOTALRETURNS'])
  const netTotal = amountFromRow(row, ['netTotal', 'net_total', 'NETTOTAL'])
  const totalCardAmount = amountFromRow(row, ['totalCardAmount', 'total_card_amount', 'TOTALCARDAMOUNT'])
  const totalCardReturns = amountFromRow(row, ['totalCardReturns', 'total_card_returns'])
  const discountTotal = amountFromRow(row, ['discountTotal', 'discount_total', 'DISCOUNTTOTAL'])
  const creditTotal = amountFromRow(row, ['creditTotal', 'credit_total', 'CREDITTOTAL'])
  /** Credit customer return total (TBLCREDITSETTLEMENT on sales-return bills). */
  const crReconciled = amountFromRow(row, [
    'crReconciled',
    'cr_reconciled',
    'creditReturnTotal',
    'credit_return_total',
    'CREDITRETURNTOTAL',
  ])
  const voucherTotal = amountFromRow(row, ['voucherTotal', 'voucher_total', 'VOUCHERTOTAL'])
  const onlineTotal = amountFromRow(row, ['onlineTotal', 'online_total', 'ONLINETOTAL'])

  const lines = []
  lines.push(INIT)
  if (encoding === 'IBM864') {
    lines.push(ARABIC_CODEPAGE)
  }
  pushReceiptHeaderLogoEscPos(lines, headerLogoChunk)
  pushLocationHeaderEscPos(lines, '', locationTelephone, w, bodyFontCmd)
  if (encoding === 'IBM864') {
    lines.push(LATIN_CODEPAGE_PC437)
  }

  const closeDateStr = formatCounterCloseDate(date)
  const isCheckCopy = slipKind === 'check'
  lines.push(CENTER)
  lines.push(FONT_NORMAL)
  lines.push(BOLD_ON)
  lines.push((isCheckCopy ? '*** TIME CHECK COPY ***' : '*** FINAL CLOSE ***').slice(0, w) + LF)
  lines.push(BOLD_OFF)
  lines.push(bodyFontCmd)
  if (isCheckCopy) {
    lines.push('Pre-close verification (not final)' + LF)
  }
  lines.push('Counter day : ' + closeDateStr + LF)
  lines.push(dashedLine(undefined, w))

  lines.push(LEFT)
  lines.push(bodyFontCmd)
  const closingAt = new Date()
  const closingDatePart = formatCounterCloseDate(date)
  const closingClock = closingAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })

  lines.push(lineLabelValue('Counter', stripThermalCombiningMarks(String(counterCode || '—')), w))
  const cashierLine = stripThermalCombiningMarks(String(cashierDisplay ?? '').trim())
  if (cashierLine) lines.push(lineLabelValue('Cashier', cashierLine.slice(0, 22), w))
  lines.push(
    ((isCheckCopy ? 'Check time : ' : 'Closing time : ') + closingDatePart + ' ' + closingClock).slice(0, w) + LF
  )

  lines.push(LF)
  lines.push(lineLabelValue('Total Sales', formatReceiptAmount2(totalSales), w))
  lines.push(lineLabelValue('Sales returns', formatReceiptAmount2(totalReturns), w))
  lines.push(lineLabelValue('Net total', formatReceiptAmount2(netTotal), w))
  lines.push(lineLabelValue('Discount (lines)', formatReceiptAmount2(discountTotal), w))
  lines.push(lineLabelValue('Credit on account', formatReceiptAmount2(creditTotal), w))
  lines.push(lineLabelValue('Online', formatReceiptAmount2(onlineTotal), w))

  lines.push(LF)
  pushSectionHeading(lines, 'Card Details', w, bodyFontCmd)
  const cardMap = cardByType && typeof cardByType === 'object' ? cardByType : {}
  const cardKeys = Object.keys(cardMap)
  if (cardKeys.length > 0) {
    cardKeys.sort().forEach((k) => {
      lines.push(lineLabelValue(stripThermalCombiningMarks(k), formatReceiptAmount2(cardMap[k]), w))
    })
  } else if (parseReceiptAmount(totalCardAmount) > 0) {
    lines.push(lineLabelValue('CARD', formatReceiptAmount2(totalCardAmount), w))
  }

  lines.push(LF)
  pushSectionHeading(lines, 'Gift Voucher Details', w, bodyFontCmd)
  lines.push(lineLabelValue('VOUCHER', formatReceiptAmount2(voucherTotal), w))

  lines.push(LF)
  pushSectionHeading(lines, 'Currency Details', w, bodyFontCmd)
  lines.push(LF)
  pushSectionHeading(lines, 'No.Of Telephone Cards', w, bodyFontCmd)

  lines.push(LF)
  lines.push(lineLabelValue('Cr.Reconcilled', formatReceiptAmount2(crReconciled), w))
  lines.push(dashedLine(undefined, w))

  // Cash in box: from API (per-bill NET-CARD sums minus credit & voucher) or fallback formula
  const cashInBoxStr = cashInBox == null ? '' : String(cashInBox).trim().replace(/,/g, '')
  const canUseApiCash =
    cashInBox !== undefined &&
    cashInBox !== null &&
    cashInBoxStr !== '' &&
    Number.isFinite(parseFloat(cashInBoxStr))
  const cash = canUseApiCash
    ? parseReceiptAmount(cashInBox)
    : parseReceiptAmount(netTotal) -
      parseReceiptAmount(totalCardAmount) +
      parseReceiptAmount(totalCardReturns) -
      parseReceiptAmount(creditTotal) -
      parseReceiptAmount(voucherTotal)
  lines.push(BOLD_ON)
  lines.push(lineLabelValue('Cash in Box', formatReceiptAmount2(cash), w))
  lines.push(BOLD_OFF)
  lines.push(bodyFontCmd)
  lines.push(
    (
      'Cash = cash from bills (net - card) - credit - voucher'
    ).slice(0, w) + LF
  )
  lines.push(dashedLine(undefined, w))
  if (isCheckCopy) {
    lines.push(CENTER)
    lines.push(bodyFontCmd)
    lines.push('Use Close for official final print.' + LF)
    lines.push(LF)
  }

  lines.push(LF + LF + LF + LF)
  if (slipKind === 'final') {
    const drawerKick = cashDrawerKickEscPos()
    if (drawerKick) {
      lines.push(drawerKick)
    }
  }
  lines.push(CUT)
  return lines
}

/**
 * Print counter close summary to thermal printer via QZ Tray.
 */
export async function printCounterCloseReport(reportData) {
  if (typeof window === 'undefined') return

  try {
    const qz = await loadQzTrayModule()
    if (!qz) throw new Error('QZ Tray not available')

    await ensureQzSecurity(qz)
    try {
      await qz.websocket.connect({ retries: 2, delay: 1 })
    } catch (connErr) {
      if (!connErr?.message?.includes('already exists')) throw connErr
    }

    const logoPromise = createReceiptHeaderLogoQzImage().catch((e) => {
      console.warn('[ThermalPrint] Counter close header logo skipped:', e)
      return null
    })
    const [printerName, headerLogoChunk] = await Promise.all([resolvePrinterName(qz), logoPromise])
    let encoding = localStorage.getItem(ENCODING_KEY) || 'IBM864'
    const pl = String(printerName).toLowerCase()
    const isEpsonFamily = pl.includes('epson') || pl.includes('tm')

    const counterCloseConfig = (enc) =>
      qz.configs.create(printerName, {
        encoding: enc,
        ...(isEpsonFamily ? {} : { forceRaw: true }),
      })

    const profile = getThermalProfileFromPrinterName(printerName)
    const printCounterCloseOnce = async (enc) => {
      const payload = buildEscPosCounterCloseReport(reportData, enc, headerLogoChunk, profile)
      await qz.print(counterCloseConfig(enc), payload)
    }

    try {
      await printCounterCloseOnce(encoding)
    } catch (printErr) {
      if (encoding === 'IBM864' && isQzThermalEncodingFailure(printErr)) {
        console.warn('[ThermalPrint] Retrying counter close with Cp1256 after IBM864 failure:', printErr)
        await printCounterCloseOnce('Cp1256')
      } else {
        throw printErr
      }
    }
    console.info('[ThermalPrint] Counter close report printed')
  } catch (err) {
    console.error('[ThermalPrint] Counter close print failed:', err)
    const msg = err?.message || String(err)
    if (msg.includes('Connection refused') || msg.includes('Unable to establish')) {
      throw new Error('QZ Tray is not running. Please start QZ Tray from https://qz.io/')
    }
    if (msg.includes('No printers')) {
      throw new Error('No printers found. Connect a USB thermal printer and try again.')
    }
    if (msg.includes('Failed to sign request') || msg.includes('Signing failed')) {
      throw new Error('QZ signing failed. Ensure backend has backend/certs/private-key.pem and pip install cryptography.')
    }
    throw err
  }
}

function pickPreferredThermalPrinter(all) {
  if (!all || all.length === 0) {
    throw new Error('No printers found. Please connect a USB thermal printer.')
  }
  const keywords = [
    'POS',
    'Receipt',
    'TM-',
    'TM88',
    'TM-T',
    'Epson',
    'Adler',
    'Star',
    'Citizen',
    'Bixolon',
    'thermal',
  ]
  for (const kw of keywords) {
    const found = all.find((p) => String(p).toLowerCase().includes(kw.toLowerCase()))
    if (found) return found
  }
  return all[0]
}

/**
 * Resolve printer name: from localStorage, or find by common thermal printer keywords
 */
async function resolvePrinterName(qz) {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(PRINTER_KEY) : null
  if (saved && saved.trim()) {
    return saved.trim()
  }
  const now = Date.now()
  if (
    _printerListCache.names &&
    Array.isArray(_printerListCache.names) &&
    _printerListCache.names.length > 0 &&
    now < _printerListCache.expires
  ) {
    return pickPreferredThermalPrinter(_printerListCache.names)
  }
  const all = (await qz.printers.find()) || []
  _printerListCache = { names: all, expires: now + PRINTER_LIST_CACHE_MS }
  return pickPreferredThermalPrinter(all)
}

/**
 * Print receipt to USB thermal printer via QZ Tray.
 * @param {Object} receiptData - Receipt payload (billNo, items, total, etc.)
 * @returns {Promise<void>}
 */
export async function printReceipt(receiptData) {
  if (typeof window === 'undefined') return

  try {
    const qz = await loadQzTrayModule()
    if (!qz) throw new Error('QZ Tray not available')

    await ensureQzSecurity(qz)
    // Connect (or use existing connection - connect throws "already exists" when active)
    try {
      await qz.websocket.connect({ retries: 2, delay: 1 })
    } catch (connErr) {
      if (!connErr?.message?.includes('already exists')) throw connErr
      // Already connected (e.g. from Settings/PrinterSettings), proceed
    }

    const savedPrinter =
      typeof localStorage !== 'undefined' ? localStorage.getItem(PRINTER_KEY)?.trim() : ''
    let encoding = localStorage.getItem(ENCODING_KEY) || 'IBM864'

    const logoPromise = createReceiptHeaderLogoQzImage().catch((e) => {
      console.warn('[ThermalPrint] Receipt header logo skipped:', e)
      return null
    })
    const printerPromise = savedPrinter ? Promise.resolve(savedPrinter) : resolvePrinterName(qz)
    const [printerName, headerLogoChunk] = await Promise.all([printerPromise, logoPromise])
    const profile = getThermalProfileFromPrinterName(printerName)
    const barcodeBodyFont = profile.bodyFont === 'normal' ? FONT_NORMAL : FONT_SMALL
    const barcodeChunk = await createBillNoBarcodeQzImage(receiptData.billNo, profile).catch((e) => {
      console.warn('[ThermalPrint] Receipt barcode skipped:', e)
      return null
    })

    const drawerKick = shouldOpenCashDrawerForReceipt(receiptData) ? cashDrawerKickEscPos() : null
    const barcodeBlock = barcodeChunk
      ? [CENTER, barcodeBodyFont, barcodeChunk, LF]
      : ['*' + String(receiptData.billNo ?? '').padStart(12, '0') + '*' + LF, LF]
    const feedBeforeCut = [LF + LF + LF + LF]

    /** Match backend / API: treat only explicit true-ish as sales return (avoid truthy string "false"). */
    const isSalesReturnReceipt = [true, 'true', '1', 1].includes(receiptData?.isSalesReturn)
    const isCreditReceipt = String(receiptData?.paymentMethod || '').toLowerCase() === 'credit'
    const printTwoCopies = isSalesReturnReceipt || isCreditReceipt

    const pl = String(printerName).toLowerCase()
    const isEpsonFamily = pl.includes('epson') || pl.includes('tm')

    const buildReceiptPrintData = (enc) => {
      const lines = buildEscPosReceipt(receiptData, enc, headerLogoChunk, profile)
      const oneReceipt = (withDrawerKick) => [
        ...lines,
        ...barcodeBlock,
        ...feedBeforeCut,
        ...(withDrawerKick && drawerKick ? [drawerKick] : []),
        CUT,
      ]
      return printTwoCopies
        ? [...oneReceipt(!!drawerKick), ...oneReceipt(false)]
        : oneReceipt(!!drawerKick)
    }

    const receiptConfig = (enc) =>
      qz.configs.create(printerName, {
        encoding: enc,
        ...(isEpsonFamily ? {} : { forceRaw: true }),
      })

    const printReceiptOnce = async (enc) => {
      await qz.print(receiptConfig(enc), buildReceiptPrintData(enc))
    }

    try {
      await printReceiptOnce(encoding)
    } catch (printErr) {
      if (encoding === 'IBM864' && isQzThermalEncodingFailure(printErr)) {
        console.warn('[ThermalPrint] Retrying receipt print with Cp1256 after IBM864 failure:', printErr)
        await printReceiptOnce('Cp1256')
      } else {
        throw printErr
      }
    }
    console.info(
      printTwoCopies
        ? `[ThermalPrint] ${isCreditReceipt && !isSalesReturnReceipt ? 'Credit sale' : 'Sales return'}: 2 receipt copies printed`
        : '[ThermalPrint] Receipt printed successfully'
    )
  } catch (err) {
    console.error('[ThermalPrint] Failed to print:', err)
    const msg = err?.message || String(err)
    if (msg.includes('Connection refused') || msg.includes('Unable to establish')) {
      throw new Error('QZ Tray is not running. Please start QZ Tray from https://qz.io/')
    }
    if (msg.includes('No printers')) {
      throw new Error('No printers found. Connect a USB thermal printer and try again.')
    }
    if (msg.includes('Failed to sign request') || msg.includes('Signing failed')) {
      throw new Error('QZ signing failed. Ensure backend has backend/certs/private-key.pem and pip install cryptography.')
    }
    throw err
  }
}

/**
 * Print hold/suspend slip (same location header as receipt, then BILL ON HOLD + metadata) via QZ Tray.
 * @param {Object} holdData - billNo, date, locationCode, locationName?, branchName?, locationTelephone?, counterCode, counterName, userName, suspend?, totalAmount?
 */
export async function printHoldSlip(holdData) {
  if (typeof window === 'undefined') return

  try {
    const qz = await loadQzTrayModule()
    if (!qz) throw new Error('QZ Tray not available')

    await ensureQzSecurity(qz)
    try {
      await qz.websocket.connect({ retries: 2, delay: 1 })
    } catch (connErr) {
      if (!connErr?.message?.includes('already exists')) throw connErr
    }

    const savedPrinter =
      typeof localStorage !== 'undefined' ? localStorage.getItem(PRINTER_KEY)?.trim() : ''
    const logoPromise = createReceiptHeaderLogoQzImage().catch((e) => {
      console.warn('[ThermalPrint] Hold slip header logo skipped:', e)
      return null
    })
    const printerPromise = savedPrinter ? Promise.resolve(savedPrinter) : resolvePrinterName(qz)
    const [printerName, headerLogoChunk] = await Promise.all([printerPromise, logoPromise])
    const profile = getThermalProfileFromPrinterName(printerName)

    let encoding = localStorage.getItem(ENCODING_KEY) || 'IBM864'
    const pl = String(printerName).toLowerCase()
    const isEpsonFamily = pl.includes('epson') || pl.includes('tm')

    const holdSlipConfig = (enc) =>
      qz.configs.create(printerName, {
        encoding: enc,
        ...(isEpsonFamily ? {} : { forceRaw: true }),
      })

    const printHoldSlipOnce = async (enc) => {
      const payload = await buildEscPosHoldSlip(holdData, enc, headerLogoChunk, profile)
      await qz.print(holdSlipConfig(enc), payload)
    }

    try {
      await printHoldSlipOnce(encoding)
    } catch (printErr) {
      if (encoding === 'IBM864' && isQzThermalEncodingFailure(printErr)) {
        console.warn('[ThermalPrint] Retrying hold slip with Cp1256 after IBM864 failure:', printErr)
        await printHoldSlipOnce('Cp1256')
      } else {
        throw printErr
      }
    }
    console.info('[ThermalPrint] Hold slip printed')
  } catch (err) {
    console.error('[ThermalPrint] Hold slip print failed:', err)
    const msg = err?.message || String(err)
    if (msg.includes('Connection refused') || msg.includes('Unable to establish')) {
      throw new Error('QZ Tray is not running. Please start QZ Tray from https://qz.io/')
    }
    if (msg.includes('No printers')) {
      throw new Error('No printers found. Connect a USB thermal printer and try again.')
    }
    if (msg.includes('Failed to sign request') || msg.includes('Signing failed')) {
      throw new Error('QZ signing failed. Ensure backend has backend/certs/private-key.pem and pip install cryptography.')
    }
    throw err
  }
}

/**
 * Set preferred receipt printer name (saved to localStorage)
 */
export function setReceiptPrinter(name) {
  invalidatePrinterListCache()
  if (name) localStorage.setItem(PRINTER_KEY, String(name).trim())
  else localStorage.removeItem(PRINTER_KEY)
}

/**
 * Get list of available printers (requires QZ Tray connection)
 */
export async function getAvailablePrinters() {
  if (typeof window === 'undefined') return []
  try {
    invalidatePrinterListCache()
    const qz = await loadQzTrayModule()
    await ensureQzSecurity(qz)
    try {
      await qz.websocket.connect({ retries: 2, delay: 1 })
    } catch (connErr) {
      if (!connErr?.message?.includes('already exists')) throw connErr
    }
    return qz.printers.find() || []
  } catch {
    return []
  }
}
