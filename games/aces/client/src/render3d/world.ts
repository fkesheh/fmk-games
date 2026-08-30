// ============================================================================
// ACES render3d/world — sea / islands / airfields / clouds (GRAPHICS_3D §4).
//
// createWorld(map) builds EVERYTHING BELOW AND ABOVE the planes from the
// frozen map data, deterministically (makeRng(map.seed) — no Math.random):
//
//   SEA        one flat Lambert plane (seaDeep, receiveShadow) oversized past
//              the map rim so the horizon is always fog, never a sea edge;
//              ~14 seeded tonal mottling blobs (Basic, seaLit/seaDark) read
//              as value patches from altitude; 6 thin sunGlare streaks in the
//              west third pulse their alpha in update().
//   ISLANDS    ExtrudeGeometry of the island blob polygon (12 spokes × r·
//              blob[i]) rising ~26u with a beveled scrub cap and darker
//              walls, on a sand skirt shelf; instanced palm trunks+canopies
//              and dodecahedron rocks at the map's own offsets with ±30%
//              scale / full-turn rotation variance (STYLE_BIBLE §6); one
//              foam surf ring per rim pulsing via a shared material.
//   AIRFIELDS  graded landfall (packed-sand deck top ~0.4u over sea, bodies
//              sunk below the waterline, sand→wet-sand→foam skirt) + team-
//              coloured wind square on a wood pole + parked reserve crates —
//              landmarks, not sets.
//   CLOUDS     THREE bands of TWO-TONE puff masses (alpha ≤ 0.78) drifting
//              EAST and wrapping around the map bounds, thinned over the
//              central corridor (keep ×0.62, size ×0.72, alpha ×0.85 — mirrors
//              render/world.ts's 2D laws): an OVER-NOSE deck Y 34–60 (7 large
//              masses, undersides a clean 12–26u above the Y≈22 chase cam —
//              F1 re-band), a towering HIGH deck Y 55–90 (7 masses whose
//              distant bodies fill the upper frame like real sky — F1
//              re-band; fog washes the far ones = correct aerial perspective,
//              in-corridor thinning keeps the nearest few reading with
//              contrast), and a LOW MIST band Y 7–12 below cruise altitude
//              (12 sparse flat wisps the player overflies — F4, unchanged).
//              F3 ANTI-CREAM LAW: every mass is a lit-top + shaded-underside
//              object — an upper/outer cross-quad pair in a paper→seaDark
//              ~0.18-family lit tint (cooler/grayer than the dawnHi sky) over
//              a lower/rear pair in a deepened shadeA('haze',−0.5) warm
//              gray-blue extended to overlap the lit pair — the UNDERSIDE
//              tone carries the silhouette now, because the chase cam sees
//              every mass from below (F1: clearly darker than the sky at any
//              distance) — plus a soft ink-tinted base rim quad on the
//              heavier puffs, so at any chase angle a cloud reads as an
//              OBJECT against the sky, never a cream smudge. Baked as
//              per-cloud vertex-RGBA quads (one shared material, one draw
//              call per mass). Their cloud shadows are ONE InstancedMesh of
//              flat seaDark puffs (opacity 0.22), offset east-south per band
//              off the ~35° western sun, drifting with them.
//
// PERF LAW: update(tS, camPos) allocates NOTHING — positions wrap by
// arithmetic, shadow matrices are prebuilt and only re-translated, every
// animated value is a number write to a cached material. All colors flow
// through pal()/mixA()/shadeA(); all materials come from the frozen factory;
// the only texture is THE shared puff model. Draw calls: ~90 steady state
// (1 sea + 14 mottling + 6 glints + 24 island parts + ~16 airfield landfall
// (4 graded layers ×2 fields) + 3 instanced + ≤26 clouds + 1 shadow IM) —
// inside the ≤120 budget with room
// for W2/W3 planes, tracers and effects.
//
// DEVIATIONS (reported): the brief says "billboard Sprites" — THREE.Sprite
// requires SpriteMaterial, which the frozen materials factory cannot express
// (factory law forbids constructing materials elsewhere), so clouds use
// cross-quad meshes (two perpendicular quads, both windings) sampling the
// SAME puffTexture: visible from any camera yaw, zero per-frame orientation
// work. F3 two-tone extension: the factory also has no vertex-colored
// textured path, so — matching the effects3d.ts bucket precedent — the ONE
// cloud material (map + vertexColors + transparent) is constructed here ONCE;
// every color remains APAL-derived, baked into per-cloud vertex RGBA from
// pal()/mixA()/shadeA() at build time (draw calls stay one per mass).
// F1 GEOMETRY FIX (reported): the raw cross-quads carried NO uv attribute, so
// the mapped puffTexture sampled texel (0,0) for every fragment — three.js
// Material.defaultAttributeValues.uv = [0,0] — which is the transparent
// canvas corner: every mass rendered fully transparent (judge evidence:
// shadows visible, cloud objects in zero frames). pushQuad now bakes per-quad
// 0..1 UVs (PlaneGeometry law) at build time; no new allocations, materials,
// or draw calls. Bands re-raised per the F1 brief (Y 34–60 / Y 55–90).
// ============================================================================

