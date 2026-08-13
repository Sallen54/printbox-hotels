const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs-extra')
const fetch = require('node-fetch')

const printRoutes = require('./routes/print')
const configRoutes = require('./routes/config')
const printboxRoutes = require('./routes/printbox')
const authRoutes = require('./routes/auth')
const { getSessionHotelId, resolveHotelDir } = require('./lib/session')

const app = express()
const PORT = 4000

// Sin Electron, este backend solo corre en desarrollo con `node backend/server.js` —
// los datos siempre viven en la raíz del proyecto (ver README §8).
const DATA_DIR = process.cwd()

app.locals.dataDir = DATA_DIR

;['descargas', 'pdf', 'config'].forEach(d =>
  fs.ensureDirSync(path.join(DATA_DIR, d))
)

const defaultConfig = path.join(__dirname, '../config')
const userConfig = path.join(DATA_DIR, 'config')
if (fs.existsSync(defaultConfig)) {
  ;['servidor_api.txt', 'textos.txt'].forEach(f => {
    const dest = path.join(userConfig, f)
    const src = path.join(defaultConfig, f)
    if (!fs.existsSync(dest) && fs.existsSync(src)) fs.copySync(src, dest)
  })
}

const LOG_PATH = path.join(DATA_DIR, 'PBAcount.txt')
if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '0')
app.locals.logPath = LOG_PATH

// Se permite la cookie de sesión en dev cross-origin (panel :3000 → backend :4000 y
// el móvil por IP de la LAN), pero NO se refleja cualquier Origin de internet: solo
// localhost y rangos privados. En prod es same-origin (proxy.php).
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/i
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true)            // curl, apps nativas, same-origin
    if (LOCAL_ORIGIN_RE.test(origin)) return cb(null, true)
    return cb(null, false)                        // sin cabeceras CORS → el navegador bloquea
  },
  credentials: true,
}))
// Límite alto: las fotos y el logo viajan como base64 en JSON (el default de 100kb no alcanza)
app.use(express.json({ limit: '25mb' }))

// dist/ se sirve como estático, y dentro vive una copia de config/. Sin esto,
// http://<host>:4000/config/square.json devolvería el token de Square en claro
// (en prod lo tapa config/.htaccess, pero Express no lee .htaccess).
// Ojo: la API de config es exactamente /config o /config/ y sigue funcionando.
app.use((req, res, next) => {
  if (/^\/config\/.+/i.test(req.path)) {
    return res.status(403).json({ error: 'Prohibido' })
  }
  next()
})

const distPath = path.join(__dirname, '../dist')
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
}

const assetsPath = path.join(__dirname, '../src/public/assets')
app.use('/assets', express.static(assetsPath))

app.use('/descargas', express.static(path.join(DATA_DIR, 'descargas')))

app.get('/health', (_req, res) => res.json({ ok: true }))

app.use('/auth', authRoutes)

// ── Logo del hotel (por hotel) ──
// GET: sirve config/hotels/<id>/hotel-logo.png (o el global legado), con fallback al
//   placeholder de assets/. El hotel se resuelve por sesión (panel) o ?hotel= (móvil).
// POST: guarda el logo (base64 PNG/JPEG, redimensionado en el cliente) en la carpeta
//   del hotel de la SESIÓN — exige estar autenticado.
const baseConfigDir = path.join(DATA_DIR, 'config')

app.get('/hotel-logo', (req, res) => {
  res.set('Cache-Control', 'no-cache')
  const hotelId = getSessionHotelId(req, baseConfigDir) || req.query.hotel
  const dir = resolveHotelDir(baseConfigDir, hotelId)
  const logoPath = path.join(dir, 'hotel-logo.png')
  if (fs.existsSync(logoPath)) return res.type('png').sendFile(logoPath)
  res.type('png').sendFile(path.join(assetsPath, 'hotel-logo.png'))
})

