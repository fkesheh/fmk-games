// ============================================================================
// C3 — map renderer: MapDef (pure data) => baked static geometry + solids.
// Ground slab, skyline backdrop + cloud bands, BoxDefs rendered as RICH boxes,
// seeded floor life + ceiling light panels,
// and seeded deco prop scatter — everything static is merged by bake() into
// one mesh per material (< 60 draw calls per map).
//
// VISUAL_UPGRADE.md §3b/§3c pass — the value ladder is expressed in GEOMETRY:
//   - WALL ARTICULATION (§3b): every box whose long axis clears 3 m calls the
//     frozen `articulate()` for a `…Deep` plinth, a `…Lit` cornice, alternating
//     pilasters and (above 4 m) a mid rail. Ladder partners come ONLY from
//     MAT_COLORS / TRIM_MAT / DARK_MAT / CONTACT_MAT; those tables return null
//     at the ends of a ladder and the element is then skipped, never faked.
//     On top of that this file adds a `…Lit` bead over the plinth, a `…Deep`
//     soffit under the cornice and `…Dark` panel seams: 8-20 prims per wall,
//     all merged by bake(), so the whole lot costs draw calls nothing.
//   - OPENINGS (§3b): door/window gaps between collinear same-material walls
//     are detected from the BoxDefs and get a reveal frame (two jambs + a head)
//     in the trim tier.
//   - PROP CONTACT SHADOWS (§1 L2b): every scattered prop gets a `contactShadow()`
//     disc. This round's entire replacement for AO — without one props float.
//     Baked into their own group so they never cast a shadow of their own.
//   - PROP DENSITY/DETAIL (§3c + §10): EVERY DecoKind builder lands in the
//     8-16 prim budget with a three-tier value break (`…Lit` sun-hit detail /
//     base body / `…Deep` contact band) — not just the crate/barrel/pallet
//     trio. Rocks get facets and a base skirt, chairs get caster arms and
//     cushions, coolers get spigots and a drip tray, sacks and paper piles get
//     banding, sandbags get a ground pad and sun-hit crests, and so on. Deco
//     counts are scaled up per §3c on top of that.
//   - NO SKY DOME (§1 S3 — this is where the "floating diamonds" actually came
//     from). There used to be a SECOND dome here: a raw r=400 SphereGeometry with
//     a 2-stop vertex gradient, added on top of the rig's own opaque r=395 shader
//     dome (scene.ts). The rig dome is re-centred on the CAMERA every frame; this
//     one sat at the world origin. The moment the player walked away from the
//     centre the two spheres INTERPENETRATED — the origin-centred one poked
//     through on the near side at 400-|p| < 395 — and the r=400 dome's 24x12
//     facets showed through the rig dome in pale, hard-edged, corner-on patches:
//     the diamonds and wedges in screenshots/v2/fps-{dustbowl,crossfire}-a.png.
//     They tracked the CAMERA, not the world, which is why retuning every map's
//     SkylineDef never touched them. Verified by capture: with this dome removed
//     and the skyline ring untouched, the sky is clean. §7 seam rule 1 gives F8
//     exactly this choice ("either delete the now-covered makeSkyDome() or leave
//     it strictly alone"); it is deleted, and the rig now owns the sky outright.
//   - SKYLINE (§3c + §1 S3): TWO depth tiers — a near ring in full value and a far
//     ring pushed out and faded toward the fog with `mix()` (atmospheric
//     perspective is free depth; both mix endpoints stay palette entries, §0
//     rule 7). The ring is generated in ANGLE space so that landmark height is a
//     function of landmark distance and neighbours always overlap — see
//     buildSkyline() for why that makes a floating tip impossible.
//   - CLOUDS (§3c): two layered bands of flattened, clustered, horizon-hugging
//     blocks, the far band faded toward the fog. Never cast or receive shadows.
//   - BOX ALBEDO IS THE PALETTE, EXACTLY (§1 + §0 rule 7): a box body is
//     MAT_COLORS[mat] with no derived tint. The old per-box albedo jitter
//     multiplied the BODY while articulate()'s trim/plinth stayed on the
//     unjittered table, so a +5% body ate the >= 8 L* trim lift L3 requires on
//     4 of the 5 main wall families (sand 6.9, plaster 5.8, brick 7.9, snow
//     4.7) — and shade() emitted an untraceable non-palette hex besides.
//     Variety now comes from GEOMETRY (§3b articulation), which is free.
//     Sun-kissed cap slabs are the `…Lit` trim tier, or nothing where the
//     ladder has no tier above (same null discipline as articulate()).
//   - floor life: seeded patchwork tint zones + darker wear lanes running
//     T spawn -> CT spawn (and two offset lanes), plus trampled spawn courts
//   - indoor maps (big overhead slabs) get seeded ceiling light panels:
//     metalDark frame + emissive glow plate (warm paper, some cool screenGlow,
//     ~15% dead dark fixtures) with a soft floor pool quad under each lit panel
//   - per-map data extras: `skyline` (silhouette mesa ring beyond the walls)
//     and `accents` (one deliberate accent color repeated: gates, painted
//     plates, tarps, hazard strips, whiteboards, wayfinding)
//
// Visual layers NEVER extend the collision solids: solids come from BoxDefs
// unchanged (boxToAABB); caps sit flush with the box top, strips protrude
// <= 3cm (decorative ledges, non-collidable).
// Determinism: all scatter/jitter comes from rng(decoSeed(map.id, salt));
// Math.random is never touched. Props are client-only dressing: non-collidable,
// never inside solids (AABB inflated 0.5m) or within 2.5m of any spawn.
// ============================================================================
import * as THREE from 'three';
import {
  PALETTE,
  boxToAABB,
  decoSeed,
  rng,
  rngInt,
  rngRange,
  type AABB,
  type BoxDef,
  type DecoKind,
  type MapDef,
  type MatId,
} from '@fps/shared';
import { mix } from '@platform/shared';
import {
  CONTACT_Y,
  COPLANAR_EPS,
  articulate,
  at,
  bake,
  box,
  cone,
  contactShadow,
  cyl,
  sphere,
  type ArticulateColors,
} from '../contract/visual.js';

// ---- MatId -> PALETTE ---------------------------------------------------------
// The mapping now lives in the shared contract (@fps/shared/matColors.ts) so
// map authors and the renderer never contend for this file. Imported for local
// use AND re-exported for existing importers (effects.ts). DO NOT redefine it.
import { CONTACT_MAT, DARK_MAT, MAT_COLORS, TRIM_MAT } from '@fps/shared';

// MAT_COLORS is used locally below; the rest are pure re-exports so that
// downstream client modules (effects.ts) and F8's articulate() call sites can
// reach the whole ladder-partner set from one place.
export { MAT_COLORS, CONTACT_MAT, TRIM_MAT, DARK_MAT };

// ---- scatter tuning (frozen by CONTRACT/C3 spec) ------------------------------
const SOLID_PAD = 0.5; // solids inflated by this when rejecting prop points
const FLOOR_OCCUPIED_Y = 1.2; // a solid whose underside is above this is walk-under
const SPAWN_CLEARANCE = 2.5; // min prop distance to any spawn
const MAX_ATTEMPTS_PER_PROP = 30; // termination cap for rejection sampling

// ---- richness tuning ----------------------------------------------------------
// rng stream salts (deco zones use salts 0..zoneCount-1; these stay clear)
// (1000 was the retired per-box albedo-jitter stream — see buildRichBox)
const SALT_FLOOR = 2000;
const SALT_LIGHT = 3000;
const SALT_SKYLINE = 4000;
const SALT_DESK = 5000;
const SALT_CLOUD = 6000;

// NO PER-BOX ALBEDO JITTER. Any multiplier on the body while the ladder tables
// stay put shrinks the very deltas §1 L2a/L3 measure: at the old +5% bucket the
// on-screen trim lift fell to 6.9 (sand), 5.8 (plaster), 7.9 (brick) and 4.7
// (snow) L* — below the >= 8 floor on 4 of the 5 main wall families — because
// `articulate()` is fed the UNJITTERED MAT_COLORS partners. A jittered body is
// also an ad-hoc hex (§0 rule 7 sanctions only mix()/composite()). Box bodies
// are therefore the exact palette entry, and variety is carried by §3b geometry.
const CAP_H = 0.035; // top cap slab thickness (flush with the box top)
const CAP_OUT = 0.02; // cap lateral outset (reads as a sunlit rim, hides seam)
const SKIRT_H = 0.14; // floor-level skirting band height
const SKIRT_OUT = 0.024;
const TRIM_H = 0.15; // wall-top trim band height (sits just under the cap)
const TRIM_OUT = 0.028;
const OVERHEAD_BOTTOM = 2.0; // boxes starting above this are "overhead" (plain)

const PATCH_FACTORS = [0.86, 0.93, 1.06] as const; // floor patchwork tints
const WEAR_FACTOR = 0.85; // trampled lane darkening (subtle, read at a glance)
const WEAR_TOP_Y = -0.0008; // overlays stack: patches < courts < lanes < feet(0)

// ---- wall articulation (VISUAL_UPGRADE.md §3b) ----------------------------------
// The old ad-hoc breakup (derived-hex ribs + +-4% mottle clouds + a translucent
// grime band) is gone: it broke the span but carried no value ladder, so a 12 m
// wall still read as one tone. `articulate()` replaces it with named ladder
// tiers, and these constants add the three details the helper deliberately
// leaves to the caller.
const ARTIC_MIN_SPAN = 3; // §3b: "every wall over 3 m long"
const ARTIC_MIN_H = 1.0; // below this plinth + cornice would meet in the middle
const ARTIC_PLINTH_H = 0.32; // §3b band 0.25-0.4 (passed explicitly, see below)
const ARTIC_CORNICE_H = 0.18; // §3b band 0.15-0.25
const ARTIC_PILASTER_EVERY = 4.5; // keeps articulate()'s interior ribs in 4-6 m
const BEAD_H = 0.05; // `…Lit` bead capping the plinth (reads at 30 m)
const BEAD_OUT = 0.045; // just proud of the plinth's 0.04
const SOFFIT_H = 0.05; // `…Deep` shadow line under the cornice
const SOFFIT_OUT = 0.055; // just under the cornice's 0.06
const SEAM_EVERY = 2.4; // panel-seam pitch along a long face (m)
const SEAM_W = 0.07;
const SEAM_OUT = 0.018; // tucks behind pilasters (0.05) where they coincide
const SEAM_MAX = 8; // keeps the per-wall budget inside §3b's 8-20 prims

// ---- openings: reveal frames (§3b) ----------------------------------------------
const OPEN_MIN = 0.9; // narrower than this is a build tolerance, not a doorway
const OPEN_MAX = 4.6; // wider than this is a lane between two masses, not an opening
const OPEN_JAMB_W = 0.16;
const OPEN_PROUD = 0.07; // jambs/head stand proud of both wall faces
const OPEN_HEAD_H = 0.16;
const OPEN_MAX_HEAD_Y = 3.4; // above this the gap is a lane, not a door: jambs only
const OPEN_LINTEL_MIN_Y = 1.8; // a box whose underside sits here spans the opening

