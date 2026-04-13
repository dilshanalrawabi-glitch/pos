/**
 * Thermal receipt printing via QZ Tray.
 * Prints directly to USB thermal printer without opening system print dialogs.
 * Requires QZ Tray desktop app to be running: https://qz.io/
 *
 * Signing: certificate from backend + RSA-SHA512 signatures via POST /api/qz-tray/sign
 * removes the "unrestricted website" / anonymous-site warning in QZ Tray.
 */

import { getApiBase } from '../apiBase'
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
const CUT = GS + '\x56\x00' // full cut

const PRINTER_KEY = 'pos_receipt_printer'
const ENCODING_KEY = 'pos_receipt_encoding' // 'IBM864' (default Arabic) or 'Cp1256' (Windows Arabic) — set in Settings if Arabic garbled
const RECEIPT_WIDTH = 48 // full width for 80mm paper; use 42 for 58mm

/** Register once: public cert + server-side signing (matches backend SHA-512). */
let _qzSecurityConfigured = false

async function ensureQzSecurity(qz) {
  if (_qzSecurityConfigured) return
  const base = getApiBase()
  if (!base) {
    throw new Error('API base URL not configured')
  }
  qz.security.setCertificatePromise((resolve, reject) => {
    fetch(`${base}/api/qz-tray/certificate`, { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error(`Certificate: ${r.status}`)
        return r.text()
      })
      .then(resolve)
      .catch(reject)
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

function dashedLine(len = RECEIPT_WIDTH) {
  return '-'.repeat(Math.min(len, RECEIPT_WIDTH)) + LF
}

/**
 * CODE128 barcode of bill number as ESC/POS raster via QZ Tray (raw image).
 */
async function createBillNoBarcodeQzImage(billNo) {
  const text = String(billNo ?? '').trim() || '0'
  const canvas = document.createElement('canvas')
  JsBarcode(canvas, text, {
    format: 'CODE128',
    width: 2,
    height: 56,
    displayValue: true,
    margin: 6,
    fontSize: 12,
    textMargin: 4,
  })
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
}

/**
 * One line: English label left, Arabic + amount right (uses full RECEIPT_WIDTH)
 */
function lineEnArAmount(english, arabic, amountStr) {
  const leftW = 22
  const rightW = RECEIPT_WIDTH - leftW
  const rightPart = arabic ? `${arabic} ${amountStr}` : amountStr
  const right = rightPart.length > rightW ? rightPart.slice(-rightW) : rightPart
  return pad(english.slice(0, leftW), leftW) + pad(right, rightW, 'right') + LF
}

/**
 * One line: label left, value right – uses full RECEIPT_WIDTH
 */
function lineLabelValue(label, value) {
  const valueStr = String(value)
  const valueW = 18
  const labelW = RECEIPT_WIDTH - valueW
  return pad(label.slice(0, labelW), labelW) + pad(valueStr.slice(-valueW), valueW, 'right') + LF
}

/**
 * Same top block as sales receipt: bold location heading, margin, optional telephone, dashed line.
 */
function pushLocationHeaderEscPos(lines, locationHeading, locationTelephone) {
  const heading = String(locationHeading ?? '').trim().slice(0, RECEIPT_WIDTH)
  lines.push(FONT_SMALL)
  lines.push(CENTER)
  lines.push(FONT_NORMAL)
  lines.push(BOLD_ON)
  lines.push((heading || ' ') + LF)
  lines.push(BOLD_OFF)
  lines.push(LF)
  lines.push(FONT_SMALL)
  const tel = String(locationTelephone ?? '').trim()
  if (tel) {
    lines.push(tel.slice(0, RECEIPT_WIDTH) + LF)
  }
  lines.push(dashedLine())
}

/**
 * Hold / suspend slip — same header as receipt, then ** BILL ON HOLD ***, Bill No, User,
 * Location Code, Counter, Date, Time, bill barcode, dashed line, cut.
 */
async function buildEscPosHoldSlip(data, encoding = 'IBM864') {
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
  } = data

  const d = date instanceof Date ? date : new Date(date)
  const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/\s/g, ' ')
  const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).toLowerCase()

  const locationHeading = (branchName || locationName || locationCode || '').trim().slice(0, RECEIPT_WIDTH)

  const lines = []
  lines.push(INIT)
  if (encoding === 'IBM864') {
    lines.push(ARABIC_CODEPAGE)
  }
  pushLocationHeaderEscPos(lines, locationHeading, locationTelephone)
  lines.push(CENTER)
  lines.push(FONT_SMALL)
  lines.push(BOLD_ON)
  lines.push((suspend ? '** BILL SUSPENDED ***' : '** BILL ON HOLD ***') + LF)
  lines.push(BOLD_OFF)
  lines.push(LF)
  lines.push(LEFT)
  lines.push(FONT_SMALL)
  lines.push(lineLabelValue('Bill No', String(billNo ?? '')))
  lines.push(lineLabelValue('User', (userName || '--').toString().slice(0, 22)))
  lines.push(lineLabelValue('Location Code', (locationCode || '--').toString()))
  const counterLine = [counterCode, counterName].filter(Boolean).join(' ').trim() || '--'
  lines.push(lineLabelValue('Counter', counterLine.slice(0, RECEIPT_WIDTH)))
  lines.push(lineLabelValue('Date', dateStr))
  lines.push(lineLabelValue('Time', timeStr))
  lines.push(LF)
  lines.push(CENTER)
  lines.push(FONT_SMALL)
  try {
    lines.push(await createBillNoBarcodeQzImage(billNo))
  } catch (e) {
    console.warn('[ThermalPrint] Hold slip barcode skipped:', e)
    lines.push(String(billNo ?? '') + LF)
  }
  lines.push(LF)
  lines.push(LEFT)
  lines.push(dashedLine())
  lines.push(LF + LF + LF + LF)
  lines.push(CUT)
  return lines
}

