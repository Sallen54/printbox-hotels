import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom'
import ViewerApp from './viewer/ViewerApp'
import PrinterApp from './printer/PrinterApp'
import MobileApp from './mobile/MobileApp'
import './styles/global.css'
import { clearStorageOnNewBuild } from './shared/storage'

// Antes de montar nada: si el visitante viene de una versión anterior, su estado guardado
// se descarta. Va aquí (una sola llamada) y no en cada app, porque main.jsx importa las
// tres y la primera en ejecutarse marcaría la versión como ya vista.
clearStorageOnNewBuild(['printbox_mobile_state', 'printbox_viewer_state'])

function RedirectByDevice() {
  const navigate = useNavigate()

  useEffect(() => {
    const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent)

    // Configurar variables globales para api.js
    window.isMobile = isMobile
    window.isViewer = !isMobile

    if (isMobile) {
      navigate('/mobile', { replace: true })
    } else {
      navigate('/viewer', { replace: true })
    }
  }, [])

  return null
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        {/* ruta raíz */}
        <Route path="/" element={<RedirectByDevice />} />

        <Route path="/viewer"  element={<ViewerApp />} />
        <Route path="/printer" element={<PrinterApp />} />
        <Route path="/mobile"  element={<MobileApp />} />

        {/* fallback */}
        <Route path="*" element={<RedirectByDevice />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
)