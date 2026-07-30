// ============================================================================
// KART GP — scene shell + renderer (frozen export, docs/KART.md "Client
// modules"). One WebGLRenderer (ACES, sRGB out, PCFSoft shadows, pixelRatio
// <= 2, subtle exposure lift). Sky rig (VISUAL_UPGRADE.md §1 S1/S2): a
// vertex-gradient dome whose stops are LITERAL palette entries — a thin
// KPAL.horizon rim, KPAL.sky through the mid band, KPAL.skyHigh at the zenith
// (cooler and 37 L* darker than the horizon, so S1 reads in the frame, not
// just in the test) — plus a warm blob around the sun azimuth, a hard-edged
// billboard sun disc with a tight halo, and three seeded cloud layers clumped
// into gap-free formations (bottom-aligned puffs give real flat bases; the
// puff texture ramps KPAL.cloud tops into KPAL.cloudShade undersides),
// drifting at different rates, palette-tinted by sun proximity and hazed
// toward the fog by layer distance. The directional light RIDES THE
// VISIBLE DISC — same azimuth, same 15° elevation — so the golden-hour sun
// and the long raking shadows always agree; the watched kart is kept readable
// by two shadowless helpers: a weak camera-axis directional fill (cool, the
// sky's counter-bounce to the warm key) plus a near-subject point fill
// anchored between camera and kart (inverse-square — the kart reads, the
// world barely sees it). All sky materials are unlit (MeshBasic/Sprite/Shader)
// with fog:false — the only unlit-material exceptions. FogExp2 sits EXACTLY on
// KPAL.fog (== KPAL.horizon, S2) so ground, ridgelines and dome fuse on one
// value; hemi is a cool sky over a warm KPAL.dirt ground bounce and is
// deliberately WEAK so the sun's 4096 shadows actually register. The shadow
// box follows the watched kart. Every other surface is flat-shaded
// MeshLambertMaterial in KPAL colors via the cached mat() factory below.
// Track construction lives in trackMesh.ts (bakes all static deco into ~1
// mesh per material); kart visuals live in kartMesh.ts (unbaked — front
// wheels steer, all wheels spin, the body rolls while drifting, and a small
// exhaust flame flickers while nitro is active). This module keeps the
// KartScene public API and the shared material cache, and delegates to
// those two.
//
// Camera: the frozen chase base (behind + above, modest FOV kick) with the
// AAA feel layered on top — drift swing (camera yaw trails the kart and leans
// into the slide, recovering as it straightens), speed micro-shake (tiny,
// frequency rises with speed), brake dive / accel squat from the longitudinal
// accel estimate, and a landing-dip spring fed by vertical velocity. All of
// it derives from the frozen setCamera inputs (x,y,z,yaw,speed,dt); the
// optional 7th fx param lets a caller hand in known drift ground truth.
// A dependency-free post pass (two fullscreen quads: warm grade lift +
// KPAL.ink vignette) closes the frame. Deterministic throughout — every rng
// is seeded, motion is a pure function of the input sequence.
// ============================================================================
import * as THREE from 'three';
import { KPAL, type TrackDef, type TrackTheme } from '@kart/shared';
import { decoSeed, mix, rng, rngInt, rngRange } from '@platform/shared';
import { buildTrackMesh } from './trackMesh.js';
import { KartVisual } from './kartMesh.js';

// ---- chase camera (frozen feel: behind + above, modest speed effects) --------
const BASE_FOV = 65;
const FOV_PER_KMH = 0.25; // docs/KART.md: FOV = 65 + 0.25 * speedKmH ...
const FOV_BONUS_CAP = 15; // ... "keep modest" — hard cap on the speed bonus
const CAM_DIST = 7; // m behind the kart at standstill
const CAM_DIST_PER_SPEED = 0.08; // + m per m/s of |speed|
const CAM_HEIGHT = 3;
const CAM_EASE = 8; // camera position ease rate /s
const CAM_LOOK_AHEAD = 4; // aim this far ahead of the kart
const CAM_LOOK_HEIGHT = 1.2;

// ---- camera feel (all derived from the setCamera input stream) --------------
const CAM_YAW_EASE = 5.5; // drift lag: camera yaw trails the kart /s
const SWING_MAX = 0.1; // rad of extra yaw INTO the drift at full slide
const SLIP_REF = 5; // lateral m/s that reads as a full drift
const SLIP_MIN_SPEED = 5; // no swing below this ground speed (m/s)
const SWING_EASE = 6; // swing approach rate /s
const SHAKE_START = 16; // m/s where the micro shake fades in
const SHAKE_FULL = 30; // ...and reaches full (tiny) amplitude
const SHAKE_MAX = 0.004; // rad — tiny by design
const SHAKE_F0 = 15; // Hz base frequency
const SHAKE_F_PER = 0.6; // +Hz per m/s — frequency rises with speed
const ACCEL_EASE = 5; // longitudinal accel estimate smoothing /s
const PITCH_PER_ACCEL = 0.0028; // rad of camera pitch per m/s²
const PITCH_ACCEL_CAP = 0.032; // brake dive / accel squat cap (rad)
const VY_EASE = 10; // vertical speed estimate smoothing /s
const LAND_VY_TRIGGER = -2.5; // falling faster than this arms the landing dip
const LAND_VY_DONE = -1; // ...and the dip fires once vy recovers past this
const LAND_K = 0.35; // dip velocity per m/s of impact
const LAND_MAX = 2.2; // hardest single landing impulse
const LAND_SPRING = 60; // dip spring ω² (ω ≈ 7.7 rad/s)
const LAND_DAMP = 9; // dip spring 2ζω (ζ ≈ 0.58 — one soft ~12cm bounce)
const TELEPORT_DIST = 12; // respawn jump — resets every camera derivative

