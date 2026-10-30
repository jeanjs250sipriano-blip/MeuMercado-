/* Testes de integração do backend local (regras de negócio sobre o store real). Execução: node --test tests-backend.js */
const test = require('node:test'); const assert = require('node:assert/strict');
const MMStore = require('./mm-store.js'); const MMAuth = require('./mm-auth.js'); const MMPay = require('./mm-pay.js'); const { createBackend } = require('./mm-backend.js'); const R = require('./business-rules.js');

async function harness() {
  const store = new MMStore.Store(); await store.open();
  const auth = MMAuth.create(store, { iterations: 1000, storage: null });
  const provider = MMPay.create(store); const be = createBackend({ store, auth, provider });
  const H = { store, auth, be, db: store.db };
  H.ctx = async (u) => { const a = await auth.getByUsername(u); return { auth: { uid: a.uid, token: auth.claimsOf(a) } }; };
  H.call = async (u, name, data) => be.call(name, data, await H.ctx(u));
  await auth.createFirstAdmin({ username: 'admin', password: 'senha1' });
  return H;
}
const HOURS = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(i => [String(i), [{ open: '00:00', close: '23:59' }]]));
async function world(H, { allocated = 10, price = 1000, commission = 10, fee = 800 } = {}) {
  await H.call('admin', 'adminUpsertCity', { name: 'Campinas', uf: 'SP', active: true });
  await H.call('admin', 'adminUpsertCategory', { name: 'Mercearia' });
  const cat = (await H.db.collection('categories').get()).docs[0].id;
  const m = await H.call('admin', 'adminCreateMarket', { name: 'Mercado A', cityId: 'campinas-sp', commissionPercent: commission, deliveryFee: fee, hours: HOURS, deliveryArea: { ceps: ['130'], districts: [], center: null, radiusKm: null }, owner: { username: 'donoa', name: 'Dono A', password: 'abcd' }, status: 'active' });
  const lst = await H.call('donoa', 'marketUpsertListing', { marketId: m.marketId, name: 'Arroz 5kg', categoryId: cat, unit: 'kg', size: 5, price, allocated, active: true });
  await H.call('admin', 'adminCreateAccount', { username: 'ana', password: 'abcd', role: 'customer', name: 'Ana' });
  const ana = await H.auth.getByUsername('ana');
  await H.db.collection('users').doc(ana.uid).collection('addresses').doc('a1').set({ cep: '13010000', street: 'Rua 1', number: '1', city: 'Campinas', district: 'Centro' });
  return { marketId: m.marketId, listingId: lst.id, anaUid: ana.uid };
}
async function buy(H, w, qty, user = 'ana', key = Math.random().toString(36)) {
  const items = [{ listingId: w.listingId, qty }];
  const q = await H.call(user, 'quoteCart', { marketId: w.marketId, items });
  return H.call(user, 'createCheckout', { marketId: w.marketId, items, method: 'pix', addressId: 'a1', idempotencyKey: key, expectedTotal: q.totals.total, schedule: { mode: 'asap' } });
}
const L = (H, w) => H.store.getRaw(`markets/${w.marketId}/listings/${w.listingId}`);