// ---- deco density (§3c: dressing +60-100%) --------------------------------------
// Applied to `zone.count`; every existing rejection (solids, spawn clearance,
// `minSpacing`) still runs, so lanes stay clear and props stay non-collidable.
const DECO_DENSITY = 1.6;

// ---- skyline + clouds (§3c, §1 S3) ----------------------------------------------
const SKYLINE_FAR_IN = 1.32; // far tier ring, as a multiple of SkylineDef.maxR
const SKYLINE_FAR_OUT = 1.75;
const SKYLINE_FAR_COUNT = 0.85; // far tier landmark count, relative to s.count
const SKYLINE_FAR_FADE = 0.5; // mix() toward theme.fog — atmospheric perspective
const CLOUD_FAR_FADE = 0.55;

// ---- the anti-diamond geometry (§1 S3) ------------------------------------------
// The floating pale diamonds were never a colour problem: they were the skyline
// ring's SHAPE. Three independent generator bugs produced them, and all three
// are fixed by the constants below (see buildSkyline/addSkylineRing).
const SKY_EYE = 1.62; // player eye height — the y of the horizon line
const SKY_MAX_ANG = 0.22; // rad (12.6 deg): hard ceiling on any landmark's top
const SKY_RELIEF = 0.62; // shortest landmark, as a fraction of the tallest angle
const SKY_WIDTH_SLOTS = 1.5; // landmark angular width in slot widths: > 1 = overlap
const SKY_ANG_JITTER = 0.08; // slot fractions — small enough to keep the overlap
const SKY_YAW_JITTER = 0.12; // rad off the ring tangent (never corner-on)
const SKY_DEPTH_MIN = 0.28; // landmark depth, as a fraction of its width
const SKY_DEPTH_MAX = 0.5;
const SKY_CAP_FRAC = 0.72; // the cap step starts this far up the landmark
const SKY_CAP_W = 0.8; // cap footprint, as a fraction of the body's
const SKY_CAP_D = 0.62;
const SKY_SINK = 0.6; // sunk into the apron so no base gap can ever show

const PANEL_CELL = 2.4; // ceiling light-panel grid pitch (m)
const PANEL_SKIP = 0.38; // seeded fraction of cells left dark
const PANEL_DARK = 0.15; // fraction of lit cells that are dead fixtures
const PANEL_COOL = 0.2; // fraction of lit panels running cool (screenGlow)
const POOL_OPACITY = 0.55; // floor pool quad alpha (transparent, warm spill)

/** Multiply a PALETTE '#rrggbb' hex by f (clamped). All richness tints derive
 *  from PALETTE entries here — no ad-hoc hues are ever introduced. */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 0xff) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 0xff) * f));
  const b = Math.min(255, Math.round((n & 0xff) * f));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/**
 * Build the whole map: ground, sky dome, collidable boxes, floor life,
 * ceiling light panels, deco scatter.
 * Returns the renderable root group and the collision solids (same AABBs the
 * server derives — boxToAABB per BoxDef, order preserved).
 */
export function buildMap(map: MapDef): { root: THREE.Group; solids: AABB[] } {
  const solids = map.boxes.map(boxToAABB);
  const statics = new THREE.Group();

  // ---- ground: factory box as a slab; top surface at y=-0.01, 8m apron ----
  statics.add(at(box(map.sizeX + 8, 0.02, map.sizeZ + 8, MAT_COLORS[map.floorMat]), 0, -0.02, 0));

  // ---- skyline backdrop: giant ground apron + silhouette landmark ring ------
  buildSkyline(statics, map);

  // ---- floor life: patchwork tint zones + wear lanes (visual overlays) ------
  buildFloorLife(statics, map);

  // ---- collidable boxes at exact BoxDef coords (rich materials) --------------
  for (const b of map.boxes) {
    buildRichBox(statics, b);
  }

  // ---- reveal frames around door/window openings (§3b) -----------------------
  buildReveals(statics, map);

  // ---- desktop dressing: monitors/keyboards/papers on desk-row boxes --------
  buildDesktopDressing(statics, map);

  // ---- ceiling light panels (indoor maps only: big overhead slabs) -----------
  buildLightPanels(statics, map, solids);

  // ---- deliberate accent dressing (per-map data, pure visual overlays) -------
  buildAccents(statics, map);

  // ---- deco scatter: seeded per zone, rejection-sampled ----------------------
  // Contact shadows are collected SEPARATELY (VISUAL_UPGRADE.md §1 L2b): they
  // are alpha quads standing in for AO, and if they went through the main bake
  // they would inherit castShadow and throw a second, offset disc of their own.
  const propShadows = new THREE.Group();
  const placed: Array<{ x: number; z: number }> = []; // all zones share spacing knowledge
  map.deco.forEach((zone, zoneIndex) => {
    const next = rng(decoSeed(map.id, zoneIndex));
    let placedInZone = 0;
    const target = Math.max(1, Math.round(zone.count * DECO_DENSITY));
    const maxAttempts = target * MAX_ATTEMPTS_PER_PROP;
    for (let attempt = 0; attempt < maxAttempts && placedInZone < target; attempt++) {
      const x = rngRange(next, zone.x0, zone.x1);
      const z = rngRange(next, zone.z0, zone.z1);
      if (insideSolid(x, z, solids)) continue;
      if (nearSpawn(x, z, map)) continue;
      if (tooClose(x, z, placed, zone.minSpacing)) continue;
      placed.push({ x, z });
      placedInZone++;
      const { group: prop, shadowR } = buildProp(zone.kind, next, zone.hex);
      prop.position.set(x, 0, z);
      statics.add(prop);
      const disc = contactShadow(shadowR);
      disc.position.set(x, CONTACT_Y, z);
      propShadows.add(disc);
    }
  });

  const root = new THREE.Group();
  root.add(bake(statics)); // one merged mesh per material, shadows on
  root.add(shadowless(bake(propShadows))); // AO stand-in: casts nothing itself
  root.add(buildClouds(map)); // horizon-hugging bands, unshadowed (§1 S3)
  // NO SKY DOME HERE. See the "TWO DOMES" note in this file's header and §7 seam
  // rule 1: the rig owns the visible sky, and this one was actively harmful.
  return { root, solids };
}

/** Strip shadow participation from a baked group. `bake()` flags every merged
 *  mesh castShadow+receiveShadow; contact-shadow quads and cloud bands must
 *  carry neither (and the flag pair is also what `scene.ts`'s legacy skyline-cap
 *  stripper selects on, so clearing it keeps the clouds out of its way). */
function shadowless(g: THREE.Group): THREE.Group {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = false;
      o.receiveShadow = false;
    }
  });
  return g;
}

// ---- rich box rendering -------------------------------------------------------

/** The four ladder partners of a MatId, nulls preserved. `TRIM_MAT` /
 *  `CONTACT_MAT` return null at the top / bottom of a family's ladder; passing
 *  the null through is the whole point — `articulate()` then emits nothing
 *  rather than zero-contrast trim (VISUAL_UPGRADE.md §1 L2a/L3). */
function ladder(m: MatId): { base: string; trim: string | null; dark: string; contact: string | null } {
  const trimId = TRIM_MAT[m];
  const contactId = CONTACT_MAT[m];
  return {
    base: MAT_COLORS[m],
    trim: trimId === null ? null : MAT_COLORS[trimId],
    dark: MAT_COLORS[DARK_MAT[m]],
    contact: contactId === null ? null : MAT_COLORS[contactId],
  };
}

/**
 * One BoxDef => a palette-exact body plus the articulation that stops it
 * reading as a blockout quad (VISUAL_UPGRADE.md §3b).
 *
 * THE BODY IS `MAT_COLORS[b.mat]`, UNMODIFIED. `articulate()` resolves its
 * plinth/cornice from those same frozen tables, so any tint applied here and
 * not there silently shrinks the L2a/L3 deltas the ladder law measures — which
 * is exactly what the retired +-5% albedo jitter did (§1). Palette in, palette
 * out; §0 rule 7 wants no derived hex on a wall either way.
 *
 * Boxes whose long axis clears `ARTIC_MIN_SPAN` are WALLS: they get the frozen
 * `articulate()` set (plinth / cornice / pilasters / mid rail, all in named
 * ladder tiers) plus this file's bead, soffit and panel seams — 8-20 primitives
 * that bake() merges away for free. Shorter boxes (posts, crates, low cover)
 * cannot carry a plinth without self-intersecting, so they keep the cheap
 * cap + contact band + cornice band, all drawn from the ladder tables.
 *
 * The sun-kissed cap slab is the `…Lit` TRIM TIER, or nothing: where a family
 * has no tier above (`TRIM_MAT` returns null) the cap is skipped and the body
 * runs full height, the same "never fake a ladder step" rule articulate() uses.
 *
 * Overhead boxes (ceilings, high bridges) stay plain slabs — their tops are
 * never seen and their undersides carry the light panels instead.
 */
function buildRichBox(g: THREE.Group, b: BoxDef): void {
  const { base, trim, dark, contact } = ladder(b.mat);
  const bottom = b.y - b.h / 2;
  const top = b.y + b.h / 2;
  const overhead = bottom > OVERHEAD_BOTTOM;

  if (overhead || b.h <= CAP_H + 0.01) {
    g.add(at(box(b.w, b.h, b.d, base), b.x, b.y, b.z));
    return;
  }

  if (Math.max(b.w, b.d) > ARTIC_MIN_SPAN && b.h >= ARTIC_MIN_H) {
    // A cornice already resurfaces the whole top face in the `…Lit` tier, and
    // where there is no trim tier there is no legal colour for a cap either.
    g.add(at(box(b.w, b.h, b.d, base), b.x, b.y, b.z));
    const colors: ArticulateColors = { body: base, trim, dark, contact };
    g.add(
      at(
        articulate(b.w, b.h, b.d, colors, {
          plinthH: ARTIC_PLINTH_H,
          corniceH: ARTIC_CORNICE_H,
          pilasterEvery: ARTIC_PILASTER_EVERY,
        }),
        b.x,
        b.y,
        b.z,
      ),
    );
    addWallDetail(g, b, trim, dark, contact);
    return;
  }

  // body: bottom unchanged, top lowered by CAP_H when a cap is legal (the cap
  // then finishes flush at `top`); full height when the ladder has no trim tier
  const capH = trim === null ? 0 : CAP_H;
  g.add(at(box(b.w, b.h - capH, b.d, base), b.x, bottom + (b.h - capH) / 2, b.z));
  // cap: sun-kissed top face in `…Lit`, slight outset so the seam never z-fights
  if (trim !== null) {
    g.add(at(box(b.w + CAP_OUT * 2, CAP_H, b.d + CAP_OUT * 2, trim), b.x, top - CAP_H / 2, b.z));
  }
  // contact band at the floor line: L2a for posts too narrow to articulate.
  // `contact === null` means the material IS the bottom of its ladder, and
  // `DARK_MAT` self-maps there — a fallback band would be zero contrast.
  // The skirt is outset on both lateral axes already, but its UNDERSIDE used to
  // sit exactly on the body's underside — two down-facing quads at one depth,
  // which the sun's shadow pass (shadowSide = BackSide) renders and fights over.
  // Grow it COPLANAR_EPS down into the ground; the top edge does not move.
  if (contact !== null && b.h >= 1.8 && Math.abs(bottom) <= 0.06 && (b.w >= 0.8 || b.d >= 0.8)) {
    const skirtH = SKIRT_H + COPLANAR_EPS;
    g.add(
      at(
        box(b.w + SKIRT_OUT * 2, skirtH, b.d + SKIRT_OUT * 2, contact),
        b.x,
        bottom + SKIRT_H - skirtH / 2,
        b.z,
      ),
    );
  }
  // cornice band just under the cap — the L3 lift, read at distance. Same null
  // rule: no trim tier, no band (a `…Dark` band here would read as a stain).
  // Grown COPLANAR_EPS UP into the cap so its top face is not flush with the
  // body's; the visible line under it is unmoved.
  if (trim !== null && b.h >= 2.2) {
    const bandH = TRIM_H + COPLANAR_EPS;
    g.add(
      at(
        box(b.w + TRIM_OUT * 2, bandH, b.d + TRIM_OUT * 2, trim),
        b.x,
        top - capH - TRIM_H + bandH / 2,
        b.z,
      ),
    );
  }
}

