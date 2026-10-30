const { chromium } = require('playwright');
exports.start = async (opts = {}) => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: opts.viewport || { width: 1200, height: 900 }, permissions: ['geolocation'], geolocation: { latitude: -22.9, longitude: -47.06 } }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  p.on('dialog', d => d.accept());
  const go = async (h) => { await p.evaluate((h) => { location.hash = h; }, h); await p.waitForTimeout(450); };
  const txt = async (n = 400) => (await p.innerText('#app')).replace(/\s+/g, ' ').slice(0, n);
  const call = (name, data) => p.evaluate(async ([n, d]) => api.call(n, d), [name, data]);
  const btn = async (name) => { await p.getByRole('button', { name, exact: false }).first().click(); await p.waitForTimeout(500); };
  return { b, ctx, p, errs, go, txt, call, btn };
};
exports.setupAdmin = async (T) => { const { p } = T; await p.goto('http://localhost:8123/index.html'); await p.waitForTimeout(800); const ins = await p.$$('form.stack input'); await ins[0].fill('admin'); await ins[1].fill('Chefe'); await ins[2].fill('senha1'); await ins[3].fill('senha1'); await p.click('button[type=submit]'); await p.waitForTimeout(1000); };
exports.createMarket = async (T) => { const { p, go, call } = T;
  await call('adminUpsertCity', { name: 'Campinas', uf: 'SP', active: true }); await call('adminUpsertCategory', { name: 'Mercearia' });
  await go('/admin/mercados/novo'); const f = await p.$$('form.stack input:not([type=checkbox]):not([type=time]), form.stack select');
  const set = async (i, v) => { await f[i].fill(v); }; await set(0, 'Mercado Central'); await set(2, '11222333000181'); await set(14, '130'); await set(19, 'central'); await set(20, 'Gerente Central'); await set(21, 'abcd');
  await p.click('button[type=submit]'); await p.waitForTimeout(1200); };
exports.loginAs = async (T, user, pass) => { const { p } = T; await p.evaluate(() => { const b = [...document.querySelectorAll('#sim-bar button')][0]; b.click(); }); await p.waitForTimeout(400);
  const ins = await p.$$('.modal input, [role=dialog] input, #modal-root input'); await ins[0].fill(user); await ins[1].fill(pass); await p.click('#modal-root button[type=submit]'); await p.waitForTimeout(900); };
