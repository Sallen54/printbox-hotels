// Detecta si estamos en local (Electron/dev) o en producción (IONOS)
// En Electron: siempre usar localhost:4000 para todo (viewer, mobile, printer)
// En localhost web: http://localhost:4000 para TODO (viewer, mobile) - mismo backend para sincronizar config
// En producción IONOS: rutas relativas para proxy.php (todos los apps)
const BACKEND_URL = 
  window.electronAPI ? 'http://localhost:4000' : 
  (window.location.hostname === 'localhost' ? 'http://localhost:4000' : 
    '' // Producción: usar rutas relativas para proxy.php
  )

// ─── API Printbox ───────────────────────────────────────────────────────────

export async function findEvent(eventCode) {
  const res = await fetch(`${BACKEND_URL}/printbox/find-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: eventCode }),
  })
  if (!res.ok) throw new Error(`Error al buscar evento: ${res.status}`)
  const data = await res.json()
  return data.uuid
}

export async function getEventPhotos(uuid, page = 1) {
  const res = await fetch(`${BACKEND_URL}/printbox/photos?page=${page}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: uuid }),
  })
  if (!res.ok) throw new Error(`Error al obtener fotos: ${res.status}`)
  const data = await res.json()
  return { photos: data.data || [], lastPage: data.last_page || 1 }
}

export async function getPhotosToPrint(uuid) {
  const res = await fetch(`${BACKEND_URL}/printbox/photos-to-print`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: uuid }),
  })
  if (!res.ok) throw new Error(`Error al obtener fotos para imprimir: ${res.status}`)
  const data = await res.json()
  return data.values || []
}

function formatApiError(data, defaultMessage) {
  if (!data) return defaultMessage
  if (data?.message && typeof data.message === 'string') {
    const errors = data.errors
    if (errors && typeof errors === 'object') {
      const detail = Object.values(errors).flat().join(' ')
      return detail ? `${data.message}: ${detail}` : data.message
    }
    return data.message
  }
  if (data?.error) {
    if (typeof data.error === 'string') return data.error
    if (data.error?.message) return data.error.message
  }
  return defaultMessage
}

function normalizePhone(phone, country) {
  if (!phone) return phone
  const trimmed = phone.trim()
  if (trimmed.startsWith('+')) {
    return trimmed
  }
  if (trimmed.startsWith('00')) {
    return '+' + trimmed.slice(2)
  }

  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return trimmed

  switch ((country || '').toUpperCase()) {
    case 'ES':
      if (digits.length === 9) return '+34' + digits
      if (digits.length === 11 && digits.startsWith('34')) return '+' + digits
      return '+34' + digits
    case 'US':
    case 'CA':
      if (digits.length === 10) return '+1' + digits
      if (digits.length === 11 && digits.startsWith('1')) return '+' + digits
      return '+1' + digits
    default:
      return '+' + digits
  }
}

export async function requestOtp({ phone, phone_country = 'ES' }) {
  const normalizedPhone = normalizePhone(phone, phone_country)
  const res = await fetch(`${BACKEND_URL}/printbox/otp/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: normalizedPhone, phone_country }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(formatApiError(data, 'Error solicitando OTP'))
  return data
}

export async function validateOtp({ phone, phone_country = 'ES', crypt_otp }) {
  const normalizedPhone = normalizePhone(phone, phone_country)
  const res = await fetch(`${BACKEND_URL}/printbox/otp/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: normalizedPhone, phone_country, crypt_otp }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(formatApiError(data, 'Error validando OTP'))
  return data
}

// ─── Backend local ───────────────────────────────────────────────────────────

export async function getPrinters() {
  try {
    const res = await fetch(`${BACKEND_URL}/print/printers`)
    const data = await res.json()
    return data.printers || []
  } catch {
    return []
  }
}

export async function getPrintCount() {
  try {
    const res = await fetch(`${BACKEND_URL}/print/count`)
    const data = await res.json()
    return data.count || 0
  } catch {
    return 0
  }
}

