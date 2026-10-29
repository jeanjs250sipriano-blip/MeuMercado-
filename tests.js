'use strict';
// Testes das regras de negócio puras.  Execute:  node --test tests.js
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./business-rules.js');

const NOW = new Date('2026-10-28T12:00:00-03:00').getTime();
const L = (o) => ({ name: 'Item', price: 1000, allocated: 100, reserved: 0, committed: 0, active: true, ...o });
const mkt = { commissionRate: 0.10, deliveryFee: 800 };

test('estoque: disponível = alocado - reservado - comprometido', () => {
  assert.equal(R.availableQty(L({ allocated: 100, reserved: 10, committed: 60 })), 30);
  assert.equal(R.availableQty(L({ allocated: 5, reserved: 9, committed: 0 })), 0);
});

test('estoque: reduzir alocação respeita comprometido e reservas (exemplo 100/60)', () => {
  const l = L({ allocated: 100, committed: 60, reserved: 0 });
  assert.equal(R.minAllocation(l), 60);
  assert.equal(R.availableQty(l), 40);
});

test('estoque: status esgotado e baixo', () => {
  assert.equal(R.stockStatus(L({ allocated: 3, committed: 3 })), 'out_of_stock');
  assert.equal(R.stockStatus(L({ allocated: 8, committed: 4, lowStockAt: 5 })), 'low');
  assert.equal(R.stockStatus(L({ allocated: 100 })), 'ok');
});

test('promoções: preço fixo, percentual, compre 5 pague 4, progressivo', () => {
  assert.equal(R.priceLine(L({ promo: { type: 'price', price: 800 } }), 2, NOW).net, 1600);
  assert.equal(R.priceLine(L({ promo: { type: 'percent', percent: 10 } }), 2, NOW).net, 1800);
  assert.equal(R.priceLine(L({ promo: { type: 'buyxpayy', buy: 5, pay: 4 } }), 5, NOW).net, 4000);
  assert.equal(R.priceLine(L({ promo: { type: 'buyxpayy', buy: 5, pay: 4 } }), 11, NOW).net, 11000 - 2000);
  const tiers = { type: 'tiers', tiers: [{ minQty: 3, percent: 5 }, { minQty: 6, percent: 10 }] };
  assert.equal(R.priceLine(L({ promo: tiers }), 2, NOW).promoDiscount, 0);
  assert.equal(R.priceLine(L({ promo: tiers }), 6, NOW).net, 5400);
});

test('promoções: fora do período não se aplica', () => {
  const p = { type: 'percent', percent: 50, start: '2026-01-01', end: '2026-02-01' };
  assert.equal(R.priceLine(L({ promo: p }), 1, NOW).promoDiscount, 0);
});

test('cotação: comissão incide só sobre produtos pagos, excluindo taxa de entrega', () => {
  const q = R.computeQuote({ nowMs: NOW, marketId: 'm1', userId: 'u1', items: [{ listingId: 'a', qty: 2 }], listings: { a: L({}) }, market: mkt });
  assert.equal(q.totals.itemsPaid, 2000);
  assert.equal(q.totals.commission, 200);           // 10% de 2000, sem os 800 da entrega
  assert.equal(q.totals.total, 2800);
  assert.equal(q.totals.marketReceivable, 2000 - 200 + 800);
  assert.equal(q.totals.platformNet, 200);
});

test('cotação: cupom da plataforma gera subsídio e o mercado recebe o devido', () => {
  const coupon = { code: 'MM10', type: 'fixed', value: 500, fundedBy: 'platform', active: true };
  const q = R.computeQuote({ nowMs: NOW, marketId: 'm1', userId: 'u1', items: [{ listingId: 'a', qty: 2 }], listings: { a: L({}) }, market: mkt, coupon });
  assert.equal(q.totals.couponDiscountPlatform, 500);
  assert.equal(q.totals.itemsPaid, 1500);
  assert.equal(q.totals.commission, 150);           // sobre o valor efetivamente pago
  assert.equal(q.totals.total, 1500 + 800);
  assert.equal(q.totals.marketReceivable, 2000 - 150 + 800);  // mercado não perde com o desconto da plataforma
  assert.equal(q.totals.platformNet, 150 - 500);
  // conservação: o que o cliente paga = repasse ao mercado + resultado líquido da plataforma
  assert.equal(q.totals.total, q.totals.marketReceivable + q.totals.platformNet);
});

