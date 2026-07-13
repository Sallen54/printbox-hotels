# Estado verificado (13 julio 2026)

---

## Resumen

Proyecto creado hoy a partir de `printbox-adventures` (carpeta hermana), como base para un producto separado orientado a hoteles/hostales/campings. Es un proyecto nuevo, **aún no desplegado en ningún dominio real** — todo lo verificado hasta ahora es local.

## Cambios frente a printbox-adventures

- **Sin Electron**: eliminado por completo de `package.json` (dependencias, scripts, bloque `build`). No hay carpeta `electron/`, no hay workflow de instalador.
- **Terminología**: "evento" → "habitación" de cara al usuario en `MobileApp.jsx`, `ViewerApp.jsx` y `PrinterApp.jsx`. El QR ahora usa `?habitacion=` en vez de `?evento=`. Internamente sigue siendo un "evento" de Laravel (sin renombrar variables técnicas).
- **Colores**: paleta propia centralizada en `src/styles/global.css` (variables `--pb-bg`, `--pb-bg-alt`, `--pb-accent`, `--pb-text`), sustituyendo el ámbar `#f7c604` hardcodeado en 5 archivos.
- **Logo del hotel**: nuevo slot `src/public/assets/hotel-logo.png` (placeholder copiado de `ic_launcher.png`, pendiente de sustituir por el logo real del hotel) usado en cabecera móvil, monitor y printer.
- **Nueva feature — aviso a recepción por e-mail**: al enviar fotos (pago o gratis desde cámara) se llama a `POST /printbox/notify-order` una vez por pedido completo. En dev solo loguea por consola; en `proxy.php` (prod) construye y envía un e-mail HTML con miniaturas inline vía `mail()` nativo de PHP, sin SMTP/PHPMailer.
- **Config nueva**: campo `email_recepcion` añadido en `backend/routes/config.js`, `proxy.php` (GET/POST + validKeys) y en el panel Admin de `ViewerApp.jsx`, con el mismo mecanismo por-habitación que los precios.

## Verificado

- `php -l proxy.php` ✅ (sin errores de sintaxis)
- `node --check` sobre `backend/server.js`, `backend/routes/config.js`, `backend/routes/printbox.js`, `src/shared/api.js` ✅

## Pendiente de verificar

- `npm install` + `npm run dev` (arranque real de Vite + Express sin Electron)
- Flujo completo en el navegador: entrar por `/mobile?habitacion=<código>`, seleccionar/hacer fotos, pagar o subir gratis, y confirmar que el backend Express loguea el resumen del pedido correctamente
- Guardar/leer `email_recepcion` desde el panel Admin del Monitor (`/viewer`)
- Primer despliegue real en IONOS y comprobación de que `mail()` entrega el e-mail (no se puede probar en local)