/**
 * Build ESC/POS receipt – bilingual design (English / Arabic)
 */
function buildEscPosReceipt(data, encoding = 'IBM864') {
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
  } = data

  const d = date instanceof Date ? date : new Date(date)
  const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/\s/g, ' ')
  const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).toLowerCase()

  const netTotal = total - (Number(discount) || 0)
  const locationHeading = (branchName || locationName || locationCode || '').trim().slice(0, RECEIPT_WIDTH)

  const lines = []

  lines.push(INIT)
  if (encoding === 'IBM864') {
    lines.push(ARABIC_CODEPAGE)
  }
  pushLocationHeaderEscPos(lines, locationHeading, locationTelephone)
  lines.push(CENTER)  // center all body content

  // ----- BODY: Font B (11pt), normal weight -----
  lines.push(FONT_SMALL)  // Font B = 9x17 dots (~11pt)
  const SP = ' '
  const colSlNo = 4
  const colItemName = 18   // Item Name (first line = manufactureId, second = product name, third = Arabic)
  const colQty = 6
  const colRate = 6
  const colAmt = 6
  const headerRow = pad('Sl.No', colSlNo) + SP + pad('Item Name', colItemName) + SP + pad('Qty', colQty, 'right') + SP + pad('Rate', colRate, 'right') + SP + pad('Amount', colAmt, 'right')
  lines.push(headerRow.slice(0, RECEIPT_WIDTH) + LF)
  lines.push(dashedLine())

  const getManufactureId = (item) => String(item?.manufactureId ?? item?.MANUFACTUREID ?? item?.manufactureid ?? item?.id ?? item?.ITEMCODE ?? item?.itemCode ?? '').trim()
  const getItemName = (item) => (item?.name ?? item?.ITEMNAME ?? item?.itemname ?? '').toString().trim()
  const getItemDetails = (item) => (item?.details ?? item?.DETAILS ?? item?.size ?? item?.SIZE ?? item?.pack ?? '').toString().trim()
  const getItemNameAr = (item) => (item?.nameAr ?? item?.NAME_AR ?? item?.itemname_ar ?? item?.itemNameAra ?? item?.ITEMNAMEARA ?? '').toString().trim()

  items.forEach((item, idx) => {
    const slNo = idx + 1
    const manufId = getManufactureId(item)
    const name = getItemName(item)
    const details = getItemDetails(item)
    const nameAr = getItemNameAr(item)
    const qty = Number(item.quantity) || 0
    const rate = Number(item.price) || 0
    const amt = qty * rate
    const qtyStr = qty.toFixed(3)
    const rateStr = rate.toFixed(2)
    const amtStr = amt.toFixed(2)
    // First line: Sl.No | Item Name column = manufactureId | Qty | Rate | Amount
    const row1 = pad(String(slNo), colSlNo) + SP + pad(manufId.slice(0, colItemName), colItemName) + SP + pad(qtyStr, colQty, 'right') + SP + pad(rateStr, colRate, 'right') + SP + pad(amtStr, colAmt, 'right')
    lines.push(row1.slice(0, RECEIPT_WIDTH) + LF)
    // Second line: under Item Name heading = product name (no sl.no, qty, rate, amount)
    const itemNameIndent = colSlNo + SP.length
    const itemNameWidth = RECEIPT_WIDTH - itemNameIndent - colQty - SP.length - colRate - SP.length - colAmt - SP.length
    const nameLine = pad('', colSlNo) + SP + name.slice(0, itemNameWidth) + SP + pad('', colQty) + SP + pad('', colRate) + SP + pad('', colAmt)
    lines.push(nameLine.slice(0, RECEIPT_WIDTH) + LF)
    if (details) {
      const detailsLine = pad('', colSlNo) + SP + details.slice(0, itemNameWidth) + SP + pad('', colQty) + SP + pad('', colRate) + SP + pad('', colAmt)
      lines.push(detailsLine.slice(0, RECEIPT_WIDTH) + LF)
    }
    // Third line: under Item Name heading = Arabic product name
    if (nameAr) {
      const arLine = pad('', colSlNo) + SP + nameAr.slice(0, itemNameWidth) + SP + pad('', colQty) + SP + pad('', colRate) + SP + pad('', colAmt)
      lines.push(arLine.slice(0, RECEIPT_WIDTH) )
      lines.push(LF)           // break after Arabic name
    }
  })

  lines.push(dashedLine())
  lines.push(LF)

  // ----- SUMMARY -----
  lines.push(lineEnArAmount('Grand Total', AR.grandTotal, 'QAR ' + total.toFixed(2)))
  lines.push(lineEnArAmount('Discount', AR.discount, 'QAR ' + (Number(discount) || 0).toFixed(2)))
  lines.push(lineEnArAmount('Net Total', AR.netTotal, 'QAR ' + netTotal.toFixed(2)))
  lines.push(dashedLine())
  const pmNorm = String(paymentMethod || 'cash').toLowerCase()
  if (pmNorm === 'split' && (Number(cashAmount) > 0 || Number(cardAmount) > 0)) {
    lines.push(lineEnArAmount('Cash paid', AR.cash, (Number(cashAmount) || 0).toFixed(2)))
    lines.push(lineEnArAmount('Card', '', (Number(cardAmount) || 0).toFixed(2)))
  } else {
    lines.push(lineEnArAmount('Qatar Riyals AR', AR.cash, amountTendered.toFixed(2)))
  }
  lines.push(lineEnArAmount('Change Qatar Riyals QAR', AR.change, change.toFixed(2)))
  lines.push(LF)

  // ----- TRANSACTION DETAILS -----
  lines.push(dashedLine())
  lines.push(CENTER)  // content centered on receipt
  lines.push((customerName ? `Customer : ${customerName}` : 'Customer : --') + LF)
  const pmDisplay =
    pmNorm === 'cash'
      ? 'Cash'
      : pmNorm === 'split'
        ? 'Cash + Card'
        : pmNorm === 'card'
          ? 'Card'
          : String(paymentMethod || 'card')
  lines.push(lineLabelValue('Payment Type', pmDisplay))
  lines.push(lineLabelValue('Total Points', (Number(totalPoints) || 0).toFixed(3)))
  lines.push(lineLabelValue('Served By : ' + (userName || '--'), AR.cashierName))
  lines.push(LF)

  // Receipt | Date | Time | POS – full width
  const colR = 12
  const colD = 12
  const colT = 12
  const colP = 12
  lines.push(pad('Receipt', colR) + pad('Date', colD) + pad('Time', colT) + pad('POS', colP, 'right') + LF)
  lines.push(pad(String(billNo), colR) + pad(dateStr, colD) + pad(timeStr, colT) + pad(counterCode || 'CNT01', colP, 'right') + LF)
  lines.push(LF)

  // ----- FOOTER -----
  lines.push(dashedLine())
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