app.post('/hotel-logo', (req, res) => {
  try {
    const hotelId = getSessionHotelId(req, baseConfigDir)
    if (!hotelId) return res.status(401).json({ error: 'No autenticado' })
    const image = String(req.body?.image || '')
    const match = image.match(/^data:image\/(png|jpeg);base64,(.+)$/)
    if (!match) return res.status(400).json({ error: 'Formato inválido: se espera data URL PNG/JPEG' })
    const buffer = Buffer.from(match[2], 'base64')
    if (!buffer.length || buffer.length > 3 * 1024 * 1024) {
      return res.status(400).json({ error: 'Imagen vacía o mayor de 3MB' })
    }
    const dir = resolveHotelDir(baseConfigDir, hotelId, { create: true })
    fs.writeFileSync(path.join(dir, 'hotel-logo.png'), buffer)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Credenciales de Square: variables de entorno si existen, si no config/square.json
// (fuera de git, protegido por config/.htaccess en prod). Nunca hardcodeadas en el código.
function getSquareCredentials() {
  let accessToken = process.env.SQUARE_ACCESS_TOKEN || ''
  let locationId = process.env.SQUARE_LOCATION_ID || ''
  if (!accessToken || !locationId) {
    try {
      const f = path.join(baseConfigDir, 'square.json')
      if (fs.existsSync(f)) {
        const parsed = JSON.parse(fs.readFileSync(f, 'utf8'))
        if (!accessToken) accessToken = parsed.accessToken || ''
        if (!locationId) locationId = parsed.locationId || ''
      }
    } catch {}
  }
  return { accessToken, locationId }
}

// ── Validación del importe en el SERVIDOR ──
// El cliente manda el importe, pero no se puede confiar en él (DevTools/curl). Se
// recalcula aquí a partir de los precios del hotel y el desglose de copias que
// acompaña al pago (`order`). Misma lógica que en proxy.php: mantener ambos a la par.
function readHotelPrices(hotelId) {
  const prices = { precio1: 5, precio2: 9, precio3: 12 }
  try {
    const dir = resolveHotelDir(baseConfigDir, hotelId)
    const f = path.join(dir, 'textos.txt')
    if (fs.existsSync(f)) {
      for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        const i = line.indexOf(':')
        if (i < 0) continue
        const key = line.slice(0, i).trim()
        const val = parseFloat(String(line.slice(i + 1)).trim().replace(',', '.'))
        if (['precio1', 'precio2', 'precio3'].includes(key) && !isNaN(val)) prices[key] = val
      }
    }
  } catch {}
  return prices
}

// Devuelve { ok } o { ok:false, error }. `order` = { copies:[n,...], coupon? }
function checkAmount(req, amountCents) {
  const hotelId = getSessionHotelId(req, baseConfigDir) || req.body?.order?.hotel || req.query.hotel || ''
  const p = readHotelPrices(hotelId)
  const priceFor = (c) => [0, p.precio1, p.precio2, p.precio3][Math.min(Math.max(parseInt(c) || 0, 0), 3)] || 0
  const copies = req.body?.order?.copies

  if (Array.isArray(copies) && copies.length) {
    const expected = Math.round(copies.reduce((s, c) => s + priceFor(c), 0) * 100)
    // Con cupón el descuento lo valida proxy.php (en dev no hay almacén de cupones):
    // aquí solo se exige que no supere el total sin descuento.
    if (req.body?.order?.coupon) {
      return amountCents <= expected ? { ok: true } : { ok: false, error: 'Importe superior al total del pedido' }
    }
    return amountCents === expected
      ? { ok: true }
      : { ok: false, error: `El importe no coincide con el pedido (esperado ${(expected / 100).toFixed(2)}€, recibido ${(amountCents / 100).toFixed(2)}€)` }
  }

  // Cliente antiguo sin desglose: al menos que no se pueda pagar 1 céntimo.
  const min = Math.round(Math.min(p.precio1, p.precio2, p.precio3) * 100)
  return amountCents >= min ? { ok: true } : { ok: false, error: 'Importe inferior al mínimo configurado' }
}

// Pago con Square. Ojo: en dev se cobra contra el SANDBOX; producción (proxy.php)
// va contra connect.squareup.com con dinero real.
app.post('/process-payment', async (req, res) => {
  try {
    const { token, amount, currency = 'EUR' } = req.body

    if (!token || !amount) {
      return res.status(400).json({ error: 'Token y amount son requeridos' })
    }

    // El cliente envía céntimos (String(finalCents)), no euros.
    const amountCents = Math.round(parseFloat(amount))
    if (!amountCents || amountCents <= 0) {
      return res.status(400).json({ error: 'Importe inválido' })
    }
    const check = checkAmount(req, amountCents)
    if (!check.ok) return res.status(400).json({ error: check.error })

    const { accessToken: SQUARE_ACCESS_TOKEN, locationId: SQUARE_LOCATION_ID } = getSquareCredentials()
    if (!SQUARE_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'Square no configurado en el servidor' })
    }

    const payload = {
      source_id: token,
      idempotency_key: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      amount_money: {
        amount: amountCents,
        currency,
      },
      // location_id SIEMPRE del servidor: si viene del cliente se puede desviar el cobro.
      location_id: SQUARE_LOCATION_ID,
    }

    const squareRes = await fetch('https://connect.squareupsandbox.com/v2/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    })

    const data = await squareRes.json()
    if (!squareRes.ok) {
      return res.status(squareRes.status).json(data)
    }

    res.json(data)
  } catch (error) {
    console.error('process-payment error:', error)
    res.status(500).json({ error: error.message || 'Error al procesar el pago' })
  }
})

app.use('/printbox', printboxRoutes)
app.use('/print', printRoutes)
app.use('/config', configRoutes)

// Proxy de imágenes (para evitar CORS)
app.get('/proxy-image/*', async (req, res) => {
  try {
    // Se limpia la ruta para que no pueda salirse del host de Laravel (SSRF).
    const imagePath = '/' + String(req.params[0]).replace(/\.\.|\\|\0/g, '').replace(/^\/+/, '')
    const imageUrl = (process.env.PRINTBOX_BASE || 'http://gestion.printboxweb.com') + imagePath

    console.log(`[proxy-image] Fetching: ${imageUrl}`)

    const response = await fetch(imageUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    })

    if (!response.ok) {
      console.error(`[proxy-image] Error ${response.status}: ${imageUrl}`)
      return res.status(response.status).json({ error: 'Imagen no encontrada' })
    }

    const contentType = response.headers.get('content-type')
    if (contentType) res.set('Content-Type', contentType)

    res.set('Cache-Control', 'public, max-age=86400')
    const buffer = await response.buffer()
    res.send(buffer)
  } catch (err) {
    console.error('[proxy-image] Error:', err.message)
    res.status(500).json({ error: 'Error al obtener imagen' })
  }
})

// Fallback para React Router
app.get('*', (_req, res) => {
  const indexPath = path.join(distPath, 'index.html')
  if (fs.existsSync(indexPath)) res.sendFile(indexPath)
  else res.status(404).send('Not found')
})

app.listen(PORT, () =>
  console.log(`[Backend] Printbox Hotels escuchando en :${PORT}`)
)

console.log(`[Backend] Directorio de datos: ${DATA_DIR}`)
console.log(`[Backend] Assets: ${assetsPath}`)

module.exports = app