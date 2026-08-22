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
//   CLOUDS     TWO bands of puffTexture cross-quads (alpha ≤ 0.78) drifting
//              EAST and wrapping around the map bounds, thinned over the
//              central corridor (keep ×0.62, size ×0.72, alpha ×0.85 — mirrors
//              render/world.ts's 2D laws): a reduced high deck Y 26–32
//              (14 large puffs, paper↔dawnHi) and a LOW MIST band Y 7–12
//              below cruise altitude (12 sparse flat seaDark↔paper wisps the
//              player overflies — F4). Their cloud shadows are ONE
//              InstancedMesh of flat seaDark puffs (opacity 0.22), offset
//              east-south per band off each cloud, drifting with them.
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
// work, one geometry shared by all clouds.
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

const CLOUD_HIGH_COUNT = 14; //   reduced high deck — fewer, LARGER puffs (F4)
const CLOUD_LOW_COUNT = 12; //    sparse low mist band BELOW cruise alt (F4)
const CLOUD_MARGIN = 700;
const CLOUD_ALPHA_MAX = 0.78; // STYLE_BIBLE §6 hard cap
const CLOUD_ALPHA_MIN = 0.12;
const SHADOW_OPACITY = 0.22; //  §6/§3 cap 0.25
/** Shadow offsets fall EAST-SOUTH off the low western sun; per-band because
 *  the throw scales with cloud height (~height/tan(21°)). */
const SHADOW_OFF_X = 95;
const SHADOW_OFF_Z = 45;
const MIST_OFF_X = 26;
const MIST_OFF_Z = 13;
const SHADOW_Y = 0.18;

const FOAM_BASE = 0.3;
const FOAM_AMP = 0.14;
const FOAM_FREQ = 1.35;

// ---------------------------------------------------------------------------
// Cloud puff geometry: two unit quads crossing on the Y axis (XY plane +
// ZY plane), each emitted with BOTH windings so FrontSide culling can never
// hide a face from any camera yaw. ONE instance is shared by every cloud.
// ---------------------------------------------------------------------------

function buildPuffGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        -0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0,
        0, -0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5, 0.5,
      ]),
      3,
    ),
  );
  g.setAttribute(
    'uv',
    new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1]), 2),
  );
  g.setIndex([0, 1, 2, 1, 3, 2, 2, 1, 0, 2, 3, 1, 4, 5, 6, 5, 7, 6, 6, 5, 4, 6, 7, 5]);
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

  // ---- clouds: puff cross-quads + ONE instanced shadow layer ----------------------

  const puffGeo = buildPuffGeometry();
  ownedGeos.push(puffGeo);
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
    /** paper↔X mix endpoints (APAL keys) expressed ACROSS puffs. */
    readonly tintB: 'dawnHi' | 'seaDark';
    readonly shOffX: number;
    readonly shOffZ: number;
  }
  // F4 TWO-BAND sky: the chase cam cruises at Y≈22 looking level/down, so the
  // old single Y26–34 deck sat above every frame. High deck is REDUCED but
  // larger; the new LOW MIST band (Y 7–12, below cruise altitude) gives the
  // player soft seaDark/paper wisps to overfly. Both drift east; corridor
  // thinning applies to both (mirrors the 2D module's layer laws).
  const specs: ReadonlyArray<CloudSpec> = [
    {
      count: CLOUD_HIGH_COUNT,
      yMin: 26,
      yMax: 32,
      rMin: 95,
      rMax: 170,
      aBase: 0.34,
      aSpan: 0.2,
      speed: 11,
      wMul: 2.6,
      hMul: 1.7,
      tintB: 'dawnHi',
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
      tintB: 'seaDark',
      shOffX: MIST_OFF_X,
      shOffZ: MIST_OFF_Z,
    },
  ];
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
      // paper ↔ dawnHi / seaDark mixes expressed ACROSS puffs (kit law)
      const tint = mixA('paper', spec.tintB, rng());
      const m = withPuff(matBasic(tint, { transparent: true, opacity: alpha, depthWrite: false }));
      const mesh = new THREE.Mesh(puffGeo, m);
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
      // Geometries and textures are ours; materials stay in the frozen
      // factory's global cache (shared with other modules — never disposed).
      for (const geo of ownedGeos) geo.dispose();
      for (const tex of ownedTexs) tex.dispose();
      if (shadowIM) shadowIM.dispose(); // frees the instanceMatrix attribute
      ownedGeos.length = 0;
      ownedTexs.length = 0;
      clouds.length = 0;
      shadowBases.length = 0;
      glints.length = 0;
    },
  };
}
