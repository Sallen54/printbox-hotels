# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Descripción del proyecto

Printbox Hotels es un sistema de envío/impresión de fotos por habitación para hoteles, hostales y campings. Cada habitación tiene un QR que abre la app móvil directamente sobre su galería de fotos; el huésped sube/hace fotos, paga (o las sube gratis desde la cámara), y **recepción recibe un e-mail automático** con miniaturas, copias y el resumen de lo pagado. Recepción imprime las fotos con el Printer y se las entrega.

Este proyecto es una copia personalizada de **printbox-adventures** (carpeta hermana en `Proyectos/`), creada en julio 2026. Comparte toda la arquitectura técnica y el mismo backend Laravel externo; los cambios frente a Adventures son: sin Electron (nunca lo tuvo), terminología "habitación" en vez de "evento" de cara al usuario, paleta de colores propia, hueco de logo del hotel, y el endpoint nuevo `/printbox/notify-order` para el aviso a recepción.

## Comandos

```bash
npm install    # instalación inicial
npm run dev     # vite (React, :3000) + node backend/server.js (:4000), concurrently
npm run build    # vite build -> dist/, luego scripts/copy-dist-assets.js copia .htaccess, proxy.php, .well-known, config/ dentro de dist/
npm run preview   # vite preview del dist/ ya generado
```

No hay suite de tests ni script de lint configurado — no inventes uno, y no asumas que `npm test` hace algo.

Verifica que el backend está arriba con `GET /health` → `{ "ok": true }` (`http://localhost:4000/health` en dev).

Para probar la app móvil desde un teléfono en la misma WiFi durante desarrollo: busca tu IP local (`ipconfig`), cambia `BACKEND_URL` en [src/shared/api.js](src/shared/api.js) a `http://<IP-LOCAL>:4000`, y abre `http://<IP-LOCAL>:3000/mobile` desde el móvil. La cámara del dispositivo solo funciona sobre HTTPS, así que en desarrollo local solo se puede probar el flujo de galería (no la cámara) desde un móvil.

## Sin Electron

A diferencia de Adventures (donde Electron es legacy pero el `package.json` todavía lo menciona), aquí se **eliminó por completo**: no hay `electron/`, no hay dependencias de Electron en `package.json`, no hay workflow de GitHub Actions para generar instalador. Si te piden trabajar en "el instalador" o "la app de escritorio", no existe en este repo — solo la versión web.

## Arquitectura

### Una sola app React, tres rutas, elegidas según el dispositivo

[src/main.jsx](src/main.jsx) es el único punto de entrada (BrowserRouter). Renderiza una de tres apps independientes según la ruta, y redirige automáticamente `/` según `navigator.userAgent` (UA móvil → `/mobile`, si no → `/viewer`):

| Ruta | Componente | Propósito |
| --- | --- | --- |
| `/viewer` | [src/viewer/ViewerApp.jsx](src/viewer/ViewerApp.jsx) | Monitor de recepción — galería de una habitación, impresión manual, Admin (precios/textos/email de recepción), QR |
| `/mobile` | [src/mobile/MobileApp.jsx](src/mobile/MobileApp.jsx) | El móvil del huésped — entra vía QR (`?habitacion=`), navega la galería, hace fotos con cámara, arma un pedido, paga, dispara el aviso a recepción |
| `/printer` | [src/printer/PrinterApp.jsx](src/printer/PrinterApp.jsx) | Hace polling de fotos marcadas "para imprimir", las descarga, genera un PDF y las envía a la impresora física |

Las tres llaman siempre a través de la única capa de API compartida [src/shared/api.js](src/shared/api.js) — nunca llames `fetch` directamente desde un componente.

### Dos backends en paralelo sirviendo el *mismo* contrato de frontend

Como el hosting compartido de IONOS no tiene runtime de Node, existen **dos implementaciones independientes de la misma superficie de API** que hay que mantener sincronizadas cuando cambias comportamiento:

