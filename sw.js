/* Meu Mercado Teste — Service Worker
 * Simulador 100% local: guarda em cache apenas os arquivos estáticos do próprio app (shell),
 * para abrir offline. Os DADOS ficam no IndexedDB e nunca passam pelo service worker.
 * Não há chamadas a serviços externos. Caminhos relativos (funciona em subpasta do GitHub Pages).
 */
const VERSION = 'mmt-v1.0.0';
const SHELL = `shell-${VERSION}`;
const SHELL_FILES = [
  './', './index.html', './styles.css', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png',
  './mm-store.js', './mm-idb.js', './mm-auth.js', './mm-pay.js', './business-rules.js', './mm-backend.js', './mm-api.js', './mm-backup.js',
  './app-core.js', './app-data.js', './app-shell.js', './app-customer.js', './app-checkout.js', './app-market.js', './app-admin.js', './app-admin2.js', './app-boot.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (event) => { if (event.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // nunca intercepta outras origens
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }
  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => { if (res && res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone())); return res; }).catch(() => hit);
      return hit || net;
    })
  );
});
