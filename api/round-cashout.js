/*
 * POST /api/round-cashout
 *
 * Body: { token: string, claimedMult?: number }
 *
 * Validates a cashout against the server-authoritative multiplier.
 * The server ignores the client's claimedMult for the authoritative
 * decision and instead derives the real mult from its own clock.
 *
 * Returns:
 *   { ok: true, valid: true,  mult: <number>, win: <amount*mult> }
 *   { ok: true, valid: false, reason: 'busted', crashAt: <number>, ... }
 *
 * Latency grace: a cashout that arrives CASH_GRACE_MS after the real
 * bust is still honoured — the client may have tapped a hair before
 * the network round-trip completed. Generous to the player, but a
 * client can NEVER cash out ABOVE the real crashAt.
 */

// Edge Runtime: full Web API (Request/Response/crypto.subtle).
export const config = { runtime: "edge" };
import {
  decryptToken, multAt, sha256Hex, json, rateGate, clientIp, hasSecret, ctEqual, CFG, readJsonBody,
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

  // Authoritative server-clock multiplier at the moment of cashout.
  const now = Date.now();
  const elapsed = Math.max(0, now - p.started);
  const serverMult = multAt(elapsed);

  // Did it already bust?
  if (serverMult >= p.crashAt) {
    // Grace: if the bust happened within the last CASH_GRACE_MS, the player
    // very likely tapped just before the network delivered the bust tick.
    const bustElapsedApprox = elapsed; // upper bound
    // Re-check: was the crashAt reachable within (elapsed - grace)?
    const elapsedMinusGrace = Math.max(0, elapsed - CFG.CASH_GRACE_MS);
    const multAtGrace = multAt(elapsedMinusGrace);
    if (multAtGrace < p.crashAt) {
      // The player was within the grace window → honour at crashAt (the best
      // legal multiplier). They cannot exceed crashAt, only cap at it.
      const honoured = Math.min(serverMult, p.crashAt);
      return json({
        ok: true, valid: true, grace: true,
        mult: honoured,
        win: Math.round(amount * honoured),
        crashAt: p.crashAt,
        serverTime: now,
      });
    }
    // Legitimately too late.
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
  return json({
    ok: true,
    valid: true,
    mult: Math.floor(serverMult * 100) / 100,
    win: Math.round(amount * Math.floor(serverMult * 100) / 100),
    serverTime: now,
  });
}