- **[backend/server.js](backend/server.js) + [backend/routes/](backend/routes/)** — Express, usado solo en desarrollo local (puerto 4000).
- **[proxy.php](proxy.php)** — un único fichero PHP que reimplementa las mismas rutas para el despliegue en producción de IONOS, ya que Apache no puede ejecutar Express. [.htaccess](.htaccess) reescribe `/health`, `/config`, `/print/*`, `/printbox/*`, `/proxy-image/*` hacia `proxy.php`.

**Si cambias el comportamiento de una ruta en `backend/routes/*.js`, casi siempre necesitas hacer el cambio equivalente en `proxy.php`, y viceversa** — no se generan uno del otro, se mantienen en paralelo a mano. `npm run build` copia `proxy.php` y `.htaccess` tal cual dentro de `dist/`, no compila nada.

`src/shared/api.js` decide en tiempo de ejecución qué backend usar: si el hostname es `localhost` → `localhost:4000`; si no, rutas relativas (así producción golpea `proxy.php` vía las reescrituras de `.htaccess`).

### Aguas arriba: todo pasa por un proxy hacia Laravel

Ambos backends son proxies finos delante del mismo backend Laravel compartido con Adventures en `gestion.printboxweb.com` (su propio repo, no forma parte de este). Cada "habitación" es técnicamente un "evento" de Laravel — el renombrado a "habitación" es solo de cara al usuario (rótulos de UI y el nombre del query param `?habitacion=` del QR), las variables internas (`eventCode`, `findEvent`, `/printbox/find-event`, etc.) siguen llamándose "evento". Flujo clave, orquestado desde [backend/routes/printbox.js](backend/routes/printbox.js):

```
buscar habitación → POST /printbox/find-event      → Laravel /api/v1/events/find        → { uuid }
galería            → POST /printbox/photos?page=N   → Laravel /api/v1/events/photos       → { data, last_page }
subir/pagar foto    → POST /printbox/photo-send      → Laravel /api/v1/events/photo/send    → { success }
aviso a recepción   → POST /printbox/notify-order    → (no toca Laravel, solo lee config + envía e-mail)
```

Laravel usa protección CSRF de Sanctum en los POST que sí lo tocan. Tanto la ruta Express como `proxy.php` mantienen un **cookie jar** (`tough-cookie`/`fetch-cookie` en Node, un fichero de cookies en PHP) para pedir primero `/sanctum/csrf-cookie` y reenviar la cookie `XSRF-TOKEN` como cabecera `X-XSRF-TOKEN` en cada POST. Si ves errores HTTP 419, esta danza de CSRF es lo primero a revisar (reiniciar el backend Express resetea su cookie jar).

Las URLs de las imágenes de las fotos apuntan al host de Laravel y se reescriben a `/proxy-image/<path>` (ver `fixImageUrl`/`getImageUrl` en ViewerApp/MobileApp) para evitar problemas de mixed-content/CORS.

### Aviso a recepción por e-mail (`/printbox/notify-order`)

Pieza nueva frente a Adventures. Se dispara **una vez por pedido completo** (no una vez por foto/copia) desde tres puntos de [src/mobile/MobileApp.jsx](src/mobile/MobileApp.jsx): dentro de `sendOrderPhotos()` (llamada tanto tras pago con Square como con PayPal) y en el botón "Subir fotos directamente" del paso de cámara (gratis, sin pago). El helper [src/shared/api.js](src/shared/api.js) `notifyRoomOrder({ room, items, total, paymentMethod })` envía `items` con un thumbnail pequeño (~300px, generado client-side con `resizeImageBase64` a partir de la misma foto que ya se está subiendo — **no se pide nada a la API de Laravel**) y el nº de copias por foto.

- **`backend/routes/printbox.js`** (dev): solo loguea por consola, no hay SMTP configurado en local. Limitación de desarrollo aceptada.
- **`proxy.php`** (prod): lee `email_recepcion` de `getTextosFile($configDir, $room)` (mismo mecanismo que precios/empresa) vía `getRoomReceptionEmail()`, y si existe, construye y envía un e-mail HTML con las miniaturas embebidas inline (MIME `multipart/related`, Content-ID, sin librerías) usando `mail()` nativo de PHP — ver función `sendRoomOrderEmail()`. Si no hay email configurado para la habitación, responde `{ ok: true, skipped: true }` sin enviar nada ni romper el flujo del huésped.

