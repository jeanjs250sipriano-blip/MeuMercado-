/* Testes da camada local: store (atomicidade/concorrência), contas e política de acesso. Execução: node --test tests-store.js */
const test = require('node:test'); const assert = require('node:assert/strict');
const { Store, FieldValue, memoryPersistence } = require('./mm-store.js');
const MMAuth = require('./mm-auth.js'); const MMApi = require('./mm-api.js');
const mk = async () => { const s = new Store(); await s.open(); const store = { map: new Map(), getItem(k) { return this.map.get(k) ?? null; }, setItem(k, v) { this.map.set(k, v); }, removeItem(k) { this.map.delete(k); } }; const auth = MMAuth.create(s, { iterations: 1000, storage: store }); return { s, auth, db: s.db }; };

test('store: incrementos concorrentes em transação não perdem atualização', async () => {
  const { s, db } = await mk(); await db.doc('c/a').set({ n: 0 });
  await Promise.all(Array.from({ length: 25 }, () => db.runTransaction(async (tx) => { const d = (await tx.get(db.doc('c/a'))).data(); tx.update(db.doc('c/a'), { n: d.n + 1 }); })));
  assert.equal(s.getRaw('c/a').n, 25);
});
test('store: sem oversell — 10 compradores disputando 3 unidades', async () => {
  const { s, db } = await mk(); await db.doc('stock/p').set({ avail: 3 }); let ok = 0;
  await Promise.all(Array.from({ length: 10 }, async (_, i) => { try { await db.runTransaction(async (tx) => { const d = (await tx.get(db.doc('stock/p'))).data(); if (d.avail < 1) throw new Error('esgotado'); tx.update(db.doc('stock/p'), { avail: d.avail - 1 }); tx.create(db.doc(`res/r${i}`), { q: 1 }); }); ok++; } catch (e) { /* esgotado */ } }));
  assert.equal(ok, 3); assert.equal(s.getRaw('stock/p').avail, 0); assert.equal(s.allPaths().filter(p => p.startsWith('res/')).length, 3);
});
test('store: falha na persistência não altera a memória (atomicidade)', async () => {
  const { s, db } = await mk(); await db.doc('c/a').set({ n: 1 });
  s.failNextCommit = new Error('quota'); await assert.rejects(db.batch().update(db.doc('c/a'), { n: 2 }).set(db.doc('c/b'), { x: 1 }).commit());
  assert.equal(s.getRaw('c/a').n, 1); assert.equal(s.getRaw('c/b'), null);
});
test('store: persiste e recarrega (mesma persistência)', async () => {
  const p = memoryPersistence(); const a = new Store(p); await a.open(); await a.db.doc('x/1').set({ t: require('./mm-store.js').Timestamp.now(), v: 5 });
  const b = new Store(p); await b.open(); assert.equal(b.getRaw('x/1').v, 5); assert.ok(b.getRaw('x/1').t.toMillis);
});
test('store: increment/arrayUnion/serverTimestamp e undefined rejeitado', async () => {
  const { s, db } = await mk(); await db.doc('c/a').set({ n: 1, l: ['a'] }); await db.doc('c/a').update({ n: FieldValue.increment(4), l: FieldValue.arrayUnion('a', 'b'), at: FieldValue.serverTimestamp(), 'o.k': 3 });
  const d = s.getRaw('c/a'); assert.equal(d.n, 5); assert.deepEqual(d.l, ['a', 'b']); assert.ok(d.at.toMillis); assert.equal(d.o.k, 3);
  await assert.rejects(db.doc('c/z').set({ a: undefined }));
});
test('store: replaceAll e wipe', async () => {
  const { s, db } = await mk(); await db.doc('c/a').set({ n: 1 }); await s.replaceAll([['d/z', { q: 1 }]]); assert.equal(s.getRaw('c/a'), null); assert.equal(s.getRaw('d/z').q, 1); await s.wipe(); assert.equal(s.size, 0);
});
test('auth: primeiro administrador só uma vez; senha com hash PBKDF2, nunca em texto puro', async () => {
  const { s, auth } = await mk(); assert.equal(await auth.hasAdmin(), false);
  const u = await auth.createFirstAdmin({ username: 'Admin', name: 'Chefe', password: 'senha123' }); assert.equal(u.role, 'platform_admin'); assert.equal(u.username, 'admin');
  await assert.rejects(auth.createFirstAdmin({ username: 'outro', password: 'abcd1234' }), /já foi criado/);
  const acc = s.getRaw(`accounts/${u.uid}`); assert.ok(acc.hash && acc.salt && acc.iter); assert.ok(!JSON.stringify([...s.entries()]).includes('senha123'));
});
test('auth: login, senha errada, conta desativada, usuário duplicado, último admin', async () => {
  const { auth } = await mk(); const a = await auth.createFirstAdmin({ username: 'admin', password: 'senha123' }); auth.signOut();
  await assert.rejects(auth.signIn('admin', 'errada'), /incorretos/); assert.equal((await auth.signIn('admin', 'senha123')).username, 'admin');
  const c = await auth.createAccount({ username: 'cli1', password: 'abcd', role: 'customer' }); await assert.rejects(auth.createAccount({ username: 'CLI1', password: 'abcd', role: 'customer' }), /em uso/);
  await auth.updateAccount(c.account.uid, { active: false }); await assert.rejects(auth.signIn('cli1', 'abcd'), /desativada/);
  await assert.rejects(auth.updateAccount(a.uid, { active: false }), /último administrador/);
  for (let i = 0; i < 5; i++) await auth.signIn('admin', 'x').catch(() => {}); await assert.rejects(auth.signIn('admin', 'senha123'), /Muitas tentativas/);
});
test('api: política de acesso (cliente só lê o seu; escrita sensível negada; contas ocultas)', async () => {
  const { s, auth, db } = await mk(); const backend = { call: async () => ({}) };
  const api = MMApi.create({ store: s, auth, backend });
  await auth.createFirstAdmin({ username: 'admin', password: 'senha123' });
  const c1 = (await auth.createAccount({ username: 'ana', password: 'abcd', role: 'customer' })).account; const c2 = (await auth.createAccount({ username: 'bia', password: 'abcd', role: 'customer' })).account;
  await db.doc('orders/o1').set({ customerId: c1.uid, marketId: 'm1', status: 'confirmed' }); await db.doc('markets/m1').set({ status: 'active' }); await db.doc('markets/m2').set({ status: 'suspended' });
  await db.doc('payments/p1').set({ amount: 1 });
  await auth.signIn('ana', 'abcd');
  assert.ok(await api.doc('orders/o1')); assert.equal((await api.col('orders')).length, 1);
  assert.equal((await api.col('markets')).length, 1);
  await assert.rejects(api.update('orders/o1', { status: 'delivered' }), /permiss/); await assert.rejects(api.set('markets/m1', { status: 'x' }), /permiss/);
  await assert.rejects(api.doc('payments/p1'), /permiss/); assert.equal((await api.col('accounts')).length, 0);
  await api.set(`users/${c1.uid}`, { name: 'Ana', phone: '', email: '', createdAt: api.stamp(), prefs: {} }).catch(() => {}); 
  await assert.rejects(api.set(`users/${c2.uid}/addresses/a`, { cep: '1', street: 'r', number: '1', city: 'c' }), /permiss/);
  const id = await api.add(`users/${c1.uid}/addresses`, { cep: '01001000', street: 'Rua A', number: '1', city: 'SP' }); assert.ok(id);
  auth.signOut(); await assert.rejects(api.add(`users/${c1.uid}/addresses`, {}), /Entre/);
  await auth.signIn('bia', 'abcd'); assert.equal((await api.col('orders')).length, 0); assert.equal((await api.col(`users/${c1.uid}/addresses`)).length, 0);
});
