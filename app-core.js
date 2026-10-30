/* =====================================================================
   MEU MERCADO TESTE — núcleo da interface (utilitários, ícones, DOM seguro)
   O app é dividido em arquivos clássicos <script> que compartilham o escopo global:
   app-core · app-data · app-shell · app-customer · app-checkout · app-market · app-admin · app-boot.
   Preço, estoque, pagamento (simulado), permissão e estado do pedido são decididos em mm-backend.js e mm-api.js, não na tela.
   ===================================================================== */
'use strict';

/* ───────────────────────── CONFIG ───────────────────────── */
const MM = { version: '1.0.0-teste', appName: 'Meu Mercado Teste' };
/* Regras de negócio puras: business-rules.js (global MMRules). */
const R = MMRules;

/* ───────────────────────── UTIL ───────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>', cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M3 4h2.2l2.3 11h11l2-8H6.3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>', home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v11h14V10"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  bag: '<path d="M5 8h14l-1 13H6z"/><path d="M9 8a3 3 0 016 0"/>', store: '<path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M3 9a3 3 0 006 0 3 3 0 006 0 3 3 0 006 0"/>',
  pin: '<path d="M12 21s7-6 7-11a7 7 0 00-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>', check: '<path d="M5 12l5 5 9-10"/>', chev: '<path d="M9 6l6 6-6 6"/>',
  bell: '<path d="M6 16V11a6 6 0 0112 0v5l2 2H4z"/><path d="M10 20a2 2 0 004 0"/>', gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>', box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>', truck: '<path d="M2 6h11v10H2zM13 10h4l3 3v3h-7"/><circle cx="6" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.2"/>', edit: '<path d="M4 20l1-4L16 5l3 3L8 19z"/>', trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  money: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>', users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 21c.7-3.5 3.3-5.5 7-5.5s6.3 2 7 5.5M16 4.5a3.5 3.5 0 010 7M18 15.5c2 .6 3.4 2.2 4 5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 114 2c-1 .8-1.5 1.2-1.5 2.5M12 17.5v.1"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>', upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>', shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>', logout: '<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>', repeat: '<path d="M17 3l4 4-4 4M3 11V9a2 2 0 012-2h16M7 21l-4-4 4-4M21 13v2a2 2 0 01-2 2H3"/>', download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>'
};
const icon = (n, cls = '') => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'i ' + cls); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICONS[n] || ''; return s; }; // ICONS é constante interna
/** Hyperscript: cria DOM com textContent — nunca interpreta HTML vindo de dados (evita XSS). */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k]; if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'textContent') el[k] = v;
    else if (tag === 'img' && k === 'src' && String(v).startsWith('mmimg:')) hydrateImg(el, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c instanceof Node ? c : document.createTextNode(String(c))); };
  kids.forEach(add); return el;
}
/* Os métodos nativos do DOM transformam null/false em texto ("null", "false"). Aqui eles passam a ignorar valores vazios e aceitar listas aninhadas. */
(() => { const flat = (a) => a.flat(Infinity).filter(x => x != null && x !== false && x !== true);
  ['replaceChildren', 'append', 'prepend'].forEach((m) => { const orig = Element.prototype[m]; Element.prototype[m] = function (...a) { return orig.apply(this, flat(a)); }; }); })();
const brl = (c) => ((Number(c) || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dt = (ms) => ms ? new Date(ms.toMillis ? ms.toMillis() : ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const dday = (ms) => ms ? new Date(ms.toMillis ? ms.toMillis() : ms).toLocaleDateString('pt-BR') : '—';
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* armazenamento indisponível */ } };
const cepMask = (v) => { const d = String(v).replace(/\D/g, '').slice(0, 8); return d.length > 5 ? d.slice(0, 5) + '-' + d.slice(5) : d; };
const CAT_EMOJI = { mercearia: '🥫', cereais: '🌾', 'arroz-e-feijao': '🍚', massas: '🍝', bebidas: '🥤', hortifruti: '🥬', carnes: '🥩', peixes: '🐟', laticinios: '🧀', padaria: '🍞', congelados: '🧊', limpeza: '🧽', higiene: '🧴', bebes: '🍼', 'cesta-basica': '🧺', pet: '🐾' };
const emojiFor = (cat) => cat?.icon || CAT_EMOJI[cat?.id] || '🛒';
const STATUS = { ...R.ORDER_STATUS, confirmed: 'Pagamento confirmado — aguardando separação', picked: 'Separado', ready_for_dispatch: 'Aguardando expedição', delivered: 'Entregue', completed: 'Concluído', delivery_failed: 'Falha na entrega' };
const STATUS_TONE = { awaiting_payment: 'o', confirmed: 'b', picking: 'b', picked: 'b', ready_for_dispatch: 'b', out_for_delivery: 'o', delivered: '', completed: 'g', delivery_failed: 'r', cancelled: 'r', refund_processing: 'o', refunded: 'g' };
const statusBadge = (s) => h('span', { class: 'badge ' + (STATUS_TONE[s] || '') }, STATUS[s] || s);
const errMsg = (e) => {
  const c = e && (e.code || '').replace('functions/', ''); const m = (e && e.message) || String(e);
  if (/PROVIDER_NOT_CONFIGURED/.test(m)) return 'O pagamento online ainda não foi configurado pela plataforma. Nada foi cobrado.';
  if (c === 'permission-denied' && !/permiss|Missing or insufficient/i.test(m)) return m;
  if (/Missing or insufficient permissions/.test(m)) return 'Você não tem permissão para ver ou alterar isso.';
  if (c === 'unavailable' || /network|offline/i.test(m)) return 'Sem conexão com o servidor. Verifique a internet e tente de novo.';
  if (c === 'unauthenticated') return 'Entre na sua conta para continuar.';
  return m.replace(/^.*?:\s*/, '').slice(0, 300) || 'Algo deu errado. Tente novamente.';
};

