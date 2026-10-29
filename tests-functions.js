'use strict';
/**
 * Testes das Cloud Functions SEM Firebase: o Admin SDK e o firebase-functions são substituídos por um
 * Firestore/Auth em memória (este arquivo). Serve para validar a LÓGICA (estoque, pagamento, expiração, entrega,
 * permissões, substituições, reembolsos). NÃO substitui o emulador oficial nem testes em projeto real:
 * regras de segurança (firestore.rules), índices e comportamento de rede só são verificados lá (veja README).
 *
 * Fidelidade importante ao Firestore real: transações exigem TODAS as leituras antes das escritas; valores
 * `undefined` são rejeitados; update() falha em documento inexistente; transações concorrentes são serializadas.
 *
 * Executar: node --test tests-functions.js
 */
const Module = require('module');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

/* ───────────────────────── Firestore em memória ───────────────────────── */
class Timestamp {
  constructor(ms) { this._ms = ms; }
  static now() { return new Timestamp(Date.now()); }
  static fromMillis(ms) { return new Timestamp(ms); }
  static fromDate(d) { return new Timestamp(d.getTime()); }
  toMillis() { return this._ms; } toDate() { return new Date(this._ms); } get seconds() { return Math.floor(this._ms / 1000); }
}
class Sentinel { constructor(kind, arg) { this.kind = kind; this.arg = arg; } }
const FieldValue = { serverTimestamp: () => new Sentinel('ts'), increment: (n) => new Sentinel('inc', n), arrayUnion: (...a) => new Sentinel('union', a), arrayRemove: (...a) => new Sentinel('remove', a), delete: () => new Sentinel('del') };
const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Timestamp) && !(v instanceof Sentinel) && !(v instanceof Date);
const clone = (v) => v instanceof Timestamp ? new Timestamp(v._ms) : Array.isArray(v) ? v.map(clone) : isPlain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v;
const eq = (a, b) => JSON.stringify(a, (k, v) => v instanceof Timestamp ? { __ts: v._ms } : v) === JSON.stringify(b, (k, v) => v instanceof Timestamp ? { __ts: v._ms } : v);
function checkUndefined(v, path) { if (v === undefined) throw new Error(`Firestore: valor undefined não é permitido (${path})`); if (Array.isArray(v)) v.forEach((x, i) => checkUndefined(x, `${path}[${i}]`)); else if (isPlain(v)) Object.entries(v).forEach(([k, x]) => checkUndefined(x, `${path}.${k}`)); }
function resolveVal(v, existing) {
  if (v instanceof Sentinel) {
    if (v.kind === 'ts') return Timestamp.now();
    if (v.kind === 'inc') return (typeof existing === 'number' ? existing : 0) + v.arg;
    if (v.kind === 'union') { const cur = Array.isArray(existing) ? existing.slice() : []; v.arg.forEach(x => { if (!cur.some(y => eq(x, y))) cur.push(clone(x)); }); return cur; }
    if (v.kind === 'remove') return (Array.isArray(existing) ? existing : []).filter(y => !v.arg.some(x => eq(x, y)));
    if (v.kind === 'del') return undefined;
  }
  if (isPlain(v)) { const out = {}; for (const [k, x] of Object.entries(v)) { const r = resolveVal(x, existing && isPlain(existing) ? existing[k] : undefined); if (r !== undefined) out[k] = r; } return out; }
  return clone(v);
}
function deepMerge(base, patch) { const out = { ...base }; for (const [k, v] of Object.entries(patch)) out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v; return out; }
function setPath(obj, dotted, val) { const parts = dotted.split('.'); let o = obj; for (let i = 0; i < parts.length - 1; i++) { if (!isPlain(o[parts[i]])) o[parts[i]] = {}; o = o[parts[i]]; } const last = parts[parts.length - 1]; if (val === undefined) delete o[last]; else o[last] = val; }
const getPath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const cmpVal = (v) => v instanceof Timestamp ? v._ms : v;

