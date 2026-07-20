// Freno a la fuerza bruta en /auth/login: 5 fallos por IP+usuario en 15 minutos.
// Equivalente a pbhLoginBlockedFor/pbhRegisterLoginFailure/pbhClearLoginFailures de
// proxy.php — si cambias la política aquí, cámbiala allí también.
//
// En dev basta con memoria (el backend Express es un solo proceso); en prod el que
// manda es proxy.php, que sí persiste el contador en config/login_attempts.json.

const MAX_FAILS = 5
const WINDOW_MS = 15 * 60 * 1000

const attempts = new Map() // key -> { first, count }

function keyFor(req, user) {
  const ip = req.ip || req.socket?.remoteAddress || '0.0.0.0'
  return `${ip}|${String(user || '').trim().toLowerCase()}`
}

// Segundos que quedan de bloqueo (0 = puede intentarlo)
function blockedFor(req, user) {
  const entry = attempts.get(keyFor(req, user))
  if (!entry) return 0
  if (Date.now() - entry.first > WINDOW_MS) return 0
  if (entry.count < MAX_FAILS) return 0
  return Math.ceil((entry.first + WINDOW_MS - Date.now()) / 1000)
}

function registerFailure(req, user) {
  const key = keyFor(req, user)
  const entry = attempts.get(key)
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    attempts.set(key, { first: Date.now(), count: 1 })
  } else {
    entry.count += 1
  }
  // Limpieza de entradas caducadas para que el Map no crezca sin límite
  for (const [k, v] of attempts) {
    if (Date.now() - v.first > WINDOW_MS) attempts.delete(k)
  }
}

function clearFailures(req, user) {
  attempts.delete(keyFor(req, user))
}

module.exports = { blockedFor, registerFailure, clearFailures, MAX_FAILS, WINDOW_MS }
