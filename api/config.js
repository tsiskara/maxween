/*
 * GET /api/config
 *
 * Returns public configuration the browser needs: the Supabase URL + anon key.
 * Both are PUBLIC values (the anon key is designed for the client; RLS enforces
 * data security). The service_role key is never exposed here.
 *
 * This lets `git push` deploy real-money mode with zero manual index.html edits.
 * If Supabase isn't configured, returns disabled:true and the client stays
 * virtual-coin silently.
 */
import { corsHeaders } from '../lib/server-engine.js';

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);
  return res.status(200).json({
    ok: true,
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    enabled: !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
  });
}
