/* Meu Mercado Teste — mm-backup.js
 * Exportação, importação (MESCLAR inteligente), restauração completa (SUBSTITUIR) e reset do ambiente local.
 *
 * Formato (JSON, nunca executado — só é lido com JSON.parse):
 *   { format:'meu-mercado-teste-backup', formatVersion:1, app:{name,version}, schemaVersion, backupId, createdAt, createdBy,
 *     counts:{docs,images}, checksum:{algo:'SHA-256', value}, data:{ docs:[{path,data}], images:[{id,mime,w,h,size,createdAt,b64}] } }
 *  - O checksum cobre `data` em JSON canônico (chaves ordenadas): detecta arquivo truncado/alterado por engano.
 *    Não é assinatura: quem edita o arquivo pode recalcular o checksum. O conteúdo é sempre validado antes de aplicar.
 *  - Contas entram no backup apenas com hash+sal de senha (nunca a senha).
 * Regras da mesclagem: mesmo id + mesmo conteúdo = ignorado; id novo = adicionado; mesmo id com conteúdo diferente = CONFLITO
 * (o usuário escolhe manter o local, usar o backup ou cancelar). Nada é sobrescrito em silêncio.
 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./mm-store.js')); else root.MMBackup = factory(root.MMStore); })(typeof self !== 'undefined' ? self : this, function (MMStore) {
  'use strict';
  const { encode, decode, autoId } = MMStore;
  const FORMAT = 'meu-mercado-teste-backup'; const FORMAT_VERSION = 1; const MAX_BYTES = 200 * 1024 * 1024;
  const PATH_RE = /^[A-Za-z0-9_.@~:-]+(\/[A-Za-z0-9_.@~:-]+)*$/;
  const TECH_SKIP_ON_MERGE = new Set(['system/setup']);               // marcador técnico: só vem junto na substituição completa
  const VOLATILE = [[/^accounts$/, ['lastLoginAt']], [/notifications$/, ['read']]];
  const webc = () => (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) ? globalThis.crypto : require('crypto').webcrypto;
  const fail = (code, msg) => Object.assign(new Error(msg), { code });

  const canon = (v) => JSON.stringify(sortKeys(v));
  function sortKeys(v) { if (Array.isArray(v)) return v.map(sortKeys); if (v && typeof v === 'object') { const o = {}; Object.keys(v).sort().forEach(k => { o[k] = sortKeys(v[k]); }); return o; } return v; }
  const colOf = (p) => p.split('/').slice(0, -1).join('/');
  const colName = (p) => { const s = colOf(p).split('/'); return s[s.length - 1]; };
  const stripVolatile = (path, d) => { const c = colName(path); let o = d; for (const [re, keys] of VOLATILE) if (re.test(c)) { o = { ...o }; keys.forEach(k => delete o[k]); } return o; };
  async function sha256Hex(strOrBuf) { const buf = typeof strOrBuf === 'string' ? new TextEncoder().encode(strOrBuf) : strOrBuf; const h = await webc().subtle.digest('SHA-256', buf); return Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, '0')).join(''); }
  function toB64(buf) { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return typeof btoa === 'function' ? btoa(s) : Buffer.from(u).toString('base64'); }
  function fromB64(b) { if (typeof atob === 'function') { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; } const bb = Buffer.from(b, 'base64'); return bb.buffer.slice(bb.byteOffset, bb.byteOffset + bb.byteLength); }
  const safeParse = (text) => JSON.parse(text, function (k, v) { return (k === '__proto__' || k === 'constructor' || k === 'prototype') ? undefined : v; });
  const topDiff = (a, b) => { const ks = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]); return [...ks].filter(k => canon(a && a[k]) !== canon(b && b[k])); };

  function create({ store, blobs, metaGet, metaSet, version = '1.0.0', dataSchema = 1, resetExtra, now = () => Date.now(), onAfterChange }) {
    const history = async () => (await metaGet('backupHistory')) || [];
    async function record(entry) { const h = await history(); h.unshift({ id: autoId().slice(0, 12), at: now(), ...entry }); try { await metaSet('backupHistory', h.slice(0, 100)); } catch (e) { /* histórico é auxiliar */ } }

    /* ───────── Exportar ───────── */
    async function exportBackup({ by } = {}) {
      const docs = [...store.entries()].map(([path, data]) => ({ path, data: encode(data) })).sort((a, b) => a.path < b.path ? -1 : 1);
      const imgs = (await blobs.all()).sort((a, b) => a.id < b.id ? -1 : 1).map(r => ({ id: r.id, mime: r.mime, w: r.w, h: r.h, size: r.size, createdAt: r.createdAt, b64: toB64(r.bytes) }));
      const data = { docs, images: imgs }; const checksum = await sha256Hex(canon(data)); const backupId = 'bk_' + autoId().slice(0, 16);
      const file = { format: FORMAT, formatVersion: FORMAT_VERSION, app: { name: 'Meu Mercado Teste', version }, schemaVersion: dataSchema, backupId, createdAt: new Date(now()).toISOString(), createdBy: by || null, counts: { docs: docs.length, images: imgs.length }, checksum: { algo: 'SHA-256', value: checksum }, data };
      const json = JSON.stringify(file); const d = new Date(now()); const p2 = (n) => String(n).padStart(2, '0');
      await record({ kind: 'export', by: by || null, backupId, checksum, counts: file.counts, result: 'ok' });
      return { json, backupId, checksum, counts: file.counts, filename: `meu-mercado-teste-backup-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.json`, bytes: json.length };
    }

    /* ───────── Validar ───────── */
    async function parse(input) {
      const errors = [];
      let file; try { const text = typeof input === 'string' ? input : JSON.stringify(input); if (text.length > MAX_BYTES) throw new Error('arquivo grande demais'); file = safeParse(text); } catch (e) { return { ok: false, errors: ['O arquivo não é um JSON válido (' + e.message + ').'] }; }
      if (!file || typeof file !== 'object' || file.format !== FORMAT) return { ok: false, errors: ['Este arquivo não é um backup do Meu Mercado Teste.'] };
      if (file.formatVersion !== FORMAT_VERSION) errors.push(`Versão de formato não suportada: ${file.formatVersion}.`);
      if (!(Number.isInteger(file.schemaVersion))) errors.push('Backup sem versão de esquema.'); else if (file.schemaVersion > dataSchema) errors.push(`O backup foi gerado por uma versão mais nova do simulador (esquema ${file.schemaVersion}). Atualize o aplicativo antes de importar.`);
      if (!file.data || !Array.isArray(file.data.docs) || !Array.isArray(file.data.images)) errors.push('Estrutura de dados ausente ou inválida.');
      if (errors.length) return { ok: false, errors };
      const seen = new Set();
      for (const d of file.data.docs) {
        if (!d || typeof d.path !== 'string' || !PATH_RE.test(d.path) || d.path.split('/').length % 2 !== 0) { errors.push(`Caminho de registro inválido: ${String(d && d.path).slice(0, 80)}`); continue; }
        if (!d.data || typeof d.data !== 'object' || Array.isArray(d.data)) { errors.push(`Registro sem conteúdo válido: ${d.path}`); continue; }
        if (seen.has(d.path)) errors.push(`Registro duplicado dentro do arquivo: ${d.path}`); seen.add(d.path);
      }
      const imgSeen = new Set();
      for (const im of file.data.images) {
        if (!im || typeof im.id !== 'string' || !/^img_[0-9a-f]{32}$/.test(im.id) || typeof im.b64 !== 'string') { errors.push('Imagem com formato inválido.'); continue; }
        if (imgSeen.has(im.id)) errors.push(`Imagem repetida: ${im.id}`); imgSeen.add(im.id);
        let buf; try { buf = fromB64(im.b64); } catch (e) { errors.push(`Imagem ${im.id}: base64 inválido.`); continue; }
        if ('img_' + (await sha256Hex(buf)).slice(0, 32) !== im.id) errors.push(`Imagem ${im.id}: conteúdo não confere com o identificador (arquivo alterado ou corrompido).`);
        if (!/^image\/(jpeg|png|webp|gif)$/.test(im.mime)) errors.push(`Imagem ${im.id}: tipo não permitido.`);
      }
      if (errors.length > 20) errors.splice(20, errors.length, `… e mais ${errors.length - 20} problemas.`);
      if (!file.checksum || file.checksum.algo !== 'SHA-256') errors.push('Checksum ausente.');
      else if ((await sha256Hex(canon(file.data))) !== file.checksum.value) errors.push('Checksum não confere: o arquivo foi alterado ou está incompleto.');
      if (errors.length) return { ok: false, errors };
      return { ok: true, errors: [], backup: file };
    }

    /* ───────── Planejar mesclagem ───────── */
    const refsOf = (path, d) => { const r = []; const c = path.split('/'); const root = c[0];
      if (root === 'orders' && c.length === 2) { if (d.marketId) r.push(`markets/${d.marketId}`); if (d.customerId) r.push(`accounts/${d.customerId}`); }
      if (root === 'markets' && c[2] === 'listings' && c.length === 4) r.push(`markets/${c[1]}`);
      if (root === 'payments' && !String(c[1]).includes('__sub_')) r.push(`orders/${c[1]}`);
      if (root === 'reviews' && d.marketId) r.push(`markets/${d.marketId}`);
      if (root === 'marketAdmin' && c.length === 2) r.push(`markets/${c[1]}`);
      if (root === 'accounts' && d.marketId) r.push(`markets/${d.marketId}`);
      return r; };
    const ledgerKey = (d) => d && d.type ? [d.type, d.orderId || '', (d.meta && (d.meta.refundId || d.meta.payoutId)) || ''].join('|') : null;

    async function plan(backup) {
      const adds = [], same = [], conflicts = [], skippedTech = [], dupBusiness = [];
      const localLedger = new Map(); for (const [p, d] of store.entries()) if (colOf(p) === 'ledger') { const k = ledgerKey(d); if (k && (d.orderId || d.meta)) localLedger.set(k, p); }
      for (const { path, data } of backup.data.docs) {
        if (TECH_SKIP_ON_MERGE.has(path)) { skippedTech.push(path); continue; }
        const local = store.getRaw(path);
        if (local === null) {
          if (colOf(path) === 'ledger') { const k = ledgerKey(decode(data)); const lp = k && localLedger.get(k); if (lp && lp !== path) { dupBusiness.push({ path, existing: lp, key: k }); continue; } }
          adds.push({ path, data }); continue;
        }
        const a = canon(stripVolatile(path, encode(local))), b = canon(stripVolatile(path, data));
        if (a === b) same.push(path); else conflicts.push({ path, keys: topDiff(stripVolatile(path, encode(local)), stripVolatile(path, data)), local: encode(local), incoming: data });
      }
      const haveImgs = new Set(await blobs.keys()); const imgAdds = backup.data.images.filter(i => !haveImgs.has(i.id)); const imgSame = backup.data.images.length - imgAdds.length;
      // referências ausentes (nem no local nem no backup): não inventamos vínculos — esses registros ficam de fora
      const incomingPaths = new Set(backup.data.docs.map(d => d.path)); const exists = (p) => store.getRaw(p) !== null || incomingPaths.has(p);
      const orphans = []; const keep = [];
      for (const a of adds) { const missing = refsOf(a.path, decode(a.data)).filter(r => !exists(r)); if (missing.length) orphans.push({ path: a.path, missing }); else keep.push(a); }
      const byCol = {}; keep.forEach(a => { const c = colOf(a.path); byCol[c] = (byCol[c] || 0) + 1; });
      return { backupId: backup.backupId, createdAt: backup.createdAt, adds: keep, same, conflicts, orphans, dupBusiness, skippedTech, imgAdds, imgSame, byCollection: byCol,
        summary: { add: keep.length, same: same.length, conflicts: conflicts.length, orphans: orphans.length, duplicatesSkipped: dupBusiness.length, imagesAdd: imgAdds.length, imagesSame: imgSame } };
    }

    /* ───────── Aplicar mesclagem (atômico: tudo ou nada) ───────── */
    async function applyMerge(pl, { choices = {}, defaultChoice = 'local', by } = {}) {
      if (defaultChoice === 'cancel') throw fail('cancelled', 'Importação cancelada. Nada foi alterado.');
      const useBackup = pl.conflicts.filter(c => (choices[c.path] || defaultChoice) === 'backup');
      const ops = [...pl.adds.map(a => ['set', a.path, decode(a.data), false]), ...useBackup.map(c => ['set', c.path, decode(c.incoming), false])];
      const addedImgs = pl.imgAdds.map(i => ({ id: i.id, mime: i.mime, bytes: fromB64(i.b64), w: i.w, h: i.h, size: i.size, createdAt: i.createdAt }));
      let imgDone = false;
      try {
        if (addedImgs.length) { await blobs.putMany(addedImgs); imgDone = true; }
        if (ops.length) await store._commit(ops, null);        // uma única gravação persistente: ou entra tudo ou nada
      } catch (e) {
        if (imgDone) { for (const i of addedImgs) { try { await blobs.delete(i.id); } catch (x) { /* melhor esforço */ } } }
        await record({ kind: 'merge', by: by || null, backupId: pl.backupId, result: 'erro: ' + e.message, counts: pl.summary });
        throw fail(e.code || 'merge-failed', 'A mesclagem foi interrompida e nada foi alterado: ' + e.message);
      }
      const res = { added: pl.adds.length, replaced: useBackup.length, keptLocal: pl.conflicts.length - useBackup.length, ignoredSame: pl.same.length, orphans: pl.orphans.length, duplicatesSkipped: pl.dupBusiness.length, imagesAdded: addedImgs.length };
      await record({ kind: 'merge', by: by || null, backupId: pl.backupId, result: 'ok', counts: res });
      if (onAfterChange) await onAfterChange('merge');
      return res;
    }

    /* ───────── Substituição completa, com reversão em caso de falha ───────── */
    async function replace(backup, { by } = {}) {
      const oldEntries = [...store.entries()].map(([p, d]) => [p, MMStore.clone(d)]); const oldImgs = await blobs.all();
      const newEntries = backup.data.docs.map(d => [d.path, decode(d.data)]); const newImgs = backup.data.images.map(i => ({ id: i.id, mime: i.mime, bytes: fromB64(i.b64), w: i.w, h: i.h, size: i.size, createdAt: i.createdAt }));
      let step = 'imagens';
      try {
        await blobs.replaceAll(newImgs); step = 'registros'; await store.replaceAll(newEntries);
        step = 'verificação'; if (store.size !== newEntries.length) throw new Error(`contagem inesperada (${store.size} ≠ ${newEntries.length})`);
      } catch (e) {
        let rb = 'ok'; try { await blobs.replaceAll(oldImgs); await store.replaceAll(oldEntries); } catch (x) { rb = 'FALHOU: ' + x.message; }
        await record({ kind: 'replace', by: by || null, backupId: backup.backupId, result: `erro em ${step}: ${e.message}; reversão ${rb}` });
        throw fail('replace-failed', `A restauração falhou na etapa "${step}" (${e.message}). ${rb === 'ok' ? 'Os dados anteriores foram mantidos.' : 'ATENÇÃO: a reversão também falhou (' + rb + '). Importe um backup recente.'}`);
      }
      const res = { docs: newEntries.length, images: newImgs.length };
      await record({ kind: 'replace', by: by || null, backupId: backup.backupId, result: 'ok', counts: res });
      if (onAfterChange) await onAfterChange('replace');
      return res;
    }

    /* ───────── Reset completo ───────── */
    async function reset({ by } = {}) {
      const steps = []; const run = async (name, fn) => { try { await fn(); steps.push({ step: name, ok: true }); } catch (e) { steps.push({ step: name, ok: false, error: e.message }); } };
      await run('registros e metadados', () => store.wipe());
      await run('imagens', () => blobs.replaceAll([]));
      if (resetExtra) await run('dados auxiliares do navegador', resetExtra);
      const ok = steps.every(s => s.ok);
      try { await metaSet('backupHistory', [{ id: autoId().slice(0, 12), at: now(), kind: 'reset', by: by || null, result: ok ? 'ok' : 'parcial', steps }]); } catch (e) { /* ignore */ }
      if (onAfterChange) await onAfterChange('reset');
      return { ok, steps };
    }
    return { exportBackup, parse, plan, applyMerge, replace, reset, history, canon, sha256Hex };
  }
  return { create, canon, FORMAT };
});