### Pipeline de impresión

[backend/routes/print.js](backend/routes/print.js): una cola de un solo trabajo a la vez (flag `isProcessing` + array) descarga la imagen, espera un delay configurable, usa `sharp` para leer las dimensiones, construye un PDF A4 con `pdfkit` (imagen centrada, orientación elegida según ancho vs alto), y luego imprime vía `pdf-to-printer` (SumatraPDF embebido). Hueco conocido heredado de Adventures (ver [ORIENTATION_AND_SIZE_GUIDE.md](ORIENTATION_AND_SIZE_GUIDE.md)): Express siempre genera A4 y nunca rota según el tamaño de impresión configurado (10x15 vs 15x20).

### Ficheros de configuración: delimitados por punto y coma/dos puntos, sensibles a posición y a clave

La configuración vive en `config/servidor_api.txt` / `config/textos_<habitación>.txt`, leída/escrita por [backend/routes/config.js](backend/routes/config.js) y reflejada en `proxy.php`:

- `servidor_api.txt` — líneas `clave;valor`, **parseadas posicionalmente por número de línea** (servidor, evento, evento_printer, timer, impresora, delay) — no reordenes las líneas.
- `textos_<códigoHabitación>.txt` (o simplemente `textos.txt` cuando no hay código) — líneas `clave:valor` (textos es/en/fr/de, precio1/2/3, empresa, **email_recepcion**), parseadas por nombre de clave. Cada habitación tiene su propio archivo, así que precios y email de recepción son independientes por habitación (ver `getTextosFile()` en proxy.php y `normalizeEventCode()` en api.js).
- Los códigos se normalizan quitando un prefijo `ev-`/`ev_` antes de usarse como nombre de fichero/clave de búsqueda — haz lo mismo de forma consistente si añades nuevas búsquedas de configuración indexadas por habitación.
- Si añades un nuevo campo de configuración (como se hizo con `email_recepcion`), tócalo en **cuatro** sitios: `backend/routes/config.js` (GET y POST), `proxy.php` (GET y POST, además del array `$validKeys` en ambos), y el formulario de Admin en `ViewerApp.jsx`.

### Pagos

Square (Web Payments SDK en el cliente, `/process-payment` en `backend/server.js` llamando a `connect.squareupsandbox.com` — endpoint de *sandbox*) y PayPal (`createPayPalOrder`/`capturePayPalOrder`/`getPayPalConfig` en `src/shared/api.js`, respaldado por `config/paypal.json`, en gitignore — ver `config/paypal.example.json`). Apple Pay / Google Pay no están implementados.

### Modelo de persistencia

No hay base de datos en este repo. El estado o bien se proxea hacia la API externa de Laravel (habitaciones/fotos/pedidos), o vive en ficheros de configuración planos bajo `config/`, o en `localStorage` del navegador en MobileApp/ViewerApp (fotos seleccionadas, capturas de cámara, paso/página actual, código de habitación) para que una recarga de página o un nuevo escaneo de QR retome donde el huésped lo dejó.

## Documentación en este repo

- [README.md](README.md) cubre instalación, despliegue en IONOS, arquitectura y la feature de e-mail a recepción — es la referencia principal para trabajo no arquitectónico.
- [ORIENTATION_AND_SIZE_GUIDE.md](ORIENTATION_AND_SIZE_GUIDE.md) heredado de Adventures — la traza de orientación/tamaño de impresión sigue siendo válida técnicamente (mismo Express/Laravel), pero sus referencias de número de línea son de Adventures y pueden no coincidir exactamente aquí.
- [CURRENT_STATUS.md](CURRENT_STATUS.md) es una foto fechada, no documentación viva — trátala como histórica.
