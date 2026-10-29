'use strict';
/**
 * Meu Mercado — regras de negócio PURAS (sem I/O).
 * Usadas pelas Cloud Functions (autoridade) e cobertas por tests.js.
 * Todos os valores monetários são inteiros em CENTAVOS.
 */

const DEFAULTS = {
  reservationMinutes: 30,        // prazo de pagamento pendente / reserva de estoque
  scheduleBusinessDays: 3,       // janela de agendamento
  substitutionTimeoutMinutes: 20,
  deliveryCodeMaxAttempts: 5,
  deliveryCodeLockMinutes: 15,
  lowStockDefault: 5
};

/* ---------------- Estados do pedido ---------------- */
const ORDER_STATUS = {
  awaiting_payment: 'Aguardando pagamento',
  confirmed: 'Pedido confirmado',           // na fila de separação (entrada automática)
  picking: 'Em separação',
  picked: 'Pedido separado',
  ready_for_dispatch: 'Aguardando expedição',
  out_for_delivery: 'Saiu para entrega',
  delivered: 'Entrega confirmada',
  cancelled: 'Cancelado',
  refund_processing: 'Reembolso em processamento',
  refunded: 'Reembolsado'
};

const TRANSITIONS = {
  awaiting_payment: ['confirmed', 'cancelled'],
  confirmed: ['picking', 'cancelled', 'refund_processing'],
  picking: ['picked', 'refund_processing'],
  picked: ['ready_for_dispatch', 'refund_processing'],
  ready_for_dispatch: ['out_for_delivery', 'refund_processing'],
  out_for_delivery: ['delivered'],     // cancelamento depois da saída NÃO é automático (vai para suporte)
  delivered: ['refund_processing'],
  cancelled: [],
  refund_processing: ['refunded', 'cancelled'],
  refunded: []
};

function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

/** Cliente só cancela sozinho antes do início da separação. */
function customerCanCancelDirectly(status) {
  return status === 'awaiting_payment' || status === 'confirmed';
}

/* ---------------- Estoque alocado ---------------- */
function availableQty(l) {
  const a = Number(l.allocated) || 0, r = Number(l.reserved) || 0, c = Number(l.committed) || 0;
  return Math.max(0, a - r - c);
}
function stockStatus(l) {
  const av = availableQty(l);
  if (av <= 0) return 'out_of_stock';
  if (av <= (Number.isFinite(l.lowStockAt) ? l.lowStockAt : DEFAULTS.lowStockDefault)) return 'low';
  return 'ok';
}
/**
 * Menor alocação permitida: nunca abaixo do que já está reservado + comprometido.
 * Ex.: alocado 100, comprometido 60, reservado 0 → pode reduzir até 60 (as 40 restantes saem da venda).
 */
function minAllocation(l) {
  return (Number(l.reserved) || 0) + (Number(l.committed) || 0);
}

/* ---------------- Preço de linha e promoções ---------------- */
function inWindow(p, now) {
  if (!p) return false;
  const s = p.start ? new Date(p.start).getTime() : -Infinity;
  const e = p.end ? new Date(p.end).getTime() : Infinity;
  return now >= s && now <= e;
}

/**
 * listing.price: preço normal. listing.promo (opcional):
 *  { type:'price', price }                       preço promocional fixo
 *  { type:'percent', percent }                   desconto percentual
 *  { type:'buyxpayy', buy:5, pay:4 }             compre 5, pague 4
 *  { type:'tiers', tiers:[{minQty, percent}] }   desconto progressivo
 *  + start/end ISO opcionais
 * Retorna descontos de promoção (financiados pelo MERCADO).
 */
