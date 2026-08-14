# SKI SPLAT — CONTRACT §12 / V3 AMENDMENT (rev 2 — post-gauntlet, FROZEN)

Extends `games/splat/CONTRACT.md` §1–§11. Where §12 conflicts with §11 it wins
**for the two v3 feature surfaces only** (air lock, visual refinement).

**Revision history.** Rev 1 was submitted to a 3-reviewer adversarial pre-freeze
gauntlet and rejected 3/3 (REJECT / FIX-FIRST / REJECT). Rev 2 resolves every
`fatal` and `major` finding. Where rev 2 reverses rev 1, rev 2 wins; rev 1 is
dead and must not be consulted.

Art direction: `docs/splat-v3/STYLE_BIBLE_V3.md` (also rev 2), embedded verbatim
in every visual implementer brief.

---

## §12.0 Owner decisions (settled — do not reopen)

1. **Air lock:** the player may not steer in flight. Reverses §11's "damped
   steering in air = the skill".
2. **Near-field occluders:** permitted **off-piste only, non-colliding**
   (`|x| >= 27`). They may never enter the driveable piste and may never
   acquire a collider. The 4-year-old law is untouchable.
3. **Terrain amplitude:** **raise it**, and re-verify the physics. This is an
   accepted gameplay change, not a visual-only change; §12.4 gates it.
   **Rev 3: by RE-ALLOCATION, not uniform scaling — see §12.2a. Uniform ×2.5–3.0
   was measured to be unshippable.**
4. **Benchmark:** first-person snow-sports set is **primary**; _Lonely
   Mountains: Downhill_ is retained only as an anchor for occlusion and depth
   layering, with judges explicitly instructed to ignore subject matter,
   season, palette and camera.

---

## §12.1 AIR LOCK — the player may not steer in flight

### Code anchors (verified — do not hunt)

`stepSki` = `games/splat/shared/src/sim.ts:233`. Airborne captured pre-step at
`sim.ts:249`. There are **exactly three writers to `s.yaw`**:

| # | Line | Term |
|---|---|---|
| (a) | `sim.ts:260` | `s.yaw += st * turnRateAt(s.v) * (airborne ? J_AIR_STEER_MUL : 1) * dt` — player input |
| (b) | `sim.ts:267-269` | the `±YAW_MAX` / `YAW_SPRING` passive self-centring clamp |
| (c) | `sim.ts:338-340` | inside the soft edge: `s.yaw -= sign(s.yaw) * (aEdge / max(s.v, MIN_SPEED)) * dt` |

Carve scrub is `sim.ts:263`. The soft-edge positional shift is `sim.ts:341`.

### Frozen semantics

While `s.airborne` is true at the start of a step:

1. **(a) contributes zero.** `J_AIR_STEER_MUL = 0` (`config.ts:90`, was `0.35`).
2. **Carve scrub contributes zero.** `J_AIR_CARVE_MUL = 0` (`config.ts:92`,
   was `0.3`).
3. **(b) is suspended.** It is self-centring, not safety.
4. **(c) REMAINS ACTIVE, including its yaw term.** It is the containment
   mechanism and the only thing that may change heading in flight.

**"Heading is frozen" means exactly:** for any flight that never enters the
edge zone (`|x| > slope.width/2 - EDGE_ZONE`), yaw at landing equals yaw at
launch bit-identically, whatever the player holds. Inside the edge zone the
safety system alone curves it back. **Do not test for absolute yaw constancy
on an edge-zone flight.**

Two reviewers independently replayed this arithmetic. Keeping (c) active gives
**~2.02 m** off-piste excursion at launch yaw 0.6 — *better* than v2's measured
4.87 m. Suspending (c) would have given 8–10 m, a 62–65% regression that trips
§12.4 gate 5 by construction. That is why rule 4 is not negotiable.

5. **Unchanged in air:** gravity and drag (`sim.ts:256-257`), the arc (§11.2),
   the plant skip (`sim.ts:289`), gate boosts, landing, finish, and
   `resolveSkiPair`'s airborne skip.

### Forbidden moves

- Do **not** stop sending `steer` on the wire while airborne, and do **not**
  zero it in `drive.ts`. The sim ignores it; suppressing it client-side
  desyncs prediction from authority. Automatic reject.
- The steer ramp / assist EMA in `drive.ts` keeps running in air so landing is
  immediately responsive.
- Do **not** restore air steering to rescue a failing containment gate, and do
  **not** retune `J_MAX_AIRTIME_S`, `J_COOLDOWN_MS`, or the edge constants.
  Those are the orchestrator's.

### The camera currently lies — this is in scope

`render/scene.ts:398-401` computes carve roll as
`clamp(steer,-1,1) * (sp/MAX_SPEED) * ROLL_MAX` and is **not gated on
airborne**. After this change the camera would bank up to ~4° into a turn the
sim ignores, violating UX_BIBLE's input→roll promise. The own-skis rig already
does this correctly (`skiers.ts:435-443` multiply by `(1 - air)`). **W4 must
gate the camera roll on the airborne flag.** Line item, not optional.

### UX decision (recorded so it is not rediscovered)

