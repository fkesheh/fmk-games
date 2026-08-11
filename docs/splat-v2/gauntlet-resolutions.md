# SPLAT V2 — Gauntlet resolutions (audit trail)

3-reviewer panel verdict: **FIX-FIRST (3/3)**. Every finding resolved before
refreeze. The empirical prototype (`prototype-v2.mts`) ran the v2 physics on
real genSlope seeds and is the evidence the panel demanded.

## FATAL (2)

1. **`airHeight` rendering frame** (coherence, all 3 reviewers) — the pre-
   gauntlet helper returned height above the LAUNCH point but the render
   formula added it to CURRENT terrain: on a descending piste the skier
   rendered underground (up to ~12 m error). **Fix:** `airHeight(s, x, z,
   slope)` now returns height above the CURRENT terrain; the landing test
   uses the world frame `airStartY + arc <= slope.height(x,z)` — both derive
   from the same world-space arc (CONTRACT §11.2).
2. **Kicker-scan gated behind the grounded-only branch** (totality, 2
   reviewers) — a ramp crossed mid-air was never consumed, contradicting the
   Kicker doc and creating the hop-then-cross re-launch bug. **Fix:** the
   scan runs EVERY step; any crossing consumes (`lastKickerIx` advances);
   a launch requires grounded + off-cooldown + within halfWidth (§11.2).

## MAJOR (resolved)

3. **World-frame jump tuning** — with launch vy 4.2/5+0.16v the terrain-drop
   term (~0.26·v m/s) amplified flights to ~13 m air. **Fix:** retuned
   J_HOP_VY 1.1, J_KICKER_VY_BASE 1.8, J_KICKER_VY_SPEED 0.05, cooldown 1800
   ms, land scrub 0.97; empirically verified: hop apex 1.5–2.5 m, kicker
   apex 3–4.6 m, flights 30–50 m, always land, always contained.
4. **DESIGN_BIBLE "no jump" contradiction** (precedence chain) — Pillar 1 +
   Non-goals amended for v2.
5. **4-year-old test never run** — now empirically run (prototype) AND gated
   (P1v2 unit + E2Ev2): full-lock 20/20 both directions, hop-then-full-lock
   20/20 both directions (contained ≤ 3.5 m off-piste), corridor rider 20/20.

## MINOR (resolved)

- Wire omits `jump:false` (bandwidth).
- Kicker spacing 85 m > max flight ~52 m (no overshoot).
- Cooldown-denied feedback (quiet thud + chip pulse) in UX_BIBLE §V2.
- Cloud puffs bake to ≤ 2 draw calls (STYLE_BIBLE §V2.5).
- §11.3 clarified: validateSlope checks the 4 laws, not centreline membership.
- E2Ev2 gate adds the full-lock-with-kickers finish assert.
- slope.ts stale grade comment corrected (0.26−0.08 = 0.18).
- §11.2 documents the containment bound + hop-over-kicker timing skill.
