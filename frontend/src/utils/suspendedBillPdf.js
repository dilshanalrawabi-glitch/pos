let jspdfModulePromise = null

async function loadJsPdfModules() {
  if (!jspdfModulePromise) {
    jspdfModulePromise = Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ]).then(([jspdfMod, autotableMod]) => ({
      jsPDF: jspdfMod.jsPDF,
      autoTable: autotableMod.default,
    }))
  }
  return jspdfModulePromise
}

function fmtDate(iso) {
  if (!iso || typeof iso !== 'string') return ''
  const d = iso.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : String(iso).slice(0, 19)
}

const MARGIN = 12

/**
 * Draw one suspended bill (header + line table + totals) on the current PDF page.
 * @param {object} doc jsPDF instance
 * @param {{ header?: object, items?: unknown[] }} data
 * @param {{ billNo: number, companyName?: string, branchName?: string, locationName?: string }} meta
 * @param {Function} autoTableFn jspdf-autotable default export
 */
export function appendSuspendedBillDetailPage(doc, data, meta, autoTableFn) {
  const { billNo, companyName, branchName, locationName } = meta
  const h = data.header || {}
  const items = Array.isArray(data.items) ? data.items : []
  const pageW = doc.internal.pageSize.getWidth()

  let y = 14
  doc.setFontSize(16)
  doc.setFont('helvetica', 'bold')
  doc.text('Suspended bill — full detail', MARGIN, y)
  y += 9
  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  const metaRight = companyName || branchName || locationName
  if (metaRight) {
    doc.setFont('helvetica', 'italic')
    doc.text(String(metaRight).slice(0, 80), pageW - MARGIN, 14, { align: 'right' })
    doc.setFont('helvetica', 'normal')
  }

  const hdrLines = [
    `Bill no: ${h.billNo ?? billNo}`,
    `Date: ${fmtDate(h.billDate)}   Time: ${h.billTime || '—'}`,
    `Customer: ${h.customerName || h.customerCode || '—'}`,
    `Counter: ${h.counterCode || '—'}`,
  ]
  hdrLines.forEach((line) => {
    doc.text(line, MARGIN, y)
    y += 5
  })
  y += 3

  const tableBody = items.map((row, idx) => {
    const qty = Number(row.quantity ?? row.QUANTITY ?? 0)
    const rate = Number(row.rate ?? row.RATE ?? row.price ?? 0)
    const amount = qty * rate
    return [
      String(idx + 1),
      String(row.itemCode ?? row.ITEMCODE ?? row.id ?? ''),
      String(row.itemName ?? row.ITEMNAME ?? row.name ?? '').slice(0, 40),
      qty.toFixed(3),
      rate.toFixed(2),
      amount.toFixed(2),
    ]
  })

  autoTableFn(doc, {
    startY: y,
    head: [['#', 'Code', 'Item', 'Qty', 'Rate', 'Amount']],
    body: tableBody,
    styles: { fontSize: 8, cellPadding: 1.5 },
    headStyles: { fillColor: [60, 60, 60] },
    margin: { left: MARGIN, right: MARGIN },
  })

  const finalY = (doc.lastAutoTable && doc.lastAutoTable.finalY) ? doc.lastAutoTable.finalY + 8 : y + 20
  doc.setFont('helvetica', 'bold')
  doc.text(`Total: QAR ${Number(h.total ?? data.total ?? 0).toFixed(2)}`, MARGIN, finalY)
}

async function fetchSuspendedBillDetails(apiBase, billNo, billDate, locationCode, counterCode) {
  const params = new URLSearchParams({ date: billDate })
  if (locationCode) params.set('locationCode', locationCode)
  if (counterCode) params.set('counterCode', counterCode)
  const res = await fetch(`${apiBase}/api/bills/${billNo}/receipt?${params}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Could not load bill ${billNo}`)
  }
  return data
}

/**
 * Fetch one suspended bill and save PDF.
 */
export async function downloadSuspendedBillPdf(apiBase, opts) {
  const { jsPDF: JsPDF, autoTable: autoTableFn } = await loadJsPdfModules()
  const {
    billNo,
    billDate,
    locationCode,
    counterCode,
    locationName,
    branchName,
    companyName,
  } = opts
  if (!apiBase || billNo == null || !billDate) {
    throw new Error('Missing bill number, date, or API base')
  }
  const data = await fetchSuspendedBillDetails(apiBase, billNo, billDate, locationCode, counterCode)
  const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  appendSuspendedBillDetailPage(doc, data, { billNo, companyName, branchName, locationName }, autoTableFn)
  const h = data.header || {}
  const safeDate = String(h.billDate || billDate).replace(/[^\d-]/g, '') || 'date'
  doc.save(`suspended-bill-${h.billNo ?? billNo}-${safeDate}.pdf`)
}

/**
 * Fetch each suspended bill and save one PDF with one landscape page per bill.
 */
export async function downloadAllSuspendedBillsPdf(apiBase, opts) {
  const { jsPDF: JsPDF, autoTable: autoTableFn } = await loadJsPdfModules()
  const {
    billNos,
    billDate,
    locationCode,
    counterCode,
    locationName,
    branchName,
    companyName,
  } = opts
  if (!apiBase || !billDate) {
    throw new Error('Missing API base or date')
  }
  const nos = Array.isArray(billNos)
    ? [...new Set(billNos.map((n) => Number(n)).filter((n) => Number.isFinite(n)))]
    : []
  if (nos.length === 0) {
    throw new Error('No suspended bills to export')
  }

  const meta = { companyName, branchName, locationName }
  const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

  for (let i = 0; i < nos.length; i++) {
    if (i > 0) {
      doc.addPage('a4', 'l')
    }
    const billNo = nos[i]
    const data = await fetchSuspendedBillDetails(apiBase, billNo, billDate, locationCode, counterCode)
    appendSuspendedBillDetailPage(doc, data, { billNo, ...meta }, autoTableFn)
  }

  const safeDate = String(billDate).replace(/[^\d-]/g, '') || 'date'
  doc.save(`suspended-bills-all-${safeDate}.pdf`)
}
