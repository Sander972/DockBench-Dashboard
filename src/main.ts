import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { router } from './router'
import { applyPrefs } from './composables/usePrefs'
import { afterPaint } from './lib/paint'

applyPrefs()
// the router guard awaits the session check (store.init), which waits for the first paint and starts polling once signed in
createApp(App).use(router).mount('#app')

// the service worker serves the shell and the static files from its cache on the next loads; registering it waits until the page has painted and gone idle
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  afterPaint(() => navigator.serviceWorker.register('/sw.js').catch(() => {}), true)
  // a tap on a system notification while the dashboard is open opens that notification's page here
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'navigate') router.push(new URL(e.data.url).pathname)
  })
}
