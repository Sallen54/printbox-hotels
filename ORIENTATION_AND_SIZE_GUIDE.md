# Guía de Orientación y Tamaño de Impresión (10x15 / 15x20)

## 📋 Resumen General

El sistema Printbox maneja **orientación** (portrait/landscape) y **tamaño de impresión** (10x15 cm / 15x20 cm). Estos parámetros viajan a través de todo el flujo:

- **Frontend** → envía orientación detectada
- **Backend Express (Node.js)** → actualmente NO rota las imágenes
- **Backend Laravel** → ROTA las imágenes según orientación + tamaño
- **Apps Flutter** → detectan y envían orientación

---

## 🎯 Tamaños y Orientaciones

| Tamaño | Orientación típica | Rotación |
|--------|-------------------|----------|
| **10x15 cm** | Portrait (vertical) | -90° si viene horizontal |
| **15x20 cm** | Landscape (horizontal) | 90° si viene vertical |

---

## 📍 FRONTEND - Dónde se ENVÍA la orientación

### 1. **MobileApp.jsx** - Fotos tomadas con cámara
- **Ruta**: `src/mobile/MobileApp.jsx`
- **Líneas**: 830, 919, 935, 1216

```jsx
// Línea 919 - Fotos de cámara (primer envío)
await sendPhoto({
  event: targetUuid,
  image: photo.dataUrl,
  times: 1,
  name: photo.id,
  phone: '000000000',
  orientation: 'portrait'  // ← Siempre portrait
})

// Línea 935 - Fotos de galería en paso ORDER
await sendPhoto({
  event: targetUuid,
  image: resized,
  times: 1,
  name: uniqueName,
  phone: '000000000',
  orientation: 'portrait'  // ← Siempre portrait
})

// Línea 1216 - Fotos capturadas directas (sin pedido)
await sendPhoto({
  event: uuid,
  image: photo.dataUrl,
  times: photo.copies || 1,
  name: uniqueName,
  phone: '000000000',
  orientation: 'portrait'  // ← Siempre portrait
})
```

### 2. **ViewerApp.jsx** - Fotos de galería desde visor
- **Ruta**: `src/viewer/ViewerApp.jsx`
- **Línea**: 575

```jsx
// Línea 575 - Envío de foto para impresión
const res = await sendPhoto({
  event: uuid,
  image: resized,
  times: 1,
  name: imageName,
  phone: '000000000',
  orientation: 'landscape'  // ← Siempre landscape
})
```

### 3. **shared/api.js** - Función que envía
- **Ruta**: `src/shared/api.js`
- **Línea**: 312

```jsx
export async function sendPhoto({ event, image, times = 1, name, phone, print, orientation }) {
  // Envía a /printbox/photo-send o /proxy-image + /api/v1/events/photo/send
  const data = {
    event,
    image,
    times,
    name: name || `photo-${Date.now()}`,
    print: typeof print !== 'undefined' ? print : Boolean(times > 0),
    phone,
    orientation
  }
  // ...
}
```

---

## 🔌 BACKEND EXPRESS (Node.js) - Donde se PROCESA actualmente

### 1. **backend/routes/printbox.js** - Proxy a Laravel
- **Ruta**: `backend/routes/printbox.js`
- **Líneas**: 102, 160, 169

```js
// Línea 102 - Detecta orientación automáticamente (no se usa)
const orientation = meta?.width >= meta.height ? 'landscape' : 'portrait'

// Línea 160 - Recibe orientación del frontend
const { event, image, times = 1, name, phone, print, orientation } = req.body

// Línea 169 - La pasa al payload que envía a Laravel
if (orientation) payload.orientation = orientation
```

**Endpoint**: `POST /printbox/photo-send`
- Recibe: `{event, image, times, name, phone, print, orientation}`
- Proxifica a: `POST /api/v1/events/photo/send` (Laravel)

### 2. **backend/routes/print.js** - Conversión a PDF y impresión
- **Ruta**: `backend/routes/print.js`
- **Líneas**: 106-125