/**
 * The three articulation details `articulate()` deliberately leaves to the
 * caller, because they depend on the plinth/cornice heights the caller chose:
 *
 *  - a `…Lit` BEAD on top of the plinth — the hard light line that turns the
 *    dark plinth into a deliberate stone course instead of a dirty smudge;
 *  - a `…Deep` SOFFIT under the cornice — a cornice with no shadow under it
 *    reads as a paint stripe, not as geometry;
 *  - `…Dark` PANEL SEAMS every ~2.4 m — the fine-grain rhythm between the
 *    4.5 m pilasters, which is what kills the last of the flat-quad read.
 *
 * Everything stands proud in the wall's THIN axis only, so end caps never
 * intersect an abutting wall, and every offset is chosen to sit strictly under
 * the element above it in the stack (seam 0.018 < plinth 0.04 < bead 0.045 <
 * pilaster 0.05 < soffit 0.055 < cornice 0.06) — no coplanar z-fighting.
 */
function addWallDetail(
  g: THREE.Group,
  b: BoxDef,
  trim: string | null,
  dark: string,
  contact: string | null,
): void {
  const alongX = b.w >= b.d;
  const span = alongX ? b.w : b.d;
  const thick = alongX ? b.d : b.w;
  const bottom = b.y - b.h / 2;
  const base = MAT_COLORS[b.mat];
  const plinthH = contact === null ? 0 : ARTIC_PLINTH_H;
  const corniceH = trim === null ? 0 : ARTIC_CORNICE_H;
  // Every band below is a LADDER STEP or it is nothing: a bead in the body
  // colour or a soffit in a self-mapped `…Dark` tier is zero-contrast geometry
  // that fakes articulation instead of carrying it (§1 L2a/L3).
  const beadH = plinthH > 0 && trim !== null ? BEAD_H : 0;
  const soffitH = corniceH > 0 && contact !== null ? SOFFIT_H : 0;

  // Same rule as `articulate()`'s own bands: carry them COPLANAR_EPS PAST the
  // wall's two end faces along the long axis. Flush end caps put a second quad
  // on the wall's end plane at the same depth, which is what made wall bases
  // and rooflines flicker as the camera moved.
  const bandSpan = span + COPLANAR_EPS * 2;

  if (beadH > 0 && trim !== null) {
    const bead = alongX
      ? box(bandSpan, beadH, b.d + BEAD_OUT * 2, trim)
      : box(b.w + BEAD_OUT * 2, beadH, bandSpan, trim);
    g.add(at(bead, b.x, bottom + plinthH + beadH / 2, b.z));
  }
  if (soffitH > 0 && contact !== null) {
    const soffit = alongX
      ? box(bandSpan, soffitH, b.d + SOFFIT_OUT * 2, contact)
      : box(b.w + SOFFIT_OUT * 2, soffitH, bandSpan, contact);
    g.add(at(soffit, b.x, b.y + b.h / 2 - corniceH - soffitH / 2, b.z));
  }

  const bodyH = b.h - plinthH - beadH - corniceH - soffitH;
  if (bodyH < 0.5 || dark === base) return; // self-mapped `…Dark`: invisible seams
  const yC = bottom + plinthH + beadH + bodyH / 2;
  const n = Math.min(SEAM_MAX, Math.floor(span / SEAM_EVERY) - 1);
  for (let i = 1; i <= n; i++) {
    const t = (i / (n + 1) - 0.5) * span;
    const seam = alongX
      ? box(SEAM_W, bodyH, thick + SEAM_OUT * 2, dark)
      : box(thick + SEAM_OUT * 2, bodyH, SEAM_W, dark);
    g.add(at(seam, alongX ? b.x + t : b.x, yC, alongX ? b.z : b.z + t));
  }
}

// ---- openings: reveal frames (VISUAL_UPGRADE.md §3b) ----------------------------

/**
 * Doorways and window slots are not authored as data — they are the GAPS
 * between two collinear, coplanar, same-material wall BoxDefs. This recovers
 * them from the geometry and lines each one with a reveal frame (two jambs plus
 * a head) in the trim tier, so an opening reads as a deliberate architectural
 * event instead of a place where the level designer stopped extruding.
 *
 * Purely visual: the frame stands proud of the wall faces and never intrudes
 * into the gap, so nothing about movement or collision changes.
 */
function buildReveals(g: THREE.Group, map: MapDef): void {
  const walls = map.boxes.filter(
    (b) =>
      b.y - b.h / 2 <= 0.08 &&
      b.h >= 1.8 &&
      b.y - b.h / 2 > -1 &&
      Math.max(b.w, b.d) >= 1.5 &&
      Math.min(b.w, b.d) <= 1.6,
  );
  for (let i = 0; i < walls.length; i++) {
    const a = walls[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < walls.length; j++) {
      const c = walls[j];
      if (c === undefined) continue;
      // Materials may differ (Office frames plaster partitions against concrete
      // cores); the reveal takes the tier of the LONGER flank, which is the wall
      // the opening reads as belonging to.
      if (a.w >= a.d && c.w >= c.d && Math.abs(a.z - c.z) < 0.12 && Math.abs(a.d - c.d) < 0.12) {
        const lo = a.x < c.x ? a : c;
        const hi = a.x < c.x ? c : a;
        const m = lo.w >= hi.w ? lo.mat : hi.mat;
        addReveal(g, map, 'x', lo.x + lo.w / 2, hi.x - hi.w / 2, lo.z, lo.d, Math.min(lo.h, hi.h), m);
      } else if (a.d > a.w && c.d > c.w && Math.abs(a.x - c.x) < 0.12 && Math.abs(a.w - c.w) < 0.12) {
        const lo = a.z < c.z ? a : c;
        const hi = a.z < c.z ? c : a;
        const m = lo.d >= hi.d ? lo.mat : hi.mat;
        addReveal(g, map, 'z', lo.z + lo.d / 2, hi.z - hi.d / 2, lo.x, lo.w, Math.min(lo.h, hi.h), m);
      }
    }
  }
}

/** One candidate gap => 0 or 3 reveal primitives. `g0`/`g1` bound the gap along
 *  `axis`; `cross` and `thick` locate the wall line; `wallH` is the shorter of
 *  the two flanking walls. */
function addReveal(
  g: THREE.Group,
  map: MapDef,
  axis: 'x' | 'z',
  g0: number,
  g1: number,
  cross: number,
  thick: number,
  wallH: number,
  m: MatId,
): void {
  const gap = g1 - g0;
  if (gap < OPEN_MIN || gap > OPEN_MAX) return;

  // Something standing in the gap means these two walls are not two sides of
  // one opening — they are two walls with a third thing between them.
  let lintelY = Number.POSITIVE_INFINITY;
  for (const b of map.boxes) {
    const bLo = axis === 'x' ? b.x - b.w / 2 : b.z - b.d / 2;
    const bHi = axis === 'x' ? b.x + b.w / 2 : b.z + b.d / 2;
    const bCross = axis === 'x' ? b.z : b.x;
    const bHalf = (axis === 'x' ? b.d : b.w) / 2;
    if (bHi <= g0 + 0.02 || bLo >= g1 - 0.02) continue; // no overlap along the gap
    if (Math.abs(bCross - cross) > bHalf + thick / 2) continue; // not on this wall line
    const bot = b.y - b.h / 2;
    if (bot < 1.4) return; // a solid blocks the passage: not an opening
    if (bot >= OPEN_LINTEL_MIN_Y && bot < lintelY) lintelY = bot; // a head above it
  }

  const { trim, dark } = ladder(m);
  const hex = trim ?? dark; // §3b wants the trim tier; `…Lit` mats fall to `…Dark`
  const hasLintel = Number.isFinite(lintelY);
  const jambH = hasLintel ? Math.min(lintelY, wallH) : wallH;
  const depth = thick + OPEN_PROUD * 2;
  const mid = (g0 + g1) / 2;

  // A jamb used to finish EXACTLY on the flanking wall's end plane, and to run
  // from exactly the wall's underside to exactly its top — three coplanar,
  // same-facing quad pairs per jamb, trim tier against body tier, on the
  // most-looked-at surface in the map (see COPLANAR_EPS). So:
  //  - pull each jamb COPLANAR_EPS back off the reveal, i.e. BACK INTO ITS OWN
  //    WALL, so it still never intrudes into the gap and nothing about movement
  //    or collision changes;
  //  - run it COPLANAR_EPS below the wall's underside, into the ground;
  //  - and stop it COPLANAR_EPS BELOW an unlintelled wall's top rather than on
  //    it, so a jamb never lands on the wall top (or on the cornice that now
  //    finishes just above it) and never breaks a roofline.
  const jambLo = -COPLANAR_EPS;
  const jambTop = Math.min(jambH, wallH - COPLANAR_EPS);
  const jambBoxH = jambTop - jambLo;
  for (const edge of [g0 - OPEN_JAMB_W / 2 - COPLANAR_EPS, g1 + OPEN_JAMB_W / 2 + COPLANAR_EPS]) {
    const jamb =
      axis === 'x'
        ? box(OPEN_JAMB_W, jambBoxH, depth, hex)
        : box(depth, jambBoxH, OPEN_JAMB_W, hex);
    g.add(
      at(jamb, axis === 'x' ? edge : cross, (jambLo + jambTop) / 2, axis === 'x' ? cross : edge),
    );
  }
  // A gap that runs the full height of tall walls with nothing spanning it is a
  // LANE, not a doorway: capping it with a beam would invent architecture that
  // is not there. Jambs still line the edges; the head is what we withhold.
  if (!hasLintel && wallH > OPEN_MAX_HEAD_Y) return;
  const head =
    axis === 'x'
      ? box(gap + OPEN_JAMB_W * 2, OPEN_HEAD_H, depth, hex)
      : box(depth, OPEN_HEAD_H, gap + OPEN_JAMB_W * 2, hex);
  g.add(at(head, axis === 'x' ? mid : cross, jambTop - OPEN_HEAD_H / 2, axis === 'x' ? cross : mid));
}

