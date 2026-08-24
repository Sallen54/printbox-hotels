# Printbox Hotels

Sistema de envío e impresión de fotos por habitación para hoteles, hostales y campings. Creado en julio 2026 a partir de **Printbox Adventures** (misma base técnica: React + Vite + Node/Express, desplegado como app web en hosting compartido de IONOS). A diferencia de Adventures, aquí **no hay app de escritorio Electron** — es solo web.

**Versión actual:** 0.1.0 (julio 2026) — proyecto recién creado, pendiente de primer despliegue real.

---

## Índice

1. [Descripción general](#1-descripción-general)
2. [Requisitos](#2-requisitos)
3. [Instalación y arranque](#3-instalación-y-arranque)
4. [Despliegue web en IONOS (Apache)](#4-despliegue-web-en-ionos-apache)
5. [Estructura del proyecto](#5-estructura-del-proyecto)
6. [Cómo funciona la aplicación](#6-cómo-funciona-la-aplicación)
7. [Aviso por e-mail a recepción](#7-aviso-por-e-mail-a-recepción)
8. [Archivos de configuración](#8-archivos-de-configuración)
9. [Colores y logo del hotel](#9-colores-y-logo-del-hotel)
10. [Arquitectura técnica](#10-arquitectura-técnica)
11. [Flujo de datos completo](#11-flujo-de-datos-completo)
12. [Solución de problemas](#12-solución-de-problemas)
13. [Pendientes / ideas de mejora](#13-pendientes--ideas-de-mejora)

---

## 1. Descripción general

**Varios hoteles conviven en el mismo despliegue**, cada uno con **su propia cuenta/sesión** (usuario+contraseña que le da Printbox). Al entrar en `/viewer` cada hotel inicia sesión y ve solo lo suyo (habitaciones, precios, logo, email). Cada habitación tiene un **QR** (pegado en la propia habitación) que abre la app móvil. El huésped:

1. Escanea el QR → entra directo a la pantalla de su habitación (sin escribir ningún código).
2. Sube fotos que ya tiene guardadas en el móvil (no ve las fotos de otros).
3. Paga con tarjeta (Square) o PayPal.
4. **Recepción recibe un e-mail automático** con miniaturas de las fotos, el número total y el resumen de lo pagado.
5. Recepción imprime las fotos (con el mismo "Panel de Control"/Printer que ya usa Adventures) y se las entrega al huésped.

### Alta de un hotel (lo hace Printbox)

Las cuentas **las crea Printbox** (no hay auto-registro), con el script local `scripts/add-hotel.js`, y se suben por FTP a `config/` (ver §14):

```bash
node scripts/add-hotel.js --id marbella --nombre "Hotel Marbella" --user recepcion --pass "claveSegura"
node scripts/add-hotel.js --list                          # ver hoteles
node scripts/add-hotel.js --id marbella --pass "nueva"    # resetear contraseña
```

Esto añade la cuenta a `config/hotels.xml` y crea `config/hotels/marbella/`.

**También puedes editar `config/hotels.xml` a mano** (Bloc de notas, VS Code, Excel): la
contraseña va tal cual en `<pass>`, así que dar de alta un hotel es copiar un bloque y
cambiar los cuatro datos.

```xml
<hotel id="marbella">
  <nombre>Hotel Marbella</nombre>
  <usuario>recepcion</usuario>
  <pass>ClaveDelHotel2026</pass>
</hotel>
```

El `id` va sin espacios ni acentos y es lo que viaja en el QR. Para ver las cuentas y sus
contraseñas: `node scripts/add-hotel.js --list`.

> ⚠️ Ese fichero contiene **las contraseñas de todos los hoteles en claro**. La web nunca lo
> sirve (`config/.htaccess` lo bloquea), pero cualquiera con acceso al FTP las ve. No lo
> compartas por correo ni lo dejes en una carpeta sincronizada.

### Puesta en marcha de un hotel (tutorial)

El hotel abre `/viewer`, **inicia sesión** con el usuario/contraseña que le dio Printbox, y la primera vez aparece un **asistente de 3 pasos**:

1. **Nombre del hotel** — se muestra en la cabecera del monitor y en los avisos.
2. **Logo del hotel** — se sube desde el navegador (PNG/JPG, se ajusta solo); aparece en el monitor, en la app del huésped y como sello en cada foto. Se puede omitir y subir después.
3. **Habitaciones** — cada habitación con su **código `ev-` proporcionado por Printbox**.

Al terminar, el monitor queda funcionando. Desde **Admin** (⚙) pueden después: cambiar nombre/logo, añadir/quitar habitaciones, **ver e imprimir el QR de cada habitación**, elegir qué habitación muestra el monitor, y configurar precios, e-mail de recepción y el interruptor de "servicio disponible". Botón **Salir** para cerrar sesión. El QR de cada habitación es `/mobile?hotel=<id>&habitacion=<código>` (lleva el hotel para que el móvil cargue sus precios/logo).

### Interfaces web (desplegadas en IONOS)

| Pantalla | Ruta | Uso |
| --- | --- | --- |
| App Móvil | `/mobile` | El huésped escanea el QR de su habitación, sube/hace fotos y paga |
| Monitor / Admin | `/viewer` | Pantalla de recepción — ver fotos de una habitación, imprimir, configurar precios y el e-mail de recepción |
| Printer | `/printer` | Poll de fotos marcadas para imprimir → PDF → impresora física en recepción |

### Backend

Reutiliza la **misma infraestructura Laravel** que Adventures (`gestion.printboxweb.com`) — técnicamente cada "habitación" es un "evento" de Laravel, solo que de cara al huésped y a recepción se le llama habitación. No hay base de datos propia en este repo.

---

## 2. Requisitos

### Para desarrollo
- Node.js v18 o superior → <https://nodejs.org>
- npm (incluido con Node.js)
- Conexión a internet (habla con `gestion.printboxweb.com`)

### Para despliegue (IONOS)
- Acceso FTP al hosting IONOS
- Dominio propio para Printbox Hotels: **https://vf.incomar.net/**
- El mismo backend Laravel externo en `gestion.printboxweb.com`

---

## 3. Instalación y arranque

```bash
npm install
npm run dev
```

Lanza 2 procesos (sin Electron):
- `[REACT]` — Vite dev server en `http://localhost:3000`
- `[BACKEND]` — Express en `http://localhost:4000`

Verificar backend:
```
Desarrollo:  http://localhost:4000/health  →  { "ok": true }
Producción:  https://vf.incomar.net/health   →  { "ok": true }
```

### Probar la app móvil desde el móvil en desarrollo (misma WiFi)
1. `ipconfig` → busca tu IP local (`IPv4 Address: 192.168.X.X`)
2. Cambia `BACKEND_URL` en `src/shared/api.js` si hace falta apuntar a esa IP
3. Abre `http://192.168.X.X:3000/mobile` desde el móvil

> ⚠️ La app del huésped se sirve **siempre por HTTPS** (el `.htaccess` fuerza la redirección): el SDK de pago de Square exige contexto seguro y por http se niega a cargar.

---

## 4. Despliegue web en IONOS (Apache)

Igual que Adventures: como IONOS no permite Node.js, el backend Express se reemplaza en producción por un **proxy PHP** (`proxy.php`).

### Archivos necesarios en IONOS (raíz del subdominio)
```
/  (raíz del subdominio de Printbox Hotels)
├── index.html          ← del dist/
├── assets/              ← del dist/ (incluye hotel-logo.png — solo placeholder de fallback)
├── proxy.php            ← reemplaza el backend Express (incluye envío de e-mail con mail() nativo)
├── .htaccess            ← enruta las llamadas API al proxy
└── config/              ← carpeta con permisos de escritura (chmod 755), ver §8
    ├── .htaccess         ← deniega TODO acceso HTTP directo a este directorio
    ├── hotels.xml        ← cuentas (Printbox, con scripts/add-hotel.js)
    ├── session_secret.txt, coupon_secret.txt   ← se generan solos, no tocar a mano
    ├── square.json       ← credenciales de Square (copiar de config/square.example.json)
    └── hotels/<id>/      ← config, precios, logo y habitaciones de cada hotel
```

### Pasos para publicar
```bash
npm run build
```
Sube por FTP a la raíz del subdominio: todo `dist/` (ya incluye `proxy.php`, `.htaccess`, `config/` copiados automáticamente por `scripts/copy-dist-assets.js`).

> ⚠️ **No sobreescribir `config/`** si ya tiene datos (cuentas, secretos, config de los hoteles). `npm run build` copia tu `config/` LOCAL entero a `dist/config/` (incluida tu `config/hotels.xml` y `config/square.json` de pruebas) — sube solo `assets/`, `index.html`, `proxy.php` y `.htaccess`, **nunca** la carpeta `config/` entera de `dist/`.
>
> ⚠️ **La primera vez**, sube manualmente: `config/.htaccess` (deniega TODO acceso HTTP a `config/` — debe bloquear por fichero con `<FilesMatch>`, no a nivel de carpeta, o romperá la ruta `/config` de la API, ver §12), `config/hotels.xml` y `config/hotels/<id>/` generados con `add-hotel.js`, y `config/square.json` (copia `config/square.example.json` con las credenciales reales de Square).

**Alta de hoteles (Printbox):** el hosting IONOS no tiene Node, así que las cuentas se crean **en local** con `node scripts/add-hotel.js ...` (§1) y luego se suben por FTP los ficheros resultantes (`config/hotels.xml` y `config/hotels/<id>/`).

**Migrar el hotel actual de `vf.incomar.net`** (que hoy tiene su config en el `config/` global): (1) crea su cuenta con `add-hotel.js`; (2) por FTP, mueve `servidor_api.txt`, `textos.txt`, `habitaciones.json` y `hotel-logo.png` del `config/` global a `config/hotels/<id>/`; (3) reimprime los QR con `?hotel=<id>`. Mientras no se migre, el sitio sigue leyendo el `config/` global (fallback de compatibilidad).

Ver también `guia_ionos.txt` para la guía genérica paso a paso de FTP.

### Diagnóstico tras subir
```
https://vf.incomar.net/health     →  { "ok": true }
https://vf.incomar.net/config     →  { "config": {...}, "textos": {...} }
https://vf.incomar.net/proxy.php  →  { "status": "ok", "curl": true, ... }
```

---

## 5. Estructura del proyecto

```
printbox-hotels/
│
├── backend/
│   ├── server.js        Express (puerto 4000) — sirve frontend + API proxy (solo dev)
│   ├── lib/session.js   Sesión de hotel (cookie HMAC), compartida por config.js y auth.js
│   └── routes/
│       ├── auth.js      POST /login, GET /me, POST /logout
│       ├── printbox.js  Proxy → gestion.printboxweb.com + POST /notify-order (dev: solo loguea)
│       ├── print.js     Descarga → PDF → imprime
│       └── config.js    Lee/escribe config/hotels/<id>/*.txt (incluye email_recepcion)
│
├── src/
│   ├── main.jsx         React Router — /viewer /mobile /printer
│   ├── public/assets/
│   │   └── hotel-logo.png   ← placeholder de fallback (cada hotel sube el suyo desde el navegador)
│   ├── styles/global.css    Paleta de colores centralizada (variables --pb-*)
│   ├── shared/api.js         Todas las llamadas HTTP: login/logout/getMe, getConfig, notifyRoomOrder()...
│   ├── viewer/ViewerApp.jsx   Login + Monitor de recepción + Admin (precios, email, cupones, QR)
│   ├── printer/PrinterApp.jsx Impresión física (exige sesión del Monitor)
│   └── mobile/MobileApp.jsx   App del huésped (subir foto, pedido, pago, cupón, aviso a recepción)
│
├── config/                    Ver §8 — cuentas, secretos y config/hotels/<id>/ (todo fuera de git)
│
├── scripts/
│   ├── add-hotel.js          CLI de Printbox: alta/reset de cuentas de hotel
│   └── copy-dist-assets.js   Copia .htaccess, proxy.php y config/ a dist/ tras el build
│
├── package.json
├── vite.config.js
├── proxy.php
└── README.md
```

---

## 6. Cómo funciona la aplicación

### 6.1 App Móvil (huésped) — `/mobile?habitacion=XXXX`

1. El huésped escanea el QR de su habitación (o recibe la URL) → entra directo a la galería, sin escribir ningún código.
2. Pulsa **Subir foto**, que abre el selector nativo del móvil (desde ahí puede elegir una foto guardada o hacer una en el momento). El botón de cámara propio está desactivado (`CAMARA_HABILITADA = false`), aunque su código se conserva. **La foto se sube al original, sin redimensionar**, para no perder calidad de impresión; sólo se genera una miniatura para la pantalla y el e-mail.
3. "Ver pedido" → ve el desglose: **una copia de cada foto** al precio unitario del hotel (por defecto 1,20 €). No hay selector de copias; el tope por pedido son **80 fotos** (`MAX_FOTOS` en [src/mobile/MobileApp.jsx](src/mobile/MobileApp.jsx)).
4. Elige método (**Tarjeta** o **PayPal**) y paga. Si aplica un cupón que cubre el total, no se muestra pasarela: solo un botón de **Enviar pedido**.
5. Al completar el envío, **recepción recibe automáticamente el e-mail** con las primeras miniaturas, el número de fotos y el resumen del pago (ver sección 7).
6. Las fotos quedan pendientes de imprimir en el Monitor/Printer de recepción.

### 6.2 Monitor / Admin — `/viewer`

Pantalla para recepción: elige la habitación y ve la galería de fotos que suben los huéspedes (al pulsar una se abre a pantalla grande). **Solo visor: no imprime ni cobra** — de eso se encarga el móvil del huésped. Desde **Configuración** (contraseña) ajusta precio, empresa y **el e-mail de recepción** del hotel, y genera cupones.

### 6.3 Printer — `/printer`

Igual que en Adventures: hace polling de las fotos marcadas para imprimir, genera PDF y las envía a la impresora física conectada en recepción.

---

## 7. Aviso por e-mail a recepción

**Cada vez que una habitación envía fotos** (tras el pago, o tras un cupón de pago completo), se dispara **una sola llamada** a `POST /printbox/notify-order` con:

```json
{ "room": "1204", "items": [{ "thumbnail": "data:image/jpeg;base64,...", "copies": 1 }], "total": "2.40", "paymentMethod": "Tarjeta (Square)" }
```

- El thumbnail se genera **en el propio móvil**, a partir de la foto que ya se está enviando (no se pide nada a ninguna API externa).
- Cada foto va con `copies: 1`; el pedido viaja al servidor como lista de copias porque la validación del importe (`pbhCheckAmountCents`) sigue recalculando con esa tabla.
- En un pedido grande el e-mail lleva **sólo las 12 primeras miniaturas** + el total real (`fotos`), y resume el resto con "y N fotos más". Con 80 miniaturas el correo no pasaría por `mail()`.

### En producción (IONOS / `proxy.php`)
Lee el e-mail de recepción del hotel (`email_recepcion` en `config/hotels/<id>/textos.txt` — único por hotel, vale para todas sus habitaciones) y envía un email HTML con las miniaturas embebidas inline (MIME `multipart/related`, sin librerías externas) usando **`mail()` nativo de PHP** — elegido deliberadamente como la opción más simple, sin SMTP ni PHPMailer. El hotel se resuelve por el `?hotel=<id>` que el móvil añade desde el QR (el aviso lo dispara siempre el huésped, sin sesión).

> ⚠️ **Limitación conocida y aceptada:** la fiabilidad de `mail()` en IONOS depende de la configuración SPF/DKIM del dominio — puede terminar en spam. Si en el futuro hace falta más fiabilidad, la vía sería migrar a SMTP real (Gmail, Brevo, SendGrid, etc.), pero eso queda fuera del alcance actual a propósito.

Si la habitación no tiene `email_recepcion` configurado, el endpoint responde `{ ok: true, skipped: true }` sin enviar nada (no rompe el flujo del huésped).

### En desarrollo (`backend/routes/printbox.js`)
No hay forma sencilla de enviar e-mail real sin credenciales SMTP en local, así que el endpoint de dev **solo loguea por consola** el resumen del pedido (habitación, nº de fotos, total). Es una limitación de desarrollo documentada y aceptada.

---

## 8. Archivos de configuración

> **Desarrollo:** `config/` en la raíz del proyecto.
> **Producción:** `config/` en la raíz del subdominio en IONOS (mismo sitio que `proxy.php`).

Estructura multi-hotel:

```
config/
  .htaccess               # deniega TODO acceso HTTP a este directorio (por fichero, ver nota)
  hotels.xml              # cuentas: <hotel id=".."><nombre/><usuario/><pass/></hotel>
  session_secret.txt      # secreto HMAC de sesión (se genera solo la 1ª vez)
  coupon_secret.txt       # secreto HMAC de los códigos de cupón (se genera solo la 1ª vez)
  square.json             # credenciales de Square (copiar de square.example.json)
  paypal.json             # credenciales de PayPal (opcional, copiar de paypal.example.json)
  hotels/
    <hotelId>/            # una carpeta por hotel
      servidor_api.txt
      textos.txt
      habitaciones.json
      hotel-logo.png
      cupones-<evento>.json      # cupones de descuento/pago completo de esa habitación
```

Cada hotel se resuelve por la **sesión** (panel) o por **`?hotel=<id>`** (móvil). Si no hay `hotelId`, se lee el `config/` global (compat con el modelo antiguo de un solo hotel).

> ⚠️ **`config/.htaccess` debe denegar por FICHERO** (`<FilesMatch ".">Require all denied</FilesMatch>`), no con un `Require all denied` a nivel de carpeta: como `/config` es también una ruta real de la API (reescrita a `proxy.php`), un deny a nivel de directorio la bloquea con 403 antes de que la reescritura actúe. Ver §12.

### `config/hotels/<id>/servidor_api.txt`
```
servidor;http://gestion.printboxweb.com
evento;
evento_printer;
timer;5
impresora;-IMPRESORA-
delay;5
servicio_disponible;1
```
> ⚠️ Orden exacto — no cambiar posición de líneas (se parsea por número de línea).

### `config/hotels/<id>/textos.txt`
```
es:¡Consigue tu foto de la habitación!
en:Get your room photo!
fr:Obtenez votre photo!
de:Hol dir dein Foto!
precio1:1.20
precio2:2.40
precio3:3.60
empresa:Hotel Ejemplo
email_recepcion:recepcion@tuhotel.com
```
Precios, textos y email son **por hotel**; se configuran en el Admin del Monitor y valen para todas las habitaciones de ese hotel.

### `config/hotels/<id>/habitaciones.json`
```json
[
  { "nombre": "Suite 101", "codigo": "6926957" },
  { "nombre": "Doble 102", "codigo": "6926958" }
]
```
Habitaciones registradas (asistente inicial / Admin), código **sin** prefijo `ev-`. Viajan por el mismo `GET/POST /config`.

### `config/hotels/<id>/hotel-logo.png`
Logo subido desde el navegador (`POST /hotel-logo`, requiere sesión). Si no existe, `GET /hotel-logo` sirve el placeholder de `assets/`.

### `config/hotels.xml` (cuentas), `session_secret.txt` y `coupon_secret.txt`
`hotels.xml` lo gestiona `scripts/add-hotel.js`, pero **está pensado para editarse a mano** (contraseñas legibles en `<pass>`). Los dos secretos, en cambio, los genera el propio backend la primera vez que hacen falta — **nunca** editarlos a mano: regenerar `coupon_secret.txt` invalida todos los cupones emitidos y regenerar `session_secret.txt` echa a todos los hoteles de su sesión. Los tres quedan fuera del alcance HTTP por `config/.htaccess`.

### `config/square.json` y `config/paypal.json`
Credenciales de las pasarelas de pago (`accessToken`/`locationId` para Square, `clientId`/`clientSecret`/`env` para PayPal). Cada uno tiene un `*.example.json` con placeholders en el repo — copia el que corresponda, rellénalo con las credenciales reales y **nunca lo subas a git** (ya están en `.gitignore`). Si faltan, `/process-payment` y `/paypal/*` responden 500 con un error explícito en vez de fallar en silencio.

### Cupones de descuento/pago completo
`GET/POST /coupon/*` (§11) — cada hotel genera desde el Admin del Monitor cupones de un solo uso para una habitación suya: **descuento** (resta del importe) o **pago completo** (cubre el 100% y salta Square/PayPal). Se guardan en `config/hotels/<id>/cupones-<evento>.json`, firmados con HMAC (`coupon_secret.txt`) para que no se puedan falsificar a mano. Crear/listar cupones exige sesión del hotel dueño de esa habitación; validar/canjear un código no (lo hace el huésped sin login), pero solo un código realmente emitido por un hotel autenticado supera la firma.

---

## 9. Colores y logo del hotel

- **App Móvil / Printer**: tema oscuro con acento dorado, paleta centralizada en `src/styles/global.css` (variables `--pb-bg`, `--pb-bg-alt`, `--pb-accent`, `--pb-text`) — cambiar esos valores re-tematiza ambas apps.
- **Monitor (`/viewer`)**: tema claro/crema inspirado en la maqueta del hotel (cabecera crema de 3 columnas: idioma ES/EN a la izquierda, logo del hotel al centro, idioma FR/DE a la derecha; botones de acción en pastillas; galería sobre fondo oliva oscuro; footer oscuro con precios). Variables propias en `src/viewer/Viewer.css` (`--vw-cream`, `--vw-body-bg`, `--vw-footer-bg`, `--vw-text-dark`), independientes de las de Mobile/Printer.
- **Logo del hotel**: se sube **desde el navegador** (asistente inicial o Admin del Monitor) — no hace falta FTP. Se guarda en `config/hotel-logo.png` del servidor (sobrevive a redespliegues) y lo sirve `GET /hotel-logo` con fallback al placeholder `src/public/assets/hotel-logo.png`. Se reutiliza en tres sitios: cabecera de la app móvil, centro de la cabecera del Monitor (con el nombre del hotel debajo), y como badge circular en cada foto de la galería del Monitor (`.viewer-photo-badge` en `Viewer.css`). Recomendado: imagen cuadrada, fondo transparente u opaco simple (el badge la recorta en un círculo).
- Los modales (Admin, código de habitación, impresión, cupones) siguen con el tema oscuro heredado de Adventures — no había referencia visual para ellos y cambiarlos no formaba parte del encargo.

---

## 10. Arquitectura técnica

### Stack
| Capa | Tecnología |
| --- | --- |
| Frontend | React 18 + Vite 7 + Bootstrap 5.3.8 CDN dark mode + React Router |
| Backend (dev) | Node.js + Express 4 (puerto 4000) |
| Backend (prod, IONOS) | `proxy.php` — reimplementa las mismas rutas en PHP puro |

### Dos backends en paralelo
Igual que Adventures: `backend/routes/*.js` (dev) y `proxy.php` (prod) implementan el mismo contrato de API por separado — **si cambias el comportamiento de una ruta en uno, replica el cambio en el otro**. Ver `CLAUDE.md` para el detalle completo.

---

## 11. Flujo de datos completo

```
CONECTAR HABITACIÓN
App → POST /printbox/find-event { code }
    → /api/v1/events/find → { uuid }

GALERÍA
App → POST /printbox/photos?page=N { event: uuid }
    → /api/v1/events/photos → { data: [...], last_page }

SUBIR/PAGAR FOTO
App → POST /printbox/photo-send { event, image: base64, times }
    → /api/v1/events/photo/send → { success: true }

AVISO A RECEPCIÓN (una vez por pedido completo)
App → POST /printbox/notify-order?hotel=<id> { room, items: [{thumbnail, copies}], total, paymentMethod }
    → lee email_recepcion del textos.txt del hotel → envía e-mail (mail() en prod / log en dev)

CONFIG (precios + email de recepción, únicos para todo el hotel)
App (panel, con sesión) → GET/POST /config
App (móvil, sin sesión) → GET /config?hotel=<id>

CUPONES (por habitación; crear/listar exigen sesión del hotel dueño de esa habitación)
Panel  → POST /coupon/create { evento, amount, type: 'discount'|'full', expires_hours }
Panel  → GET  /coupon/list?evento=<code>
Huésped → POST /coupon/validate { code, evento }   (solo comprueba)
Huésped → POST /coupon/redeem   { code, evento, order_id }   (consume, tras pago o si type=full)
```

---

## 12. Solución de problemas

**`failed to fetch` en desarrollo**
Verificar `http://localhost:4000/health`. Usar siempre `npm run dev`.

**Error 419 (CSRF)**
Reiniciar el backend Express — el CookieJar se resetea solo.

**Cámara no funciona en móvil**
Solo funciona en HTTPS. En desarrollo local solo funciona la galería.

**Recepción no recibe el e-mail**
1. Comprobar que `email_recepcion` está configurado para esa habitación (panel Admin del Monitor).
2. Revisar la carpeta de spam — `mail()` de IONOS no siempre pasa los filtros SPF/DKIM.
3. En desarrollo, el e-mail nunca se envía de verdad — solo se loguea por consola del backend Express.

**"Habitación no encontrada"**
Verificar el número de habitación (solo dígitos, sin `ev-`). Comprobar que existe como evento en el backend Laravel.

**403 en `/config` (u otra ruta) que debería dar 401 o funcionar**
Casi siempre es `config/.htaccess` bloqueando por CARPETA en vez de por FICHERO — Apache intercepta la URL `/config` porque coincide con el nombre de la carpeta real, antes de que la reescritura a `proxy.php` actúe. La regla correcta es `<FilesMatch ".">Require all denied</FilesMatch>` (ver §8). Comprobar con `curl -o /dev/null -w "%{http_code}" https://tu-dominio/config/`.

**401 en `/coupon/create` o `/coupon/list` desde el Admin**
Se ha cerrado la sesión, o el `evento` no corresponde a una habitación de ESE hotel (se comprueba contra `habitaciones.json` — devuelve 403 en ese caso, no 401).

---

## 13. Pendientes / ideas de mejora

- [ ] Primer despliegue real en IONOS (dominio ya asignado: `vf.incomar.net`) y verificación de que `mail()` entrega correctamente (spam/SPF/DKIM).
- [ ] Sustituir `hotel-logo.png` por el logo/monograma real del hotel (se reutiliza en cabecera móvil, cabecera del Monitor y badge de las fotos).
- [ ] Si la entrega de e-mail por `mail()` resulta poco fiable en la práctica, valorar migrar a SMTP real.
- [ ] PWA manifest para instalar la app móvil en pantalla de inicio.
- [ ] Rotar el token de Square (estuvo hardcodeado en el código/historial de git hasta el 15 julio; ver `CURRENT_STATUS.md`) y confirmar que `config/square.json` está subido en producción.
- [ ] Decidir si cada hotel debe tener sus propias credenciales de pago (Square/PayPal) en vez de una única cuenta compartida para todo el despliegue.
- [ ] Sin límite de intentos en `/auth/login` (fuerza bruta) — valorar un lockout o retardo tras varios fallos.

---

*Printbox Hotels v0.1.0 · Desarrollado por Alejandro · julio 2026*
