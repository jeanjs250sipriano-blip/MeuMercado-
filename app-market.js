
/* ───────────────────────── PAINEL DO MERCADO: base ───────────────────────── */
const MARKET_NAV = [['', 'Painel', 'home', null], ['pedidos', 'Pedidos', 'bag', 'orders.read'], ['produtos', 'Produtos', 'box', 'products.read'], ['estoque', 'Estoque alocado', 'tag', 'products.read'], ['importar', 'Importar', 'upload', 'products.import'], ['promocoes', 'Promoções', 'tag', 'promotions.write'], ['entrega', 'Entrega e horários', 'truck', 'settings.write'], ['equipe', 'Equipe', 'users', 'staff.manage'], ['financeiro', 'Financeiro', 'money', 'finance.read'], ['avaliacoes', 'Avaliações', 'star', 'chat.use'], ['config', 'Configurações', 'gear', 'settings.write']];
function sideNav(base, nav, active, user) {
  return h('nav', { class: 'side', 'aria-label': 'Menu' }, nav.filter(n => !n[3] || can(user, n[3])).map(([k, t, ic]) => h('a', { href: href(k ? `${base}/${k}` : base), class: k === active ? 'on' : '' }, icon(ic), t)));
}
function mpanel(active, ...content) { return h('div', { class: 'panel' }, sideNav('/painel', MARKET_NAV, active, SESSION.user), h('div', { class: 'stack', style: { minWidth: 0 } }, ...content)); }
const noPerm = () => empty('🔒', 'Sem permissão', 'Sua conta não tem permissão para esta função neste mercado.');
async function mctx() {
  await ensureBase(); const mid = SESSION.user.marketId; const [m, s] = await Promise.all([api.doc('markets/' + mid), api.doc(`markets/${mid}/public/settings`)]);
  return { mid, m: m || { id: mid, name: 'Mercado' }, s: s || {} };
}
const lowOf = (l, s) => l.lowStockAt ?? s.lowStockDefault ?? R.DEFAULTS.lowStockDefault;
const ACTIVE_ST = ['confirmed', 'picking', 'picked', 'ready_for_dispatch', 'out_for_delivery'];
const isLate = (o) => ACTIVE_ST.includes(o.status) && (o.delivery?.etaAt || Infinity) < Date.now();

/* ───────────────────────── Painel inicial ───────────────────────── */
routeA("market", /^\/painel$/, async () => {
  const { mid, m, s } = await mctx(); const root = h('div', { class: 'stack' }); let period = 7; let orders = [], listings = [];
  // Mercados criados pelo cadastro público: ativa na vitrine se ainda estiver "aguardando"
  if (m && m.status && m.status !== 'active' && can(SESSION.user, 'settings.write')) {
    try {
      await api.call('marketUpdateSettings', { marketId: mid, goLive: true, settings: { deliveryArea: { open: true } }, acceptingOrders: true });
      m.status = 'active'; m.acceptingOrders = true;
    } catch (e) { console.warn('goLive', e); }
  }
  const [ls, cp] = await Promise.all([api.col(`markets/${mid}/listings`, { limit: 1000 }).catch(() => []), Promise.resolve()]); listings = ls;
  const canOrders = can(SESSION.user, 'orders.read'), canFin = can(SESSION.user, 'finance.read');
  const draw = () => {
    const by = (st) => orders.filter(o => st.includes(o.status)).length; const late = orders.filter(isLate); const since = Date.now() - period * 86400000;
    const sold = orders.filter(o => !['awaiting_payment', 'cancelled'].includes(o.status) && o.createdAt >= since); const itemsPaid = sold.reduce((a, o) => a + (o.final || o.totals).itemsPaid, 0); const recv = sold.reduce((a, o) => a + (o.final || o.totals).marketReceivable, 0); const comm = sold.reduce((a, o) => a + (o.final || o.totals).commission, 0);
    const low = listings.filter(l => l.active && R.availableQty(l) > 0 && R.availableQty(l) <= lowOf(l, s)); const out = listings.filter(l => l.active && R.availableQty(l) <= 0); const promos = listings.filter(l => l.active && promoTag(l));
    const kpi = (v, l, tone, link) => h(link ? 'a' : 'div', { class: 'kpi', href: link ? href(link) : null, style: { textDecoration: 'none', color: 'inherit', borderColor: tone === 'bad' && v > 0 ? 'var(--red-600)' : '' } }, h('b', null, v), h('span', null, l));
    root.replaceChildren(
      m.status !== 'active' && h('div', { class: 'alert warn' }, h('div', null, h('b', null, 'Seu mercado ainda não está visível aos clientes. '), 'Faltam ajustes de configuração com a equipe da plataforma (status: ', STATUS_MARKET[m.status] || m.status, ').')),
      h('div', { class: 'row between' }, h('div', null, h('h1', { style: { margin: 0 } }, m.name), h('div', { class: 'muted tiny' }, 'Visão geral da operação')), h('div', { class: 'row' }, h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: m.acceptingOrders !== false, disabled: !can(SESSION.user, 'settings.write'), onchange: async (e) => { const on = e.target.checked; if (!on && !(await confirmDlg('Pausar novos pedidos', 'O mercado continuará visível, mas indicado como indisponível. Pedidos já aceitos continuam sendo atendidos.', 'Pausar'))) { e.target.checked = true; return; } try { await api.call('marketUpdateSettings', { marketId: mid, settings: {}, acceptingOrders: on }); m.acceptingOrders = on; toast(on ? 'Recebendo novos pedidos' : 'Novos pedidos pausados', 'ok'); } catch (x) { e.target.checked = !on; toast(errMsg(x), 'err'); } } }), ' Receber novos pedidos'))),
      late.length > 0 && h('div', { class: 'alert err' }, h('div', null, h('b', null, `${late.length} ${late.length === 1 ? 'pedido atrasado' : 'pedidos atrasados'}. `), h('a', { href: href('/painel/pedidos') }, 'Ver pedidos'))),
      out.length > 0 && h('div', { class: 'alert warn' }, h('div', null, h('b', null, `${out.length} ${out.length === 1 ? 'produto esgotado' : 'produtos esgotados'}. `), h('a', { href: href('/painel/estoque') }, 'Repor estoque'))),
      canOrders && h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' } }, kpi(by(['confirmed']), 'Recebidos (fila de separação)', '', '/painel/pedidos'), kpi(by(['picking']), 'Em separação', '', '/painel/pedidos'), kpi(by(['picked', 'ready_for_dispatch']), 'Aguardando expedição', '', '/painel/pedidos'), kpi(by(['out_for_delivery']), 'Entregas em andamento', '', '/painel/pedidos'), kpi(late.length, 'Pedidos atrasados', 'bad', '/painel/pedidos')),
      h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' } }, kpi(low.length, 'Estoque baixo', '', '/painel/estoque'), kpi(out.length, 'Esgotados', 'bad', '/painel/estoque'), kpi(promos.length, 'Promoções ativas', '', '/painel/promocoes')),
      canOrders && h('section', { class: 'card stack' }, h('div', { class: 'row between' }, h('h3', { style: { margin: 0 } }, 'Vendas do período'), sel([[1, 'Hoje'], [7, 'Últimos 7 dias'], [30, 'Últimos 30 dias']], period, { label: 'Período', onchange: (e) => { period = Number(e.target.value); draw(); } })), h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' } }, kpi(sold.length, 'Pedidos pagos'), kpi(brl(itemsPaid), 'Produtos vendidos (pago)'), canFin && kpi(brl(comm), 'Comissão da plataforma'), canFin && kpi(brl(recv), 'Líquido a receber'))),
      !canOrders && h('div', { class: 'alert' }, 'Sua função não inclui pedidos. Use o menu para acessar suas tarefas.'), h('p', { class: 'tiny muted' }, 'Os pedidos entram automaticamente na fila de separação assim que o pagamento é confirmado — não há aceite manual.'));
  };
  draw();
  if (canOrders) S.cleanups.push(api.watchCol('orders', { where: [['marketId', '==', mid]], orderBy: [['createdAt', 'desc']], limit: 300 }, (rows) => { orders = rows; draw(); }, (e) => root.prepend(errorBox(e))));
  return mpanel('', root);
});
const STATUS_MARKET = { awaiting_setup: 'aguardando configuração', suspended: 'suspenso', active: 'ativo' };