function priceLine(listing, qty, nowMs) {
  const unit = Math.round(listing.price);
  const gross = unit * qty;
  let discount = 0, label = null;
  const p = listing.promo;
  if (p && inWindow(p, nowMs)) {
    if (p.type === 'price' && Number.isFinite(p.price) && p.price < unit) {
      discount = (unit - Math.round(p.price)) * qty; label = 'Oferta';
    } else if (p.type === 'percent' && p.percent > 0 && p.percent < 100) {
      discount = Math.round(gross * p.percent / 100); label = `${p.percent}% off`;
    } else if (p.type === 'buyxpayy' && p.buy > p.pay && p.pay >= 0) {
      const groups = Math.floor(qty / p.buy);
      discount = groups * (p.buy - p.pay) * unit; label = `Leve ${p.buy}, pague ${p.pay}`;
    } else if (p.type === 'tiers' && Array.isArray(p.tiers)) {
      const t = p.tiers.filter(x => qty >= x.minQty).sort((a, b) => b.minQty - a.minQty)[0];
      if (t && t.percent > 0 && t.percent < 100) { discount = Math.round(gross * t.percent / 100); label = `${t.percent}% a partir de ${t.minQty}`; }
    }
  }
  discount = Math.min(discount, gross);
  return { unit, qty, gross, promoDiscount: discount, net: gross - discount, promoLabel: label };
}

/* ---------------- Cupons ---------------- */
function couponIsValid(c, ctx) {
  const now = ctx.nowMs;
  if (!c || c.active === false) return { ok: false, reason: 'Cupom inativo.' };
  if (c.validFrom && now < new Date(c.validFrom).getTime()) return { ok: false, reason: 'Cupom ainda não está válido.' };
  if (c.validTo && now > new Date(c.validTo).getTime()) return { ok: false, reason: 'Cupom expirado.' };
  if (c.marketId && c.marketId !== ctx.marketId) return { ok: false, reason: 'Cupom não vale para este mercado.' };
  if (Number.isFinite(c.maxUses) && (c.usedCount || 0) >= c.maxUses) return { ok: false, reason: 'Limite de usos do cupom atingido.' };
  if (Number.isFinite(c.maxUsesPerUser) && (ctx.userUses || 0) >= c.maxUsesPerUser) return { ok: false, reason: 'Você já usou este cupom o máximo de vezes.' };
  if (Array.isArray(c.eligibleUserIds) && c.eligibleUserIds.length && !c.eligibleUserIds.includes(ctx.userId)) return { ok: false, reason: 'Cupom não disponível para esta conta.' };
  if (Number.isFinite(c.minOrder) && ctx.subtotalNet < c.minOrder) return { ok: false, reason: 'Pedido abaixo do mínimo do cupom.' };
  return { ok: true };
}

/* ---------------- Cotação completa (autoridade do servidor) ---------------- */
/**
 * @param {Object} a
 *  items:[{listingId, qty}] ; listings:{[id]:listing} ; market:{commissionRate, delivery:{fee, freeAbove, ...}}
 *  coupon: doc de cupom ou null ; delivery:{mode:'delivery', fee?}
 * Retorna linhas, totais, divisão de descontos por origem, comissão e valor a repassar.
 */
