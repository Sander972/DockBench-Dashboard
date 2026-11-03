import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig, type Plugin } from 'vite'

// Emits /sw.js from src/sw.js with this build's precache list: every chunk and stylesheet, the Latin font subsets (other subsets are cached on first use), the shell and the icons. The version hashes that list (hashed names) plus the unhashed files, so any deploy that changes one installs a new worker.
function serviceWorker(): Plugin {
  return {
    name: 'dockbench-sw',
    apply: 'build',
    generateBundle(_, bundle) {
      const files = Object.keys(bundle).filter(f => /\.(js|css)$/.test(f) || /-latin-wdth-normal-.*\.woff2$/.test(f))
      const statics = ['manifest.webmanifest', 'favicon.png', 'icons/icon-192.png']
      const precache = ['/index.html', ...statics.map(f => '/' + f), ...files.map(f => '/' + f)]
      const sw = readFileSync('src/sw.js', 'utf8')
      const hash = createHash('sha256').update(precache.join()).update(sw).update(readFileSync('index.html'))
      for (const f of statics) hash.update(readFileSync('public/' + f))
      const version = hash.digest('hex').slice(0, 12)
      const source = `const VERSION = ${JSON.stringify(version)}\nconst PRECACHE = ${JSON.stringify(precache)}\n` + sw
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

// Preloads the Latin UI font from the shell, so it downloads alongside the JS instead of after the stylesheet has been parsed, and the first text paints in Archivo rather than swapping from the fallback.
function preloadFont(): Plugin {
  return {
    name: 'dockbench-preload-font',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (_, ctx) => Object.keys(ctx.bundle ?? {}).filter(f => /archivo-latin-wdth-normal-.*\.woff2$/.test(f)).map(f => ({ tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: '/' + f, crossorigin: '' }, injectTo: 'head' as const })),
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), serviceWorker(), preloadFont()],
  build: {
    rolldownOptions: {
      // the framework changes far less often than the app, so a deploy keeps it cached
      output: { codeSplitting: { groups: [{ name: 'vue', test: /node_modules[\\/](@vue|vue|vue-router)[\\/]/ }] } },
    },
  },
  server: { proxy: { '/api': 'http://localhost:3001' } },
})
