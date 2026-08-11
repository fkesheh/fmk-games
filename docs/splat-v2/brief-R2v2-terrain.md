# SPLAT V2 — R2v2 (terrain): groomed piste, powder, banks, richer rocks, foothills

You own EXACTLY: `games/splat/client/src/render/terrain.ts`.

Read STYLE_BIBLE §V2.2 and the existing terrain.ts (slope mesh, forest walls,
ridge rocks, peak cards). Implement the v2 terrain pass. ALL colours from
SPAL; all meshes via `contract/visual.ts`; deterministic from
`rng(slope.seed ^ salt)` — never Math.random.

1. **Groomed piste:** in `snowColor`/the slope-mesh vertex loop, add a subtle
   corduroy read down the piste centre: a band `|x| < width*0.18` gets a
   faint lightening toward `snowLit` (±1% value) plus 3–4 very faint parallel
   ridge lines (sine-based value modulation along x, wavelength ~2.5 m,
   amplitude ±0.6% — just perceptible, not stripey). Off-piste beyond the
   band keeps the deeper `snowShade`/`snowDeep` powder look. Everything
   derives from the seed so the groom is stable per mountain.
2. **Snow banks:** seeded rounded mounds (visual only — NEVER inside the
   corridor or plant clearances; tuck them against the piste edges, mostly
   outside `halfW - 2`, plus a couple near the start): squashed
   `snowShade` half-spheres (scale y ~0.35) with `snowLit` wind-scallop caps,
   clustered 3–5 like the plants, ~12–16 clusters total, deterministic.
   Keep total instances modest (≤ 120 meshes, then `bake()` them — banks are
   static).
3. **Rocks:** the existing `buildRocks` outcrops get angular fracture — each
   boulder becomes 2–3 interlocking squashed spheres/boxes in
   `rockLit`/`rock` with a `snowLit` snow skirt on the uphill face (a
   slightly larger flattened cap behind/above) and a `snowShade` shadow
   crease at the base. Plus ~20 small debris rocks (0.3–0.6 m) scattered
   near the piste edge for foreground scale. Still baked to a few draw calls.
4. **Foothills (depth plane):** a NEARER ridge between the peak cards and the
   piste: a second ring of peak-card-style silhouettes at ~380–460 m, hazed
   only ~50% toward `skyHorizon` (mix the card colours 50/50 with the full
   haze), lower and rounder than the far peaks, `fog:false`, ~10–14 cards.
   Same buildPeakCards technique — reuse its geometry-building path with
   different radius/haze so it reads as a nearer plane.
5. Keep the terrain budget: slope mesh ≤ 128×256 segments (unchanged), total
   visual instances ≤ 3k (unchanged), draw calls stay well under the < 80
   budget.

Your gate: `node node_modules/typescript/bin/tsc --noEmit -p
games/splat/client` — fix every error in terrain.ts; sibling files' errors
are the orchestrator's. Report actual output.
