/*
 * BOOST — Server-authoritative crash engine (Aviator/JetX-style).
 *
 * DESIGN GOAL: make the crash point cryptographically unrecoverable
 * to the client before the rocket actually busts.
 *
 * HOW:
 *  - A fresh secret serverSeed is generated for EVERY round.
 *  - The client only ever receives COMMITMENT = SHA-256(serverSeed) pre-bust.
 *  - The real crashAt is computed on the server and stored inside an
 *    AES-256-GCM-encrypted round token. The client carries the token
 *    but cannot read it (no key).
 *  - The multiplier during flight is recomputed on the server from the
 *    server's monotonic clock, so the client cannot lie about elapsed
 *    time when cashing out.
 *  - On bust the server reveals serverSeed + crashAt, enabling true
 *    provably-fair verification (commitment was fixed pre-flight).
 *
 * RUNTIME: Edge. Uses the global Web Crypto (crypto.subtle) — no node:crypto
 * import, which keeps cold starts fast and avoids Node-stream body parsing.
 *
 * ENV (required): BOOST_SECRET — 64+ hex chars (32 bytes) for AES-256.
 * The server fails closed if it is missing/weak: no secret → no rounds.
 */

const subtle = crypto.subtle;

/* ---------- Config ----------
   MATH CONSTANTS (HOUSE_EDGE, GROWTH, MAX_MULT) are FROZEN and MUST match
   the client's frozen _cfg in index.html exactly. The client's crashFromHash
   asserts window.CFG.HOUSE_EDGE===0.01 and mirrors this formula in verify();
   any divergence silently breaks provably-fair verification. Changing these
   requires a coordinated server+client redeploy — intentionally not a runtime
   knob. See docs/REAL-MONEY-SETUP.md "Why the edge is frozen" for the math
   on why 1% is already revenue-optimal for a crash game.

   OPERATOR KNOBS (MAX_STAKE_USDT, MAX_PAYOUT_USDT, maintenance) do NOT affect
   crash math, so they're runtime-mutable via the operator_settings table
   (read at request time, with the values below as compiled-in fallback when
   the DB is unreachable). */
export const CFG = Object.freeze({
  HOUSE_EDGE: 0.01,
  GROWTH: 0.0000977,
  MAX_MULT: 1000,
  // Compiled-in fallback limits. The live values live in operator_settings
  // and are read at bet-placement and settlement time.
  MAX_STAKE_USDT: 1000,
  MAX_PAYOUT_USDT: 50000,
  // v7: post-bust grace removed — it enabled a guaranteed-win strategy
  // (poll until bust, then cash out within the grace window at crashAt).
  // A round is busted the instant serverMult >= crashAt. No exceptions.
  // a tick response older than this is considered stale/invalid client-side
  TICK_STALE_MS: 4000,
  // max cashouts honored per round token (one per bet slot)
  MAX_CASHOUTS_PER_TOKEN: 2,
  // how long a token's cash-count record is kept (round + margin)
  TOKEN_RECORD_TTL_MS: 60000,
});

/* ---------- The crash formula — MIRROR of client crashFromHash,
   minus the client-side volatility drift (drift was purely cosmetic
   and broke provably-fair determinism; server is the source of truth). ---------- */
export function crashFromHash(hashHex) {
  if (!hashHex || hashHex.length < 12) return 1.0;
  const h = parseInt(hashHex.slice(0, 8), 16);
  const r = h / 0xffffffff;
  if (r > 1 - CFG.HOUSE_EDGE) return 1.0;
  const m = (1 - CFG.HOUSE_EDGE) / (1 - r);
  const h2 = parseInt(hashHex.slice(8, 12), 16) / 0xffff;
  let result = m;
  if (h2 > 0.97) result = m * (1 + (h2 - 0.97) * 8);
  result = Math.min(result, CFG.MAX_MULT);
  return Math.max(1.0, Math.floor(result * 100) / 100);
}

/* ---------- Growth formula — EXACT mirror of the client loop:
     accel = 1 + 0.08 * clamp((elapsed-4000)/6000, 0, 1)
     mult  = 1.0024 * exp(GROWTH * elapsed * 2.5 * accel) ---------- */
export function multAt(elapsedMs) {
  const e = Math.max(0, elapsedMs);
  const accel = 1 + 0.08 * Math.min(1, Math.max(0, (e - 4000) / 6000));
  return 1.0024 * Math.exp(CFG.GROWTH * e * 2.5 * accel);
}

/* Inverse: at what elapsed does the multiplier reach `target`?
   Used to sanity-check client-claimed cashout times. Binary search
   because the accel piece makes it non-algebraic. */
