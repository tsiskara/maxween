/*
 * POST /api/bet-place
 *
 * Body: { token: string, stake: number }
 *
 * Reserves a real-money stake against a round token. The token is opaque
 * here (we don't decrypt it — that's the Edge endpoints' job); we just bind
 * the bet row to it so round-cashout can find and settle it.
 *
 * The place_bet RPC debits + inserts + ledgers in ONE transaction. If
 * balance is insufficient or a race hits, it returns ok:false with a reason
 * and the balance is untouched.
 *
 * Auth required. Returns the server betId the client must send at cashout.
 */
import { sbUser, getUser, hasSupabase } from '../lib/supabase.js';
import { corsHeaders, clientIp, rateGate } from '../lib/server-engine.js';

export default async function handler(req, res) {
  if (!hasSupabase()) return res.status(503).json({ ok: false, error: 'server-not-configured' });
  for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method-not-allowed' });
  if (!rateGate(clientIp(req), 30, 10000)) return res.status(429).json({ ok: false, error: 'rate-limited' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  const token = body && body.token;
  const stake = Number(body && body.stake);
  if (typeof token !== 'string' || token.length < 20 || token.length > 2000) {
    return res.status(400).json({ ok: false, error: 'bad-token' });
  }
  if (!Number.isFinite(stake) || stake <= 0 || stake > 1e6) {
    return res.status(400).json({ ok: false, error: 'bad-stake' });
  }

  const sb = sbUser(req);
  await sb.rpc('ensure_wallet');

  const { data, error } = await sb.rpc('place_bet', {
    p_round_token: token,
    p_stake: stake,
  });

  if (error || !data || !data[0] || !data[0].ok) {
    const reason = (data && data[0] && data[0].reason) || 'db';
    if (reason === 'insufficient') return res.status(409).json({ ok: false, error: 'insufficient', balance: data[0].balance });
    return res.status(400).json({ ok: false, error: reason });
  }

  return res.status(200).json({
    ok: true,
    betId: data[0].bet_id,
    balance: data[0].balance,
  });
}
