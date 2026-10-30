const L = require('./lib.js');
(async () => { const T = await L.start({ viewport: { width: 390, height: 800 } }); const { p, go, btn } = T; await L.setupAdmin(T);
  await go('/admin/contas'); await btn('Nova conta'); await p.selectOption('#modal-root select >> nth=0', 'market_staff'); await p.waitForTimeout(300);
  console.log((await p.innerText('#modal-root')).replace(/\s+/g, ' ').slice(0, 400));
  await p.getByRole('button', { name: 'Criar conta' }).click(); await p.waitForTimeout(500); console.log('toast:', (await p.innerText('#toasts')).slice(0, 200));
  console.log('errors', T.errs); await T.b.close(); })();