function computeQuote(a) {
  const nowMs = a.nowMs || Date.now();
  const issues = [];
  const lines = [];
  for (const it of a.items) {
    const l = a.listings[it.listingId];
    const qty = Math.floor(Number(it.qty));
    if (!l) { issues.push({ listingId: it.listingId, code: 'NOT_FOUND', msg: 'Produto não encontrado neste mercado.' }); continue; }
    if (!(qty >= 1)) { issues.push({ listingId: it.listingId, code: 'BAD_QTY', msg: 'Quantidade inválida.' }); continue; }
    if (l.active === false) { issues.push({ listingId: it.listingId, code: 'INACTIVE', msg: `${l.name} está indisponível.` }); continue; }
    const av = availableQty(l);
    if (av <= 0) { issues.push({ listingId: it.listingId, code: 'OUT_OF_STOCK', msg: `${l.name} está esgotado.` }); continue; }
    if (qty > av) issues.push({ listingId: it.listingId, code: 'INSUFFICIENT', msg: `${l.name}: só há ${av} disponível(is).`, available: av });
    const pl = priceLine(l, qty, nowMs);
    lines.push({ listingId: it.listingId, name: l.name, brand: l.brand || null, unitLabel: l.unitLabel || null, ...pl, hasPromo: pl.promoDiscount > 0 });
    if (a.expectedPrices && a.expectedPrices[it.listingId] != null && a.expectedPrices[it.listingId] !== pl.net) {
      issues.push({ listingId: it.listingId, code: 'PRICE_CHANGED', msg: `${l.name}: o preço mudou.`, was: a.expectedPrices[it.listingId], now: pl.net });
    }
  }

  const subtotalList = lines.reduce((s, x) => s + x.gross, 0);
  const promoDiscount = lines.reduce((s, x) => s + x.promoDiscount, 0);
  const subtotalNet = subtotalList - promoDiscount;

  // Cupom
  let couponDiscountMarket = 0, couponDiscountPlatform = 0, couponFreeShipping = false, couponInfo = null;
  if (a.coupon) {
    const v = couponIsValid(a.coupon, { nowMs, marketId: a.marketId, userId: a.userId, userUses: a.userUses, subtotalNet });
    if (!v.ok) issues.push({ code: 'COUPON_INVALID', msg: v.reason });
    else {
      const c = a.coupon;
      const eligibleBase = c.stackWithPromo === false
        ? lines.filter(x => !x.hasPromo).reduce((s, x) => s + x.net, 0)
        : subtotalNet;
      let d = 0;
      if (c.type === 'percent') d = Math.round(eligibleBase * c.value / 100);
      else if (c.type === 'fixed') d = Math.min(Math.round(c.value), eligibleBase);
      else if (c.type === 'freeShipping') couponFreeShipping = true;
      if (Number.isFinite(c.maxDiscount)) d = Math.min(d, c.maxDiscount);
      d = Math.max(0, Math.min(d, eligibleBase));
      if (c.type !== 'freeShipping' && d === 0) issues.push({ code: 'COUPON_NO_EFFECT', msg: 'O cupom não se aplica aos itens do carrinho.' });
      const fund = c.fundedBy || 'market';
      if (fund === 'platform') couponDiscountPlatform = d;
      else if (fund === 'shared') { couponDiscountPlatform = Math.round(d * (c.sharePlatformPct ?? 50) / 100); couponDiscountMarket = d - couponDiscountPlatform; }
      else couponDiscountMarket = d;
      couponInfo = { code: c.code, type: c.type, fundedBy: fund, discountMarket: couponDiscountMarket, discountPlatform: couponDiscountPlatform, freeShipping: couponFreeShipping };
    }
  }

  // Entrega (taxa pertence ao mercado)
  const mk = a.market || {};
  const fee = Math.max(0, Math.round((a.delivery && a.delivery.fee != null ? a.delivery.fee : mk.deliveryFee) || 0));
  let deliveryDiscountMarket = 0, deliveryDiscountPlatform = 0;
  const itemsAfterMarket = subtotalNet - couponDiscountMarket;
  const freeAbove = mk.freeShippingAbove;
  if (Number.isFinite(freeAbove) && freeAbove > 0 && (itemsAfterMarket - couponDiscountPlatform) >= freeAbove) deliveryDiscountMarket = fee;
  else if (couponFreeShipping) {
    if ((a.coupon.fundedBy || 'market') === 'platform') deliveryDiscountPlatform = fee; else deliveryDiscountMarket = fee;
  }
  const deliveryPaid = fee - deliveryDiscountMarket - deliveryDiscountPlatform;

  const itemsAfterMarketDiscounts = itemsAfterMarket;                     // base do que o mercado "vendeu"
  const itemsPaid = itemsAfterMarketDiscounts - couponDiscountPlatform;   // o que o cliente paga pelos produtos
  const total = itemsPaid + deliveryPaid;

  const rate = Number.isFinite(mk.commissionRate) ? mk.commissionRate : 0; // ex.: 0.10 = 10%
  const commission = Math.round(itemsPaid * rate);                          // exclui taxa de entrega
  const platformSubsidy = couponDiscountPlatform + deliveryDiscountPlatform;
  const marketReceivable = itemsAfterMarketDiscounts - commission + (fee - deliveryDiscountMarket);
  const platformNet = commission - platformSubsidy;                          // antes das taxas do provedor

  return {
    lines, issues,
    totals: {
      subtotalList, promoDiscount, couponDiscountMarket, couponDiscountPlatform,
      deliveryFee: fee, deliveryDiscountMarket, deliveryDiscountPlatform, deliveryPaid,
      itemsPaid, total, commissionRate: rate, commission, platformSubsidy, marketReceivable, platformNet
    },
    coupon: couponInfo,
    blocking: issues.some(i => ['NOT_FOUND', 'BAD_QTY', 'INACTIVE', 'OUT_OF_STOCK', 'INSUFFICIENT', 'COUPON_INVALID'].includes(i.code)),
    priceChanged: issues.some(i => i.code === 'PRICE_CHANGED')
  };
}

