/*
 * POST /api/round-settle
 *
 * Body: { token: string }
 *
 * Called by the client when it observes the round has busted, to settle any
 * still-open bets on that token as losses. This is defensive: round-cashout
 * already flips a bet to 'lost' if cashed out post-bust, but a bet that is
 * never cashed out (player AFK, tab closed) would otherwise stay 'open'
 * forever. settle_token_losses is idempotent.
 *
 * Uses the service role key because the bust was verified by decrypting the
 * token + MAC (proof the round existed), not by a user JWT. Bets are only
 * flipped to 'lost'; no balance change (stake was debitted at bet time).
 *
 * Edge runtime.
 */
export const config = { runtime: "edge" };
import {
  decryptToken, multAt, sha256Hex, json, rateGate, clientIp, hasSecret, ctEqual, readJsonBody,
} from '../lib/server-engine.js';
import { hasSupabaseEdge, rpc } from '../lib/supabase-edge.js';

export default async function handler(req) {
  if (!hasSecret()) return json({ ok: false, error: 'server-not-configured' }, 503);
  if (req.method !== 'POST') return json({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'POST' });

  const ip = clientIp(req);
  if (!rateGate(ip, 60, 10000)) return json({ ok: false, error: 'rate-limited' }, 429);

  const body = await readJsonBody(req);
  const token = body && body.token;
  if (typeof token !== 'string' || token.length > 2000) return json({ ok: false, error: 'bad-token' }, 400);

  let p;
  try { p = await decryptToken(token); }
  catch (_) { return json({ ok: false, error: 'bad-token' }, 400); }
  const expectMac = await sha256Hex([p.seed, p.crashAt, p.started, p.nonce, p.clientSeed].join('|'));
  if (!ctEqual(expectMac, p.mac)) return json({ ok: false, error: 'bad-token' }, 400);

  if (!hasSupabaseEdge()) return json({ ok: true, settled: false, mode: 'virtual' });

  // Authoritative bust check: only settle losses if the server clock confirms
  // the multiplier has reached crashAt. This stops a misbehaving client from
  // nuking a LIVE bet mid-flight — we never trust the client's claim of bust.
  const now = Date.now();
  const elapsed = Math.max(0, now - p.started);
  const liveMult = multAt(elapsed);
  if (liveMult < p.crashAt) {
    return json({ ok: false, error: 'round-still-flying', mult: liveMult, crashAt: p.crashAt }, 409);
  }

  try {
    await rpc('settle_token_losses', { p_round_token: token }, { mode: 'service' });
  } catch (e) {
    return json({ ok: false, error: 'settle-failed' }, 500);
  }
  return json({ ok: true, settled: true });
}
