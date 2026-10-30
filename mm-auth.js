/* Meu Mercado Teste — mm-auth.js
 * Contas locais (usuário + senha), sessão e "claims" (papel, mercado, permissões).
 * ATENÇÃO: isto é conveniência de laboratório, NÃO é segurança de produção. Quem controla o navegador pode ler ou alterar o
 * banco local (inclusive os hashes de senha). As senhas nunca são guardadas em texto puro: PBKDF2-SHA256 com sal individual.
 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./mm-store.js')); else root.MMAuth = factory(root.MMStore); })(typeof self !== 'undefined' ? self : this, function (MMStore) {
  'use strict';
  const { Timestamp, autoId } = MMStore;
  const subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : require('crypto').webcrypto.subtle;
  const getRandom = (a) => (typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : require('crypto').webcrypto).getRandomValues(a);
  const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; u.forEach(b => { s += String.fromCharCode(b); }); return typeof btoa === 'function' ? btoa(s) : Buffer.from(u).toString('base64'); };
  const unb64 = (s) => { if (typeof atob === 'function') { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; } return new Uint8Array(Buffer.from(s, 'base64')); };
  const fail = (code, msg) => Object.assign(new Error(msg), { code });

  const ROLES = { platform_admin: 'Administrador', platform_staff: 'Equipe da plataforma', market_staff: 'Mercado', customer: 'Cliente' };
  const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
  const normUser = (u) => String(u || '').trim().toLowerCase();
  const TEMP_ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
  const tempPassword = () => Array.from(getRandom(new Uint8Array(8)), b => TEMP_ALPHA[b % TEMP_ALPHA.length]).join('');

  function create(store, opts = {}) {
    let iterations = opts.iterations || 150000;
    const storage = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const listeners = new Set(); let session = null; const attempts = new Map();
    const SKEY = 'mm.sessao';
    const db = store.db;

    async function derive(password, saltU8, iter) {
      const key = await subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
      return b64(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltU8, iterations: iter }, key, 256));
    }
    async function makeSecret(password) { const salt = getRandom(new Uint8Array(16)); const iter = iterations; return { salt: b64(salt), iter, hash: await derive(password, salt, iter) }; }
    function checkPassword(p) { if (typeof p !== 'string' || p.length < 4) throw fail('weak-password', 'A senha precisa ter 4 dígitos numéricos.'); if (p.length > 100) throw fail('weak-password', 'Senha longa demais.'); }
    function checkUsername(u) { if (!USERNAME_RE.test(u)) throw fail('invalid-username', 'Usuário inválido: use de 3 a 30 letras minúsculas, números, ponto, hífen ou sublinhado.'); }

    const publicView = (a) => a && ({ uid: a.uid, username: a.username, name: a.displayName, role: a.role, marketId: a.marketId || null, perms: a.perms || [], active: a.active !== false, email: `${a.username}@local`, createdAt: a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : a.createdAt, lastLoginAt: a.lastLoginAt && a.lastLoginAt.toMillis ? a.lastLoginAt.toMillis() : (a.lastLoginAt || null) });
    const claimsOf = (a) => ({ role: a.role, marketId: a.marketId || null, perms: a.perms || [], email: `${a.username}@local` });

    async function getByUsername(username) { const u = await db.doc(`usernames/${normUser(username)}`).get(); if (!u.exists) return null; const a = await db.doc(`accounts/${u.data().uid}`).get(); return a.exists ? a.data() : null; }
    async function getAccount(uid) { const a = await db.doc(`accounts/${uid}`).get(); return a.exists ? a.data() : null; }
    async function hasAdmin() { const q = await db.collection('accounts').where('role', '==', 'platform_admin').limit(1).get(); return !q.empty; }
    async function setupDone() { return (await db.doc('system/setup').get()).exists; }

    /** Cria conta (uso interno e pelas funções do backend). A unicidade do usuário é garantida por um documento-índice. */
    async function createAccount(spec, actor) {
      const username = normUser(spec.username); checkUsername(username);
      const password = spec.password || tempPassword(); checkPassword(password);
      if (!ROLES[spec.role]) throw fail('invalid-role', 'Perfil inválido.');
      if (spec.role === 'market_staff' && !spec.marketId) throw fail('invalid-argument', 'Conta de mercado precisa de um mercado.');
      const uid = spec.uid || autoId(); const secret = await makeSecret(password);
      const acc = { uid, username, displayName: String(spec.name || username).trim().slice(0, 120) || username, role: spec.role, marketId: spec.marketId || null, perms: Array.isArray(spec.perms) ? spec.perms : [], active: spec.active !== false,
        salt: secret.salt, iter: secret.iter, hash: secret.hash, createdAt: Timestamp.now(), createdBy: actor || null, mustChangePassword: !!spec.mustChangePassword };
      try { await db.runTransaction(async (tx) => { const ex = await tx.get(db.doc(`usernames/${username}`)); if (ex.exists) throw fail('already-exists', 'Este nome de usuário já está em uso.'); tx.create(db.doc(`usernames/${username}`), { uid }); tx.create(db.doc(`accounts/${uid}`), acc); }); }
      catch (e) { if (e.code === 6) throw fail('already-exists', 'Este nome de usuário já está em uso.'); throw e; }
      return { account: publicView(acc), password };
    }
    /** Primeiro administrador: só funciona uma vez (documento system/setup é criado de forma atômica). */
    async function createFirstAdmin({ username, name, password }) {
      const username2 = normUser(username); checkUsername(username2); checkPassword(password);
      if (await hasAdmin()) throw fail('setup-closed', 'O administrador inicial já foi criado. A criação de novas contas é feita dentro do painel administrativo.');
      const uid = autoId(); const secret = await makeSecret(password);
      const acc = { uid, username: username2, displayName: String(name || username2).trim().slice(0, 120), role: 'platform_admin', marketId: null, perms: [], active: true, salt: secret.salt, iter: secret.iter, hash: secret.hash, createdAt: Timestamp.now(), createdBy: 'setup', mustChangePassword: false };
      try { await db.runTransaction(async (tx) => { const s = await tx.get(db.doc('system/setup')); if (s.exists) throw fail('setup-closed', 'O administrador inicial já foi criado.'); tx.create(db.doc('system/setup'), { at: Timestamp.now(), adminUid: uid, appVersion: opts.appVersion || null }); tx.create(db.doc(`usernames/${username2}`), { uid }); tx.create(db.doc(`accounts/${uid}`), acc); }); }
      catch (e) { if (e.code === 6) throw fail('already-exists', 'Este nome de usuário já está em uso.'); throw e; }
      await db.collection('auditLogs').add({ at: Timestamp.now(), actor: uid, actorRole: 'platform_admin', action: 'setup.first_admin', target: `accounts/${uid}`, marketId: null, before: null, after: { username: username2 }, note: 'Administrador inicial criado manualmente' });
      return setSession(acc);
    }
    function setSession(acc) { session = publicView(acc); try { storage && storage.setItem(SKEY, acc.uid); } catch (e) { /* sem storage */ } emit(); return session; }
    function emit() { listeners.forEach(f => { try { f(session); } catch (e) { console.error(e); } }); }

    async function signIn(username, password) {
      const un = normUser(username); const rec = attempts.get(un) || { n: 0, until: 0 };
      if (rec.until > Date.now()) throw fail('too-many-attempts', `Muitas tentativas. Aguarde ${Math.ceil((rec.until - Date.now()) / 1000)} s.`);
      const acc = await getByUsername(un);
      const bad = () => { rec.n++; if (rec.n >= 5) { rec.until = Date.now() + 15000; rec.n = 0; } attempts.set(un, rec); return fail('wrong-password', 'Usuário ou senha incorretos.'); };
      if (!acc) { await derive(String(password), new Uint8Array(16), 1000); throw bad(); }
      const h = await derive(String(password), unb64(acc.salt), acc.iter);
      if (h !== acc.hash) throw bad();
      if (acc.active === false) throw fail('account-disabled', 'Esta conta está desativada. Peça a um administrador para reativá-la.');
      attempts.delete(un);
      await db.doc(`accounts/${acc.uid}`).update({ lastLoginAt: Timestamp.now() }).catch(() => {});
      return setSession(acc);
    }
    /** Cadastro livre de cliente (tela de entrada). */
    async function signUpCustomer({ username, name, password }) {
      const { account } = await createAccount({ username, name, password, role: 'customer' }, 'self');
      await db.doc(`users/${account.uid}`).set({ name: account.name, phone: '', email: '', createdAt: Timestamp.now(), prefs: { orderUpdates: true, promos: false } });
      return signIn(username, password);
    }
    async function restore() { // reabre a sessão após recarregar
      let uid = null; try { uid = storage && storage.getItem(SKEY); } catch (e) { /* ignore */ }
      if (!uid) { session = null; emit(); return null; }
      const acc = await getAccount(uid); if (!acc || acc.active === false) { session = null; try { storage.removeItem(SKEY); } catch (e) { /* ignore */ } emit(); return null; }
      session = publicView(acc); emit(); return session;
    }
    function signOut() { session = null; try { storage && storage.removeItem(SKEY); } catch (e) { /* ignore */ } emit(); }
    /** Administrador entra como outra conta (atalho de teste). Fica registrado na auditoria. */
    async function impersonate(uid, byUid) { const by = await getAccount(byUid); if (!by || by.role !== 'platform_admin' || by.active === false) throw fail('permission-denied', 'Somente um administrador ativo pode entrar como outra conta.'); const acc = await getAccount(uid); if (!acc) throw fail('not-found', 'Conta não encontrada.'); if (acc.active === false) throw fail('account-disabled', 'Conta desativada.');
      await db.collection('auditLogs').add({ at: Timestamp.now(), actor: byUid, actorRole: 'platform_admin', action: 'account.impersonate', target: `accounts/${uid}`, marketId: acc.marketId || null, before: null, after: { username: acc.username }, note: 'Entrou como outra conta (teste)' });
      return setSession(acc); }
    async function setPassword(uid, newPassword, { requireOld, actor } = {}) {
      checkPassword(newPassword); const acc = await getAccount(uid); if (!acc) throw fail('not-found', 'Conta não encontrada.');
      if (requireOld !== undefined && (await derive(String(requireOld), unb64(acc.salt), acc.iter)) !== acc.hash) throw fail('wrong-password', 'Senha atual incorreta.');
      const s = await makeSecret(newPassword); await db.doc(`accounts/${uid}`).update({ salt: s.salt, iter: s.iter, hash: s.hash, mustChangePassword: false, passwordChangedAt: Timestamp.now() });
      return true;
    }
    async function listAccounts() { const q = await db.collection('accounts').get(); return q.docs.map(d => publicView(d.data())).sort((a, b) => a.username.localeCompare(b.username)); }
    async function updateAccount(uid, patch) {
      const acc = await getAccount(uid); if (!acc) throw fail('not-found', 'Conta não encontrada.'); const u = {};
      if (patch.name !== undefined) u.displayName = String(patch.name).trim().slice(0, 120) || acc.username;
      if (typeof patch.active === 'boolean') { if (!patch.active && acc.role === 'platform_admin' && (await db.collection('accounts').where('role', '==', 'platform_admin').get()).docs.filter(d => d.data().active !== false && d.id !== uid).length === 0) throw fail('last-admin', 'Não é possível desativar o último administrador ativo.'); u.active = patch.active; }
      if (patch.perms) u.perms = patch.perms; if (patch.marketId !== undefined) u.marketId = patch.marketId; if (patch.role) u.role = patch.role;
      if (Object.keys(u).length) await db.doc(`accounts/${uid}`).update(u);
      if (session && session.uid === uid) { const n = await getAccount(uid); session = n.active === false ? null : publicView(n); emit(); }
      return publicView(await getAccount(uid));
    }

    /* Adaptador com a forma do Admin SDK, usado pelo backend reaproveitado */
    const adminAuth = {
      async getUserByEmail(email) { const a = await getByUsername(String(email).replace(/@local$/, '')); if (!a) throw fail('auth/user-not-found', 'usuário não encontrado'); return { uid: a.uid, email: `${a.username}@local`, customClaims: claimsOf(a), disabled: a.active === false }; },
      async getUser(uid) { const a = await getAccount(uid); if (!a) throw fail('auth/user-not-found', 'usuário não encontrado'); return { uid: a.uid, email: `${a.username}@local`, customClaims: claimsOf(a), disabled: a.active === false }; },
      async createUser(p) { const un = String(p.email).replace(/@local$/, ''); const r = await createAccount({ username: un, name: p.displayName, role: 'customer', password: tempPassword(), mustChangePassword: true }, 'backend'); adminAuth._lastTemp = { [r.account.uid]: r.password }; return { uid: r.account.uid }; },
      async setCustomUserClaims(uid, c) { const a = await getAccount(uid); await db.doc(`accounts/${uid}`).update({ role: c.role || a.role, marketId: c.marketId || null, perms: c.perms || [] }); },
      async updateUser(uid, p) { if (typeof p.disabled === 'boolean') await updateAccount(uid, { active: !p.disabled }); },
      async revokeRefreshTokens() { /* sessão local: nada a revogar */ },
      async generatePasswordResetLink(email) { const a = await getByUsername(String(email).replace(/@local$/, '')); const pw = (adminAuth._lastTemp && adminAuth._lastTemp[a.uid]) || tempPassword(); await setPassword(a.uid, pw); await db.doc(`accounts/${a.uid}`).update({ mustChangePassword: true }); return 'SENHA-TEMPORARIA:' + pw; }
    };

    return { tempPasswordGen: tempPassword, createAccount, createFirstAdmin, signIn, signUpCustomer, signOut, restore, impersonate, setPassword, listAccounts, updateAccount, getAccount, getByUsername, hasAdmin, setupDone, adminAuth, claimsOf, publicView,
      current: () => session, onChange(f) { listeners.add(f); return () => listeners.delete(f); }, setIterations(n) { iterations = n; }, _forget() { session = null; try { storage && storage.removeItem(SKEY); } catch (e) { /* ignore */ } emit(); } };
  }
  return { create, ROLES, normUser, tempPassword };
});
