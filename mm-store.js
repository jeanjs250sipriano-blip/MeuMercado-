/* Meu Mercado Teste — mm-store.js
 * Banco local transacional com interface parecida com o Firestore (documentos em coleções), usado tanto no
 * navegador (persistindo em IndexedDB, via mm-idb.js) quanto nos testes em Node (persistência em memória).
 *
 * Garantias:
 *  - Atomicidade: toda transação/escrita é primeiro gravada no armazenamento persistente (uma única transação do
 *    IndexedDB) e só depois aparece na memória. Se a gravação falhar, nada muda e o erro é devolvido.
 *  - Concorrência otimista (como o Firestore): cada documento tem uma versão; se algum documento lido por uma
 *    transação mudou antes do commit, a função é reexecutada. Duas operações concorrentes não reservam a mesma unidade.
 *  - Leituras antes das escritas dentro da transação; valores `undefined` são rejeitados.
 *  - Documentos operacionais ficam em memória (leves, sem imagens) e são gravados "write-through" no IndexedDB.
 *    Imagens ficam em outro repositório (blobs) e são carregadas sob demanda.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ───────── Tipos de valor ───────── */
  class Timestamp {
    constructor(ms) { this._ms = ms; }
    static now() { return new Timestamp(Date.now()); }
    static fromMillis(ms) { return new Timestamp(ms); }
    static fromDate(d) { return new Timestamp(d.getTime()); }
    toMillis() { return this._ms; }
    toDate() { return new Date(this._ms); }
    get seconds() { return Math.floor(this._ms / 1000); }
  }
  class Sentinel { constructor(kind, arg) { this.kind = kind; this.arg = arg; } }
  const FieldValue = {
    serverTimestamp: () => new Sentinel('ts'), increment: (n) => new Sentinel('inc', n),
    arrayUnion: (...a) => new Sentinel('union', a), arrayRemove: (...a) => new Sentinel('remove', a), delete: () => new Sentinel('del')
  };
  const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Timestamp) && !(v instanceof Sentinel) && !(v instanceof Date);
  const clone = (v) => v instanceof Timestamp ? new Timestamp(v._ms) : Array.isArray(v) ? v.map(clone) : isPlain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v;
  const tsReplacer = (k, v) => v instanceof Timestamp ? { __ts: v._ms } : v;
  const eq = (a, b) => JSON.stringify(a, tsReplacer) === JSON.stringify(b, tsReplacer);
  /** Forma serializável (IndexedDB/backup): Timestamp vira { __ts: ms }. */
  const encode = (v) => v instanceof Timestamp ? { __ts: v._ms } : Array.isArray(v) ? v.map(encode) : isPlain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)])) : v;
  const decode = (v) => Array.isArray(v) ? v.map(decode) : v && typeof v === 'object' ? (Object.keys(v).length === 1 && typeof v.__ts === 'number' ? new Timestamp(v.__ts) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]))) : v;

  function checkUndefined(v, path) {
    if (v === undefined) throw new Error(`Valor undefined não é permitido (${path})`);
    if (typeof v === 'function' || typeof v === 'symbol') throw new Error(`Tipo não suportado (${path})`);
    if (Array.isArray(v)) v.forEach((x, i) => checkUndefined(x, `${path}[${i}]`));
    else if (isPlain(v)) Object.entries(v).forEach(([k, x]) => checkUndefined(x, `${path}.${k}`));
  }
  function resolveVal(v, existing) {
    if (v instanceof Sentinel) {
      if (v.kind === 'ts') return Timestamp.now();
      if (v.kind === 'inc') return (typeof existing === 'number' ? existing : 0) + v.arg;
      if (v.kind === 'union') { const cur = Array.isArray(existing) ? existing.slice() : []; v.arg.forEach(x => { if (!cur.some(y => eq(x, y))) cur.push(clone(x)); }); return cur; }
      if (v.kind === 'remove') return (Array.isArray(existing) ? existing : []).filter(y => !v.arg.some(x => eq(x, y)));
      if (v.kind === 'del') return undefined;
    }
    if (isPlain(v)) { const out = {}; for (const [k, x] of Object.entries(v)) { const r = resolveVal(x, existing && isPlain(existing) ? existing[k] : undefined); if (r !== undefined) out[k] = r; } return out; }
    return clone(v);
  }
  const deepMerge = (base, patch) => { const out = { ...base }; for (const [k, v] of Object.entries(patch)) out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v; return out; };
  function setPath(obj, dotted, val) { const parts = dotted.split('.'); let o = obj; for (let i = 0; i < parts.length - 1; i++) { if (!isPlain(o[parts[i]])) o[parts[i]] = {}; o = o[parts[i]]; } const last = parts[parts.length - 1]; if (val === undefined) delete o[last]; else o[last] = val; }
  const getPath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const cmpVal = (v) => v instanceof Timestamp ? v._ms : v;
  const colOf = (path) => path.split('/').slice(0, -1).join('/');
  const err = (code, msg) => Object.assign(new Error(msg), { code });

  const rnd = (n) => { const a = new Uint8Array(n); (typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : require('crypto').webcrypto).getRandomValues(a); return a; };
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const autoId = () => Array.from(rnd(20), b => ALPHA[b % ALPHA.length]).join('');

  /* ───────── Persistência em memória (testes) ───────── */
  function memoryPersistence() {
    const docs = new Map();
    return {
      kind: 'memory',
      async load() { return [...docs].map(([path, data]) => ({ path, data })); },
      async commit(puts, dels) { puts.forEach(([p, d]) => docs.set(p, JSON.parse(JSON.stringify(d)))); dels.forEach(p => docs.delete(p)); },
      async clear() { docs.clear(); },
      _docs: docs
    };
  }

  /* ───────── Store ───────── */
  class Store {
    constructor(persistence) {
      this.p = persistence || memoryPersistence(); this.mem = new Map(); this.ver = new Map(); this.colVer = new Map();
      this.queue = Promise.resolve(); this.watchers = new Set(); this.ready = false; this.failNextCommit = null;
      this.db = this._makeDb();
    }
    async open() { const rows = await this.p.load(); this.mem.clear(); this.ver.clear(); rows.forEach(r => this.mem.set(r.path, decode(r.data))); this.ready = true; return this; }
    get size() { return this.mem.size; }
    /* leitura "administrativa" (sem política de acesso) */
    getRaw(path) { return this.mem.has(path) ? clone(this.mem.get(path)) : null; }
    allPaths() { return [...this.mem.keys()]; }
    *entries() { for (const [p, d] of this.mem) yield [p, d]; }
    /** Resolve e grava atomicamente uma lista de operações [kind, path, data, merge]. Tudo roda numa fila serial:
     *  1) confere as versões lidas pela transação (senão pede nova tentativa); 2) calcula os novos valores sobre o estado
     *  ATUAL; 3) grava no armazenamento persistente (uma transação); 4) só então atualiza a memória. */
    _commit(list, readSet) {
      const run = async () => {
        if (readSet) { for (const [k, v] of readSet.docs) if ((this.ver.get(k) || 0) !== v) return { retry: true }; for (const [k, v] of readSet.cols) if (!k.startsWith('*') && (this.colVer.get(k) || 0) !== v) return { retry: true }; }
        const staged = new Map(); const cur = (p) => staged.has(p) ? staged.get(p) : (this.mem.has(p) ? this.mem.get(p) : null);
        for (const [kind, path, data, merge] of list) {
          const c = cur(path); let nv;
          if (kind === 'set') { checkUndefined(data, path); const res = resolveVal(data, c === null ? undefined : c); nv = merge && c ? deepMerge(c, res) : res; }
          else if (kind === 'update') { checkUndefined(data, path); if (c === null) throw err(5, `NOT_FOUND: documento inexistente: ${path}`); const cc = clone(c); for (const [k, val] of Object.entries(data)) setPath(cc, k, resolveVal(val, getPath(cc, k))); nv = cc; }
          else if (kind === 'create') { if (c !== null) throw err(6, `ALREADY_EXISTS: ${path}`); checkUndefined(data, path); nv = resolveVal(data, undefined); }
          else nv = null;
          staged.set(path, nv);
        }
        const ops = [...staged];
        if (this.failNextCommit) { const e = this.failNextCommit; this.failNextCommit = null; throw e; }
        const puts = [], dels = [];
        for (const [path, val] of ops) (val === null ? dels : puts).push(val === null ? path : [path, encode(val)]);
        if (puts.length || dels.length) await this.p.commit(puts, dels);       // se falhar, a memória permanece intacta
        const cols = new Set();
        for (const [path, val] of ops) { if (val === null) this.mem.delete(path); else this.mem.set(path, val); this.ver.set(path, (this.ver.get(path) || 0) + 1); cols.add(colOf(path)); }
        cols.forEach(c => this.colVer.set(c, (this.colVer.get(c) || 0) + 1));
        this._notify(ops.map(o => o[0]));
        return { ok: true };
      };
      const p = this.queue.then(run, run); this.queue = p.then(() => {}, () => {}); return p;
    }
    _notify(paths) { if (!this.watchers.size) return; const cols = new Set(paths.map(colOf)); queueMicrotask(() => this.watchers.forEach(w => { try { w.maybe(cols, paths); } catch (e) { console.error(e); } })); }
    /** Assina mudanças. `fn(cols, paths)` é chamado após cada commit. */
    subscribe(maybe) { const w = { maybe }; this.watchers.add(w); return () => this.watchers.delete(w); }
    async replaceAll(entries) { // restauração integral: grava tudo e troca a memória só se der certo
      const old = [...this.mem.keys()];
      if (this.p.replaceAll) await this.p.replaceAll(entries.map(([p, d]) => [p, encode(d)]));
      else await this.p.commit(entries.map(([p, d]) => [p, encode(d)]), old.filter(k => !entries.some(e => e[0] === k)));
      this.mem.clear(); entries.forEach(([p, d]) => this.mem.set(p, clone(d))); this.ver.clear(); this.colVer.clear();
      this._notify([...new Set([...old, ...entries.map(e => e[0])])]);
    }
    async wipe() { if (this.p.clear) await this.p.clear(); const old = [...this.mem.keys()]; this.mem.clear(); this.ver.clear(); this.colVer.clear(); this._notify(old); }

    _makeDb() {
      const store = this;
      class DocSnap { constructor(ref, data) { this.ref = ref; this.id = ref.id; this._d = data; this.exists = data !== undefined; } data() { return this._d === undefined ? undefined : clone(this._d); } get(f) { return this._d ? getPath(this._d, f) : undefined; } }
      class QuerySnap { constructor(docs) { this.docs = docs; this.empty = docs.length === 0; this.size = docs.length; } forEach(f) { this.docs.forEach(f); } }
      const view = (tx) => ({
        get: (p) => tx && tx.overlay.has(p) ? tx.overlay.get(p) : (store.mem.has(p) ? store.mem.get(p) : null),
        record: (p) => { if (tx && !tx.overlay.has(p)) tx.reads.docs.set(p, store.ver.get(p) || 0); }
      });
      class DocRef {
        constructor(path, tx) { this.path = path; this.id = path.split('/').pop(); this._tx = tx; }
        get parent() { return new Query(colOf(this.path), [], [], null, false, this._tx); }
        collection(n) { return new Query(`${this.path}/${n}`, [], [], null, false, this._tx); }
        async get() { const v = view(this._tx); v.record(this.path); const d = v.get(this.path); return new DocSnap(this, d === null ? undefined : clone(d)); }
        _w(kind, data, merge) { return store._write([[kind, this.path, data, merge]]); }
        set(d, o) { return this._w('set', d, !!(o && o.merge)); } update(d) { return this._w('update', d); } create(d) { return this._w('create', d); } delete() { return this._w('delete'); }
      }
      class Query {
        constructor(path, filters = [], orders = [], lim = null, group = false, tx = null) { this.path = path; this.filters = filters; this.orders = orders; this.lim = lim; this.group = group; this._tx = tx; this.id = path.split('/').pop(); }
        get parent() { const p = this.path.split('/'); return p.length > 1 ? new DocRef(p.slice(0, -1).join('/')) : null; }
        doc(id) { return new DocRef(`${this.path}/${id || autoId()}`, this._tx); }
        async add(d) { const r = this.doc(); await r.create(d); return r; }
        where(f, op, v) { return new Query(this.path, [...this.filters, { f, op, v }], this.orders, this.lim, this.group, this._tx); }
        orderBy(f, dir = 'asc') { return new Query(this.path, this.filters, [...this.orders, { f, dir }], this.lim, this.group, this._tx); }
        limit(n) { return new Query(this.path, this.filters, this.orders, n, this.group, this._tx); }
        _rows() {
          const segs = this.path.split('/').length; const tx = this._tx; const v = view(tx);
          const keys = new Set(); for (const k of store.mem.keys()) keys.add(k); if (tx) for (const [k, val] of tx.overlay) { if (val === null) keys.delete(k); else keys.add(k); }
          let rows = [];
          for (const k of keys) { const s = k.split('/'); const inCol = this.group ? (s.length % 2 === 0 && s[s.length - 2] === this.path) : (s.length === segs + 1 && k.startsWith(this.path + '/')); if (inCol) rows.push({ path: k, data: v.get(k) }); }
          for (const { f, op, v: val } of this.filters) rows = rows.filter(({ data }) => { const x = getPath(data, f); if (x === undefined) return false; const a = cmpVal(x), b = cmpVal(val);
            switch (op) { case '==': return eq(a, b); case '!=': return !eq(a, b); case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b;
              case 'in': return val.some(y => eq(cmpVal(y), a)); case 'array-contains': return Array.isArray(x) && x.some(y => eq(y, val)); default: throw new Error('operador não suportado: ' + op); } });
          for (const { f } of this.orders) rows = rows.filter(({ data }) => getPath(data, f) !== undefined);
          if (this.orders.length) rows.sort((A, B) => { for (const { f, dir } of this.orders) { const a = cmpVal(getPath(A.data, f)), b = cmpVal(getPath(B.data, f)); if (a < b) return dir === 'desc' ? 1 : -1; if (a > b) return dir === 'desc' ? -1 : 1; } return 0; });
          if (this.lim != null) rows = rows.slice(0, this.lim);
          return rows;
        }
        async get() {
          const rows = this._rows();
          if (this._tx) { this._tx.reads.cols.set(this.group ? '*' + this.path : this.path, this.group ? 0 : (store.colVer.get(this.path) || 0)); rows.forEach(r => view(this._tx).record(r.path)); }
          return new QuerySnap(rows.map(r => new DocSnap(new DocRef(r.path, this._tx), clone(r.data))));
        }
      }
      store._Q = Query; store._D = DocRef; store._S = DocSnap;
      return {
        settings() {}, collection: (p) => new Query(p), doc: (p) => new DocRef(p), collectionGroup: (id) => new Query(id, [], [], null, true),
        getAll: (...refs) => Promise.all(refs.map(r => r.get())),
        batch() { const ops = []; const b = { set: (r, d, o) => (ops.push(['set', r.path, d, !!(o && o.merge)]), b), update: (r, d) => (ops.push(['update', r.path, d]), b), create: (r, d) => (ops.push(['create', r.path, d]), b), delete: (r) => (ops.push(['delete', r.path]), b), commit: () => store._write(ops) }; return b; },
        async runTransaction(fn, opts) {
          const max = (opts && opts.maxAttempts) || 100;
          for (let attempt = 1; attempt <= max; attempt++) {
            const t = { overlay: new Map(), reads: { docs: new Map(), cols: new Map() }, ops: [], wrote: false };
            const guard = () => { if (t.wrote) throw new Error('Firestore transactions require all reads to be executed before all writes.'); };
            const queue = (kind, r, d, o) => { t.wrote = true; t.ops.push([kind, r.path, d, !!(o && o.merge)]); return tx; };
            const tx = {
              get: async (x) => { guard(); const c = x._tx === t ? x : (x instanceof Query ? new Query(x.path, x.filters, x.orders, x.lim, x.group, t) : new DocRef(x.path, t)); return c.get(); },
              getAll: async (...refs) => { guard(); return Promise.all(refs.map(r => new DocRef(r.path, t).get())); },
              set: (r, d, o) => queue('set', r, d, o), update: (r, d) => queue('update', r, d), create: (r, d) => queue('create', r, d), delete: (r) => queue('delete', r)
            };
            const out = await fn(tx);
            const res = await store._commit(t.ops, t.reads);
            if (res.retry) continue; return out;
          }
          throw err(10, 'ABORTED: transação abortada por conflitos repetidos');
        }
      };
    }
    /** Escrita fora de transação (atômica; lista de operações). */
    _write(list) { return this._commit(list, null).then(() => {}); }
  }

  return { Store, Timestamp, FieldValue, memoryPersistence, encode, decode, clone, eq, autoId, getPath, colOf, isPlain, Sentinel };
});