/* ───────────────────────── Pedidos (fila e expedição) ───────────────────────── */
const BOARD = [['confirmed', 'Na fila de separação', ['confirmed']], ['picking', 'Em separação', ['picking']], ['ready_for_dispatch', 'Aguardando expedição', ['picked', 'ready_for_dispatch']], ['out_for_delivery', 'Em entrega', ['out_for_delivery']], ['delivered', 'Entregues', ['delivered']], ['other', 'Cancelados / reembolsos', ['cancelled', 'refund_processing', 'refunded']]];
routeA("market", /^\/painel\/pedidos$/, async (ctx) => {
  const u = SESSION.user; if (!can(u, 'orders.read')) return mpanel('pedidos', noPerm()); const { mid } = await mctx(); const board = h('div', { class: 'board' }); let orders = [];
  const draw = () => board.replaceChildren(...BOARD.map(([k, t, sts]) => { const rows = orders.filter(o => sts.includes(o.status)).slice(0, k === 'delivered' || k === 'other' ? 15 : 100); return h('div', { class: 'col' }, h('h4', null, t, h('span', { class: 'badge' }, rows.length)), ...rows.map(o => h('div', { class: 'ocard' + (isLate(o) ? ' late' : ''), tabindex: 0, role: 'button', onclick: () => openMarketOrder(o.id, mid), onkeydown: (e) => { if (e.key === 'Enter') openMarketOrder(o.id, mid); } }, h('div', { class: 'row between' }, h('b', null, '#' + o.id.slice(0, 6).toUpperCase()), isLate(o) ? h('span', { class: 'badge r' }, 'Atrasado') : o.delivery?.mode === 'scheduled' ? h('span', { class: 'badge b' }, 'Agendado') : null), h('div', { class: 'tiny' }, `${o.items.reduce((s, i) => s + i.qty, 0)} itens · ${brl((o.final || o.totals).itemsPaid)}`), h('div', { class: 'tiny muted' }, o.delivery?.mode === 'scheduled' ? `Entrega ${dt(o.delivery.scheduledStart)}` : `Previsão ${dt(o.delivery?.etaAt)}`), o.demo && h('span', { class: 'badge g' }, 'DEMO'))), rows.length === 0 && h('div', { class: 'tiny muted center', style: { padding: '14px 0' } }, 'Vazio')); }));
  S.cleanups.push(api.watchCol('orders', { where: [['marketId', '==', mid]], orderBy: [['createdAt', 'desc']], limit: 300 }, (rows) => { orders = rows.filter(o => o.status !== 'awaiting_payment'); draw(); if (ctx.q.o && !ctx._opened) { ctx._opened = true; openMarketOrder(ctx.q.o, mid); } }, (e) => board.replaceChildren(errorBox(e))));
  return mpanel('pedidos', h('h1', null, 'Pedidos'), h('p', { class: 'muted tiny' }, 'Pedidos pagos entram automaticamente na fila. Toque em um cartão para operar. As telas dedicadas de separador e entregador virão em uma etapa posterior; por ora o painel controla todos os estados.'), board);
});
function openMarketOrder(id, mid) {
  const u = SESSION.user; const m = openModal((mm) => {
    const root = h('div', { class: 'stack' }); const subs = h('div', { class: 'stack' }), evs = h('div', { class: 'stack' }); const chatBox = h('div'); let chatMade = false;
    const unS = api.watchCol(`orders/${id}/substitutions`, {}, (rows) => subs.replaceChildren(...rows.map(s => h('div', { class: 'alert' + (s.status === 'pending' ? ' warn' : '') }, h('div', null, h('b', null, `Falta: ${s.itemName} (${s.qty})`), ` — ${s.status === 'pending' ? 'aguardando o cliente' : s.status === 'accepted' ? 'troca autorizada' : s.status === 'declined' ? 'recusada/reembolsada' : s.status}`, s.substitute && ` · sugestão: ${s.substitute.name}`)))), () => {});
    const unE = api.watchCol(`orders/${id}/events`, { orderBy: [['at', 'asc']] }, (rows) => evs.replaceChildren(h('h4', null, 'Histórico'), ...rows.map(e => h('div', { class: 'row tiny' }, h('span', { class: 'muted', style: { minWidth: '92px' } }, dt(e.at)), h('span', null, (EV_LABEL[e.type] || e.type) + (e.to && STATUS[e.to] ? ': ' + STATUS[e.to] : ''))))), () => {});
    const un = api.watchDoc('orders/' + id, (o) => {
      if (!o || o.marketId !== mid) { root.replaceChildren(h('p', null, 'Pedido não encontrado.')); return; }
      const t = o.final || o.totals; const adv = (to, extra = {}) => (btn) => busy(btn, async () => { await api.call('marketAdvanceOrder', { orderId: id, to, ...extra }); toast('Estado atualizado', 'ok'); });
      const acts = []; const P = (p) => can(u, p);
      if (o.status === 'confirmed' && P('orders.picking')) acts.push(h('button', { class: 'btn', onclick: (e) => adv('picking')(e.currentTarget) }, 'Iniciar separação'));
      if (o.status === 'picking' && P('orders.picking')) { acts.push(h('button', { class: 'btn', onclick: (e) => adv('picked')(e.currentTarget) }, 'Concluir separação'), h('button', { class: 'btn ghost', onclick: () => openMissing(o, mid) }, 'Reportar item em falta')); }
      if (['picked', 'ready_for_dispatch'].includes(o.status) && P('orders.dispatch')) { const cn = inp({ ph: 'Nome do entregador', value: u.name, label: 'Entregador' }); acts.push(h('div', { class: 'row' }, h('div', { class: 'grow' }, cn), h('button', { class: 'btn', onclick: (e) => adv('out_for_delivery', { courierName: cn.value.trim() })(e.currentTarget) }, 'Saiu para entrega'))); }
      if (o.status === 'out_for_delivery' && P('orders.deliver')) { const code = inp({ ph: 'Código de 6 dígitos do cliente', mode: 'numeric', max_len: 6, label: 'Código de entrega' }); acts.push(h('div', { class: 'card flat stack' }, h('b', null, 'Confirmar entrega'), h('div', { class: 'tiny muted' }, 'Peça ao cliente o código de 6 dígitos mostrado no app dele. Ele não aparece aqui.'), h('div', { class: 'row' }, h('div', { class: 'grow' }, code), h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { const r = await api.call('confirmDelivery', { orderId: id, code: code.value.trim() }); if (r.ok) toast('Entrega confirmada', 'ok'); else if (r.locked) toast(`Muitas tentativas. Tente de novo em ${Math.ceil((r.retryAfterSec || 900) / 60)} min.`, 'err'); else toast(`Código incorreto. Restam ${r.attemptsLeft} tentativas.`, 'err'); }) }, 'Validar código')), h('button', { class: 'btn sm ghost', onclick: () => { const r = inp({ ph: 'Ex.: cliente não atendeu' }); openModal((m2) => h('div', { class: 'stack' }, r, h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { if (!r.value.trim()) throw new Error('Informe o motivo.'); await api.call('reportDeliveryIssue', { orderId: id, reason: r.value.trim() }); toast('Ocorrência registrada e enviada ao suporte', 'ok'); m2.close(); }) }, 'Registrar ocorrência')), { title: 'Ocorrência de entrega' }); } }, 'Cliente sem código? Registrar ocorrência'))); }
      root.replaceChildren(h('div', { class: 'row between' }, h('h3', { style: { margin: 0 } }, `Pedido #${id.slice(0, 6).toUpperCase()}`), statusBadge(o.status)), isLate(o) && h('div', { class: 'alert err' }, 'Passou da previsão confirmada.'), o.demo && h('span', { class: 'badge g' }, 'DEMO'), tracker(o.status),
        h('div', { class: 'card flat' }, h('b', null, o.address.recipient || 'Cliente'), h('div', null, `${o.address.street}, ${o.address.number}${o.address.complement ? ' — ' + o.address.complement : ''}`), h('div', { class: 'muted tiny' }, `${o.address.district || ''} ${o.address.city}/${o.address.uf || ''} · CEP ${o.address.cep}`), h('div', { class: 'tiny' }, o.delivery.mode === 'scheduled' ? `Agendada: ${dt(o.delivery.scheduledStart)}` : `Previsão: ${dt(o.delivery.etaAt)}`)),
        h('div', { class: 'card flat stack' }, h('b', null, 'Itens'), o.items.map(i => h('div', { class: 'row between' }, h('span', null, `${i.qty}× ${i.name}`, i.unitLabel && h('span', { class: 'muted tiny' }, ' ' + i.unitLabel)), h('span', null, brl(i.paidTotal ?? i.net)))), h('div', { class: 'sep' }), h('div', { class: 'row between' }, h('span', null, 'Produtos pagos'), h('b', null, brl(t.itemsPaid))), h('div', { class: 'row between' }, h('span', null, 'Entrega'), h('b', null, brl(t.deliveryPaid))), can(u, 'finance.read') && [h('div', { class: 'row between' }, h('span', null, `Comissão (${(o.commissionRate * 100).toFixed(1).replace('.', ',')}%, sem a entrega)`), h('b', null, '− ' + brl(t.commission))), h('div', { class: 'row between' }, h('span', null, 'Líquido a receber'), h('b', null, brl(t.marketReceivable)))]),
        subs, h('div', { class: 'stack' }, acts), can(u, 'chat.use') && h('div', { class: 'card flat stack' }, h('b', null, '💬 Chat com o cliente'), chatBox), evs);
      if (can(u, 'chat.use') && !chatBox.firstChild && !chatMade) { chatBox.append(orderChat(id, 'market')); chatMade = true; }
    }, (e) => root.replaceChildren(errorBox(e)));
    const old = mm.close; mm.close = () => { un(); unS(); unE(); old(); }; return root;
  }, { title: 'Pedido', wide: true });
}
async function openMissing(o, mid) {
  const ls = (await api.col(`markets/${mid}/listings`, { where: [['active', '==', true]], limit: 600 })).filter(l => R.availableQty(l) > 0);
  openModal((m) => { const it = sel(o.items.map(i => [i.listingId, `${i.qty}× ${i.name}`]), o.items[0].listingId, { label: 'Item em falta' }); const qty = inp({ type: 'number', value: 1, min: 1 }); const sub = sel([['', 'Sem substituto (reembolsar o item)'], ...ls.map(l => [l.id, `${l.name} ${l.unitLabel || ''} — ${brl(l.price)}`])], '', { label: 'Substituto' });
    return h('div', { class: 'stack' }, h('div', { class: 'alert' }, 'Nenhuma substituição acontece sem a autorização expressa do cliente. Se for mais caro, ele precisa aprovar o novo valor; sem resposta, o item é retirado e reembolsado.'), field('Item em falta', it), field('Quantidade faltante', qty), field('Sugerir substituto (opcional)', sub), h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { await api.call('marketReportMissingItem', { orderId: o.id, listingId: it.value, qty: parseInt(qty.value) || 1, substituteListingId: sub.value || undefined }); toast('Cliente avisado. Aguarde a decisão.', 'ok'); m.close(); }) }, 'Enviar ao cliente')); }, { title: 'Reportar item em falta' });
}

/* ───────────────────────── Produtos ───────────────────────── */
function promoEditor(promo, price) {
  const p = promo || {}; const type = sel([['', 'Sem promoção'], ['price', 'Preço promocional'], ['percent', 'Desconto percentual'], ['buyxpayy', 'Leve X, pague Y'], ['tiers', 'Desconto progressivo']], p.type || '', { label: 'Tipo de promoção' });
  const f = { price: inp({ value: p.price ? moneyIn(p.price) : '', mode: 'decimal', ph: 'R$' }), percent: inp({ type: 'number', value: p.percent || '', min: 1, max: 99 }), buy: inp({ type: 'number', value: p.buy || 5, min: 2 }), pay: inp({ type: 'number', value: p.pay || 4, min: 0 }), t1q: inp({ type: 'number', value: p.tiers?.[0]?.minQty || 3 }), t1p: inp({ type: 'number', value: p.tiers?.[0]?.percent || 5 }), t2q: inp({ type: 'number', value: p.tiers?.[1]?.minQty || 6 }), t2p: inp({ type: 'number', value: p.tiers?.[1]?.percent || 10 }), start: inp({ type: 'date', value: (p.start || '').slice(0, 10) }), end: inp({ type: 'date', value: (p.end || '').slice(0, 10) }) };
  const body = h('div', { class: 'stack' }); const draw = () => { const t = type.value; body.replaceChildren(...(t === 'price' ? [field('Preço promocional (R$)', f.price)] : t === 'percent' ? [field('Desconto (%)', f.percent)] : t === 'buyxpayy' ? [h('div', { class: 'grid g2' }, field('Leve', f.buy), field('Pague', f.pay))] : t === 'tiers' ? [h('div', { class: 'grid g2' }, field('A partir de (un.)', f.t1q), field('% de desconto', f.t1p)), h('div', { class: 'grid g2' }, field('A partir de (un.)', f.t2q), field('% de desconto', f.t2p))] : []), ...(t ? [h('div', { class: 'grid g2' }, field('Início (opcional)', f.start), field('Fim (opcional)', f.end))] : [])); };
  type.addEventListener('change', draw); draw();
  return { el: h('div', { class: 'stack' }, field('Promoção', type), body), get() { const t = type.value; if (!t) return null; const base = { type: t, start: f.start.value || null, end: f.end.value || null }; if (t === 'price') { const v = parseMoney(f.price.value); if (!(v > 0)) throw new Error('Informe o preço promocional.'); return { ...base, price: v }; } if (t === 'percent') return { ...base, percent: Number(f.percent.value) }; if (t === 'buyxpayy') return { ...base, buy: parseInt(f.buy.value), pay: parseInt(f.pay.value) }; return { ...base, tiers: [{ minQty: parseInt(f.t1q.value), percent: Number(f.t1p.value) }, { minQty: parseInt(f.t2q.value), percent: Number(f.t2p.value) }] }; } };
}
function openListingEditor(l, mid, s, done) {
  const u = SESSION.user; const P = (p) => can(u, p);
  openModal((m) => { const price = inp({ value: moneyIn(l.price), mode: 'decimal', label: 'Preço', ph: 'R$' }); price.disabled = !P('products.write'); const alloc = inp({ type: 'number', value: l.allocated, min: R.minAllocation(l), label: 'Quantidade alocada' }); alloc.disabled = !P('stock.write'); const low = inp({ type: 'number', value: l.lowStockAt ?? s.lowStockDefault ?? 5, min: 0 }); low.disabled = !P('stock.write');
    const pe = promoEditor(l.promo, l.price); const act = h('input', { type: 'checkbox', checked: l.active, disabled: !P('products.write') }); const feat = h('input', { type: 'checkbox', checked: !!l.featured, disabled: !P('products.write') }); const desc = h('textarea', { class: 'in', maxlength: 800, value: l.description || '' }); desc.value = l.description || ''; const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
    const hist = h('div', { class: 'stack tiny' }); api.col(`markets/${mid}/listingHistory`, { orderBy: [['at', 'desc']], limit: 80 }).then(rows => { const mine = rows.filter(r => r.listingId === l.id).slice(0, 8); hist.replaceChildren(...(mine.length ? mine.map(r => h('div', null, `${dt(r.at)} — ${Object.keys(r.after || {}).map(k => `${HK[k] || k}: ${fmtH(k, r.before?.[k])} → ${fmtH(k, r.after?.[k])}`).join('; ') || 'criado'}`)) : [h('span', { class: 'muted' }, 'Sem alterações registradas.')])); }).catch(() => hist.replaceChildren(h('span', { class: 'muted' }, 'Histórico indisponível.')));
    return h('div', { class: 'stack' }, h('div', { class: 'muted' }, [l.brand, l.unitLabel].filter(Boolean).join(' · '), l.local && h('span', { class: 'badge o', style: { marginLeft: '6px' } }, 'produto local')), h('div', { class: 'grid g2' }, field('Preço (R$)', price), field('Quantidade alocada à plataforma', alloc, `Mínimo ${R.minAllocation(l)} (reservado + comprometido em pedidos)`)), h('div', { class: 'tiny muted' }, `Reservado: ${l.reserved || 0} · Comprometido (vendido): ${l.committed || 0} · Disponível: ${R.availableQty(l)}`), field('Alerta de estoque baixo (unidades)', low), pe.el,
      l.local && field('Descrição / itens do combo', desc), field('Foto própria (opcional)', file), h('label', { class: 'row' }, act, ' Ativo na loja'), h('label', { class: 'row' }, feat, ' Produto em destaque'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { const d = { marketId: mid, id: l.id }; const np = parseMoney(price.value); if (!(np > 0)) throw new Error('Preço inválido.'); if (np !== l.price) d.price = np; const na = parseInt(alloc.value); if (na !== l.allocated) d.allocated = na; const nl = parseInt(low.value); if (nl !== (l.lowStockAt ?? s.lowStockDefault ?? 5)) d.lowStockAt = nl; const pr = pe.get(); if (JSON.stringify(pr) !== JSON.stringify(l.promo || null)) d.promo = pr; if (act.checked !== l.active) d.active = act.checked; if (feat.checked !== !!l.featured) d.featured = feat.checked; if (l.local && desc.value !== (l.description || '')) d.description = desc.value; if (file.files[0]) { if (file.files[0].size > 3 * 1024 * 1024) throw new Error('A foto deve ter até 3 MB.'); d.imageUrl = await api.upload(`markets/${mid}/products/${l.id}-${Date.now()}`, file.files[0]); } if (Object.keys(d).length <= 2) { m.close(); return; } await api.call('marketUpsertListing', d); toast('Produto atualizado', 'ok'); m.close(); done && done(); }) }, 'Salvar'),
        P('products.write') && h('button', { class: 'btn danger', onclick: async () => { if (!(await confirmDlg('Remover do mercado', `Remover “${l.name}” do seu catálogo? Pedidos em andamento continuam sendo atendidos. O catálogo global não é alterado.`, 'Remover', true))) return; try { await api.call('marketRemoveListing', { marketId: mid, id: l.id }); toast('Produto removido', 'ok'); m.close(); done && done(); } catch (e) { toast(errMsg(e), 'err'); } } }, icon('trash'), 'Remover')), h('h4', null, 'Histórico de alterações'), hist); }, { title: l.name, wide: true });
}
const HK = { price: 'preço', allocated: 'alocado', active: 'ativo', promo: 'promoção', lowStockAt: 'alerta' };
const fmtH = (k, v) => v == null ? '—' : k === 'price' ? brl(v) : k === 'promo' ? (v ? promoTag({ promo: v }) || 'promo' : '—') : k === 'active' ? (v ? 'sim' : 'não') : String(v);