const STORE = new Map();
let AUTO = 0; const autoId = () => 'auto' + (++AUTO).toString(36).padStart(8, '0') + crypto.randomBytes(4).toString('hex');
const notFound = (p) => Object.assign(new Error(`5 NOT_FOUND: no document to update: ${p}`), { code: 5 });
const exists = (p) => STORE.has(p);
function applySet(path, data, merge) { checkUndefined(data, path); const cur = STORE.get(path); const res = resolveVal(data, cur); STORE.set(path, merge && cur ? deepMerge(cur, res) : res); }
function applyUpdate(path, data) {
  checkUndefined(data, path); if (!STORE.has(path)) throw notFound(path); const cur = clone(STORE.get(path));
  for (const [k, v] of Object.entries(data)) { const r = resolveVal(v, getPath(cur, k)); setPath(cur, k, r); }
  STORE.set(path, cur);
}
function applyCreate(path, data) { if (STORE.has(path)) throw Object.assign(new Error('6 ALREADY_EXISTS: ' + path), { code: 6 }); applySet(path, data, false); }
function applyDelete(path) { STORE.delete(path); }

class DocSnap { constructor(ref, data) { this.ref = ref; this.id = ref.id; this._d = data; this.exists = data !== undefined; } data() { return this._d === undefined ? undefined : clone(this._d); } get(f) { return this._d ? getPath(this._d, f) : undefined; } }
class QuerySnap { constructor(docs) { this.docs = docs; this.empty = docs.length === 0; this.size = docs.length; } forEach(f) { this.docs.forEach(f); } }
class DocRef {
  constructor(path) { this.path = path; this.id = path.split('/').pop(); }
  get parent() { return new Query(this.path.split('/').slice(0, -1).join('/')); }
  collection(n) { return new Query(`${this.path}/${n}`); }
  async get() { return new DocSnap(this, STORE.has(this.path) ? clone(STORE.get(this.path)) : undefined); }
  async set(d, o) { applySet(this.path, d, !!(o && o.merge)); } async update(d) { applyUpdate(this.path, d); } async create(d) { applyCreate(this.path, d); } async delete() { applyDelete(this.path); }
}
class Query {
  constructor(path, filters = [], orders = [], lim = null, group = false) { this.path = path; this.filters = filters; this.orders = orders; this.lim = lim; this.group = group; this.id = path.split('/').pop(); }
  get parent() { const p = this.path.split('/'); return p.length > 1 ? new DocRef(p.slice(0, -1).join('/')) : null; }
  doc(id) { return new DocRef(`${this.path}/${id || autoId()}`); }
  async add(d) { const r = this.doc(); applyCreate(r.path, d); return r; }
  where(f, op, v) { return new Query(this.path, [...this.filters, { f, op, v }], this.orders, this.lim, this.group); }
  orderBy(f, dir = 'asc') { return new Query(this.path, this.filters, [...this.orders, { f, dir }], this.lim, this.group); }
  limit(n) { return new Query(this.path, this.filters, this.orders, n, this.group); }
  _docs() {
    const segs = this.path.split('/').length; let keys = [...STORE.keys()].filter(k => { const s = k.split('/'); return this.group ? s.length % 2 === 0 && s[s.length - 2] === this.path : (s.length === segs + 1 && k.startsWith(this.path + '/')); });
    let rows = keys.map(k => ({ ref: new DocRef(k), data: STORE.get(k) }));
    for (const { f, op, v } of this.filters) rows = rows.filter(({ data }) => { const x = f === '__name__' ? undefined : getPath(data, f); if (x === undefined) return false; const a = cmpVal(x), b = cmpVal(v);
      return op === '==' ? eq(a, b) : op === '!=' ? !eq(a, b) : op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : op === '>=' ? a >= b : op === 'in' ? v.some(y => eq(cmpVal(y), a)) : op === 'array-contains' ? Array.isArray(x) && x.some(y => eq(y, v)) : (() => { throw new Error('operador não suportado no mock: ' + op); })(); });
    for (const { f } of this.orders) rows = rows.filter(({ data }) => getPath(data, f) !== undefined);
    if (this.orders.length) rows.sort((A, B) => { for (const { f, dir } of this.orders) { const a = cmpVal(getPath(A.data, f)), b = cmpVal(getPath(B.data, f)); if (a < b) return dir === 'desc' ? 1 : -1; if (a > b) return dir === 'desc' ? -1 : 1; } return 0; });
    if (this.lim != null) rows = rows.slice(0, this.lim); return rows;
  }
  async get() { return new QuerySnap(this._docs().map(r => new DocSnap(r.ref, clone(r.data)))); }
}
let LOCK = Promise.resolve();
const db = {
  settings() {}, collection: (p) => new Query(p), doc: (p) => new DocRef(p), collectionGroup: (id) => new Query(id, [], [], null, true),
  getAll: (...refs) => Promise.all(refs.map(r => r.get())),
  batch() { const ops = []; const b = { set: (r, d, o) => (ops.push(() => applySet(r.path, d, !!(o && o.merge))), b), update: (r, d) => (ops.push(() => applyUpdate(r.path, d)), b), create: (r, d) => (ops.push(() => applyCreate(r.path, d)), b), delete: (r) => (ops.push(() => applyDelete(r.path)), b), commit: async () => { ops.forEach(f => f()); } }; return b; },
  runTransaction(fn) {
    const run = async () => {
      const writes = []; let wrote = false;
      const guard = () => { if (wrote) throw new Error('Firestore transactions require all reads to be executed before all writes.'); };
      const tx = {
        get: async (x) => { guard(); return x.get(); },
        getAll: async (...refs) => { guard(); return Promise.all(refs.map(r => r.get())); },
        set: (r, d, o) => { wrote = true; writes.push(() => applySet(r.path, d, !!(o && o.merge))); return tx; },
        update: (r, d) => { wrote = true; writes.push(() => applyUpdate(r.path, d)); return tx; },
        create: (r, d) => { wrote = true; writes.push(() => applyCreate(r.path, d)); return tx; },
        delete: (r) => { wrote = true; writes.push(() => applyDelete(r.path)); return tx; }
      };
      const out = await fn(tx);
      const snapshot = new Map([...STORE].map(([k, v]) => [k, clone(v)]));
      try { writes.forEach(f => f()); } catch (e) { STORE.clear(); snapshot.forEach((v, k) => STORE.set(k, v)); throw e; }
      return out;
    };
    const p = LOCK.then(run, run); LOCK = p.then(() => {}, () => {}); return p;
  }
};
/* Auth em memória */
const USERS = new Map(); const authErr = (code) => Object.assign(new Error(code), { code });
const auth = {
  async createUser(p) { if ([...USERS.values()].some(u => u.email === p.email)) throw authErr('auth/email-already-exists'); const uid = p.uid || 'u' + crypto.randomBytes(5).toString('hex'); const u = { uid, claims: {}, disabled: false, ...p }; USERS.set(uid, u); return u; },
  async getUser(uid) { if (!USERS.has(uid)) throw authErr('auth/user-not-found'); return USERS.get(uid); },
  async getUserByEmail(email) { const u = [...USERS.values()].find(x => x.email === email); if (!u) throw authErr('auth/user-not-found'); return u; },
  async setCustomUserClaims(uid, c) { (await this.getUser(uid)).claims = c; }, async updateUser(uid, p) { Object.assign(await this.getUser(uid), p); }, async revokeRefreshTokens() {},
  async generatePasswordResetLink(email) { return 'https://exemplo.test/reset?e=' + encodeURIComponent(email); }
};

