/* Meu Mercado Teste — mm-backend.js
 * Regras de negócio privilegiadas (preço, estoque, pagamento, permissão, estado do pedido) executadas LOCALMENTE.
 * Origem: functions.js (Cloud Functions, removido desta cópia) do Meu Mercado original, reaproveitado por meio de uma fábrica com
 * adaptadores (https onCall, HttpsError, FieldValue, Timestamp, auth local e provedor de pagamento SIMULADO).
 * Não há servidor, rede nem pagamento real. O backend usa o store diretamente (equivalente ao Admin SDK);
 * cada função valida papel/permissão da conta que a chamou.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./mm-store.js'), require('./business-rules.js'));
  else root.MMBackend = factory(root.MMStore, root.MMRules);
})(typeof self !== 'undefined' ? self : this, function (MMStore, R) {
'use strict';
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; this.name = 'HttpsError'; } }
function createBackend(deps) {
const { store, auth, provider: PROVIDER } = deps;
const exports = {};
const onCall = (o, h) => h, onRequest = (o, h) => h, onSchedule = (o, h) => h, onDocumentCreated = (o, h) => h;
const db = store.db; const FV = MMStore.FieldValue; const TS = MMStore.Timestamp;
const admin = { auth: () => auth.adminAuth };
const OPTS = {};
const getProvider = () => PROVIDER;
const _webc = () => (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) ? globalThis.crypto : require('crypto').webcrypto;
const _rb = (n) => { const a = new Uint8Array(n); _webc().getRandomValues(a); return a; };
const crypto = { randomBytes: (n) => { const a = _rb(n); return { toString: () => Array.from(a, b => b.toString(16).padStart(2, '0')).join('') }; }, randomInt: (lo, hi) => { const a = new Uint32Array(1); _webc().getRandomValues(a); return lo + (a[0] % (hi - lo)); } };
/* ============================ Utilidades ============================ */
const now = () => TS.now();
const plusMin = (m) => TS.fromMillis(Date.now() + m * 60000);
const fail = (code, msg) => { throw new HttpsError(code, msg); };

function needAuth(req) { if (!req.auth) fail('unauthenticated', 'Entre na sua conta para continuar.'); return req.auth; }
function claims(req) { const t = needAuth(req).token; return { uid: req.auth.uid, role: t.role || null, perms: t.perms || [], marketId: t.marketId || null, email: t.email || null }; }
function needPlatform(req, perm) {
  const c = claims(req);
  const ok = c.role === 'platform_admin' || (c.role === 'platform_staff' && c.perms.includes(perm));
  if (!ok) fail('permission-denied', 'Você não tem permissão para esta ação.');
  return c;
}
function needMarket(req, marketId, perm) {
  const c = claims(req);
  if (c.role === 'market_staff' && c.marketId === marketId && c.perms.includes(perm)) return c;
  fail('permission-denied', 'Você não tem permissão neste mercado para esta ação.');
}
function str(v, max, name) { if (typeof v !== 'string' || !v.trim() || v.length > max) fail('invalid-argument', `Campo inválido: ${name}.`); return v.trim(); }
function optStr(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : null; }
function int(v, min, max, name) { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < min || n > max) fail('invalid-argument', `Valor inválido: ${name}.`); return n; }
function slug(s) { return R.normText(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); }
function keywordsOf(...parts) { return [...new Set(parts.filter(Boolean).join(' ').split(/\s+/).map(R.normText).filter(w => w.length >= 2))].slice(0, 30); }

function audit(tx, e) {
  const ref = db.collection('auditLogs').doc();
  const doc = { at: now(), actor: e.actor || 'system', actorRole: e.actorRole || null, action: e.action, target: e.target || null,
    marketId: e.marketId || null, before: e.before ?? null, after: e.after ?? null, note: e.note || null };
  return tx ? tx.set(ref, doc) : ref.set(doc);
}
function orderEvent(tx, orderId, e) {
  const ref = db.collection('orders').doc(orderId).collection('events').doc();
  const doc = { at: now(), type: e.type, actor: e.actor || 'system', data: e.data || null, from: e.from || null, to: e.to || null };
  return tx ? tx.set(ref, doc) : ref.set(doc);
}
function notifyUser(tx, uid, n) {
  const ref = db.collection('users').doc(uid).collection('notifications').doc();
  const doc = { at: now(), read: false, ...n };
  return tx ? tx.set(ref, doc) : ref.set(doc);
}
function notifyMarket(tx, marketId, n) {
  const ref = db.collection('markets').doc(marketId).collection('notifications').doc();
  const doc = { at: now(), read: false, ...n };
  return tx ? tx.set(ref, doc) : ref.set(doc);
}
function ledger(tx, e) {
  const ref = e.id ? db.collection('ledger').doc(e.id) : db.collection('ledger').doc();
  const doc = { at: now(), type: e.type, orderId: e.orderId || null, marketId: e.marketId || null, amount: e.amount, meta: e.meta || null };
  return tx ? tx.set(ref, doc) : ref.set(doc);
}
async function platformConfig() {
  const s = await db.collection('platform').doc('config').get();
  return { ...R.DEFAULTS, ...(s.exists ? s.data() : {}) };
}
async function marketBundle(marketId) {
  const [m, a, s] = await Promise.all([
    db.collection('markets').doc(marketId).get(),
    db.collection('marketAdmin').doc(marketId).get(),
    db.collection('markets').doc(marketId).collection('public').doc('settings').get()
  ]);
  if (!m.exists) fail('not-found', 'Mercado não encontrado.');
  return { market: { id: m.id, ...m.data() }, admin: a.exists ? a.data() : {}, settings: s.exists ? s.data() : {} };
}

/* ============================ Administração: catálogo, cidades, config ============================ */
exports.adminUpsertCategory = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'categories.write');
  const d = req.data || {};
  const name = str(d.name, 80, 'nome');
  const id = d.id ? str(d.id, 80, 'id') : slug(name) + '-' + crypto.randomBytes(2).toString('hex');
  const ref = db.collection('categories').doc(id);
  // UI envia "emoji"; backend grava em "icon" (e espelha em "emoji" para a listagem)
  const iconVal = optStr(d.icon || d.emoji, 8);
  await db.runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    if (d.parentId) { const p = await tx.get(db.collection('categories').doc(d.parentId)); if (!p.exists) fail('invalid-argument', 'Categoria-pai inexistente.'); if (d.parentId === id) fail('invalid-argument', 'Categoria não pode ser pai de si mesma.'); }
    const next = { name, parentId: d.parentId || null, order: int(d.order ?? 0, 0, 9999, 'ordem'), active: d.active !== false, icon: iconVal, emoji: iconVal, updatedAt: now() };
    tx.set(ref, cur.exists ? next : { ...next, createdAt: now() }, { merge: true });
    audit(tx, { actor: c.uid, actorRole: c.role, action: cur.exists ? 'category.update' : 'category.create', target: `categories/${id}`, before: cur.exists ? cur.data() : null, after: next });
  });
  return { id };
});

/** Categorias padrão do supermercado (ids estáveis alinhados a CAT_EMOJI no front). Só cria as que ainda não existem. */
const DEFAULT_CATEGORIES = [
  { id: 'mercearia', name: 'Mercearia', icon: '🥫', order: 10 },
  { id: 'arroz-e-feijao', name: 'Arroz e Feijão', icon: '🍚', order: 20 },
  { id: 'cereais', name: 'Cereais e Grãos', icon: '🌾', order: 30 },
  { id: 'massas', name: 'Massas', icon: '🍝', order: 40 },
  { id: 'oleos-e-temperos', name: 'Óleos e Temperos', icon: '🫒', order: 45 },
  { id: 'bebidas', name: 'Bebidas', icon: '🥤', order: 50 },
  { id: 'laticinios', name: 'Laticínios', icon: '🧀', order: 60 },
  { id: 'padaria', name: 'Padaria', icon: '🍞', order: 70 },
  { id: 'hortifruti', name: 'Hortifruti', icon: '🥬', order: 80 },
  { id: 'carnes', name: 'Carnes', icon: '🥩', order: 90 },
  { id: 'peixes', name: 'Peixes e Frutos do Mar', icon: '🐟', order: 100 },
  { id: 'congelados', name: 'Congelados', icon: '🧊', order: 110 },
  { id: 'doces-e-snacks', name: 'Doces e Snacks', icon: '🍫', order: 115 },
  { id: 'limpeza', name: 'Limpeza', icon: '🧽', order: 120 },
  { id: 'higiene', name: 'Higiene e Beleza', icon: '🧴', order: 130 },
  { id: 'bebes', name: 'Bebês', icon: '🍼', order: 140 },
  { id: 'pet', name: 'Pet', icon: '🐾', order: 150 },
  { id: 'cesta-basica', name: 'Cesta Básica', icon: '🧺', order: 160 },
];

exports.adminSeedDefaultCategories = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'categories.write');
  let created = 0, skipped = 0;
  for (const cat of DEFAULT_CATEGORIES) {
    const ref = db.collection('categories').doc(cat.id);
    const cur = await ref.get();
    if (cur.exists) { skipped++; continue; }
    const doc = { name: cat.name, parentId: null, order: cat.order, active: true, icon: cat.icon, emoji: cat.icon, createdAt: now(), updatedAt: now() };
    await ref.set(doc);
    created++;
  }
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'category.seedDefaults', target: 'categories', after: { created, skipped } });
  return { created, skipped, total: DEFAULT_CATEGORIES.length };
});

// Categorias nunca são excluídas: apenas desativadas, preservando produtos e histórico.
exports.adminResolveCategoryRequest = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'categories.write');
  const { requestId, approve } = req.data || {};
  const ref = db.collection('categoryRequests').doc(str(requestId, 80, 'solicitação'));
  await ref.update({ status: approve ? 'approved' : 'rejected', resolvedBy: c.uid, resolvedAt: now() });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'categoryRequest.resolve', target: ref.path, after: { approve: !!approve } });
  return { ok: true };
});

exports.adminUpsertCity = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'cities.write');
  const d = req.data || {};
  const name = str(d.name, 80, 'cidade');
  const id = d.id ? str(d.id, 80, 'id') : slug(name + '-' + (d.uf || ''));
  const doc = { name, uf: str(d.uf, 2, 'UF').toUpperCase(), active: d.active === true, regions: Array.isArray(d.regions) ? d.regions.slice(0, 50).map(r => str(r, 60, 'região')) : [], updatedAt: now() };
  await db.collection('cities').doc(id).set(doc, { merge: true });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'city.upsert', target: `cities/${id}`, after: doc });
  return { id };
});

exports.adminSetPlatformConfig = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'config.write');
  const d = req.data || {};
  const next = {
    reservationMinutes: int(d.reservationMinutes ?? 30, 5, 120, 'prazo de reserva'),
    disputeWindowMinutes: int(d.disputeWindowMinutes ?? 60, 0, 10080, 'janela de contestação'),
    scheduleBusinessDays: int(d.scheduleBusinessDays ?? 3, 1, 14, 'dias de agendamento'),
    substitutionTimeoutMinutes: int(d.substitutionTimeoutMinutes ?? 20, 5, 240, 'prazo de substituição'),
    updatedAt: now()
  };
  const ref = db.collection('platform').doc('config');
  const before = (await ref.get()).data() || null;
  await ref.set(next, { merge: true });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'platform.config', target: ref.path, before, after: next });
  return { ok: true };
});

exports.adminUpsertGlobalProduct = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'catalog.write');
  const d = req.data || {};
  const name = str(d.name, 160, 'nome');
  const brand = optStr(d.brand, 80);
  const barcode = d.barcode ? String(d.barcode).replace(/\D/g, '') : null;
  if (barcode && ![8, 12, 13, 14].includes(barcode.length)) fail('invalid-argument', 'Código de barras inválido (8, 12, 13 ou 14 dígitos).');
  const doc = {
    name, brand, barcode, categoryId: str(d.categoryId, 80, 'categoria'),
    size: d.size != null ? Number(d.size) : null, unit: optStr(d.unit, 12), // g, kg, ml, l, un
    description: optStr(d.description, 800), imageUrl: optStr(d.imageUrl, 500), active: d.active !== false,
    keywords: keywordsOf(name, brand), updatedAt: now()
  };
  let id = d.id;
  if (!id) {
    if (barcode) { const dup = await db.collection('globalProducts').where('barcode', '==', barcode).limit(1).get(); if (!dup.empty) fail('already-exists', `Já existe produto com este código de barras (${dup.docs[0].id}).`); }
    id = db.collection('globalProducts').doc().id;
    doc.createdAt = now();
  }
  await db.collection('globalProducts').doc(id).set(doc, { merge: true });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'globalProduct.upsert', target: `globalProducts/${id}`, after: doc });
  return { id };
});

/* ============================ Administração: equipe interna ============================ */
async function inviteUser({ email, name, claimsObj }) {
  const username = String(email).toLowerCase().replace(/@local$/, '');
  let acc = await auth.getByUsername(username); let password = null;
  if (!acc) { const r = await auth.createAccount({ username, name, role: claimsObj.role, marketId: claimsObj.marketId || null, perms: claimsObj.perms || [], mustChangePassword: true }, 'backend'); acc = { uid: r.account.uid }; password = r.password; }
  else await admin.auth().setCustomUserClaims(acc.uid, claimsObj);
  return { user: { uid: acc.uid }, link: password ? 'Senha temporária (anote agora, ela não será mostrada de novo): ' + password : 'A conta já existia; apenas as permissões foram atualizadas.', password };
}

exports.adminInviteStaff = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'staff.manage');
  const d = req.data || {};
  const email = str(d.username || d.email, 60, 'usuário').toLowerCase().replace(/@local$/, '');
  const perms = R.sanitizePerms(d.perms, R.PLATFORM_PERMS);
  if (c.role !== 'platform_admin') { // delegação limitada: não concede o que não possui
    if (perms.some(p => !c.perms.includes(p))) fail('permission-denied', 'Você não pode conceder permissões que não possui.');
  }
  const { user, link, password } = await inviteUser({ email, name: optStr(d.name, 120), claimsObj: { role: 'platform_staff', perms } });
  const staffDoc = { name: optStr(d.name, 120), email, department: optStr(d.department, 60), title: optStr(d.title, 60), perms, active: true, managerUid: d.managerUid || null, createdAt: now(), createdBy: c.uid };
  await db.collection('staff').doc(user.uid).set(staffDoc, { merge: true });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'staff.invite', target: `staff/${user.uid}`, after: { email, perms } });
  return { uid: user.uid, passwordSetupLink: link, temporaryPassword: password, note: 'Simulador: autenticação local simples, não use senhas reais.' };
});

exports.adminSetStaffAccess = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'staff.manage');
  const d = req.data || {};
  const uid = str(d.uid, 128, 'uid');
  if (uid === c.uid) fail('failed-precondition', 'Você não pode alterar o próprio acesso.');
  const target = await admin.auth().getUser(uid);
  const tc = target.customClaims || {};
  if (tc.role === 'platform_admin' && c.role !== 'platform_admin') fail('permission-denied', 'Somente um Administrador Geral altera outro Administrador Geral.');
  const ref = db.collection('staff').doc(uid);
  const before = (await ref.get()).data() || null;
  const patch = {};
  if (Array.isArray(d.perms)) {
    const perms = R.sanitizePerms(d.perms, R.PLATFORM_PERMS);
    if (c.role !== 'platform_admin' && perms.some(p => !c.perms.includes(p))) fail('permission-denied', 'Você não pode conceder permissões que não possui.');
    patch.perms = perms;
    if (tc.role !== 'platform_admin') await admin.auth().setCustomUserClaims(uid, { role: 'platform_staff', perms });
  }
  if (typeof d.active === 'boolean') {
    patch.active = d.active;
    await admin.auth().updateUser(uid, { disabled: !d.active });
  }
  if (d.department !== undefined) patch.department = optStr(d.department, 60);
  if (d.managerUid !== undefined) patch.managerUid = d.managerUid || null;
  patch.updatedAt = now();
  await ref.set(patch, { merge: true });
  await admin.auth().revokeRefreshTokens(uid);
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'staff.access', target: `staff/${uid}`, before, after: patch });
  return { ok: true };
});

exports.adminSaveDepartment = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'staff.manage');
  const d = req.data || {};
  const id = d.id || slug(str(d.name, 60, 'nome'));
  await db.collection('departments').doc(id).set({ name: str(d.name, 60, 'nome'), managerUid: d.managerUid || null, updatedAt: now() }, { merge: true });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'department.upsert', target: `departments/${id}` });
  return { id };
});

/* ============================ Administração: CRM e mercados ============================ */
const PROSPECT_STATES = ['new', 'contacted', 'docs_pending', 'in_review', 'awaiting_contact', 'approved', 'rejected', 'awaiting_setup', 'active', 'suspended'];

// Solicitação iniciada pelo próprio mercado (pública, com validação e limite simples por e-mail).
exports.marketRequestSignup = onCall(OPTS, async (req) => {
  const d = req.data || {};
  const email = str(d.email, 160, 'e-mail').toLowerCase();
  const recent = await db.collection('prospects').where('contactEmail', '==', email).where('source', '==', 'market_request').limit(3).get();
  if (recent.size >= 3) fail('resource-exhausted', 'Já recebemos solicitações deste e-mail. Nossa equipe entrará em contato.');
  const doc = {
    tradeName: str(d.tradeName, 120, 'nome fantasia'), legalName: optStr(d.legalName, 160), cnpj: optStr(d.cnpj, 18),
    contactName: str(d.contactName, 120, 'contato'), contactEmail: email, contactPhone: str(d.contactPhone, 30, 'telefone'),
    city: str(d.city, 80, 'cidade'), uf: optStr(d.uf, 2), notes: optStr(d.notes, 1000),
    status: 'new', source: 'market_request', ownerUid: null, createdAt: now(), updatedAt: now(), stageSince: now()
  };
  const ref = await db.collection('prospects').add(doc);
  return { id: ref.id };
});

exports.adminSaveProspect = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'crm.write');
  const d = req.data || {};
  const patch = {
    tradeName: str(d.tradeName, 120, 'nome fantasia'), legalName: optStr(d.legalName, 160), cnpj: optStr(d.cnpj, 18),
    contactName: optStr(d.contactName, 120), contactEmail: optStr(d.contactEmail, 160), contactPhone: optStr(d.contactPhone, 30),
    city: optStr(d.city, 80), uf: optStr(d.uf, 2), notes: optStr(d.notes, 1000), updatedAt: now()
  };
  let id = d.id;
  if (!id) {
    const ref = await db.collection('prospects').add({ ...patch, status: 'new', source: 'sales_team', ownerUid: c.uid, createdAt: now(), stageSince: now(), timeline: [] });
    id = ref.id;
  } else await db.collection('prospects').doc(id).set(patch, { merge: true });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'prospect.save', target: `prospects/${id}` });
  return { id };
});

