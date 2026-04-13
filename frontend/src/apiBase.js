/** Backend API origin. Resolved at call time so Cloudflare HTTPS + tunnel host is correct (not cached at module load). */
function resolveApiBase() {
  if (typeof window === 'undefined') return ''

  const h = window.location.hostname.toLowerCase()
  const isHttps = window.location.protocol === 'https:'

  const env = import.meta.env.VITE_API_BASE
  if (env) {
    let base = String(env).trim().replace(/\/$/, '')
    if (isHttps && base.startsWith('http://')) {
      const tunnelFront = String(import.meta.env.VITE_TUNNEL_FRONTEND_HOST || '').trim().toLowerCase()
      if (tunnelFront && h === tunnelFront && import.meta.env.VITE_TUNNEL_API_ORIGIN) {
        base = String(import.meta.env.VITE_TUNNEL_API_ORIGIN).trim().replace(/\/$/, '')
      } else if (h.startsWith('pos.') && !h.startsWith('pos-backend.')) {
        const zone = h.slice(4)
        if (zone) base = `https://pos-backend.${zone}`
      }
    }
    return base
  }

  const tunnelFront = String(import.meta.env.VITE_TUNNEL_FRONTEND_HOST || '').trim().toLowerCase()
  const tunnelApi = String(import.meta.env.VITE_TUNNEL_API_ORIGIN || '').trim().replace(/\/$/, '')
  if (tunnelFront && tunnelApi && h === tunnelFront) return tunnelApi

  if (isHttps && h.startsWith('pos.') && !h.startsWith('pos-backend.')) {
    const zone = h.slice(4)
    if (zone) return `https://pos-backend.${zone}`
  }

  return `http://${h}:7227`
}

export function getApiBase() {
  return resolveApiBase()
}
