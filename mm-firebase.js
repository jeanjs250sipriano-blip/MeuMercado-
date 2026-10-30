/* Meu Mercado — adaptador Firebase (Firestore + Auth anônimo)
 * Quando firebase-config.js estiver presente e FIREBASE_ENABLED=true:
 *  - dados operacionais ficam na coleção Firestore `mm_docs` (compartilhados)
 *  - Auth anônimo só para as security rules exigirem request.auth != null
 *  - a lógica de contas (usuário+PIN) continua a mesma, agora no banco compartilhado
 */
(function (root) {
  'use strict';

  function pathToId(path) {
    // id estável e válido no Firestore (sem /)
    try {
      return btoa(unescape(encodeURIComponent(path))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    } catch (e) {
      return path.replace(/\//g, '__');
    }
  }

  function stripUndefined(v) {
    if (v === undefined) return null;
    if (Array.isArray(v)) return v.map(stripUndefined);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = {};
      for (const k of Object.keys(v)) {
        if (v[k] !== undefined) o[k] = stripUndefined(v[k]);
      }
      return o;
    }
    return v;
  }

  /**
   * Persistência compatível com MMStore (load/commit/replaceAll).
   * @param {firebase.firestore.Firestore} fs
   * @param {object} [opts]
   */
  function createFirestorePersistence(fs, opts) {
    const colName = (opts && opts.collection) || 'mm_docs';
    const col = fs.collection(colName);
    let remoteUnsub = null;
    let storeRef = null; // MMStore.Store instance, set after open
    let applyingRemote = false;
    const localEpoch = { n: 0 };

    const persistence = {
      async load() {
        const snap = await col.get();
        const rows = [];
        snap.forEach((doc) => {
          const d = doc.data() || {};
          if (d.path) rows.push({ path: d.path, data: d.data != null ? d.data : {} });
        });
        return rows;
      },

      async commit(puts, dels) {
        if (applyingRemote) return; // não ecoar de volta
        localEpoch.n++;
        const epoch = localEpoch.n;
        // batches de até 400 ops
        const ops = [];
        for (const [path, data] of puts) {
          ops.push({ type: 'put', path, data: stripUndefined(data) });
        }
        for (const path of dels) {
          ops.push({ type: 'del', path });
        }
        for (let i = 0; i < ops.length; i += 400) {
          const chunk = ops.slice(i, i + 400);
          const batch = fs.batch();
          for (const op of chunk) {
            const ref = col.doc(pathToId(op.path));
            if (op.type === 'del') batch.delete(ref);
            else batch.set(ref, { path: op.path, data: op.data, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), epoch });
          }
          await batch.commit();
        }
      },

      async replaceAll(entries) {
        const snap = await col.get();
        const batchDeletes = [];
        snap.forEach((doc) => batchDeletes.push(doc.ref));
        for (let i = 0; i < batchDeletes.length; i += 400) {
          const batch = fs.batch();
          batchDeletes.slice(i, i + 400).forEach((ref) => batch.delete(ref));
          await batch.commit();
        }
        await persistence.commit(entries, []);
      },

      /** Liga escuta em tempo real e aplica no store em memória */
      attachStore(store) {
        storeRef = store;
        if (remoteUnsub) remoteUnsub();
        remoteUnsub = col.onSnapshot({ includeMetadataChanges: false }, (snap) => {
          if (!storeRef) return;
          const changedPaths = [];
          snap.docChanges().forEach((change) => {
            const d = change.doc.data() || {};
            const path = d.path;
            if (!path) return;
            // ignora eco da própria escrita recente (heurística por epoch)
            if (d.epoch && d.epoch === localEpoch.n) return;
            applyingRemote = true;
            try {
              if (change.type === 'removed') {
                storeRef.mem.delete(path);
                storeRef.ver.set(path, (storeRef.ver.get(path) || 0) + 1);
              } else {
                const data = d.data != null ? MMStore.decode(d.data) : null;
                if (data == null) storeRef.mem.delete(path);
                else storeRef.mem.set(path, data);
                storeRef.ver.set(path, (storeRef.ver.get(path) || 0) + 1);
              }
              changedPaths.push(path);
            } finally {
              applyingRemote = false;
            }
          });
          if (changedPaths.length && storeRef._notify) {
            // atualiza colVer
            const cols = new Set(changedPaths.map((p) => p.split('/').slice(0, -1).join('/')));
            cols.forEach((c) => storeRef.colVer.set(c, (storeRef.colVer.get(c) || 0) + 1));
            storeRef._notify(changedPaths);
          }
        }, (err) => console.error('[firebase] onSnapshot', err));
      },

      detach() {
        if (remoteUnsub) { remoteUnsub(); remoteUnsub = null; }
        storeRef = null;
      }
    };

    return persistence;
  }

  async function initFirebase() {
    const cfg = root.FIREBASE_CONFIG;
    if (!cfg || !root.FIREBASE_ENABLED || !cfg.apiKey || cfg.apiKey === 'COLE_AQUI') {
      return { enabled: false };
    }
    if (typeof firebase === 'undefined') {
      console.error('[firebase] SDK não carregado. Verifique os scripts no index.html.');
      return { enabled: false, error: 'sdk' };
    }
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    const auth = firebase.auth();
    const fs = firebase.firestore();
    try {
      await fs.enablePersistence({ synchronizeTabs: true });
    } catch (e) {
      console.warn('[firebase] persistence offline:', e && e.message);
    }
    // Auth anônimo: permite rules com request.auth != null
    if (!auth.currentUser) {
      await auth.signInAnonymously();
    }
    await new Promise((resolve) => {
      const u = auth.onAuthStateChanged(() => { u(); resolve(); });
    });
    const persistence = createFirestorePersistence(fs);
    return { enabled: true, auth, fs, persistence, app: firebase.app() };
  }

  root.MMFirebase = { initFirebase, createFirestorePersistence, pathToId };
})(typeof self !== 'undefined' ? self : this);