/** Lê código de barras pela câmera e devolve o GTIN/EAN (só dígitos). */
function openBarcodeScanner({ onCode, title }) {
  const video = h('video', { playsinline: 'true', muted: true, autoplay: true, style: { width: '100%', maxHeight: '55vh', background: '#000', borderRadius: '12px', objectFit: 'cover' } });
  const status = h('p', { class: 'tiny muted center' }, 'Aponte a câmera para o código de barras…');
  const hint = h('p', { class: 'tiny muted' }, 'Boa iluminação ajuda. Aceita EAN-13, EAN-8 e UPC.');
  let stream = null, raf = 0, closed = false, html5 = null;

  const stop = () => {
    closed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (html5) { try { html5.stop().catch(() => {}); } catch (_) {} html5 = null; }
    if (stream) { stream.getTracks().forEach(tr => tr.stop()); stream = null; }
    try { video.srcObject = null; } catch (_) {}
  };

  const finish = (code) => {
    if (closed) return;
    const digits = String(code || '').replace(/\D/g, '');
    if (digits.length < 8) return;
    stop();
    try { md.close(); } catch (_) {}
    onCode && onCode(digits);
  };

  const md = openModal(() => h('div', { class: 'stack' },
    video,
    status,
    hint,
    h('button', { class: 'btn ghost block', type: 'button', onclick: () => { stop(); md.close(); } }, 'Cancelar')
  ), { title: title || 'Ler código de barras', wide: true, onClose: stop });

  (async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status.textContent = 'Este navegador não permite câmera. Digite o código manualmente.';
      status.className = 'alert err';
      return;
    }
    // 1) API nativa BarcodeDetector (Chrome Android etc.)
    if (typeof BarcodeDetector !== 'undefined') {
      try {
        const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'] });
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        video.srcObject = stream;
        await video.play();
        status.textContent = 'Câmera ativa — enquadre o código…';
        const tick = async () => {
          if (closed) return;
          try {
            if (video.readyState >= 2) {
              const codes = await detector.detect(video);
              if (codes && codes.length && codes[0].rawValue) {
                finish(codes[0].rawValue);
                return;
              }
            }
          } catch (_) {}
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return;
      } catch (e) {
        console.warn('BarcodeDetector', e);
        if (stream) { stream.getTracks().forEach(tr => tr.stop()); stream = null; }
      }
    }

    // 2) Fallback Html5Qrcode (CDN)
    try {
      if (!window.Html5Qrcode) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
          s.onload = resolve;
          s.onerror = () => reject(new Error('Falha ao carregar leitor.'));
          document.head.appendChild(s);
        });
      }
      const boxId = 'mm-qr-' + Date.now();
      const box = h('div', { id: boxId, style: { width: '100%' } });
      video.replaceWith(box);
      status.textContent = 'Iniciando câmera…';
      html5 = new Html5Qrcode(boxId);
      await html5.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 280, height: 160 }, aspectRatio: 1.777 },
        (decoded) => finish(decoded),
        () => {}
      );
      status.textContent = 'Câmera ativa — enquadre o código…';
    } catch (e) {
      status.textContent = (e && e.message) || 'Não foi possível abrir a câmera. Permita o acesso nas configurações do navegador.';
      status.className = 'alert err';
    }
  })();
}