/* ---------------- Reembolso proporcional (item faltante / cancelamento parcial) ---------------- */
function refundForLine(order, listingId, qty) {
  const line = order.items.find(i => i.listingId === listingId);
  if (!line) return 0;
  const q = Math.min(qty, line.qty);
  // valor efetivamente pago por unidade = (net da linha − parte do cupom rateada) / qty
  const paidLine = line.paidTotal != null ? line.paidTotal : line.net;
  return Math.round(paidLine * q / line.qty);
}

/** Rateia desconto de plataforma entre linhas para saber o valor realmente pago por linha. */
function allocatePaidPerLine(lines, couponDiscountMarket, couponDiscountPlatform) {
  const totalDisc = couponDiscountMarket + couponDiscountPlatform;
  const base = lines.reduce((s, l) => s + l.net, 0);
  let left = totalDisc;
  return lines.map((l, i) => {
    const share = i === lines.length - 1 ? left : Math.min(left, Math.round(totalDisc * l.net / (base || 1)));
    left -= share;
    return { ...l, paidTotal: l.net - share };
  });
}

/* ---------------- Código de entrega ---------------- */
function isValidDeliveryCodeFormat(code) { return typeof code === 'string' && /^\d{6}$/.test(code); }
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ---------------- Horário de funcionamento e agendamento ---------------- */
// hours: { '0'..'6': [{open:'08:00', close:'20:00'}] }  (0 = domingo) ; closedDates:['2026-12-25']
function isOpenAt(hours, closedDates, date) {
  const iso = ymd(date);
  if (Array.isArray(closedDates) && closedDates.includes(iso)) return false;
  const slots = (hours && hours[String(date.getDay())]) || [];
  const m = date.getHours() * 60 + date.getMinutes();
  return slots.some(s => toMin(s.open) <= m && m < toMin(s.close));
}
function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

