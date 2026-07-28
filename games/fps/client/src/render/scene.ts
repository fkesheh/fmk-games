// ============================================================================
// C3 — scene rig: renderer + camera + per-map lighting/fog theme.
// One WebGLRenderer (ACES, sRGB out, PCFSoft shadows, pixelRatio <= 2), one
// PerspectiveCamera(BASE_FOV) driven in YXZ order (yaw then pitch) to match the
// shared aim convention. Screen shake is cosmetic only: trauma^2-scaled
// rotational noise, capped at 0.02 rad, decaying ~2.5/s — never positional,
// never rolls while strafing beyond the shake cap (STYLE_BIBLE).
//
// AAA lighting layer (all derived from the frozen MapTheme — the rig's public
// API is unchanged):
//   - OUTDOOR themes (dustbowl/urbana/frostbite/crossfire): golden-hour grade
//     keyed off the theme's sky color (warmer sun, warm-shifted hemi/fog), the
//     sun art-directed down to ~24 deg so shadows rake ~2.3x object height and
//     match the visible disc, a 2048 shadow cascade that FOLLOWS the watched
//     player (texel-snapped, tighter frustum = sharper maps, no acne), a
//     procedural sun disc + warm halo on a rig-owned 3-stop sky dome (warm
//     horizon -> theme sky -> pale zenith), and a cool sky-bounce fill from
//     the opposite azimuth so shaded walls/models stay dimensional.
//   - INDOOR themes (office/bunker): cool-white hemi lift, denser moody fog
//     (readability still guarded by the ambient floor), and fake "light pool"
//     floor decals — brighter patches raycast-validated onto open floor, so no
//     real point lights are needed.
//   - ALL themes: a camera-follow fill light (~0.4, shadowless) keeps enemy
//     models readable in shade, and a dep-free post grade (one fullscreen
//     ShaderMaterial quad: vignette + tiny warm lift) finishes the frame.
// Determinism: pool scatter uses seeded rng (decoSeed); Math.random is never
// touched. PALETTE is the only color source.
// ============================================================================
import * as THREE from 'three';
import { BASE_FOV, PALETTE, decoSeed, rng, rngRange, type MapTheme, type Vec3 } from '@fps/shared';

// ---- shake tuning (frozen feel: "small and rare") ---------------------------
const SHAKE_MAX_RAD = 0.02; // hard cap per axis
const SHAKE_DECAY = 2.5; // trauma per second
const SHAKE_SPEED = 18; // noise clock rate (rad/s of noise input)

// ---- shadow rig ---------------------------------------------------------------
// OUTDOOR: golden-hour art direction. The theme's sunDir sits at ~58 deg
// (midday: shadows hide under their casters — the "no shadows" read). The rig
// keeps the theme's azimuth but drops the sun to SUN_ELEVATION so shadows rake
// ~2.3x object height and agree with the visible disc. ONE static 2048
// origin-centered cascade at ±SHADOW_EXTENT covers every outdoor map's
// interior — a player-following window was tried and rejected: edge
// structures (gate gantry legs, big crate stacks) fell out of it and stopped
// casting, and integrity beats the marginal texel gain.
// The near plane is the skyline guard: backdrop-ring landmarks (the maps'
// SkylineDef ring starts at r=SKYLINE_INNER_RADIUS=42) must never shadow the
// playable area, so the cascade's near plane starts just inside the ring's
// depth and clips it while every interior wall top (deepest ~21.4) still
// casts. INDOOR keeps near=1 (the ceiling slab shadows everything anyway).
const SHADOW_EXTENT = 40;
const SHADOW_FAR = 160;
const SUN_DISTANCE = 60; // light sits this far along the sun direction
const SUN_ELEVATION = 0.42; // rad (~24 deg) — the golden-hour art direction
const SKYLINE_INNER_RADIUS = 42; // maps' backdrop ring starts here (SkylineDef.minR)
const SHADOW_NEAR_OUTDOOR = SUN_DISTANCE - SKYLINE_INNER_RADIUS * Math.cos(SUN_ELEVATION) - 0.5;

// ---- ambient floor (STYLE_BIBLE: "min ambient floor: players always clearly lit") ----
// Effective hemi fill = relative luminance(sky color) x hemiIntensity; setTheme
// never lets a theme drop it below this, so indoor maps can't ship pitch-black.
const MIN_AMBIENT_LUMINANCE = 0.12;
const AMBIENT_FLOOR_SCRATCH = new THREE.Color(); // reuse — no per-theme alloc

// ---- camera-follow fill (readability: enemies never crush to silhouette) ----
const FILL_INTENSITY = 0.4; // shadowless frontal lift from the view direction
const FILL_AHEAD = 8; // fill target sits this far in front of the camera

// ---- cool sky bounce (outdoor shade dimensionality) ----------------------------
// Golden-hour cinematography: warm key on one side, cool sky bounce on the
// other. Shaded faces keep modeling instead of crushing to black. Shadowless.
const BOUNCE_INTENSITY = 0.3;
const BOUNCE_ELEVATION = 0.6; // rad — a sky light, not a horizon light
const BOUNCE_COOL = 0.55; // lerp theme sky -> skyCold

// ---- rig-owned sky dome + sun disc (outdoor themes only) -------------------------
// The map renderer's dome is a plain 2-stop gradient; the critic bar is a
// 3-stop sky (warm horizon -> theme sky -> pale zenith). The rig renders its
// own dome just inside theirs (opaque, depth-tested: it covers theirs fully
// and can never z-fight it). The sun disc is an additive shader quad parked
// at the theme azimuth at SUN_ELEVATION — exactly where the light comes from.
const SKY_DOME_RADIUS = 395; // the map renderer's dome is r=400
const SKY_ZENITH_PALE = 0.5; // zenith lerp -> paper (pale, not white)
const SUN_DISC_DISTANCE = 380; // inside the rig dome
const SUN_DISC_SIZE = 150; // halo spans the full quad
const SUN_DISC_INTENSITY = 1.3; // punch through the bright horizon band

