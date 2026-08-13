import React, { useState, useEffect, useCallback, useRef } from 'react'
import { findEvent, getPhotosToPrint, getConfig, saveConfig, getPrinters, getPrintCount, getMe } from '../shared/api'
import { useInterval } from '../shared/hooks/useInterval'
import './Printer.css'

const APP_VERSION = '1.0.6'

// Misma contraseña que el Admin del Monitor: cambiar el evento de impresión es un ajuste
// de Printbox. Sin esto, el Printer era una puerta trasera para saltarse ese candado.
const ADVANCED_PASSWORD = 'HostyPrint2026@'

// Ojo: aquí el backend está fijado a un dominio, no se resuelve como en shared/api.js.
// El Printer corre en el PC de recepción y habla siempre con este despliegue.
const BACKEND = "https://printbox.incomar.net"

// ── COMPONENTE PRINCIPAL - PANEL DE IMPRESIÓN ──
export default function PrinterApp() {
  // --- Estados de configuración ---
  const [config, setConfig] = useState({
    servidor: 'https://gestion.printboxweb.com',
    evento: '',
    timer: 5,
    delay: 5,
    impresora: ''
  })
  const [textos, setTextos] = useState({
    text_es: '',
    text_en: '',
    text_fr: '',
    text_de: '',
    precio1: '',
    precio2: '',
    precio3: '',
    empresa: ''
  })
  const [printers, setPrinters] = useState([])      // Lista de impresoras disponibles
  const [noSession, setNoSession] = useState(false) // No hay sesión de hotel iniciada en el Monitor
  const [editing, setEditing] = useState(false)     // Modo edición de configuración
  const [showEventModal, setShowEventModal] = useState(false)  // Modal para cambiar evento
  const [eventInput, setEventInput] = useState('')   // Input del código de evento
  const [eventError, setEventError] = useState('')   // Error en el código de evento
  const [eventPass, setEventPass] = useState('')     // Contraseña de Printbox para cambiar el evento
  const eventInputRef = useRef(null)                 // Referencia para auto-focus

  // --- Estados de ejecución ---
  const [running, setRunning] = useState(false)      // Indica si el programa está ejecutándose
  const [uuid, setUuid] = useState(null)             // UUID del evento activo
  const [printedImages, setPrintedImages] = useState([])  // Historial de imágenes impresas
  const [lastPhoto, setLastPhoto] = useState(null)   // Última foto impresa
  const [printCount, setPrintCount] = useState(0)    // Contador total de impresiones
  const [logs, setLogs] = useState([])               // Log de eventos
  const [elapsed, setElapsed] = useState(0)          // Tiempo transcurrido en ejecución

  // --- Estados de monitoreo ---
  const [printerStatus, setPrinterStatus] = useState('ok')   // Estado de la impresora: 'ok' | 'offline'
  const [apiStatus, setApiStatus] = useState('ok')           // Estado de la API: 'ok' | 'error'
  const [reconnecting, setReconnecting] = useState(false)    // Indica si se está reconectando
  const reconnectAttemptsRef = useRef(0)                     // Contador de intentos de reconexión
  const logsRef = useRef(null)                               // Referencia para auto-scroll del log

  // ── FUNCIONES DE MONITOREO ──

  async function checkPrinterStatus(printerName) {
    try {
      const list = await getPrinters()
      setPrinters(list)
      if (!printerName) {
        setPrinterStatus('ok')
        return
      }
      const found = list.some(p => p === printerName || p.includes(printerName))
      setPrinterStatus(found ? 'ok' : 'offline')
    } catch {
      setPrinterStatus('offline')
    }
  }

  // ── EFECTOS DE INICIALIZACIÓN ──

  useEffect(() => {
    // El Printer comparte la cookie de sesión del Monitor (mismo navegador de recepción).
    // Sin sesión no hay hotel del que leer config → avisar de que hay que entrar en el Monitor.
    getMe().then(me => {
      setNoSession(!me)
      if (!me) return
      getConfig().then(d => {
        if (d.config) {
          setConfig(d.config)
          checkPrinterStatus(d.config.impresora)
        }
        if (d.textos) setTextos(d.textos)
      }).catch(() => {})
      getPrintCount().then(setPrintCount).catch(() => {})
    }).catch(() => setNoSession(true))
  }, [])

  useInterval(() => checkPrinterStatus(config.impresora), 30000)

  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight
    }
  }, [logs])

  useEffect(() => {
    if (showEventModal) {
      setTimeout(() => eventInputRef.current?.focus(), 50)
    }
  }, [showEventModal])

  // ── FUNCIONES DE LOG ──

  /**
   * Agregar un mensaje al log
   * @param {string} msg - Mensaje a mostrar
   * @param {string} type - Tipo de mensaje: 'info', 'success', 'warn', 'error'
   */
  function addLog(msg, type = 'info') {
    const time = new Date().toTimeString().slice(0, 8)
    setLogs(prev => [...prev.slice(-200), { time, msg, type, id: Date.now() + Math.random() }])
  }

  useInterval(() => setElapsed(e => e + 1), running ? 1000 : null)

  function formatElapsed(s) {
    return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
      .map(n => String(n).padStart(2, '0'))
      .join(':')
  }

  // ── MANEJO DEL EVENTO ──

  function handleStartClick() {
    setEventInput((config.evento_printer || config.evento)?.replace('ev-', '') || '')
    setEventError('')
    setEventPass('')
    setShowEventModal(true)
  }

  async function handleEventConfirm() {
    const code = eventInput.trim()
    if (!code) {
      setEventError('Introduce el número del evento')
      return
    }
    if (eventPass !== ADVANCED_PASSWORD) {
      setEventError('Contraseña de Printbox incorrecta')
      return
    }
    const fullCode = `ev-${code}`
    setEventError('')
    setEventPass('')
    setShowEventModal(false)

    const newConfig = { ...config, evento_printer: fullCode }
    setConfig(newConfig)
    await saveConfig(newConfig, textos)
    addLog(`✓ Evento de impresora configurado: ${fullCode}`, 'success')
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') handleEventConfirm()
    if (e.key === 'Escape') setShowEventModal(false)
  }

  // ── CONTROL DE EJECUCIÓN ──

  async function handleStart() {
    const eventToUse = config.evento_printer || config.evento
    if (!eventToUse) {
      handleStartClick()
      return
    }
    addLog(`Conectando con evento ${eventToUse}...`)
    try {
      const eventUuid = await findEvent(eventToUse)
      setUuid(eventUuid)
      setRunning(true)
      setElapsed(0)
      setPrintedImages([])
      addLog(`✓ Conectado. UUID: ${eventUuid}`, 'success')
      addLog(`Buscando fotos cada ${config.timer}s con ${config.delay}s de delay...`)
    } catch (e) {
      addLog(`✗ Error al conectar: ${e.message}`, 'error')
    }
  }

  function handleStop() {
    setRunning(false)
    setUuid(null)
    addLog('— Programa detenido.', 'warn')
  }

  // ── RECONEXIÓN AUTOMÁTICA ──

  async function tryReconnect() {
    const eventToUse = config.evento_printer || config.evento
    if (reconnecting || !eventToUse) return

    setReconnecting(true)
    reconnectAttemptsRef.current += 1
    const attempt = reconnectAttemptsRef.current
    addLog(`↻ Intentando reconectar... (intento ${attempt})`, 'warn')

    try {
      const newUuid = await findEvent(eventToUse)
      setUuid(newUuid)
      setApiStatus('ok')
      setReconnecting(false)
      reconnectAttemptsRef.current = 0
      addLog(`✓ Reconectado al evento ${eventToUse}`, 'success')
    } catch {
      setReconnecting(false)
      const delay = Math.min(30, attempt * 5)
      addLog(`✗ Reconexión fallida. Próximo intento en ${delay}s...`, 'error')
      setTimeout(tryReconnect, delay * 1000)
    }
  }

  // ── VERIFICACIÓN E IMPRESIÓN DE FOTOS ──

  const checkAndPrint = useCallback(async () => {
    if (!uuid) return

    try {
      const photos = await getPhotosToPrint(uuid)
      setApiStatus('ok')
      reconnectAttemptsRef.current = 0

      if (!photos?.length) {
        addLog(`... Sin fotos pendientes (${photos?.length || 0} fotos)`)
        return
      }

      addLog(`→ ${photos.length} foto(s) con ${photos.reduce((s,p)=>s+(p.times||1),0)} copia(s) pendiente(s)`)

      // Agrupar fotos por nombre base y quedarse solo con la de mayor prefijo
      // Manejar tanto gallery_ como print_N_ formatos
      const photoMap = new Map()
      for (const photo of photos) {
        const baseUrl = photo.uri_full
        const parts = baseUrl.split('/')
        const baseName = parts.pop()
        const eventPath = parts.join('/') + '/'

        // Extraer el prefijo y el nombre
        // Formato 1: gallery_name.jpeg
        let photoName = baseName
        let copies = photo.times || 1

        const printMatch = baseName.match(/^print_(\d+)_(.+)$/)
        if (printMatch) {
          // Es un archivo print_N_, quedarse con el mayor N
          const copyNum = parseInt(printMatch[1])
          photoName = printMatch[2]
          const key = `${eventPath}|${photoName}`
          if (!photoMap.has(key) || copyNum > photoMap.get(key).copyNum) {
            photoMap.set(key, {
              eventPath,
              photoName,
              copyNum,
              copies: copyNum
            })
          }
          continue
        }

        // Es un archivo gallery_, usar times como número de copias
        const galleryMatch = baseName.match(/^gallery_(.+)$/)
        if (galleryMatch) {
          photoName = galleryMatch[1]
          const key = `${eventPath}|${photoName}`
          if (!photoMap.has(key) || copies > photoMap.get(key).copies) {
            photoMap.set(key, {
              eventPath,
              photoName,
              copies
            })
          }
        }
      }

      // Procesar cada foto agrupada
      for (const [key, photo] of photoMap) {
        // Construir URL del archivo print con el número de copias
        // print_2_ si times=2, print_1_ si times=1, etc.
        const imageName = `print_${photo.copies}_${photo.photoName}`
        const printUrl = `${photo.eventPath}${imageName}`

        if (printedImages.includes(imageName)) {
          addLog(`⏭ Saltar: ${imageName} (ya impreso)`)
          continue
        }

        addLog(`↓ Enviando ${imageName} (${photo.copies} copia(s))...`)

        try {
          const response = await fetch(`${BACKEND}/print/job`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              imageUrl: printUrl,
              imageName,
              printer: config.impresora,
              delay: config.delay
            }),
          })

          if (!response.ok) {
            const text = await response.text()
            throw new Error(`HTTP ${response.status}: ${text}`)
          }

          const result = await response.json()

          if (result.error) throw new Error(result.error)

          setPrintedImages(prev => [...prev, imageName])
          setLastPhoto(printUrl)
          setPrintCount(result.count || 0)
          addLog(`✓ Impreso: ${imageName} (total: ${result.count || 0})`, 'success')
        } catch (err) {
          addLog(`✗ Error: ${err.message}`, 'error')
        }
      }
      addLog('... Esperando más imágenes.')
    } catch (e) {
      setApiStatus('error')
      addLog(`✗ Error API: ${e.message} — iniciando reconexión...`, 'error')
      setUuid(null)
      tryReconnect()
    }
  }, [uuid, printedImages, config.impresora, config.delay, config.evento, config.evento_printer])

  useInterval(checkAndPrint, running ? config.timer * 1000 : null)

  // ── GUARDAR CONFIGURACIÓN ──

  async function handleSave() {
    await saveConfig(config, textos)
    setEditing(false)
    addLog('✓ Configuración guardada.', 'success')
  }

  // ── RENDER ──

  const logTypeClass = {
    info: 'log-info',
    success: 'log-success',
    warn: 'log-warn',
    error: 'log-error'
  }

  if (noSession) {
    return (
      <div className="printer-app d-flex flex-column vh-100 bg-dark text-light align-items-center justify-content-center text-center p-4">
        <i className="bi bi-box-arrow-in-right text-warning" style={{ fontSize: 48 }} />
        <h4 className="mt-3">Inicia sesión en el Monitor</h4>
        <p className="text-secondary" style={{ maxWidth: 420 }}>
          Esta impresora usa la sesión del hotel abierta en el Monitor (<span className="font-mono">/viewer</span>) de este mismo equipo.
          Abre el Monitor, entra con las credenciales del hotel y vuelve a cargar esta página.
        </p>
        <button className="btn btn-warning text-dark fw-bold mt-2" onClick={() => window.location.reload()}>
          <i className="bi bi-arrow-repeat me-2" />Reintentar
        </button>
      </div>
    )
  }

  return (
    <div className="printer-app d-flex flex-column vh-100 bg-dark text-light">
      {/* ========== ALERTA IMPRESORA OFFLINE ========== */}
      {printerStatus === 'offline' && config.impresora && (
        <div className="alert alert-danger printer-offline-alert" role="alert">
          <i className="bi bi-printer-fill fs-5" />
          <strong>Impresora no encontrada:</strong>
          <span className="font-mono">"{config.impresora}"</span>
          <span className="ms-1">— Verifica que está encendida y conectada.</span>
          <button
            className="btn btn-sm btn-outline-light ms-auto font-mono retry-btn"
            onClick={() => checkPrinterStatus(config.impresora)}
          >
            <i className="bi bi-arrow-clockwise me-1" />
            Reintentar
          </button>
        </div>
      )}

      {/* ========== ALERTA RECONEXIÓN API ========== */}
      {apiStatus === 'error' && (
        <div className="alert alert-warning reconnect-alert" role="alert">
          <div className="spinner-border spinner-border-sm text-warning" role="status" />
          <strong>Sin conexión con la API.</strong>
          <span>Intentando reconectar automáticamente...</span>
        </div>
      )}

      {/* ========== MODAL EVENTO ========== */}
      {showEventModal && (
        <div
          className="modal d-block"
          tabIndex="-1"
          style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)' }}
        >
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content bg-dark border border-secondary event-modal">
              <div className="modal-body text-center event-modal-body">
                <img src="/assets/hotel-logo.png" alt="Logo" className="event-modal-logo" />
                <h5 className="event-modal-title">¿Cuál es la habitación?</h5>
                <p className="event-modal-subtitle">Introduce el número de habitación a conectar</p>

                <div className="input-group mb-2 event-modal-input-group">
                  <span className="input-group-text bg-black border-secondary text-warning fw-bold font-mono">
                    ev-
                  </span>
                  <input
                    ref={eventInputRef}
                    type="text"
                    className={`form-control bg-black border-secondary text-light font-mono event-modal-input ${
                      eventError ? 'is-invalid' : ''
                    }`}
                    value={eventInput}
                    onChange={e => setEventInput(e.target.value.replace(/\D/g, ''))}
                    onKeyDown={handleKeyDown}
                  />
                </div>

                <input
                  type="password"
                  className="form-control bg-black border-secondary text-light event-modal-input"
                  placeholder="Contraseña de Printbox"
                  value={eventPass}
                  onChange={e => { setEventPass(e.target.value); setEventError('') }}
                  onKeyDown={handleKeyDown}
                />
                {eventError && <div className="text-danger mt-2" style={{ fontSize: 13 }}>{eventError}</div>}
              </div>
              <div className="modal-footer border-secondary justify-content-between">
                <button className="btn btn-outline-secondary" onClick={() => setShowEventModal(false)}>
                  <i className="bi bi-x-lg me-1" /> Cancelar
                </button>
                <button className="btn btn-warning text-dark fw-bold" onClick={handleEventConfirm}>
                  <i className="bi bi-check-lg me-1" /> Guardar habitación
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========== HEADER ========== */}
      <nav className="navbar printer-nav">
        <div className="d-flex align-items-center gap-3">
          <img src="/assets/hotel-logo.png" alt="Logo" className="printer-logo" />
          <div>
            <div className="printer-title">Printbox Hotels</div>
            <div className="printer-version text-secondary d-flex align-items-center gap-2">
              Panel de Control
              <span className="badge border border-secondary text-secondary fw-normal">
                v{APP_VERSION}
              </span>
            </div>
          </div>
        </div>

        <div className="d-flex align-items-center gap-3 ms-auto">
          {(config.evento_printer || config.evento) && (
            <span className="badge border border-warning text-warning printer-event-badge">
              <i className="bi bi-calendar-event" />
              {config.evento_printer || config.evento}
              <button
                className="btn btn-link p-0 text-warning printer-event-edit"
                onClick={handleStartClick}
                disabled={running}
                title="Cambiar habitación"
              >
                <i className="bi bi-pencil" />
              </button>
            </span>
          )}
          <span className="printer-contact">
            <i className="bi bi-envelope me-1" />
            eventos@printboxweb.com · 623 040 445
          </span>
        </div>
      </nav>

      {/* ========== BODY PRINCIPAL ========== */}
      <div className="flex-grow-1 overflow-auto p-3">
        <div className="row g-3">
          {/* ========== CONFIGURACIÓN ========== */}
          <div className="col-12">
            <div className="card config-card">
              <div className="card-body">
                <div className="config-header">
                  <span className="config-badge">Configuración</span>
                  <span className="badge bg-secondary config-api-badge">
                    API · {config.servidor}
                  </span>
                </div>

                <div className="row g-3">
                  <div className="col-md-3">
                    <label className="form-label config-label">Delay (seg)</label>
                    <div className="config-helper-text">Espera antes de imprimir</div>
                    <input
                      type="number"
                      min="1"
                      className="form-control config-input"
                      value={config.delay}
                      disabled={!editing || running}
                      onChange={e => setConfig(p => ({ ...p, delay: parseInt(e.target.value) || 5 }))}
                    />
                  </div>

                  <div className="col-md-3">
                    <label className="form-label config-label">Timer (seg)</label>
                    <div className="config-helper-text">Frecuencia de consulta</div>
                    <input
                      type="number"
                      min="5"
                      className="form-control config-input"
                      value={config.timer}
                      disabled={!editing || running}
                      onChange={e => setConfig(p => ({ ...p, timer: parseInt(e.target.value) || 5 }))}
                    />
                  </div>

                  <div className="col-md-6">
                    <label className="form-label config-label">Impresora</label>
                    <div className="config-helper-text">&nbsp;</div>
                    <select
                      className="form-select config-input"
                      value={config.impresora}
                      disabled={!editing || running}
                      onChange={e => setConfig(p => ({ ...p, impresora: e.target.value }))}
                    >
                      <option value="">— Predeterminada del sistema —</option>
                      {printers.map(p => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Sección de textos (solo en modo edición) */}
                {editing && (
                  <div className="mt-4">
                    <p className="textos-section-title">Textos del Visor</p>
                    <div className="config-helper-text mb-2">El precio por foto se cambia desde Admin en el Monitor (pide la contraseña de Printbox).</div>
                    <div className="row g-2">
                      {[
                        ['text_es', 'Español'],
                        ['text_en', 'English'],
                        ['text_fr', 'Français'],
                        ['text_de', 'Deutsch'],
                        ['empresa', 'Empresa']
                      ].map(([key, label]) => (
                        <div className="col-md-3" key={key}>
                          <label className="form-label textos-input-label">{label}</label>
                          <input
                            className="form-control form-control-sm textos-input"
                            value={textos[key] || ''}
                            onChange={e => setTextos(p => ({ ...p, [key]: e.target.value }))}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Botones de edición */}
                <div className="config-edit-buttons">
                  {!editing ? (
                    <button
                      className="btn btn-outline-secondary btn-sm"
                      onClick={() => setEditing(true)}
                      disabled={running}
                    >
                      <i className="bi bi-pencil me-1" />
                      Editar
                    </button>
                  ) : (
                    <>
                      <button className="btn btn-outline-secondary btn-sm" onClick={() => setEditing(false)}>
                        <i className="bi bi-x me-1" />
                        Cancelar
                      </button>
                      <button className="btn btn-warning btn-sm text-dark fw-bold" onClick={handleSave}>
                        <i className="bi bi-floppy me-1" />
                        Guardar
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* ========== CONTROLES ========== */}
          <div className="col-12">
            <div className="card controls-card">
              <div className="card-body controls-container">
                <button
                  className="btn btn-success btn-lg start-btn"
                  onClick={handleStart}
                  disabled={running}
                >
                  <i className="bi bi-play-fill me-2" />
                  Encender
                </button>

                <div className="printer-state">
                  <div className={`printer-state-dot mx-auto mb-2 ${running ? 'on' : 'off'}`} />
                  <small className="printer-state-text">
                    {running ? 'EN EJECUCIÓN' : 'DETENIDO'}
                  </small>
                </div>

                <button
                  className="btn btn-danger btn-lg stop-btn"
                  onClick={handleStop}
                  disabled={!running}
                >
                  <i className="bi bi-stop-fill me-2" />
                  Apagar
                </button>
              </div>
            </div>
          </div>

          {/* ========== STATS: FOTOS IMPRESAS ========== */}
          <div className="col-md-3">
            <div className="card stats-card">
              <div className="card-body d-flex flex-column align-items-center justify-content-center">
                <div className="stats-number">{printCount}</div>
                <div className="stats-label">Fotos impresas</div>
              </div>
            </div>
          </div>

          {/* ========== STATS: TIEMPO EN EJECUCIÓN ========== */}
          <div className="col-md-3">
            <div className="card stats-card">
              <div className="card-body d-flex flex-column align-items-center justify-content-center">
                <div className="stats-number-large">{formatElapsed(elapsed)}</div>
                <div className="stats-label">Tiempo en ejecución</div>
              </div>
            </div>
          </div>

          {/* ========== ÚLTIMA FOTO IMPRESA ========== */}
          <div className="col-md-6">
            <div className="card last-photo-card">
              <div className="card-body d-flex flex-column align-items-center">
                <div className="last-photo-title">
                  <i className="bi bi-image me-1" />
                  Última foto impresa
                </div>
                {lastPhoto ? (
                  <img
                    src={lastPhoto}
                    alt="Última foto"
                    className="last-photo-img"
                  />
                ) : (
                  <div className="last-photo-placeholder">—</div>
                )}
              </div>
            </div>
          </div>

          {/* ========== LOG ========== */}
          <div className="col-12">
            <div className="card log-card">
              <div className="card-body">
                <p className="log-title">
                  <i className="bi bi-terminal me-2" />
                  Log
                </p>
                <div ref={logsRef} className="log-container">
                  {logs.length === 0 ? (
                    <span className="log-empty">El log aparecerá aquí al encender el programa.</span>
                  ) : (
                    logs.map(entry => (
                      <div key={entry.id} className={`log-entry ${logTypeClass[entry.type] || 'log-info'}`}>
                        <span className="log-time">{entry.time}</span>
                        <span>{entry.msg}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}