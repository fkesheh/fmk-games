// ============================================================================
// KART GP — kart visual (split out of render.ts; the frozen KartScene export
// still owns the public API). One KartVisual per racer: the prim factory
// (chassis/aero/driver/wheels/steer pivots/nitro flame) plus the per-frame
// easing that turns target poses into rendered poses. Karts stay unbaked —
// front wheels steer, all wheels spin (rims + spokes with them), the body
// rolls into steering and pitches under accel/braking, the driver leans into
// turns, and a small exhaust flame flickers while nitro is active. Faces
// local -z so root.rotation.y = platform yaw works.
//
// 46 prims/kart: under-shadow band (merged spine + pod pad), floor tray,
// chassis tub, nose cone, front-wing assembly (blade + 2 endplates merged),
// 2 side pods, merged pod skirts, merged lit pod rails, center stripe, cockpit
// coaming, seat back, steering column + torus wheel, engine block, bright
// rear-deck air box, dual exhausts (merged), roll bar, rear wing (charcoal
// blade + supports merged; accent endplates merged), merged lit aero strips
// (front + rear wing tops), number roundels (pod L/R + nose, one merged mesh),
// driver (torso + back stripe, 2 arms, gloves merged, helmet + wrap visor +
// brow peak + crown stripe), 2 flame cones, 4x (lathe tire + recessed white
// rim + spokes), brake disc. All static colors are KPAL; the livery accent is
// a small deterministic hue/lightness shift of the player color.
//
// VALUE LADDER (VISUAL_UPGRADE.md §1/§4 — "kart is low-contrast at distance"):
//   ink L 8   under-shadow band (deepest; the kart no longer floats)
//   tire L 13 tyres
//   charcoal L 16  floor tray, pod skirts, aero blades  (>= 8 above the band)
//   color L 39-64  chassis tub + driver suit             (>= 23 above charcoal)
//   accent L 52-87 side pods + helmet                    (>= 10 above color)
//   curbWhite L 91 pod rails, wing tops, rims, gloves, stripes (lit trim)
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { KPAL, KART_COLORS, type TrackDef } from '@kart/shared';
import { box, cyl, sphere, type MatFn } from './trackMesh.js';

// ---- kart visual tuning (frozen feel) ---------------------------------------------
const INTERP_RATE = 12; // kart target ease rate /s (docs: ~12/s)
const STEER_VIS = 0.4; // front-wheel visual lock (rad at steer = 1)
const DRIFT_ROLL = 0.3; // extra body roll per rad of visual steer while drifting
const WHEEL_R = 0.28;
const ROLL_MAX = 0.07; // always-on roll into steering at full lock + speed (rad)
const ROLL_SPEED_REF = 8; // m/s at which steering roll reaches full authority
const PITCH_MAX = 0.05; // squat/dive clamp (rad)
const PITCH_PER_ACCEL = 0.006; // rad per m/s² of smoothed longitudinal accel
const ACCEL_CLAMP = 12; // m/s² — collisions/spawns never slam the pitch
const LEAN_MAX = 0.14; // driver lean into turns at full lock + speed (rad)
const SHAKE_AMP = 0.012; // grass shake amplitude (m) — tiny, high-frequency
const SHAKE_MIN_SPEED = 1.5; // m/s — no shake when parked on the grass

// ---- grass detection (injected circuit; multi-track, no I/O) ---------------------
// surfaceAt()/closestOnTrack() allocate per call — this inline distance check
// against the same centerline keeps update() allocation-free.
let grassTrack: TrackDef | null = null;
/** The circuit KartVisual's off-road check runs against. app.ts injects it whenever the
 *  room's circuit changes; unset means "assume on-road" (nothing to compare against). */
export function setKartTrack(track: TrackDef): void {
  grassTrack = track;
}
function offRoad(x: number, z: number): boolean {
  if (!grassTrack) return false;
  const cl = grassTrack.centerline;
  let bestD = Infinity;
  for (let i = 0; i < cl.length; i++) {
    const c = cl[i]!;
    const dx = c[0] - x;
    const dz = c[1] - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) bestD = d;
  }
  return bestD > (grassTrack.roadHalfW + 0.4) * (grassTrack.roadHalfW + 0.4);
}

/**
 * Livery accent: a small deterministic variant of the player color — a slight
 * HUE shift plus a lightness lift, so accents read as a second livery color
 * rather than a tint of the main one. Computed once per kart at construction;
 * the hex feeds the shared mat() cache like any KPAL color.
 */