// ---- floor life (patchwork tint zones + wear lanes; visual overlays only) -----

function buildFloorLife(g: THREE.Group, map: MapDef): void {
  const floorHex = MAT_COLORS[map.floorMat];
  const next = rng(decoSeed(map.id, SALT_FLOOR));
  const halfX = map.sizeX / 2;
  const halfZ = map.sizeZ / 2;

  // patchwork tint zones: large soft rectangles, four depth tiers so
  // overlapping patches never share a plane (no z-fighting)
  const patchCount = Math.round((map.sizeX * map.sizeZ) / 220);
  for (let i = 0; i < patchCount; i++) {
    const w = rngRange(next, 3, 9);
    const d = rngRange(next, 3, 9);
    const x = rngRange(next, -halfX + w / 2 + 1, halfX - w / 2 - 1);
    const z = rngRange(next, -halfZ + d / 2 + 1, halfZ - d / 2 - 1);
    const f = PATCH_FACTORS[i % PATCH_FACTORS.length] ?? 1;
    const y = -0.003 - (i % 4) * 0.0012;
    g.add(at(box(w, 0.002, d, shade(floorHex, f)), x, y, z));
  }

  // wear lanes: darker trampled strips running T -> CT along the mid axis and
  // two offset lanes; segmented with a slight seeded wobble so they read worn,
  // not painted. Spawn courts get a trampled pad as well.
  const wearHex = shade(floorHex, WEAR_FACTOR);
  const t = centroid(map.spawns.T);
  const ct = centroid(map.spawns.CT);
  for (const off of [0, -halfX * 0.62, halfX * 0.62]) {
    const p0 = { x: t.x + off, z: t.z };
    const p3 = { x: ct.x + off, z: ct.z };
    const pts = [p0];
    for (const k of [1 / 3, 2 / 3]) {
      pts.push({
        x: p0.x + (p3.x - p0.x) * k + rngRange(next, -1.2, 1.2),
        z: p0.z + (p3.z - p0.z) * k,
      });
    }
    pts.push(p3);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const c = pts[i + 1];
      if (a === undefined || c === undefined) continue;
      const dx = c.x - a.x;
      const dz = c.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      const wSeg = rngRange(next, 1.5, 2.1);
      const seg = at(box(wSeg, 0.002, len + 0.6, wearHex), (a.x + c.x) / 2, WEAR_TOP_Y - 0.001, (a.z + c.z) / 2);
      seg.rotation.y = Math.atan2(dx, dz);
      g.add(seg);
    }
  }
  for (const c of [t, ct]) {
    g.add(at(box(7, 0.002, 3.2, wearHex), c.x, WEAR_TOP_Y - 0.0014, c.z));
  }
}

function centroid(pts: ReadonlyArray<{ x: number; z: number }>): { x: number; z: number } {
  let x = 0;
  let z = 0;
  for (const p of pts) {
    x += p.x;
    z += p.z;
  }
  const n = Math.max(1, pts.length);
  return { x: x / n, z: z / n };
}

// ---- skyline backdrop (silhouette ring beyond the outer walls) ----------------

/**
 * A giant ground apron (so the horizon never shows void) plus TWO DEPTH TIERS
 * of mesa/dune silhouettes outside the playable area (VISUAL_UPGRADE.md §3c),
 * built so that a FLOATING TIP IS GEOMETRICALLY IMPOSSIBLE (§1 S3).
 *
 * ---- why the old ring produced "sky diamonds" -----------------------------
 * The previous generator drew each landmark independently: a free height from
 * `[minH, maxH]`, a free radius from `[minR, maxR]`, a free yaw, and a narrower
 * second block dropped on top with a yaw of its own. Three consequences, all of
 * them visible in screenshots/v2:
 *
 *   1. HEIGHT WAS INDEPENDENT OF DISTANCE, so a FARTHER landmark could easily be
 *      TALLER on screen than the nearer one standing in front of it. Its body was
 *      hidden, its top was not: a pale shape with sky on every side.
 *   2. THE RING HAD GAPS. `count` landmarks of width `h*1.6..2.8` at radius
 *      `r` cover `count * w / r` radians; on Crossfire (16 x ~25 m at r 60-76)
 *      that is barely 2*PI with the angular jitter routinely opening real holes,
 *      so the ring read as separated spikes rather than a horizon.
 *   3. EVERY BLOCK WAS FREELY YAWED, so it was regularly seen corner-on — and a
 *      box seen corner-on, clipped to its tip, is literally a diamond.
 *
 * ---- what replaces it -----------------------------------------------------
 * The ring is now generated in ANGLE space, not in metres:
 *
 *   - HEIGHT IS DERIVED FROM DISTANCE. The map's authored `[minH, maxH]` is read
 *     ONCE, at the ring's own mid radius, as an apparent-elevation band above the
 *     horizon line at eye height (`SKY_EYE`). Every landmark then gets its height
 *     back from ITS OWN radius as `y = SKY_EYE + r * tan(theta)`. Nearer landmarks
 *     are therefore SHORTER, by construction, and the whole ring is clamped to
 *     `SKY_MAX_ANG` no matter what a map asks for. A landmark can no longer
 *     out-top something in front of it just by being further away.
 *   - THE RING IS CONTINUOUS. Landmarks sit in fixed angular slots and are cut
 *     `SKY_WIDTH_SLOTS` (1.5) slots wide, so every one overlaps both neighbours
 *     even at the worst angular jitter. There is no sky under a tip because
 *     there is no gap between the ranks.
 *   - LANDMARKS FACE THE PLAYER. Yaw is the ring TANGENT plus at most
 *     `SKY_YAW_JITTER`, so the broad face is what is seen: never a corner.
 *   - THE CAP IS A STEP, NOT A HAT. It shares its body's yaw and footprint centre
 *     and its top IS the clamped top, so it reads as the upper terrace of one
 *     mass instead of a separate object that can survive its body's occlusion.
 *
 * ---- the two tiers --------------------------------------------------------
 * The near ring keeps the map's own `SkylineDef` colours AT FULL VALUE — pre-fading
 * it toward the fog as well collapses the whole backdrop to within a few L* of the
 * sky and it stops reading as anything. Only the FAR ring (1.32-1.75x the radius)
 * is mixed halfway toward `theme.fog`. Both `mix()` endpoints are palette entries,
 * so the result stays traceable (§0 rule 7).
 */
function buildSkyline(g: THREE.Group, map: MapDef): void {
  const s = map.skyline;
  if (s === undefined) return;
  g.add(at(box(320, 0.02, 320, map.theme.ground), 0, -0.04, 0)); // horizon apron
  const next = rng(decoSeed(map.id, SALT_SKYLINE));

  // The authored height band, read at the ring's mid radius, becomes the ring's
  // ELEVATION band. `SKY_MAX_ANG` is the hard S3 ceiling; `SKY_RELIEF` opens the
  // bottom of the band back up, because a ridge whose tops all sit within ~1.5
  // deg of each other reads as a wall, not as a landscape. Neither end can make
  // a landmark taller than the clamp, which is the property S3 needs.
  const rMid = (s.minR + s.maxR) / 2;
  const angHi = Math.min(SKY_MAX_ANG, Math.atan(Math.max(0.5, s.maxH - SKY_EYE) / rMid));
  const angLo = Math.min(angHi * SKY_RELIEF, Math.atan(Math.max(0.4, s.minH - SKY_EYE) / rMid));

  const farCount = Math.max(3, Math.round(s.count * SKYLINE_FAR_COUNT));
  addSkylineRing(
    g,
    next,
    farCount,
    s.maxR * SKYLINE_FAR_IN,
    s.maxR * SKYLINE_FAR_OUT,
    angLo,
    angHi,
    mix(s.hex, map.theme.fog, SKYLINE_FAR_FADE),
    mix(s.capHex ?? s.hex, map.theme.fog, SKYLINE_FAR_FADE),
    Math.PI / farCount, // half a slot: the far ranks sit behind the near seams
  );
  addSkylineRing(g, next, s.count, s.minR, s.maxR, angLo, angHi, s.hex, s.capHex ?? s.hex, 0);
}

/**
 * One ring of stepped mesa landmarks, generated in angle space.
 *
 * `angLo`/`angHi` are apparent elevations above the horizon line, NOT heights:
 * the height of each landmark is recovered from its own radius, which is what
 * makes "nearer ring landmarks are shorter" an invariant of the generator rather
 * than a tuning value a map can violate.
 *
 * Widths are cut from the same angle space (`SKY_WIDTH_SLOTS` slots wide against
 * a `2*PI/count` slot), so the ring stays continuous at ANY radius or count a map
 * chooses — every landmark overlaps both neighbours, and each still keeps roughly
 * a fifth of a slot of exclusive silhouette running all the way down to the
 * horizon. That exclusive span is the guarantee: a shape that reaches the ground
 * somewhere cannot read as floating.
 *
 * Pure backdrop: non-collidable, outside every solid, well beyond the tightened
 * shadow frustum; fog does the rest of the aerial perspective.
 */
function addSkylineRing(
  g: THREE.Group,
  next: () => number,
  count: number,
  r0: number,
  r1: number,
  angLo: number,
  angHi: number,
  bodyHex: string,
  capHex: string,
  angOffset: number,
): void {
  const slot = (Math.PI * 2) / count;
  const halfW = (slot * SKY_WIDTH_SLOTS) / 2;
  for (let i = 0; i < count; i++) {
    const ang = i * slot + angOffset + rngRange(next, -SKY_ANG_JITTER, SKY_ANG_JITTER) * slot;
    const r = rngRange(next, r0, r1);
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    // TOP FROM DISTANCE — the whole S3 fix in one line.
    const top = SKY_EYE + r * Math.tan(rngRange(next, angLo, angHi));
    const w = 2 * r * Math.tan(halfW); // >= 1.5 slots wide: neighbours always overlap
    const d = w * rngRange(next, SKY_DEPTH_MIN, SKY_DEPTH_MAX);
    // tangent-aligned: rotation.y = phi sends local +x to world (cos phi, -sin phi),
    // so -ang - PI/2 puts the broad face across the line of sight from the centre.
    const yaw = -ang - Math.PI / 2 + rngRange(next, -SKY_YAW_JITTER, SKY_YAW_JITTER);
    const bodyTop = top * SKY_CAP_FRAC;
    const bodyH = bodyTop + SKY_SINK;
    const body = at(box(w, bodyH, d, bodyHex), x, bodyH / 2 - SKY_SINK, z);
    body.rotation.y = yaw;
    g.add(body);
    // the cap is the upper TERRACE of the same mass: same centre, same yaw, and
    // its top is the clamped top — it can never outlive the body that carries it
    const capH = top - bodyTop;
    const cap = at(box(w * SKY_CAP_W, capH, d * SKY_CAP_D, capHex), x, bodyTop + capH / 2, z);
    cap.rotation.y = yaw;
    g.add(cap);
  }
}

