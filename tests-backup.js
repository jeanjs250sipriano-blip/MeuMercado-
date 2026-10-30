/* Testes de backup/mesclagem/restauração/reset (casos A–D do prompt + financeiro + atomicidade). node --test tests-backup.js */
const test = require('node:test'); const assert = require('node:assert/strict');
const MMStore = require('./mm-store.js'); const MMAuth = require('./mm-auth.js'); const MMPay = require('./mm-pay.js'); const MMBackup = require('./mm-backup.js'); const { createBackend } = require('./mm-backend.js');
const HOURS = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(i => [String(i), [{ open: '00:00', close: '23:59' }]]));
const fakeBlobs = () => { const m = new Map(); return { m, async all() { return [...m.values()]; }, async keys() { return [...m.keys()]; }, async putMany(r) { r.forEach(x => m.set(x.id, x)); }, async delete(id) { m.delete(id); }, async replaceAll(r) { m.clear(); r.forEach(x => m.set(x.id, x)); }, async has(id) { return m.has(id); }, async put(x) { m.set(x.id, x); } }; };
async function env() {
  const store = new MMStore.Store(); await store.open(); const auth = MMAuth.create(store, { iterations: 1000, storage: null }); const be = createBackend({ store, auth, provider: MMPay.create(store) });
  const blobs = fakeBlobs(); const meta = new Map();
  const bk = MMBackup.create({ store, blobs, metaGet: async k => meta.get(k), metaSet: async (k, v) => meta.set(k, v) });
  const E = { store, auth, be, blobs, bk, meta, db: store.db };
  E.call = async (u, name, data) => { const a = await auth.getByUsername(u); return be.call(name, data, { auth: { uid: a.uid, token: auth.claimsOf(a) } }); };
  return E;
}
async function seed(E, tag = 'a') {
  await auth0(E); await E.call('admin', 'adminUpsertCity', { name: 'Campinas', uf: 'SP', active: true }); await E.call('admin', 'adminUpsertCategory', { name: 'Mercearia', id: 'merc' });
  const m = await E.call('admin', 'adminCreateMarket', { name: 'Mercado ' + tag, cityId: 'campinas-sp', commissionPercent: 10, deliveryFee: 800, hours: HOURS, deliveryArea: { ceps: ['130'] }, owner: { username: 'dono' + tag, password: 'abcd' }, status: 'active' });
  const l = await E.call('dono' + tag, 'marketUpsertListing', { marketId: m.marketId, name: 'Arroz', categoryId: 'merc', unit: 'kg', size: 5, price: 1000, allocated: 10, active: true });
  await E.call('admin', 'adminCreateAccount', { username: 'cli' + tag, password: 'abcd', role: 'customer' }); const c = await E.auth.getByUsername('cli' + tag);
  await E.db.doc(`users/${c.uid}/addresses/a1`).set({ cep: '13010000', street: 'R', number: '1', city: 'C' });
  const items = [{ listingId: l.id, qty: 2 }]; const q = await E.call('cli' + tag, 'quoteCart', { marketId: m.marketId, items });
  const o = await E.call('cli' + tag, 'createCheckout', { marketId: m.marketId, items, method: 'pix', addressId: 'a1', idempotencyKey: 'k' + tag, expectedTotal: q.totals.total, schedule: { mode: 'asap' } });
  await E.call('cli' + tag, 'simulatePayment', { orderId: o.orderId, outcome: 'approve' });
  await realImg(E);
  return { marketId: m.marketId, listingId: l.id, orderId: o.orderId };
}
const auth0 = async (E) => { if (!(await E.auth.hasAdmin())) await E.auth.createFirstAdmin({ username: 'admin', password: 'senha1' }); };
const roundtrip = async (E) => { const x = await E.bk.exportBackup({ by: 'admin' }); const p = await E.bk.parse(x.json); return { x, p }; };
const countCol = (E, c) => E.store.allPaths().filter(p => p.startsWith(c + '/') && p.split('/').length === 2).length;
// o backup guarda imagens com id = hash do conteúdo; nos testes usamos bytes reais
const realImg = async (E) => { const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]).buffer; const h = await E.bk.sha256Hex(bytes); const id = 'img_' + h.slice(0, 32); await E.blobs.put({ id, mime: 'image/png', bytes, w: 1, h: 1, size: 8, createdAt: 1 }); return id; };

