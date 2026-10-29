'use strict';
process.env.TZ = process.env.TZ || 'America/Sao_Paulo'; // horários dos mercados são locais (Brasil, sem horário de verão)
/**
 * Meu Mercado — Cloud Functions (operações privilegiadas).
 * Toda decisão que envolve preço, estoque, pagamento, permissão ou estado do pedido é tomada AQUI,
 * nunca no navegador. O Admin SDK ignora as regras do Firestore; por isso cada função valida papel/permissão.
 */
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');
const R = require('./business-rules.js');
const { getProvider } = require('./payment-provider.js');

admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const TS = admin.firestore.Timestamp;
const WEBHOOK_SECRET = defineSecret('PAYMENT_WEBHOOK_SECRET');
const OPTS = { region: 'southamerica-east1', cors: true, maxInstances: 20 };
// Recomendado em produção: ative App Check e use enforceAppCheck: true em OPTS (veja README).

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
  await db.runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    if (d.parentId) { const p = await tx.get(db.collection('categories').doc(d.parentId)); if (!p.exists) fail('invalid-argument', 'Categoria-pai inexistente.'); if (d.parentId === id) fail('invalid-argument', 'Categoria não pode ser pai de si mesma.'); }
    const next = { name, parentId: d.parentId || null, order: int(d.order ?? 0, 0, 9999, 'ordem'), active: d.active !== false, icon: optStr(d.icon, 8), updatedAt: now() };
    tx.set(ref, cur.exists ? next : { ...next, createdAt: now() }, { merge: true });
    audit(tx, { actor: c.uid, actorRole: c.role, action: cur.exists ? 'category.update' : 'category.create', target: `categories/${id}`, before: cur.exists ? cur.data() : null, after: next });
  });
  return { id };
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
async function inviteUser({ email, name, claimsObj, collection, docId, extra }) {
  let user;
  try { user = await admin.auth().getUserByEmail(email); }
  catch { user = await admin.auth().createUser({ email, displayName: name, emailVerified: false, disabled: false }); }
  await admin.auth().setCustomUserClaims(user.uid, claimsObj);
  await admin.auth().revokeRefreshTokens(user.uid);       // força renovar o token com as novas claims
  // Link para o convidado DEFINIR a própria senha. Nunca há senha compartilhada.
  const link = await admin.auth().generatePasswordResetLink(email);
  return { user, link };
}

