import React, { useState, useEffect, useCallback, useRef } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { findEvent, getEventPhotos, printJob, saveConfig, getConfig, getPrintCount, sendPhoto, processPayment, hotelLogoUrl, uploadHotelLogo, saveHabitaciones, login, logout, getMe } from '../shared/api'
import { useInterval } from '../shared/hooks/useInterval'
import './Viewer.css'

window.isViewer = true

const BACKEND = window.electronAPI?.backendUrl || (window.location.hostname === 'localhost' ? 'http://localhost:4000' : '/')

const defaultPrivacyContent = `
<div style="text-align:center;"><h4><b> Condiciones y políticas de uso </b></h4><br></div>
<div style="text-align:justify;"><p> La Aplicación Printbox Hotels está desarrollada, diseñada y publicada por Jorge Marí Grimalt y domicilio C/Patricio Ferrandiz 3 Bjo C Incomar en Dénia, Alicante. Las condiciones de servicio y uso (las "Condiciones de Uso") rigen el acceso a la aplicación móvil Printbox Hotels así como el uso del Sitio y de los servicios que usted (el "Usuario") realice. </p><p> Para consultar nuestras políticas de privacidad, acceda en el siguiente enlace: </p></div>
`

const SQUARE_APP_ID = 'sq0idp-OV9y595m1kR_UU3QRest7Q'
const SQUARE_LOCATION_ID = 'LHB32XGQK68GX'

// Traba para el personal del hotel (que ya entró con su sesión), no un secreto: va en el bundle.
const ADVANCED_PASSWORD = 'HostyPrint2026@'
const PRECIO_FOTO_DEFAULT = '1.20'

// Los QR van siempre a https (salvo en local): con http, Square no carga en el móvil.
function mobileOrigin() {
  const { origin, hostname } = window.location
  if (hostname === 'localhost' || hostname === '127.0.0.1') return origin
  return origin.replace(/^http:/, 'https:')
}

// Semáforo del código de habitación: comprobando / existe / no existe.
function RoomCodeStatus({ status }) {
  if (status === 'checking') return <span className="spinner-border spinner-border-sm text-secondary" title="Comprobando…" />
  if (status === 'ok') return <i className="bi bi-check-circle-fill text-success" title="La habitación existe" />
  if (status === 'bad') return <i className="bi bi-x-circle-fill text-danger" title="No existe ninguna habitación con este código" />
  return <i className="bi bi-dash-circle text-secondary" title="Sin comprobar" />
}

function fixImageUrl(url) {
  if (!url) return ''
  if (url.includes('/proxy-image')) return url
  try {
    const parsed = new URL(url)
    return '/proxy-image' + parsed.pathname
  } catch {
    if (url.startsWith('/')) return '/proxy-image' + url
    return url
  }
}

