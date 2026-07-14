const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs-extra')
const os = require('os')
const { getSessionHotelId, resolveHotelDir } = require('../lib/session')

function getBaseConfigDir(req) {
  const dataDir = req.app.locals.dataDir ||
    path.join(os.homedir(), 'AppData', 'Local', 'PrintboxHotels')
  return path.join(dataDir, 'config')
}

// Carpeta de config para LECTURA: hotel de la sesión (panel) o del query ?hotel= (móvil);
// sin ninguno, carpeta global (compat con el modelo antiguo de un solo hotel).
function getReadConfigDir(req) {
  const base = getBaseConfigDir(req)
  const hotelId = getSessionHotelId(req, base) || req.query.hotel
  return resolveHotelDir(base, hotelId)
}

// Habitaciones registradas del hotel: [{ nombre, codigo }] en config/habitaciones.json.
// codigo se guarda normalizado (sin prefijo ev-).
function readHabitaciones(configDir) {
  try {
    const file = path.join(configDir, 'habitaciones.json')
    if (!fs.existsSync(file)) return []
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function sanitizeHabitaciones(input) {
  if (!Array.isArray(input)) return []
  return input
    .map(h => ({
      nombre: String(h?.nombre ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 40),
      codigo: String(h?.codigo ?? '').trim().replace(/^ev[-_]?/i, '').replace(/[^0-9a-zA-Z_-]/g, ''),
    }))
    .filter(h => h.codigo)
    .slice(0, 500)
}

router.get('/', (req, res) => {
  try {
    const CONFIG_DIR = getReadConfigDir(req)
    const apiFile = path.join(CONFIG_DIR, 'servidor_api.txt')
    const textosFile = path.join(CONFIG_DIR, 'textos.txt')

    const config = { servidor: 'http://gestion.printboxweb.com', evento: '', evento_printer: '', timer: 5, impresora: '', delay: 5, servicio_disponible: true }
    const textos = { text_es: '', text_en: '', text_fr: '', text_de: '', precio1: '', precio2: '', precio3: '', empresa: '', email_recepcion: '' }

    if (fs.existsSync(apiFile)) {
      const lines = fs.readFileSync(apiFile, 'utf8').split('\n')
      lines.forEach((line, i) => {
        const val = line.includes(';') ? line.split(';')[1]?.trim() : line.trim()
        if (i === 0 && val) config.servidor = val
        if (i === 1 && val) config.evento = val
        if (i === 2 && val) config.evento_printer = val
        if (i === 3 && val) config.timer = parseInt(val) || 5
        if (i === 4 && val) config.impresora = val
        if (i === 5 && val) config.delay = parseInt(val) || 5
        if (i === 6 && val) config.servicio_disponible = val !== '0'
      })
    }

    if (fs.existsSync(textosFile)) {
      const lines = fs.readFileSync(textosFile, 'utf8').split('\n')
      lines.forEach((line) => {
        const line_trimmed = line.trim()
        if (line_trimmed && line_trimmed.includes(':')) {
          const colonIndex = line_trimmed.indexOf(':')
          const key = line_trimmed.substring(0, colonIndex).trim()
          const val = line_trimmed.substring(colonIndex + 1).trim()
          // Map by key name, not by line index
          if (key === 'text_es' || key === 'es') textos['text_es'] = val
          else if (key === 'text_en' || key === 'en') textos['text_en'] = val
          else if (key === 'text_fr' || key === 'fr') textos['text_fr'] = val
          else if (key === 'text_de' || key === 'de') textos['text_de'] = val
          else if (key === 'precio1') textos['precio1'] = val
          else if (key === 'precio2') textos['precio2'] = val
          else if (key === 'precio3') textos['precio3'] = val
          else if (key === 'empresa') textos['empresa'] = val
          else if (key === 'email_recepcion') textos['email_recepcion'] = val
        }
      })
    }

    res.json({ config, textos, habitaciones: readHabitaciones(CONFIG_DIR) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/', (req, res) => {
  try {
    const base = getBaseConfigDir(req)
    const hotelId = getSessionHotelId(req, base)
    if (!hotelId) return res.status(401).json({ error: 'No autenticado' })
    const CONFIG_DIR = resolveHotelDir(base, hotelId, { create: true })
    fs.ensureDirSync(CONFIG_DIR)
    const { config, textos, habitaciones } = req.body

    if (habitaciones !== undefined) {
      fs.writeFileSync(
        path.join(CONFIG_DIR, 'habitaciones.json'),
        JSON.stringify(sanitizeHabitaciones(habitaciones), null, 2)
      )
    }

    if (config) {
      const lines = [
        `servidor;${config.servidor || 'https://gestion.printboxweb.com'}`,
        `evento;${config.evento || ''}`,
        `evento_printer;${config.evento_printer || ''}`,
        `timer;${config.timer || 5}`,
        `impresora;${config.impresora || ''}`,
        `delay;${config.delay || 5}`,
        `servicio_disponible;${config.servicio_disponible === false ? '0' : '1'}`,
      ]
      fs.writeFileSync(path.join(CONFIG_DIR, 'servidor_api.txt'), lines.join('\n'))
    }

    if (textos) {
      const lines = [
        `es:${textos.text_es || ''}`,
        `en:${textos.text_en || ''}`,
        `fr:${textos.text_fr || ''}`,
        `de:${textos.text_de || ''}`,
        `precio1:${textos.precio1 || ''}`,
        `precio2:${textos.precio2 || ''}`,
        `precio3:${textos.precio3 || ''}`,
        `empresa:${textos.empresa || ''}`,
        `email_recepcion:${textos.email_recepcion || ''}`,
      ]
      fs.writeFileSync(path.join(CONFIG_DIR, 'textos.txt'), lines.join('\n'))
    }

    // Devolver los valores guardados (igual que GET)
    const textosFile = path.join(CONFIG_DIR, 'textos.txt')
    const textosResponse = { text_es: '', text_en: '', text_fr: '', text_de: '', precio1: '', precio2: '', precio3: '', empresa: '', email_recepcion: '' }
    if (fs.existsSync(textosFile)) {
      const lines = fs.readFileSync(textosFile, 'utf8').split('\n')
      lines.forEach((line) => {
        const line_trimmed = line.trim()
        if (line_trimmed && line_trimmed.includes(':')) {
          const colonIndex = line_trimmed.indexOf(':')
          const key = line_trimmed.substring(0, colonIndex).trim()
          const val = line_trimmed.substring(colonIndex + 1).trim()
          if (key === 'text_es' || key === 'es') textosResponse['text_es'] = val
          else if (key === 'text_en' || key === 'en') textosResponse['text_en'] = val
          else if (key === 'text_fr' || key === 'fr') textosResponse['text_fr'] = val
          else if (key === 'text_de' || key === 'de') textosResponse['text_de'] = val
          else if (key === 'precio1') textosResponse['precio1'] = val
          else if (key === 'precio2') textosResponse['precio2'] = val
          else if (key === 'precio3') textosResponse['precio3'] = val
          else if (key === 'empresa') textosResponse['empresa'] = val
          else if (key === 'email_recepcion') textosResponse['email_recepcion'] = val
        }
      })
    }

    res.json({ ok: true, config, textos: textosResponse, habitaciones: readHabitaciones(CONFIG_DIR) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router