/* Meu Mercado Teste — mm-pay.js
 * Provedor de pagamento FICTÍCIO. Nenhum dinheiro real, nenhum cartão real, nenhuma rede.
 * Implementa o mesmo contrato do provedor de pagamento original (createCharge/getCharge/refund), guardando cada
 * cobrança em `payCharges/{id}` no banco local. O estado só muda por ação explícita do usuário (função simulatePayment).
 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./mm-store.js')); else root.MMPay = factory(root.MMStore); })(typeof self !== 'undefined' ? self : this, function (MMStore) {
  'use strict';
  const { Timestamp, autoId } = MMStore;
  function create(store) {
    const db = store.db;
    return {
      name: 'simulado', configured: true, simulated: true,
      async createCharge(p) {
        const id = 'sim_' + autoId().slice(0, 14);
        await db.doc(`payCharges/${id}`).set({ id, orderId: p.orderId, kind: p.kind || 'order', amount: p.amount, method: p.method, status: 'pending', paidAmount: 0, createdAt: Timestamp.now(), expiresAt: p.expiresAt ? Timestamp.fromMillis(p.expiresAt) : null });
        return { providerChargeId: id, status: 'pending', pix: p.method === 'pix' ? { qrCode: null, copyPaste: 'SIMULADO-' + id.toUpperCase() + ' (pagamento fictício — nenhum valor real)', expiresAt: p.expiresAt || null } : undefined };
      },
      async getCharge(id) {
        const s = await db.doc(`payCharges/${id}`).get(); if (!s.exists) return { status: 'expired' };
        const c = s.data(); return { status: c.status, paidAmount: c.status === 'paid' ? c.paidAmount : 0, paidAt: c.paidAt ? c.paidAt.toMillis() : null, providerFee: 0 };
      },
      async refund(p) { return { providerRefundId: 'simr_' + autoId().slice(0, 12), status: 'done' }; }
    };
  }
  return { create };
});
