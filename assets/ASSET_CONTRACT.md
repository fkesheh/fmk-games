# ASSET LIBRARY CONTRACT — v1 (frozen)

Immutable. Implementers fill module bodies against this; they may never alter
the types, the kit, the palette, or the budgets. Violations a reviewer checks:
ad-hoc hex outside `palette.ts`, `any`, untyped holes, per-frame allocation in
`update()`, geometry not merged, colors not tier-traced, budgets exceeded,
non-determinism for a fixed seed.

## Layer 1 — frozen files

| File | Role | May implementers touch? |
|---|---|---|
| `library/src/types.ts` | all cross-module types | NO |
| `library/src/kit/palette.ts` | named palette `TREE_PALETTE` | NO |
| `library/src/kit/rng.ts` | re-export of `@platform/shared/rng` | NO |
| `library/src/kit/material.ts` | `ASSET_MATERIAL` + wind patch | NO |
| `library/src/kit/wind.ts` | `aBend` attr writer + `setWind()` | NO |
| `library/src/kit/geometry.ts` | blob/taper/strip/merge/counter | NO |
| `library/src/kit/budgets.ts` | pure budget + height data | NO |
| `library/src/registry.ts` | `ASSETS` array + `assetById()` | additive only (new species) |
| `library/src/trees/*.ts` | one species per file | YES — bodies only |
| `viewer/src/**` | the UI | YES |

## Types (verbatim `types.ts`)

```ts
import type * as THREE from 'three';

export type AssetCategory = 'tree';            // grows: 'rock' | 'prop' | …
export type Quality = 'hero' | 'lod' | 'micro';
export type MotionKind = 'wind' | 'none';

export interface AssetVariation {
  readonly id: string;        // 'autumn'
  readonly label: string;     // 'Autumn Oak'
  readonly seed: number;      // uint32 — feeds rng()
  readonly notes: string;     // what makes this variation distinct
}

export interface AssetMeta {
  readonly id: string;        // 'oak' — URL-safe
  readonly category: AssetCategory;
  readonly name: string;      // 'Oak'
  readonly description: string; // one sentence, storytelling
  readonly variations: readonly AssetVariation[]; // ≥ 3
  readonly motion: MotionKind;
  readonly triBudget: Readonly<Record<Quality, number>>; // mirrors budgets.ts
  readonly heightRange: readonly [number, number];      // metres, mirrors budgets.ts
}

export interface BuiltAsset {
  readonly root: THREE.Object3D;   // origin ground-centre, +Y up, ONE merged mesh
  readonly tris: number;           // exact, from geometry.ts counter
  readonly bbox: THREE.Box3;       // world-space after build
  readonly mesh: THREE.Mesh;       // uses ASSET_MATERIAL
}

export interface AssetModule {
  readonly meta: AssetMeta;
  build(quality: Quality): BuiltAsset; // variation chosen via meta + registry
  buildVariation(variationId: string, quality: Quality): BuiltAsset;
}
```

## Shared context

- `ASSET_MATERIAL` — the ONE Lambert (white, vertexColors, flat, wind-patched).
- `setWind(timeSeconds, strength0to1)` — called once per frame by the host;
  default 0.5 / 0 when host does nothing (graceful static).
- `blob(rngNext, opts)` — faceted foliage mass, vertex-colored by tier,
  `aBend` populated. `taperCylinder`, `strip`, `mergeAll`, `triCountOf` likewise.
- All species build: geometry parts → per-part color tier + bend weight →
  `mergeAll` → single `THREE.Mesh(geom, ASSET_MATERIAL)`.

## Determinism & budgets (mechanically enforced)

- Same `seed` + `quality` → byte-identical geometry (test-hashed).
- tris ≤ `triBudget[quality]` for every species × variation × quality.
- `heightRange` respected by every variation; base verts (y < 0.2) have
  `aBend` < 0.15; max `aBend` ≥ 0.6 (tree actually moves).

