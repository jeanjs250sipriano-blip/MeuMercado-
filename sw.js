/* Meu Mercado — Service Worker
 * Estratégia segura:
 *  - Shell estático (index.html, manifest, ícones): cache-first com atualização em segundo plano.
 *  - Imagens públicas de catálogo: stale-while-revalidate (cache limitado).
 *  - NUNCA armazena em cache: Firebase/Firestore/Auth/Functions, pagamentos, pedidos, estoque.
 *    Essas operações exigem validação atualizada no backend e falham de forma explícita offline.
 */
const VERSION = 'mm-v1.0.0';
const SHELL = `shell-${VERSION}`;
const IMAGES = `img-${VERSION}`;
const SHELL_FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
const MAX_IMAGES = 80;

const NEVER_CACHE = [
  'googleapis.com', 'firebaseio.com', 'cloudfunctions.net', 'firebaseapp.com/__/auth',
  'identitytoolkit', 'securetoken', 'gstatic.com/firebasejs'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)));
  // Não chama skipWaiting automaticamente: o app pede ao usuário para atualizar.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, IMAGES].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (NEVER_CACHE.some((h) => req.url.includes(h))) return; // vai direto para a rede

  // Navegação: rede primeiro, shell em cache como contingência (SPA)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Arquivos do próprio site: cache-first + revalidação
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => {
          if (res && res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone()));
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // Imagens de terceiros (fotos de produtos): stale-while-revalidate com limite
  if (req.destination === 'image') {
    event.respondWith(
      caches.open(IMAGES).then(async (cache) => {
        const hit = await cache.match(req);
        const net = fetch(req).then((res) => {
          if (res && (res.ok || res.type === 'opaque')) { cache.put(req, res.clone()); trimCache(IMAGES, MAX_IMAGES); }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
