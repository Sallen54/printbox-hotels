// En dev todo va al Express de :4000; en producción se usan rutas relativas para que
// las reescrituras del .htaccess las lleven a proxy.php. (La rama de electronAPI es
// herencia de Adventures: aquí no hay Electron y nunca se cumple.)
const BACKEND_URL =
  window.electronAPI ? 'http://localhost:4000' :
  (window.location.hostname === 'localhost' ? 'http://localhost:4000' : '')

// En dev el panel corre en :3000 y el backend en :4000 (cross-origin): la cookie de
// sesión solo viaja si las peticiones autenticadas usan credentials:'include'. En prod
// es same-origin, así que es inofensivo. Se aplica a todo lo que dependa de la sesión.
const CREDS = { credentials: 'include' }

// ─── Autenticación de hotel (login por sesión, cuentas creadas por Printbox) ──

export async function login(user, password) {
  const res = await fetch(`${BACKEND_URL}/auth/login`, {
    method: 'POST', ...CREDS,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, password }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data?.error || 'Error al iniciar sesión')
  return data // { ok, hotelId, nombre }
}

export async function getMe() {
  const res = await fetch(`${BACKEND_URL}/auth/me`, CREDS)
  if (res.status === 401) return null
  if (!res.ok) throw new Error('Error comprobando la sesión')
  return res.json() // { hotelId, nombre }
}

export async function logout() {
  await fetch(`${BACKEND_URL}/auth/logout`, { method: 'POST', ...CREDS }).catch(() => {})
}

// Logo del hotel: lo sirve el backend desde config/hotels/<id>/hotel-logo.png con fallback
// al placeholder de assets/. Va por endpoint (no archivo estático) para que el logo subido
// sobreviva a un redespliegue de dist/. En el panel el hotel se resuelve por la cookie de
// sesión; en el móvil hay que pasar el hotelId del QR → hotelLogoUrl(hotelId).
export function hotelLogoUrl(hotelId = '') {
  const q = hotelId ? `?hotel=${encodeURIComponent(hotelId)}` : ''
  return `${BACKEND_URL}/hotel-logo${q}`
}

export async function uploadHotelLogo(dataUrl) {
  const res = await fetch(hotelLogoUrl(), {
    method: 'POST', ...CREDS,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data?.error || 'Error al subir el logo')
  return data
}

// Habitaciones registradas del hotel: [{ nombre, codigo }] — codigo sin prefijo ev-.
// Viajan por el mismo POST /config que config/textos (requiere sesión).
export async function saveHabitaciones(habitaciones) {
  const res = await fetch(`${BACKEND_URL}/config/`, {
    method: 'POST', ...CREDS,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ habitaciones }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || 'Error al guardar las habitaciones')
  return data
}

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

export async function getConfig(hotelId = '') {
  // Panel: hotel por cookie de sesión (no hace falta hotelId). Móvil: hotelId del QR.
  const queryParam = hotelId ? `?hotel=${encodeURIComponent(hotelId)}` : ''
  const url = `${BACKEND_URL}/config/${queryParam}`
  try {
    const res = await fetch(url, CREDS)
    if (!res.ok) {
      console.error(`GET /config returned ${res.status}, using defaults`)
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

export async function saveConfig(config, textos) {
  // Requiere sesión: el backend guarda SIEMPRE en la carpeta del hotel de la cookie.
  // IMPORTANTE: usar /config/ con barra final para evitar redirect 301 de Apache.
  // Sin la barra, Apache redirige /config → /config/ y el redirect convierte POST en GET,
  // perdiendo el body (los precios llegan vacíos al servidor).
  const url = `${BACKEND_URL}/config/`
  try {
    const res = await fetch(url, {
      method: 'POST', ...CREDS,
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

// `order` = { hotel, evento, copies: [n,...], coupon } → el servidor recalcula el
// importe con los precios del hotel y rechaza el pago si no cuadra. Sin él el
// importe lo decidiría el cliente. Ver pbhCheckAmountCents() en proxy.php.
export async function createPayPalOrder({ amount, currency = 'EUR', order }) {
  const url = `${BACKEND_URL || ''}/paypal/create-order`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, currency, order }),
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

// location_id ya no se envía: lo pone el servidor desde config/square.json.
// `order` viaja para que el servidor pueda recalcular el importe (ver arriba).
export async function processPayment({ token, amount, currency = 'EUR', order }) {
  const url = `${BACKEND_URL || ''}/process-payment`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ token, amount, currency, order }),
  })
  const data = await res.json()

  if (data?.errors) {
    const errMsg = data.errors.map(e => e.detail || e.message || JSON.stringify(e)).join(', ')
    throw new Error(`Square error: ${errMsg}`)
  }
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}: ${JSON.stringify(data)}`)
  }
  return data
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
export async function notifyRoomOrder({ hotel = '', room, items, total, paymentMethod }) {
  // El email de recepción se lee del hotel indicado (?hotel= lo resuelve el backend).
  const q = hotel ? `?hotel=${encodeURIComponent(hotel)}` : ''
  const res = await fetch(`${BACKEND_URL}/printbox/notify-order${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: normalizeEventCode(room), items, total, paymentMethod }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || 'Error al notificar a recepción')
  return data
}