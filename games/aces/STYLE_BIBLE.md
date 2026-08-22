# STYLE BIBLE — ACES

**Status: FROZEN** alongside CONTRACT.md. Embedded in every visual
implementer's brief. Contradictions stop-and-report; nobody reinterprets it
locally. All color traces to `APAL` (`shared/src/palette.ts`); ad-hoc hex is
a contract violation reviewers file without discussion.

---

## §0 The benchmark

**Luftrausers (Vlambeer).** The shipped commercial gold standard for a 2D
dogfighter with total art-direction conviction. Every capture this build
produces goes before a harsh, context-free judge as an unlabeled A/B against
a Luftrausers screenshot of the same shot type (duel mid-air, explosion,
cloud layer, HUD-on frame). Bar: **wins or ties**. "Good for a browser game"
fails. Reference shots live in `judge/reference-aces/`.

What we chase from Luftrausers, in priority order:

1. **Total palette conviction.** One mood, zero exceptions, every pixel.
   Luftrausers commits to one sepia and wins on commitment alone.
2. **Silhouette-first machines.** Planes read as *shapes*, not textures.
3. **FX with weight.** Tracers, smoke and blasts feel physical because they
   obey one consistent scale and gravity of ink.
4. **A world that breathes at the edges** — clouds, glare, surf — while the
   center stays readable.

What we do **not** chase: monochrome (our two-team read needs hue),
photoreal anything, sprite/pixel aesthetics. We draw clean vector ink on
paper, and we win on composition and light.

---

## §1 Mood

**1917, first light over a cold strait.** The war is elsewhere; here it is
two squadrons and the gulls. Warm paper sky, cold green sea, islands like
torn paper, long haze bands where the sun has not yet burned through. The
world is muted and calm — **the only loud things in any frame are the two
team colors and the tracer amber.** That restraint IS the art direction:
gameplay elements are brighter and more saturated than everything under them,
always.

Touchstones: WWI aviation propaganda posters (flat ink, cream paper, bold
simple marks); the quiet sea paintings of the war-marine tradition;
Luftrausers' single-mindedness; Sky Rogue's toy-soldier clarity.

## §2 Material model — FLAT INK ON PAPER (no mixing)

- Everything is flat filled vector shapes with **at most one highlight tone
  and one shadow tone per object**, both derived from its base via `shadeA`.
- **No gradients except:** sky banding (dawnHi→dawnLo, painted as 3–4 hard-ish
  stops, not smooth ramps), and the shared `softPuff` radial for clouds/smoke/
  blast cores. Nothing else may use `createLinearGradient`/
  `createRadialGradient`. Reviewers grep for it.
- **One global film-grain pass** (`applyGrain`, ≤0.05 alpha) plus a fixed
  vignette unify every frame into "one printed page."
- Outlines: aircraft carry a hairline ink outline (`APAL.ink` at ~55% alpha)
  so they sit ON the world rather than IN it. Terrain carries none.

## §3 Lighting recipe

Single low sun from screen-west (fixed, never moves): warm `sunGlare` disc +
haze wash rendered as a WEST MAP-EDGE glow treatment inside the top-down view
(there is no horizon line anywhere — this is a map-view air war); every
object gets its ONE highlight tone on the west-facing side, shadow tone east
— implemented as static two-tone fills per shape (cheap, consistent). Cloud
shadows drift on the sea as soft dark blobs (`seaDark`, alpha ≤0.25) — they
sell altitude and time of day simultaneously. No dynamic light sources
anywhere; explosions do NOT light the scene, they replace it for 3 frames
(flash bloom).

### Color bindings (bible words → APAL keys — no guessing allowed)

| bible word | APAL key(s) |
|---|---|
| clouds / cloud puffs | `paper` ↔ `dawnHi` mix, alpha ≤0.78 |
| sun glint / sparkle core | `sunGlare` |
| "white-hot" hit spark | `flash` |
| smoke (light/heavy) | `smokeLt` / `smokeDk` |
| fire | `fireCore` + `fireEdge` rim |
| blast bloom | `blast` → `flash` core |
| debris / ink chips | `debris`, outlines `ink` |
| crate canopy (neutral) | `dope` with `wood` ropes |
| gulls / vignette / grain | `ink` |
| HUD paper chips | `paper` at alpha over `ink` type |

## §4 Camera & framing

