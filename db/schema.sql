/*
 * BOOST — real-money schema (Supabase / Postgres).
 *
 * Run via: psql "$SUPABASE_DB_URL" -f db/schema.sql
 *   or paste into the Supabase SQL editor.
 *
 * MONEY MODEL
 *  - One USDT balance row per user (wallets), guarded by optimistic `version`.
 *  - Append-only ledger records every credit/debit; SUM(ledger) == balance.
 *  - Bets carry their stake INTO the round; on cashout we credit stake*mult,
 *    on bust the stake stays debited (it was removed at bet time).
 *  - Every money mutation is a SECURITY DEFINER RPC that does debit+insert
 *    in ONE transaction, so the invariant holds even under races / retries.
 *
 * All amounts in USDT with 8 decimals (bigint of micro-cents would be purer,
 * but numeric(18,8) is exact, readable, and more than enough for crash stakes).
 */

create extension if not exists "pgcrypto";

/* ============ profiles ============ */
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  username     text unique,
  created_at   timestamptz not null default now(),
  country      text,                      -- geo, best-effort
  blocked      boolean not null default false
);

/* ============ wallets ============ */
create table if not exists public.wallets (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  balance_usdt  numeric(18,8) not null default 0 check (balance_usdt >= 0),
  version       bigint not null default 1,   -- optimistic concurrency
  updated_at    timestamptz not null default now()
);