```js
async function convertImageToPdf(imagePath, pdfPath) {
  const sharp = require('sharp')
  const meta = await sharp(imagePath).metadata()
  const w = meta.width || 800
  const h = meta.height || 600
  const isLandscape = w > h

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',  // ← PROBLEMA: Siempre A4, no 10x15 ni 15x20
      layout: isLandscape ? 'landscape' : 'portrait',
      margin: 0,
    })
    // ... centra la imagen pero no rota
    doc.image(imagePath, x, y, { width: dw, height: dh })
    doc.end()
  })
}
```

**PROBLEMA**: 
- ❌ No rota la imagen según orientación + tamaño
- ❌ No lee `size_print` del evento
- ❌ Siempre usa A4

### 3. **proxy.php** - Proxy desde web
- **Ruta**: `proxy.php`
- **Líneas**: 572-573

```php
if (!empty($data['orientation'])) {
    $payload['orientation'] = $data['orientation'];
}
```

---

## 🔷 BACKEND LARAVEL - Donde se ROTA correctamente

### 1. **printbox-api-laravel/app/Concerns/StorageFiles.php**
- **Ruta**: `printbox-api-laravel/app/Concerns/StorageFiles.php`
- **Líneas**: 18, 30, 35, 73, 75, 129-135

```php
class StorageFiles {
    private $orientation;  // Línea 18

    public function __construct($event, $file, $name, $orientation) {  // Línea 30
        $this->orientation = $orientation;  // Línea 35
    }

    public static function upload($event, $file, $name, $print, $times, $orientation) {  // Línea 73
        $object = new StorageFiles($event, $file, $name, $orientation);  // Línea 75
    }

    // ✅ LÓGICA CORRECTA DE ROTACIÓN (Líneas 129-135)
    public function rotateImage($image) {
        if ($this->orientation == "landscape" and $this->event->size_print == "15x20" ) {
            $image->rotate(90);  // Rota 90° si landscape + 15x20
        }
        if ($this->orientation == "portrait" and $this->event->size_print == "10x15" ) {
            $image->rotate(-90);  // Rota -90° si portrait + 10x15
        }
        return $image;
    }
}
```

### 2. **printbox-api-laravel/app/Http/Controllers/Api/EventController.php**
- **Ruta**: `printbox-api-laravel/app/Http/Controllers/Api/EventController.php`
- **Línea**: 48, 89

```php
// Línea 48 - Validación
'orientation' => 'required|in:portrait,landscape',

// Línea 89 - Pasa a StorageFiles
$file = StorageFiles::upload($event, $request->image, $request->name, 
    $request->print, $request->times, $request->orientation);
```

**Endpoint**: `POST /api/v1/events/photo/send`
- Valida orientación (portrait|landscape)
- Pasa a StorageFiles que rotea según tamaño

---

## 📱 APPS FLUTTER

### 1. **PrintBoxAdventureFlutter** - Detección y envío
- **Ruta**: `PrintBoxAdventureFlutter/lib/services/main_service.dart`
- **Línea**: 180

```dart
var imageFile = img.decodeImage(await photo.readAsBytes());

var data = {
  "event": eventCode,
  "phone": "+$phoneNumber",
  "image": "data:image/png;base64, $base64Image",
  "times": isPrint ? times : 0,
  "print": isPrint,
  "name": "${DateTime.now().millisecondsSinceEpoch}",
  "orientation": (imageFile.height > imageFile.width) ? "portrait" : "landscape",
  "ImageWidth": imageFile.width,
  "ImageHeight": imageFile.height,
};
```

### 2. **PrintBoxFlutter** - Idem
- **Ruta**: `PrintBoxFlutter/lib/services/main_service.dart`
- **Línea**: 180

Mismo código que PrintBoxAdventureFlutter.

---

## 🗂️ EVENTO - Dónde se CONFIGURA el tamaño

### EventController.php (Laravel)
- **Ruta**: `printbox-api-laravel/app/Http/Controllers/EventController.php`
- **Líneas**: 68, 137

