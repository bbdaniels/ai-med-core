import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

// VITE_APP picks the page a build serves: unset for the simulator page
// (src/main.tsx), "talk" for the talk page (src/talk-main.tsx). index.html stays
// one file; this plugin rewrites its entry script before Vite reads it, in both
// `vite build` and `vite dev`.
function appEntry(): Plugin {
  const app = process.env.VITE_APP || ''
  if (app !== '' && app !== 'talk') {
    throw new Error(`VITE_APP must be unset or "talk", not "${app}"`)
  }
  // A talk build of a project that does not declare app:"talk" is a mistake in
  // the build step, not something to ship.
  const slug = process.env.VITE_PROJECT
  if (app === 'talk' && slug) {
    const file = path.resolve(__dirname, '../../projects', slug, 'project.json')
    if (fs.existsSync(file)) {
      const declared = JSON.parse(fs.readFileSync(file, 'utf8')).app
      if (declared !== 'talk') {
        throw new Error(`VITE_APP=talk, but project ${slug} declares app ${JSON.stringify(declared ?? null)}`)
      }
    }
  }
  return {
    name: 'app-entry',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (app !== 'talk') return html
        if (!html.includes('/src/main.tsx')) throw new Error('index.html no longer loads /src/main.tsx')
        return html.replace('/src/main.tsx', '/src/talk-main.tsx')
      },
    },
  }
}

export default defineConfig({
  plugins: [react(), appEntry()],
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