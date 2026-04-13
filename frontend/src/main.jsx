import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import BackDisplay from './components/BackDisplay.jsx'

const isBackDisplay = typeof window !== 'undefined' && (
  window.location.pathname === '/back-display' ||
  (window.location.search && new URLSearchParams(window.location.search).get('display') === 'back')
)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isBackDisplay ? <BackDisplay /> : <App />}
  </StrictMode>,
)