test('fluxo: admin cria mercado ativo, cliente compra, reserva, pagamento aprovado confirma e entra na fila', async () => {
  const H = await harness(); const w = await world(H);
  assert.equal(H.store.getRaw(`markets/${w.marketId}`).status, 'active');
  const r = await buy(H, w, 3); assert.ok(r.orderId);
  assert.equal(L(H, w).reserved, 3);
  const o1 = H.store.getRaw(`orders/${r.orderId}`); assert.equal(o1.status, 'awaiting_payment');
  assert.equal(o1.totals.total, 3000 + 800);
  await H.call('ana', 'simulatePayment', { orderId: r.orderId, outcome: 'approve', attemptKey: 'k1' });
  const o2 = H.store.getRaw(`orders/${r.orderId}`); assert.equal(o2.status, 'confirmed'); assert.equal(o2.queue, 'picking');
  const l = L(H, w); assert.equal(l.reserved, 0); assert.equal(l.committed, 3); assert.equal(R.availableQty(l), 7);
  // idempotência: repetir a mesma tentativa não duplica razão contábil
  await H.call('ana', 'simulatePayment', { orderId: r.orderId, outcome: 'approve', attemptKey: 'k1' });
  await H.call('ana', 'simulatePayment', { orderId: r.orderId, outcome: 'approve', attemptKey: 'k2' });
  const sales = (await H.db.collection('ledger').where('type', '==', 'sale').get()).docs; assert.equal(sales.length, 1);
  assert.equal(L(H, w).committed, 3);
});
test('exemplo do prompt (cupom do mercado): R$100 − R$10, frete R$8, 10% → comissão R$9, mercado recebe R$89, total R$98', async () => {
  const H = await harness(); const w = await world(H, { price: 10000, allocated: 5 });
  const cp = (await H.call('donoa', 'marketUpsertCoupon', { marketId: w.marketId, code: 'DEZ', type: 'fixed', value: 1000, active: true, visibility: 'public' })).code;
  const items = [{ listingId: w.listingId, qty: 1 }];
  const q = await H.call('ana', 'quoteCart', { marketId: w.marketId, items, coupon: cp }); assert.equal(q.totals.total, 9800);
  const r = await H.call('ana', 'createCheckout', { marketId: w.marketId, items, method: 'pix', addressId: 'a1', idempotencyKey: 'x1', coupon: cp, expectedTotal: 9800, schedule: { mode: 'asap' } });
  const t = H.store.getRaw(`orders/${r.orderId}`).totals; assert.equal(t.commission, 900); assert.equal(t.marketReceivable, 8900); assert.equal(t.platformSubsidy || 0, 0);
});
test('cupom da plataforma: custo registrado à parte (subsídio) e mercado recebe como se não houvesse desconto', async () => {
  const H = await harness(); const w = await world(H, { price: 10000, allocated: 5 });
  await H.call('admin', 'adminUpsertCoupon', { code: 'PLAT', type: 'fixed', value: 1000, active: true, visibility: 'public' });
  const items = [{ listingId: w.listingId, qty: 1 }];
  const r = await H.call('ana', 'createCheckout', { marketId: w.marketId, items, method: 'pix', addressId: 'a1', idempotencyKey: 'x2', coupon: 'PLAT', expectedTotal: 9800, schedule: { mode: 'asap' } });
  const t = H.store.getRaw(`orders/${r.orderId}`).totals; assert.equal(t.total, 9800); assert.equal(t.platformSubsidy, 1000); assert.equal(t.marketReceivable, 9900);
});
test('sem oversell: 5 compradores disputam 3 unidades; esgotado nunca fica negativo', async () => {
  const H = await harness(); const w = await world(H, { allocated: 3 });
  for (let i = 0; i < 4; i++) await H.call('admin', 'adminCreateAccount', { username: 'cli' + i, password: 'abcd', role: 'customer' }).then(async () => { const a = await H.auth.getByUsername('cli' + i); await H.db.collection('users').doc(a.uid).collection('addresses').doc('a1').set({ cep: '13010000', street: 'R', number: '1', city: 'C' }); });
  const users = ['ana', 'cli0', 'cli1', 'cli2', 'cli3'];
  const res = await Promise.allSettled(users.map(u => buy(H, w, 1, u)));
  const ok = res.filter(x => x.status === 'fulfilled' && x.value.orderId).length; assert.equal(ok, 3);
  const l = L(H, w); assert.equal(l.reserved, 3); assert.equal(R.availableQty(l), 0);
});
test('reserva expira exatamente e libera estoque; pagamento após expirar é bloqueado', async () => {
  const H = await harness(); const w = await world(H); const r = await buy(H, w, 2);
  await H.db.collection('orders').doc(r.orderId).update({ expiresAt: MMStore.Timestamp.fromMillis(Date.now() - 1000) });
  await assert.rejects(H.call('ana', 'simulatePayment', { orderId: r.orderId, outcome: 'approve' }), /expirou/);
  assert.equal(H.store.getRaw(`orders/${r.orderId}`).status, 'cancelled'); assert.equal(L(H, w).reserved, 0);
  const r2 = await buy(H, w, 1); await H.db.collection('orders').doc(r2.orderId).update({ expiresAt: MMStore.Timestamp.fromMillis(Date.now() - 1) });
  const sw = await H.be.internals.sweep(); assert.equal(sw.expiredOrders, 1); assert.equal(L(H, w).reserved, 0);
});
test('pagamento recusado não conta como recebido, mantém reserva e permite nova tentativa', async () => {
  const H = await harness(); const w = await world(H); const r = await buy(H, w, 2);
  await H.call('ana', 'simulatePayment', { orderId: r.orderId, outcome: 'refuse', attemptKey: 'a' });
  let p = H.store.getRaw(`payments/${r.orderId}`); assert.equal(p.status, 'refused'); assert.equal(H.store.getRaw(`orders/${r.orderId}`).status, 'awaiting_payment'); assert.equal(L(H, w).reserved, 2);
  assert.equal((await H.db.collection('ledger').get()).size, 0);
  await H.call('ana', 'simulatePayment', { orderId: r.orderId, outcome: 'approve', attemptKey: 'b' });
  p = H.store.getRaw(`payments/${r.orderId}`); assert.equal(p.status, 'paid'); assert.equal(p.attempts.length, 2);
});
test('cancelamento após pagamento: estoque volta e reembolso total; sem duplicar', async () => {
  const H = await harness(); const w = await world(H); const r = await buy(H, w, 2);
  await H.call('ana', 'simulatePayment', { orderId: r.orderId, outcome: 'approve' });
  await H.call('ana', 'customerCancelOrder', { orderId: r.orderId });
  const o = H.store.getRaw(`orders/${r.orderId}`); assert.equal(o.status, 'refunded'); assert.equal(L(H, w).committed, 0);
  assert.equal(H.store.getRaw(`payments/${r.orderId}`).status, 'refunded');
  const refs = (await H.db.collection('ledger').where('type', '==', 'refund_done').get()).size; assert.equal(refs, 1);
});