function openNewListing(mid, s, done) {
  openModal((m) => { const tabs = h('div', { class: 'tabs' }); const body = h('div', { class: 'stack', style: { marginTop: '12px' } }); let tab = 'off';
    const draw = () => { tabs.replaceChildren(...[['off', 'Open Food Facts'], ['global', 'Do catálogo global'], ['local', 'Produto local / combo']].map(([k, t]) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; draw(); } }, t))); body.replaceChildren(tab === 'off' ? offTab() : tab === 'global' ? globalTab() : localTab()); };

    /* ── helpers OFF ── */
    const parseQty = (q) => {
      if (!q) return { size: null, unit: '' };
      const s = String(q).trim().toLowerCase().replace(',', '.').replace(/\s+/g, '');
      const m = s.match(/^([\d.]+)\s*(kg|g|ml|l|un|unidade|unidades|litros?|gramas?)?/);
      if (!m) return { size: null, unit: '' };
      let unit = (m[2] || '');
      if (/^unidades?$/.test(unit)) unit = 'un';
      if (/^litros?$/.test(unit)) unit = 'l';
      if (/^gramas?$/.test(unit)) unit = 'g';
      return { size: parseFloat(m[1]) || null, unit: unit || '' };
    };
    const offImg = (p) => p.image_front_url || p.image_url || p.image_front_small_url || p.image_front_thumb_url || null;
    const offThumb = (p) => p.image_front_thumb_url || p.image_front_small_url || p.image_front_url || p.image_url || null;
    const offName = (p) => (p.product_name_pt || p.product_name || p.generic_name_pt || p.generic_name || '').trim() || 'Sem nome';
    const offBrand = (p) => ((p.brands || '').split(',')[0] || '').trim();

    // Mapeia tags/nome da Open Food Facts → id de categoria local (ids estáveis do seed)
    const OFF_CAT_RULES = [
      { id: 'acougue', keys: ['meat', 'beef', 'pork', 'chicken', 'carne', 'bovina', 'suina', 'suína', 'frango', 'aves', 'linguica', 'linguiça', 'bacon', 'hamburguer', 'hambúrguer'] },
      { id: 'padaria', keys: ['bread', 'bakery', 'pao', 'pão', 'padaria', 'bolo', 'torrada', 'croissant'] },
      { id: 'hortifruti', keys: ['fruit', 'vegetable', 'fruta', 'verdura', 'legume', 'hortifruti', 'banana', 'maca', 'maçã', 'alface', 'tomate', 'cebola', 'batata'] },
      { id: 'frios-laticinios', keys: ['dairy', 'cheese', 'milk', 'yogurt', 'leite', 'queijo', 'iogurte', 'manteiga', 'requeijao', 'requeijão', 'presunto', 'mortadela', 'frios', 'laticinio', 'laticínio'] },
      { id: 'bebidas', keys: ['beverage', 'drink', 'soda', 'water', 'juice', 'bebida', 'refrigerante', 'suco', 'agua', 'água', 'cerveja', 'vinho', 'cafe', 'café', 'cha', 'chá', 'coca', 'guarana', 'guaraná'] },
      { id: 'congelados', keys: ['frozen', 'congelado', 'sorvete', 'ice cream', 'pizza congelada'] },
      { id: 'higiene', keys: ['hygiene', 'higiene', 'shampoo', 'sabonete', 'toothpaste', 'creme dental', 'desodorante', 'papel higienico', 'papel higiênico', 'absorvente'] },
      { id: 'limpeza', keys: ['cleaning', 'limpeza', 'detergente', 'desinfetante', 'sabao', 'sabão', 'amaciante', 'multiuso', 'agua sanitaria', 'água sanitária'] },
      { id: 'utilidades', keys: ['disposable', 'descartavel', 'descartável', 'papel toalha', 'filme pvc', 'alumínio', 'aluminio', 'copo plastico', 'utilidade'] },
      { id: 'pet', keys: ['pet', 'dog', 'cat', 'cao', 'cão', 'gato', 'racao', 'ração', 'pet-food'] },
      { id: 'saudaveis', keys: ['organic', 'organico', 'orgânico', 'integral', 'sem gluten', 'sem glúten', 'diet', 'light', 'vegano', 'vegetariano', 'fitness'] },
      { id: 'mercearia', keys: ['arroz', 'feijao', 'feijão', 'acucar', 'açúcar', 'farinha', 'macarrao', 'macarrão', 'pasta', 'oil', 'oleo', 'óleo', 'molho', 'enlatado', 'biscoito', 'bolacha', 'cereal', 'grocery', 'food', 'alimento', 'snack', 'doce'] },
    ];
    const guessCategory = (p) => {
      const bag = [
        ...(p.categories_tags || []),
        p.categories || '',
        p.product_name || '',
        p.product_name_pt || '',
        p.generic_name || '',
        p.brands || '',
      ].join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      for (const rule of OFF_CAT_RULES) {
        if (rule.keys.some(k => bag.includes(k.normalize('NFD').replace(/[\u0300-\u036f]/g, '')))) {
          // só retorna se a categoria existir localmente
          if (S.cats.some(c => c.id === rule.id)) return rule.id;
        }
      }
      // fallback: mercearia se existir
      if (S.cats.some(c => c.id === 'mercearia')) return 'mercearia';
      if (S.cats.some(c => c.id === 'mercearia')) return 'mercearia';
      return S.cats[0]?.id || '';
    };

    const normalizeSearchTerm = (raw) => {
      let t = String(raw || '').trim().replace(/\s+/g, ' ');
      // "5 kg" / "5kg" / "5  kg" → mantém legível para a API
      t = t.replace(/(\d)\s*(kg|g|ml|l)\b/gi, '$1$2');
      return t;
    };

    const offTab = () => {
      const q = inp({ ph: 'Ex: Arroz 5kg, Café 3 Corações ou código de barras' });
      const res = h('div', { class: 'stack' });
      const price = inp({ ph: 'Preço R$', mode: 'decimal' });
      const qty = inp({ type: 'number', ph: 'Qtd. alocada', min: 0 });
      const cat = sel([['', 'Categoria…'], ...S.cats.map(c => [c.id, (c.parentId ? '— ' : '') + (c.emoji || c.icon || '') + ' ' + c.name])], '');
      const formBox = h('div', { class: 'stack' });
      let selected = null;

      const showForm = (p) => {
        selected = p;
        const pq = parseQty(p.quantity);
        const name = offName(p);
        const brand = offBrand(p);
        const img = offImg(p);
        const thumb = offThumb(p);
        const guessed = guessCategory(p);
        if (guessed) cat.value = guessed;
        formBox.replaceChildren(
          h('div', { class: 'card flat row', style: { gap: '12px', alignItems: 'center' } },
            thumb ? h('img', { src: thumb, alt: '', style: { width: '64px', height: '64px', objectFit: 'contain', borderRadius: '8px', background: '#f5f5f5' }, loading: 'lazy' })
              : h('div', { style: { width: '64px', height: '64px', background: '#eee', borderRadius: '8px' } }),
            h('div', { class: 'grow' },
              h('b', null, name),
              h('div', { class: 'tiny muted' }, [brand, p.quantity, p.code].filter(Boolean).join(' · ')),
              (p.categories || '').split(',').slice(0, 2).join(', ') && h('div', { class: 'tiny muted' }, String(p.categories || '').split(',').slice(0, 2).join(', ').trim())
            )
          ),
          h('div', { class: 'alert ok' }, 'Nome, marca, código, peso e imagem preenchidos. Ajuste a categoria se precisar e informe preço e estoque.'),
          h('div', { class: 'grid g2' }, field('Seu preço (R$)', price), field('Quantidade para vender', qty)),
          field('Categoria', cat),
          h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => {
            const pr = parseMoney(price.value);
            if (!(pr > 0)) throw new Error('Informe o preço.');
            if (!cat.value) throw new Error('Selecione a categoria.');
            const unit = pq.unit || 'un';
            const barcode = p.code ? String(p.code).replace(/\D/g, '') || null : null;
            // Alimenta o Catálogo Global (sem preço/estoque) e vincula a oferta do mercado
            let gpId = null;
            try {
              const g = await api.call('marketEnsureGlobalProduct', {
                marketId: mid,
                name: name.slice(0, 160),
                brand: brand.slice(0, 80) || null,
                barcode,
                categoryId: cat.value,
                size: pq.size,
                unit,
                imageUrl: img,
                description: null,
                source: p._source || 'openfoodfacts',
                externalId: barcode || null
              });
              gpId = g && g.id;
            } catch (ge) { console.warn('global ensure', ge); }
            if (gpId) {
              await api.call('marketUpsertListing', {
                marketId: mid,
                globalProductId: gpId,
                price: pr,
                allocated: parseInt(qty.value) || 0,
                active: (parseInt(qty.value) || 0) > 0
              });
            } else {
              await api.call('marketUpsertListing', {
                marketId: mid,
                name: name.slice(0, 160),
                brand: brand.slice(0, 80) || null,
                barcode,
                size: pq.size,
                unit,
                categoryId: cat.value,
                price: pr,
                allocated: parseInt(qty.value) || 0,
                active: (parseInt(qty.value) || 0) > 0,
                imageUrl: img,
                description: null,
                kind: 'product'
              });
            }
            toast('Produto no catálogo global + oferta do mercado', 'ok');
            m.close(); done && done();
          }) }, 'Cadastrar no meu mercado')
        );
        // rola o formulário para a vista
        setTimeout(() => formBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
      };

      const OFF_FIELDS = 'code,product_name,product_name_pt,generic_name,generic_name_pt,brands,quantity,categories,categories_tags,image_front_thumb_url,image_front_small_url,image_front_url,image_url';
      const UA = { 'User-Agent': 'MeuMercadoTeste/1.0 (simulador local; contato@local)' };

      const fetchOff = async (term) => {
        const digits = term.replace(/\D/g, '');
        const isBarcode = digits.length >= 8 && digits.length <= 14 && /^\d+$/.test(digits) && digits === term.replace(/\s/g, '');
        if (isBarcode || (digits.length >= 8 && digits.length <= 14 && !/[a-zA-Zà-úÀ-Ú]/.test(term))) {
          const code = digits;
          const r = await fetch(`https://br.openfoodfacts.org/api/v2/product/${code}.json?fields=${OFF_FIELDS}`, { headers: UA });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const data = await r.json();
          if (data.status === 1 && data.product) return [data.product];
          // tenta world se BR não achar
          const r2 = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${OFF_FIELDS}`, { headers: UA });
          const data2 = await r2.json();
          if (data2.status === 1 && data2.product) return [data2.product];
          return [];
        }
        // Busca textual multi-fonte com variantes
        const base = normalizeSearchTerm(term);
        const variants = [base];
        const withoutSize = base.replace(/\s*\d+[.,]?\d*\s*(kg|g|ml|l)\b/gi, '').trim();
        if (withoutSize && withoutSize !== base) variants.push(withoutSize);
        const spaced = base.replace(/(\d)(kg|g|ml|l)\b/gi, '$1 $2');
        if (spaced !== base) variants.push(spaced);
        // singular/plural simples
        if (base.endsWith('s') && base.length > 4) variants.push(base.slice(0, -1));
        else variants.push(base + 's');

        const hosts = [
          { host: 'br.openfoodfacts.org', source: 'openfoodfacts' },
          { host: 'world.openfoodfacts.org', source: 'openfoodfacts' },
          { host: 'world.openproductsfacts.org', source: 'openproductsfacts' },
          { host: 'world.openbeautyfacts.org', source: 'openbeautyfacts' },
          { host: 'world.openpetfoodfacts.org', source: 'openpetfoodfacts' },
        ];
        const seen = new Set();
        const products = [];
        const add = (list, source) => {
          for (const p of list) {
            const key = p.code || (p.product_name + '|' + (p.brands || ''));
            if (!key || seen.has(key)) continue;
            seen.add(key);
            p._source = source;
            products.push(p);
          }
        };
        // 1º: BR food com todas variantes
        for (const v of variants) {
          if (products.length >= 20) break;
          try {
            const url = `https://br.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(v)}&search_simple=1&action=process&json=1&page_size=24&fields=${OFF_FIELDS}`;
            const r = await fetch(url, { headers: UA });
            if (r.ok) { const data = await r.json(); add(data.products || [], 'openfoodfacts'); }
          } catch (_) {}
        }
        // 2º: se poucos resultados, outras bases (produtos, beleza, pet)
        if (products.length < 6) {
          for (const { host, source } of hosts.slice(1)) {
            if (products.length >= 20) break;
            try {
              const url = `https://${host}/cgi/search.pl?search_terms=${encodeURIComponent(base)}&search_simple=1&action=process&json=1&page_size=12&fields=${OFF_FIELDS}`;
              const r = await fetch(url, { headers: UA });
              if (r.ok) { const data = await r.json(); add(data.products || [], source); }
            } catch (_) {}
          }
        }
        return products.slice(0, 20);
      };

      const search = debounce(async () => {
        const term = (q.value || '').trim();
        if (term.length < 2) {
          res.replaceChildren(h('p', { class: 'muted' }, 'Digite nome (ex: Arroz 5kg) ou código de barras.'));
          formBox.replaceChildren();
          return;
        }
        res.replaceChildren(h('p', { class: 'muted' }, 'Buscando no catálogo e nas bases externas…'));
        formBox.replaceChildren();
        try {
          // 1) Catálogo Global local primeiro
          const tNorm = R.normText(term);
          let globalHits = [];
          try {
            const allGp = await api.col('globalProducts', { where: [['active', '==', true]], limit: 500 });
            globalHits = allGp.filter(g => R.normText([g.name, g.brand, g.barcode].join(' ')).includes(tNorm)).slice(0, 8);
          } catch (_) {}
          const products = await fetchOff(term);
          // Exibe hits do catálogo global como cards especiais
          const globalCards = globalHits.map(g => h('div', { class: 'card flat row between', style: { cursor: 'pointer', gap: '10px', borderLeft: '3px solid var(--ok, #1F9D55)' }, onclick: () => {
            // reutiliza fluxo de vínculo ao global
            showForm({
              product_name: g.name, brands: g.brand || '', code: g.barcode || '', quantity: g.size && g.unit ? (g.size + g.unit) : '',
              image_url: g.imageUrl, image_front_thumb_url: g.imageUrl, categories_tags: [], _globalId: g.id, _source: 'global'
            });
            if (g.categoryId) cat.value = g.categoryId;
          } },
            h('div', { class: 'row', style: { gap: '10px', flex: 1 } },
              g.imageUrl ? h('img', { src: g.imageUrl, alt: '', style: { width: '52px', height: '52px', objectFit: 'contain', borderRadius: '6px', background: '#f5f5f5' }, loading: 'lazy' }) : h('div', { style: { width: '52px', height: '52px', background: '#eee', borderRadius: '6px' } }),
              h('div', null, h('b', null, g.name), h('div', { class: 'tiny muted' }, [g.brand, g.barcode].filter(Boolean).join(' · ')), h('span', { class: 'badge g' }, 'Catálogo global'))
            ),
            h('button', { class: 'btn sm', type: 'button' }, 'Usar')
          ));
          if (!products.length && !globalHits.length) {
            res.replaceChildren(h('p', { class: 'muted' }, 'Nenhum produto encontrado. Tente outro termo (sem acento, ou só a marca) ou use a aba Produto local.'));
            return;
          }
          const extCards = products.map(p => {
            const name = offName(p);
            const brand = offBrand(p);
            const thumb = offThumb(p);
            const catGuess = guessCategory(p);
            const catName = (S.cats.find(c => c.id === catGuess) || {}).name || '';
            return h('div', { class: 'card flat row between', style: { cursor: 'pointer', gap: '10px' }, onclick: () => showForm(p) },
              h('div', { class: 'row', style: { gap: '10px', flex: 1, minWidth: 0 } },
                thumb ? h('img', { src: thumb, alt: '', style: { width: '52px', height: '52px', objectFit: 'contain', borderRadius: '6px', background: '#f5f5f5', flexShrink: 0 }, loading: 'lazy' })
                  : h('div', { style: { width: '52px', height: '52px', background: '#eee', borderRadius: '6px', flexShrink: 0 } }),
                h('div', { style: { minWidth: 0 } },
                  h('b', { style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
                  h('div', { class: 'tiny muted' }, [brand, p.quantity, p.code].filter(Boolean).join(' · ')),
                  catName && h('div', { class: 'tiny' }, h('span', { class: 'badge' }, catName))
                )
              ),
              h('button', { class: 'btn sm', type: 'button', onclick: (ev) => { ev.stopPropagation(); showForm(p); } }, 'Selecionar')
            );
          });
          res.replaceChildren(...globalCards, ...extCards);
        } catch (err) {
          res.replaceChildren(h('p', { class: 'muted' }, 'Falha na busca: ' + (err.message || 'rede indisponível') + '. Cadastre manualmente na aba Produto local.'));
        }
      }, 450);

      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
      const scanBtn = h('button', {
        class: 'btn ghost', type: 'button', title: 'Ler código de barras com a câmera',
        onclick: () => openBarcodeScanner({
          onCode: (code) => {
            q.value = code;
            toast('Código ' + code, 'ok');
            search();
          }
        })
      }, '📷 Código');
      // Busca só ao pressionar Enter ou clicar em Buscar (evita spam na API)
      return h('div', { class: 'stack' },
        h('div', { class: 'alert' }, 'Pesquise por nome ou código. Use 📷 Código para ler o código de barras com a câmera — busca automática no Open Food Facts. A categoria é sugerida; você define preço e estoque.'),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, q), scanBtn, h('button', { class: 'btn', type: 'button', onclick: () => search() }, 'Buscar')),
        res, formBox
      );
    };

    const globalTab = () => { const q = inp({ ph: 'Buscar por nome, marca ou código de barras' }); const res = h('div', { class: 'stack' }); let all = null; const price = inp({ ph: 'Preço R$', mode: 'decimal' }); const qty = inp({ type: 'number', ph: 'Qtd. alocada', min: 0 });
      const search = debounce(async () => { if (!all) all = await api.col('globalProducts', { where: [['active', '==', true]], limit: 800 }); const t = R.normText(q.value); const rows = all.filter(g => !t || R.normText([g.name, g.brand, g.barcode].join(' ')).includes(t)).slice(0, 12); res.replaceChildren(...(rows.length ? rows.map(g => h('div', { class: 'card flat row between' }, h('div', null, h('b', null, g.name), h('div', { class: 'tiny muted' }, [g.brand, g.size && g.unit ? g.size + ' ' + g.unit : null, g.barcode].filter(Boolean).join(' · '))), h('button', { class: 'btn sm', onclick: (e) => busy(e.currentTarget, async () => { const p = parseMoney(price.value); if (!(p > 0)) throw new Error('Informe o preço antes.'); await api.call('marketUpsertListing', { marketId: mid, globalProductId: g.id, price: p, allocated: parseInt(qty.value) || 0, active: (parseInt(qty.value) || 0) > 0 }); toast('Produto vinculado', 'ok'); m.close(); done && done(); }) }, 'Vincular'))) : [h('p', { class: 'muted' }, 'Nada encontrado. Cadastre como produto local (a equipe da plataforma revisa depois).')])); }, 300);
      q.addEventListener('input', search); search(); return h('div', { class: 'stack' }, q, h('div', { class: 'grid g2' }, field('Seu preço (R$)', price), field('Quantidade para vender na plataforma', qty)), res); };
    const localTab = () => { const f = { name: inp({ max_len: 160 }), brand: inp({ max_len: 80 }), barcode: inp({ mode: 'numeric' }), size: inp({ mode: 'decimal' }), unit: sel([['', 'Unidade…'], ['g', 'g'], ['kg', 'kg'], ['ml', 'ml'], ['l', 'l'], ['un', 'un']], ''), cat: sel([['', 'Categoria…'], ...S.cats.map(c => [c.id, (c.parentId ? '— ' : '') + c.name])], ''), price: inp({ mode: 'decimal' }), qty: inp({ type: 'number', min: 0 }) }; const desc = h('textarea', { class: 'in', maxlength: 800, placeholder: 'Para combos: liste os itens incluídos' }); const combo = h('input', { type: 'checkbox' });
      return h('div', { class: 'stack' }, h('div', { class: 'alert' }, 'Produtos locais não alteram o catálogo global e ficam marcados para revisão da plataforma. Códigos de barras, preços e quantidades nunca são inventados.'), field('Nome', f.name), h('div', { class: 'grid g2' }, field('Marca', f.brand), field('Código de barras', f.barcode)), h('div', { class: 'grid g2' }, field('Tamanho/peso/volume', f.size), field('Unidade', f.unit)), field('Categoria', f.cat), h('div', { class: 'grid g2' }, field('Preço (R$)', f.price), field('Qtd. alocada', f.qty)), h('label', { class: 'row' }, combo, ' É um combo/kit (preço e quantidade próprios)'), field('Descrição', desc), h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { const p = parseMoney(f.price.value); if (!f.name.value.trim() || !f.unit.value || !f.cat.value || !(p > 0)) throw new Error('Preencha nome, unidade, categoria e preço.'); await api.call('marketUpsertListing', { marketId: mid, name: f.name.value.trim(), brand: f.brand.value.trim() || null, barcode: f.barcode.value.trim() || null, size: f.size.value ? Number(f.size.value.replace(',', '.')) : null, unit: f.unit.value, categoryId: f.cat.value, price: p, allocated: parseInt(f.qty.value) || 0, active: (parseInt(f.qty.value) || 0) > 0, description: desc.value.trim() || null, kind: combo.checked ? 'combo' : 'product' }); toast('Produto cadastrado', 'ok'); m.close(); done && done(); }) }, 'Cadastrar')); };
    draw(); return h('div', null, tabs, body); }, { title: 'Novo produto', wide: true });
}