test('cotação: cupom compartilhado divide a origem do desconto', () => {
  const coupon = { code: 'SH', type: 'percent', value: 10, fundedBy: 'shared', sharePlatformPct: 50, active: true };
  const q = R.computeQuote({ nowMs: NOW, marketId: 'm1', userId: 'u1', items: [{ listingId: 'a', qty: 10 }], listings: { a: L({}) }, market: mkt, coupon });
  assert.equal(q.totals.couponDiscountPlatform + q.totals.couponDiscountMarket, 1000);
  assert.equal(q.totals.couponDiscountPlatform, 500);
  assert.equal(q.totals.total, q.totals.marketReceivable + q.totals.platformNet);
});

test('cotação: frete grátis acima do valor é custo do mercado e a comissão ignora frete', () => {
  const m = { ...mkt, freeShippingAbove: 5000 };
  const q = R.computeQuote({ nowMs: NOW, marketId: 'm1', userId: 'u1', items: [{ listingId: 'a', qty: 6 }], listings: { a: L({}) }, market: m });
  assert.equal(q.totals.deliveryPaid, 0);
  assert.equal(q.totals.deliveryDiscountMarket, 800);
  assert.equal(q.totals.marketReceivable, 6000 - 600 + 0);
});

test('cotação: bloqueia item esgotado, acima do saldo e inativo', () => {
  const base = { nowMs: NOW, marketId: 'm1', userId: 'u1', market: mkt };
  assert.ok(R.computeQuote({ ...base, items: [{ listingId: 'a', qty: 1 }], listings: { a: L({ allocated: 2, committed: 2 }) } }).blocking);
  assert.ok(R.computeQuote({ ...base, items: [{ listingId: 'a', qty: 5 }], listings: { a: L({ allocated: 3 }) } }).blocking);
  assert.ok(R.computeQuote({ ...base, items: [{ listingId: 'a', qty: 1 }], listings: { a: L({ active: false }) } }).blocking);
  assert.ok(R.computeQuote({ ...base, items: [{ listingId: 'zzz', qty: 1 }], listings: {} }).blocking);
});

test('cotação: mudança de preço é sinalizada e não silenciosa', () => {
  const q = R.computeQuote({ nowMs: NOW, marketId: 'm1', userId: 'u1', market: mkt, items: [{ listingId: 'a', qty: 1 }], listings: { a: L({ price: 1200 }) }, expectedPrices: { a: 1000 } });
  assert.ok(q.priceChanged);
  assert.equal(q.issues.find(i => i.code === 'PRICE_CHANGED').now, 1200);
});

test('cupom: validade, limites e elegibilidade', () => {
  const ctx = { nowMs: NOW, marketId: 'm1', userId: 'u1', subtotalNet: 5000, userUses: 0 };
  assert.ok(R.couponIsValid({ active: true }, ctx).ok);
  assert.ok(!R.couponIsValid({ active: true, validTo: '2026-01-01' }, ctx).ok);
  assert.ok(!R.couponIsValid({ active: true, marketId: 'outro' }, ctx).ok);
  assert.ok(!R.couponIsValid({ active: true, maxUses: 3, usedCount: 3 }, ctx).ok);
  assert.ok(!R.couponIsValid({ active: true, minOrder: 9000 }, ctx).ok);
  assert.ok(!R.couponIsValid({ active: true, eligibleUserIds: ['x'] }, ctx).ok);
});

test('cupom: sem combinar com promoção só vale para itens sem promoção', () => {
  const coupon = { code: 'X', type: 'percent', value: 10, active: true, stackWithPromo: false };
  const listings = { a: L({ promo: { type: 'percent', percent: 10 } }), b: L({}) };
  const q = R.computeQuote({ nowMs: NOW, marketId: 'm1', userId: 'u1', market: mkt, coupon, listings, items: [{ listingId: 'a', qty: 1 }, { listingId: 'b', qty: 1 }] });
  assert.equal(q.totals.couponDiscountMarket, 100);
});

test('pedido: transições válidas e inválidas', () => {
  assert.ok(R.canTransition('awaiting_payment', 'confirmed'));
  assert.ok(R.canTransition('confirmed', 'picking'));
  assert.ok(!R.canTransition('awaiting_payment', 'picking'));      // pagamento precede a fila
  assert.ok(!R.canTransition('confirmed', 'delivered'));
  assert.ok(!R.canTransition('out_for_delivery', 'cancelled'));    // sem cancelamento automático depois da saída
  assert.ok(!R.canTransition('delivered', 'picking'));
});

