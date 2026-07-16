/*
 * GET /api/config
 *
 * Returns public configuration the browser needs:
 *  - Supabase URL + anon key (both PUBLIC; RLS enforces data security)
 *  - Live operator settings: house edge, table limits, maintenance flag
 *
 * The client uses these to (a) mirror the server's crashFromHash so verify()
 *    works, (b) clamp the bet UI to the real table limits, and (c) show a
 *    maintenance banner before a frustrated player tries to bet.
 *
 * If Supabase isn't configured, returns disabled:true and the client stays
 * virtual-coin silently with the compiled-in CFG defaults.
 */
import { corsHeaders, CFG, isMaintenance } from '../lib/server-engine.js';

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);
  return res.status(200).json({
    ok: true,
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    enabled: !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
    maintenance: isMaintenance(),
    // Public game math + limits. The client MUST mirror these in its verify().
    game: {
      houseEdge: CFG.HOUSE_EDGE,
      maxMult: CFG.MAX_MULT,
      maxStakeUsdt: CFG.MAX_STAKE_USDT,
      maxPayoutUsdt: CFG.MAX_PAYOUT_USDT,
    },
  });
}
