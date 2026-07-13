import React, { useState, useEffect, useRef, useCallback } from 'react'
import { findEvent, sendPhoto, getConfig, processPayment, getPayPalConfig, createPayPalOrder, capturePayPalOrder, notifyRoomOrder } from '../shared/api'
import { useInterval } from '../shared/hooks/useInterval'
import './Mobile.css'

window.isMobile = true

// ============================================
// UTILIDADES
// ============================================

function resizeImageBase64(dataUrl, maxSize = 1200) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const ratio = Math.min(maxSize / img.width, maxSize / img.height, 1)
      canvas.width = img.width * ratio
      canvas.height = img.height * ratio
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.src = dataUrl
  })
}

// ============================================
// CONSTANTES DE PASOS
// ============================================
const STEP_EVENT = 'event'
const STEP_GALLERY = 'gallery'
const STEP_CAMERA = 'camera'
const STEP_ORDER = 'order'
const STEP_SUCCESS = 'success'

// ============================================
// CONSTANTES DE SQUARE
// ============================================
const SQUARE_APP_ID = 'sq0idp-OV9y595m1kR_UU3QRest7Q'
const SQUARE_LOCATION_ID = 'LHB32XGQK68GX'

// ============================================
// COMPONENTE PRINCIPAL
// ============================================

