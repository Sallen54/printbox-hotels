// Estado guardado en el navegador entre visitas.
//
// Al desplegar una versión nueva, un localStorage con la forma antigua puede dejar la app
// en un estado incoherente (precios viejos, un paso que ya no existe). Comparando el
// identificador de build se detecta al visitante que viene de la versión anterior y se
// tira su estado. Las cookies NO se tocan: ahí vive la sesión del hotel y borrarla
// echaría a recepción cada vez que se sube una actualización.
export const BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'

const VERSION_KEY = 'printbox_build'

export function clearStorageOnNewBuild(keys) {
  try {
    if (localStorage.getItem(VERSION_KEY) === BUILD_ID) return false
    keys.forEach((k) => localStorage.removeItem(k))
    localStorage.setItem(VERSION_KEY, BUILD_ID)
    return true
  } catch {
    return false
  }
}
