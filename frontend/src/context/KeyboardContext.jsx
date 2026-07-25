import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'

const KeyboardContext = createContext(null)

/** Wait after OSK Enter before hiding keyboard so pointer/touch release does not hit controls below (e.g. Checkout). */
const OSK_ENTER_DISMISS_MS = 320

export function KeyboardProvider({ children }) {
  const [inputValue, setInputValueState] = useState('')
  const [visible, setVisible] = useState(false)
  const focusedRef = useRef(null)
  const inputListenerRef = useRef(null)
  const enterDismissTimerRef = useRef(null)

  const setInputValue = useCallback((value) => {
    setInputValueState(value)
    const el = focusedRef.current
    if (el) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement?.prototype ?? window.HTMLInputElement.prototype,
        'value'
      )?.set
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        el.value = value
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
  }, [])

  const setFocusedInput = useCallback((el) => {
    if (el && focusedRef.current === el) {
      setVisible(true)
      setInputValueState(el.value ?? '')
      return
    }
    if (focusedRef.current && inputListenerRef.current?._cleanup) {
      inputListenerRef.current._cleanup()
    }
    focusedRef.current = el
    if (!el) {
      setVisible(false)
      setInputValueState('')
      return
    }
    const val = el.value ?? ''
    setInputValueState(val)

    const onInput = () => setInputValueState(el.value ?? '')
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        el.blur()
      }
    }
    el.addEventListener('input', onInput)
    el.addEventListener('keydown', onKeyDown)
    inputListenerRef.current = {
      _cleanup: () => {
        el.removeEventListener('input', onInput)
        el.removeEventListener('keydown', onKeyDown)
      },
    }
    setVisible(true)
  }, [])

  const clearFocusedInput = useCallback(() => {
    if (enterDismissTimerRef.current) {
      clearTimeout(enterDismissTimerRef.current)
      enterDismissTimerRef.current = null
    }
    const el = focusedRef.current
    if (el) {
      el.blur()
      if (inputListenerRef.current?._cleanup) {
        inputListenerRef.current._cleanup()
      }
    }
    focusedRef.current = null
    inputListenerRef.current = null
    setVisible(false)
    setInputValueState('')
  }, [])

  /** Open OSK for this input, or close if it is already the active OSK target (toggle). */
  const toggleKeyboardForInput = useCallback(
    (el) => {
      if (!el) return
      if (focusedRef.current === el && visible) {
        clearFocusedInput()
        return
      }
      el.focus()
      setFocusedInput(el)
    },
    [visible, clearFocusedInput, setFocusedInput]
  )

  const pressEnterOnFocusedInput = useCallback(() => {
    if (enterDismissTimerRef.current) {
      clearTimeout(enterDismissTimerRef.current)
      enterDismissTimerRef.current = null
    }
    const el = focusedRef.current
    const dismissTarget = el
    if (el) {
      const form = el.form
      if (form) {
        // One path only: synthetic Enter + requestSubmit() could run the form onSubmit twice
        // (scanner / OSK / browser quirks) and skip straight to Pay on the next Enter.
        form.requestSubmit()
      } else {
        const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
        el.dispatchEvent(new KeyboardEvent('keydown', opts))
        el.dispatchEvent(new KeyboardEvent('keyup', opts))
      }
    }
    // Defer blur/hide: if we collapse the keyboard in the same gesture as Enter, layout shifts
    // and pointerup can land on Checkout (ghost click).
    enterDismissTimerRef.current = setTimeout(() => {
      enterDismissTimerRef.current = null
      if (dismissTarget && focusedRef.current === dismissTarget) {
        clearFocusedInput()
      } else if (!dismissTarget) {
        clearFocusedInput()
      }
    }, OSK_ENTER_DISMISS_MS)
  }, [clearFocusedInput])

  const backspaceFocusedInput = useCallback(() => {
    const el = focusedRef.current
    if (!el) return null
    const cur = String(el.value ?? '')
    if (cur.length === 0) return null
    const next = cur.slice(0, -1)
    setInputValueState(next)
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement?.prototype ?? window.HTMLInputElement.prototype,
      'value'
    )?.set
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, next)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      el.value = next
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return next
  }, [])

  useEffect(() => {
    const handleFocusIn = (e) => {
      const target = e.target
      if (!target?.closest) return
      const el = target.closest('input, textarea')
      if (!el) return
      if (el.getAttribute('data-no-osk') === 'true') return
      const type = (el.type || '').toLowerCase()
      if (type === 'hidden' || type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button') return
      setFocusedInput(el)
    }

    const isOskFocusTarget = (node) =>
      !!node &&
      !!node.closest &&
      (node.closest('.on-screen-keyboard-wrapper') ||
        node.closest('.simple-keyboard-container') ||
        node.closest('.hg-theme-default') ||
        node.closest('.simple-keyboard'))

    const handleFocusOut = (e) => {
      const related = e.relatedTarget
      const leaving = e.target
      if (leaving !== focusedRef.current) return
      if (
        related?.closest?.('input') ||
        related?.closest?.('textarea') ||
        isOskFocusTarget(related) ||
        related?.closest?.('[data-keyboard-toggle="true"]')
      ) {
        return
      }
      if (related == null) {
        queueMicrotask(() => {
          if (focusedRef.current !== leaving) return
          const ae = document.activeElement
          if (ae === leaving) return
          if (isOskFocusTarget(ae)) return
          if (ae?.closest?.('input') || ae?.closest?.('textarea')) return
          if (ae?.closest?.('[data-keyboard-toggle="true"]')) return
          clearFocusedInput()
        })
        return
      }
      clearFocusedInput()
    }

    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)
    return () => {
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
    }
  }, [setFocusedInput, clearFocusedInput])

  const value = {
    inputValue,
    setInputValue,
    visible,
    setVisible,
    setFocusedInput,
    clearFocusedInput,
    toggleKeyboardForInput,
    pressEnterOnFocusedInput,
    backspaceFocusedInput,
  }

  useEffect(() => {
    if (visible) {
      document.body.classList.add('keyboard-open')
    } else {
      document.body.classList.remove('keyboard-open')
    }
    return () => document.body.classList.remove('keyboard-open')
  }, [visible])

  useEffect(() => () => {
    if (enterDismissTimerRef.current) {
      clearTimeout(enterDismissTimerRef.current)
      enterDismissTimerRef.current = null
    }
  }, [])

  return (
    <KeyboardContext.Provider value={value}>
      {children}
    </KeyboardContext.Provider>
  )
}

export function useKeyboard() {
  const ctx = useContext(KeyboardContext)
  if (!ctx) throw new Error('useKeyboard must be used within KeyboardProvider')
  return ctx
}
