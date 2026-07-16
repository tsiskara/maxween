/*
 * POST /api/round-tick
 *
 * Body: { token: string }
 *
 * Returns, while still flying:
 *   { ok: true, state: 'fly', mult: number }      // server-authoritative mult
 *
 * Returns, once the rocket has busted:
 *   { ok: true, state: 'busted', mult: crashAt,
 *     crashAt: number, serverSeed: string,
 *     nonce: number, clientSeed: string }          // NOW provably-fair verifiable
 *
 * The server recomputes the multiplier from its own clock and the
 * token's `started` timestamp. The client cannot stall or inflate mult.
 */

// Edge Runtime: full Web API (Request/Response/crypto.subtle).
export const config = { runtime: "edge" };
import {
  decryptToken, multAt, sha256Hex, json, rateGate, clientIp, hasSecret, ctEqual, readJsonBody,
} from '../lib/server-engine.js';

export default async function handler(req) {
  if (!hasSecret()) return json({ ok: false, error: 'server-not-configured' }, 503);
  if (req.method !== 'POST') return json({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'POST' });

  const ip = clientIp(req);
  if (!rateGate(ip, 240, 10000)) return json({ ok: false, error: 'rate-limited' }, 429);

  const body = await readJsonBody(req);
  const token = body && body.token;
  if (typeof token !== 'string' || token.length > 2000) return json({ ok: false, error: 'bad-token' }, 400);

  let p;
  try { p = await decryptToken(token); }
  catch (_) { return json({ ok: false, error: 'bad-token' }, 400); }

  // Integrity seal check
  const expectMac = await sha256Hex([p.seed, p.crashAt, p.started, p.nonce, p.clientSeed].join('|'));
  if (!ctEqual(expectMac, p.mac)) return json({ ok: false, error: 'bad-token' }, 400);

  const now = Date.now();
  const elapsed = Math.max(0, now - p.started);
  const liveMult = multAt(elapsed);

  // Still flying
  if (liveMult < p.crashAt) {
    return json({ ok: true, state: 'fly', mult: Math.min(liveMult, p.crashAt), serverTime: now });
  }

  // Busted — reveal everything for provably-fair verification.
  return json({
    ok: true,
    state: 'busted',
    mult: p.crashAt,
    crashAt: p.crashAt,
    serverSeed: p.seed,
    nonce: p.nonce,
    clientSeed: p.clientSeed,
    serverTime: now,
  });
}
