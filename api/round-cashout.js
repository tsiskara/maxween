/*
 * POST /api/round-cashout
 *
 * Body: { token: string, amount?: number }
 *
 * Validates a cashout against the server-authoritative multiplier.
 * The server ignores the client's claimedMult for the authoritative
 * decision and instead derives the real mult from its own clock.
 *
 * Money (when Supabase configured):
 *   Calls settle_win_by_token(token, mult). The bet is looked up SERVER-SIDE
 *   by (round_token, caller's user_id) — we NEVER trust a client-supplied bet
 *   id. This closes a cheat surface and also heals the slow-network race
 *   where betId hadn't reached the client yet. Idempotent on bet.status.
 *
 * v7 hardening:
 *   - Post-bust grace REMOVED. A round is busted the instant serverMult >= crashAt.
 *   - Per-token cashout cap (MAX_CASHOUTS_PER_TOKEN = 2, one per slot).
 *   - Settlement is gated on a verified open bet belonging to the caller.
 *
 * Returns:
 *   { ok: true, valid: true,  mult, win, balance? }
 *   { ok: true, valid: false, reason: 'busted'|'spent', ... }
 */

// Edge Runtime: full Web API (Request/Response/crypto.subtle).
export const config = { runtime: "edge" };
import {
  decryptToken, multAt, sha256Hex, json, rateGate, clientIp, hasSecret, ctEqual, CFG, readJsonBody,
  cashCountFor, markCashout,
} from '../lib/server-engine.js';
import { hasSupabaseEdge, rpc } from '../lib/supabase-edge.js';

export default async function handler(req) {
  if (!hasSecret()) return json({ ok: false, error: 'server-not-configured' }, 503);
  if (req.method !== 'POST') return json({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'POST' });

  const ip = clientIp(req);
  if (!rateGate(ip, 120, 10000)) return json({ ok: false, error: 'rate-limited' }, 429);

  const body = await readJsonBody(req);
  const token = body && body.token;
  if (typeof token !== 'string' || token.length > 2000) return json({ ok: false, error: 'bad-token' }, 400);
  const amount = Number(body && body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) {
    return json({ ok: false, error: 'bad-amount' }, 400);
  }

  let p;
  try { p = await decryptToken(token); }
  catch (_) { return json({ ok: false, error: 'bad-token' }, 400); }

  const expectMac = await sha256Hex([p.seed, p.crashAt, p.started, p.nonce, p.clientSeed].join('|'));
  if (!ctEqual(expectMac, p.mac)) return json({ ok: false, error: 'bad-token' }, 400);

  // v7: anti-replay — at most MAX_CASHOUTS_PER_TOKEN honored cashouts per round.
  if (cashCountFor(token, p.mac) >= CFG.MAX_CASHOUTS_PER_TOKEN) {
    return json({ ok: true, valid: false, reason: 'spent', serverTime: Date.now() });
  }

  // Authoritative server-clock multiplier at the moment of cashout.
  const now = Date.now();
  const elapsed = Math.max(0, now - p.started);
  const serverMult = multAt(elapsed);

  // v7: no grace. Busted the instant the multiplier reaches crashAt.
  if (serverMult >= p.crashAt) {
    // Token-side loss settle: any open bets on this token for this caller flip
    // to 'lost' so they aren't left dangling. (Stake was debitted at bet time.)
    if (hasSupabaseEdge()) {
      try { await rpc('settle_token_losses_for_user', { p_round_token: token }, { req }); } catch (_) {}
    }
    return json({
      ok: true, valid: false, reason: 'busted',
      crashAt: p.crashAt,
      serverSeed: p.seed,
      nonce: p.nonce,
      clientSeed: p.clientSeed,
      serverTime: now,
    });
  }

  // Valid cashout at the authoritative multiplier.
  const honored = Math.floor(serverMult * 100) / 100;

  // Real-money settlement: server looks up the caller's open bet on this token
  // and credits stake*mult. No client-supplied id trusted. Falls through cleanly
  // in virtual-coin mode (no Supabase) or when the caller had no open bet.
  let balance = null;
  if (hasSupabaseEdge()) {
    try {
      const rows = await rpc('settle_win_by_token', { p_round_token: token, p_mult: honored }, { req });
      if (rows && rows[0] && rows[0].ok) balance = Number(rows[0].balance);
    } catch (e) {
      // Settlement failed AFTER we validated the cashout. The bet stays 'open'
      // and the client retries; we do NOT return valid:true without a settlement.
      // Note: we intentionally do NOT markCashout() here — settling the per-token
      // slot only after success keeps a transient RPC error from exhausting the
      // cap (MAX_CASHOUTS_PER_TOKEN=2) and stranding the winning bet as 'spent'.
      return json({ ok: false, error: 'settle-failed', retry: true, serverTime: now }, 500);
    }
  }

  // Settlement succeeded (or virtual mode): now count this cashout against the
  // per-round cap. settle_win_by_token is idempotent on bet.status, so marking
  // after success is safe; a retried request re-settles the same already-won bet.
  markCashout(token, p.mac);

  return json({
    ok: true,
    valid: true,
    mult: honored,
    win: Math.round(amount * honored),
    balance,
    serverTime: now,
  });
}
