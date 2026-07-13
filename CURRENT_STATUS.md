# Estado verificado (13 julio 2026)

---

## Resumen

Proyecto creado hoy a partir de `printbox-adventures` (carpeta hermana), como base para un producto separado orientado a hoteles/hostales/campings. Es un proyecto nuevo, **aún no desplegado en ningún dominio real** — todo lo verificado hasta ahora es local.

## Cambios frente a printbox-adventures

- **Sin Electron**: eliminado por completo de `package.json` (dependencias, scripts, bloque `build`). No hay carpeta `electron/`, no hay workflow de instalador.
- **Terminología**: "evento" → "habitación" de cara al usuario en `MobileApp.jsx`, `ViewerApp.jsx` y `PrinterApp.jsx`. El QR ahora usa `?habitacion=` en vez de `?evento=`. Internamente sigue siendo un "evento" de Laravel (sin renombrar variables técnicas).
- **Diseño del Monitor (`/viewer`) rediseñado a tema claro/crema** siguiendo la maqueta del hotel de referencia: cabecera de 3 columnas (idioma ES/EN, logo del hotel centrado, idioma FR/DE), botones de acción en pastilla, galería sobre fondo oliva oscuro con badge circular del logo en cada foto, paginación y footer a juego. La app Móvil y el Printer mantienen el tema oscuro con acento dorado (paleta en `src/styles/global.css`); el Monitor tiene su propia paleta clara en `src/viewer/Viewer.css`.
- **Logo del hotel**: un único archivo `src/public/assets/hotel-logo.png` (placeholder de momento) reutilizado en cabecera móvil, cabecera del Monitor y badge de las fotos.
- **Nueva feature — aviso a recepción por e-mail**: al enviar fotos (pago o gratis desde cámara) se llama a `POST /printbox/notify-order` una vez por pedido completo. En dev solo loguea por consola; en `proxy.php` (prod) construye y envía un e-mail HTML con miniaturas inline vía `mail()` nativo de PHP, sin SMTP/PHPMailer.
- **Config nueva**: campo `email_recepcion` añadido en `backend/routes/config.js`, `proxy.php` (GET/POST + validKeys) y en el panel Admin de `ViewerApp.jsx`, con el mismo mecanismo por-habitación que los precios.
- **Limpieza**: eliminados ~30 assets de Adventures sin usar (mascotas, banners, iconos de flujo OTP/cámara antiguo), la carpeta `assets/` duplicada en la raíz, `test.html`/`test.php` (scratch de diagnóstico IONOS), y todo lo relacionado con la verificación de dominio de Apple Pay (`.well-known/`, rutas en `proxy.php`/`.htaccess`/`copy-dist-assets.js`) — no implementado y específico del dominio de Adventures.

## Dos bugs reales encontrados y corregidos durante la verificación (heredados de Adventures, no introducidos en este trabajo)

1. **La cámara era inalcanzable**: `MobileApp.jsx` tenía toda la lógica de `STEP_CAMERA` (capturar, subir gratis) pero **ningún botón llamaba a `setStep(STEP_CAMERA)`** — ni en Adventures ni aquí. Se añadió un botón de cámara en la cabecera de la galería (`src/mobile/MobileApp.jsx`, junto al botón de Términos) para poder llegar a ese paso.
2. **`eventCode` se vaciaba solo bajo `React.StrictMode` en desarrollo**: el `useEffect` que procesa `?habitacion=` llamaba a `loadFromLocalStorage()` de forma incondicional al final, incluso cuando ya se había fijado el código por QR. Bajo el doble-invocado de efectos de StrictMode (solo en dev), la segunda pasada releía un `localStorage` todavía no actualizado y sobreescribía el código de habitación correcto con uno vacío — el e-mail a recepción llegaba con `room: ""`. Corregido moviendo esa llamada dentro del `else` (solo cuando NO hay `?habitacion=` en la URL). No afecta al build de producción (StrictMode no duplica efectos fuera de dev), pero sí habría confundido cualquier prueba local futura.

## Verificado (Playwright, Chromium headless, con red mockeada)

- `php -l proxy.php` y `node --check` sobre todo el backend ✅
- `npm install` + `npm run build` + `npm run dev` ✅ (sin Electron, puerto correcto, sin colisionar con el directorio de datos de Adventures)
- **Flujo completo con pago**: `/mobile?habitacion=1204` → seleccionar foto de galería → pedido con 2 copias → pago (SDK de Square mockeado) → `photo-send` recibe la foto → `notify-order` recibe `{room: "1204", items: [...], total, paymentMethod: "Tarjeta (Square)"}` correctamente ✅
- **Flujo completo gratis con cámara**: botón "Hacer foto" → capturar (cámara simulada con un canvas) → "Subir fotos directamente" → `photo-send` + `notify-order` con `paymentMethod: "Gratis (foto de cámara)"` ✅
- `/mobile`, `/viewer` y `/printer` renderizan sin errores de consola, con la marca y colores correctos (Mobile/Printer oscuro-dorado, Viewer claro-crema con el logo del hotel en 3 sitios)

## Pendiente de verificar

- Guardar/leer `email_recepcion` desde el panel Admin del Monitor contra un evento real (ya probado por API directamente, falta probar desde la UI del Admin)
- Flujo completo de pago (Square/PayPal) contra un evento real de `gestion.printboxweb.com` (lo verificado usó un SDK de Square simulado)
- Primer despliegue real en IONOS y comprobación de que `mail()` entrega el e-mail (no se puede probar en local)
