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

// Copiar config por defecto si no existe
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

// origin:true refleja el Origin y credentials:true permite la cookie de sesión en
// dev cross-origin (panel :3000 → backend :4000). En prod es same-origin (proxy.php).
app.use(cors({ origin: true, credentials: true }))
// Límite alto: las fotos y el logo viajan como base64 en JSON (el default de 100kb no alcanza)
app.use(express.json({ limit: '25mb' }))

// Servir el frontend (dist) desde Express en producción
const distPath = path.join(__dirname, '../dist')
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
}

// Servir assets (banners, logos, qr)
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

// Square payment endpoint (local backend)
app.post('/process-payment', async (req, res) => {
  try {
    const { token, amount, currency = 'EUR', location_id } = req.body

    if (!token || !amount) {
      return res.status(400).json({ error: 'Token y amount son requeridos' })
    }

    const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || 'EAAAl0j_Yx8fE69GiPLm7N3hmvuLAD2h6uRIaKomqSVfInluHW9gzA0twdKLPrn8'
    const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || 'LHB32XGQK68GX'

    const payload = {
      source_id: token,
      idempotency_key: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      amount_money: {
        amount: Math.round(parseFloat(amount) * 100),
        currency,
      },
      location_id: location_id || SQUARE_LOCATION_ID,
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
    const imagePath = '/' + req.params[0]
    const imageUrl = 'http://gestion.printboxweb.com' + imagePath

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