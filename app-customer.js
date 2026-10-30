
/* ───────────────────────── CLIENTE: componentes ───────────────────────── */
const ensureBase = async () => { if (!S.cats.length) await loadBase(); };
function promoTag(l) {
  const p = l.promo; if (!p) return null; if (p.end && new Date(p.end).getTime() < Date.now()) return null; if (p.start && new Date(p.start).getTime() > Date.now()) return null;
  return p.type === 'price' ? 'Oferta' : p.type === 'percent' ? `${p.percent}% off` : p.type === 'buyxpayy' ? `Leve ${p.buy}, pague ${p.pay}` : p.type === 'tiers' ? 'Desconto progressivo' : 'Oferta';
}
function productImage(l) { return l.imageUrl ? h('img', { src: l.imageUrl, alt: '', loading: 'lazy', onerror: (e) => e.currentTarget.replaceWith(document.createTextNode(productEmoji(l))) }) : productEmoji(l); }
function productCard(l, mid, o = {}) {
  const avail = R.availableQty(l); const sold = avail <= 0; const pl = R.priceLine(l, 1, Date.now()); const tag = promoTag(l);
  const ctl = h('div', null);
  const draw = () => {
    const q = CartStore.qty(mid, l.id);
    ctl.replaceChildren(sold ? h('button', { class: 'btn block ghost', disabled: true }, 'Esgotado') : q ? h('div', { class: 'step' }, h('button', { 'aria-label': 'Diminuir', onclick: () => { CartStore.setQty(mid, l, q - 1); draw(); o.onChange && o.onChange(); } }, '−'), h('b', null, q), h('button', { 'aria-label': 'Aumentar', onclick: () => { if (q + 1 > avail) return toast(`Só há ${avail} disponível(is).`, 'err'); CartStore.setQty(mid, l, q + 1); draw(); o.onChange && o.onChange(); } }, '+'))
      : h('button', { class: 'btn block sec', onclick: () => { CartStore.setQty(mid, l, 1); draw(); o.onChange && o.onChange(); } }, icon('plus'), 'Adicionar'));
  };
  draw();
  return h('article', { class: 'prod' + (sold ? ' soldout' : '') },
    sold ? h('span', { class: 'badge r tag' }, 'Esgotado') : tag ? h('span', { class: 'badge o tag' }, tag) : l.stockStatus === 'low' ? h('span', { class: 'badge b tag' }, 'Últimas unidades') : null,
    h('button', { class: 'ph', style: { border: 0, cursor: 'pointer' }, 'aria-label': 'Detalhes de ' + l.name, onclick: () => openProduct(l, mid) }, productImage(l)),
    h('div', { class: 'nm' }, l.name), h('div', { class: 'tiny muted' }, [l.brand, l.unitLabel].filter(Boolean).join(' · ') || ' '),
    o.marketName && h('div', { class: 'tiny' }, '🏪 ', o.marketName),
    h('div', { class: 'price' }, brl(pl.net), pl.promoDiscount > 0 && h('s', null, brl(pl.gross))),
    ctl, h('button', { class: 'btn sm ghost', style: { marginTop: '2px' }, onclick: () => openAddToList(l), 'aria-label': 'Adicionar à lista' }, icon('list'), 'Lista'));
}
function openProduct(l, mid) {
  openModal((m) => { const pl = R.priceLine(l, 1, Date.now()); const tag = promoTag(l); const avail = R.availableQty(l);
    return h('div', { class: 'stack' }, h('div', { class: 'prod', style: { border: 0, padding: 0 } }, h('div', { class: 'ph', style: { maxHeight: '220px' } }, productImage(l))),
      h('h3', null, l.name), h('div', { class: 'muted' }, [l.brand, l.unitLabel].filter(Boolean).join(' · ')),
      h('div', { class: 'price', style: { fontSize: '1.4rem' } }, brl(pl.net), pl.promoDiscount > 0 && h('s', null, brl(pl.gross))), tag && h('span', { class: 'badge o' }, tag),
      l.barcode && h('div', { class: 'tiny muted' }, 'Código de barras: ', l.barcode), l.description && h('p', null, l.description),
      avail > 0 ? h('div', { class: 'tiny muted' }, avail <= 10 ? `Restam ${avail} unidades.` : 'Disponível') : h('div', { class: 'badge r' }, 'Esgotado'),
      h('div', { class: 'row' }, avail > 0 && h('button', { class: 'btn', onclick: () => { CartStore.setQty(mid, l, CartStore.qty(mid, l.id) + 1); toast('Adicionado ao carrinho', 'ok'); m.close(); navigate(); } }, 'Adicionar ao carrinho'), h('button', { class: 'btn ghost', onclick: () => { m.close(); openAddToList(l); } }, 'Adicionar à lista')));
  }, { title: 'Produto' });
}
function cartBar(mid) {
  const bar = h('a', { class: 'cartbar', href: href('/carrinho/' + encodeURIComponent(mid)), hidden: true }, icon('cart'), h('b', { 'data-n': true }), h('span', { class: 'right' }, 'Ver carrinho ›'));
  const upd = () => { const n = CartStore.get(mid).reduce((s, i) => s + i.qty, 0); bar.hidden = !n; bar.querySelector('[data-n]').textContent = `${n} ${n === 1 ? 'item' : 'itens'}`; };
  upd(); bar.update = upd; return bar;
}
function marketChips(m) {
  const s = m.settings || {}; const d = distanceKm(m);
  return h('div', { class: 'row', style: { gap: '6px' } }, m.ratingCount ? h('span', { class: 'badge o' }, '★ ' + m.ratingAvg.toFixed(1) + ` (${m.ratingCount})`) : h('span', { class: 'badge g' }, 'Novo'), h('span', { class: 'badge' }, `⏱ ${s.etaMinutes || 60} min`), h('span', { class: 'badge' }, s.deliveryFee ? `Entrega ${brl(s.deliveryFee)}` : 'Entrega grátis'), s.freeShippingAbove && h('span', { class: 'badge b' }, `Grátis acima de ${brl(s.freeShippingAbove)}`), d != null && h('span', { class: 'badge g' }, d.toFixed(1).replace('.', ',') + ' km'));
}
function marketTile(m, covers) {
  const off = !marketAvail(m);
  return h('a', { class: 'card market' + (off ? ' off' : ''), href: href('/m/' + encodeURIComponent(m.id)) },
    h('div', { class: 'logo-badge' }, m.logoUrl ? h('img', { src: m.logoUrl, alt: '' }) : '🏪'),
    h('div', { class: 'grow' }, h('b', null, m.name), marketChips(m), off ? h('div', { style: { marginTop: '4px' } }, h('span', { class: 'badge r' }, 'Indisponível temporariamente — não aceita novos pedidos')) : covers === null ? h('div', { class: 'tiny muted', style: { marginTop: '4px' } }, 'Informe seu endereço para confirmar a entrega') : !marketOpenNow(m) ? h('div', { class: 'tiny', style: { marginTop: '4px' } }, '🕒 Fechado agora — agende sua entrega') : null,
      m._promos > 0 && h('div', { class: 'tiny', style: { marginTop: '4px' } }, `🏷 ${m._promos} ofertas`)), icon('chev'));
}

