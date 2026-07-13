const fs = require('fs-extra')
const path = require('path')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')

async function copyAssets() {
  await fs.ensureDir(dist)
  await fs.copy(path.join(root, '.htaccess'), path.join(dist, '.htaccess'), { overwrite: true })
  await fs.copy(path.join(root, 'proxy.php'), path.join(dist, 'proxy.php'), { overwrite: true })
  await fs.copy(path.join(root, '.well-known'), path.join(dist, '.well-known'), { overwrite: true })
  await fs.copy(path.join(root, 'config'), path.join(dist, 'config'), { overwrite: true })
  console.log('Copied .htaccess, proxy.php, .well-known and config to dist/')
}

copyAssets().catch((err) => {
  console.error('Error copying dist assets:', err)
  process.exit(1)
})