routeA("market", /^\/painel\/produtos$/, async () => {
  if (!can(SESSION.user, 'products.read')) return mpanel('produtos', noPerm()); const { mid, s } = await mctx(); const catById = mapById(S.cats); let rows = []; const body = h('tbody'); const st = { q: '', f: 'all' }; const count = h('span', { class: 'muted' });
  const draw = () => { const t = R.normText(st.q); const arr = rows.filter(l => (!t || R.normText([l.name, l.brand, l.barcode].join(' ')).includes(t)) && ({ all: true, active: l.active, inactive: !l.active, promo: !!promoTag(l), low: l.active && R.availableQty(l) > 0 && R.availableQty(l) <= lowOf(l, s), out: R.availableQty(l) <= 0 }[st.f])).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')); count.textContent = `${arr.length} de ${rows.length}`;
    body.replaceChildren(...arr.map(l => h('tr', null, h('td', null, h('b', null, l.name), h('div', { class: 'tiny muted' }, [l.brand, l.unitLabel, l.local ? 'local' : null, l.kind === 'combo' ? 'combo' : null].filter(Boolean).join(' · '))), h('td', { class: 'tiny' }, catById[l.categoryId]?.name || '—'), h('td', { class: 'num' }, brl(l.price)), h('td', null, promoTag(l) ? h('span', { class: 'badge o' }, promoTag(l)) : '—'), h('td', { class: 'num' }, `${R.availableQty(l)} / ${l.allocated}`), h('td', null, !l.active ? h('span', { class: 'badge g' }, 'Inativo') : R.availableQty(l) <= 0 ? h('span', { class: 'badge r' }, 'Esgotado') : l.stockStatus === 'low' ? h('span', { class: 'badge b' }, 'Baixo') : h('span', { class: 'badge' }, 'Ativo')), h('td', null, h('button', { class: 'btn sm ghost', onclick: () => openListingEditor(l, mid, s) }, icon('edit'), 'Editar'))))); if (!arr.length) body.replaceChildren(h('tr', null, h('td', { colspan: 7 }, empty('📦', rows.length ? 'Nada com esses filtros' : 'Nenhum produto ainda', rows.length ? null : 'Vincule produtos do catálogo global ou importe uma planilha.')))); };
  const q = inp({ ph: 'Buscar produto, marca ou código', oninput: (e) => { st.q = e.target.value; draw(); }, label: 'Buscar' });
  S.cleanups.push(api.watchCol(`markets/${mid}/listings`, { limit: 1000 }, (r) => { rows = r; draw(); }, () => {}));
  return mpanel('produtos', h('div', { class: 'row between' }, h('h1', { style: { margin: 0 } }, 'Produtos'), h('div', { class: 'row' }, can(SESSION.user, 'products.import') && h('a', { class: 'btn ghost', href: href('/painel/importar') }, icon('upload'), 'Importar planilha'), can(SESSION.user, 'products.write') && h('button', { class: 'btn', onclick: () => openNewListing(mid, s) }, icon('plus'), 'Novo produto'))),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, q), sel([['all', 'Todos'], ['active', 'Ativos'], ['inactive', 'Inativos'], ['promo', 'Em promoção'], ['low', 'Estoque baixo'], ['out', 'Esgotados']], 'all', { label: 'Filtro', onchange: (e) => { st.f = e.target.value; draw(); } }), count),
    h('div', { class: 'tw card flat', style: { padding: 0 } }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Produto', 'Categoria', 'Preço', 'Promoção', 'Disp. / alocado', 'Status', ''].map((c, i) => h('th', { class: i === 2 || i === 4 ? 'num' : '' }, c)))), body)));
});

/* ───────────────────────── Estoque alocado ───────────────────────── */
routeA("market", /^\/painel\/estoque$/, async () => {
  if (!can(SESSION.user, 'products.read')) return mpanel('estoque', noPerm()); const { mid, s } = await mctx(); const body = h('tbody'); let rows = []; let f = 'attention'; const canW = can(SESSION.user, 'stock.write');
  const draw = () => { const arr = rows.filter(l => f === 'all' || (f === 'out' ? R.availableQty(l) <= 0 : f === 'low' ? R.availableQty(l) > 0 && R.availableQty(l) <= lowOf(l, s) : (R.availableQty(l) <= lowOf(l, s)))).sort((a, b) => R.availableQty(a) - R.availableQty(b));
    body.replaceChildren(...(arr.length ? arr.map(l => { const a = inp({ type: 'number', value: l.allocated, min: R.minAllocation(l), label: 'Alocado ' + l.name }); a.style.width = '96px'; a.disabled = !canW; return h('tr', null, h('td', null, h('b', null, l.name), h('div', { class: 'tiny muted' }, l.unitLabel || '')), h('td', { class: 'num' }, l.reserved || 0), h('td', { class: 'num' }, l.committed || 0), h('td', { class: 'num' }, h('b', null, R.availableQty(l))), h('td', null, a), h('td', null, R.availableQty(l) <= 0 ? h('span', { class: 'badge r' }, 'Esgotado') : R.availableQty(l) <= lowOf(l, s) ? h('span', { class: 'badge b' }, 'Baixo') : h('span', { class: 'badge' }, 'OK')), h('td', null, canW && h('button', { class: 'btn sm', onclick: (e) => busy(e.currentTarget, async () => { const n = parseInt(a.value); if (!Number.isInteger(n) || n < 0) throw new Error('Quantidade inválida.'); const d = { marketId: mid, id: l.id, allocated: n }; if (!l.active && n > R.minAllocation(l)) d.active = true; await api.call('marketUpsertListing', d); toast(!l.active && d.active ? 'Estoque atualizado e produto reativado' : 'Estoque atualizado', 'ok'); }) }, 'Salvar'))); }) : [h('tr', null, h('td', { colspan: 7 }, empty('✅', 'Tudo em ordem', 'Nenhum produto com estoque baixo ou esgotado.')))])); };
  S.cleanups.push(api.watchCol(`markets/${mid}/listings`, { limit: 1000 }, (r) => { rows = r; draw(); }, () => {}));
  return mpanel('estoque', h('h1', null, 'Estoque alocado à plataforma'), h('div', { class: 'alert' }, h('div', null, 'Aqui você informa só a quantidade que realmente quer vender no Meu Mercado — não é o estoque físico da loja. ', h('b', null, 'Disponível = alocado − reservado − comprometido.'), ' Você pode reduzir a alocação até o que já está reservado ou vendido; essas unidades continuam sendo obrigação de atendimento.')),
    h('div', { class: 'row' }, sel([['attention', 'Precisam de atenção'], ['low', 'Estoque baixo'], ['out', 'Esgotados'], ['all', 'Todos']], f, { label: 'Filtro', onchange: (e) => { f = e.target.value; draw(); } })), h('div', { class: 'tw card flat', style: { padding: 0 } }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Produto', 'Reservado', 'Vendido/comprometido', 'Disponível', 'Alocado', 'Status', ''].map((c, i) => h('th', { class: i > 0 && i < 4 ? 'num' : '' }, c)))), body)), h('p', { class: 'tiny muted' }, 'Quando chega a zero, o produto continua no catálogo como “Esgotado” e não pode ser comprado até você repor e reativar.'));
});


/* ───────────────────────── Importação em massa ───────────────────────── */
function parseCSV(text) {
  const first = text.split(/\r?\n/, 1)[0] || ''; const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : (first.includes('\t') ? '\t' : ',');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === delim) { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x.trim() !== '')) rows.push(row); row = []; } else cur += c; }
  row.push(cur); if (row.some(x => x.trim() !== '')) rows.push(row); return rows;
}
async function readSheet(file) {
  if (file.size > 10 * 1024 * 1024) throw new Error('Arquivo maior que 10 MB.');
  const buf = await file.arrayBuffer(); let grid;
  if (/\.(xlsx|xls)$/i.test(file.name)) throw new Error('Planilhas Excel precisam ser salvas como CSV (o simulador não usa bibliotecas externas). No Excel: Arquivo → Salvar como → CSV UTF-8.');
  if (/\.(csv|txt)$/i.test(file.name)) { let t = new TextDecoder('utf-8').decode(buf); if (t.includes('�')) t = new TextDecoder('windows-1252').decode(buf); grid = parseCSV(t.replace(/^﻿/, '')); }
  else throw new Error('Use um arquivo .csv, .xlsx ou .xls.');
  grid = grid.filter(r => r.some(c => String(c).trim() !== '')); if (grid.length < 2) throw new Error('A planilha precisa de um cabeçalho e ao menos uma linha.');
  return { headers: grid[0].map(x => String(x).trim()), rows: grid.slice(1) };
}
const IMPORT_FIELDS = [['name', 'Nome *', ['nome', 'produto', 'descricao', 'item']], ['brand', 'Marca', ['marca', 'fabricante']], ['barcode', 'Código de barras', ['barras', 'ean', 'gtin', 'codigo']], ['size', 'Tamanho/peso/volume', ['tamanho', 'peso', 'volume', 'quantidade por', 'conteudo']], ['unit', 'Unidade * (g, kg, ml, l, un)', ['unidade', 'unid', 'medida', 'und']], ['price', 'Preço *', ['preco', 'valor', 'price']], ['allocated', 'Quantidade a vender *', ['quantidade', 'qtd', 'estoque', 'alocad']], ['category', 'Categoria *', ['categoria', 'setor', 'secao', 'departamento']]];
function templateCSV() { return '﻿nome;marca;codigo_de_barras;tamanho;unidade;preco;quantidade;categoria\nArroz branco tipo 1;Marca Exemplo;;5;kg;27,90;50;arroz-e-feijao\n'; }
routeA("market", /^\/painel\/importar$/, async () => {
  const u = SESSION.user; if (!can(u, 'products.import')) return mpanel('importar', noPerm()); const { mid } = await mctx(); const root = h('div', { class: 'stack' }); const stage = h('div', { class: 'stack' }); const hist = h('div', { class: 'stack' });
  const catIdOf = (v) => { const t = R.normText(v); const c = S.cats.find(x => R.normText(x.id) === t || R.normText(x.name) === t); return c ? c.id : String(v).trim(); };
  S.cleanups.push(api.watchCol(`markets/${mid}/imports`, { orderBy: [['createdAt', 'desc']], limit: 10 }, (rows) => hist.replaceChildren(h('h3', null, 'Importações anteriores'), ...(rows.length ? rows.map(i => h('div', { class: 'card flat row between' }, h('div', null, h('b', null, i.fileName || 'Planilha'), h('div', { class: 'tiny muted' }, `${dt(i.createdAt)} · ${i.total} linhas · ${i.valid} válidas · ${i.suspects} suspeitas · ${i.errors} com erro`)), h('div', { class: 'row' }, h('span', { class: 'badge ' + (i.status === 'published' ? '' : 'o') }, { review: 'Em revisão', partial: 'Parcial', published: 'Publicada' }[i.status] || i.status), i.status !== 'published' && h('button', { class: 'btn sm', onclick: () => review(i.id) }, i.status === 'partial' ? 'Retomar' : 'Revisar')))) : [h('p', { class: 'muted' }, 'Nenhuma importação ainda.')])), () => {}));
  async function review(importId) {
    stage.replaceChildren(h('div', { class: 'spin' })); let rows; try { rows = (await api.col(`markets/${mid}/imports/${importId}/rows`)).sort((a, b) => a.line - b.line); } catch (e) { return stage.replaceChildren(errorBox(e)); }
    const accept = new Set(); const cnt = (s) => rows.filter(r => r.status === s).length; const canApprove = can(u, 'products.import.approve');
    const tr = (r) => h('tr', null, h('td', null, r.line), h('td', null, r.status === 'valid' ? h('span', { class: 'badge' }, 'Válida') : r.status === 'error' ? h('span', { class: 'badge r' }, 'Erro') : r.status === 'duplicate_suspect' ? h('span', { class: 'badge o' }, 'Possível duplicata') : h('span', { class: 'badge g' }, r.status)), h('td', null, h('b', null, r.data.name || '—'), h('div', { class: 'tiny muted' }, [r.data.brand, r.data.size ? r.data.size + ' ' + (r.data.unit || '') : r.data.unit, r.data.barcode].filter(Boolean).join(' · '))), h('td', { class: 'num' }, r.data.price != null ? brl(r.data.price) : '—'), h('td', { class: 'num' }, r.data.allocated ?? '—'), h('td', { class: 'tiny' }, [...(r.errors || []), ...(r.warnings || [])].join('; ')), h('td', null, r.status === 'duplicate_suspect' && canApprove && h('label', { class: 'tiny' }, h('input', { type: 'checkbox', onchange: (e) => { e.target.checked ? accept.add(r.id) : accept.delete(r.id); } }), ' Publicar mesmo assim')));
    stage.replaceChildren(h('div', { class: 'card stack' }, h('h3', { style: { margin: 0 } }, 'Pré-visualização e conferência'), h('div', { class: 'row' }, h('span', { class: 'badge' }, `${cnt('valid')} válidas`), h('span', { class: 'badge o' }, `${cnt('duplicate_suspect')} possíveis duplicatas`), h('span', { class: 'badge r' }, `${cnt('error')} com erro`), h('span', { class: 'badge g' }, `${cnt('published')} já publicadas`)), h('div', { class: 'alert' }, 'Nada vai para a loja até a aprovação. Linhas com erro não são publicadas — corrija a planilha e importe de novo. Preços, unidades, quantidades e códigos de barras ausentes nunca são preenchidos automaticamente.'),
      h('div', { class: 'tw', style: { maxHeight: '380px', overflow: 'auto' } }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Linha', 'Status', 'Produto', 'Preço', 'Qtd.', 'Observações', ''].map(c => h('th', null, c)))), h('tbody', null, rows.map(tr)))),
      canApprove ? h('button', { class: 'btn', disabled: !cnt('valid') && true === false, onclick: async (e) => { if (!(await confirmDlg('Publicar importação', `Publicar ${cnt('valid')} produtos válidos${accept.size ? ` + ${accept.size} duplicatas aceitas` : ''}? Eles ficam marcados para revisão do catálogo.`, 'Publicar'))) return; await busy(e.currentTarget, async () => { const r = await api.call('marketImportApprove', { marketId: mid, importId, acceptSuspectIds: [...accept] }); toast(`${r.published} produtos publicados. ${r.remaining ? r.remaining + ' linhas pendentes (você pode retomar).' : ''}`, 'ok'); review(importId); }); } }, 'Aprovar e publicar') : h('div', { class: 'alert warn' }, 'Seu usuário pode enviar planilhas, mas a aprovação é feita por um funcionário com permissão de aprovar importações.')));
  }
  const file = h('input', { type: 'file', accept: '.csv,.xlsx,.xls,.txt', 'aria-label': 'Arquivo de produtos' }); const mapBox = h('div', { class: 'stack' });
  file.addEventListener('change', async () => { mapBox.replaceChildren(); stage.replaceChildren(); if (!file.files[0]) return; try { const sheet = await readSheet(file.files[0]); const map = {}; IMPORT_FIELDS.forEach(([k, , keys]) => { const i = sheet.headers.findIndex(hd => keys.some(w => R.normText(hd).includes(w))); map[k] = i; });
    const selects = IMPORT_FIELDS.map(([k, label]) => { const s2 = sel([['-1', '— não usar —'], ...sheet.headers.map((hd, i) => [String(i), hd || `Coluna ${i + 1}`])], String(map[k]), { label, onchange: (e) => { map[k] = parseInt(e.target.value); } }); return field(label, s2); });
    mapBox.replaceChildren(h('div', { class: 'card stack' }, h('h3', { style: { margin: 0 } }, '2. Confira o mapeamento das colunas'), h('p', { class: 'muted tiny' }, `${sheet.rows.length} linhas lidas de “${file.files[0].name}”.`), h('div', { class: 'grid g2' }, selects), h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { if (map.name < 0 || map.price < 0 || map.unit < 0 || map.allocated < 0 || map.category < 0) throw new Error('Mapeie ao menos nome, preço, unidade, quantidade e categoria.'); if (sheet.rows.length > 2000) throw new Error('Máximo de 2000 linhas por importação. Divida a planilha.'); const g = (r, k) => map[k] >= 0 ? String(r[map[k]] ?? '').trim() : ''; const rows = sheet.rows.map(r => ({ name: g(r, 'name'), brand: g(r, 'brand'), barcode: g(r, 'barcode'), size: g(r, 'size'), unit: g(r, 'unit'), price: g(r, 'price'), allocated: g(r, 'allocated'), categoryId: g(r, 'category') ? catIdOf(g(r, 'category')) : '' })); const r = await api.call('marketImportStage', { marketId: mid, rows, fileName: file.files[0].name, mapping: map }); toast(`${r.valid} válidas, ${r.suspects} suspeitas, ${r.errors} com erro`, 'ok'); review(r.importId); }) }, 'Validar e pré-visualizar'))); } catch (e) { toast(errMsg(e), 'err'); } });
  root.append(h('h1', null, 'Importar produtos'), h('div', { class: 'card stack' }, h('h3', { style: { margin: 0 } }, '1. Envie a planilha (CSV ou Excel)'), h('p', { class: 'muted tiny' }, 'Fluxo: upload → mapeamento → validação → pré-visualização → aprovação → publicação em lote. Listas preparadas com ferramentas externas de IA podem ser usadas como planilha, mas passam pela mesma validação.'), file, h('button', { class: 'btn sm ghost', onclick: () => download('modelo-importacao.csv', new Blob([templateCSV()], { type: 'text/csv;charset=utf-8' })) }, icon('download'), 'Baixar modelo CSV')), mapBox, stage, hist);
  return mpanel('importar', root);
});

