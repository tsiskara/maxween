# Maxween — Apple-Level Brand & Design Overhaul

## What We're Working With

Four independent single-file HTML games with **zero brand coherence**:
- **boost.html** (1780 lines) — Flagship crash betting game. Most polished but needs refinement.
- **fusion.html** (943 lines) — Physics merge game. Good bones, diverges from boost's design.
- **index.html** (504 lines) — Canvas arcade survival. Rawest visually — zero CSS variables, no safe areas, no accessibility.
- **maxween.html** (420 lines) — Legacy demo. Different font, different colors, different genre positioning.

## Phase 1: Brand Foundation — Shared Design System

Create a shared CSS custom properties spec applied consistently across ALL files:

### Color Palette (unified, Apple-calibrated dark mode)
```
--surface-0: #06040c      (deepest background)
--surface-1: #0f0c1a      (panel bg)
--surface-2: #1a1428      (elevated card)
--text-primary: #f4f1f8   (headlines, values)
--text-secondary: #8b8398 (labels, muted)
--text-tertiary: #5a5468  (disabled, footnotes)
--accent-gold: #ffc740    (currency, rewards, CTAs)
--accent-red: #ff3b5c     (danger, crash, bust)
--accent-green: #2ee68a   (success, cash out, bank)
--accent-blue: #36c6ff    (info, highlights)
--accent-purple: #b07bff  (rarity, epic, level-up)
--glass: rgba(255,255,255,.05)
--glass-border: rgba(255,255,255,.08)
```

### Typography Scale
```
--font-sans: 'SF Pro Display', 'Inter', -apple-system, system-ui, sans-serif
--font-mono: 'SF Mono', 'JetBrains Mono', 'Cascadia Code', monospace
```
Apple-type ramp: 10/11/12/13/14/15/17/20/22/28/34/40/48/56/64/72px with fixed weights

### Spacing Scale (4px grid)
```
--space-1:4px, --space-2:8px, --space-3:12px, --space-4:16px,
--space-5:20px, --space-6:24px, --space-7:32px
```

### Radius Scale
```
--radius-sm:8px, --radius-md:12px, --radius-lg:16px, --radius-xl:20px, --radius-full:24px
```

### Motion Tokens
```
--ease-out: cubic-bezier(0.16, 1, 0.3, 1)       (Apple default ease-out)
--ease-spring: cubic-bezier(0.2, 1.4, 0.4, 1)    (bouncy entrances)
--duration-fast: 150ms, --duration-normal: 250ms, --duration-slow: 400ms
```

---

## Phase 2: boost.html — Flagship Refinement

The main game. Already has 15 CSS variables, adaptive music, haptics, PWA meta. These are the specific Apple-quality upgrades:

1. **Replace Trebuchet MS with SF Pro / Inter** — Trebuchet has a small x-height and informal character. SF Pro is Apple-native and geometrically precise.
2. **Fix safe-area on bottom panel** — `#panel` currently doesn't account for `env(safe-area-inset-bottom)`.
3. **Add `prefers-reduced-motion` support** — Gate all 22 keyframe animations behind media query. The JS `reducedMotion` setting should sync with the OS preference.
4. **Add proper `:focus-visible` styles** — Keyboard navigation currently has zero visible focus indicators.
5. **Add `aria-live` regions** — Screen readers need announcements for score changes, multiplier events, crash/bust, and round state.
6. **Add `aria-label` to canvas and all icon buttons** — Currently partial.
7. **Refine color phase transitions on multiplier** — Current green→gold→red switch is instant. Add smooth `transition: color 0.3s var(--ease-out)`.
8. **Upgrade the starfield background** — Add parallax layers, twinkle alpha oscillation, and subtle nebula color variation (currently flat single-layer).
9. **Refine button shine animation** — Replace hard-coded `left:-100%` pseudo-element with percentage-based keyframe for smoother GPU compositing.
10. **Add `will-change` hints** on frequently animated elements (multiplier, bet buttons, canvas).
11. **Z-index system** — Replace 12+ scattered magic numbers with CSS variables (`--z-canvas:1`, `--z-hud:10`, `--z-overlay:20`, `--z-modal:30`, `--z-toast:40`, `--z-max:50`).
12. **Add Apple touch-icon meta** and proper favicon (currently only SVG data URI).
13. **Canvas polish** — Add subtle bloom/glow pass to rocket flame, chromatic aberration only on extreme multipliers (currently always-on pattern), smooth the crash shake decay (currently linear).

