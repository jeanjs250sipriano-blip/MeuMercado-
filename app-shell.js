
/* ───────────────────────── STATE ───────────────────────── */
const S = { addr: lsGet('mm.addr', null), cities: [], cats: [], marketsCache: null, cleanups: [], notifUnsub: null, unread: 0, install: null };
const cache = { listings: {}, ts: {} };
const CartStore = {
  _all() { return lsGet('mm.cart', {}); },
  get(mid) { return this._all()[mid] || []; },
  set(mid, items) { const a = this._all(); if (items.length) a[mid] = items; else delete a[mid]; lsSet('mm.cart', a); this.syncUp(mid); updateBadges(); },
  qty(mid, lid) { return (this.get(mid).find(i => i.listingId === lid) || {}).qty || 0; },
  setQty(mid, l, qty) {
    const items = this.get(mid).filter(i => i.listingId !== l.id); qty = Math.max(0, Math.min(500, qty));
    if (qty > 0) items.push({ listingId: l.id, qty, snap: { name: l.name, brand: l.brand || null, unitLabel: l.unitLabel || null, price: l.price, emoji: l.emoji || null, imageUrl: l.imageUrl || null } });
    this.set(mid, items);
  },
  total() { return Object.values(this._all()).reduce((s, a) => s + a.reduce((x, i) => x + i.qty, 0), 0); },
  markets() { return Object.keys(this._all()); },
  syncUp: debounce(function (mid) {
    const u = SESSION.user; if (!u || u.role !== 'customer' || !api.set) return;
    const items = CartStore.get(mid).map(i => ({ listingId: i.listingId, qty: i.qty }));
    (items.length ? api.set(`users/${u.uid}/carts/${mid}`, { items, updatedAt: api.stamp() }) : api.del(`users/${u.uid}/carts/${mid}`)).catch(() => {});
  }, 800),
  async mergeDown() {
    const u = SESSION.user; if (!u || u.role !== 'customer') return;
    try {
      const remote = await api.col(`users/${u.uid}/carts`);
      for (const r of remote) {
        const local = this.get(r.id); const map = new Map(local.map(i => [i.listingId, i]));
        for (const it of r.items || []) if (!map.has(it.listingId)) map.set(it.listingId, { listingId: it.listingId, qty: it.qty, snap: null });
        const a = this._all(); a[r.id] = [...map.values()]; lsSet('mm.cart', a);
      }
      updateBadges();
    } catch { /* carrinho remoto indisponível: mantém o local */ }
  }
};