export function elapsedForMult(target, maxMs = 120000) {
  if (target <= 1.0024) return 0;
  let lo = 0, hi = maxMs;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    const m = multAt(mid);
    if (m < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/* ---------- SHA-256 (hex) ---------- */
export async function sha256Hex(str) {
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- Random hex via CSPRNG ---------- */
export function randHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- Secret key cache (per-process) ---------- */
let _keyPromise = null;
async function getKey() {
  if (_keyPromise) return _keyPromise;
  _keyPromise = (async () => {
    const secret = process.env.BOOST_SECRET;
    if (!secret || !/^[0-9a-fA-F]{64}$/.test(secret)) {
      throw new Error('BOOST_SECRET missing or not 64 hex chars (32 bytes). Set it in Vercel env.');
    }
    const raw = new Uint8Array(secret.match(/.{2}/g).map(h => parseInt(h, 16)));
    return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  })();
  return _keyPromise;
}

/* Verify env at module load so the first request fails with a clear error. */
export function hasSecret() {
  const s = process.env.BOOST_SECRET;
  return !!s && /^[0-9a-fA-F]{64}$/.test(s);
}

/* ---------- Token (encrypt/decrypt the round payload) ----------
   Payload (plaintext JSON): {
     seed:    serverSeed hex (secret until reveal),
     crashAt: number,
     started: server timestamp ms (launch moment),
     nonce:   number,
     clientSeed: string,
     mac:     SHA-256(seed|crashAt|started|nonce|clientSeed) — tamper seal
   }
   AES-GCM already authenticates, but the MAC lets us reason about payload
   integrity independently and fail closed on any drift. */
export async function encryptToken(payload) {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const both = new Uint8Array(iv.length + ct.byteLength);
  both.set(iv, 0);
  both.set(new Uint8Array(ct), iv.length);
  // base64url
  return Buffer.from(both).toString('base64url');
}

export async function decryptToken(token) {
  const key = await getKey();
  const both = Buffer.from(token, 'base64url');
  if (both.length < 13) throw new Error('bad token');
  const iv = both.subarray(0, 12);
  const ct = both.subarray(12);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

export async function sealPayload({ seed, crashAt, started, nonce, clientSeed }) {
  const mac = await sha256Hex([seed, crashAt, started, nonce, clientSeed].join('|'));
  return { seed, crashAt, started, nonce, clientSeed, mac };
}

/* ---------- Standard JSON response helpers ---------- */
export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders,
    },
  });
}

/* Anti-replay/abuse: a very small per-IP token-bucket-ish gate.
   Not a full rate limiter (would need KV/Edge config) — just stops
   trivial script kiddies hammering the endpoints at 1000 req/s. */
const _hit = new Map(); // ip -> [timestamps]
export function rateGate(ip, maxPerWindow = 60, windowMs = 10000) {
  const now = Date.now();
  const arr = (_hit.get(ip) || []).filter(t => now - t < windowMs);
  arr.push(now);
  _hit.set(ip, arr);
  if (arr.length > maxPerWindow) return false;
  // occasional eviction
  if (_hit.size > 5000) for (const k of _hit.keys()) if (now - (_hit.get(k)[0] || 0) > windowMs) _hit.delete(k);
  return true;
}

/* ---------- v7: per-token cashout anti-replay ----------
   Without durable state (KV/Redis) we can't fully stop cross-instance replay,
   but we CAN stop the trivial "submit the same token N times" attack within an
   instance's lifetime. Each round token gets at most MAX_CASHOUTS_PER_TOKEN
   honored cashouts (one per bet slot). The record auto-expires.

   RESIDUAL: a patient attacker could replay a stale token against a fresh Edge
   instance after this Map resets. The complete fix is Vercel KV SETNX — filed
   as a follow-up. Acceptable for virtual coins. */
const _tokenCash = new Map(); // tokenKey -> { count, expires }
function tokenKey(token, mac) {
  // We don't hash the raw token (it's large); the MAC already binds the payload.
  // Keying on MAC + a token prefix is enough to identify a round uniquely.
  return (mac || '') + ':' + String(token).slice(0, 24);
}
export function cashCountFor(token, mac) {
  const k = tokenKey(token, mac);
  const rec = _tokenCash.get(k);
  if (!rec || Date.now() > rec.expires) return 0;
  return rec.count;
}
export function markCashout(token, mac) {
  const k = tokenKey(token, mac);
  const now = Date.now();
  const rec = _tokenCash.get(k);
  if (!rec || now > rec.expires) {
    _tokenCash.set(k, { count: 1, expires: now + CFG.TOKEN_RECORD_TTL_MS });
  } else {
    rec.count++;
  }
  // opportunistic eviction
  if (_tokenCash.size > 2000) {
    for (const key of _tokenCash.keys()) {
      const r = _tokenCash.get(key);
      if (now > r.expires) _tokenCash.delete(key);
    }
  }
}