// ---- shadow rig (one 4096 box; ortho frustum follows the watched kart) -------
// 4096 over the same 120 m box = ~2.9 cm/texel: the raking 15° sun finally
// draws a readable edge instead of the mush 2048 gave it. The extent stays at
// 60 on purpose — rivals up the road must keep their shadows, and a tighter
// box would pop them off as they pull away.
const SHADOW_EXTENT = 60;
const SHADOW_MAP_SIZE = 4096;
const SUN_DISTANCE = 80; // sun sits at target + sunVec x 80 (sunVec = the VISIBLE sun)

// ---- grade / light balance ---------------------------------------------------
// The old balance (hemi x1.4, key x1.2) lit every surface from every direction
// at once, which is why the world read flat: the shadow side of a kart sat
// within ~25% of its lit side. The key now carries the frame and the hemi is a
// weak COOL sky over a WARM ground bounce, so shadows land AND every surface
// picks up a free hue split (VISUAL_UPGRADE.md §3d) for zero cost.
const EXPOSURE = 1.18; // subtle tone-map lift — ACES stays
const SUN_WARM = 0.34; // sun color pull toward KPAL.gold
const SUN_BOOST = 1.55; // key-light raise — the low sun grazes, verticals catch it
const HEMI_BOOST = 0.75; // ambient CUT — the sun's shadows have to register
const FILL_INTENSITY = 0.26; // camera-follow directional fill (world readability)
const FILL_COOL = 0.55; // fill pull from curbWhite toward KPAL.sky (counter-bounce)
const FOG_DENSITY_SCALE = 0.8; // aerial-perspective knob over TrackTheme.fogDensity
const KART_LIGHT_INTENSITY = 11; // near-subject point fill (candela, decay 1.8)
const KART_LIGHT_DIST = 30; // hard cutoff — the world beyond ~15 m barely sees it
const KART_LIGHT_DECAY = 1.8;
const KART_LIGHT_LERP = 0.35; // anchor: camera -> look target mix (≈4 m off the kart)
const GRADE_ALPHA = 0.05; // fullscreen warm lift, weighted to the GROUND half
const VIGNETTE_ALPHA = 0.3; // corner darkening (KPAL.ink)

// ---- sky dome ------------------------------------------------------------------
const DOME_RADIUS = 400;
const SUN_ELEVATION = 0.26; // rad (~15°) — disc height AND the light's raking angle
const SUN_CORE_SCALE = 48; // sprite size in m at the dome (≈7° across)
const SUN_HALO_SCALE = 130;
const SUN_CORE_GOLD = 0.55; // disc center hue: curbWhite -> this far toward gold
// Dome band breakpoints as a fraction of dome height (0 = horizon, 1 = zenith).
// Weighted LOW on purpose: a chase camera looking near-level only ever frames
// y < ~0.5, so the horizon->sky->skyHigh ramp has to finish inside that band or
// S1's 37 L* of separation never appears on screen.
const DOME_RIM_TOP = 0.06; // pure KPAL.horizon rim (fuses with the fog)
const DOME_MID_TOP = 0.3; // ...ramping to KPAL.sky by here
const DOME_ZENITH_TOP = 0.8; // ...and fully KPAL.skyHigh from here up
const DOME_BELOW_LAND = 0.55; // below-horizon fade toward distant land
const SUN_GLOW_POW = 5; // tighter, more directional warm blob than the old 4
const SUN_GLOW_MAX = 0.72; // ...and it no longer bleaches the horizon rim white

// ---- clouds (3 seeded layers, clumped but gap-free, slow drift) ----------------
interface CloudLayerSpec {
  readonly count: number;
  readonly megas: number; // formation centers, ring-spaced so any ~60° heading has one
  readonly megaSpread: number; // rad of azimuth scatter around a center
  readonly radius: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly wMin: number;
  readonly wMax: number;
  readonly hMin: number;
  readonly hMax: number;
  readonly puffs: readonly [number, number]; // sprites per cloud [min,max]
  readonly opacity: number;
  readonly rate: number; // rad/s of drift around Y
  readonly haze: number; // pull toward the fog color (aerial perspective)
}
// Three tiers of DISTANCE, not just three tiers of height: haze rises with how
// far back the layer reads, so the low horizon streaks sit almost inside the
// fog while the mid cumulus stay near-white. That gradient is what turns a flat
// sticker sky into depth (VISUAL_UPGRADE.md §4, atmospheric perspective).
const CLOUD_LAYERS: readonly CloudLayerSpec[] = [
  // low, far, wide streaks hugging the horizon (90° spacing) — deepest haze
  { count: 10, megas: 4, megaSpread: 0.6, radius: 340, yMin: 40, yMax: 68, wMin: 80, wMax: 130, hMin: 9, hMax: 15, puffs: [2, 4], opacity: 0.66, rate: 0.0045, haze: 0.34 },
  // mid puffy cumulus — the main read; 60° spacing, alternating clump strength
  { count: 20, megas: 6, megaSpread: 0.4, radius: 295, yMin: 74, yMax: 118, wMin: 30, wMax: 60, hMin: 14, hMax: 24, puffs: [3, 5], opacity: 0.95, rate: 0.0028, haze: 0.06 },
  // high cirrus: heavily stretched, faint, low enough to read in frame
  { count: 8, megas: 3, megaSpread: 0.72, radius: 335, yMin: 122, yMax: 168, wMin: 190, wMax: 320, hMin: 3.5, hMax: 7, puffs: [1, 2], opacity: 0.34, rate: 0.0016, haze: 0.18 },
];

// ---- cached material factory (mirrors the fps client visual vocabulary) --------
const matCache = new Map<string, THREE.MeshLambertMaterial>();

/**
 * Shared, cached flat-shaded Lambert material. hex MUST come from
 * KPAL/KART_COLORS — an ad-hoc literal here is a palette violation and there is
 * no second material path to hide it in.
 *
 * This factory is THE material source for the whole KART client: it is handed
 * to trackMesh.ts as `MatFn` and to KartVisual as its material factory, so the
 * cache is global and one hex is exactly one draw-call bucket. Its signature is
 * a seam (VISUAL_UPGRADE.md §7 rule 5) — consumers must not build their own
 * materials, and it must not grow parameters that would fork the cache key.
 */