**No HUD copy change.** `hud.ts:251` "hold a side to steer" remains true when
grounded, and the frozen heading is self-evident from the level air camera plus
the air pose. `hud.ts`, `hud.css`, `hud.test.ts` and `UX_BIBLE.md` stay
untouched. If the judge loop shows players confused in flight, that becomes a
new brief — not an in-flight edit by a visual task.

## §12.2 Air-lock ownership (no file shared with any other task)

| Task | Files (exclusive) | Body |
|---|---|---|
| **A1** | `games/splat/shared/src/config.ts` | `J_AIR_STEER_MUL = 0`, `J_AIR_CARVE_MUL = 0`, **and** the §12.2a terrain-amplitude values (exact numbers, do not improvise). Pure data — no logic. Document each change with a §12 pointer. |
| **A2** | `games/splat/shared/src/sim.ts` | Suspend writer (b) while airborne. Touch nothing else — not (c), not the arc, not landing, plants, gates or pair resolution. |
| **A3** | `games/splat/shared/src/sim.test.ts`, `games/splat/client/src/drive.test.ts`, `games/splat/server/src/room.test.ts` | The §12.4 gates + the repair list below. |
| **A5** | `games/splat/shared/src/containment.test.ts` (new) | The empirical 20-seed sweep, §12.4 gate 7 — a **vitest suite**, not a script, so it runs in CI. (Rev 1 put this in a `.mts` prototype; that is why v2's evidence rotted.) |

`scripts/e2e-splat.mjs` is **A4**'s (§12.3 table). Frozen docs
(`CONTRACT.md`, the bibles, `palette.ts`, `valueLadder.test.ts`,
`contract/visual.ts`, `types.ts`) are **orchestrator-only**.

### A3's repair list (named pre-fan-out — these are the landmines)

- `sim.test.ts:1076-1120` `describe('air steering (damped control)')` —
  **DELETE the whole block.** Its assertions are one-sided upper bounds
  (`< groundedDelta * J_AIR_STEER_MUL + 0.05`, `< groundedScrub + 0.01`) that
  pass *vacuously* at zero. A green test that tests nothing is worse than a red
  one. Replace with the §12.4 gates as **equality** assertions.
- `sim.test.ts:1235` containment `<= 3.5` — **keep the 3.5 m bound.** The
  arithmetic predicts ~2.0 m, so it should pass with margin. If it fails, that
  is a §12.4 gate-5 blocking finding for the orchestrator, not a number to
  relax.
- `sim.test.ts:1212` the 4-year-old law, 20 seeds with kickers — keep.
- **Orchestrator moves, pre-fan-out:** `slope.test.ts:559` ("a corridor-
  following skier crosses every kicker" — it steers *every* step including
  airborne) and `slope.test.ts:591` ("full-lock both directions reaches the
  finish on 20 seeds") are physics tests sitting in **W1's visual file**. The
  orchestrator relocates both into `sim.test.ts` before fan-out so an air-lock
  regression cannot land in a visual implementer's gate.
- `drive.test.ts:655-660` — **the same vacuity, one file over.** The test is
  titled *"the jump edge rides the predictor: airborne becomes true after a jump
  input"* and asserts nothing of the kind: its only assertions are
  `expect(sent.length).toBe(1)` and `expect(sent[0]?.jump).toBe(true)`, and the
  airborne branch is a dead comment — `// When P1v2 merges: expect(s.airborne)...`
  followed by `if (!s.airborne) { /* comment only */ }`. The dependency it
  defers to has shipped. Delete the dead branch and assert airborne for real.
- `room.test.ts:430`, `room.test.ts:729` — expected to still pass. Verify; do
  not pre-emptively rewrite. `room.test.ts:430` (the
  snapshot-matches-local-twin parity gate) failing means the peers forked:
  automatic reject.

## §12.2a Terrain amplitude — exact frozen values (rev 3)

Rev 2 said "×2.5–3.0, preserving their ratio, targeting 11–14 m". A reviewer ran
the real `genSlope`/`stepSki` at those settings. It **cannot ship**:

- `config.ts:38-41` and `slope.ts:6-13` carry a by-construction safety proof:
  the worst-case downhill undulation gradient (`0.057 + 0.057 = 0.114`) must
  stay under `GRADE_BASE - GRADE_MIN = 0.18`. At ×2.5 it becomes **0.2856**; at
  ×3.0, **0.3427**. The proof is falsified.
- The `GRADE_MIN` clamp — a safety net — then fires on **17.0%** of seed 42's
  centreline at ×2.5 and **20.5%** at ×3.0. At ×3.0 the terrain literally
  **rises on 11.7% of the run** while `gradeAt` still returns `+GRADE_MIN`: the
  skier accelerates uphill. `validateSlope` cannot detect this because it
  samples `gradeAt`, which clamps internally.
- Four named tests go red, including `sim.test.ts:1235`'s `<= 3.5 m` bound that
  §12.2 explicitly ordered kept (measured **3.514 m** at ×2.5, **3.974 m** at ×3.0).
- `KICKER_SPACING = 85` is pinned in `config.ts:105-107` with the comment
  "> max flight (~52 m at 26 m/s) so a fast skier never overshoots the next
  ramp". Max flight goes **63.1 m → 98.6 m** at ×2.5, breaking that law, and the
  `J_MAX_AIRTIME_S` emergency cap starts firing in normal play — the anti-stuck
  backstop becomes a routine event.
- "Preserving their ratio" was also internally contradictory with "put the
  largest share on the longest wavelength": `UND_LONG_1` and `UND_LONG_2`
  contribute *exactly equal* gradient today (`2.0·τ/220 == 1.0·τ/110 == 0.0571`).

**Frozen resolution — re-allocate, do not scale.** Uniform scaling caps out at
×1.576 (~7.1 m envelope); the 11 m target is reachable only by moving amplitude
onto the longest wavelength. A1 sets exactly:

| constant | HEAD | rev 3 |
|---|---|---|
| `UND_LONG_1_AMP` | 2.0 | **5.2** |
| `UND_LONG_2_AMP` | 1.0 | **0.4** |
| `UND_LAT_AMP` | 1.5 | **2.5** |

Measured at these values: **~11 m envelope** on seed 42, **0%** `GRADE_MIN`
clamping on the fall line, max kicker flight **72 m < 85 m** spacing, **zero**
airtime-cap hits, containment **3.09 / 3.23 m** (passes the 3.5 m bound).

**Hard budget A1 must satisfy:**
`UND_LONG_1_AMP·τ/UND_LONG_1_LEN + UND_LONG_2_AMP·τ/UND_LONG_2_LEN <= 0.171`.

**New gates (A5):** max kicker flight `< KICKER_SPACING`, and **zero**
`J_MAX_AIRTIME_S` cap hits across the 20-seed kicker sweep.

**W1** must re-derive the hand-tuned comments and rate budgets at
`slope.test.ts:131-133`, `:147-149` and `:201-202` from the new constants — they
were tuned to the old ones and will otherwise go red for the wrong reason.

## §12.3 VISUAL REFINEMENT — ownership

Bound by `STYLE_BIBLE_V3.md` rev 2 verbatim plus §2 RULES: flat Lambert,
meshes from `contract/visual.ts`, colours from `SPAL`, seeded RNG only,
shadows ON, no per-frame allocation.

| Task | Files (exclusive) | Body |
|---|---|---|
| **W1** | `games/splat/shared/src/slope.ts`, `slope.test.ts` | §V3.2 pre-skied carve tracks (`trackMask` only) + the raised terrain amplitude reading A1's constants. **Isolated RNG stream** (below). |
| **W2** | `games/splat/client/src/render/terrain.ts`, `terrain.test.ts` (new) | Run as **three sequential sub-waves, each gated before the next** (§12.3f). One file so it cannot be split by ownership — but it must not be one unbounded run either. |
| **W3** | `games/splat/client/src/render/plants.ts`, `plants.test.ts` (new) | §V3.4 mid-distance dressing. |
| **W4** | `games/splat/client/src/render/scene.ts`, `scene.test.ts` (new) | §V3.5 fog band, §V3.6 bloom, the airborne camera-roll gate (§12.1), the ambient floor (§12.5a.2), **and the camera-pitch re-tune (§12.3g)**. |
| **W5** | `games/splat/client/src/render/skiers.ts` | §V3.7 first-person body presence. |
| **W6** | `scripts/capture-splat-v3.mjs` | The capture harness + shot list (§12.5a). *Already delivered pre-fan-out.* |
| **A4** | `scripts/e2e-splat.mjs` | Air-lock e2e gate; draw-call assertion updated to the §12.5 number. |
| **G2** | `scripts/gen-slope-golden.mjs`, `games/splat/shared/src/__fixtures__/slope-golden.json` | **PRE-FAN-OUT, ON HEAD — must complete and be verified green BEFORE A1 starts.** Split the digest (below). |
| **INT** | `games/splat/client/src/app.ts` | Orchestrator integration only. |

**Out of scope and frozen:** `gates.ts`, `fx.ts`, `hud.ts`, `hud.css`,
`audio.ts`, `types.ts`, `palette.ts`, `valueLadder.test.ts`, and
`app.ts` *(frozen to every implementer; INT-only)*. A task that believes it
needs one **reports a contract gap and stops**.

**G2 is ordering-critical and is NOT part of the fan-out.** `canonicalSlope()`
(`gen-slope-golden.mjs:56-100`) puts the height lattice and the plant-derived
free intervals in the *same* array element, and `buildFixture()` hashes the
whole serialisation — so the 20 committed digests cannot be decomposed without
regenerating them. If G2 ran concurrently with or after A1, it would bake A1's
**raised amplitude** into its own baseline and §12.5.4's "rngDigest
byte-identical" would prove exactly nothing. **Sequence: G2 splits and
regenerates on HEAD → `--verify` green on HEAD → only then A1 fans out.**
G2 also adds a thin vitest that shells `--verify`, because nothing currently
imports the fixture (`grep -rn slope-golden` finds only the script and this
contract), so no test run would ever notice drift.

**Cut from rev 1:** sun light shafts. They required forest-gap positions that
live in W2's file with no seam to W4, and they are polish, not a headline
lever. Removed rather than shipped as a cross-task dependency.

### §12.3a The seam — reduced to ONE function

Rev 1 froze four exports. Three were unimplementable or ambiguous and are
**deleted**:

- `slopeAO` — **deleted.** It could only sample `slope.height`, but terrain
  renders `groundHeight = slope.height + skirtLift` (`terrain.ts:141-143`)
  across a 28 m skirt each side — precisely where the forest walls sit. AO on a
  surface that isn't rendered is worthless. **W2 owns all AO**, computed on the
  heightfield it actually renders.
- `corridorCenter` / `corridorHalfWidth` — **deleted.** The centreline is a
  local array inside `genSlope` (`slope.ts:303 weaveCentres`), never stored on
  `SlopeDef`; a pure `(slope, z)` version would re-run generation per vertex
  (33k times per terrain build). Worse, "corridor" means three different things
  here — see below.

W1 exports a **two-stage builder** — not a bare pure function. Rev 2 froze
`trackMask(slope, x, z)` while §12.3c mandates constructing the RNG stream
*inside* the function; terrain's vertex loop runs `129 × 257 = 33,153`
iterations, so that combination would build a fresh generator and re-draw all
6–10 curves **per vertex** — reinstating the exact 33k-per-build cost that
justified deleting `slopeAO`. Frozen shape:

```ts
/** Build the pre-skied carve-track sampler for a slope (§V3.2).
 *  The 6-10 S-curves are drawn ONCE here, from an isolated stream
 *  rng(slope.seed ^ GROOM_PHASE_SALT) (§12.3c). The returned closure is a
 *  cheap pure sampler safe to call per vertex at BUILD time (never per frame).
 *  Sampler range -1..+1: negative = trench (bias vertex colour toward
 *  snowShade), positive = spoil edge (bias toward snowLit), 0 = untracked. */
export function buildTrackMask(slope: SlopeDef): (x: number, z: number) => number
```

**Two constants move into the frozen contract**, because the tracks must sit on
the same corduroy the terrain already draws, and `shared/` cannot import from
`client/`. Rev 2 would have forced W1 to silently duplicate two module-private
values — the very "two tasks negotiating an interface not in the contract"
anti-pattern the seam reduction existed to kill. W1 exports both from
`@splat/shared`; W2 imports them and **deletes its local literals**:

```ts
export const GROOM_BAND_HALF_M = 10.08   // was terrain.ts:77 GROOM_BAND_FRAC 0.18 × SLOPE_WIDTH 56
export const GROOM_PHASE_SALT  = 0xc0a1  // was the inline literal at terrain.ts:209
```

**The call site is assigned** (rev 2 left it unowned, so the headline carve
tracks would simply never have reached the screen): **W2 calls
`buildTrackMask(slope)` once before its vertex loop and applies the sampler at
`terrain.ts:287`, biasing the vertex colour AFTER the corduroy block at
`terrain.ts:188-201`** — machine first, then people.

### §12.3b The three "corridors" — never conflate them again

| Name | Value | Source | Used for |
|---|---|---|---|
| plant-free tube | `±1.5 m` about the weave | `slope.ts:83`, `PLANT_CORRIDOR_M=3` | the guaranteed dodge lane |
| groomed band | `x = 0 ± 10.1 m` (fixed, does NOT follow the weave) | `terrain.ts:193,210`, `GROOM_BAND_FRAC=0.18` | the corduroy |
| driveable piste | `±28 m` (`SLOPE_WIDTH=56`) | `config.ts:29` | everything else |

Frozen consequences:
- **W1's carve tracks** go on the **groomed band** (`x = 0 ± 10.1 m`), keyed to
  the same `bandHalf` / `corrPhase` as the existing corduroy at
  `terrain.ts:188-201`. Tracks are drawn *over* corduroy, not instead of it.
- **W3's dressing** goes at **`|x| >= 27`**, respecting the existing
  `DRESSING_X_MIN = 24.5` law (`terrain.ts:104-106`) and stopping before the
  forest wall at `halfW + FOREST_IN = 29.5`.
- **W2's occluders** go at **`|x| >= 27`**, non-colliding.
- Rev 1 told W3 to place 900–1400 props 1.5–5.5 m from the racing line and
  plant poles 3 m apart down the fastest line. That was wrong by a factor of
  ~9 and would have destroyed the game. It is dead.

### §12.3c RNG isolation — the silent world-mover

`genSlope` runs **one sequential RNG stream** (`slope.ts:237 const next =
rng(seed)`) consumed in order by phi1/phi2/phi3 → `weaveCentres` → the plant
Poisson scatter → gates → kickers. **Any new `next()` draw inserted anywhere
relocates the entire world**, silently breaking `room.test.ts:590/613/650` and
e2e checks 9b/10/11a, which are pinned to the exact geometry of `genSlope(42)`.

**Frozen law:** `trackMask` and any new randomness MUST derive from its own
stream, `rng(slope.seed ^ <fixed constant>)`, constructed inside the function.
W1 may not add, remove or reorder a single call to `genSlope`'s `next()`
stream, nor modify `weaveCentres`, the plant loop, the gate loop or the kicker
loop. The repo's own precedent: `terrain.ts:209`
`rngRange(rng(slope.seed ^ 0xc0a1), 0, TAU)` — "one phase draw makes the
corduroy stable per mountain without touching the gameplay scatter streams."

### §12.3f W2's three sub-waves (rev 3)

`terrain.ts` is 1115 lines and the largest file in the game. Rev 2 handed one
agent: an AO replacement, a bug fix, three occluder archetypes, flanking ridges
(which means rewriting `skirtLift` at `terrain.ts:133-138`, therefore
`groundHeight` at `:141-143`, therefore the vertex normals at `:252-257`, the AO
stencil at `:269-273`, and the grounding height of every dressing prop),
contact-AO stamps, the `FOREST_MAX` cut, and a new test file. That is a
structural refactor bundled with five feature additions.

**Run it as three specs, gated in order.** The same agent may carry all three,
but it must not start the next until the previous is green:

- **W2a — vertex colour only.** Replace `curvatureAO`/`forestAO`
  (`terrain.ts:266-283`) with the two-radius version; raise `AO_MAX` 0.12 → 0.22;
  **fix the inverted edge term**; consume W1's `buildTrackMask` sampler at
  `:287`. Write `terrain.test.ts`.
  *Gate:* the piste centre is not darker than the piste edge; splat units green.
- **W2b — build-order inversion + contact AO.** `terrain.ts:1085-1094` builds
  `slopeMesh` FIRST and only then `forest/banks/rocks/…`, so stamping prop
  footprints into terrain vertex colours requires computing every prop position
  *before* the slope mesh is built. This inversion is a refactor with no visual
  payload of its own — do it as its own step.
  *Gate:* e2e checks 7 and 18 unchanged; draw calls unchanged.
- **W2c — occluders, flanking ridges, `FOREST_MAX`.**
  *Gate:* draw-call delta ≤ +3; every occluder bounding box `|x| >= 28.5`;
  instance total ≤ 3000.

### §12.3g Camera pitch vs the raised terrain (W4, rev 3)

Camera pitch is derived from terrain, not fixed: `scene.ts:346`
`pitchTarget = atan2(slope.height(aheadX, aheadZ) - y, LOOK_AHEAD)` with
`LOOK_AHEAD = 14` (`scene.ts:76`) and `PITCH_EASE = 7` (`:77`). Today the
fall-line gradient spans `0.146..0.374` → pitch `-8.3°..-20.5°`. Under §12.2a's
raised relief the swing widens materially and the camera can pitch **up** over
crests, breaking the promise documented at `scene.ts:330-332` that "the horizon
holds near the vertical third-line".

**W4 re-tunes `LOOK_AHEAD` / `PITCH_EASE` against the new relief and reports the
before/after pitch envelope.** `scene.test.ts` bounds `|pitch|` over a sampled
traverse of seed 42. Without this, round-1 captures are framed differently from
round 0 for reasons that have nothing to do with the art, and the judge scores
noise.

### §12.3d Material exemptions — §2.5 amended for V3

`contract/visual.ts:29-39` returns a cached **opaque** `MeshLambertMaterial`
and must never grow parameters. §2.5's exemption list is therefore extended,
for V3 only, colours still from SPAL:

- The §V3.5 fog band may use `MeshBasicMaterial` with `transparent`,
  `AdditiveBlending`, `depthWrite:false`, `fog:false`.
- The §V3.6 bloom stage may use `ShaderMaterial` + `WebGLRenderTarget`.

**Precedent to clone:** `scene.ts:760-800` already builds three fullscreen
`ShaderMaterial` quads (grade / vignette / hit-flash) with `transparent:true`,
`depthTest:false`, `depthWrite:false`.

### §12.3e Budgets — raised, allocated, and individually gateable

Rev 1 froze `< 80` against a measured baseline of 76. All three reviewers
independently computed v3's cost at +19 to +39. `< 80` was unmeetable.

**Draw calls: `< 100`.** Measured on **page A during racing in the seed-42
two-player room — the identical condition as e2e-splat check 7**, so it is
comparable to the recorded 76. Per-task allowances, each self-verified:

| Task | Allowance | Required discipline |
|---|---|---|
| W1 | +0 | vertex data only |
| W2 | ≤ **+3** | occluder geometry merges into existing `bake()` material groups; the +3 buys the **shadow-casting** occluder group (see below) |
| W3 | ≤ +7 | ≤3 InstancedMeshes, **`castShadow = false`** (a shadow caster costs two calls — `terrain.ts:1104`) |
| W4 | ≤ **+9** | fog band = ONE merged mesh; bloom ≤ 4 passes; **fold the 3 existing post quads into the bloom composite (reclaims −2)** |
| W5 | ≤ +4 | hands+poles ≤2 meshes per side; camera-space, no shadow cost |

76 + 23 = 99. Each visual task reports its own measured delta so an overrun is
attributable, not discovered at integration.

**Why W2 moved from +0 to +3 (rev 3).** §V3.1 mandates "every occluder casts a
shadow onto the piste… the single highest-value shadow in the game". That is
flatly unsatisfiable at +0: `terrain.ts:1104-1113` *deliberately* sets
`castShadow = false` on every decorative dressing group precisely to hold the
old budget. So occluders either inherit that and cast nothing, or they cost a
second draw call each. Only the pine-cluster archetype has a free path (extra
instances in the already-casting forest `InstancedMesh`, `terrain.ts:559-560`).
The +3 buys casting for the rock buttress and cornice masses — the ones §V3.1
calls the darkest thing in the frame. It is taken out of W4's allowance, so the
total is unchanged.

**Instances — and a correction on the funding currency.** `FOREST_MAX`
(`terrain.ts:63`) caps **instances inside two existing `InstancedMesh`es**
(`terrain.ts:549, 694`). An InstancedMesh is **one draw call at 2800 or at
1900**, so cutting it frees **zero draw calls**. Rev 2 used that cut to fund
both W2's draw-call allowance *and* W3's instances — one resource claimed twice,
once in the wrong unit. **Frozen: the `FOREST_MAX` 2800 → 1900 cut is W3's
INSTANCE funding only.** `1900 + ~150 plants + ~900 dressing ≈ 2950 <= 3000`.

### RESOLVED (post-build, orchestrator decision): restore `FOREST_MAX` to 2800

The forest thinning **was** the density regression. Measured evidence:

- The forest is **3 `InstancedMesh`es at 1900 or at 2800** — instances cost
  **zero** extra draw calls. Restoring 2800 moves draw calls 86 → 86.
- The v3 trade swapped ~900 **full-height pines** out of what
  `terrain.ts:13-17` calls "the rails that make the piste corridor read at
  60 km/h", and replaced them with ~900 **sub-metre-to-3 m props** in a 2.5 m
  band. On silhouette area that is a large net loss.
- The blind judge scored world density **3/10** across both rounds.

**Frozen change: `FOREST_MAX` returns to 2800, and the instance ceiling is
raised from 3000 to 4000.** Worst case becomes ~3919 (forest 2800 + edge pines
≤5 + dressing ≤900 + plants ≤214, the last swept over 400 seeds). The 3000
figure was inherited from §8 and is **not** a hardware limit — it was never
justified as one, and the thing it was protecting (draw calls) is provably
unaffected. The real budget that matters, draw calls < 100, is untouched at 86.

This is the single highest-value, near-zero-cost fix available: it directly
addresses the lowest-scoring axis for no measured cost.

⚠️ **Superseded note — W2 was asked to report whether the thinning visibly
weakened the corridor read.** `terrain.ts:13-17` calls the forest walls "the rails that make the piste
corridor read at 60 km/h", and thinning them 32% cuts the very occlusion V3 is
chasing. If it reads worse, say so — the 3000 ceiling is not justified anywhere
as a hardware limit and raising it is the orchestrator's call.

**Colours: no new `SPAL` key is required.** Every colour §V3 names already
exists (`palette.ts:9-38`). The key name **`fog` is FORBIDDEN** —
`valueLadder.test.ts:95` asserts `'fog' in SPAL === false`. The fog band tints
toward `skyHorizon` / `paper`.

## §12.4 Gates — air lock + terrain amplitude

Every gate runs **after a clean rebuild**. `dist/` artifacts are not evidence:
`platform/server/dist/server.js` currently bakes `J_AIR_STEER_MUL = 0.35`.

1. **Determinism (A3):** identical `(steer, dt, jump)` streams → bit-identical
   sims across two replays, with airborne segments present.
2. **Air lock is total (A3):** from an identical launch state, replaying with
   `steer` held `0`, `+1`, `-1` for the whole airborne segment gives
   bit-identical position, yaw and velocity **at every airborne step**, not
   merely at landing. (Rev 1's landing-only form was satisfied by A1's config
   edit alone and never tested A2.)
3. **Heading is frozen (A3) — THE GATE THAT TESTS A2.** Yaw at landing === yaw
   at launch, for a flight constructed to stay out of `EDGE_ZONE`, and
   **launched with `|yaw| > YAW_MAX` (1.35 rad)**.
   The `|yaw| > YAW_MAX` requirement is not optional: A2's only change is
   suspending the `±YAW_MAX` spring, and that spring **only fires beyond
   YAW_MAX**. Below it, A2's change is a no-op and every gate passes whether or
   not A2 was done at all — which is precisely how rev 1 and rev 2 both shipped
   A2 completely ungated. Note this is the realistic case, not a corner:
   `sim.ts:44-50` records the full-lock yaw equilibrium at **~1.574 rad**, so
   real full-lock launches are always the `> YAW_MAX` case.
   **This gate must FAIL against HEAD and pass after A2.** If it passes on HEAD,
   it is not testing anything — report that rather than accepting it.
4. **Control returns (A3):** on the first grounded step after landing, a
   non-zero steer changes yaw by the normal grounded amount.
5. **Edge-zone flight (A3) — gated on DELTA vs HEAD, not an absolute.**
   A flight launched at `x = ±(width/2 - EDGE_ZONE + 2)` with `yaw = ±0.9`:
   assert yaw moves *only* by the soft-edge term, and assert the max excursion
   beyond the piste edge **does not regress against the same scenario measured
   on HEAD**, tolerance +0.15 m.

   **Rev 2 froze `<= 3.5 m` here and that was wrong — measured 5.5–6.1 m under
   rev 2's own semantics, i.e. red by construction.** The 3.5 m figure belongs
   to `sim.test.ts:1235`'s *milder* scenario (a mid-piste hop), which measures
   **3.315 m on HEAD and 3.315 m under air lock** — unchanged. Air lock is
   containment-**neutral**, not an improvement; rev 2's claim that it improves
   containment came from an analytic replica, not the real sim, and is
   withdrawn.

   **A3 must therefore first measure this scenario on HEAD and record the
   number**, then assert no-regression against it. Do not invent a bound.
6. **Grounded is untouched (A3):** the `±YAW_MAX` spring still fires on the
   first grounded step; a full-lock grounded skier's yaw equilibrium is
   unchanged from HEAD.
7. **The 4-year-old sweep (A5), now covering BOTH changes:** full-lock both
   directions, **20 seeds, with kickers, on the raised-amplitude terrain** —
   always lands, never stuck, contained `<= 3.5 m`, always finishes.
   **A5 MUST import and call the real `stepSki` and the real `genSlope`.**
   Copying or re-deriving sim logic into the prototype is an automatic reject —
   the entire point is that it measures shipped code. (`prototype-v2.mts`
   hand-rolled its own `stepSkiV2`; do not repeat that.)
   Make this a **vitest suite**, not a script, so it runs in CI.
8. **E2E (A4):** `setJump()` → airborne → land; a full-lock run with kickers
   finishes; snapshot ≤ 2 KB at 8 players; draw calls `< 100`.

## §12.5 Gates — visual

1. **Captures at 1280×720 minimum**, shadows and full post stack ON. Judging a
   downscaled render is banned (v2 judged 640×360 and invalidated itself). If
   720p wedges under software rasterization, W6 reports it as a blocking
   finding; the orchestrator decides. No silent downscale.
2. **Draw calls `< 100`** under §12.3e's pinned measurement condition. The
   **same number** appears in §12.4 gate 8 so A4 and W2–W5 cannot diverge.
3. **Palette purity is reviewer-enforced, NOT mechanically gated.**
   `valueLadder.test.ts` imports only `{SPAL, SKIER_COLORS, MAX_PLAYERS}` and
   validates the palette *object* — it has no `fs`, no glob, no source regex,
   and cannot detect a hardcoded hex in `plants.ts`. Rev 1 claimed it could.
   It is a review lens; do not mistake it for a green light.
4. **Gameplay invariance, mechanically:** `npx tsx scripts/gen-slope-golden.mjs
   --verify` must show the **`rngDigest` byte-identical** for all 20 seeds —
   every plant `x,z`, gate `x,z`, kicker `x,z` unchanged. The `heightDigest`
   **will** change (approved amplitude) and must be re-baselined *with the
   diff explained*. G2 splits the existing single digest to make this
   expressible.
5. **Per-task unit gates.** No splat test currently imports any `render/*`
   file, so "the suite passes unchanged" proves nothing about W2–W4. Each owns
   a new `*.test.ts` asserting its own mesh/instance/draw-call counts and
   vertex-colour ranges. W3's must assert every dressing instance sits at
   `|x| >= 27` and is disjoint from `slope.plants`, on ≥10 seeds.
6. **Known CI hazard for W4:** e2e check 18 asserts zero console errors; new
   `ShaderMaterial` programs can emit shader-link warnings at error level under
   SwiftShader.

## §12.5a The shot list (frozen — W6 implements literally, judges consume literally)

Seed pinned at **42** so every round captures the same slope. Round 0 is
captured on **HEAD, before fan-out**.

| Shot | Page | Wait predicate | Primary pairing (FP snow) | Anchor (LMD) |
|---|---|---|---|---|
| `v3-wide-vista.png` | A | `z∈[60,90]`, `v>15`, steer 0 | `pov-wide-1.jpg` | `wide-1` |
| `v3-descent.png` | A | `z∈[250,300]`, `v>20` | `pov-speed-1.jpg` | `wide-2` |
| `v3-veg-margin.png` | A | `z∈[150,200]` | `pov-trees-1.jpg` | `veg-1` |
| `v3-forest-wall.png` | A | `z∈[330,380]`, **`v > 18`**, `\|x\|∈[14,20]` — ON the piste looking ACROSS at the wall | `pov-trees-2.jpg` | `veg-2` |
| `v3-atmosphere.png` | A | `z∈[400,500]`, **`v > 18`, `\|x\| < 12`** — on the piste, long sightline | `mood-alt-1.jpg` | — |
| `v3-air.png` | A | `airborne===true`, peak `airH` | `pov-air-1.jpg` | — |
| `v3-body-pov.png` | A | `\|steer\|===1`, `v>18` | `pov-wide-2.jpg` | — |
| `v3-finish.png` | A | `z>760` | — | `finish-1` |
| `v3-hud-ipad.png` | iPad C | `phase==='racing'` | `hud-1.jpg`, `hud-2.jpg` | — |
| `v3-results.png` | A | `phase==='results'` | — | rubric only |

FP snow set: `judge/reference-fp-snow/` — 9 verified 1920×1080 in-engine POV
frames from **Steep** and **SNOW**. `pov-air-1.jpg` is the set's weakest match
(a lit jump feature at dusk, not a confirmed apex) and is flagged to judges.

### §12.5a.1 Frame-validity gate (added after round 0 shipped a black frame)

Round 0 produced a **near-black `v3-forest-wall.png`** and the harness reported
it GREEN: the skier had stalled off-piste (`v=8.2`, yaw pinned) and the camera
ended up *inside* the forest wall. A judge would have scored it as a real
frame. File-size and non-blankness checks did not catch it because a black PNG
is neither empty nor small.

**W6 must assert, per shot, and fail loudly on violation:**
1. **Mean luminance ∈ [0.10, 0.92].** A frame darker than 0.10 means the camera
   is inside geometry; brighter than 0.92 means a blown-out white-out.
2. **Luminance standard deviation > 0.04** — rejects a flat single-value frame.
3. **The sky is visible:** the top 15% of the frame contains pixels above 0.5
   luma. Every shot in the list is an outdoor downhill frame; if no sky is
   present the camera is buried.
4. **`v` at capture is within the shot's stated predicate** — a stalled skier
   is not a gameplay frame.

These are *capture-validity* checks, not aesthetic ones. A shot that fails them
is re-driven, not accepted and judged.

**Round-0 measured results (mean luma, 0–1), so later rounds are comparable:**

| shot | mean luma | verdict |
|---|---|---|
| `v3-forest-wall.png` | **0.102** | INVALID — camera inside the forest wall |
| `v3-atmosphere.png` | **0.306** | INVALID — camera clipping through a pine |
| the other 8 | 0.55 – 0.60 | valid |

Both invalid frames share one cause: **the camera has no collision and no
near-plane push-out**, so a skier who wanders off-piste drives the eye straight
through tree geometry. This is pre-existing, not introduced by V3, and it is
NOT in scope to fix — but it means capture must keep the skier on the piste
(hence the corrected predicates above), and §V3.1 occluders are pushed out to
`|x| >= 30` so nothing a player can reach is ever flown through.

### §12.5a.2 The ambient-floor finding (routed to W4)

The near-black frame also exposes a real lighting defect: the scene has **one
directional sun + one hemisphere light and no ambient floor**, so anywhere the
sun does not reach — inside the forest wall, and the shadow side of any §V3.1
occluder — collapses toward black. Since V3 deliberately adds large occluding
masses that cast long shadows, this defect is about to get much more visible.

**W4 must raise the shadow-side floor** so that fully-shadowed geometry still
reads as *blue snow-bounce shade*, never black — consistent with §V1's law that
shadows on snow are BLUE, never grey (and certainly never black). Lift the
hemisphere ground-bounce term and/or add a low ambient in `snowShade`. **W4's
gate: no pixel region of a shadowed-but-outdoor frame falls below 0.10 luma.**

## §12.6 The judge loop — bounded at 2 rounds per aspect (owner-set)

- **Diagnostic:** the 6-axis art-director rubric, per shot.
- **Pass/fail:** blind unlabeled A/B, build vs the **FP snow** pairing.
- **Pass bar, per pair:** the build wins, or gap ≤ 1 with substantive axes
  split, and the critic's free text reads as genuine admiration. "Decent" and
  "good for a generated game" are failing grades.
- **Explicit FAIL state:** gap ≥ 4 after round 2 is a **FAILED aspect**,
  reported as FAILED — never dressed up as a bounded exit.
- **Structural handicap, recorded before the loop runs:** LMD is third-person,
  high-chroma and snow-free; any pairing against it structurally penalises a
  first-person snow shot regardless of execution. LMD pairs are scored on
  occlusion / depth-layering / atmospheric separation **only**.
- **A shot with no pairing is scored on the rubric alone and reported as
  UNJUDGED-BLIND** — never as a pass.
- **Mandatory record:** per-shot, per-axis scores for rounds 0/1/2 written to
  `docs/splat-v3/judge-rounds.md`. Without round 0 on HEAD, "we moved the
  number" is unfalsifiable.

## §12.7 Baseline — measured, not asserted

Run directly (never through `rtk`, which truncates and reports false greens):

| Gate | Result on HEAD |
|---|---|
| `npm run typecheck` (20 workspaces) | **exit 0** |
| `npm run build` | **exit 0** |
| `npx vitest run games/splat` | **exit 0 — 197/197, 7 files** |
| `E2E_SKIP_BUILD=1 node scripts/e2e-splat.mjs` | **exit 0 — 22/22, 0 page errors, max drawCalls 76**, full-lock 4-year-old run finished (88.9 s sim, 0 plant hits) |
| `npm test` (repo) | 5 failures, **all** in `games/rift/server/src/balance.test.ts` (unrelated) |
| lint | no linter exists in this repo |

**The splat surface has ZERO pre-existing failures. Any red gate in this pass
is OURS.** Only failures outside `games/splat`, `platform`, and
`scripts/e2e-splat.mjs` may be called pre-existing, and only with a command and
exit code quoted. No task may make a failing test pass by weakening it.