---

## Phase 3: fusion.html — Align with Design System

1. **Sync color variables** to match boost.html — Currently different gold (`#ffd24a` vs `#ffc740`), different green (`#3dffa6` vs `#2ee68a`), different pink (`#ff4d8d` vs `#ff3b5c`).
2. **Replace Trebuchet MS** → SF Pro / Inter font stack.
3. **Add monospace font** for score/coin displays — Prevents layout shift during count-up.
4. **Add `font-variant-numeric: tabular-nums`** on all numeric HUD elements.
5. **Add `aria-label`** to canvas, logo button, shop button, mute button.
6. **Add `:focus-visible` styles** to all interactive elements.
7. **Add `prefers-reduced-motion` gating** on combo banner, pulse, new-best, and starfield animations.
8. **Fix safe-area on bottom controls** — Credits and next-ball preview currently overlap home indicator.
9. **Upgrade overlay transitions** — Current `transform: scale(1.04)` causes subpixel blur. Use `opacity` + `translateY` instead.
10. **Add haptic feedback** — Currently zero haptics. Add vibrate on merge, combo, max tier, and game over.
11. **Unify button design** — fusion's alt button gradient (`#5a5a8a`→`#3a3a60`) should use the shared design tokens.
12. **Add `will-change` and `contain` hints** on frequently animated elements.

---

## Phase 4: index.html — Complete Visual Overhaul

This file needs the most work. Current state: zero CSS variables, no accessibility, no safe areas.

1. **Inject the shared design system** — Add all CSS custom properties.
2. **Redesign HUD blocks** — Use glass morphism (matching boost/fusion), proper safe-area padding, consistent border-radius.
3. **Upgrade multiplier display** — Add color-phase transitions, spring scale on change, proper text-shadow.
4. **Redesign bank button** — Match boost.html's button language: gradient, shadow glow, shine sweep, proper active state with spring.
5. **Add overlay transitions** — Currently toggles `display:none`. Replace with opacity + transform fade.
6. **Upgrade obstacle rendering** — Add gradient fill, inner highlights, edge glow falloff per obstacle.
7. **Add parallax starfield layers** — Currently single-layer, no twinkle.
8. **Add particle variety** — Bank particles should sparkle (circles with glow), crash should fragment (rectangles/rotated).
9. **Add `aria-live` announcements** for game events.
10. **Add haptic feedback** — Vibrate on bank, crash, new best.
11. **Add `prefers-reduced-motion`** to gate screen shake, pulse, particle storms.
12. **Add keyboard focus management** — When game-over overlay shows, auto-focus the PLAY AGAIN button.
13. **Fix all contrast issues** — Credits text, status text, HUD labels all fail WCAG AA.
14. **Add PWA meta tags** — `apple-mobile-web-app-capable`, `theme-color`.

---

## Phase 5: maxween.html — Brand Alignment or Removal

This is a legacy demo with a completely different design language. Two options:
- **A (recommended)**: Re-theme it to match the unified design system so it serves as a lightweight "try the mechanic" page.
- **B**: Remove it — it's redundant with boost.html which is the real product.

---

## Phase 6: Brand Coherence

1. **Unified naming** — Every page gets the same brand treatment. If "Maxween" is the umbrella, every title area shows it. If each game is standalone, pick one name per product.
2. **Consistent "bank"/"cash out" terminology** — index.html says "BANK" while boost.html says "CASH OUT". Pick one.
3. **Responsible-play messaging** — boost.html has it, others don't. Add consistent disclaimers.
4. **Footer/credits treatment** — All files should use the same position, opacity, and typography.

---

## What I Won't Touch
- Game logic, provably-fair math, audio engines, persistence schemas
- Mission/achievement/XP/skin data (they're fine)
- Responsible-play systems (they're already solid)

## Build Order
1. Design tokens → inject into boost.html → verify
2. boost.html refinements (safe areas, accessibility, motion, canvas polish)
3. fusion.html alignment (colors, fonts, haptics, accessibility)
4. index.html overhaul (most work — new design system, accessibility, polish)
5. maxween.html decision + alignment
6. Brand coherence pass across all files
7. Lighthouse audit + fix pass