function shortDashLine(len = 22) {
  const n = Math.min(Math.max(len, 8), RECEIPT_WIDTH)
  return '-'.repeat(n) + LF
}

function pushSectionHeading(lines, title) {
  lines.push(LEFT)
  lines.push(FONT_SMALL)
  lines.push(title + LF)
  lines.push(shortDashLine(Math.min(title.length + 6, RECEIPT_WIDTH)))
}

/**
 * ESC/POS counter closing slip — layout matches thermal “Counter Closing” report
 */
export function buildEscPosCounterCloseReport(data, encoding = 'IBM864') {
  const {
    date = '',
    counterCode = '',
    locationCode = '',
    locationName = '',
    totalSales = 0,
    totalReturns = 0,
    netTotal = 0,
    companyName = 'RAWABI FOOD INTERNATIONAL',
    companyNameAr = '',
    branchName = '',
    closedBy = '',
    cashierDisplay = '',
    totalCardAmount = 0,
    /** Sum of CARDAMOUNT on return bills (card refunds); used if cashInBox missing */
    totalCardReturns = 0,
    cardByType = null,
    discountTotal = 0,
    creditTotal = 0,
    voucherTotal = 0,
    cashInBox = null,
    crReconciled = 0,
    /** 'check' = pre-close time-check copy; 'final' = official slip after Close */
    slipKind = 'final',
  } = data

  const lines = []
  lines.push(INIT)
  if (encoding === 'IBM864') {
    lines.push(ARABIC_CODEPAGE)
  }
  lines.push(FONT_SMALL)
  lines.push(CENTER)
  if (companyNameAr) {
    lines.push(companyNameAr.slice(0, RECEIPT_WIDTH) + LF)
  }
  lines.push(FONT_NORMAL)
  lines.push(BOLD_ON)
  lines.push((companyName || 'RAWABI FOOD INTERNATIONAL').slice(0, RECEIPT_WIDTH) + LF)
  lines.push(BOLD_OFF)
  lines.push(FONT_SMALL)
  const locBit = (locationName || locationCode || '').toString().trim()
  const titleLoc = [companyName, locBit].filter(Boolean).join(' - ')
  if (titleLoc) lines.push(titleLoc.slice(0, RECEIPT_WIDTH) + LF)
  if (branchName) lines.push(branchName.slice(0, RECEIPT_WIDTH) + LF)
  lines.push(dashedLine())

  const closeDateStr = formatCounterCloseDate(date)
  const isCheckCopy = slipKind === 'check'
  lines.push(CENTER)
  lines.push(FONT_NORMAL)
  lines.push(BOLD_ON)
  lines.push((isCheckCopy ? '*** TIME CHECK COPY ***' : '*** FINAL CLOSE ***').slice(0, RECEIPT_WIDTH) + LF)
  lines.push(BOLD_OFF)
  lines.push(FONT_SMALL)
  if (isCheckCopy) {
    lines.push('Pre-close verification (not final)' + LF)
  }
  lines.push('Counter day : ' + closeDateStr + LF)
  lines.push(dashedLine())

  lines.push(LEFT)
  lines.push(FONT_SMALL)
  const closingAt = new Date()
  const closingDatePart = formatCounterCloseDate(date)
  const closingClock = closingAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })

  lines.push(lineLabelValue('Counter', String(counterCode || '—')))
  const cashierLine = (cashierDisplay || closedBy || '').toString().trim()
  if (cashierLine) lines.push(lineLabelValue('Cashier', cashierLine.slice(0, 22)))
  lines.push(
    ((isCheckCopy ? 'Check time : ' : 'Closing time : ') + closingDatePart + ' ' + closingClock).slice(0, RECEIPT_WIDTH) + LF
  )

  lines.push(LF)
  lines.push(lineLabelValue('Total Sales', Number(totalSales).toFixed(2)))
  lines.push(lineLabelValue('Sales returns', Number(totalReturns).toFixed(2)))
  lines.push(lineLabelValue('Net total', Number(netTotal).toFixed(2)))
  lines.push(lineLabelValue('Discount (lines)', Number(discountTotal).toFixed(2)))
  lines.push(lineLabelValue('Credit on account', Number(creditTotal).toFixed(2)))

  lines.push(LF)
  pushSectionHeading(lines, 'Card Details')
  const cardMap = cardByType && typeof cardByType === 'object' ? cardByType : {}
  const cardKeys = Object.keys(cardMap)
  if (cardKeys.length > 0) {
    cardKeys.sort().forEach((k) => {
      lines.push(lineLabelValue(k, Number(cardMap[k]).toFixed(2)))
    })
  } else if (Number(totalCardAmount) > 0) {
    lines.push(lineLabelValue('CARD', Number(totalCardAmount).toFixed(2)))
  }

  lines.push(LF)
  pushSectionHeading(lines, 'Gift Voucher Details')
  lines.push(lineLabelValue('VOUCHER', Number(voucherTotal).toFixed(2)))

  lines.push(LF)
  pushSectionHeading(lines, 'Currency Details')
  lines.push(LF)
  pushSectionHeading(lines, 'No.Of Telephone Cards')

  lines.push(LF)
  lines.push(lineLabelValue('Cr.Reconcilled', Number(crReconciled).toFixed(2)))
  lines.push(dashedLine())

  // Cash in box: from API (per-bill NET-CARD sums minus credit & voucher) or fallback formula
  const cash =
    cashInBox != null && !Number.isNaN(Number(cashInBox))
      ? Number(cashInBox)
      : Number(netTotal) -
        Number(totalCardAmount || 0) +
        Number(totalCardReturns || 0) -
        Number(creditTotal) -
        Number(voucherTotal)
  lines.push(BOLD_ON)
  lines.push(lineLabelValue('Cash in Box', cash.toFixed(2)))
  lines.push(BOLD_OFF)
  lines.push(FONT_SMALL)
  lines.push(
    (
      'Cash = cash from bills (net - card) - credit - voucher'
    ).slice(0, RECEIPT_WIDTH) + LF
  )
  lines.push(dashedLine())
  if (isCheckCopy) {
    lines.push(CENTER)
    lines.push(FONT_SMALL)
    lines.push('Use Close for official final print.' + LF)
    lines.push(LF)
  }

  lines.push(LF + LF + LF + LF)
  lines.push(CUT)
  return lines
}