import * as THREE from 'three';
import type { AcesMap } from '@aces/shared/maps.js';
import { makeRng, mixA, shadeA } from '../contract/visual.js';
import { matBasic, matLambert, pal, puffTexture } from './materials.js';

export interface AcesWorld {
  /** Added to the scene by the app (mount via rig.getCam().parent). */
  group: THREE.Group;
  /** Cloud drift, surf pulse, glint shimmer, cloud shadows. Zero allocation. */
  update(tS: number, camPos: { x: number; y: number }): void;
  dispose(): void;
}

// ---- tunables (mirroring the frozen 2D world module where laws exist) -------

/** Central open corridor (maps.ts buildMap LANE) — clouds thin here. */
const CORRIDOR_HALF = 340;
const CORRIDOR_KEEP = 0.62; //   brief: keep factor 0.62 in-corridor
const CORRIDOR_SHRINK = 0.72; // mirrors 2D buildLayer size cut
const CORRIDOR_ALPHA = 0.85; //  mirrors 2D buildLayer alpha cut

const SEA_PAD = 1400;
const MOTTLE_COUNT = 14;
const GLINT_COUNT = 6;

const ISLAND_BASE_Y = -4; //    skirt sinks below the waterline
const ISLAND_DEPTH = 26; //     brief: extrude depth ~26u
const BEVEL_T = 4;
const BEVEL_S = 8;
const SKIRT_SCALE = 1.16;
const SKIRT_DEPTH = 6;
/** World Y of the island top cap (geometry spans base−bevel .. depth+bevel). */
const PROP_Y = ISLAND_BASE_Y + ISLAND_DEPTH + BEVEL_T;
const SURF_Y = 0.35;
const SURF_INNER = 1.1;
const SURF_OUTER = 1.24;

const CLOUD_HIGH_COUNT = 7; //   F1 re-band — towering Y 55–90 deck
const CLOUD_MID_COUNT = 7; //    F1 re-band — over-nose deck Y 34–60, undersides
                                // a clean 12–26u above the Y≈22 chase cam
const CLOUD_LOW_COUNT = 12; //   sparse low mist band BELOW cruise alt (F4)
const CLOUD_MARGIN = 700;
const CLOUD_ALPHA_MAX = 0.78; // STYLE_BIBLE §6 hard cap
const CLOUD_ALPHA_MIN = 0.12;
// F3 two-tone anti-cream tunables — every value APAL-derived via helpers.
const CLOUD_LIT_MIN = 0.12; //   lit tint = mixA('paper','seaDark', t), the
const CLOUD_LIT_SPAN = 0.12; //  0.12–0.24 band centered on the ~0.18 cooler-
                               // than-sky nudge the F3 brief names
const CLOUD_MIST_LIT_MIN = 0.45; // mist stays seaDark-leaning (reads against
const CLOUD_MIST_LIT_SPAN = 0.25; // sea below AND sky at the horizon)
const CLOUD_SHADE = shadeA('haze', -0.5); // shaded underside (warm gray-blue) —
                                          // F1: deepened from −0.35 so the tone
                                          // the cam sees from below stays clearly
                                          // darker than the sky at any distance
const CLOUD_HEAVY_ALPHA = 0.55; // puffs at/above this get the ink base rim
const CLOUD_RIM_ALPHA = 0.55; //  ink rim softness relative to the cloud alpha
const SHADOW_OPACITY = 0.22; //  §6/§3 cap 0.25
/** Shadow throws fall EAST-SOUTH off the ~35° western sun (scene.ts SUN_DIR),
 *  scaled per band as ~height/tan(34°) and split along the sun's horizontal
 *  direction (0.964 east, 0.265 south): high deck Y55–90 ≈108u, over-nose
 *  deck Y34–60 ≈70u, mist ≈14u. */
