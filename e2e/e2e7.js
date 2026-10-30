const L = require('./lib.js'); const fs = require('fs');
(async () => {
  const T = await L.start(); const { p, go, txt, call, btn } = T; await L.setupAdmin(T); await L.createMarket(T);
  await go('/admin/backup'); console.log('PAGE:', await txt(900));
  const btns = await p.$$eval('#app button, #app a.btn', e => e.map(x => x.innerText.trim()));
  console.log('buttons', btns);
  const dl = p.waitForEvent('download'); await btn('Baixar backup completo'); const d = await dl; await d.saveAs('b1.json');
  const j = JSON.parse(fs.readFileSync('b1.json', 'utf8')); console.log('backup keys', Object.keys(j), 'docs', Object.keys(j.docs || j.data || {}).length);
  await call('adminUpsertCategory', { name: 'Bebidas' });
  const cnt = () => p.evaluate(async () => [(await api.col('categories')).length, (await api.col('orders')).length]);
  console.log('cats before import', await cnt());
  await btn('Importar arquivo'); const fi = await p.$('#modal-root input[type=file]'); console.log('file input in modal', !!fi);
  await fi.setInputFiles('b1.json'); await p.waitForTimeout(1500);
  console.log('PLAN:', (await p.innerText('#modal-root')).replace(/\s+/g, ' ').slice(0, 900));
  console.log('modal buttons', await p.$$eval('#modal-root button', e => e.map(x => x.innerText.trim())));
  await p.getByRole('button', { name: 'Mesclar (recomendado)' }).click(); await p.waitForTimeout(1200);
  console.log('after merge click:', (await p.innerText('#modal-root').catch(() => '')).replace(/\s+/g, ' ').slice(0, 300));
  const cm = [...await p.$$('#modal-root button')]; for (const b of cm) { const t = (await b.innerText()).trim(); if (/Aplicar|Confirmar/.test(t)) { await b.click(); await p.waitForTimeout(1200); break; } }
  console.log('cats after merge (esperado 2: local mantido)', await cnt());
  await btn('Importar arquivo'); await (await p.$('#modal-root input[type=file]')).setInputFiles('b1.json'); await p.waitForTimeout(1200);
  await p.getByRole('button', { name: 'Substituir tudo' }).click(); await p.waitForTimeout(800);
  console.log('replace dlg:', (await p.innerText('#modal-root').catch(() => '')).replace(/\s+/g, ' ').slice(0, 400));
  await p.waitForTimeout(300); const cb = p.getByRole('button', { name: 'Substituir tudo', exact: true }); await cb.last().click(); await p.waitForTimeout(2000);
  console.log('cats after replace (esperado 1)', await cnt(), 'user', await p.evaluate(() => SESSION.user && SESSION.user.username));
  await p.evaluate(() => api.signIn('admin', 'senha1')); await p.reload(); await p.waitForTimeout(1200); await go('/admin/backup'); await btn('Zerar ambiente'); const t = await p.$('#modal-root input'); await t.fill('APAGAR TUDO'); await p.getByRole('button', { name: /apagar|zerar|confirm/i }).last().click(); await p.waitForTimeout(2000);
  console.log('after reset hash', await p.evaluate(() => location.hash), (await txt(200)));
  // restaurar do backup na tela inicial vazia
  const fi2 = await p.$('input[type=file]'); console.log('file input on setup', !!fi2);
  console.log('btns', await p.$$eval('#modal-root button, .modal button', e => e.map(x => x.innerText.trim())));
  console.log('errors', T.errs); await T.b.close();
})().catch(e => { console.error('CRASH', e.message); process.exit(1); });
