/*
 * Edge-runtime Supabase client (fetch-based, no SDK).
 *
 * The crash endpoints (round-start/tick/cashout/settle) run on the Edge
 * runtime for low-latency server-authoritative math. The Supabase JS SDK is
 * Node-only, so here we hit the PostgREST + GoTrue HTTP APIs directly.
 *
 * Two access modes:
 *  - user-scoped (Bearer JWT): auth.uid() resolves, RLS applies. Used for
 *    place_bet / settle_win which are SECURITY DEFINER RPCs (run as owner).
 *  - service (service_role key): bypasses RLS. Used by settle/settle-loss
 *    which the server calls after a verified bust (no user JWT at that point,
 *    but the bet rows were validated against the token's MAC).
 *
 * ENV: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

const URL = () => process.env.SUPABASE_URL;
const ANON = () => process.env.SUPABASE_ANON_KEY;
const SERVICE = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

export function hasSupabaseEdge() { return !!(URL() && ANON() && SERVICE()); }

/* Extract Authorization header from a Web API Request. */
export function bearer(req) {
  const h = req && req.headers;
  if (!h) return null;
  const a = typeof h.get === 'function' ? h.get('authorization') : h['authorization'];
  return a && a.startsWith('Bearer ') ? a.slice(7) : null;
}

/* Verify a JWT via GoTrue getUser. Returns user object or null. */
export async function edgeUser(req) {
  const token = bearer(req);
  if (!token) return null;
  try {
    const r = await fetch(`${URL()}/auth/v1/user`, {
      headers: {
        authorization: `Bearer ${token}`,
        apikey: ANON(),
      },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.id ? j : null;
  } catch (_) { return null; }
}

/* Call a Postgres RPC. mode: 'user' (uses caller JWT) or 'service' (service_role). */
export async function rpc(name, args, { req, mode = 'user' } = {}) {
  const isService = mode === 'service';
  const token = isService ? SERVICE() : bearer(req);
  if (!token) throw new Error(`rpc(${name}): no ${isService ? 'service key' : 'bearer token'}`);
  const r = await fetch(`${URL()}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: isService ? SERVICE() : ANON(),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: JSON.stringify(args || {}),
  });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch (_) { body = { raw: text }; }
  if (!r.ok) {
    const e = new Error(`rpc(${name}) → ${r.status}`);
    e.status = r.status; e.body = body; throw e;
  }
  return body; // RPCs return a JSON array of the return table's rows.
}
