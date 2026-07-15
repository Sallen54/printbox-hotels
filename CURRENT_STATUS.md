# Estado verificado (15 julio 2026)

---

## Auditoría de seguridad y arreglos (15 julio)

Revisión completa de `proxy.php` (única superficie realmente expuesta en producción) pidiendo explícitamente fallos de seguridad. Confirmado en vivo contra `vf.incomar.net` con `curl` antes y después de cada arreglo.

### Crítico — ya corregido
- **`/coupon/create` y `/coupon/list` no exigían sesión**: cualquiera podía generar cupones firmados (HMAC) de "pago completo" para cualquier habitación, o listar los cupones de un evento, sin login. Confirmado explotable en vivo (`POST /coupon/create` sin cookie devolvía `200` con un código válido). **Arreglado**: ambas rutas exigen ahora `getSessionHotelId()` y además comprueban que la `evento` pertenece a una habitación del **propio** hotel de la sesión (`hotelOwnsRoom()`) — antes ni siquiera estaban aisladas por hotel (`getCouponFile()` usaba la carpeta global).
- **Bug relacionado, descubierto durante el arreglo**: el campo `type` (`discount`/`full`) que ya esperaba el frontend (`ViewerApp.jsx`/`MobileApp.jsx`) **nunca se guardaba ni se devolvía** en `/coupon/create` ni `/coupon/validate` — aplicar un cupón no reducía el precio realmente pagado (el descuento mostrado era solo visual). Efecto colateral: esto hacía el hueco de seguridad de arriba menos grave de lo que parecía (no se podía imprimir gratis todavía), pero el sistema de cupones estaba roto para el uso legítimo. **Arreglado**: `type` se persiste y se devuelve; el cálculo del frontend (ya escrito correctamente, no hubo que tocarlo) empezó a funcionar solo.
- **`/debug/config` sin autenticación**: exponía la ruta del servidor y el contenido crudo de `textos.txt` (precios, email de recepción) de la config global. Confirmado en vivo. **Eliminado** por completo (no lo usaba el frontend).
- **`/reset-config` sin autenticación NI comprobación de método HTTP**: un simple `GET` (disparable con un `<img src="...">`) restauraba los textos/precios a los valores por defecto. **Eliminado** por completo (no lo usaba el frontend).

### Alto — ya corregido
- **Token de acceso de Square hardcodeado en el código** (`proxy.php`, duplicado en la ruta legacy `?route=process-payment`, y en `backend/server.js`), committeado en el historial de git. **Arreglado**: ahora se lee de la variable de entorno `SQUARE_ACCESS_TOKEN`/`SQUARE_LOCATION_ID` o, si no existe, de `config/square.json` (nuevo, gitignored; hay un `config/square.example.json` con placeholders documentando el formato). `/process-payment` responde `500` explícito si no hay credenciales, en vez de usar un secreto hardcodeado.
- **`COUPON_SECRET` hardcodeado** (`'pba_s3cr3t_k3y_2026'`) → ahora se genera aleatorio y se guarda en `config/coupon_secret.txt` (gitignored, protegido por `config/.htaccess`), igual que ya existía para `session_secret.txt`. Efecto colateral bueno: invalida automáticamente cualquier cupón firmado con la clave vieja (incluidos los de las pruebas de esta auditoría).

### Limpieza relacionada (encontrada durante la misma revisión)
- `pba_requests.log` logueaba el body de **todas** las peticiones, incluido `/auth/login` — la contraseña de la cuenta de cada hotel quedaba en texto plano en ese log. Arreglado: el body de `/auth/*` ya no se loguea (`[redacted]`).
- `/process-payment` escribía en `config/debug.log` el payload completo de cada pago (incluido el `source_id` de Square) y la respuesta de Square — sin ningún endpoint que lo mostrara ya (`/debug/config` se eliminó). Se quitó ese logging.
- `getTextosFile($configDir, $eventCode)` tenía una rama "por evento" (`textos_<código>.txt`) que **nunca se llamaba** con `$eventCode` no vacío en ningún sitio del código actual — simplificado a una única función sin esa rama muerta.
- Dependencia `axios` en `package.json`: no se usa en ningún sitio del código (ni `src/` ni `backend/`) — eliminada.

