/* Service worker de Mostrador.
 *
 * - HTML (la app entera es un solo index.html): RED PRIMERO, con la copia en
 *   caché como respaldo. Así una versión nueva llega apenas hay internet y sin
 *   internet la app abre igual.
 * - Íconos y manifest: caché primero (no cambian entre versiones).
 * - .wasm del lector de códigos (zxing en jsDelivr): caché primero en una caché
 *   de "runtime" que sobrevive a las versiones (pesa ~1 MB, no tiene sentido
 *   bajarlo de nuevo en cada actualización).
 * - El resto de los dominios externos (PeerJS, Open Food Facts…) NO se
 *   interceptan: son en vivo y no tienen sentido sin red.
 * - La versión nueva queda "esperando" hasta que el usuario toca "Actualizar"
 *   (banners.jsx manda {type:'SKIP_WAITING'}): nunca se cambia la app debajo de
 *   una venta a medio cobrar.
 *
 * tools/postbuild.mjs reemplaza e7818f8fa6 por un hash del build.
 */
const VERSION = 'e7818f8fa6'
const CACHE = 'mostrador-' + VERSION
const RUNTIME = 'mostrador-runtime'
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png', './favicon-32.png']
const WASM_HOSTS = ['cdn.jsdelivr.net', 'fastly.jsdelivr.net']
const STATIC_RE = /\.(?:png|svg|ico|webmanifest|woff2?)$/i

/** Decide la estrategia para una petición. Puro: lo usan las pruebas. */
function route(request, scopeUrl) {
  if (request.method !== 'GET') return null
  const url = new URL(request.url)
  const scope = new URL(scopeUrl)
  if (url.origin !== scope.origin) {
    if (WASM_HOSTS.includes(url.hostname) && /\.wasm$/i.test(url.pathname)) return 'wasm'
    return null
  }
  if (!url.pathname.startsWith(scope.pathname)) return null
  if (url.pathname.endsWith('/sw.js')) return null
  // Antes que "navigate": abrir un ícono en una pestaña tiene que dar el ícono, no la app.
  if (STATIC_RE.test(url.pathname)) return 'static'
  const accept = (request.headers && request.headers.get && request.headers.get('accept')) || ''
  if (request.mode === 'navigate' || accept.includes('text/html') || url.pathname === scope.pathname || /\/index\.html$/.test(url.pathname)) return 'html'
  return 'same'
}

async function networkFirstHtml(request) {
  const cache = await caches.open(CACHE)
  try {
    const res = await fetch(request, { cache: 'no-store' })
    if (res && res.ok) cache.put('./index.html', res.clone()).catch(() => {})
    return res
  } catch (e) {
    const hit = (await cache.match('./index.html')) || (await cache.match('./')) || (await caches.match(request, { ignoreSearch: true }))
    if (hit) return hit
    throw e
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(request, { ignoreSearch: cacheName === CACHE })
  if (hit) return hit
  const res = await fetch(request)
  // Las respuestas "opaque" (CORS sin cabeceras) también se guardan: el wasm se pide con fetch normal.
  if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone()).catch(() => {})
  return res
}

async function networkThenCache(request) {
  const cache = await caches.open(CACHE)
  try {
    const res = await fetch(request)
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {})
    return res
  } catch (e) {
    const hit = await cache.match(request, { ignoreSearch: true })
    if (hit) return hit
    throw e
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // allSettled: si falta un ícono, la app igual queda disponible sin red.
      Promise.allSettled(PRECACHE.map((u) => cache.add(new Request(u, { cache: 'reload' })))),
    ),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k.startsWith('mostrador-') && k !== CACHE && k !== RUNTIME).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  const data = event.data || {}
  if (data.type === 'SKIP_WAITING') self.skipWaiting()
  else if (data.type === 'GET_VERSION' && event.source) event.source.postMessage({ type: 'VERSION', version: VERSION })
})

self.addEventListener('fetch', (event) => {
  const kind = route(event.request, self.registration ? self.registration.scope : self.location.href)
  if (kind === 'html') event.respondWith(networkFirstHtml(event.request))
  else if (kind === 'static') event.respondWith(cacheFirst(event.request, CACHE))
  else if (kind === 'wasm') event.respondWith(cacheFirst(event.request, RUNTIME))
  else if (kind === 'same') event.respondWith(networkThenCache(event.request))
  // null → no se intercepta: el navegador hace la petición normal.
})

self.__mostrador = { route, VERSION, CACHE, RUNTIME, PRECACHE }
