import React, { useState, useEffect, useRef, useCallback } from 'react'
import { findEvent, sendPhoto, getConfig, processPayment, getPayPalConfig, createPayPalOrder, capturePayPalOrder, notifyRoomOrder, hotelLogoUrl } from '../shared/api'
import { useInterval } from '../shared/hooks/useInterval'
import { guardarPedido, leerPedido, borrarPedido } from '../shared/photoStore'
import './Mobile.css'

window.isMobile = true

// ── UTILIDADES ──

// Carga una imagen (acepta `data:` y `blob:`) y devuelve el elemento ya decodificado, o
// **null** si el navegador no puede con ella (formato que no soporta, archivo dañado, falta
// de memoria) o si tarda demasiado.
//
// El null y el temporizador son imprescindibles: antes solo se escuchaba `onload`, así que
// una única foto que no cargaba dejaba la promesa sin resolver y la importación se quedaba
// colgada para siempre a mitad ("Preparando tus fotos… 30/40").
function cargarImagen(src, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const img = new Image()
    let resuelto = false
    const terminar = (valor) => {
      if (resuelto) return
      resuelto = true
      clearTimeout(temporizador)
      img.onload = null
      img.onerror = null
      resolve(valor)
    }
    const temporizador = setTimeout(() => terminar(null), timeoutMs)
    img.onerror = () => terminar(null)
    img.onload = () => terminar(img)
    img.src = src
  })
}

// Reduce una imagen ya cargada a un JPEG en base64. Solo se usa para las MINIATURAS de la
// interfaz y del e-mail: la foto que se imprime se sube siempre original.
function miniaturaDe(img, maxSize) {
  try {
    const canvas = document.createElement('canvas')
    const ratio = Math.min(maxSize / img.width, maxSize / img.height, 1)
    canvas.width = Math.max(1, Math.round(img.width * ratio))
    canvas.height = Math.max(1, Math.round(img.height * ratio))
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    const salida = canvas.toDataURL('image/jpeg', 0.85)
    canvas.width = 0 // libera el búfer del canvas (iOS es muy sensible con esto)
    canvas.height = 0
    return salida
  } catch { return null }
}

// Redimensiona a partir de una fuente. Solo se usa como red de seguridad al subir (ver
// LIMITE_SUBIDA_CHARS) y para la foto de la cámara.
async function resizeImage(src, maxSize = 1200, timeoutMs = 15000) {
  const img = await cargarImagen(src, timeoutMs)
  return img ? miniaturaDe(img, maxSize) : null
}

// "DNG", "DNG y HEIC", "DNG, HEIC y 2 más": los formatos que han fallado, agrupados.
function resumenFormatos(formatos) {
  const unicos = [...new Set(formatos)]
  if (unicos.length === 1) return unicos[0]
  if (unicos.length === 2) return `${unicos[0]} y ${unicos[1]}`
  return `${unicos.slice(0, 2).join(', ')} y ${unicos.length - 2} más`
}

// Formato legible de un fichero, para decirle al huésped QUÉ ha fallado: un nombre como
// IMG_4471 no le dice nada, pero "DNG" sí, y es lo que hay que explicarle.
function formatoDe(file) {
  const ext = (file?.name || '').split('.').pop()
  if (ext && ext.length <= 5 && /^[a-z0-9]+$/i.test(ext)) return ext.toUpperCase()
  const tipo = (file?.type || '').split('/')[1]
  return tipo ? tipo.toUpperCase() : 'desconocido'
}

// Recorta al formato del papel quedándose con el centro de la imagen (equivale al
// `BoxFit.cover` de Flutter). Mantiene la resolución: solo se van los bordes que sobran.
// Devuelve { image, width, height } o null si no se puede decodificar.
async function recortarAlPapel(src, timeoutMs = 30000) {
  const img = await cargarImagen(src, timeoutMs)
  if (!img) return null
  const w = img.naturalWidth
  const h = img.naturalHeight
  // El papel se orienta como la foto: vertical con vertical, horizontal con horizontal.
  const objetivo = w >= h ? PROPORCION_PAPEL : 1 / PROPORCION_PAPEL
  const actual = w / h

  let recorteW = w
  let recorteH = h
  if (actual > objetivo) recorteW = Math.round(h * objetivo)   // sobra por los lados
  else if (actual < objetivo) recorteH = Math.round(w / objetivo) // sobra por arriba y abajo

  try {
    const canvas = document.createElement('canvas')
    canvas.width = recorteW
    canvas.height = recorteH
    canvas.getContext('2d').drawImage(
      img,
      Math.round((w - recorteW) / 2), Math.round((h - recorteH) / 2), recorteW, recorteH,
      0, 0, recorteW, recorteH,
    )
    const salida = canvas.toDataURL('image/jpeg', 0.92)
    canvas.width = 0
    canvas.height = 0
    return { image: salida, width: recorteW, height: recorteH }
  } catch { return null }
}

// Lee un fichero tal cual y lo devuelve en base64, sin recodificar ni redimensionar: es lo
// que hace la app Flutter cuando el huésped PUBLICA la foto (al imprimir sí la recorta).
function ficheroABase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('No se pudo leer la foto'))
    reader.readAsDataURL(file)
  })
}

// ── CONSTANTES DE PASOS ──
const STEP_EVENT = 'event'
const STEP_GALLERY = 'gallery'
const STEP_CAMERA = 'camera'
const STEP_ORDER = 'order'
const STEP_SUCCESS = 'success'

// El huésped sube desde la galería (el selector del móvil ya deja hacer una foto). El flujo
// STEP_CAMERA se conserva entero: poner esto a true lo reactiva.
const CAMARA_HABILITADA = false

// ── TRATAMIENTO DE LAS FOTOS ──
// Regla de oro: la foto que se imprime se sube ORIGINAL, sin redimensionar ni recodificar,
// igual que la app Flutter. Todo lo de abajo existe para que un pedido de 80 originales no
// se quede sin memoria en el móvil ni tarde una eternidad en subir.
const MAX_FOTOS = 80                                // tope de fotos por pedido
const MAX_COPIAS = 20                               // copias de una misma foto
const THUMB_SIZE = 320                              // miniatura: interfaz y e-mail a recepción
// Recorte al formato del papel antes de imprimir, que es lo que hace la app Flutter:
// captura la foto dentro de un marco 2:3 (vertical) o 3:2 (horizontal) con `BoxFit.cover`.
// Sin esto, una foto de móvil (4:3) encajada en un papel 10x15 (3:2) sale con bandas
// blancas a los lados. Recortar pierde ~11% de los bordes; a cambio llena el papel.
// Un 10x15 es 3:2; si algún día se imprime en 15x20, esto pasaría a ser 4:3.
const RECORTAR_AL_PAPEL = true
const PROPORCION_PAPEL = 3 / 2

const ANCHO_MONITOR = 1600                          // copia para el Monitor, que sólo se mira
const CONCURRENCIA_ENVIO = 2                        // fotos en vuelo (manda el ancho de banda)
const MAX_MINIATURAS_EMAIL = 12                     // el resto se resume: "y N fotos más"
const FORMATOS_DIRECTOS = /^image\/(jpe?g|png)$/i   // HEIC, WEBP… se pasan a JPEG al subir

// Red de seguridad: por encima de ~9 MB en base64, el POST lo rechaza PHP (post_max_size)
// y el pedido YA está pagado, así que esas fotos se suben a 2400px (cubre 15x20 a 300 ppp).
const LIMITE_SUBIDA_CHARS = 9000000
const ANCHO_MAXIMO_SEGURO = 2400

// Regalo por volumen: a partir de estas copias impresas, el hotel regala un álbum. Se
// cuentan COPIAS (lo que se imprime y se paga), no fotos distintas: 12 fotos a 3 copias son
// 36 impresiones y el álbum se llena igual. Para quitar la promoción, poner 0.
const COPIAS_PARA_ALBUM = 35

// Precios mientras no responda el servidor: 1, 2 y 3 copias de una misma foto. El Admin
// guarda precio2 y precio3 como múltiplos de precio1, así que dos copias valen lo mismo que
// dos fotos sueltas. Los dos backends validan el importe con esta misma tabla.
const PRECIOS_DEFECTO = { precio1: '1.20', precio2: '2.40', precio3: '3.60' }

