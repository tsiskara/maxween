/*
 * GET /api/wallet-balance
 *
 * Returns the caller's USDT balance, open bet count, and recent ledger.
 * Auth required (Bearer JWT).
 */
import { sbUser, getUser, hasSupabase, authHeader } from '../lib/supabase.js';
import { json, corsHeaders, clientIp, rateGate } from '../lib/server-engine.js';

export default async function handler(req, res) {
  if (!hasSupabase()) return res.status(503).json({ ok: false, error: 'server-not-configured' });
  // CORS
  for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);
  if (!rateGate(clientIp(req), 30, 10000)) return res.status(429).json({ ok: false, error: 'rate-limited' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const sb = sbUser(req);
  await sb.rpc('ensure_wallet');

  const { data: w } = await sb.from('wallets').select('balance_usdt').eq('user_id', user.id).single();
  // head:true → supabase-js returns data:null and the total in `count`.
  // Destructuring `data` here yields null, so read `count` instead.
  const { count: openBets } = await sb.from('bets').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'open');
  const { data: ledger } = await sb.from('ledger')
    .select('id,type,amount_usdt,ref_type,created_at')
    .eq('user_id', user.id).order('id', { ascending: false }).limit(20);

  return res.status(200).json({
    ok: true,
    balance: Number((w && w.balance_usdt) || 0),
    openBets: openBets || 0,
    ledger: (ledger || []).map(r => ({ ...r, amount_usdt: Number(r.amount_usdt) })),
  });
}