exports.adminProspectEvent = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'crm.write');
  const d = req.data || {};
  const ref = db.collection('prospects').doc(str(d.id, 80, 'prospecto'));
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref); if (!s.exists) fail('not-found', 'Prospecto não encontrado.');
    const cur = s.data(); const upd = { updatedAt: now() };
    const entry = { at: TS.now(), by: c.uid, kind: optStr(d.kind, 30) || 'note', text: optStr(d.text, 1000) };
    if (d.status) {
      if (!PROSPECT_STATES.includes(d.status)) fail('invalid-argument', 'Estado inválido.');
      if (d.status !== cur.status) { upd.status = d.status; upd.stageSince = now(); entry.kind = 'status'; entry.text = `${cur.status} → ${d.status}. ${entry.text || ''}`.trim();
        upd.stageHistory = FV.arrayUnion({ status: cur.status, enteredAt: cur.stageSince || cur.createdAt, leftAt: TS.now(), by: c.uid }); }
    }
    if (d.nextTask) upd.nextTask = { text: str(d.nextTask.text, 200, 'tarefa'), dueDate: optStr(d.nextTask.dueDate, 10) };
    upd.timeline = FV.arrayUnion(entry);
    tx.update(ref, upd);
    audit(tx, { actor: c.uid, actorRole: c.role, action: 'prospect.event', target: ref.path, before: { status: cur.status }, after: { status: upd.status || cur.status }, note: entry.text });
  });
  return { ok: true };
});

exports.adminCreateMarketFromProspect = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'markets.write');
  const d = req.data || {};
  const pref = db.collection('prospects').doc(str(d.prospectId, 80, 'prospecto'));
  const p = await pref.get(); if (!p.exists) fail('not-found', 'Prospecto não encontrado.');
  if (!['approved', 'awaiting_setup'].includes(p.data().status)) fail('failed-precondition', 'O prospecto precisa estar aprovado antes de virar mercado.');
  const marketId = slug(p.data().tradeName) + '-' + crypto.randomBytes(2).toString('hex');
  const cityId = str(d.cityId, 80, 'cidade');
  await db.runTransaction(async (tx) => {
    tx.set(db.collection('markets').doc(marketId), { name: p.data().tradeName, cityId, status: 'awaiting_setup', acceptingOrders: false, ratingSum: 0, ratingCount: 0, ratingAvg: 0, createdAt: now(), prospectId: pref.id });
    tx.set(db.collection('marketAdmin').doc(marketId), { commissionRate: null, ownerUid: d.ownerUid || p.data().ownerUid || c.uid, ownerHistory: [], legalName: p.data().legalName || null, cnpj: p.data().cnpj || null, paymentAccountId: null, createdAt: now() });
    tx.update(pref, { status: 'awaiting_setup', marketId, stageSince: now(), updatedAt: now() });
    audit(tx, { actor: c.uid, actorRole: c.role, action: 'market.create', target: `markets/${marketId}`, marketId, after: { cityId } });
  });
  return { marketId };
});

function setupProblems(m, a, s) {
  const p = [];
  if (!(a.commissionRate >= 0 && a.commissionRate <= 0.5) || a.commissionRate == null) p.push('comissão não definida');
  if (!s.hours || !Object.keys(s.hours).length) p.push('horário de funcionamento não configurado');
  if (!s.deliveryArea || !(s.deliveryArea.ceps?.length || s.deliveryArea.districts?.length || (s.deliveryArea.center && s.deliveryArea.radiusKm))) p.push('área de entrega não configurada');
  if (!Number.isFinite(s.deliveryFee)) p.push('taxa de entrega não definida');
  if (!a.ownerUid) p.push('responsável interno não atribuído');
  return p;
}

exports.adminSetMarketStatus = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'markets.status');
  const d = req.data || {};
  const marketId = str(d.marketId, 100, 'mercado');
  const status = d.status;
  if (!['active', 'suspended', 'awaiting_setup'].includes(status)) fail('invalid-argument', 'Estado inválido.');
  const { market, admin: a, settings } = await marketBundle(marketId);
  if (status === 'active') { const pr = setupProblems(market, a, settings); if (pr.length) fail('failed-precondition', 'Configuração incompleta: ' + pr.join('; ') + '.'); }
  await db.collection('markets').doc(marketId).update({ status, ...(status === 'suspended' ? { acceptingOrders: false } : {}), statusReason: optStr(d.reason, 300), statusChangedAt: now() });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'market.status', target: `markets/${marketId}`, marketId, before: { status: market.status }, after: { status }, note: optStr(d.reason, 300) });
  // Suspender NÃO apaga pedidos nem financeiro; pedidos já aceitos continuam sendo atendidos.
  return { ok: true };
});

exports.adminSetCommission = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'commission.write');
  const d = req.data || {};
  const marketId = str(d.marketId, 100, 'mercado');
  const pct = Number(d.percent);
  if (!(pct >= 0 && pct <= 50)) fail('invalid-argument', 'Comissão deve ficar entre 0% e 50%.');
  const ref = db.collection('marketAdmin').doc(marketId);
  const before = (await ref.get()).data()?.commissionRate ?? null;
  await ref.set({ commissionRate: Math.round(pct * 100) / 10000, commissionUpdatedAt: now(), commissionUpdatedBy: c.uid }, { merge: true });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'market.commission', target: ref.path, marketId, before, after: pct / 100, note: 'Vale apenas para novos pedidos; pedidos existentes preservam a comissão da compra.' });
  return { ok: true };
});

exports.adminAssignMarketOwner = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'markets.write');
  const d = req.data || {};
  const marketId = str(d.marketId, 100, 'mercado'); const newOwner = str(d.ownerUid, 128, 'responsável');
  const ref = db.collection('marketAdmin').doc(marketId);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref); const cur = s.data() || {};
    if (cur.ownerUid === newOwner) return;
    tx.set(ref, { ownerUid: newOwner, ownerHistory: FV.arrayUnion({ uid: cur.ownerUid || null, until: TS.now(), reassignedBy: c.uid, reason: optStr(d.reason, 200) }) }, { merge: true });
    tx.set(ref.collection('history').doc(), { at: now(), kind: 'reassign', from: cur.ownerUid || null, to: newOwner, by: c.uid, reason: optStr(d.reason, 200) });
    audit(tx, { actor: c.uid, actorRole: c.role, action: 'market.reassign', target: ref.path, marketId, before: cur.ownerUid || null, after: newOwner });
  });
  return { ok: true }; // histórico anterior preservado em ownerHistory e em /history
});

exports.adminAddMarketLog = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'crm.write');
  const d = req.data || {};
  const marketId = str(d.marketId, 100, 'mercado');
  await db.collection('marketAdmin').doc(marketId).collection('history').add({ at: now(), kind: optStr(d.kind, 30) || 'note', text: str(d.text, 1000, 'texto'), by: c.uid });
  return { ok: true };
});

exports.adminUpsertCoupon = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'campaigns.write');
  const d = req.data || {};
  const code = str(d.code, 30, 'código').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!['percent', 'fixed', 'freeShipping'].includes(d.type)) fail('invalid-argument', 'Tipo de cupom inválido.');
  const doc = {
    code, type: d.type, value: d.type === 'freeShipping' ? 0 : Number(d.value), fundedBy: ['market', 'platform', 'shared'].includes(d.fundedBy) ? d.fundedBy : 'platform',
    sharePlatformPct: d.sharePlatformPct != null ? int(d.sharePlatformPct, 0, 100, 'rateio') : 50, marketId: d.marketId || null,
    minOrder: d.minOrder != null ? int(d.minOrder, 0, 10_000_000, 'pedido mínimo') : null, maxDiscount: d.maxDiscount != null ? int(d.maxDiscount, 0, 10_000_000, 'desconto máximo') : null,
    maxUses: d.maxUses != null ? int(d.maxUses, 1, 10_000_000, 'limite de usos') : null, maxUsesPerUser: d.maxUsesPerUser != null ? int(d.maxUsesPerUser, 1, 1000, 'limite por cliente') : null,
    validFrom: optStr(d.validFrom, 30), validTo: optStr(d.validTo, 30), stackWithPromo: d.stackWithPromo !== false,
    eligibleUserIds: Array.isArray(d.eligibleUserIds) ? d.eligibleUserIds.slice(0, 500) : null, visibility: d.visibility === 'public' ? 'public' : 'private',
    firstOrderOnly: d.firstOrderOnly === true, productIds: Array.isArray(d.productIds) ? d.productIds.slice(0, 200).map(String) : [], categoryIds: Array.isArray(d.categoryIds) ? d.categoryIds.slice(0, 50).map(String) : [],
    active: d.active !== false, updatedAt: now()
  };
  if (doc.type === 'percent' && !(doc.value > 0 && doc.value <= 100)) fail('invalid-argument', 'Percentual deve estar entre 0 e 100.');
  if (doc.type === 'fixed' && !(doc.value > 0)) fail('invalid-argument', 'Valor do cupom inválido.');
  const ref = db.collection('coupons').doc(code);
  const cur = await ref.get();
  await ref.set(cur.exists ? doc : { ...doc, usedCount: 0, createdAt: now(), createdBy: c.uid }, { merge: true });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'coupon.upsert', target: ref.path, before: cur.data() || null, after: doc });
  return { code };
});

/* ============================ Mercado: equipe, configurações, produtos ============================ */
exports.marketInviteStaff = onCall(OPTS, async (req) => {
  const d = req.data || {};
  const marketId = str(d.marketId, 100, 'mercado');
  const c = needMarket(req, marketId, 'staff.manage');
  const email = str(d.username || d.email, 60, 'usuário').toLowerCase().replace(/@local$/, '');
  const preset = d.preset && R.MARKET_ROLE_PRESETS[d.preset];
  const perms = R.sanitizePerms(preset || d.perms, R.MARKET_PERMS);
  if (perms.some(p => !c.perms.includes(p))) fail('permission-denied', 'Você não pode conceder permissões que não possui.'); // sem escalada de privilégio
  const existing = await admin.auth().getUserByEmail(email).catch(() => null);
  if (existing && existing.customClaims && existing.customClaims.role && existing.customClaims.marketId !== marketId) fail('failed-precondition', 'Este e-mail já pertence a outra equipe.');
  const { user, link, password } = await inviteUser({ email, name: optStr(d.name, 120), claimsObj: { role: 'market_staff', marketId, perms } });
  await db.collection('markets').doc(marketId).collection('staff').doc(user.uid).set({ name: optStr(d.name, 120), email, preset: d.preset || null, perms, active: true, createdAt: now(), createdBy: c.uid }, { merge: true });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'marketStaff.invite', target: `markets/${marketId}/staff/${user.uid}`, marketId, after: { email, perms } });
  return { uid: user.uid, passwordSetupLink: link, temporaryPassword: password };
});

exports.marketSetStaffAccess = onCall(OPTS, async (req) => {
  const d = req.data || {};
  const marketId = str(d.marketId, 100, 'mercado');
  const c = needMarket(req, marketId, 'staff.manage');
  const uid = str(d.uid, 128, 'uid');
  if (uid === c.uid) fail('failed-precondition', 'Você não pode alterar o próprio acesso.');
  const ref = db.collection('markets').doc(marketId).collection('staff').doc(uid);
  const s = await ref.get(); if (!s.exists) fail('not-found', 'Funcionário não encontrado neste mercado.');
  const patch = { updatedAt: now() };
  if (Array.isArray(d.perms)) {
    const perms = R.sanitizePerms(d.perms, R.MARKET_PERMS);
    if (perms.some(p => !c.perms.includes(p))) fail('permission-denied', 'Você não pode conceder permissões que não possui.');
    patch.perms = perms; await admin.auth().setCustomUserClaims(uid, { role: 'market_staff', marketId, perms });
  }
  if (typeof d.active === 'boolean') { patch.active = d.active; await admin.auth().updateUser(uid, { disabled: !d.active }); }
  await ref.set(patch, { merge: true });
  await admin.auth().revokeRefreshTokens(uid);
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'marketStaff.access', target: ref.path, marketId, before: s.data(), after: patch });
  return { ok: true };
});

exports.marketUpdateSettings = onCall(OPTS, async (req) => {
  const d = req.data || {};
  const marketId = str(d.marketId, 100, 'mercado');
  const c = needMarket(req, marketId, 'settings.write');
  const s = d.settings || {};
  const out = { updatedAt: now() };
  if (s.hours) {
    const h = {};
    for (let i = 0; i < 7; i++) {
      const slots = (s.hours[String(i)] || []).slice(0, 4).map(x => {
        if (!/^\d{2}:\d{2}$/.test(x.open) || !/^\d{2}:\d{2}$/.test(x.close) || x.open >= x.close) fail('invalid-argument', 'Horário inválido (use HH:MM e abertura anterior ao fechamento).');
        return { open: x.open, close: x.close };
      });
      if (slots.length) h[String(i)] = slots;
    }
    out.hours = h;
  }
  if (Array.isArray(s.closedDates)) out.closedDates = s.closedDates.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)).slice(0, 120);
  if (s.deliveryFee != null) out.deliveryFee = int(s.deliveryFee, 0, 100000, 'taxa de entrega');
  if (s.freeShippingAbove != null) out.freeShippingAbove = s.freeShippingAbove === 0 ? null : int(s.freeShippingAbove, 0, 10_000_000, 'frete grátis acima de');
  if (s.minOrder != null) out.minOrder = int(s.minOrder, 0, 10_000_000, 'pedido mínimo');
  if (s.etaMinutes != null) out.etaMinutes = int(s.etaMinutes, 10, 600, 'previsão');
  if (s.deliveryArea) {
    const a = s.deliveryArea;
    out.deliveryArea = {
      ceps: (a.ceps || []).slice(0, 300).map(x => String(x).replace(/\D/g, '')).filter(x => x.length >= 3 && x.length <= 8),
      districts: (a.districts || []).slice(0, 200).map(x => str(x, 80, 'bairro')),
      center: a.center && Number.isFinite(a.center.lat) && Number.isFinite(a.center.lng) ? { lat: a.center.lat, lng: a.center.lng } : null,
      radiusKm: Number.isFinite(a.radiusKm) ? Math.min(60, Math.max(0, a.radiusKm)) : null
    };
  }
  if (s.capacity) out.capacity = { maxPerHour: s.capacity.maxPerHour != null ? int(s.capacity.maxPerHour, 1, 5000, 'limite/hora') : null, maxPerDay: s.capacity.maxPerDay != null ? int(s.capacity.maxPerDay, 1, 50000, 'limite/dia') : null, maxPerSlot: s.capacity.maxPerSlot != null ? int(s.capacity.maxPerSlot, 1, 5000, 'limite/janela') : null };
  if (s.scheduling) out.scheduling = { enabled: s.scheduling.enabled !== false, slotMinutes: int(s.scheduling.slotMinutes ?? 60, 30, 240, 'janela') };
  if (s.reservationMinutes != null) out.reservationMinutes = int(s.reservationMinutes, 5, 120, 'prazo de reserva');
  if (s.substitutionTimeoutMinutes != null) out.substitutionTimeoutMinutes = int(s.substitutionTimeoutMinutes, 5, 1440, 'prazo de substituição');
  if (s.substitutionNoResponse) out.substitutionNoResponse = ['remove_refund', 'escalate'].includes(s.substitutionNoResponse) ? s.substitutionNoResponse : fail('invalid-argument', 'Política de substituição inválida.');
  if (s.couponMaxPercent != null) out.couponMaxPercent = int(s.couponMaxPercent, 0, 100, 'limite de cupom');
  if (s.notifyPrefs) out.notifyPrefs = Object.fromEntries(Object.entries(s.notifyPrefs).slice(0, 20).map(([k, v]) => [String(k).slice(0, 30), !!v]));
  if (s.lowStockDefault != null) out.lowStockDefault = int(s.lowStockDefault, 0, 10000, 'estoque baixo');
  const ref = db.collection('markets').doc(marketId);
  const sref = ref.collection('public').doc('settings');
  const before = (await sref.get()).data() || null;
  await sref.set(out, { merge: true });
  const mPatch = {};
  if (typeof d.acceptingOrders === 'boolean') mPatch.acceptingOrders = d.acceptingOrders; // pausar não remove o mercado da vitrine
  if (d.profile) { if (d.profile.name) mPatch.name = str(d.profile.name, 120, 'nome'); if (d.profile.description !== undefined) mPatch.description = optStr(d.profile.description, 500); if (d.profile.logoUrl !== undefined) mPatch.logoUrl = optStr(d.profile.logoUrl, 500); if (d.profile.coverUrl !== undefined) mPatch.coverUrl = optStr(d.profile.coverUrl, 500); if (d.profile.address) mPatch.addressText = optStr(d.profile.address, 200); }
  if (Object.keys(mPatch).length) await ref.set(mPatch, { merge: true });
  if (d.notify) { // contatos/avisos privados (WhatsApp é opcional e só funciona após configurar o provedor)
    await ref.collection('staff').doc('_settings').set({ whatsappNumber: optStr(d.notify.whatsappNumber, 20), whatsappTypes: Array.isArray(d.notify.whatsappTypes) ? d.notify.whatsappTypes.slice(0, 20) : [], whatsappEnabled: false, updatedAt: now() }, { merge: true });
  }
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'market.settings', target: sref.path, marketId, before, after: { ...out, ...mPatch } });
  return { ok: true };
});