/* ============ ledger (append-only money log) ============ */
create table if not exists public.ledger (
  id            bigserial primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  type          text not null check (type in ('deposit','bet','win','withdraw','withdraw_fee','bonus','adjust')),
  amount_usdt   numeric(18,8) not null,  -- signed: + credit, - debit
  balance_after numeric(18,8) not null,
  ref_type      text,                    -- 'bet' | 'withdrawal' | 'deposit' | ...
  ref_id        text,
  meta          jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists ledger_user_time on public.ledger(user_id, id desc);

/* ============ bets ============ */
-- One row per placed bet. status lifecycle:
--   open      → debited, round in progress
--   won       → cashed out, credited stake*mult (win_net = payout - stake)
--   lost      → busted, stake already debited at place time
--   void      → refunded (shouldn't happen in normal flow; safety valve)
create table if not exists public.bets (
  id          bigserial primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  round_token text not null,             -- the AES round token (opaque)
  stake_usdt  numeric(18,8) not null check (stake_usdt > 0),
  status      text not null default 'open' check (status in ('open','won','lost','void')),
  mult        numeric(12,4),             -- honored multiplier (on win)
  payout_usdt numeric(18,8),             -- credited amount (stake*mult) on win
  created_at  timestamptz not null default now(),
  settled_at  timestamptz
);
create index if not exists bets_user_time on public.bets(user_id, id desc);
create index if not exists bets_token on public.bets(round_token);
create index if not exists bets_status on public.bets(status) where status = 'open';

/* ============ deposits ============ */
-- Tracks a NowPayments invoice we created for a user.
create table if not exists public.deposits (
  id              bigserial primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  invoice_id      text,                  -- NowPayments invoice id
  pay_address     text,
  pay_currency    text,
  pay_amount      numeric(18,8),
  price_usdt      numeric(18,8) not null,
  status          text not null default 'pending'
                  check (status in ('pending','confirming','paid','failed','expired')),
  np_payment_id   text unique,           -- dedupe key for webhook
  credited        boolean not null default false,  -- idempotency: only credit once
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists deposits_user on public.deposits(user_id, id desc);
create index if not exists deposits_np on public.deposits(np_payment_id);

/* ============ withdrawals ============ */
create table if not exists public.withdrawals (
  id            bigserial primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  amount_usdt   numeric(18,8) not null check (amount_usdt > 0),
  address       text not null,
  currency      text not null default 'usdttrc20',
  status        text not null default 'pending'
                check (status in ('pending','processing','sent','failed','cancelled')),
  payout_id     text,                    -- NowPayments payout id
  tx_hash       text,
  created_at    timestamptz not null default now(),
  processed_at  timestamptz
);
create index if not exists withdrawals_user on public.withdrawals(user_id, id desc);

/* ============================================================
 * RPCs — the ONLY way money moves. SECURITY DEFINER so they run
 * with the function owner's privileges, not the caller's, letting
 * us lock down table RLS to "own row read, no direct writes".
 * ============================================================ */

-- Wallet is created lazily on first auth. RPC ensures it exists.
create or replace function public.ensure_wallet()
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into wallets(user_id) values (auth.uid())
  on conflict (user_id) do nothing;
end; $$;

-- Deposit: credit a paid invoice exactly once (idempotent on deposits row).
-- Called by the webhook after HMAC verification.
create or replace function public.credit_deposit(p_deposit_id bigint)
returns table(ok boolean, balance numeric, amount numeric) language plpgsql security definer set search_path = public as $$
declare d deposits%rowtype; v bigint; _bal numeric;
begin
  select * into d from deposits where id = p_deposit_id for update;
  if not found then
    return query select false, 0::numeric, 0::numeric; return;
  end if;
  if d.credited then
    select balance_usdt into _bal from wallets where user_id = d.user_id;
    return query select true, _bal, 0::numeric; return;
  end if;
  if d.status <> 'paid' then
    return query select false, 0::numeric, 0::numeric; return;
  end if;

  update wallets set
      balance_usdt = balance_usdt + d.price_usdt,
      version = version + 1,
      updated_at = now()
    where user_id = d.user_id
    returning version into v;

  update deposits set credited = true, updated_at = now() where id = p_deposit_id;

  insert into ledger(user_id, type, amount_usdt, balance_after, ref_type, ref_id, meta)
    values (d.user_id, 'deposit', d.price_usdt,
            (select balance_usdt from wallets where user_id = d.user_id),
            'deposit', d.id::text, jsonb_build_object('currency', d.pay_currency));

  select balance_usdt into _bal from wallets where user_id = d.user_id;
  return query select true, _bal, d.price_usdt;
  return;
end; $$;

-- Place a bet: atomically debit stake + insert bet row + ledger.
-- Returns the bet id the caller must send with the round token.
create or replace function public.place_bet(
  p_round_token text, p_stake numeric
) returns table(ok boolean, bet_id bigint, balance numeric, reason text)
language plpgsql security definer set search_path = public as $$
declare w wallets%rowtype; newbal numeric; bid bigint; uid uuid := auth.uid();
begin
  if uid is null then
    return query select false, 0::bigint, 0::numeric, 'no-auth'::text; return;
  end if;
  if p_stake is null or p_stake <= 0 then
    return query select false, 0::bigint, 0::numeric, 'bad-stake'::text; return;
  end if;

  select * into w from wallets where user_id = uid for update;
  if not found then
    return query select false, 0::bigint, 0::numeric, 'no-wallet'::text; return;
  end if;
  if w.balance_usdt < p_stake then
    return query select false, 0::bigint, w.balance_usdt, 'insufficient'::text; return;
  end if;

  newbal := w.balance_usdt - p_stake;
  update wallets set balance_usdt = newbal, version = version + 1, updated_at = now()
    where user_id = uid;

  insert into bets(user_id, round_token, stake_usdt, status)
    values (uid, p_round_token, p_stake, 'open')
    returning id into bid;

  insert into ledger(user_id, type, amount_usdt, balance_after, ref_type, ref_id)
    values (uid, 'bet', -p_stake, newbal, 'bet', bid::text);

  return query select true, bid, newbal, ''::text;
  return;
end; $$;

-- Settle a winning cashout: credit stake*mult, idempotent on the bet row.
-- p_bet_id + p_mult: caller already validated the token + server multiplier.
create or replace function public.settle_win(
  p_bet_id bigint, p_mult numeric
) returns table(ok boolean, balance numeric, payout numeric, reason text)
language plpgsql security definer set search_path = public as $$
declare b bets%rowtype; uid uuid; payout numeric; v bigint; _bal numeric;
begin
  select * into b from bets where id = p_bet_id for update;
  if not found then
    return query select false, 0::numeric, 0::numeric, 'no-bet'::text; return;
  end if;
  uid := b.user_id;
  if b.status <> 'open' then
    -- already settled — idempotent no-op
    select balance_usdt into _bal from wallets where user_id = uid;
    return query select true, _bal, 0::numeric, 'already'::text; return;
  end if;
  if p_mult is null or p_mult < 1 then
    return query select false, 0::numeric, 0::numeric, 'bad-mult'::text; return;
  end if;

  payout := b.stake_usdt * p_mult;
  update wallets set balance_usdt = balance_usdt + payout, version = version + 1, updated_at = now()
    where user_id = uid returning version into v;

  update bets set status='won', mult=p_mult, payout_usdt=payout, settled_at=now() where id = p_bet_id;

  insert into ledger(user_id, type, amount_usdt, balance_after, ref_type, ref_id, meta)
    values (uid, 'win', payout,
      (select balance_usdt from wallets where user_id=uid),
      'bet', p_bet_id::text, jsonb_build_object('mult', p_mult));

  select balance_usdt into _bal from wallets where user_id = uid;
  return query select true, _bal, payout, ''::text;
  return;
end; $$;

-- Settle a loss on bust. Stake was debitted at place time, so we only
-- flip status + record settled_at. Idempotent.
create or replace function public.settle_loss(p_bet_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  update bets set status='lost', settled_at=now()
    where id = p_bet_id and status='open';
end; $$;

-- Settle a win WITHOUT a client-supplied bet id. The server looks up the
-- caller's OPEN bet on this round_token. This closes two holes at once:
--   (1) a modified client can't settle an arbitrary bet id (must be the
--       caller's own, found via auth.uid());
--   (2) a slow network that failed to relay betId to the client still
--       settles correctly — we never trust the client for identity.
-- Idempotent: once the bet is 'won', a second call is a no-op.
-- Returns payout + new balance. p_mult comes from the authoritative server clock.
create or replace function public.settle_win_by_token(
  p_round_token text, p_mult numeric
) returns table(ok boolean, bet_id bigint, balance numeric, payout numeric, reason text)
language plpgsql security definer set search_path = public as $$
declare b bets%rowtype; uid uuid := auth.uid(); v bigint; _bal numeric;
begin
  if uid is null then
    return query select false, 0::bigint, 0::numeric, 0::numeric, 'no-auth'::text; return;
  end if;
  if p_mult is null or p_mult < 1 then
    return query select false, 0::bigint, 0::numeric, 0::numeric, 'bad-mult'::text; return;
  end if;

  -- Lock THIS user's open bet on this token. FOR UPDATE ensures atomicity.
  select * into b from bets
    where round_token = p_round_token and user_id = uid and status = 'open'
    order by id desc limit 1
    for update;

  if not found then
    -- No open bet: either never placed, already settled, or cashed out.
    return query select true, 0::bigint,
      (select balance_usdt from wallets where user_id=uid), 0::numeric, 'no-open-bet'::text;
    return;
  end if;

  declare payout numeric;
  begin
    payout := b.stake_usdt * p_mult;
    update wallets set balance_usdt = balance_usdt + payout, version = version + 1, updated_at = now()
      where user_id = uid returning version into v;
    update bets set status='won', mult=p_mult, payout_usdt=payout, settled_at=now() where id = b.id;
    insert into ledger(user_id, type, amount_usdt, balance_after, ref_type, ref_id, meta)
      values (uid, 'win', payout,
        (select balance_usdt from wallets where user_id=uid),
        'bet', b.id::text, jsonb_build_object('mult', p_mult));

    select balance_usdt into _bal from wallets where user_id = uid;
    return query select true, b.id, _bal, payout, ''::text;
    return;
  end;
end; $$;

-- Mark all still-open bets on a token as lost (called on bust).
create or replace function public.settle_token_losses(p_round_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update bets set status='lost', settled_at=now()
    where round_token = p_round_token and status='open';
end; $$;

-- Mark the CALLER's still-open bets on a token as lost. Used by round-cashout
-- when the server detects bust mid-cashout: only this user's dangling bet is
-- flipped, not every player's. Stake was debitted at place time.
create or replace function public.settle_token_losses_for_user(p_round_token text)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then return; end if;
  update bets set status='lost', settled_at=now()
    where round_token = p_round_token and user_id = uid and status='open';
end; $$;

-- Request a withdrawal: atomically debit amount + insert pending withdrawal.
create or replace function public.request_withdrawal(
  p_amount numeric, p_address text, p_currency text
) returns table(ok boolean, withdrawal_id bigint, balance numeric, reason text)
language plpgsql security definer set search_path = public as $$
declare w wallets%rowtype; newbal numeric; wid bigint; uid uuid := auth.uid();
begin
  if uid is null then
    return query select false, 0::bigint, 0::numeric, 'no-auth'::text; return;
  end if;
  if p_amount is null or p_amount <= 0 then
    return query select false, 0::bigint, 0::numeric, 'bad-amount'::text; return;
  end if;
  if p_address is null or length(p_address) < 10 then
    return query select false, 0::bigint, 0::numeric, 'bad-address'::text; return;
  end if;

  select * into w from wallets where user_id = uid for update;
  if not found then
    return query select false, 0::bigint, 0::numeric, 'no-wallet'::text; return;
  end if;
  if w.balance_usdt < p_amount then
    return query select false, 0::bigint, w.balance_usdt, 'insufficient'::text; return;
  end if;

  newbal := w.balance_usdt - p_amount;
  update wallets set balance_usdt = newbal, version = version + 1, updated_at = now() where user_id = uid;

  insert into withdrawals(user_id, amount_usdt, address, currency, status)
    values (uid, p_amount, p_address, p_currency, 'pending') returning id into wid;

  insert into ledger(user_id, type, amount_usdt, balance_after, ref_type, ref_id)
    values (uid, 'withdraw', -p_amount, newbal, 'withdrawal', wid::text);

  return query select true, wid, newbal, ''::text;
  return;
end; $$;

-- Reverse a failed/cancelled withdrawal: credit the amount back. Idempotent.
create or replace function public.refund_withdrawal(p_withdrawal_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare wd withdrawals%rowtype;
begin
  select * into wd from withdrawals where id = p_withdrawal_id for update;
  if not found then return; end if;
  if wd.status in ('sent') then return; end if;  -- can't claw back a sent payout
  if wd.status in ('failed','cancelled') then return; end if; -- already refunded

  update wallets set balance_usdt = balance_usdt + wd.amount_usdt, version = version + 1, updated_at = now()
    where user_id = wd.user_id;
  insert into ledger(user_id, type, amount_usdt, balance_after, ref_type, ref_id, meta)
    values (wd.user_id, 'adjust', wd.amount_usdt,
      (select balance_usdt from wallets where user_id=wd.user_id),
      'withdrawal', wd.id::text, jsonb_build_object('refund', true));
  update withdrawals set status='failed', processed_at=now() where id = p_withdrawal_id;
end; $$;

-- ============ RLS ============
alter table public.profiles     enable row level security;
alter table public.wallets      enable row level security;
alter table public.ledger       enable row level security;
alter table public.bets         enable row level security;
alter table public.deposits     enable row level security;
alter table public.withdrawals  enable row level security;

-- Users read their own rows only. All writes go through SECURITY DEFINER RPCs,
-- so we grant NO direct insert/update/delete to the anon/authenticated roles.
create policy "own profile"     on public.profiles    for select using (auth.uid() = user_id);
create policy "own wallet"      on public.wallets     for select using (auth.uid() = user_id);
create policy "own ledger"      on public.ledger      for select using (auth.uid() = user_id);
create policy "own bets"        on public.bets        for select using (auth.uid() = user_id);
create policy "own deposits"    on public.deposits    for select using (auth.uid() = user_id);
create policy "own withdrawals" on public.withdrawals for select using (auth.uid() = user_id);

-- Webhook/service writes deposits & withdrawals via the service_role key
-- (bypasses RLS), so no insert policies are needed for those.