/* ───────────────────────── Módulos substituídos ───────────────────────── */
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const wrap = (a, b) => { const fn = typeof a === 'function' ? a : b; fn.opts = typeof a === 'function' ? {} : a; return fn; };
const fakes = {
  'firebase-admin': Object.assign({ initializeApp() {}, firestore: Object.assign(() => db, { FieldValue, Timestamp }), auth: () => auth }),
  'firebase-functions/v2/https': { onCall: wrap, onRequest: wrap, HttpsError },
  'firebase-functions/v2/scheduler': { onSchedule: wrap },
  'firebase-functions/v2/firestore': { onDocumentCreated: (p, h) => h },
  'firebase-functions/params': { defineSecret: (n) => ({ value: () => process.env[n] || 'segredo-de-teste' }) }
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return fakes[req] || origLoad.call(this, req, ...rest); };
process.env.PAYMENT_PROVIDER = 'sandbox'; process.env.FUNCTIONS_EMULATOR = 'true'; process.env.PAYMENT_WEBHOOK_SECRET = 'segredo-de-teste';
const F = require('./functions.js');
const R = require('./business-rules.js');
const { getProvider } = require('./payment-provider.js');

/* ───────────────────────── Utilidades de teste ───────────────────────── */
const reqOf = (token, data) => ({ auth: token ? { uid: token.uid, token } : null, data });
const customer = (uid = 'u1') => ({ uid, role: 'customer', email: `${uid}@teste.local` });
const staff = (marketId = 'm1', perms = R.MARKET_ROLE_PRESETS.manager, uid = 'staff1') => ({ uid, role: 'market_staff', marketId, perms });
const admin = (perms = [], role = 'platform_admin', uid = 'adm1') => ({ uid, role, perms });
const call = (name, token, data) => F[name](reqOf(token, data));
const rejects = async (p, code) => { try { await p; } catch (e) { assert.equal(e.code, code, `esperava ${code}, veio ${e.code}: ${e.message}`); return e; } assert.fail('esperava rejeição ' + code); };
const get = (p) => STORE.get(p); const clock = () => ({ open: '00:00', close: '23:59' });
function seed() {
  STORE.clear(); USERS.clear();
  const hours = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), [clock()]]));
  STORE.set('markets/m1', { name: 'Mercado Um', status: 'active', acceptingOrders: true, cityId: 'c1' });
  STORE.set('marketAdmin/m1', { commissionRate: 0.1 });
  STORE.set('markets/m1/public/settings', { hours, closedDates: [], deliveryFee: 690, etaMinutes: 60, deliveryArea: { ceps: ['01310'] }, scheduling: { enabled: true, slotMinutes: 60 } });
  STORE.set('markets/m2', { name: 'Mercado Dois', status: 'active', acceptingOrders: true }); STORE.set('marketAdmin/m2', { commissionRate: 0.1 }); STORE.set('markets/m2/public/settings', { hours, deliveryFee: 500, deliveryArea: { ceps: ['01310'] } });
  const L = (o) => ({ name: 'Item', unit: 'un', price: 1000, allocated: 10, reserved: 0, committed: 0, active: true, hasPromo: false, stockStatus: 'ok', ...o });
  STORE.set('markets/m1/listings/L1', L({ name: 'Arroz 5kg', price: 2790 })); STORE.set('markets/m1/listings/L2', L({ name: 'Feijão 1kg', price: 800, allocated: 3 }));
  STORE.set('markets/m1/listings/L3', L({ name: 'Arroz 2kg', price: 1200 })); STORE.set('markets/m1/listings/L4', L({ name: 'Item caro', price: 5000 }));
  ['u1', 'u2'].forEach(u => STORE.set(`users/${u}/addresses/a1`, { cep: '01310100', district: 'Bela Vista', street: 'Rua A', number: '1', city: 'São Paulo', uf: 'SP', recipient: 'Fulano' }));
}
const sign = (obj) => { const raw = Buffer.from(JSON.stringify(obj)); return { raw, sig: crypto.createHmac('sha256', 'segredo-de-teste').update(raw).digest('hex') }; };
async function webhook(obj, sigOverride) {
  const { raw, sig } = sign(obj); const out = { code: 0, body: '' };
  const res = { status(c) { out.code = c; return res; }, send(b) { out.body = b; return res; } };
  await F.paymentWebhook({ method: 'POST', rawBody: raw, headers: { 'x-mm-signature': sigOverride ?? sig } }, res); return out;
}
let evSeq = 0;
const pay = (chargeId) => webhook({ id: 'ev' + (++evSeq), type: 'charge.paid', chargeId, occurredAt: Date.now() });
async function checkout(uid, items, extra = {}) {
  const token = customer(uid);
  const q = await call('quoteCart', token, { marketId: 'm1', items });
  return call('createCheckout', token, { marketId: 'm1', items, method: 'pix', addressId: 'a1', idempotencyKey: extra.key || crypto.randomBytes(6).toString('hex'), expectedTotal: extra.expectedTotal ?? q.totals.total, schedule: { mode: 'asap' }, ...extra.more });
}
const chargeOf = (orderId) => get(`payments/${orderId}`).providerChargeId;
async function paidOrder(uid = 'u1', items = [{ listingId: 'L1', qty: 1 }, { listingId: 'L2', qty: 1 }]) { const r = await checkout(uid, items); assert.ok(r.orderId, JSON.stringify(r)); await pay(chargeOf(r.orderId)); return r.orderId; }