/**
 * Print counter close summary to thermal printer via QZ Tray.
 */
export async function printCounterCloseReport(reportData) {
  if (typeof window === 'undefined') return

  try {
    const qz = (await import('qz-tray')).default
    if (!qz) throw new Error('QZ Tray not available')

    await ensureQzSecurity(qz)
    try {
      await qz.websocket.connect({ retries: 2, delay: 1 })
    } catch (connErr) {
      if (!connErr?.message?.includes('already exists')) throw connErr
    }

    const printerName = await resolvePrinterName(qz)
    const encoding = localStorage.getItem(ENCODING_KEY) || 'IBM864'
    const payload = buildEscPosCounterCloseReport(reportData, encoding)

    const config = qz.configs.create(printerName, {
      encoding,
      ...(printerName.toLowerCase().includes('epson') || printerName.toLowerCase().includes('tm') ? {} : { forceRaw: true }),
    })

    await qz.print(config, payload)
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

/**
 * Resolve printer name: from localStorage, or find by common thermal printer keywords
 */
async function resolvePrinterName(qz) {
  const saved = localStorage.getItem(PRINTER_KEY)
  if (saved && saved.trim()) {
    return saved.trim()
  }

  const all = await qz.printers.find()
  if (!all || all.length === 0) {
    throw new Error('No printers found. Please connect a USB thermal printer.')
  }

  // Prefer thermal/receipt printers
  const keywords = ['POS', 'Receipt', 'TM-', 'TM88', 'TM-T', 'Epson', 'Star', 'Citizen', 'Bixolon', 'thermal']
  for (const kw of keywords) {
    const found = all.find((p) => String(p).toLowerCase().includes(kw.toLowerCase()))
    if (found) return found
  }

  // Fallback to first printer
  return all[0]
}

/**
 * Print receipt to USB thermal printer via QZ Tray.
 * @param {Object} receiptData - Receipt payload (billNo, items, total, etc.)
 * @returns {Promise<void>}
 */
export async function printReceipt(receiptData) {
  if (typeof window === 'undefined') return

  try {
    const qz = (await import('qz-tray')).default
    if (!qz) throw new Error('QZ Tray not available')

    await ensureQzSecurity(qz)
    // Connect (or use existing connection - connect throws "already exists" when active)
    try {
      await qz.websocket.connect({ retries: 2, delay: 1 })
    } catch (connErr) {
      if (!connErr?.message?.includes('already exists')) throw connErr
      // Already connected (e.g. from Settings/PrinterSettings), proceed
    }

    const printerName = await resolvePrinterName(qz)
    const encoding = localStorage.getItem(ENCODING_KEY) || 'IBM864'
    const lines = buildEscPosReceipt(receiptData, encoding)
    let barcodeChunk
    try {
      barcodeChunk = await createBillNoBarcodeQzImage(receiptData.billNo)
    } catch (e) {
      console.warn('[ThermalPrint] Receipt barcode skipped:', e)
      barcodeChunk = null
    }
    const data = [
      ...lines,
      ...(barcodeChunk ? [CENTER, FONT_SMALL, barcodeChunk, LF] : ['*' + String(receiptData.billNo ?? '').padStart(12, '0') + '*' + LF, LF]),
      LF + LF + LF + LF,
      CUT,
    ]

    const config = qz.configs.create(printerName, {
      encoding, // IBM864 = Arabic (Epson); try Cp1256 if Arabic still wrong
      ...(printerName.toLowerCase().includes('epson') || printerName.toLowerCase().includes('tm') ? {} : { forceRaw: true }),
    })

    await qz.print(config, data)
    console.info('[ThermalPrint] Receipt printed successfully')
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
 * @param {Object} holdData - billNo, date, locationCode, locationName?, branchName?, locationTelephone?, counterCode, counterName, userName, suspend?
 */
export async function printHoldSlip(holdData) {
  if (typeof window === 'undefined') return

  try {
    const qz = (await import('qz-tray')).default
    if (!qz) throw new Error('QZ Tray not available')

    await ensureQzSecurity(qz)
    try {
      await qz.websocket.connect({ retries: 2, delay: 1 })
    } catch (connErr) {
      if (!connErr?.message?.includes('already exists')) throw connErr
    }

    const printerName = await resolvePrinterName(qz)
    const encoding = localStorage.getItem(ENCODING_KEY) || 'IBM864'
    const payload = await buildEscPosHoldSlip(holdData, encoding)

    const config = qz.configs.create(printerName, {
      encoding,
      ...(printerName.toLowerCase().includes('epson') || printerName.toLowerCase().includes('tm') ? {} : { forceRaw: true }),
    })

    await qz.print(config, payload)
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
  if (name) localStorage.setItem(PRINTER_KEY, String(name).trim())
  else localStorage.removeItem(PRINTER_KEY)
}

/**
 * Get list of available printers (requires QZ Tray connection)
 */
export async function getAvailablePrinters() {
  if (typeof window === 'undefined') return []
  try {
    const qz = (await import('qz-tray')).default
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