function mat(hex: string): THREE.MeshLambertMaterial {
  let m = matCache.get(hex);
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      color: hex,
      flatShading: true, // the flat-shaded look — do not remove
    });
    matCache.set(hex, m);
  }
  return m;
}

/** Dispose every Mesh geometry under root (shared cached materials excluded). */
function disposeGeometries(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.geometry.dispose();
  });
}

function smooth01(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Wrap an angle to (-π, π]. */
function wrapPi(a: number): number {
  const TWO_PI = Math.PI * 2;
  return ((((a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** rgba() css string from a KPAL hex — canvas gradients need sRGB components. */
function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Raw sRGB components of a KPAL hex for the post shader (no color management). */
function srgbUniform(hex: string): THREE.Vector3 {
  const n = parseInt(hex.slice(1), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Deterministic radial-gradient texture (procedural — no assets). */
function radialTexture(size: number, stops: ReadonlyArray<readonly [number, string]>): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [offset, color] of stops) g.addColorStop(offset, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Cloud puff texture: a soft radial alpha blob with the vertical shading
 * baked in — bright top, shaded bottom (sun overhead). The sprite material's
 * tint (cool/warm by sun proximity, hazed by layer distance) multiplies on
 * top. KPAL-derived only: KPAL.cloud is the lit top, KPAL.cloudShade the
 * underside, and every intermediate comes from `mix()` between two palette
 * entries so it stays traceable.
 *
 * Two things changed from the first pass. (1) The alpha core is now WIDE and
 * flat-topped (solid out to 0.45, still soft at the rim) — the old 0.35/0.65
 * falloff made every puff a fog ball, so a cluster read as smoke rather than
 * cloud. (2) The value ramp is no longer a straight lerp: the top 45% stays
 * near-pure cloud, then the shading falls off fast into a dark base band. That
 * knee, not the gradient, is what makes a cumulus read as a lit mass with a
 * flat shadowed bottom.
 */
function cloudTexture(size: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, rgba(KPAL.cloud, 1));
  g.addColorStop(0.45, rgba(KPAL.cloud, 1));
  g.addColorStop(0.72, rgba(KPAL.cloud, 0.62));
  g.addColorStop(0.9, rgba(KPAL.cloud, 0.16));
  g.addColorStop(1, rgba(KPAL.cloud, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // source-atop repaints only inside the blob's alpha — a vertical light ramp
  ctx.globalCompositeOperation = 'source-atop';
  const v = ctx.createLinearGradient(0, 0, 0, size);
  v.addColorStop(0, KPAL.cloud); // top: full lit cloud
  v.addColorStop(0.45, mix(KPAL.cloud, KPAL.cloudShade, 0.18)); // still bright
  v.addColorStop(0.72, mix(KPAL.cloud, KPAL.cloudShade, 0.78)); // the shading knee
  v.addColorStop(1, mix(KPAL.cloudShade, KPAL.sky, 0.4)); // base: cool underside
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Optional camera ground truth (additive; the app passes the frozen 6 args). */
export interface CameraFx {
  /** Known drift intensity 0..1 — scales the drift swing when the caller has it. */
  drift?: number;
}

interface Cloud {
  readonly mats: THREE.SpriteMaterial[]; // one per puff (big center + faint trailings)
  readonly azimuth: number; // base ring angle (layer rotation added per frame)
  readonly layer: THREE.Group;
  readonly warmthBias: number; // seeded per-cloud tint variation
  readonly haze: number;
}

interface CloudLayer {
  readonly group: THREE.Group;
  readonly base: number; // seeded starting rotation
  readonly rate: number;
}

// ---- module-level KPAL-derived colors (allocated once) ---------------------------
const COL_GOLD = new THREE.Color(KPAL.gold);
const COL_SKY = new THREE.Color(KPAL.sky);
const COL_WARM_GLOW = new THREE.Color(KPAL.gold).lerp(new THREE.Color(KPAL.curbWhite), 0.3);
/** S1 zenith stop — a literal palette entry, not a derived tint. */
const COL_ZENITH = new THREE.Color(KPAL.skyHigh);
/** Below the horizon line the dome reads as distant land, not as more sky. */
const COL_LAND_BELOW = new THREE.Color(KPAL.grassDeep);

export class KartScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly fill: THREE.DirectionalLight; // camera-follow silhouette fill
  private readonly kartLight: THREE.PointLight; // near-subject fill anchored off the kart
  private readonly sky: THREE.Mesh;
  private readonly sunCore: THREE.Sprite;
  private readonly sunHalo: THREE.Sprite;
  private readonly cloudLayers: CloudLayer[] = [];
  private readonly clouds: Cloud[] = [];
  private readonly postScene = new THREE.Scene();
  private readonly postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly disposables: Array<{ dispose(): void }> = [];

  // theme-derived sky state (recomputed in applyGrade)
  private sunDir: readonly [number, number, number] = [0.5, -1, 0.35];
  private sunAz = 0; // azimuth of the visible disc (from sunDir, clamped elevation)
  private readonly sunVec = new THREE.Vector3(); // unit vector TO the visible sun
  private readonly cloudCool = new THREE.Color(KPAL.cloudShade);
  private readonly cloudWarm = new THREE.Color(KPAL.cloud);
  private readonly cloudHaze = new THREE.Color(KPAL.fog);

  private trackRoot: THREE.Group | null = null;
  private readonly karts = new Map<string, KartVisual>();

  // ---- camera feel state (derived from the setCamera stream; no per-frame alloc)
  private camReady = false; // first setCamera snaps instead of easing
  private camYaw = 0; // lagged camera yaw (drift swing rides on top)
  private camTime = 0; // accumulated clamped dt — shake phase + cloud drift
  private swing = 0; // smoothed drift-swing offset (rad)
  private accel = 0; // smoothed longitudinal accel estimate (m/s²)
  private vy = 0; // smoothed vertical speed (m/s)
  private prevVy = 0;
  private dip = 0; // landing dip spring offset (<= 0 while bouncing)
  private dipV = 0;
  private prevX = 0;
  private prevY = 0;
  private prevZ = 0;
  private prevSpeed = 0;

  private readonly camScratch = new THREE.Vector3(); // reuse — no per-frame alloc
  private readonly lookScratch = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    // guard: no WebGL context => readable failure surface, then propagate
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        powerPreference: 'high-performance',
      });
    } catch (err) {
      KartScene.showContextError();
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.renderer = renderer;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(KPAL.fog, 0.006);
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, DOME_RADIUS * 1.5); // far covers the dome

    // lights are created once and re-tinted per theme — no add/remove churn
    // cool sky over a warm ground bounce (applyGrade re-tints per theme)
    this.hemi = new THREE.HemisphereLight(KPAL.sky, KPAL.dirt, 0.6);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(KPAL.curbWhite, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    const sc = this.sun.shadow.camera;
    sc.left = -SHADOW_EXTENT;
    sc.right = SHADOW_EXTENT;
    sc.top = SHADOW_EXTENT;
    sc.bottom = -SHADOW_EXTENT;
    sc.near = 1;
    sc.far = SUN_DISTANCE * 3;
    sc.updateProjectionMatrix();
    // tuned pair: small negative depth bias kills acne on the flat-shaded
    // Lambert, normalBias keeps the contact shadow glued (no peter-panning);
    // at the 15° raking angle normalBias does the heavy lifting on the road.
    // Both tightened with the 4096 map — the extra texels buy back the slack
    // the old numbers were paying for, so contacts sit closer to the wheel.
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.normalBias = 0.028;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target); // target defaults to origin

    // camera-follow silhouette fill: weak, shadowless, COOL — it stands in for
    // sky bounce, so the shadow side of a kart goes blue rather than merely
    // dimmer, and the warm key reads as a key (position/target track the chase
    // cam every setCamera)
    this.fill = new THREE.DirectionalLight(KPAL.curbWhite, FILL_INTENSITY);
    this.fill.castShadow = false;
    this.scene.add(this.fill);
    this.scene.add(this.fill.target);

    // near-subject point fill: anchored between camera and kart, inverse-
    // square so the kart's chase-view faces always read, world barely sees it
    this.kartLight = new THREE.PointLight(
      new THREE.Color(KPAL.curbWhite).lerp(COL_GOLD, 0.15),
      KART_LIGHT_INTENSITY,
      KART_LIGHT_DIST,
      KART_LIGHT_DECAY,
    );
    this.kartLight.castShadow = false;
    this.kartLight.position.set(0, 4, 6);
    this.scene.add(this.kartLight);

    // sky dome: vertex gradient (3-stop + warm sun blob), fog:false, unlit.
    // 64x32 rather than 48x24 — the gradient and the sun glow are interpolated
    // BETWEEN vertices, so the old ring spacing quantised both into visible
    // bands. Still one unlit draw call; the extra quads are free.
    const skyGeo = new THREE.SphereGeometry(DOME_RADIUS, 64, 32);
    const skyMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false });
    this.disposables.push(skyMat);
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.sky.frustumCulled = false; // the dome always encloses the camera
    this.scene.add(this.sky);

    // sun disc: SOLID amber core (alpha 1, brightest thing in the sky), fast
    // faint falloff — no ring band, no translucent center
    const sunCoreHex = mix(KPAL.curbWhite, KPAL.gold, SUN_CORE_GOLD);
    const coreTex = radialTexture(128, [
      [0, rgba(sunCoreHex, 1)],
      [0.55, rgba(sunCoreHex, 1)],
      [0.66, rgba(KPAL.gold, 0.3)],
      [0.78, rgba(KPAL.gold, 0.08)],
      [1, rgba(KPAL.gold, 0)],
    ]);
    const haloTex = radialTexture(128, [
      [0, rgba(KPAL.gold, 0.35)],
      [0.4, rgba(KPAL.gold, 0.14)],
      [1, rgba(KPAL.gold, 0)],
    ]);
    this.disposables.push(coreTex, haloTex);
    const coreMat = new THREE.SpriteMaterial({
      map: coreTex,
      color: KPAL.curbWhite,
      transparent: true,
      opacity: 0.98,
      depthWrite: false,
      fog: false,
    });
    const haloMat = new THREE.SpriteMaterial({
      map: haloTex,
      color: KPAL.gold,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      fog: false,
    });
    this.disposables.push(coreMat, haloMat);
    this.sunCore = new THREE.Sprite(coreMat);
    this.sunCore.scale.set(SUN_CORE_SCALE, SUN_CORE_SCALE, 1);
    this.sunHalo = new THREE.Sprite(haloMat);
    this.sunHalo.scale.set(SUN_HALO_SCALE, SUN_HALO_SCALE, 1);
    this.scene.add(this.sunHalo);
    this.scene.add(this.sunCore);

    this.buildClouds();
    this.buildPost();

    // default golden grade (setTheme re-applies per track); light rides the disc
    this.applyGrade(KPAL.sky, KPAL.horizon, KPAL.fog, 0.006, KPAL.curbWhite, 1.6, 0.6);
    this.aimSun(0, 0, 0);
    this.resize();
  }

  /** Re-tint lights/fog/sky from the track theme. Idempotent. */
  setTheme(theme: TrackTheme): void {
    this.sunDir = theme.sunDir;
    this.applyGrade(
      theme.sky,
      theme.horizon,
      theme.fog,
      theme.fogDensity,
      theme.sunColor,
      theme.sunIntensity,
      theme.hemiIntensity,
    );
    this.aimSun(0, 0, 0); // light direction == the visible disc (long raking shadows)
  }

  /**
   * Build the whole circuit (ground, road ribbon + painted markings, curbs,
   * barrier posts, seeded scatter, hill ring — construction lives in
   * trackMesh.ts). Idempotent — rebuilding disposes the previous track's
   * geometries.
   */
  buildTrack(track: TrackDef): void {
    if (this.trackRoot) {
      this.scene.remove(this.trackRoot);
      disposeGeometries(this.trackRoot);
      this.trackRoot = null;
    }
    this.trackRoot = buildTrackMesh(track, mat);
    this.scene.add(this.trackRoot);
  }

  /** Add a kart; color MUST be its KART_COLORS hex (chassis + helmet). Idempotent. */
  addKart(id: string, color: string): void {
    this.removeKart(id);
    const v = new KartVisual(color, mat);
    this.karts.set(id, v);
    this.scene.add(v.root);
  }

  removeKart(id: string): void {
    const v = this.karts.get(id);
    if (!v) return;
    this.scene.remove(v.root);
    disposeGeometries(v.root);
    this.karts.delete(id);
  }

  /**
   * Push the latest target transform for a kart and ease towards it (~12/s —
   * the interpolation lives in KartVisual.update, callers just forward
   * sim/snapshot poses). First call after addKart snaps. Wheels spin with
   * signed travel distance, the front pair steers, the body rolls slightly
   * while drifting, and while nitroActive a small emissive flame flickers at
   * the exhaust tip (a deterministic scale pulse — no Math.random).
   */
  updateKart(id: string, x: number, y: number, z: number, yaw: number, steer: number, drift: boolean, nitroActive: boolean, dt: number): void {
    const v = this.karts.get(id);
    if (!v) return; // addKart must run first — ignore stray state
    v.update(x, y, z, yaw, steer, drift, nitroActive, dt);
  }

  /**
   * Chase camera: behind + above the watched kart (dist 7 + 0.08*|speed|,
   * height ~3), looking a few meters ahead of it. FOV = 65 + 0.25*km/h, bonus
   * capped at +15 to keep it modest. Position eases at ~8/s; first call snaps.
   * The sun's shadow box follows so shadows stay crisp anywhere on the circuit.
   *
   * Feel layers on top of the frozen base, all derived from the input stream:
   * drift swing (camera yaw trails the kart at ~5.5/s and leans up to ~6° INTO
   * the slide, recovering as it straightens), speed micro-shake (<= 0.23°,
   * frequency ~15 Hz + 0.6 Hz per m/s), brake dive / accel squat (camera pitch
   * from the smoothed longitudinal accel), and a landing dip spring triggered
   * when a hard fall stops. fx.drift (optional) scales the swing when the
   * caller knows the drift state; omitted, the slide is read off the motion.
   */
  setCamera(x: number, y: number, z: number, yaw: number, speed: number, dt: number, fx?: CameraFx): void {
    const dtc = Math.min(Math.max(dt, 0), 0.1); // hitch clamp, same spirit as the ease
    const sp = Math.abs(speed);
    const first = !this.camReady;
    if (first) {
      this.camReady = true;
      this.camYaw = yaw;
      this.swing = 0;
      this.accel = 0;
      this.vy = 0;
      this.prevVy = 0;
      this.dip = 0;
      this.dipV = 0;
      this.prevX = x;
      this.prevY = y;
      this.prevZ = z;
      this.prevSpeed = sp;
    } else if (dtc > 1e-5) {
      const dx = x - this.prevX;
      const dy = y - this.prevY;
      const dz = z - this.prevZ;
      this.prevX = x;
      this.prevY = y;
      this.prevZ = z;
      if (Math.hypot(dx, dz) > TELEPORT_DIST) {
        // respawn teleport — drop every derivative (no phantom slide/shake/dip)
        this.camYaw = yaw;
        this.swing = 0;
        this.accel = 0;
        this.vy = 0;
        this.prevVy = 0;
        this.dip = 0;
        this.dipV = 0;
        this.prevSpeed = sp;
      } else {
        // drift swing: signed lateral slide of the motion vs the facing
        const vx = dx / dtc;
        const vz = dz / dtc;
        const groundSpeed = Math.hypot(vx, vz);
        const fwx = -Math.sin(yaw);
        const fwz = -Math.cos(yaw);
        const latV = vx * fwz - vz * fwx; // + = sliding to the kart's left
        let swingTarget = 0;
        if (groundSpeed > SLIP_MIN_SPEED) {
          // nose sits opposite the slide — leaning -latV yaws INTO the drift
          swingTarget = -clamp(latV / SLIP_REF, -1, 1) * SWING_MAX;
        }
        if (fx?.drift !== undefined) {
          swingTarget *= 0.35 + 0.65 * clamp(fx.drift, 0, 1);
        }
        this.swing += (swingTarget - this.swing) * (1 - Math.exp(-SWING_EASE * dtc));

        // brake dive / accel squat: longitudinal accel of |speed|
        const aRaw = (sp - this.prevSpeed) / dtc;
        this.prevSpeed = sp;
        this.accel += (aRaw - this.accel) * (1 - Math.exp(-ACCEL_EASE * dtc));

        // landing dip: a hard fall coming to a stop fires the spring
        const vyRaw = dy / dtc;
        this.prevVy = this.vy;
        this.vy += (vyRaw - this.vy) * (1 - Math.exp(-VY_EASE * dtc));
        if (this.prevVy < LAND_VY_TRIGGER && this.vy >= LAND_VY_DONE) {
          this.dipV -= Math.min(LAND_MAX, -this.prevVy * LAND_K);
        }
      }
      this.camTime += dtc;
    }
    if (dtc > 1e-5) {
      // landing spring integrates every frame (decays to rest)
      const dipA = -LAND_SPRING * this.dip - LAND_DAMP * this.dipV;
      this.dipV += dipA * dtc;
      this.dip += this.dipV * dtc;
      // drift lag: camera yaw trails the kart, swing riding on top
      this.camYaw += wrapPi(yaw + this.swing - this.camYaw) * (1 - Math.exp(-CAM_YAW_EASE * dtc));
    }

    const cfX = -Math.sin(this.camYaw);
    const cfZ = -Math.cos(this.camYaw);
    const dist = CAM_DIST + CAM_DIST_PER_SPEED * sp;
    const desired = this.camScratch.set(x - cfX * dist, y + CAM_HEIGHT + this.dip, z - cfZ * dist);
    if (first) {
      this.camera.position.copy(desired);
    } else {
      this.camera.position.lerp(desired, 1 - Math.exp(-CAM_EASE * dtc));
    }
    this.camera.lookAt(this.lookScratch.set(x + cfX * CAM_LOOK_AHEAD, y + CAM_LOOK_HEIGHT, z + cfZ * CAM_LOOK_AHEAD));

    // post-lookAt offsets: dive/squat + landing pitch + the speed micro-shake
    const divePitch = clamp(this.accel * PITCH_PER_ACCEL, -PITCH_ACCEL_CAP, PITCH_ACCEL_CAP);
    const shakeAmp = smooth01((sp - SHAKE_START) / (SHAKE_FULL - SHAKE_START)) * SHAKE_MAX;
    let shakeY = 0;
    let shakeP = 0;
    if (shakeAmp > 1e-6) {
      const w = Math.PI * 2 * (SHAKE_F0 + sp * SHAKE_F_PER) * this.camTime;
      shakeY = shakeAmp * (Math.sin(w) * 0.6 + Math.sin(w * 1.37 + 1.7) * 0.4);
      shakeP = shakeAmp * 0.7 * (Math.sin(w * 0.83 + 0.9) * 0.6 + Math.sin(w * 1.61 + 2.6) * 0.4);
    }
    this.camera.rotateX(divePitch + this.dip * 0.35 + shakeP);
    this.camera.rotateY(shakeY);

    const fov = BASE_FOV + Math.min(FOV_BONUS_CAP, FOV_PER_KMH * sp * 3.6);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // shadow box follows the kart; light direction = the visible disc (15° rake)
    this.aimSun(x, 0, z);
    // silhouette fill rides the camera view axis (weak, shadowless)
    this.fill.position.copy(this.camera.position);
    this.fill.target.position.copy(this.lookScratch);
    this.fill.target.updateMatrixWorld();
    // near-subject point fill anchored between camera and kart
    this.kartLight.position
      .copy(this.camera.position)
      .lerp(this.lookScratch, KART_LIGHT_LERP);
    this.kartLight.position.y += 0.8;
  }

  /** Fit renderer + camera to the canvas' laid-out size (DPR capped at 2). */
  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false); // canvas CSS size owned by the app shell
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.updateSky();
    this.renderer.render(this.scene, this.camera);
    // post pass: grade + vignette quads drawn over the frame (no deps)
    this.renderer.autoClear = false;
    this.renderer.render(this.postScene, this.postCam);
    this.renderer.autoClear = true;
  }

  /** Release GPU resources. Materials are shared via the mat() cache — not disposed here. */
  dispose(): void {
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
  }

  // ---- private helpers -------------------------------------------------------------

  /**
   * Golden-hour grade over the theme: a warm key that actually carries the
   * frame, a weak cool-sky / warm-ground hemisphere under it, fog sitting
   * exactly on the horizon stop, re-graded sky dome, cloud palette, sun
   * placement. Every colour is a palette entry or a `mix()` of two.
   *
   * S2 (VISUAL_UPGRADE.md §1): the fog is `theme.fog` UNTOUCHED. The previous
   * pass pulled it 30% toward KPAL.gold, which only survived S2 because the
   * dome's horizon band happened to get the identical pull — two wrongs
   * agreeing. Now both sides are the literal hex, so the ground plane, the
   * ridgelines and the dome fuse on one value and the horizon line is drawn by
   * the terrain rather than by a seam between two near-misses.
   */
  private applyGrade(skyHex: string, horizonHex: string, fogHex: string, fogDensity: number, sunColor: string, sunIntensity: number, hemiIntensity: number): void {
    // hemisphere: cool sky above, warm earth bounce below — free hue split on
    // every surface in the world, and weak enough that the key still reads
    this.hemi.color.set(skyHex);
    this.hemi.groundColor.set(KPAL.dirt);
    this.hemi.intensity = hemiIntensity * HEMI_BOOST;

    this.sun.color.set(sunColor).lerp(COL_GOLD, SUN_WARM);
    this.sun.intensity = sunIntensity * SUN_BOOST;

    // silhouette fill: cool sky-bounce, camera-locked — keeps karts readable
    // without washing the shadow side back to the lit value
    this.fill.color.set(KPAL.curbWhite).lerp(COL_SKY, FILL_COOL);

    const fogCol = new THREE.Color(fogHex); // S2: exactly the horizon stop
    this.scene.fog = new THREE.FogExp2(fogCol, fogDensity * FOG_DENSITY_SCALE);
    this.renderer.setClearColor(fogCol);

    // clouds read BRIGHT against the sky: KPAL.cloud is the lit tier, the
    // shade tier is its own palette entry, and the sun side pulls to gold
    this.cloudCool.set(KPAL.cloud).lerp(new THREE.Color(KPAL.cloudShade), 0.28);
    this.cloudWarm.set(KPAL.cloud).lerp(COL_GOLD, 0.42);
    this.cloudHaze.copy(fogCol);

    this.placeSun();
    this.tintSky(skyHex, horizonHex);
  }

  /** Pin the visible sun disc/halo to the theme sun azimuth, golden-hour height. */
  private placeSun(): void {
    const nx = -this.sunDir[0];
    const nz = -this.sunDir[2];
    const l = Math.hypot(nx, nz) || 1;
    this.sunAz = Math.atan2(nx / l, nz / l);
    const ce = Math.cos(SUN_ELEVATION);
    const se = Math.sin(SUN_ELEVATION);
    this.sunVec.set(Math.sin(this.sunAz) * ce, se, Math.cos(this.sunAz) * ce);
    const d = DOME_RADIUS * 0.96;
    this.sunCore.position.copy(this.sunVec).multiplyScalar(d);
    this.sunHalo.position.copy(this.sunVec).multiplyScalar(d);
  }

  /**
   * Aim the shadow-casting sun AT (tx,ty,tz) FROM the visible disc — the light
   * rides the same azimuth + SUN_ELEVATION as the sky sprite, so the golden-
   * hour disc and the long raking shadows always agree.
   */
  private aimSun(tx: number, ty: number, tz: number): void {
    this.sun.position.set(
      tx + this.sunVec.x * SUN_DISTANCE,
      ty + this.sunVec.y * SUN_DISTANCE,
      tz + this.sunVec.z * SUN_DISTANCE,
    );
    this.sun.target.position.set(tx, ty, tz);
    this.sun.target.updateMatrixWorld();
  }

  /**
   * Rewrite the dome's vertex colors. This is where VISUAL_UPGRADE.md §1 S1
   * actually lands: the zenith stop is KPAL.skyHigh (L 48), the horizon stop is
   * KPAL.horizon (L 85) — 37 L* of separation, and skyHigh is the cooler of the
   * two by blueBias. Both are literal palette entries; the old code derived the
   * zenith by lerping the theme sky 38% toward KPAL.kartBlue, which is a kart
   * colour doing sky duty and produced barely 10 L* of ramp.
   *
   * Bands, bottom to top: distant land below the horizon line, a thin pure
   * KPAL.horizon rim that the fog fuses into, horizon -> KPAL.sky, then
   * KPAL.sky -> KPAL.skyHigh, all weighted low so the ramp finishes inside the
   * band a level chase camera can actually see. A warm blob around the sun
   * azimuth rides on top so the light reads directional.
   */
  private tintSky(topHex: string, bottomHex: string): void {
    const pos = this.sky.geometry.getAttribute('position') as THREE.BufferAttribute;
    let col = this.sky.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!col || col.count !== pos.count) {
      col = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
      this.sky.geometry.setAttribute('color', col);
    }
    const upper = new THREE.Color(topHex); // theme sky — the mid stop
    const zenith = COL_ZENITH; // KPAL.skyHigh, straight from the palette (S1)
    const horizon = new THREE.Color(bottomHex); // == the fog colour (S2)
    const below = new THREE.Color(bottomHex).lerp(COL_LAND_BELOW, DOME_BELOW_LAND);
    const c = new THREE.Color();
    const dir = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / DOME_RADIUS; // -1..1
      if (y <= 0) {
        c.copy(horizon).lerp(below, smooth01(-y * 2.5));
      } else if (y < DOME_RIM_TOP) {
        c.copy(horizon); // flat rim — the fog has to disappear into it
      } else if (y < DOME_MID_TOP) {
        c.copy(horizon).lerp(upper, smooth01((y - DOME_RIM_TOP) / (DOME_MID_TOP - DOME_RIM_TOP)));
      } else if (y < DOME_ZENITH_TOP) {
        c.copy(upper).lerp(zenith, smooth01((y - DOME_MID_TOP) / (DOME_ZENITH_TOP - DOME_MID_TOP)));
      } else {
        c.copy(zenith);
      }
      // warm glow around the sun, climbing well above the horizon band
      dir.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
      const sunAmt =
        Math.pow(Math.max(0, dir.dot(this.sunVec)), SUN_GLOW_POW) * (1 - smooth01(y / 0.7));
      if (sunAmt > 0.001) c.lerp(COL_WARM_GLOW, Math.min(SUN_GLOW_MAX, sunAmt));
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  /**
   * Seeded cloud rig: three drifting layers of shaded sprite-blob clusters.
   * Formations clump around ring-spaced centers (alternating strong/weak
   * quotas) so any ~60° heading holds at least one, with no even-ring look.
   */
  private buildClouds(): void {
    const blobTex = cloudTexture(64);
    this.disposables.push(blobTex);
    for (let li = 0; li < CLOUD_LAYERS.length; li++) {
      const spec = CLOUD_LAYERS[li]!;
      const next = rng(decoSeed('kart-sky', li * 7 + 1));
      const group = new THREE.Group();
      const base = rngRange(next, 0, Math.PI * 2);
      group.rotation.y = base;
      this.cloudLayers.push({ group, base, rate: spec.rate });
      // formation centers + per-center cloud quotas (even centers run double
      // strength — the clumped read); small jitter keeps the 60° guarantee
      const megaAz: number[] = [];
      const megaQuota: number[] = [];
      let weightTotal = 0;
      for (let mi = 0; mi < spec.megas; mi++) {
        megaAz.push((mi / spec.megas) * Math.PI * 2 + rngRange(next, -0.15, 0.15));
        weightTotal += mi % 2 === 0 ? 2 : 1;
      }
      let assigned = 0;
      for (let mi = 0; mi < spec.megas; mi++) {
        const q = Math.floor((spec.count * (mi % 2 === 0 ? 2 : 1)) / weightTotal);
        megaQuota.push(q);
        assigned += q;
      }
      for (let mi = 0; assigned < spec.count; mi = (mi + 1) % spec.megas) {
        megaQuota[mi]! += 1;
        assigned++;
      }
      for (let mi = 0; mi < spec.megas; mi++) {
        const mega = megaAz[mi]!;
        for (let k = 0; k < megaQuota[mi]!; k++) {
          // bell-ish scatter around the formation center (two rolls)
          const azimuth = mega + (next() + next() - 1) * spec.megaSpread;
          const r = spec.radius + rngRange(next, -25, 25);
          const cloud = new THREE.Group();
          cloud.position.set(
            Math.sin(azimuth) * r,
            rngRange(next, spec.yMin, spec.yMax),
            Math.cos(azimuth) * r,
          );
          const mats: THREE.SpriteMaterial[] = [];
          const puffs = rngInt(next, spec.puffs[0], spec.puffs[1]);
          const wBase = rngRange(next, spec.wMin, spec.wMax);
          const hBase = rngRange(next, spec.hMin, spec.hMax);
          const oBase = spec.opacity * rngRange(next, 0.85, 1);
          for (let pi = 0; pi < puffs; pi++) {
            // big solid center, smaller trailings (per-puff falloff)
            const fall = pi === 0 ? 1 : rngRange(next, 0.5, 0.82);
            const puffMat = new THREE.SpriteMaterial({
              map: blobTex,
              color: KPAL.cloud,
              transparent: true,
              // trailings stay substantial — at the old 0.45..0.7 they read as
              // smoke drifting off the mass instead of part of the same cloud
              opacity: oBase * (pi === 0 ? 1 : rngRange(next, 0.68, 0.92)),
              depthWrite: false,
              fog: false,
            });
            this.disposables.push(puffMat);
            mats.push(puffMat);
            const puff = new THREE.Sprite(puffMat);
            const wPuff = wBase * fall;
            const hPuff = pi === 0 ? hBase : hBase * fall * 0.95;
            // TRUE flat bottoms. Sprite anchors are centres, so equal y put the
            // base of every short puff ABOVE the centre puff's and the cluster
            // hung in the air; dropping each puff by half its height deficit
            // parks every base on one line. The lift is upward-only, so mass
            // piles onto the top — cauliflower crown, flat shadowed underside.
            puff.position.set(
              pi === 0 ? 0 : rngRange(next, -0.5, 0.5) * wBase,
              (hPuff - hBase) / 2 + (pi === 0 ? 0 : rngRange(next, 0, 0.22) * hPuff),
              rngRange(next, -8, 8),
            );
            puff.scale.set(wPuff, hPuff, 1);
            cloud.add(puff);
          }
          group.add(cloud);
          this.clouds.push({
            mats,
            azimuth,
            layer: group,
            warmthBias: rngRange(next, -0.08, 0.08),
            haze: spec.haze,
          });
        }
      }
      this.scene.add(group);
    }
  }

  /**
   * Dependency-free post pass: two fullscreen quads — a subtle warm grade
   * lift (stronger toward the sky half) and a KPAL.ink vignette. Shader
   * outputs raw sRGB (ShaderMaterial skips tone mapping / color conversion),
   * so uniforms are hand-decoded sRGB components.
   */
  private buildPost(): void {
    const VERT =
      'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    // Weighted to the GROUND half, not the sky half. The old ramp put its
    // strongest gold wash at the top of the frame, which fought the cool
    // zenith S1 exists to create; warming the lower half instead reinforces
    // the same cool-sky / warm-earth split the hemisphere light is making.
    const GRADE_FRAG =
      'varying vec2 vUv; uniform vec3 uColor; uniform float uAlpha;' +
      'void main() { gl_FragColor = vec4(uColor, uAlpha * (0.55 + 0.45 * (1.0 - vUv.y))); }';
    const VIGNETTE_FRAG =
      'varying vec2 vUv; uniform vec3 uColor; uniform float uAlpha;' +
      'void main() {' +
      '  vec2 p = (vUv - 0.5) * vec2(1.15, 1.0);' +
      '  float a = smoothstep(0.52, 1.05, length(p) * 1.4142) * uAlpha;' +
      '  gl_FragColor = vec4(uColor, a);' +
      '}';
    const gradeMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: GRADE_FRAG,
      uniforms: { uColor: { value: srgbUniform(KPAL.gold) }, uAlpha: { value: GRADE_ALPHA } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const vignetteMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: VIGNETTE_FRAG,
      uniforms: { uColor: { value: srgbUniform(KPAL.ink) }, uAlpha: { value: VIGNETTE_ALPHA } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.disposables.push(gradeMat, vignetteMat);
    const grade = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), gradeMat);
    grade.frustumCulled = false;
    grade.renderOrder = 1;
    const vignette = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), vignetteMat);
    vignette.frustumCulled = false;
    vignette.renderOrder = 2;
    this.disposables.push(grade.geometry, vignette.geometry);
    this.postScene.add(grade);
    this.postScene.add(vignette);
  }

  /** Per-frame sky motion: deterministic drift + sun-side cloud tinting. */
  private updateSky(): void {
    for (const layer of this.cloudLayers) {
      layer.group.rotation.y = layer.base + this.camTime * layer.rate;
    }
    for (const cloud of this.clouds) {
      const az = cloud.azimuth + cloud.layer.rotation.y;
      const warm = Math.pow(Math.max(0, Math.cos(az - this.sunAz)), 2);
      const t = clamp(warm * 0.85 + cloud.warmthBias, 0, 1);
      for (const m of cloud.mats) {
        m.color.copy(this.cloudCool).lerp(this.cloudWarm, t).lerp(this.cloudHaze, cloud.haze);
      }
    }
  }

  /** Tracked context-error overlay (single element; never duplicated). */
  private static contextErrorEl: HTMLDivElement | null = null;

  /** Full-viewport readable failure message (KPAL colors); idempotent. */
  private static showContextError(): void {
    if (KartScene.contextErrorEl?.isConnected) return;
    const div = document.createElement('div');
    div.textContent = 'WebGL is not available in this browser — KART GP needs GPU rendering to run.';
    const s = div.style;
    s.position = 'fixed';
    s.inset = '0';
    s.display = 'flex';
    s.alignItems = 'center';
    s.justifyContent = 'center';
    s.padding = '24px';
    s.textAlign = 'center';
    s.background = KPAL.ink;
    s.color = KPAL.hudText;
    s.font = '16px/1.5 system-ui, sans-serif';
    s.zIndex = '1000';
    document.body.appendChild(div);
    KartScene.contextErrorEl = div;
  }
}