/* ---------- Anúncios: preço, promoção e estoque alocado ---------- */
exports.marketUpsertListing = onCall(OPTS, async (req) => {
  const d = req.data || {};
  const marketId = str(d.marketId, 100, 'mercado');
  const c = needMarket(req, marketId, 'products.read');
  const has = (p) => c.perms.includes(p);
  const gpId = d.globalProductId ? str(d.globalProductId, 100, 'produto global') : null;
  const listingId = d.id || (gpId ? `gp_${gpId}` : db.collection('markets').doc(marketId).collection('listings').doc().id);
  const ref = db.collection('markets').doc(marketId).collection('listings').doc(listingId);
  const gpRef = gpId ? db.collection('globalProducts').doc(gpId) : null;

  let out;
  await db.runTransaction(async (tx) => {
    const [cur, gp] = await Promise.all([tx.get(ref), gpRef ? tx.get(gpRef) : null]);
    if (gpRef && !gp.exists) fail('not-found', 'Produto do catálogo global não encontrado.');
    if (!cur.exists && !has('products.write')) fail('permission-denied', 'Sem permissão para cadastrar produtos.');
    const before = cur.exists ? cur.data() : {};
    const next = { ...before };

    if (!cur.exists) { // identidade
      if (gp) { const g = gp.data(); Object.assign(next, { globalProductId: gpId, name: g.name, brand: g.brand || null, barcode: g.barcode || null, size: g.size ?? null, unit: g.unit || null, categoryId: g.categoryId, imageUrl: g.imageUrl || null, local: false }); }
      else {
        Object.assign(next, { globalProductId: null, local: true, needsCatalogReview: true, name: str(d.name, 160, 'nome'), brand: optStr(d.brand, 80), barcode: d.barcode ? String(d.barcode).replace(/\D/g, '') || null : null, size: d.size != null ? Number(d.size) : null, unit: optStr(d.unit, 12), categoryId: str(d.categoryId, 80, 'categoria') });
        if (!next.unit) fail('invalid-argument', 'Informe a unidade (g, kg, ml, l, un).');
      }
      Object.assign(next, { allocated: 0, reserved: 0, committed: 0, active: false, createdAt: now() });
    } else if (next.local && has('products.write')) { // produto local pode ter nome ajustado; global nunca
      if (d.name) next.name = str(d.name, 160, 'nome'); if (d.brand !== undefined) next.brand = optStr(d.brand, 80);
    }
    next.unitLabel = [next.size != null ? next.size : null, next.unit].filter(Boolean).join(' ') || null;
    next.keywords = keywordsOf(next.name, next.brand, next.unitLabel);

    if (d.price !== undefined) {
      if (!has('products.write')) fail('permission-denied', 'Sem permissão para alterar preços.');
      next.price = int(d.price, 1, 100_000_00, 'preço');
    }
    if (next.price == null) fail('invalid-argument', 'Informe o preço.');
    if (d.promo !== undefined) {
      if (!has('promotions.write')) fail('permission-denied', 'Sem permissão para promoções.');
      next.promo = d.promo === null ? null : validatePromo(d.promo, next.price);
    }
    if (d.imageUrl !== undefined && has('products.write')) next.imageUrl = optStr(d.imageUrl, 500);
    if (d.photos !== undefined && has('products.write')) next.photos = (d.photos || []).slice(0, 5).map(u => str(u, 500, 'foto'));
    if (d.featured !== undefined && has('products.write')) next.featured = !!d.featured;
    if (d.description !== undefined && has('products.write')) next.description = optStr(d.description, 800);
    if (d.kind !== undefined && has('products.write')) next.kind = d.kind === 'combo' ? 'combo' : 'product'; // combo = produto-kit com preço e quantidade próprios
    if (d.lowStockAt !== undefined) { if (!has('stock.write')) fail('permission-denied', 'Sem permissão para estoque.'); next.lowStockAt = int(d.lowStockAt, 0, 100000, 'estoque baixo'); }
    if (d.allocated !== undefined) {
      if (!has('stock.write')) fail('permission-denied', 'Sem permissão para estoque.');
      const a = int(d.allocated, 0, 1_000_000, 'quantidade alocada');
      const min = R.minAllocation(next);
      if (a < min) fail('failed-precondition', `Não é possível alocar menos que ${min}: há unidades reservadas ou comprometidas em pedidos.`);
      next.allocated = a;
    }
    if (d.active !== undefined) {
      if (!has('products.write')) fail('permission-denied', 'Sem permissão para ativar/desativar.');
      if (d.active && R.availableQty(next) <= 0 && !cur.exists) { /* pode ficar visível como esgotado */ }
      next.active = !!d.active;
    }
    next.hasPromo = !!next.promo;
    next.stockStatus = R.stockStatus(next);
    next.updatedAt = now();
    tx.set(ref, next);
    const changed = ['price', 'promo', 'allocated', 'active', 'lowStockAt'].filter(k => JSON.stringify(before[k] ?? null) !== JSON.stringify(next[k] ?? null));
    if (!cur.exists || changed.length) {
      tx.set(db.collection('markets').doc(marketId).collection('listingHistory').doc(), { at: now(), listingId, name: next.name, by: c.uid, before: Object.fromEntries(changed.map(k => [k, before[k] ?? null])), after: Object.fromEntries(changed.map(k => [k, next[k] ?? null])) });
      audit(tx, { actor: c.uid, actorRole: c.role, action: cur.exists ? 'listing.update' : 'listing.create', target: ref.path, marketId,
        before: Object.fromEntries(changed.map(k => [k, before[k] ?? null])), after: Object.fromEntries(changed.map(k => [k, next[k] ?? null])) });
      if (changed.includes('allocated') && R.availableQty(next) <= (next.lowStockAt ?? R.DEFAULTS.lowStockDefault)) {
        notifyMarket(tx, marketId, { type: next.stockStatus === 'out_of_stock' ? 'out_of_stock' : 'low_stock', title: next.stockStatus === 'out_of_stock' ? 'Produto esgotado' : 'Estoque baixo', body: next.name, ref: listingId });
      }
    }
    out = { id: listingId, stockStatus: next.stockStatus };
  });
  return out;
});

function validatePromo(p, price) {
  const t = p.type; const base = { type: t, start: optStr(p.start, 30), end: optStr(p.end, 30) };
  if (t === 'price') { const v = int(p.price, 1, price - 1, 'preço promocional'); return { ...base, price: v }; }
  if (t === 'percent') { const v = Number(p.percent); if (!(v > 0 && v < 100)) fail('invalid-argument', 'Percentual inválido.'); return { ...base, percent: v }; }
  if (t === 'buyxpayy') { const b = int(p.buy, 2, 100, 'leve'), y = int(p.pay, 0, b - 1, 'pague'); return { ...base, buy: b, pay: y }; }
  if (t === 'tiers') { const tiers = (p.tiers || []).slice(0, 6).map(x => ({ minQty: int(x.minQty, 2, 10000, 'qtd mínima'), percent: Number(x.percent) })); if (!tiers.length || tiers.some(x => !(x.percent > 0 && x.percent < 100))) fail('invalid-argument', 'Faixas inválidas.'); return { ...base, tiers }; }
  fail('invalid-argument', 'Tipo de promoção inválido.');
}

exports.marketRemoveListing = onCall(OPTS, async (req) => {
  const d = req.data || {};
  const marketId = str(d.marketId, 100, 'mercado'); const c = needMarket(req, marketId, 'products.write');
  const ref = db.collection('markets').doc(marketId).collection('listings').doc(str(d.id, 100, 'anúncio'));
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref); if (!s.exists) return;
    const l = s.data();
    if ((l.reserved || 0) + (l.committed || 0) > 0) { tx.update(ref, { active: false, unlinked: true, updatedAt: now() }); } // obrigação de atendimento preservada
    else tx.delete(ref);
    audit(tx, { actor: c.uid, actorRole: c.role, action: 'listing.remove', target: ref.path, marketId, before: { name: l.name, price: l.price } });
  });
  return { ok: true };
});

/* ---------- Importação em massa (CSV/Excel lidos no navegador; validação e publicação aqui) ---------- */
function parseMoneyToCents(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/[R$\s]/g, '');
  const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}
const UNITS = { g: 'g', kg: 'kg', ml: 'ml', l: 'l', lt: 'l', un: 'un', und: 'un', unidade: 'un', litro: 'l', litros: 'l', grama: 'g', gramas: 'g', quilo: 'kg' };

exports.marketImportStage = onCall({ ...OPTS, timeoutSeconds: 120, memory: '512MiB' }, async (req) => {
  const d = req.data || {};
  const marketId = str(d.marketId, 100, 'mercado'); const c = needMarket(req, marketId, 'products.import');
  const rows = Array.isArray(d.rows) ? d.rows : fail('invalid-argument', 'Nenhuma linha recebida.');
  if (rows.length === 0 || rows.length > 2000) fail('invalid-argument', 'Envie entre 1 e 2000 linhas por importação.');
  const cats = new Set((await db.collection('categories').where('active', '==', true).get()).docs.map(x => x.id));
  const existing = await db.collection('markets').doc(marketId).collection('listings').get();
  const byBarcode = new Map(), byKey = new Map();
  existing.forEach(x => { const l = x.data(); if (l.barcode) byBarcode.set(l.barcode, x.id); byKey.set(`${R.normText(l.name)}|${R.normText(l.brand)}|${l.size}|${l.unit}`, x.id); });
  const seenBarcode = new Set(), seenKey = new Set();
  const impRef = db.collection('markets').doc(marketId).collection('imports').doc();
  const batchRows = []; let valid = 0, errors = 0, suspects = 0;
  rows.forEach((r, i) => {
    const errs = [], warn = [];
    const name = typeof r.name === 'string' ? r.name.trim().replace(/\s+/g, ' ') : '';
    const brand = typeof r.brand === 'string' ? r.brand.trim() : null;
    const barcode = r.barcode ? String(r.barcode).replace(/\D/g, '') : null;
    const unit = r.unit ? UNITS[R.normText(r.unit)] : null;
    const size = r.size === '' || r.size == null ? null : Number(String(r.size).replace(',', '.'));
    const price = parseMoneyToCents(r.price);
    const allocatedRaw = r.allocated;
    const allocated = allocatedRaw === '' || allocatedRaw == null ? null : Number(allocatedRaw);
    const categoryId = r.categoryId ? String(r.categoryId).trim() : null;
    if (!name || name.length > 160) errs.push('nome ausente ou longo demais');
    if (price == null) errs.push('preço ausente ou inválido (não é inventado)');
    if (!unit) errs.push('unidade ausente ou desconhecida (g, kg, ml, l, un)');
    if (size != null && !(size > 0)) errs.push('tamanho/peso inválido');
    if (allocated == null || !Number.isInteger(allocated) || allocated < 0) errs.push('quantidade alocada ausente ou inválida (não é inventada)');
    if (!categoryId || !cats.has(categoryId)) errs.push('categoria inexistente ou inativa');
    if (barcode && ![8, 12, 13, 14].includes(barcode.length)) errs.push('código de barras inválido');
    let status = errs.length ? 'error' : 'valid'; let dupOf = null;
    if (!errs.length) {
      const key = `${R.normText(name)}|${R.normText(brand)}|${size}|${unit}`;
      if (barcode && (byBarcode.has(barcode) || seenBarcode.has(barcode))) { status = 'duplicate_suspect'; dupOf = byBarcode.get(barcode) || 'arquivo'; warn.push('código de barras já existe'); }
      else if (byKey.has(key) || seenKey.has(key)) { status = 'duplicate_suspect'; dupOf = byKey.get(key) || 'arquivo'; warn.push('mesmo nome, marca e tamanho já existem'); }
      if (barcode) seenBarcode.add(barcode); seenKey.add(key);
      if (price > 1_000_00) warn.push('preço muito alto, confira'); // conferência de preço
    }
    if (status === 'valid') valid++; else if (status === 'error') errors++; else suspects++;
    batchRows.push({ line: i + 2, status, errors: errs, warnings: warn, dupOf, data: { name, brand, barcode, unit, size, price, allocated, categoryId }, raw: r });
  });
  const wb = db.batch();
  wb.set(impRef, { status: 'review', fileName: optStr(d.fileName, 200), total: rows.length, valid, errors, suspects, createdBy: c.uid, createdAt: now(), mapping: d.mapping || null });
  await wb.commit();
  for (let i = 0; i < batchRows.length; i += 400) {
    const b = db.batch();
    batchRows.slice(i, i + 400).forEach((row, j) => b.set(impRef.collection('rows').doc(String(i + j).padStart(5, '0')), row));
    await b.commit();
  }
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'import.stage', target: impRef.path, marketId, after: { total: rows.length, valid, errors, suspects } });
  return { importId: impRef.id, total: rows.length, valid, errors, suspects };
});

exports.marketImportApprove = onCall({ ...OPTS, timeoutSeconds: 300, memory: '512MiB' }, async (req) => {
  const d = req.data || {};
  const marketId = str(d.marketId, 100, 'mercado'); const c = needMarket(req, marketId, 'products.import.approve');
  const impRef = db.collection('markets').doc(marketId).collection('imports').doc(str(d.importId, 100, 'importação'));
  const imp = await impRef.get(); if (!imp.exists) fail('not-found', 'Importação não encontrada.');
  const accept = new Set(Array.isArray(d.acceptSuspectIds) ? d.acceptSuspectIds : []);
  const snap = await impRef.collection('rows').get();
  let published = 0, skipped = 0, failed = 0;
  const todo = snap.docs.filter(r => { const x = r.data(); return x.status === 'valid' || (x.status === 'duplicate_suspect' && accept.has(r.id)); });
  for (let i = 0; i < todo.length; i += 200) {
    const b = db.batch();
    for (const r of todo.slice(i, i + 200)) {
      const x = r.data().data;
      let gp = null;
      if (x.barcode) { const g = await db.collection('globalProducts').where('barcode', '==', x.barcode).limit(1).get(); if (!g.empty) gp = { id: g.docs[0].id, ...g.docs[0].data() }; }
      const id = gp ? `gp_${gp.id}` : db.collection('markets').doc(marketId).collection('listings').doc().id;
      const lref = db.collection('markets').doc(marketId).collection('listings').doc(id);
      const l = gp
        ? { globalProductId: gp.id, local: false, name: gp.name, brand: gp.brand || null, barcode: gp.barcode, size: gp.size ?? x.size, unit: gp.unit || x.unit, categoryId: gp.categoryId, imageUrl: gp.imageUrl || null }
        : { globalProductId: null, local: true, needsCatalogReview: true, name: x.name, brand: x.brand, barcode: x.barcode, size: x.size, unit: x.unit, categoryId: x.categoryId };
      l.unitLabel = [l.size, l.unit].filter(Boolean).join(' ') || null;
      Object.assign(l, { hasPromo: false, price: x.price, allocated: x.allocated, reserved: 0, committed: 0, active: x.allocated > 0, createdAt: now(), updatedAt: now(), importId: imp.id, keywords: keywordsOf(l.name, l.brand, l.unitLabel) });
      l.stockStatus = R.stockStatus(l);
      const exists = (await lref.get()).exists;
      if (exists) { skipped++; b.update(r.ref, { status: 'skipped_exists' }); continue; }
      b.set(lref, l); b.update(r.ref, { status: 'published', listingId: id }); published++;
    }
    await b.commit();
  }
  const remaining = snap.docs.filter(r => ['error', 'duplicate_suspect'].includes(r.data().status) && !accept.has(r.id)).length;
  await impRef.update({ status: remaining ? 'partial' : 'published', published: FV.increment(published), approvedBy: c.uid, approvedAt: now() });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'import.publish', target: impRef.path, marketId, after: { published, skipped, remaining } });
  return { published, skipped, failed, remaining }; // pode ser chamado de novo para retomar
});

exports.marketUpsertCoupon = onCall(OPTS, async (req) => {
  const d = req.data || {};
  const marketId = str(d.marketId, 100, 'mercado'); const c = needMarket(req, marketId, 'promotions.write');
  const code = (marketId.slice(0, 4) + '-' + str(d.code, 20, 'código')).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!['percent', 'fixed', 'freeShipping'].includes(d.type)) fail('invalid-argument', 'Tipo de cupom inválido.');
  const doc = { code, type: d.type, value: d.type === 'freeShipping' ? 0 : Number(d.value), fundedBy: 'market', marketId, minOrder: d.minOrder != null ? int(d.minOrder, 0, 10_000_000, 'pedido mínimo') : null,
    maxUses: d.maxUses != null ? int(d.maxUses, 1, 1_000_000, 'limite') : null, maxUsesPerUser: d.maxUsesPerUser != null ? int(d.maxUsesPerUser, 1, 100, 'limite por cliente') : null,
    validFrom: optStr(d.validFrom, 30), validTo: optStr(d.validTo, 30), stackWithPromo: d.stackWithPromo === true, visibility: d.visibility === 'public' ? 'public' : 'private', firstOrderOnly: d.firstOrderOnly === true, productIds: Array.isArray(d.productIds) ? d.productIds.slice(0, 200).map(String) : [], categoryIds: Array.isArray(d.categoryIds) ? d.categoryIds.slice(0, 50).map(String) : [], active: d.active !== false, updatedAt: now() };
  if (doc.type === 'percent' && !(doc.value > 0 && doc.value <= 100)) fail('invalid-argument', 'Percentual inválido.');
  if (doc.type === 'fixed' && !(doc.value > 0)) fail('invalid-argument', 'Valor inválido.');
  const ref = db.collection('coupons').doc(code); const cur = await ref.get();
  if (cur.exists && cur.data().marketId !== marketId) fail('permission-denied', 'Este código pertence a outro mercado.');
  await ref.set(cur.exists ? doc : { ...doc, usedCount: 0, createdAt: now(), createdBy: c.uid }, { merge: true });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'coupon.market_upsert', target: ref.path, marketId, before: cur.data() || null, after: doc });
  return { code };
});

/* ============================ Cliente: cotação, opções de entrega e checkout ============================ */
async function loadListingsPlain(marketId, ids) {
  const refs = ids.map(id => db.collection('markets').doc(marketId).collection('listings').doc(id));
  const snaps = refs.length ? await db.getAll(...refs) : [];
  const out = {}; snaps.forEach(s => { if (s.exists) out[s.id] = s.data(); }); return out;
}
async function paidOrderCount(uid) { const q = await db.collection('orders').where('customerId', '==', uid).get(); return q.docs.filter(x => !['awaiting_payment', 'cancelled'].includes(x.data().status)).length; }
function cleanItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 150) fail('invalid-argument', 'Carrinho vazio ou grande demais.');
  const m = new Map();
  for (const it of items) { const id = str(it.listingId, 100, 'produto'); const q = int(it.qty, 1, 500, 'quantidade'); m.set(id, (m.get(id) || 0) + q); }
  return [...m].map(([listingId, qty]) => ({ listingId, qty }));
}
function slotKey(iso) { return iso.replace(/[:.]/g, '-'); }
function hourKey(d) { return `h-${R.ymd(d)}T${String(d.getHours()).padStart(2, '0')}`; }

exports.quoteCart = onCall(OPTS, async (req) => {
  const d = req.data || {};
  const marketId = str(d.marketId, 100, 'mercado');
  const items = cleanItems(d.items);
  const { market, admin: a, settings } = await marketBundle(marketId);
  const listings = await loadListingsPlain(marketId, items.map(i => i.listingId));
  let coupon = null, userUses = 0; const userOrders = req.auth ? await paidOrderCount(req.auth.uid) : 0;
  if (d.coupon && req.auth) {
    const cs = await db.collection('coupons').doc(String(d.coupon).toUpperCase()).get();
    coupon = cs.exists ? cs.data() : { active: false };
    userUses = (await db.collection('users').doc(req.auth.uid).collection('couponUses').doc(String(d.coupon).toUpperCase()).get()).data()?.count || 0;
  } else if (d.coupon) fail('unauthenticated', 'Entre na sua conta para aplicar cupons.');
  const q = R.computeQuote({ marketId, userId: req.auth?.uid, userUses, userOrders, items, listings, coupon, expectedPrices: d.expectedPrices || null,
    market: { commissionRate: a.commissionRate, deliveryFee: settings.deliveryFee, freeShippingAbove: settings.freeShippingAbove } });
  if (settings.minOrder && q.totals.itemsPaid < settings.minOrder) q.issues.push({ code: 'MIN_ORDER', msg: `Pedido mínimo deste mercado: R$ ${(settings.minOrder / 100).toFixed(2).replace('.', ',')}.` });
  // A comissão e o repasse não são expostos ao cliente.
  const { commission, marketReceivable, platformNet, platformSubsidy, commissionRate, ...pub } = q.totals;
  return { lines: q.lines, issues: q.issues, totals: pub, coupon: q.coupon, blocking: q.blocking || q.issues.some(i => i.code === 'MIN_ORDER'), priceChanged: q.priceChanged, acceptingOrders: market.status === 'active' && market.acceptingOrders !== false };
});