/* ───────────────────────── Testes ───────────────────────── */
test('sem provedor configurado, a cobrança é recusada (nada é inventado)', async () => {
  seed(); const keep = process.env.PAYMENT_PROVIDER; delete process.env.PAYMENT_PROVIDER;
  try { assert.equal(getProvider().configured, false); await rejects(checkout('u1', [{ listingId: 'L1', qty: 1 }]), 'failed-precondition'); assert.equal([...STORE.keys()].filter(k => k.startsWith('orders/')).length, 0); }
  finally { process.env.PAYMENT_PROVIDER = keep; }
});

test('checkout: reserva estoque, não confirma pagamento, é idempotente', async () => {
  seed(); const r = await checkout('u1', [{ listingId: 'L1', qty: 2 }], { key: 'k1' });
  const o = get(`orders/${r.orderId}`); assert.equal(o.status, 'awaiting_payment'); assert.equal(o.payment.status, 'pending');
  assert.equal(get('markets/m1/listings/L1').reserved, 2); assert.equal(get('markets/m1/listings/L1').committed, 0);
  assert.equal(get(`reservations/${r.orderId}`).status, 'active'); assert.ok(!STORE.has(`orders/${r.orderId}/secrets/delivery`), 'código de entrega só existe depois de pago');
  assert.equal(o.totals.total, r.totals.total); assert.ok(o.totals.commission > 0);
  const again = await checkout('u1', [{ listingId: 'L1', qty: 2 }], { key: 'k1' }); assert.equal(again.duplicate, true); assert.equal(get('markets/m1/listings/L1').reserved, 2, 'repetir a requisição não reserva de novo');
});