### No tocado (fuera de alcance, decisión del usuario)
- `hotelId` no es secreto por diseño (viaja en el QR/URL); cualquiera que lo conozca puede leer precios/email de ese hotel vía `GET /config?hotel=<id>` sin login. Aceptado como parte del diseño multi-hotel.
- El interruptor "servicio disponible" solo se comprueba en el cliente móvil, no en el backend.
- Sin límite de intentos en `/auth/login` (fuerza bruta).
- CSP totalmente abierta en `.htaccess` raíz (`"CSP disabled for debugging"`).

### Verificado
- `php -l proxy.php` y `node -c backend/server.js` limpios tras cada cambio.
- Servidor PHP embebido aislado (fuera del proyecto real, en scratchpad) con dos hoteles de prueba: `coupon/create`/`coupon/list` sin sesión → 401; con sesión de OTRO hotel sobre una habitación ajena → 403; con la sesión correcta → 200 y `type` presente en la respuesta; `coupon/validate` devuelve `type`; `debug/config` y `reset-config` → 404; `process-payment` sin credenciales → 500 explícito, con `config/square.json` → pasa la comprobación (la llamada real a Square no se pudo probar por restricciones de red del entorno de pruebas, no relacionado con el cambio).
- Confirmado en vivo contra `vf.incomar.net` (antes del arreglo): `coupon/create` sin sesión → `200` (explotable), `debug/config` → `200` con datos reales de la config global.

### Pendiente
- Subir a producción: `proxy.php`, `.htaccess`, `config/square.json` (nuevo).
- Rotar el token de Square en el panel de Square — el valor actual estuvo expuesto en el código fuente y en el historial de git.

---

## Resumen

