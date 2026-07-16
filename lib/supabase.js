/*
 * Supabase server client (Node runtime).
 *
 * Two clients:
 *  - sbUser(req): impersonates the caller (auth.jwt on the request). RLS
 *    enforces "own row only" — used for reads + the SECURITY DEFINER RPCs,
 *    which run as the function owner and do the actual money mutations.
 *  - sbAdmin(): service_role key — bypasses RLS. ONLY for the webhook
 *    (unauthenticated external caller) to mark deposits and drive refunds.
 */
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function hasSupabase() {
  return !!(URL && ANON && SERVICE);
}

/* Caller-scoped client: forwards the user's JWT so auth.uid() resolves. */
export function sbUser(req) {
  const auth = authHeader(req);
  return createClient(URL, ANON, {
    global: { headers: { Authorization: auth || '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/* Service client: bypasses RLS. Keep this inside the webhook + admin paths. */
let _admin = null;
export function sbAdmin() {
  if (_admin) return _admin;
  _admin = createClient(URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _admin;
}

/* Extract "Bearer ..." from Node (IncomingMessage) or Web API (Request). */
export function authHeader(req) {
  if (!req) return null;
  const h = req.headers;
  if (!h) return null;
  const get = typeof h.get === 'function' ? (k) => h.get(k) : (k) => h[k];
  const ah = get('authorization') || get('Authorization');
  return ah && ah.startsWith('Bearer ') ? ah : null;
}

/* Verify the caller's JWT via Supabase and return the user, or null.
   Used as the auth gate for every wallet/bet/cashout endpoint. */
export async function getUser(req) {
  const token = (authHeader(req) || '').slice(7); // strip "Bearer "
  if (!token) return null;
  const sb = createClient(URL, ANON, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.auth.getUser();
  if (error || !data || !data.user) return null;
  return data.user;
}
