#!/usr/bin/env node
/*
 * add-hotel.js — Alta/actualización de cuentas de hotel (uso interno de Printbox).
 *
 * No hay auto-registro: Printbox crea cada cuenta con este script. Escribe en
 * config/hotels.xml (índice de cuentas con hash bcrypt) y crea la carpeta
 * config/hotels/<hotelId>/ con ficheros de config por defecto. Si todavía existe el
 * hotels.json antiguo se lee de ahí y la primera escritura ya deja el XML migrado.
 *
 * Los hashes bcrypt de bcryptjs ($2b$) los verifica tanto backend/routes/auth.js
 * como password_verify() de PHP en proxy.php — misma cuenta vale en dev y prod.
 *
 * Uso:
 *   node scripts/add-hotel.js --id marbella --nombre "Hotel Marbella" --user recepcion --pass "claveSegura"
 *   node scripts/add-hotel.js --id marbella --pass "nuevaClave"      # solo cambiar contraseña
 *   node scripts/add-hotel.js --list                                  # listar hoteles
 *   node scripts/add-hotel.js --migrate-global marbella "Hotel Marbella" recepcion "clave"
 *       # migra el config/ global actual (single-hotel) a config/hotels/marbella/ y crea la cuenta
 */

const fs = require('fs-extra')
const path = require('path')
const bcrypt = require('bcryptjs')

const CONFIG_DIR = path.join(process.cwd(), 'config')
const HOTELS_XML = path.join(CONFIG_DIR, 'hotels.xml')
const HOTELS_JSON = path.join(CONFIG_DIR, 'hotels.json') // formato antiguo, solo lectura
const HOTELS_DIR = path.join(CONFIG_DIR, 'hotels')

// Ficheros de config que son por-hotel (los que hoy viven en config/ global)
const HOTEL_FILES = ['servidor_api.txt', 'textos.txt', 'habitaciones.json', 'hotel-logo.png', 'paypal.json']

const DEFAULT_SERVIDOR_API = [
  'servidor;http://gestion.printboxweb.com',
  'evento;',
  'evento_printer;',
  'timer;5',
  'impresora;',
  'delay;5',
  'servicio_disponible;1',
].join('\n')

const DEFAULT_TEXTOS = [
  'es:¡Consigue tu foto de la habitación!',
  'en:Get your room photo!',
  'fr:Obtenez votre photo!',
  'de:Hol dir dein Foto!',
  'precio1:1.20',
  'precio2:2.40',
  'precio3:3.60',
  'empresa:',
  'email_recepcion:',
].join('\n')

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) { args[key] = true }
      else { args[key] = next; i++ }
    } else { args._.push(a) }
  }
  return args
}

const xmlEscape = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')

const xmlUnescape = (s) => String(s ?? '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

// Lee config/hotels.xml; si aún no existe, cae al hotels.json antiguo (la primera
// escritura ya deja el XML, migrando las cuentas sin intervención).
function readHotels() {
  try {
    if (fs.existsSync(HOTELS_XML)) {
      const xml = fs.readFileSync(HOTELS_XML, 'utf8')
      const hotels = {}
      const tag = (block, name) => {
        const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
        return m ? xmlUnescape(m[1].trim()) : ''
      }
      for (const m of xml.matchAll(/<hotel\s+id="([^"]+)"\s*>([\s\S]*?)<\/hotel>/g)) {
        hotels[xmlUnescape(m[1].trim())] = {
          nombre: tag(m[2], 'nombre'), user: tag(m[2], 'usuario'), passHash: tag(m[2], 'passHash'),
        }
      }
      return hotels
    }
    return fs.existsSync(HOTELS_JSON) ? JSON.parse(fs.readFileSync(HOTELS_JSON, 'utf8')) : {}
  } catch { return {} }
}

function writeHotels(hotels) {
  fs.ensureDirSync(CONFIG_DIR)
  const cuerpo = Object.entries(hotels).map(([id, h]) => [
    `  <hotel id="${xmlEscape(id)}">`,
    `    <nombre>${xmlEscape(h.nombre)}</nombre>`,
    `    <usuario>${xmlEscape(h.user)}</usuario>`,
    `    <passHash>${xmlEscape(h.passHash)}</passHash>`,
    '  </hotel>',
  ].join('\n')).join('\n')
  fs.writeFileSync(HOTELS_XML, `<?xml version="1.0" encoding="UTF-8"?>\n<hoteles>\n${cuerpo}\n</hoteles>\n`)
}