exports.getCheckoutOptions = onCall(OPTS, async (req) => {
  const d = req.data || {};
  const marketId = str(d.marketId, 100, 'mercado');
  const { market, settings } = await marketBundle(marketId);
  const cfg = await platformConfig();
  const addr = d.address || {};
  const covers = R.coversAddress(settings.deliveryArea, { cep: addr.cep, district: addr.district, lat: addr.lat, lng: addr.lng });
  const active = market.status === 'active';
  const accepting = active && market.acceptingOrders !== false;
  const nowD = new Date();
  const openNow = R.isOpenAt(settings.hours, settings.closedDates, nowD);
  let slots = [];
  if (covers && accepting && settings.scheduling?.enabled !== false) {
    const cs = await db.collection('markets').doc(marketId).collection('counters').get();
    const counts = {}; cs.forEach(x => { counts[x.id] = x.data().count || 0; });
    const raw = R.scheduleSlots({ hours: settings.hours, closedDates: settings.closedDates || [], now: nowD, businessDays: cfg.scheduleBusinessDays, slotMinutes: settings.scheduling?.slotMinutes || 60 });
    const maxSlot = settings.capacity?.maxPerSlot ?? Infinity;
    slots = raw.filter(s => (counts['s-' + slotKey(s.start)] || 0) < maxSlot);
  }
  const hourCount = (await db.collection('markets').doc(marketId).collection('counters').doc(hourKey(nowD)).get()).data()?.count || 0;
  const asapOk = covers && accepting && openNow && !(settings.capacity?.maxPerHour && hourCount >= settings.capacity.maxPerHour);
  return {
    covers, accepting, openNow, asapAvailable: !!asapOk, etaMinutes: settings.etaMinutes || 60, deliveryFee: settings.deliveryFee ?? 0,
    freeShippingAbove: settings.freeShippingAbove ?? null, minOrder: settings.minOrder ?? 0, slots,
    reason: !active ? 'Mercado indisponível.' : !accepting ? 'Este mercado pausou novos pedidos temporariamente.' : !covers ? 'Este mercado não entrega no endereço informado.' : !openNow && !slots.length ? 'Fora do horário de atendimento.' : null
  };
});

async function loadOrderIfSame(uid, key) {
  const s = await db.collection('idempotency').doc(`${uid}_${key}`).get();
  return s.exists ? s.data() : null;
}

exports.createCheckout = onCall({ ...OPTS, timeoutSeconds: 60 }, async (req) => {
  const c = claims(req);
  const d = req.data || {};
  const marketId = str(d.marketId, 100, 'mercado');
  const items = cleanItems(d.items);
  const method = ['pix', 'debit', 'credit'].includes(d.method) ? d.method : fail('invalid-argument', 'Forma de pagamento inválida.');
  const idemKey = str(d.idempotencyKey, 80, 'chave de idempotência');
  const prior = await loadOrderIfSame(c.uid, idemKey);
  if (prior) { const p = await db.collection('payments').doc(prior.orderId).get(); return { orderId: prior.orderId, duplicate: true, payment: p.data()?.public || null }; }

  const provider = getProvider();

  const cfg = await platformConfig();
  const { market, admin: a, settings } = await marketBundle(marketId);
  if (market.status !== 'active') fail('failed-precondition', 'Este mercado não está disponível.');
  if (market.acceptingOrders === false) fail('failed-precondition', 'Este mercado pausou novos pedidos temporariamente.');
  if (a.commissionRate == null) fail('failed-precondition', 'Mercado sem configuração financeira completa.');

  // Endereço do cliente (leitura confiável, dono verificado) + cobertura
  const addrSnap = await db.collection('users').doc(c.uid).collection('addresses').doc(str(d.addressId, 100, 'endereço')).get();
  if (!addrSnap.exists) fail('not-found', 'Endereço não encontrado.');
  const address = addrSnap.data();
  if (!R.coversAddress(settings.deliveryArea, address)) fail('failed-precondition', 'Este mercado não entrega no endereço escolhido.');

  // Janela de entrega
  const nowD = new Date();
  let delivery;
  const mode = d.schedule?.mode === 'scheduled' ? 'scheduled' : 'asap';
  const counterRefs = [];
  if (mode === 'asap') {
    if (!R.isOpenAt(settings.hours, settings.closedDates, nowD)) fail('failed-precondition', 'O mercado está fora do horário de atendimento. Agende uma entrega.');
    delivery = { mode, etaAt: TS.fromMillis(Date.now() + (settings.etaMinutes || 60) * 60000) };
    counterRefs.push({ ref: db.collection('markets').doc(marketId).collection('counters').doc(hourKey(nowD)), limit: settings.capacity?.maxPerHour });
    counterRefs.push({ ref: db.collection('markets').doc(marketId).collection('counters').doc('d-' + R.ymd(nowD)), limit: settings.capacity?.maxPerDay });
  } else {
    if (settings.scheduling?.enabled === false) fail('failed-precondition', 'Este mercado não aceita agendamento.');
    const start = str(d.schedule.slotStart, 40, 'janela');
    const valid = R.scheduleSlots({ hours: settings.hours, closedDates: settings.closedDates || [], now: nowD, businessDays: cfg.scheduleBusinessDays, slotMinutes: settings.scheduling?.slotMinutes || 60 }).find(s => s.start === start);
    if (!valid) fail('failed-precondition', 'Esta janela de entrega não está mais disponível. Escolha outra.');
    delivery = { mode, scheduledStart: TS.fromMillis(Date.parse(valid.start)), scheduledEnd: TS.fromMillis(Date.parse(valid.end)), etaAt: TS.fromMillis(Date.parse(valid.end)) };
    counterRefs.push({ ref: db.collection('markets').doc(marketId).collection('counters').doc('s-' + slotKey(valid.start)), limit: settings.capacity?.maxPerSlot });
    counterRefs.push({ ref: db.collection('markets').doc(marketId).collection('counters').doc('d-' + R.ymd(new Date(valid.start))), limit: settings.capacity?.maxPerDay });
  }

  const priorOrders = await paidOrderCount(c.uid);
  const orderRef = db.collection('orders').doc();
  const orderId = orderRef.id;
  const listingRefs = items.map(i => db.collection('markets').doc(marketId).collection('listings').doc(i.listingId));
  const couponCode = d.coupon ? String(d.coupon).toUpperCase() : null;
  const expiresAt = plusMin(settings.reservationMinutes || cfg.reservationMinutes);
  let result;

  await db.runTransaction(async (tx) => {
    // ---- leituras ----
    const [lsnaps, csnap, usesSnap, ctrs, idem] = await Promise.all([
      tx.getAll(...listingRefs),
      couponCode ? tx.get(db.collection('coupons').doc(couponCode)) : null,
      couponCode ? tx.get(db.collection('users').doc(c.uid).collection('couponUses').doc(couponCode)) : null,
      Promise.all(counterRefs.map(x => tx.get(x.ref))),
      tx.get(db.collection('idempotency').doc(`${c.uid}_${idemKey}`))
    ]);
    if (idem.exists) fail('already-exists', 'Requisição duplicada.');
    const listings = {}; lsnaps.forEach(s => { if (s.exists) listings[s.id] = s.data(); });
    const q = R.computeQuote({ nowMs: Date.now(), marketId, userId: c.uid, userUses: usesSnap?.data()?.count || 0, userOrders: priorOrders, items, listings, coupon: csnap ? (csnap.exists ? csnap.data() : { active: false }) : null,
      expectedPrices: d.expectedPrices || null, market: { commissionRate: a.commissionRate, deliveryFee: settings.deliveryFee, freeShippingAbove: settings.freeShippingAbove } });
    if (settings.minOrder && q.totals.itemsPaid < settings.minOrder) q.issues.push({ code: 'MIN_ORDER', msg: 'Pedido abaixo do mínimo do mercado.' });
    const blocking = q.blocking || q.issues.some(i => i.code === 'MIN_ORDER');
    // O cliente precisa ter VISTO e aceitado o total exato; qualquer divergência volta para revisão (nada é cobrado em silêncio).
    if (blocking || q.priceChanged || d.expectedTotal !== q.totals.total) { result = { needsReview: true, issues: q.issues, totals: q.totals, lines: q.lines }; return; }
    for (let i = 0; i < counterRefs.length; i++) { const lim = counterRefs[i].limit; if (lim && (ctrs[i].data()?.count || 0) >= lim) fail('resource-exhausted', 'A capacidade deste horário foi atingida. Escolha outro horário.'); }

    // ---- escritas: reserva atômica de estoque ----
    for (let i = 0; i < items.length; i++) {
      const l = listings[items[i].listingId];
      tx.update(listingRefs[i], { reserved: FV.increment(items[i].qty), stockStatus: R.stockStatus({ ...l, reserved: (l.reserved || 0) + items[i].qty }), updatedAt: now() });
    }
    counterRefs.forEach(x => tx.set(x.ref, { count: FV.increment(1) }, { merge: true }));
    const lines = R.allocatePaidPerLine(q.lines, q.totals.couponDiscountMarket, q.totals.couponDiscountPlatform).map(l => ({ ...l, globalProductId: listings[l.listingId].globalProductId || null, unit: listings[l.listingId].unit || null }));
    tx.set(db.collection('reservations').doc(orderId), { orderId, marketId, customerId: c.uid, status: 'active', items: items, createdAt: now(), expiresAt });
    tx.set(orderRef, {
      customerId: c.uid, marketId, marketName: market.name, cityId: market.cityId || null, status: 'awaiting_payment', items: lines, totals: q.totals, final: q.totals,
      coupon: q.coupon, address: { ...address, recipient: address.recipient || null }, delivery, payment: { method, status: 'pending' }, commissionRate: q.totals.commissionRate,
      createdAt: now(), expiresAt, idempotencyKey: idemKey, refundedTotal: 0, refunds: [], payoutId: null,
      snapshot: { commissionRate: q.totals.commissionRate, deliveryFee: settings.deliveryFee ?? 0, freeShippingAbove: settings.freeShippingAbove ?? null, minOrder: settings.minOrder ?? 0, reservationMinutes: settings.reservationMinutes || cfg.reservationMinutes, substitutionTimeoutMinutes: settings.substitutionTimeoutMinutes || cfg.substitutionTimeoutMinutes, substitutionNoResponse: settings.substitutionNoResponse || 'remove_refund', etaMinutes: settings.etaMinutes || 60, at: TS.now() }
    });
    tx.set(db.collection('idempotency').doc(`${c.uid}_${idemKey}`), { orderId, at: now() });
    orderEvent(tx, orderId, { type: 'created', actor: c.uid, to: 'awaiting_payment', data: { total: q.totals.total } });
    result = { orderId, totals: q.totals, expiresAt: expiresAt.toMillis() };
  });
  if (result.needsReview) return result;

  // ---- cobrança no provedor (fora da transação) ----
  try {
    const split = R.paymentSplit({ totals: result.totals });
    const ch = await provider.createCharge({ orderId, amount: result.totals.total, method, split: { ...split, marketAccountId: a.paymentAccountId || null },
      customer: { id: c.uid, email: c.email }, idempotencyKey: `${orderId}:charge`, expiresAt: expiresAt.toMillis(), cardToken: d.cardToken || null, kind: 'order' });
    const pub = { method, status: ch.status, pix: ch.pix || null, redirectUrl: ch.redirectUrl || null, expiresAt: expiresAt.toMillis() };
    await db.collection('payments').doc(orderId).set({ orderId, customerId: c.uid, marketId, provider: provider.name, providerChargeId: ch.providerChargeId, method, amount: result.totals.total, split, status: ch.status, lastSeq: 0, public: pub, createdAt: now() });
    await db.collection('orders').doc(orderId).update({ 'payment.pix': ch.pix || null, 'payment.redirectUrl': ch.redirectUrl || null }); // dados que o próprio cliente precisa para pagar
    if (ch.status === 'paid') await confirmPayment(orderId, { paidAmount: result.totals.total, source: 'sync' });
    return { orderId, totals: result.totals, payment: pub };
  } catch (e) {
    await cancelPendingOrder(orderId, 'payment_init_failed', { skipProviderCheck: true }).catch(() => {});
    if (e instanceof HttpsError) throw e;
    console.error('createCharge falhou', orderId, e);
    fail('unavailable', 'Não foi possível iniciar o pagamento agora. Nada foi cobrado. Tente novamente.');
  }
});

/* ============================ Pagamento: confirmação, expiração, cancelamento ============================ */
function randomCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

/**
 * Única porta para marcar um pedido como pago. Chamada SOMENTE pelo webhook verificado ou pela verificação
 * com o provedor (getCharge). O navegador não tem como chegar aqui.
 */
async function confirmPayment(orderId, info) {
  const orderRef = db.collection('orders').doc(orderId);
  const payRef = db.collection('payments').doc(orderId);
  const resRef = db.collection('reservations').doc(orderId);
  let outcome = { done: false };
  await db.runTransaction(async (tx) => {
    const [o, p, r] = await Promise.all([tx.get(orderRef), tx.get(payRef), tx.get(resRef)]);
    if (!o.exists || !p.exists) fail('not-found', 'Pedido ou pagamento inexistente.');
    const order = o.data();
    if (['confirmed', 'picking', 'picked', 'ready_for_dispatch', 'out_for_delivery', 'delivered', 'completed', 'delivery_failed'].includes(order.status)) { outcome = { done: true, idempotent: true }; return; }
    if (info.paidAmount !== order.totals.total) {
      tx.update(payRef, { status: 'amount_mismatch', mismatch: { expected: order.totals.total, got: info.paidAmount }, updatedAt: now() });
      tx.set(db.collection('tickets').doc(), { requesterId: order.customerId, requesterRole: 'system', marketId: order.marketId, orderId, category: 'payment_mismatch', subject: `Valor pago diverge do pedido ${orderId}`, status: 'open', priority: 'high', createdAt: now() });
      audit(tx, { actor: 'system', action: 'payment.mismatch', target: payRef.path, marketId: order.marketId, after: { expected: order.totals.total, got: info.paidAmount } });
      outcome = { done: false, mismatch: true }; return;
    }
    const listingRefs = order.items.map(i => db.collection('markets').doc(order.marketId).collection('listings').doc(i.listingId));
    const lsnaps = await tx.getAll(...listingRefs);
    const couponRef = order.coupon?.code ? db.collection('coupons').doc(order.coupon.code) : null;
    const usesRef = order.coupon?.code ? db.collection('users').doc(order.customerId).collection('couponUses').doc(order.coupon.code) : null;
    const reservationActive = r.exists && r.data().status === 'active' && order.status === 'awaiting_payment';

    if (!reservationActive) { // pagamento tardio (reserva já liberada): só confirma se o estoque ainda permitir
      const ok = lsnaps.every((s, i) => s.exists && R.availableQty(s.data()) >= order.items[i].qty && s.data().active !== false);
      if (!ok || order.status !== 'cancelled') {
        tx.update(payRef, { status: 'paid_needs_refund', paidAmount: info.paidAmount, updatedAt: now() });
        tx.update(orderRef, { 'payment.status': 'paid_late_refund_due' });
        orderEvent(tx, orderId, { type: 'late_payment_unfulfillable', data: { status: order.status } });
        outcome = { done: false, late: true, refund: true, amount: info.paidAmount }; return;
      }
      lsnaps.forEach((s, i) => tx.update(listingRefs[i], { committed: FV.increment(order.items[i].qty), stockStatus: R.stockStatus({ ...s.data(), committed: (s.data().committed || 0) + order.items[i].qty }) }));
    } else {
      lsnaps.forEach((s, i) => { const l = s.data(), q = order.items[i].qty; tx.update(listingRefs[i], { reserved: FV.increment(-q), committed: FV.increment(q), stockStatus: R.stockStatus({ ...l, reserved: Math.max(0, (l.reserved || 0) - q), committed: (l.committed || 0) + q }) }); });
      tx.update(resRef, { status: 'committed', committedAt: now() });
    }
    tx.update(orderRef, { status: 'confirmed', queue: 'picking', confirmedAt: now(), 'payment.status': 'paid', 'payment.paidAt': now() });
    tx.update(payRef, { status: 'paid', paidAmount: info.paidAmount, paidAt: now(), providerFee: info.providerFee ?? null });
    tx.set(orderRef.collection('secrets').doc('delivery'), { code: randomCode(), attempts: 0, used: false, lockedUntil: null, createdAt: now() });
    if (couponRef) { tx.update(couponRef, { usedCount: FV.increment(1) }); tx.set(usesRef, { count: FV.increment(1) }, { merge: true }); }
    const t = order.totals;
    ledger(tx, { id: `sale_${orderId}`, type: 'sale', orderId, marketId: order.marketId, amount: t.total, meta: { itemsPaid: t.itemsPaid, deliveryPaid: t.deliveryPaid, commission: t.commission, platformSubsidy: t.platformSubsidy, marketReceivable: t.marketReceivable } });
    orderEvent(tx, orderId, { type: 'payment_confirmed', from: order.status, to: 'confirmed', data: { source: info.source || 'webhook' } });
    notifyMarket(tx, order.marketId, { type: 'new_order', title: 'Novo pedido pago', body: `Pedido ${orderId.slice(0, 6).toUpperCase()} aguardando separação`, ref: orderId });
    notifyUser(tx, order.customerId, { type: 'payment_confirmed', title: 'Pagamento confirmado', body: 'Seu pedido entrou na fila de separação.', ref: orderId });
    audit(tx, { actor: 'system', action: 'payment.confirmed', target: orderRef.path, marketId: order.marketId, after: { amount: info.paidAmount } });
    outcome = { done: true };
  });
  if (outcome.refund) await startRefund(orderId, outcome.amount, 'late_payment', { full: false, force: true });
  return outcome;
}

async function cancelPendingOrder(orderId, reason, opts = {}) {
  const orderRef = db.collection('orders').doc(orderId);
  const payRef = db.collection('payments').doc(orderId);
  if (!opts.skipProviderCheck) {
    // Antes de cancelar/liberar estoque, confirma o estado REAL no provedor.
    const p = await payRef.get();
    if (p.exists && p.data().providerChargeId) {
      const ch = await getProvider().getCharge(p.data().providerChargeId); // se falhar, a exceção impede o cancelamento
      if (ch.status === 'paid') { await confirmPayment(orderId, { paidAmount: ch.paidAmount, source: 'verify', providerFee: ch.providerFee }); return { confirmed: true }; }
    }
  }
  let out = { cancelled: false };
  await db.runTransaction(async (tx) => {
    const [o, r] = await Promise.all([tx.get(orderRef), tx.get(db.collection('reservations').doc(orderId))]);
    if (!o.exists || o.data().status !== 'awaiting_payment') return;
    const order = o.data();
    const refs = order.items.map(i => db.collection('markets').doc(order.marketId).collection('listings').doc(i.listingId));
    const snaps = await tx.getAll(...refs);
    if (r.exists && r.data().status === 'active') {
      snaps.forEach((s, i) => { if (s.exists) { const l = s.data(), q = order.items[i].qty; tx.update(refs[i], { reserved: FV.increment(-q), stockStatus: R.stockStatus({ ...l, reserved: Math.max(0, (l.reserved || 0) - q) }) }); } });
      tx.update(r.ref, { status: 'released', releasedAt: now(), reason });
      await decrementCounters(tx, order);
    }
    tx.update(orderRef, { status: 'cancelled', cancelledAt: now(), cancelReason: reason, 'payment.status': 'cancelled' });
    if (payRef) tx.set(payRef, { status: 'cancelled', updatedAt: now() }, { merge: true });
    orderEvent(tx, orderId, { type: 'cancelled', from: 'awaiting_payment', to: 'cancelled', data: { reason } });
    notifyUser(tx, order.customerId, { type: 'order_cancelled', title: 'Pedido cancelado', body: reason === 'expired' ? 'O prazo de pagamento terminou.' : 'Pedido cancelado.', ref: orderId });
    out = { cancelled: true };
  });
  return out;
}

async function decrementCounters(tx, order) {
  const base = db.collection('markets').doc(order.marketId).collection('counters');
  const ids = [];
  const created = order.createdAt.toDate();
  if (order.delivery.mode === 'asap') { ids.push(hourKey(created), 'd-' + R.ymd(created)); }
  else { const st = order.delivery.scheduledStart.toDate(); ids.push('s-' + slotKey(st.toISOString()), 'd-' + R.ymd(st)); }
  ids.forEach(id => tx.set(base.doc(id), { count: FV.increment(-1) }, { merge: true }));
}