export async function printJob({ imageUrl, imageName, printer, delay = 5 }) {
  const res = await fetch(`${BACKEND_URL}/print/job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl, imageName, printer, delay }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error || 'Error al imprimir')
  }
  return res.json()
}

function normalizeEventCode(eventCode = '') {
  if (!eventCode) return ''
  return String(eventCode).trim().replace(/^ev[-_]?/i, '')
}

export async function getConfig(eventCode = '') {
  // Si eventCode incluye prefijo 'ev-' o 'ev_', se elimina antes de hacer la petición
  const normalizedEventCode = normalizeEventCode(eventCode)
  const queryParam = normalizedEventCode ? `?eventCode=${encodeURIComponent(normalizedEventCode)}` : ''
  const url = `${BACKEND_URL}/config/${queryParam}`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      // Log the error but return defaults instead of throwing
      console.error(`GET /config returned ${res.status}, using defaults`)
      // Return default config structure
      return {
        config: {
          servidor: 'http://gestion.printboxweb.com',
          evento: '',
          timer: 5,
          impresora: '',
          delay: 5,
        },
        textos: {
          text_es: '¡Consigue tu foto del evento!',
          text_en: 'Get your event photo!',
          text_fr: 'Obtenez votre photo!',
          text_de: 'Hol dir dein Foto!',
          precio1: '5',
          precio2: '9',
          precio3: '12',
          empresa: 'Printbox Hotels',
        },
      }
    }
    const data = await res.json()
    return data
  } catch (error) {
    console.error('Error fetching config:', error)
    // Return defaults on network error
    return {
      config: {
        servidor: 'http://gestion.printboxweb.com',
        evento: '',
        timer: 5,
        impresora: '',
        delay: 5,
      },
      textos: {
        text_es: '¡Consigue tu foto del evento!',
        text_en: 'Get your event photo!',
        text_fr: 'Obtenez votre photo!',
        text_de: 'Hol dir dein Foto!',
        precio1: '5',
        precio2: '9',
        precio3: '12',
        empresa: 'Printbox Hotels',
      },
    }
  }
}

export async function saveConfig(config, textos, eventCode = '') {
  // Si eventCode incluye prefijo 'ev-' o 'ev_', se elimina antes de guardar.
  // IMPORTANTE: usar /config/ con barra final para evitar redirect 301 de Apache.
  // Sin la barra, Apache redirige /config → /config/ y el redirect convierte POST en GET,
  // perdiendo el body (los precios llegan vacíos al servidor).
  const normalizedEventCode = normalizeEventCode(eventCode)
  const queryParam = normalizedEventCode ? `?eventCode=${encodeURIComponent(normalizedEventCode)}` : ''
  const url = `${BACKEND_URL}/config/${queryParam}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, textos }),
    })
    if (!res.ok) {
      console.error(`POST /config returned ${res.status}`)
      const errorText = await res.text()
      throw new Error(`HTTP ${res.status}: ${errorText.substring(0, 100)}`)
    }
    const data = await res.json()
    return data
  } catch (error) {
    console.error('Error saving config:', error)
    throw error
  }
}

export async function createPayPalOrder({ amount, currency = 'EUR' }) {
  const url = `${BACKEND_URL || ''}/paypal/create-order`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, currency }),
  })
  const data = await res.json()
  if (!res.ok) {
    const msg = data?.error || data?.message || `HTTP ${res.status}`
    throw new Error(`PayPal create order failed: ${msg}`)
  }
  return data.orderID || data.id || data.orderId
}

export async function capturePayPalOrder(orderId) {
  const url = `${BACKEND_URL || ''}/paypal/capture-order`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId }),
  })
  const data = await res.json()
  if (!res.ok) {
    const msg = data?.error || data?.message || `HTTP ${res.status}`
    throw new Error(`PayPal capture order failed: ${msg}`)
  }
  return data
}

export async function getPayPalConfig() {
  const url = `${BACKEND_URL || ''}/paypal/config`
  const res = await fetch(url)
  const data = await res.json()
  if (!res.ok) {
    const msg = data?.error || data?.message || `HTTP ${res.status}`
    throw new Error(`PayPal config fetch failed: ${msg}`)
  }
  return data
}

export async function processPayment({ token, amount, currency = 'EUR', location_id }) {
  const url = `${BACKEND_URL || ''}/process-payment`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, amount, currency, location_id }),
    })
    const data = await res.json()
    
    // Log completo para debuggear
    console.log('Square response:', { status: res.status, ok: res.ok, data })
    
    // Si hay errores en la respuesta de Square, lanzar excepción
    if (data?.errors) {
      const errMsg = data.errors.map(e => e.detail || e.message || JSON.stringify(e)).join(', ')
      throw new Error(`Square error: ${errMsg}`)
    }
    
    // Si HTTP error, lanzar excepción
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}: ${JSON.stringify(data)}`)
    }
    
    return data
  } catch (e) {
    console.error('processPayment error:', e)
    throw e
  }
}

export async function sendPhoto({ event, image, times = 1, name, phone, print, orientation }) {
  const body = { event, image, times }
  if (name) body.name = name
  if (typeof print !== 'undefined') body.print = print
  if (phone) body.phone = phone
  if (orientation) body.orientation = orientation

  const res = await fetch(`${BACKEND_URL}/printbox/photo-send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error?.message || data?.message || 'Error al enviar foto')
  return data
}

// Avisa a recepción por e-mail de que una habitación ha enviado fotos.
// items: [{ thumbnail: 'data:image/jpeg;base64,...', copies: N }, ...] — una fila por foto del pedido (no por copia).
export async function notifyRoomOrder({ room, items, total, paymentMethod }) {
  const res = await fetch(`${BACKEND_URL}/printbox/notify-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: normalizeEventCode(room), items, total, paymentMethod }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || 'Error al notificar a recepción')
  return data
}