async function advance(H, w, orderId, user = 'donoa') {
  for (const to of ['picking', 'picked', 'out_for_delivery']) await H.call(user, 'marketAdvanceOrder', { orderId, to });
}
async function deliver(H, orderId, user = 'donoa') {
  const code = H.store.getRaw(`orders/${orderId}/secrets/delivery`).code;
  return H.call(user, 'confirmDelivery', { orderId, code });
}
test('ciclo completo até concluído + repasse: saldo, repasse único, idempotência e estorno', async () => {
  const H = await harness(); const w = await world(H, { price: 10000, allocated: 5 });
  await H.call('admin', 'adminSetPlatformConfig', { disputeWindowMinutes: 0 });
  const r = await buy(H, w, 1); await H.call('ana', 'simulatePayment', { orderId: r.orderId, outcome: 'approve' });
  await advance(H, w, r.orderId);
  const bad = await H.call('donoa', 'confirmDelivery', { orderId: r.orderId, code: '000000' }); assert.equal(bad.ok, false);
  assert.equal((await deliver(H, r.orderId)).ok, true); assert.equal(H.store.getRaw(`orders/${r.orderId}`).status, 'delivered');
  assert.equal((await deliver(H, r.orderId).catch(e => ({ ok: false, e: e.message }))).ok, false); // código de uso único
  assert.equal((await H.call('admin', 'getMarketBalance', { marketId: w.marketId })).available, 0);
  await H.be.internals.sweep(); assert.equal(H.store.getRaw(`orders/${r.orderId}`).status, 'completed');
  const bal = await H.call('donoa', 'getMarketBalance', {}); assert.equal(bal.available, 10000 - 1000 + 800);
  const p1 = await H.call('admin', 'adminRecordPayout', { marketId: w.marketId, amount: 5000, idempotencyKey: 'k1', reference: 'PIX-1' });
  const p1b = await H.call('admin', 'adminRecordPayout', { marketId: w.marketId, amount: 5000, idempotencyKey: 'k1' }); assert.equal(p1b.duplicate, true);
  await assert.rejects(H.call('admin', 'adminRecordPayout', { marketId: w.marketId, amount: 5000 }), /Saldo insuficiente/);
  assert.equal((await H.call('donoa', 'getMarketBalance', {})).available, 9800 - 5000);
  await H.call('admin', 'adminReversePayout', { marketId: w.marketId, payoutId: p1.payoutId, reason: 'teste' });
  assert.equal((await H.call('donoa', 'getMarketBalance', {})).available, 9800);
  assert.equal((await H.call('admin', 'adminIntegrityCheck', {})).issues.length, 0);
  await assert.rejects(H.call('ana', 'adminRecordPayout', { marketId: w.marketId }), /permiss/);
});
test('reembolso parcial pós-conclusão debita mercado e comissão proporcionalmente; sem duplicar', async () => {
  const H = await harness(); const w = await world(H, { price: 10000, allocated: 5 });
  await H.call('admin', 'adminSetPlatformConfig', { disputeWindowMinutes: 0 });
  const r = await buy(H, w, 1); await H.call('ana', 'simulatePayment', { orderId: r.orderId, outcome: 'approve' }); await advance(H, w, r.orderId); await deliver(H, r.orderId); await H.be.internals.sweep();
  await H.call('admin', 'adminRefundOrder', { orderId: r.orderId, amount: 5400, reason: 'avaria' });
  const o = H.store.getRaw(`orders/${r.orderId}`); assert.equal(o.refundedTotal, 5400); assert.equal(o.status, 'completed'); assert.equal(H.store.getRaw(`payments/${r.orderId}`).status, 'partially_refunded');
  const bal = await H.call('admin', 'getMarketBalance', { marketId: w.marketId }); assert.equal(bal.available, 9800 - 4900);
  assert.equal((await H.call('admin', 'adminIntegrityCheck', {})).issues.length, 0);
  await assert.rejects(H.call('admin', 'adminRefundOrder', { orderId: r.orderId, amount: 99999, reason: 'x' }), /maior/);
});
test('contestação bloqueia conclusão; falha de entrega e novo envio', async () => {
  const H = await harness(); const w = await world(H, { allocated: 5 });
  const r = await buy(H, w, 1); await H.call('ana', 'simulatePayment', { orderId: r.orderId, outcome: 'approve' }); await advance(H, w, r.orderId);
  await H.call('donoa', 'marketReportDeliveryFailure', { orderId: r.orderId, reason: 'cliente ausente' }); assert.equal(H.store.getRaw(`orders/${r.orderId}`).status, 'delivery_failed');
  await H.call('donoa', 'marketAdvanceOrder', { orderId: r.orderId, to: 'out_for_delivery' }); await deliver(H, r.orderId);
  await H.call('ana', 'customerDisputeDelivery', { orderId: r.orderId, reason: 'faltou item' }); assert.equal(H.store.getRaw(`orders/${r.orderId}`).disputed, true);
  await assert.rejects(H.call('ana', 'completeOrder', { orderId: r.orderId }), /contestação/);
  await H.call('admin', 'adminResolveDispute', { orderId: r.orderId, resolution: 'dismiss' }); await H.call('ana', 'completeOrder', { orderId: r.orderId });
  assert.equal(H.store.getRaw(`orders/${r.orderId}`).status, 'completed');
});
test('mercado cancela pedido separado: estoque volta e cliente é reembolsado integralmente', async () => {
  const H = await harness(); const w = await world(H, { allocated: 5 });
  const r = await buy(H, w, 2); await H.call('ana', 'simulatePayment', { orderId: r.orderId, outcome: 'approve' }); await H.call('donoa', 'marketAdvanceOrder', { orderId: r.orderId, to: 'picking' });
  await H.call('donoa', 'marketCancelOrder', { orderId: r.orderId, reason: 'sem condições' });
  assert.equal(H.store.getRaw(`orders/${r.orderId}`).status, 'refunded'); assert.equal(L(H, w).committed, 0); assert.equal(R.availableQty(L(H, w)), 5);
});
test('permissões nas funções: cliente não opera pedido; mercado B não mexe no mercado A', async () => {
  const H = await harness(); const w = await world(H, { allocated: 5 });
  await H.call('admin', 'adminCreateMarket', { name: 'Mercado B', cityId: 'campinas-sp', commissionPercent: 5, hours: HOURS, deliveryArea: { ceps: ['130'] }, deliveryFee: 500, owner: { username: 'donob', password: 'abcd' }, status: 'active' });
  const r = await buy(H, w, 1); await H.call('ana', 'simulatePayment', { orderId: r.orderId, outcome: 'approve' });
  await assert.rejects(H.call('donob', 'marketAdvanceOrder', { orderId: r.orderId, to: 'picking' }), /permiss/);
  await assert.rejects(H.call('ana', 'marketAdvanceOrder', { orderId: r.orderId, to: 'picking' }), /permiss/);
  await assert.rejects(H.call('donob', 'marketUpsertListing', { marketId: w.marketId, id: w.listingId, price: 1 }), /permiss/);
  await assert.rejects(H.be.call('adminCreateMarket', {}, {}), /Entre/);
});