Proyecto creado a partir de `printbox-adventures` (carpeta hermana), como base para un producto separado orientado a hoteles/hostales/campings. Dominio de producción en IONOS asignado (**https://vf.incomar.net/**), pendiente de re-desplegar con los últimos cambios. Todo lo verificado es local.

## Multi-hotel con login por hotel (14 julio) — cambio de arquitectura

**Antes:** un despliegue = un solo hotel, config global, cualquiera que entrase a `/viewer` veía el mismo hotel. **Ahora:** varios hoteles conviven en el mismo despliegue, cada uno con **su sesión** (usuario+contraseña) y su carpeta de config aislada.

- **Cuentas** en `config/hotels.json` (hash **bcrypt**), creadas por Printbox con `scripts/add-hotel.js` (no hay auto-registro). Los hashes de bcryptjs los verifica también `password_verify()` de PHP → misma cuenta vale en dev (Express) y prod (proxy.php); **verificado** con prueba cruzada Node↔PHP.
- **Sesión** = cookie `pbh_session` firmada con **HMAC** (secreto en `config/session_secret.txt`), `HttpOnly`+`SameSite=Lax`(+`Secure` en prod), sin BD. Endpoints `POST /auth/login`, `GET /auth/me`, `POST /auth/logout` en ambos backends.
- **Config por hotel**: `config/hotels/<id>/` (servidor_api, textos, habitaciones.json, hotel-logo.png). El **panel** resuelve el hotel por la **cookie**; el **móvil** (huésped, sin login) por **`?hotel=<id>`** del QR. **Escribir exige sesión** (401 si no) y siempre en la carpeta del hotel de la cookie (nunca del query).
- **QR** ahora `/mobile?hotel=<id>&habitacion=<code>`, generado desde el panel.
- **Viewer**: pantalla de login nueva; tras entrar, el asistente/monitor/Admin quedan acotados a ese hotel; botón "Salir". **Desaparece la contraseña `admin123`** hardcodeada del cliente: el candado ahora es la sesión de hotel.
- **Printer**: usa la misma cookie (mismo navegador de recepción); si no hay sesión, muestra "Inicia sesión en el Monitor".
- **Seguridad**: `config/.htaccess` (`Require all denied`) para que nada de `config/` (cuentas, secreto, logos/textos de todos) se sirva por HTTP; se **quitó el diagnóstico temporal** de `/printbox/notify-order` que filtraba email y rutas internas; CORS con credenciales (refleja Origin) en ambos backends para que la cookie viaje en dev cross-origin.

### Verificado (14 julio)
- **Aislamiento por sesión en LOS DOS backends** (Express y `proxy.php` local, con curl): login A/B con cookies distintas; `GET /config` con cookie A devuelve solo A, con B solo B; login incorrecto → 401; `GET /config?hotel=hotela` sin cookie (móvil) → A; `POST /config` sin cookie → **401**; logo `POST` sin cookie → 401, `GET ?hotel=hotela` sirve el subido y `?hotel=hotelb` el placeholder ✅
- **E2E Playwright (viewer)**: sin sesión → login; login incorrecto → error; login A → cabecera "Hotel A"; logout → login; login B → "Hotel B" (aislado); recarga → sigue "Hotel B" (cookie persiste) ✅
- **E2E Playwright (móvil)**: `/mobile?hotel=hotela&habitacion=111` → todas las peticiones `/config` y `/hotel-logo` llevan `hotel=hotela` desde el primer render ✅

---

## (Histórico) Cambios previos frente a printbox-adventures

- **Sin Electron**: eliminado por completo de `package.json` (dependencias, scripts, bloque `build`). No hay carpeta `electron/`, no hay workflow de instalador.
- **Terminología**: "evento" → "habitación" de cara al usuario en `MobileApp.jsx`, `ViewerApp.jsx` y `PrinterApp.jsx`. El QR ahora usa `?habitacion=` en vez de `?evento=`. Internamente sigue siendo un "evento" de Laravel (sin renombrar variables técnicas).
- **Diseño del Monitor (`/viewer`) rediseñado a tema claro/crema** siguiendo la maqueta del hotel de referencia: cabecera de 3 columnas (idioma ES/EN, logo del hotel centrado, idioma FR/DE), botones de acción en pastilla, galería sobre fondo oliva oscuro con badge circular del logo en cada foto, paginación y footer a juego. La app Móvil y el Printer mantienen el tema oscuro con acento dorado (paleta en `src/styles/global.css`); el Monitor tiene su propia paleta clara en `src/viewer/Viewer.css`.
- **Logo del hotel**: un único archivo `src/public/assets/hotel-logo.png` (placeholder de momento) reutilizado en cabecera móvil, cabecera del Monitor y badge de las fotos.
- **Nueva feature — aviso a recepción por e-mail**: al enviar fotos (pago o gratis desde cámara) se llama a `POST /printbox/notify-order` una vez por pedido completo. En dev solo loguea por consola; en `proxy.php` (prod) construye y envía un e-mail HTML con miniaturas inline vía `mail()` nativo de PHP, sin SMTP/PHPMailer.
- **Config nueva**: campo `email_recepcion` añadido en `backend/routes/config.js`, `proxy.php` (GET/POST + validKeys) y en el panel Admin de `ViewerApp.jsx`.
- **Config de ámbito hotel (14 jul)**: cada hotel tiene su propia página/despliegue, así que precios, textos y email de recepción pasaron a ser **únicos por hotel** — se configuran una vez en el Admin (que ya no pasa `eventCode` a `/config`) y valen para todas las habitaciones. `proxy.php` lee el email del `textos.txt` global (`getHotelReceptionEmail()`); los archivos por-evento `textos_<código>.txt` quedan como mecanismo legado que Hotels ya no usa.
- **Limpieza**: eliminados ~30 assets de Adventures sin usar (mascotas, banners, iconos de flujo OTP/cámara antiguo), la carpeta `assets/` duplicada en la raíz, `test.html`/`test.php` (scratch de diagnóstico IONOS), y todo lo relacionado con la verificación de dominio de Apple Pay (`.well-known/`, rutas en `proxy.php`/`.htaccess`/`copy-dist-assets.js`) — no implementado y específico del dominio de Adventures.
- **Subir fotos ya guardadas en el móvil**: nuevo botón (icono `bi-images`) en la cabecera de la galería que abre el selector nativo de archivos del móvil (`<input type="file" accept="image/*" multiple>`). Las fotos elegidas entran en el mismo flujo que las de cámara (`capturedPhotos` → pedido → pago/gratis → aviso a recepción).
- **El Viewer es ahora la página autoconfigurable de cada hotel (14 jul)**: al abrir `/viewer` sin configurar aparece un **asistente de 3 pasos** — nombre del hotel → logo (se sube desde el navegador, se redimensiona a PNG 512px con canvas) → habitaciones (nombre + código `ev-` proporcionado por Printbox). El Admin incorpora: nombre del hotel, cambio de logo, y un **gestor de habitaciones** (añadir/quitar, ver/imprimir el QR de cada una, elegir cuál muestra el monitor). Piezas nuevas: `config/habitaciones.json` (viaja por el mismo `/config`), endpoint `GET/POST /hotel-logo` en ambos backends (+ regla en `.htaccess`) — el logo subido se guarda en `config/hotel-logo.png` (la carpeta que nunca se sobreescribe al redesplegar) con fallback al placeholder de `assets/`. La cabecera del monitor muestra logo + nombre, hay un botón-pastilla con la habitación actual que abre el selector, y "Ver QR" muestra el QR de la habitación monitorizada. El móvil no cambia de flujo — solo su `<img>` de logo apunta a `/hotel-logo` para reflejar el logo subido.
- **El móvil ya NO muestra la galería del evento (14 jul)**: los huéspedes que escanean el QR no deben ver las fotos que ya haya en la habitación — el flujo es solo *subir/hacer foto → pagar → se imprime en recepción*. Se eliminó de `MobileApp.jsx` todo el listado/selección de fotos del evento (`getEventPhotos`, `selected`, scroll infinito); la pantalla principal muestra las fotos añadidas por el propio huésped o un estado vacío con instrucciones. El Monitor (`/viewer`) sí sigue mostrando la galería del evento — es la pantalla de recepción.
- **Interruptor "servicio disponible" a nivel de hotel**: nuevo campo `servicio_disponible` (booleano) en `servidor_api.txt`/`config` — es **global**, no depende de la habitación (a diferencia de precios/email que son por-habitación vía `textos_<habitación>.txt`). Se activa/desactiva desde un switch en el panel Admin del Monitor (`ViewerApp.jsx`). Si está desactivado, **cualquier** habitación que abra la app móvil (por QR o manualmente) ve de inmediato una pantalla de bloqueo con el aviso en ES/EN/FR/DE ("Servicio no disponible temporalmente. Lamentamos las molestias.") en vez del flujo normal; se comprueba al entrar y se refresca cada 5s mientras se usa la app, así que también bloquea a media sesión si recepción lo desactiva. El Monitor muestra además una insignia roja de aviso en la cabecera mientras esté desactivado, para que recepción no se olvide de reactivarlo.

## Dos bugs reales encontrados y corregidos durante la verificación (heredados de Adventures, no introducidos en este trabajo)

1. **La cámara era inalcanzable**: `MobileApp.jsx` tenía toda la lógica de `STEP_CAMERA` (capturar, subir gratis) pero **ningún botón llamaba a `setStep(STEP_CAMERA)`** — ni en Adventures ni aquí. Se añadió un botón de cámara en la cabecera de la galería (`src/mobile/MobileApp.jsx`, junto al botón de Términos) para poder llegar a ese paso.
2. **`eventCode` se vaciaba solo bajo `React.StrictMode` en desarrollo**: el `useEffect` que procesa `?habitacion=` llamaba a `loadFromLocalStorage()` de forma incondicional al final, incluso cuando ya se había fijado el código por QR. Bajo el doble-invocado de efectos de StrictMode (solo en dev), la segunda pasada releía un `localStorage` todavía no actualizado y sobreescribía el código de habitación correcto con uno vacío — el e-mail a recepción llegaba con `room: ""`. Corregido moviendo esa llamada dentro del `else` (solo cuando NO hay `?habitacion=` en la URL). No afecta al build de producción (StrictMode no duplica efectos fuera de dev), pero sí habría confundido cualquier prueba local futura.

## Verificado (Playwright, Chromium headless, con red mockeada)

- `php -l proxy.php` y `node --check` sobre todo el backend ✅
- `npm install` + `npm run build` + `npm run dev` ✅ (sin Electron, puerto correcto, sin colisionar con el directorio de datos de Adventures)
- **Flujo completo con pago**: `/mobile?habitacion=1204` → seleccionar foto de galería → pedido con 2 copias → pago (SDK de Square mockeado) → `photo-send` recibe la foto → `notify-order` recibe `{room: "1204", items: [...], total, paymentMethod: "Tarjeta (Square)"}` correctamente ✅
- **Flujo completo gratis con cámara**: botón "Hacer foto" → capturar (cámara simulada con un canvas) → "Subir fotos directamente" → `photo-send` + `notify-order` con `paymentMethod: "Gratis (foto de cámara)"` ✅
- **Flujo completo subiendo desde la galería del móvil**: botón de galería → elegir un archivo de imagen → "Ver pedido" → pagar (Square mockeado) → `photo-send` + `notify-order` con `room`, `total` y `paymentMethod` correctos ✅
- `/mobile`, `/viewer` y `/printer` renderizan sin errores de consola, con la marca y colores correctos (Mobile/Printer oscuro-dorado, Viewer claro-crema con el logo del hotel en 3 sitios)
- **Interruptor de servicio disponible/no disponible**: con `servicio_disponible: true` la app móvil entra con normalidad; con `false` bloquea inmediatamente y muestra el aviso en los 4 idiomas (`.service-unavailable-box`), verificado con red mockeada en ambos casos ✅
- **Asistente del hotel completo (Playwright)**: entrar sin configurar → asistente visible → nombre → subir logo (archivo real vía `setInputFiles`) → 2 habitaciones → Terminar → `POST /hotel-logo` + habitaciones + config con `empresa` y `evento` correctos → monitor con nombre en cabecera y botón "Suite Mar" → Admin lista las 2 habitaciones → QR de la 2ª habitación se abre con su código. Cero errores de consola ✅
- **Endpoints nuevos contra backend real**: `GET /hotel-logo` (placeholder → subido tras POST, con fallback) y `habitaciones` saneadas (quita `ev-`, descarta filas sin código) verificados con curl tanto en Express como en `proxy.php` (servidor PHP local) ✅
- **Corregido: foto única "enorme" en la galería del Monitor** — con `grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))`, al haber pocas fotos las columnas vacías colapsaban y la(s) foto(s) restante(s) se estiraban para llenar todo el ancho de pantalla. Cambiado a `repeat(auto-fill, minmax(180px, 220px))` + `justify-content: center`, así el tamaño de cada miniatura es fijo (~220px) sin importar cuántas fotos haya. Verificado con una sola foto en un viewport de 1600px: la miniatura midió 220×293px en vez de ocupar toda la pantalla ✅
- **Corregido: la insignia del logo tapaba la foto entera** — la regla `.viewer-photo-card img` (clase+etiqueta) tenía más especificidad CSS que `.viewer-photo-badge` (una sola clase), así que la insignia circular de 34×34px heredaba el `width:100%;height:100%;object-fit:contain` pensado para la foto principal, mostrándose a tamaño completo (216×289px) y tapando por completo la foto real subida por el huésped — daba la sensación de que "sale el logo en vez de la foto". Corregido reforzando el selector a `.viewer-photo-card .viewer-photo-badge` (dos clases, más específico). Verificado con `getComputedStyle`: antes `width:216px` (mal, igual que la foto), después `width:34px` (correcto, solo la esquina) ✅

## Pendiente de verificar

- Guardar/leer `email_recepcion` desde el panel Admin del Monitor contra un evento real (ya probado por API directamente, falta probar desde la UI del Admin)
- Flujo completo de pago (Square/PayPal) contra un evento real de `gestion.printboxweb.com` (lo verificado usó un SDK de Square simulado)
- Primer despliegue real en IONOS (`vf.incomar.net`) y comprobación de que `mail()` entrega el e-mail (no se puede probar en local)
