# SPLAT V2 — CONTRACT GAUNTLET (review brief)

You are an adversarial pre-freeze reviewer. A team wrote the FROZEN PREP for
**SKI SPLAT v2** — a first-person multiplayer downhill ski racer (three.js,
TypeScript, strict) — and is about to mark the v2 contract IMMUTABLE and fan
the build out to ~13 parallel implementers. This is the LAST chance to fix the
contract. The build has NOT happened; review ONLY the prep (the contract text
+ the frozen code files + the bibles + the ownership table + the gate list).
Do NOT review the existing v1 implementation for style — review the v2 prep
for soundness.

## What v2 is

Two things: (1) **JUMPS** — a new core mechanic: a manual hop (jump edge on
the wire) and seeded **kicker ramps** on the slope; one shared world-space
ballistic arc; flying is pure upside (no plant contact in air, gates still
boost, landing is always safe); (2) a **full graphics overhaul** across every
visual module.

## Files to read (the prep)

- `games/splat/CONTRACT.md` — the frozen contract; **§11 is the v2 amendment**
  (jump semantics §11.2, kicker placement §11.3, graphics §11.4, ownership
  §11.5, gates §11.6). Read §0–§10 too — the amendment must not contradict it.
- `games/splat/shared/src/types.ts` — SkierSim air fields, Kicker, SlopeDef.kickers,
  SplatInputMsg.jump, SkierSnap.airborne
- `games/splat/shared/src/config.ts` — J_* and KICKER_* constants
- `games/splat/shared/src/protocol.ts` — jump parse
- `games/splat/shared/src/sim.ts` — v2 field constructors + airHeight()
  (the jump STATE MACHINE inside stepSki is implementer P1v2's body — judge
  the SPEC in CONTRACT §11.2, not the missing body)
- `games/splat/shared/src/slope.ts` — genSlope returns `kickers: []` for now
  (P2v2 fills the seeded placement per §11.3 — judge the SPEC)
- `games/splat/STYLE_BIBLE.md` §V2 — the per-asset graphics brief
- `games/splat/UX_BIBLE.md` §V2 — the JUMP control surface
- `games/splat/DESIGN_BIBLE.md` — the design law (the 4-year-old test)

## The lenses — refute "sound and ready to freeze" on each

1. **Coherence** — every cross-boundary call resolves; no untyped holes; does
   the frozen surface let every module reach what it needs? Does the client
   actually have a way to know its OWN airborne state and the REMOTE ones?
   Does the wire carry enough? (The contract deliberately adds NO jump/land
   events — remotes derive FX from snap.airborne edges. Is that sound at
   20 Hz with a 0.86 s hop?)
2. **Totality** — any responsibility owned by NO module? (e.g. who builds the
   kicker MESH? who triggers the landing FX? who owns the air camera?)
3. **Consistency** — any frozen artifact contradicting another? Numbers
   consistent (config vs §11.2 vs bible)? The `airHeight` closed form vs the
   §11.2 world-space landing test vs the camera contract — do they agree?
4. **Buildability** — can the frozen kit + palette + material model produce
   the bible's mood? Is every bible demand mapped to a module + file?
5. **Gate** — do the gates actually prove the mechanics? (jump determinism,
   the v2 4-year-old test, e2e airborne assertions, the 2 KB snapshot budget
   with the one new bool + optional edge)
6. **Gameplay coherence** — with the FROZEN numbers (J_HOP_VY 4.2, kicker vy
   = 5 + 0.16·v, cooldown 1200 ms, air steer 0.35×, 9 kickers at ~75 m), is
   the jump GOOD? Think: does a kicker launch at 26 m/s fly ~49 m — off the
   piste? into plants? across the finish? Is the manual hop useful at all vs
   just riding kickers? Is there a dominant strategy? Does the 4-year-old
   test still hold (a full-lock skier on 20 seeds with kickers in the
   corridor must always finish)? Check the numbers, don't hand-wave.
7. **UX completeness** — JUMP button + hint + feedback budget covered? The
   assist interaction (assist never auto-jumps) sensible? Accessibility
   (glyph not colour)? The thumb-lift tradeoff acceptable?
8. **Non-functional** — draw calls < 80 with kickers + clouds + foothills +
   the second pennant row? Particles ≤ 512 with the new land/launch bursts?
   The snapshot ≤ 2 KB at 8 players with airborne + jump on the wire?

## Output

Ranked findings (most build-sinking first). For each: lens, severity
(fatal | major | minor), file, quoted evidence, WHY it sinks the build if
frozen as-is, and the FIX. Be honest if a lens finds nothing. End with a
one-line verdict: FREEZE / FIX-FIRST / REJECT. Return your findings as plain
text in your reply (no files needed).
