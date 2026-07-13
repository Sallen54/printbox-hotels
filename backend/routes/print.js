const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs-extra')
const fetch = require('node-fetch')
const PDFDocument = require('pdfkit')
const os = require('os')

// Cola para evitar procesar múltiples trabajos simultáneamente
let isProcessing = false
const printQueue = []

function getDataDir(req) {
  return req.app.locals.dataDir ||
    path.join(os.homedir(), 'AppData', 'Local', 'PrintboxHotels')
}

// GET /print/printers
router.get('/printers', async (_req, res) => {
  try {
    const { getPrinters } = require('pdf-to-printer')
    const printers = await getPrinters()
    res.json({ printers: printers.map(p => p.name) })
  } catch {
    res.json({ printers: [] })
  }
})

// GET /print/count
router.get('/count', (req, res) => {
  try {
    const logPath = req.app.locals.logPath ||
      path.join(getDataDir(req), 'PBAcount.txt')
    const count = parseInt(fs.readFileSync(logPath, 'utf8')) || 0
    res.json({ count })
  } catch {
    res.json({ count: 0 })
  }
})

// POST /print/job
router.post('/job', async (req, res) => {
  const { imageUrl, imageName, printer, delay = 5 } = req.body

  // Añadir a la cola y procesar
  printQueue.push({ req, res, imageUrl, imageName, printer, delay })
  processQueue(req.app)
})

async function processQueue(app) {
  if (isProcessing || printQueue.length === 0) return

  isProcessing = true
  const { req, res, imageUrl, imageName, printer, delay } = printQueue.shift()

  const DATA_DIR = getDataDir(req)
  const descargasDir = path.join(DATA_DIR, 'descargas')
  const pdfDir = path.join(DATA_DIR, 'pdf')
  const logPath = req.app.locals.logPath || path.join(DATA_DIR, 'PBAcount.txt')

  fs.ensureDirSync(descargasDir)
  fs.ensureDirSync(pdfDir)

  // Usar nombre único para evitar colisiones cuando hay múltiples jobs simultáneos
  const uniqueSuffix = Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
  const ext = path.extname(imageName)
  const baseName = path.basename(imageName, ext)
  const uniqueImageName = `${baseName}_${uniqueSuffix}${ext}`
  const imagePath = path.join(descargasDir, uniqueImageName)
  const pdfPath = path.join(pdfDir, uniqueImageName.replace(ext, '.pdf'))

  try {
    // 1. Descargar imagen
    const imgRes = await fetch(imageUrl)
    if (!imgRes.ok) throw new Error(`No se pudo descargar la imagen: ${imgRes.status}`)
    const buffer = await imgRes.buffer()
    fs.writeFileSync(imagePath, buffer)

    // 2. Delay
    await new Promise(r => setTimeout(r, delay * 1000))

    // 3. Convertir a PDF
    await convertImageToPdf(imagePath, pdfPath)

    // 4. Imprimir
    const { print } = require('pdf-to-printer')
    const options = printer ? { printer } : {}
    await print(pdfPath, options)

    // 5. Incrementar contador
    const current = parseInt(fs.readFileSync(logPath, 'utf8')) || 0
    const newCount = current + 1
    fs.writeFileSync(logPath, String(newCount))

    res.json({ ok: true, count: newCount })
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    isProcessing = false
    // Procesar siguiente en cola
    processQueue(app)
  }
}

async function convertImageToPdf(imagePath, pdfPath) {
  const sharp = require('sharp')
  const meta = await sharp(imagePath).metadata()
  const w = meta.width || 800
  const h = meta.height || 600
  const isLandscape = w > h

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: isLandscape ? 'landscape' : 'portrait',
      margin: 0,
    })
    const stream = fs.createWriteStream(pdfPath)
    doc.pipe(stream)
    const pageW = doc.page.width
    const pageH = doc.page.height
    const scale = Math.min(pageW / w, pageH / h)
    const dw = w * scale
    const dh = h * scale
    const x = (pageW - dw) / 2
    const y = (pageH - dh) / 2
    doc.image(imagePath, x, y, { width: dw, height: dh })
    doc.end()
    stream.on('finish', resolve)
    stream.on('error', reject)
  })
}

module.exports = router