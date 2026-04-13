import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'

const KeyboardContext = createContext(null)

export function KeyboardProvider({ children }) {
  const [inputValue, setInputValueState] = useState('')
  const [visible, setVisible] = useState(false)
  const focusedRef = useRef(null)
  const inputListenerRef = useRef(null)

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
    if (focusedRef.current === el) return
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
    const el = focusedRef.current
    if (el) {
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
      el.dispatchEvent(new KeyboardEvent('keydown', opts))
      el.dispatchEvent(new KeyboardEvent('keyup', opts))
      if (el.form) {
        el.form.requestSubmit()
      }
    }
    clearFocusedInput()
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

    const handleFocusOut = (e) => {
      const related = e.relatedTarget
      if (related?.closest?.('input') || related?.closest?.('textarea') || related?.closest?.('.on-screen-keyboard-wrapper') || related?.closest?.('.hg-theme-default') || related?.closest?.('.simple-keyboard')) return
      if (related?.closest?.('[data-keyboard-toggle="true"]')) return
      if (e.target === focusedRef.current) {
        clearFocusedInput()
      }
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
