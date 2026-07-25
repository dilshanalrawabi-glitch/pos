import { create } from 'zustand'
import {
  cartLineSyncKey,
  findCartLineIndexForMerge,
  getItemId,
  resolveManufactureId,
  sameCartLineId,
} from '../utils/cartItemUtils'

export const useCartStore = create((set, get) => ({
  items: [],
  selectedCartItemId: null,
  isSalesReturn: false,
  priceMode: null,

  setItems: (items) => set({ items: Array.isArray(items) ? items : [] }),

  setSelectedCartItemId: (id) => set({ selectedCartItemId: id }),

  setIsSalesReturn: (value) => set({ isSalesReturn: !!value }),

  setPriceMode: (mode) => set({ priceMode: mode || null }),

  addToCart: (product) => {
    const state = get()
    const wasReturnMode = state.isSalesReturn
    const qtyDelta = wasReturnMode ? -1 : 1
    const useQty = product.isWeightedItem && product.quantity != null && product.quantity > 0
      ? (wasReturnMode ? -Math.abs(product.quantity) : Math.abs(product.quantity))
      : qtyDelta
    const idx = findCartLineIndexForMerge(state.items, product)
    let newCart
    if (idx >= 0) {
      const existingItem = state.items[idx]
      const manufactureId = resolveManufactureId(product) || resolveManufactureId(existingItem)
      newCart = [...state.items]
      if (existingItem.void) {
        newCart[idx] = { ...existingItem, ...product, manufactureId, void: false, quantity: useQty }
      } else {
        newCart[idx] = { ...existingItem, manufactureId, quantity: existingItem.quantity + useQty }
      }
    } else {
      newCart = [...state.items, { ...product, quantity: useQty }]
    }
    set({
      items: newCart,
      ...(wasReturnMode ? { isSalesReturn: false } : null),
    })
    return newCart
  },

  mergeCartLine: (enrichedProduct) => {
    if (!enrichedProduct) return get().items
    const state = get()
    const idx = findCartLineIndexForMerge(state.items, enrichedProduct)
    if (idx < 0) return state.items
    const existing = state.items[idx]
    const merged = {
      ...existing,
      ...enrichedProduct,
      manufactureId: resolveManufactureId(enrichedProduct) || resolveManufactureId(existing),
      quantity: existing.quantity,
      void: existing.void,
      discount: existing.discount,
      price: existing.price,
    }
    const newCart = [...state.items]
    newCart[idx] = merged
    set({ items: newCart })
    return newCart
  },

  removeFromCart: (productId) => {
    const newCart = get().items.filter((item) => !sameCartLineId(getItemId(item), productId))
    set({ items: newCart })
    return newCart
  },

  updateQuantity: (productId, quantity) => {
    const state = get()
    const raw = Number(quantity)
    const existing = state.items.find((item) => sameCartLineId(getItemId(item), productId))
    const lineIsReturn = existing && !existing.void && Number(existing.quantity) < 0
    const treatAsReturn = state.isSalesReturn || lineIsReturn
    const qty = treatAsReturn
      ? (Number.isNaN(raw) ? 0 : raw)
      : Math.max(0, Number(quantity) || 0)
    let newCart
    if (qty === 0) {
      newCart = state.items.filter((item) => !sameCartLineId(getItemId(item), productId))
    } else {
      newCart = state.items.map((item) =>
        sameCartLineId(getItemId(item), productId) ? { ...item, quantity: qty } : item
      )
    }
    set({ items: newCart })
    return newCart
  },

  voidSelectedLine: (selectedId) => {
    const newCart = get().items.map((item) =>
      sameCartLineId(getItemId(item), selectedId) ? { ...item, void: true } : item
    )
    set({ items: newCart, selectedCartItemId: null })
    return newCart
  },

  clearCart: () => {
    set({ items: [], selectedCartItemId: null })
  },
}))

export { getItemId, sameCartLineId, cartLineSyncKey }