test('pedido: cliente cancela direto só antes da separação', () => {
  assert.ok(R.customerCanCancelDirectly('awaiting_payment'));
  assert.ok(R.customerCanCancelDirectly('confirmed'));
  assert.ok(!R.customerCanCancelDirectly('picking'));
  assert.ok(!R.customerCanCancelDirectly('out_for_delivery'));
});

test('reembolso de item faltante é proporcional ao valor pago', () => {
  const lines = R.allocatePaidPerLine([{ listingId: 'a', qty: 4, net: 4000 }, { listingId: 'b', qty: 1, net: 1000 }], 0, 500);
  const sum = lines.reduce((s, l) => s + l.paidTotal, 0);
  assert.equal(sum, 4500);
  const order = { items: lines };
  assert.equal(R.refundForLine(order, 'a', 1), Math.round(lines[0].paidTotal / 4));
  assert.equal(R.refundForLine(order, 'b', 5), lines[1].paidTotal); // limitado à quantidade comprada
});

test('código de entrega: formato e comparação', () => {
  assert.ok(R.isValidDeliveryCodeFormat('012345'));
  assert.ok(!R.isValidDeliveryCodeFormat('12345'));
  assert.ok(!R.isValidDeliveryCodeFormat('abcdef'));
  assert.ok(R.timingSafeEqualStr('123456', '123456'));
  assert.ok(!R.timingSafeEqualStr('123456', '123457'));
});

test('agendamento: respeita horário, feriados e antecedência', () => {
  const hours = { 1: [{ open: '08:00', close: '12:00' }], 2: [{ open: '08:00', close: '12:00' }], 3: [{ open: '08:00', close: '12:00' }], 4: [{ open: '08:00', close: '12:00' }], 5: [{ open: '08:00', close: '12:00' }] };
  const now = new Date('2026-10-28T07:00:00'); // quarta
  const slots = R.scheduleSlots({ hours, closedDates: ['2026-10-29'], now, businessDays: 3, slotMinutes: 60, leadMinutes: 60 });
  assert.ok(slots.length > 0);
  const days = new Set(slots.map(s => new Date(s.start).getDate()));
  assert.ok(!days.has(29), 'dia fechado não pode aparecer');
  assert.ok(new Date(slots[0].start).getTime() >= now.getTime() + 60 * 60000);
  const full = R.scheduleSlots({ hours, now, businessDays: 1, ordersInSlot: { [slots[0].start]: 10 }, maxPerSlot: 10 });
  assert.ok(!full.some(s => s.start === slots[0].start), 'janela lotada não aparece');
});

test('permissões: sanitização descarta permissões desconhecidas', () => {
  assert.deepEqual(R.sanitizePerms(['orders.read', 'root', 'orders.read'], R.MARKET_PERMS), ['orders.read']);
  assert.ok(!R.MARKET_ROLE_PRESETS.courier.includes('finance.read'));
  assert.ok(!R.MARKET_ROLE_PRESETS.picker.includes('finance.read'));
});

test('divisão de pagamento: soma fecha com o total', () => {
  const q = R.computeQuote({ nowMs: NOW, marketId: 'm1', userId: 'u1', market: mkt, items: [{ listingId: 'a', qty: 3 }], listings: { a: L({}) } });
  const s = R.paymentSplit(q);
  assert.equal(s.marketAmount + s.platformAmount, s.total);
});

test('área de entrega: CEP, bairro e raio; sem critério não atende', () => {
  const area = { ceps: ['01310'], districts: ['Jardim Paulista'], center: { lat: -23.56, lng: -46.65 }, radiusKm: 2 };
  assert.ok(R.coversAddress(area, { cep: '01310-100' }));
  assert.ok(R.coversAddress(area, { cep: '99999-000', district: 'jardim paulista' }));
  assert.ok(R.coversAddress(area, { cep: '99999-000', lat: -23.561, lng: -46.651 }));
  assert.ok(!R.coversAddress(area, { cep: '99999-000', lat: -22.9, lng: -43.2 }));
  assert.ok(!R.coversAddress({}, { cep: '01310-100' }));
  assert.ok(!R.coversAddress({ ceps: ['0'] }, { cep: '01310-100' }), 'prefixo curto demais não vale');
});