Top-down, slight chase: camera leads velocity by CAMERA.LOOKAHEAD_S; zoom
eases CAMERA.ZOOM_MAX (1.15, idle) → CAMERA.ZOOM_MIN (1.14, full throttle) —
close enough that airframe silhouettes and marks read at rest, wide enough
to keep context at speed. The horizon never appears. Framing law for
captures: at least two planes in frame when possible, cloud layer visibly
overlapping something, no more than ~45% open empty water. Hero close-ups
for judging may zoom further via the debug surface.

## §5 Silhouette language (part budgets = distinct drawn shapes)

Airframes are drawn 30–40 u long (scout smallest, gunship largest); at
CAMERA.ZOOM_MAX that is ≈35–46 px on screen — silhouettes and marks must
read there AND survive CAMERA.ZOOM_MIN at full throttle. Each airframe must
be identifiable in pure black silhouette:

- **SCOUT** — stubby equal-stagger biplane, round cowling, single-seat hump,
  high rudder. Reads: small + nose-heavy + busy tail. Budget 10–14 parts.
- **FIGHTER** — larger equal-span biplane, straight twin MG muzzles breaking
  the cowl line, tapered fuselage deck. Reads: classic duelist. Budget 12–18.
- **GUNSHIP** — wide triple-wing stack (one mid wing set far forward), deep
  slab fuselage, twin rudders. Reads: wide + slow + armored. Budget 16–22.
- Team marks double-encode identity: ROYAL = navy airframe + deck-cream
  ROUNDEL ring mid-wing; IRON = crimson airframe + near-black BAR-CROSS.
  Mark shapes are geometric, invented, non-historical insignia.

## §6 World population (density targets, seeded)

- Sea: base value mottling patches (≥3 tones from seaDeep/seaLit/seaDark,
  soft irregular forms — NEVER visible rectangles), animated glint streaks
  in a sunward band, surf ring pulsing at every island rim (foam, alpha
  oscillation).
- Islands: 6 per map, each sand ring → scrub fill → 3–6 palm clusters →
  1–3 rock outcrops; palm clusters get seeded scale/rotation variation; no
  two adjacent palms identical (variation law: scale ±30%, rotation full).
- Clouds above: two parallax layers of soft puffs (`paper`↔`dawnHi`, alpha
  ≤0.78); coverage ≤35% of viewport; slow steady drift east; thinned over the
  central corridor so head-on duels are never hidden.
- Airfields: simple graded strip + team-marked wind square + 2 parked
  reserve crates; they are landmarks, not sets — keep them quiet.

## §7 FX & game feel (every event answers in ink)

- **Tracers:** amber core, short warm tail, fired in pairs/quads with real
  spread; muzzle flash same frame as trigger (latency budget).
- **Hits:** white-hot spark tick + tiny ink chip; hit marker × on YOUR hits.
- **Smoke trail:** heavy gray-brown puffs below SMOKE_BELOW, growing and
  drifting downwind; fire adds flickering orange-red embers below FIRE_BELOW.
- **Death:** 3-frame flash bloom → 8–14 tumbling debris shards (ink) →
  lingering smoke column → foam-ring splash if over open water. Screen shake
  scaled by proximity; large shake only for your own death.
- **Crates:** parachute descent (canopy = deck cream), landing puff, pickup
  sparkle + chime.
- Ambient life: gull pair silhouettes crossing rarely (pure flavor, ≤2 on
  screen, never near fights), glint shimmer, surf pulse, cloud drift.
  **A still frame must still look alive.**

## §8 UI look — "operations room paperwork"

HUD = ink stamps and typewritten labels on translucent paper chips pinned
over the sky. HP/boost cluster bottom-left with needle gauge; ticket bars
top-center flanked by team names in small caps; kill feed top-right as
paper slips that slide in and fade; scoreboard Tab = two-column flight
roster with a hand-drawn MVP star; respawn class cards look like requisition
forms (name, stat strips, big numeral hotkeys 1–3). Menu/end screens are
full propaganda posters: big condensed type on paper, team-color accent bar,
no photographs. Minimum 14 px type at 1080p; every state exists as a designed
screen — menu / connecting / LOBBY-COUNTDOWN (roster + "first patrol launches
in N") / live / dead+class-picker / end / disconnect.

## §9 Hard bans

- Ad-hoc hex literals anywhere under `games/aces/client`.
- `Math.random()` anywhere under `games/aces/`.
- Gradients outside sky-band stops and `softPuff`.
- Image/font assets, network-fetched resources.
- Per-frame allocation in render/sim hot paths; unbounded particle growth.
- Disabling grain/vignette/clouds/shadows "for test performance" — capture at
  reduced resolution instead.
- Photoreal gradients, drop-shadowed "gamer" HUD chrome, emoji anywhere.
