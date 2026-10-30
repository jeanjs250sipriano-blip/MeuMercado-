const L = require('./lib.js');
(async () => {
  const T = await L.start({ viewport: { width: 390, height: 800 } }); const { p, go, txt, call } = T; await L.setupAdmin(T); await L.createMarket(T);
  const ov = async (n) => console.log(n, 'overflow-x:', await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth));
  for (const r of ['/admin', '/admin/mercados', '/admin/pedidos', '/admin/backup', '/admin/contas', '/admin/financeiro']) { await go(r); await ov(r); }
  await p.screenshot({ path: 'mobile-admin.png' });
  await p.evaluate(() => api.signOut()); await go('/'); await ov('/ (cliente)'); await p.screenshot({ path: 'mobile-home.png' });
  // offline
  await p.waitForTimeout(1500); const sw = await p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && (r.active || r.waiting)); }); console.log('sw registrado', sw);
  await p.reload(); await p.waitForTimeout(1000); await T.ctx.setOffline(true); await p.reload(); await p.waitForTimeout(1500);
  console.log('offline body:', (await p.innerText('body')).replace(/\s+/g, ' ').slice(0, 120));
  await T.ctx.setOffline(false);
  console.log('errors', T.errs); await T.b.close();
})().catch(e => { console.error('CRASH', e.message); process.exit(1); });