// ── CONSTANTES DE SQUARE ──
const SQUARE_APP_ID = 'sq0idp-OV9y595m1kR_UU3QRest7Q'
const SQUARE_LOCATION_ID = 'LHB32XGQK68GX'

// ── COMPONENTE PRINCIPAL ──

export default function MobileApp() {
  // --- Estados del flujo ---
  const [step, setStep] = useState(STEP_EVENT)
  // del QR (?hotel=): selecciona la config del hotel. Se inicializa de forma síncrona
  // desde la URL para que el primer render ya pida el logo correcto (sin parpadeo).
  const [hotelId, setHotelId] = useState(() => new URLSearchParams(window.location.search).get('hotel') || '')
  const [eventCode, setEventCode] = useState('')
  const [eventError, setEventError] = useState('')
  const [uuid, setUuid] = useState(null)
  const [textos, setTextos] = useState({})
  // Habitaciones [{ nombre, codigo }] para mostrar el nombre (no el código) en la cabecera.
  const [habitaciones, setHabitaciones] = useState([])
  const [loading, setLoading] = useState(false)
  const [loadingFromQR, setLoadingFromQR] = useState(false)
  const [showTermsModal, setShowTermsModal] = useState(false)
  const [serviceUnavailable, setServiceUnavailable] = useState(false)

  // --- Estados de habitación/impresora ---
  const [printerUuid, setPrinterUuid] = useState(null)
  const lastPrinterCodeRef = useRef(null)

  // --- Estados de cámara (solo con CAMARA_HABILITADA) ---
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const [facingMode, setFacingMode] = useState('environment')

  // --- Fotos del pedido ---
  // Cada foto es { file, thumb, orientation, copies, id } — con `dataUrl` en vez de `file`
  // si viene de la cámara. `copies` es 1, 2 o 3 y lo elige el huésped en el carro.
  const [capturedPhotos, setCapturedPhotos] = useState([])
  const galleryFileInputRef = useRef(null)
  // Progreso {hechas, total} de las dos partes lentas. Sin ellos el móvil parece colgado:
  // la importación decodifica 80 fotos y el envío ocurre con el pedido ya pagado.
  const [importProgreso, setImportProgreso] = useState(null)
  const [envioProgreso, setEnvioProgreso] = useState(null)
  // Permite abortar una importación larga sin cerrar la app (ref y no estado: se consulta
  // dentro del bucle, que no ve los cambios de estado).
  const cancelarImportRef = useRef(false)
  // Hasta que no se ha leído el pedido guardado, no se escribe encima.
  const pedidoRecuperadoRef = useRef(false)
  // Nombres de las fotos que el móvil no ha podido leer. Van a un aviso fijo (no a un
  // toast) para que se puedan leer con calma y sepamos qué archivos fallan.
  const [fotosOmitidas, setFotosOmitidas] = useState([])

  // --- Estados de envío y pago ---
  const [toast, setToast] = useState(null)
  const [payMethod, setPayMethod] = useState('card') // 'card' | 'paypal' — solo se monta el elegido
  const [squareCard, setSquareCard] = useState(null)
  const [squareError, setSquareError] = useState('')
  const [squareLoading, setSquareLoading] = useState(false)
  const [paypalClientId, setPaypalClientId] = useState('')
  const [paypalReady, setPaypalReady] = useState(false)
  const [paypalError, setPaypalError] = useState('')
  const paypalButtonsRef = useRef(null)

  // --- Estados de cupón (descuento/pago completo) ---
  const [couponCode, setCouponCode] = useState('')
  const [couponError, setCouponError] = useState('')
  const [couponLoading, setCouponLoading] = useState(false)
  const [appliedCoupon, setAppliedCoupon] = useState(null) // { amount, amount_eur, type }
  const [discountAmount, setDiscountAmount] = useState(0)   // en céntimos

  // ── FUNCIONES AUXILIARES ──
  const normalizeEventCode = (code = '') => String(code).trim().replace(/^ev[-_]?/i, '')

  // "Habitación <nombre>" (buscado por código); sin duplicar el prefijo si ya empieza por
  // "Hab", y con el código de respaldo si la habitación no está registrada.
  // Solo el nombre que haya puesto el alojamiento ("M101", "Parcela 12", "Bungalow 3"):
  // no todos son hoteles, y anteponer "Habitación" chirriaba en campings y apartamentos.
  const roomLabel = (() => {
    const code = normalizeEventCode(eventCode)
    const room = habitaciones.find(h => normalizeEventCode(h.codigo) === code)
    return room?.nombre?.trim() || eventCode
  })()

  const showToast = (msg, duration = 3000) => {
    setToast(msg)
    setTimeout(() => setToast(null), duration)
  }

  const applyTextos = (incoming) => {
    if (!incoming) return
    setTextos(prev => ({
      precio1: (incoming.precio1?.trim()) || prev?.precio1 || PRECIOS_DEFECTO.precio1,
      precio2: (incoming.precio2?.trim()) || prev?.precio2 || PRECIOS_DEFECTO.precio2,
      precio3: (incoming.precio3?.trim()) || prev?.precio3 || PRECIOS_DEFECTO.precio3,
      text_es: incoming.text_es || prev?.text_es || '',
      text_en: incoming.text_en || prev?.text_en || '',
      text_fr: incoming.text_fr || prev?.text_fr || '',
      text_de: incoming.text_de || prev?.text_de || '',
      empresa: incoming.empresa || prev?.empresa || ''
    }))
  }

  // ── LOCALSTORAGE ──
  // Solo la habitación, el paso y los textos. Las fotos NO: ahora el pedido son ficheros del
  // móvil (no serializables) y 80 originales desbordarían de largo la cuota (~5 MB).
  const saveToLocalStorage = () => {
    try {
      localStorage.setItem('printbox_mobile_state', JSON.stringify({ hotelId, eventCode, step, uuid, textos }))
    } catch {}
  }

  const loadFromLocalStorage = () => {
    const data = localStorage.getItem('printbox_mobile_state')
    if (data) {
      try {
        const parsed = JSON.parse(data)
        if (parsed.hotelId) setHotelId(parsed.hotelId)
        setEventCode(parsed.eventCode || '')
        // Las fotos llegan de IndexedDB (asíncrono, más abajo). Hasta que se sepa si hay
        // pedido guardado no se entra al paso de pago, para no enseñar un carrito vacío.
        const paso = parsed.step || STEP_EVENT
        setStep(paso === STEP_ORDER ? STEP_GALLERY : paso)
        setUuid(parsed.uuid || null)
        if (parsed.textos) setTextos(parsed.textos)
        return parsed
      } catch (e) { console.error(e) }
    }
    return null
  }

  // ── PEDIDO GUARDADO (sobrevive a una recarga, caduca a las 2 h) ──
  // Se guarda en cada cambio del pedido; cada guardado renueva el reloj de inactividad.
  useEffect(() => {
    if (!pedidoRecuperadoRef.current) return // aún no se ha leído lo guardado: no pisarlo
    if (capturedPhotos.length) guardarPedido({ fotos: capturedPhotos, hotelId, eventCode, step })
    else borrarPedido()
  }, [capturedPhotos, hotelId, eventCode, step])

  useEffect(() => {
    let cancelado = false
    leerPedido().then(guardado => {
      if (cancelado) return
      if (guardado?.fotos?.length) {
        setCapturedPhotos(guardado.fotos)
        if (guardado.eventCode) setEventCode(guardado.eventCode)
      }
      pedidoRecuperadoRef.current = true
    })
    return () => { cancelado = true }
  }, [])

  // Con la pestaña abierta y nadie tocando nada, el pedido también caduca.
  useEffect(() => {
    const id = setInterval(async () => {
      const guardado = await leerPedido()
      if (!guardado && capturedPhotos.length && pedidoRecuperadoRef.current) {
        setCapturedPhotos([])
        setStep(STEP_GALLERY)
        showToast('Tu selección se ha vaciado tras 2 horas sin actividad', 6000)
      }
    }, 60000)
    return () => clearInterval(id)
  }, [capturedPhotos.length])

  // ── EFECTOS INICIALES ──
  useEffect(() => {
    document.documentElement.style.overflow = 'auto'
    document.body.style.overflow = 'auto'
    const root = document.getElementById('root')
    if (root) { root.style.overflow = 'auto'; root.style.height = 'auto' }
    return () => {
      document.documentElement.style.overflow = ''
      document.body.style.overflow = ''
      if (root) { root.style.overflow = ''; root.style.height = '' }
    }
  }, [])

  // OJO: loadFromLocalStorage() solo puede llamarse en la rama `else`. Si se llama
  // también fuera del if/else, bajo React.StrictMode (dev) el efecto se ejecuta dos
  // veces y la segunda pasada relee un localStorage que todavía no tiene el código de
  // habitación recién fijado, dejando eventCode vacío → el aviso a recepción sale con
  // room: "". No afecta a producción, pero rompe cualquier prueba local.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const hotelParam = params.get('hotel') || ''
    if (hotelParam) setHotelId(hotelParam)
    const ev = params.get('habitacion')
    if (ev) {
      const code = ev.replace('ev-', '')
      setEventCode(code)
      setLoadingFromQR(true)
      setTimeout(() => handleConnectEvent(code, hotelParam), 100)
    } else {
      const saved = loadFromLocalStorage()
      const effectiveHotel = hotelParam || saved?.hotelId || ''
      if (saved?.eventCode && saved.step !== STEP_EVENT) {
        if (saved.uuid) {
          setStep(saved.step)
          setUuid(saved.uuid)
          setLoadingFromQR(false)
        } else {
          setTimeout(() => handleConnectEvent(saved.eventCode, effectiveHotel), 100)
        }
      }
      if (!saved?.eventCode) {
        getConfig(effectiveHotel).then(d => { if (d.textos) applyTextos(d.textos) }).catch(() => {})
      }
    }
  }, [])

  // Comprobación del servicio a nivel de hotel (independiente de la habitación),
  // tanto al entrar como periódicamente por si recepción lo activa/desactiva mientras se usa.
  useEffect(() => {
    const h = new URLSearchParams(window.location.search).get('hotel') || ''
    getConfig(h).then(d => {
      setServiceUnavailable(d.config?.servicio_disponible === false)
      if (d.habitaciones) setHabitaciones(d.habitaciones)
    }).catch(() => {})
  }, [])

  // Sin `capturedPhotos` en las dependencias: las fotos ya no se guardan, así que reescribir
  // al añadir cada una de las 80 sería trabajo tirado.
  useEffect(() => {
    saveToLocalStorage()
  }, [hotelId, eventCode, step, uuid])

  // Refrescar precios y evento impresora cada 5s (config del hotel del QR)
  useEffect(() => {
    const interval = setInterval(() => {
      getConfig(hotelId).then(d => {
        if (d.textos) applyTextos(d.textos)
        if (d.habitaciones) setHabitaciones(d.habitaciones)
        setServiceUnavailable(d.config?.servicio_disponible === false)
        if (d.config?.evento_printer) {
          const printerCode = d.config.evento_printer.replace(/^ev[-_]?/i, '')
          if (printerCode && printerCode !== lastPrinterCodeRef.current) {
            lastPrinterCodeRef.current = printerCode
            loadPrinterEvent(printerCode)
          }
        } else if (lastPrinterCodeRef.current !== null) {
          lastPrinterCodeRef.current = null
          setPrinterUuid(null)
        }
      }).catch(() => {})
    }, 5000)
    return () => clearInterval(interval)
  }, [eventCode, hotelId])

  const loadPrinterEvent = useCallback(async (eventCodePrinter) => {
    if (!eventCodePrinter) { setPrinterUuid(null); return }
    try {
      const printerUuidResult = await findEvent(`ev-${eventCodePrinter}`)
      setPrinterUuid(printerUuidResult)
    } catch (e) { setPrinterUuid(null) }
  }, [])

  // Refrescar precios al entrar al pedido: así el total mostrado coincide con el que el
  // servidor valida al pagar (evita el "importe no coincide" por precios en caché).
  useEffect(() => {
    if (step !== STEP_ORDER) return
    getConfig(hotelId).then(d => { if (d.textos) applyTextos(d.textos) }).catch(() => {})
  }, [step])

  // Solo se monta la pasarela elegida y solo si hay algo que cobrar (finalCents se lee dentro
  // del efecto, donde ya está inicializado).
    useEffect(() => {
    if (step !== STEP_ORDER || payMethod !== 'card' || finalCents === 0) return
    let cancelled = false
    let card = null
    const initSquare = async () => {
      if (!window.Square) { setSquareError('Pasarela no cargada'); return }
      try {
        const payments = window.Square.payments(SQUARE_APP_ID, SQUARE_LOCATION_ID)
        card = await payments.card()
        if (cancelled) { try { await card.destroy() } catch {} ; return }
        await card.attach('#card-container')
        setSquareCard(card)
        setSquareError('')
      } catch (e) { if (!cancelled) setSquareError(e.message) }
    }
    initSquare()
    return () => {
      cancelled = true
      try { card?.destroy?.() } catch {}
      setSquareCard(null)
    }
  }, [step, payMethod, appliedCoupon])

  useEffect(() => {
    if (step !== STEP_ORDER || payMethod !== 'paypal' || finalCents === 0) return
    let cancelled = false
    const loadPayPalScript = (clientId) => {
      return new Promise((resolve, reject) => {
        if (window.paypal) return resolve(window.paypal)
        const script = document.createElement('script')
        script.setAttribute('data-paypal-sdk', 'true')
        script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=EUR&intent=capture`
        script.async = true
        script.onload = () => window.paypal ? resolve(window.paypal) : reject(new Error('PayPal no disponible'))
        script.onerror = () => reject(new Error('Error cargando PayPal'))
        document.body.appendChild(script)
      })
    }
    const initPayPal = async () => {
      setPaypalError(''); setPaypalReady(false)
      try {
        const config = await getPayPalConfig()
        if (cancelled) return
        if (!config.clientId) throw new Error('PayPal no configurado')
        setPaypalClientId(config.clientId)
        const paypal = await loadPayPalScript(config.clientId)
        if (cancelled) return
        const buttons = paypal.Buttons({
          style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'paypal' },
          createOrder: async () => {
            const totalCents = Math.round(parseFloat(totalPrice()) * 100)
            const discountCents = couponDiscountCents(totalCents)
            const finalCents = Math.max(0, totalCents - discountCents)
            if (appliedCoupon?.type === 'full' && finalCents > 0) {
              throw new Error('El cupón de pago completo no cubre el total')
            }
            const finalAmount = (finalCents / 100).toFixed(2)
            return await createPayPalOrder({ amount: finalAmount, currency: 'EUR', order: orderPayload() })
          },
          onApprove: async (data) => {
            try {
              await capturePayPalOrder(data.orderID)
              if (appliedCoupon) {
                const orderId = `mobile_${Date.now()}`
                await redeemCoupon(couponCode, orderId)
              }
              await sendOrderPhotos({ paymentMethod: 'PayPal', amountPaid: finalPrice })
              await borrarPedido() // enviado: que una recarga no lo resucite
              setStep(STEP_SUCCESS)
            } catch (error) {
              setPaypalError(error.message)
            }
          },
          onError: (error) => setPaypalError(error?.message || 'Error en PayPal'),
          onCancel: () => showToast('Pago cancelado')
        })
        if (cancelled) return
        paypalButtonsRef.current = buttons
        // El efecto se repite al aplicar/quitar cupón: sin vaciar, los botones se acumulan.
                const container = document.getElementById('paypal-button-container')
        if (container) container.innerHTML = ''
        await buttons.render('#paypal-button-container')
        setPaypalReady(true)
      } catch (e) { setPaypalError(e.message) }
    }
    initPayPal()
    return () => {
      cancelled = true
      try { paypalButtonsRef.current?.close?.() } catch {}
      paypalButtonsRef.current = null
      const container = document.getElementById('paypal-button-container')
      if (container) container.innerHTML = ''
    }
  }, [step, payMethod, appliedCoupon])

  // ── CUPONES (proxy.php) ──
  const validateCoupon = async (code) => {
    const evento = normalizeEventCode(eventCode)
    const res = await fetch('/coupon/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim().toUpperCase(), evento }),
    })
    const json = await res.json()
    if (!res.ok || !json.valid) throw new Error(json.error || 'Cupón inválido')
    return json // { valid, amount, amount_eur, type }
  }

  const redeemCoupon = async (code, orderId) => {
    const evento = normalizeEventCode(eventCode)
    const res = await fetch('/coupon/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim().toUpperCase(), evento, order_id: orderId }),
    })
    const json = await res.json()
    if (!res.ok || !json.ok) throw new Error(json.error || 'No se pudo canjear el cupón')
    return json
  }

  const handleApplyCoupon = async () => {
    if (!couponCode.trim()) { setCouponError('Introduce un código'); return }
    setCouponLoading(true)
    setCouponError('')
    try {
      const result = await validateCoupon(couponCode)
      setAppliedCoupon(result)
      setDiscountAmount(result.amount)
      showToast(`✔ Cupón aplicado: ${result.type === 'discount' ? 'descuento de' : 'pago completo de'} ${result.amount_eur}`)
    } catch (e) {
      setCouponError(e.message)
      setAppliedCoupon(null)
      setDiscountAmount(0)
    } finally {
      setCouponLoading(false)
    }
  }

  // ── CONEXIÓN EVENTO Y GALERÍA ──
  async function handleConnectEvent(code = null, hotelOverride = null) {
    const eventCodeToUse = normalizeEventCode(code || eventCode)
    if (!eventCodeToUse) { setEventError('Introduce el número de habitación'); return }
    const h = hotelOverride ?? hotelId
    setLoading(true)
    setEventError('')
    try {
      const id = await findEvent(`ev-${eventCodeToUse}`)
      setUuid(id)
      const configData = await getConfig(h)
      if (configData.textos) applyTextos(configData.textos)
      if (configData.habitaciones) setHabitaciones(configData.habitaciones)
      if (configData.config?.evento_printer) {
        const printerCode = configData.config.evento_printer.replace(/^ev[-_]?/i, '')
        if (printerCode) {
          await loadPrinterEvent(printerCode)
          lastPrinterCodeRef.current = printerCode
        }
      }
      setStep(STEP_GALLERY)
      setLoadingFromQR(false)
    } catch (e) {
      setEventError('Habitación no encontrada. Verifica el número.')
      setLoadingFromQR(false)
    } finally {
      setLoading(false)
    }
  }

  // ── CÁMARA ──
  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: false })
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
    } catch { showToast('No se puede acceder a la cámara') }
  }
  function stopCamera() {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }
  async function capturePhoto() {
    const video = videoRef.current, canvas = canvasRef.current
    if (!video || !canvas) return
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)
    // La cámara ya da la foto a la resolución del vídeo: se sube tal cual, sin reducirla.
    const raw = canvas.toDataURL('image/jpeg', 0.92)
    if (capturedPhotos.length >= MAX_FOTOS) { showToast(`Máximo ${MAX_FOTOS} fotos por pedido`); return }
    const thumb = await resizeImage(raw, THUMB_SIZE)
    if (!thumb) { showToast('No se ha podido procesar la foto'); return }
    setCapturedPhotos(prev => [...prev, {
      dataUrl: raw,
      thumb,
      copies: 1,
      orientation: canvas.height > canvas.width ? 'portrait' : 'landscape',
      width: canvas.width,
      height: canvas.height,
      id: Date.now(),
    }])
    showToast('Foto capturada')
  }
  async function flipCamera() {
    stopCamera()
    setFacingMode(prev => prev === 'environment' ? 'user' : 'environment')
  }
  useEffect(() => {
    if (step === STEP_CAMERA) startCamera()
    else stopCamera()
    return () => stopCamera()
  }, [step, facingMode])
  // `delta` es +1 o -1 (flechas del selector). Se queda entre 1 y MAX_COPIAS.
  function cambiarCopias(id, delta) {
    setCapturedPhotos(prev => prev.map(p => {
      if (p.id !== id) return p
      const n = Math.min(Math.max((parseInt(p.copies) || 1) + delta, 1), MAX_COPIAS)
      return { ...p, copies: n }
    }))
  }

  function removeCaptured(id) {
    setCapturedPhotos(prev => prev.filter(p => p.id !== id))
  }

  // ── SUBIR FOTOS YA GUARDADAS EN EL MÓVIL (galería del dispositivo) ──
  async function handleGalleryFilesSelected(e) {
    const seleccionadas = Array.from(e.target.files || [])
    e.target.value = '' // permite volver a elegir el mismo archivo más tarde
    if (!seleccionadas.length) return

    const hueco = MAX_FOTOS - capturedPhotos.length
    if (hueco <= 0) { showToast(`Máximo ${MAX_FOTOS} fotos por pedido`); return }
    const files = seleccionadas.slice(0, hueco)
    const descartadas = seleccionadas.length - files.length

    // Se añaden todas de una vez al final: un setState por foto repintaría la galería
    // entera en cada vuelta del bucle.
    setImportProgreso({ hechas: 0, total: files.length })
    cancelarImportRef.current = false
    setFotosOmitidas([])
    const nuevas = []
    const omitidas = []
    let cancelada = false
    try {
      for (const file of files) {
        if (cancelarImportRef.current) { cancelada = true; break }
        // El fichero se queda tal cual (vive en el disco del móvil, no en memoria) y sólo
        // se decodifica para sacar la miniatura y medir la orientación. El original se lee
        // en el momento de subirlo, uno a uno.
        const url = URL.createObjectURL(file)
        let img = null
        try {
          img = await cargarImagen(url)
          // Segunda oportunidad con más margen: en un lote largo el móvil se calienta y
          // alguna foto grande no llega a tiempo a la primera.
          if (!img) img = await cargarImagen(url, 30000)

          if (img) {
            const thumb = miniaturaDe(img, THUMB_SIZE)
            nuevas.push({
              file,
              thumb,
              copies: 1,
              // Misma regla que la app Flutter: alto > ancho → vertical; el resto (incluida
              // la foto cuadrada) → horizontal.
              orientation: img.naturalHeight > img.naturalWidth ? 'portrait' : 'landscape',
              width: img.naturalWidth,
              height: img.naturalHeight,
              id: `${Date.now()}${Math.random()}`,
            })
          } else {
            omitidas.push(formatoDe(file))
          }
        } finally { URL.revokeObjectURL(url) }

        setImportProgreso({ hechas: nuevas.length + omitidas.length, total: files.length })
        // Cede el hilo entre fotos: deja repintar la barra y da margen al recolector.
        await new Promise(r => setTimeout(r, 0))
      }
      if (nuevas.length) setCapturedPhotos(prev => [...prev, ...nuevas])
      if (omitidas.length) setFotosOmitidas(omitidas)
    } finally {
      setImportProgreso(null)
    }

    // Las fotos omitidas no llevan toast: salen en el aviso fijo de la galería, que se
    // puede leer con calma en vez de desaparecer a los segundos.
    if (cancelada) {
      showToast(`Importación cancelada · ${nuevas.length} foto(s) añadidas`, 4000)
    } else if (!omitidas.length) {
      if (descartadas > 0) showToast(`Solo caben ${MAX_FOTOS} fotos por pedido: se han añadido ${files.length}`)
      else showToast(`${files.length} foto${files.length > 1 ? 's' : ''} añadida${files.length > 1 ? 's' : ''} al pedido`)
    }
  }

  // ── PEDIDO Y PAGO ──
  // Acepta precio 0 (gratis); solo usa el default si no es un número. `parseFloat(x) || N`
  // trataría el 0 como ausente.
  const priceOr = (value, fallback) => {
    const n = parseFloat(value)
    return Number.isFinite(n) ? n : fallback
  }
  // Precio por copia, sin tope: una copia cuesta `precio1` y N copias cuestan N veces eso.
  // Antes era una tabla de 3 tramos y a partir de la tercera copia se cobraba de menos.
  // precio2/precio3 siguen guardándose (x2 y x3) para no romper los ficheros existentes.
  const precioCopia = () => priceOr(textos.precio1, parseFloat(PRECIOS_DEFECTO.precio1))
  const priceForPhoto = (copies) => precioCopia() * Math.min(Math.max(parseInt(copies) || 1, 1), MAX_COPIAS)
  const totalCopies = capturedPhotos.reduce((n, p) => n + (p.copies || 1), 0)
  const totalPrice = () => capturedPhotos.reduce((s, p) => s + priceForPhoto(p.copies), 0).toFixed(2)

  // Regalo: cuántas copias faltan y si ya está conseguido.
  const albumActivo = COPIAS_PARA_ALBUM > 0
  const albumConseguido = albumActivo && totalCopies >= COPIAS_PARA_ALBUM
  const albumRestantes = Math.max(0, COPIAS_PARA_ALBUM - totalCopies)

  // Un cupón 'discount' resta su importe; uno 'full' cubre el pedido entero cuando su
  // importe alcanza el total (si no, cubre lo que puede y el resto se paga con tarjeta).
  const couponDiscountCents = (total) => {
    if (!appliedCoupon) return 0
    if (appliedCoupon.type === 'full') return Math.min(appliedCoupon.amount, total)
    return appliedCoupon.type === 'discount' ? appliedCoupon.amount : 0
  }

  // Desglose que se manda con el pago para que el servidor recalcule el importe.
  const orderPayload = () => ({
    hotel: hotelId,
    evento: normalizeEventCode(eventCode),
    copies: capturedPhotos.map(p => p.copies || 1),
    coupon: appliedCoupon ? couponCode.trim().toUpperCase() : undefined,
  })

  const totalCents = Math.round(parseFloat(totalPrice()) * 100)
  const discountCents = couponDiscountCents(totalCents)
  const finalCents = Math.max(0, totalCents - discountCents)
  const finalPrice = (finalCents / 100).toFixed(2)

  // El cupón cubre el total: no hay pasarela de por medio, solo canjear y enviar.
  const handleFreeOrder = async () => {
    setSquareLoading(true)
    setSquareError('')
    try {
      if (appliedCoupon) await redeemCoupon(couponCode, `mobile_${Date.now()}`)
      await sendOrderPhotos({ paymentMethod: 'Cupón (pago completo)', amountPaid: '0.00' })
      await borrarPedido() // enviado: que una recarga no lo resucite
      setStep(STEP_SUCCESS)
    } catch (e) {
      setSquareError(`Error: ${e.message}`)
    } finally {
      setSquareLoading(false)
    }
  }

  const handleSquarePayment = async () => {
    if (!squareCard) { setSquareError('Pasarela no inicializada'); return }
    if (appliedCoupon?.type === 'full' && finalCents > 0) {
      setSquareError('El cupón de pago completo no cubre el total')
      return
    }
    setSquareLoading(true)
    try {
      if (finalCents > 0) {
        const result = await squareCard.tokenize()
        if (result.status !== 'OK') throw new Error(result.errors?.[0]?.message || 'Tokenización fallida')
        await processPayment({
          token: result.token,
          amount: String(finalCents),
          currency: 'EUR',
          order: orderPayload(),
        })
      }
      if (appliedCoupon) {
        const orderId = `mobile_${Date.now()}`
        await redeemCoupon(couponCode, orderId)
      }
      await sendOrderPhotos({ paymentMethod: 'Tarjeta (Square)', amountPaid: finalPrice })
      await borrarPedido() // ya está pagado y enviado: que una recarga no lo resucite
      setStep(STEP_SUCCESS)
    } catch (e) {
      setSquareError(`Error: ${e.message}`)
    } finally {
      setSquareLoading(false)
    }
  }

  async function sendOrderPhotos({ paymentMethod = 'Tarjeta', amountPaid } = {}) {
    // Cola de impresión (evento_printer) o, si no hay, la propia habitación: ahí van las copias.
    const printTarget = printerUuid || uuid
    if (!printTarget) throw new Error('No hay habitación destino')
    // Si la cola es un evento distinto, mandamos además UNA copia a la habitación (sin
    // imprimir) para que su Monitor también vea la foto.
    const displayRoomUuid = (printerUuid && uuid && printerUuid !== uuid) ? uuid : null
    const fotos = capturedPhotos
    const total = fotos.length

    // Una foto suelta puede fallar por un corte de red; como el pedido YA está cobrado,
    // se reintenta antes de dar el envío por perdido.
    const conReintento = async (fn) => {
      try { return await fn() }
      catch { await new Promise(r => setTimeout(r, 800)); return fn() }
    }

    // La foto original se lee AQUÍ, justo antes de subirla, y se descarta al terminar: así
    // sólo hay en memoria las que están en vuelo y no las 80 del pedido.
    const leerOriginal = async (photo) => {
      if (!photo.file) return photo.dataUrl // foto de la cámara: ya está en base64

      // Formato que la impresión no digiere (HEIC de iPhone, WEBP…): se recodifica a JPEG
      // **sin bajar la resolución** (el tope enorme deja el tamaño intacto).
      if (!FORMATOS_DIRECTOS.test(photo.file.type || '')) {
        const url = URL.createObjectURL(photo.file)
        try {
          const jpeg = await resizeImage(url, 20000, 30000)
          if (jpeg) return jpeg
        } finally { URL.revokeObjectURL(url) }
      }

      const original = await ficheroABase64(photo.file)
      if (original.length <= LIMITE_SUBIDA_CHARS) return original
      // Sólo para fotos enormes: se reduce lo justo para que el POST no lo rechace el
      // servidor. 2400px sigue cubriendo 15x20 a 300 ppp.
      const url = URL.createObjectURL(photo.file)
      try { return (await resizeImage(url, ANCHO_MAXIMO_SEGURO, 30000)) || original }
      finally { URL.revokeObjectURL(url) }
    }

    const subirFoto = async (photo) => {
      let image = await leerOriginal(photo)
      const orientation = photo.orientation || 'portrait'

      // Recorte al formato del papel, lo último antes de subir. Si fallara, se manda la
      // foto sin recortar: saldrá con bandas, pero el pedido no se pierde.
      let medidas = (() => {
        const { width, height } = photo
        if (!width || !height) return {}
        const factor = image === photo.dataUrl ? 1 : Math.min(ANCHO_MAXIMO_SEGURO / width, ANCHO_MAXIMO_SEGURO / height, 1)
        return factor === 1
          ? { width, height }
          : { width: Math.round(width * factor), height: Math.round(height * factor) }
      })()
      if (RECORTAR_AL_PAPEL) {
        const recortada = await recortarAlPapel(image)
        if (recortada) {
          image = recortada.image
          medidas = { width: recortada.width, height: recortada.height }
        }
      }
      const copias = Math.min(Math.max(parseInt(photo.copies) || 1, 1), 3)
      // La foto se sube UNA vez y se piden N copias por dos vías que el Printer entiende:
      // `times` (lo que devuelve la API en photos_two) y el nombre `print_N_` (que usa como
      // respaldo). Subirla N veces multiplicaría por N unos megas que ya son grandes.
      const uniqueName = `print_${copias}_c${Date.now()}${Math.random().toString(36).substr(2,9)}`
      await conReintento(() => sendPhoto({ event: printTarget, image, times: copias, name: uniqueName, phone: '000000000', orientation, ...medidas }))
      if (displayRoomUuid) {
        // Esta copia sólo se MIRA en el Monitor de recepción (nunca se imprime), así que
        // va reducida: manda la mitad de bytes por pedido sin tocar la que se imprime.
        const paraMonitor = await resizeImage(image, ANCHO_MONITOR, 30000)
        const dispName = `room${Date.now()}${Math.random().toString(36).substr(2,9)}`
        await conReintento(() => sendPhoto({ event: displayRoomUuid, image: paraMonitor || image, times: 1, name: dispName, phone: '000000000', orientation, print: false }))
      }
    }

    // Envío con varias fotos en vuelo a la vez: en serie, un pedido de 80 tardaría minutos.
    setEnvioProgreso({ hechas: 0, total })
    let siguiente = 0
    let hechas = 0
    const worker = async () => {
      while (true) {
        const i = siguiente++
        if (i >= total) return
        await subirFoto(fotos[i])
        hechas++
        setEnvioProgreso({ hechas, total })
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCIA_ENVIO, total) }, worker))
    } finally {
      setEnvioProgreso(null)
    }

    // El e-mail lleva sólo las primeras miniaturas (ya generadas al importar): con 80 fotos
    // el correo pesaría demasiado para mail(). `fotos` da el total real a recepción.
    const notifyItems = fotos.slice(0, MAX_MINIATURAS_EMAIL).map(p => ({ thumbnail: p.thumb || p.dataUrl, copies: p.copies || 1 }))
    try {
      await notifyRoomOrder({
        hotel: hotelId,
        room: normalizeEventCode(eventCode),
        items: notifyItems,
        fotos: total,
        copias: totalCopies,
        // Recepción tiene que saberlo: es quien entrega el álbum en mano.
        album: albumConseguido,
        total: amountPaid ?? totalPrice(),
        paymentMethod,
      })
    } catch (e) {
      console.error('notifyRoomOrder error:', e)
    }
    return true
  }

  // ── RENDER POR PASO ──
  if (serviceUnavailable) {
    return (
      <div className="mobile-app event-container">
        <img src={hotelLogoUrl(hotelId)} alt="Logo" className="event-logo" />
        <div className="service-unavailable-box">
          <p><span className="service-unavailable-flag">🇪🇸</span>Servicio no disponible temporalmente. Lamentamos las molestias.</p>
          <p><span className="service-unavailable-flag">🇬🇧</span>Service temporarily unavailable. We apologize for the inconvenience.</p>
          <p><span className="service-unavailable-flag">🇫🇷</span>Service temporairement indisponible. Nous nous excusons pour la gêne occasionnée.</p>
          <p><span className="service-unavailable-flag">🇩🇪</span>Dienst vorübergehend nicht verfügbar. Wir entschuldigen uns für die Unannehmlichkeiten.</p>
        </div>
      </div>
    )
  }

  if (step === STEP_EVENT) {
    if (loadingFromQR) {
      return (
        <div className="mobile-app event-container">
          <img src={hotelLogoUrl(hotelId)} alt="Logo" className="event-logo" />
          <h1 className="event-title">Printbox Hotels</h1>
          <p className="event-subtitle">Cargando habitación...</p>
          <div className="d-flex justify-content-center"><span className="spinner-border text-warning" style={{width:'3rem',height:'3rem'}} /></div>
          {toast && <div className="mobile-toast">{toast}</div>}
        </div>
      )
    }
    return (
      <div className="mobile-app event-container">
        <img src={hotelLogoUrl(hotelId)} alt="Logo" className="event-logo" />
        <h1 className="event-title">Printbox Hotels</h1>
        <p className="event-subtitle">Introduce el número de habitación</p>
        <div className="event-input-wrapper">
          <div className="input-group event-input-group">
            <span className="input-group-text event-input-prefix">Hab.</span>
            <input type="number" inputMode="numeric" className={`form-control event-input ${eventError ? 'is-invalid' : ''}`} placeholder="000000" value={eventCode} onChange={e => { setEventCode(e.target.value); setEventError('') }} onKeyDown={e => e.key === 'Enter' && handleConnectEvent()} />
            {eventError && <div className="invalid-feedback text-center">{eventError}</div>}
          </div>
          <button className="btn btn-warning event-button" onClick={handleConnectEvent} disabled={loading}>
            {loading ? <><span className="spinner-border spinner-border-sm me-2" />Conectando...</> : <><i className="bi bi-arrow-right-circle me-2" />Entrar a mi habitación</>}
          </button>
        </div>
        {toast && <div className="mobile-toast">{toast}</div>}
      </div>
    )
  }

  if (step === STEP_GALLERY) {
    return (
      <div className="mobile-app">
        {/* Marca arriba y centrada, debajo una fila con el logo del hotel, el texto en dos
            idiomas y la (i); la habitación cierra la cabecera. Subir fotos ya no vive aquí:
            tiene su propio botón flotante, que es donde la mano llega. */}
        <div className="mobile-header">
          <img src="/assets/hostyprint-logo.png" alt="HostyPrint" className="mobile-brand-logo" />
          <div className="mobile-header-fila">
            <img src={hotelLogoUrl(hotelId)} alt="" className="mobile-header-hotel-logo" />
            <div className="mobile-header-title">
              <span className="mobile-header-bandera">🇪🇸</span> Sube o haz tus fotos para imprimir
              <br />
              <small className="text-muted"><span className="mobile-header-bandera">🇬🇧</span> Upload or take your photos to print</small>
            </div>
            <button className="mobile-header-info" title="Información y condiciones" onClick={() => setShowTermsModal(true)}><i className="bi bi-info-circle" /></button>
          </div>
          {eventCode && <div className="mobile-room-badge">{roomLabel}</div>}
          <input ref={galleryFileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleGalleryFilesSelected} />
        </div>
        {fotosOmitidas.length > 0 && (
          <div className="mobile-warning-box">
            <button className="mobile-warning-close" onClick={() => setFotosOmitidas([])} aria-label="Cerrar">&times;</button>
            <p className="mobile-warning-title"><i className="bi bi-exclamation-triangle-fill me-2" />{fotosOmitidas.length} foto{fotosOmitidas.length > 1 ? 's' : ''} en formato {resumenFormatos(fotosOmitidas)}</p>
            <p className="mobile-warning-text">
              Ese formato no se puede imprimir. Suele pasar con las fotos en <strong>RAW/DNG</strong>, las de <strong>modo profesional</strong> y los <strong>vídeos</strong>.
            </p>
            <p className="mobile-warning-text mt-1">
              <strong>Solución:</strong> ábrelas en la app de Fotos de tu móvil, pulsa <strong>Editar</strong> y <strong>Guardar</strong>; quedan en un formato normal y ya se pueden subir.
            </p>
            <p className="mobile-warning-text mt-1">Las demás fotos siguen en el pedido y sólo pagarás las que ves aquí.</p>
          </div>
        )}
        {capturedPhotos.length === 0 ? (
          <div className="gallery-empty-state">
            <p>Sube una foto de tu galería para imprimirla en recepción.</p>
            <div className="gallery-empty-actions">
              <button className="btn btn-outline-warning fw-bold" onClick={() => galleryFileInputRef.current?.click()}><i className="bi bi-images me-2" />Subir foto</button>
              {CAMARA_HABILITADA && <button className="btn btn-outline-warning fw-bold" onClick={() => setStep(STEP_CAMERA)}><i className="bi bi-camera me-2" />Hacer foto</button>}
            </div>
          </div>
        ) : (
          <div className="gallery-grid">
            {capturedPhotos.map(photo => (
              <div key={photo.id} className="mobile-photo-card selected">
                <img src={photo.thumb || photo.dataUrl} alt="" loading="lazy" decoding="async" draggable={false} onContextMenu={e=>e.preventDefault()} onDragStart={e=>e.preventDefault()} />
              </div>
            ))}
          </div>
        )}
        {/* Pila flotante: añadir fotos arriba, el regalo justo encima del pedido. */}
        {capturedPhotos.length > 0 && (
          <div className="mobile-float-stack">
            <button className="btn btn-outline-warning fw-bold float-add-btn" onClick={() => galleryFileInputRef.current?.click()}>
              <i className="bi bi-plus-circle me-2" />Añadir más fotos
            </button>
            {albumActivo && (
              <button
                className={`album-float ${albumConseguido ? 'album-float-hecho' : ''}`}
                onClick={() => !albumConseguido && galleryFileInputRef.current?.click()}
              >
                <span className="album-float-icono"><i className={`bi ${albumConseguido ? 'bi-gift-fill' : 'bi-gift'}`} /></span>
                <span className="album-float-texto">
                  {albumConseguido
                    ? <b>¡Álbum de regalo conseguido!</b>
                    : <><b>Álbum de regalo</b><span> te faltan {albumRestantes} foto{albumRestantes > 1 ? 's' : ''}</span></>}
                </span>
                <span className="album-float-barra">
                  <span className="album-float-relleno" style={{ width: `${Math.min(100, Math.round((totalCopies / COPIAS_PARA_ALBUM) * 100))}%` }} />
                </span>
              </button>
            )}
            <button className="btn btn-warning w-100 fw-bold shadow-lg" onClick={() => setStep(STEP_ORDER)}>
              <i className="bi bi-bag-check me-2" />Ver pedido ({capturedPhotos.length} foto{capturedPhotos.length > 1 ? 's' : ''})
            </button>
          </div>
        )}
        {showTermsModal && (
          <div className="terms-modal-overlay" onClick={() => setShowTermsModal(false)}>
            <div className="terms-modal-content" onClick={e=>e.stopPropagation()}>
              <div className="terms-modal-header"><h5>Información y condiciones</h5><button className="terms-modal-close" onClick={()=>setShowTermsModal(false)}>&times;</button></div>
              <div className="terms-modal-body">
                <p><strong>¿Cómo funciona?</strong></p>
                <ol style={{paddingLeft:'1.1rem',margin:'0 0 12px'}}>
                  <li>Pulsa <strong>Subir foto</strong> y elige las fotos de tu móvil (hasta {MAX_FOTOS} por pedido).</li>
                  <li>Elige cuántas <strong>copias</strong> quieres de cada una, a {precioCopia().toFixed(2)}&nbsp;€ la copia.</li>
                  <li>Paga con <strong>tarjeta</strong> o <strong>PayPal</strong>.</li>
                  <li>Recoge tus fotos impresas en <strong>recepción</strong>.</li>
                  <li>Con <strong>{COPIAS_PARA_ALBUM} fotos o más</strong> te regalamos un <strong>álbum</strong>, que recoges en recepción con tu pedido.</li>
                </ol>

                <p><strong>¿Qué es un cupón?</strong></p>
                <p>Es un código que te da el hotel para que pagues menos (o nada). Hay dos tipos:</p>
                <ul style={{paddingLeft:'1.1rem',margin:'0 0 8px'}}>
                  <li><strong>De descuento:</strong> te resta dinero del total. Si tu pedido son 3,60&nbsp;€ y el cupón es de 1,00&nbsp;€, pagas 2,60&nbsp;€ con tarjeta.</li>
                  <li><strong>De pago completo:</strong> cubre todo el pedido y <strong>no pagas nada</strong>.</li>
                </ul>
                <p><strong>Cómo usarlo:</strong> escribe el código en la casilla <em>Cupón</em> de la pantalla del pedido y pulsa <strong>Aplicar</strong>. Verás el total actualizado al instante.</p>
                <p style={{marginBottom:12}}><strong>Ojo:</strong> cada cupón sirve <strong>una sola vez</strong>, caduca, y solo vale para la habitación para la que se creó. Si te da error, pide uno nuevo en recepción.</p>

                <p><strong>Tus fotos están protegidas.</strong> No almacenamos datos personales ni compartimos tus imágenes.</p>
                <p>Los pagos se procesan de forma segura a través de <strong>Square</strong> y <strong>PayPal</strong>.</p>
                <p>Al usar este servicio, aceptas que las fotos seleccionadas se impriman en recepción.</p>
              </div>
              <div className="terms-modal-footer"><button className="btn btn-sm btn-secondary" onClick={()=>setShowTermsModal(false)}>Cerrar</button></div>
            </div>
          </div>
        )}
        {importProgreso && (
          <div className="mobile-busy-overlay">
            <span className="spinner-border text-warning" style={{width:'2.5rem',height:'2.5rem'}} />
            <p className="mobile-busy-title">Preparando tus fotos… {importProgreso.hechas}/{importProgreso.total}</p>
            <p className="mobile-busy-text">No cierres esta pantalla.</p>
            <button className="btn btn-sm btn-outline-light" onClick={() => { cancelarImportRef.current = true }}>Cancelar</button>
          </div>
        )}
        {toast && <div className="mobile-toast">{toast}</div>}
      </div>
    )
  }

  if (step === STEP_CAMERA) {
    return (
      <div className="mobile-app d-flex flex-column" style={{minHeight:'100dvh'}}>
        <div className="mobile-header d-flex align-items-center gap-2">
          <button className="btn btn-sm btn-outline-secondary" onClick={() => setStep(STEP_GALLERY)}><i className="bi bi-arrow-left" /></button>
          <span className="fw-bold" style={{color:'var(--pb-accent)'}}>Hacer foto</span>
          {eventCode && <span className="mobile-room-badge">{roomLabel}</span>}
          <button className="btn btn-sm btn-outline-secondary ms-auto" onClick={flipCamera}><i className="bi bi-arrow-repeat" /></button>
        </div>
        <div className="camera-container">
          <video ref={videoRef} autoPlay playsInline muted className="camera-preview" />
          <canvas ref={canvasRef} style={{ display: 'none' }} />
          <div className="camera-shutter"><button className="shutter-btn" onClick={capturePhoto} /></div>
          {capturedPhotos.length > 0 && (
            <div className="captured-section">
              <p className="captured-title">Tus fotos ({capturedPhotos.length})</p>
              <div className="captured-thumbnails">
                {capturedPhotos.map(p => (
                  <div key={p.id} className="captured-thumb-wrapper">
                    <img src={p.thumb || p.dataUrl} alt="" className="captured-thumb" loading="lazy" decoding="async" draggable={false} onContextMenu={e=>e.preventDefault()} onDragStart={e=>e.preventDefault()} />
                    <button className="btn btn-sm btn-danger captured-remove-btn" onClick={() => removeCaptured(p.id)}><i className="bi bi-x" /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {capturedPhotos.length > 0 && (
            <div className="d-flex gap-2 w-100" style={{flexDirection:'column'}}>
              <button className="btn btn-warning fw-bold w-100 continue-button" onClick={() => setStep(STEP_ORDER)}>
                <i className="bi bi-bag-check me-2" />Hacer pedido ({capturedPhotos.length} foto{capturedPhotos.length > 1 ? 's' : ''})
              </button>
            </div>
          )}
        </div>
        {toast && <div className="mobile-toast">{toast}</div>}
      </div>
    )
  }

  if (step === STEP_ORDER) {
    return (
      <div className="mobile-app d-flex flex-column" style={{minHeight:'100dvh'}}>
        <div className="mobile-header d-flex align-items-center gap-2">
          <button className="btn btn-sm btn-outline-secondary" onClick={() => setStep(STEP_GALLERY)}><i className="bi bi-arrow-left" /></button>
          <span className="fw-bold" style={{color:'var(--pb-accent)'}}>Tu pedido</span>
          {eventCode && <span className="mobile-room-badge ms-auto">{roomLabel}</span>}
        </div>
        <div className="order-summary-container">
          {capturedPhotos.map(photo => (
            <div key={photo.id} className="order-photo-item">
              <img src={photo.thumb || photo.dataUrl} alt="" className="order-photo-thumb" loading="lazy" decoding="async" draggable={false} onContextMenu={e=>e.preventDefault()} onDragStart={e=>e.preventDefault()} />
              <div className="order-photo-info">
                <div className="order-photo-label">Tu foto</div>
                <div className="order-copies-selector">
                  <span className="order-copies-label">Copias</span>
                  <div className="copias-stepper">
                    <span className="copias-stepper-valor">{photo.copies || 1}</span>
                    <span className="copias-stepper-flechas">
                      <button type="button" aria-label="Una copia más" disabled={(photo.copies || 1) >= MAX_COPIAS} onClick={() => cambiarCopias(photo.id, 1)}><i className="bi bi-chevron-up" /></button>
                      <button type="button" aria-label="Una copia menos" disabled={(photo.copies || 1) <= 1} onClick={() => cambiarCopias(photo.id, -1)}><i className="bi bi-chevron-down" /></button>
                    </span>
                  </div>
                  <span className="order-price">{priceForPhoto(photo.copies).toFixed(2)}€</span>
                </div>
              </div>
              <button className="btn btn-sm btn-outline-danger order-delete-btn" onClick={() => removeCaptured(photo.id)}><i className="bi bi-trash" /></button>
            </div>
          ))}
          <div className="order-total-box">
            <span className="order-total-label">Total</span>
            {discountAmount > 0 ? (
              <>
                <span style={{textDecoration:'line-through', marginRight:'10px', color:'grey'}}>{totalPrice()}€</span>
                <span className="order-total-amount">{finalPrice}€</span>
              </>
            ) : (
              <span className="order-total-amount">{totalPrice()}€</span>
            )}
          </div>

          {albumActivo && (
            <div className={`album-promo ${albumConseguido ? 'album-promo-hecho' : ''}`}>
              <div className="album-promo-fila">
                <span className="album-promo-icono"><i className={`bi ${albumConseguido ? 'bi-gift-fill' : 'bi-gift'}`} /></span>
                <div className="album-promo-texto">
                  {albumConseguido ? (
                    <><b>¡Álbum de regalo incluido!</b><span> Lo recoges en recepción junto con tus fotos.</span></>
                  ) : (
                    <><b>Añade {albumRestantes} foto{albumRestantes > 1 ? 's' : ''} más</b><span> y te llevas un álbum de regalo</span></>
                  )}
                </div>
              </div>
              <div className="album-promo-barra">
                <div className="album-promo-relleno" style={{ width: `${Math.min(100, Math.round((totalCopies / COPIAS_PARA_ALBUM) * 100))}%` }} />
              </div>
              {!albumConseguido && (
                <button className="album-promo-accion" onClick={() => setStep(STEP_GALLERY)}>
                  <i className="bi bi-plus-circle me-1" />Añadir más fotos
                </button>
              )}
            </div>
          )}

          {/* Panel de cupón (descuento o pago completo) */}
          <div className="payment-methods-section">
            <div className="payment-method-card" style={{ borderColor: appliedCoupon ? '#198754' : undefined }}>
              <div className="payment-method-header">
                <div className="payment-method-icon" style={{ background: '#198754', color: '#fff' }}><i className="bi bi-ticket-perforated"></i></div>
                <div className="payment-method-info">
                  <div className="payment-method-name">Cupón de descuento o pago</div>
                  <div className="payment-method-desc">Introduce el código (válido una sola vez)</div>
                </div>
              </div>
              <div className="payment-method-content">
                {appliedCoupon ? (
                  <div className="d-flex align-items-center justify-content-between">
                    <div className="text-success fw-bold">
                      <i className="bi bi-check-circle-fill me-1" />
                      {appliedCoupon.type === 'discount' ? `Descuento: ${appliedCoupon.amount_eur}` : `Pago completo cubierto (${appliedCoupon.amount_eur})`}
                    </div>
                    <button className="btn btn-sm btn-outline-secondary" onClick={() => { setAppliedCoupon(null); setDiscountAmount(0); setCouponCode(''); setCouponError(''); }}>
                      Cambiar
                    </button>
                  </div>
                ) : (
                  <div className="d-flex gap-2">
                    <input type="text" className={`form-control bg-black border-secondary text-light text-uppercase ${couponError ? 'is-invalid' : ''}`} value={couponCode} onChange={e => { setCouponCode(e.target.value); setCouponError(''); }} style={{ fontFamily: 'monospace', letterSpacing: '1px' }} />
                    <button className="btn btn-outline-success fw-bold" onClick={handleApplyCoupon} disabled={couponLoading}>
                      {couponLoading ? <span className="spinner-border spinner-border-sm" /> : 'Aplicar'}
                    </button>
                  </div>
                )}
                {couponError && <div className="text-danger mt-1" style={{ fontSize: '13px' }}>{couponError}</div>}
              </div>
            </div>

            {/* Con el pedido ya cubierto por el cupón no se muestra ninguna pasarela. */}
            {finalCents === 0 ? (
              <div className="payment-method-card">
                <div className="payment-method-content text-center">
                  <i className="bi bi-check-circle-fill text-success" style={{ fontSize: 34 }} />
                  <p className="fw-bold mt-2 mb-1">No tienes que pagar nada</p>
                  <p className="text-muted mb-3" style={{ fontSize: 14 }}>Tu cupón cubre el pedido completo.</p>
                  {squareError && <div className="text-danger mb-2">{squareError}</div>}
                  <button className="btn btn-warning w-100 fw-bold payment-btn" onClick={handleFreeOrder} disabled={squareLoading || totalCopies === 0}>
                    {squareLoading ? <><span className="spinner-border spinner-border-sm me-2" />Enviando…</> : <><i className="bi bi-send me-2" />Enviar pedido</>}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="pay-method-chooser">
                  <p className="pay-method-question">¿Cómo quieres pagar?</p>
                  <div className="pay-method-tabs">
                    <button className={`pay-method-tab ${payMethod === 'card' ? 'active' : ''}`} onClick={() => setPayMethod('card')}>
                      <i className="bi bi-credit-card-2-front" />
                      <span>Tarjeta</span>
                    </button>
                    <button className={`pay-method-tab ${payMethod === 'paypal' ? 'active' : ''}`} onClick={() => setPayMethod('paypal')}>
                      <i className="bi bi-paypal" />
                      <span>PayPal</span>
                    </button>
                  </div>
                </div>

                {payMethod === 'card' ? (
                  <div className="payment-method-card card-payment-card">
                    <div className="payment-method-content">
                      <div id="card-container" style={{ minHeight: '150px' }}></div>
                      {squareError && <div className="text-danger text-center mt-2">{squareError}</div>}
                      <button className="btn btn-warning w-100 mt-3 fw-bold payment-btn" onClick={handleSquarePayment} disabled={squareLoading || !squareCard || totalCopies === 0}>
                        {squareLoading ? <><span className="spinner-border spinner-border-sm me-2" />Procesando…</> : `Pagar ${finalPrice}€`}
                      </button>
                      <p className="pay-method-note"><i className="bi bi-shield-lock me-1" />Visa · Mastercard · American Express</p>
                    </div>
                  </div>
                ) : (
                  <div className="payment-method-card paypal-card">
                    <div className="payment-method-content">
                      {paypalError && <div className="text-danger text-center mb-2">{paypalError}</div>}
                      <div id="paypal-button-container" style={{ minHeight: '70px' }} />
                      {!paypalReady && !paypalError && <div className="text-center text-muted">Cargando PayPal…</div>}
                      {!paypalClientId && <div className="text-center text-muted">PayPal no configurado en el servidor.</div>}
                      <p className="pay-method-note"><i className="bi bi-shield-lock me-1" />Paga con tu cuenta de PayPal o con tarjeta</p>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
          {finalCents > 0 && (
            <div className="alert alert-secondary order-payment-note">
              <i className="bi bi-lock-fill text-warning" /> Pago seguro. No guardamos los datos de tu tarjeta.
            </div>
          )}
        </div>
        {envioProgreso && (
          <div className="mobile-busy-overlay">
            <span className="spinner-border text-warning" style={{width:'2.5rem',height:'2.5rem'}} />
            <p className="mobile-busy-title">Enviando tus fotos… {envioProgreso.hechas}/{envioProgreso.total}</p>
            <p className="mobile-busy-text">No cierres esta pantalla.</p>
          </div>
        )}
        {toast && <div className="mobile-toast">{toast}</div>}
      </div>
    )
  }

  if (step === STEP_SUCCESS) {
    return (
      <div className="mobile-app success-container">
        <img src={hotelLogoUrl(hotelId)} alt="Success" className="success-image" />
        <h2 className="success-title">¡Pedido enviado!</h2>
        <p className="success-text">Tu pedido ha sido enviado. Tus fotos se imprimirán en breve.</p>
        {albumConseguido && (
          <div className="album-promo album-promo-hecho album-promo-exito">
            <div className="album-promo-fila">
              <span className="album-promo-icono"><i className="bi bi-gift-fill" /></span>
              <div className="album-promo-texto">
                <b>Tu álbum de regalo te espera</b><span> Recógelo en recepción con tus fotos.</span>
              </div>
            </div>
          </div>
        )}
        <p className="success-small-text">¡Gracias por tu compra!</p>
        <button className="btn btn-outline-warning back-button" onClick={() => { borrarPedido(); setStep(STEP_GALLERY); setCapturedPhotos([]); setAppliedCoupon(null); setDiscountAmount(0); setCouponCode(''); }}>
          <i className="bi bi-check-circle me-2" />Finalizar
        </button>
        {textos?.empresa && <p className="company-footer"><i className="bi bi-camera me-1" />{textos.empresa}</p>}
      </div>
    )
  }
  return null
}