export default function MobileApp() {
  // --- Estados del flujo ---
  const [step, setStep] = useState(STEP_EVENT)
  const [eventCode, setEventCode] = useState('')
  const [eventError, setEventError] = useState('')
  const [uuid, setUuid] = useState(null)
  const [textos, setTextos] = useState({})
  const [loading, setLoading] = useState(false)
  const [loadingFromQR, setLoadingFromQR] = useState(false)
  const [showTermsModal, setShowTermsModal] = useState(false)
  const [serviceUnavailable, setServiceUnavailable] = useState(false)

  // --- Estados de habitación/impresora ---
  const uuidRef = useRef(null)
  const [printerUuid, setPrinterUuid] = useState(null)
  const lastPrinterCodeRef = useRef(null)

  // --- Estados de cámara ---
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const [cameraOn, setCameraOn] = useState(false)
  const [facingMode, setFacingMode] = useState('environment')
  const [capturedPhotos, setCapturedPhotos] = useState([])

  // --- Subida de fotos ya guardadas en el móvil (galería del dispositivo) ---
  const galleryFileInputRef = useRef(null)

  // --- Estados de envío y pago ---
  const [sending, setSending] = useState(false)
  const [toast, setToast] = useState(null)
  const [squareCard, setSquareCard] = useState(null)
  const [squareError, setSquareError] = useState('')
  const [squareLoading, setSquareLoading] = useState(false)
  const [paypalClientId, setPaypalClientId] = useState('')
  const [paypalReady, setPaypalReady] = useState(false)
  const [paypalError, setPaypalError] = useState('')
  const [paypalLoading, setPaypalLoading] = useState(false)
  const paypalButtonsRef = useRef(null)

  // --- Estados de cupón (descuento/pago completo) ---
  const [couponCode, setCouponCode] = useState('')
  const [couponError, setCouponError] = useState('')
  const [couponLoading, setCouponLoading] = useState(false)
  const [appliedCoupon, setAppliedCoupon] = useState(null) // { amount, amount_eur, type }
  const [discountAmount, setDiscountAmount] = useState(0)   // en céntimos

  // ============================================
  // FUNCIONES AUXILIARES
  // ============================================
  const normalizeEventCode = (code = '') => String(code).trim().replace(/^ev[-_]?/i, '')

  const showToast = (msg, duration = 3000) => {
    setToast(msg)
    setTimeout(() => setToast(null), duration)
  }

  const applyTextos = (incoming) => {
    if (!incoming) return
    setTextos(prev => ({
      precio1: (incoming.precio1?.trim()) || prev?.precio1 || '5',
      precio2: (incoming.precio2?.trim()) || prev?.precio2 || '9',
      precio3: (incoming.precio3?.trim()) || prev?.precio3 || '12',
      text_es: incoming.text_es || prev?.text_es || '',
      text_en: incoming.text_en || prev?.text_en || '',
      text_fr: incoming.text_fr || prev?.text_fr || '',
      text_de: incoming.text_de || prev?.text_de || '',
      empresa: incoming.empresa || prev?.empresa || ''
    }))
  }

  // ============================================
  // LOCALSTORAGE
  // ============================================
  const saveToLocalStorage = () => {
    const data = { eventCode, step, capturedPhotos, uuid, textos }
    localStorage.setItem('printbox_mobile_state', JSON.stringify(data))
  }

  const loadFromLocalStorage = () => {
    const data = localStorage.getItem('printbox_mobile_state')
    if (data) {
      try {
        const parsed = JSON.parse(data)
        setEventCode(parsed.eventCode || '')
        setStep(parsed.step || STEP_EVENT)
        setCapturedPhotos(parsed.capturedPhotos || [])
        setUuid(parsed.uuid || null)
        if (parsed.textos) setTextos(parsed.textos)
        return parsed
      } catch (e) { console.error(e) }
    }
    return null
  }

  // ============================================
  // EFECTOS INICIALES
  // ============================================
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const ev = params.get('habitacion')
    if (ev) {
      const code = ev.replace('ev-', '')
      setEventCode(code)
      setLoadingFromQR(true)
      setTimeout(() => handleConnectEvent(code), 100)
    } else {
      const saved = loadFromLocalStorage()
      if (saved?.eventCode && saved.step !== STEP_EVENT) {
        if (saved.uuid) {
          setStep(saved.step)
          setUuid(saved.uuid)
          setLoadingFromQR(false)
        } else {
          setTimeout(() => handleConnectEvent(saved.eventCode), 100)
        }
      }
      if (!saved?.eventCode) {
        getConfig().then(d => { if (d.textos) applyTextos(d.textos) }).catch(() => {})
      }
    }
  }, [])

  // Comprobación del servicio a nivel de hotel (independiente de la habitación),
  // tanto al entrar como periódicamente por si recepción lo activa/desactiva mientras se usa.
  useEffect(() => {
    getConfig().then(d => {
      setServiceUnavailable(d.config?.servicio_disponible === false)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    saveToLocalStorage()
  }, [eventCode, step, capturedPhotos, uuid])

  // Refrescar precios y evento impresora cada 5s
  useEffect(() => {
    const interval = setInterval(() => {
      getConfig(eventCode || undefined).then(d => {
        if (d.textos) applyTextos(d.textos)
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
  }, [eventCode])

  const loadPrinterEvent = useCallback(async (eventCodePrinter) => {
    if (!eventCodePrinter) { setPrinterUuid(null); return }
    try {
      const printerUuidResult = await findEvent(`ev-${eventCodePrinter}`)
      setPrinterUuid(printerUuidResult)
    } catch (e) { setPrinterUuid(null) }
  }, [])

  // Inicializar Square y PayPal en paso ORDER
  useEffect(() => {
    if (step !== STEP_ORDER) return
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
  }, [step])

  useEffect(() => {
    if (step !== STEP_ORDER) return
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
            const discountCents = (appliedCoupon?.type === 'discount') ? appliedCoupon.amount : 0
            const finalCents = Math.max(0, totalCents - discountCents)
            if (appliedCoupon?.type === 'full' && finalCents > 0) {
              throw new Error('El cupón de pago completo no cubre el total')
            }
            const finalAmount = (finalCents / 100).toFixed(2)
            return await createPayPalOrder({ amount: finalAmount, currency: 'EUR' })
          },
          onApprove: async (data) => {
            setPaypalLoading(true)
            try {
              await capturePayPalOrder(data.orderID)
              if (appliedCoupon) {
                const orderId = `mobile_${Date.now()}`
                await redeemCoupon(couponCode, orderId)
              }
              await sendOrderPhotos({ paymentMethod: 'PayPal', amountPaid: finalPrice })
              setStep(STEP_SUCCESS)
            } catch (error) {
              setPaypalError(error.message)
            } finally { setPaypalLoading(false) }
          },
          onError: (error) => setPaypalError(error?.message || 'Error en PayPal'),
          onCancel: () => showToast('Pago cancelado')
        })
        if (cancelled) return
        paypalButtonsRef.current = buttons
        await buttons.render('#paypal-button-container')
        setPaypalReady(true)
      } catch (e) { setPaypalError(e.message) }
    }
    initPayPal()
    return () => { cancelled = true }
  }, [step, appliedCoupon])

  // ============================================
  // CUPONES (proxy.php)
  // ============================================
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

  // ============================================
  // CONEXIÓN EVENTO Y GALERÍA
  // ============================================
  async function handleConnectEvent(code = null) {
    const eventCodeToUse = normalizeEventCode(code || eventCode)
    if (!eventCodeToUse) { setEventError('Introduce el número de habitación'); return }
    setLoading(true)
    setEventError('')
    try {
      const id = await findEvent(`ev-${eventCodeToUse}`)
      setUuid(id)
      uuidRef.current = id
      const configData = await getConfig(eventCodeToUse)
      if (configData.textos) applyTextos(configData.textos)
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

  // ============================================
  // CÁMARA
  // ============================================
  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: false })
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
      setCameraOn(true)
    } catch { showToast('No se puede acceder a la cámara') }
  }
  function stopCamera() {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setCameraOn(false)
  }
  async function capturePhoto() {
    const video = videoRef.current, canvas = canvasRef.current
    if (!video || !canvas) return
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)
    const raw = canvas.toDataURL('image/jpeg', 0.92)
    const resized = await resizeImageBase64(raw, 1400)
    setCapturedPhotos(prev => [...prev, { dataUrl: resized, copies: 1, id: Date.now() }])
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
  function updateCapturedCopies(id, copies) {
    setCapturedPhotos(prev => prev.map(p => p.id === id ? { ...p, copies } : p))
  }
  function removeCaptured(id) {
    setCapturedPhotos(prev => prev.filter(p => p.id !== id))
  }

  // ============================================
  // SUBIR FOTOS YA GUARDADAS EN EL MÓVIL (galería del dispositivo)
  // ============================================
  async function handleGalleryFilesSelected(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // permite volver a elegir el mismo archivo más tarde
    for (const file of files) {
      const raw = await new Promise(res => {
        const reader = new FileReader()
        reader.onload = () => res(reader.result)
        reader.readAsDataURL(file)
      })
      const resized = await resizeImageBase64(raw, 1400)
      setCapturedPhotos(prev => [...prev, { dataUrl: resized, copies: 1, id: Date.now() + Math.random() }])
    }
    if (files.length) showToast(`${files.length} foto${files.length > 1 ? 's' : ''} añadida${files.length > 1 ? 's' : ''} al pedido`)
  }

  // ============================================
  // PEDIDO Y PAGO
  // ============================================
  const totalCopies = capturedPhotos.map(p => p.copies).reduce((a,b) => a+b, 0)
  const priceForPhoto = (copies) => {
    const c = Math.min(copies,3)
    const p1 = parseFloat(textos.precio1) || 5
    const p2 = parseFloat(textos.precio2) || 9
    const p3 = parseFloat(textos.precio3) || 12
    const prices = [0, p1, p2, p3]
    return prices[c] || 0
  }
  const totalPrice = () => {
    return capturedPhotos.reduce((sum, p) => sum + priceForPhoto(p.copies), 0).toFixed(2)
  }

  const totalCents = Math.round(parseFloat(totalPrice()) * 100)
  const discountCents = (appliedCoupon?.type === 'discount') ? appliedCoupon.amount : 0
  const finalCents = Math.max(0, totalCents - discountCents)
  const finalPrice = (finalCents / 100).toFixed(2)

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
          location_id: SQUARE_LOCATION_ID,
        })
      }
      if (appliedCoupon) {
        const orderId = `mobile_${Date.now()}`
        await redeemCoupon(couponCode, orderId)
      }
      await sendOrderPhotos({ paymentMethod: 'Tarjeta (Square)', amountPaid: finalPrice })
      setStep(STEP_SUCCESS)
    } catch (e) {
      setSquareError(`Error: ${e.message}`)
    } finally {
      setSquareLoading(false)
    }
  }

  async function sendOrderPhotos({ paymentMethod = 'Tarjeta', amountPaid } = {}) {
    const targetUuid = printerUuid || uuid
    if (!targetUuid) throw new Error('No hay habitación destino')
    const notifyItems = []
    for (const photo of capturedPhotos) {
      for (let i = 0; i < (photo.copies || 1); i++) {
        const uniqueName = `c${Date.now()}${Math.random().toString(36).substr(2,9)}_${i+1}`
        await sendPhoto({ event: targetUuid, image: photo.dataUrl, times: 1, name: uniqueName, phone: '000000000', orientation: 'portrait' })
      }
      notifyItems.push({ thumbnail: await resizeImageBase64(photo.dataUrl, 300), copies: photo.copies || 1 })
    }
    try {
      await notifyRoomOrder({ room: normalizeEventCode(eventCode), items: notifyItems, total: amountPaid ?? totalPrice(), paymentMethod })
    } catch (e) {
      console.error('notifyRoomOrder error:', e)
    }
    return true
  }

  // ============================================
  // RENDER POR PASO
  // ============================================
  if (serviceUnavailable) {
    return (
      <div className="mobile-app event-container">
        <img src="/assets/hotel-logo.png" alt="Logo" className="event-logo" />
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
          <img src="/assets/hotel-logo.png" alt="Logo" className="event-logo" />
          <h1 className="event-title">Printbox Hotels</h1>
          <p className="event-subtitle">Cargando habitación...</p>
          <div className="d-flex justify-content-center"><span className="spinner-border text-warning" style={{width:'3rem',height:'3rem'}} /></div>
          {toast && <div className="mobile-toast">{toast}</div>}
        </div>
      )
    }
    return (
      <div className="mobile-app event-container">
        <img src="/assets/hotel-logo.png" alt="Logo" className="event-logo" />
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
        <div className="mobile-header d-flex align-items-center gap-3 justify-content-between">
          <img src="/assets/hotel-logo.png" alt="Logo" className="mobile-header-ic-launcher-large" />
          <div className="flex-grow-1">
            <div className="mobile-header-title"><span style={{fontSize:'1.2rem',marginRight:'6px'}}>🇪🇸</span> Sube o haz tus fotos para imprimir<br /><small className="text-muted"><span style={{fontSize:'1rem',marginRight:'6px'}}>🇬🇧</span> Upload or take your photos to print</small></div>
          </div>
          <input ref={galleryFileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleGalleryFilesSelected} />
          <button className="btn btn-sm btn-outline-warning" title="Subir de tu galería" style={{fontSize:'18px',padding:'2px 6px'}} onClick={() => galleryFileInputRef.current?.click()}><i className="bi bi-images" /></button>
          <button className="btn btn-sm btn-outline-warning" title="Hacer foto" style={{fontSize:'18px',padding:'2px 6px'}} onClick={() => setStep(STEP_CAMERA)}><i className="bi bi-camera" /></button>
          <button className="btn btn-sm btn-outline-warning" title="Términos" style={{fontSize:'18px',padding:'2px 6px'}} onClick={() => setShowTermsModal(true)}><i className="bi bi-info-circle" /></button>
        </div>
        {capturedPhotos.length === 0 ? (
          <div className="gallery-empty-state">
            <i className="bi bi-camera" />
            <p>Sube una foto de tu galería o haz una foto nueva para imprimirla en recepción.</p>
          </div>
        ) : (
          <div className="gallery-grid">
            {capturedPhotos.map(photo => (
              <div key={photo.id} className="mobile-photo-card selected">
                <img src={photo.dataUrl} alt="" draggable={false} onContextMenu={e=>e.preventDefault()} onDragStart={e=>e.preventDefault()} />
              </div>
            ))}
          </div>
        )}
        {capturedPhotos.length > 0 && (
          <div className="order-float-button">
            <button className="btn btn-warning w-100 fw-bold shadow-lg" onClick={() => setStep(STEP_ORDER)}>
              <i className="bi bi-bag-check me-2" />Ver pedido ({capturedPhotos.length} foto{capturedPhotos.length > 1 ? 's' : ''})
            </button>
          </div>
        )}
        {showTermsModal && (
          <div className="terms-modal-overlay" onClick={() => setShowTermsModal(false)}>
            <div className="terms-modal-content" onClick={e=>e.stopPropagation()}>
              <div className="terms-modal-header"><h5>Términos y condiciones</h5><button className="terms-modal-close" onClick={()=>setShowTermsModal(false)}>&times;</button></div>
              <div className="terms-modal-body">
                <p><strong>Tus fotos están protegidas.</strong> No almacenamos datos personales ni compartimos tus imágenes.</p>
                <p>Los pagos se procesan de forma segura a través de <strong>Square</strong> y <strong>PayPal</strong>.</p>
                <p>Al usar este servicio, aceptas que las fotos seleccionadas se impriman en recepción.</p>
              </div>
              <div className="terms-modal-footer"><button className="btn btn-sm btn-secondary" onClick={()=>setShowTermsModal(false)}>Cerrar</button></div>
            </div>
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
                    <img src={p.dataUrl} alt="" className="captured-thumb" draggable={false} onContextMenu={e=>e.preventDefault()} onDragStart={e=>e.preventDefault()} />
                    <button className="btn btn-sm btn-danger captured-remove-btn" onClick={() => removeCaptured(p.id)}><i className="bi bi-x" /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {capturedPhotos.length > 0 && (
            <div className="d-flex gap-2 w-100" style={{flexDirection:'column'}}>
              <button className="btn btn-success fw-bold w-100 continue-button" onClick={async () => {
                setSending(true)
                try {
                  const notifyItems = []
                  for (const photo of capturedPhotos) {
                    const uniqueName = `c${Date.now()}${Math.random().toString(36).substr(2,9)}`
                    await sendPhoto({ event: uuid, image: photo.dataUrl, times: photo.copies || 1, name: uniqueName, phone: '000000000', orientation: 'portrait' })
                    notifyItems.push({ thumbnail: await resizeImageBase64(photo.dataUrl, 300), copies: photo.copies || 1 })
                  }
                  try {
                    await notifyRoomOrder({ room: normalizeEventCode(eventCode), items: notifyItems, total: '0.00', paymentMethod: 'Gratis (foto de cámara)' })
                  } catch (e) { console.error('notifyRoomOrder error:', e) }
                  showToast(`${capturedPhotos.length} foto(s) subida(s)`)
                  setCapturedPhotos([])
                } catch (e) { showToast(`Error: ${e.message}`) }
                finally { setSending(false) }
              }} disabled={sending}>
                {sending ? <><span className="spinner-border spinner-border-sm me-2" /> Subiendo...</> : <><i className="bi bi-cloud-upload me-2" /> Subir fotos directamente</>}
              </button>
              <button className="btn btn-warning fw-bold w-100 continue-button" onClick={() => setStep(STEP_ORDER)} disabled={sending}>
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
        </div>
        <div className="order-summary-container">
          {capturedPhotos.map(photo => (
            <div key={photo.id} className="order-photo-item">
              <img src={photo.dataUrl} alt="" className="order-photo-thumb" draggable={false} onContextMenu={e=>e.preventDefault()} onDragStart={e=>e.preventDefault()} />
              <div className="order-photo-info">
                <div className="order-photo-label">Tu foto</div>
                <div className="order-copies-selector">
                  <span className="order-copies-label">Copias:</span>
                  {[1,2,3].map(n => (
                    <button key={n} className={`btn btn-sm order-copies-btn ${photo.copies === n ? 'order-copies-btn-active' : 'order-copies-btn-inactive'}`} onClick={() => updateCapturedCopies(photo.id, n)}>{n}</button>
                  ))}
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

            {/* PayPal */}
            <div className="payment-method-card paypal-card">
              <div className="payment-method-header">
                <div className="payment-method-icon"><i className="bi bi-paypal"></i></div>
                <div className="payment-method-info">
                  <div className="payment-method-name">PayPal</div>
                  <div className="payment-method-desc">Paga con tu cuenta PayPal o tarjeta</div>
                </div>
              </div>
              <div className="payment-method-content">
                {paypalError && <div className="text-danger text-center mb-2">{paypalError}</div>}
                <div id="paypal-button-container" style={{ minHeight: '70px' }} />
                {!paypalReady && !paypalError && <div className="text-center text-muted mb-2">Cargando PayPal...</div>}
                {!paypalClientId && <div className="text-center text-muted mb-2">PayPal no configurado en el servidor.</div>}
              </div>
            </div>

            {/* Tarjeta de crédito */}
            <div className="payment-method-card card-payment-card">
              <div className="payment-method-header">
                <div className="payment-method-icon"><i className="bi bi-credit-card"></i></div>
                <div className="payment-method-info">
                  <div className="payment-method-name">Tarjeta de Crédito/Débito</div>
                  <div className="payment-method-desc">Visa, Mastercard, American Express</div>
                </div>
              </div>
              <div className="payment-method-content">
                <div id="card-container" style={{ minHeight: '170px' }}></div>
                {squareError && <div className="text-danger text-center mt-2">{squareError}</div>}
                <button className="btn btn-warning w-100 mt-3 fw-bold payment-btn" onClick={handleSquarePayment} disabled={squareLoading || !squareCard || totalCopies === 0}>
                  {squareLoading ? 'Procesando pago...' : `Pagar ${finalPrice}€`}
                </button>
              </div>
            </div>
          </div>
          <div className="alert alert-secondary order-payment-note">
            <i className="bi bi-credit-card text-warning" /> Pago seguro con tarjeta de crédito o PayPal
          </div>
        </div>
        {toast && <div className="mobile-toast">{toast}</div>}
      </div>
    )
  }

  if (step === STEP_SUCCESS) {
    return (
      <div className="mobile-app success-container">
        <img src="/assets/hotel-logo.png" alt="Success" className="success-image" />
        <h2 className="success-title">¡Pedido enviado!</h2>
        <p className="success-text">Tu pedido ha sido enviado. Tus fotos se imprimirán en breve.</p>
        <p className="success-small-text">¡Gracias por tu compra!</p>
        <button className="btn btn-outline-warning back-button" onClick={() => { setStep(STEP_GALLERY); setCapturedPhotos([]); setAppliedCoupon(null); setDiscountAmount(0); setCouponCode(''); }}>
          <i className="bi bi-check-circle me-2" />Finalizar
        </button>
        {textos?.empresa && <p className="company-footer"><i className="bi bi-camera me-1" />{textos.empresa}</p>}
      </div>
    )
  }
  return null
}