// ---- cloud bands (VISUAL_UPGRADE.md §1 S3 / §3c) --------------------------------

/**
 * The replacement for the "sky diamonds". Those were never clouds — they were
 * the skyline ring's tips poking over their own front ranks, and `scene.ts` was
 * deleting them at runtime with a triangle filter. These are real clouds:
 *
 *  - TWO LAYERED BANDS, near in full value and far mixed toward `theme.fog`;
 *  - FLATTENED (a slab wider and deeper than it is tall, with rounder puffs
 *    riding on it) so they read as cloud and not as floating masonry;
 *  - CLUSTERED, not evenly scattered;
 *  - HORIZON-HUGGING: they sit low, just above and beyond the skyline ring,
 *    where the exponential fog still lets them read at all.
 *
 * Baked, then stripped of shadow participation: a cloud that casts a shadow map
 * would drop a hard rectangle across the whole playfield. Indoor maps (no
 * `SkylineDef`, i.e. no sky worth dressing) get nothing.
 */
function buildClouds(map: MapDef): THREE.Group {
  const s = map.skyline;
  if (s === undefined) return new THREE.Group();
  const next = rng(decoSeed(map.id, SALT_CLOUD));
  const R = s.maxR;
  const g = new THREE.Group();
  // far band first, so the near band's clusters bake over the top of it. Counts,
  // radii and heights are held at the values this band was tuned to: raising the
  // count makes the RING legible as a ring, which is a worse read than a few
  // large clusters.
  addCloudBand(
    g,
    next,
    R * 1.6,
    R * 2.0,
    R * 0.56,
    R * 0.76,
    mix(PALETTE.paper, map.theme.fog, CLOUD_FAR_FADE),
    mix(PALETTE.plaster, map.theme.fog, CLOUD_FAR_FADE),
    11,
    1.5,
  );
  addCloudBand(g, next, R * 1.15, R * 1.5, R * 0.4, R * 0.56, PALETTE.paper, PALETTE.plaster, 9, 1.0);
  return shadowless(bake(g));
}

/** One ring of cloud clusters: a `baseHex` underside slab, NARROWER than the
 *  cluster, carrying 4-6 `topHex` puffs that overhang it on every side, so the
 *  silhouette is a lumpy mass rather than a plate with bumps on it. `scale`
 *  stretches the whole band for the far tier, so the further clusters stay the
 *  same apparent size. */
function addCloudBand(
  g: THREE.Group,
  next: () => number,
  r0: number,
  r1: number,
  y0: number,
  y1: number,
  topHex: string,
  baseHex: string,
  count: number,
  scale: number,
): void {
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + rngRange(next, -0.25, 0.25);
    const r = rngRange(next, r0, r1);
    const len = rngRange(next, 16, 30) * scale;
    const dep = rngRange(next, 7, 12) * scale;
    const cluster = new THREE.Group();
    cluster.add(at(box(len * 0.76, 1.7 * scale, dep * 0.78, baseHex), 0, 0, 0)); // shaded underside
    const puffs = rngInt(next, 4, 6);
    for (let p = 0; p < puffs; p++) {
      const w = rngRange(next, 0.34, 0.6) * len;
      const ph = rngRange(next, 1.6, 3.2) * scale;
      const pd = rngRange(next, 0.7, 1.05) * dep;
      cluster.add(
        at(
          box(w, ph, pd, topHex),
          rngRange(next, -len / 2 + w / 2, len / 2 - w / 2),
          rngRange(next, 0.1, 0.7) * scale + ph / 2, // puffs bed INTO the slab
          rngRange(next, -dep * 0.18, dep * 0.18),
        ),
      );
    }
    cluster.position.set(Math.cos(ang) * r, rngRange(next, y0, y1), Math.sin(ang) * r);
    // Long axis tangential to the ring, so no cluster points end-on at the map —
    // a band seen end-on is a short floating bar, which is the same read the S3
    // skyline diamonds had. `rotation.y = phi` sends local +x to (cos phi, -sin phi),
    // so the tangent at `ang` is `-ang - PI/2`; the old `ang + PI/2` only happened
    // to be tangential on the four cardinal bearings and was radial in between.
    cluster.rotation.y = -ang - Math.PI / 2 + rngRange(next, -0.3, 0.3);
    g.add(cluster);
  }
}

// ---- deliberate accent dressing (data-driven visual overlays) ------------------

function buildAccents(g: THREE.Group, map: MapDef): void {
  for (const a of map.accents ?? []) {
    const opts = a.emissive === true ? { emissive: a.hex } : undefined;
    g.add(at(box(a.w, a.h, a.d, a.hex, opts), a.x, a.y, a.z));
  }
}

// ---- desktop dressing (showroom -> workplace) -----------------------------------

/**
 * Seeded workplace props ON 'desk'-material BoxDefs (the bullpen sightlines
 * were bare white desktops): monitors with lit/dark screens + keyboards, and
 * paper piles. Everything sits on the desk top; all non-collidable overlays.
 */
function buildDesktopDressing(g: THREE.Group, map: MapDef): void {
  const next = rng(decoSeed(map.id, SALT_DESK));
  for (const b of map.boxes) {
    if (b.mat !== 'desk' || b.w < 2 || b.d < 0.6) continue;
    const top = b.y + b.h / 2;
    const items = rngInt(next, 1, 2);
    for (let i = 0; i < items; i++) {
      const px = b.x + rngRange(next, -b.w / 2 + 0.5, b.w / 2 - 0.5);
      const pz = b.z + rngRange(next, -b.d / 2 + 0.2, b.d / 2 - 0.2);
      if (next() < 0.6) {
        // monitors within ~9m of a spawn-adjacent sightline are always lit —
        // the hero frames must never show a dead black screen at eye level
        buildMonitor(g, next, px, top, pz, withinSpawnRadius(px, pz, map, 9));
      } else {
        const pile = new THREE.Group();
        buildPaperStack(pile, next);
        pile.position.set(px, top, pz);
        g.add(pile);
      }
    }
  }
}

/** True when (x,z) is within r meters of any spawn point (either team). */
function withinSpawnRadius(x: number, z: number, map: MapDef, r: number): boolean {
  const r2 = r * r;
  for (const team of [map.spawns.T, map.spawns.CT]) {
    for (const s of team) {
      const dx = s.x - x;
      const dz = s.z - z;
      if (dx * dx + dz * dz < r2) return true;
    }
  }
  return false;
}

/** monitor: stand + foot + bezel + screen face (~95% lit screenGlow; always
 *  lit when forceLit) + keyboard. */
function buildMonitor(g: THREE.Group, next: () => number, x: number, topY: number, z: number, forceLit: boolean): void {
  const m = new THREE.Group();
  m.add(at(box(0.3, 0.03, 0.2, PALETTE.charcoal), 0, 0.015, 0)); // foot
  m.add(at(box(0.06, 0.22, 0.06, PALETTE.charcoal), 0, 0.13, 0)); // stand
  m.add(at(box(0.56, 0.36, 0.05, PALETTE.charcoal), 0, 0.42, 0)); // bezel
  const lit = forceLit || next() < 0.95;
  m.add(
    at(
      box(0.5, 0.3, 0.02, PALETTE.screenGlow, lit ? { emissive: PALETTE.screenGlow } : undefined),
      0,
      0.42,
      0.037,
    ),
  ); // screen face (+z of group)
  m.add(at(box(0.36, 0.02, 0.13, PALETTE.charcoal), 0, 0.01, 0.28)); // keyboard
  m.rotation.y = (next() < 0.5 ? 0 : Math.PI) + rngRange(next, -0.25, 0.25);
  m.position.set(x, topY, z);
  g.add(m);
}

// ---- ceiling light panels (indoor maps: big mood win) --------------------------

/**
 * Seeded grid of fluorescent panels hung under ceiling slabs. A map "has a
 * ceiling" wherever an overhead box (slab bottom in [2.2, 4.5], >= 3m in both
 * footprint axes) covers the grid point — outdoor maps get nothing, skylight
 * slots stay dark. Panels never spawn inside tall solids (pillars/walls).
 * ~15% of lit cells are dead fixtures (dark plate, no glow, no pool); each
 * live panel spills a soft transparent pool quad onto the floor below.
 */
function buildLightPanels(g: THREE.Group, map: MapDef, solids: AABB[]): void {
  const slabs = map.boxes.filter((b) => {
    const bottom = b.y - b.h / 2;
    return bottom >= 2.2 && bottom <= 4.5 && b.w >= 3 && b.d >= 3;
  });
  if (slabs.length === 0) return;

  const next = rng(decoSeed(map.id, SALT_LIGHT));
  const halfX = map.sizeX / 2;
  const halfZ = map.sizeZ / 2;
  const cols = Math.floor((map.sizeX - 2.6) / PANEL_CELL) + 1;
  const rows = Math.floor((map.sizeZ - 2.6) / PANEL_CELL) + 1;
  const poolHex = shade(PALETTE.paper, 0.82); // warm fixture light on any floor
  const poolGlowHex = shade(PALETTE.paper, 0.5);

  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = -halfX + 1.3 + i * PANEL_CELL;
      const z = -halfZ + 1.3 + j * PANEL_CELL;
      let ceil = Number.POSITIVE_INFINITY;
      for (const s of slabs) {
        if (Math.abs(x - s.x) <= s.w / 2 && Math.abs(z - s.z) <= s.d / 2) {
          ceil = Math.min(ceil, s.y - s.h / 2);
        }
      }
      if (!Number.isFinite(ceil)) continue;
      if (next() < PANEL_SKIP) continue;
      if (insideTallSolid(x, z, ceil, map.boxes)) continue;

      const alongX = (i + j) % 2 === 0; // alternate orientation per cell
      const fw = alongX ? 1.3 : 0.7;
      const fd = alongX ? 0.7 : 1.3;
      const gw = alongX ? 1.16 : 0.56;
      const gd = alongX ? 0.56 : 1.16;
      g.add(at(box(fw, 0.05, fd, PALETTE.metalDark), x, ceil - 0.025, z));

      if (next() < PANEL_DARK) {
        // dead fixture: dark inset plate, no glow, no pool
        g.add(at(box(gw, 0.024, gd, PALETTE.charcoal), x, ceil - 0.062, z));
        continue;
      }
      const warm = next() >= PANEL_COOL;
      const glowHex = warm ? PALETTE.paper : PALETTE.screenGlow;
      g.add(at(box(gw, 0.024, gd, glowHex, { emissive: glowHex }), x, ceil - 0.062, z));
      // floor pool: soft warm emissive-transparent spill on open floor (not
      // under solids) — every live panel gets a visible floor response
      if (!insideSolid(x, z, solids)) {
        const pw = alongX ? 2.8 : 1.8;
        const pd = alongX ? 1.8 : 2.8;
        g.add(
          at(
            box(pw, 0.001, pd, poolHex, { transparent: true, opacity: POOL_OPACITY, emissive: poolGlowHex }),
            x,
            -0.001,
            z,
          ),
        );
      }
    }
  }
}