exports.expireStaleOrders = onSchedule({}, async () => {
  const q = await db.collection('orders').where('status', '==', 'awaiting_payment').where('expiresAt', '<=', TS.now()).limit(500).get();
  for (const doc of q.docs) {
    try { await cancelPendingOrder(doc.id, 'expired'); }
    catch (e) { console.warn('expiração adiada (provedor indisponível?)', doc.id, e.message); } // sem verificação não há cancelamento
  }
});

/** Processa um evento do provedor SIMULADO (equivalente ao webhook assinado do original). Idempotente por id de evento. */
async function processProviderEvent(ev) {
  const provider = getProvider();
  const evRef = db.collection('webhookEvents').doc(String(ev.id));
  try { await evRef.create({ type: ev.type, chargeId: ev.chargeId, receivedAt: now(), status: 'processing' }); }
  catch (e) { return 'duplicate'; }
  try {
    const paySnap = await db.collection('payments').where('providerChargeId', '==', ev.chargeId).limit(1).get();
    if (paySnap.empty) { await evRef.update({ status: 'unmatched' }); return 'unmatched'; }
    const pay = paySnap.docs[0]; const orderId = pay.data().orderId || pay.id;
    if (ev.type === 'charge.paid') {
      const ch = await provider.getCharge(ev.chargeId);
      if (ch.status === 'paid') {
        if (pay.data().kind === 'substitution_extra') await applySubstitutionPaid(pay.data(), ch);
        else await confirmPayment(orderId, { paidAmount: ch.paidAmount, source: 'simulacao', providerFee: ch.providerFee });
      }
    } else if (ev.type === 'charge.expired') {
      if (pay.data().kind !== 'substitution_extra') await cancelPendingOrder(orderId, 'expired');
    } else if (ev.type === 'refund.done') {
      await markRefundDone(orderId, ev.refundId);
    }
    await evRef.update({ status: 'done', doneAt: now() });
    return 'ok';
  } catch (e) { await evRef.delete().catch(() => {}); throw e; }
}

/* ---------- Reembolsos ---------- */
async function startRefund(orderId, amount, reason, opts = {}) {
  if (!(amount > 0)) return null;
  const provider = getProvider();
  const orderRef = db.collection('orders').doc(orderId);
  const pay = (await db.collection('payments').doc(orderId).get()).data();
  if (!pay || !pay.providerChargeId) fail('failed-precondition', 'Pedido sem cobrança no provedor.');
  const refundId = db.collection('_').doc().id;
  let seq;
  await db.runTransaction(async (tx) => {
    const o = (await tx.get(orderRef)).data();
    seq = (o.refunds || []).length + 1;
    const already = (o.refundedTotal || 0);
    if (!opts.force && already + amount > o.totals.total) fail('failed-precondition', 'Reembolso maior que o valor pago.');
    tx.update(orderRef, { refunds: FV.arrayUnion({ id: refundId, amount, reason, status: 'pending', at: TS.now(), ...(opts.adjust ? { adjust: true } : {}) }), refundedTotal: FV.increment(amount), ...(opts.full ? { status: 'refund_processing', refundFinalTo: 'refunded' } : {}) });
    ledger(tx, { id: `refund_pending_${refundId}`, type: 'refund_pending', orderId, marketId: o.marketId, amount: -amount, meta: { reason, refundId } });
    orderEvent(tx, orderId, { type: 'refund_requested', data: { amount, reason }, ...(opts.full ? { from: o.status, to: 'refund_processing' } : {}) });
    notifyUser(tx, o.customerId, { type: 'refund', title: 'Reembolso em processamento', body: `R$ ${(amount / 100).toFixed(2).replace('.', ',')}`, ref: orderId });
    notifyMarket(tx, o.marketId, { type: 'refund', title: 'Reembolso solicitado', body: reason, ref: orderId });
  });
  const r = await provider.refund({ providerChargeId: pay.providerChargeId, amount, idempotencyKey: `${orderId}:refund:${seq}:${amount}`, reason });
  await orderRef.update({ [`refundProvider.${refundId}`]: r.providerRefundId });
  await db.collection('payments').doc(orderId).set({ refunds: FV.arrayUnion({ refundId, providerRefundId: r.providerRefundId, amount, at: TS.now() }) }, { merge: true });
  if (r.status === 'done') await markRefundDone(orderId, r.providerRefundId, refundId);
  return { refundId };
}

async function markRefundDone(orderId, providerRefundId, knownRefundId) {
  const orderRef = db.collection('orders').doc(orderId);
  await db.runTransaction(async (tx) => {
    const o = await tx.get(orderRef); if (!o.exists) return;
    const order = o.data();
    const map = order.refundProvider || {};
    const refundId = knownRefundId || Object.keys(map).find(k => map[k] === providerRefundId);
    let amount = 0;
    const refunds = (order.refunds || []).map(r => { if (r.id === refundId && r.status !== 'done') { amount = r.amount; return { ...r, status: 'done', doneAt: TS.now() }; } return r; });
    if (!amount) return; // evento repetido
    const patch = { refunds };
    const allDone = refunds.every(r => r.status === 'done');
    if (order.status === 'refund_processing' && allDone) patch.status = order.refundFinalTo || 'refunded';
    const done = (order.refunds || []).find(r => r.id === refundId);
    if (done && done.adjust) { // reembolso pós-entrega: reduz proporcionalmente (sobre os valores originais) o que cabe ao mercado e à plataforma
      const f = { ...(order.final || order.totals) }; const orig = f.orig || { total: order.totals.total, marketReceivable: f.marketReceivable, commission: f.commission, itemsPaid: f.itemsPaid };
      const adjSum = refunds.filter(r => r.status === 'done' && r.adjust).reduce((acc, r) => acc + r.amount, 0); const keep = Math.max(0, 1 - adjSum / orig.total);
      const nf = { marketReceivable: Math.round(orig.marketReceivable * keep), commission: Math.round(orig.commission * keep), itemsPaid: Math.round(orig.itemsPaid * keep) };
      const dRecv = f.marketReceivable - nf.marketReceivable, dComm = f.commission - nf.commission;
      if (order.status === 'completed') {
        ledger(tx, { id: `mrefund_${refundId}`, type: 'market_refund_debit', orderId, marketId: order.marketId, amount: -dRecv, meta: { refundId } });
        ledger(tx, { id: `commadj_${refundId}`, type: 'commission_adjust', orderId, marketId: order.marketId, amount: -dComm, meta: { refundId } });
      }
      patch.final = { ...f, ...nf, orig };
    }
    ledger(tx, { id: `refund_done_${refundId}`, type: 'refund_done', orderId, marketId: order.marketId, amount: -amount, meta: { refundId, providerRefundId } });
    orderEvent(tx, orderId, { type: 'refund_done', data: { amount }, ...(patch.status ? { from: 'refund_processing', to: patch.status } : {}) });
    { const doneSum = refunds.filter(r => r.status === 'done').reduce((a, r) => a + r.amount, 0); const ps = doneSum >= order.totals.total ? 'refunded' : 'partially_refunded'; tx.set(db.collection('payments').doc(orderId), { status: ps, refundedAmount: doneSum, updatedAt: now() }, { merge: true }); patch['payment.status'] = ps; }
    tx.update(orderRef, patch);
    notifyUser(tx, order.customerId, { type: 'refund', title: patch.status === 'refunded' ? 'Reembolsado' : 'Reembolso concluído', body: `R$ ${(amount / 100).toFixed(2).replace('.', ',')}`, ref: orderId });
  });
}

exports.customerCancelOrder = onCall({ ...OPTS, timeoutSeconds: 60 }, async (req) => {
  const c = claims(req);
  const d = req.data || {};
  const orderId = str(d.orderId, 100, 'pedido');
  const ref = db.collection('orders').doc(orderId);
  const o = await ref.get(); if (!o.exists || o.data().customerId !== c.uid) fail('not-found', 'Pedido não encontrado.');
  const order = o.data();
  const reason = optStr(d.reason, 300) || 'Cancelado pelo cliente';
  if (order.status === 'awaiting_payment') {
    const r = await cancelPendingOrder(orderId, 'customer_cancelled');
    if (r.confirmed) return { ok: false, message: 'O pagamento acabou de ser confirmado. Você pode cancelar o pedido confirmado agora.' };
    return { ok: true };
  }
  if (R.customerCanCancelDirectly(order.status)) { // confirmado, ainda sem separação: cancelamento direto com reembolso integral
    let cancelled = false;
    await db.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data();
      if (cur.status !== 'confirmed') return;
      const refs = cur.items.map(i => db.collection('markets').doc(cur.marketId).collection('listings').doc(i.listingId));
      const snaps = await tx.getAll(...refs);
      snaps.forEach((s, i) => { if (s.exists) { const l = s.data(); tx.update(refs[i], { committed: FV.increment(-cur.items[i].qty), stockStatus: R.stockStatus({ ...l, committed: Math.max(0, (l.committed || 0) - cur.items[i].qty) }) }); } });
      await decrementCounters(tx, cur);
      tx.update(ref, { cancelledAt: now(), cancelReason: reason, cancelledBy: c.uid });
      cancelled = true;
    });
    if (!cancelled) fail('failed-precondition', 'O pedido já começou a ser separado. Abra um chamado para avaliarmos o caso.');
    await startRefund(orderId, order.final?.total ?? order.totals.total, 'customer_cancel', { full: true });
    return { ok: true, refund: true };
  }
  // Depois do início da separação: avaliação por suporte, conforme etapa/motivo/política (nunca automático)
  const t = await db.collection('tickets').add({ requesterId: c.uid, requesterRole: 'customer', marketId: order.marketId, orderId, category: 'cancel_request', subject: `Solicitação de cancelamento do pedido ${orderId.slice(0, 6).toUpperCase()}`, status: 'open', priority: order.status === 'out_for_delivery' ? 'high' : 'normal', createdAt: now() });
  await t.collection('messages').add({ text: reason, senderId: c.uid, senderRole: 'customer', createdAt: now() });
  await orderEvent(null, orderId, { type: 'cancel_requested', actor: c.uid, data: { status: order.status } });
  return { ok: false, escalated: true, ticketId: t.id, message: 'O pedido já foi iniciado. Nossa equipe vai avaliar sua solicitação.' };
});

/* ============================ Operação do pedido (mercado) ============================ */
const ADVANCE_PERM = { picking: 'orders.picking', picked: 'orders.picking', ready_for_dispatch: 'orders.dispatch', out_for_delivery: 'orders.dispatch' };

exports.marketAdvanceOrder = onCall(OPTS, async (req) => {
  const d = req.data || {};
  const orderId = str(d.orderId, 100, 'pedido'); const to = d.to;
  if (!ADVANCE_PERM[to]) fail('invalid-argument', 'Transição não permitida por esta ação. A entrega só é confirmada pelo código do cliente.');
  const ref = db.collection('orders').doc(orderId);
  const pre = await ref.get(); if (!pre.exists) fail('not-found', 'Pedido não encontrado.');
  const c = needMarket(req, pre.data().marketId, ADVANCE_PERM[to]);
  await db.runTransaction(async (tx) => {
    const o = await tx.get(ref); const order = o.data();
    if (order.marketId !== pre.data().marketId) fail('permission-denied', 'Pedido de outro mercado.');
    if (!R.canTransition(order.status, to)) fail('failed-precondition', `Não é possível ir de "${R.ORDER_STATUS[order.status]}" para "${R.ORDER_STATUS[to]}".`);
    if (order.pendingSubstitutions > 0 && to === 'picked') fail('failed-precondition', 'Há substituições aguardando resposta do cliente.');
    const patch = { status: to, [`${to}At`]: now(), [`${to}By`]: c.uid };
    if (to === 'out_for_delivery') {
      patch.courierId = optStr(d.courierId, 128) || c.uid; patch.courierName = optStr(d.courierName, 80);
    }
    tx.update(ref, patch);
    orderEvent(tx, orderId, { type: 'status', actor: c.uid, from: order.status, to, data: { note: optStr(d.note, 300) } });
    let finalTo = to;
    if (to === 'picked') { // encaminhamento automático para expedição
      tx.update(ref, { status: 'ready_for_dispatch', ready_for_dispatchAt: now() });
      orderEvent(tx, orderId, { type: 'status', actor: 'system', from: 'picked', to: 'ready_for_dispatch' });
      notifyMarket(tx, order.marketId, { type: 'awaiting_dispatch', title: 'Pedido aguardando expedição', body: orderId.slice(0, 6).toUpperCase(), ref: orderId });
      finalTo = 'ready_for_dispatch';
    }
    const msg = { picking: ['Em separação', 'Estamos separando seus produtos.'], picked: ['Pedido separado', 'Seu pedido foi separado e segue para expedição.'], out_for_delivery: ['Saiu para entrega', 'Informe o código de 6 dígitos ao entregador.'] }[to];
    if (msg) notifyUser(tx, order.customerId, { type: to, title: msg[0], body: msg[1], ref: orderId });
    audit(tx, { actor: c.uid, actorRole: c.role, action: 'order.status', target: ref.path, marketId: order.marketId, before: { status: order.status }, after: { status: finalTo } });
  });
  return { ok: true };
});

/** Confirmação de entrega: validada no servidor, com limite de tentativas e código de uso único. */
exports.confirmDelivery = onCall(OPTS, async (req) => {
  const d = req.data || {};
  const orderId = str(d.orderId, 100, 'pedido');
  const code = String(d.code || '');
  const ref = db.collection('orders').doc(orderId);
  const pre = await ref.get(); if (!pre.exists) fail('not-found', 'Pedido não encontrado.');
  const c = needMarket(req, pre.data().marketId, 'orders.deliver');
  const cfg = await platformConfig();
  let result;
  await db.runTransaction(async (tx) => {
    const [o, sec] = await Promise.all([tx.get(ref), tx.get(ref.collection('secrets').doc('delivery'))]);
    const order = o.data();
    if (order.status !== 'out_for_delivery') fail('failed-precondition', 'O pedido não está em rota de entrega.');
    if (order.courierId && order.courierId !== c.uid && !c.perms.includes('orders.dispatch')) fail('permission-denied', 'Este pedido está atribuído a outro entregador.');
    const s = sec.data();
    if (!s || s.used) fail('failed-precondition', 'Código indisponível.');
    const lockedUntil = s.lockedUntil ? s.lockedUntil.toMillis() : 0;
    if (lockedUntil > Date.now()) { result = { ok: false, locked: true, retryAfterSec: Math.ceil((lockedUntil - Date.now()) / 1000) }; return; }
    const good = R.isValidDeliveryCodeFormat(code) && R.timingSafeEqualStr(code, s.code);
    if (!good) {
      const attempts = (s.attempts || 0) + 1;
      const lock = attempts >= cfg.deliveryCodeMaxAttempts;
      tx.update(sec.ref, { attempts: lock ? 0 : attempts, lockedUntil: lock ? plusMin(cfg.deliveryCodeLockMinutes) : null });
      orderEvent(tx, orderId, { type: 'delivery_code_failed', actor: c.uid, data: { attempts, locked: lock } });
      result = { ok: false, attemptsLeft: lock ? 0 : cfg.deliveryCodeMaxAttempts - attempts, locked: lock };
      return;
    }
    tx.update(sec.ref, { used: true, usedAt: now(), usedBy: c.uid });
    tx.update(ref, { status: 'delivered', deliveredAt: now(), deliveredBy: c.uid, disputeUntil: plusMin(cfg.disputeWindowMinutes) });
    orderEvent(tx, orderId, { type: 'delivered', actor: c.uid, from: 'out_for_delivery', to: 'delivered', data: { validation: 'code_ok' } });
    ledger(tx, { id: `delivery_${orderId}`, type: 'delivery_confirmed', orderId, marketId: order.marketId, amount: (order.final || order.totals).marketReceivable });
    notifyUser(tx, order.customerId, { type: 'delivered', title: 'Entrega confirmada', body: 'Avalie o mercado quando quiser.', ref: orderId });
    notifyMarket(tx, order.marketId, { type: 'delivered', title: 'Entrega confirmada', body: orderId.slice(0, 6).toUpperCase(), ref: orderId });
    audit(tx, { actor: c.uid, actorRole: c.role, action: 'order.delivered', target: ref.path, marketId: order.marketId });
    result = { ok: true };
  });
  return result;
});

exports.reportDeliveryIssue = onCall(OPTS, async (req) => {
  const d = req.data || {};
  const orderId = str(d.orderId, 100, 'pedido');
  const pre = await db.collection('orders').doc(orderId).get(); if (!pre.exists) fail('not-found', 'Pedido não encontrado.');
  const c = needMarket(req, pre.data().marketId, 'orders.deliver');
  const t = await db.collection('tickets').add({ requesterId: c.uid, requesterRole: 'market', marketId: pre.data().marketId, orderId, category: 'delivery_issue', subject: `Ocorrência de entrega: ${str(d.reason, 140, 'motivo')}`, status: 'open', priority: 'high', createdAt: now() });
  await orderEvent(null, orderId, { type: 'delivery_issue', actor: c.uid, data: { reason: d.reason } }); // o pedido NÃO é marcado como entregue
  return { ticketId: t.id };
});

/* ============================ Substituições (sempre com autorização expressa) ============================ */
exports.marketReportMissingItem = onCall(OPTS, async (req) => {
  const d = req.data || {};
  const orderId = str(d.orderId, 100, 'pedido');
  const ref = db.collection('orders').doc(orderId);
  const pre = await ref.get(); if (!pre.exists) fail('not-found', 'Pedido não encontrado.');
  const c = needMarket(req, pre.data().marketId, 'orders.picking');
  const cfg = await platformConfig();
  let subId;
  await db.runTransaction(async (tx) => {
    const o = await tx.get(ref); const order = o.data();
    if (order.status !== 'picking') fail('failed-precondition', 'Só é possível reportar falta durante a separação.');
    const line = order.items.find(i => i.listingId === d.listingId); if (!line) fail('not-found', 'Item não está no pedido.');
    const qty = int(d.qty ?? line.qty, 1, line.qty, 'quantidade');
    let substitute = null;
    if (d.substituteListingId) {
      const sl = await tx.get(db.collection('markets').doc(order.marketId).collection('listings').doc(d.substituteListingId));
      if (!sl.exists || sl.data().active === false || R.availableQty(sl.data()) < qty) fail('failed-precondition', 'O produto substituto não está disponível.');
      const pl = R.priceLine(sl.data(), qty, Date.now());
      substitute = { listingId: sl.id, name: sl.data().name, unitLabel: sl.data().unitLabel || null, qty, net: pl.net };
    }
    const missingValue = R.refundForLine(order, d.listingId, qty);
    const sref = ref.collection('substitutions').doc(); subId = sref.id;
    tx.set(sref, { status: 'pending', listingId: d.listingId, itemName: line.name, qty, missingValue, substitute, diff: substitute ? substitute.net - missingValue : null, createdBy: c.uid, createdAt: now(), expiresAt: plusMin(order.snapshot?.substitutionTimeoutMinutes || cfg.substitutionTimeoutMinutes), noResponse: order.snapshot?.substitutionNoResponse || 'remove_refund' });
    tx.update(ref, { pendingSubstitutions: FV.increment(1) });
    tx.set(ref.collection('messages').doc(), { text: substitute ? `Item em falta: ${line.name}. Sugerimos: ${substitute.name}. Responda pelo app para autorizar ou recusar.` : `Item em falta: ${line.name}. Você pode recusar a troca e receber o valor de volta.`, senderId: c.uid, senderRole: 'market', createdAt: now() });
    notifyUser(tx, order.customerId, { type: 'substitution', title: 'Produto em falta', body: `${line.name}: precisamos da sua decisão.`, ref: orderId });
    orderEvent(tx, orderId, { type: 'missing_item', actor: c.uid, data: { listingId: d.listingId, qty, substitute: substitute?.listingId || null } });
  });
  return { subId };
});