export default function ViewerApp() {
  // --- Configuración ---
  const [config, setConfig] = useState(null)
  const [textos, setTextos] = useState(null)
  const [uuid, setUuid] = useState(null)
  const [allPhotos, setAllPhotos] = useState([])
  const [currentPage, setCurrentPage] = useState(1)
  const [lastPage, setLastPage] = useState(1)
  const [printCount, setPrintCount] = useState(0)
  const [error, setError] = useState(null)
  const [autoplay, setAutoplay] = useState(false)
  const [loading, setLoading] = useState(false)

  // Sesión de hotel: undefined = comprobando, null = mostrar login, { hotelId, nombre } = dentro
  const [session, setSession] = useState(undefined)
  const [loginUser, setLoginUser] = useState('')
  const [loginPass, setLoginPass] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)

  // Modales
  const [showEventModal, setShowEventModal] = useState(false)
  const [eventError, setEventError] = useState('')

  // Admin
  const [adminError, setAdminError] = useState('')
  const [adminEventCode, setAdminEventCode] = useState('')
  const [adminPrinterEventCode, setAdminPrinterEventCode] = useState('')
  const [adminPrecioFoto, setAdminPrecioFoto] = useState('')
  // Campos sensibles (evento de impresión y precio) tras contraseña fija de Printbox.
  const [advancedUnlocked, setAdvancedUnlocked] = useState(false)
  const [showUnlockModal, setShowUnlockModal] = useState(false)
  const [unlockInput, setUnlockInput] = useState('')
  const [unlockError, setUnlockError] = useState('')
  // Confirmación escrita antes de cortar el servicio a todos los huéspedes.
  const [showServiceConfirm, setShowServiceConfirm] = useState(false)
  const [serviceConfirmInput, setServiceConfirmInput] = useState('')
  // Validación en vivo de los códigos de habitación: { [codigo]: 'checking' | 'ok' | 'bad' }
  const [roomCodeStatus, setRoomCodeStatus] = useState({})
  const [adminEmailRecepcion, setAdminEmailRecepcion] = useState('')
  const [adminServicioDisponible, setAdminServicioDisponible] = useState(true)
  const [adminHotelName, setAdminHotelName] = useState('')
  const [adminRooms, setAdminRooms] = useState([])
  const [adminLogoData, setAdminLogoData] = useState(null) // dataURL PNG pendiente de subir
  const [adminSaving, setAdminSaving] = useState(false)

  // Habitaciones registradas del hotel [{ nombre, codigo }] y logo dinámico
  const [habitaciones, setHabitaciones] = useState([])
  const [logoVersion, setLogoVersion] = useState(0)
  const logoSrc = `${hotelLogoUrl()}?v=${logoVersion}`
  const [qrRoom, setQrRoom] = useState(null) // { nombre, codigo } | null — modal de QR

  // Asistente de primera configuración (nombre del hotel → logo → habitaciones)
  const [showSetupWizard, setShowSetupWizard] = useState(false)
  const [wizardStep, setWizardStep] = useState(1)
  const [wizardName, setWizardName] = useState('')
  const [wizardLogoData, setWizardLogoData] = useState(null)
  const [wizardRooms, setWizardRooms] = useState([{ nombre: '', codigo: '' }])
  const [wizardError, setWizardError] = useState('')
  const [wizardSaving, setWizardSaving] = useState(false)

  const [showPrivacyModal, setShowPrivacyModal] = useState(false)
  const [privacyContent, setPrivacyContent] = useState('')
  const [showAdminConfig, setShowAdminConfig] = useState(false)

  // Panel de cupones (admin)
  const [showCouponPanel, setShowCouponPanel] = useState(false)
  const [couponGenAmount, setCouponGenAmount] = useState('')
  const [couponGenHours, setCouponGenHours] = useState('72')
  const [couponGenType, setCouponGenType] = useState('full')
  const [couponGenResult, setCouponGenResult] = useState(null)
  const [couponGenError, setCouponGenError] = useState('')
  const [couponGenLoading, setCouponGenLoading] = useState(false)
  const [couponList, setCouponList] = useState([])
  const [couponListLoading, setCouponListLoading] = useState(false)

  // Pago y cupón en el modal de impresión
  const [selectedPhoto, setSelectedPhoto] = useState(null)
  const [copies, setCopies] = useState(1)
  const [printing, setPrinting] = useState(false)
  const [printDone, setPrintDone] = useState(false)
  const [showPayment, setShowPayment] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState('')
  const [squareCard, setSquareCard] = useState(null)
  const [squareError, setSquareError] = useState('')
  const [squareLoading, setSquareLoading] = useState(false)
  // Cupón (descuento/pago completo)
  const [couponCode, setCouponCode] = useState('')
  const [couponError, setCouponError] = useState('')
  const [couponLoading, setCouponLoading] = useState(false)
  const [appliedCoupon, setAppliedCoupon] = useState(null)

  // ── LOCALSTORAGE (solo caché de pintado; la fuente de verdad es el servidor por sesión) ──
  const saveViewerState = () => {
    try {
      const data = { config, textos, currentPage, lastPage, printCount }
      localStorage.setItem('printbox_viewer_state', JSON.stringify(data))
    } catch (e) { console.error(e) }
  }

  // ── INICIALIZACIÓN (tras autenticar) — toda la config viene del hotel de la sesión ──
  const init = useCallback(async () => {
    try {
      const [d, count] = await Promise.all([
        getConfig(),                 // hotel resuelto por la cookie de sesión
        getPrintCount().catch(() => 0),
      ])
      const cfg = d.config || {}
      const mergedConfig = {
        servidor: cfg.servidor || 'http://gestion.printboxweb.com',
        timer: cfg.timer || 5,
        impresora: cfg.impresora || '',
        delay: cfg.delay || 5,
        evento: cfg.evento || '',
        evento_printer: cfg.evento_printer || '',
        servicio_disponible: cfg.servicio_disponible !== false,
      }
      const mergedTextos = {
        precio1: PRECIO_FOTO_DEFAULT, precio2: '2.40', precio3: '3.60', empresa: '',
        ...(d.textos || {}),
      }
      setConfig(mergedConfig)
      setTextos(mergedTextos)
      setHabitaciones(d.habitaciones || [])
      setPrintCount(count || 0)
      setError(null)
      if (!mergedConfig.evento) {
        if ((d.habitaciones || []).length) {
          setShowEventModal(true)           // habitaciones registradas pero ninguna elegida
        } else {
          const empresa = mergedTextos.empresa || ''
          setWizardName(empresa && empresa !== 'Printbox Hotels' ? empresa : '')
          setShowSetupWizard(true)          // hotel sin configurar → asistente
        }
      } else setShowEventModal(false)
    } catch (e) {
      setError('No se pudo cargar la configuración: ' + (e?.message || e))
    }
  }, [])

  // Comprobar sesión al arrancar; si hay, inicializar
  useEffect(() => {
    getMe().then(me => {
      if (me) { setSession(me); init() }
      else setSession(null)
    }).catch(() => setSession(null))
  }, [init])

  async function handleLogin(e) {
    e?.preventDefault?.()
    if (!loginUser.trim() || !loginPass) { setLoginError('Introduce usuario y contraseña'); return }
    setLoginLoading(true); setLoginError('')
    try {
      const me = await login(loginUser.trim(), loginPass)
      setSession(me); setLoginPass('')
      await init()
    } catch (err) { setLoginError(err.message) }
    finally { setLoginLoading(false) }
  }

  async function handleLogout() {
    await logout()
    setSession(null)
    setConfig(null); setTextos(null); setUuid(null); setHabitaciones([]); setAllPhotos([])
    setShowAdminConfig(false); setShowEventModal(false); setShowSetupWizard(false)
    localStorage.removeItem('printbox_viewer_state')
  }

  useEffect(() => { fetch('/assets/terms_and_conditions_2.html').then(r=>r.text()).then(setPrivacyContent).catch(()=>setPrivacyContent(defaultPrivacyContent)) }, [])
  useEffect(() => { if (session) saveViewerState() }, [config, textos, currentPage, lastPage, printCount, session])

  // ── EVENTO Y ADMIN ──
  // Cambiar la habitación que muestra el Monitor (de entre las registradas)
  async function handleSelectRoom(codigo) {
    const fullCode = `ev-${codigo}`
    setEventError('')
    setShowEventModal(false)
    const newConfig = { ...config, evento: fullCode }
    setConfig(newConfig)
    await saveConfig(newConfig, textos).catch(() => {})
  }

  // Lee un archivo de imagen y lo devuelve como dataURL PNG cuadrado-máx 512px
  // (así el POST /hotel-logo recibe siempre un PNG pequeño, venga el archivo que venga)
  function readLogoFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('Sin archivo'))
      if (!/^image\//.test(file.type)) return reject(new Error('El archivo debe ser una imagen'))
      const reader = new FileReader()
      reader.onload = () => {
        const img = new Image()
        img.onload = () => {
          const canvas = document.createElement('canvas')
          const ratio = Math.min(512 / img.width, 512 / img.height, 1)
          canvas.width = Math.max(1, Math.round(img.width * ratio))
          canvas.height = Math.max(1, Math.round(img.height * ratio))
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
          resolve(canvas.toDataURL('image/png'))
        }
        img.onerror = () => reject(new Error('No se pudo leer la imagen'))
        img.src = reader.result
      }
      reader.onerror = () => reject(new Error('No se pudo leer el archivo'))
      reader.readAsDataURL(file)
    })
  }

  // Editor de lista de habitaciones (compartido entre asistente y Admin)
  const updateRoomList = (setter) => ({
    add: () => setter(prev => [...prev, { nombre: '', codigo: '' }]),
    remove: (idx) => setter(prev => prev.filter((_, i) => i !== idx)),
    set: (idx, field, value) => setter(prev => prev.map((r, i) => i === idx ? { ...r, [field]: field === 'codigo' ? value.replace(/\D/g, '') : value } : r)),
  })
  const wizardRoomsEditor = updateRoomList(setWizardRooms)
  const adminRoomsEditor = updateRoomList(setAdminRooms)

  const validRooms = (rooms) => rooms
    .map(r => ({ nombre: r.nombre.trim(), codigo: r.codigo.trim() }))
    .filter(r => r.codigo)

  // Comprueba contra Laravel que el código existe, para avisar al escribir y no al guardar.
    const checkRoomCode = useCallback(async (codigo) => {
    const code = String(codigo || '').trim()
    if (!code) return
    setRoomCodeStatus(prev => (prev[code] ? prev : { ...prev, [code]: 'checking' }))
    try {
      const id = await findEvent(`ev-${code}`)
      setRoomCodeStatus(prev => ({ ...prev, [code]: id ? 'ok' : 'bad' }))
    } catch {
      setRoomCodeStatus(prev => ({ ...prev, [code]: 'bad' }))
    }
  }, [])

  function handleUnlockAdvanced() {
    if (unlockInput !== ADVANCED_PASSWORD) { setUnlockError('Contraseña incorrecta'); return }
    setAdvancedUnlocked(true)
    setShowUnlockModal(false)
    setUnlockInput('')
    setUnlockError('')
  }

  // Primer código repetido entre habitaciones (o null): no pueden compartir código de evento.
  const duplicateRoomCode = (rooms) => {
    const seen = new Set()
    for (const r of rooms) {
      if (seen.has(r.codigo)) return r.codigo
      seen.add(r.codigo)
    }
    return null
  }

  // ── ASISTENTE DE PRIMERA CONFIGURACIÓN ──
  async function handleWizardFinish() {
    const rooms = validRooms(wizardRooms)
    if (!rooms.length) { setWizardError('Añade al menos una habitación con su código'); return }
    const dupW = duplicateRoomCode(rooms)
    if (dupW) { setWizardError(`Hay dos habitaciones con el mismo código (${dupW}). Cada habitación debe tener un código distinto.`); return }
    setWizardError('')
    setWizardSaving(true)
    try {
      if (wizardLogoData) {
        await uploadHotelLogo(wizardLogoData)
        setLogoVersion(Date.now())
      }
      await saveHabitaciones(rooms)
      const newConfig = { ...config, evento: `ev-${rooms[0].codigo}` }
      const newTextos = {
        text_es: textos?.text_es || '¡Consigue tu foto de la habitación!',
        text_en: textos?.text_en || 'Get your room photo!',
        text_fr: textos?.text_fr || 'Obtenez votre photo!',
        text_de: textos?.text_de || 'Hol dir dein Foto!',
        precio1: textos?.precio1 || PRECIO_FOTO_DEFAULT,
        precio2: textos?.precio2 || (parseFloat(PRECIO_FOTO_DEFAULT) * 2).toFixed(2),
        precio3: textos?.precio3 || (parseFloat(PRECIO_FOTO_DEFAULT) * 3).toFixed(2),
        empresa: wizardName.trim() || 'Printbox Hotels',
        email_recepcion: textos?.email_recepcion || '',
      }
      const saveResult = await saveConfig(newConfig, newTextos)
      if (saveResult.textos) setTextos(saveResult.textos)
      setConfig(newConfig)
      setHabitaciones(rooms)
      setShowSetupWizard(false)
      setWizardStep(1)
    } catch (e) {
      setWizardError('Error guardando: ' + e.message)
    } finally {
      setWizardSaving(false)
    }
  }

  // ── ADMIN ──
  // El acceso ya está protegido por la sesión de hotel; el Admin abre directo.
  function openAdmin() {
    setAdminError('')
    setShowAdminConfig(true)
    setAdminHotelName(textos?.empresa && textos.empresa !== 'Printbox Hotels' ? textos.empresa : (textos?.empresa || ''))
    setAdminRooms(habitaciones.length ? habitaciones.map(h => ({ ...h })) : [{ nombre: '', codigo: '' }])
    setAdminLogoData(null)
    setAdminEventCode(config?.evento?.replace('ev-', '') || '')
    setAdminPrinterEventCode(config?.evento_printer?.replace('ev-', '') || '')
    setAdminPrecioFoto(textos?.precio1 || PRECIO_FOTO_DEFAULT)
    setAdminEmailRecepcion(textos?.email_recepcion || '')
    setAdminServicioDisponible(config?.servicio_disponible !== false)
    setAdvancedUnlocked(false)
    setRoomCodeStatus({})
  }

  async function handleSaveAdminConfig() {
    const rooms = validRooms(adminRooms)
    if (!rooms.length) { setAdminError('Añade al menos una habitación con su código'); return }
    const dup = duplicateRoomCode(rooms)
    if (dup) { setAdminError(`Hay dos habitaciones con el mismo código (${dup}). Cada habitación debe tener un código distinto.`); return }
    // La habitación monitorizada debe ser una de las registradas
    const monitorCode = rooms.some(r => r.codigo === adminEventCode) ? adminEventCode : rooms[0].codigo
    const newConfig = { ...config, evento: `ev-${monitorCode}`, evento_printer: adminPrinterEventCode ? `ev-${adminPrinterEventCode}` : '', servicio_disponible: adminServicioDisponible }
    const newTextos = {
      text_es: textos?.text_es || '¡Consigue tu foto de la habitación!',
      text_en: textos?.text_en || 'Get your room photo!',
      text_fr: textos?.text_fr || 'Obtenez votre photo!',
      text_de: textos?.text_de || 'Hol dir dein Foto!',
      // Precio ÚNICO por foto. precio2/precio3 se guardan como múltiplos para que el
      // fichero siga siendo válido y el recálculo del importe en el servidor (tabla
      // [0,p1,p2,p3]) siga cuadrando sin tocar los dos backends.
      ...(() => {
        const p = parseFloat(String(adminPrecioFoto).replace(',', '.'))
        const unit = Number.isFinite(p) && p >= 0 ? p : parseFloat(textos?.precio1) || parseFloat(PRECIO_FOTO_DEFAULT)
        return { precio1: unit.toFixed(2), precio2: (unit * 2).toFixed(2), precio3: (unit * 3).toFixed(2) }
      })(),
      empresa: adminHotelName.trim() || textos?.empresa || 'Printbox Hotels',
      email_recepcion: adminEmailRecepcion?.trim() || '',
    }
    setAdminError('')
    setAdminSaving(true)
    try {
      if (adminLogoData) {
        await uploadHotelLogo(adminLogoData)
        setLogoVersion(Date.now())
      }
      await saveHabitaciones(rooms)
      // Sin eventCode: los textos/precios/email se guardan en el textos.txt global del hotel
      const saveResult = await saveConfig(newConfig, newTextos)
      if (saveResult.textos) { setTextos(saveResult.textos); localStorage.removeItem('printbox_viewer_state') }
      if (saveResult.config) setConfig(saveResult.config)
      setHabitaciones(rooms)
      setAdminError('✓ Configuración guardada correctamente')
      setTimeout(() => { setShowAdminConfig(false); setAdminError(''); setAdminLogoData(null) }, 1200)
    } catch (e) {
      setAdminError('Error guardando configuración: ' + e.message)
    } finally {
      setAdminSaving(false)
    }
  }

  // ── FOTOS ──
  // Limpiar uuid y galería ANTES de resolver el nuevo evento: si find-event falla (419 o
  // habitación inexistente) no debe quedarse pegada la galería de la habitación anterior.
  useEffect(() => {
    if (!config?.evento) { setUuid(null); setAllPhotos([]); return }
    setUuid(null); setAllPhotos([])
    findEvent(config.evento)
      .then(setUuid)
      .catch(e => { setError(`No se pudo conectar: ${e.message}`); setUuid(null); setAllPhotos([]) })
  }, [config?.evento])

  // silent=true → refresco de fondo: no pone loading ni borra la galería (si no, parpadeaba
  // a "Cargando fotos…" en cada ciclo).
  const loadAllPhotos = useCallback(async (localPage = 1, silent = false) => {
    if (!uuid) return
    if (!silent) setLoading(true)
    try {
      const remoteStart = (localPage - 1) * 2 + 1
      let resultPhotos = []
      let remoteLastPage = 1
      let remotePerPage = 10
      for (let offset = 0; offset < 2; offset++) {
        const remotePage = remoteStart + offset
        const { photos: data = [], lastPage: lp } = await getEventPhotos(uuid, remotePage)
        remoteLastPage = lp || remoteLastPage
        if (data.length) resultPhotos.push(...data)
        if (remotePage >= remoteLastPage) break
      }
      if (resultPhotos.length < 20 && remoteStart + 2 <= remoteLastPage) {
        const { photos: extra = [] } = await getEventPhotos(uuid, remoteStart + 2)
        resultPhotos.push(...extra)
      }
      setAllPhotos(resultPhotos.slice(0,20))
      const calculatedLast = Math.max(1, Math.ceil((remoteLastPage * (remotePerPage || 10)) / 20))
      setLastPage(calculatedLast)
      setError(null)
    } catch (e) {
      // En refresco de fondo, un fallo puntual no borra la galería: se reintenta al siguiente ciclo.
      if (!silent) { setError(`Error al cargar fotos: ${e.message}`); setAllPhotos([]) }
    }
    finally { if (!silent) setLoading(false) }
  }, [uuid])

  useEffect(() => { loadAllPhotos(currentPage).catch(e => setError(`Error al cargar fotos: ${e?.message || e}`)) }, [loadAllPhotos, currentPage])

  // Autoplay
  useInterval(() => { if (autoplay) setCurrentPage(p => (p < lastPage ? p + 1 : 1)) }, autoplay ? 15000 : null)

  // Auto-refresco cada 20s para que aparezcan las fotos nuevas de los huéspedes. Se pausa si
  // hay un modal abierto para no interrumpir al recepcionista.
  useInterval(() => {
    if (uuid && !loading && !selectedPhoto && !showAdminConfig && !showSetupWizard && !showEventModal) {
      loadAllPhotos(currentPage, true).catch(() => {})
    }
  }, uuid ? 20000 : null)

  // ── HELPERS DE PRECIO ──
  function getPrecio(n) {
    if (!textos) return null
    if (n === 1) return textos.precio1
    if (n === 2) return textos.precio2
    if (n >= 3) return textos.precio3
  }
  const totalPrice = () => {
    const p = parseFloat(getPrecio(copies) || 0)
    return isNaN(p) ? '0' : p.toFixed(2)
  }
  // Un cupón 'discount' resta su importe; uno 'full' cubre el pedido entero cuando su
  // importe alcanza el total (si no, cubre lo que puede y el resto se paga con tarjeta).
  const couponDiscountCents = (total) => {
    if (!appliedCoupon) return 0
    if (appliedCoupon.type === 'full') return Math.min(appliedCoupon.amount, total)
    return appliedCoupon.type === 'discount' ? appliedCoupon.amount : 0
  }

  const totalCents = Math.round(parseFloat(totalPrice()) * 100)
  const discountCents = couponDiscountCents(totalCents)
  const finalCents = Math.max(0, totalCents - discountCents)
  const finalPrice = (finalCents / 100).toFixed(2)

  // Desglose que se manda con el pago para que el servidor recalcule el importe.
  const orderPayload = () => ({
    hotel: session?.hotelId || '',
    evento: (config?.evento || '').replace('ev-', ''),
    copies: [copies],
    coupon: appliedCoupon ? couponCode.trim().toUpperCase() : undefined,
  })

  // ── CUPONES (proxy.php) ──
  const validateCoupon = async (code) => {
    const evento = (config?.evento || '').replace('ev-', '')
    const res = await fetch('/coupon/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim().toUpperCase(), evento }),
    })
    const json = await res.json()
    if (!res.ok || !json.valid) throw new Error(json.error || 'Cupón inválido')
    return json
  }
  const redeemCoupon = async (code, orderId) => {
    const evento = (config?.evento || '').replace('ev-', '')
    const res = await fetch('/coupon/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim().toUpperCase(), evento, order_id: orderId }),
    })
    const json = await res.json()
    if (!res.ok || !json.ok) throw new Error(json.error || 'No se pudo canjear el cupón')
    return json
  }

  // ── IMPRESIÓN Y PAGO ──
  function handleSelectPhoto(photo) { setSelectedPhoto(photo); setCopies(1); setPrintDone(false); setShowPayment(false); setAppliedCoupon(null); setCouponCode(''); setCouponError('') }

  const handleApplyCoupon = async () => {
    if (!couponCode.trim()) { setCouponError('Introduce un código'); return }
    setCouponLoading(true); setCouponError('')
    try {
      const result = await validateCoupon(couponCode)
      setAppliedCoupon(result)
    } catch (e) { setCouponError(e.message); setAppliedCoupon(null) }
    finally { setCouponLoading(false) }
  }

  const handlePayment = async () => {
    if (!selectedPhoto || printing || !paymentMethod) return
    if (paymentMethod === 'square' && !squareCard) { setSquareError('Square no inicializado'); return }

    // Validar cupón tipo full
    if (appliedCoupon?.type === 'full' && finalCents > 0) {
      setCouponError('El cupón de pago completo no cubre el total')
      return
    }

    setPrinting(true)
    try {
      // 1. Procesar pago si hay saldo restante
      if (finalCents > 0) {
        if (paymentMethod === 'square') {
          setSquareLoading(true)
          const result = await squareCard.tokenize()
          if (result.status !== 'OK') throw new Error(result.errors?.[0]?.message || 'Tokenización fallida')
          await processPayment({ token: result.token, amount: String(finalCents), currency: 'EUR', order: orderPayload() })
          setSquareLoading(false)
        } else if (paymentMethod === 'paypal') {
          // PayPal NO está integrado en el Monitor (sí en el móvil, con los botones del
          // SDK). Mientras siga así, este método no debería ofrecerse en la UI: el
          // usuario llega al final del flujo y solo entonces ve el error.
          throw new Error('PayPal en Viewer requiere integración adicional. Usa Square o cupón.')
        }
      }

      // 2. Consumir cupón si se aplicó
      if (appliedCoupon) {
        const orderId = `viewer_${Date.now()}`
        await redeemCoupon(couponCode, orderId)
      }

      // 3. Enviar foto a impresora
      if (config?.evento_printer) {
        const proxyUrl = fixImageUrl(selectedPhoto.uri_full || selectedPhoto.uri)
        const resp = await fetch(proxyUrl)
        const blob = await resp.blob()
        const base64 = await new Promise(res => { const reader = new FileReader(); reader.onload = () => res(reader.result); reader.readAsDataURL(blob) })
        await sendPhoto({ event: config.evento_printer, image: base64, times: copies, name: `print_${copies}_${selectedPhoto.id || 'viewer'}`, phone: '000000000', orientation: 'landscape' })
      }
      setPrintDone(true)
    } catch (e) { console.error(e); setSquareError(e.message) }
    finally { setPrinting(false) }
  }

  // Inicializar Square cuando se muestra modal de pago y se selecciona tarjeta
  useEffect(() => {
    if (showPayment && paymentMethod === 'square') {
      const initSquare = async () => {
        if (!window.Square) { setSquareError('Pasarela no cargada'); return }
        try {
          const payments = window.Square.payments(SQUARE_APP_ID, SQUARE_LOCATION_ID)
          const card = await payments.card()
          await card.attach('#card-container')
          setSquareCard(card)
          setSquareError('')
        } catch (e) { setSquareError(e.message) }
      }
      initSquare()
    }
  }, [showPayment, paymentMethod])

  // ── ADMIN CUPONES ──
  const handleGenerateCoupon = async () => {
    const euros = parseFloat(couponGenAmount)
    if (!euros || euros <= 0) { setCouponGenError('Importe inválido'); return }
    const evento = (config?.evento || '').replace('ev-', '')
    if (!evento) { setCouponGenError('No hay evento activo'); return }
    setCouponGenLoading(true); setCouponGenError(''); setCouponGenResult(null)
    try {
      const res = await fetch('/coupon/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evento, amount: Math.round(euros * 100), expires_hours: parseInt(couponGenHours) || 72, type: couponGenType }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Error al generar')
      setCouponGenResult(json)
      loadCouponList()
    } catch (e) { setCouponGenError(e.message) }
    finally { setCouponGenLoading(false) }
  }
  const loadCouponList = async () => {
    const evento = (config?.evento || '').replace('ev-', '')
    if (!evento) return
    setCouponListLoading(true)
    try {
      const res = await fetch(`/coupon/list?evento=${encodeURIComponent(evento)}`)
      const json = await res.json()
      if (json.ok) setCouponList(json.coupons || [])
    } catch (e) { /* silenciar */ }
    finally { setCouponListLoading(false) }
  }

  // ── RENDER ──
  // Comprobando sesión (primer render)
  if (session === undefined) {
    return (
      <div className="viewer-app d-flex flex-column align-items-center justify-content-center bg-dark text-light" style={{ height: '100vh' }}>
        <span className="spinner-border text-warning" style={{ width: '3rem', height: '3rem' }} />
      </div>
    )
  }

  // Sin sesión → pantalla de login del hotel
  if (session === null) {
    return (
      <div className="viewer-app d-flex flex-column align-items-center justify-content-center bg-dark text-light" style={{ height: '100vh', padding: '1rem' }}>
        <div className="card bg-black border-secondary" style={{ maxWidth: 380, width: '100%' }}>
          <form className="card-body p-4 p-md-5 text-center" onSubmit={handleLogin}>
            <img src={hotelLogoUrl()} alt="Printbox Hotels" style={{ width: 72, height: 72, objectFit: 'contain', marginBottom: '1rem' }} />
            <h4 className="text-light mb-1">Acceso del hotel</h4>
            <p className="text-secondary mb-4" style={{ fontSize: 13 }}>Introduce las credenciales que te ha dado Printbox</p>
            <div className="mb-2 text-start">
              <label className="form-label text-light" style={{ fontSize: 13 }}>Usuario</label>
              <input className="form-control bg-dark border-secondary text-light" value={loginUser} onChange={e => { setLoginUser(e.target.value); setLoginError('') }} autoFocus autoComplete="username" />
            </div>
            <div className="mb-3 text-start">
              <label className="form-label text-light" style={{ fontSize: 13 }}>Contraseña</label>
              <input type="password" className="form-control bg-dark border-secondary text-light" value={loginPass} onChange={e => { setLoginPass(e.target.value); setLoginError('') }} autoComplete="current-password" />
            </div>
            {loginError && <div className="alert alert-danger py-2 mb-3" style={{ fontSize: 13 }}>{loginError}</div>}
            <button type="submit" className="btn btn-warning text-dark fw-bold w-100" disabled={loginLoading}>
              {loginLoading ? <><span className="spinner-border spinner-border-sm me-2" />Entrando…</> : <><i className="bi bi-box-arrow-in-right me-2" />Entrar</>}
            </button>
          </form>
        </div>
      </div>
    )
  }

  const currentRoomCode = (config?.evento || '').replace(/^ev-/, '')
  const currentRoom = habitaciones.find(h => h.codigo === currentRoomCode)
  const currentRoomLabel = currentRoom?.nombre || (currentRoomCode ? `Hab. ${currentRoomCode}` : 'Habitación')

  return (
    <div className="viewer-app d-flex flex-column bg-dark text-light" style={{ height: "100vh", overflow: "hidden" }}>
      {/* Asistente de primera configuración: nombre del hotel → logo → habitaciones */}
      {showSetupWizard && (
        <div className="modal d-block event-modal-overlay" tabIndex="-1">
          <div className="modal-dialog modal-dialog-centered modal-lg">
            <div className="modal-content bg-dark border border-secondary event-modal">
              <div className="modal-header border-secondary">
                <h5 className="modal-title text-light"><i className="bi bi-stars me-2 text-warning" />Configura tu hotel</h5>
                <span className="ms-auto text-secondary font-mono" style={{ fontSize: '13px' }}>Paso {wizardStep} de 3</span>
              </div>
              <div className="modal-body p-4">
                {wizardStep === 1 && (
                  <>
                    <h6 className="text-warning mb-1"><i className="bi bi-building me-2" />Nombre del hotel</h6>
                    <p className="text-secondary" style={{ fontSize: '13px' }}>Aparecerá en la pantalla del monitor y en los avisos a recepción.</p>
                    <input className="form-control form-control-lg bg-black border-secondary text-light" placeholder="Hotel Ejemplo" value={wizardName} onChange={e => setWizardName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && wizardName.trim()) { setWizardError(''); setWizardStep(2) } }} autoFocus />
                  </>
                )}
                {wizardStep === 2 && (
                  <>
                    <h6 className="text-warning mb-1"><i className="bi bi-image me-2" />Logo del hotel</h6>
                    <p className="text-secondary" style={{ fontSize: '13px' }}>Se mostrará en la cabecera del monitor, en la app del huésped y como sello en cada foto. Puedes omitirlo y subirlo más tarde desde Admin.</p>
                    <div className="d-flex align-items-center gap-3">
                      <img src={wizardLogoData || logoSrc} alt="Logo" style={{ width: 90, height: 90, objectFit: 'contain', background: '#000', borderRadius: 12, border: '1px solid var(--bs-secondary)' }} />
                      <div className="flex-grow-1">
                        <input type="file" accept="image/*" className="form-control bg-black border-secondary text-light" onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; try { setWizardLogoData(await readLogoFile(f)); setWizardError('') } catch (err) { setWizardError(err.message) } }} />
                        <div className="form-text text-secondary">PNG o JPG — se ajusta solo a 512px.</div>
                      </div>
                    </div>
                  </>
                )}
                {wizardStep === 3 && (
                  <>
                    <h6 className="text-warning mb-1"><i className="bi bi-door-open me-2" />Habitaciones del hotel</h6>
                    <p className="text-secondary" style={{ fontSize: '13px' }}>Añade cada habitación con el código que te hemos proporcionado. Al salir del campo se comprueba que existe. Podrás añadir o quitar habitaciones más adelante desde Admin.</p>
                    <div style={{ maxHeight: '38vh', overflowY: 'auto' }}>
                      {wizardRooms.map((r, i) => (
                        <div key={i} className="d-flex gap-2 mb-2 align-items-center">
                          <input className="form-control bg-black border-secondary text-light" placeholder={`Habitación ${i + 1}`} value={r.nombre} onChange={e => wizardRoomsEditor.set(i, 'nombre', e.target.value)} style={{ maxWidth: '42%' }} />
                          <div className="input-group">
                            <input className="form-control bg-black border-secondary text-light font-mono" inputMode="numeric" placeholder="000000" value={r.codigo} onChange={e => wizardRoomsEditor.set(i, 'codigo', e.target.value)} onBlur={() => checkRoomCode(r.codigo)} />
                            <span className="input-group-text bg-black border-secondary"><RoomCodeStatus status={roomCodeStatus[r.codigo]} /></span>
                          </div>
                          <button className="btn btn-sm btn-outline-danger" onClick={() => wizardRoomsEditor.remove(i)} disabled={wizardRooms.length === 1} title="Quitar"><i className="bi bi-trash" /></button>
                        </div>
                      ))}
                    </div>
                    <button className="btn btn-sm btn-outline-warning mt-1" onClick={wizardRoomsEditor.add}><i className="bi bi-plus-circle me-1" />Añadir habitación</button>
                  </>
                )}
                {wizardError && <div className="alert alert-danger py-2 mt-3 mb-0">{wizardError}</div>}
              </div>
              <div className="modal-footer border-secondary">
                {wizardStep > 1 && <button className="btn btn-secondary me-auto" onClick={() => { setWizardError(''); setWizardStep(s => s - 1) }} disabled={wizardSaving}><i className="bi bi-arrow-left me-1" />Atrás</button>}
                {wizardStep === 1 && <button className="btn btn-warning text-dark fw-bold" onClick={() => { if (!wizardName.trim()) { setWizardError('Escribe el nombre del hotel'); return } setWizardError(''); setWizardStep(2) }}>Siguiente<i className="bi bi-arrow-right ms-1" /></button>}
                {wizardStep === 2 && <button className="btn btn-warning text-dark fw-bold" onClick={() => { setWizardError(''); setWizardStep(3) }}>{wizardLogoData ? 'Siguiente' : 'Omitir por ahora'}<i className="bi bi-arrow-right ms-1" /></button>}
                {wizardStep === 3 && <button className="btn btn-warning text-dark fw-bold" onClick={handleWizardFinish} disabled={wizardSaving}>{wizardSaving ? <><span className="spinner-border spinner-border-sm me-2" />Guardando…</> : <>Terminar<i className="bi bi-check-circle ms-1" /></>}</button>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Selector de habitación a monitorizar (entre las registradas del hotel) */}
      {showEventModal && !showSetupWizard && (
        <div className="modal d-block event-modal-overlay" tabIndex="-1">
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content bg-dark border border-secondary event-modal">
              <div className="modal-body text-center p-4 p-md-5">
                <img src={logoSrc} alt="Logo" className="event-modal-logo" />
                <h4 className="event-modal-title">Elige la habitación</h4>
                <p className="event-modal-subtitle">El monitor mostrará las fotos de esa habitación</p>
                <div style={{ maxHeight: '42vh', overflowY: 'auto' }}>
                  {habitaciones.map(h => (
                    <button key={h.codigo} className={`btn w-100 mb-2 d-flex justify-content-between align-items-center ${config?.evento === `ev-${h.codigo}` ? 'btn-warning text-dark fw-bold' : 'btn-outline-light'}`} onClick={() => handleSelectRoom(h.codigo)}>
                      <span><i className="bi bi-door-open me-2" />{h.nombre || 'Habitación'}</span>
                      <span className="font-mono" style={{ fontSize: '12px' }}>{h.codigo}</span>
                    </button>
                  ))}
                </div>
                {eventError && <div className="text-danger mt-2" style={{ fontSize: '13px' }}>{eventError}</div>}
                <p className="text-secondary mt-2 mb-0" style={{ fontSize: '12px' }}>¿Falta alguna habitación? Añádela desde <b>Admin</b>.</p>
                {config?.evento && <button className="btn btn-secondary btn-sm mt-3" onClick={() => setShowEventModal(false)}>Cancelar</button>}
              </div>
            </div>
          </div>
        </div>
      )}

      {showAdminConfig && (
        <div className="modal d-block event-modal-overlay" tabIndex="-1">
          <div className="modal-dialog modal-dialog-centered modal-lg">
            <div className="modal-content bg-dark border border-secondary event-modal">
              <div className="modal-header border-secondary"><h5 className="modal-title text-light">Configuración del Hotel</h5><button type="button" className="btn-close btn-close-white" onClick={() => setShowAdminConfig(false)} /></div>
              <div className="modal-body p-4" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                <div className="row g-3">
                  <div className="col-md-7">
                    <label className="form-label text-light">Nombre del hotel</label>
                    <input className="form-control bg-black border-secondary text-light" placeholder="Hotel Ejemplo" value={adminHotelName} onChange={e => setAdminHotelName(e.target.value)} />
                  </div>
                  <div className="col-md-5">
                    <label className="form-label text-light">Logo del hotel</label>
                    <div className="d-flex align-items-center gap-2">
                      <img src={adminLogoData || logoSrc} alt="Logo" style={{ width: 46, height: 46, objectFit: 'contain', background: '#000', borderRadius: 8, border: '1px solid var(--bs-secondary)' }} />
                      <input type="file" accept="image/*" className="form-control bg-black border-secondary text-light" onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; try { setAdminLogoData(await readLogoFile(f)); setAdminError('') } catch (err) { setAdminError(err.message) } }} />
                    </div>
                  </div>

                  <div className="col-12">
                    <label className="form-label text-light mb-1">Habitaciones del hotel</label>
                    <div className="form-text text-secondary mt-0 mb-2">Cada habitación con su código proporcionado por Printbox (se comprueba que existe al salir del campo). <i className="bi bi-qr-code" /> muestra el QR para imprimirlo y ponerlo en la habitación; <i className="bi bi-display" /> la elige como la que muestra este monitor.</div>
                    <div style={{ maxHeight: '30vh', overflowY: 'auto' }}>
                      {adminRooms.map((r, i) => (
                        <div key={i} className="d-flex gap-2 mb-2 align-items-center">
                          <input className="form-control form-control-sm bg-black border-secondary text-light" placeholder={`Habitación ${i + 1}`} value={r.nombre} onChange={e => adminRoomsEditor.set(i, 'nombre', e.target.value)} style={{ maxWidth: '34%' }} />
                          <div className="input-group input-group-sm" style={{ maxWidth: '38%' }}>
                            <input className="form-control bg-black border-secondary text-light font-mono" inputMode="numeric" placeholder="000000" value={r.codigo} onChange={e => adminRoomsEditor.set(i, 'codigo', e.target.value)} onBlur={() => checkRoomCode(r.codigo)} />
                            <span className="input-group-text bg-black border-secondary"><RoomCodeStatus status={roomCodeStatus[r.codigo]} /></span>
                          </div>
                          <button className="btn btn-sm btn-outline-light" title="Ver QR de esta habitación" onClick={() => setQrRoom({ nombre: r.nombre, codigo: r.codigo })} disabled={!r.codigo}><i className="bi bi-qr-code" /></button>
                          <button className={`btn btn-sm ${adminEventCode === r.codigo && r.codigo ? 'btn-warning text-dark' : 'btn-outline-secondary'}`} title="Mostrar esta habitación en el monitor" onClick={() => r.codigo && setAdminEventCode(r.codigo)} disabled={!r.codigo}><i className="bi bi-display" /></button>
                          <button className="btn btn-sm btn-outline-danger" title="Quitar" onClick={() => adminRoomsEditor.remove(i)} disabled={adminRooms.length === 1}><i className="bi bi-trash" /></button>
                        </div>
                      ))}
                    </div>
                    <button className="btn btn-sm btn-outline-warning" onClick={adminRoomsEditor.add}><i className="bi bi-plus-circle me-1" />Añadir habitación</button>
                  </div>

                  <div className="col-12">
                    <div className="bg-black border border-secondary rounded-3 p-3">
                      <div className="d-flex align-items-center justify-content-between mb-2">
                        <span className="text-light fw-bold"><i className={`bi ${advancedUnlocked ? 'bi-unlock-fill text-warning' : 'bi-lock-fill'} me-2`} />Ajustes de Printbox</span>
                        {advancedUnlocked
                          ? <span className="badge bg-warning text-dark">Desbloqueado</span>
                          : <button className="btn btn-sm btn-outline-warning" onClick={() => { setUnlockInput(''); setUnlockError(''); setShowUnlockModal(true) }}><i className="bi bi-key me-1" />Desbloquear</button>}
                      </div>
                      <div className="row g-3">
                        <div className="col-md-6">
                          <label className="form-label text-light">Evento de impresión (Impresora)</label>
                          <input type="text" inputMode="numeric" className="form-control bg-black border-secondary text-light font-mono" value={adminPrinterEventCode} disabled={!advancedUnlocked} onChange={e => setAdminPrinterEventCode(e.target.value.replace(/\D/g, ''))} />
                        </div>
                        <div className="col-md-6">
                          <label className="form-label text-light">Precio por foto (€)</label>
                          <input type="number" step="0.01" min="0" className="form-control bg-black border-secondary text-light" value={adminPrecioFoto} disabled={!advancedUnlocked} onChange={e => setAdminPrecioFoto(e.target.value)} />
                          <div className="form-text text-secondary">Se cobra por cada copia: 2 copias = el doble, 3 copias = el triple.</div>
                        </div>
                      </div>
                      {!advancedUnlocked && <div className="form-text text-secondary mt-2">Estos ajustes los cambia Printbox. Pulsa <b>Desbloquear</b> e introduce la contraseña.</div>}
                    </div>
                  </div>
                  <div className="col-md-12"><label className="form-label text-light">Email de Recepción</label><input type="email" placeholder="recepcion@tuhotel.com" className="form-control bg-black border-secondary text-light" value={adminEmailRecepcion} onChange={e => setAdminEmailRecepcion(e.target.value)} /><div className="form-text text-secondary">Vale para todo el hotel: a esta dirección se enviará un aviso con miniaturas y copias cada vez que cualquier habitación envíe fotos. Los precios también son únicos para todas las habitaciones.</div></div>
                  <div className="col-md-12">
                    <div className="bg-black border border-secondary rounded-3 p-3">
                      <div className="form-check form-switch">
                        <input className="form-check-input" type="checkbox" role="switch" id="servicioDisponibleSwitch" checked={adminServicioDisponible} onChange={e => {
                          // Reactivar es inocuo; cortar el servicio afecta a todo el hotel y pide confirmación escrita.
                          if (e.target.checked) { setAdminServicioDisponible(true); return }
                          setServiceConfirmInput('')
                          setShowServiceConfirm(true)
                        }} />
                        <label className="form-check-label text-light fw-bold" htmlFor="servicioDisponibleSwitch">Servicio disponible para los huéspedes</label>
                      </div>
                      <div className="form-text text-secondary">Afecta a <strong>todo el hotel</strong>. Si se desactiva, cualquier huésped que escanee un QR verá el aviso de "servicio no disponible" en 4 idiomas en lugar de poder pedir fotos.</div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="modal-footer border-secondary">
                <button type="button" className="btn btn-outline-success me-auto" onClick={() => { setShowAdminConfig(false); setShowCouponPanel(true); loadCouponList() }}><i className="bi bi-ticket-perforated me-1" />Cupones</button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowAdminConfig(false)} disabled={adminSaving}>Cancelar</button>
                <button type="button" className="btn btn-warning text-dark" onClick={handleSaveAdminConfig} disabled={adminSaving}>{adminSaving ? <><span className="spinner-border spinner-border-sm me-2" />Guardando…</> : 'Guardar'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showCouponPanel && (
        <div className="modal d-block" style={{ backgroundColor: 'rgba(0,0,0,0.85)' }} tabIndex="-1" onClick={() => setShowCouponPanel(false)}>
          <div className="modal-dialog modal-dialog-centered modal-lg" onClick={e => e.stopPropagation()}>
            <div className="modal-content bg-dark border border-secondary">
              <div className="modal-header border-secondary"><h5 className="modal-title text-warning"><i className="bi bi-ticket-perforated me-2" />Cupones de Pago en Efectivo</h5><button type="button" className="btn-close btn-close-white" onClick={() => setShowCouponPanel(false)} /></div>
              <div className="modal-body p-4">
                {/* Guía para recepción: quien usa esto no tiene por qué saber cómo funciona. */}
                <div className="coupon-help mb-4">
                  <div className="coupon-help-title"><i className="bi bi-info-circle me-2" />¿Para qué sirven los cupones?</div>
                  <p className="coupon-help-text">
                    Un cupón es un <b>código</b> que le das al huésped para que pague menos (o nada) en la app.
                    Sirve para cobrar <b>en efectivo en recepción</b>, para invitaciones o para compensar una incidencia.
                  </p>
                  <div className="coupon-help-types">
                    <div className="coupon-help-type">
                      <span className="coupon-help-badge">Pago completo</span>
                      <span>El huésped <b>no paga nada</b> en la app. Úsalo cuando ya te ha pagado en efectivo en recepción.</span>
                    </div>
                    <div className="coupon-help-type">
                      <span className="coupon-help-badge">Descuento</span>
                      <span>Le <b>resta</b> ese importe del total. Si el pedido son 3,60&nbsp;€ y el cupón es de 1,00&nbsp;€, pagará 2,60&nbsp;€ con tarjeta.</span>
                    </div>
                  </div>
                  <p className="coupon-help-text mb-0"><b>Cómo se usa:</b> pon el importe, genera el código y dáselo al huésped (o pulsa <i className="bi bi-clipboard" /> para copiarlo). Él lo escribe en la casilla <i>Cupón</i> de su móvil y pulsa <b>Aplicar</b>.</p>
                  <p className="coupon-help-warn mb-0"><i className="bi bi-exclamation-triangle-fill me-1" />Cada código vale <b>una sola vez</b>, caduca a las horas que indiques, y solo funciona en la <b>habitación que muestra ahora el monitor</b>. Si cambias de habitación, genera otro.</p>
                </div>

                <h6 className="text-light mb-3">Generar nuevo cupón</h6>
                <div className="row g-2 mb-3">
                  <div className="col-md-4"><label className="form-label text-secondary" style={{ fontSize: '12px' }}>Importe (€)</label><input type="number" step="0.01" min="0.01" className="form-control bg-black border-secondary text-light" value={couponGenAmount} onChange={e => setCouponGenAmount(e.target.value)} /></div>
                  <div className="col-md-3"><label className="form-label text-secondary" style={{ fontSize: '12px' }}>Caduca en (horas)</label><input type="number" min="1" className="form-control bg-black border-secondary text-light" value={couponGenHours} onChange={e => setCouponGenHours(e.target.value)} /></div>
                  <div className="col-md-3"><label className="form-label text-secondary" style={{ fontSize: '12px' }}>Tipo de cupón</label><select className="form-select bg-black border-secondary text-light" value={couponGenType} onChange={e => setCouponGenType(e.target.value)}><option value="full">Pago completo (sin cambio)</option><option value="discount">Descuento (resta del total)</option></select></div>
                  <div className="col-md-2 d-flex align-items-end"><button className="btn btn-warning w-100" onClick={handleGenerateCoupon} disabled={couponGenLoading}>{couponGenLoading ? <span className="spinner-border spinner-border-sm" /> : 'Generar'}</button></div>
                </div>
                {couponGenError && <div className="alert alert-danger py-2">{couponGenError}</div>}
                {couponGenResult && (
                  <div className="alert alert-success py-2 d-flex align-items-center gap-3">
                    <div><div style={{ fontSize: '12px' }}>Código generado ({couponGenResult.amount_eur})</div><div style={{ fontFamily: 'monospace', fontSize: '22px', fontWeight: 'bold', letterSpacing: '4px' }}>{couponGenResult.code}</div><div style={{ fontSize: '11px' }}>Caduca: {new Date(couponGenResult.expires_at).toLocaleString('es-ES')}</div></div>
                    <button className="btn btn-sm btn-outline-success ms-auto" onClick={() => navigator.clipboard?.writeText(couponGenResult.code)}><i className="bi bi-clipboard" /> Copiar</button>
                  </div>
                )}
                <div className="d-flex justify-content-between align-items-center mt-4 mb-2"><h6 className="text-light mb-0">Cupones del evento</h6><button className="btn btn-sm btn-outline-secondary" onClick={loadCouponList} disabled={couponListLoading}>{couponListLoading ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-arrow-clockwise" />}</button></div>
                <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
                  {couponList.length === 0 && !couponListLoading && <div className="text-secondary text-center py-3">No hay cupones.</div>}
                  {couponList.map(c => (
                    <div key={c.code} className="d-flex align-items-center gap-2 py-2 border-bottom border-secondary">
                      <span style={{ fontFamily: 'monospace', fontSize: '14px', letterSpacing: '2px', color: c.status === 'active' && !c.expired ? 'var(--pb-accent)' : '#6c757d' }}>{c.code}</span>
                      <span className={`badge ${c.status === 'used' ? 'bg-secondary' : c.expired ? 'bg-danger' : 'bg-success'}`} style={{ fontSize: '10px' }}>{c.status === 'used' ? 'Usado' : c.expired ? 'Caducado' : 'Activo'}</span>
                      <span className="ms-auto text-light fw-bold">{c.amount_eur}</span>
                      {c.used_at && <span className="text-secondary" style={{ fontSize: '11px' }}>{new Date(c.used_at).toLocaleString('es-ES')}</span>}
                    </div>
                  ))}
                </div>
              </div>
              <div className="modal-footer border-secondary"><button type="button" className="btn btn-secondary" onClick={() => setShowCouponPanel(false)}>Cerrar</button></div>
            </div>
          </div>
        </div>
      )}

      {showPrivacyModal && (
        <div className="modal d-block" style={{ backgroundColor: 'rgba(0,0,0,0.8)' }} tabIndex="-1">
          <div className="modal-dialog modal-dialog-centered modal-lg">
            <div className="modal-content bg-dark border border-secondary">
              <div className="modal-header border-secondary"><h5 className="modal-title text-light">Términos y Condiciones</h5><button type="button" className="btn-close btn-close-white" onClick={() => setShowPrivacyModal(false)} /></div>
              <div className="modal-body p-4" style={{ maxHeight: '60vh', overflowY: 'auto' }}><div dangerouslySetInnerHTML={{ __html: privacyContent }} /></div>
              <div className="modal-footer border-secondary"><button type="button" className="btn btn-secondary" onClick={() => setShowPrivacyModal(false)}>Cerrar</button></div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE IMPRESIÓN (con soporte de cupón) */}
      {selectedPhoto && (
        <div className="modal d-block print-modal-overlay" tabIndex="-1" onClick={() => !printing && setSelectedPhoto(null)}>
          <div className="modal-dialog modal-dialog-centered modal-xl modal-fullscreen-sm-down" onClick={e => e.stopPropagation()}>
            <div className="modal-content bg-dark border border-secondary print-modal">
              <div className="print-modal-header">
                {printDone ? (
                  <span className="text-success fw-bold font-mono"><i className="bi bi-check-circle-fill me-2" />¡Impresión enviada!</span>
                ) : (
                  <span className="text-light fw-bold font-mono"><i className="bi bi-printer me-2 text-warning" />Total {copies} {copies === 1 ? 'foto' : 'fotos'} {getPrecio(copies) ? `${finalPrice}€` : ''}</span>
                )}
                <button className="btn-close btn-close-white print-modal-close" onClick={() => setSelectedPhoto(null)} />
              </div>
              <div className="print-modal-body">
                <div className="row g-0">
                  <div className="col-md-7 print-image-container">
                    <img src={fixImageUrl(selectedPhoto.uri || selectedPhoto.uri_full)} alt="Foto" className="print-image" draggable={false} onContextMenu={e=>e.preventDefault()} onDragStart={e=>e.preventDefault()} />
                  </div>
                  <div className="col-md-5 print-panel">
                    <div>
                      <p className="copies-title"><i className="bi bi-stack me-1" />Número de copias</p>
                      <div className="copies-buttons">
                        {[1,2,3].map(n => (
                          <button key={n} className={`btn fw-bold copy-btn ${copies === n ? 'copy-btn-active' : 'copy-btn-inactive'}`} onClick={() => setCopies(n)}>
                            <span>{copies === n ? <i className="bi bi-check-circle-fill copy-icon" /> : <i className="bi bi-circle copy-icon" />}{n} {n === 1 ? 'copia' : 'copias'}</span>
                            {textos?.[`precio${n}`] && <span className={`badge copy-price-badge ${copies === n ? 'copy-price-badge-active' : 'copy-price-badge-inactive'}`}>{textos[`precio${n}`]}€</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="print-actions">
                      {printDone ? (
                        <>
                          <div className="alert alert-success print-success-alert"><i className="bi bi-check-circle-fill me-1" />{copies} {copies === 1 ? 'copia enviada' : 'copias enviadas'} a imprimir</div>
                          <button className="btn btn-outline-secondary cancel-button" onClick={() => setSelectedPhoto(null)}><i className="bi bi-arrow-left me-1" /> Volver a la galería</button>
                        </>
                      ) : showPayment ? (
                        <>
                          <div className="mb-3">
                            <p className="text-light mb-2">Método de pago:</p>
                            <div className="d-flex gap-2 flex-wrap">
                              <button className={`btn ${paymentMethod === 'paypal' ? 'btn-warning text-dark' : 'btn-outline-light'}`} onClick={() => setPaymentMethod('paypal')}><i className="bi bi-paypal me-1" /> PayPal</button>
                              <button className={`btn ${paymentMethod === 'square' ? 'btn-warning text-dark' : 'btn-outline-light'}`} onClick={() => setPaymentMethod('square')}><i className="bi bi-credit-card me-1" /> Tarjeta</button>
                            </div>
                            {/* Cupón */}
                            <div className="mt-3">
                              <div className="d-flex gap-2 align-items-center">
                                <input type="text" className={`form-control bg-black border-secondary text-light text-uppercase ${couponError ? 'is-invalid' : ''}`} placeholder="Código de cupón" value={couponCode} onChange={e => setCouponCode(e.target.value)} style={{ fontFamily: 'monospace' }} />
                                <button className="btn btn-outline-success" onClick={handleApplyCoupon} disabled={couponLoading}>{couponLoading ? <span className="spinner-border spinner-border-sm" /> : 'Aplicar'}</button>
                              </div>
                              {couponError && <div className="text-danger mt-1 small">{couponError}</div>}
                              {appliedCoupon && <div className="text-success mt-1 small"><i className="bi bi-check-circle-fill me-1" />{appliedCoupon.type === 'discount' ? `Descuento: ${appliedCoupon.amount_eur}` : `Pago completo cubierto (${appliedCoupon.amount_eur})`}</div>}
                            </div>
                            {paymentMethod === 'square' && <div id="card-container" className="mt-3 p-2 border border-secondary rounded bg-dark"></div>}
                            {squareError && <div className="alert alert-danger mt-2 mb-0">{squareError}</div>}
                          </div>
                          <button className="btn btn-success text-dark fw-bold print-button" onClick={handlePayment} disabled={printing || !paymentMethod || (appliedCoupon?.type==='full' && finalCents>0)}>
                            {printing ? <><span className="spinner-border spinner-border-sm me-2" /> Procesando…</> : <><i className="bi bi-check-circle-fill me-2" /> Pagar {finalPrice}€</>}
                          </button>
                          <button className="btn btn-outline-secondary cancel-button" onClick={() => setShowPayment(false)}><i className="bi bi-arrow-left me-1" /> Volver</button>
                        </>
                      ) : (
                        <>
                          <button className="btn btn-warning text-dark fw-bold print-button" onClick={() => setShowPayment(true)}><i className="bi bi-credit-card me-2" /> Pagar</button>
                          <button className="btn btn-outline-secondary cancel-button" onClick={() => setSelectedPhoto(null)}><i className="bi bi-x me-1" /> Cancelar</button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Desbloqueo de los ajustes de Printbox (evento de impresión y precio) */}
      {showUnlockModal && (
        <div className="modal d-block event-modal-overlay" style={{ zIndex: 1090 }} tabIndex="-1">
          <div className="modal-dialog modal-dialog-centered modal-sm">
            <div className="modal-content bg-dark border border-secondary event-modal">
              <div className="modal-body p-4 text-center">
                <i className="bi bi-key-fill text-warning" style={{ fontSize: 32 }} />
                <h5 className="text-light mt-2 mb-1">Ajustes de Printbox</h5>
                <p className="text-secondary mb-3" style={{ fontSize: 13 }}>Introduce la contraseña para cambiar el evento de impresión y el precio.</p>
                <input type="password" autoFocus className={`form-control bg-black border-secondary text-light ${unlockError ? 'is-invalid' : ''}`} value={unlockInput}
                  onChange={e => { setUnlockInput(e.target.value); setUnlockError('') }}
                  onKeyDown={e => { if (e.key === 'Enter') handleUnlockAdvanced(); if (e.key === 'Escape') setShowUnlockModal(false) }} />
                {unlockError && <div className="text-danger mt-2" style={{ fontSize: 13 }}>{unlockError}</div>}
              </div>
              <div className="modal-footer border-secondary justify-content-between">
                <button className="btn btn-secondary" onClick={() => setShowUnlockModal(false)}>Cancelar</button>
                <button className="btn btn-warning text-dark fw-bold" onClick={handleUnlockAdvanced}>Desbloquear</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirmación escrita para cortar el servicio a todos los huéspedes */}
      {showServiceConfirm && (
        <div className="modal d-block event-modal-overlay" style={{ zIndex: 1090 }} tabIndex="-1">
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content bg-dark border border-danger event-modal">
              <div className="modal-body p-4 text-center">
                <i className="bi bi-exclamation-triangle-fill text-danger" style={{ fontSize: 40 }} />
                <h5 className="text-light mt-2 mb-2">¿Desactivar el servicio?</h5>
                <div className="alert alert-danger py-2" style={{ fontSize: 14 }}>
                  <strong>EL SERVICIO SE DETENDRÁ PARA TODOS LOS HUÉSPEDES.</strong>
                </div>
                <p className="text-secondary mb-3" style={{ fontSize: 13 }}>
                  Cualquier huésped que escanee un QR verá el aviso de "servicio no disponible" y no podrá pedir fotos.
                  Escribe <b className="text-light">Confirmo</b> para continuar.
                </p>
                <input autoFocus className="form-control bg-black border-secondary text-light text-center" placeholder="Confirmo" value={serviceConfirmInput}
                  onChange={e => setServiceConfirmInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') setShowServiceConfirm(false) }} />
              </div>
              <div className="modal-footer border-secondary justify-content-between">
                <button className="btn btn-secondary" onClick={() => setShowServiceConfirm(false)}>Cancelar</button>
                <button className="btn btn-danger fw-bold" disabled={serviceConfirmInput.trim().toLowerCase() !== 'confirmo'}
                  onClick={() => { setAdminServicioDisponible(false); setShowServiceConfirm(false) }}>
                  <i className="bi bi-power me-1" />Desactivar servicio
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Header y galería */}
      <header className="viewer-header">
        <div className="viewer-header-top">
          <div className="viewer-header-status">
            {uuid && (
              <>
                <span className="status-dot" />
                <span className="status-text">EN ESCUCHA · {allPhotos.length} FOTOS</span>
              </>
            )}
          </div>
          <div className="viewer-header-brand-center">
            <img src={logoSrc} alt="Logo del hotel" className="header-logo-center" />
            {textos?.empresa && <div className="header-hotel-name">{textos.empresa}</div>}
            {uuid && <div className="header-hotel-subtitle">MONITOR · {currentRoomLabel}</div>}
          </div>
          <div className="viewer-header-right">
            {/* Cambiar habitación / Admin / Salir van SIEMPRE (aunque find-event falle y uuid
                sea null), o el recepcionista se quedaría atascado. El resto se oculta sin uuid. */}
            <div className="viewer-header-actions">
              {uuid && config?.servicio_disponible === false && (
                <span className="badge service-disabled-badge"><i className="bi bi-exclamation-triangle-fill me-1" />Servicio desactivado para los huéspedes</span>
              )}
              <button className="btn btn-sm header-action-btn" onClick={() => setShowEventModal(true)} title="Cambiar la habitación que muestra el monitor"><i className="bi bi-door-open me-1" />{uuid ? currentRoomLabel : 'Elegir habitación'}</button>
              {uuid && <button className={`btn btn-sm header-action-btn ${autoplay ? 'header-action-btn-active' : ''}`} onClick={() => setAutoplay(!autoplay)} title={autoplay ? 'Detener autoplay' : 'Iniciar autoplay (15s por página)'}><i className={`bi ${autoplay ? 'bi-pause-circle-fill' : 'bi-play-circle-fill'} me-1`} />{autoplay ? 'Autoplay ON' : 'Autoplay'}</button>}
              {uuid && <button className="btn btn-sm header-action-btn" onClick={() => setQrRoom(currentRoom || { nombre: '', codigo: currentRoomCode })} title="Mostrar QR de la habitación actual"><i className="bi bi-qr-code me-1" />Ver QR</button>}
              <button className="btn btn-sm header-action-btn" onClick={() => setShowPrivacyModal(true)}><i className="bi bi-info-circle me-1" /> Términos</button>
              <button className="btn btn-sm header-action-btn" onClick={openAdmin}><i className="bi bi-gear me-1" /> Admin</button>
              <button className="btn btn-sm header-action-btn" onClick={handleLogout} title={`Sesión: ${session?.nombre || session?.hotelId || ''}`}><i className="bi bi-box-arrow-right me-1" /> Salir</button>
              {uuid && <button className="btn btn-sm header-action-btn" onClick={() => loadAllPhotos(currentPage)} disabled={loading}><i className={`bi ${loading ? 'bi-hourglass-split spin' : 'bi-arrow-repeat'} me-1`} />{loading ? 'Cargando...' : 'Actualizar'}</button>}
            </div>
          </div>
        </div>
        {error && <div className="alert alert-danger viewer-error-alert">{error}</div>}
      </header>
      {qrRoom && (
        <div className="modal d-block event-modal-overlay" style={{ zIndex: 1080 }} tabIndex="-1" onClick={() => setQrRoom(null)}>
          <div className="modal-dialog modal-dialog-centered" onClick={e => e.stopPropagation()}>
            <div className="modal-content bg-dark border border-secondary event-modal">
              <div className="modal-body text-center p-5">
                <h5 className="event-modal-title mb-1">{qrRoom.nombre || 'Habitación'}</h5>
                <p className="text-secondary font-mono mb-4" style={{ fontSize: '12px' }}>{qrRoom.codigo}</p>
                <div style={{ display: 'flex', justifyContent: 'center', backgroundColor: 'white', padding: '15px', borderRadius: '8px' }}>
                  <QRCodeSVG value={`${mobileOrigin()}/mobile?hotel=${encodeURIComponent(session?.hotelId || '')}&habitacion=${qrRoom.codigo}`} size={300} level="H" includeMargin={true} />
                </div>
                <p className="text-warning mt-3 mb-0"><small>Imprime este código y colócalo en la habitación — al escanearlo, el huésped sube sus fotos</small></p>
                <button className="btn btn-secondary mt-3" onClick={() => setQrRoom(null)}><i className="bi bi-x me-1" /> Cerrar</button>
              </div>
            </div>
          </div>
        </div>
      )}
      <main className="viewer-gallery">
        {!uuid ? (
          <div className="viewer-gallery-empty"><img src={logoSrc} alt="Logo" className="empty-logo" /><h2 className="empty-title">{textos?.empresa || 'Printbox Hotels'}</h2><p className="empty-text">Elige la habitación para ver las fotos</p></div>
        ) : loading ? (
          <div className="viewer-gallery-empty"><img src={logoSrc} alt="Logo" className="empty-logo" /><h2 className="empty-title">{textos?.empresa || 'Printbox Hotels'}</h2><p className="empty-text">Cargando fotos…</p></div>
        ) : allPhotos.length === 0 ? (
          <div className="viewer-gallery-empty"><img src={logoSrc} alt="Logo" className="empty-logo" /><h2 className="empty-title">{textos?.empresa || 'Printbox Hotels'}</h2><p className="empty-text">Esperando fotos…</p></div>
        ) : (
          <>
            <div className="viewer-gallery-header">
              <h3 className="gallery-title">Fotos de {currentRoomLabel}</h3>
              <span className="gallery-hint">CLIC EN UNA FOTO PARA IMPRIMIR</span>
            </div>
            <div className="viewer-gallery-grid">
              {allPhotos.map(photo => <PhotoCard key={photo.id || photo.uri} photo={photo} onSelect={handleSelectPhoto} logoSrc={logoSrc} />)}
            </div>
          </>
        )}
      </main>
      {lastPage > 1 && (
        <nav className="viewer-pagination">
          <ul className="pagination pagination-sm mb-0">
            <li className={`page-item ${currentPage === 1 ? 'disabled' : ''}`}><button className="page-link pagination-btn" onClick={() => setCurrentPage(p => p - 1)}><i className="bi bi-chevron-left" /></button></li>
            {Array.from({ length: lastPage }, (_, i) => i + 1).map(page => <li key={page} className={`page-item ${page === currentPage ? 'active pagination-active' : ''}`}><button className="page-link pagination-btn" onClick={() => setCurrentPage(page)}>{page}</button></li>)}
            <li className={`page-item ${currentPage === lastPage ? 'disabled' : ''}`}><button className="page-link pagination-btn" onClick={() => setCurrentPage(p => p + 1)}><i className="bi bi-chevron-right" /></button></li>
          </ul>
        </nav>
      )}
      <footer className="viewer-footer">
        <div className="viewer-footer-content">
          {textos?.precio1 && <span className="price-badge">PRECIO POR FOTO <span className="badge">{textos.precio1}€</span></span>}
          {textos?.empresa && <span className="company-name">{textos.empresa}</span>}
          <span className="print-count">IMPRESAS HOY <span className="print-count-number">{printCount}</span></span>
        </div>
      </footer>
    </div>
  )
}

function PhotoCard({ photo, onSelect, logoSrc = '/assets/hotel-logo.png' }) {
  const thumb = fixImageUrl(photo.uri || photo.uri_full)
  const [imageError, setImageError] = React.useState(false)
  const [retryCount, setRetryCount] = React.useState(0)
  const maxRetries = 3
  const handleImageError = () => {
    if (retryCount < maxRetries) {
      setTimeout(() => { setRetryCount(retryCount + 1); setImageError(false) }, (retryCount + 1) * 1000)
    } else setImageError(true)
  }
  return (
    <button className="viewer-photo-card btn p-0 w-100 border-2 rounded-3 overflow-hidden position-relative" onClick={() => onSelect(photo)} style={{ aspectRatio: '3/4' }}>
      {imageError ? <div style={{width:'100%',height:'100%',display:'flex',alignItems:'center',justifyContent:'center',backgroundColor:'#f0f0f0',color:'#999',fontSize:'12px'}}>Error cargando</div> :
        <img key={`${thumb}-${retryCount}`} src={thumb} alt="" className="w-100 h-100" style={{ objectFit: 'cover' }} loading="lazy" draggable={false} onContextMenu={e=>e.preventDefault()} onDragStart={e=>e.preventDefault()} onError={handleImageError} />
      }
      <div className="viewer-photo-hint"><i className="bi bi-printer me-1" /> Imprimir</div>
      <img src={logoSrc} alt="" className="viewer-photo-badge" draggable={false} />
    </button>
  )
}