```php
// Línea 68 - Crear evento
$sizesPrint = ["10x15" => "10x15","15x20" => "15x20"];

// Se guarda en la BD como $event->size_print
$event->size_print = $request->size_print;  // "10x15" o "15x20"
```

### Event Model (Laravel)
- Campo: `size_print` (VARCHAR, "10x15" o "15x20")
- Usado en `rotateImage()` para decidir rotación

---

## 🔄 FLUJO COMPLETO

```
1. USUARIO TOMA/SELECCIONA FOTO
   ↓
2. FRONTEND DETECTA ORIENTACIÓN
   - MobileApp: orientation = 'portrait'
   - ViewerApp: orientation = 'landscape'
   ↓
3. ENVÍA A /printbox/photo-send (Express Node.js)
   - Payload: { event, image, times, name, phone, print, orientation }
   ↓
4. Express PROXIFICA A /api/v1/events/photo/send (Laravel)
   - Mismo payload + orientation
   ↓
5. LARAVEL PROCESA
   - Valida: orientation ∈ {portrait, landscape}
   - Lee: event.size_print (10x15 o 15x20)
   - Llama: StorageFiles.upload(..., orientation)
   ↓
6. StorageFiles ROTA SEGÚN LÓGICA
   - Si orientation='landscape' && size_print='15x20' → rotate(90)
   - Si orientation='portrait' && size_print='10x15' → rotate(-90)
   ↓
7. IMPRESORA RECIBE IMAGEN ROTADA CORRECTAMENTE
```

---

## ⚠️ PROBLEMAS ACTUALES EN EXPRESS

### Backend Express NO implementa rotación

1. **print.js** (líneas 106-125):
   - ❌ No rota la imagen
   - ❌ Usa siempre A4
   - ❌ No lee `size_print` del evento

2. **printbox.js** (línea 102):
   - ✅ Detecta orientación automáticamente
   - ✅ La pasa a Laravel
   - ❌ Express mismo nunca la usa para rotar

3. **Flujo actual**:
   - Express descarga → convierte a PDF A4 → imprime sin rotar
   - Laravel recibe y guarda rotadas (no se usa)

---

## 🔧 SOLUCIÓN NECESARIA

Para que **Express maneje correctamente 10x15 / 15x20 con rotación**:

1. **Obtener `size_print` del evento**
   ```js
   const event = await findEvent(eventCode)  // Get size_print
   ```

2. **Aplicar rotación en `convertImageToPdf()`**
   ```js
   if (orientation === 'landscape' && event.size_print === '15x20') {
     image = image.rotate(90)
   }
   if (orientation === 'portrait' && event.size_print === '10x15') {
     image = image.rotate(-90)
   }
   ```

3. **Cambiar tamaño PDF según `size_print`**
   - Actualmente: siempre A4 (210×297mm)
   - Debería ser: 15x20cm (148×200mm) o 10x15cm (100×150mm)

---

## 📝 RESUMEN DE ARCHIVOS

| Archivo | Líneas | Qué hace |
|---------|--------|----------|
| `src/mobile/MobileApp.jsx` | 830, 919, 935, 1216 | Envía orientation='portrait' |
| `src/viewer/ViewerApp.jsx` | 575 | Envía orientation='landscape' |
| `src/shared/api.js` | 312 | Función sendPhoto con orientation |
| `backend/routes/printbox.js` | 102, 160, 169 | Detecta y proxifica orientation |
| `backend/routes/print.js` | 106-125 | ❌ NO rota, siempre A4 |
| `proxy.php` | 572-573 | Proxifica orientation |
| `printbox-api-laravel/app/Concerns/StorageFiles.php` | 18, 30, 35, 73, 129-135 | ✅ ROTA correctamente |
| `printbox-api-laravel/app/Http/Controllers/Api/EventController.php` | 48, 89 | Valida y pasa orientation |
| `PrintBoxAdventureFlutter/lib/services/main_service.dart` | 180 | Detecta y envía orientation |
| `PrintBoxFlutter/lib/services/main_service.dart` | 180 | Detecta y envía orientation |

