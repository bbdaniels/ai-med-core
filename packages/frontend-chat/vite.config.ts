import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  // For GitHub Pages: set VITE_BASE_PATH at build time (e.g. "/ai-med/demo/")
  base: process.env.VITE_BASE_PATH || '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // enketo-core internal module aliases (see enketo-core/package.json "browser" field)
      'enketo/config': path.resolve(__dirname, '../../node_modules/enketo-core/config.js'),
      'enketo/widgets': path.resolve(__dirname, '../../node_modules/enketo-core/src/js/widgets.js'),
      'enketo/translator': path.resolve(__dirname, '../../node_modules/enketo-core/src/js/fake-translator'),
      'enketo/dialog': path.resolve(__dirname, '../../node_modules/enketo-core/src/js/fake-dialog'),
      'enketo/file-manager': path.resolve(__dirname, '../../node_modules/enketo-core/src/js/file-manager'),
      'enketo/xpath-evaluator-binding': path.resolve(__dirname, '../../node_modules/enketo-core/src/js/xpath-evaluator-binding'),
      // Stub unused enketo-core deps (map/geo widgets not needed)
      'leaflet.gridlayer.googlemutant': path.resolve(__dirname, './src/stubs/empty.js'),
      'leaflet-draw': path.resolve(__dirname, './src/stubs/empty.js'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/t': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
})