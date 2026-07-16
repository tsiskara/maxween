/*
 * Geoblocking middleware (Edge).
 *
 * Blocks requests from restricted jurisdictions on the real-money endpoints.
 * NowPayments and any payment processor expect you to gate restricted regions.
 * Vercel's request.geo.country is derived from the client IP at the edge.
 *
 * Configure the block list via env: GEO_BLOCKED (comma-separated ISO-3166
 * alpha-2 codes). Sensible defaults are baked in for unlicensed offshore
 * operators — override or empty the list via env to fit your jurisdiction.
 *
 * ponytail: scoped to /api paths that touch money + the app shell, not static
 * assets. A plain allow/deny by country code — no GeoIP DB to maintain.
 */

const DEFAULT_BLOCKED = ['US', 'UK', 'AU', 'FR', 'NL', 'DE', 'ES', 'IT', 'GR', 'PT', 'BE', 'PL', 'RO', 'CZ', 'SK'];
const BLOCKED = (process.env.GEO_BLOCKED != null ? process.env.GEO_BLOCKED : DEFAULT_BLOCKED.join(','))
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const ENABLED = process.env.GEO_BLOCKED !== ''; // set GEO_BLOCKED='' to disable

// ponytail: only gate the money-touching surface. The crash engine itself
// (round-start/tick) is harmless without a bound bet, so virtual-coin play
// stays open even in blocked regions. Money + the wallet UI are what's gated.
const MONEY_PATHS = new Set([
  '/api/wallet-balance', '/api/wallet-deposit', '/api/wallet-withdraw',
  '/api/bet-place', '/api/nowpayments-webhook',
]);

export default function middleware(req) {
  if (!ENABLED) return;
  const path = new URL(req.url).pathname;
  // Webhook comes from NowPayments servers (not a player) — never geo-gate it.
  if (path === '/api/nowpayments-webhook') return;
  if (!MONEY_PATHS.has(path)) return;

  const country = (req.geo && req.geo.country) || '';
  if (country && BLOCKED.includes(country.toUpperCase())) {
    return new Response(JSON.stringify({ ok: false, error: 'region-not-allowed' }), {
      status: 451, // "Unavailable For Legal Reasons" — the honest status code
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}

// Edge runtime, match money + deposit/deposit pages.
export const config = {
  runtime: 'edge',
  matcher: ['/api/:path*'],
};
