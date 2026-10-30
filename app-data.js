'use strict';
/* ───────────────────────── DADOS LOCAIS ─────────────────────────
   Liga a interface ao banco local (IndexedDB), às contas locais, ao backend local e ao pagamento simulado.
   `api` mantém a mesma interface do app original (col/doc/watchCol/watchDoc/set/add/update/del/upload/call/...). */
const api = {};
const APP = { store: null, idb: null, auth: null, backend: null, backup: null, ready: false, lock: null };
const SESSION = { user: null, listeners: [] };
function emitAuth() { SESSION.listeners.forEach(f => f(SESSION.user)); }
const onAuth = (f) => { SESSION.listeners.push(f); f(SESSION.user); };

/* Imagens guardadas no IndexedDB são referenciadas como "mmimg:<id>"; viram URLs temporárias (blob:) só para exibir. */
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
}
/** Expira reservas/pedidos pendentes e substituições vencidas ao abrir, ao voltar à aba e a cada 30 s. */
let sweepBusy = false;
async function runSweep() { if (sweepBusy || !APP.backend) return; sweepBusy = true; try { await APP.backend.call('runMaintenance', {}, {}); } catch (e) { console.warn('manutenção', e); } finally { sweepBusy = false; } }
function maintenanceLoop() { runSweep(); setInterval(runSweep, 30000); document.addEventListener('visibilitychange', () => { if (!document.hidden) runSweep(); }); }
