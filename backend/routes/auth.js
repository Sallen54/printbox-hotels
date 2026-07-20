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
    const entry = Object.entries(hotels).find(([, h]) => h.user === String(user).trim())
    if (!entry || !entry[1].passHash || !bcrypt.compareSync(String(password), entry[1].passHash)) {
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