/** Gera janelas de agendamento de até N dias úteis, respeitando horário, feriados e limites. */
function scheduleSlots(opts) {
  const { hours, closedDates = [], now, businessDays = DEFAULTS.scheduleBusinessDays, slotMinutes = 60, leadMinutes = 60, ordersInSlot = {}, maxPerSlot = Infinity } = opts;
  const out = [];
  let d = new Date(now); d.setHours(0, 0, 0, 0);
  let counted = 0, guard = 0;
  while (counted < businessDays + 1 && guard++ < 21) {
    const dow = d.getDay();
    const isBusiness = dow !== 0 && dow !== 6;
    const slots = (hours && hours[String(dow)]) || [];
    if (!closedDates.includes(ymd(d))) {
      for (const s of slots) {
        for (let t = toMin(s.open); t + slotMinutes <= toMin(s.close); t += slotMinutes) {
          const start = new Date(d); start.setHours(Math.floor(t / 60), t % 60, 0, 0);
          if (start.getTime() < now.getTime() + leadMinutes * 60000) continue;
          const key = start.toISOString();
          if ((ordersInSlot[key] || 0) >= maxPerSlot) continue;
          out.push({ start: key, end: new Date(start.getTime() + slotMinutes * 60000).toISOString() });
        }
      }
    }
    if (isBusiness) counted++;
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}


/* ---------------- Área de entrega ---------------- */
function haversineKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const normText = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
/**
 * area: { ceps:['01310','0131'] (prefixos), districts:['centro'], radiusKm, center:{lat,lng}, mode:'any' }
 * Um mercado atende se o endereço casar com QUALQUER critério configurado. Sem critério configurado => NÃO atende.
 */
function coversAddress(area, addr) {
  if (!area || !addr) return false;
  const cep = String(addr.cep || '').replace(/\D/g, '');
  if (Array.isArray(area.ceps) && cep && area.ceps.some(p => cep.startsWith(String(p).replace(/\D/g, '')) && String(p).replace(/\D/g, '').length >= 3)) return true;
  if (Array.isArray(area.districts) && addr.district && area.districts.map(normText).includes(normText(addr.district))) return true;
  if (area.center && Number.isFinite(area.radiusKm) && Number.isFinite(addr.lat) && Number.isFinite(addr.lng)) {
    return haversineKm(area.center, { lat: addr.lat, lng: addr.lng }) <= area.radiusKm;
  }
  return false;
}

/* ---------------- Permissões ---------------- */
const MARKET_PERMS = [
  'orders.read', 'orders.picking', 'orders.dispatch', 'orders.deliver', 'chat.use',
  'products.read', 'products.write', 'products.import', 'products.import.approve',
  'promotions.write', 'stock.write', 'settings.write', 'staff.manage', 'finance.read', 'reports.export'
];
const PLATFORM_PERMS = [
  'users.read', 'staff.read', 'staff.manage', 'markets.read', 'markets.write', 'markets.status', 'commission.write',
  'crm.read', 'crm.write', 'catalog.write', 'categories.write', 'cities.write', 'orders.read', 'finance.read',
  'finance.payouts', 'campaigns.read', 'campaigns.write', 'support.read', 'support.write', 'reviews.moderate',
  'audit.read', 'indicators.read', 'config.write'
];
const MARKET_ROLE_PRESETS = {
  manager: MARKET_PERMS,
  picker: ['orders.read', 'orders.picking', 'chat.use'],
  dispatcher: ['orders.read', 'orders.dispatch', 'chat.use'],
  courier: ['orders.read', 'orders.deliver'],                 // preparado: sem tela nesta versão
  finance: ['orders.read', 'finance.read', 'reports.export'],
  products: ['products.read', 'products.write', 'products.import', 'stock.write', 'promotions.write']
};

function sanitizePerms(requested, allowed) {
  return [...new Set((requested || []).filter(p => allowed.includes(p)))];
}

/* ---------------- Divisão do pagamento (para o provedor) ---------------- */
function paymentSplit(quote) {
  return {
    total: quote.totals.total,
    marketAmount: quote.totals.marketReceivable,              // inclui o subsídio coberto pela plataforma
    platformAmount: quote.totals.total - quote.totals.marketReceivable
  };
}

module.exports = {
  DEFAULTS, ORDER_STATUS, TRANSITIONS, canTransition, customerCanCancelDirectly,
  availableQty, stockStatus, minAllocation, priceLine, couponIsValid, computeQuote,
  refundForLine, allocatePaidPerLine, isValidDeliveryCodeFormat, timingSafeEqualStr,
  isOpenAt, scheduleSlots, ymd, haversineKm, coversAddress, normText, MARKET_PERMS, PLATFORM_PERMS, MARKET_ROLE_PRESETS, sanitizePerms, paymentSplit
};