/* ───────────────────────── CLIENTE: início ───────────────────────── */
route(/^\/$/, async () => {
  await ensureBase(); const all = await loadMarkets();
  const withCover = all.map(m => ({ ...m, _covers: S.addr ? R.coversAddress(m.settings?.deliveryArea, S.addr) : null }));
  const shown = S.addr ? withCover.filter(m => m._covers) : withCover; const hidden = withCover.length - shown.length;
  await Promise.all(shown.slice(0, 6).map(async m => { try { const ls = await loadListings(m.id); m._promos = ls.filter(l => promoTag(l)).length; } catch { /* sem ofertas */ } }));
  let sort = 'rel'; const listBox = h('div', { class: 'stack' });
  const draw = () => {
    const arr = shown.slice(); const key = { rel: (a, b) => (marketAvail(b) - marketAvail(a)) || ((b._promos || 0) - (a._promos || 0)) || (b.ratingAvg - a.ratingAvg), prox: (a, b) => (distanceKm(a) ?? 1e9) - (distanceKm(b) ?? 1e9), rate: (a, b) => b.ratingAvg - a.ratingAvg, eta: (a, b) => (a.settings.etaMinutes || 60) - (b.settings.etaMinutes || 60) }[sort]; arr.sort(key);
    listBox.replaceChildren(arr.length ? arr.map(m => marketTile(m, m._covers)) : empty('📍', S.addr ? 'Nenhum mercado entrega neste endereço ainda' : 'Nenhum mercado disponível', S.addr ? 'Tente outro endereço — estamos chegando a novas regiões.' : 'Volte em breve.', S.addr && h('button', { class: 'btn', onclick: () => openAddressPicker() }, 'Trocar endereço')));
  }; draw();
  const promos = []; const feats = [];
  for (const m of shown.filter(marketAvail).slice(0, 3)) { const ls = cache.listings[m.id] || []; ls.filter(l => promoTag(l) && R.availableQty(l) > 0).slice(0, 6).forEach(l => promos.push({ l, m })); ls.filter(l => l.featured && R.availableQty(l) > 0).slice(0, 6).forEach(l => feats.push({ l, m })); }
  const topCats = S.cats.filter(c => !c.parentId);
  const prodRow = (arr) => h('div', { class: 'hscroll' }, arr.slice(0, 12).map(({ l, m }) => h('div', { style: { minWidth: '168px', maxWidth: '168px' } }, productCard(l, m.id, { marketName: m.name, onChange: updateBadges }))));
  return h('div', { class: 'stack' },
    h('section', { class: 'hero' }, h('div', { class: 'art' }, '🛒'), h('h1', null, 'Seu supermercado, onde você estiver'), h('p', null, 'Compare mercados, monte listas e receba em casa.'),
      h('div', { class: 'row', style: { marginTop: '14px' } }, h('button', { class: 'btn warn', onclick: () => openAddressPicker() }, icon('pin'), S.addr ? 'Entregar em ' + (S.addr.street || 'CEP ' + S.addr.cep) : 'Informar meu endereço'))),
    h('div', { class: 'grid g3' }, [['/listas', 'list', 'Minhas listas'], ['/pedidos', 'bag', 'Meus pedidos'], ['/suporte', 'help', 'Suporte']].map(([p, ic, t]) => h('a', { class: 'card flat row', style: { textDecoration: 'none', color: 'inherit', justifyContent: 'center', padding: '12px 8px', fontWeight: 600, fontSize: '.9rem' }, href: href(p) }, icon(ic), t))),
    !S.addr && h('div', { class: 'alert warn' }, h('div', null, h('b', null, 'Informe seu endereço '), 'para vermos quais mercados entregam aí. Você pode navegar sem criar conta.')),
    h('section', { class: 'stack' }, h('div', { class: 'row between' }, h('h2', { style: { margin: 0 } }, S.addr ? 'Mercados que entregam para você' : 'Mercados'), sel([['rel', 'Relevância'], ['prox', 'Proximidade'], ['rate', 'Avaliação'], ['eta', 'Prazo de entrega']], sort, { label: 'Ordenar', onchange: (e) => { sort = e.target.value; draw(); } })), listBox, hidden > 0 && h('p', { class: 'tiny muted' }, `${hidden} ${hidden === 1 ? 'mercado não entrega' : 'mercados não entregam'} neste endereço e ${hidden === 1 ? 'não é exibido' : 'não são exibidos'}.`)),
    promos.length > 0 && h('section', null, h('h2', null, '🏷 Ofertas e promoções'), prodRow(promos)),
    topCats.length > 0 && h('section', null, h('h2', null, 'Corredores'), h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fill,minmax(112px,1fr))' } }, topCats.map(c => h('a', { class: 'aisle', href: href('/busca?cat=' + encodeURIComponent(c.id)) }, h('span', { class: 'em' }, emojiFor(c)), c.name)))),
    feats.length > 0 && h('section', null, h('h2', null, '⭐ Em destaque'), prodRow(feats)),
    h('section', { class: 'card flat row between' }, h('div', null, h('b', null, 'Tem um supermercado?'), h('div', { class: 'muted tiny' }, 'Venda no Meu Mercado e alcance novos clientes.')), h('a', { class: 'btn sec', href: href('/seja-parceiro') }, 'Quero vender')),
    installHint());
});

