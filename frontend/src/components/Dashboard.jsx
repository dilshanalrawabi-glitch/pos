import { useState, useCallback, useEffect, useRef } from 'react'
import { printReceipt } from '../services/thermalPrint'
import '../styles/Dashboard.css'

function todayStr() {
  const d = new Date()
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  )
}

/** Match backend BILLHDR: X = return; legacy negative NET on C/R = return */
function isBillSalesReturn(row) {
  const bt = String(row?.billType ?? '').toUpperCase()
  const net = Number(row?.netBillAmount ?? 0)
  return bt === 'X' || (['C', 'R', '1', '2'].includes(bt) && net < 0)
}

export default function Dashboard({
  apiBase,
  locationCode = '',
  locationName = '',
  counterCode = '',
  counterName = '',
  user = null,
}) {
  const [billDate, setBillDate] = useState(todayStr)
  const [billNoFilter, setBillNoFilter] = useState('')
  const [bills, setBills] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [printingBillNo, setPrintingBillNo] = useState(null)
  const billNoFilterRef = useRef(billNoFilter)
  billNoFilterRef.current = billNoFilter

  const loadBills = useCallback(async (opts = {}) => {
    const { useBillNoServerFilter = false } = opts
    if (!apiBase || !billDate) return
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ date: billDate })
      if (locationCode) params.set('locationCode', locationCode)
      if (counterCode) params.set('counterCode', counterCode)
      if (useBillNoServerFilter) {
        const bn = billNoFilterRef.current.trim()
        if (bn !== '' && /^\d+$/.test(bn)) params.set('billNo', bn)
      }
      const res = await fetch(`${apiBase}/api/bills/by-date?${params}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setBills([])
        setError(data.error || `Failed to load bills (${res.status})`)
        return
      }
      setBills(Array.isArray(data.bills) ? data.bills : [])
    } catch (e) {
      setBills([])
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [apiBase, billDate, locationCode, counterCode])

  useEffect(() => {
    loadBills({ useBillNoServerFilter: false })
  }, [loadBills])

  const filteredBills = bills.filter((b) => {
    const q = billNoFilter.trim().toLowerCase()
    if (!q) return true
    const n = String(b.billNo ?? '')
    return n.includes(q)
  })

  const handlePrintBill = async (bill) => {
    const bno = bill.billNo
    if (bno == null || !apiBase) return
    setPrintingBillNo(bno)
    setError(null)
    try {
      const params = new URLSearchParams({ date: billDate })
      if (locationCode) params.set('locationCode', locationCode)
      const res = await fetch(`${apiBase}/api/bills/${bno}/receipt?${params}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setError(data.error || `Could not load bill ${bno}`)
        return
      }
      const h = data.header || {}
      const billDateObj = h.billDate ? new Date(h.billDate) : new Date(`${billDate}T12:00:00`)
      await printReceipt({
        billNo: h.billNo ?? bno,
        date: billDateObj,
        locationCode: h.locationCode || locationCode || '',
        locationName: locationName || '',
        locationTelephone: (typeof localStorage !== 'undefined' && localStorage.getItem('pos_location_telephone')) || '',
        counterCode: h.counterCode || counterCode || '',
        counterName: counterName || '',
        userName: user?.userid ?? user?.username ?? '',
        customerName: h.customerName || '',
        companyName: (localStorage.getItem('pos_company_name') || '').trim() || undefined,
        companyNameAr: (localStorage.getItem('pos_company_name_ar') || '').trim() || undefined,
        branchName: localStorage.getItem('pos_branch_name') || '',
        items: data.items || [],
        subtotal: data.subtotal ?? 0,
        total: data.total ?? 0,
        discount: data.discount ?? 0,
        totalPoints: data.totalPoints ?? 0,
        paymentMethod: data.paymentMethod ?? 'cash',
        cashAmount: data.cashAmount,
        cardAmount: data.cardAmount,
        amountTendered: data.amountTendered ?? data.total ?? 0,
        change: data.change ?? 0,
        isSalesReturn: !!data.isSalesReturn,
      })
    } catch (e) {
      const msg = e?.message ?? String(e)
      setError(msg)
      if (msg.includes('QZ Tray is not running')) {
        alert('Receipt not printed. Please start QZ Tray (https://qz.io) for automatic receipt printing.')
      } else if (!msg.includes('No printers')) {
        alert('Receipt print failed: ' + msg)
      }
    } finally {
      setPrintingBillNo(null)
    }
  }

  return (
    <div className="dashboard-page">
      <div className="dashboard-header">
        <h1 className="dashboard-title">Dashboard</h1>
        <p className="dashboard-subtitle">Browse bills by date and reprint receipts.</p>
      </div>

      <form
        className="dashboard-bill-form"
        onSubmit={(e) => {
          e.preventDefault()
          loadBills({ useBillNoServerFilter: true })
        }}
      >
        <div className="dashboard-form-row">
          <label className="dashboard-field">
            <span>Bill date</span>
            <input
              type="date"
              value={billDate}
              onChange={(e) => setBillDate(e.target.value)}
            />
          </label>
          <label className="dashboard-field dashboard-field-grow">
            <span>Bill no. (filter)</span>
            <input
              type="text"
              inputMode="numeric"
              placeholder="Type to narrow list, or full number + Refresh"
              value={billNoFilter}
              onChange={(e) => setBillNoFilter(e.target.value)}
            />
          </label>
          <div className="dashboard-form-actions">
            <button type="submit" className="dashboard-btn primary" disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>
      </form>

      {error && <div className="dashboard-error" role="alert">{error}</div>}

      <div className="dashboard-bill-list-wrap">
        <div className="dashboard-list-header">
          <span>Bills on {billDate}</span>
          <span className="dashboard-list-count">{filteredBills.length} shown</span>
        </div>
        {loading && bills.length === 0 ? (
          <div className="dashboard-empty">Loading bills…</div>
        ) : filteredBills.length === 0 ? (
          <div className="dashboard-empty">No bills for this date{billNoFilter.trim() ? ' (with current filter)' : ''}.</div>
        ) : (
          <ul className="dashboard-bill-list">
            {filteredBills.map((b) => (
              <li key={`${b.billNo}-${b.billDate}`} className="dashboard-bill-row">
                <button
                  type="button"
                  className="dashboard-bill-no-btn"
                  disabled={printingBillNo === b.billNo}
                  onClick={() => handlePrintBill(b)}
                  title="Print receipt"
                >
                  {printingBillNo === b.billNo ? 'Printing…' : `Bill ${b.billNo}`}
                </button>
                <span className="dashboard-bill-meta">{b.counterCode || '—'}</span>
                <span className="dashboard-bill-meta">{b.customerName || '—'}</span>
                <span className="dashboard-bill-amount">
                  QAR {Number(b.netBillAmount || 0).toFixed(2)}
                </span>
                <span className={`dashboard-bill-type ${isBillSalesReturn(b) ? 'return' : ''}`}>
                  {isBillSalesReturn(b) ? 'Return' : 'Sale'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
