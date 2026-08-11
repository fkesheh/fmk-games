# SPLAT V2 — ART-DIRECTOR FIX ROUND 1 (judge findings)

The Phase-4 art-director panel (8 harsh critics, blind vs Lonely Mountains:
Downhill) returned gap 4–5 on every shot. Their CONSOLIDATED findings —
these are your orders. All colours still from SPAL; meshes only from
`contract/visual.ts` factories; deterministic seeded rng; draw calls stay
< 80; no per-frame allocation. Files: your brief names which one you own.

## The judge findings (round 1)

1. **Lighting/flatness ("no ground shadows", "plastic snow", "washed out")**
   — the world reads uniformly lit. Long soft BLUE shadows are half the
   Lonely-Mountains look; we have them but they don't read.
2. **Density ("world empty", "sparse trees", "no midground")** — vast clean
   snow reads dead. Add foreground/midground props and terrain interest
   WITHOUT touching the gameplay corridor or plant clearances.
3. **Color ("overly saturated green trees", "no blue snow shade",
   "no warm/cool contrast")** — the piste should carry cool blue shade
   against warm sun; plants should pop but not scream.
4. **Silhouette ("trees repetitive", "finish gate unreadable", "no skier")**
   — vary the trees, make landmarks read at distance.
5. **HUD ("place chip orange clashes", "progress rail invisible", "jump
   button unremarkable", "default sans looks placeholder")** — the UI needs
   scrims, weight, and coherence.
6. **Cleanliness ("z-fighting", "floating trees", "banding", "hard HUD
   overlay")** — grounding and integration.

## Fixer briefs

### F1 — scene.ts (lighting + grade)
- Shadow presence: lower the sun elevation (SUN_ELEV in visual.ts is 0.24;
  try 0.16–0.18 for longer raking shadows), keep the warm sunWarm tint,
  raise the shadow map to 2048 (already) and widen SHADOW_EXTENT slightly
  (55 → 70) so more forest wall lands in the box; soften with a slightly
  larger normalBias (0.05 → 0.08) to kill acne; ensure `renderer.shadowMap`
  uses PCFSoft (it does). The visible result must be LONG SOFT BLUE shadows
  across the piste.
- Warm/cool grade: strengthen the warm sunGold ground-half lift slightly
  (GRADE_ALPHA 0.07 → 0.10) and deepen the cool vignette a touch — the
  classic warm-key/cool-shadow split.
- Sky: the judges called the horizon "banded/washed". Re-tint the dome so
  the rim is a hair cooler (less white) and the zenith a touch deeper
  (all via existing SPAL lerps — no new hex).
- Keep prewarm/resize/drawCalls/setAirborne/land/buildTerrain intact.

### F2 — terrain.ts (density + midground)
- More midground interest near the piste edges (visual only — NEVER inside
  the corridor or the plant clearances): ~10–14 more rock outcrop clusters
  (the angular 2–3-interlocking-boulder style) plus scattered small debris,
  a few seeded snow-drift banks hugging the runout, and 3–5 lone mature
  pines INSIDE the piste edge band (dressing, not gameplay — keep them off
  the corridor).
- Break the horizon: raise some near foothill peaks and vary the existing
  foothill heights so the skyline is not a flat band.
- Ground contact: ensure every rock/bank sits ON the terrain (base = terrain
  height − sink), no floaters, no z-fighting (nudge skirts into the snow).
- Budget: total visual instances ≤ 3k, draw calls stay well under 80.

### F3 — plants.ts (variety + colour harmony)
- Scale variety up (wider sclLo/sclHi), add per-instance rot.z lean and
  slight per-instance hue/value jitter WITHIN the frozen SPAL entries (pick
  between pine/pineDark/pineLit per instance via the seeded rng) so no two
  plants read identical and the green is less uniform.
- Snow dust: make the caps read better (larger, brighter snowLit caps).
- Keep the 3 draw calls, the hit squash/shake, band culling, and the
  in-piste counts (≤150).

### F4 — ui/hud.css + ui/hud.ts (HUD polish)
- Scrims: every chip (place, speed) gets a stronger scrim wash + a soft
  drop-shadow so it reads over bright snow.
- Progress rail: give it weight — a thin ink rail with a subtle paper glow
  so the dots are visible against the sky.
- JUMP button: bigger visual weight — thicker sunGold ring, a soft paper
  halo, and a pressed state (scale + darker ring).
- Place chip colour: if the chip inherits the skier colour and the judge
  called orange clashing, keep the skier colour but add a paper ring so it
  reads as a badge, not a raw swatch.
- Keep the change-guarded render + no per-frame allocation + all tests
  green (hud.test.ts).

### F5 — gates.ts (finish readability)
- Make the finish read at distance: slightly taller finish poles, a brighter
  sunGold banner panel (already gold — raise its y so it clears the haze
  band), and 2–3 small snow-lit rocks + a pair of tiny flags at the gate
  feet for grounding.
- Lodge: a touch more presence (the smoke puffs already read; raise the
  roof snow a little) — do not block the runout.

## Gate
For each: `node node_modules/typescript/bin/tsc --noEmit -p
games/splat/client` — fix EVERY error in YOUR files; sibling errors are the
orchestrator's — + the client vitest suites stay green. Report file-by-file
changes + actual gate output tail. Do NOT commit.