function sanitizeId(id) {
  return String(id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
}

function ensureHotelFolder(hotelId, { seedDefaults = true } = {}) {
  const dir = path.join(HOTELS_DIR, hotelId)
  fs.ensureDirSync(dir)
  if (seedDefaults) {
    const apiFile = path.join(dir, 'servidor_api.txt')
    const textosFile = path.join(dir, 'textos.txt')
    if (!fs.existsSync(apiFile)) fs.writeFileSync(apiFile, DEFAULT_SERVIDOR_API)
    if (!fs.existsSync(textosFile)) fs.writeFileSync(textosFile, DEFAULT_TEXTOS)
  }
  return dir
}

function upsertHotel({ id, nombre, user, pass }) {
  const hotelId = sanitizeId(id)
  if (!hotelId) { console.error('Error: --id inválido (usa minúsculas, números, - o _)'); process.exit(1) }

  const hotels = readHotels()
  const existing = hotels[hotelId] || {}

  if (!existing.user && !user) { console.error('Error: hotel nuevo requiere --user'); process.exit(1) }
  if (!existing.passHash && !pass) { console.error('Error: hotel nuevo requiere --pass'); process.exit(1) }

  hotels[hotelId] = {
    nombre: nombre !== undefined ? String(nombre) : (existing.nombre || ''),
    user: user !== undefined ? String(user).trim() : existing.user,
    passHash: pass !== undefined ? bcrypt.hashSync(String(pass), 10) : existing.passHash,
  }
  writeHotels(hotels)
  ensureHotelFolder(hotelId)
  console.log(`✓ Hotel "${hotelId}" guardado (usuario: ${hotels[hotelId].user}, nombre: ${hotels[hotelId].nombre || '—'})`)
  console.log(`  Carpeta: config/hotels/${hotelId}/`)
}

function migrateGlobal(id, nombre, user, pass) {
  const hotelId = sanitizeId(id)
  if (!hotelId || !user || !pass) {
    console.error('Uso: --migrate-global <id> "<nombre>" <user> <pass>')
    process.exit(1)
  }
  const dir = ensureHotelFolder(hotelId, { seedDefaults: false })
  let moved = 0
  for (const f of HOTEL_FILES) {
    const src = path.join(CONFIG_DIR, f)
    const dest = path.join(dir, f)
    if (fs.existsSync(src) && !fs.existsSync(dest)) { fs.copySync(src, dest); moved++ }
  }
  ensureHotelFolder(hotelId) // rellena defaults que falten
  upsertHotel({ id: hotelId, nombre, user, pass })
  console.log(`✓ Migrados ${moved} fichero(s) de config/ global a config/hotels/${hotelId}/`)
  console.log('  (Los ficheros globales originales NO se han borrado; revisa y elimínalos manualmente cuando confirmes que todo va bien.)')
}

function listHotels() {
  const hotels = readHotels()
  const ids = Object.keys(hotels)
  if (!ids.length) { console.log('No hay hoteles registrados.'); return }
  console.log('Hoteles registrados:')
  for (const id of ids) console.log(`  - ${id}  (usuario: ${hotels[id].user}, nombre: ${hotels[id].nombre || '—'})`)
}

// ── main ──
const args = parseArgs(process.argv.slice(2))

if (args.list) { listHotels() }
else if (args['migrate-global']) {
  // node add-hotel.js --migrate-global <id> "<nombre>" <user> <pass>
  const [id, nombre, user, pass] = args._
  migrateGlobal(id, nombre, user, pass)
}
else if (args.id) {
  upsertHotel({ id: args.id, nombre: args.nombre, user: args.user, pass: args.pass })
}
else {
  console.log(`add-hotel.js — gestión de cuentas de hotel (Printbox)

  node scripts/add-hotel.js --id <id> --nombre "<nombre>" --user <user> --pass "<clave>"
  node scripts/add-hotel.js --id <id> --pass "<nuevaClave>"        # cambiar solo la contraseña
  node scripts/add-hotel.js --list
  node scripts/add-hotel.js --migrate-global <id> "<nombre>" <user> "<clave>"
`)
}
