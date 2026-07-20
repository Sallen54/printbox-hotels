const fs = require('fs-extra')
const path = require('path')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')

// Ficheros sensibles que SÍ se copian a dist/ (y por tanto viajan al servidor en el
// FTP): cuentas con hash bcrypt, secreto de sesión, credenciales de cobro y la config
// y logos de cada hotel. Se listan aquí para poder avisar por consola de que van
// dentro y para comprobar que el .htaccess que los tapa viaja con ellos.
//
// Lo único que impide servirlos por HTTP es config/.htaccess, así que este script
// aborta el build si ese fichero falta o no deniega el acceso.
//
// Para generar un dist/ sin ellos (p. ej. para compartir el build): PBH_SIN_SECRETOS=1 npm run build
const SECRET_PATTERNS = [
  /^square\.json$/i,
  /^paypal\.json$/i,
  /^session_secret\.txt$/i,
  /^hotels\.json$/i,
  /^coupon_secret\.txt$/i,
  /^cupones-.*\.(json|txt)$/i,
  /\.log$/i,
]

const SKIP_SECRETS = process.env.PBH_SIN_SECRETOS === '1'

function isSecret(fullPath) {
  return SECRET_PATTERNS.some((re) => re.test(path.basename(fullPath)))
}

async function listSecrets(dir, found = []) {
  if (!(await fs.pathExists(dir))) return found
  for (const entry of await fs.readdir(dir)) {
    const full = path.join(dir, entry)
    if ((await fs.stat(full)).isDirectory()) await listSecrets(full, found)
    else if (isSecret(full)) found.push(path.relative(dist, full))
  }
  return found
}

async function copyAssets() {
  await fs.ensureDir(dist)
  await fs.copy(path.join(root, '.htaccess'), path.join(dist, '.htaccess'), { overwrite: true })
  await fs.copy(path.join(root, 'proxy.php'), path.join(dist, 'proxy.php'), { overwrite: true })

  await fs.copy(path.join(root, 'config'), path.join(dist, 'config'), {
    overwrite: true,
    filter: (src) => !SKIP_SECRETS || !isSecret(src),
  })

  const distConfig = path.join(dist, 'config')

  if (SKIP_SECRETS) {
    // Limpieza de secretos que hubiera dejado un build anterior
    for (const rel of await listSecrets(distConfig)) {
      await fs.remove(path.join(dist, rel))
    }
    console.log('Copiado .htaccess, proxy.php y config/ a dist/ (SIN secretos)')
    return
  }

  // Red de seguridad: los secretos solo están a salvo en el servidor mientras
  // config/.htaccess los deniegue. Si no viaja, el deploy los dejaría descargables.
  const guard = path.join(distConfig, '.htaccess')
  if (!(await fs.pathExists(guard))) {
    throw new Error('dist/config/.htaccess NO existe: sin él los secretos quedarían accesibles por HTTP. Restaura config/.htaccess antes de desplegar.')
  }
  if (!/Require all denied|Deny from all/i.test(await fs.readFile(guard, 'utf8'))) {
    throw new Error('dist/config/.htaccess no deniega el acceso. Revísalo antes de desplegar.')
  }

  const secrets = await listSecrets(distConfig)
  console.log('Copiado .htaccess, proxy.php y config/ a dist/')
  if (secrets.length) {
    console.log(`\n  AVISO: ${secrets.length} fichero(s) sensible(s) van dentro de dist/ y se subirán al servidor:`)
    for (const rel of secrets) console.log(`    - ${rel}`)
    console.log('  Lo único que impide servirlos por HTTP es config/.htaccess (verificado arriba).')
    console.log('  Comprueba de vez en cuando que https://tudominio/config/square.json devuelve 403.\n')
  }
}

copyAssets().catch((err) => {
  console.error('Error copiando assets a dist/:', err.message)
  process.exit(1)
})
