const L = require('./lib.js'); const assert = require('assert');
(async () => {
  const T = await L.start(); const { p, go, txt, call, btn } = T; await L.setupAdmin(T); await L.createMarket(T);
  const ids = await p.evaluate(async () => { const cats = await api.col('categories'); const ms = await api.col('markets'); return { cat: cats[0].id, mid: ms[0].id }; });
  console.log(ids);
  await L.loginAs(T, 'central', 'abcd');
  const lid = await call('marketUpsertListing', { marketId: ids.mid, name: 'Arroz Tipo 1', brand: 'Bom', unit: 'kg', size: 5, categoryId: ids.cat, price: 25.9, allocated: 20, active: true, kind: 'product' });
  console.log('listing', JSON.stringify(lid));
  // image upload + persistence
  const img = await p.evaluate(async (mid) => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 64, 64); const blob = await new Promise(r => c.toBlob(r, 'image/png')); const f = new File([blob], 'a.png', { type: 'image/png' }); return await api.upload('listings/' + mid + '/a.png', f); }, ids.mid);
  console.log('img', String(img).slice(0, 40));
  // switch to customer: sign up
  await p.evaluate(async () => { await api.signOut(); });
  await p.evaluate(async () => { await api.signUp('ana', 'Ana Cliente', 'senha1'); }).catch(e => console.log('signup err', e.message));
  await p.reload(); await p.waitForTimeout(1200); console.log('after reload user:', await p.evaluate(() => SESSION.user && SESSION.user.username));
  await p.evaluate(async (mid) => { const u = SESSION.user; await api.add(`users/${u.uid}/addresses`, { label: 'Casa', street: 'Rua A', number: '10', district: 'Centro', city: 'Campinas', uf: 'SP', cep: '13010000', isDefault: true }); }, ids.mid);
  const lst = await p.evaluate(async (mid) => (await api.col('markets/' + mid + '/listings')).map(l => l.id + ':' + l.name + ':' + l.active), ids.mid); console.log('listings', lst);
  await p.evaluate(([mid, lid]) => { CartStore.set(mid, [{ listingId: lid, qty: 2 }]); }, [ids.mid, (await p.evaluate(async (mid) => (await api.col('markets/' + mid + '/listings'))[0].id, ids.mid))]);
  await go('/checkout/' + ids.mid); await p.waitForTimeout(800); console.log('CHECKOUT:', await txt(700)); await p.screenshot({ path: 'checkout.png' });
  await btn('Confirmar pedido'); await p.waitForTimeout(800); console.log('hash', await p.evaluate(() => location.hash)); console.log('ORDER:', await txt(500));
  await btn('Recusar'); console.log('after refuse:', (await txt(400)));
  await btn('Aprovar pagamento'); await p.waitForTimeout(800); console.log('after approve:', (await txt(300)));
  console.log('errors', T.errs); await T.b.close();
})();
