/*
 * POST /api/wallet-withdraw
 *
 * Body: { amountUsdt: number, address: string, currency?: string }
 *
 * 1. Debit the user's balance atomically via request_withdrawal RPC, creating
 *    a 'pending' withdrawal row.
 * 2. Immediately call NowPayments createPayout. On success → mark 'sent'.
 *    On failure → refund_withdrawal credits the balance back.
 *
 * Currency defaults to usdttrc20 (TRON USDT — cheapest, dominant for gambling).
 * Auth required.
 */
import { sbUser, getUser, hasSupabase } from '../lib/supabase.js';
import { createPayout, hasNowpayments } from '../lib/nowpayments.js';
import { corsHeaders, clientIp, rateGate } from '../lib/server-engine.js';

export default async function handler(req, res) {
  if (!hasSupabase()) return res.status(503).json({ ok: false, error: 'server-not-configured' });
  for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method-not-allowed' });
  if (!rateGate(clientIp(req), 10, 10000)) return res.status(429).json({ ok: false, error: 'rate-limited' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!hasNowpayments()) return res.status(503).json({ ok: false, error: 'payments-not-configured' });

  const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  const amount = Number(body.amountUsdt);
  const address = String(body.address || '').trim();
  const currency = (body.currency && String(body.currency).replace(/[^a-z0-9]/gi, '').slice(0, 20)) || 'usdttrc20';

  if (!Number.isFinite(amount) || amount < 1) return res.status(400).json({ ok: false, error: 'bad-amount' });
  if (address.length < 10) return res.status(400).json({ ok: false, error: 'bad-address' });

  const sb = sbUser(req);
  await sb.rpc('ensure_wallet');

  // 1. Debit + create pending withdrawal (atomic, RLS-safe via SECURITY DEFINER).
  const { data: reqd, error: reqErr } = await sb.rpc('request_withdrawal', {
    p_amount: amount, p_address: address, p_currency: currency,
  });
  if (reqErr || !reqd || !reqd[0] || !reqd[0].ok) {
    const reason = (reqd && reqd[0] && reqd[0].reason) || 'db';
    if (reason === 'insufficient') return res.status(409).json({ ok: false, error: 'insufficient' });
    return res.status(400).json({ ok: false, error: reason });
  }
  const withdrawalId = reqd[0].withdrawal_id;
  const balanceAfter = reqd[0].balance;

  // 2. Drive the payout. On any failure, refund and report.
  try {
    const payout = await createPayout({ address, amount, currency, withdrawalId });
    await sb.from('withdrawals').update({
      status: 'sent',
      payout_id: payout.id && String(payout.id),
      processed_at: new Date().toISOString(),
    }).eq('id', withdrawalId);
    return res.status(200).json({ ok: true, withdrawalId, balance: balanceAfter, payoutId: payout.id });
  } catch (e) {
    console.error('payout failed; refunding', e.status, e.body);
    await sb.rpc('refund_withdrawal', { p_withdrawal_id: withdrawalId });
    const { data: w } = await sb.from('wallets').select('balance_usdt').eq('user_id', user.id).single();
    return res.status(502).json({ ok: false, error: 'payout-failed', balance: Number((w && w.balance_usdt) || 0) });
  }
}