## Species model sheets — TREES v1

All: root flare, natural lean ±4°, `…Deep` contact band at base, one story
detail per hero variation. Height/unit = metres; soldier = 1.8.

### 1. `oak` — heroic broadleaf (8–12 u)
Squat tapered trunk (7–9 sided, visible taper, 2–3 bark ridge runs), 3–5
gnarled secondary boughs angling 35–55° up, canopy = 6–9 large blob masses
(0.9–1.8 u radius) in 3 value tiers with `leafLit` crowns top/sun side,
`leafDeep` under-canopy, gaps between masses (birds can fly through). Variations:
`veteran` (default, hollow knot + one broken bough), `autumn` (leaf mix shifts to
autumn accents on ~40% of canopy), `young` (slimmer, 5 blobs, brighter tiers).

### 2. `birch` — slender paper-bark (10–14 u)
Straight slim trunk (5–6 sided) with dark `birchBand` lenticel bands every
0.5–0.9 u, slight S-curve lean, 5–8 thin drooping branchlets (tip 15–30° down),
airy canopy = 4–7 smaller blobs (0.5–1.1 u), lighter yellow-green tiers, some
sky visible through it. Variations: `twin` (double trunk from one root),
`leaning` (strong 6–8° lean, wind-shaped one-sided canopy), `classic`.

### 3. `pine` — layered conifer (12–16 u)
Straight trunk mostly hidden, 5–7 layered skirts (cone rings), each skirt =
8–14 faceted drooping tips, tier color cool pine greens, top spike. Snow biome
variation dusts upward-facing surfaces (`snowDust` on top skirt faces).
Variations: `snowbound` (snow dust + slightly stunted), `tall` (14–16 u, 7
skirts), `standard`.

### 4. `snag` — dead tree (7–10 u)
No foliage. Jagged tapered trunk, 4–6 broken branches at expressive 20–70°
angles, deadwood 3-tier greys-browns, woodpecker hole (`knotHole`), top broken
at a lightning-angle. Variations: `lightning` (split top char tint),
`weathered` (paler greys, moss patch at base), `classic`.

### 5. `palm` — tropical (9–13 u)
Curved ringed trunk (rings every 0.4–0.6 u, curve 5–12°), 7–9 arched fronds
(bent strips, 4–6 segments, sagging tips), coconut cluster (3–5 `coconut`
faceted spheres) at the crown, saturated green tiers. Variations: `curved`
(strong 12° curve), `coconut-heavy` (5–7 nuts, slightly fewer fronds),
`standard`.

## Viewer contract (`@assets/viewer`)

- Gallery: every registered asset, live thumbnails (hero, variation 0).
- Focus stage: OrbitControls turntable (auto-rotate default on, drag to orbit),
  ground disc + contact shadow, gradient sky dome per species biome.
- Controls: variation cycler ◀ ▶, LOD switcher (Hero/LOD/Micro), wireframe
  toggle, wind toggle + strength slider, stats HUD (tris, draw calls, height,
  footprint, budget headroom).
- URL params (headless-judge surface): `?asset=oak&variation=autumn&lod=hero
  &wind=0.5&angle=three-quarter|front|high|closeup&ui=0|1&autorot=0|1`.
  With `ui=0` chrome hides; `window.__ASSETS_READY` set + `document.title =
  'ready'` after first rendered frame (puppeteer waits on this).

## Gates (all must be green)

1. `npm run typecheck -w @assets/library` and `-w @assets/viewer` (strict).
2. `npm run build -w @assets/viewer` (vite build).
3. `npx vitest run assets` (registry / budgets / palette / tiers / wind tests).
4. `node scripts/capture-assets.mjs` — screenshots to `judge/captures/trees/`.
5. Art-director judge (fresh, context-free, harsh) — per-asset scorecard vs
   the style bible benchmarks; every axis ≥ 7 and no fatal smell, or fix-loop.