test('checkout: total divergente volta para revisão sem reservar nem cobrar', async () => {
  seed(); const r = await checkout('u1', [{ listingId: 'L1', qty: 1 }], { expectedTotal: 1 });
  assert.equal(r.needsReview, true); assert.equal(get('markets/m1/listings/L1').reserved, 0); assert.equal([...STORE.keys()].filter(k => k.startsWith('orders/')).length, 0);
});

test('estoque: dois clientes disputando as últimas unidades — nunca vende além do alocado', async () => {
  seed(); // L2 tem 3 unidades
  const [a, b] = await Promise.all([checkout('u1', [{ listingId: 'L2', qty: 2 }]), checkout('u2', [{ listingId: 'L2', qty: 2 }])]);
  const ok = [a, b].filter(x => x.orderId); assert.equal(ok.length, 1, 'só um pedido passa'); assert.ok([a, b].some(x => x.needsReview));
  const l = get('markets/m1/listings/L2'); assert.ok(l.reserved + l.committed <= l.allocated); assert.equal(l.reserved, 2);
});

test('webhook: assinatura inválida é rejeitada; pagamento confirma uma única vez', async () => {
  seed(); const r = await checkout('u1', [{ listingId: 'L1', qty: 1 }, { listingId: 'L2', qty: 1 }]); const cid = chargeOf(r.orderId);
  assert.equal((await webhook({ id: 'x1', type: 'charge.paid', chargeId: cid }, 'assinatura-falsa')).code, 401); assert.equal(get(`orders/${r.orderId}`).status, 'awaiting_payment');
  const ev = { id: 'evA', type: 'charge.paid', chargeId: cid }; assert.equal((await webhook(ev)).code, 200);
  const o = get(`orders/${r.orderId}`); assert.equal(o.status, 'confirmed'); assert.equal(o.queue, 'picking'); assert.equal(o.payment.status, 'paid');
  assert.match(get(`orders/${r.orderId}/secrets/delivery`).code, /^\d{6}$/);
  const l1 = get('markets/m1/listings/L1'); assert.equal(l1.reserved, 0); assert.equal(l1.committed, 1); assert.equal(get(`reservations/${r.orderId}`).status, 'committed');
  const dup = await webhook(ev); assert.equal(dup.body, 'duplicate'); assert.equal(get('markets/m1/listings/L1').committed, 1);
  assert.equal([...STORE].filter(([k, v]) => k.startsWith('ledger/') && v.type === 'sale').length, 1);
  assert.ok([...STORE].some(([k, v]) => k.startsWith('markets/m1/notifications/') && v.type === 'new_order'), 'mercado é avisado');
});

