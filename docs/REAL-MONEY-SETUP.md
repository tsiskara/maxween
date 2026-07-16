# BOOST — Real-Money Setup (crypto deposit / play / withdraw)

This guide turns the existing virtual-coin crash game into a real-money crypto
product. The game ships **disabled** — it stays virtual-coin until you complete
these steps. Nothing changes for players until you flip it on.

## What you're wiring up

```
index.html ── /api/* (Vercel) ── Supabase (Postgres + Auth)
                              └─ NowPayments (crypto deposit/withdraw rail)
```

- **Supabase** holds balances, the immutable ledger, bets, auth. Money only
  moves through Postgres SECURITY DEFINER functions (`db/schema.sql`).
- **NowPayments** creates deposit invoices, sends withdrawals, and pings a
  webhook when deposits confirm. Verify everything via HMAC.
- **Auth** is Supabase email/password (swap for magic link / OAuth later by
  changing one call in the client).

## 1. Supabase project

1. Create a project at supabase.com. Note:
   - `Project URL` (e.g. `https://abcd.supabase.co`)
   - `anon` public key (Project Settings → API)
   - `service_role` key (keep secret — webhook + admin only)
2. Open the SQL editor and run `db/schema.sql`. This creates all tables, the
   money RPCs, and RLS policies.
3. In Auth settings, decide email confirmation policy. For a fast launch you
   can disable "Confirm email" (Auth → Providers → Email). For production,
   leave it on.

## 2. NowPayments account

1. Sign up at nowpayments.io and complete KYC (they permit gambling with terms).
2. Generate an **API key** (Account → API Keys).
3. Set an **IPN secret** (Account → IPN settings) — any random string. This
   signs webhooks; you'll store it as `NOWPAYMENTS_IPN_SECRET`.
4. Note the payout wallet you'll fund (you send withdrawals from this balance).

## 3. Vercel environment variables

In your Vercel project → Settings → Environment Variables, add (all envs):

| Key | Value |
|-----|-------|
| `BOOST_SECRET` | 64 hex chars (32 bytes) — already required for the crash engine |
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | your anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | your service_role key (secret) |
| `NOWPAYMENTS_API_KEY` | your NowPayments API key |
| `NOWPAYMENTS_IPN_SECRET` | your NowPayments IPN secret |
| `GEO_BLOCKED` | (optional) comma-separated ISO country codes to block, e.g. `US,UK,AU`. Set to empty string `""` to disable geoblocking. Defaults to a sensible blocklist for unlicensed operators. |

Generate `BOOST_SECRET` with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## 4. Point the client at Supabase

**No manual editing required.** The client fetches public Supabase config from
`/api/config` at startup, which is built from your Vercel env vars (step 3).
The anon key is *public by design* (RLS enforces data security); the
service_role key never reaches the browser.

For **local dev** only, you can paste URL + anon key into the Wallet modal —
it persists to localStorage on that device. Don't do this in production.

If neither is set, the game silently stays in virtual-coin mode.

## 5. Deploy & smoke test

1. `git push` (or `vercel --prod`).
2. Open the site. A 🔐 button appears in the header balance area.
3. Sign in / sign up → the balance flips to **0.00 USDT** (real mode).
4. Deposit → enter an amount → you're redirected to NowPayments. Send a small
   **testnet** or minimum mainnet amount. On confirmation the webhook credits
   your balance (polling also refreshes every 15s).
5. Place a bet → the stake is really debited. Cash out → really credited.
6. Withdraw → the amount is debited and a payout is sent to your address.

## How money stays safe

- **Every balance change is one Postgres transaction** in a SECURITY DEFINER
  function: debit + ledger row + state flip happen atomically. No half-states.
- **Append-only ledger**: `SUM(amount) == wallets.balance` is an invariant.
  You can reconcile at any time: `SELECT user_id, SUM(amount_usdt) FROM
  ledger GROUP BY user_id;` must match `SELECT user_id, balance_usdt FROM wallets;`.
- **Idempotency**: deposits credit once (`credited` flag), cashouts settle once
  (bet `status`), withdrawals refund exactly once on failure.
- **RLS**: users read only their own rows; all writes go through the RPCs.
- **Webhook HMAC**: every NowPayments callback is verified with the IPN secret
  before anything happens. A spoofed callback credits nothing.
- **Cashout anti-replay**: the bet row's status is the settle idempotency key,
  replacing the old in-memory Map hack (which was per-instance only).

## Geoblocking (important — already built)

NowPayments and your payment processor expect you to block restricted
jurisdictions. `middleware.js` does this at the Edge — it returns HTTP 451
("Unavailable For Legal Reasons") on the money endpoints for any country in
the `GEO_BLOCKED` list (env var). The crash engine itself stays open so
virtual-coin play works everywhere; only deposit/withdraw/bet-placement are
gated.

Defaults (unlicensed offshore operator): US, UK, AU, FR, NL, DE, ES, IT, GR,
PT, BE, PL, RO, CZ, SK. Override via the `GEO_BLOCKED` env var, or set it to
`""` to disable. **Confirm this list against the jurisdictions where you
actually operate or hold a license.**

## When something goes wrong

- **Deposit didn't credit**: check NowPayments dashboard for the payment
  status; if `finished`, the webhook may have failed to verify — confirm the
  IPN secret matches and re-run `SELECT credit_deposit(<id>);` in SQL.
- **Withdrawal failed, balance refunded**: the `withdrawals` row is `failed`
  and `refund_withdrawal` credited it back. Re-try from the UI.
- **Bet stuck `open`**: `SELECT settle_token_losses('<token>');` will flip all
  open bets on that token to `lost` (stake already debitted at place time).

## Swapping providers later

All NowPayments calls live in `lib/nowpayments.js`. Reimplement those five
functions for another provider (or self-custody) and nothing else changes.
