# SPLAT V2 — ART-DIRECTOR FIX ROUND 3 (ESCALATION)

Two judge rounds (8 critics each, blind vs Lonely Mountains: Downhill) both
returned gap 4–5. Incremental tweaks did not move the gap. This round
ESCALATES: the accumulated deficiencies are now explicit requirements, and
the fixers are the strong tier. The bar remains "gap ≤ 1 or wowed" — but
honest movement is the goal. Frozen laws hold: flat-shaded Lambert only,
all colours from SPAL, meshes from `contract/visual.ts` factories,
deterministic seeded rng, draw calls < 80, particles ≤ 512, no per-frame
allocation, terrain ≤ 128×256 segments, visual instances ≤ 3k.

## The accumulated deficiencies (two rounds of judges — treat as requirements)

- **"Snow shading flat / blown-out white void / no blue-vs-sunlit contrast"**
  → the piste must read as SHADED snow: cool blue-violet shade on one side,
  warm sun-lit white on the other, soft AO in the creases and under trees.
- **"Hard uniform shadows / no ground contact"** → long SOFT shadows; trees
  and props grounded (contact crease), no floaters, no z-fighting.
- **"World empty / evenly spaced trees / no clutter"** → dense organic
  forest walls (CLUSTERED, not a grid), midground rocks/banks/debris,
  foreground interest near the piste.
- **"Copy-paste trees"** → at least 3 archetypes + strong per-instance
  variety.
- **"Sky artifacts / flat horizon"** → a rich multi-stop gradient sky, a
  visible warm sun, soft haze, no banding.
- **"HUD looks like a template"** → a real design language: grounded scrim
  chips with borders and depth, a proper JUMP button, a bound progress rail.

## The briefs

### T1 (pro) — terrain.ts: AO-shaded snow + dense clustered forest + clutter
- **Vertex AO:** in the slope-mesh colour pass, compute a soft ambient-
  occlusion term from the heightfield (curvature: concave creases/valleys
  darker toward snowShade, convex ridges brighter toward snowLit; plus a
  distance-from-forest darkening so the piste edges near trees carry soft
  shade). Blend it into the existing sun-dot colour (max ~0.12 of the
  snowDeep channel). The result: the piste is visibly SHADED, not a flat
  white void.
- **Height-based snow:** higher terrain slightly brighter/cooler (ice blue),
  lower slightly warmer/deeper — a subtle vertical gradient in the vertex
  colours.
- **Forest walls — clustered not gridded:** change the scatter so trees form
  organic clusters (seeded Gaussian blobs with jitter) instead of the even
  per-row spacing; raise FOREST_MAX toward the 3k budget; widen the depth
  band a little. Trees must still clear the piste edge (FOREST_IN) and the
  corridor.
- **Third archetype:** a round-topped snowy tree (2-3 overlapping
  flattened cones/spheres, heavier snow cap, ~15% share) so the forest
  reads as mixed species.
- **Clutter:** more small debris rocks near the piste edge (~30), a few
  wind-scallop banks, 4-6 midground boulders INSIDE the piste near the
  edges (visual only, off the corridor).
- Everything grounded (base = height − sink); deterministic; budget-safe.

### T2 (pro) — scene.ts: soft long shadows + rich sky + haze
- **Shadows:** `sun.shadow.radius = 8` (PCFSoft softness), widen
  SHADOW_EXTENT to ~85 so forest walls land in the box, keep normalBias
  tuned against acne; the visible result is LONG SOFT shadows raking the
  piste.
- **Sky:** rebuild `tintSky()` with a richer 5-stop gradient (deep zenith →
  azure → ice horizon → a faint warm sunWarm band just above the horizon →
  the fog-matched rim), all SPAL lerps; kill any banding by using smooth01
  ramps (they exist). Add a soft warm radial glow already present — keep.
- **Haze:** a barely-there warm `sunWarm`-tinted haze quad ring just above
  the horizon (baked, fog:false, low alpha) so distance reads atmospheric.
- Keep prewarm/resize/drawCalls/setAirborne/land/buildTerrain intact.

### T3 (pro) — ui/hud.css + hud.ts: a HUD design language
- Chips become **grounded badges**: rounded, paper panel + ink border + soft
  shadow + a thin skier-colour accent line; the place chip keeps the big
  ordinal in the skier colour on a paper disc with an ink ring.
- **Progress rail** is bound to the right edge with a visible ink track + a
  subtle paper inner glow; dots get a white rim (you dot slightly larger +
  sunGold rim when you lead).
- **JUMP button**: a real button — paper disc, sunGold ring + arrow, soft
  drop shadow, pressed state (scale 0.92 + brighter ring), a tiny "HOP"
  label under the arrow (text + glyph — the UX law: never colour alone).
- **Speed chip**: bar + numeral on a paper scrim; the bar gets a sunGold
  gradient fill.
- No per-frame allocation; hud.test.ts green; DOM built once, updated in
  place.

## Gate
tsc on games/splat/client (fix YOUR files only) + client vitest green.
Report file-by-file changes + actual gate output tails. Do NOT commit.