/** True when (x,z) lies inside a floor-standing solid (padded) whose top
 *  reaches the panel. Overhead boxes (the ceiling slabs themselves, bottom at
 *  or above the panel) are not obstructions — panels hang from them. */
function insideTallSolid(x: number, z: number, ceil: number, boxes: readonly BoxDef[]): boolean {
  for (const b of boxes) {
    if (b.y - b.h / 2 >= ceil - 0.5) continue; // overhead slab, not a pillar
    if (b.y + b.h / 2 < ceil - 0.12) continue; // too low to reach the panel
    if (Math.abs(x - b.x) <= b.w / 2 + 0.35 && Math.abs(z - b.z) <= b.d / 2 + 0.35) return true;
  }
  return false;
}

// ---- scatter rejections -------------------------------------------------------

/**
 * Point (ground plane) vs every FLOOR-OCCUPYING solid, each AABB inflated by
 * SOLID_PAD.
 *
 * The height test is load-bearing. Without it the test was purely 2D, so a
 * ceiling slab — which spans the entire footprint of an indoor map — matched
 * every candidate point and rejected it: Office and Bunker were scattering ZERO
 * deco props and painting ZERO light pools, silently, for every prop their map
 * data asked for. A solid you can walk under does not occupy the floor.
 */
function insideSolid(x: number, z: number, solids: AABB[]): boolean {
  for (const s of solids) {
    if (s.minY > FLOOR_OCCUPIED_Y) continue; // overhead: ceilings, bridges, lintels
    if (x > s.minX - SOLID_PAD && x < s.maxX + SOLID_PAD && z > s.minZ - SOLID_PAD && z < s.maxZ + SOLID_PAD) {
      return true;
    }
  }
  return false;
}

/** Props never crowd spawn points (both teams). */
function nearSpawn(x: number, z: number, map: MapDef): boolean {
  const d2 = SPAWN_CLEARANCE * SPAWN_CLEARANCE;
  for (const s of map.spawns.T) {
    const dx = s.x - x;
    const dz = s.z - z;
    if (dx * dx + dz * dz < d2) return true;
  }
  for (const s of map.spawns.CT) {
    const dx = s.x - x;
    const dz = s.z - z;
    if (dx * dx + dz * dz < d2) return true;
  }
  return false;
}

/** Min center distance to every already-placed prop. */
function tooClose(x: number, z: number, placed: ReadonlyArray<{ x: number; z: number }>, minSpacing: number): boolean {
  const d2 = minSpacing * minSpacing;
  for (const p of placed) {
    const dx = p.x - x;
    const dz = p.z - z;
    if (dx * dx + dz * dz < d2) return true;
  }
  return false;
}

// ---- deco prop recipes (VISUAL_UPGRADE.md §3c: 8-16 prims, PALETTE only) ------
// Every builder fills a group sitting on y=0; buildProp adds yaw + scale jitter.

/**
 * Contact-shadow radius per prop kind, in metres before scale jitter
 * (VISUAL_UPGRADE.md §1 L2b). Roughly the prop's ground footprint radius plus a
 * little spill — a disc tighter than the silhouette reads as a hole, one much
 * wider reads as a puddle. This table is the reason props stop floating, which
 * is this round's entire substitute for ambient occlusion.
 */
const PROP_SHADOW_R: Record<DecoKind, number> = {
  crate: 0.7,
  barrel: 0.44,
  pallet: 0.75,
  pipe: 0.95,
  rock: 0.72,
  shrub: 0.44,
  cactus: 0.34,
  snowRock: 0.76,
  plant: 0.26,
  paperStack: 0.3,
  palletStack: 0.78,
  sandbag: 0.95,
  icicle: 0.44,
  deskChair: 0.38,
  waterCooler: 0.3,
  sack: 0.5,
};

function buildProp(
  kind: DecoKind,
  next: () => number,
  hex?: string,
): { group: THREE.Group; shadowR: number } {
  const g = new THREE.Group();
  switch (kind) {
    case 'crate':
      buildCrate(g);
      break;
    case 'barrel':
      buildBarrel(g, next, hex);
      break;
    case 'pallet':
      buildPallet(g);
      break;
    case 'pipe':
      buildPipe(g);
      break;
    case 'rock':
      scatterRocks(g, next, PALETTE.rockDark, PALETTE.concreteDark, PALETTE.rockDeep);
      break;
    case 'shrub':
      buildShrub(g, next);
      break;
    case 'cactus':
      buildCactus(g, next);
      break;
    case 'snowRock':
      buildSnowRock(g, next);
      break;
    case 'plant':
      buildPlant(g, next);
      break;
    case 'paperStack':
      buildPaperStack(g, next);
      break;
    case 'palletStack':
      buildPalletStack(g, next);
      break;
    case 'sandbag':
      buildSandbag(g, next);
      break;
    case 'icicle':
      buildIcicle(g, next);
      break;
    case 'deskChair':
      buildDeskChair(g);
      break;
    case 'waterCooler':
      buildWaterCooler(g);
      break;
    case 'sack':
      buildSack(g, next);
      break;
  }
  g.rotation.y = next() * Math.PI * 2; // slight organic yaw jitter
  const s = rngRange(next, 0.85, 1.2);
  g.scale.setScalar(s);
  return { group: g, shadowR: PROP_SHADOW_R[kind] * s };
}

/**
 * crate (10 prims, §3c): `crate` body, four `woodDark` CORNER BRACES, a
 * `woodDeep` base ring that grounds it, a rim + `crateLit` lid panel split by a
 * `woodDeep` LID SEAM, and a paper STENCIL PLATE on one face. The three-value
 * break across body / brace / lid is what makes a crate read as a crate at 25 m
 * instead of as a brown cube.
 */
function buildCrate(g: THREE.Group): void {
  const S = 0.9;
  const B = 0.09;
  g.add(at(box(S, S, S, PALETTE.crate), 0, S / 2, 0)); // body
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(at(box(B, S, B, PALETTE.woodDark), (sx * (S - B)) / 2, S / 2, (sz * (S - B)) / 2)); // corner brace
    }
  }
  g.add(at(box(S + 0.05, 0.07, S + 0.05, PALETTE.woodDeep), 0, 0.035, 0)); // base ring
  g.add(at(box(S + 0.04, 0.045, S + 0.04, PALETTE.woodDark), 0, S + 0.022, 0)); // lid rim
  g.add(at(box(S - 0.08, 0.05, S - 0.08, PALETTE.crateLit), 0, S + 0.07, 0)); // lid panel
  g.add(at(box(S - 0.06, 0.022, 0.05, PALETTE.woodDeep), 0, S + 0.097, 0)); // lid seam
  g.add(at(box(0.3, 0.22, 0.02, PALETTE.paper), 0, S * 0.58, S / 2 + 0.012)); // stencil plate
}

/** barrel (8 prims, §3c): body + 2 RING BANDS + a `metalDeep` BASE RING + top
 *  chime + `steelLit` lid + a BUNG and a vent plug on the lid. Body: steel or
 *  tBrown industrial by default, or two tones of the zone's family hex when one
 *  is set (dustbowl's sand family — the gray-blue steel read off-palette there). */
function buildBarrel(g: THREE.Group, next: () => number, hex?: string): void {
  const R = 0.34;
  const H = 0.92;
  const body = hex !== undefined ? shade(hex, next() < 0.5 ? 1 : 0.85) : next() < 0.5 ? PALETTE.steel : PALETTE.tBrown;
  g.add(at(cyl(R, R, H, 12, body), 0, H / 2, 0));
  g.add(at(cyl(R + 0.035, R + 0.035, 0.08, 12, PALETTE.metalDark), 0, H * 0.3, 0)); // rim
  g.add(at(cyl(R + 0.035, R + 0.035, 0.08, 12, PALETTE.metalDark), 0, H * 0.7, 0)); // rim
  g.add(at(cyl(R + 0.045, R + 0.045, 0.09, 12, PALETTE.metalDeep), 0, 0.045, 0)); // base ring
  g.add(at(cyl(R + 0.02, R + 0.02, 0.06, 12, PALETTE.metalDark), 0, H - 0.03, 0)); // top chime
  g.add(at(cyl(R - 0.03, R - 0.03, 0.05, 12, PALETTE.steelLit), 0, H + 0.012, 0)); // lid
  g.add(at(cyl(0.07, 0.07, 0.05, 8, PALETTE.metalDark), 0.16, H + 0.05, 0)); // bung
  g.add(at(cyl(0.045, 0.045, 0.035, 8, PALETTE.metalDeep), -0.14, H + 0.045, 0)); // vent plug
}

/** pallet (11 prims, §3c): 5 VISIBLE TOP SLATS with real gaps between them,
 *  3 `woodDark` stringers and 3 `woodDeep` bottom slats. The gaps are the
 *  point — a pallet is legible only when you can see through it. */
function buildPallet(g: THREE.Group): void {
  for (const z of [-0.44, -0.22, 0, 0.22, 0.44]) {
    g.add(at(box(1.15, 0.035, 0.16, PALETTE.wood), 0, 0.125, z)); // top deck slat
  }
  for (const x of [-0.44, 0, 0.44]) {
    g.add(at(box(0.13, 0.09, 1.04, PALETTE.woodDark), x, 0.062, 0)); // stringer
  }
  for (const z of [-0.4, 0, 0.4]) {
    g.add(at(box(1.15, 0.032, 0.18, PALETTE.woodDeep), 0, 0.016, z)); // bottom slat
  }
}

/**
 * palletStack: 2-3 `pallet` props piled with slight yaw drift (warehouse
 * dressing). Deliberately over §3c's per-prop 8-16 band at 22-33 prims — it is
 * a CLUSTER of whole props, not one prop, and thinning `pallet` to make the
 * stack fit would regress the single pallet the budget actually describes.
 */
function buildPalletStack(g: THREE.Group, next: () => number): void {
  const n = rngInt(next, 2, 3);
  for (let i = 0; i < n; i++) {
    const layer = new THREE.Group();
    buildPallet(layer);
    layer.position.y = i * 0.15;
    layer.rotation.y = rngRange(next, -0.14, 0.14);
    g.add(layer);
  }
}

