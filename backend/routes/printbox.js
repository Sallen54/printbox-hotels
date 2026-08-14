const express = require('express')
const router = express.Router()
const fetch = require('node-fetch')
const tough = require('tough-cookie')
const fetchCookieModule = require('fetch-cookie')
const fetchCookie = fetchCookieModule.default || fetchCookieModule
const sharp = require('sharp')

// Por aquí viajan fotos en base64, teléfonos y códigos OTP. En prod proxy.php ya
// sondea HTTPS y lo usa si el certificado es válido; aquí (solo dev) se deja HTTP por
// compatibilidad, pero se puede forzar con PRINTBOX_BASE=https://gestion.printboxweb.com
const BASE = process.env.PRINTBOX_BASE || 'http://gestion.printboxweb.com'

// CookieJar compartido — mantiene la sesión y el token CSRF entre peticiones
const cookieJar = new tough.CookieJar()
const fetchWithCookies = fetchCookie(fetch, cookieJar)

// Obtiene el token CSRF haciendo un GET a la home de Laravel
// Laravel devuelve una cookie XSRF-TOKEN que hay que reenviar en cada POST
async function getCsrfToken() {
  await fetchWithCookies(`${BASE}/sanctum/csrf-cookie`, { method: 'GET' })
  const cookies = await cookieJar.getCookies(BASE)
  const xsrf = cookies.find(c => c.key === 'XSRF-TOKEN')
  if (xsrf) return decodeURIComponent(xsrf.value)

  // Fallback: intentar con la ruta raíz
  await fetchWithCookies(BASE, { method: 'GET' })
  const cookies2 = await cookieJar.getCookies(BASE)
  const xsrf2 = cookies2.find(c => c.key === 'XSRF-TOKEN')
  return xsrf2 ? decodeURIComponent(xsrf2.value) : null
}

// POST con token CSRF y cookies de sesión. Reintenta una vez ante 419 (CSRF caducado):
// vacía el jar y vuelve a pedir el csrf-cookie.
async function postWithCsrf(url, body) {
  const doPost = async () => {
    const csrfToken = await getCsrfToken()
    const headers = {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json',
    }
    if (csrfToken) headers['X-XSRF-TOKEN'] = csrfToken
    return fetchWithCookies(url, { method: 'POST', headers, body: JSON.stringify(body) })
  }
  let r = await doPost()
  if (r.status === 419) {
    await new Promise((resolve) => cookieJar.removeAllCookies(() => resolve()))
    r = await doPost()
  }
  return r
}

router.post('/find-event', async (req, res) => {
  try {
    const { code } = req.body
    const r = await postWithCsrf(`${BASE}/api/v1/events/find`, { code })
    const data = await r.json()
    console.log(`[printbox] find-event ${code} → ${r.status}`, JSON.stringify(data).slice(0, 200))
    if (!r.ok) return res.status(r.status).json({ error: data })
    res.json({ uuid: data?.data?.uuid })
  } catch (err) {
    console.error('[printbox] find-event error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

router.post('/photos', async (req, res) => {
  try {
    const page = req.query.page || 1
    const { event } = req.body
    const r = await postWithCsrf(`${BASE}/api/v1/events/photos?page=${page}&limit=20`, { event })
    const data = await r.json()
    console.log(`[printbox] photos page=${page} → ${r.status}`)
    if (!r.ok) return res.status(r.status).json({ error: data })
    if (data.data) data.data = data.data.slice(0, 20)
    res.json(data)
  } catch (err) {
    console.error('[printbox] photos error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Resolver un evento a UUID usando código o UUID directo
async function resolveEventId(event) {
  if (!event) throw new Error('Evento no definido')
  if (typeof event !== 'string') throw new Error('Evento inválido')
  if (event.startsWith('ev-')) {
    const r = await postWithCsrf(`${BASE}/api/v1/events/find`, { code: event })
    const data = await r.json()
    if (!r.ok) throw new Error(data?.error || JSON.stringify(data))
    return data?.data?.uuid
  }
  return event
}

// Descargar una imagen y devolver base64 + orientación
async function downloadImageAsDataUrl(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`No se pudo descargar imagen: ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const meta = await sharp(buffer).metadata().catch(() => null)
  const orientation = meta?.width && meta?.height && meta.width >= meta.height ? 'landscape' : 'portrait'
  return {
    image: `data:image/jpeg;base64,${buffer.toString('base64')}`,
    orientation,
  }
}

router.post('/photos-to-print', async (req, res) => {
  try {
    const { event } = req.body
    const r = await postWithCsrf(`${BASE}/api/v1/events/photos_two`, { event })
    const data = await r.json()
    console.log(`[printbox] photos-to-print → ${r.status}`)
    if (!r.ok) return res.status(r.status).json({ error: data })
    res.json(data)
  } catch (err) {
    console.error('[printbox] photos-to-print error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

router.post('/otp/request', async (req, res) => {
  try {
    const { phone, phone_country } = req.body
    const r = await postWithCsrf(`${BASE}/api/v1/otp/generate`, { phone, phone_country })
    const data = await r.json()
    console.log(`[printbox] otp/request → ${r.status}`)
    if (!r.ok) return res.status(r.status).json({ error: data })
    res.json(data)
  } catch (err) {
    console.error('[printbox] otp/request error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

router.post('/otp/validate', async (req, res) => {
  try {
    const { phone, phone_country, crypt_otp } = req.body
    const r = await postWithCsrf(`${BASE}/api/v1/otp/validate`, { phone, phone_country, crypt_otp })
    const data = await r.json()
    console.log(`[printbox] otp/validate → ${r.status}`)
    if (!r.ok) return res.status(r.status).json({ error: data })
    res.json(data)
  } catch (err) {
    console.error('[printbox] otp/validate error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

router.post('/photo-send', async (req, res) => {
  try {
    const { event, image, times = 1, name, phone, print, orientation } = req.body
    const payload = {
      event,
      image,
      times,
      name: name || `photo-${Date.now()}`,
      print: typeof print !== 'undefined' ? print : Boolean(times > 0),
    }
    if (phone) payload.phone = phone
    if (orientation) payload.orientation = orientation

    const csrfToken = await getCsrfToken()
    const r = await fetchWithCookies(`${BASE}/api/v1/events/photo/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
        'X-XSRF-TOKEN': csrfToken,
      },
      body: JSON.stringify(payload),
    })
    const data = await r.json()
    if (!r.ok) return res.status(r.status).json({ error: data })
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /printbox/notify-order — avisa a recepción por e-mail de un pedido de habitación.
// En dev no hay SMTP configurado (ver proxy.php, que sí usa mail() en producción IONOS),
// así que aquí solo se deja constancia en consola. Igual que la cámara (solo funciona en
// HTTPS de producción), es una limitación conocida y documentada del entorno de desarrollo.
router.post('/notify-order', async (req, res) => {
  const { room, items = [], fotos, total, paymentMethod } = req.body
  // `items` puede traer solo las primeras miniaturas de un pedido grande; `fotos` es el total.
  const numFotos = Math.max(items.length, Number(fotos) || 0)
  console.log(`[notify-order] Habitación ${room} envió ${numFotos} foto(s) — total ${total}€ (${paymentMethod}). ` +
    `Miniaturas en el aviso: ${items.length}. [DEV] No se envía e-mail real, solo se loguea.`)
  res.json({ ok: true, devStub: true })
})

module.exports = router