// Service worker, emitted as /sw.js by the `serviceWorker` plugin in vite.config.ts, which prepends VERSION and PRECACHE (the build's chunks, CSS, Latin fonts, icons and index.html).
/* global VERSION, PRECACHE */
const CACHE = `dockbench-${VERSION}`

// Hashed /assets/ files never change, so one already cached by an older version is copied instead of downloaded again.
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await Promise.all(PRECACHE.map(async url => {
      const old = url.startsWith('/assets/') && (await caches.match(url))
      await cache.put(url, old || (await fetch(url, { cache: 'reload' }).then(r => { if (!r.ok) throw new Error(`${url} ${r.status}`); return r })))
    }))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('dockbench-') && k !== CACHE) await caches.delete(k)
    await self.clients.claim()
  })())
})

// The API always goes to the network. Navigations get the cached shell, so the app paints with no round trip; static files come from the cache, and other /assets/ files (non-Latin font subsets) are cached on first use.
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('/index.html').then(r => r || fetch(req)))
    return
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r.ok && url.pathname.startsWith('/assets/')) {
      const copy = r.clone()
      e.waitUntil(caches.open(CACHE).then(c => c.put(req, copy)))
    }
    return r
  })))
})

// a tap on a system notification focuses the open dashboard (or opens one) on the notification's page
self.addEventListener('notificationclick', e => {
  e.notification.close()
  const target = new URL(e.notification.data?.url || '/', location.origin).href
  e.waitUntil((async () => {
    const [win] = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (!win) return self.clients.openWindow(target)
    await win.focus()
    win.postMessage({ type: 'navigate', url: target })
  })())
})
