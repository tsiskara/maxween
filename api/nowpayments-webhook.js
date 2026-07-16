/*
 * POST /api/nowpayments-webhook
 *
 * NowPayments IPN callback. Verifies HMAC, marks the deposit paid, credits
 * the user's balance exactly once (idempotent on np_payment_id).
 *
 * UNAUTHENTICATED external caller — security is the HMAC signature.
 * Uses the service_role client (bypasses RLS) because there is no user JWT.
 *
 * NowPayments payment statuses: waiting / confirming / confirmed / sending /
 *   partially_paid / finished / failed / expired / refunded.
 * We credit on 'confirmed' || 'finished' (final, irreversible).
 */
import { sbAdmin, hasSupabase } from '../lib/supabase.js';
import { verifyWebhook, hasNowpayments } from '../lib/nowpayments.js';

export default async function handler(req, res) {
  if (!hasSupabase() || !hasNowpayments()) return res.status(503).json({ ok: false });
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  // Body may be parsed (vercel body parser) or raw. Accept object.
  let payload = req.body;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) { payload = null; } }
  if (!payload || typeof payload !== 'object') return res.status(400).json({ ok: false });

  // Vercel parses JSON into req.body but doesn't preserve the raw bytes by default.
  // For HMAC we re-serialize with the SAME canonical sorting NowPayments uses.
  const sig = req.headers['x-nowpayments-sig'] || (req.headers && req.headers.get && req.headers.get('x-nowpayments-sig'));
  if (!verifyWebhook(payload, sig)) {
    return res.status(401).json({ ok: false, error: 'bad-sig' });
  }

  const status = payload.payment_status;
  const npPaymentId = payload.payment_id && String(payload.payment_id);
  const orderId = payload.order_id && String(payload.order_id);

  const admin = sbAdmin();

  // Match our deposits row. We keyed order_id as "<user_id>:<ts>" on creation,
  // so parse the user out of it. (If the shape ever changes, fall back to invoice_id.)
  let userId = null;
  if (orderId && orderId.includes(':')) userId = orderId.split(':')[0];

  // Find by np_payment_id first (idempotency), else by invoice id / order.
  let { data: dep } = await admin.from('deposits').select('*').eq('np_payment_id', npPaymentId).maybeSingle();
  if (!dep && userId) {
    const invId = payload.invoice_id && String(payload.invoice_id);
    let q = admin.from('deposits').select('*').eq('user_id', userId);
    if (invId) q = q.eq('invoice_id', invId);
    ({ data: dep } = await q.order('id', { ascending: false }).limit(1).maybeSingle());
  }
  if (!dep) return res.status(404).json({ ok: false, error: 'no-deposit' });

  // Stamp the payment id so future webhooks dedupe.
  if (npPaymentId && !dep.np_payment_id) {
    await admin.from('deposits').update({ np_payment_id: npPaymentId }).eq('id', dep.id);
  }

  const FINAL = new Set(['confirmed', 'finished']);
  const FAIL = new Set(['failed', 'expired']);

  if (FINAL.has(status)) {
    await admin.from('deposits').update({
      status: 'paid',
      pay_address: payload.pay_address || null,
      pay_currency: payload.pay_currency || dep.pay_currency,
      pay_amount: payload.pay_amount || null,
      updated_at: new Date().toISOString(),
    }).eq('id', dep.id);
    // Credit exactly once (RPC is idempotent on the deposits.credited flag).
    await admin.rpc('credit_deposit', { p_deposit_id: dep.id });
    return res.status(200).json({ ok: true, credited: true });
  }

  if (FAIL.has(status)) {
    await admin.from('deposits').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', dep.id);
    return res.status(200).json({ ok: true, failed: true });
  }

  // Intermediate state (waiting/confirming/...): record, don't credit.
  await admin.from('deposits').update({ status: 'confirming', updated_at: new Date().toISOString() }).eq('id', dep.id);
  return res.status(200).json({ ok: true, pending: true });
}