async function resolveMissing(order, orderId, sub, subRef, decision, actor) {
  // Aplica a decisão: recusa => retira o item e reembolsa; aceite mais barato => troca e devolve a diferença.
  const ref = db.collection('orders').doc(orderId);
  const refundAmount = decision === 'decline' ? sub.missingValue : (sub.diff < 0 ? -sub.diff : 0);
  const rate = order.commissionRate || 0;
  await db.runTransaction(async (tx) => {
    const [o, s] = await Promise.all([tx.get(ref), tx.get(subRef)]);
    if (s.data().status !== 'pending' && s.data().status !== 'awaiting_extra_payment') return;
    const cur = o.data();
    const lref = db.collection('markets').doc(cur.marketId).collection('listings').doc(sub.listingId);
    const lsnap = await tx.get(lref);
    const sref = decision === 'accept' ? db.collection('markets').doc(cur.marketId).collection('listings').doc(sub.substitute.listingId) : null;
    const ssnap = sref ? await tx.get(sref) : null;
    const fin = { ...(cur.final || cur.totals) };
    const items = cur.items.map(i => ({ ...i }));
    const idx = items.findIndex(i => i.listingId === sub.listingId);
    // estoque: o item faltante deixa de estar comprometido e o produto fica esgotado para novas compras
    if (lsnap.exists) { const l = lsnap.data(); const newCommitted = Math.max(0, (l.committed || 0) - sub.qty); tx.update(lref, { committed: newCommitted, allocated: Math.min(l.allocated || 0, newCommitted + (l.reserved || 0)), stockStatus: 'out_of_stock', updatedAt: now() }); }
    if (decision === 'decline') {
      items[idx].qty -= sub.qty; items[idx].removedQty = (items[idx].removedQty || 0) + sub.qty; items[idx].paidTotal -= sub.missingValue;
      fin.itemsPaid -= sub.missingValue; fin.total -= sub.missingValue;
    } else {
      if (ssnap) { const sl = ssnap.data(); tx.update(sref, { committed: FV.increment(sub.qty), stockStatus: R.stockStatus({ ...sl, committed: (sl.committed || 0) + sub.qty }) }); }
      items[idx].qty -= sub.qty; items[idx].removedQty = (items[idx].removedQty || 0) + sub.qty; items[idx].paidTotal -= sub.missingValue;
      items.push({ listingId: sub.substitute.listingId, name: sub.substitute.name, unitLabel: sub.substitute.unitLabel, qty: sub.qty, gross: sub.substitute.net, promoDiscount: 0, net: sub.substitute.net, paidTotal: sub.substitute.net, substituteFor: sub.listingId });
      fin.itemsPaid += sub.diff; fin.total += sub.diff;
    }
    const delta = decision === 'decline' ? -sub.missingValue : sub.diff;
    fin.commission = Math.round(fin.itemsPaid * rate);
    fin.marketReceivable = fin.itemsPaid - fin.commission + (fin.deliveryFee - fin.deliveryDiscountMarket) + (fin.couponDiscountPlatform || 0);
    tx.update(ref, { items: items.filter(i => i.qty > 0), final: fin, pendingSubstitutions: FV.increment(-1) });
    tx.update(subRef, { status: decision === 'accept' ? 'accepted' : 'declined', resolvedAt: now(), resolvedBy: actor });
    orderEvent(tx, orderId, { type: 'substitution_resolved', actor, data: { decision, refund: refundAmount, delta } });
    audit(tx, { actor, action: 'substitution.resolve', target: subRef.path, marketId: cur.marketId, after: { decision, refundAmount } });
  });
  if (refundAmount > 0) await startRefund(orderId, refundAmount, decision === 'decline' ? 'missing_item' : 'substitute_cheaper', { full: false });
}

exports.customerRespondSubstitution = onCall({ ...OPTS, timeoutSeconds: 60 }, async (req) => {
  const c = claims(req); const d = req.data || {};
  const orderId = str(d.orderId, 100, 'pedido');
  const ref = db.collection('orders').doc(orderId);
  const o = await ref.get(); if (!o.exists || o.data().customerId !== c.uid) fail('not-found', 'Pedido não encontrado.');
  const subRef = ref.collection('substitutions').doc(str(d.subId, 100, 'substituição'));
  const s = await subRef.get(); if (!s.exists || s.data().status !== 'pending') fail('failed-precondition', 'Esta solicitação não está mais pendente.');
  const sub = s.data();
  const decision = d.decision;
  if (decision === 'cancel_order') {
    await subRef.update({ status: 'declined', resolvedAt: now(), resolvedBy: c.uid, note: 'cliente pediu cancelamento integral' });
    await ref.update({ pendingSubstitutions: FV.increment(-1) });
    const t = await db.collection('tickets').add({ requesterId: c.uid, requesterRole: 'customer', marketId: o.data().marketId, orderId, category: 'cancel_request', subject: 'Cancelamento integral após falta de produto', status: 'open', priority: 'high', createdAt: now() });
    return { escalated: true, ticketId: t.id };
  }
  if (decision === 'decline') { await resolveMissing(o.data(), orderId, sub, subRef, 'decline', c.uid); return { ok: true }; }
  if (decision !== 'accept' || !sub.substitute) fail('invalid-argument', 'Decisão inválida.');
  if (sub.diff > 0) { // mais caro: precisa de autorização EXPLÍCITA do novo valor e de pagamento da diferença
    if (d.acceptExtraCents !== sub.diff) fail('failed-precondition', `O substituto custa R$ ${(sub.diff / 100).toFixed(2).replace('.', ',')} a mais. Confirme o valor para continuar.`);
    const provider = getProvider(); 
    const extraId = `${orderId}__sub_${subRef.id}`;
    const ch = await provider.createCharge({ orderId: extraId, amount: sub.diff, method: 'pix', split: { marketAmount: Math.round(sub.diff * (1 - (o.data().commissionRate || 0))), platformAmount: sub.diff - Math.round(sub.diff * (1 - (o.data().commissionRate || 0))) }, customer: { id: c.uid }, idempotencyKey: `${extraId}:charge`, expiresAt: Date.now() + 30 * 60000, kind: 'substitution_extra' });
    await db.collection('payments').doc(extraId).set({ orderId, subId: subRef.id, kind: 'substitution_extra', customerId: c.uid, marketId: o.data().marketId, providerChargeId: ch.providerChargeId, amount: sub.diff, status: ch.status, lastSeq: 0, public: { method: 'pix', pix: ch.pix || null }, createdAt: now() });
    await subRef.update({ status: 'awaiting_extra_payment', extraPaymentId: extraId });
    return { awaitingPayment: true, payment: { pix: ch.pix || null, amount: sub.diff } };
  }
  await resolveMissing(o.data(), orderId, sub, subRef, 'accept', c.uid);
  return { ok: true };
});

async function applySubstitutionPaid(pay, ch) {
  const ref = db.collection('orders').doc(pay.orderId);
  const subRef = ref.collection('substitutions').doc(pay.subId);
  const [o, s] = await Promise.all([ref.get(), subRef.get()]);
  if (!s.exists || s.data().status !== 'awaiting_extra_payment') return;
  if (ch.paidAmount !== s.data().diff) { console.error('diferença paga não confere', pay.orderId); return; }
  await resolveMissing(o.data(), pay.orderId, s.data(), subRef, 'accept', 'system');
  await db.collection('payments').doc(pay.orderId + '__sub_' + pay.subId).update({ status: 'paid', paidAt: now() });
}

// Sem resposta no prazo: NÃO há substituição nem consentimento presumido — o item é retirado e o valor reembolsado.
exports.expireSubstitutions = onSchedule({ ...OPTS, schedule: 'every 5 minutes' }, async () => {
  const q = await db.collectionGroup('substitutions').where('status', '==', 'pending').where('expiresAt', '<', now()).limit(50).get();
  for (const doc of q.docs) {
    const orderRef = doc.ref.parent.parent; const o = await orderRef.get();
    if (!o.exists) continue;
    try {
      if (doc.data().noResponse === 'escalate') { await doc.ref.update({ expiresAt: plusMin(60 * 24 * 365), escalated: true }); await db.collection('tickets').add({ requesterId: o.data().customerId, requesterRole: 'system', marketId: o.data().marketId, orderId: orderRef.id, category: 'substitution_no_response', subject: `Cliente não respondeu à substituição (${doc.data().itemName})`, status: 'open', priority: 'high', createdAt: now() }); continue; }
      await resolveMissing(o.data(), orderRef.id, doc.data(), doc.ref, 'decline', 'system'); } catch (e) { console.warn('substituição não resolvida', doc.ref.path, e.message); }
  }
});

exports.flagLateOrders = onSchedule({ ...OPTS, schedule: 'every 10 minutes' }, async () => {
  const q2 = await db.collection('orders').where('delivery.etaAt', '<', now()).where('status', 'in', ['confirmed', 'picking', 'picked', 'ready_for_dispatch', 'out_for_delivery']).limit(200).get();
  for (const doc of q2.docs) {
    const o = doc.data(); if (o.lateNotified) continue;
    await doc.ref.update({ lateNotified: true });
    await notifyUser(null, o.customerId, { type: 'late', title: 'Seu pedido está atrasado', body: 'Passamos da previsão confirmada. O mercado já foi avisado.', ref: doc.id });
    await notifyMarket(null, o.marketId, { type: 'late', title: 'Pedido atrasado', body: doc.id.slice(0, 6).toUpperCase(), ref: doc.id });
    await orderEvent(null, doc.id, { type: 'late_flag' });
  }
});

exports.onOrderMessage = onDocumentCreated({ document: 'orders/{orderId}/messages/{msgId}', region: OPTS.region }, async (event) => {
  const m = event.data.data(); const orderId = event.params.orderId;
  const o = (await db.collection('orders').doc(orderId).get()).data(); if (!o) return;
  if (m.senderRole === 'customer') await notifyMarket(null, o.marketId, { type: 'message', title: 'Nova mensagem do cliente', body: String(m.text).slice(0, 80), ref: orderId });
  else await notifyUser(null, o.customerId, { type: 'message', title: 'Nova mensagem do mercado', body: String(m.text).slice(0, 80), ref: orderId });
});

/* ============================ Avaliações ============================ */
exports.submitReview = onCall(OPTS, async (req) => {
  const c = claims(req); const d = req.data || {};
  const orderId = str(d.orderId, 100, 'pedido'); const rating = int(d.rating, 1, 5, 'nota');
  const comment = optStr(d.comment, 1000);
  const oref = db.collection('orders').doc(orderId); const rref = db.collection('reviews').doc(orderId);
  await db.runTransaction(async (tx) => {
    const [o, r] = await Promise.all([tx.get(oref), tx.get(rref)]);
    if (!o.exists || o.data().customerId !== c.uid) fail('not-found', 'Pedido não encontrado.');
    if (!['delivered', 'completed'].includes(o.data().status)) fail('failed-precondition', 'Só é possível avaliar após a entrega.'); // compra real
    const mref = db.collection('markets').doc(o.data().marketId); const m = await tx.get(mref);
    const prev = r.exists ? r.data().rating : null;
    const sum = (m.data().ratingSum || 0) - (prev || 0) + rating; const cnt = (m.data().ratingCount || 0) + (r.exists ? 0 : 1);
    if (r.exists) tx.set(rref.collection('versions').doc(), { ...r.data(), versionAt: now() }); // histórico preservado
    tx.set(rref, { orderId, marketId: o.data().marketId, customerId: c.uid, customerName: (o.data().address?.recipient || 'Cliente').split(' ')[0], rating, comment, edited: r.exists, hidden: r.exists ? r.data().hidden === true : false, reply: r.exists ? r.data().reply || null : null, officialNote: r.exists ? r.data().officialNote || null : null, createdAt: r.exists ? r.data().createdAt : now(), updatedAt: now() });
    tx.update(mref, { ratingSum: sum, ratingCount: cnt, ratingAvg: Math.round((sum / cnt) * 100) / 100 });
  });
  return { ok: true };
});

exports.marketReplyReview = onCall(OPTS, async (req) => {
  const d = req.data || {};
  const rref = db.collection('reviews').doc(str(d.reviewId, 100, 'avaliação'));
  const r = await rref.get(); if (!r.exists) fail('not-found', 'Avaliação não encontrada.');
  const c = needMarket(req, r.data().marketId, 'chat.use');
  await rref.update({ reply: { text: str(d.text, 800, 'resposta'), at: now(), by: c.uid } }); // o mercado responde, nunca exclui
  return { ok: true };
});

exports.adminModerateReview = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'reviews.moderate'); const d = req.data || {};
  const rref = db.collection('reviews').doc(str(d.reviewId, 100, 'avaliação'));
  const patch = {};
  if (typeof d.hidden === 'boolean') { patch.hidden = d.hidden; patch.hiddenReason = optStr(d.reason, 300); } // só spam/abuso/dados pessoais
  if (d.officialNote) patch.officialNote = { text: str(d.officialNote, 800, 'nota'), at: now(), by: c.uid }; // o texto original permanece intacto
  await rref.update(patch);
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'review.moderate', target: rref.path, after: patch });
  return { ok: true };
});

/* ============================ Suporte ============================ */
exports.supportUpdateTicket = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'support.write'); const d = req.data || {};
  const ref = db.collection('tickets').doc(str(d.ticketId, 100, 'chamado'));
  const patch = { updatedAt: now() };
  if (d.status) { if (!['open', 'in_progress', 'waiting_customer', 'escalated', 'resolved', 'closed'].includes(d.status)) fail('invalid-argument', 'Estado inválido.'); patch.status = d.status; if (['resolved', 'closed'].includes(d.status)) { patch.resolution = optStr(d.resolution, 800); patch.resolvedAt = now(); } }
  if (d.priority) patch.priority = ['low', 'normal', 'high', 'urgent'].includes(d.priority) ? d.priority : 'normal';
  if (d.assigneeUid !== undefined) patch.assigneeUid = d.assigneeUid || null;
  if (d.escalate) { patch.status = 'escalated'; patch.escalatedTo = d.escalate; }
  if (d.incidentType) patch.incidentType = optStr(d.incidentType, 40);
  await ref.update(patch);
  if (d.message) await ref.collection('messages').add({ text: str(d.message, 2000, 'mensagem'), senderId: c.uid, senderRole: 'support', createdAt: now() });
  let recurrence = null;
  const t = (await ref.get()).data();
  if (patch.incidentType && t.marketId) { // reincidência: sugere advertência/restrição/suspensão, sem aplicar automaticamente
    const since = TS.fromMillis(Date.now() - 30 * 86400000);
    const n = (await db.collection('tickets').where('marketId', '==', t.marketId).where('incidentType', '==', patch.incidentType).where('createdAt', '>=', since).get().catch(() => ({ size: 0 }))).size;
    recurrence = { count: n, suggestion: n >= 8 ? 'suspensão (avaliar)' : n >= 5 ? 'restrição temporária' : n >= 3 ? 'advertência' : null };
  }
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'ticket.update', target: ref.path, marketId: t.marketId || null, after: patch });
  return { ok: true, recurrence };
});

exports.adminReadOrderChat = onCall(OPTS, async (req) => { // consulta administrativa registrada em auditoria
  const c = needPlatform(req, 'support.read'); const d = req.data || {};
  const orderId = str(d.orderId, 100, 'pedido');
  const msgs = await db.collection('orders').doc(orderId).collection('messages').orderBy('createdAt').limit(300).get();
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'chat.admin_read', target: `orders/${orderId}/messages`, note: optStr(d.reason, 300) });
  return { messages: msgs.docs.map(x => ({ id: x.id, ...x.data(), createdAt: x.data().createdAt?.toMillis() })) };
});

/* ============================ Finanças e indicadores ============================ */
const SOLD = ['confirmed', 'picking', 'picked', 'ready_for_dispatch', 'out_for_delivery', 'delivered', 'completed', 'delivery_failed', 'refund_processing', 'refunded'];

function reportRow(id, o) {
  let f = o.final || o.totals; const t = o.totals;
  // Pedido totalmente reembolsado: não gera comissão nem valor a repassar (o reembolso fica registrado).
  if (['refund_processing', 'refunded'].includes(o.status) && (o.refundedTotal || 0) >= f.total) f = { ...f, itemsPaid: 0, commission: 0, marketReceivable: 0, deliveryFee: 0, deliveryDiscountMarket: 0, total: 0 };
  return {
    orderId: id, at: o.createdAt.toMillis(), status: o.status, cityId: o.cityId || null, marketId: o.marketId, marketName: o.marketName,
    gross: t.subtotalList, discounts: t.promoDiscount + t.couponDiscountMarket + t.couponDiscountPlatform, subsidy: t.platformSubsidy || 0,
    itemsPaid: f.itemsPaid, deliveryFee: f.deliveryFee - f.deliveryDiscountMarket, commission: f.commission, refunds: o.refundedTotal || 0,
    marketReceivable: f.marketReceivable, total: t.total, paidOut: !!o.payoutId, delivered: ['delivered', 'completed'].includes(o.status), completed: o.status === 'completed'
  };
}

function summarize(rows) {
  const s = { orders: rows.length, gmv: 0, grossProducts: 0, discounts: 0, subsidy: 0, commission: 0, deliveryFees: 0, refunds: 0, marketReceivable: 0, pending: 0, paid: 0, awaitingDelivery: 0 };
  for (const r of rows) {
    s.gmv += r.total; s.grossProducts += r.gross; s.discounts += r.discounts; s.subsidy += r.subsidy; s.commission += r.commission; s.deliveryFees += r.deliveryFee; s.refunds += r.refunds; s.marketReceivable += r.marketReceivable;
    if (r.paidOut) s.paid += r.marketReceivable; else if (r.delivered) s.pending += r.marketReceivable; else s.awaitingDelivery += r.marketReceivable;
  }
  s.ticket = s.orders ? Math.round(s.gmv / s.orders) : 0;
  return s; // GMV não é receita: a receita da plataforma é a comissão (menos subsídios)
}

