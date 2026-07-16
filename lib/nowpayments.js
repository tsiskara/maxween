/*
 * NowPayments provider.
 *
 * Docs: https://documenter.getpostman.com/view/7907941/S1a32n38
 *   - POST /v1/invoice            → hosted checkout { id, invoice_url }
 *   - POST /v1/payment {iid,...}  → { pay_address, pay_amount, payment_status }
 *   - POST /v1/payout             → withdrawal { id, status, ... }
 *   - IPN webhook: HMAC-SHA256 over sorted JSON payload, x-nowpayments-sig header
 *
 * Auth: x-api-key header. Webhook verified with IPN secret (separate value).
 *
 * ENV: NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET, NOWPAYMENTS_BASE_URL (optional).
 *
 * This is the single integration point with the external payment rail.
 * To swap providers later, reimplement these five functions; callers don't change.
 */

import { createHmac } from 'node:crypto';

const BASE = process.env.NOWPAYMENTS_BASE_URL || 'https://api.nowpayments.io';
const KEY = process.env.NOWPAYMENTS_API_KEY;
const IPN = process.env.NOWPAYMENTS_IPN_SECRET;

export function hasNowpayments() { return !!(KEY && IPN); }

async function np(path, init = {}) {
  if (!KEY) throw new Error('NOWPAYMENTS_API_KEY missing');
  const r = await fetch(BASE + path, {
    ...init,
    headers: {
      'x-api-key': KEY,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { raw: text }; }
  if (!r.ok) {
    const e = new Error(`nowpayments ${path} → ${r.status}`);
    e.status = r.status; e.body = body; throw e;
  }
  return body;
}

/* Create a deposit invoice for `amount` USDT. Returns NowPayments invoice. */
export async function createInvoice({ amountUsdt, orderId, ipnUrl, successUrl, cancelUrl, payCurrency }) {
  return np('/v1/invoice', {
    method: 'POST',
    body: JSON.stringify({
      price_amount: amountUsdt,
      price_currency: 'usdt',
      // NowPayments treats 'usdt' as price_currency; pay_currency selects the coin
      // the user will actually send. If omitted, the hosted page lets them choose.
      order_id: orderId,
      order_description: 'BOOST deposit',
      ipn_callback_url: ipnUrl,
      success_url: successUrl,
      cancel_url: cancelUrl,
      ...(payCurrency ? { pay_currency: payCurrency } : {}),
    }),
  });
}

/* Given an invoice id, create a payment to get a pay_address + amount.
   (Used when we want an on-site address instead of redirecting to hosted checkout.) */
export async function createPaymentFromInvoice({ invoiceId, payCurrency }) {
  return np('/v1/payment', {
    method: 'POST',
    body: JSON.stringify({ iid: invoiceId, pay_currency: payCurrency }),
  });
}

/* Verify an incoming webhook. Returns true iff the HMAC matches.
   NowPayments computes the sig over recursively-sorted JSON keys,
   stringified, signed with HMAC-SHA512, hex-encoded. Compare constant-time. */
export function verifyWebhook(payloadObj, sigHeader) {
  if (!IPN || !sigHeader) return false;
  const payload = JSON.stringify(sortKeys(payloadObj));
  const computed = createHmac('sha512', IPN).update(payload).digest('hex');
  return ctEqualLow(computed, String(sigHeader).toLowerCase());
}

function sortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = sortKeys(obj[k]); return acc; }, {});
  }
  return obj;
}
function ctEqualLow(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* Request a payout (withdrawal). `currency` e.g. 'usdttrc20'. */
export async function createPayout({ address, amount, currency, withdrawalId }) {
  return np('/v1/payout', {
    method: 'POST',
    body: JSON.stringify({
      address,
      amount,            // in the withdrawal currency; we send USDT-equivalent
      currency,
      unique_external_id: String(withdrawalId), // idempotency on our side
    }),
  });
}

/* Check a payout's status. */
export async function getPayoutStatus(payoutId) {
  return np(`/v1/payout/${payoutId}`, { method: 'GET' });
}
