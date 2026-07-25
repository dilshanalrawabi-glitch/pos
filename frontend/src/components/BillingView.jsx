import { memo, useCallback } from 'react'
import Billing from './Billing'
import { useCartStore } from '../stores/useCartStore'

function BillingView({
  products,
  productLookupMap,
  productsReady,
  itemDetailsCacheResetKey,
  onAddToCart,
  onMergeCartLine,
  onUpdateQuantity,
  onRemove,
  onSelectCartItem,
  onToggleSalesReturn,
  onSetPriceMode,
  ...rest
}) {
  const cartItems = useCartStore((s) => s.items)
  const selectedCartItemId = useCartStore((s) => s.selectedCartItemId)
  const isSalesReturn = useCartStore((s) => s.isSalesReturn)
  const priceMode = useCartStore((s) => s.priceMode)

  const handleSelectCartItem = useCallback((id) => {
    useCartStore.getState().setSelectedCartItemId(id)
    onSelectCartItem?.(id)
  }, [onSelectCartItem])

  const handleToggleSalesReturn = useCallback((...args) => {
    onToggleSalesReturn?.(...args)
  }, [onToggleSalesReturn])

  return (
    <Billing
      cartItems={cartItems}
      products={products}
      productLookupMap={productLookupMap}
      productsReady={productsReady}
      itemDetailsCacheResetKey={itemDetailsCacheResetKey}
      onAddToCart={onAddToCart}
      onMergeCartLine={onMergeCartLine}
      onUpdateQuantity={onUpdateQuantity}
      onRemove={onRemove}
      selectedCartItemId={selectedCartItemId}
      onSelectCartItem={handleSelectCartItem}
      isSalesReturn={isSalesReturn}
      onToggleSalesReturn={handleToggleSalesReturn}
      priceMode={priceMode}
      onSetPriceMode={onSetPriceMode}
      {...rest}
    />
  )
}

export default memo(BillingView)
