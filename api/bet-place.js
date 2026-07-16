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
import { decryptToken, multAt, json as edgeJson, corsHeaders, clientIp, rateGate, readJsonBody, CFG, isUserBlocked, isMaintenance, getLiveSettings } from '../lib/server-engine.js';

// ponytail: server-side betting window. The client only places bets during its
// BET phase (G.phase===PH.BET, ~5s before flight), but the server can't trust
// the client's phase. Without this, an attacker can poll /api/round-tick until
// it returns state:'fly' (which PROVES crashAt > currentMult), then place a bet
// and cash it out instantly — a deterministic guaranteed-win exploit.
//
// `started` is the round-start clock (set in startBetting). The client's BET
// phase runs for CFG.BET_TIME (5s) after that, so any bet arriving past this
// window is mid-flight. We allow a generous buffer over the client's BET_TIME
// so a laggy legit bet isn't rejected, while still closing the exploit.
const BET_WINDOW_MS = 8000;

export default async function handler(req, res) {
  if (!hasSupabase()) return res.status(503).json({ ok: false, error: 'server-not-configured' });
  for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method-not-allowed' });
  if (!rateGate(clientIp(req), 30, 10000)) return res.status(429).json({ ok: false, error: 'rate-limited' });

  const settings = await getLiveSettings();
  if (settings.maintenance) return res.status(503).json({ ok: false, error: 'maintenance' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (await isUserBlocked(user.id)) return res.status(403).json({ ok: false, error: 'account-suspended' });

  const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  const token = body && body.token;
  const stake = Number(body && body.stake);
  if (typeof token !== 'string' || token.length < 20 || token.length > 2000) {
    return res.status(400).json({ ok: false, error: 'bad-token' });
  }
  // Table limit: stake ceiling. Reject anything above the live max stake rather
  // than silently clamping — the player should know the bet wasn't accepted.
  if (!Number.isFinite(stake) || stake <= 0) {
    return res.status(400).json({ ok: false, error: 'bad-stake' });
  }
  if (stake > settings.maxStakeUsdt) {
    return res.status(400).json({ ok: false, error: 'stake-too-large', maxStake: settings.maxStakeUsdt });
  }

  // Betting-window enforcement: decrypt the round token to read `started` and
  // reject any bet placed after the window. This closes the mid-flight exploit
  // where an attacker waits for state:'fly' (proving crashAt > mult) before
  // committing a stake. Any failure to decrypt → reject (fail closed).
  let started;
  try {
    const p = await decryptToken(token);
    started = Number(p && p.started);
  } catch (_) {
    return res.status(400).json({ ok: false, error: 'bad-token' });
  }
  if (!Number.isFinite(started) || started <= 0) {
    return res.status(400).json({ ok: false, error: 'bad-token' });
  }
  const elapsed = Date.now() - started;
  if (elapsed > BET_WINDOW_MS) {
    return res.status(409).json({ ok: false, error: 'betting-closed' });
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
    // Surface the payout cap so the client can show the true max win for this bet.
    // The effective multiplier ceiling is min(MAX_MULT, maxPayout / stake).
    maxPayout: settings.maxPayoutUsdt,
    effectiveMaxMult: Math.min(CFG.MAX_MULT, settings.maxPayoutUsdt / stake),
  });
}