/* ───────────────────────── Promoções e cupons ───────────────────────── */
routeA("market", /^\/painel\/promocoes$/, async () => {
  if (!can(SESSION.user, 'promotions.write')) return mpanel('promocoes', noPerm()); const { mid, s } = await mctx(); const listBox = h('div', { class: 'stack' }), couponBox = h('div', { class: 'stack' }); let ls = [];
  const drawL = () => { const p = ls.filter(l => l.promo); listBox.replaceChildren(p.length ? h('div', { class: 'tw card flat', style: { padding: 0 } }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Produto', 'Preço normal', 'Promoção', 'Período', ''].map(c => h('th', null, c)))), h('tbody', null, p.map(l => h('tr', null, h('td', null, h('b', null, l.name), h('div', { class: 'tiny muted' }, l.unitLabel || '')), h('td', { class: 'num' }, brl(l.price)), h('td', null, h('span', { class: 'badge o' }, promoTag({ promo: { ...l.promo, start: null, end: null } }) || 'Oferta')), h('td', { class: 'tiny' }, `${l.promo.start ? dday(l.promo.start) : 'já'} → ${l.promo.end ? dday(l.promo.end) : 'sem fim'}`), h('td', null, h('button', { class: 'btn sm ghost', onclick: () => openListingEditor(l, mid, s) }, 'Editar'))))))) : empty('🏷', 'Nenhuma promoção ativa', 'Crie ofertas por período, “leve 5 pague 4”, descontos progressivos e mais.')); };
  S.cleanups.push(api.watchCol(`markets/${mid}/listings`, { limit: 1000 }, (r) => { ls = r; drawL(); }, () => {}));
  S.cleanups.push(api.watchCol('coupons', { where: [['marketId', '==', mid]] }, (rows) => couponBox.replaceChildren(rows.length ? rows.map(c => h('div', { class: 'card flat row between' }, h('div', null, h('b', null, c.code), h('div', { class: 'tiny muted' }, `${c.type === 'percent' ? c.value + '%' : c.type === 'fixed' ? brl(c.value) : 'Frete grátis'} · usos: ${c.usedCount || 0}${c.maxUses ? '/' + c.maxUses : ''}${c.minOrder ? ' · mín. ' + brl(c.minOrder) : ''}${c.stackWithPromo ? ' · acumula com promoção' : ''}`)), h('div', { class: 'row' }, h('span', { class: 'badge ' + (c.active ? '' : 'g') }, c.active ? 'Ativo' : 'Inativo'), h('button', { class: 'btn sm ghost', onclick: (e) => busy(e.currentTarget, async () => { await api.call('marketUpsertCoupon', { marketId: mid, code: c.code.split('-').slice(1).join('-'), type: c.type, value: c.value, minOrder: c.minOrder, maxUses: c.maxUses, validTo: c.validTo, stackWithPromo: c.stackWithPromo, visibility: c.visibility, active: !c.active }); }) }, c.active ? 'Desativar' : 'Ativar')))) : [h('p', { class: 'muted' }, 'Nenhum cupom do mercado.')]), () => couponBox.replaceChildren(h('p', { class: 'muted' }, 'Não foi possível listar cupons.'))));
  const f = { code: inp({ ph: 'VERAO10', max_len: 20 }), type: sel([['percent', 'Percentual'], ['fixed', 'Valor fixo (R$)'], ['freeShipping', 'Frete grátis']], 'percent'), value: inp({ mode: 'decimal', ph: '10 ou 5,00' }), min: inp({ mode: 'decimal', ph: 'R$' }), max: inp({ type: 'number', min: 1 }), end: inp({ type: 'date' }) }; const stack = h('input', { type: 'checkbox' }); const free = inp({ mode: 'decimal', value: s.freeShippingAbove ? moneyIn(s.freeShippingAbove) : '', ph: 'R$ (vazio = sem frete grátis)' });
  return mpanel('promocoes', h('h1', null, 'Promoções e cupons'), h('section', { class: 'stack' }, h('div', { class: 'row between' }, h('h3', { style: { margin: 0 } }, 'Promoções por produto'), h('a', { class: 'btn sm', href: href('/painel/produtos') }, 'Escolher produto')), listBox, h('p', { class: 'tiny muted' }, 'Tipos: preço promocional, percentual, leve X pague Y e desconto progressivo. Combos são cadastrados como produto-kit (preço e quantidade próprios). Preços novos valem só para novas compras; pedidos antigos preservam os valores.')),
    h('section', { class: 'card stack' }, h('h3', { style: { margin: 0 } }, 'Frete grátis acima de um valor'), h('div', { class: 'row' }, h('div', { class: 'grow' }, free), h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { const v = free.value.trim() ? parseMoney(free.value) : 0; if (!Number.isFinite(v) || v < 0) throw new Error('Valor inválido.'); await api.call('marketUpdateSettings', { marketId: mid, settings: { freeShippingAbove: v } }); toast('Frete grátis atualizado', 'ok'); }) }, 'Salvar')), h('div', { class: 'tiny muted' }, 'O custo do frete grátis é do mercado. A comissão da plataforma nunca incide sobre a taxa de entrega.')),
    h('section', { class: 'stack' }, h('h3', null, 'Cupons do mercado'), couponBox, h('form', { class: 'card stack', onsubmit: async (e) => { e.preventDefault(); await busy(e.submitter, async () => { const t = f.type.value; const v = t === 'percent' ? Number(f.value.value.replace(',', '.')) : t === 'fixed' ? parseMoney(f.value.value) : 0; if (!f.code.value.trim()) throw new Error('Informe o código.'); if (t !== 'freeShipping' && !(v > 0)) throw new Error('Informe o valor do desconto.'); await api.call('marketUpsertCoupon', { marketId: mid, code: f.code.value.trim(), type: t, value: v, minOrder: f.min.value ? parseMoney(f.min.value) : null, maxUses: f.max.value ? parseInt(f.max.value) : null, validTo: f.end.value ? f.end.value + 'T23:59:59' : null, stackWithPromo: stack.checked, visibility: 'public' }); toast('Cupom salvo', 'ok'); e.target.reset(); }); } }, h('h4', null, 'Novo cupom'), h('div', { class: 'grid g2' }, field('Código', f.code), field('Tipo', f.type)), h('div', { class: 'grid g2' }, field('Valor (% ou R$)', f.value), field('Pedido mínimo', f.min)), h('div', { class: 'grid g2' }, field('Limite de usos', f.max), field('Válido até', f.end)), h('label', { class: 'row' }, stack, ' Pode ser combinado com promoções de produtos'), h('button', { class: 'btn', type: 'submit' }, 'Salvar cupom'), h('div', { class: 'tiny muted' }, 'A ordem de aplicação, os limites e o cálculo da comissão são validados no servidor.'))));
});

