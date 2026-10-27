// Guarda el pedido en curso en el propio móvil para que recargar la página (o que el
// navegador descarte la pestaña) no borre las fotos elegidas.
//
// Va en IndexedDB y no en localStorage por dos razones: admite objetos `File` tal cual —y
// desde que la foto se sube original, el pedido son ficheros, no texto— y no tiene el tope
// de ~5 MB que un pedido de 80 fotos revienta de largo.
//
// El pedido caduca por inactividad: si nadie lo toca durante CADUCIDAD_MS, se borra solo.
// Así el huésped que deja el móvil a medias no se encuentra días después un carrito viejo,
// y las fotos no se quedan ahí indefinidamente.

const BD = 'printbox_pedido'
const ALMACEN = 'pedido'
const CLAVE = 'actual'

export const CADUCIDAD_MS = 2 * 60 * 60 * 1000 // 2 horas

function abrir() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('Sin IndexedDB'))
    const req = indexedDB.open(BD, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(ALMACEN)) db.createObjectStore(ALMACEN)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('No se pudo abrir IndexedDB'))
  })
}

function operar(modo, fn) {
  return abrir().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(ALMACEN, modo)
    const req = fn(tx.objectStore(ALMACEN))
    tx.oncomplete = () => { db.close(); resolve(req?.result) }
    tx.onerror = () => { db.close(); reject(tx.error) }
    tx.onabort = () => { db.close(); reject(tx.error) }
  }))
}

// Las fotos se guardan con su `File` original; `thumb` ya es una cadena pequeña.
export async function guardarPedido({ fotos, hotelId, eventCode, step }) {
  try {
    await operar('readwrite', (almacen) => almacen.put({
      ts: Date.now(),
      hotelId,
      eventCode,
      step,
      fotos: (fotos || []).map(f => ({
        id: f.id,
        file: f.file || null,
        dataUrl: f.file ? null : (f.dataUrl || null), // solo la foto de cámara viaja en base64
        thumb: f.thumb || null,
        orientation: f.orientation || 'portrait',
        copies: f.copies || 1,
      })),
    }, CLAVE))
    return true
  } catch {
    return false // sin IndexedDB (modo privado, cuota) se sigue sin guardar: no es crítico
  }
}

// Devuelve el pedido guardado, o null si no hay o si ha caducado (y entonces lo borra).
export async function leerPedido() {
  try {
    const guardado = await operar('readonly', (almacen) => almacen.get(CLAVE))
    if (!guardado) return null
    if (Date.now() - (guardado.ts || 0) > CADUCIDAD_MS) {
      await borrarPedido()
      return null
    }
    return guardado
  } catch {
    return null
  }
}

export async function borrarPedido() {
  try {
    await operar('readwrite', (almacen) => almacen.delete(CLAVE))
    return true
  } catch {
    return false
  }
}

// Momento del último cambio, para saber cuánto lleva el pedido sin tocarse.
export async function ultimaActividad() {
  try {
    const guardado = await operar('readonly', (almacen) => almacen.get(CLAVE))
    return guardado?.ts || 0
  } catch {
    return 0
  }
}