test('expiração: pedido sem pagamento libera o estoque; pagamento tardio confirmado no provedor ainda vale', async () => {
  seed(); const r = await checkout('u1', [{ listingId: 'L1', qty: 3 }]); const o = get(`orders/${r.orderId}`); o.expiresAt = Timestamp.fromMillis(Date.now() - 10 * 60000); STORE.set(`orders/${r.orderId}`, o);
  await F.expireStaleOrders(); assert.equal(get(`orders/${r.orderId}`).status, 'cancelled'); assert.equal(get('markets/m1/listings/L1').reserved, 0); assert.equal(get(`reservations/${r.orderId}`).status, 'released');
  // pedido que o provedor já recebeu como pago, mas o webhook ainda não chegou: expiração verifica antes de cancelar
  const r2 = await checkout('u1', [{ listingId: 'L1', qty: 1 }]); const cid = chargeOf(r2.orderId); getProvider().verifyWebhook(sign({ id: 'z', type: 'charge.paid', chargeId: cid }).raw, { 'x-mm-signature': sign({ id: 'z', type: 'charge.paid', chargeId: cid }).sig }, 'segredo-de-teste');
  const o2 = get(`orders/${r2.orderId}`); o2.expiresAt = Timestamp.fromMillis(Date.now() - 10 * 60000); STORE.set(`orders/${r2.orderId}`, o2);
  await F.expireStaleOrders(); assert.equal(get(`orders/${r2.orderId}`).status, 'confirmed', 'não cancela pedido já pago no provedor');
});

test('o cliente não consegue marcar o próprio pedido como pago nem usar funções de mercado/admin', async () => {
  seed(); const orderId = (await checkout('u1', [{ listingId: 'L1', qty: 1 }])).orderId; const c = customer('u1');
  await rejects(call('marketAdvanceOrder', c, { orderId, to: 'picking' }), 'permission-denied');
  await rejects(call('confirmDelivery', c, { orderId, code: '000000' }), 'permission-denied');
  await rejects(call('adminSetCommission', c, { marketId: 'm1', percent: 0 }), 'permission-denied');
  await rejects(call('marketUpsertListing', c, { marketId: 'm1' }), 'permission-denied');
  await rejects(call('quoteCart', null, { marketId: 'm1', items: [{ listingId: 'L1', qty: 1 }], coupon: 'X' }), 'unauthenticated');
  await rejects(call('createCheckout', null, {}), 'unauthenticated');
  assert.equal(get(`orders/${orderId}`).status, 'awaiting_payment');
});

