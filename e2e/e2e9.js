const L = require('./lib.js');
(async () => {
  const T = await L.start(); const { p, go, txt, call, btn } = T; await L.setupAdmin(T); await L.createMarket(T); await L.loginAs(T, 'central', 'abcd');
  await go('/painel/equipe'); await btn('Novo usuário'); const ins = await p.$$('#modal-root input'); console.log('inputs', ins.length);
  await ins[0].fill('Maria'); await ins[1].fill('maria'); await p.getByRole('button', { name: /Criar usuário|Convidar/ }).last().click(); await p.waitForTimeout(1000);
  console.log('RESULT:', (await p.innerText('#modal-root')).replace(/\s+/g, ' ').slice(0, 400));
  console.log('errors', T.errs); await T.b.close();
})().catch(e => { console.error('CRASH', e.message); process.exit(1); });
