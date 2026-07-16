/*
 * POST /api/wallet-deposit
 *
 * Body: { amountUsdt: number, payCurrency?: string }
 *
 * Creates a NowPayments invoice (hosted checkout) and records a `deposits`
 * row in 'pending'. The client redirects to invoice_url; NowPayments pings
 * our webhook when paid, which flips status → 'paid' and credits balance.
 *
 * Auth required.
 */
import { sbUser, getUser, hasSupabase } from '../lib/supabase.js';
import { createInvoice, hasNowpayments } from '../lib/nowpayments.js';
import { json, corsHeaders, clientIp, rateGate, isUserBlocked, isMaintenance } from '../lib/server-engine.js';

export default async function handler(req, res) {
  if (!hasSupabase()) return res.status(503).json({ ok: false, error: 'server-not-configured' });
  for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method-not-allowed' });
  if (!rateGate(clientIp(req), 10, 10000)) return res.status(429).json({ ok: false, error: 'rate-limited' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  // Refuse new deposits for blocked users (they're under review) and during
  // maintenance. Existing balances remain fully withdrawable.
  if (await isUserBlocked(user.id)) return res.status(403).json({ ok: false, error: 'account-suspended' });
  if (await isMaintenance()) return res.status(503).json({ ok: false, error: 'maintenance' });
  if (!hasNowpayments()) return res.status(503).json({ ok: false, error: 'payments-not-configured' });

  const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  const amount = Number(body.amountUsdt);
  if (!Number.isFinite(amount) || amount < 1 || amount > 1e6) {
    return res.status(400).json({ ok: false, error: 'bad-amount' });
  }
  const payCurrency = (body.payCurrency && String(body.payCurrency).replace(/[^a-z0-9]/gi, '').slice(0, 20)) || undefined;

  // Server-owned public base URL — never trust a client header for the IPN
  // callback: NowPayments pings it server-side, and Origin/Referer are absent
  // or relative for direct/cors-less calls (which would make the IPN silently
  // fail and deposits never get credited). Fall back to the header only if the
  // operator hasn't set APP_BASE_URL.
  const cfgBase = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const hdrBase = (req.headers.origin || req.headers.referer || '').replace(/\/$/, '');
  const rawBase = cfgBase || hdrBase;
  if (!/^https:\/\/.+/.test(rawBase)) {
    return res.status(500).json({ ok: false, error: 'app-base-url-not-configured' });
  }
  const base = rawBase.replace(/^http:/, 'https');
  const ipnUrl = `${base}/api/nowpayments-webhook`;
  const successUrl = `${base}/?deposit=success`;
  const cancelUrl = `${base}/?deposit=cancel`;

  let inv;
  try {
    inv = await createInvoice({
      amountUsdt: amount,
      orderId: `${user.id}:${Date.now()}`,
      ipnUrl, successUrl, cancelUrl,
      ...(payCurrency ? { payCurrency } : {}),
    });
  } catch (e) {
    console.error('deposit invoice failed', e.status, e.body);
    return res.status(502).json({ ok: false, error: 'invoice-failed' });
  }

  const sb = sbUser(req);
  const { data, error } = await sb.from('deposits').insert({
    user_id: user.id,
    invoice_id: inv.id && String(inv.id),
    pay_currency: payCurrency || null,
    price_usdt: amount,
    status: 'pending',
  }).select('id').single();

  if (error) {
    console.error('deposit row insert failed', error);
    return res.status(500).json({ ok: false, error: 'db' });
  }

  return res.status(200).json({
    ok: true,
    depositId: data.id,
    invoiceUrl: inv.invoice_url,
    invoiceId: inv.id,
  });
}
