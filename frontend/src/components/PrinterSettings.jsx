import { useState, useEffect } from 'react'
import { getApiBase } from '../apiBase'
import { getAvailablePrinters, setReceiptPrinter } from '../services/thermalPrint'
import '../styles/PrinterSettings.css'

const PRINTER_KEY = 'pos_receipt_printer'
const COMPANY_KEY = 'pos_company_name'
const COMPANY_AR_KEY = 'pos_company_name_ar'
const BRANCH_KEY = 'pos_branch_name'
const ENCODING_KEY = 'pos_receipt_encoding'

const ENCODING_OPTIONS = [
  { value: 'IBM864', label: 'IBM864 (Arabic – Epson)' },
  { value: 'Cp1256', label: 'Windows-1256 (Arabic)' },
  { value: 'UTF-8', label: 'UTF-8 (if printer supports)' },
]

export default function PrinterSettings() {
  const [printers, setPrinters] = useState([])
  const [selected, setSelected] = useState(() => localStorage.getItem(PRINTER_KEY) || '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [companyName, setCompanyName] = useState(() => localStorage.getItem(COMPANY_KEY) || '')
  const [companyNameAr, setCompanyNameAr] = useState(() => localStorage.getItem(COMPANY_AR_KEY) || '')
  const [branchName, setBranchName] = useState(() => localStorage.getItem(BRANCH_KEY) || '')
  const [encoding, setEncoding] = useState(() => localStorage.getItem(ENCODING_KEY) || 'IBM864')
  const [certError, setCertError] = useState(null)

  const downloadQzCert = async (kind) => {
    const token = localStorage.getItem('pos_token')
    if (!token) {
      setCertError('Sign in required.')
      return
    }
    setCertError(null)
    const base = getApiBase()
    const downloadName = kind === 'digital-certificate' ? 'digital-certificate.txt' : 'private-key.pem'
    try {
      const res = await fetch(`${base}/api/qz-certs/${kind}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        let msg = res.statusText
        try {
          const j = await res.json()
          if (j?.error) msg = j.error
        } catch {
          /* ignore */
        }
        throw new Error(msg)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = downloadName
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setCertError(err?.message || 'Download failed')
    }
  }

  const loadPrinters = async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await getAvailablePrinters()
      setPrinters(list || [])
      if (!selected && list?.length > 0) {
        const saved = localStorage.getItem(PRINTER_KEY)
        setSelected(saved || list[0] || '')
      }
    } catch (err) {
      setError(err?.message || 'Could not load printers. Is QZ Tray running?')
      setPrinters([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadPrinters()
  }, [])

  const handleSelect = (name) => {
    const val = name || ''
    setSelected(val)
    setReceiptPrinter(val || null)
  }

  const saveCompany = (key, value) => {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  }

  return (
    <div className="printer-settings">
      <h3>Receipt Header (Bilingual)</h3>
      <p className="printer-settings-desc">Shown at the top of printed receipts. Leave blank to use location name.</p>
      <label className="printer-settings-label">Company name (English)</label>
      <input
        type="text"
        className="printer-settings-input"
        value={companyName}
        onChange={(e) => { setCompanyName(e.target.value); saveCompany(COMPANY_KEY, e.target.value) }}
        placeholder="e.g. RAWABI FOOD INTERNATIONAL"
      />
      <label className="printer-settings-label">Company name (Arabic)</label>
      <input
        type="text"
        className="printer-settings-input"
        value={companyNameAr}
        onChange={(e) => { setCompanyNameAr(e.target.value); saveCompany(COMPANY_AR_KEY, e.target.value) }}
        placeholder="e.g. شركة الروابي للأغذية العالمية"
      />
      <label className="printer-settings-label">Branch / location line</label>
      <input
        type="text"
        className="printer-settings-input"
        value={branchName}
        onChange={(e) => { setBranchName(e.target.value); saveCompany(BRANCH_KEY, e.target.value) }}
        placeholder="e.g. Branch - Counter name"
      />

      <h3 className="printer-settings-section">QZ Tray signing files</h3>
      <p className="printer-settings-desc">
        Download the certificate and private key from the POS server for QZ Tray &quot;Site manager&quot; signing.
        Treat the private key as confidential.
      </p>
      {certError && (
        <div className="printer-settings-error printer-settings-cert-error">{certError}</div>
      )}
      <div className="printer-settings-cert-actions">
        <button type="button" className="printer-settings-cert-btn" onClick={() => downloadQzCert('digital-certificate')}>
          Download digital-certificate.txt
        </button>
        <button type="button" className="printer-settings-cert-btn" onClick={() => downloadQzCert('private-key')}>
          Download private-key.pem
        </button>
      </div>

      <h3 className="printer-settings-section">Receipt Printer</h3>
      <p className="printer-settings-desc">
        Select the USB thermal printer for automatic receipt printing after payment. Requires{' '}
        <a href="https://qz.io/" target="_blank" rel="noreferrer">QZ Tray</a> to be running.
      </p>
      {loading && <p className="printer-settings-loading">Loading printers…</p>}
      {error && (
        <div className="printer-settings-error">
          {error}
          <button type="button" onClick={loadPrinters}>Retry</button>
        </div>
      )}
      {!loading && !error && printers.length > 0 && (
        <>
          <select
            className="printer-settings-select"
            value={selected}
            onChange={(e) => handleSelect(e.target.value)}
          >
            <option value="">— Select printer —</option>
            {printers.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <label className="printer-settings-label">Arabic text encoding</label>
          <p className="printer-settings-desc">If Arabic prints as wrong characters, try another option.</p>
          <select
            className="printer-settings-select"
            value={encoding}
            onChange={(e) => {
              const v = e.target.value
              setEncoding(v)
              localStorage.setItem(ENCODING_KEY, v)
            }}
          >
            {ENCODING_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </>
      )}
      {!loading && !error && printers.length === 0 && (
        <p className="printer-settings-empty">No printers found. Connect a USB thermal printer and ensure QZ Tray is running.</p>
      )}
    </div>
  )
}