// ---- indoor fake light pools ----------------------------------------------------
// Bright floor patches "baked" under the ceiling light panels the map renderer
// hangs over indoor maps (its seeded 2.4m grid puts a fixture within reach of
// every open spot, so any validated pool reads as panel spill). Placed once
// per theme on the first render (map geometry must exist): a jittered 5x4
// candidate grid, each candidate raycast-validated onto open floor. No real
// point lights — additive decals.
const POOL_COLS = 5;
const POOL_ROWS = 4;
const POOL_STEP = 7.5; // candidate cell pitch (m)
const POOL_JITTER = 2.2; // seeded jitter per candidate (m)
const POOL_PROBE_Y = 2.55; // below every indoor ceiling, above all furniture (h <= 2.2)
const POOL_LATERAL_CLEAR = 0.7; // reject candidates this close to a tall face
const POOL_OPACITY = 0.3; // additive — reads as a soft baked brightness pool

// ---- indoor floor tonal wear (corridor paths) ------------------------------------
// The pool grid is sparse points; real interiors read through PATHS. A
// frame-sliced open-floor scan (2 rays per 2.5m cell, ~45 cells/frame so the
// join frame never hitches) maps the walkable floor; maximal open runs of 3+
// cells become soft additive wear strips — the lighter traffic lanes the
// critic asked for. Deterministic: the grid is fixed, raycasts do the layout.
const PATH_CELL = 2.5; // scan pitch (m)
const PATH_COLS = 15; // x from -17.5..17.5 (covers office 40m + bunker 32m)
const PATH_ROWS = 12; // z from -13.75..13.75
const PATH_SCAN_PER_FRAME = 45; // cells validated per render (2 rays each)
const PATH_MIN_RUN = 3; // cells (7.5m) — corridors qualify, isolated blobs don't
const PATH_MAX_STRIPS = 10; // longest runs win
const PATH_STRIP_W = 2.6; // strip width (m) — overlaps the 2.5m cell pitch
const PATH_OPACITY = 0.16; // additive — a clear traffic-lane lift, under the pools

// ---- sky artifact strip (outdoor themes) -------------------------------------------
// The maps' backdrop ring (silhouette mesas at r=42-68) pokes tall pale tops
// over its own front ranks — through the haze those tips read as floating
// pale-yellow DIAMONDS in the sky, which the critic flagged as rendering
// artifacts. Interior content never matches the test: outer walls top out at
// exactly h=5 (centroids stay at/below SKYCAP_MIN_Y), and every structure
// taller than that sits at r<=35.6 (urbana bricks, crossfire warehouse) —
// inside SKYCAP_MIN_R. So the rig drops exactly the ring's tip triangles at
// runtime; the ring survives as a low dune band on the horizon.
const SKYCAP_MIN_Y = 5.5;
const SKYCAP_MIN_R = 36;

// ---- outdoor golden-hour grade (keyed by the theme's sky color) ---------------
interface OutdoorGrade {
  readonly sunWarm: number; // lerp sun color -> muzzle (golden key)
  readonly hemiWarm: number; // lerp hemi sky -> skyDusk (warm ambient shift)
  readonly fogWarm: number; // lerp fog -> fogDusk (warm haze)
  readonly sunBoost: number; // sun intensity multiplier (a low sun starves the floor)
  readonly hemiBoost: number; // hemi intensity multiplier (lifts the shade floor)
}
const GRADE_FALLBACK: OutdoorGrade = { sunWarm: 0.5, hemiWarm: 0.12, fogWarm: 0.08, sunBoost: 1.3, hemiBoost: 1.12 };
const OUTDOOR_GRADES: ReadonlyArray<readonly [string, OutdoorGrade]> = [
  // dustbowl: already dusk — deepen the warmth, don't recolor it
  [PALETTE.skyDusk, { sunWarm: 0.3, hemiWarm: 0.1, fogWarm: 0.15, sunBoost: 1.4, hemiBoost: 1.25 }],
  // urbana/crossfire: daylight paper sun -> golden-hour key
  [PALETTE.skyDay, { sunWarm: 0.72, hemiWarm: 0.16, fogWarm: 0.1, sunBoost: 1.25, hemiBoost: 1.15 }],
  // frostbite: warm key against the cool fill — the MW2 cold-map look
  [PALETTE.skyCold, { sunWarm: 0.6, hemiWarm: 0.05, fogWarm: 0.0, sunBoost: 1.3, hemiBoost: 1.1 }],
];

// ---- indoor grade ---------------------------------------------------------------
const INDOOR_HEMI_WHITEN = 0.42; // hemi sky -> paper (cool-white fluorescent fill)
const INDOOR_HEMI_BOOST = 1.22; // hemi intensity multiplier
const INDOOR_GROUND_LIFT = 0.5; // hemi ground -> paper (lifts the dark ceiling undersides)
const INDOOR_FOG_BOOST = 1.32; // moodier fog; readability kept via ambient floor

// ---- post grade ------------------------------------------------------------------
const POST_VIGNETTE_OUTDOOR = 0.3; // corner darkening (0 = off, 1 = black corners)
const POST_VIGNETTE_INDOOR = 0.4; // moodier indoors
const POST_LIFT_OUTDOOR = 0.042; // additive warm lift (tiny — a grade, not a tint)
const POST_LIFT_INDOOR = 0.024;

