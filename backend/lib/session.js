// Sesión de hotel compartida por las rutas del backend Express (dev).
// Misma lógica que proxy.php (prod): cookie firmada con HMAC, sin BD.
// Los hashes bcrypt de las cuentas (config/hotels.xml) los generan add-hotel.js
// y bcryptjs; password_verify() de PHP los acepta igual.

const crypto = require('crypto')
const fs = require('fs-extra')
const path = require('path')
const bcrypt = require('bcryptjs')

const COOKIE_NAME = 'pbh_session'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12 h

// El secreto HMAC vive en config/session_secret.txt (fuera del alcance web por .htaccess).
// Se genera la primera vez si no existe.
function getSecret(baseConfigDir) {
  const f = path.join(baseConfigDir, 'session_secret.txt')
  try {
    if (fs.existsSync(f)) {
      const s = fs.readFileSync(f, 'utf8').trim()
      if (s) return s
    }
  } catch {}
  const secret = crypto.randomBytes(32).toString('hex')
  try { fs.ensureDirSync(baseConfigDir); fs.writeFileSync(f, secret) } catch {}
  return secret
}

function makeToken(hotelId, baseConfigDir) {
  const expiry = Date.now() + SESSION_TTL_MS
  const data = `${hotelId}|${expiry}`
  const mac = crypto.createHmac('sha256', getSecret(baseConfigDir)).update(data).digest('hex')
  return `${data}|${mac}`
}

function verifyToken(token, baseConfigDir) {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('|')
  if (parts.length !== 3) return null
  const [hotelId, expiryStr, mac] = parts
  const expiry = parseInt(expiryStr, 10)
  if (!hotelId || !expiry || Date.now() > expiry) return null
  const expected = crypto.createHmac('sha256', getSecret(baseConfigDir)).update(`${hotelId}|${expiry}`).digest('hex')
  if (mac.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
  return hotelId
}

function parseCookies(req) {
  const header = req.headers?.cookie || ''
  const out = {}
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=')
    if (idx > -1) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim())
  })
  return out
}

function getSessionHotelId(req, baseConfigDir) {
  return verifyToken(parseCookies(req)[COOKIE_NAME], baseConfigDir)
}

// Cuentas de los hoteles: config/hotels.xml (formato oficial) con respaldo en hotels.json
// para despliegues sin migrar. Misma lógica que readHotelsAccounts() de proxy.php.
// <pass> es la contraseña legible (se edita a mano); <passHash> son las cuentas antiguas.
// El XML lo escribe siempre scripts/add-hotel.js, así que se parsea con regex en vez de
// añadir una dependencia de XML solo para esto.
function readHotels(baseConfigDir) {
  try {
    const xmlFile = path.join(baseConfigDir, 'hotels.xml')
    if (fs.existsSync(xmlFile)) {
      const xml = fs.readFileSync(xmlFile, 'utf8')
      const hotels = {}
      const tag = (block, name) => {
        const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
        return m ? m[1].trim() : ''
      }
      for (const m of xml.matchAll(/<hotel\s+id="([^"]+)"\s*>([\s\S]*?)<\/hotel>/g)) {
        const id = m[1].trim()
        if (!id) continue
        hotels[id] = {
          nombre: tag(m[2], 'nombre'),
          user: tag(m[2], 'usuario'),
          pass: tag(m[2], 'pass'),
          passHash: tag(m[2], 'passHash'),
        }
      }
      return hotels
    }
    const f = path.join(baseConfigDir, 'hotels.json')
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}
  } catch { return {} }
}

function sanitizeHotelId(id) {
  return String(id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
}

// Carpeta de config del hotel. hotelId válido → config/hotels/<id>; sin id → carpeta
// global (compat con el modelo antiguo de un solo hotel / QRs viejos sin ?hotel=).
// No crea la carpeta en lecturas: si no existe, el llamador leerá los defaults.
function resolveHotelDir(baseConfigDir, hotelId, { create = false } = {}) {
  const id = sanitizeHotelId(hotelId)
  if (!id) return baseConfigDir
  const dir = path.join(baseConfigDir, 'hotels', id)
  if (create) fs.ensureDirSync(dir)
  return dir
}

module.exports = {
  COOKIE_NAME, SESSION_TTL_MS,
  makeToken, verifyToken, parseCookies, getSessionHotelId,
  readHotels, sanitizeHotelId, resolveHotelDir, bcrypt,
}