/* ───────────────────────── CLIENTE: busca entre mercados ───────────────────────── */
const catAndChildren = (id) => new Set([id, ...S.cats.filter(c => c.parentId === id).map(c => c.id)]);
route(/^\/busca$/, async (ctx) => {
  await ensureBase(); const q = R.normText(ctx.q.q || ''); const cat = ctx.q.cat || null; const all = await loadMarkets();
  const ms = (S.addr ? all.filter(m => R.coversAddress(m.settings?.deliveryArea, S.addr)) : all).filter(marketAvail).slice(0, 8);
  const nameHits = q ? all.filter(m => R.normText(m.name).includes(q)) : [];
  const groups = await Promise.all(ms.map(async m => { const ls = await loadListings(m.id); const set = cat ? catAndChildren(cat) : null; return { m, items: ls.filter(l => (!set || set.has(l.categoryId)) && (!q || R.normText([l.name, l.brand, l.barcode, ...(l.keywords || [])].join(' ')).includes(q))) }; }));
  const total = groups.reduce((s, g) => s + g.items.length, 0); const c = cat && S.cats.find(x => x.id === cat);
  return h('div', { class: 'stack' }, h('h1', null, c ? `${emojiFor(c)} ${c.name}` : q ? `Resultados para “${ctx.q.q}”` : 'Buscar'),
    !S.addr && h('div', { class: 'alert warn' }, 'Sem endereço selecionado, mostramos todos os mercados. ', h('button', { class: 'btn sm', onclick: () => openAddressPicker() }, 'Informar endereço')),
    nameHits.length > 0 && h('section', { class: 'stack' }, h('h3', null, 'Mercados'), nameHits.map(m => marketTile({ ...m }, S.addr ? R.coversAddress(m.settings?.deliveryArea, S.addr) : null))),
    total === 0 ? empty('🔎', 'Nada encontrado', 'Tente outro termo, marca ou categoria.') : groups.filter(g => g.items.length).map(g => h('section', { class: 'stack' }, h('div', { class: 'row between' }, h('h3', { style: { margin: 0 } }, '🏪 ' + g.m.name), h('a', { href: href('/m/' + encodeURIComponent(g.m.id) + (c ? '/c/' + cat : '')) }, 'Ver mercado')), h('div', { class: 'products' }, g.items.slice(0, 12).map(l => productCard(l, g.m.id, { onChange: updateBadges }))))));
});

