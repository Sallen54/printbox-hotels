import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  // Identificador único de cada build: el frontend lo usa para detectar que el visitante
  // viene de una versión anterior y tirar su estado guardado (ver src/shared/storage.js).
  define: {
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
  },
  base: '/',
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/index.html'),
    },
  },
  server: { port: 3000, host: true },
})