/**
 * pipe (13 prims, §3c): a `steel` run on two `metalDeep` GROUND CRADLES, 2 mid
 * ring bands + 2 `metalDark` end flanges, an elbow riser with its own base
 * flange, a `steelLit` riser cap and a `steelLit` valve wheel with a `metalDark`
 * stem. Three tiers — steelLit hardware, steel pipework, metalDark/metalDeep
 * fittings and contact — so it stops reading as one grey sausage at 20 m.
 */
function buildPipe(g: THREE.Group): void {
  const R = 0.14;
  const L = 1.8;
  const run = at(cyl(R, R, L, 10, PALETTE.steel), 0, R, 0);
  run.rotation.z = Math.PI / 2; // axis along x, resting on the ground
  g.add(run);
  for (const x of [-0.55, 0.55]) {
    const flange = at(cyl(R + 0.06, R + 0.06, 0.08, 10, PALETTE.metalDark), x, R, 0);
    flange.rotation.z = Math.PI / 2;
    g.add(flange);
  }
  for (const x of [-L / 2 + 0.05, L / 2 - 0.05]) {
    const end = at(cyl(R + 0.05, R + 0.05, 0.07, 10, PALETTE.metalDark), x, R, 0);
    end.rotation.z = Math.PI / 2;
    g.add(end);
  }
  // cradles: the `…Deep` contact tier where the run meets the ground
  for (const x of [-0.78, 0.78]) {
    g.add(at(box(0.2, R * 0.9, R * 2.4, PALETTE.metalDeep), x, (R * 0.9) / 2, 0));
  }
  const riserX = L / 2 - R;
  g.add(at(cyl(R + 0.05, R + 0.05, 0.08, 10, PALETTE.metalDark), riserX, R + 0.06, 0)); // elbow base flange
  g.add(at(cyl(R, R, 0.9, 10, PALETTE.steel), riserX, R + 0.42, 0)); // elbow up at one end
  g.add(at(cyl(R + 0.03, R + 0.03, 0.06, 10, PALETTE.steelLit), riserX, R + 0.9, 0)); // riser cap
  const stem = at(cyl(0.03, 0.03, 0.18, 6, PALETTE.metalDark), riserX - 0.14, R + 0.62, 0);
  stem.rotation.z = Math.PI / 2;
  g.add(stem); // valve stem
  const wheel = at(cyl(0.13, 0.13, 0.035, 10, PALETTE.steelLit), riserX - 0.23, R + 0.62, 0);
  wheel.rotation.z = Math.PI / 2;
  g.add(wheel); // valve wheel
}

/**
 * sandbag (10-13 prims, §3c): a `sandDeep` GROUND PAD carrying 2-3 brickwork
 * rows of squat bags, the courses value-stepped bottom-to-top (`sandDark` →
 * `dust` → `sand`, so the stack lightens as it rises out of its own shadow),
 * plus 2 `sandLit` sun-hit caps riding the top course and a `sandDeep` end
 * buttress. Three tiers on a field fortification that used to be one flat tan.
 */
const SANDBAG_ROW_HEX = [PALETTE.sandDark, PALETTE.dust, PALETTE.sand] as const;

function buildSandbag(g: THREE.Group, next: () => number): void {
  const rows = rngInt(next, 2, 3);
  g.add(at(box(1.7, 0.06, 0.5, PALETTE.sandDeep), 0, 0.03, 0)); // ground pad (contact tier)
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < 3; i++) {
      const bx = (i - 1) * 0.52 + (r % 2 === 1 ? 0.13 : -0.13);
      const bag = at(
        box(0.5, 0.2, 0.34, SANDBAG_ROW_HEX[r] ?? PALETTE.sand),
        bx + rngRange(next, -0.03, 0.03),
        0.13 + r * 0.19,
        rngRange(next, -0.03, 0.03),
      );
      bag.rotation.y = rngRange(next, -0.15, 0.15);
      g.add(bag);
    }
  }
  const topY = 0.13 + (rows - 1) * 0.19 + 0.1;
  for (const sx of [-1, 1]) {
    const cap = at(box(0.42, 0.045, 0.28, PALETTE.sandLit), sx * 0.5, topY, rngRange(next, -0.02, 0.02));
    cap.rotation.y = rngRange(next, -0.12, 0.12);
    g.add(cap); // sun-hit crest (the L3 read on a low prop)
  }
  g.add(at(box(0.14, topY - 0.02, 0.42, PALETTE.sandDeep), -0.86, (topY - 0.02) / 2, 0)); // end buttress
}

/**
 * icicle (10-12 prims, §3c): a frost formation, not three loose cones — a
 * `snowDeep` melt pool at the ground, a `snow` drift mound it grows out of,
 * 5-7 `ice`/`snowShadow` shards of mixed height and lean, and 2 `snowLit`
 * sun-catching tips. snowLit / ice / snowDeep is the three-tier break.
 */
function buildIcicle(g: THREE.Group, next: () => number): void {
  const pool = at(sphere(0.42, 7, PALETTE.snowDeep), 0, 0.02, 0);
  pool.scale.y = 0.12;
  g.add(pool); // melt pool: the contact tier
  const mound = at(sphere(0.3, 7, PALETTE.snow), rngRange(next, -0.06, 0.06), 0.05, rngRange(next, -0.06, 0.06));
  mound.scale.y = 0.4;
  g.add(mound); // drift the shards grow from
  const n = rngInt(next, 5, 7);
  for (let i = 0; i < n; i++) {
    const h = rngRange(next, 0.3, 0.9);
    const r = rngRange(next, 0.05, 0.12);
    const hex = next() < 0.6 ? PALETTE.ice : PALETTE.snowShadow;
    const shard = at(cone(r, h, 6, hex), rngRange(next, -0.3, 0.3), 0.08 + h / 2, rngRange(next, -0.3, 0.3));
    shard.rotation.z = rngRange(next, -0.12, 0.12);
    shard.rotation.x = rngRange(next, -0.12, 0.12);
    g.add(shard);
  }
  for (const sx of [-1, 1]) {
    const h = rngRange(next, 0.5, 0.95);
    const tip = at(cone(0.07, h, 6, PALETTE.snowLit), sx * rngRange(next, 0.08, 0.22), 0.1 + h / 2, rngRange(next, -0.16, 0.16));
    tip.rotation.z = rngRange(next, -0.1, 0.1);
    g.add(tip); // sun-catching crest shard
  }
}

/**
 * deskChair (14 prims, §3c): a `metalDeep` hub with FIVE CASTER ARMS, a post
 * with a `steelLit` gas-cylinder collar, a `charcoal` seat pan carrying a
 * `steel` cushion, a `charcoal` back panel with its own `steel` pad, and two
 * `metalDark` armrests. The charcoal / steel / steelLit break is what makes it
 * legible against a dark carpet instead of dissolving into it.
 */
function buildDeskChair(g: THREE.Group): void {
  g.add(at(cyl(0.1, 0.12, 0.05, 8, PALETTE.metalDeep), 0, 0.025, 0)); // hub (contact tier)
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const arm = at(box(0.26, 0.035, 0.07, PALETTE.metalDark), Math.cos(a) * 0.15, 0.03, Math.sin(a) * 0.15);
    arm.rotation.y = -a;
    g.add(arm); // caster arm
  }
  g.add(at(cyl(0.03, 0.03, 0.42, 6, PALETTE.metalDark), 0, 0.24, 0)); // post
  g.add(at(cyl(0.05, 0.05, 0.1, 8, PALETTE.steelLit), 0, 0.36, 0)); // gas-cylinder collar
  g.add(at(box(0.46, 0.06, 0.44, PALETTE.charcoal), 0, 0.47, 0)); // seat pan
  g.add(at(box(0.4, 0.05, 0.38, PALETTE.steel), 0, 0.525, 0.01)); // seat cushion
  g.add(at(box(0.44, 0.5, 0.06, PALETTE.charcoal), 0, 0.75, -0.22)); // back panel
  g.add(at(box(0.38, 0.42, 0.045, PALETTE.steel), 0, 0.76, -0.18)); // back pad
  for (const sx of [-1, 1]) {
    g.add(at(box(0.05, 0.04, 0.34, PALETTE.metalDark), sx * 0.24, 0.66, -0.06)); // armrest
  }
}

/**
 * waterCooler (12 prims, §3c): a `metalDeep` plinth under a `paper` body with a
 * recessed `steel` front panel, TWO SPIGOTS over a `metalDark` drip tray with a
 * `steelLit` grille, a `charcoal` collar, the `ice` bottle + neck, a `steelLit`
 * cap and a `snowLit` water line inside the bottle. paper / steel / metalDeep
 * is the value break; the bottle is the one cool accent.
 */
function buildWaterCooler(g: THREE.Group): void {
  g.add(at(box(0.38, 0.06, 0.38, PALETTE.metalDeep), 0, 0.03, 0)); // plinth (contact tier)
  g.add(at(box(0.34, 0.9, 0.34, PALETTE.paper), 0, 0.51, 0)); // body
  g.add(at(box(0.24, 0.34, 0.02, PALETTE.steel), 0, 0.58, 0.173)); // recessed front panel
  for (const sx of [-1, 1]) {
    const spout = at(cyl(0.018, 0.018, 0.1, 6, PALETTE.charcoal), sx * 0.07, 0.44, 0.19);
    spout.rotation.x = Math.PI / 2;
    g.add(spout); // spigot
  }
  g.add(at(box(0.22, 0.03, 0.1, PALETTE.metalDark), 0, 0.33, 0.2)); // drip tray
  g.add(at(box(0.18, 0.012, 0.07, PALETTE.steelLit), 0, 0.35, 0.2)); // tray grille
  g.add(at(box(0.36, 0.05, 0.36, PALETTE.charcoal), 0, 0.975, 0)); // collar trim
  g.add(at(cyl(0.15, 0.15, 0.42, 10, PALETTE.ice), 0, 1.21, 0)); // bottle
  g.add(at(cyl(0.152, 0.152, 0.06, 10, PALETTE.snowLit), 0, 1.36, 0)); // water line
  g.add(at(cyl(0.05, 0.05, 0.08, 8, PALETTE.ice), 0, 1.46, 0)); // neck
  g.add(at(cyl(0.055, 0.055, 0.035, 8, PALETTE.steelLit), 0, 1.5, 0)); // cap
}

/**
 * sack (9-10 prims, §3c): a `dustDeep` GROUND PAD, 4-5 slumped grain sacks
 * value-cycled across `sandDark` / `dust` / `tBrown` so the pile has internal
 * depth, 2 `sandDeep` BANDING STRAPS cinching the front bags and 2 `sandLit`
 * tied necks catching the sun. Three tiers on what used to be two brown blobs.
 */
const SACK_HEX = [PALETTE.sandDark, PALETTE.dust, PALETTE.tBrown] as const;

