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
2. Sube fotos que ya tiene guardadas en el móvil o hace fotos nuevas con la cámara (no ve las fotos de otros).
3. Paga (tarjeta vía Square o PayPal) o las sube gratis desde la cámara.
4. **Recepción recibe un e-mail automático** con miniaturas de las fotos, número de copias y el resumen de lo pagado.
5. Recepción imprime las fotos (con el mismo "Panel de Control"/Printer que ya usa Adventures) y se las entrega al huésped.

### Alta de un hotel (lo hace Printbox)

Las cuentas **las crea Printbox** (no hay auto-registro), con el script local `scripts/add-hotel.js`, y se suben por FTP a `config/` (ver §14):

```bash
node scripts/add-hotel.js --id marbella --nombre "Hotel Marbella" --user recepcion --pass "claveSegura"
node scripts/add-hotel.js --list                          # ver hoteles
node scripts/add-hotel.js --id marbella --pass "nueva"    # resetear contraseña
```

Esto añade la cuenta a `config/hotels.json` (contraseña cifrada con bcrypt) y crea `config/hotels/marbella/`.

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

> ⚠️ La cámara del móvil solo funciona en **HTTPS** (producción). En desarrollo local solo funciona la galería.

---

## 4. Despliegue web en IONOS (Apache)

Igual que Adventures: como IONOS no permite Node.js, el backend Express se reemplaza en producción por un **proxy PHP** (`proxy.php`).

### Archivos necesarios en IONOS (raíz del subdominio)
```
/  (raíz del subdominio de Printbox Hotels)
├── index.html          ← del dist/
├── assets/              ← del dist/ (incluye hotel-logo.png — sustituir por el logo real del hotel)
├── proxy.php            ← reemplaza el backend Express (incluye envío de e-mail con mail() nativo)
├── .htaccess            ← enruta las llamadas API al proxy
└── config/              ← carpeta con permisos de escritura (chmod 755)
    ├── servidor_api.txt
    └── textos.txt
```

### Pasos para publicar
```bash
npm run build
```
Sube por FTP a la raíz del subdominio: todo `dist/` (ya incluye `proxy.php`, `.htaccess`, `config/` copiados automáticamente por `scripts/copy-dist-assets.js`).

> ⚠️ **No sobreescribir `config/`** si ya tiene datos (cuentas, secreto de sesión, config de los hoteles). Sube solo los `assets/`, `index.html`, `proxy.php` y `.htaccess` — nunca la carpeta `config/` entera.
>
> ⚠️ **La primera vez**, sube manualmente `config/.htaccess` (deniega el acceso HTTP a las cuentas y la config). Y sube el `config/hotels.json` y las carpetas `config/hotels/<id>/` que hayas generado en local con `add-hotel.js`.