/* ───────────────────────── CLIENTE: página do mercado ───────────────────────── */
async function getMarket(id) {
  const list = await loadMarkets(); let m = list.find(x => x.id === id);
  if (!m) { const d = await api.doc('markets/' + id); if (!d || d.status !== 'active') return null; m = { ...d, settings: (await api.doc(`markets/${id}/public/settings`)) || {} }; }
  return m;
}
function marketBanner(m) {
  const out = []; if (!marketAvail(m)) out.push(h('div', { class: 'alert err' }, h('div', null, h('b', null, 'Indisponível temporariamente. '), 'Este mercado pausou novos pedidos. Você pode ver o catálogo, mas não comprar agora.')));
  else if (S.addr && !R.coversAddress(m.settings?.deliveryArea, S.addr)) out.push(h('div', { class: 'alert err' }, h('div', null, h('b', null, 'Não entrega no seu endereço. '), h('button', { class: 'btn sm', onclick: () => openAddressPicker() }, 'Trocar endereço'))));
  else if (!S.addr) out.push(h('div', { class: 'alert warn' }, h('div', null, 'Informe seu endereço para confirmar se este mercado entrega aí. ', h('button', { class: 'btn sm', onclick: () => openAddressPicker() }, 'Informar'))));
  else if (!marketOpenNow(m)) out.push(h('div', { class: 'alert' }, '🕒 Fechado agora. Você pode montar o carrinho e agendar a entrega.'));
  return out;
}
function marketHeader(m) {
  return h('div', { class: 'stack' }, h('div', { class: 'card row' }, h('div', { class: 'logo-badge' }, m.logoUrl ? h('img', { src: m.logoUrl, alt: '' }) : '🏪'), h('div', { class: 'grow' }, h('h1', { style: { margin: 0, fontSize: '1.3rem' } }, m.name), m.description && h('div', { class: 'muted tiny' }, m.description), marketChips(m), m.addressText && h('div', { class: 'tiny muted' }, '📍 ' + m.addressText))), ...marketBanner(m));
}
function marketSearchBar(mid, val = '') {
  const i = inp({ ph: 'Buscar neste mercado', value: val, label: 'Buscar neste mercado' });
  return h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); go(`/m/${encodeURIComponent(mid)}/busca?q=${encodeURIComponent(i.value.trim())}`); } }, h('div', { class: 'grow' }, i), h('button', { class: 'btn', type: 'submit' }, icon('search'), 'Buscar'));
}
route(/^\/m\/([^/]+)$/, async (ctx) => {
  await ensureBase(); const mid = ctx.params[0]; const m = await getMarket(mid); if (!m) return empty('🏪', 'Mercado indisponível', 'Este mercado não está ativo.', h('a', { class: 'btn', href: href('/') }, 'Ver outros mercados'));
  const [ls, reviews] = await Promise.all([loadListings(mid), api.col('reviews', { where: [['marketId', '==', mid], ['hidden', '==', false]], orderBy: [['createdAt', 'desc']], limit: 10 }).catch(() => [])]);
  const have = new Set(ls.map(l => l.categoryId)); const aisles = S.cats.filter(c => !c.parentId && (have.has(c.id) || S.cats.some(s => s.parentId === c.id && have.has(s.id))));
  const promos = ls.filter(l => promoTag(l)); const feats = ls.filter(l => l.featured); const bar = cartBar(mid);
  let again = null; const u = SESSION.user;
  if (u && u.role === 'customer') { try { const os = (await api.col('orders', { where: [['customerId', '==', u.uid]], orderBy: [['createdAt', 'desc']], limit: 10 })).filter(o => o.marketId === mid && o.status === 'delivered'); if (os[0]) { const byId = mapById(ls); const items = os[0].items.map(i => byId[i.listingId]).filter(Boolean).slice(0, 10); if (items.length) again = h('section', null, h('h2', null, '🔁 Comprar novamente'), h('div', { class: 'hscroll' }, items.map(l => h('div', { style: { minWidth: '168px', maxWidth: '168px' } }, productCard(l, mid, { onChange: bar.update }))))); } } catch { /* sem histórico */ } }
  const row = (arr) => h('div', { class: 'hscroll' }, arr.slice(0, 14).map(l => h('div', { style: { minWidth: '168px', maxWidth: '168px' } }, productCard(l, mid, { onChange: bar.update }))));
  return h('div', { class: 'stack' }, marketHeader(m), marketSearchBar(mid),
    h('section', null, h('h2', null, 'Corredores'), aisles.length ? h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fill,minmax(112px,1fr))' } }, aisles.map(c => h('a', { class: 'aisle', href: href(`/m/${encodeURIComponent(mid)}/c/${encodeURIComponent(c.id)}`) }, h('span', { class: 'em' }, emojiFor(c)), c.name))) : empty('🛒', 'Catálogo em preparação', 'Este mercado ainda não publicou produtos.')),
    promos.length > 0 && h('section', null, h('div', { class: 'row between' }, h('h2', null, '🏷 Promoções'), h('a', { href: href(`/m/${encodeURIComponent(mid)}/busca?promo=1`) }, 'Ver todas')), row(promos)), again, feats.length > 0 && h('section', null, h('h2', null, '⭐ Em destaque'), row(feats)),
    h('section', { class: 'stack' }, h('h2', null, 'Avaliações'), reviews.length ? reviews.map(r => h('div', { class: 'card flat' }, h('div', { class: 'row between' }, h('b', null, r.customerName || 'Cliente'), stars(r.rating)), r.comment && h('p', { style: { margin: '6px 0 0' } }, r.comment), r.edited && h('small', null, '(editada)'), r.reply && h('div', { class: 'alert ok', style: { marginTop: '8px' } }, h('div', null, h('b', null, 'Resposta do mercado: '), r.reply.text)), r.officialNote && h('div', { class: 'alert', style: { marginTop: '8px' } }, h('div', null, h('b', null, 'Nota oficial da plataforma: '), r.officialNote.text)))) : h('p', { class: 'muted' }, 'Ainda sem avaliações.')), bar);
});
async function catalogView(ctx, { catId, q }) {
  await ensureBase(); const mid = ctx.params[0]; const m = await getMarket(mid); if (!m) return empty('🏪', 'Mercado indisponível');
  const all = await loadListings(mid); const bar = cartBar(mid); const cat = catId ? S.cats.find(c => c.id === catId) : null; const subs = cat ? S.cats.filter(c => c.parentId === cat.id) : [];
  const st = { sub: null, brand: '', min: '', max: '', promo: ctx.q.promo === '1', stock: false, sort: 'name' }; const grid = h('div', { class: 'products' }); const count = h('span', { class: 'muted' }); const chips = h('div', { class: 'hscroll' });
  const base = all.filter(l => (!cat || catAndChildren(cat.id).has(l.categoryId)) && (!q || R.normText([l.name, l.brand, l.barcode, l.unitLabel, ...(l.keywords || [])].join(' ')).includes(R.normText(q))));
  const brands = [...new Set(base.map(l => l.brand).filter(Boolean))].sort();
  const brandSel = sel([['', 'Todas as marcas'], ...brands.map(b => [b, b])], '', { label: 'Marca', onchange: (e) => { st.brand = e.target.value; draw(); } });
  const draw = () => {
    let arr = base.filter(l => (!st.sub || l.categoryId === st.sub) && (!st.brand || l.brand === st.brand) && (!st.promo || promoTag(l)) && (!st.stock || R.availableQty(l) > 0));
    const mn = st.min ? parseMoney(st.min) : null, mx = st.max ? parseMoney(st.max) : null; if (Number.isFinite(mn)) arr = arr.filter(l => R.priceLine(l, 1, Date.now()).net >= mn); if (Number.isFinite(mx)) arr = arr.filter(l => R.priceLine(l, 1, Date.now()).net <= mx);
    const pr = (l) => R.priceLine(l, 1, Date.now()).net; arr.sort(st.sort === 'asc' ? (a, b) => pr(a) - pr(b) : st.sort === 'desc' ? (a, b) => pr(b) - pr(a) : (a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    count.textContent = `${arr.length} ${arr.length === 1 ? 'produto' : 'produtos'}`; grid.replaceChildren(...(arr.length ? arr.map(l => productCard(l, mid, { onChange: bar.update })) : [h('div', { style: { gridColumn: '1/-1' } }, empty('🔎', 'Nenhum produto com esses filtros', 'Remova algum filtro ou tente outra busca.'))]));
    chips.replaceChildren(...subs.map(s => h('button', { class: 'chip' + (st.sub === s.id ? ' on' : ''), onclick: () => { st.sub = st.sub === s.id ? null : s.id; draw(); } }, s.name)));
  };
  const minI = inp({ ph: 'Mín. R$', mode: 'decimal', oninput: (e) => { st.min = e.target.value; draw(); } }), maxI = inp({ ph: 'Máx. R$', mode: 'decimal', oninput: (e) => { st.max = e.target.value; draw(); } }); draw();
  return h('div', { class: 'stack' }, h('a', { href: href('/m/' + encodeURIComponent(mid)) }, '‹ ' + m.name), h('h1', null, cat ? `${emojiFor(cat)} ${cat.name}` : q ? `Busca: “${q}”` : st.promo ? '🏷 Promoções' : 'Todos os produtos'), marketSearchBar(mid, q || ''), ...marketBanner(m), subs.length > 0 && chips,
    h('div', { class: 'card flat stack' }, h('div', { class: 'grid g2' }, brandSel, sel([['name', 'Nome (A–Z)'], ['asc', 'Menor preço'], ['desc', 'Maior preço']], 'name', { label: 'Ordenar', onchange: (e) => { st.sort = e.target.value; draw(); } })), h('div', { class: 'grid g2' }, minI, maxI),
      h('div', { class: 'row' }, h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: st.promo, onchange: (e) => { st.promo = e.target.checked; draw(); } }), ' Só promoções'), h('label', { class: 'chip' }, h('input', { type: 'checkbox', onchange: (e) => { st.stock = e.target.checked; draw(); } }), ' Só disponíveis'), count)), grid, bar);
}
route(/^\/m\/([^/]+)\/c\/([^/]+)$/, (ctx) => catalogView(ctx, { catId: ctx.params[1] }));
route(/^\/m\/([^/]+)\/busca$/, (ctx) => catalogView(ctx, { q: ctx.q.q || '' }));

