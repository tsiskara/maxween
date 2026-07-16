/*
 * POST /api/round-cashout
 *
 * Body: { token: string, amount?: number }
 *
 * Validates a cashout against the server-authoritative multiplier.
 * The server ignores the client's claimedMult for the authoritative
 * decision and instead derives the real mult from its own clock.
 *
 * v7 hardening:
 *   - Post-bust grace REMOVED. A round is busted the instant
 *     serverMult >= crashAt. (Previously a 350ms window allowed a
 *     guaranteed-win strategy: poll until bust, then cash at crashAt.)
 *   - Per-token cashout cap (MAX_CASHOUTS_PER_TOKEN = 2, one per slot).
 *     Stops the trivial N-cashout replay within an instance. Residual:
 *     cross-instance replay after Map reset needs KV — filed as follow-up.
 *   - Client `amount` is used only for the payout figure (stake is not yet
 *     bound server-side — see round-start). Validity is decided purely from
 *     the server clock + crashAt.
 *
 * Returns:
 *   { ok: true, valid: true,  mult, win }
 *   { ok: true, valid: false, reason: 'busted'|'spent', ... }
 */

// Edge Runtime: full Web API (Request/Response/crypto.subtle).
export const config = { runtime: "edge" };
import {
  decryptToken, multAt, sha256Hex, json, rateGate, clientIp, hasSecret, ctEqual, CFG, readJsonBody,
  cashCountFor, markCashout,
} from '../lib/server-engine.js';

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
    return json({
      ok: true, valid: false, reason: 'busted',
      crashAt: p.crashAt,
      serverSeed: p.seed,
      nonce: p.nonce,
      clientSeed: p.clientSeed,
      serverTime: now,
    });
  }

  // Valid cashout at the authoritative multiplier. Count it against the cap.
  markCashout(token, p.mac);
  const honored = Math.floor(serverMult * 100) / 100;
  return json({
    ok: true,
    valid: true,
    mult: honored,
    win: Math.round(amount * honored),
    serverTime: now,
  });
}
