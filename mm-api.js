/* Meu Mercado Teste — mm-api.js
 * Fachada `api` (mesma interface usada pela interface: col/doc/watchCol/watchDoc/set/add/update/del/upload/call/...)
 * sobre o banco local. TODA leitura/escrita feita pela interface passa por `canRead`/`canWrite`, portados do
 * firestore.rules: a verificação de permissão está nas funções de dados, não apenas na tela.
 * O backend local (mm-backend.js) usa o acesso direto ao store (equivalente ao Admin SDK).
 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./mm-store.js')); else root.MMApi = factory(root.MMStore); })(typeof self !== 'undefined' ? self : this, function (MMStore) {
  'use strict';
  const { FieldValue, Timestamp, clone } = MMStore;
  const perr = (msg) => Object.assign(new Error(msg || 'Sem permissão para esta operação.'), { code: 'permission-denied' });
  const unauth = () => Object.assign(new Error('Entre na sua conta para continuar.'), { code: 'unauthenticated' });

  function normalize(v) {
    if (v instanceof Timestamp) return v.toMillis();
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = normalize(v[k]); return o; }
    return v;
  }
  const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
  const onlyKeys = (d, keys) => d && typeof d === 'object' && Object.keys(d).every(k => keys.includes(k));
  const hasOnlyDiff = (a, b, keys) => { const ks = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]); for (const k of ks) if (JSON.stringify(norm(a && a[k])) !== JSON.stringify(norm(b && b[k])) && !keys.includes(k)) return false; return true; };
  const norm = (v) => normalize(v);

  /** Contexto do usuário atual: { uid, role, marketId, perms } (ou null). */
  function policy(store) {
    const raw = (p) => store.getRaw(p);
    const C = (u) => ({
      uid: u ? u.uid : null, role: u ? u.role : null,
      staff() { return this.role === 'platform_admin' || this.role === 'platform_staff'; },
      sup() { return this.role === 'platform_admin'; },
      pperm(p) { return this.sup() || (this.role === 'platform_staff' && (u.perms || []).includes(p)); },
      mstaff(m) { return this.role === 'market_staff' && u.marketId === m; },
      mperm(m, p) { return this.mstaff(m) && (u.perms || []).includes(p); },
      owner(x) { return !!this.uid && this.uid === x; }
    });
    const orderOf = (id) => raw(`orders/${id}`);
    const orderReader = (c, o, pm, sp) => !!o && (c.owner(o.customerId) || c.mperm(o.marketId, pm) || c.pperm(sp));

    function canRead(path, data, user) {
      const c = C(user); const s = path.split('/'); const d = data || {};
      switch (s[0]) {
        case 'platform': case 'cities': case 'categories': return s.length === 2;
        case 'categoryRequests': return c.staff() || (c.uid && d.requestedBy === c.uid);
        case 'globalProducts': return d.active === true || c.staff();
        case 'markets': {
          if (s.length === 2) return d.status === 'active' || c.staff() || c.mstaff(s[1]);
          const m = s[1], sub = s[2];
          if (sub === 'public') return true;
          if (sub === 'listings') return d.active === true || c.staff() || c.mstaff(m);
          if (sub === 'staff') return c.mstaff(m) || c.staff();
          if (sub === 'imports') return c.mperm(m, 'products.import') || c.staff();
          if (sub === 'listingHistory') return c.mperm(m, 'products.read') || c.pperm('audit.read');
          if (sub === 'finance' || sub === 'payouts') return c.mperm(m, 'finance.read') || c.pperm('finance.read');
          if (sub === 'notifications') return c.mstaff(m);
          return false;
        }
        case 'users': return s.length === 2 ? (c.owner(s[1]) || c.pperm('users.read')) : (['addresses', 'lists', 'carts', 'notifications'].includes(s[2]) && c.owner(s[1]));
        case 'orders': {
          if (s.length === 2) return orderReader(c, d, 'orders.read', 'orders.read');
          const o = orderOf(s[1]); if (!o) return false; const sub = s[2];
          if (sub === 'messages') return c.owner(o.customerId) || c.mperm(o.marketId, 'chat.use') || c.pperm('support.read');
          if (sub === 'events' || sub === 'substitutions') return orderReader(c, o, 'orders.read', 'orders.read');
          if (sub === 'secrets') return c.owner(o.customerId) && ['out_for_delivery', 'ready_for_dispatch'].includes(o.status);
          return false;
        }
        case 'payments': case 'ledger': case 'payouts': case 'refunds': case 'payAttempts': return c.pperm('finance.read');
        case 'reviews': return s.length === 2 ? (d.hidden !== true || c.pperm('reviews.moderate')) : (s[2] === 'versions' && c.pperm('reviews.moderate'));
        case 'tickets': { if (s.length === 2) return (c.uid && d.requesterId === c.uid) || c.pperm('support.read'); const t = raw(`tickets/${s[1]}`); return !!t && s[2] === 'messages' && ((c.uid && t.requesterId === c.uid) || c.pperm('support.read')); }
        case 'marketAdmin': return c.pperm('markets.read');
        case 'prospects': return c.pperm('crm.read');
        case 'staff': return c.owner(s[1]) || c.pperm('staff.read');
        case 'departments': return c.staff();
        case 'coupons': return (d.active === true && d.visibility === 'public') || c.pperm('campaigns.read') || (c.role === 'market_staff' && d.marketId === user.marketId && (user.perms || []).includes('promotions.write'));
        case 'auditLogs': return c.pperm('audit.read');
        case 'backups': return c.pperm('backup.manage');
        default: return false; // accounts, usernames, system, reservations, idempotency, webhookEvents...
      }
    }

    /** kind: create | update | delete. `old` = documento atual (ou null), `nu` = valor resultante após a escrita. */
    function canWrite(path, kind, old, nu, user) {
      const c = C(user); const s = path.split('/'); const d = nu || {};
      if (!c.uid) return false;
      if (s[0] === 'categoryRequests' && s.length === 2) return kind === 'create' && c.role === 'market_staff' && str(d.name, 80) && d.requestedBy === c.uid && d.marketId === user.marketId && d.status === 'pending' && onlyKeys(d, ['name', 'requestedBy', 'marketId', 'status', 'createdAt']);
      if (s[0] === 'users') {
        if (s.length === 2) {
          if (!c.owner(s[1])) return false;
          if (kind === 'create') return onlyKeys(d, ['name', 'phone', 'email', 'createdAt', 'prefs']) && str(d.name, 120);
          if (kind === 'update') return onlyKeys(d, ['name', 'phone', 'email', 'createdAt', 'prefs']) && JSON.stringify(norm(old.createdAt)) === JSON.stringify(norm(d.createdAt));
          return false;
        }
        if (!c.owner(s[1])) return false; const sub = s[2];
        if (sub === 'addresses') return kind === 'delete' || (str(d.cep, 9) && str(d.street, 160) && str(d.number, 20) && str(d.city, 80) && onlyKeys(d, ['label', 'cep', 'street', 'number', 'complement', 'district', 'city', 'uf', 'lat', 'lng', 'isDefault', 'recipient']));
        if (sub === 'lists') return kind === 'delete' || (str(d.name, 80) && onlyKeys(d, ['name', 'items', 'updatedAt', 'createdAt']) && Array.isArray(d.items) && d.items.length <= 200);
        if (sub === 'carts') return kind === 'delete' || (onlyKeys(d, ['items', 'updatedAt', 'coupon']) && Array.isArray(d.items) && d.items.length <= 150);
        if (sub === 'notifications') return kind === 'update' && hasOnlyDiff(old, d, ['read']);
        return false;
      }
      if (s[0] === 'markets' && s[2] === 'notifications') return kind === 'update' && c.mstaff(s[1]) && hasOnlyDiff(old, d, ['read']);
      if (s[0] === 'orders' && s[2] === 'messages' && s.length === 4) {
        const o = orderOf(s[1]); if (!o || kind !== 'create') return false;
        return onlyKeys(d, ['text', 'senderId', 'senderRole', 'createdAt']) && str(d.text, 1000) && d.senderId === c.uid && ((d.senderRole === 'customer' && c.owner(o.customerId)) || (d.senderRole === 'market' && c.mperm(o.marketId, 'chat.use')));
      }
      if (s[0] === 'tickets') {
        if (s.length === 2) return kind === 'create' && d.requesterId === c.uid && str(d.subject, 140) && d.status === 'open' && d.priority === 'normal' && (d.requesterRole === 'customer' || (d.requesterRole === 'market' && c.role === 'market_staff' && d.marketId === user.marketId)) && onlyKeys(d, ['requesterId', 'requesterRole', 'marketId', 'orderId', 'category', 'subject', 'status', 'priority', 'createdAt']);
        if (s[2] === 'messages' && s.length === 4) { const t = raw(`tickets/${s[1]}`); return !!t && kind === 'create' && str(d.text, 2000) && d.senderId === c.uid && onlyKeys(d, ['text', 'senderId', 'senderRole', 'createdAt']) && (t.requesterId === c.uid || c.pperm('support.write')); }
      }
      return false; // todo o resto só pelo backend
    }
    return { canRead, canWrite };
  }

  function create({ store, auth, backend, blobs, idb, now }) {
    const pol = policy(store); const db = store.db; const A = { mode: 'local' };
    const U = () => auth.current();
    const watchers = new Set();
    A.stamp = () => FieldValue.serverTimestamp();
    A.arrayUnion = (...x) => FieldValue.arrayUnion(...x);
    A.policy = pol;
    A.user = U;
    const out = (id, d) => ({ id, ...normalize(d) });

    A.doc = async (path) => { const d = store.getRaw(path); if (!d) return null; if (!pol.canRead(path, d, U())) throw perr(); return out(path.split('/').pop(), d); };
    function runCol(path, o = {}) {
      let q = db.collection(path); (o.where || []).forEach(([f, op, v]) => { q = q.where(f, op, v); }); (o.orderBy || []).forEach(([f, d]) => { q = q.orderBy(f, d || 'asc'); });
      return q._rows().filter(r => pol.canRead(r.path, r.data, U())).slice(0, o.limit || Infinity).map(r => out(r.path.split('/').pop(), r.data));
    }
    A.col = async (path, o) => runCol(path, o);
    const subscribeAll = (run, match) => {
      let pending = false; const w = { run, match };
      const fire = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; if (watchers.has(w)) { try { run(); } catch (e) { console.error(e); } } }, 0); };
      w.fire = fire; watchers.add(w); fire(); return () => watchers.delete(w);
    };
    store.subscribe((cols, paths) => watchers.forEach(w => { if (w.match(cols, paths)) w.fire(); }));
    auth.onChange(() => watchers.forEach(w => w.fire()));
    A.watchCol = (path, o, cb) => subscribeAll(() => cb(runCol(path, o)), (cols) => cols.has(path));
    A.watchDoc = (path, cb) => subscribeAll(() => { const d = store.getRaw(path); cb(d && pol.canRead(path, d, U()) ? out(path.split('/').pop(), d) : null); }, (cols, paths) => paths.includes(path));

    /* Escritas: simula o resultado e consulta a política antes de gravar. Tudo dentro de uma transação. */
    async function guarded(path, kind, data, merge) {
      const u = U(); if (!u) throw unauth();
      let denied = false;
      await db.runTransaction(async (tx) => {
        const ref = db.doc(path); const snap = await tx.get(ref); const old = snap.exists ? snap.data() : null;
        if (kind === 'create' && old) { const e = new Error('Documento já existe'); e.code = 6; throw e; }
        if ((kind === 'update') && !old) { const e = new Error('Documento inexistente'); e.code = 5; throw e; }
        let nu;
        if (kind === 'delete') nu = null;
        else { const probe = await simulate(old, kind, data, merge); nu = probe; }
        const ok = kind === 'delete' ? pol.canWrite(path, 'delete', old, null, u) : pol.canWrite(path, old ? 'update' : 'create', old, nu, u);
        if (!ok) { denied = true; return; }
        if (kind === 'delete') tx.delete(ref); else if (kind === 'update') tx.update(ref, data); else tx.set(ref, data, merge ? { merge: true } : undefined);
      });
      if (denied) throw perr();
    }
    async function simulate(old, kind, data, merge) { // resultado da escrita sobre um store temporário (sem persistir)
      const tmp = new MMStore.Store(); await tmp.open(); if (old) await tmp.db.doc('x/y').set(old);
      if (kind === 'update') await tmp.db.doc('x/y').update(data); else await tmp.db.doc('x/y').set(data, merge ? { merge: true } : undefined);
      return tmp.getRaw('x/y');
    }
    A.set = (path, data, merge) => guarded(path, 'set', data, merge);
    A.update = (path, data) => guarded(path, 'update', data);
    A.del = (path) => guarded(path, 'delete');
    A.add = async (path, data) => { const id = MMStore.autoId(); await guarded(`${path}/${id}`, 'create', data); return id; };

    /* Imagens: reduzidas/comprimidas e guardadas no IndexedDB (repositório de blobs). Devolve "mmimg:<id>". */
    A.upload = async (path, file) => {
      if (!U()) throw unauth(); if (!blobs) throw new Error('Armazenamento de imagens indisponível.');
      const rec = await idb.processImage(file); if (!(await blobs.has(rec.id))) await blobs.put(rec); return 'mmimg:' + rec.id;
    };
    A.call = async (name, data) => { const u = U(); return backend.call(name, data || {}, u ? { auth: { uid: u.uid, token: auth.claimsOf ? auth.claimsOf(u) : u } } : {}); };

    /* autenticação (pelos nomes que a interface já usa) */
    A.signIn = (user, pass) => auth.signIn(user, pass).then(() => {});
    A.signUp = (user, pass, name) => auth.signUpCustomer({ username: user, password: pass, name }).then(() => {});
    A.signOut = async () => auth.signOut();
    A.resetPassword = async () => { throw new Error('Não há recuperação por e-mail no simulador. Peça a um administrador para redefinir sua senha.'); };
    A.refreshToken = async () => {};
    A.watchers = () => watchers.size;
    return A;
  }
  return { create, policy, normalize };
});
