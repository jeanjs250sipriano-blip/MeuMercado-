'use strict';
/**
 * Camada de integração de pagamentos — SUBSTITUÍVEL.
 *
 * Nenhum provedor foi contratado nem integrado nesta entrega. O provedor padrão ("unconfigured")
 * recusa qualquer cobrança com PROVIDER_NOT_CONFIGURED. Para integrar um provedor real
 * (ex.: um que ofereça split de marketplace, Pix, débito e crédito), crie um objeto que
 * implemente o contrato abaixo e registre-o em `PROVIDERS`, definindo PAYMENT_PROVIDER no ambiente.
 *
 * CONTRATO
 *   createCharge({ orderId, amount, method, split, customer, idempotencyKey, expiresAt, cardToken, kind })
 *        -> { providerChargeId, status:'pending'|'paid', pix?:{ qrCode, copyPaste, expiresAt }, redirectUrl? }
 *        method: 'pix' | 'debit' | 'credit'. Cartão: use SOMENTE token gerado pelo SDK do provedor no navegador;
 *        dados de cartão nunca passam por este sistema.
 *        split: { marketAmount, platformAmount, marketAccountId }  (centavos)
 *   getCharge(providerChargeId)
 *        -> { status:'pending'|'paid'|'failed'|'expired'|'refunded'|'chargeback', paidAmount, paidAt, providerFee }
 *   refund({ providerChargeId, amount, idempotencyKey, reason })
 *        -> { providerRefundId, status:'pending'|'done' }
 *   verifyWebhook(rawBody:Buffer, headers, secret)
 *        -> { valid:boolean, event?:{ id, type:'charge.paid'|'charge.failed'|'charge.expired'|'refund.done'|'chargeback',
 *                chargeId, refundId?, occurredAt, sequence?, amount? } }
 *        Deve validar assinatura HMAC (ou equivalente) em tempo constante e rejeitar timestamps antigos.
 */
const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');

const unconfigured = {
  name: 'unconfigured',
  configured: false,
  async createCharge() { throw new HttpsError('failed-precondition', 'PROVIDER_NOT_CONFIGURED: nenhum provedor de pagamento foi configurado.'); },
  async getCharge() { throw new HttpsError('failed-precondition', 'PROVIDER_NOT_CONFIGURED'); },
  async refund() { throw new HttpsError('failed-precondition', 'PROVIDER_NOT_CONFIGURED'); },
  verifyWebhook() { return { valid: false }; }
};

/**
 * Provedor de TESTE, disponível apenas no emulador (FUNCTIONS_EMULATOR=true). Nunca confirma pagamento sozinho:
 * o estado só muda quando um webhook assinado é enviado ao endpoint (veja README, seção de testes).
 */
const charges = new Map();
const sandbox = {
  name: 'sandbox',
  configured: true,
  async createCharge(p) {
    const id = 'sbx_' + crypto.randomBytes(8).toString('hex');
    charges.set(id, { status: 'pending', amount: p.amount });
    return { providerChargeId: id, status: 'pending', pix: p.method === 'pix' ? { qrCode: null, copyPaste: 'SANDBOX-' + id, expiresAt: p.expiresAt } : undefined };
  },
  async getCharge(id) { const c = charges.get(id); return c ? { status: c.status, paidAmount: c.status === 'paid' ? c.amount : 0, paidAt: c.paidAt || null, providerFee: 0 } : { status: 'expired' }; },
  async refund() { return { providerRefundId: 'sbxr_' + crypto.randomBytes(6).toString('hex'), status: 'pending' }; },
  verifyWebhook(raw, headers, secret) {
    const sig = String(headers['x-mm-signature'] || '');
    const expected = crypto.createHmac('sha256', secret || '').update(raw).digest('hex');
    const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!ok) return { valid: false };
    let body; try { body = JSON.parse(raw.toString('utf8')); } catch { return { valid: false }; }
    if (body.type === 'charge.paid' && charges.has(body.chargeId)) { const c = charges.get(body.chargeId); c.status = 'paid'; c.paidAt = new Date().toISOString(); }
    return { valid: true, event: body };
  }
};

const PROVIDERS = { sandbox };

function getProvider() {
  const want = process.env.PAYMENT_PROVIDER;
  if (want === 'sandbox' && process.env.FUNCTIONS_EMULATOR === 'true') return sandbox;
  if (want && PROVIDERS[want] && want !== 'sandbox') return PROVIDERS[want];
  return unconfigured;
}

module.exports = { getProvider, PROVIDERS };