function liveryAccent(hex: string): string {
  const c = new THREE.Color(hex);
  const hsl: THREE.HSL = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL((hsl.h + 0.055) % 1, Math.min(1, hsl.s * 1.05), Math.min(0.8, hsl.l + 0.2));
  return `#${c.getHexString()}`;
}

// ---- number roundels (white disc + race number, one canvas texture per color) -----
// Module-level cache: bounded by the 8 KART_COLORS, shared by every kart with
// the same color (per-kart textures would leak — render.ts only disposes
// geometries). The number is the deterministic KART_COLORS index + 1.
const roundelCache = new Map<string, THREE.MeshLambertMaterial>();
function roundelNumber(hex: string): number {
  const ix = KART_COLORS.indexOf(hex);
  if (ix >= 0) return ix + 1;
  let h = 0; // unknown color: deterministic hash fallback, still 1-8
  for (let i = 0; i < hex.length; i++) h = (h * 31 + hex.charCodeAt(i)) | 0;
  return (Math.abs(h) % 8) + 1;
}
function roundelMat(hex: string): THREE.MeshLambertMaterial {
  let m = roundelCache.get(hex);
  if (m) return m;
  const canvas = document.createElement('canvas');
  canvas.width = 256; // 128 -> 256: the roundel is read at chase-cam distance
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 256);
  ctx.fillStyle = KPAL.ink; // dark ring: the disc must read on a LIGHT livery too
  ctx.beginPath();
  ctx.arc(128, 128, 124, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = KPAL.curbWhite; // the roundel disc
  ctx.beginPath();
  ctx.arc(128, 128, 111, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = KPAL.ink; // the race number
  ctx.font = 'bold 150px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(roundelNumber(hex)), 128, 137);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  m = new THREE.MeshLambertMaterial({ map: tex, transparent: true, flatShading: true });
  roundelCache.set(hex, m);
  return m;
}

// ---- nitro flame materials (emissive fx — the fps muzzle-flash precedent) ------
// Lazily shared across all karts; NOT in the mat() cache (emissive must not leak
// onto plain body prims that share a cached hex).
let flameOuterMat: THREE.MeshLambertMaterial | null = null;
function flameOuter(): THREE.MeshLambertMaterial {
  if (!flameOuterMat) {
    flameOuterMat = new THREE.MeshLambertMaterial({
      color: KPAL.kartOrange, // fire orange
      emissive: KPAL.kartOrange,
      flatShading: true,
    });
  }
  return flameOuterMat;
}
let flameInnerMat: THREE.MeshLambertMaterial | null = null;
function flameInner(): THREE.MeshLambertMaterial {
  if (!flameInnerMat) {
    flameInnerMat = new THREE.MeshLambertMaterial({
      color: KPAL.gold, // hot yellow core (muzzle-flash tone)
      emissive: KPAL.gold,
      flatShading: true,
    });
  }
  return flameInnerMat;
}

/** Tire profile: flat tread, rounded shoulders, open well (the rim covers it). */
function tireGeometry(): THREE.BufferGeometry {
  const profile = [
    new THREE.Vector2(0.14, 0.115),
    new THREE.Vector2(0.235, 0.11),
    new THREE.Vector2(0.262, 0.075),
    new THREE.Vector2(0.275, 0.045),
    new THREE.Vector2(0.275, -0.045),
    new THREE.Vector2(0.262, -0.075),
    new THREE.Vector2(0.235, -0.11),
    new THREE.Vector2(0.14, -0.115),
  ];
  const geo = new THREE.LatheGeometry(profile, 12);
  geo.rotateZ(Math.PI / 2); // axle along local X
  return geo;
}

/**
 * One racer's visual state: the eased pose actually rendered, plus the wheel /
 * steering / body-language / nitro-flame animation state. Geometry disposal is
 * the caller's job (render.ts sweeps geometries on removeKart).
 */
export class KartVisual {
  readonly root: THREE.Group; // positioned/rotated to the eased pose
  private readonly body: THREE.Group; // roll/pitch pivot (every non-wheel prim)
  private readonly driver: THREE.Group; // leans into turns (pivot at the seat base)
  private readonly wheels: THREE.Group[] = []; // all four — spin about the axle (local X)
  private readonly steerPivots: THREE.Group[] = []; // front pair — yaw with steer
  private readonly flame: THREE.Group; // nitro exhaust flame — visible only while boosting
  private flameT = 0; // accumulated flicker phase (deterministic, dt-driven)
  private snapped = false; // first update snaps instead of easing
  private tx = 0; // latest target transform
  private ty = 0;
  private tz = 0;
  private tyaw = 0;
  private cx = 0; // eased pose actually rendered
  private cy = 0;
  private cz = 0;
  private cyaw = 0;
  private spin = 0; // accumulated wheel angle (rad)
  private steerVis = 0; // eased visual steer angle
  private roll = 0; // eased body roll (steering + drift)
  private pitch = 0; // eased squat/dive
  private lean = 0; // eased driver lean
  private speedSmooth = 0; // eased signed ground speed (m/s)
  private prevSpeed = 0; // last frame's instantaneous speed (accel input)
  private accelSmooth = 0; // eased longitudinal accel (m/s²)
  private shakeT = 0; // accumulated grass-shake phase (deterministic, dt-driven)
  private grass = false; // last off-road check result

  constructor(color: string, matFn: MatFn) {
    this.root = new THREE.Group();
    const root = this.root;
    const body = new THREE.Group();
    this.body = body;
    root.add(body);
    const accent = liveryAccent(color);
    const put = (mesh: THREE.Mesh, x: number, y: number, z: number): THREE.Mesh => {
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      body.add(mesh);
      return mesh;
    };

    // ---- under-shadow band (grounding) ------------------------------------------
    // Nothing used to sit between the floor tray and the road, so the kart read
    // as floating. A ground-hugging `ink` slab (the palette's deepest value, a
    // full 8 L under the charcoal tray) is the kart's contact band. It lives on
    // ROOT, not body, so it stays parallel to the ground while the chassis rolls
    // and pitches. Two merged parts: a narrow spine threaded between the wheels,
    // and a wider pad under the side pods where there is lateral clearance.
    //
    // HEIGHT: the band must clear the whole road-decal stack in `trackMesh.ts`.
    // The topmost layer there is PAINT_Y (0.03) carrying 0.02-tall boxes — the
    // start/finish checker and the grid-stall paint — whose top faces land at
    // y 0.040, and karts spawn standing on exactly those stalls. So the band is
    // thin (0.014) and centred at 0.050: it occupies y 0.043..0.057, entirely
    // above the paint with a 3 mm gap, and with no face coplanar with y 0.040
    // (a shared plane z-fights just as badly as an overlap). Thin rather than
    // tall so the side faces stay a sliver — it must read as a shadow pressed
    // into the road, not as a slab floating over it.
    const shadowSpine = new THREE.BoxGeometry(0.98, 0.014, 2.5);
    shadowSpine.translate(0, 0.05, 0.05);
    const shadowPad = new THREE.BoxGeometry(1.58, 0.014, 0.84);
    shadowPad.translate(0, 0.05, 0.1);
    const underShadow = new THREE.Mesh(mergeGeometries([shadowSpine, shadowPad])!, matFn(KPAL.ink));
    root.add(underShadow); // no castShadow: this IS the shadow read

    // ---- chassis & aero ---------------------------------------------------------
    put(box(matFn, 1.3, 0.06, 2.3, KPAL.charcoal), 0, 0.14, 0.05); // floor tray
    put(box(matFn, 0.95, 0.18, 1.5, color), 0, 0.3, 0.15); // chassis tub (livery)
    const nose = put(new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.8, 4), matFn(color)), 0, 0.33, -0.95);
    nose.geometry.rotateY(Math.PI / 4); // flat faces fore/aft
    nose.geometry.rotateX(-Math.PI / 2); // apex -> -z (forward)
    nose.scale.y = 0.55; // flattened wedge
    // front-wing assembly: blade + both endplates merged into one rigid part
    const wingBlade = new THREE.BoxGeometry(1.35, 0.04, 0.32);
    const endL = new THREE.BoxGeometry(0.03, 0.14, 0.34);
    endL.translate(-0.66, 0.05, 0);
    const endR = new THREE.BoxGeometry(0.03, 0.14, 0.34);
    endR.translate(0.66, 0.05, 0);
    put(new THREE.Mesh(mergeGeometries([wingBlade, endL, endR])!, matFn(KPAL.charcoal)), 0, 0.12, -1.45);
    put(box(matFn, 0.32, 0.22, 1.0, accent), -0.62, 0.33, 0.05); // side pod L (accent)
    put(box(matFn, 0.32, 0.22, 1.0, accent), 0.62, 0.33, 0.05); // side pod R (accent)
    // pod skirts: the shaded lower flank, flush with the pod's outer face. One
    // merged charcoal part — a hard value break between the accent pods and the
    // tray, so the pods stop merging into the body mass at distance.
    const skirtL = new THREE.BoxGeometry(0.34, 0.09, 1.02);
    skirtL.translate(-0.62, 0.185, 0.05);
    const skirtR = new THREE.BoxGeometry(0.34, 0.09, 1.02);
    skirtR.translate(0.62, 0.185, 0.05);
    put(new THREE.Mesh(mergeGeometries([skirtL, skirtR])!, matFn(KPAL.charcoal)), 0, 0, 0);
    // pod rails: the lit top edge (curbWhite), the ladder's top rung. Two thin
    // slivers, but they draw the kart's widest horizontal line against the road.
    const railL = new THREE.BoxGeometry(0.36, 0.035, 1.04);
    railL.translate(-0.62, 0.4525, 0.05);
    const railR = new THREE.BoxGeometry(0.36, 0.035, 1.04);
    railR.translate(0.62, 0.4525, 0.05);
    put(new THREE.Mesh(mergeGeometries([railL, railR])!, matFn(KPAL.curbWhite)), 0, 0, 0);
    put(box(matFn, 0.16, 0.03, 0.66, accent), 0, 0.4, -0.3); // nose-deck center stripe (accent)
    // cockpit coaming: an ink slot around the driver so the suit does not sit
    // straight on the same-value tub. Sunk 0.02 into the tub to avoid coplanar faces.
    put(box(matFn, 0.56, 0.12, 0.62, KPAL.ink), 0, 0.43, 0.34);

    // ---- number roundels (pod flanks + nose top; one merged mesh, one canvas) ---
    const rdPodL = new THREE.CircleGeometry(0.13, 12);
    rdPodL.rotateY(-Math.PI / 2); // faces -x
    rdPodL.translate(-0.785, 0.33, 0.05);
    const rdPodR = new THREE.CircleGeometry(0.13, 12);
    rdPodR.rotateY(Math.PI / 2); // faces +x
    rdPodR.translate(0.785, 0.33, 0.05);
    const rdNose = new THREE.CircleGeometry(0.13, 12);
    rdNose.rotateX(-Math.PI / 2 + 0.42); // lies back on the wedge slope
    rdNose.translate(0, 0.42, -0.92);
    put(new THREE.Mesh(mergeGeometries([rdPodL, rdPodR, rdNose])!, roundelMat(color)), 0, 0, 0);

    // ---- cockpit ----------------------------------------------------------------
    const seatBack = put(box(matFn, 0.52, 0.5, 0.1, KPAL.ink), 0, 0.6, 0.55);
    seatBack.rotation.x = 0.15; // slight rake
    const column = put(cyl(matFn, 0.02, 0.02, 0.32, 6, KPAL.ink), 0, 0.55, -0.32);
    column.rotation.x = -0.35; // raked back towards the driver
    const wheelRim = put(new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.028, 6, 10), matFn(KPAL.ink)), 0, 0.68, -0.28);
    wheelRim.rotation.x = -0.6; // tilted towards the driver

    // ---- powertrain (light metals at the rear — the chase cam stares at this) ----
    put(box(matFn, 0.5, 0.3, 0.45, KPAL.steel), 0, 0.35, 0.95); // engine block
    const airBox = put(box(matFn, 0.24, 0.2, 0.32, KPAL.curbWhite), 0, 0.66, 0.9);
    airBox.rotation.x = 0.12; // bright rear-deck intake panel above the engine
    // dual exhausts merged into one rigid part (both steel, both static)
    const pipeL = new THREE.CylinderGeometry(0.045, 0.05, 0.55, 6);
    pipeL.rotateX(Math.PI / 2 - 0.25); // axis rearward, tip slightly up
    pipeL.rotateZ(0.1); // slight outward splay
    pipeL.translate(-0.25, 0.42, 1.1);
    const pipeR = new THREE.CylinderGeometry(0.045, 0.05, 0.55, 6);
    pipeR.rotateX(Math.PI / 2 - 0.25);
    pipeR.rotateZ(-0.1);
    pipeR.translate(0.25, 0.42, 1.1);
    put(new THREE.Mesh(mergeGeometries([pipeL, pipeR])!, matFn(KPAL.steel)), 0, 0, 0);
    const rollBar = put(cyl(matFn, 0.045, 0.045, 0.55, 6, KPAL.steel), 0, 1.12, 0.72);
    rollBar.rotation.z = Math.PI / 2; // axis across the kart
    // rear wing: low charcoal blade + supports, ACCENT endplates (the livery
    // read at the rear corners) — two merged rigid parts
    const rwBlade = new THREE.BoxGeometry(1.0, 0.04, 0.24);
    rwBlade.translate(0, 0.88, 1.18);
    const rwSupL = new THREE.BoxGeometry(0.04, 0.2, 0.06);
    rwSupL.translate(-0.26, 0.74, 1.12);
    const rwSupR = new THREE.BoxGeometry(0.04, 0.2, 0.06);
    rwSupR.translate(0.26, 0.74, 1.12);
    put(new THREE.Mesh(mergeGeometries([rwBlade, rwSupL, rwSupR])!, matFn(KPAL.charcoal)), 0, 0, 0);
    const rwEndL = new THREE.BoxGeometry(0.04, 0.16, 0.28);
    rwEndL.translate(-0.5, 0.84, 1.18);
    const rwEndR = new THREE.BoxGeometry(0.04, 0.16, 0.28);
    rwEndR.translate(0.5, 0.84, 1.18);
    put(new THREE.Mesh(mergeGeometries([rwEndL, rwEndR])!, matFn(accent)), 0, 0, 0);
    // lit aero: curbWhite skins on the two wing tops, merged into one part. The
    // charcoal blades vanished against the road; a sun-facing top surface gives
    // the kart a bright leading and trailing line (the chase cam stares at the
    // rear one all race).
    const wingLitFront = new THREE.BoxGeometry(1.28, 0.02, 0.28);
    wingLitFront.translate(0, 0.145, -1.45);
    const wingLitRear = new THREE.BoxGeometry(0.94, 0.02, 0.2);
    wingLitRear.translate(0, 0.905, 1.18);
    put(new THREE.Mesh(mergeGeometries([wingLitFront, wingLitRear])!, matFn(KPAL.curbWhite)), 0, 0, 0);

    // nitro flame at the right exhaust tip: outer orange cone + smaller hot
    // core, apexes pointing rearward (+z). Hidden until boost. Emissive fx —
    // no shadow casting. Fresh cone geometries, NOT the cone() factory (that
    // one shares the plain mat() cache; flames need emissive).
    const flame = new THREE.Group();
    this.flame = flame;
    flame.position.set(0.25, 0.48, 1.38);
    const flameOut = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.5, 6), flameOuter());
    flameOut.rotation.x = Math.PI / 2; // apex -> +z (rearward)
    flameOut.position.z = 0.25;
    const flameIn = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.3, 6), flameInner());
    flameIn.rotation.x = Math.PI / 2;
    flameIn.position.z = 0.15;
    flame.add(flameOut, flameIn);
    flame.visible = false;
    body.add(flame);

    // ---- driver (leans into turns; pivot at the seat base) ----------------------
    const driver = new THREE.Group();
    this.driver = driver;
    driver.position.set(0, 0.45, 0.35);
    body.add(driver);
    const dput = (mesh: THREE.Mesh, x: number, y: number, z: number): THREE.Mesh => {
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      driver.add(mesh);
      return mesh;
    };
    // Suit is the PLAYER colour (who is driving is legible from the suit), helmet
    // is the lifted accent — 10-27 L above the suit, so the head reads as a
    // separate mass against the seat back instead of one livery-coloured blob.
    dput(box(matFn, 0.44, 0.5, 0.26, color), 0, 0.28, 0); // torso — livery racing suit
    dput(box(matFn, 0.42, 0.12, 0.03, KPAL.curbWhite), 0, 0.42, 0.14); // back stripe high on the torso — clears the seat top from behind
    const armL = dput(box(matFn, 0.09, 0.09, 0.42, color), -0.14, 0.26, -0.25);
    armL.rotation.x = -0.25; // hands down to the wheel
    armL.rotation.y = 0.1; // hands in towards the column
    const armR = dput(box(matFn, 0.09, 0.09, 0.42, color), 0.14, 0.26, -0.25);
    armR.rotation.x = -0.25;
    armR.rotation.y = -0.1;
    // white gloves on the wheel grips — one merged rigid part
    const gloveGeoL = new THREE.BoxGeometry(0.11, 0.11, 0.13);
    gloveGeoL.rotateX(-0.25);
    gloveGeoL.translate(-0.13, 0.2, -0.51);
    const gloveGeoR = new THREE.BoxGeometry(0.11, 0.11, 0.13);
    gloveGeoR.rotateX(-0.25);
    gloveGeoR.translate(0.13, 0.2, -0.51);
    dput(new THREE.Mesh(mergeGeometries([gloveGeoL, gloveGeoR])!, matFn(KPAL.curbWhite)), 0, 0, 0);
    dput(sphere(matFn, 0.21, 8, accent), 0, 0.62, 0.02); // helmet — lifted livery accent
    const visor = dput(box(matFn, 0.36, 0.09, 0.08, KPAL.ink), 0, 0.63, -0.155);
    visor.rotation.x = -0.1; // wide stripe, corners wrap the helmet sides
    const peak = dput(box(matFn, 0.32, 0.03, 0.12, KPAL.charcoal), 0, 0.575, -0.185);
    peak.rotation.x = -0.15; // brow proud of the shell — casts the visor into shade
    dput(box(matFn, 0.075, 0.06, 0.2, KPAL.curbWhite), 0, 0.795, 0.02); // crown stripe, read from behind

    // ---- wheels: lathe tire (rounded shoulders) + recessed white rim + spokes -----
    const tireGeo = tireGeometry();
    const rimGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.2, 6);
    rimGeo.rotateZ(Math.PI / 2); // hex alloy, recessed inside the tire faces —
    // sidewall proud of the rim, spokes proud of the well: a 3-part stack
    const spokeGeo = new THREE.BoxGeometry(0.22, 0.26, 0.05); // hub bar across the rim face
    const brakeGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.03, 8);
    brakeGeo.rotateZ(Math.PI / 2);
    const tire = matFn(KPAL.tire);
    const rim = matFn(KPAL.curbWhite); // light rims — real kart rims read bright
    const spoke = matFn(KPAL.charcoal);
    const spots: Array<[number, number, boolean]> = [
      [-0.62, -0.75, true],
      [0.62, -0.75, true],
      [-0.66, 0.78, false],
      [0.66, 0.78, false],
    ];
    for (const [wx, wz, steerable] of spots) {
      const pivot = new THREE.Group();
      pivot.position.set(wx, WHEEL_R, wz);
      const wheel = new THREE.Group();
      const tireMesh = new THREE.Mesh(tireGeo, tire);
      tireMesh.castShadow = true;
      wheel.add(tireMesh);
      wheel.add(new THREE.Mesh(rimGeo, rim));
      wheel.add(new THREE.Mesh(spokeGeo, spoke));
      pivot.add(wheel);
      root.add(pivot);
      this.wheels.push(wheel);
      if (steerable) this.steerPivots.push(pivot);
    }
    // brake disc hint: one disc on the rear axle line, inside the rear-left
    // rim (spins with the wheel, as it should)
    const brake = new THREE.Mesh(brakeGeo, spoke);
    brake.position.x = 0.12;
    this.wheels[2]!.add(brake);
  }

  /**
   * Push the latest target transform and ease towards it (~12/s — the
   * interpolation lives in here, callers just forward sim/snapshot poses).
   * First call after construction snaps. Wheels spin with signed travel
   * distance, the front pair steers, the body rolls into steering (more while
   * drifting), squats under acceleration and dives under braking (from the
   * speed delta), the driver leans into turns, and the whole body gets a tiny
   * high-frequency shake on grass. While nitroActive a small emissive flame
   * flickers at the exhaust tip. Everything is dt-driven and deterministic —
   * no Math.random, no per-frame allocation.
   */
  update(x: number, y: number, z: number, yaw: number, steer: number, drift: boolean, nitroActive: boolean, dt: number): void {
    this.tx = x;
    this.ty = y;
    this.tz = z;
    this.tyaw = yaw;
    const d = Math.min(dt, 0.1); // tab-back spikes never teleport the ease
    if (!this.snapped) {
      this.cx = x;
      this.cy = y;
      this.cz = z;
      this.cyaw = yaw;
      this.snapped = true;
    } else {
      const k = 1 - Math.exp(-INTERP_RATE * d);
      const px = this.cx;
      const pz = this.cz;
      this.cx += (this.tx - this.cx) * k;
      this.cy += (this.ty - this.cy) * k;
      this.cz += (this.tz - this.cz) * k;
      const dyaw = Math.atan2(Math.sin(this.tyaw - this.cyaw), Math.cos(this.tyaw - this.cyaw)); // shortest arc
      this.cyaw += dyaw * k;
      // wheels spin with the signed distance travelled along the forward axis
      const fx = -Math.sin(this.cyaw);
      const fz = -Math.cos(this.cyaw);
      const dist = (this.cx - px) * fx + (this.cz - pz) * fz;
      this.spin -= dist / WHEEL_R;
      // body language derives from motion: smoothed speed + longitudinal accel
      const instSpeed = dist / Math.max(d, 1e-4);
      const accel = Math.max(-ACCEL_CLAMP, Math.min(ACCEL_CLAMP, (instSpeed - this.prevSpeed) / Math.max(d, 1e-4)));
      this.prevSpeed = instSpeed;
      this.speedSmooth += (instSpeed - this.speedSmooth) * Math.min(1, 12 * d);
      this.accelSmooth += (accel - this.accelSmooth) * Math.min(1, 6 * d);
      this.grass = offRoad(this.cx, this.cz);
    }
    this.steerVis += (steer * STEER_VIS - this.steerVis) * Math.min(1, 14 * d);
    // roll into steering, scaled by speed; drifting leans much harder
    const steerNorm = this.steerVis / STEER_VIS; // -1..1
    const speedFac = Math.min(1, Math.abs(this.speedSmooth) / ROLL_SPEED_REF);
    const rollTarget = -steerNorm * speedFac * ROLL_MAX + (drift ? -this.steerVis * DRIFT_ROLL : 0);
    this.roll += (rollTarget - this.roll) * Math.min(1, 10 * d);
    // squat under acceleration / dive under braking
    const pitchTarget = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, this.accelSmooth * PITCH_PER_ACCEL));
    this.pitch += (pitchTarget - this.pitch) * Math.min(1, 8 * d);
    // driver leans into the turn a touch harder than the chassis
    this.lean += (-steerNorm * speedFac * LEAN_MAX - this.lean) * Math.min(1, 8 * d);
    // nitro flame: only while boosting, quick deterministic scale flicker
    // anchored at the exhaust tip (group origin — the flame grows rearward).
    this.flame.visible = nitroActive;
    if (nitroActive) {
      this.flameT += d;
      const t = this.flameT;
      const len = 0.85 + 0.3 * Math.sin(t * 34) + 0.1 * Math.sin(t * 61);
      const wide = 0.9 + 0.15 * Math.sin(t * 47 + 1.3);
      this.flame.scale.set(wide, wide, len);
    }
    // grass shake: tiny high-frequency jitter, amplitude grows with speed
    let shakeY = 0;
    let shakeRoll = 0;
    let shakePitch = 0;
    if (this.grass && Math.abs(this.speedSmooth) > SHAKE_MIN_SPEED) {
      this.shakeT += d;
      const a = SHAKE_AMP * Math.min(1, Math.abs(this.speedSmooth) / 6);
      const t = this.shakeT;
      shakeY = a * Math.sin(t * 47) + a * 0.6 * Math.sin(t * 83 + 1.7);
      shakeRoll = a * 0.8 * Math.sin(t * 61 + 0.6);
      shakePitch = a * 0.5 * Math.sin(t * 71 + 2.1);
    }
    this.root.position.set(this.cx, this.cy, this.cz);
    this.root.rotation.y = this.cyaw;
    this.body.position.y = shakeY;
    this.body.rotation.z = this.roll + shakeRoll;
    this.body.rotation.x = this.pitch + shakePitch;
    this.driver.rotation.z = this.lean;
    for (const wheel of this.wheels) wheel.rotation.x = this.spin;
    // steer + = RIGHT (yaw decreases). The kart faces local -z, so its right
    // side is local +x; rotating a -z-facing wheel by rotation.y = -angle
    // swings its nose toward +x — hence the negative sign here.
    for (const pivot of this.steerPivots) pivot.rotation.y = -this.steerVis;
  }
}