exports.getFinanceReport = onCall({ ...OPTS, timeoutSeconds: 120, memory: '512MiB' }, async (req) => {
  const c = claims(req); const d = req.data || {};
  let marketId = d.marketId || null;
  if (c.role === 'market_staff') { marketId = c.marketId; if (!c.perms.includes('finance.read')) fail('permission-denied', 'Sem permissão financeira.'); }
  else needPlatform(req, 'finance.read');
  const from = TS.fromMillis(Number(d.from) || Date.now() - 30 * 86400000), to = TS.fromMillis(Number(d.to) || Date.now());
  let q = db.collection('orders').where('createdAt', '>=', from).where('createdAt', '<=', to);
  if (marketId) q = q.where('marketId', '==', marketId);
  const snap = await q.orderBy('createdAt', 'desc').limit(5000).get();
  const rows = snap.docs.filter(x => SOLD.includes(x.data().status)).map(x => reportRow(x.id, x.data())).filter(r => !d.cityId || r.cityId === d.cityId).filter(r => !d.status || r.status === d.status);
  const sum = summarize(rows);
  const payouts = marketId ? (await db.collection('markets').doc(marketId).collection('payouts').orderBy('at', 'desc').limit(50).get()).docs.map(x => ({ id: x.id, ...x.data(), at: x.data().at?.toMillis() })) : [];
  if (marketId) { const bal = await marketBalanceOf((q2) => q2.get(), marketId); sum.paid = bal.paid; sum.pending = bal.available + bal.pending; sum.balance = bal; }
  if (c.role === 'market_staff') { delete sum.gmv; } // mercado vê as próprias vendas; GMV global é visão da plataforma
  return { rows: rows.slice(0, 2000), truncated: rows.length > 2000, summary: sum, payouts };
});


exports.adminGetIndicators = onCall({ ...OPTS, timeoutSeconds: 120, memory: '512MiB' }, async (req) => {
  const c = needPlatform(req, 'indicators.read'); const d = req.data || {};
  const from = TS.fromMillis(Number(d.from) || Date.now() - 30 * 86400000), to = TS.fromMillis(Number(d.to) || Date.now());
  let q = db.collection('orders').where('createdAt', '>=', from).where('createdAt', '<=', to);
  if (d.marketId) q = q.where('marketId', '==', d.marketId);
  const snap = await q.limit(10000).get();
  const all = snap.docs.map(x => ({ id: x.id, ...x.data() })).filter(o => !d.cityId || o.cityId === d.cityId);
  const sold = all.filter(o => SOLD.includes(o.status)).map(o => reportRow(o.id, o));
  const canFin = c.role === 'platform_admin' || c.perms.includes('finance.read');
  const byDay = {}, byCity = {};
  sold.forEach(r => { const day = R.ymd(new Date(r.at)); (byDay[day] ||= { orders: 0, gmv: 0, commission: 0 }); byDay[day].orders++; byDay[day].gmv += r.total; byDay[day].commission += r.commission; (byCity[r.cityId || '—'] ||= { orders: 0, gmv: 0 }); byCity[r.cityId || '—'].orders++; byCity[r.cityId || '—'].gmv += r.total; });
  const mk = await db.collection('markets').get();
  const marketsBy = { active: 0, awaiting_setup: 0, suspended: 0 }; mk.forEach(m => { marketsBy[m.data().status] = (marketsBy[m.data().status] || 0) + 1; });
  const pros = await db.collection('prospects').get();
  const pipeline = {}; pros.forEach(p => { pipeline[p.data().status] = (pipeline[p.data().status] || 0) + 1; });
  const sm = summarize(sold);
  const out = {
    orders: sold.length, cancelled: all.filter(o => ['cancelled'].includes(o.status)).length, refundedOrders: all.filter(o => o.refundedTotal > 0).length,
    refundsTotal: sold.reduce((s, r) => s + r.refunds, 0), markets: marketsBy, pipeline, byDay, byCity
  };
  if (canFin) Object.assign(out, { gmv: sm.gmv, ticket: sm.ticket, commissions: sm.commission, discounts: sm.discounts, subsidy: sm.subsidy, pendingPayouts: sm.pending, paidPayouts: sm.paid });
  return out;
});

exports.adminGetStaffPerformance = onCall({ ...OPTS, timeoutSeconds: 120 }, async (req) => {
  needPlatform(req, 'indicators.read'); const d = req.data || {};
  const from = TS.fromMillis(Number(d.from) || Date.now() - 30 * 86400000);
  const pros = await db.collection('prospects').where('createdAt', '>=', from).get();
  const by = {};
  pros.forEach(p => {
    const x = p.data(); const k = x.ownerUid || '—'; const r = (by[k] ||= { worked: 0, contacts: 0, negotiating: 0, closed: 0, approved: 0, activated: 0, stageMs: {}, stageN: {} });
    r.worked++; (x.timeline || []).forEach(t => { if (t.kind === 'contact' || t.kind === 'status') r.contacts += t.kind === 'contact' ? 1 : 0; });
    if (['in_review', 'awaiting_contact'].includes(x.status)) r.negotiating++;
    if (['approved', 'awaiting_setup', 'active'].includes(x.status)) { r.approved++; r.closed++; }
    if (x.status === 'active') r.activated++;
    (x.stageHistory || []).forEach(h => { const ms = (h.leftAt?.toMillis?.() || 0) - (h.enteredAt?.toMillis?.() || 0); if (ms > 0) { r.stageMs[h.status] = (r.stageMs[h.status] || 0) + ms; r.stageN[h.status] = (r.stageN[h.status] || 0) + 1; } });
  });
  const out = Object.entries(by).map(([uid, r]) => ({ uid, worked: r.worked, contacts: r.contacts, negotiating: r.negotiating, closed: r.closed, approved: r.approved, activated: r.activated, conversion: r.worked ? Math.round((r.activated / r.worked) * 1000) / 10 : 0, avgStageHours: Object.fromEntries(Object.keys(r.stageMs).map(s => [s, Math.round(r.stageMs[s] / r.stageN[s] / 36000) / 100])) }));
  return { rows: out };
});




/* ============================ Ciclo pós-entrega: conclusão, contestação, falha, reembolsos, repasses ============================ */
async function completeOrderInternal(orderId, by, why) {
  const ref = db.collection('orders').doc(orderId); let done = false;
  await db.runTransaction(async (tx) => {
    const o = await tx.get(ref); if (!o.exists) fail('not-found', 'Pedido não encontrado.'); const order = o.data();
    if (order.status !== 'delivered') return; if (order.disputed) fail('failed-precondition', 'Pedido em contestação: resolva a contestação antes de concluir.');
    const f = order.final || order.totals;
    tx.update(ref, { status: 'completed', completedAt: now(), completedBy: by });
    ledger(tx, { id: `credit_${orderId}`, type: 'market_credit', orderId, marketId: order.marketId, amount: f.marketReceivable, meta: { itemsPaid: f.itemsPaid, deliveryFee: f.deliveryFee } });
    ledger(tx, { id: `commission_${orderId}`, type: 'commission', orderId, marketId: order.marketId, amount: f.commission, meta: { rate: order.commissionRate } });
    if (order.totals.platformSubsidy) ledger(tx, { id: `subsidy_${orderId}`, type: 'platform_subsidy', orderId, marketId: order.marketId, amount: -order.totals.platformSubsidy, meta: { coupon: order.coupon?.code || null } });
    orderEvent(tx, orderId, { type: 'completed', actor: by, from: 'delivered', to: 'completed', data: { why: why || null } });
    notifyMarket(tx, order.marketId, { type: 'completed', title: 'Pedido concluído', body: orderId.slice(0, 6).toUpperCase() + ' liberado para repasse', ref: orderId });
    done = true;
  });
  return done;
}
exports.completeOrder = onCall(OPTS, async (req) => {
  const c = claims(req); const orderId = str((req.data || {}).orderId, 100, 'pedido');
  const o = await db.collection('orders').doc(orderId).get(); if (!o.exists) fail('not-found', 'Pedido não encontrado.');
  const isAdmin = c.role === 'platform_admin' || (c.role === 'platform_staff' && c.perms.includes('orders.read') && c.perms.includes('finance.payouts'));
  if (o.data().customerId !== c.uid && !isAdmin) fail('permission-denied', 'Sem permissão.');
  if (o.data().status !== 'delivered') fail('failed-precondition', 'Só pedidos entregues podem ser concluídos.');
  return { ok: await completeOrderInternal(orderId, c.uid, o.data().customerId === c.uid ? 'confirmado pelo cliente' : 'concluído pela plataforma') };
});
exports.customerDisputeDelivery = onCall(OPTS, async (req) => {
  const c = claims(req); const d = req.data || {}; const orderId = str(d.orderId, 100, 'pedido'); const reason = str(d.reason, 500, 'motivo');
  const ref = db.collection('orders').doc(orderId); let ticketId;
  await db.runTransaction(async (tx) => {
    const o = await tx.get(ref); if (!o.exists || o.data().customerId !== c.uid) fail('not-found', 'Pedido não encontrado.');
    const order = o.data(); if (order.status !== 'delivered') fail('failed-precondition', 'Só é possível contestar uma entrega ainda não concluída.');
    if (order.disputeUntil && order.disputeUntil.toMillis() < Date.now()) fail('failed-precondition', 'O prazo de contestação terminou.');
    tx.update(ref, { disputed: true, disputeReason: reason, disputedAt: now() });
    const t = db.collection('tickets').doc(); ticketId = t.id;
    tx.set(t, { requesterId: c.uid, requesterRole: 'customer', marketId: order.marketId, orderId, category: 'delivery_dispute', subject: `Entrega contestada: pedido ${orderId.slice(0, 6).toUpperCase()}`, status: 'open', priority: 'high', createdAt: now() });
    tx.set(t.collection('messages').doc(), { text: reason, senderId: c.uid, senderRole: 'customer', createdAt: now() });
    orderEvent(tx, orderId, { type: 'delivery_disputed', actor: c.uid, data: { reason } });
    notifyMarket(tx, order.marketId, { type: 'dispute', title: 'Entrega contestada', body: orderId.slice(0, 6).toUpperCase(), ref: orderId });
  });
  return { ticketId };
});
exports.adminResolveDispute = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'finance.payouts'); const d = req.data || {}; const orderId = str(d.orderId, 100, 'pedido');
  const ref = db.collection('orders').doc(orderId); const o = await ref.get(); if (!o.exists || !o.data().disputed) fail('failed-precondition', 'Pedido sem contestação aberta.');
  const order = o.data(); const resolution = d.resolution === 'refund' ? 'refund' : 'dismiss';
  await ref.update({ disputed: false, disputeResolution: resolution, disputeResolvedAt: now(), disputeUntil: plusMin(0) });
  await orderEvent(null, orderId, { type: 'dispute_resolved', actor: c.uid, data: { resolution, note: optStr(d.note, 300) } });
  if (resolution === 'refund') { const left = order.totals.total - (order.refundedTotal || 0); const amount = d.amount != null ? int(d.amount, 1, left, 'valor') : left; await startRefund(orderId, amount, 'dispute', { full: amount >= left, adjust: true }); }
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'dispute.resolve', target: ref.path, marketId: order.marketId, after: { resolution } });
  return { ok: true };
});
exports.marketReportDeliveryFailure = onCall(OPTS, async (req) => {
  const d = req.data || {}; const orderId = str(d.orderId, 100, 'pedido'); const reason = str(d.reason, 300, 'motivo');
  const ref = db.collection('orders').doc(orderId); const pre = await ref.get(); if (!pre.exists) fail('not-found', 'Pedido não encontrado.');
  const c = needMarket(req, pre.data().marketId, 'orders.deliver');
  await db.runTransaction(async (tx) => {
    const o = await tx.get(ref); const order = o.data(); if (!R.canTransition(order.status, 'delivery_failed')) fail('failed-precondition', 'Só pedidos em rota podem ter falha de entrega registrada.');
    tx.update(ref, { status: 'delivery_failed', deliveryFailedAt: now(), deliveryFailReason: reason });
    orderEvent(tx, orderId, { type: 'status', actor: c.uid, from: order.status, to: 'delivery_failed', data: { reason } });
    const t = db.collection('tickets').doc(); tx.set(t, { requesterId: c.uid, requesterRole: 'market', marketId: order.marketId, orderId, category: 'delivery_issue', subject: `Falha na entrega: ${reason}`, status: 'open', priority: 'high', createdAt: now() });
    notifyUser(tx, order.customerId, { type: 'delivery_failed', title: 'Não conseguimos entregar', body: reason, ref: orderId });
  });
  return { ok: true };
});
async function cancelConfirmed(orderId, actor, reason) {
  const ref = db.collection('orders').doc(orderId); let total = 0;
  await db.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data();
    if (!cur || !['confirmed', 'picking', 'picked', 'ready_for_dispatch'].includes(cur.status)) fail('failed-precondition', 'Este pedido não pode mais ser cancelado diretamente (já saiu para entrega ou foi encerrado).');
    const refs = cur.items.map(i => db.collection('markets').doc(cur.marketId).collection('listings').doc(i.listingId));
    const snaps = await tx.getAll(...refs);
    snaps.forEach((s2, i) => { if (s2.exists) { const l = s2.data(); tx.update(refs[i], { committed: FV.increment(-cur.items[i].qty), stockStatus: R.stockStatus({ ...l, committed: Math.max(0, (l.committed || 0) - cur.items[i].qty) }) }); } });
    await decrementCounters(tx, cur);
    tx.update(ref, { cancelledAt: now(), cancelReason: reason, cancelledBy: actor });
    total = cur.totals.total - (cur.refundedTotal || 0);
  });
  await startRefund(orderId, total, 'cancelled_by_staff', { full: true });
  return total;
}
exports.marketCancelOrder = onCall(OPTS, async (req) => {
  const d = req.data || {}; const orderId = str(d.orderId, 100, 'pedido'); const reason = str(d.reason, 300, 'motivo');
  const pre = await db.collection('orders').doc(orderId).get(); if (!pre.exists) fail('not-found', 'Pedido não encontrado.');
  const c = needMarket(req, pre.data().marketId, 'orders.dispatch');
  const total = await cancelConfirmed(orderId, c.uid, reason);
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'order.cancel_by_market', target: `orders/${orderId}`, marketId: pre.data().marketId, after: { reason, refund: total } });
  return { ok: true, refund: total };
});
exports.adminCancelOrder = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'finance.payouts'); const d = req.data || {}; const orderId = str(d.orderId, 100, 'pedido'); const reason = str(d.reason, 300, 'motivo');
  const pre = await db.collection('orders').doc(orderId).get(); if (!pre.exists) fail('not-found', 'Pedido não encontrado.');
  if (pre.data().status === 'awaiting_payment') { await cancelPendingOrder(orderId, 'admin_cancelled', { skipProviderCheck: false }); return { ok: true, refund: 0 }; }
  const total = await cancelConfirmed(orderId, c.uid, reason);
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'order.cancel_by_admin', target: `orders/${orderId}`, marketId: pre.data().marketId, after: { reason, refund: total } });
  return { ok: true, refund: total };
});
exports.adminRefundOrder = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'finance.payouts'); const d = req.data || {}; const orderId = str(d.orderId, 100, 'pedido'); const reason = str(d.reason, 300, 'motivo');
  const o = await db.collection('orders').doc(orderId).get(); if (!o.exists) fail('not-found', 'Pedido não encontrado.'); const order = o.data();
  if (!['delivered', 'completed', 'delivery_failed'].includes(order.status)) fail('failed-precondition', 'Reembolso manual vale para pedidos entregues, concluídos ou com falha de entrega. Antes disso, cancele o pedido.');
  const left = order.totals.total - (order.refundedTotal || 0); if (left <= 0) fail('failed-precondition', 'Pedido já totalmente reembolsado.');
  const amount = d.amount != null ? int(d.amount, 1, 100_000_000, 'valor') : left; if (amount > left) fail('failed-precondition', 'Valor maior que o saldo reembolsável deste pedido.');
  await startRefund(orderId, amount, reason, { full: amount >= left, adjust: true });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'order.refund', target: `orders/${orderId}`, marketId: order.marketId, after: { amount, reason } });
  return { ok: true, amount };
});

/* ---- saldo e repasses ---- */
async function marketBalanceOf(reader, marketId) {
  const [lg, po] = await Promise.all([reader(db.collection('ledger').where('marketId', '==', marketId)), reader(db.collection('markets').doc(marketId).collection('payouts'))]);
  let credits = 0, debits = 0; lg.docs.forEach(x => { const e = x.data(); if (e.type === 'market_credit') credits += e.amount; else if (e.type === 'market_refund_debit') debits += e.amount; });
  let paid = 0, pending = 0; po.docs.forEach(x => { const p = x.data(); if (p.status === 'paid') paid += p.amount; else if (p.status === 'pending') pending += p.amount; });
  return { credits, debits, paid, pending, available: credits + debits - paid - pending };
}
exports.getMarketBalance = onCall(OPTS, async (req) => {
  const c = claims(req); let marketId = (req.data || {}).marketId;
  if (c.role === 'market_staff') { marketId = c.marketId; if (!c.perms.includes('finance.read')) fail('permission-denied', 'Sem permissão financeira.'); } else needPlatform(req, 'finance.read');
  return marketBalanceOf((q) => q.get(), str(marketId, 100, 'mercado'));
});
exports.adminRecordPayout = onCall({}, async (req) => {
  const c = needPlatform(req, 'finance.payouts'); const d = req.data || {}; const marketId = str(d.marketId, 100, 'mercado');
  const idem = d.idempotencyKey ? str(d.idempotencyKey, 80, 'chave') : null; const status = d.schedule ? 'pending' : 'paid'; let out;
  await db.runTransaction(async (tx) => {
    if (idem) { const ex = await tx.get(db.collection('idempotency').doc(`payout_${marketId}_${idem}`)); if (ex.exists) { out = { ...ex.data().result, duplicate: true }; return; } }
    const bal = await marketBalanceOf((q) => tx.get(q), marketId);
    const amount = d.amount != null ? int(d.amount, 1, 100_000_000_00, 'valor') : bal.available;
    if (!(amount > 0)) fail('failed-precondition', 'Não há saldo a repassar para este mercado.');
    if (amount > bal.available) fail('failed-precondition', `Saldo insuficiente: disponível R$ ${(bal.available / 100).toFixed(2).replace('.', ',')}.`);
    const pref = db.collection('markets').doc(marketId).collection('payouts').doc();
    tx.set(pref, { at: now(), amount, status, reference: optStr(d.reference, 120), by: c.uid, balanceBefore: bal.available, balanceAfter: bal.available - amount, simulated: true });
    if (status === 'paid') ledger(tx, { id: `payout_${pref.id}`, type: 'payout_paid', marketId, amount: -amount, meta: { payoutId: pref.id } });
    audit(tx, { actor: c.uid, actorRole: c.role, action: 'payout.record', target: pref.path, marketId, after: { amount, status, reference: d.reference || null } });
    notifyMarket(tx, marketId, { type: 'payout', title: status === 'paid' ? 'Repasse (simulado) realizado' : 'Repasse agendado', body: `R$ ${(amount / 100).toFixed(2).replace('.', ',')}`, ref: pref.id });
    out = { payoutId: pref.id, amount, status };
    if (idem) tx.set(db.collection('idempotency').doc(`payout_${marketId}_${idem}`), { at: now(), result: out });
  });
  return out;
});
exports.adminSettlePayout = onCall({}, async (req) => {
  const c = needPlatform(req, 'finance.payouts'); const d = req.data || {}; const marketId = str(d.marketId, 100, 'mercado'); const ref = db.collection('markets').doc(marketId).collection('payouts').doc(str(d.payoutId, 100, 'repasse'));
  await db.runTransaction(async (tx) => { const p = await tx.get(ref); if (!p.exists || p.data().status !== 'pending') fail('failed-precondition', 'Repasse não está pendente.'); tx.update(ref, { status: 'paid', paidAt: now(), settledBy: c.uid }); ledger(tx, { id: `payout_${ref.id}`, type: 'payout_paid', marketId, amount: -p.data().amount, meta: { payoutId: ref.id } }); audit(tx, { actor: c.uid, actorRole: c.role, action: 'payout.settle', target: ref.path, marketId }); });
  return { ok: true };
});
exports.adminReversePayout = onCall({}, async (req) => {
  const c = needPlatform(req, 'finance.payouts'); const d = req.data || {}; const marketId = str(d.marketId, 100, 'mercado'); const ref = db.collection('markets').doc(marketId).collection('payouts').doc(str(d.payoutId, 100, 'repasse')); const reason = str(d.reason, 300, 'motivo');
  await db.runTransaction(async (tx) => { const p = await tx.get(ref); if (!p.exists || !['paid', 'pending'].includes(p.data().status)) fail('failed-precondition', 'Repasse não pode ser estornado.'); const wasPaid = p.data().status === 'paid';
    tx.update(ref, { status: 'reversed', reversedAt: now(), reversedBy: c.uid, reverseReason: reason }); if (wasPaid) ledger(tx, { id: `payout_rev_${ref.id}`, type: 'payout_reversed', marketId, amount: p.data().amount, meta: { payoutId: ref.id } }); audit(tx, { actor: c.uid, actorRole: c.role, action: 'payout.reverse', target: ref.path, marketId, note: reason }); });
  return { ok: true };
});

