/* Meu Mercado Teste — inicialização de dados
 * Local (IndexedDB) por padrão; se firebase-config.js estiver ativo, usa Firestore compartilhado.
 */
const MM = { version: '1.1.0-firebase' };
const APP = { ready: false, mode: 'local' };
const SESSION = { user: null };
const api = {};
const authListeners = new Set();
function onAuth(fn) { authListeners.add(fn); if (SESSION.user !== undefined) try { fn(SESSION.user); } catch (e) { console.error(e); } return () => authListeners.delete(fn); }
function emitAuth() { authListeners.forEach(fn => { try { fn(SESSION.user); } catch (e) { console.error(e); } }); }

const imgUrlCache = new Map();
async function imgObjectURL(id) {
  if (imgUrlCache.has(id)) return imgUrlCache.get(id);
  const rec = await APP.idb.blobs.get(id); if (!rec) return null;
  const u = URL.createObjectURL(new Blob([rec.bytes], { type: rec.mime })); imgUrlCache.set(id, u); return u;
}
function hydrateImg(el, src) {
  const id = String(src).slice(6);
  if (!APP.idb) { el.dispatchEvent(new Event('error')); return; }
  imgObjectURL(id).then(u => { if (u) el.src = u; else el.dispatchEvent(new Event('error')); }).catch(() => el.dispatchEvent(new Event('error')));
}

async function initData() {
  // 1) Tenta Firebase compartilhado
  let fb = { enabled: false };
  if (typeof MMFirebase !== 'undefined' && window.FIREBASE_ENABLED && window.FIREBASE_CONFIG) {
    try {
      fb = await MMFirebase.initFirebase();
    } catch (e) {
      console.error('[firebase] falha ao iniciar, caindo para modo local:', e);
      fb = { enabled: false, error: e };
    }
  }

  if (fb.enabled) {
    APP.mode = 'firebase';
    // IndexedDB ainda usado só para blobs/imagens locais e meta
    const idb = await MMIdb.open({ name: 'mm-teste-fb-blobs' });
    APP.lock = { ok: true }; // sem trava de aba única no modo compartilhado
    const store = new MMStore.Store(fb.persistence);
    await store.open();
    if (fb.persistence.attachStore) fb.persistence.attachStore(store);
    try { await idb.migrate(store); } catch (e) { console.warn('migrate', e); }
    const auth = MMAuth.create(store, { appVersion: MM.version });
    const provider = MMPay.create(store);
    const backend = MMBackend.createBackend({ store, auth, provider });
    const a = MMApi.create({ store, auth, backend, blobs: idb.blobs, idb: MMIdb });
    Object.assign(api, a); api.mode = 'firebase';
    Object.assign(APP, { store, idb, auth, backend, provider, firebase: fb });
    APP.backup = MMBackup.create({ store, blobs: idb.blobs, metaGet: idb.metaGet, metaSet: idb.metaSet, version: MM.version, dataSchema: MMIdb.DATA_SCHEMA,
      resetExtra: async () => {
        Object.keys(localStorage).filter(k => k.startsWith('mm.')).forEach(k => localStorage.removeItem(k));
        imgUrlCache.forEach(u => URL.revokeObjectURL(u)); imgUrlCache.clear();
        // limpa também Firestore
        try {
          if (fb.persistence.replaceAll) await fb.persistence.replaceAll([]);
        } catch (e) { console.warn(e); }
      } });
    auth.onChange((u) => { SESSION.user = u; emitAuth(); });
    await auth.restore();
    APP.ready = true;
    maintenanceLoop();
    console.info('[Meu Mercado] Modo Firebase ativo — dados compartilhados entre dispositivos.');
    return;
  }

  // 2) Modo local (IndexedDB)
  APP.mode = 'local';
  const idb = await MMIdb.open();
  const lock = await MMIdb.acquireInstanceLock(); APP.lock = lock;
  if (!lock.ok) throw new MMIdb.MMError('locked', 'O Meu Mercado Teste já está aberto em outra aba ou janela deste navegador. Os dados ficam em memória em cada aba, então só uma pode escrever por vez. Feche a outra aba e recarregue.');
  const store = new MMStore.Store(idb.persistence); await store.open(); await idb.migrate(store);
  const auth = MMAuth.create(store, { appVersion: MM.version });
  const provider = MMPay.create(store);
  const backend = MMBackend.createBackend({ store, auth, provider });
  const a = MMApi.create({ store, auth, backend, blobs: idb.blobs, idb: MMIdb });
  Object.assign(api, a); api.mode = 'local';
  Object.assign(APP, { store, idb, auth, backend, provider });
  APP.backup = MMBackup.create({ store, blobs: idb.blobs, metaGet: idb.metaGet, metaSet: idb.metaSet, version: MM.version, dataSchema: MMIdb.DATA_SCHEMA,
    resetExtra: async () => { Object.keys(localStorage).filter(k => k.startsWith('mm.')).forEach(k => localStorage.removeItem(k)); imgUrlCache.forEach(u => URL.revokeObjectURL(u)); imgUrlCache.clear(); await idb.metaSet('dataSchema', MMIdb.DATA_SCHEMA); } });
  auth.onChange((u) => { SESSION.user = u; emitAuth(); });
  await auth.restore();
  idb.persist().catch(() => {});
  APP.ready = true;
  maintenanceLoop();
  console.info('[Meu Mercado] Modo local (IndexedDB). Para compartilhar entre celulares, configure o Firebase (veja FIREBASE.md).');
}

let sweepBusy = false;
async function runSweep() { if (sweepBusy || !APP.backend) return; sweepBusy = true; try { await APP.backend.call('runMaintenance', {}, {}); } catch (e) { console.warn('manutenção', e); } finally { sweepBusy = false; } }
function maintenanceLoop() { runSweep(); setInterval(runSweep, 30000); document.addEventListener('visibilitychange', () => { if (!document.hidden) runSweep(); }); }

// Garante acesso global (GitHub Pages / service worker / ordem de scripts)
if (typeof window !== 'undefined') {
  window.initData = initData;
  window.APP = APP;
  window.SESSION = SESSION;
  window.api = api;
  window.onAuth = onAuth;
  window.MM = MM;
  window.runSweep = runSweep;
  window.maintenanceLoop = maintenanceLoop;
  window.hydrateImg = hydrateImg;
}
