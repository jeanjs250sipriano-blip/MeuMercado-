
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
  try { await initData(); APP.hasAdmin = await APP.auth.hasAdmin(); }
  catch (e) {
    console.error(e);
    $('#sim-bar').hidden = true;
    $('#app').replaceChildren(h('div', { class: 'card stack center', style: { maxWidth: '560px', margin: '40px auto' } }, h('h2', null, 'Não foi possível iniciar o simulador'), h('p', null, (e && e.message) || 'Erro desconhecido ao abrir o armazenamento local.'), h('button', { class: 'btn', onclick: () => location.reload() }, 'Tentar novamente')));
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