test('operação: separação → expedição → entrega com código (limite de tentativas, uso único, isolamento entre mercados)', async () => {
  seed(); const orderId = await paidOrder(); const s = staff();
  await rejects(call('marketAdvanceOrder', staff('m2'), { orderId, to: 'picking' }), 'permission-denied');
  await rejects(call('marketAdvanceOrder', staff('m1', ['orders.read']), { orderId, to: 'picking' }), 'permission-denied');
  await rejects(call('marketAdvanceOrder', s, { orderId, to: 'out_for_delivery' }), 'failed-precondition'); // não pula etapas
  await rejects(call('marketAdvanceOrder', s, { orderId, to: 'delivered' }), 'invalid-argument');           // entrega só pelo código
  await call('marketAdvanceOrder', s, { orderId, to: 'picking' }); await call('marketAdvanceOrder', s, { orderId, to: 'picked' });
  assert.equal(get(`orders/${orderId}`).status, 'ready_for_dispatch', 'separado vai direto para expedição');
  await call('marketAdvanceOrder', s, { orderId, to: 'out_for_delivery', courierName: 'Entregador' });
  const code = get(`orders/${orderId}/secrets/delivery`).code; const wrong = code === '123456' ? '654321' : '123456';
  for (let i = 1; i <= 4; i++) { const r = await call('confirmDelivery', s, { orderId, code: wrong }); assert.equal(r.ok, false); assert.equal(r.attemptsLeft, 5 - i); }
  const locked = await call('confirmDelivery', s, { orderId, code: wrong }); assert.equal(locked.locked, true);
  assert.equal((await call('confirmDelivery', s, { orderId, code })).locked, true, 'mesmo o código certo fica bloqueado durante o bloqueio');
  const sec = get(`orders/${orderId}/secrets/delivery`); sec.lockedUntil = Timestamp.fromMillis(Date.now() - 1000); STORE.set(`orders/${orderId}/secrets/delivery`, sec);
  await rejects(call('confirmDelivery', staff('m2', R.MARKET_PERMS), { orderId, code }), 'permission-denied');
  assert.deepEqual(await call('confirmDelivery', s, { orderId, code }), { ok: true }); assert.equal(get(`orders/${orderId}`).status, 'delivered');
  await rejects(call('confirmDelivery', s, { orderId, code }), 'failed-precondition'); // código de uso único
  assert.ok([...STORE].some(([k, v]) => k.startsWith('ledger/') && v.type === 'delivery_confirmed'));
});

test('falta de item: nunca substitui sem autorização; recusa reembolsa e ajusta comissão', async () => {
  seed(); const orderId = await paidOrder('u1', [{ listingId: 'L1', qty: 1 }, { listingId: 'L2', qty: 2 }]); const s = staff();
  await call('marketAdvanceOrder', s, { orderId, to: 'picking' });
  const { subId } = await call('marketReportMissingItem', s, { orderId, listingId: 'L1', substituteListingId: 'L4' }); // substituto mais caro
  await rejects(call('marketAdvanceOrder', s, { orderId, to: 'picked' }), 'failed-precondition'); // bloqueado enquanto o cliente não decide
  const before = get(`orders/${orderId}`).final;
  await rejects(call('customerRespondSubstitution', customer('u2'), { orderId, subId, decision: 'decline' }), 'not-found');
  await rejects(call('customerRespondSubstitution', customer('u1'), { orderId, subId, decision: 'accept' }), 'failed-precondition'); // diferença maior exige autorização do valor
  assert.equal(get(`orders/${orderId}/substitutions/${subId}`).status, 'pending');
  await call('customerRespondSubstitution', customer('u1'), { orderId, subId, decision: 'decline' });
  const o = get(`orders/${orderId}`); assert.equal(o.final.itemsPaid, before.itemsPaid - 2790); assert.equal(o.final.total, before.total - 2790); assert.equal(o.pendingSubstitutions, 0);
  assert.equal(o.final.commission, Math.round(o.final.itemsPaid * 0.1)); assert.equal(o.refundedTotal, 2790); assert.equal(o.refunds[0].status, 'pending');
  assert.equal(get('markets/m1/listings/L1').stockStatus, 'out_of_stock');
  await call('marketAdvanceOrder', s, { orderId, to: 'picked' }); // agora pode seguir
});