**Alta de hoteles (Printbox):** el hosting IONOS no tiene Node, así que las cuentas se crean **en local** con `node scripts/add-hotel.js ...` (§1) y luego se suben por FTP los ficheros resultantes (`config/hotels.json` y `config/hotels/<id>/`).

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
│   └── routes/
│       ├── printbox.js  Proxy → gestion.printboxweb.com + POST /notify-order (dev: solo loguea)
│       ├── print.js     Descarga → PDF → imprime
│       └── config.js    Lee/escribe config/*.txt (incluye email_recepcion)
│
├── src/
│   ├── main.jsx         React Router — /viewer /mobile /printer
│   ├── public/assets/
│   │   └── hotel-logo.png   ← SUSTITUIR por el logo real del hotel
│   ├── styles/global.css    Paleta de colores centralizada (variables --pb-*)
│   ├── shared/api.js         Todas las llamadas HTTP, incluida notifyRoomOrder()
│   ├── viewer/ViewerApp.jsx   Monitor de recepción + Admin (precios + email de recepción)
│   ├── printer/PrinterApp.jsx Impresión física
│   └── mobile/MobileApp.jsx   App del huésped (galería, cámara, pedido, pago, aviso a recepción)
│
├── config/
│   ├── servidor_api.txt
│   └── textos.txt
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
2. En la cabecera tiene tres opciones: el icono de **galería** (📷🖼️, abre el selector nativo del móvil para subir fotos que ya tiene guardadas), el icono de **cámara** (hacer una foto nueva en el momento), o seleccionar alguna de las fotos que ya hubiera en la habitación.
3. "Ver pedido" → elige copias por foto (1/2/3) y ve el precio.
4. Paga con tarjeta (Square) o PayPal — o si son solo fotos de cámara, puede subirlas gratis con "Subir fotos directamente".
5. Al completar el envío, **recepción recibe automáticamente el e-mail** con miniaturas + copias + resumen del pago (ver sección 7).
6. Las fotos quedan pendientes de imprimir en el Monitor/Printer de recepción.

### 6.2 Monitor / Admin — `/viewer`

Pantalla para recepción: introduce el número de habitación, ve la galería, imprime fotos manualmente, y desde **Configuración** (contraseña) ajusta precios, empresa y **el e-mail de recepción** para esa habitación.

### 6.3 Printer — `/printer`

Igual que en Adventures: hace polling de las fotos marcadas para imprimir, genera PDF y las envía a la impresora física conectada en recepción.

---

## 7. Aviso por e-mail a recepción

**Cada vez que una habitación envía fotos** (ya sea tras un pago o con el botón gratis de "Subir fotos directamente" desde la cámara), se dispara **una sola llamada** a `POST /printbox/notify-order` con:

```json
{ "room": "1204", "items": [{ "thumbnail": "data:image/jpeg;base64,...", "copies": 2 }], "total": "9.00", "paymentMethod": "Tarjeta (Square)" }
```

- El thumbnail se genera **en el propio móvil**, a partir de la foto que ya se está enviando (no se pide nada a ninguna API externa).
- Un pedido con una foto a 3 copias genera **una fila** en el email (no 3 envíos).

### En producción (IONOS / `proxy.php`)
Lee el e-mail de recepción del hotel (`email_recepcion` en `config/textos.txt` — único para todo el despliegue) y envía un email HTML con las miniaturas embebidas inline (MIME `multipart/related`, sin librerías externas) usando **`mail()` nativo de PHP** — elegido deliberadamente como la opción más simple, sin SMTP ni PHPMailer.

> ⚠️ **Limitación conocida y aceptada:** la fiabilidad de `mail()` en IONOS depende de la configuración SPF/DKIM del dominio — puede terminar en spam. Si en el futuro hace falta más fiabilidad, la vía sería migrar a SMTP real (Gmail, Brevo, SendGrid, etc.), pero eso queda fuera del alcance actual a propósito.

Si la habitación no tiene `email_recepcion` configurado, el endpoint responde `{ ok: true, skipped: true }` sin enviar nada (no rompe el flujo del huésped).

### En desarrollo (`backend/routes/printbox.js`)
No hay forma sencilla de enviar e-mail real sin credenciales SMTP en local, así que el endpoint de dev **solo loguea por consola** el resumen del pedido (habitación, nº de fotos, copias, total). Es una limitación de desarrollo documentada y aceptada, igual que la cámara (que solo funciona en HTTPS de producción).

---

## 8. Archivos de configuración

> **Desarrollo:** `config/` en la raíz del proyecto.
> **Producción:** `config/` en la raíz del subdominio en IONOS (mismo sitio que `proxy.php`).

Estructura multi-hotel:

```
config/
  .htaccess               # "Require all denied": nada de config/ se sirve por HTTP
  hotels.json             # cuentas: { "<hotelId>": { user, passHash(bcrypt), nombre } }
  session_secret.txt      # secreto HMAC de sesión (se genera solo la 1ª vez)
  hotels/
    <hotelId>/            # una carpeta por hotel
      servidor_api.txt
      textos.txt
      habitaciones.json
      hotel-logo.png
```

Cada hotel se resuelve por la **sesión** (panel) o por **`?hotel=<id>`** (móvil). Si no hay `hotelId`, se lee el `config/` global (compat con el modelo antiguo de un solo hotel).

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
precio1:5
precio2:9
precio3:12
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

### `config/hotels.json` (cuentas) y `config/session_secret.txt`
Los gestiona `scripts/add-hotel.js` y el backend; **nunca** editar a mano `session_secret.txt`. Ambos quedan fuera del alcance HTTP por `config/.htaccess`.

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
App → POST /printbox/notify-order { room, items: [{thumbnail, copies}], total, paymentMethod }
    → lee email_recepcion del textos.txt global del hotel → envía e-mail (mail() en prod / log en dev)

CONFIG (precios + email de recepción, únicos para todo el hotel)
App → GET  /config
App → POST /config
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

---

## 13. Pendientes / ideas de mejora

- [ ] Primer despliegue real en IONOS (dominio ya asignado: `vf.incomar.net`) y verificación de que `mail()` entrega correctamente (spam/SPF/DKIM).
- [ ] Sustituir `hotel-logo.png` por el logo/monograma real del hotel (se reutiliza en cabecera móvil, cabecera del Monitor y badge de las fotos).
- [ ] Si la entrega de e-mail por `mail()` resulta poco fiable en la práctica, valorar migrar a SMTP real.
- [ ] PWA manifest para instalar la app móvil en pantalla de inicio.

---

*Printbox Hotels v0.1.0 · Desarrollado por Alejandro · julio 2026*
