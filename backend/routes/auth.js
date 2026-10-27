const express = require('express')
const router = express.Router()
const path = require('path')
const os = require('os')
const { COOKIE_NAME, SESSION_TTL_MS, makeToken, getSessionHotelId, readHotels, bcrypt } = require('../lib/session')
const { blockedFor, registerFailure, clearFailures } = require('../lib/login-limiter')

function getBaseConfigDir(req) {
  const dataDir = req.app.locals.dataDir ||
    path.join(os.homedir(), 'AppData', 'Local', 'PrintboxHotels')
  return path.join(dataDir, 'config')
}

// En dev (http://localhost) no ponemos Secure para que la cookie se acepte.
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`)
}

router.post('/login', (req, res) => {
  try {
    const base = getBaseConfigDir(req)
    const { user, password } = req.body || {}
    if (!user || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' })

    const wait = blockedFor(req, user)
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait))
      return res.status(429).json({ error: `Demasiados intentos fallidos. Inténtalo de nuevo en ${Math.ceil(wait / 60)} min` })
    }

    const hotels = readHotels(base)
    // <pass> (legible) manda sobre <passHash> (cuentas antiguas). Misma regla que proxy.php.
    const coincide = (c) => {
      const enClaro = String(c.pass || '').trim()
      if (enClaro) return enClaro === String(password)
      return Boolean(c.passHash) && bcrypt.compareSync(String(password), c.passHash)
    }
    // Un hotel puede tener varias cuentas; vale cualquiera de ellas.
    const entry = Object.entries(hotels).find(([, h]) =>
      (h.cuentas || [h]).some(c => c.user === String(user).trim() && coincide(c)))
    if (!entry) {
      registerFailure(req, user)
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' })
    }
    const [hotelId, h] = entry
    clearFailures(req, user)
    setSessionCookie(res, makeToken(hotelId, base))
    res.json({ ok: true, hotelId, nombre: h.nombre || '' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/me', (req, res) => {
  const base = getBaseConfigDir(req)
  const hotelId = getSessionHotelId(req, base)
  if (!hotelId) return res.status(401).json({ error: 'No autenticado' })
  const hotels = readHotels(base)
  res.json({ hotelId, nombre: hotels[hotelId]?.nombre || '' })
})

router.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
  res.json({ ok: true })
})

module.exports = router