/* ───────────────────────── CLIENTE: listas de compras ───────────────────────── */
function needCustomer(msg, path) {
  const u = SESSION.user; if (u && u.role === 'customer') return null;
  if (u) return empty('👤', 'Área do cliente', 'Você entrou com uma conta de equipe. Use uma conta de cliente para comprar.', h('button', { class: 'btn ghost', onclick: () => api.signOut() }, 'Sair'));
  return empty('🔐', msg, 'Entre ou crie sua conta gratuita.', h('a', { class: 'btn', href: href('/entrar?next=' + encodeURIComponent(path || parseHash().path)) }, 'Entrar ou criar conta'));
}
const listItemOf = (l) => ({ globalProductId: l.globalProductId || null, barcode: l.barcode || null, name: l.name, brand: l.brand || null, unitLabel: l.unitLabel || null, emoji: l.emoji || null, qty: 1 });
async function openAddToList(l) {
  const gate = needCustomer('Entre para usar listas'); if (gate) return openModal(() => gate, { title: 'Listas de compras' });
  const u = SESSION.user; const lists = await api.col(`users/${u.uid}/lists`).catch(() => []);
  openModal((m) => { const nm = inp({ ph: 'Nova lista (ex.: Churrasco)' });
    const add = async (list) => { const items = [...(list.items || [])]; const k = items.findIndex(i => (l.globalProductId && i.globalProductId === l.globalProductId) || (l.barcode && i.barcode === l.barcode) || i.name === l.name); if (k >= 0) items[k] = { ...items[k], qty: items[k].qty + 1 }; else items.push(listItemOf(l)); await api.set(`users/${u.uid}/lists/${list.id}`, { name: list.name, items, createdAt: list.createdAt || api.stamp(), updatedAt: api.stamp() }); toast(`Adicionado a “${list.name}”`, 'ok'); m.close(); };
    return h('div', { class: 'stack' }, h('p', null, h('b', null, l.name)), lists.map(x => h('button', { class: 'btn ghost block', onclick: (e) => busy(e.currentTarget, () => add(x)) }, x.name, h('span', { class: 'muted' }, ` (${(x.items || []).length})`))), h('div', { class: 'row' }, h('div', { class: 'grow' }, nm), h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { if (!nm.value.trim()) throw new Error('Dê um nome à lista.'); const id = await api.add(`users/${u.uid}/lists`, { name: nm.value.trim().slice(0, 80), items: [], createdAt: api.stamp(), updatedAt: api.stamp() }); await add({ id, name: nm.value.trim().slice(0, 80), items: [] }); }) }, 'Criar e adicionar')));
  }, { title: 'Adicionar à lista' });
}
route(/^\/listas$/, async () => {
  const gate = needCustomer('Suas listas ficam salvas na conta'); if (gate) return gate; const u = SESSION.user; const box = h('div', { class: 'stack' }); const nm = inp({ ph: 'Nome da nova lista' });
  const un = api.watchCol(`users/${u.uid}/lists`, { orderBy: [['updatedAt', 'desc']] }, (rows) => box.replaceChildren(rows.length ? rows.map(x => h('a', { class: 'card row between', style: { textDecoration: 'none', color: 'inherit' }, href: href('/lista/' + x.id) }, h('div', null, h('b', null, x.name), h('div', { class: 'muted tiny' }, `${(x.items || []).length} itens · atualizada ${dday(x.updatedAt)}`)), icon('chev'))) : empty('📝', 'Nenhuma lista ainda', 'Crie listas como “Semanal”, “Limpeza” ou “Churrasco” e reutilize em qualquer mercado.')), (e) => box.replaceChildren(errorBox(e)));
  S.cleanups.push(un);
  return h('div', { class: 'stack' }, h('h1', null, 'Listas de compras'), h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); if (!nm.value.trim()) return; await busy(e.submitter, async () => { const id = await api.add(`users/${u.uid}/lists`, { name: nm.value.trim().slice(0, 80), items: [], createdAt: api.stamp(), updatedAt: api.stamp() }); go('/lista/' + id); }); } }, h('div', { class: 'grow' }, nm), h('button', { class: 'btn', type: 'submit' }, icon('plus'), 'Criar lista')), box);
});
/** Casa itens de lista/pedido com anúncios de um mercado — nunca substitui automaticamente. */
function matchItems(items, listings) {
  const byGp = {}, byBc = {}, byId = mapById(listings); listings.forEach(l => { if (l.globalProductId) byGp[l.globalProductId] = l; if (l.barcode) byBc[l.barcode] = l; });
  return items.map(it => { const l = (it.listingId && byId[it.listingId]) || (it.globalProductId && byGp[it.globalProductId]) || (it.barcode && byBc[it.barcode]) || null; return { item: it, listing: l, state: !l ? 'missing' : R.availableQty(l) <= 0 ? 'soldout' : 'ok' }; });
}
async function openUseItems(title, items) {
  await ensureBase(); const ms = (await loadMarkets()).filter(marketAvail).filter(m => !S.addr || R.coversAddress(m.settings?.deliveryArea, S.addr));
  if (!ms.length) return toast('Nenhum mercado disponível para o seu endereço.', 'err');
  openModal((m) => { const out = h('div', { class: 'stack' }); let cur = null; const picks = new Map();
    const show = async (mk) => { cur = mk; out.replaceChildren(h('div', { class: 'spin' })); const ls = await loadListings(mk.id); const mt = matchItems(items, ls); picks.clear();
      out.replaceChildren(h('p', { class: 'muted tiny' }, 'Conferimos preço e disponibilidade agora. Itens que não existem neste mercado não são trocados por outros.'),
        h('div', { class: 'stack' }, mt.map(({ item, listing, state }) => { const qty = inp({ type: 'number', value: item.qty, min: 1, max: 99, label: 'Quantidade' }); qty.style.width = '80px'; const ck = h('input', { type: 'checkbox', checked: state === 'ok', disabled: state !== 'ok', 'aria-label': 'Incluir ' + item.name, onchange: () => {} }); if (state === 'ok') picks.set(item, { ck, qty, listing });
          return h('div', { class: 'card flat row' }, ck, h('div', { class: 'grow' }, h('b', null, item.name), h('div', { class: 'tiny muted' }, [item.brand, item.unitLabel].filter(Boolean).join(' · ')), state === 'ok' ? h('div', null, brl(R.priceLine(listing, 1, Date.now()).net), listing.promo && promoTag(listing) ? h('span', { class: 'badge o', style: { marginLeft: '6px' } }, promoTag(listing)) : null) : h('span', { class: 'badge r' }, state === 'soldout' ? 'Esgotado' : 'Não encontrado neste mercado')), state === 'ok' && qty); })),
        h('button', { class: 'btn block', onclick: () => { let n = 0; picks.forEach(({ ck, qty, listing }) => { if (ck.checked) { CartStore.setQty(cur.id, listing, Math.max(1, Math.min(99, parseInt(qty.value) || 1))); n++; } }); if (!n) return toast('Selecione ao menos um item.', 'err'); m.close(); toast(`${n} ${n === 1 ? 'item adicionado' : 'itens adicionados'}. Revise o carrinho antes de pagar.`, 'ok'); go('/carrinho/' + encodeURIComponent(cur.id)); } }, 'Adicionar ao carrinho e revisar'));
    };
    const ms2 = sel(ms.map(x => [x.id, x.name]), ms[0].id, { label: 'Mercado', onchange: (e) => show(ms.find(x => x.id === e.target.value)) }); show(ms[0]);
    return h('div', { class: 'stack' }, field('Escolha o mercado', ms2), out); }, { title, wide: true });
}
route(/^\/lista\/([^/]+)$/, async (ctx) => {
  const gate = needCustomer('Entre para ver sua lista'); if (gate) return gate; const u = SESSION.user; const id = ctx.params[0]; const path = `users/${u.uid}/lists/${id}`;
  const box = h('div', { class: 'stack' }); const head = h('div', null); let cur = null;
  const save = (patch) => api.set(path, { name: cur.name, items: cur.items, createdAt: cur.createdAt, updatedAt: api.stamp(), ...patch });
  const draw = () => {
    head.replaceChildren(h('div', { class: 'row between' }, h('h1', { style: { margin: 0 } }, cur.name), h('div', { class: 'row' },
      h('button', { class: 'btn sm ghost', onclick: () => { const n = inp({ value: cur.name }); openModal((m) => h('form', { class: 'stack', onsubmit: async (e) => { e.preventDefault(); await busy(e.submitter, async () => { await save({ name: n.value.trim().slice(0, 80) || cur.name }); m.close(); }); } }, n, h('button', { class: 'btn', type: 'submit' }, 'Salvar')), { title: 'Renomear lista' }); } }, icon('edit'), 'Renomear'),
      h('button', { class: 'btn sm ghost', onclick: (e) => busy(e.currentTarget, async () => { const nid = await api.add(`users/${u.uid}/lists`, { name: cur.name + ' (cópia)', items: cur.items, createdAt: api.stamp(), updatedAt: api.stamp() }); toast('Lista duplicada', 'ok'); go('/lista/' + nid); }) }, 'Duplicar'),
      h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDlg('Excluir lista', `Excluir “${cur.name}”? Isso não pode ser desfeito.`, 'Excluir', true)) { await api.del(path); go('/listas'); } } }, icon('trash'), 'Excluir'))));
    box.replaceChildren(cur.items.length ? [h('div', { class: 'stack' }, cur.items.map((it, i) => h('div', { class: 'card flat row' }, h('div', { class: 'logo-badge', style: { width: '44px', height: '44px', fontSize: '1.4rem' } }, it.emoji || '🛒'), h('div', { class: 'grow' }, h('b', null, it.name), h('div', { class: 'tiny muted' }, [it.brand, it.unitLabel].filter(Boolean).join(' · '))),
      h('div', { class: 'step', style: { minWidth: '112px' } }, h('button', { 'aria-label': 'Diminuir', onclick: () => { cur.items[i].qty = Math.max(1, it.qty - 1); save(); } }, '−'), h('b', null, it.qty), h('button', { 'aria-label': 'Aumentar', onclick: () => { cur.items[i].qty = Math.min(99, it.qty + 1); save(); } }, '+')),
      h('button', { class: 'icon-btn', 'aria-label': 'Remover ' + it.name, onclick: () => { cur.items.splice(i, 1); save(); } }, icon('trash'))))), h('button', { class: 'btn block', onclick: () => openUseItems('Usar lista em um mercado', cur.items) }, icon('cart'), 'Comprar esta lista')] : empty('📝', 'Lista vazia', 'Adicione produtos pelo botão “Lista” em qualquer produto.', h('a', { class: 'btn', href: href('/') }, 'Ver mercados')));
  };
  const un = api.watchDoc(path, (d) => { if (!d) { box.replaceChildren(empty('🗑', 'Lista não encontrada')); head.replaceChildren(); return; } cur = { ...d, items: d.items || [] }; draw(); }, (e) => box.replaceChildren(errorBox(e))); S.cleanups.push(un);
  return h('div', { class: 'stack' }, h('a', { href: href('/listas') }, '‹ Listas'), head, box);
});
