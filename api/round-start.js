/*
 * POST /api/round-start
 *
 * Body: { clientSeed?: string }
 *
 * Returns: {
 *   token:       "<base64url AES-256-GCM blob>"  // opaque to client
 *   commitment:  "<hex64 = SHA-256(serverSeed)>" // shown pre-flight for provably-fair
 *   nonce:       number,
 *   clientSeed:  string,
 *   started:     number  (ms, server launch clock — NOT crashAt)
 * }
 *
 * CRITICAL: crashAt NEVER appears in the response. It lives only inside
 * the encrypted token, which the client cannot open without BOOST_SECRET.
 */

// Edge Runtime: full Web API (Request/Response/crypto.subtle).
export const config = { runtime: "edge" };
import {
  CFG, crashFromHash, sha256Hex, randHex, encryptToken, sealPayload,
  json, rateGate, clientIp, hasSecret, readJsonBody,
} from '../lib/server-engine.js';

export default async function handler(req) {
  if (!hasSecret()) {
    return json({ ok: false, error: 'server-not-configured' }, 503);
  }
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'POST' });
  }

  const ip = clientIp(req);
  if (!rateGate(ip, 40, 10000)) {
    return json({ ok: false, error: 'rate-limited' }, 429);
  }

  const body = await readJsonBody(req);

  // clientSeed is provided by the client but we sanitize it hard:
  // hex only, capped length, fallback to random. We never trust it for
  // anything security-critical — it just mixes into the hash input.
  let clientSeed = (body && typeof body.clientSeed === 'string')
    ? body.clientSeed.replace(/[^a-f0-9]/gi, '').slice(0, 16)
    : '';
  if (!clientSeed) clientSeed = randHex(8);

  // Per-process monotonic-ish nonce. In a single serverless instance this
  // is unique per cold start + call; combined with the random seed it is
  // more than enough entropy for a client-side-only demo backend.
  // (For a real money product you'd back this with a durable counter store.)
  const nonce = Date.now();

  // Fresh secret server seed for THIS round.
  const serverSeed = randHex(16);

  // Compute the hash → crashAt deterministically.
  const fullHash = await sha256Hex(serverSeed + ':' + clientSeed + ':' + nonce);
  const crashAt = crashFromHash(fullHash);

  // Commitment = SHA-256(seed): can be shown now, reveals nothing about
  // crashAt because SHA-256(serverSeed) → crashAt goes through an
  // additional full SHA-256(serverSeed:clientSeed:nonce) the client
  // cannot recompute without the seed. Standard commitment scheme.
  const commitment = await sha256Hex(serverSeed);

  // Launch moment on the server clock. Tick/cashout endpoints measure
  // elapsed from this, so the client cannot freeze the multiplier.
  const started = Date.now();

  const payload = await sealPayload({ seed: serverSeed, crashAt, started, nonce, clientSeed });
  const token = await encryptToken(payload);

  return json({
    ok: true,
    token,
    commitment,
    nonce,
    clientSeed,
    started,
    // tiny grace so client-side "fly starts now" lines up with server clock
    serverTime: started,
  });
}