const SHADOW_OFF_X = 104;
const SHADOW_OFF_Z = 28;
const MID_OFF_X = 67;
const MID_OFF_Z = 18;
const MIST_OFF_X = 14;
const MIST_OFF_Z = 4;
const SHADOW_Y = 0.18;

const FOAM_BASE = 0.3;
const FOAM_AMP = 0.14;
const FOAM_FREQ = 1.35;

// ---------------------------------------------------------------------------
// Cloud puff geometry (F3 anti-cream): each mass is ONE merged, vertex-RGBA
// geometry of soft quads — a LIT upper/outer cross-quad pair (both windings,
// visible from any camera yaw) and a SHADED lower/rear pair tucked beneath
// it, plus a horizontal ink-tinted base rim quad on heavier puffs. Hard
// two-tone break at the quad seam (flat-ink law — no gradient within a
// shape); the shared puffTexture supplies the soft edges. All tints/alphas
// are baked per cloud at build time from pal()/mixA()/shadeA(); alpha ≤ the
// 0.78 cap rides the vertex.
// ---------------------------------------------------------------------------

/** Emit one soft quad (both windings, FrontSide-safe from any yaw) as six
 *  vertices with the given RGBA baked into every vertex and the puff texture
 *  mapped 0..1 across the quad's own extent (corners arrive in BL, BR, TL,
 *  TR order — PlaneGeometry UV law). Zero allocation at frame time —
 *  build-time only. Without a uv attribute the mapped texture would sample
 *  three.js's default generic value uv (0,0) — the transparent canvas
 *  corner — and the whole mass would render invisible (F1). */
function pushQuad(
  pos: number[],
  col: number[],
  uv: number[],
  rgba: readonly [number, number, number, number],
  v0: readonly [number, number, number],
  v1: readonly [number, number, number],
  v2: readonly [number, number, number],
  v3: readonly [number, number, number],
): void {
  const [r, g, b, a] = rgba as [number, number, number, number];
  const push = (v: readonly [number, number, number], u: number, w: number): void => {
    pos.push(v[0]!, v[1]!, v[2]!);
    col.push(r, g, b, a);
    uv.push(u, w);
  };
  push(v0, 0, 0);
  push(v1, 1, 0);
  push(v2, 0, 1);
  push(v1, 1, 0);
  push(v3, 1, 1);
  push(v2, 0, 1);
  push(v2, 0, 1);
  push(v1, 1, 0);
  push(v0, 0, 0);
  push(v2, 0, 1);
  push(v3, 1, 1);
  push(v1, 1, 0);
}

/** Build one two-tone cloud mass geometry (unit footprint −0.5..0.5 in X/Z,
 *  y −0.54..0.52; the mesh scale applies the band size). The shaded underside
 *  pair reaches +0.10 INTO the lit pair (F1: the below-view silhouette is
 *  underside-dominated, and the overlap seals the coplanar seam). */
