import { memo } from 'react'
import Payment from './Payment'
import { useCartStore } from '../stores/useCartStore'

function PaymentView(props) {
  const cartItems = useCartStore((s) => s.items)
  return <Payment cartItems={cartItems} {...props} />
}

export default memo(PaymentView)
