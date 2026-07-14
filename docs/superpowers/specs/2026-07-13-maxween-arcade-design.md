# MAXWEEN — Skill-Based Arcade Game Design

**Date:** 2026-07-13
**Status:** Approved (user delegated design judgment)
**Mode:** Ponytail — single-file HTML, zero dependencies, no build step

## What it is

A 2D canvas arcade game that keeps the one genius mechanic from the crash
genre — a **rising multiplier you must bank before you lose it** — but replaces
the house-favored gambling RNG with **skill-based survival**. You crash because
*you* mistimed, not because a casino algorithm decided to take your money.

No currency, no bets, no real money, no house edge. You play for score,
leaderboard rank, and cosmetics.

## The core loop (one round, ~10 seconds)

1. Round starts. Multiplier reads **1.00×** and begins climbing.
2. Obstacles spawn from the right and accelerate toward the player orb on the left.
3. The longer you survive, the higher the multiplier climbs and the denser/faster
   the obstacles get. Speed scales with multiplier.
4. Player presses **SPACE** (or taps) to **BANK** — score is locked in at the
   current multiplier, round ends as a WIN.
5. If an obstacle hits the orb, the round ends as a CRASH — the multiplier you
   were building is lost entirely.
6. Score persists for the session; best score persists in `localStorage`.

**The tension:** do you bank early for a safe 3×, or push for 15× knowing one
mistake wipes everything? That's the entire game, and it's enough.

## Skill model

- Player controls vertical position only (up/down or drag). Left edge fixed.
- Obstacles are pillars with gaps, asteroids, and moving blocks.
- Collision = crash. No health bar. One hit, you're out. High stakes, clean feedback.
- No power-ups, no upgrades, no progression that changes the rules. Pure skill.
  Everyone plays the same game. The only thing that grows is the player.

## Scoring

- `roundScore = banksThisRun` is wrong; simpler:
- Each BANK locks in `currentMultiplier` as points. Round ends, points added to
  session total. Then a NEW round begins — you can chain banks in a single
  "run" by choosing to bank, which starts the next round immediately.
- **Revised simpler model (chosen):** one round = one life. You survive,
  multiplier climbs, you press BANK to lock the score and the round ends.
  Crash = 0 for the round. Session score = sum of all banked rounds. This
  keeps the Aviator "one decision" purity.

## Retention hooks (ethical)

- **Personal best** persisted in `localStorage` — the oldest, strongest hook.
- **Last 10 rounds history** pills (green = banked, red = crashed).
- **Streak counter** — consecutive successful banks.
- **Daily seed** — same obstacle sequence for everyone that day (shareable,
  "today's run"), generated from the date so it's deterministic and fair.
- No FOMO timers, no energy systems, no "you'll lose your streak if you don't
  play." Come back because it's fun, not because you're threatened.

## Visuals & juice (the 100/100 part)

- Neon-on-dark palette. Player orb glows. Obstacles glow red.
- **Multiplier counter** is the visual hero — huge, centered, pulses as it climbs.
- Particle burst on BANK (green, satisfying). Screen shake + red flash on CRASH.
- Motion trail on the orb. Subtle parallax starfield background.
- Speed lines intensify as multiplier rises — visual pressure matches mechanical pressure.
- Screen-edge vignette darkens as multiplier climbs.
- All juice on Canvas, no DOM animation.
- Sound: WebAudio oscillator beeps (ascending pitch as multiplier rises, crash
  buzz on death, bright chord on bank). Zero audio files, zero dependencies.

## Controls

- **SPACE / click / tap** = BANK
- **Arrow Up/Down or mouse Y / touch Y** = move orb vertically
- **R** = restart after crash
- Mobile-first: the whole game is playable one-handed on a phone screen.

## Tech

- One file: `index.html`. Canvas 2D. Vanilla JS. No frameworks, no bundler.
- Runs by opening the file — no server required.
- Responsive canvas, fills viewport, works on phone and desktop.
- `ponytail:` — single file, no build, no deps, no backend. Add a server only
  when multiplayer/leaderboards are actually needed.

## Out of scope (YAGNI)

- No accounts, no auth, no backend, no multiplayer — yet. Local-only PB.
- No monetization in v1. The game earns by being good; monetization is a later
  decision and will be cosmetic-only if added.
- No settings menu, no tutorial level — a 3-line "how to play" overlay on first
  load, then it gets out of the way.

## Success criteria

- Open the file → playing in under 1 second.
- One round = ~10 seconds. "One more run" feels natural.
- Personal best creates the pull to return.
- Crash feels fair (your fault), bank feels earned (your timing).