exports.adminInviteStaff = onCall(OPTS, async (req) => {
  const c = needPlatform(req, 'staff.manage');
  const d = req.data || {};
  const email = str(d.email, 160, 'e-mail').toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('invalid-argument', 'E-mail inválido.');
  const perms = R.sanitizePerms(d.perms, R.PLATFORM_PERMS);
  if (c.role !== 'platform_admin') { // delegação limitada: não concede o que não possui
    if (perms.some(p => !c.perms.includes(p))) fail('permission-denied', 'Você não pode conceder permissões que não possui.');
  }
  const { user, link } = await inviteUser({ email, name: optStr(d.name, 120), claimsObj: { role: 'platform_staff', perms } });
  const staffDoc = { name: optStr(d.name, 120), email, department: optStr(d.department, 60), title: optStr(d.title, 60), perms, active: true, managerUid: d.managerUid || null, createdAt: now(), createdBy: c.uid };
  await db.collection('staff').doc(user.uid).set(staffDoc, { merge: true });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'staff.invite', target: `staff/${user.uid}`, after: { email, perms } });
  return { uid: user.uid, passwordSetupLink: link, note: 'Envie este link ao funcionário; ele define a própria senha. Recomende ativar autenticação multifator.' };
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
  const email = str(d.email, 160, 'e-mail').toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('invalid-argument', 'E-mail inválido.');
  const preset = d.preset && R.MARKET_ROLE_PRESETS[d.preset];
  const perms = R.sanitizePerms(preset || d.perms, R.MARKET_PERMS);
  if (perms.some(p => !c.perms.includes(p))) fail('permission-denied', 'Você não pode conceder permissões que não possui.'); // sem escalada de privilégio
  const existing = await admin.auth().getUserByEmail(email).catch(() => null);
  if (existing && existing.customClaims && existing.customClaims.role && existing.customClaims.marketId !== marketId) fail('failed-precondition', 'Este e-mail já pertence a outra equipe.');
  const { user, link } = await inviteUser({ email, name: optStr(d.name, 120), claimsObj: { role: 'market_staff', marketId, perms } });
  await db.collection('markets').doc(marketId).collection('staff').doc(user.uid).set({ name: optStr(d.name, 120), email, preset: d.preset || null, perms, active: true, createdAt: now(), createdBy: c.uid }, { merge: true });
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'marketStaff.invite', target: `markets/${marketId}/staff/${user.uid}`, marketId, after: { email, perms } });
  return { uid: user.uid, passwordSetupLink: link };
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
    validFrom: optStr(d.validFrom, 30), validTo: optStr(d.validTo, 30), stackWithPromo: d.stackWithPromo === true, visibility: d.visibility === 'public' ? 'public' : 'private', active: d.active !== false, updatedAt: now() };
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
  let coupon = null, userUses = 0;
  if (d.coupon && req.auth) {
    const cs = await db.collection('coupons').doc(String(d.coupon).toUpperCase()).get();
    coupon = cs.exists ? cs.data() : { active: false };
    userUses = (await db.collection('users').doc(req.auth.uid).collection('couponUses').doc(String(d.coupon).toUpperCase()).get()).data()?.count || 0;
  } else if (d.coupon) fail('unauthenticated', 'Entre na sua conta para aplicar cupons.');
  const q = R.computeQuote({ marketId, userId: req.auth?.uid, userUses, items, listings, coupon, expectedPrices: d.expectedPrices || null,
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
  if (method !== 'pix' && !d.cardToken) fail('invalid-argument', 'Cartão: use o token gerado pelo provedor de pagamento (dados do cartão nunca são enviados a este sistema).');
  const idemKey = str(d.idempotencyKey, 80, 'chave de idempotência');
  const prior = await loadOrderIfSame(c.uid, idemKey);
  if (prior) { const p = await db.collection('payments').doc(prior.orderId).get(); return { orderId: prior.orderId, duplicate: true, payment: p.data()?.public || null }; }

  const provider = getProvider();
  if (!provider.configured) fail('failed-precondition', 'PROVIDER_NOT_CONFIGURED: o pagamento online ainda não foi configurado pela plataforma.');

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

  const orderRef = db.collection('orders').doc();
  const orderId = orderRef.id;
  const listingRefs = items.map(i => db.collection('markets').doc(marketId).collection('listings').doc(i.listingId));
  const couponCode = d.coupon ? String(d.coupon).toUpperCase() : null;
  const expiresAt = plusMin(cfg.reservationMinutes);
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
    const q = R.computeQuote({ nowMs: Date.now(), marketId, userId: c.uid, userUses: usesSnap?.data()?.count || 0, items, listings, coupon: csnap ? (csnap.exists ? csnap.data() : { active: false }) : null,
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
      createdAt: now(), expiresAt, idempotencyKey: idemKey, refundedTotal: 0, refunds: []
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
    if (['confirmed', 'picking', 'picked', 'ready_for_dispatch', 'out_for_delivery', 'delivered'].includes(order.status)) { outcome = { done: true, idempotent: true }; return; }
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
    ledger(tx, { type: 'sale', orderId, marketId: order.marketId, amount: t.total, meta: { itemsPaid: t.itemsPaid, deliveryPaid: t.deliveryPaid, commission: t.commission, platformSubsidy: t.platformSubsidy, marketReceivable: t.marketReceivable } });
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

exports.expireStaleOrders = onSchedule({ ...OPTS, schedule: 'every 5 minutes', timeoutSeconds: 300 }, async () => {
  const q = await db.collection('orders').where('status', '==', 'awaiting_payment').where('expiresAt', '<', TS.fromMillis(Date.now() - 60000)).limit(100).get();
  for (const doc of q.docs) {
    try { await cancelPendingOrder(doc.id, 'expired'); }
    catch (e) { console.warn('expiração adiada (provedor indisponível?)', doc.id, e.message); } // sem verificação não há cancelamento
  }
});

exports.paymentWebhook = onRequest({ region: OPTS.region, secrets: [WEBHOOK_SECRET], maxInstances: 20 }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('method not allowed'); return; }
  const provider = getProvider();
  const v = provider.verifyWebhook(req.rawBody, req.headers, WEBHOOK_SECRET.value());
  if (!v.valid) { console.warn('webhook com assinatura inválida'); res.status(401).send('invalid signature'); return; }
  const ev = v.event;
  try {
    // Idempotência: cada evento do provedor é processado no máximo uma vez.
    const evRef = db.collection('webhookEvents').doc(String(ev.id));
    try { await evRef.create({ type: ev.type, chargeId: ev.chargeId, receivedAt: now(), status: 'processing' }); }
    catch (e) { res.status(200).send('duplicate'); return; }

    const paySnap = await db.collection('payments').where('providerChargeId', '==', ev.chargeId).limit(1).get();
    if (paySnap.empty) { await evRef.update({ status: 'unmatched' }); res.status(200).send('unmatched'); return; }
    const pay = paySnap.docs[0]; const orderId = pay.data().orderId || pay.id;
    // Eventos fora de ordem: ignora sequência antiga.
    if (ev.sequence != null && pay.data().lastSeq != null && ev.sequence < pay.data().lastSeq) { await evRef.update({ status: 'stale' }); res.status(200).send('stale'); return; }
    if (ev.sequence != null) await pay.ref.update({ lastSeq: ev.sequence });

    // Nunca confiamos só no corpo: consultamos o estado real quando o evento afirma pagamento.
    if (ev.type === 'charge.paid') {
      const ch = await provider.getCharge(ev.chargeId);
      if (ch.status === 'paid') {
        if (pay.data().kind === 'substitution_extra') await applySubstitutionPaid(pay.data(), ch);
        else await confirmPayment(orderId, { paidAmount: ch.paidAmount, source: 'webhook', providerFee: ch.providerFee });
      }
    } else if (ev.type === 'charge.failed' || ev.type === 'charge.expired') {
      if (pay.data().kind !== 'substitution_extra') await cancelPendingOrder(orderId, ev.type === 'charge.failed' ? 'payment_failed' : 'expired');
    } else if (ev.type === 'refund.done') {
      await markRefundDone(orderId, ev.refundId);
    } else if (ev.type === 'chargeback') {
      await db.collection('tickets').add({ requesterId: pay.data().customerId, requesterRole: 'system', marketId: pay.data().marketId, orderId, category: 'chargeback', subject: `Chargeback no pedido ${orderId}`, status: 'open', priority: 'urgent', createdAt: now() });
      await ledger(null, { type: 'chargeback', orderId, marketId: pay.data().marketId, amount: -(ev.amount ?? pay.data().amount) });
      await audit(null, { actor: 'system', action: 'payment.chargeback', target: `payments/${orderId}`, marketId: pay.data().marketId, after: ev });
    }
    await evRef.update({ status: 'done', doneAt: now() });
    res.status(200).send('ok');
  } catch (e) {
    console.error('erro no webhook', ev && ev.id, e);
    if (ev && ev.id) await db.collection('webhookEvents').doc(String(ev.id)).delete().catch(() => {}); // permite nova entrega do provedor
    res.status(500).send('retry');
  }
});

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
    tx.update(orderRef, { refunds: FV.arrayUnion({ id: refundId, amount, reason, status: 'pending', at: TS.now() }), refundedTotal: FV.increment(amount), ...(opts.full ? { status: 'refund_processing', refundFinalTo: 'refunded' } : {}) });
    ledger(tx, { type: 'refund_pending', orderId, marketId: o.marketId, amount: -amount, meta: { reason, refundId } });
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
    tx.update(orderRef, patch);
    ledger(tx, { type: 'refund_done', orderId, marketId: order.marketId, amount: -amount, meta: { refundId, providerRefundId } });
    orderEvent(tx, orderId, { type: 'refund_done', data: { amount }, ...(patch.status ? { from: 'refund_processing', to: patch.status } : {}) });
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
    tx.update(ref, { status: 'delivered', deliveredAt: now(), deliveredBy: c.uid });
    orderEvent(tx, orderId, { type: 'delivered', actor: c.uid, from: 'out_for_delivery', to: 'delivered', data: { validation: 'code_ok' } });
    ledger(tx, { type: 'delivery_confirmed', orderId, marketId: order.marketId, amount: (order.final || order.totals).marketReceivable });
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
    tx.set(sref, { status: 'pending', listingId: d.listingId, itemName: line.name, qty, missingValue, substitute, diff: substitute ? substitute.net - missingValue : null, createdBy: c.uid, createdAt: now(), expiresAt: plusMin(cfg.substitutionTimeoutMinutes) });
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
    const provider = getProvider(); if (!provider.configured) fail('failed-precondition', 'PROVIDER_NOT_CONFIGURED');
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
    try { await resolveMissing(o.data(), orderRef.id, doc.data(), doc.ref, 'decline', 'system'); } catch (e) { console.warn('substituição não resolvida', doc.ref.path, e.message); }
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
    if (o.data().status !== 'delivered') fail('failed-precondition', 'Só é possível avaliar após a entrega.'); // compra real
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
const SOLD = ['confirmed', 'picking', 'picked', 'ready_for_dispatch', 'out_for_delivery', 'delivered', 'refund_processing', 'refunded'];

function reportRow(id, o) {
  let f = o.final || o.totals; const t = o.totals;
  // Pedido totalmente reembolsado: não gera comissão nem valor a repassar (o reembolso fica registrado).
  if (['refund_processing', 'refunded'].includes(o.status) && (o.refundedTotal || 0) >= f.total) f = { ...f, itemsPaid: 0, commission: 0, marketReceivable: 0, deliveryFee: 0, deliveryDiscountMarket: 0, total: 0 };
  return {
    orderId: id, at: o.createdAt.toMillis(), status: o.status, cityId: o.cityId || null, marketId: o.marketId, marketName: o.marketName,
    gross: t.subtotalList, discounts: t.promoDiscount + t.couponDiscountMarket + t.couponDiscountPlatform, subsidy: t.platformSubsidy || 0,
    itemsPaid: f.itemsPaid, deliveryFee: f.deliveryFee - f.deliveryDiscountMarket, commission: f.commission, refunds: o.refundedTotal || 0,
    marketReceivable: f.marketReceivable, total: t.total, paidOut: !!o.payoutId, delivered: o.status === 'delivered'
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
  const rows = snap.docs.filter(x => SOLD.includes(x.data().status)).map(x => reportRow(x.id, x.data())).filter(r => !d.cityId || r.cityId === d.cityId);
  const sum = summarize(rows);
  const payouts = marketId ? (await db.collection('markets').doc(marketId).collection('payouts').orderBy('at', 'desc').limit(50).get()).docs.map(x => ({ id: x.id, ...x.data(), at: x.data().at?.toMillis() })) : [];
  if (c.role === 'market_staff') { delete sum.gmv; } // mercado vê as próprias vendas; GMV global é visão da plataforma
  return { rows: rows.slice(0, 2000), truncated: rows.length > 2000, summary: sum, payouts };
});

exports.adminRecordPayout = onCall({ ...OPTS, timeoutSeconds: 120 }, async (req) => {
  const c = needPlatform(req, 'finance.payouts'); const d = req.data || {};
  const marketId = str(d.marketId, 100, 'mercado');
  const snap = await db.collection('orders').where('marketId', '==', marketId).where('status', '==', 'delivered').where('payoutId', '==', null).limit(400).get();
  const ids = Array.isArray(d.orderIds) ? new Set(d.orderIds) : null;
  const docs = snap.docs.filter(x => !ids || ids.has(x.id));
  if (!docs.length) fail('failed-precondition', 'Nenhum pedido entregue pendente de repasse.');
  const amount = docs.reduce((s, x) => s + (x.data().final || x.data().totals).marketReceivable, 0);
  const pref = db.collection('markets').doc(marketId).collection('payouts').doc();
  const b = db.batch();
  b.set(pref, { at: now(), amount, orderCount: docs.length, reference: optStr(d.reference, 120), by: c.uid, status: 'paid' });
  docs.forEach(x => b.update(x.ref, { payoutId: pref.id }));
  b.set(db.collection('ledger').doc(), { at: now(), type: 'payout_paid', marketId, amount: -amount, orderId: null, meta: { payoutId: pref.id } });
  await b.commit();
  await audit(null, { actor: c.uid, actorRole: c.role, action: 'payout.record', target: pref.path, marketId, after: { amount, orders: docs.length, reference: d.reference || null } });
  return { payoutId: pref.id, amount, orders: docs.length };
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
