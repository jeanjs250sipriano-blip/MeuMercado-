
/* ───────────────────────── PWA ───────────────────────── */
let swReg = null;
function setupPWA() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.install = e; });
  window.addEventListener('appinstalled', () => { S.install = null; toast('Meu Mercado instalado!', 'ok'); });
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    swReg = reg;
    const offer = (w) => { const b = h('div', { class: 'alert', style: { position: 'fixed', left: '12px', right: '12px', bottom: '84px', zIndex: 60, display: 'flex', gap: '10px', alignItems: 'center', justifyContent: 'space-between' } }, 'Há uma versão nova do app.', h('button', { class: 'btn sm', onclick: () => { w.postMessage('SKIP_WAITING'); } }, 'Atualizar')); document.body.append(b); };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => { const w = reg.installing; w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); }); });
  }).catch((e) => console.warn('Service worker não registrado:', e));
  let reloaded = false; navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloaded) return; reloaded = true; location.reload(); });
}

/* ───────────────────────── BOOT ───────────────────────── */
async function boot() {
  try {
    const init = typeof initData === 'function' ? initData : (typeof window !== 'undefined' && window.initData);
    if (typeof init !== 'function') {
      throw new Error('app-data.js não carregou (initData ausente). Confira se app-data.js está na mesma pasta do index.html e limpe o cache / service worker.');
    }
    await init();
    APP.hasAdmin = await APP.auth.hasAdmin();
  }
  catch (e) {
    console.error(e);
    const bar = document.getElementById('sim-bar'); if (bar) bar.hidden = true;
    const app = document.getElementById('app');
    const msg = (e && e.message) || 'Erro desconhecido';
    if (app) app.replaceChildren(h('div', { class: 'card stack center', style: { maxWidth: '560px', margin: '40px auto' } },
      h('h2', null, 'Não foi possível iniciar o simulador'),
      h('p', null, msg),
      h('p', { class: 'tiny muted' }, 'Abra no navegador: SEU_SITE/app-data.js — se der 404, o arquivo não está no GitHub Pages.'),
      h('button', { class: 'btn', onclick: async () => {
        try {
          if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.unregister()));
          }
          if (window.caches) {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
          }
        } catch (_) {}
        location.reload(true);
      } }, 'Limpar cache e tentar de novo')));
    return;
  }
  setupPWA();
  let lastUid;
  onAuth((u) => { const id = u ? u.uid : null; if (id === lastUid && boot.done) return; lastUid = id; startNotifWatch(); if (boot.done) { CartStore.mergeDown && CartStore.mergeDown(); navigate(); } });
  window.addEventListener('hashchange', navigate);
  window.addEventListener('online', () => toast('Conexão restabelecida (o simulador funciona sem internet)', 'ok'));
  window.addEventListener('offline', () => toast('Sem internet. O simulador continua funcionando: tudo é local.', 'ok'));
  updateBadges(); await navigate(); boot.done = true;
}
boot().catch((e) => console.error('boot', e));
