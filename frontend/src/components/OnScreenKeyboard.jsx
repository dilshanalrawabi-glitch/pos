import { useEffect, useLayoutEffect, useRef } from 'react'
import SimpleKeyboard from 'simple-keyboard'
import 'simple-keyboard/build/css/index.css'
import { useKeyboard } from '../context/KeyboardContext'
import '../styles/OnScreenKeyboard.css'

export default function OnScreenKeyboard() {
  const { inputValue, setInputValue, visible, pressEnterOnFocusedInput, backspaceFocusedInput } = useKeyboard()
  const wrapperRef = useRef(null)
  const containerRef = useRef(null)
  const keyboardRef = useRef(null)
  const onChangeDebounceRef = useRef(null)
  const lastValueRef = useRef('')

  const debouncedSetInput = (value) => {
    const prev = lastValueRef.current
    lastValueRef.current = value
    const isBackspace = value.length === prev.length - 1 && prev.slice(0, -1) === value
    if (isBackspace) {
      if (onChangeDebounceRef.current) {
        clearTimeout(onChangeDebounceRef.current)
        onChangeDebounceRef.current = null
      }
      setInputValue(value)
      return
    }
    if (onChangeDebounceRef.current) clearTimeout(onChangeDebounceRef.current)
    onChangeDebounceRef.current = setTimeout(() => {
      onChangeDebounceRef.current = null
      setInputValue(lastValueRef.current)
    }, 50)
  }

  useEffect(() => {
    if (!visible) {
      if (onChangeDebounceRef.current) {
        clearTimeout(onChangeDebounceRef.current)
        onChangeDebounceRef.current = null
      }
      if (keyboardRef.current) {
        keyboardRef.current.destroy()
        keyboardRef.current = null
      }
      return
    }
    if (!containerRef.current) return
    if (keyboardRef.current) {
      keyboardRef.current.setInput(inputValue)
      return
    }
    const keyboard = new SimpleKeyboard(containerRef.current, {
      onChange: (value) => debouncedSetInput(value),
      onKeyPress: (key) => {
        if (key === '{shift}' && keyboardRef.current) {
          const current = keyboardRef.current.options.layoutName || 'default'
          keyboardRef.current.setOptions({ layoutName: current === 'default' ? 'shift' : 'default' })
        }
        if (key === '{enter}') {
          pressEnterOnFocusedInput()
        }
        if (key === '{bksp}') {
          const nextVal = backspaceFocusedInput()
          if (keyboardRef.current && nextVal != null) {
            keyboardRef.current.setInput(nextVal)
            lastValueRef.current = nextVal
          }
        }
      },
      theme: 'hg-theme-default hg-layout-default',
      layout: {
        default: [
          '1 2 3 4 5 6 7 8 9 0 {bksp}',
          'q w e r t y u i o p',
          'a s d f g h j k l',
          '{shift} z x c v b n m {shift}',
          '@ . {space} {enter}',
        ],
        shift: [
          '! @ # $ % ^ & * ( ) {bksp}',
          'Q W E R T Y U I O P',
          'A S D F G H J K L',
          '{shift} Z X C V B N M {shift}',
          '@ . {space} {enter}',
        ],
      },
      display: {
        '{bksp}': '⌫',
        '{shift}': '⇧',
        '{space}': 'Space',
        '{enter}': 'Enter',
      },
      mergeDisplay: true,
      input: inputValue,
    })
    keyboardRef.current = keyboard
  }, [visible, inputValue, setInputValue, pressEnterOnFocusedInput])

  useLayoutEffect(() => {
    if (!visible) {
      document.documentElement.style.removeProperty('--keyboard-height')
      return
    }
    const el = wrapperRef.current
    if (!el) return
    const apply = () => {
      document.documentElement.style.setProperty('--keyboard-height', `${el.offsetHeight}px`)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => {
      ro.disconnect()
      document.documentElement.style.removeProperty('--keyboard-height')
    }
  }, [visible])

  if (!visible) return null

  const stopAndPrevent = (e) => {
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      ref={wrapperRef}
      className="on-screen-keyboard-wrapper"
      role="group"
      aria-label="On-screen keyboard"
      onPointerDown={stopAndPrevent}
      onPointerUp={stopAndPrevent}
      onPointerMove={stopAndPrevent}
      onPointerCancel={stopAndPrevent}
      onTouchStart={stopAndPrevent}
      onTouchEnd={stopAndPrevent}
      onTouchMove={stopAndPrevent}
      onTouchCancel={stopAndPrevent}
      onMouseDown={stopAndPrevent}
      onMouseUp={stopAndPrevent}
      onMouseMove={stopAndPrevent}
      onClick={stopAndPrevent}
      onContextMenu={stopAndPrevent}
      onWheel={stopAndPrevent}
    >
      <div ref={containerRef} className="simple-keyboard-container" />
    </div>
  )
}
