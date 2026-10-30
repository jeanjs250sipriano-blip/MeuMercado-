const L = require('./lib.js'); const assert = require('assert');
const R = []; const ok = (n, c, x) => { R.push((c ? 'OK   ' : 'FAIL ') + n + (x ? ' — ' + x : '')); };
(async () => {
  const T = await L.start(); const { p, go, txt, call } = T; await L.setupAdmin(T); await L.createMarket(T);
  const ids = await p.evaluate(async () => ({ cat: (await api.col('categories'))[0].id, mid: (await api.col('markets'))[0].id }));
  const si = (u, pw) => p.evaluate(([u, pw]) => api.signIn(u, pw), [u, pw]);
  await si('central', 'abcd');
  const hrs = {}; for (let i = 0; i < 7; i++) hrs[String(i)] = [{ open: '00:00', close: '23:59' }]; await call('marketUpdateSettings', { marketId: ids.mid, settings: { hours: hrs } });
  const lid = (await call('marketUpsertListing', { marketId: ids.mid, name: 'Arroz', brand: 'Bom', unit: 'kg', size: 5, categoryId: ids.cat, price: 10000, allocated: 5, active: true, kind: 'product' })).id;
  await p.evaluate(() => api.signOut()); await p.evaluate(() => api.signUp('ana', 'senha1', 'Ana'));
  await p.evaluate(async () => { await api.add(`users/${SESSION.user.uid}/addresses`, { label: 'Casa', street: 'Rua A', number: '10', district: 'Centro', city: 'Campinas', uf: 'SP', cep: '13010000', isDefault: true }); });
  const adr = await p.evaluate(async () => (await api.col(`users/${SESSION.user.uid}/addresses`))[0].id);
  const mk = async (qty, key) => { const q = await call('quoteCart', { marketId: ids.mid, items: [{ listingId: lid, qty }] }); return call('createCheckout', { marketId: ids.mid, items: [{ listingId: lid, qty }], addressId: adr, method: 'pix', schedule: { mode: 'asap' }, expectedTotal: q.totals.total, expectedPrices: Object.fromEntries(q.lines.map(l => [l.listingId, l.net])), idempotencyKey: key }); };
  const o1 = await mk(1, 'k1'); const o1b = await mk(1, 'k1'); ok('checkout idempotente', o1.orderId === o1b.orderId);
  const stock = async () => p.evaluate(async ([m, l]) => { const d = await api.doc(`markets/${m}/listings/${l}`); return [d.allocated - d.committed - d.reserved, d.reserved]; }, [ids.mid, lid]);
  ok('estoque reservado', JSON.stringify(await stock()) === '[4,1]', JSON.stringify(await stock()));
  await call('simulatePayment', { orderId: o1.orderId, outcome: 'approve', attemptKey: 'a' }); const dup = await call('simulatePayment', { orderId: o1.orderId, outcome: 'approve', attemptKey: 'a' }); ok('pagamento idempotente', dup.duplicate === true);
  const ord = (id) => p.evaluate((id) => api.doc('orders/' + id), id);
  let o = await ord(o1.orderId); const T0 = o.totals; console.log('totals', JSON.stringify(T0));
  ok('pedido confirmado', o.status === 'confirmed', o.status);
  await si('central', 'abcd');
  for (const to of ['picking', 'picked', 'ready_for_dispatch', 'out_for_delivery']) { try { await call('marketAdvanceOrder', { orderId: o1.orderId, to }); } catch (e) { console.log('adv', to, e.message); } }
  o = await ord(o1.orderId); ok('em rota', o.status === 'out_for_delivery', o.status);
  await si('ana', 'senha1'); const code = await p.evaluate((id) => api.doc(`orders/${id}/secrets/delivery`), o1.orderId); ok('cliente vê código 6 dígitos', /^\d{6}$/.test(code.code));
  await si('central', 'abcd'); const bad = code.code === '000000' ? '111111' : '000000'; const w1 = await call('confirmDelivery', { orderId: o1.orderId, code: bad }); ok('código errado recusado', w1.ok === false && w1.attemptsLeft >= 0, JSON.stringify(w1)); const mSecret = await p.evaluate((id) => api.doc(`orders/${id}/secrets/delivery`).then(x => x && x.code, () => 'DENIED'), o1.orderId); ok('mercado não lê o código', mSecret == null || mSecret === 'DENIED' || mSecret === undefined, String(mSecret));
  const good = await call('confirmDelivery', { orderId: o1.orderId, code: code.code }); ok('código certo confirma', good.ok === true, JSON.stringify(good)); let e2; try { await call('confirmDelivery', { orderId: o1.orderId, code: code.code }); } catch (e) { e2 = e.message; } ok('código de uso único', !!e2, e2);
  o = await ord(o1.orderId); ok('entregue', o.status === 'delivered', o.status);
  await si('ana', 'senha1'); await call('completeOrder', { orderId: o1.orderId }); o = await ord(o1.orderId); ok('concluído', o.status === 'completed');
  await call('completeOrder', { orderId: o1.orderId }).catch(() => {});
  const led = await p.evaluate(async () => (await api.call('adminIntegrityCheck', {}).catch(e => ({ err: e.message }))), 0); 
  await si('admin', 'senha1'); const bal = await call('getMarketBalance', { marketId: ids.mid }); console.log('balance', JSON.stringify(bal));
  ok('saldo = recebível do mercado', bal.available === o.final.marketReceivable || bal.balance === o.final.marketReceivable, JSON.stringify(bal));
  const integ = await call('adminIntegrityCheck', {}); console.log('integrity', JSON.stringify(integ).slice(0, 300));
  const pay = await call('adminRecordPayout', { marketId: ids.mid, amount: bal.available ?? bal.balance, idempotencyKey: 'p1', method: 'manual' }); const pay2 = await call('adminRecordPayout', { marketId: ids.mid, amount: bal.available ?? bal.balance, idempotencyKey: 'p1', method: 'manual' }); ok('repasse idempotente', pay.id === pay2.id, JSON.stringify(pay));
  const bal2 = await call('getMarketBalance', { marketId: ids.mid }); ok('saldo zerado após repasse', (bal2.available ?? bal2.balance) === 0, JSON.stringify(bal2));
  // pedido 2: expira
  await si('ana', 'senha1'); const o2 = await mk(2, 'k2'); await call('simulatePayment', { orderId: o2.orderId, outcome: 'expire', attemptKey: 'x' }); const o2d = await ord(o2.orderId); ok('expirado libera reserva', ['expired', 'cancelled'].includes(o2d.status) && JSON.stringify(await stock()) === '[4,0]', o2d.status + JSON.stringify(await stock()));
  await si('ana', 'senha1'); const o3 = await mk(1, 'k3'); await call('simulatePayment', { orderId: o3.orderId, outcome: 'approve', attemptKey: 'b' }); await si('central', 'abcd');
  for (const to of ['picking', 'picked', 'out_for_delivery']) { await call('marketAdvanceOrder', { orderId: o3.orderId, to }).catch(() => {}); } await call('marketAdvanceOrder', { orderId: o3.orderId, to: 'out_for_delivery' }).catch(() => {});
  const s3 = await ord(o3.orderId); let wl; for (let i = 0; i < 8; i++) wl = await call('confirmDelivery', { orderId: o3.orderId, code: '000000' }); ok('bloqueio após tentativas', s3.status === 'out_for_delivery' && wl.locked === true, s3.status + JSON.stringify(wl));
  // persistência
  await p.reload(); await p.waitForTimeout(1500); const after = await p.evaluate(async (id) => (await api.doc('orders/' + id)).status, o1.orderId); ok('persistência após recarregar', after === 'completed', after);
  console.log(R.join('\n')); console.log('errors', T.errs); await T.b.close();
})().catch(e => { console.log(R.join('\n')); console.error('CRASH', e.message); process.exit(1); });
