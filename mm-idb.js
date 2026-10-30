/* Meu Mercado Teste — mm-idb.js
 * Persistência em IndexedDB (navegador): documentos, imagens e metadados.
 *  - docs  : { path, col, data }           (índice por coleção)
 *  - blobs : { id, mime, bytes, w, h, size, createdAt }   (imagens já redimensionadas/comprimidas; id = hash do conteúdo)
 *  - meta  : { key, value }                (versão do esquema, histórico de backups, preferências técnicas)
 * Versão do esquema do banco (IDB) e versão do esquema dos DADOS são separadas; migrações ficam em MIGRATIONS.
 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.MMIdb = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DB_NAME = 'meu-mercado-teste';
  const IDB_VERSION = 1;          // estrutura física (object stores)
  const DATA_SCHEMA = 1;          // estrutura lógica dos documentos (sobe quando um documento muda de formato)
  /** Migrações de dados: chave = versão de destino; recebem o store aberto e devem ser idempotentes. */
  const MIGRATIONS = { /* 2: async (store) => { ... } */ };

  class MMError extends Error { constructor(code, msg, cause) { super(msg); this.code = code; this.cause = cause; } }
  function friendly(e, what) {
    const n = (e && (e.name || e.code)) || '';
    if (n === 'QuotaExceededError') return new MMError('quota', 'Não há espaço suficiente no armazenamento do navegador. Exporte um backup e libere espaço (apague imagens ou dados antigos) antes de continuar.', e);
    if (n === 'InvalidStateError' || n === 'SecurityError') return new MMError('blocked', 'O navegador não permite gravar dados locais neste modo (navegação privada ou armazenamento bloqueado). Abra o simulador em uma janela normal.', e);
    return new MMError('io', `Falha ao ${what || 'acessar o armazenamento local'}: ${(e && e.message) || e}`, e);
  }
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('transação abortada')); });

  async function open(opts = {}) {
    const name = opts.name || DB_NAME;
    if (typeof indexedDB === 'undefined') throw new MMError('unsupported', 'Este navegador não oferece IndexedDB; o simulador não consegue guardar dados.');
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(name, IDB_VERSION);
      r.onupgradeneeded = (ev) => {
        const d = r.result;
        if (ev.oldVersion < 1) {
          const docs = d.createObjectStore('docs', { keyPath: 'path' }); docs.createIndex('col', 'col', { unique: false });
          d.createObjectStore('blobs', { keyPath: 'id' }); d.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(friendly(r.error, 'abrir o banco local')); r.onblocked = () => rej(new MMError('blocked', 'O banco local está aberto em outra aba com versão diferente. Feche as outras abas e recarregue.'));
    });
    db.onversionchange = () => db.close();

    const metaGet = async (key) => { const r = await req(db.transaction('meta').objectStore('meta').get(key)); return r ? r.value : undefined; };
    const metaSet = async (key, value) => { try { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ key, value }); await done(tx); } catch (e) { throw friendly(e, 'gravar configuração'); } };

    const persistence = {
      kind: 'indexeddb',
      async load() { const rows = await req(db.transaction('docs').objectStore('docs').getAll()); return rows.map(r => ({ path: r.path, data: r.data })); },
      async commit(puts, dels) {
        try { const tx = db.transaction('docs', 'readwrite'); const st = tx.objectStore('docs'); puts.forEach(([path, data]) => st.put({ path, col: path.split('/').slice(0, -1).join('/'), data })); dels.forEach(p => st.delete(p)); await done(tx); }
        catch (e) { throw friendly(e, 'gravar os dados'); }
      },
      async replaceAll(entries) {
        try { const tx = db.transaction('docs', 'readwrite'); const st = tx.objectStore('docs'); st.clear(); entries.forEach(([path, data]) => st.put({ path, col: path.split('/').slice(0, -1).join('/'), data })); await done(tx); }
        catch (e) { throw friendly(e, 'restaurar os dados'); }
      },
      async clear() { try { const tx = db.transaction(['docs', 'blobs', 'meta'], 'readwrite'); ['docs', 'blobs', 'meta'].forEach(n => tx.objectStore(n).clear()); await done(tx); } catch (e) { throw friendly(e, 'apagar os dados'); } }
    };

    /* Imagens */
    const blobs = {
      async put(rec) { try { const tx = db.transaction('blobs', 'readwrite'); tx.objectStore('blobs').put(rec); await done(tx); return rec.id; } catch (e) { throw friendly(e, 'salvar a imagem'); } },
      async get(id) { return (await req(db.transaction('blobs').objectStore('blobs').get(id))) || null; },
      async has(id) { return (await req(db.transaction('blobs').objectStore('blobs').count(id))) > 0; },
      async all() { return req(db.transaction('blobs').objectStore('blobs').getAll()); },
      async keys() { return req(db.transaction('blobs').objectStore('blobs').getAllKeys()); },
      async delete(id) { const tx = db.transaction('blobs', 'readwrite'); tx.objectStore('blobs').delete(id); await done(tx); },
      async replaceAll(recs) { try { const tx = db.transaction('blobs', 'readwrite'); const st = tx.objectStore('blobs'); st.clear(); recs.forEach(r => st.put(r)); await done(tx); } catch (e) { throw friendly(e, 'restaurar as imagens'); } },
      async putMany(recs) { try { const tx = db.transaction('blobs', 'readwrite'); const st = tx.objectStore('blobs'); recs.forEach(r => st.put(r)); await done(tx); } catch (e) { throw friendly(e, 'importar as imagens'); } }
    };

    /* Versão dos dados + migrações */
    let ver = await metaGet('dataSchema');
    if (ver === undefined) { ver = DATA_SCHEMA; await metaSet('dataSchema', ver); }
    if (ver > DATA_SCHEMA) throw new MMError('newer', `Os dados locais foram criados por uma versão mais nova do simulador (esquema ${ver}). Atualize o aplicativo antes de continuar.`);

    return {
      db, persistence, blobs, metaGet, metaSet, dataSchema: ver, targetSchema: DATA_SCHEMA, migrations: MIGRATIONS, MMError,
      async migrate(store) { while (ver < DATA_SCHEMA) { const next = ver + 1; if (MIGRATIONS[next]) await MIGRATIONS[next](store); ver = next; await metaSet('dataSchema', ver); } },
      async estimate() { try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); return { usage: e.usage || 0, quota: e.quota || 0 }; } } catch (e) { /* indisponível */ } return null; },
      async persist() { try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch (e) { return false; } },
      close() { db.close(); },
      async destroy() { db.close(); await new Promise((res, rej) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = () => res(); r.onerror = () => rej(r.error); r.onblocked = () => res(); }); }
    };
  }

  /** Impede duas abas escrevendo ao mesmo tempo no mesmo banco (os dados ficam em memória em cada aba). */
  async function acquireInstanceLock() {
    if (typeof navigator === 'undefined' || !navigator.locks) return { ok: true, supported: false };
    return new Promise((resolve) => {
      navigator.locks.request('meu-mercado-teste-instancia', { ifAvailable: true }, (lock) => {
        if (!lock) { resolve({ ok: false, supported: true }); return; }
        resolve({ ok: true, supported: true });
        return new Promise(() => { /* mantém o lock enquanto a aba existir */ });
      });
    });
  }

  /* ───────── Imagens: validação, redimensionamento e compressão (somente navegador) ───────── */
  const IMG_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const MAX_INPUT = 12 * 1024 * 1024, MAX_SIDE = 800;
  async function sha256Hex(buf) { const h = await crypto.subtle.digest('SHA-256', buf); return Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, '0')).join(''); }
  async function processImage(file, opts = {}) {
    if (!file || !IMG_TYPES.includes(file.type)) throw new MMError('image-type', 'Formato não suportado. Use JPG, PNG, WebP ou GIF.');
    if (file.size > MAX_INPUT) throw new MMError('image-size', 'A imagem é grande demais (máximo 12 MB). Escolha outra ou reduza o tamanho.');
    let bmp; try { bmp = await createImageBitmap(file); } catch (e) { throw new MMError('image-corrupt', 'Não foi possível ler a imagem. O arquivo pode estar corrompido.', e); }
    const max = opts.maxSide || MAX_SIDE; const scale = Math.min(1, max / Math.max(bmp.width, bmp.height)); const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h); if (bmp.close) bmp.close();
    let blob = await new Promise(r => cv.toBlob(r, 'image/webp', 0.82)); if (!blob || blob.type !== 'image/webp') blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.82));
    if (!blob) throw new MMError('image-encode', 'Não foi possível comprimir a imagem.');
    const bytes = await blob.arrayBuffer(); const id = 'img_' + (await sha256Hex(bytes)).slice(0, 32);
    return { id, mime: blob.type, bytes, w, h, size: bytes.byteLength, createdAt: Date.now() };
  }

  return { open, acquireInstanceLock, processImage, MMError, DATA_SCHEMA, IMG_TYPES };
});
