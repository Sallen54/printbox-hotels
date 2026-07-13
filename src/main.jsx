import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom'
import ViewerApp from './viewer/ViewerApp'
import PrinterApp from './printer/PrinterApp'
import MobileApp from './mobile/MobileApp'
import './styles/global.css'

// Componente para redirigir según dispositivo
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