/* ───────────────────────── Entrega, horários e capacidade ───────────────────────── */
const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
routeA("market", /^\/painel\/entrega$/, async () => {
  if (!can(SESSION.user, 'settings.write')) return mpanel('entrega', noPerm()); const { mid, m, s } = await mctx(); const area = s.deliveryArea || {}; const cap = s.capacity || {}; const sch = s.scheduling || { enabled: true, slotMinutes: 60 };
  const hrs = DAYS.map((_, d) => [0, 1].map(k => { const sl = (s.hours || {})[d]?.[k] || {}; return { o: inp({ type: 'time', value: sl.open || '', label: `${DAYS[d]} abre` }), c: inp({ type: 'time', value: sl.close || '', label: `${DAYS[d]} fecha` }) }; }));
  const closed = h('textarea', { class: 'in', placeholder: 'AAAA-MM-DD, um por linha (feriados e horários especiais)' }); closed.value = (s.closedDates || []).join('\n');
  const f = { fee: inp({ mode: 'decimal', value: moneyIn(s.deliveryFee) }), min: inp({ mode: 'decimal', value: moneyIn(s.minOrder) }), eta: inp({ type: 'number', value: s.etaMinutes || 60, min: 10 }), ceps: h('textarea', { class: 'in', placeholder: 'Prefixos de CEP (ex.: 01310, 013), separados por vírgula' }), dist: h('textarea', { class: 'in', placeholder: 'Bairros atendidos, um por linha' }), lat: inp({ mode: 'decimal', value: area.center?.lat ?? '' }), lng: inp({ mode: 'decimal', value: area.center?.lng ?? '' }), rad: inp({ mode: 'decimal', value: area.radiusKm ?? '' }), mh: inp({ type: 'number', value: cap.maxPerHour ?? '' }), md: inp({ type: 'number', value: cap.maxPerDay ?? '' }), ms: inp({ type: 'number', value: cap.maxPerSlot ?? '' }), slotMin: sel([[30, '30 min'], [60, '1 hora'], [120, '2 horas']], sch.slotMinutes || 60), low: inp({ type: 'number', value: s.lowStockDefault ?? 5 }) }; f.ceps.value = (area.ceps || []).join(', '); f.dist.value = (area.districts || []).join('\n'); const schOn = h('input', { type: 'checkbox', checked: sch.enabled !== false });
  const save = (btn) => busy(btn, async () => {
    const hours = {}; hrs.forEach((slots, d) => { const arr = slots.filter(x => x.o.value && x.c.value).map(x => ({ open: x.o.value, close: x.c.value })); if (arr.some(x => x.open >= x.close)) throw new Error(`${DAYS[d]}: a abertura deve ser antes do fechamento.`); if (arr.length) hours[d] = arr; });
    const num = (v) => v === '' ? null : Number(String(v).replace(',', '.')); const fee = parseMoney(f.fee.value || '0'), minO = parseMoney(f.min.value || '0'); if (!Number.isFinite(fee) || !Number.isFinite(minO)) throw new Error('Valores em R$ inválidos.');
    const lat = num(f.lat.value), lng = num(f.lng.value), rad = num(f.rad.value); if ((lat != null || lng != null || rad != null) && (lat == null || lng == null || rad == null)) throw new Error('Para usar raio, informe latitude, longitude e raio (km).');
    const settings = { hours, closedDates: closed.value.split(/\s+/).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)), deliveryFee: fee, minOrder: minO, etaMinutes: parseInt(f.eta.value) || 60, deliveryArea: { ceps: f.ceps.value.split(/[,\s]+/).filter(Boolean), districts: f.dist.value.split('\n').map(x => x.trim()).filter(Boolean), center: lat != null ? { lat, lng } : null, radiusKm: rad }, capacity: { maxPerHour: f.mh.value ? parseInt(f.mh.value) : null, maxPerDay: f.md.value ? parseInt(f.md.value) : null, maxPerSlot: f.ms.value ? parseInt(f.ms.value) : null }, scheduling: { enabled: schOn.checked, slotMinutes: parseInt(f.slotMin.value) }, lowStockDefault: parseInt(f.low.value) || 5 };
    await api.call('marketUpdateSettings', { marketId: mid, settings }); toast('Configurações de entrega salvas', 'ok'); });
  return mpanel('entrega', h('h1', null, 'Entrega, horários e capacidade'), h('div', { class: 'alert' }, 'Só aparecem opções de entrega e agendamento que respeitam horário, feriados, capacidade e área. Sem área configurada, o mercado não é exibido como disponível para nenhum endereço.'),
    h('section', { class: 'card stack' }, h('h3', { style: { margin: 0 } }, 'Horário de funcionamento'), DAYS.map((dn, d) => h('div', { class: 'row' }, h('b', { style: { minWidth: '82px' } }, dn), hrs[d].map(x => h('div', { class: 'row', style: { gap: '4px' } }, x.o, 'às', x.c))), ), h('div', { class: 'tiny muted' }, 'Deixe em branco os dias fechados. Dois intervalos por dia (ex.: pausa para almoço).'), field('Feriados e dias fechados', closed)),
    h('section', { class: 'card stack' }, h('h3', { style: { margin: 0 } }, 'Área de entrega (qualquer critério abaixo atende)'), field('Prefixos de CEP', f.ceps, 'Mínimo de 3 dígitos por prefixo.'), field('Bairros', f.dist), h('div', { class: 'grid g3' }, field('Latitude do mercado', f.lat), field('Longitude', f.lng), field('Raio (km)', f.rad))),
    h('section', { class: 'card stack' }, h('h3', { style: { margin: 0 } }, 'Taxas, prazo e capacidade'), h('div', { class: 'grid g3' }, field('Taxa de entrega (R$)', f.fee), field('Pedido mínimo (R$)', f.min), field('Previsão (min)', f.eta)), h('div', { class: 'grid g3' }, field('Máx. pedidos/hora', f.mh), field('Máx. pedidos/dia', f.md), field('Máx. por janela agendada', f.ms)), h('label', { class: 'row' }, schOn, ' Aceitar pedidos agendados (até 3 dias úteis)'), field('Duração da janela de agendamento', f.slotMin), field('Alerta de estoque baixo padrão (unidades)', f.low)),
    h('button', { class: 'btn', onclick: (e) => save(e.currentTarget) }, 'Salvar configurações'));
});

/* ───────────────────────── Equipe ───────────────────────── */
const PERM_LABEL = { 'orders.read': 'Ver pedidos', 'orders.picking': 'Separação', 'orders.dispatch': 'Expedição', 'orders.deliver': 'Confirmar entrega', 'chat.use': 'Chat e avaliações', 'products.read': 'Ver produtos', 'products.write': 'Editar produtos e preços', 'products.import': 'Enviar importações', 'products.import.approve': 'Aprovar importações', 'promotions.write': 'Promoções e cupons', 'stock.write': 'Estoque alocado', 'settings.write': 'Configurações e entrega', 'staff.manage': 'Gerenciar equipe', 'finance.read': 'Financeiro', 'reports.export': 'Exportar relatórios' };
const PRESET_LABEL = { manager: 'Gerente', picker: 'Separador', dispatcher: 'Expedição', courier: 'Entregador', finance: 'Financeiro', products: 'Responsável por produtos' };
function permPicker(all, selected, labels) { const boxes = all.map(p => h('label', { class: 'row tiny' }, h('input', { type: 'checkbox', value: p, checked: selected.includes(p) }), labels[p] || p)); return { el: h('div', { class: 'grid g2' }, boxes), get: () => boxes.map(b => b.querySelector('input')).filter(i => i.checked).map(i => i.value), set: (arr) => boxes.forEach(b => { const i = b.querySelector('input'); i.checked = arr.includes(i.value); }) }; }
function inviteResult(res) { openModal((m) => h('div', { class: 'stack' }, h('div', { class: 'alert ok' }, 'Usuário criado. Anote a senha temporária abaixo: ela não será mostrada de novo (simulador local; não use senhas reais).'), h('textarea', { class: 'in', readonly: true, rows: 4 }, res.passwordSetupLink), h('button', { class: 'btn', onclick: () => copyText(res.passwordSetupLink) }, 'Copiar'), h('div', { class: 'tiny muted' }, 'Repasse por um canal seguro. A autenticação simples deste simulador NÃO é segurança adequada para produção.')), { title: 'Usuário pronto' }); }
routeA("market", /^\/painel\/equipe$/, async () => {
  if (!can(SESSION.user, 'staff.manage')) return mpanel('equipe', noPerm()); const { mid } = await mctx(); const box = h('div', { class: 'stack' });
  S.cleanups.push(api.watchCol(`markets/${mid}/staff`, {}, (rows) => box.replaceChildren(...rows.filter(r => r.id !== '_settings').map(r => h('div', { class: 'card flat stack' }, h('div', { class: 'row between' }, h('div', null, h('b', null, r.name || r.email), h('div', { class: 'tiny muted' }, r.email)), h('div', { class: 'row' }, r.preset && h('span', { class: 'badge b' }, PRESET_LABEL[r.preset] || r.preset), h('span', { class: 'badge ' + (r.active === false ? 'g' : '') }, r.active === false ? 'Inativo' : 'Ativo'))), h('div', { class: 'tiny muted' }, (r.perms || []).map(p => PERM_LABEL[p] || p).join(' · ')), r.id !== SESSION.user.uid && h('div', { class: 'row' }, h('button', { class: 'btn sm ghost', onclick: () => { const pp = permPicker(R.MARKET_PERMS, r.perms || [], PERM_LABEL); openModal((m) => h('div', { class: 'stack' }, pp.el, h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { await api.call('marketSetStaffAccess', { marketId: mid, uid: r.id, perms: pp.get() }); toast('Permissões atualizadas', 'ok'); m.close(); }) }, 'Salvar permissões')), { title: 'Permissões de ' + (r.name || r.email) }); } }, 'Permissões'), h('button', { class: 'btn sm ghost', onclick: async () => { if (await confirmDlg(r.active === false ? 'Reativar' : 'Desativar acesso', r.active === false ? 'Reativar esta conta?' : 'Esta pessoa não conseguirá mais entrar.', 'Confirmar')) await api.call('marketSetStaffAccess', { marketId: mid, uid: r.id, active: r.active === false }); } }, r.active === false ? 'Reativar' : 'Desativar'))))), (e) => box.replaceChildren(errorBox(e))));
  return mpanel('equipe', h('div', { class: 'row between' }, h('h1', { style: { margin: 0 } }, 'Equipe e permissões'), h('button', { class: 'btn', onclick: () => { const nm = inp({ label: 'Nome' }), em = inp({ label: 'Usuário (login)', ph: 'ex.: maria' }); const pre = sel([['', 'Personalizado'], ...Object.entries(PRESET_LABEL)], 'picker', { label: 'Função' }); const pp = permPicker(R.MARKET_PERMS, R.MARKET_ROLE_PRESETS.picker, PERM_LABEL); pre.addEventListener('change', () => { if (pre.value) pp.set(R.MARKET_ROLE_PRESETS[pre.value]); }); openModal((m) => h('div', { class: 'stack' }, field('Nome', nm), field('Usuário (login)', em), field('Função (modelo de permissões)', pre), pp.el, h('div', { class: 'tiny muted' }, 'As permissões são verificadas no servidor — esconder botões não é a proteção. Você só concede o que você mesmo possui.'), h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { const r = await api.call('marketInviteStaff', { marketId: mid, name: nm.value.trim(), email: em.value.trim(), preset: pre.value || undefined, perms: pp.get() }); m.close(); inviteResult(r); }) }, 'Criar usuário')), { title: 'Convidar funcionário', wide: true }); } }, icon('plus'), 'Novo usuário')), h('p', { class: 'muted tiny' }, 'Funções de separador e entregador já têm permissões e dados prontos; suas telas dedicadas serão criadas em uma etapa futura.'), box);
});