/* ---- verificação de integridade ---- */
exports.adminIntegrityCheck = onCall({}, async (req) => {
  needPlatform(req, 'audit.read'); const issues = []; const add = (kind, ref, msg) => issues.push({ kind, ref, msg });
  const [mk, ord, res, led, pays, accs] = await Promise.all(['markets', 'orders', 'reservations', 'ledger', 'payments', 'accounts'].map(n => db.collection(n).get()));
  const accIds = new Set(accs.docs.map(x => x.id)); const marketIds = new Set(mk.docs.map(x => x.id));
  const resByListing = {}; res.docs.filter(x => x.data().status === 'active').forEach(x => (x.data().items || []).forEach(i => { const k = `${x.data().marketId}/${i.listingId}`; resByListing[k] = (resByListing[k] || 0) + i.qty; }));
  for (const m of mk.docs) { const ls = await db.collection('markets').doc(m.id).collection('listings').get();
    ls.docs.forEach(x => { const l = x.data(); const k = `${m.id}/${x.id}`;
      if ((l.reserved || 0) < 0 || (l.committed || 0) < 0 || (l.allocated || 0) < 0) add('estoque_negativo', k, `${l.name}: valores negativos`);
      if (R.availableQty(l) < 0) add('estoque_negativo', k, `${l.name}: disponível negativo`);
      if ((l.reserved || 0) !== (resByListing[k] || 0)) add('reserva_divergente', k, `${l.name}: reservado ${l.reserved || 0} ≠ reservas ativas ${resByListing[k] || 0}`); }); }
  const ledgerKinds = {}; led.docs.forEach(x => { const e = x.data(); if (e.orderId) { const k = `${e.type}:${e.orderId}`; ledgerKinds[k] = (ledgerKinds[k] || 0) + 1; } });
  const payById = Object.fromEntries(pays.docs.map(x => [x.id, x.data()]));
  for (const x of ord.docs) { const o = x.data(); const paidish = !['awaiting_payment', 'cancelled'].includes(o.status);
    if (!marketIds.has(o.marketId)) add('referencia_ausente', `orders/${x.id}`, 'mercado inexistente'); if (!accIds.has(o.customerId)) add('referencia_ausente', `orders/${x.id}`, 'cliente inexistente');
    if (paidish && ledgerKinds[`sale:${x.id}`] !== 1) add('razao_inconsistente', `orders/${x.id}`, `lançamentos de venda: ${ledgerKinds[`sale:${x.id}`] || 0} (esperado 1)`);
    if (['completed'].includes(o.status) && ledgerKinds[`market_credit:${x.id}`] !== 1) add('razao_inconsistente', `orders/${x.id}`, 'crédito do mercado ausente/duplicado');
    if (paidish && !payById[x.id]) add('pagamento_ausente', `orders/${x.id}`, 'pedido pago sem registro de pagamento');
    if (paidish && payById[x.id] && !['paid', 'refunded', 'partially_refunded', 'paid_needs_refund'].includes(payById[x.id].status)) add('pagamento_divergente', `orders/${x.id}`, `status do pagamento: ${payById[x.id].status}`);
    const rf = (o.refunds || []).filter(r => r.status === 'done').reduce((a, r) => a + r.amount, 0); const lr = led.docs.filter(e => e.data().type === 'refund_done' && e.data().orderId === x.id).reduce((a, e) => a - e.data().amount, 0);
    if (rf !== lr) add('reembolso_divergente', `orders/${x.id}`, `reembolsos concluídos ${rf} ≠ razão ${lr}`); }
  for (const m of mk.docs) { const b = await marketBalanceOf((q) => q.get(), m.id); if (b.available < 0) add('saldo_negativo', `markets/${m.id}`, `saldo disponível negativo: ${b.available}`); }
  return { ok: issues.length === 0, issues, checkedAt: Date.now(), counts: { markets: mk.size, orders: ord.size, ledger: led.size, payments: pays.size, accounts: accs.size } };
});

/* ============================ Simulador: contas e mercados (criação direta pelo administrador) ============================ */
exports.adminListAccounts = onCall(OPTS, async (req) => {
  needPlatform(req, 'users.read');
  const list = await auth.listAccounts();
  const markets = Object.fromEntries((await db.collection('markets').get()).docs.map(x => [x.id, x.data().name]));
  return { accounts: list.map(a => ({ ...a, marketName: a.marketId ? (markets[a.marketId] || a.marketId) : null })) };
});

exports.adminCreateAccount = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'users.write'); const d = req.data || {};
  const role = ['customer', 'platform_staff', 'market_staff', 'platform_admin'].includes(d.role) ? d.role : fail('invalid-argument', 'Perfil inválido.');
  if (role === 'platform_admin' && c.role !== 'platform_admin') fail('permission-denied', 'Somente administrador cria outro administrador.');
  let perms = [];
  if (role === 'platform_staff') perms = R.sanitizePerms(d.perms, R.PLATFORM_PERMS);
  if (role === 'market_staff') { const m = await db.collection('markets').doc(str(d.marketId, 100, 'mercado')).get(); if (!m.exists) fail('not-found', 'Mercado não encontrado.'); perms = R.sanitizePerms(d.preset && R.MARKET_ROLE_PRESETS[d.preset] || d.perms || R.MARKET_PERMS, R.MARKET_PERMS); }
  const r = await auth.createAccount({ username: d.username, name: d.name, password: d.password || undefined, role, marketId: role === 'market_staff' ? d.marketId : null, perms, mustChangePassword: !d.password }, c.uid);
  if (role === 'customer') await db.collection('users').doc(r.account.uid).set({ name: r.account.name, phone: '', email: '', createdAt: now(), prefs: { orderUpdates: true, promos: false } });
  if (role === 'market_staff') await db.collection('markets').doc(d.marketId).collection('staff').doc(r.account.uid).set({ name: r.account.name, email: r.account.email, perms, preset: d.preset || null, active: true, createdAt: now(), createdBy: c.uid });
  if (role === 'platform_staff') await db.collection('staff').doc(r.account.uid).set({ name: r.account.name, email: r.account.email, perms, active: true, createdAt: now(), createdBy: c.uid });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'account.create', target: `accounts/${r.account.uid}`, marketId: d.marketId || null, after: { username: r.account.username, role } });
  return { uid: r.account.uid, username: r.account.username, temporaryPassword: d.password ? null : r.password };
});

exports.adminUpdateAccount = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'users.write'); const d = req.data || {};
  const uid = str(d.uid, 128, 'conta'); const before = await auth.getAccount(uid); if (!before) fail('not-found', 'Conta não encontrada.');
  if (before.role === 'platform_admin' && c.role !== 'platform_admin') fail('permission-denied', 'Somente administrador altera outro administrador.');
  const patch = {}; if (d.name !== undefined) patch.name = d.name; if (typeof d.active === 'boolean') { if (uid === c.uid && !d.active) fail('failed-precondition', 'Você não pode desativar a própria conta.'); patch.active = d.active; }
  try { await auth.updateAccount(uid, patch); } catch (e) { if (e.code === 'last-admin') fail('failed-precondition', e.message); throw e; }
  let temp = null; if (d.resetPassword) { temp = d.newPassword || auth.tempPasswordGen(); await auth.setPassword(uid, temp); await db.doc(`accounts/${uid}`).update({ mustChangePassword: !d.newPassword }); }
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'account.update', target: `accounts/${uid}`, marketId: before.marketId || null, before: { active: before.active, name: before.displayName }, after: { ...patch, passwordReset: !!d.resetPassword } });
  return { ok: true, temporaryPassword: d.newPassword ? null : temp };
});

exports.accountChangeOwnPassword = onCall(OPTS, async (req) => {
  const c = claims(req); const d = req.data || {};
  await auth.setPassword(c.uid, String(d.newPassword || ''), { requireOld: String(d.oldPassword || '') });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'account.password_change', target: `accounts/${c.uid}` });
  return { ok: true };
});

exports.accountUpdateProfile = onCall(OPTS, async (req) => {
  const c = claims(req); const name = str((req.data || {}).name, 120, 'nome');
  await auth.updateAccount(c.uid, { name });
  const u = await db.collection('users').doc(c.uid).get(); if (u.exists) await u.ref.update({ name });
  return { ok: true };
});

exports.adminCreateMarket = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'markets.write'); const d = req.data || {};
  const name = str(d.name, 120, 'nome fantasia');
  const cityId = str(d.cityId, 80, 'cidade'); if (!(await db.collection('cities').doc(cityId).get()).exists) fail('invalid-argument', 'Cidade inexistente. Cadastre a cidade antes.');
  const pct = Number(d.commissionPercent); if (!(pct >= 0 && pct <= 50)) fail('invalid-argument', 'Comissão deve ficar entre 0% e 50%.');
  const cnpj = d.cnpj ? String(d.cnpj).replace(/\D/g, '') : null; if (cnpj && cnpj.length !== 14) fail('invalid-argument', 'CNPJ deve ter 14 dígitos.');
  if (cnpj) { const dup = await db.collection('marketAdmin').where('cnpj', '==', cnpj).limit(1).get(); if (!dup.empty) fail('already-exists', 'Já existe mercado com este CNPJ.'); }
  const marketId = slug(name) + '-' + crypto.randomBytes(2).toString('hex');
  const ownerName = d.owner && d.owner.username ? d.owner : null; if (!ownerName) fail('invalid-argument', 'Informe o usuário do responsável pelo mercado.');
  const settings = { hours: d.hours, deliveryFee: d.deliveryFee ?? 0, freeShippingAbove: d.freeShippingAbove ?? null, minOrder: d.minOrder ?? 0, etaMinutes: d.etaMinutes ?? 60, deliveryArea: d.deliveryArea, lowStockDefault: d.lowStockDefault ?? 5, scheduling: { enabled: d.scheduling !== false, slotMinutes: 60 } };
  // cria o responsável primeiro (se o usuário já existir, nada é criado)
  const acc = await auth.createAccount({ username: d.owner.username, name: d.owner.name || ownerName.username, password: d.owner.password || undefined, role: 'market_staff', marketId, perms: R.MARKET_PERMS, mustChangePassword: !d.owner.password }, c.uid);
  try {
    await db.runTransaction(async (tx) => {
      tx.set(db.collection('markets').doc(marketId), { name, cityId, status: 'awaiting_setup', acceptingOrders: false, ratingSum: 0, ratingCount: 0, ratingAvg: 0, createdAt: now(), description: optStr(d.description, 500), addressText: optStr(d.address, 200), phone: optStr(d.phone, 30), contactEmail: optStr(d.email, 120) });
      tx.set(db.collection('marketAdmin').doc(marketId), { commissionRate: Math.round(pct * 100) / 10000, ownerUid: acc.account.uid, ownerHistory: [], legalName: optStr(d.legalName, 160), cnpj, responsibleName: optStr(d.responsibleName, 120), createdAt: now() });
      tx.set(db.collection('markets').doc(marketId).collection('staff').doc(acc.account.uid), { name: acc.account.name, email: acc.account.email, perms: R.MARKET_PERMS, preset: 'manager', active: true, createdAt: now(), createdBy: c.uid });
      audit(tx, { actor: c.uid, actorRole: c.role, action: 'market.create', target: `markets/${marketId}`, marketId, after: { cityId, commissionPercent: pct } });
    });
  } catch (e) { await auth.updateAccount(acc.account.uid, { active: false }).catch(() => {}); throw e; }
  const real = { settings: {} };
  await exports.marketUpdateSettings({ auth: { uid: acc.account.uid, token: { role: 'market_staff', marketId, perms: R.MARKET_PERMS } }, data: { marketId, settings: Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined)) } });
  if (d.status === 'active') await exports.adminSetMarketStatus({ auth: req.auth, data: { marketId, status: 'active', reason: 'Cadastro inicial' } }).then(() => exports.marketUpdateSettings({ auth: { uid: acc.account.uid, token: { role: 'market_staff', marketId, perms: R.MARKET_PERMS } }, data: { marketId, settings: {}, acceptingOrders: true } }));
  return { marketId, ownerUid: acc.account.uid, ownerUsername: acc.account.username, temporaryPassword: d.owner.password ? null : acc.password };
});

/* ============================ Pagamento SIMULADO ============================ */
const PAY_OUTCOMES = ['approve', 'refuse', 'processing', 'expire'];
exports.simulatePayment = onCall({}, async (req) => {
  const c = claims(req); const d = req.data || {};
  const orderId = str(d.orderId, 100, 'pedido');
  const outcome = PAY_OUTCOMES.includes(d.outcome) ? d.outcome : fail('invalid-argument', 'Resultado de pagamento inválido.');
  const subId = d.subId ? str(d.subId, 100, 'substituição') : null;
  const payId = subId ? `${orderId}__sub_${subId}` : orderId;
  const [o, p] = await Promise.all([db.collection('orders').doc(orderId).get(), db.collection('payments').doc(payId).get()]);
  if (!o.exists || !p.exists) fail('not-found', 'Pedido ou pagamento não encontrado.');
  const order = o.data(); let pay = p.data();
  if (order.customerId !== c.uid && c.role !== 'platform_admin') fail('permission-denied', 'Você não pode simular o pagamento deste pedido.');
  if (!subId) {
    if (order.status === 'awaiting_payment' && order.expiresAt.toMillis() <= Date.now()) { await cancelPendingOrder(orderId, 'expired'); fail('failed-precondition', 'A reserva expirou. Os itens foram liberados; faça um novo pedido.'); }
    if (order.status !== 'awaiting_payment') { if (pay.status === 'paid') return { ok: true, duplicate: true, status: 'paid' }; fail('failed-precondition', 'Este pedido não está aguardando pagamento.'); }
  } else if (pay.status === 'paid') return { ok: true, duplicate: true, status: 'paid' };
  if (pay.status === 'paid') return { ok: true, duplicate: true, status: 'paid' };
  const attemptId = d.attemptKey ? `${payId}_${str(d.attemptKey, 80, 'tentativa')}` : db.collection('_').doc().id;
  try { await db.collection('payAttempts').doc(attemptId).create({ id: attemptId, payId, orderId, subId, outcome, by: c.uid, amount: pay.amount, method: pay.method || 'pix', at: now(), simulated: true }); }
  catch (e) { if (e.code === 6) return { ok: true, duplicate: true, status: pay.status }; throw e; }
  const entry = { id: attemptId, outcome, at: TS.now(), by: c.uid };
  const payRef = db.collection('payments').doc(payId); const orderRef = db.collection('orders').doc(orderId); const chargeRef = db.collection('payCharges').doc(pay.providerChargeId);
  if (outcome === 'approve') {
    await chargeRef.update({ status: 'paid', paidAmount: pay.amount, paidAt: now() });
    await payRef.update({ attempts: FV.arrayUnion({ ...entry, outcome: 'approved' }) });
    await processProviderEvent({ id: `${pay.providerChargeId}:paid`, type: 'charge.paid', chargeId: pay.providerChargeId });
  } else if (outcome === 'refuse' || (outcome === 'expire' && subId)) {
    await payRef.update({ status: 'refused', refusedCount: FV.increment(1), attempts: FV.arrayUnion({ ...entry, outcome: 'refused' }), updatedAt: now() });
    if (!subId) await orderRef.update({ 'payment.status': 'refused' });
    await db.collection('orders').doc(orderId).collection('events').add({ at: now(), type: 'payment_refused', actor: c.uid, data: { attemptId }, from: null, to: null });
    await notifyUser(null, order.customerId, { type: 'payment_refused', title: 'Pagamento recusado (simulação)', body: 'Você pode tentar de novo enquanto a reserva estiver ativa.', ref: orderId });
    await audit(null, { actor: c.uid, actorRole: c.role, action: 'payment.refused', target: `payments/${payId}`, marketId: order.marketId, after: { attemptId } });
  } else if (outcome === 'processing') {
    await payRef.update({ status: 'processing', attempts: FV.arrayUnion({ ...entry, outcome: 'processing' }), updatedAt: now() });
    if (!subId) await orderRef.update({ 'payment.status': 'processing' });
  } else if (outcome === 'expire') {
    await chargeRef.update({ status: 'expired' });
    await payRef.update({ attempts: FV.arrayUnion({ ...entry, outcome: 'expired' }) });
    await processProviderEvent({ id: `${pay.providerChargeId}:expired`, type: 'charge.expired', chargeId: pay.providerChargeId });
    await payRef.set({ status: 'expired' }, { merge: true });
  }
  const after = (await payRef.get()).data();
  return { ok: true, status: after.status, attemptId };
});

/** Manutenção: expira reservas/pedidos vencidos, substituições sem resposta e sinaliza atrasos. Idempotente; roda ao abrir o app e periodicamente. */
async function sweep() {
  const out = { expiredOrders: 0, substitutions: 0 };
  const q = await db.collection('orders').where('status', '==', 'awaiting_payment').where('expiresAt', '<=', TS.now()).limit(500).get();
  for (const doc of q.docs) { try { const r = await cancelPendingOrder(doc.id, 'expired'); if (r.cancelled) out.expiredOrders++; } catch (e) { console.warn('expiração falhou', doc.id, e.message); } }
  const del = await db.collection('orders').where('status', '==', 'delivered').where('disputeUntil', '<=', TS.now()).limit(500).get();
  for (const doc of del.docs) { if (doc.data().disputed) continue; try { if (await completeOrderInternal(doc.id, 'system', 'prazo de contestação encerrado')) out.completed = (out.completed || 0) + 1; } catch (e) { console.warn(e.message); } }
  try { await exports.expireSubstitutions(); } catch (e) { console.warn(e.message); }
  try { await exports.flagLateOrders(); } catch (e) { console.warn(e.message); }
  return out;
}
exports.runMaintenance = onCall({}, async () => sweep());

/* ============================ Despacho local ============================ */
async function call(name, data, ctx) {
  const fn = exports[name];
  if (typeof fn !== 'function' || name.startsWith('_')) throw new HttpsError('not-found', 'Função inexistente: ' + name);
  return fn({ data: data || {}, auth: ctx && ctx.auth ? ctx.auth : null });
}
return { exports, call, internals: { confirmPayment, cancelPendingOrder, startRefund, markRefundDone, processProviderEvent, sweep } };
}
return { createBackend, HttpsError };
});