function buildCloudGeometry(
  litHex: string,
  shadeHex: string,
  alpha: number,
  heavy: boolean,
): THREE.BufferGeometry {
  const lit = new THREE.Color(litHex);
  const shade = new THREE.Color(shadeHex);
  const rim = new THREE.Color(pal('ink'));
  const litC: [number, number, number, number] = [lit.r, lit.g, lit.b, alpha];
  const shadeC: [number, number, number, number] = [shade.r, shade.g, shade.b, alpha];
  const rimC: [number, number, number, number] = [rim.r, rim.g, rim.b, alpha * CLOUD_RIM_ALPHA];
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  // lit upper/outer cross pair (paper→seaDark family — cooler than the sky)
  pushQuad(pos, col, uv, litC, [-0.5, 0, 0], [0.5, 0, 0], [-0.5, 0.52, 0], [0.5, 0.52, 0]);
  pushQuad(pos, col, uv, litC, [0, 0, -0.5], [0, 0, 0.5], [0, 0.52, -0.5], [0, 0.52, 0.5]);
  // shaded lower/rear cross pair (deep warm gray-blue, extended over the seam)
  pushQuad(pos, col, uv, shadeC, [-0.4, -0.54, 0], [0.4, -0.54, 0], [-0.4, 0.1, 0], [0.4, 0.1, 0]);
  pushQuad(
    pos,
    col,
    uv,
    shadeC,
    [0, -0.54, -0.4],
    [0, -0.54, 0.4],
    [0, 0.1, -0.4],
    [0, 0.1, 0.4],
  );
  // heavy puffs: soft ink-tinted rim quad at the base (horizontal, both sides)
  if (heavy) {
    pushQuad(
      pos,
      col,
      uv,
      rimC,
      [-0.52, -0.44, -0.3],
      [0.52, -0.44, -0.3],
      [-0.52, -0.44, 0.3],
      [0.52, -0.44, 0.3],
    );
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

interface CloudRec {
  mesh: THREE.Mesh;
  x0: number;
  z: number;
  speed: number;
  /** Per-band shadow throw (east-south off the western sun). */
  shOffX: number;
  shOffZ: number;
}

/** Flat soft blob under a cloud — same texture, seaDark tint (§6). */
function buildShadowGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

/**
 * Build the whole ACES world from frozen map data. Deterministic per seed.
 */
export function createWorld(map: AcesMap): AcesWorld {
  const rng = makeRng(map.seed >>> 0);
  const group = new THREE.Group();
  group.name = 'aces-world';

  const ownedGeos: THREE.BufferGeometry[] = [];
  const ownedTexs: THREE.Texture[] = [];
  const clouds: CloudRec[] = [];
  const glints: { mat: THREE.MeshBasicMaterial; base: number; freq: number; phase: number }[] = [];
  let foamMat: THREE.MeshBasicMaterial | null = null;
  let shadowIM: THREE.InstancedMesh | null = null;
  const shadowBases: THREE.Matrix4[] = [];

  // THE one soft-mass texture, sampled once and shared (clouds + shadows).
  const puffTex = puffTexture();
  ownedTexs.push(puffTex);
  const withPuff = (m: THREE.MeshBasicMaterial): THREE.MeshBasicMaterial => {
    if (!m.map) {
      m.map = puffTex;
      m.needsUpdate = true;
    }
    return m;
  };

  // ---- sea ------------------------------------------------------------------

  const seaGeo = new THREE.PlaneGeometry(map.w + SEA_PAD, map.h + SEA_PAD);
  seaGeo.rotateX(-Math.PI / 2);
  ownedGeos.push(seaGeo);
  const sea = new THREE.Mesh(seaGeo, matLambert(pal('seaDeep')));
  sea.position.set(map.w / 2, 0, map.h / 2);
  sea.receiveShadow = true;
  group.add(sea);

  // ---- sea mottling: large irregular tonal patches (never rectangles) --------

  const mottleGeo = new THREE.CircleGeometry(1, 10);
  mottleGeo.rotateX(-Math.PI / 2);
  ownedGeos.push(mottleGeo);
  for (let i = 0; i < MOTTLE_COUNT; i++) {
    const key = i % 2 === 0 ? pal('seaLit') : pal('seaDark');
    const m = matBasic(key, { transparent: true, opacity: 0.14 + rng() * 0.12, depthWrite: false });
    const mesh = new THREE.Mesh(mottleGeo, m);
    mesh.position.set(100 + rng() * (map.w - 200), 0.06 + i * 0.004, 100 + rng() * (map.h - 200));
    mesh.scale.set(200 + rng() * 340, 1, 120 + rng() * 260);
    group.add(mesh);
  }

  // ---- sun glints: thin bright streaks in the west third ----------------------

  const glintGeo = new THREE.PlaneGeometry(1, 1);
  glintGeo.rotateX(-Math.PI / 2);
  ownedGeos.push(glintGeo);
  for (let i = 0; i < GLINT_COUNT; i++) {
    const base = 0.25 + rng() * 0.25;
    const m = matBasic(pal('sunGlare'), { transparent: true, opacity: base, depthWrite: false });
    const mesh = new THREE.Mesh(glintGeo, m);
    mesh.scale.set(220 + rng() * 220, 1, 5 + rng() * 8);
    mesh.position.set(map.w * (0.04 + rng() * 0.26), 0.12 + i * 0.01, map.h * (0.22 + rng() * 0.56));
    mesh.rotation.y = (rng() - 0.5) * 0.12;
    glints.push({ mat: m, base, freq: 0.5 + rng() * 0.7, phase: rng() * Math.PI * 2 });
    group.add(mesh);
  }

  // ---- islands -----------------------------------------------------------------

  const capMat = matLambert(pal('scrub'));
  const wallMat = matLambert(shadeA('scrub', -0.18));
  const skirtMat = matLambert(pal('sand'));
  foamMat = matBasic(pal('foam'), {
    transparent: true,
    opacity: FOAM_BASE + FOAM_AMP,
    depthWrite: false,
  });

  interface Spot {
    x: number;
    z: number;
    s: number;
  }
  const palmSpots: Spot[] = [];
  const rockSpots: Spot[] = [];

  for (const isl of map.islands) {
    // Blob polygon: shape-Y is negated so that after rotateX(-π/2) world Z
    // equals map-local y EXACTLY (coordinate law §1) — props then place at
    // (isl.x + px, ·, isl.y + py) directly.
    const shapePts: THREE.Vector2[] = [];
    const skirtPts: THREE.Vector2[] = [];
    let rSum = 0;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const rad = isl.r * (isl.blob[i] ?? 1);
      rSum += rad;
      shapePts.push(new THREE.Vector2(Math.cos(a) * rad, -Math.sin(a) * rad));
      skirtPts.push(new THREE.Vector2(Math.cos(a) * rad * SKIRT_SCALE, -Math.sin(a) * rad * SKIRT_SCALE));
    }
    const avgR = rSum / 12;

    const islGeo = new THREE.ExtrudeGeometry(new THREE.Shape(shapePts), {
      steps: 1,
      depth: ISLAND_DEPTH,
      bevelEnabled: true,
      bevelThickness: BEVEL_T,
      bevelSize: BEVEL_S,
      bevelSegments: 1,
    });
    islGeo.rotateX(-Math.PI / 2);
    ownedGeos.push(islGeo);
    // Extrude groups: 0 = caps, 1 = side walls.
    const body = new THREE.Mesh(islGeo, [capMat, wallMat]);
    body.position.set(isl.x, ISLAND_BASE_Y, isl.y);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const skirtGeo = new THREE.ExtrudeGeometry(new THREE.Shape(skirtPts), {
      steps: 1,
      depth: SKIRT_DEPTH,
      bevelEnabled: false,
    });
    skirtGeo.rotateX(-Math.PI / 2);
    ownedGeos.push(skirtGeo);
    const skirt = new THREE.Mesh(skirtGeo, skirtMat);
    skirt.position.set(isl.x, ISLAND_BASE_Y, isl.y);
    skirt.receiveShadow = true;
    group.add(skirt);

    // Surf ring pulsing at the island rim (shared foam material).
    const surfGeo = new THREE.RingGeometry(avgR * SURF_INNER, avgR * SURF_OUTER, 48);
    surfGeo.rotateX(-Math.PI / 2);
    ownedGeos.push(surfGeo);
    const surf = new THREE.Mesh(surfGeo, foamMat);
    surf.position.set(isl.x, SURF_Y, isl.y);
    group.add(surf);

    for (const p of isl.palms) palmSpots.push({ x: isl.x + p.x, z: isl.y + p.y, s: p.s });
    for (const r of isl.rocks) rockSpots.push({ x: isl.x + r.x, z: isl.y + r.y, s: r.s });
  }

  // ---- palms: instanced trunk + canopy across ALL islands ----------------------

  if (palmSpots.length > 0) {
    const trunkGeo = new THREE.CylinderGeometry(0.55, 1.05, 1, 5);
    const canopyGeo = new THREE.ConeGeometry(1, 1, 6);
    ownedGeos.push(trunkGeo, canopyGeo);
    const trunks = new THREE.InstancedMesh(trunkGeo, matLambert(pal('wood')), palmSpots.length);
    const canopies = new THREE.InstancedMesh(canopyGeo, matLambert(pal('canopy')), palmSpots.length);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < palmSpots.length; i++) {
      const spot = palmSpots[i] as Spot;
      // Variation law (STYLE_BIBLE §6): scale ±30%, rotation full circle.
      const sv = spot.s * (0.7 + rng() * 0.6);
      const yaw = rng() * Math.PI * 2;
      const trunkH = 9 * sv;
      dummy.position.set(spot.x, PROP_Y - 1 + trunkH / 2, spot.z);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(sv, trunkH, sv);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      const canH = 5 * sv;
      dummy.position.set(spot.x, PROP_Y - 1 + trunkH + canH / 2 - 0.6, spot.z);
      dummy.rotation.set(0, yaw + rng() * 0.8 - 0.4, 0);
      dummy.scale.set(6.5 * sv, canH, 6.5 * sv);
      dummy.updateMatrix();
      canopies.setMatrixAt(i, dummy.matrix);
    }
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    trunks.castShadow = true;
    canopies.castShadow = true;
    group.add(trunks, canopies);
  }

  // ---- rocks: instanced dodecahedra, half-buried --------------------------------

  if (rockSpots.length > 0) {
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    ownedGeos.push(rockGeo);
    const rocks = new THREE.InstancedMesh(rockGeo, matLambert(pal('rock')), rockSpots.length);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < rockSpots.length; i++) {
      const spot = rockSpots[i] as Spot;
      const sv = spot.s * (0.7 + rng() * 0.6);
      dummy.position.set(spot.x, PROP_Y - 2.2 + sv * 1.4, spot.z);
      dummy.rotation.set(rng() * 0.5, rng() * Math.PI * 2, rng() * 0.5);
      dummy.scale.set(3.4 * sv, 2.5 * sv, 3.2 * sv);
      dummy.updateMatrix();
      rocks.setMatrixAt(i, dummy.matrix);
    }
    rocks.instanceMatrix.needsUpdate = true;
    rocks.castShadow = true;
    group.add(rocks);
  }

  // ---- airfields: graded landfall + team wind square + parked crates ------------

  // Airfield landfall law (integrator brief): the deck TOP sits ~0.4u above
  // sea level and every body extends DOWNWARD below the waterline — no
  // visible underside gap, so the strip reads as landfall, not a raft.
  // Grading steps outward from the packed-sand deck through sand berm and
  // wet fringe to a foam washline (APAL keys only, via pal/shadeA).
  const DECK_TOP = 0.4;
  const DECK_H = 6; //      thick enough that no underside shows in any shot
  const BERM_TOP = 0.26;
  const BERM_H = 3;
  const FRINGE_TOP = 0.13;
  const FRINGE_H = 2;
  const FOAM_TOP = 0.06;
  const FOAM_H = 1.4;
  const crateMat = matLambert(pal('wood'));
  const poleMat = matLambert(pal('wood'));
  for (const f of map.fields) {
    const layers: ReadonlyArray<{
      w: number;
      d: number;
      top: number;
      h: number;
      hex: string;
    }> = [
      { w: 500, d: 58, top: DECK_TOP, h: DECK_H, hex: shadeA('sand', -0.08) }, // packed deck
      { w: 556, d: 108, top: BERM_TOP, h: BERM_H, hex: pal('sand') }, //         sand berm
      { w: 610, d: 152, top: FRINGE_TOP, h: FRINGE_H, hex: shadeA('sand', -0.18) }, // wet fringe
      { w: 650, d: 184, top: FOAM_TOP, h: FOAM_H, hex: pal('foam') }, //         foam washline
    ];
    for (const layer of layers) {
      const geo = new THREE.BoxGeometry(layer.w, layer.h, layer.d);
      ownedGeos.push(geo);
      const mesh = new THREE.Mesh(geo, matLambert(layer.hex));
      mesh.position.set(f.x, layer.top - layer.h / 2, f.y);
      mesh.rotation.y = -f.h;
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    const cosH = Math.cos(f.h);
    const sinH = Math.sin(f.h);
    const px = f.x - cosH * 260;
    const pz = f.y - sinH * 260;

    const poleGeo = new THREE.CylinderGeometry(0.5, 0.5, 15, 5);
    ownedGeos.push(poleGeo);
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(px, DECK_TOP + 7.5, pz); // planted into the deck top
    pole.castShadow = true;
    group.add(pole);

    const squareGeo = new THREE.PlaneGeometry(13, 13);
    ownedGeos.push(squareGeo);
    const teamKey = f.team === 'royal' ? pal('royalNavy') : pal('ironRed');
    const square = new THREE.Mesh(squareGeo, matBasic(teamKey));
    square.position.set(px, DECK_TOP + 13.1, pz);
    square.rotation.y = Math.atan2(-cosH, -sinH); // face the taking-off pilot's camera
    group.add(square);

    const crateGeo = new THREE.BoxGeometry(11, 11, 11);
    ownedGeos.push(crateGeo);
    for (const c of f.parkedCrates) {
      const crate = new THREE.Mesh(crateGeo, crateMat);
      crate.position.set(c.x, DECK_TOP + 5.5, c.y); // resting on the deck top
      crate.castShadow = true;
      group.add(crate);
    }
  }

  // ---- clouds: two-tone vertex-colored masses + ONE instanced shadow layer -----

  const span = map.w + CLOUD_MARGIN * 2;

  interface CloudSpec {
    readonly count: number;
    readonly yMin: number;
    readonly yMax: number;
    readonly rMin: number;
    readonly rMax: number;
    readonly aBase: number;
    readonly aSpan: number;
    readonly speed: number;
    /** Puff quad scale multipliers — mist lies flat, high deck towers. */
    readonly wMul: number;
    readonly hMul: number;
    /** Lit tint = mixA('paper','seaDark', t) with t ∈ [litMin, litMin+litSpan]
     *  drawn ACROSS puffs (kit law; F3 cooler/grayer-than-sky family). */
    readonly litMin: number;
    readonly litSpan: number;
    readonly shOffX: number;
    readonly shOffZ: number;
  }
  // F1 THREE-BAND sky (geometry fix): the chase cam cruises at Y≈22 (plane 12
  // + CAM_HEIGHT 10) looking DOWN at the plane — the old Y16–32 decks sat
  // at/below the lens and could only clip the horizon sliver, so the
  // over-nose band moves UP to Y 34–60 (undersides 12–26u above the cam) and
  // the high deck to Y 55–90, with radii scaled up dramatically (120–240u
  // mid, 180–420u high) so distant masses fill the upper frame like real
  // sky. Fog washes the far ones — correct aerial perspective; the
  // in-corridor thinning (below) keeps the NEAREST few reading with
  // contrast, and the deepened undersides carry the tone from below. The
  // LOW MIST band (Y 7–12, below cruise) stays for overflight wisps (F4).
  // All bands drift east; corridor thinning applies to all three (mirrors
  // the 2D module's layer laws).
  const specs: ReadonlyArray<CloudSpec> = [
    {
      count: CLOUD_MID_COUNT,
      yMin: 34,
      yMax: 60,
      rMin: 120,
      rMax: 240,
      aBase: 0.55,
      aSpan: 0.23,
      speed: 11,
      wMul: 2.6,
      hMul: 1.7,
      litMin: CLOUD_LIT_MIN,
      litSpan: CLOUD_LIT_SPAN,
      shOffX: MID_OFF_X,
      shOffZ: MID_OFF_Z,
    },
    {
      count: CLOUD_HIGH_COUNT,
      yMin: 55,
      yMax: 90,
      rMin: 180,
      rMax: 420,
      aBase: 0.5,
      aSpan: 0.22,
      speed: 11,
      wMul: 2.6,
      hMul: 1.7,
      litMin: CLOUD_LIT_MIN,
      litSpan: CLOUD_LIT_SPAN,
      shOffX: SHADOW_OFF_X,
      shOffZ: SHADOW_OFF_Z,
    },
    {
      count: CLOUD_LOW_COUNT,
      yMin: 7,
      yMax: 12,
      rMin: 30,
      rMax: 60,
      aBase: 0.22,
      aSpan: 0.14,
      speed: 6,
      wMul: 2.2,
      hMul: 0.55,
      litMin: CLOUD_MIST_LIT_MIN,
      litSpan: CLOUD_MIST_LIT_SPAN,
      shOffX: MIST_OFF_X,
      shOffZ: MIST_OFF_Z,
    },
  ];
  // F3 two-tone clouds: ONE shared vertex-colored material (see header
  // deviation); per-cloud tint/alpha live in the vertex RGBA, so the masses
  // still vary across the kit while draw calls stay at one per mass.
  const cloudMat = new THREE.MeshBasicMaterial({
    map: puffTex,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  });
  for (const spec of specs) {
    let placed = 0;
    let tries = 0;
    while (placed < spec.count && tries < spec.count * 15) {
      tries++;
      const x0 = rng() * span - CLOUD_MARGIN;
      const z = rng() * map.h;
      const inCorridor = Math.abs(z - map.h / 2) < CORRIDOR_HALF;
      if (inCorridor && rng() >= CORRIDOR_KEEP) continue;
      const shrink = inCorridor ? CORRIDOR_SHRINK : 1;
      const alphaCut = inCorridor ? CORRIDOR_ALPHA : 1;
      const rBase = spec.rMin + rng() * (spec.rMax - spec.rMin);
      const r = rBase * shrink;
      const alpha = Math.max(
        CLOUD_ALPHA_MIN,
        Math.min(CLOUD_ALPHA_MAX, (spec.aBase + rng() * spec.aSpan) * alphaCut),
      );
      // F3: lit top in the paper→seaDark ~0.18 family (cooler/grayer than
      // the dawnHi sky), deep shadeA('haze',−0.5) underside that carries the
      // below-view silhouette (F1), ink base rim on the
      // heavy puffs — a lit-top/shaded-underside OBJECT at any chase angle.
      const lit = mixA('paper', 'seaDark', spec.litMin + rng() * spec.litSpan);
      const geo = buildCloudGeometry(lit, CLOUD_SHADE, alpha, alpha >= CLOUD_HEAVY_ALPHA);
      ownedGeos.push(geo);
      const mesh = new THREE.Mesh(geo, cloudMat);
      mesh.position.set(x0, spec.yMin + rng() * (spec.yMax - spec.yMin), z);
      mesh.scale.set(r * spec.wMul, r * spec.hMul, r * spec.wMul);
      mesh.renderOrder = 6;
      group.add(mesh);
      clouds.push({
        mesh,
        x0,
        z,
        speed: spec.speed,
        shOffX: spec.shOffX,
        shOffZ: spec.shOffZ,
      });
      placed++;
    }
  }

  if (clouds.length > 0) {
    const shadowGeo = buildShadowGeometry();
    ownedGeos.push(shadowGeo);
    const shadowMat = withPuff(
      matBasic(pal('seaDark'), { transparent: true, opacity: SHADOW_OPACITY, depthWrite: false }),
    );
    shadowIM = new THREE.InstancedMesh(shadowGeo, shadowMat, clouds.length);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < clouds.length; i++) {
      const c = clouds[i] as CloudRec;
      const s = c.mesh.scale;
      dummy.position.set(c.x0 + c.shOffX, SHADOW_Y, c.z + c.shOffZ);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(s.x * 1.15, 1, s.z * 1.15);
      dummy.updateMatrix();
      shadowIM.setMatrixAt(i, dummy.matrix);
      shadowBases.push(dummy.matrix.clone());
    }
    shadowIM.instanceMatrix.needsUpdate = true;
    shadowIM.frustumCulled = false; // instances span the whole map
    group.add(shadowIM);
  }

  // ---- frame update ---------------------------------------------------------------

  const wrapX = (raw: number): number =>
    (((raw + CLOUD_MARGIN) % span) + span) % span - CLOUD_MARGIN;

  return {
    group,

    update(tS: number, _camPos: { x: number; y: number }): void {
      // Cloud drift EAST (+x) with wraparound; shadows ride along, offset
      // east-south off the low western sun. Pure arithmetic — no allocation.
      for (let i = 0; i < clouds.length; i++) {
        const c = clouds[i] as CloudRec;
        const cx = wrapX(c.x0 + c.speed * tS);
        c.mesh.position.x = cx;
        const m = shadowBases[i] as THREE.Matrix4;
        m.setPosition(cx + c.shOffX, SHADOW_Y, c.z + c.shOffZ);
        if (shadowIM) shadowIM.setMatrixAt(i, m);
      }
      if (shadowIM) shadowIM.instanceMatrix.needsUpdate = true;

      // Surf pulse: one shared foam material breathes for every rim.
      if (foamMat) foamMat.opacity = FOAM_BASE + FOAM_AMP * Math.sin(tS * FOAM_FREQ);

      // Sun-glint shimmer in the western band.
      for (let i = 0; i < glints.length; i++) {
        const g = glints[i] as { mat: THREE.MeshBasicMaterial; base: number; freq: number; phase: number };
        g.mat.opacity = g.base * (0.55 + 0.45 * Math.sin(tS * g.freq + g.phase));
      }
    },

    dispose(): void {
      // Geometries and textures are ours; factory-cached materials stay in
      // the frozen factory's global cache (shared with other modules — never
      // disposed). The ONE direct cloud material is ours alone — freed here.
      for (const geo of ownedGeos) geo.dispose();
      for (const tex of ownedTexs) tex.dispose();
      if (shadowIM) shadowIM.dispose(); // frees the instanceMatrix attribute
      cloudMat.dispose();
      ownedGeos.length = 0;
      ownedTexs.length = 0;
      clouds.length = 0;
      shadowBases.length = 0;
      glints.length = 0;
    },
  };
}
