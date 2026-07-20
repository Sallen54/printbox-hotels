const fs = require('fs-extra')
const path = require('path')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')

// Ficheros de config/ que NUNCA deben viajar en el build ni acabar en el webroot:
// credenciales de cobro, secreto de sesión, cuentas de hotel y datos de cupones.
// Se suben (o se generan) UNA VEZ en el servidor y el deploy no los toca.
// El resto de config/ (textos, precios, habitaciones, logos, .htaccess) sí se copia,
// que es lo que esperaba el flujo de despliegue existente.
const SECRET_PATTERNS = [
  /^square\.json$/i,
  /^paypal\.json$/i,
  /^session_secret\.txt$/i,
  /^hotels\.json$/i,
  /^coupon_secret\.txt$/i,
  /^cupones-.*\.(json|txt)$/i,
  /\.log$/i,
]

function isSecret(fullPath) {
  const name = path.basename(fullPath)
  return SECRET_PATTERNS.some((re) => re.test(name))
}

async function copyAssets() {
  await fs.ensureDir(dist)
  await fs.copy(path.join(root, '.htaccess'), path.join(dist, '.htaccess'), { overwrite: true })
  await fs.copy(path.join(root, 'proxy.php'), path.join(dist, 'proxy.php'), { overwrite: true })

  await fs.copy(path.join(root, 'config'), path.join(dist, 'config'), {
    overwrite: true,
    filter: (src) => !isSecret(src),
  })

  // Limpieza: si un build anterior dejó secretos dentro de dist/, se borran ahora.
  const distConfig = path.join(dist, 'config')
  let removed = 0
  const walk = async (dir) => {
    if (!(await fs.pathExists(dir))) return
    for (const entry of await fs.readdir(dir)) {
      const full = path.join(dir, entry)
      const stat = await fs.stat(full)
      if (stat.isDirectory()) await walk(full)
      else if (isSecret(full)) { await fs.remove(full); removed++ }
    }
  }
  await walk(distConfig)

  console.log('Copied .htaccess, proxy.php and config to dist/ (secrets excluded)')
  if (removed) console.log(`Removed ${removed} secret file(s) left by a previous build`)
}

copyAssets().catch((err) => {
  console.error('Error copying dist assets:', err)
  process.exit(1)
})
