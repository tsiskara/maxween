# BOOST v7 — GOTY Polish Pass (Design Spec)

**Date:** 2026-07-16
**Status:** Design — pending approval
**Scope:** Visual/UX perfection (no overlays during play), gameplay feel, retention/conversion upgrades, lightweight server hardening. No real-money economics (virtual coins only).

---

## 1. Problem statement

BOOST v6 is a mature, server-authoritative crash game. Audit found three classes of gaps blocking "visual 100/100 + game of the year" feel:

1. **Celebration overlays fire mid-flight** and obscure the multiplier, curve, and (in one case) the whole screen — directly contradicting the user's explicit "nothing overlays while user plays" requirement.
2. **Small bugs** degrade feel (never-unlocking achievement, timer stacking, dead code).
3. **Server economics** have real exploits (replayable cashout token, client-supplied stake, post-bust grace = guaranteed win). Low stakes for virtual coins, but the "Provably Fair" badge is currently a half-truth.

The user asked to maximize engagement/retention/conversion and minimize risk. This spec addresses all three with a focused, non-rebuild pass.

---

## 2. Goals & non-goals

**Goals**
- During `PH.FLY`, the multiplier, curve, and cashout button are never visually obscured by celebration/UI (except the cashout button's own live state).
- Fix every identified bug that degrades feel or fairness.
- Add the highest-leverage retention hook (comeback mercy) and conversion nudge (frictionless re-bet).
- Harden the server against the worst economic exploits without adding infrastructure.

**Non-goals (deferred)**
- Real-money wallet / persistent DB / Vercel KV. Token replay across Edge cold-starts remains *theoretically* possible; documented as the one residual gap.
- Full visual redesign, new framework, new game modes.
- Leaderboard anti-cheat beyond what the client+token binding provides.

---

## 3. Architecture & approach

### Workstream A — "Canvas is sacred" (overlay discipline)

**Core invariant:** during `PH.FLY`, no overlay may obscure the region from the multiplier (`#multWrap`, ~44% height) down to and including the cashout button (`#panel`).

**A1. `celebrationGate` helper** (new, ~10 lines)
```
function canShowFullCelebration(){
  // Full-screen / centered celebrations only when the round is over
  // OR all of the player's bets are already resolved.
  if(G.phase !== PH.FLY) return true;
  return G.bets.every(b => b.cashedOut || !b.placed);
}
```
Every celebration function calls this before showing its full version.

**A2. `#levelUp` deferred to CRASH** (`showLevelUp`, `index.html:1595`)
- XP/balance/lucky-box still credit instantly inside `addXP`.
- `addXP` sets a flag `G._pendingLevelUp = true` instead of calling `showLevelUp` directly when `G.phase === PH.FLY && !canShowFullCelebration()`.
- `doCrash()` (end of round) checks the flag and fires `showLevelUp` then.
- During FLY, a lightweight chip animates on `#lvlBar` ("⬆ LV N") so the player notices the level without a full overlay.
- If the player has no live bets when they level up (e.g. cashed both slots, round still flying for the curve), show immediately — `canShowFullCelebration()` returns true.

**A3. `#shareCard` repositioned + auto-dismiss** (`showShareCard`, `:2543`)
- Move from `top:50%` (center) to `top:78%` + scale down 30%.
- Add `setTimeout` auto-dismiss at 2500ms (currently never dismisses).
- During FLY: only show if `canShowFullCelebration()`; otherwise defer to CRASH like level-up.

**A4. Mid-flight flashes (milestone/combo/double) — phase-aware sizing**
- During FLY: position in top 12% of canvas (above multiplier), scale to 60%, duration capped at 500ms.
- At CRASH: full-size, full-duration (current behavior).
- Implemented by passing `G.phase` into each flash function and branching on a `compact` flag. `pointer-events:none` already true.

**A5. `#banner` during FLY** (already moved to `top:15%` by `main.flying` CSS `:372`) — leave as is; verified non-blocking.

**A6. `floatText`** — already `pointer-events:none`; keep, but during FLY confine to top 25%.

### Workstream B — Gameplay feel, retention, conversion

**B1. Frictionless re-bet (conversion)**
- On `startBetting()`, pre-fill each slot's amount with its previous-round bet (`SAVE.lastBets`).
- Repeat button (`#repeatBtn`) already exists; promote it visually and enable by default when a prior round exists.
- Net effect: re-betting is one tap, matching Aviator's flow.

**B2. Comeback mercy (retention)**
- `SAVE.lossStreak` already increments on bust. Add: after `MERCY_THRESHOLD` (default 5) consecutive losses, grant a **mercy token**: the next cashout gets a `+0.5×` bonus (or a guaranteed-minimum 2× if the round goes that far).
- Surface as a 🛟 badge in the header + a one-time toast ("Bad beat? Next cashout's on us.").
- `checkLossPity` (`:1444`) already exists as a hook — extend it.
- Configurable in settings; respects responsible-play.

**B3. Hot/cold felt feedback (engagement)**
- `volDrift` (`:579`) already drives `main.hot`/`main.cold`. Add:
  - A persistent chip in the top-center during BET: "🔥 HOT STREAK" (volDrift > 0.6) or "❄️ COLD" (volDrift < -0.6).
  - Curve glow color shifts warm/cool with drift.
- Gives players a *felt* sense of streaks — increases "one more round" pull.

**B4. Fix all-in achievement** (`:1572`)
- Capture pre-credit balance *before* `G.balance += totalWin`.
- `const balBefore = G.balance; G.balance += totalWin;`
- `const allInWin = b.amount >= balBefore - 1 && profit > 0;` (was using post-credit balance).

**B5. Smart bet chips** — add "¼ last win" and keep existing ½/2×/10/50/MAX. Minor.

### Workstream C — Server hardening (no new infra)

> **Sequencing note (from spec self-review):** the round token is minted in `startBetting()` (`index.html:675`), but bets are placed *during* the 5s BET phase. The server therefore does not know bet amounts at token-mint time, so "bind stake at round-start" is not achievable without a new lock endpoint. The items below are scoped to what is achievable without new endpoints or a durable store. True stake-binding + full replay protection are filed as the KV follow-up.

**C1. Remove post-bust grace** (`api/round-cashout.js:54-72`)
- `CFG.CASH_GRACE_MS` → 0; delete the grace branch.
- Once `serverMult >= p.crashAt` → `valid:false`. No exceptions.
- Kills the guaranteed-win strategy. Highest ROI change in this workstream.

**C2. Cap cashouts per token (kill N-cashout replay)**
- Embed `cashCount` in the token payload; `decryptToken` increments it in-memory per token id (module-level `Map<tokenHash, count>`, TTL = round length).
- Allow up to 2 cashouts per token (one per slot). Reject the 3rd+ with `{valid:false, reason:'spent'}`.
- Server ignores client-supplied `amount` for the *validity* decision (already does); payout still uses client `amount` because stake isn't bound — **documented gap**.
- Limitation: the in-memory `Map` resets on Edge cold-start, so a patient attacker *could* replay a stale token against a fresh instance. The complete fix is Vercel KV `SETNX` — out of scope, filed as follow-up.
- Client side: `doCashOut` already guards with `b._pendingCash`; the existing `b.cashedOut` flag prevents the same slot double-cashing.

**C3. Honest Provably Fair badge**
- When `G.serverMode`: badge shows "PROVABLY FAIR · CRASH" (true — the commitment scheme is sound).
- When offline fallback: badge shows "OFFLINE DEMO" (already implemented at `:647`).
- Drop any implication that the wallet is server-authoritative — it isn't, and shouldn't claim to be.

---

## 4. Components touched

| File | Changes |
|---|---|
| `index.html` | A1–A6 (overlay gate + deferrals), B1–B5 (gameplay), client side of C3 (badge) |
| `lib/server-engine.js` | `CFG.CASH_GRACE_MS` removed; `createToken`/`decryptToken` carry `cashCount`; module-level cash-count `Map` + TTL |
| `api/round-start.js` | No change (stake binding deferred to KV follow-up) |
| `api/round-cashout.js` | Remove grace branch; enforce per-token `cashCount` ≤ 2; ignore client `amount` for validity |
| `api/round-tick.js` | No change (already reveals crashAt only at bust) |

No new files, no new dependencies.

---

## 5. Data flow (cashout, after C1–C3)

1. Player taps CASH on slot → `doCashOut(b)` (`G.serverMode`, `!b._pendingCash`).
2. Client POSTs `{ token, amount: b.amount }` (amount still sent — not bound server-side yet).
3. `round-cashout` decrypts token, verifies MAC, looks up `cashCount` for this token id.
4. If `cashCount >= 2` → `{valid:false, reason:'spent'}` (replay blocked within instance).
5. Compute `serverMult` from server clock. If `serverMult >= p.crashAt` → `{valid:false, reason:'busted', ...reveal}`. **No grace.**
6. Else → `{valid:true, mult, win: amount * mult}`; server increments `cashCount`.
7. Client applies verdict via `_applyCashOut`.

**Concurrency:** two slots cashing near-simultaneously each send the token; the in-memory `cashCount` allows both (1 → 2). A 3rd submission is rejected. Cross-instance race on cold-start is the documented residual gap.

---

## 6. Error handling & edge cases

- **Offline fallback** (server unreachable): unchanged — local `crashFromHash` path runs, badge flips to "OFFLINE DEMO". All A/B work is phase-driven and works in both modes.
- **Level-up during offline mode:** same deferral logic applies.
- **Mercy bonus in offline mode:** computed locally, flagged honestly in history.
- **Token decrypt failure / tampered:** `round-cashout` returns `bad-token` 400 (existing path).
- **Player cashes slot 1, levels up, round continues, cashes slot 2:** level-up deferred to CRASH; slot 2's cashout shows normally (small chip on XP bar in the meantime).
- **Two slots, both cashed, round still flying for the curve:** `canShowFullCelebration()` returns true → full celebrations allowed (the player has no stake at risk anymore).

---

## 7. Testing strategy

- **Manual phase matrix:** for each of BET/FLY/CRASH × {0,1,2 slots placed} × {cashout triggers level-up / epic / milestone}, screenshot and verify no overlay obscures multiplier/curve/button. This is the acceptance bar for Workstream A.
- **Cross-device:** test on 360×640, 390×844 (iPhone), 560px (desktop narrow) — overlay positions must hold. Existing `@media (max-width:480px/420px)` rules still apply.
- **Reduced motion:** all new/changed animations honor `SAVE.settings.reducedMotion` (existing pattern).
- **Server:** unit-check the token round-trip (bind amount → decrypt → payout); verify spent token rejected; verify post-bust cashout rejected with no grace.
- **Regression:** the existing `_test_cash.js` smoke test should still pass.

---

## 8. Residual risk / follow-ups

1. **Stake is not bound server-side** — server still trusts client-supplied `amount` for payout. The `cashCount` cap stops infinite replay, but a player could still claim a larger stake than they bet. **Full fix needs a `/bet-lock` endpoint that debits + binds stake before flight** — filed as the KV/DB follow-up. Acceptable for virtual coins.
2. **Server-side token replay across Edge cold-starts** — the in-memory `cashCount` `Map` resets per instance; only fully fixed with Vercel KV `SETNX`. Filed as a follow-up.
3. **Leaderboard integrity** — client-side balance can still be edited via localStorage (checksum raises the bar but isn't cryptographic). Out of scope; leaderboard is cosmetic.
4. **Rate limiter is per-instance** — known; acceptable given virtual stakes.

---

## 9. Build sequence (preview — full plan in writing-plans)

1. Workstream A first (highest user value, lowest risk — pure UI discipline). Includes the `celebrationGate` helper + all overlay deferrals/repositioning.
2. B4 (all-in fix) + B5 (smart chips) — tiny, fold into A.
3. Workstream C (server) — independent, verifiable in isolation (C1 grace removal is a one-line high-impact change).
4. Workstream B1–B3 (gameplay systems: frictionless re-bet, mercy, hot/cold) — build on the disciplined overlay layer.

Each step keeps the game fully playable; no big-bang cutover.