test('substituição aceita (mais barata) devolve a diferença; sem resposta no prazo = item retirado e reembolsado', async () => {
  seed(); const orderId = await paidOrder('u1', [{ listingId: 'L1', qty: 1 }]); const s = staff(); await call('marketAdvanceOrder', s, { orderId, to: 'picking' });
  const a = await call('marketReportMissingItem', s, { orderId, listingId: 'L1', substituteListingId: 'L3' }); // 12,00 < 27,90
  await call('customerRespondSubstitution', customer('u1'), { orderId, subId: a.subId, decision: 'accept' });
  let o = get(`orders/${orderId}`); assert.ok(o.items.some(i => i.listingId === 'L3' && i.substituteFor === 'L1')); assert.equal(o.refundedTotal, 2790 - 1200);
  // novo pedido: expira sem resposta
  const o2 = await paidOrder('u2', [{ listingId: 'L3', qty: 2 }]); await call('marketAdvanceOrder', s, { orderId: o2, to: 'picking' });
  const b = await call('marketReportMissingItem', s, { orderId: o2, listingId: 'L3', qty: 1 }); const sref = `orders/${o2}/substitutions/${b.subId}`; const sd = get(sref); sd.expiresAt = Timestamp.fromMillis(Date.now() - 1000); STORE.set(sref, sd);
  await F.expireSubstitutions(); assert.equal(get(sref).status, 'declined'); assert.equal(get(sref).resolvedBy, 'system'); assert.equal(get(`orders/${o2}`).refundedTotal, 1200);
});

test('cancelamento pelo cliente antes da separação: reembolso integral; só conclui com confirmação do provedor', async () => {
  seed(); const orderId = await paidOrder('u1', [{ listingId: 'L1', qty: 1 }]);
  await rejects(call('customerCancelOrder', customer('u2'), { orderId }), 'not-found');
  const r = await call('customerCancelOrder', customer('u1'), { orderId }); assert.equal(r.refund, true);
  let o = get(`orders/${orderId}`); assert.equal(o.status, 'refund_processing'); assert.equal(o.refundedTotal, o.totals.total); assert.equal(get('markets/m1/listings/L1').committed, 0);
  const providerRefundId = Object.values(o.refundProvider)[0];
  assert.equal((await webhook({ id: 'r1', type: 'refund.done', chargeId: chargeOf(orderId), refundId: providerRefundId })).code, 200); assert.equal(get(`orders/${orderId}`).status, 'refunded');
  assert.equal((await webhook({ id: 'r1', type: 'refund.done', chargeId: chargeOf(orderId), refundId: providerRefundId })).body, 'duplicate');
  // depois de iniciar a separação, cancelar vira chamado para o suporte (não é automático)
  const o2 = await paidOrder('u1', [{ listingId: 'L3', qty: 1 }]); await call('marketAdvanceOrder', staff(), { orderId: o2, to: 'picking' });
  const e = await call('customerCancelOrder', customer('u1'), { orderId: o2 }); assert.equal(e.escalated, true); assert.equal(get(`orders/${o2}`).status, 'picking');
});

test('comissão e repasse: calculados sobre produtos pagos, sem a taxa de entrega', async () => {
  seed(); const r = await checkout('u1', [{ listingId: 'L1', qty: 1 }]); const t = get(`orders/${r.orderId}`).totals;
  assert.equal(t.commission, Math.round(t.itemsPaid * 0.1)); assert.equal(t.deliveryFee, 690);
  assert.equal(t.marketReceivable, t.itemsPaid - t.commission + 690, 'entrega pertence ao mercado');
});

test('permissões de equipe: só concede o que possui; convite não cria senha', async () => {
  seed(); const lim = staff('m1', ['staff.manage', 'orders.read'], 'mgr');
  const r = await call('marketInviteStaff', lim, { marketId: 'm1', name: 'Novo', email: 'novo@teste.local', perms: ['orders.read', 'finance.read'] }).catch(e => e);
  if (!(r instanceof Error)) { const claims = [...USERS.values()].find(u => u.email === 'novo@teste.local').claims; assert.ok(!claims.perms.includes('finance.read'), 'não pode conceder permissão que não tem'); assert.ok(r.passwordSetupLink); assert.equal([...USERS.values()].find(u => u.email === 'novo@teste.local').password, undefined); }
  else assert.equal(r.code, 'permission-denied');
});