/* ───────────────────────── Relatórios financeiros (mercado e administração) ───────────────────────── */
const periodRange = (k) => { const n = new Date(); const sod = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime(); return k === 'day' ? [sod, Date.now()] : k === 'week' ? [sod - 6 * 86400000, Date.now()] : [new Date(n.getFullYear(), n.getMonth(), 1).getTime(), Date.now()]; };
async function exportReport(kind, data, title) {
  const rows = data.rows.map(r => ({ Pedido: r.orderId.slice(0, 6).toUpperCase(), Data: new Date(r.at).toLocaleString('pt-BR'), Mercado: r.marketName, Estado: STATUS[r.status] || r.status, 'Produtos (preço cheio)': r.gross / 100, Descontos: r.discounts / 100, 'Produtos pagos': r.itemsPaid / 100, 'Taxa de entrega': r.deliveryFee / 100, 'Comissão da plataforma': r.commission / 100, Reembolsos: r.refunds / 100, 'Líquido a receber': r.marketReceivable / 100 }));
  if (kind === 'pdf') { toast('Abrindo a impressão: escolha "Salvar como PDF".', 'ok'); window.print(); return; }
  const s = data.summary; const resumo = [['Pedidos', s.orders], ...(s.gmv != null ? [['GMV (volume bruto — não é receita)', s.gmv / 100]] : []), ['Produtos (preço cheio)', s.grossProducts / 100], ['Descontos', s.discounts / 100], ['Comissão', s.commission / 100], ['Taxas de entrega', s.deliveryFees / 100], ['Reembolsos', s.refunds / 100], ['Líquido a receber', s.marketReceivable / 100]];
  const esc = (v) => { const t = String(v ?? ''); return /[";\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const head = Object.keys(rows[0] || { Pedido: 1 });
  const csv = ['Indicador;Valor', ...resumo.map(r => r.map(esc).join(';')), '', head.join(';'), ...rows.map(r => head.map(k => esc(typeof r[k] === 'number' ? r[k].toFixed(2).replace('.', ',') : r[k])).join(';'))].join('\r\n');
  downloadBlob(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), `${title}.csv`);
}
const PAYOUT_ST = { paid: 'Pago (simulado)', pending: 'Pendente', reversed: 'Estornado' };
function financeReport({ admin, marketOptions }) {
  const root = h('div', { class: 'stack' }); const st = { per: 'month', from: '', to: '', marketId: '', cityId: '', status: '' }; const out = h('div', { class: 'stack' }); let last = null;
  const run = async () => { out.replaceChildren(h('div', { class: 'spin' })); const [f, t] = st.per === 'custom' ? [st.from ? new Date(st.from + 'T00:00:00').getTime() : 0, st.to ? new Date(st.to + 'T23:59:59').getTime() : Date.now()] : periodRange(st.per);
    try { const d = await api.call('getFinanceReport', { from: f, to: t, marketId: st.marketId || undefined, cityId: st.cityId || undefined, status: st.status || undefined }); last = d; const s = d.summary; const k = (v, l, hint) => h('div', { class: 'kpi' }, h('b', null, v), h('span', null, l), hint && h('div', { class: 'tiny muted' }, hint));
      out.replaceChildren(h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' } }, k(s.orders, 'Pedidos'), s.gmv != null && k(brl(s.gmv), 'GMV', 'Volume bruto — não é receita nem lucro'), k(brl(s.grossProducts), 'Vendas brutas (produtos)'), k(brl(s.discounts), 'Descontos'), admin && k(brl(s.subsidy), 'Subsídios da plataforma'), k(brl(s.commission), admin ? 'Comissão calculada' : 'Comissão da plataforma'), k(brl(s.deliveryFees), 'Taxas de entrega', 'Pertencem ao mercado'), k(brl(s.refunds), 'Reembolsos'), k(brl(s.marketReceivable), 'Líquido a receber'), k(brl(s.pending), 'Saldo a repassar', 'Pedidos concluídos ainda não repassados (líquido de reembolsos)'), k(brl(s.paid), 'Repasses realizados'), k(brl(s.awaitingDelivery), 'Aguardando entrega')),
        h('div', { class: 'row no-print' }, can(SESSION.user, 'reports.export') || admin ? [h('button', { class: 'btn sec', onclick: (e) => busy(e.currentTarget, () => exportReport('csv', last, 'relatorio-financeiro')) }, icon('download'), 'Planilha (.csv)'), h('button', { class: 'btn sec', onclick: (e) => busy(e.currentTarget, () => exportReport('pdf', last, 'relatorio-financeiro')) }, icon('download'), 'PDF (imprimir)')] : h('span', { class: 'tiny muted' }, 'Sem permissão para exportar.')),
        h('div', { class: 'tw card flat', style: { padding: 0 } }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Pedido', 'Data', admin ? 'Mercado' : null, 'Estado', 'Bruto', 'Descontos', 'Comissão', 'Entrega', 'Líquido', 'Repasse'].filter(Boolean).map((c, i) => h('th', { class: i > 3 ? 'num' : '' }, c)))), h('tbody', null, d.rows.length ? d.rows.map(r => h('tr', null, h('td', null, '#' + r.orderId.slice(0, 6).toUpperCase()), h('td', { class: 'tiny' }, dt(r.at)), admin && h('td', { class: 'tiny' }, r.marketName), h('td', null, statusBadge(r.status)), h('td', { class: 'num' }, brl(r.gross)), h('td', { class: 'num' }, brl(r.discounts)), h('td', { class: 'num' }, brl(r.commission)), h('td', { class: 'num' }, brl(r.deliveryFee)), h('td', { class: 'num' }, brl(r.marketReceivable)), h('td', { class: 'num' }, r.paidOut ? 'Repassado' : r.delivered ? 'Pendente' : 'Aguardando'))) : [h('tr', null, h('td', { colspan: 10 }, empty('📊', 'Sem vendas no período')))]))),
        d.payouts && d.payouts.length > 0 && h('div', { class: 'card stack' }, h('h3', { style: { margin: 0 } }, 'Repasses'), d.payouts.map(p => h('div', { class: 'row between tiny' }, h('span', null, `${dt(p.at)} · ${PAYOUT_ST[p.status] || p.status}${p.reference ? ' · ' + p.reference : ''}`), h('b', null, brl(p.amount))))));
    } catch (e) { out.replaceChildren(errorBox(e, run)); } };
  const pbtn = (k, t) => h('button', { class: 'chip' + (st.per === k ? ' on' : ''), onclick: () => { st.per = k; draw(); run(); } }, t);
  const draw = () => root.replaceChildren(h('div', { class: 'row no-print' }, pbtn('day', 'Hoje'), pbtn('week', '7 dias'), pbtn('month', 'Este mês'), pbtn('custom', 'Período'), st.per === 'custom' && [inp({ type: 'date', value: st.from, oninput: (e) => { st.from = e.target.value; }, label: 'De' }), inp({ type: 'date', value: st.to, oninput: (e) => { st.to = e.target.value; }, label: 'Até' }), h('button', { class: 'btn sm', onclick: run }, 'Aplicar')], admin && marketOptions && sel([['', 'Todos os mercados'], ...marketOptions.map(m => [m.id, m.name])], st.marketId, { label: 'Mercado', onchange: (e) => { st.marketId = e.target.value; run(); } }), admin && sel([['', 'Todas as cidades'], ...S.cities.map(c => [c.id, c.name])], st.cityId, { label: 'Cidade', onchange: (e) => { st.cityId = e.target.value; run(); } }), sel([['', 'Todos os estados'], ...Object.entries(STATUS)], st.status, { label: 'Estado do pedido', onchange: (e) => { st.status = e.target.value; run(); } })), out);
  draw(); run(); return { el: root, run, get marketId() { return st.marketId; } };
}
routeA("market", /^\/painel\/financeiro$/, async () => {
  if (!can(SESSION.user, 'finance.read')) return mpanel('financeiro', noPerm()); await mctx(); const rep = financeReport({ admin: false });
  return mpanel('financeiro', h('h1', null, 'Financeiro'), h('div', { class: 'alert' }, 'Vendas, comissão, valores recebidos e pendentes de repasse são mostrados separadamente. A comissão incide sobre o valor efetivamente pago pelos produtos (após descontos), sem a taxa de entrega.'), rep.el);
});

/* ───────────────────────── Avaliações e configurações ───────────────────────── */
routeA("market", /^\/painel\/avaliacoes$/, async () => {
  if (!can(SESSION.user, 'chat.use')) return mpanel('avaliacoes', noPerm()); const { mid } = await mctx(); const box = h('div', { class: 'stack' });
  S.cleanups.push(api.watchCol('reviews', { where: [['marketId', '==', mid], ['hidden', '==', false]], orderBy: [['createdAt', 'desc']], limit: 50 }, (rows) => box.replaceChildren(...(rows.length ? rows.map(r => { const t = h('input', { class: 'in', placeholder: 'Responder publicamente', maxlength: 800, 'aria-label': 'Resposta' }); return h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('b', null, r.customerName || 'Cliente'), stars(r.rating)), r.comment && h('p', { style: { margin: 0 } }, r.comment), r.edited && h('small', null, '(editada pelo cliente)'), r.officialNote && h('div', { class: 'alert' }, h('div', null, h('b', null, 'Nota oficial da plataforma: '), r.officialNote.text)), r.reply ? h('div', { class: 'alert ok' }, h('div', null, h('b', null, 'Sua resposta: '), r.reply.text)) : h('div', { class: 'row' }, h('div', { class: 'grow' }, t), h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { if (!t.value.trim()) throw new Error('Escreva a resposta.'); await api.call('marketReplyReview', { reviewId: r.id, text: t.value.trim() }); toast('Resposta publicada', 'ok'); }) }, 'Responder'))); }) : [empty('⭐', 'Sem avaliações ainda')])), (e) => box.replaceChildren(errorBox(e))));
  return mpanel('avaliacoes', h('h1', null, 'Avaliações'), h('p', { class: 'muted tiny' }, 'Você pode responder publicamente, mas não excluir avaliações legítimas. Casos de spam, abuso ou exposição de dados pessoais podem ser reportados ao suporte da plataforma.'), box);
});
routeA("market", /^\/painel\/config$/, async () => {
  if (!can(SESSION.user, 'settings.write')) return mpanel('config', noPerm()); const { mid, m } = await mctx(); const f = { name: inp({ value: m.name || '', max_len: 120 }), addr: inp({ value: m.addressText || '', max_len: 200 }) }; const desc = h('textarea', { class: 'in', maxlength: 500 }); desc.value = m.description || ''; const logo = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' }); const cover = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  const wa = inp({ value: '', ph: '(11) 90000-0000', mode: 'tel' }); const wtypes = [['new_order', 'Novo pedido'], ['late', 'Atrasos'], ['low_stock', 'Estoque baixo'], ['message', 'Mensagens de clientes'], ['refund', 'Reembolsos']].map(([k, t]) => h('label', { class: 'row tiny' }, h('input', { type: 'checkbox', value: k, checked: true }), t)); const cn = inp({ ph: 'Nome da categoria sugerida' });
  return mpanel('config', h('h1', null, 'Configurações do mercado'), h('form', { class: 'card stack', onsubmit: async (e) => { e.preventDefault(); await busy(e.submitter, async () => { const profile = { name: f.name.value.trim(), description: desc.value.trim(), address: f.addr.value.trim() }; if (logo.files[0]) profile.logoUrl = await api.upload(`markets/${mid}/brand/logo-${Date.now()}`, logo.files[0]); if (cover.files[0]) profile.coverUrl = await api.upload(`markets/${mid}/brand/cover-${Date.now()}`, cover.files[0]); await api.call('marketUpdateSettings', { marketId: mid, settings: {}, profile }); toast('Perfil atualizado', 'ok'); }); } }, h('h3', { style: { margin: 0 } }, 'Identificação'), field('Nome do mercado', f.name), field('Descrição curta', desc), field('Endereço da loja', f.addr), h('div', { class: 'grid g2' }, field('Logo', logo), field('Capa', cover)), h('button', { class: 'btn', type: 'submit' }, 'Salvar')),
    h('section', { class: 'card stack' }, h('h3', { style: { margin: 0 } }, 'Avisos por WhatsApp (opcional)'), h('div', { class: 'alert warn' }, 'O envio por WhatsApp depende da contratação e configuração da WhatsApp Business Platform pela plataforma. Você já pode cadastrar o número e as preferências; nenhum aviso é enviado até a integração ser ativada.'), field('Número', wa), h('div', { class: 'row' }, wtypes), h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { await api.call('marketUpdateSettings', { marketId: mid, settings: {}, notify: { whatsappNumber: wa.value.trim(), whatsappTypes: wtypes.map(l => l.querySelector('input')).filter(i => i.checked).map(i => i.value) } }); toast('Preferências salvas', 'ok'); }) }, 'Salvar preferências')),
    h('section', { class: 'card stack' }, h('h3', { style: { margin: 0 } }, 'Sugerir nova categoria'), h('div', { class: 'muted tiny' }, 'A estrutura de categorias é da plataforma. Envie sugestões para análise.'), h('div', { class: 'row' }, h('div', { class: 'grow' }, cn), h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { if (!cn.value.trim()) throw new Error('Informe o nome.'); await api.add('categoryRequests', { name: cn.value.trim().slice(0, 80), requestedBy: SESSION.user.uid, marketId: mid, status: 'pending', createdAt: api.stamp() }); cn.value = ''; toast('Sugestão enviada', 'ok'); }) }, 'Enviar'))),
    h('section', { class: 'card stack' }, h('h3', { style: { margin: 0 } }, 'Segurança da conta'), h('p', { class: 'muted' }, 'Recomendamos ativar a verificação em duas etapas (MFA) para contas com acesso a financeiro ou equipe. Veja o README, seção “Segurança”.')));
});