function buildSack(g: THREE.Group, next: () => number): void {
  const pad = at(sphere(0.5, 7, PALETTE.dustDeep), 0, 0.015, 0);
  pad.scale.y = 0.08;
  g.add(pad); // ground pad (contact tier)
  const n = rngInt(next, 4, 5);
  const tops: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i < n; i++) {
    const r = rngRange(next, 0.24, 0.34);
    const sy = rngRange(next, 0.55, 0.7);
    const x = rngRange(next, -0.28, 0.28);
    const z = rngRange(next, -0.28, 0.28);
    const y = r * 0.55 + (i >= 3 ? 0.24 : 0); // the last bags ride the pile
    const sack = at(sphere(r, 7, SACK_HEX[i % SACK_HEX.length] ?? PALETTE.dust), x, y, z);
    sack.scale.y = sy;
    sack.rotation.y = next() * Math.PI;
    g.add(sack);
    tops.push({ x, y: y + r * sy, z });
  }
  for (let i = 0; i < 2; i++) {
    const t = tops[i];
    if (t === undefined) continue;
    g.add(at(box(0.42, 0.05, 0.06, PALETTE.sandDeep), t.x, t.y * 0.62, t.z)); // banding strap
    g.add(at(cyl(0.04, 0.06, 0.09, 6, PALETTE.sandLit), t.x, t.y - 0.01, t.z)); // tied neck
  }
}

/**
 * rock / snowRock core (8-10 prims, §3c): 3-4 overlapping squashed masses in
 * `base`, 2 upward FACETS in the lit tier (a rock with no sun-facing plane is a
 * silhouette, not a form), a `deep` BASE SKIRT that beds it into the ground,
 * and 2-3 broken chips scattered at the foot. Returns the top y so callers can
 * sit a cap on it.
 */
function scatterRocks(g: THREE.Group, next: () => number, base: string, lit: string, deep: string): number {
  let top = 0;
  const skirt = at(sphere(0.66, 7, deep), 0, 0.02, 0);
  skirt.scale.y = 0.16;
  g.add(skirt); // base skirt: the contact tier, kills the floating read
  const n = rngInt(next, 3, 4);
  for (let i = 0; i < n; i++) {
    const r = rngRange(next, 0.35, 0.6);
    const sy = rngRange(next, 0.45, 0.7);
    const cy = r * 0.45;
    const m = at(sphere(r, 7, base), rngRange(next, -0.3, 0.3), cy, rngRange(next, -0.3, 0.3));
    m.scale.set(rngRange(next, 0.9, 1.3), sy, rngRange(next, 0.9, 1.3));
    m.rotation.y = next() * Math.PI;
    g.add(m);
    top = Math.max(top, cy + r * sy);
  }
  for (let i = 0; i < 2; i++) {
    const r = rngRange(next, 0.18, 0.3);
    const facet = at(sphere(r, 6, lit), rngRange(next, -0.22, 0.22), top - r * 0.2, rngRange(next, -0.22, 0.22));
    facet.scale.set(rngRange(next, 1.1, 1.5), 0.3, rngRange(next, 1.1, 1.5));
    facet.rotation.y = next() * Math.PI;
    g.add(facet); // sun-struck facet
  }
  const chips = rngInt(next, 2, 3);
  for (let i = 0; i < chips; i++) {
    const r = rngRange(next, 0.1, 0.18);
    const chip = at(sphere(r, 6, deep), rngRange(next, -0.6, 0.6), r * 0.3, rngRange(next, -0.6, 0.6));
    chip.scale.y = 0.5;
    chip.rotation.y = next() * Math.PI;
    g.add(chip); // broken chip at the foot
  }
  return top;
}

/**
 * snowRock (11-13 prims, §3c): the rock recipe in the snow family plus a `snow`
 * cap and two `snowLit` drift lips where wind has piled it against the mass.
 */
function buildSnowRock(g: THREE.Group, next: () => number): void {
  const top = scatterRocks(g, next, PALETTE.snowShadow, PALETTE.ice, PALETTE.snowDeep);
  const cap = at(sphere(0.4, 7, PALETTE.snow), 0, top + 0.05, 0);
  cap.scale.y = 0.35;
  g.add(cap);
  for (const sx of [-1, 1]) {
    const drift = at(sphere(rngRange(next, 0.22, 0.32), 6, PALETTE.snowLit), sx * 0.34, top * 0.45, rngRange(next, -0.2, 0.2));
    drift.scale.set(1.3, 0.28, 1.1);
    g.add(drift); // wind-piled drift lip
  }
}

/**
 * shrub (11 prims, §3c): a `woodDark` trunk with a `woodDeep` root flare and a
 * branch stub, a 4-sphere `leaf`/`leafDark` canopy, 2 `leafLit` sun-hit crown
 * puffs and 2 `leafDeep` under-canopy masses. leafLit / leaf / leafDeep is the
 * three-tier break that stops it reading as one green blob.
 */
function buildShrub(g: THREE.Group, next: () => number): void {
  g.add(at(cyl(0.09, 0.14, 0.09, 6, PALETTE.woodDeep), 0, 0.045, 0)); // root flare (contact tier)
  g.add(at(cyl(0.035, 0.05, 0.3, 6, PALETTE.woodDark), 0, 0.15, 0)); // trunk
  const stub = at(cyl(0.025, 0.03, 0.2, 5, PALETTE.woodDark), 0.09, 0.28, 0);
  stub.rotation.z = -0.8;
  g.add(stub); // branch stub
  for (let i = 0; i < 2; i++) {
    const r = rngRange(next, 0.24, 0.34);
    g.add(at(sphere(r, 6, PALETTE.leafDeep), rngRange(next, -0.16, 0.16), 0.3 + r * 0.35, rngRange(next, -0.16, 0.16)));
  }
  for (let i = 0; i < 4; i++) {
    const r = rngRange(next, 0.22, 0.38);
    const hex = i % 2 === 0 ? PALETTE.leaf : PALETTE.leafDark;
    g.add(at(sphere(r, 6, hex), rngRange(next, -0.18, 0.18), 0.38 + i * 0.11 + r * 0.4, rngRange(next, -0.18, 0.18)));
  }
  for (let i = 0; i < 2; i++) {
    const r = rngRange(next, 0.16, 0.24);
    g.add(at(sphere(r, 6, PALETTE.leafLit), rngRange(next, -0.16, 0.16), 0.82 + r * 0.3, rngRange(next, -0.16, 0.16)));
  }
}

/**
 * cactus (9-13 prims, §3c): a `leafDeep` root skirt, the `cactus` column with
 * two `leafLit` sun RIBS running its height, a crown, and 1-2 arms (horizontal
 * + vertical + `leafLit` tip + a `leafDeep` shaded underside at the joint).
 */
function buildCactus(g: THREE.Group, next: () => number): void {
  const H = rngRange(next, 1.1, 1.6);
  g.add(at(cyl(0.24, 0.3, 0.08, 8, PALETTE.leafDeep), 0, 0.04, 0)); // root skirt (contact tier)
  g.add(at(cyl(0.16, 0.2, H, 8, PALETTE.cactus), 0, H / 2, 0)); // column
  for (const sx of [-1, 1]) {
    g.add(at(box(0.035, H * 0.86, 0.05, PALETTE.leafLit), sx * 0.15, H * 0.5, 0.02)); // sun rib
  }
  g.add(at(sphere(0.16, 6, PALETTE.cactus), 0, H, 0)); // crown
  const arms = rngInt(next, 1, 2);
  for (let i = 0; i < arms; i++) {
    const side = i === 0 ? 1 : -1;
    const ay = H * rngRange(next, 0.45, 0.65);
    const h = at(cyl(0.1, 0.1, 0.36, 6, PALETTE.cactus), side * 0.3, ay, 0);
    h.rotation.z = Math.PI / 2;
    g.add(h);
    g.add(at(box(0.3, 0.05, 0.12, PALETTE.leafDeep), side * 0.3, ay - 0.09, 0)); // shaded underside
    g.add(at(cyl(0.1, 0.1, 0.42, 6, PALETTE.cactus), side * 0.44, ay + 0.21, 0));
    g.add(at(sphere(0.1, 6, PALETTE.leafLit), side * 0.44, ay + 0.42, 0)); // sun-hit tip
  }
}

/**
 * plant (11 prims, §3c): a `brick` pot with a `brickLit` rim, a `brickDeep`
 * base ring and a `woodDeep` soil disc, then a 5-sphere `leaf`/`leafDark`
 * canopy topped with 2 `leafLit` new growth tips.
 */
function buildPlant(g: THREE.Group, next: () => number): void {
  g.add(at(cyl(0.18, 0.2, 0.05, 8, PALETTE.brickDeep), 0, 0.025, 0)); // base ring (contact tier)
  g.add(at(cyl(0.16, 0.12, 0.3, 8, PALETTE.brick), 0, 0.15, 0)); // pot
  g.add(at(cyl(0.175, 0.175, 0.045, 8, PALETTE.brickLit), 0, 0.285, 0)); // rim
  g.add(at(cyl(0.145, 0.145, 0.02, 8, PALETTE.woodDeep), 0, 0.3, 0)); // soil
  for (let i = 0; i < 5; i++) {
    const r = rngRange(next, 0.13, 0.21);
    const hex = i % 2 === 0 ? PALETTE.leaf : PALETTE.leafDark;
    g.add(at(sphere(r, 6, hex), rngRange(next, -0.12, 0.12), 0.34 + i * 0.1, rngRange(next, -0.12, 0.12)));
  }
  for (let i = 0; i < 2; i++) {
    const r = rngRange(next, 0.09, 0.14);
    g.add(at(sphere(r, 6, PALETTE.leafLit), rngRange(next, -0.11, 0.11), 0.82 + i * 0.08, rngRange(next, -0.11, 0.11)));
  }
}

/**
 * paperStack (9-10 prims, §3c): a `plasterDeep` TRAY the pile sits in (its own
 * contact band, since a loose sheet of paper has no shadow of its own at this
 * scale), 5-6 `paper` sheets with drifted rotations, a `deskTop` manila folder
 * riding the pile and 2 `plasterDeep` cross straps. Also used as desk dressing.
 */
function buildPaperStack(g: THREE.Group, next: () => number): void {
  g.add(at(box(0.4, 0.014, 0.3, PALETTE.plasterDeep), 0, 0.007, 0)); // tray
  const n = rngInt(next, 5, 6);
  let y = 0.014;
  for (let i = 0; i < n; i++) {
    const p = at(
      box(0.32, 0.025, 0.24, PALETTE.paper),
      rngRange(next, -0.03, 0.03),
      y + 0.0125,
      rngRange(next, -0.03, 0.03),
    );
    p.rotation.y = rngRange(next, -0.4, 0.4);
    g.add(p);
    y += 0.026;
  }
  const folder = at(box(0.34, 0.02, 0.26, PALETTE.deskTop), rngRange(next, -0.02, 0.02), y + 0.01, rngRange(next, -0.02, 0.02));
  folder.rotation.y = rngRange(next, -0.3, 0.3);
  g.add(folder); // manila folder
  for (const sz of [-1, 1]) {
    g.add(at(box(0.35, y + 0.024, 0.03, PALETTE.plasterDeep), 0, (y + 0.024) / 2, sz * 0.08)); // cross strap
  }
}
