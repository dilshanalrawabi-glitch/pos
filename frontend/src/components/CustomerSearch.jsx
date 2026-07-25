import { memo, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react'
import {
  buildCustomerSearchIndex,
  filterCustomerSearchIndex,
  getCustomerCode,
  getCustomerName,
} from '../utils/customerLookup'
import {
  getSalesChannelCode,
  getSalesChannelDescription,
} from '../utils/salesChannelLookup'

function CustomerSearch({
  customers,
  selectedCustomer,
  onSelectCustomer,
  salesChannels,
  selectedSalesChannel,
  onSelectSalesChannel,
}) {
  const [customerSearch, setCustomerSearch] = useState('')
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false)
  const [showChannelDropdown, setShowChannelDropdown] = useState(false)
  const customerSearchRef = useRef(null)
  const customerInputRef = useRef(null)

  const channels = Array.isArray(salesChannels) ? salesChannels : []
  const selectedChannelCode = getSalesChannelCode(selectedSalesChannel)
  const showChannelButton = !!selectedSalesChannel || channels.length > 0

  const searchIndex = useMemo(() => buildCustomerSearchIndex(customers), [customers])
  const selectedCode = selectedCustomer ? getCustomerCode(selectedCustomer) : ''
  const q = (customerSearch || '').trim()
  const filteredRows = useMemo(
    () =>
      q
        ? filterCustomerSearchIndex(searchIndex, q, { selectedCode })
        : [],
    [searchIndex, q, selectedCode]
  )

  const collapsed = !!selectedCustomer && !showCustomerDropdown

  const openCustomerPicker = useCallback(() => {
    setCustomerSearch('')
    setShowChannelDropdown(false)
    setShowCustomerDropdown(true)
  }, [])

  const openChannelPicker = useCallback(() => {
    setShowCustomerDropdown(false)
    setShowChannelDropdown(true)
  }, [])

  const handleSelectSalesChannel = useCallback(
    (channel) => {
      onSelectSalesChannel?.(channel)
      setShowChannelDropdown(false)
    },
    [onSelectSalesChannel]
  )

  const handleSelectCustomer = useCallback(
    (customer) => {
      onSelectCustomer?.(customer)
      setCustomerSearch('')
      setShowCustomerDropdown(false)
    },
    [onSelectCustomer]
  )

  useEffect(() => {
    function handleClickOutside(e) {
      if (customerSearchRef.current && !customerSearchRef.current.contains(e.target)) {
        setShowCustomerDropdown(false)
        setShowChannelDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useLayoutEffect(() => {
    if (!showCustomerDropdown) return undefined
    customerInputRef.current?.focus({ preventScroll: true })
    return undefined
  }, [showCustomerDropdown])

  return (
    <section className="dashboard-add-card" ref={customerSearchRef}>
      <h2 className="dashboard-card-title">Customer</h2>
      <div className={`dashboard-customer-field${collapsed ? ' dashboard-customer-field--collapsed' : ''}`}>
        {collapsed && (
          <button
            type="button"
            className="dashboard-customer-selected"
            onClick={openCustomerPicker}
            aria-expanded={false}
            aria-haspopup="listbox"
            aria-label="Change customer"
          >
            <span className="dashboard-customer-name">{getCustomerName(selectedCustomer)}</span>
            <span className="dashboard-customer-chevron" aria-hidden>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path
                  d="M6 9l6 6 6-6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>
        )}
        <div className="dashboard-customer-search-wrap" aria-hidden={collapsed}>
          <input
            ref={customerInputRef}
            type="text"
            className="dashboard-scan-input dashboard-customer-search-input"
            placeholder="Search name, code, phone, or QID..."
            value={customerSearch}
            onChange={(e) => {
              setCustomerSearch(e.target.value)
              setShowCustomerDropdown(true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const first = filteredRows[0]
                if (first) {
                  handleSelectCustomer(first.customer)
                }
                setShowCustomerDropdown(false)
              }
              if (e.key === 'Escape' && selectedCustomer) {
                setShowCustomerDropdown(false)
                setCustomerSearch('')
              }
            }}
            onFocus={() => setShowCustomerDropdown(true)}
            autoComplete="off"
            spellCheck={false}
            tabIndex={collapsed ? -1 : 0}
          />
          {showCustomerDropdown && !collapsed && (
            <div className="dashboard-customer-dropdown" role="listbox">
              {!q ? (
                <div className="dashboard-customer-empty">Type name, code, phone, or QID to search</div>
              ) : filteredRows.length === 0 ? (
                <div className="dashboard-customer-empty">No customers found</div>
              ) : (
                filteredRows.map((row, index) => {
                  const isCurrent =
                    selectedCode && row.displayCode && row.displayCode === selectedCode
                  return (
                    <button
                      key={row.displayCode || index}
                      type="button"
                      className={
                        isCurrent
                          ? 'dashboard-customer-option dashboard-customer-option-current'
                          : 'dashboard-customer-option'
                      }
                      role="option"
                      aria-selected={!!isCurrent}
                      onClick={() => handleSelectCustomer(row.customer)}
                    >
                      <span className="dashboard-customer-option-name">{row.displayName}</span>
                      {row.displayMobile ? (
                        <span className="dashboard-customer-option-cat">{row.displayMobile}</span>
                      ) : null}
                      {row.displayCategory ? (
                        <span className="dashboard-customer-option-cat">{row.displayCategory}</span>
                      ) : null}
                      {row.displayInvoiceType ? (
                        <span className="dashboard-customer-option-type">{row.displayInvoiceType}</span>
                      ) : null}
                    </button>
                  )
                })
              )}
            </div>
          )}
        </div>
      </div>

      <div className="dashboard-channel-block">
        <span className="dashboard-channel-label">Sales Channel</span>
        <div className="dashboard-channel-field">
          {showChannelButton && (
            <button
              type="button"
              className="dashboard-channel-selected"
              onClick={openChannelPicker}
              aria-expanded={showChannelDropdown}
              aria-haspopup="listbox"
              aria-label="Change sales channel"
            >
              <span className="dashboard-channel-name">
                {getSalesChannelDescription(selectedSalesChannel) || 'Select sales channel'}
              </span>
              <span className="dashboard-channel-chevron" aria-hidden>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path
                    d="M6 9l6 6 6-6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </button>
          )}
          {showChannelDropdown && (
            <div className="dashboard-channel-dropdown" role="listbox" aria-label="Sales channels">
              {channels.length === 0 ? (
                <div className="dashboard-channel-empty">No sales channels found</div>
              ) : (
                channels.map((channel, index) => {
                  const code = getSalesChannelCode(channel)
                  const isCurrent = selectedChannelCode && code === selectedChannelCode
                  return (
                    <button
                      key={code || index}
                      type="button"
                      className={
                        isCurrent
                          ? 'dashboard-channel-option dashboard-channel-option-current'
                          : 'dashboard-channel-option'
                      }
                      role="option"
                      aria-selected={!!isCurrent}
                      onClick={() => handleSelectSalesChannel(channel)}
                    >
                      <span className="dashboard-channel-option-name">
                        {getSalesChannelDescription(channel)}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

export default memo(CustomerSearch)