/* ───────────────────────── UI helpers ───────────────────────── */
function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind, role: 'status' }, msg); $('#toasts').append(t); setTimeout(() => t.remove(), kind === 'err' ? 6500 : 3500);
}
function openModal(build, opts = {}) {
  const ov = h('div', { class: 'ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Janela' });
  const box = h('div', { class: 'modal' + (opts.wide ? ' wide' : '') });
  const prev = document.activeElement;
  const api2 = { close() { ov.remove(); document.removeEventListener('keydown', onKey); prev && prev.focus && prev.focus(); opts.onClose && opts.onClose(); }, box };
  const onKey = (e) => { if (e.key === 'Escape') api2.close(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) api2.close(); });
  box.append(h('div', { class: 'row between', style: { marginBottom: '8px' } }, h('h3', { style: { margin: 0 } }, opts.title || ''), h('button', { class: 'icon-btn', 'aria-label': 'Fechar', onclick: () => api2.close() }, icon('x'))));
  box.append(build(api2)); ov.append(box); $('#modal-root').append(ov);
  const f = box.querySelector('input,select,textarea,button.btn'); f && f.focus();
  return api2;
}
function confirmDlg(title, text, okLabel = 'Confirmar', danger = false) {
  return new Promise((res) => {
    const m = openModal((mm) => h('div', { class: 'stack' }, h('p', null, text), h('div', { class: 'row' }, h('button', { class: 'btn ' + (danger ? 'danger' : ''), onclick: () => { res(true); mm.close(); } }, okLabel), h('button', { class: 'btn ghost', onclick: () => { res(false); mm.close(); } }, 'Cancelar'))), { title, onClose: () => res(false) });
  });
}
async function busy(btn, fn) {
  if (!btn) { try { return await fn(); } catch (e) { console.error(e); toast(errMsg(e), 'err'); } return; }   // botão já não existe (ex.: após uma confirmação)
  if (btn.disabled) return; const old = btn.textContent; btn.disabled = true; btn.replaceChildren(h('span', { class: 'spin', style: { width: '16px', height: '16px', borderWidth: '2px' } }), ' Aguarde…');
  try { return await fn(); } catch (e) { console.error(e); toast(errMsg(e), 'err'); } finally { btn.disabled = false; btn.textContent = old; }
}
const loading = () => h('div', { class: 'stack', 'aria-busy': 'true' }, h('div', { class: 'sk', style: { height: '120px' } }), h('div', { class: 'grid g2' }, h('div', { class: 'sk', style: { height: '180px' } }), h('div', { class: 'sk', style: { height: '180px' } })));
const empty = (emoji, title, text, action) => h('div', { class: 'empty card flat' }, h('div', { class: 'big' }, emoji), h('h3', null, title), text && h('p', null, text), action);
const errorBox = (e, retry) => h('div', { class: 'alert err' }, h('div', null, h('b', null, 'Não foi possível carregar. '), errMsg(e), retry && h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn sm ghost', onclick: retry }, 'Tentar novamente'))));
function field(label, input, hint) { return h('div', { class: 'field' }, h('label', { class: 'f' }, label, input.id ? null : null), input, hint && h('div', { class: 'tiny muted' }, hint)); }
const inp = (o = {}) => h('input', { class: 'in', type: o.type || 'text', value: o.value ?? '', placeholder: o.ph || '', required: o.req, min: o.min, max: o.max, step: o.step, maxlength: o.max_len, inputmode: o.mode, autocomplete: o.ac, name: o.name, oninput: o.oninput, 'aria-label': o.label });
const sel = (opts, value, o = {}) => h('select', { class: 'in', onchange: o.onchange, 'aria-label': o.label }, opts.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t)));
const stars = (n, size = '1rem') => h('span', { style: { color: '#F5A300', fontSize: size, letterSpacing: '1px' }, 'aria-label': `${n} de 5 estrelas` }, '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n)));
const moneyIn = (cents) => cents == null ? '' : (cents / 100).toFixed(2).replace('.', ',');
const parseMoney = (v) => { const s = String(v).replace(/[R$\s]/g, ''); const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
function copyText(t) { (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Copiado!', 'ok')).catch(() => { const ta = h('textarea', { value: t }); document.body.append(ta); ta.select(); try { document.execCommand('copy'); toast('Copiado!', 'ok'); } catch { toast('Copie manualmente.', 'err'); } ta.remove(); }); }
function download(name, blob) { const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
const downloadBlob = (blob, name) => { const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); };
function productEmoji(l) { return l.emoji || emojiFor(S.cats.find(c => c.id === l.categoryId)); }
const mapById = (arr) => Object.fromEntries(arr.map(x => [x.id, x]));
const isStaffOf = (u, kind) => u && (kind === 'market' ? u.role === 'market_staff' : (u.role === 'platform_admin' || u.role === 'platform_staff'));
const can = (u, p) => u && (u.role === 'platform_admin' || (u.perms || []).includes(p));

/* ───────────────────────── Dados compartilhados ───────────────────────── */
async function loadBase() {
  const [cities, cats] = await Promise.all([api.col('cities', { where: [['active', '==', true]] }), api.col('categories', { where: [['active', '==', true]] })]);
  S.cities = cities; S.cats = cats.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
async function loadMarkets(force) {
  if (S.marketsCache && !force && Date.now() - S.marketsCache.ts < 60000) return S.marketsCache.list;
  const ms = await api.col('markets', { where: [['status', '==', 'active']] });
  const list = await Promise.all(ms.map(async m => ({ ...m, settings: (await api.doc(`markets/${m.id}/public/settings`)) || {} })));
  S.marketsCache = { ts: Date.now(), list }; return list;
}
async function loadListings(mid, force) {
  if (!force && cache.listings[mid] && Date.now() - cache.ts[mid] < 45000) return cache.listings[mid];
  const ls = await api.col(`markets/${mid}/listings`, { where: [['active', '==', true]], limit: 600 });
  cache.listings[mid] = ls.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')); cache.ts[mid] = Date.now(); return cache.listings[mid];
}
function marketAvail(m) { return m.status === 'active' && m.acceptingOrders !== false; }
function marketOpenNow(m) { return R.isOpenAt(m.settings?.hours, m.settings?.closedDates, new Date()); }
function distanceKm(m) { const c = m.settings?.deliveryArea?.center; return c && S.addr && Number.isFinite(S.addr.lat) ? R.haversineKm(c, S.addr) : null; }
function unitPriceNow(l) { const p = R.priceLine(l, 1, Date.now()); return p; }

/* ───────────────────────── Roteador ───────────────────────── */
const routes = [];
const route = (re, fn, area) => routes.push({ re, fn, area });
const routeA = (area, re, fn) => route(re, fn, area);
const go = (p) => { if (location.hash === '#' + p) navigate(); else location.hash = p; };
const href = (p) => '#' + p;
function parseHash() { const raw = location.hash.slice(1) || '/'; const [path, qs] = raw.split('?'); return { path, q: Object.fromEntries(new URLSearchParams(qs || '')) }; }
function runCleanups() { S.cleanups.forEach(f => { try { f(); } catch { /* ignore */ } }); S.cleanups = []; }
let navToken = 0;
async function navigate() {
  runCleanups(); const tk = ++navToken; const { path, q } = parseHash(); const app = $('#app');
  if (!APP.hasAdmin && path !== '/configurar') { if (location.hash !== '#/configurar') { location.hash = '/configurar'; return; } }
  // Sem usuário: qualquer área logada volta direto para a tela de entrada
  const u0 = SESSION.user;
  if (!u0 && path !== '/entrar' && path !== '/configurar' && path !== '/seja-parceiro') {
    const needsAuth = path.startsWith('/admin') || path.startsWith('/painel') || path === '/conta' || path.startsWith('/pedido') || path.startsWith('/listas') || path.startsWith('/checkout');
    // / e /m/ e /carrinho podem ser públicos; painel/admin sempre exigem login
    if (path.startsWith('/admin') || path.startsWith('/painel') || path === '/conta') {
      location.hash = '/entrar'; return;
    }
  }
  // Com usuário: se está em /entrar, manda para a home do perfil
  if (u0 && (path === '/entrar' || path === '/configurar')) {
    location.hash = (typeof homeFor === 'function' ? homeFor(u0) : '/'); return;
  }
  let hit = null; for (const r of routes) { const m = path.match(r.re); if (m) { hit = { r, params: m.slice(1).map(decodeURIComponent) }; break; } }
  const area = hit ? hit.r.area || 'customer' : 'customer';
  renderShell(area);
  if (hit && hit.r.area && !isStaffOf(SESSION.user, hit.r.area)) { app.replaceChildren(accessGate(hit.r.area, path)); window.scrollTo(0, 0); return; }
  app.replaceChildren(loading());
  const ctx = { params: hit ? hit.params : [], q, path, on: (f) => S.cleanups.push(f), tk };
  try {
    const node = hit ? await hit.r.fn(ctx) : empty('🧭', 'Página não encontrada', 'O endereço que você abriu não existe.', h('a', { class: 'btn', href: href('/') }, 'Ir para o início'));
    if (tk !== navToken) return; app.replaceChildren(node); app.focus({ preventScroll: true }); window.scrollTo(0, 0);
  } catch (e) { console.error(e); if (tk === navToken) app.replaceChildren(errorBox(e, navigate)); }
}
function accessGate(kind, path) {
  const u = SESSION.user;
  return h('div', { class: 'card stack center', style: { maxWidth: '480px', margin: '40px auto' } }, h('div', { class: 'big', style: { fontSize: '2.4rem' } }, '🔒'),
    h('h2', null, kind === 'market' ? 'Painel do mercado' : 'Administração'),
    u ? h('p', null, 'Sua conta não tem acesso a esta área. Peça a um administrador que conceda a permissão.') : h('p', null, 'Entre com sua conta de equipe para continuar.'),
    u ? h('button', { class: 'btn ghost', onclick: () => api.signOut().then(() => go('/entrar')) }, 'Sair e trocar de conta') : h('a', { class: 'btn', href: href('/entrar?next=' + encodeURIComponent(path)) }, 'Entrar'));
}

/* ───────────────────────── Shell (topo e navegação) ───────────────────────── */
function updateBadges() {
  const n = CartStore.total(); document.querySelectorAll('[data-cart-count]').forEach(e => { e.textContent = n; e.hidden = !n; });
  document.querySelectorAll('[data-notif-count]').forEach(e => { e.textContent = S.unread; e.hidden = !S.unread; });
}
function renderShell(area) {
  renderDemoBar();
  const u = SESSION.user; const top = $('#top'); const bottom = $('#bottom');
  const brand = h('a', { class: 'brand', href: href('/') }, h('img', { src: 'icon-192.png', alt: '' }), h('b', null, 'Meu Mercado'));
  const bell = u ? h('button', { class: 'icon-btn', 'aria-label': 'Notificações', onclick: openNotifications }, icon('bell'), h('span', { class: 'dot', 'data-notif-count': true, hidden: !S.unread }, S.unread)) : null;
  if (area === 'customer') {
    const q = inp({ ph: 'Buscar produtos ou mercados', label: 'Buscar' }); q.style.paddingLeft = '40px';
    const form = h('form', { class: 'search', role: 'search', onsubmit: (e) => { e.preventDefault(); if (q.value.trim()) go('/busca?q=' + encodeURIComponent(q.value.trim())); } }, icon('search'), q);
    q.className = ''; Object.assign(q.style, { width: '100%', border: '1.5px solid var(--line)', borderRadius: '999px', padding: '10px 14px 10px 40px', background: '#F4F8F5', font: 'inherit' });
    q.value = parseHash().path === '/busca' ? parseHash().q.q || '' : '';
    top.replaceChildren(h('div', { class: 'top-in' }, brand, form,
      h('button', { class: 'addr-pill desk', onclick: () => openAddressPicker(), 'aria-label': 'Endereço de entrega' }, icon('pin'), h('span', null, S.addr ? `${S.addr.street || 'CEP ' + S.addr.cep}, ${S.addr.number || ''}`.replace(/, $/, '') : 'Informe seu endereço')),
      bell, h('a', { class: 'icon-btn desk', href: href('/carrinho'), 'aria-label': 'Carrinho' }, icon('cart'), h('span', { class: 'dot', 'data-cart-count': true }, CartStore.total())),
      h('a', { class: 'icon-btn desk', href: href(u ? '/conta' : '/entrar'), 'aria-label': u ? 'Minha conta' : 'Entrar' }, icon('user'))));
    const cur = parseHash().path; const tab = (p, ic, lbl, on, extra) => h('a', { href: href(p), class: on ? 'on' : '' }, icon(ic), lbl, extra);
    bottom.hidden = false;
    bottom.replaceChildren(tab('/', 'home', 'Início', cur === '/' || cur.startsWith('/m/')), tab('/listas', 'list', 'Listas', cur.startsWith('/lista')), tab('/carrinho', 'cart', 'Carrinho', cur.startsWith('/carrinho') || cur.startsWith('/checkout'), h('span', { class: 'dot', 'data-cart-count': true, style: { right: '22%' } }, CartStore.total())), tab('/pedidos', 'bag', 'Pedidos', cur.startsWith('/pedido')), tab(u ? '/conta' : '/entrar', 'user', u ? 'Conta' : 'Entrar', cur === '/conta' || cur === '/entrar' || cur === '/suporte'));
  } else {
    bottom.hidden = true; bottom.replaceChildren();
    const switchLinks = h('div', { class: 'areas', style: { padding: 0, flex: 1, justifyContent: 'flex-end' } },
      isStaffOf(u, 'market') && h('a', { href: href('/painel'), class: area === 'market' ? 'on' : '' }, 'Painel do mercado'),
      isStaffOf(u, 'admin') && h('a', { href: href('/admin'), class: area === 'admin' ? 'on' : '' }, 'Administração'), h('a', { href: href('/') }, 'Ver loja'));
    top.replaceChildren(h('div', { class: 'top-in' }, brand, switchLinks, bell, u && h('button', { class: 'icon-btn', 'aria-label': 'Sair', title: 'Sair', onclick: () => api.signOut().then(() => go('/entrar')) }, icon('logout'))));
  }
  updateBadges();
}
function renderDemoBar() {
  const el = document.getElementById('sim-bar');
  if (!el) return;
  el.hidden = false;
  el.className = 'demo-bar demo-bar-soft';
  const mode = (typeof APP !== 'undefined' && APP.mode === 'firebase')
    ? 'Firebase (dados compartilhados entre dispositivos)'
    : 'local neste navegador';
  el.replaceChildren(h('span', { class: 'tiny muted' }, 'Demonstração · ' + mode + ' · pagamentos fictícios'));
}

/* ───────────────────────── Notificações ───────────────────────── */
function startNotifWatch() {
  if (S.notifUnsub) { S.notifUnsub(); S.notifUnsub = null; } S.unread = 0; const u = SESSION.user; if (!u) return updateBadges();
  const path = u.role === 'market_staff' ? `markets/${u.marketId}/notifications` : (u.role === 'customer' ? `users/${u.uid}/notifications` : null);
  if (!path) return updateBadges();
  S.notifUnsub = api.watchCol(path, { orderBy: [['at', 'desc']], limit: 30 }, (rows) => { S.notifs = rows; S.unread = rows.filter(r => !r.read).length; updateBadges(); }, () => {});
}
function openNotifications() {
  const u = SESSION.user; const path = u.role === 'market_staff' ? `markets/${u.marketId}/notifications` : `users/${u.uid}/notifications`;
  openModal((m) => { const box = h('div', { class: 'stack' }); const draw = () => { const rows = S.notifs || []; box.replaceChildren(rows.length ? rows.map(n => h('div', { class: 'card flat', style: { opacity: n.read ? .6 : 1 } }, h('div', { class: 'row between' }, h('b', null, n.title), h('small', null, dt(n.at))), h('div', null, n.body), n.ref && h('a', { class: 'tiny', href: href((u.role === 'market_staff' ? '/painel/pedidos?o=' : '/pedido/') + encodeURIComponent(n.ref)), onclick: () => m.close() }, 'Abrir'))) : empty('🔔', 'Nada por aqui', 'Você será avisado sobre pedidos e mensagens.'), rows.some(r => !r.read) && h('button', { class: 'btn sm ghost', onclick: () => { rows.filter(r => !r.read).forEach(r => api.update(`${path}/${r.id}`, { read: true }).catch(() => {})); } }, 'Marcar todas como lidas')); }; draw(); const t = setInterval(draw, 1500); const old = m.close; m.close = () => { clearInterval(t); old(); }; return box; }, { title: 'Notificações' });
}

/* ───────────────────────── Endereço ───────────────────────── */
async function openAddressPicker(after) {
  const u = SESSION.user; let saved = []; if (u && u.role === 'customer') { try { saved = await api.col(`users/${u.uid}/addresses`); } catch { /* sem endereços salvos */ } }
  openModal((m) => {
    const box = h('div', { class: 'stack' });
    const pick = (a) => { S.addr = a; lsSet('mm.addr', a); S.marketsCache = null; m.close(); toast('Endereço selecionado', 'ok'); after ? after(a) : navigate(); };
    if (saved.length) box.append(h('div', { class: 'stack' }, saved.map(a => h('button', { class: 'card flat row between', style: { cursor: 'pointer', textAlign: 'left' }, onclick: () => pick({ ...a }) }, h('div', null, h('b', null, a.label || 'Endereço'), h('div', { class: 'muted tiny' }, `${a.street}, ${a.number} — ${a.district || ''} ${a.city}/${a.uf || ''} · CEP ${a.cep}`)), a.isDefault && h('span', { class: 'badge' }, 'Padrão')))), h('div', { class: 'sep' }));
    box.append(addressForm(S.addr && !S.addr.id ? S.addr : {}, async (a) => {
      if (u && u.role === 'customer') { const id = await api.add(`users/${u.uid}/addresses`, cleanAddr(a)); pick({ ...a, id }); } else pick(a);
    }, { saveLabel: u ? 'Salvar e usar' : 'Usar este endereço', geo: true }));
    return box;
  }, { title: 'Onde você quer receber?' });
}
const cleanAddr = (a) => { const o = {}; ['label', 'cep', 'street', 'number', 'complement', 'district', 'city', 'uf', 'lat', 'lng', 'isDefault', 'recipient'].forEach(k => { if (a[k] !== undefined && a[k] !== null && a[k] !== '') o[k] = a[k]; }); return o; };
function addressForm(a, onSave, o = {}) {
  const f = { label: inp({ value: a.label || '', ph: 'Casa, Trabalho…' }), cep: inp({ value: a.cep || '', ph: '00000-000', mode: 'numeric', ac: 'postal-code' }), street: inp({ value: a.street || '', ac: 'address-line1' }), number: inp({ value: a.number || '', ac: 'off' }), complement: inp({ value: a.complement || '' }), district: inp({ value: a.district || '' }), city: inp({ value: a.city || '' }), uf: inp({ value: a.uf || '', max_len: 2 }), recipient: inp({ value: a.recipient || SESSION.user?.name || '' }) };
  let geo = { lat: a.lat, lng: a.lng }; const err = h('div', { class: 'alert err', hidden: true });
  f.cep.addEventListener('input', () => { f.cep.value = cepMask(f.cep.value); });
  const geoBtn = o.geo && navigator.geolocation ? h('button', { type: 'button', class: 'btn sm ghost', onclick: (e) => busy(e.currentTarget, () => new Promise((res) => navigator.geolocation.getCurrentPosition((p) => { geo = { lat: p.coords.latitude, lng: p.coords.longitude }; toast('Localização usada só para o raio de entrega. Confirme o endereço acima.', 'ok'); res(); }, () => { toast('Não foi possível obter a localização. Informe o CEP manualmente.', 'err'); res(); }, { timeout: 8000 }))) }, '📍 Usar minha localização (opcional)') : null;
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true; const v = Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value.trim()]));
    if (v.cep.replace(/\D/g, '').length !== 8) { err.hidden = false; err.textContent = 'CEP inválido.'; return; } if (!v.street || !v.number || !v.city) { err.hidden = false; err.textContent = 'Preencha rua, número e cidade.'; return; }
    const btn = e.submitter || form.querySelector('button[type=submit]'); await busy(btn, () => onSave({ ...a, ...v, uf: v.uf.toUpperCase(), lat: geo.lat, lng: geo.lng }));
  } },
    field('CEP', f.cep), h('p', { class: 'tiny muted', style: { margin: 0 } }, 'O simulador não consulta serviços externos de CEP: preencha o endereço manualmente.'), geoBtn,
    field('Rua / Avenida', f.street), h('div', { class: 'grid g2' }, field('Número', f.number), field('Complemento', f.complement)), h('div', { class: 'grid g2' }, field('Bairro', f.district), field('Cidade', f.city)),
    h('div', { class: 'grid g2' }, field('UF', f.uf), field('Apelido', f.label)), field('Quem recebe', f.recipient), err,
    h('button', { class: 'btn block', type: 'submit' }, o.saveLabel || 'Salvar'));
  return form;
}