export function clientIp(req) {
  // Works with BOTH Vercel Node.js (IncomingMessage, headers = plain object)
  // and Edge / Web API Request (headers = Headers with .get()).
  const h = req && typeof req.headers === 'object' ? req.headers : null;
  if (!h) return 'unknown';
  const get = typeof h.get === 'function' ? (k) => h.get(k) : (k) => h[k];
  const xff = get('x-forwarded-for');
  if (xff) return String(xff).split(',')[0].trim();
  return get('x-real-ip') || 'unknown';
}

/* Read JSON body from the Edge/Web API Request. Returns {} on any error. */
export async function readJsonBody(req) {
  if (req && typeof req.json === 'function') {
    try { return await req.json(); } catch (_) { return {}; }
  }
  return {};
}

/* CORS: same-origin only. The static index.html is served from the
   same Vercel deployment, so we do NOT add Access-Control-Allow-Origin: *.
   This blocks foreign sites from driving fetch() calls into our API. */
export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '',
    'Vary': 'Origin',
  };
}

/* Constant-time string compare (for any future equality checks). */
export function ctEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ---------- Operator controls (legitimate, disclosed) ----------
   These are NOT outcome overrides. They are the standard operator surface
   every regulated gambling product has: suspend a fraudster, pause for
   maintenance. Neither can change a round's crash point or a settled bet.

   - MAINTENANCE: the operator_settings.maintenance flag (DB) OR env
     BOOST_MAINTENANCE=1 returns 503 on money endpoints. Players in flight
     still settle (their tokens are valid); new bets are refused. Rotating
     BOOST_SECRET additionally invalidates in-flight round tokens for a
     hard pause.
   - SUSPENSIONS: profiles.blocked=true refuses new bets + withdrawals for
     that user. Existing balances remain withdrawable by operator action
     (the honest exit — never trap funds).
   - TABLE LIMITS: max_stake_usdt / max_payout_usdt are read live from
     operator_settings. The payout cap is enforced again at settlement
     (defense in depth — a stale/buggy read can never cause an overpayment). */
export function isMaintenanceEnv() {
  return process.env.BOOST_MAINTENANCE === '1' || process.env.BOOST_MAINTENANCE === 'true';
}

/* Read live operator settings from the DB. Falls back to CFG + env on any
   error (fail open for play, fail closed at settlement). Cached briefly. */
let _settingsCache = null; // { value, expires }
const SETTINGS_CACHE_MS = 5000;
export async function getLiveSettings() {
  const now = Date.now();
  if (_settingsCache && now < _settingsCache.expires) return _settingsCache.value;
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const base = {
    maxStakeUsdt: CFG.MAX_STAKE_USDT,
    maxPayoutUsdt: CFG.MAX_PAYOUT_USDT,
    maintenance: isMaintenanceEnv(),
  };
  if (!url || !(anon || service)) return base;
  try {
    const r = await fetch(`${url}/rest/v1/rpc/get_operator_settings`, {
      method: 'POST',
      headers: {
        'apikey': service || anon,
        'Authorization': `Bearer ${service || anon}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!r.ok) return base;
    const rows = await r.json();
    const s = Array.isArray(rows) ? rows[0] : rows;
    const v = {
      maxStakeUsdt: Number(s && s.max_stake_usdt) || CFG.MAX_STAKE_USDT,
      maxPayoutUsdt: Number(s && s.max_payout_usdt) || CFG.MAX_PAYOUT_USDT,
      // maintenance = DB flag OR env (env is the hard-stop override)
      maintenance: isMaintenanceEnv() || !!(s && s.maintenance),
    };
    _settingsCache = { value: v, expires: now + SETTINGS_CACHE_MS };
    return v;
  } catch (_) {
    return base;
  }
}

export async function isMaintenance() {
  const s = await getLiveSettings();
  return !!s.maintenance;
}

/* Edge-friendly blocked-user check via the PostgREST REST API (no SDK needed).
   Cached briefly per-instance to avoid a DB round-trip on every bet. Returns
   false on any error (fail open for play, fail closed at bet-placement which
   also re-checks via the RPC). */
const _blockCache = new Map(); // userId -> { blocked, expires }
const BLOCK_CACHE_MS = 15000;
export async function isUserBlocked(userId) {
  if (!userId) return false;
  const now = Date.now();
  const hit = _blockCache.get(userId);
  if (hit && now < hit.expires) return hit.blocked;
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !(anon || service)) return false;
  try {
    const r = await fetch(`${url}/rest/v1/profiles?select=blocked&user_id=eq.${encodeURIComponent(userId)}`, {
      headers: {
        'apikey': service || anon,
        'Authorization': `Bearer ${service || anon}`,
      },
    });
    if (!r.ok) return false;
    const rows = await r.json();
    const blocked = !!(rows && rows[0] && rows[0].blocked);
    _blockCache.set(userId, { blocked, expires: now + BLOCK_CACHE_MS });
    return blocked;
  } catch (_) {
    return false;
  }
}