test('exporta com metadados, checksum, imagens e valida; detecta alteração', async () => {
  const E = await env(); await seed(E); const { x, p } = await roundtrip(E);
  assert.ok(p.ok, p.errors.join('|')); assert.equal(p.backup.format, 'meu-mercado-teste-backup'); assert.ok(p.backup.backupId && p.backup.createdAt && p.backup.schemaVersion >= 1 && p.backup.app.version);
  assert.equal(p.backup.counts.images, 1); assert.ok(p.backup.data.docs.length > 10);
  const tampered = JSON.parse(x.json); tampered.data.docs[0].data.hack = 1; assert.equal((await E.bk.parse(JSON.stringify(tampered))).ok, false);
  assert.equal((await E.bk.parse('{nao json')).ok, false); assert.equal((await E.bk.parse('{"format":"x"}')).ok, false);
  const bad = JSON.parse(x.json); bad.data.docs[0].path = '../etc/passwd'; assert.equal((await E.bk.parse(JSON.stringify(bad))).ok, false);
  const img = JSON.parse(x.json); img.data.images[0].b64 = Buffer.from('outra coisa').toString('base64'); assert.equal((await E.bk.parse(JSON.stringify(img))).ok, false);
  const newer = JSON.parse(x.json); newer.schemaVersion = 99; assert.match((await E.bk.parse(JSON.stringify(newer))).errors[0], /mais nova/);
});
test('Caso A: ambiente vazio + backup → tudo entra (mesclar) e integridade ok', async () => {
  const S = await env(); await seed(S); const { p } = await roundtrip(S);
  const E = await env(); const pl = await E.bk.plan(p.backup); assert.equal(pl.conflicts.length, 0); assert.ok(pl.adds.length > 10); assert.equal(pl.summary.imagesAdd, 1);
  const r = await E.bk.applyMerge(pl, { by: 'x' }); assert.equal(r.added, pl.adds.length);
  assert.equal(E.store.allPaths().length - 0, S.store.allPaths().length - 1); // sem system/setup (marcador técnico)
  await E.store.db.doc('system/setup').set({ at: MMStore.Timestamp.now() });
  assert.equal((await E.call('admin', 'adminIntegrityCheck', {})).issues.length, 0);
  assert.equal(E.blobs.m.size, 1);
});
test('Caso B: mesmos ids e mesmo conteúdo → nada duplica (idempotente)', async () => {
  const E = await env(); await seed(E); const { p } = await roundtrip(E); const before = E.store.allPaths().length;
  const pl = await E.bk.plan(p.backup); assert.equal(pl.adds.length, 0); assert.equal(pl.conflicts.length, 0); assert.ok(pl.same.length > 10);
  await E.bk.applyMerge(pl, {}); assert.equal(E.store.allPaths().length, before);
});
test('Caso C: ids novos → adicionados sem tocar nos existentes; pedidos/pagamentos/ledger não duplicam', async () => {
  const A = await env(); await seed(A, 'a'); const B = await env(); await seed(B, 'b'); const { p } = await roundtrip(B);
  const ordersBefore = countCol(A, 'orders'); const ledgerBefore = countCol(A, 'ledger');
  const pl = await A.bk.plan(p.backup);
  // 'admin' e a cidade/categoria existem nos dois com conteúdos diferentes (ids de conta diferentes) → conflitos apenas nas chaves de negócio compartilhadas
  const r = await A.bk.applyMerge(pl, { defaultChoice: 'local' });
  assert.equal(countCol(A, 'orders'), ordersBefore + 1); assert.ok(countCol(A, 'ledger') > ledgerBefore);
  const r2 = await A.bk.applyMerge(await A.bk.plan(p.backup), { defaultChoice: 'local' }); assert.equal(r2.added, 0); assert.equal(countCol(A, 'orders'), ordersBefore + 1);
  assert.ok(A.store.getRaw(`markets/${(await B.store.db.collection('markets').get()).docs[0].id}`));
});
test('Caso D: mesmo id com conteúdo diferente → conflito; escolha explícita local/backup; nada silencioso', async () => {
  const E = await env(); const w = await seed(E); const { p } = await roundtrip(E);
  await E.db.doc(`markets/${w.marketId}/listings/${w.listingId}`).update({ price: 2222 });
  const pl = await E.bk.plan(p.backup); const c = pl.conflicts.find(x => x.path.endsWith(w.listingId)); assert.ok(c); assert.ok(c.keys.includes('price'));
  await E.bk.applyMerge(pl, { defaultChoice: 'local' }); assert.equal(E.store.getRaw(`markets/${w.marketId}/listings/${w.listingId}`).price, 2222);
  await E.bk.applyMerge(await E.bk.plan(p.backup), { defaultChoice: 'local', choices: { [c.path]: 'backup' } }); assert.equal(E.store.getRaw(`markets/${w.marketId}/listings/${w.listingId}`).price, 1000);
  await E.db.doc(`markets/${w.marketId}/listings/${w.listingId}`).update({ price: 3333 });
  await assert.rejects(E.bk.applyMerge(await E.bk.plan(p.backup), { defaultChoice: 'cancel' }), /cancelada/); assert.equal(E.store.getRaw(`markets/${w.marketId}/listings/${w.listingId}`).price, 3333);
});
test('mesclagem é atômica: falha na gravação não deixa dados parciais nem imagens órfãs', async () => {
  const S = await env(); await seed(S); const { p } = await roundtrip(S); const E = await env(); const pl = await E.bk.plan(p.backup);
  E.store.failNextCommit = new Error('quota'); await assert.rejects(E.bk.applyMerge(pl, {}), /nada foi alterado/); assert.equal(E.store.size, 0); assert.equal(E.blobs.m.size, 0);
  assert.equal((await E.bk.history())[0].kind, 'merge');
});
test('referências ausentes não são inventadas: pedido sem mercado/cliente fica de fora', async () => {
  const S = await env(); const w = await seed(S); const { x } = await roundtrip(S); const f = JSON.parse(x.json);
  f.data.docs = f.data.docs.filter(d => d.path !== `markets/${w.marketId}`); f.checksum.value = await S.bk.sha256Hex(S.bk.canon(f.data));
  const p = await S.bk.parse(JSON.stringify(f)); assert.ok(p.ok); const E = await env(); const pl = await E.bk.plan(p.backup);
  assert.ok(pl.orphans.some(o => o.path === `orders/${w.orderId}`));
});
test('substituir: restaura exatamente, e reverte se falhar', async () => {
  const S = await env(); await seed(S); const { p } = await roundtrip(S); const E = await env(); await seed(E, 'z'); const before = E.store.allPaths().length;
  const orig = E.store.replaceAll.bind(E.store); let n = 0; E.store.replaceAll = async (e) => { if (++n === 1) throw new Error('disco cheio'); return orig(e); };
  await assert.rejects(E.bk.replace(p.backup, {}), /anteriores foram mantidos/); assert.equal(E.store.allPaths().length, before);
  E.store.replaceAll = orig; const r = await E.bk.replace(p.backup, {}); assert.equal(E.store.size, p.backup.data.docs.length); assert.equal(r.docs, p.backup.data.docs.length);
  assert.equal((await E.auth.hasAdmin()), true);
});
test('reset completo volta ao estado vazio e ao fluxo do primeiro administrador', async () => {
  const E = await env(); await seed(E); const r = await E.bk.reset({ by: 'admin' }); assert.equal(r.ok, true);
  assert.equal(E.store.size, 0); assert.equal(E.blobs.m.size, 0); assert.equal(await E.auth.hasAdmin(), false); await E.auth.createFirstAdmin({ username: 'novo', password: 'abcd' });
  assert.equal((await E.bk.history())[0].kind, 'reset');
});
test('backup não executa código: conteúdo malicioso é só dado', async () => {
  const E = await env(); await seed(E); const { x } = await roundtrip(E); const f = JSON.parse(x.json); f.data.docs.push({ path: 'notes/n1', data: { text: '<img src=x onerror=alert(1)>', __proto__: { polluted: 1 }, constructor: 'x' } });
  f.checksum.value = await E.bk.sha256Hex(E.bk.canon(f.data)); const txt = JSON.stringify(f).replace('"data":{"text"', '"data":{"__proto__":{"polluted":1},"text"'); const p = await E.bk.parse(txt);
  assert.equal({}.polluted, undefined); assert.ok(p.ok || p.errors.length);
});