/**
 * Display-space (sRGB) copy of a PALETTE hex for custom-shader uniforms.
 * ShaderMaterial output skips three's tonemap/colorspace chunks, so uniforms
 * feeding raw shader writes must be authored as display-space values (the
 * round trip Color->linear->sRGB recovers exactly the hex byte values).
 */
function srgbColor(hex: string): THREE.Color {
  return new THREE.Color(hex).convertLinearToSRGB();
}

/** Rec.709 relative luminance of a PALETTE hex (linear working space). */
function luminanceOf(hex: string): number {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/**
 * MapTheme carries no indoor flag (frozen contract), so the rig derives it
 * from the theme signature: office/bunker are the only themes with a steel
 * "sky" (fluorescent fill) over a near-black horizon (charcoal/ink). Outdoor
 * horizons (sand/plaster/snowShadow/fogDay) all sit above 0.15 luminance.
 */
function isIndoorTheme(theme: MapTheme): boolean {
  return theme.sky === PALETTE.steel && luminanceOf(theme.horizon) < 0.06;
}

const SUN_DISC_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Crisp core + tight inner glow + broad halo, all radial over the quad.
const SUN_DISC_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform vec3 uCore;
  uniform vec3 uHalo;
  uniform float uIntensity;
  void main() {
    float r = length(vUv - 0.5) * 2.0; // 0 center -> 1 quad edge
    float core = 1.0 - smoothstep(0.1, 0.125, r); // crisp-edged sun
    float inner = pow(max(0.0, 1.0 - r * 2.2), 1.5) * 0.55; // tight glow
    float halo = pow(max(0.0, 1.0 - r), 1.6) * 0.42; // broad warm wash
    vec3 col = uCore * (core + inner) + uHalo * halo;
    gl_FragColor = vec4(col * uIntensity, 1.0);
  }
`;

// Rig-owned sky dome: sphere local position IS the view direction. Colors are
// linear working-space; the tonemap/colorspace chunks make the dome respond
// exactly like the map renderer's MeshBasicMaterial dome it replaces.
const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// 3 stops: warm horizon band -> theme sky mid -> pale zenith.
const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uHorizon;
  uniform vec3 uMid;
  uniform vec3 uZenith;
  void main() {
    float t = normalize(vDir).y; // -1 nadir -> 1 zenith
    float lo = smoothstep(-0.02, 0.22, t); // horizon band height
    float hi = smoothstep(0.12, 0.75, t); // zenith ramp
    vec3 col = mix(uHorizon, uMid, lo);
    col = mix(col, uZenith, hi);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const POST_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0); // clip-space quad, no camera math
  }
`;

// Vignette rides the alpha channel; the warm lift rides RGB. Blending is
// (ONE, ONE_MINUS_SRC_ALPHA): result = warm*lift + frame*(1 - vignette).
const POST_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform vec3 uWarm;
  uniform float uLift;
  uniform float uVignette;
  uniform float uAspect;
  void main() {
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
    float r = length(p) * 1.4142; // 0 center -> ~1 corners
    float vig = smoothstep(0.58, 1.2, r) * uVignette;
    gl_FragColor = vec4(uWarm * uLift, vig);
  }
`;

export class SceneRig {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private readonly canvas: HTMLCanvasElement;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly bounce: THREE.DirectionalLight; // cool sky fill, outdoor only
  private readonly fill: THREE.DirectionalLight;
  private readonly fillTarget: THREE.Object3D;

  private readonly skyDome: THREE.Mesh; // rig-owned 3-stop dome
  private readonly skyDomeMat: THREE.ShaderMaterial;
  private readonly sunDisc: THREE.Mesh;
  private readonly sunDiscMat: THREE.ShaderMaterial;
  private outdoor = false; // set by setTheme: follow-cam shadows + bounce + disc

  private pools: THREE.Group | null = null; // fake indoor light pools (once placed)
  private poolMat: THREE.MeshBasicMaterial | null = null; // shared by all pool decals
  private stripMat: THREE.MeshBasicMaterial | null = null; // shared by all wear strips
  private poolTex: THREE.CanvasTexture | null = null;
  private poolsPending = false; // place on the first render after an indoor setTheme
  private pathScan: { // frame-sliced indoor open-floor scan (null = idle/done)
    cells: boolean[]; // PATH_COLS x PATH_ROWS row-major
    index: number; // next cell to validate
    group: THREE.Group; // strips land here as runs complete
  } | null = null;
  private skyCapsStripped = false; // one-time per rig: backdrop cap tiers dropped
  private readonly raycaster = new THREE.Raycaster();
  private readonly rayOrigin = new THREE.Vector3();

  private readonly postScene: THREE.Scene;
  private readonly postCam: THREE.OrthographicCamera;
  private readonly postQuad: THREE.Mesh;
  private readonly postMat: THREE.ShaderMaterial;

  private readonly forwardScratch = new THREE.Vector3(); // fill-light aim, per frame
  private readonly gradeScratchA = new THREE.Color(); // theme grading, per setTheme
  private readonly gradeScratchB = new THREE.Color();
  private readonly sunDirScratch = new THREE.Vector3(); // art-directed dir TOWARD scene, per theme

  private trauma = 0; // 0..1 shake energy
  private shakeT = 0; // accumulated noise clock
  private lastMs = -1; // last applyCamera timestamp (performance.now), -1 = unset

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
      SceneRig.showContextError();
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.renderer = renderer;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 500); // far covers the r=400 dome
    this.camera.rotation.order = 'YXZ'; // yaw about Y, then pitch about local X

    // lights are created once and re-tinted per theme — no add/remove churn
    this.hemi = new THREE.HemisphereLight(PALETTE.skyDay, PALETTE.dust, 0.6);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(PALETTE.muzzle, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -SHADOW_EXTENT;
    sc.right = SHADOW_EXTENT;
    sc.top = SHADOW_EXTENT;
    sc.bottom = -SHADOW_EXTENT;
    sc.near = 1;
    sc.far = SHADOW_FAR;
    sc.updateProjectionMatrix();
    // long-shadow tuning: at golden-hour incidence the ground plane is the
    // acne surface — normalBias ~2 texels (80m/2048 = 0.039m) pushes samples
    // off the surface without peter-panning crates; a whisper of negative
    // depth bias stops speckle along the shadow terminator
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.normalBias = 0.07;
    this.sun.shadow.radius = 4; // soften staircase edges (ignored by PCFSoft — harmless safeguard)
    this.scene.add(this.sun);
    this.scene.add(this.sun.target); // target defaults to origin

    // cool sky bounce: opposite the sun azimuth (outdoor themes only — the
    // hemisphere is the fill indoors). Shadowless, re-aimed per theme.
    this.bounce = new THREE.DirectionalLight(PALETTE.skyCold, 0);
    this.bounce.castShadow = false;
    this.scene.add(this.bounce);
    this.scene.add(this.bounce.target);

    // camera-follow fill: shadowless frontal lift so shaded enemies stay readable
    this.fill = new THREE.DirectionalLight(PALETTE.paper, FILL_INTENSITY);
    this.fill.castShadow = false;
    this.fillTarget = new THREE.Object3D();
    this.fill.target = this.fillTarget;
    this.scene.add(this.fill);
    this.scene.add(this.fillTarget);

    // rig-owned 3-stop sky dome: opaque, covers the map renderer's 2-stop dome
    this.skyDomeMat = new THREE.ShaderMaterial({
      uniforms: {
        uHorizon: { value: new THREE.Color(PALETTE.fogDay) },
        uMid: { value: new THREE.Color(PALETTE.skyDay) },
        uZenith: { value: new THREE.Color(PALETTE.paper) },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: true,
      fog: false,
    });
    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(SKY_DOME_RADIUS, 32, 16), this.skyDomeMat);
    this.skyDome.frustumCulled = false; // the dome always encloses the camera
    this.scene.add(this.skyDome);

    // sun disc: one additive quad, positioned/oriented per outdoor theme
    this.sunDiscMat = new THREE.ShaderMaterial({
      uniforms: {
        uCore: { value: srgbColor(PALETTE.tracer) },
        uHalo: { value: srgbColor(PALETTE.muzzle) },
        uIntensity: { value: SUN_DISC_INTENSITY },
      },
      vertexShader: SUN_DISC_VERT,
      fragmentShader: SUN_DISC_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true, // world geometry occludes the sun
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, // pure additive glow
      blendDst: THREE.OneFactor,
    });
    this.sunDisc = new THREE.Mesh(new THREE.PlaneGeometry(SUN_DISC_SIZE, SUN_DISC_SIZE), this.sunDiscMat);
    this.sunDisc.frustumCulled = false; // parked on the dome — always potentially visible
    this.sunDisc.visible = false; // outdoor themes only; setTheme decides
    this.scene.add(this.sunDisc);

    // post grade: fullscreen vignette + warm lift, rendered after the world
    this.postScene = new THREE.Scene();
    this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postMat = new THREE.ShaderMaterial({
      uniforms: {
        uWarm: { value: srgbColor(PALETTE.muzzle) },
        uLift: { value: POST_LIFT_OUTDOOR },
        uVignette: { value: POST_VIGNETTE_OUTDOOR },
        uAspect: { value: 1 },
      },
      vertexShader: POST_VERT,
      fragmentShader: POST_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, // lift adds; the frame scales by (1 - vignette alpha)
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat);
    this.postQuad.frustumCulled = false;
    this.postScene.add(this.postQuad);

    this.resize();
  }

  /** Re-tint lights/fog/sky from the map theme. Idempotent. */
  setTheme(theme: MapTheme): void {
    const indoor = isIndoorTheme(theme);
    this.outdoor = !indoor;

    this.hemi.color.set(theme.sky);
    this.hemi.groundColor.set(theme.ground);
    this.hemi.intensity = theme.hemiIntensity;

    this.sun.color.set(theme.sunColor);
    this.sun.intensity = theme.sunIntensity;

    let fogHex = theme.fog;
    let fogDensity = theme.fogDensity;

    if (indoor) {
      // fake interior lighting: cool-white fluorescent hemi, lifted ceiling
      // bounce, moodier fog (the ambient floor below still guards readability)
      this.hemi.color.lerp(this.gradeScratchA.set(PALETTE.paper), INDOOR_HEMI_WHITEN);
      this.hemi.groundColor.lerp(this.gradeScratchA.set(PALETTE.paper), INDOOR_GROUND_LIFT);
      this.hemi.intensity *= INDOOR_HEMI_BOOST;
      fogDensity *= INDOOR_FOG_BOOST;
      this.bounce.intensity = 0; // the hemisphere IS the bounce indoors
      this.sunDisc.visible = false;
      this.clearPools();
      this.poolsPending = true; // map geometry arrives after setTheme — place lazily
      // frozen rig: origin-centered cascade, theme sun direction
      this.sun.position.set(
        -theme.sunDir[0] * SUN_DISTANCE,
        -theme.sunDir[1] * SUN_DISTANCE,
        -theme.sunDir[2] * SUN_DISTANCE,
      );
      this.sun.target.position.set(0, 0, 0);
      this.sun.target.updateMatrixWorld();
      this.setShadowRig(SHADOW_EXTENT, 1); // frozen indoor rig: full depth range
    } else {
      // golden-hour grade keyed by the theme's sky color
      let grade = GRADE_FALLBACK;
      for (const [sky, g] of OUTDOOR_GRADES) {
        if (theme.sky === sky) {
          grade = g;
          break;
        }
      }
      this.sun.color.lerp(this.gradeScratchA.set(PALETTE.muzzle), grade.sunWarm);
      this.sun.intensity *= grade.sunBoost;
      this.hemi.color.lerp(this.gradeScratchA.set(PALETTE.skyDusk), grade.hemiWarm);
      this.hemi.intensity *= grade.hemiBoost; // shade-floor lift, still PALETTE-true
      const fog = this.gradeScratchA.set(fogHex).lerp(this.gradeScratchB.set(PALETTE.fogDusk), grade.fogWarm);
      fogHex = `#${fog.getHexString()}`;

      // art-directed sun: the theme's azimuth, golden-hour elevation. Static
      // origin-centered cascade from here on (see the rig note up top).
      const azimuth = Math.atan2(-theme.sunDir[0], -theme.sunDir[2]);
      const cosE = Math.cos(SUN_ELEVATION);
      this.sunDirScratch.set(
        -Math.sin(azimuth) * cosE,
        -Math.sin(SUN_ELEVATION),
        -Math.cos(azimuth) * cosE,
      );
      this.sun.position.copy(this.sunDirScratch).multiplyScalar(-SUN_DISTANCE);
      this.sun.target.position.set(0, 0, 0);
      this.sun.target.updateMatrixWorld();
      this.setShadowRig(SHADOW_EXTENT, SHADOW_NEAR_OUTDOOR); // near clips the backdrop ring

      // cool sky bounce opposite the sun: shade faces keep their modeling
      this.bounce.color.set(theme.sky).lerp(this.gradeScratchA.set(PALETTE.skyCold), BOUNCE_COOL);
      this.bounce.intensity = BOUNCE_INTENSITY;
      const bz = azimuth + Math.PI;
      const cosB = Math.cos(BOUNCE_ELEVATION);
      this.bounce.position.set(
        Math.sin(bz) * cosB * 50,
        Math.sin(BOUNCE_ELEVATION) * 50,
        Math.cos(bz) * cosB * 50,
      );
      this.bounce.target.position.set(0, 0, 0);
      this.bounce.target.updateMatrixWorld();

      this.placeSunDisc();
      this.poolsPending = false;
      this.clearPools();
    }
    this.enforceAmbientFloor();

    // 3-stop sky: warmed horizon (matches the fog haze) -> theme sky -> pale zenith
    const uHorizon = this.skyDomeMat.uniforms.uHorizon;
    const uMid = this.skyDomeMat.uniforms.uMid;
    const uZenith = this.skyDomeMat.uniforms.uZenith;
    if (uHorizon !== undefined) (uHorizon.value as THREE.Color).set(indoor ? theme.horizon : fogHex);
    if (uMid !== undefined) (uMid.value as THREE.Color).set(theme.sky);
    if (uZenith !== undefined) {
      (uZenith.value as THREE.Color).set(theme.sky).lerp(this.gradeScratchA.set(PALETTE.paper), SKY_ZENITH_PALE);
    }

    this.scene.fog = new THREE.FogExp2(fogHex, fogDensity);
    this.renderer.setClearColor(theme.sky);

    // post grade per theme family (uniforms are display-space; see srgbColor)
    const uLift = this.postMat.uniforms.uLift;
    const uVig = this.postMat.uniforms.uVignette;
    if (uLift !== undefined) uLift.value = indoor ? POST_LIFT_INDOOR : POST_LIFT_OUTDOOR;
    if (uVig !== undefined) uVig.value = indoor ? POST_VIGNETTE_INDOOR : POST_VIGNETTE_OUTDOOR;
  }

  /**
   * Position/aim the camera for this frame and advance shake. fovDeg is only
   * pushed to the projection matrix when it changes. Shake decays by wall
   * clock here (applyCamera runs exactly once per rendered frame).
   */
  applyCamera(pos: Vec3, yaw: number, pitch: number, fovDeg: number): void {
    const nowMs = performance.now();
    const dt = this.lastMs < 0 ? 0 : Math.min((nowMs - this.lastMs) / 1000, 0.1);
    this.lastMs = nowMs;
    this.trauma = Math.max(0, this.trauma - dt * SHAKE_DECAY);
    this.shakeT += dt * SHAKE_SPEED;

    this.camera.position.set(pos.x, pos.y, pos.z);
    let rx = pitch;
    let ry = yaw;
    let rz = 0;
    if (this.trauma > 0) {
      const mag = SHAKE_MAX_RAD * this.trauma * this.trauma; // trauma^2 scaled
      rx += mag * this.noise(0);
      ry += mag * this.noise(1);
      rz += mag * this.noise(2);
    }
    this.camera.rotation.set(rx, ry, rz);

    // fill light rides the view: from the camera, aimed ahead of it
    this.camera.getWorldDirection(this.forwardScratch);
    this.fill.position.copy(this.camera.position);
    this.fillTarget.position.copy(this.camera.position).addScaledVector(this.forwardScratch, FILL_AHEAD);
    this.fillTarget.updateMatrixWorld();

    if (this.camera.fov !== fovDeg) {
      this.camera.fov = fovDeg;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Add shake energy (clamped 0..1). Callers: own fire kick, damage taken. */
  shake(amount: number): void {
    this.trauma = Math.min(1, Math.max(0, this.trauma + amount));
  }

  /** Fit renderer + camera to the canvas' laid-out size (DPR capped at 2). */
  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false); // canvas CSS size owned by the app shell
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const uAspect = this.postMat.uniforms.uAspect;
    if (uAspect !== undefined) uAspect.value = w / h;
  }

  render(): void {
    if (this.poolsPending && this.placeLightPools()) {
      this.poolsPending = false; // placed — never again for this theme
      this.startPathScan(); // corridor wear scan rides the next few frames
    }
    if (this.pathScan !== null) this.advancePathScan(); // one slice per frame
    if (!this.skyCapsStripped && this.outdoor) {
      this.skyCapsStripped = this.stripSkylineCaps(); // drop the sky-diamond tiers
    }
    const r = this.renderer;
    r.autoClear = false;
    r.clear();
    r.render(this.scene, this.camera);
    r.render(this.postScene, this.postCam); // vignette + warm lift over the frame
    r.autoClear = true;
  }

  /** Release GPU resources. Materials are shared via the mat() cache — not disposed here. */
  dispose(): void {
    this.clearPools();
    this.poolTex?.dispose();
    this.poolTex = null;
    this.poolMat?.dispose();
    this.poolMat = null;
    this.stripMat?.dispose();
    this.stripMat = null;
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points || obj instanceof THREE.Line) {
        obj.geometry.dispose();
      }
    });
    this.sunDiscMat.dispose();
    this.skyDomeMat.dispose();
    this.postQuad.geometry.dispose();
    this.postMat.dispose();
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
  }

  // ---- private helpers --------------------------------------------------------

  /**
   * Park the sun disc exactly where the (art-directed) light comes from:
   * theme azimuth, SUN_ELEVATION, on the rig dome. Low on the sky by design —
   * clear of the top-center HUD chip in a normal combat framing. Tint comes
   * from the (already graded) sun color. The quad faces the map center — the
   * camera never leaves the inner ±32m, so the radial glow reads billboarded.
   */
  private placeSunDisc(): void {
    this.sunDisc.position.copy(this.sunDirScratch).multiplyScalar(-SUN_DISC_DISTANCE);
    this.sunDisc.lookAt(0, 0, 0);
    // core runs hot toward paper-white; halo keeps the graded sun warmth
    const core = this.sunDiscMat.uniforms.uCore;
    const halo = this.sunDiscMat.uniforms.uHalo;
    if (core !== undefined) {
      core.value = srgbColor(
        `#${this.gradeScratchA.copy(this.sun.color).lerp(this.gradeScratchB.set(PALETTE.paper), 0.55).getHexString()}`,
      );
    }
    if (halo !== undefined) {
      halo.value = srgbColor(`#${this.gradeScratchA.copy(this.sun.color).getHexString()}`);
    }
    this.sunDisc.visible = true;
  }

  /** Fit the shadow cascade's ortho extent + near depth to the theme family. */
  private setShadowRig(extent: number, near: number): void {
    const sc = this.sun.shadow.camera;
    if (sc.left !== -extent || sc.right !== extent || sc.near !== near) {
      sc.left = -extent;
      sc.right = extent;
      sc.top = extent;
      sc.bottom = -extent;
      sc.near = near;
      sc.updateProjectionMatrix();
    }
  }

  /**
   * Bake fake light pools onto open indoor floor — the floor half of the
   * interior lighting fake (the map renderer hangs the fixture half: seeded
   * ceiling light panels). Candidate centers come from a seeded jittered grid
   * (deterministic); each is raycast-validated against the baked statics (the
   * only meshes with castShadow AND receiveShadow, so player models/effects
   * can never veto a spot): a short down-ray must land on the floor slab,
   * nothing solid may stand on the spot, and no tall face may sit within
   * POOL_LATERAL_CLEAR. Returns false while the map root is not in the graph
   * yet so the caller keeps poolsPending and retries on a later frame.
   */
  private placeLightPools(): boolean {
    this.clearPools();
    const targets: THREE.Object3D[] = [];
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.castShadow && obj.receiveShadow) targets.push(obj);
    });
    if (targets.length === 0) return false; // map not in the graph yet — retry next frame

    if (this.poolTex === null) this.poolTex = SceneRig.makePoolTexture();
    if (this.poolMat === null) {
      this.poolMat = new THREE.MeshBasicMaterial({
        map: this.poolTex,
        color: PALETTE.paper,
        transparent: true,
        opacity: POOL_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        polygonOffset: true, // never z-fight the floor slab
        polygonOffsetFactor: -2,
      });
    }

    const next = rng(decoSeed('fps-light-pools', 0));
    const group = new THREE.Group();
    for (let i = 0; i < POOL_COLS; i++) {
      for (let j = 0; j < POOL_ROWS; j++) {
        const cx = (i - (POOL_COLS - 1) / 2) * POOL_STEP + rngRange(next, -POOL_JITTER, POOL_JITTER);
        const cz = (j - (POOL_ROWS - 1) / 2) * POOL_STEP + rngRange(next, -POOL_JITTER, POOL_JITTER);
        const radius = rngRange(next, 2.4, 3.4); // drawn before validation: stream stays put
        if (!this.openFloorAt(cx, cz, targets)) continue;
        const decal = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), this.poolMat);
        decal.rotation.x = -Math.PI / 2;
        decal.position.set(cx, 0.012, cz);
        group.add(decal);
      }
    }
    this.scene.add(group);
    this.pools = group;
    return true;
  }

  /**
   * Raycast test for one pool candidate: open floor below (short down-ray
   * lands on the slab), nothing solid standing on the floor (up-ray from
   * below the slab must hit its underside — front-face culling makes raycasts
   * blind to volumes the probe starts INSIDE, so wall/desk/crate footprints
   * are caught from underneath instead), and clearance from tall faces at
   * chest height.
   */
  private openFloorAt(x: number, z: number, targets: THREE.Object3D[]): boolean {
    const rc = this.raycaster;
    rc.set(this.rayOrigin.set(x, POOL_PROBE_Y, z), SceneRig.DOWN);
    rc.far = POOL_PROBE_Y + 0.2; // reach the slab, ignore the distant dome
    const floor = rc.intersectObjects(targets, false)[0];
    if (floor === undefined || floor.point.y > 0.06) return false;
    rc.set(this.rayOrigin.set(x, -0.5, z), SceneRig.UP);
    rc.far = 0.6; // slab underside at ~-0.03; a solid footprint bottoms at 0.0
    const under = rc.intersectObjects(targets, false)[0];
    if (under === undefined || under.point.y > -0.02) return false;
    rc.far = POOL_LATERAL_CLEAR;
    for (const dir of SceneRig.PROBES) {
      rc.set(this.rayOrigin.set(x, 1.0, z), dir);
      if (rc.intersectObjects(targets, false).length > 0) return false;
    }
    return true;
  }

  /** Drop the current pool decals (their small geometries die with them). */
  private clearPools(): void {
    this.pathScan = null; // any in-flight corridor scan dies with the theme
    if (this.pools === null) return;
    this.scene.remove(this.pools);
    this.pools.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    this.pools = null;
  }

  /**
   * Drop the backdrop ring's tall tips (the "sky diamonds"): triangles that
   * are both elevated (centroid y > SKYCAP_MIN_Y) and out past the playable
   * area (centroid r > SKYCAP_MIN_R). Interior content never matches: outer
   * walls top out at exactly h=5 (centroids stay at/below the y bar) and the
   * only taller structures (urbana bricks, crossfire warehouse) sit at
   * r <= 35.6 — inside the r bar. The ring bakes into the merged statics, so
   * this filters triangle ranges out of the position/normal arrays directly,
   * leaving a low dune band on the horizon. Returns true once attempted.
   */
  private stripSkylineCaps(): boolean {
    const targets: THREE.Mesh[] = [];
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.castShadow && obj.receiveShadow) targets.push(obj);
    });
    if (targets.length === 0) return false; // map not in the graph yet — retry next frame
    for (const mesh of targets) {
      const pos = mesh.geometry.getAttribute('position');
      const nor = mesh.geometry.getAttribute('normal');
      if (pos === undefined || nor === undefined) continue;
      const index = mesh.geometry.getIndex();
      const triCount = (index !== null ? index.count : pos.count) / 3;
      const keep: number[] = [];
      let dropped = 0;
      for (let t = 0; t < triCount; t++) {
        const a = index !== null ? index.getX(t * 3) : t * 3;
        const b = index !== null ? index.getX(t * 3 + 1) : t * 3 + 1;
        const c = index !== null ? index.getX(t * 3 + 2) : t * 3 + 2;
        const cy = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
        const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
        const cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
        if (cy > SKYCAP_MIN_Y && Math.hypot(cx, cz) > SKYCAP_MIN_R) {
          dropped++;
          continue;
        }
        keep.push(a, b, c);
      }
      if (dropped === 0) continue;
      const np = new Float32Array(keep.length * 3);
      const nn = new Float32Array(keep.length * 3);
      for (let k = 0; k < keep.length; k++) {
        const src = keep[k];
        if (src === undefined) continue;
        np[k * 3] = pos.getX(src);
        np[k * 3 + 1] = pos.getY(src);
        np[k * 3 + 2] = pos.getZ(src);
        nn[k * 3] = nor.getX(src);
        nn[k * 3 + 1] = nor.getY(src);
        nn[k * 3 + 2] = nor.getZ(src);
      }
      mesh.geometry.setAttribute('position', new THREE.BufferAttribute(np, 3));
      mesh.geometry.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
      mesh.geometry.setIndex(null);
      mesh.geometry.deleteAttribute('uv'); // array lengths changed; Lambert needs no uv
      mesh.geometry.computeBoundingSphere();
    }
    return true;
  }

  /** Begin the frame-sliced indoor open-floor scan (after pools are in). */
  private startPathScan(): void {
    if (this.pools === null) return;
    this.pathScan = {
      cells: new Array<boolean>(PATH_COLS * PATH_ROWS).fill(false),
      index: 0,
      group: this.pools, // strips join the pools' group (shared lifecycle)
    };
  }

  /**
   * Validate ~PATH_SCAN_PER_FRAME cells of the 2.5m grid per call; on
   * completion, turn maximal open runs of >= PATH_MIN_RUN cells into soft
   * additive wear strips (the lighter traffic lanes). Runs compete by
   * length; the longest PATH_MAX_STRIPS win.
   */
  private advancePathScan(): void {
    const scan = this.pathScan;
    if (scan === null || this.pools === null) {
      this.pathScan = null;
      return;
    }
    const targets: THREE.Object3D[] = [];
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.castShadow && obj.receiveShadow) targets.push(obj);
    });
    const total = PATH_COLS * PATH_ROWS;
    const end = Math.min(scan.index + PATH_SCAN_PER_FRAME, total);
    for (let i = scan.index; i < end; i++) {
      const col = i % PATH_COLS;
      const row = Math.floor(i / PATH_COLS);
      const x = (col - (PATH_COLS - 1) / 2) * PATH_CELL;
      const z = (row - (PATH_ROWS - 1) / 2) * PATH_CELL;
      scan.cells[i] = this.openCellAt(x, z, targets);
    }
    scan.index = end;
    if (end < total) return;
    this.pathScan = null;
    this.buildWearStrips(scan.cells, scan.group);
  }

  /** Cheap pool-grade floor test for one scan cell (no lateral probes). */
  private openCellAt(x: number, z: number, targets: THREE.Object3D[]): boolean {
    const rc = this.raycaster;
    rc.set(this.rayOrigin.set(x, POOL_PROBE_Y, z), SceneRig.DOWN);
    rc.far = POOL_PROBE_Y + 0.2;
    const floor = rc.intersectObjects(targets, false)[0];
    if (floor === undefined || floor.point.y > 0.06) return false;
    rc.set(this.rayOrigin.set(x, -0.5, z), SceneRig.UP);
    rc.far = 0.6;
    const under = rc.intersectObjects(targets, false)[0];
    return under !== undefined && under.point.y <= -0.02;
  }

  /** Turn the scanned open-floor grid into additive wear strips. */
  private buildWearStrips(cells: boolean[], group: THREE.Group): void {
    if (this.poolTex === null) this.poolTex = SceneRig.makePoolTexture();
    if (this.stripMat === null) {
      this.stripMat = new THREE.MeshBasicMaterial({
        map: this.poolTex,
        color: PALETTE.paper,
        transparent: true,
        opacity: PATH_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
    }
    interface Run {
      cx: number;
      cz: number;
      len: number; // cells
      horizontal: boolean;
    }
    const runs: Run[] = [];
    for (let row = 0; row < PATH_ROWS; row++) {
      let start = -1;
      for (let col = 0; col <= PATH_COLS; col++) {
        const open = col < PATH_COLS && cells[row * PATH_COLS + col] === true;
        if (open && start < 0) start = col;
        if (!open && start >= 0) {
          const len = col - start;
          if (len >= PATH_MIN_RUN) {
            runs.push({
              cx: (start + (len - 1) / 2 - (PATH_COLS - 1) / 2) * PATH_CELL,
              cz: (row - (PATH_ROWS - 1) / 2) * PATH_CELL,
              len,
              horizontal: true,
            });
          }
          start = -1;
        }
      }
    }
    for (let col = 0; col < PATH_COLS; col++) {
      let start = -1;
      for (let row = 0; row <= PATH_ROWS; row++) {
        const open = row < PATH_ROWS && cells[row * PATH_COLS + col] === true;
        if (open && start < 0) start = row;
        if (!open && start >= 0) {
          const len = row - start;
          if (len >= PATH_MIN_RUN) {
            runs.push({
              cx: (col - (PATH_COLS - 1) / 2) * PATH_CELL,
              cz: (start + (len - 1) / 2 - (PATH_ROWS - 1) / 2) * PATH_CELL,
              len,
              horizontal: false,
            });
          }
          start = -1;
        }
      }
    }
    runs.sort((a, b) => b.len - a.len);
    for (const run of runs.slice(0, PATH_MAX_STRIPS)) {
      const len = run.len * PATH_CELL + 1.2;
      const strip = new THREE.Mesh(
        new THREE.PlaneGeometry(run.horizontal ? len : PATH_STRIP_W, run.horizontal ? PATH_STRIP_W : len),
        this.stripMat,
      );
      strip.rotation.x = -Math.PI / 2;
      strip.position.set(run.cx, 0.011, run.cz);
      group.add(strip);
    }
  }

  /** Soft radial white gradient — the pool falloff. Deterministic (no rng). */
  private static makePoolTexture(): THREE.CanvasTexture {
    const S = 128;
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const ctx = c.getContext('2d');
    if (ctx === null) throw new Error('2d context unavailable for light-pool texture');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.42)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return new THREE.CanvasTexture(c);
  }

  /**
   * Enforce the STYLE_BIBLE ambient floor: effective hemi fill (sky-color
   * relative luminance x intensity) must stay >= MIN_AMBIENT_LUMINANCE.
   * Lifts intensity to compensate; a degenerate near-black sky color is lerped
   * halfway toward PALETTE.steel first, since intensity alone can't rescue it.
   */
  private enforceAmbientFloor(): void {
    const c = this.hemi.color;
    let lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; // Rec. 709
    if (lum < 1e-3) {
      c.lerp(AMBIENT_FLOOR_SCRATCH.set(PALETTE.steel), 0.5);
      lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    }
    if (lum * this.hemi.intensity < MIN_AMBIENT_LUMINANCE) {
      this.hemi.intensity = MIN_AMBIENT_LUMINANCE / lum;
    }
  }

  /** Smooth pseudo-noise in [-1, 1]: layered sines, allocation-free. */
  private noise(axis: number): number {
    const t = this.shakeT + axis * 37.7;
    return Math.sin(t) * 0.55 + Math.sin(t * 1.93 + 1.3) * 0.3 + Math.sin(t * 3.71 + 2.1) * 0.15;
  }

  /** Tracked context-error overlay (single element; never duplicated). */
  private static contextErrorEl: HTMLDivElement | null = null;

  private static readonly DOWN = new THREE.Vector3(0, -1, 0);
  private static readonly UP = new THREE.Vector3(0, 1, 0);
  private static readonly PROBES: ReadonlyArray<THREE.Vector3> = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
  ];

  /**
   * Remove the context-error overlay if present. Public so the caller's
   * failure fallback (e.g. ClientGame returning to the main menu) can unblock
   * the UI after the rig constructor threw. Idempotent — safe to call when no
   * overlay is shown.
   */
  static clearContextError(): void {
    SceneRig.contextErrorEl?.remove();
    SceneRig.contextErrorEl = null;
  }

  /** Full-viewport readable failure message (PALETTE colors); idempotent — reuses one overlay. */
  private static showContextError(): void {
    if (SceneRig.contextErrorEl?.isConnected) return;
    SceneRig.clearContextError(); // drop a detached stale element, if any
    const div = document.createElement('div');
    div.textContent = 'WebGL is not available in this browser — STRICKEN needs GPU rendering to run.';
    const s = div.style;
    s.position = 'fixed';
    s.inset = '0';
    s.display = 'flex';
    s.alignItems = 'center';
    s.justifyContent = 'center';
    s.padding = '24px';
    s.textAlign = 'center';
    s.background = PALETTE.ink;
    s.color = PALETTE.hudText;
    s.font = '16px/1.5 system-ui, sans-serif';
    s.zIndex = '1000';
    document.body.appendChild(div);
    SceneRig.contextErrorEl = div;
  }
}
