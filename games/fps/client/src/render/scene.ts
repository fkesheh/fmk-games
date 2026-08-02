// ============================================================================
// C3 — scene rig: renderer + camera + per-map lighting/fog theme.
// One WebGLRenderer (ACES, sRGB out, PCFSoft shadows, pixelRatio <= 2), one
// PerspectiveCamera(BASE_FOV) driven in YXZ order (yaw then pitch) to match the
// shared aim convention. Screen shake is cosmetic only: trauma^2-scaled
// rotational noise, capped at 0.02 rad, decaying ~2.5/s — never positional,
// never rolls while strafing beyond the shake cap (STYLE_BIBLE).
//
// Lighting layer (all derived from the frozen MapTheme — the rig's public
// API is unchanged). VISUAL_UPGRADE.md §1 (sky law) and §3d (lighting) own
// the numbers here:
//   - THE SKY IS DATA. The rig-owned dome is the only VISIBLE sky in the game
//     (it covers the map renderer's dome — seam rule 1) and its three stops
//     come straight from the theme: zenith = theme.skyHigh, mid = theme.sky,
//     horizon = theme.horizon. Nothing is hardcoded and nothing is recoloured,
//     so S1 (zenith cooler and >= 12 L darker than the horizon) and S2 (fog ==
//     horizon) are what the player actually sees, not just what the gate says.
//   - OUTDOOR themes (dustbowl/urbana/frostbite/crossfire): golden-hour grade
//     keyed off the theme's sky colour (warmer sun, hemisphere pulled DOWN so
//     the sun's shadows register), the sun art-directed down to ~24 deg so
//     shadows rake ~2.3x object height and match the visible disc, a 4096
//     shadow map fitted in LIGHT SPACE to the map's real static bounds (§3d —
//     the old fixed +/-40 box over-covered every map and wasted texels), a
//     procedural sun disc + halo, and a cool sky-bounce fill from the opposite
//     azimuth so shaded walls/models stay dimensional.
//   - INDOOR themes (office/bunker): cool-white hemi lift, denser moody fog
//     (readability still guarded by the ambient floor), and fake "light pool"
//     floor decals — brighter patches raycast-validated onto open floor, so no
//     real point lights are needed.
//   - ALL themes: the hemisphere runs a COOL sky tint over a WARM ground tint
//     (§3d's free hue split, zero cost, every surface), a camera-follow fill
//     light (~0.4, shadowless) keeps enemy models readable in shade, and a
//     dep-free post grade (one fullscreen ShaderMaterial quad: centre-weighted
//     warm lift + vignette) finishes the frame.
// Determinism: pool scatter uses seeded rng (decoSeed); Math.random is never
// touched. PALETTE is the only color source.
// ============================================================================
import * as THREE from 'three';
import {
  BASE_FOV,
  MAP_LIST,
  PALETTE,
  decoSeed,
  rng,
  rngRange,
  type MapDef,
  type MapTheme,
  type Vec3,
} from '@fps/shared';

// ---- shake tuning -----------------------------------------------------------
// RETUNED. The old numbers made the feature effectively non-existent: the
// largest shake reachable in the game was the flat `shake(0.3)` on taking
// damage, which peaked at 0.02 * 0.3^2 = 0.0018 rad = 0.10 DEGREES. Two
// independent reasons it could not be seen, and both had to be fixed:
//
//   1. AMPLITUDE. trauma^2 is brutal at the low trauma values anyone actually
//      passed — it turned 0.3 into 0.09. The exponent is now 1.5, which keeps
//      the soft ease-out settle (no hard stop when trauma hits 0) while making
//      mid-range trauma actually visible.
//   2. DURATION. At 2.5 trauma/s a 0.3 event lived 0.12s, over which the noise
//      clock advanced 18 * 0.12 = 2.16 rad — less than HALF of one wave. The
//      player got a fraction of a single slow wobble, not an oscillation.
//      Decay is slower and the clock faster, so a real hit now reads as ~2
//      cycles of jolt-and-settle.
//
// Resulting peaks (mag = SHAKE_MAX_RAD * trauma^SHAKE_EXP):
//   own fire, ceilinged at 0.34   -> 0.295 deg   (was 0.011)
//   12 dmg graze,  trauma 0.545   -> 0.599 deg   (was 0.103)
//   25 dmg body,   trauma 0.676   -> 0.828 deg   (was 0.103)
//   89 dmg near-kill, trauma 0.98 -> 1.445 deg   (was 0.103)
//   theoretical trauma 1.0        -> 1.489 deg
//
// The audit suggested a flat ~15x. A flat multiplier was rejected: it would
// have put every graze and every one of your own shots at the same 1.5 deg as a
// near-lethal hit, which harms aim on the SHOOTER'S side (this shake applies to
// the firer too) and is the classic recipe for motion sickness. Instead the top
// end lands at ~14x and the response is graded by damage, so the big number is
// spent only on the rare event that has earned it.
const SHAKE_MAX_RAD = 0.026; // hard cap per axis (1.49 deg at trauma 1)
const SHAKE_EXP = 1.5; // trauma -> amplitude curve; >1 keeps the ease-out settle
const SHAKE_DECAY = 1.9; // trauma per second (linear)
const SHAKE_SPEED = 22; // noise clock rate (rad/s of noise input)
// Roll is by far the most nausea-inducing axis and the least informative, so it
// is deliberately damped relative to pitch/yaw rather than scaled with them.
const SHAKE_ROLL = 0.45;

/**
 * Peak per-axis shake angle in radians for a given trauma. Pure and exported so
 * the tuning can be asserted headlessly — `SceneRig` itself needs a WebGL
 * context and cannot be constructed in a unit test.
 */
export function shakeMagnitudeRad(trauma: number): number {
  if (!Number.isFinite(trauma) || trauma <= 0) return 0;
  return SHAKE_MAX_RAD * Math.pow(Math.min(1, trauma), SHAKE_EXP);
}

/** Trauma remaining after `dt` seconds of linear decay. Pure; never negative. */
export function shakeDecay(trauma: number, dt: number): number {
  if (!Number.isFinite(trauma) || !Number.isFinite(dt)) return 0;
  return Math.max(0, trauma - dt * SHAKE_DECAY);
}

/** Trauma range for taking damage: even the lightest graze clears the floor. */
export const SHAKE_DMG_MIN = 0.38;
export const SHAKE_DMG_SPAN = 0.6;

/** Trauma for an incoming hit, from the shared 0..1 damage severity. */
export function shakeTraumaForDamage(severity01: number): number {
  const s = Number.isFinite(severity01) ? Math.min(1, Math.max(0, severity01)) : 0;
  return SHAKE_DMG_MIN + SHAKE_DMG_SPAN * s;
}

/** Own-fire kick: added per shot, but never allowed to stack past this. A rifle
 *  emptying a mag would otherwise saturate trauma to 1 and shake 1.5 deg
 *  continuously while you are trying to hold a crosshair on someone. */
export const SHAKE_FIRE_ADD = 0.16;
export const SHAKE_FIRE_CEIL = 0.34;

// ---- shadow rig ---------------------------------------------------------------
// OUTDOOR: golden-hour art direction. The theme's sunDir sits at ~58 deg
// (midday: shadows hide under their casters — the "no shadows" read). The rig
// keeps the theme's azimuth but drops the sun to SUN_ELEVATION so shadows rake
// ~2.3x object height and agree with the visible disc. ONE static
// origin-centred cascade — a player-following window was tried and rejected:
// edge structures (gate gantry legs, big crate stacks) fell out of it and
// stopped casting, and integrity beats the marginal texel gain.
//
// §3d: the map is 4096 now, and the ortho box is FITTED instead of fixed. The
// old ±SHADOW_EXTENT=40 box spent an 80m span on maps that are 32-48m across,
// so most texels landed outside the world and shadows read mushy.
//
// THE FIT IS DRIVEN BY MAP DATA, NOT BY THE SCENE GRAPH. setTheme() resolves the
// MapDef whose `theme` object it was handed and walks that map's real static
// bounds — the rendered floor slab (sizeX/sizeZ widened by FIT_GROUND_MARGIN on
// every side, which is exactly what mapRenderer draws), every collision box,
// every accent overlay and every deco scatter rect — in LIGHT SPACE (the shadow
// camera's own basis, so the low sun's vertical span is measured rather than
// approximated from world x/z). Verified against the built geometry of all six
// maps: every static vertex lands inside the fitted box, worst overshoot 1.5cm,
// against SHADOW_PAD = 1.5m of slack.
//
// Walking map data is what makes the tightening real. bake() merges the entire
// map into ONE mesh per material, skyline ring included, so a per-VERTEX radius
// reject cannot exclude a backdrop landmark as a unit: a 13-34m wide mesa parked
// at r=46 has its inner corners around r=32, well inside any radius that still
// keeps the playfield. Those corners voted the box straight back open (dustbowl
// re-fitted to the unfitted 80x47m and pulled its near plane in to 17.9, letting
// 57 backdrop vertices into the shadow pass). Map data contains no backdrop at
// all, so the ring is excluded by construction instead of by luck.
//
// Measured spans and texel sizes at 4096 (the old box was 80m at 2048 = 3.9cm):
//   dustbowl 68x38 (1.67cm)  frostbite 80x39 (1.95)  urbana 80x39 (1.95)
//   crossfire 79x38 (1.92)   office 63x62 (1.54)     bunker 59x57 (1.43)
// i.e. 2.0-2.7x the old texel density, and backdrop vertices inside the shadow
// frustum drop from 174/336/270/138 (fixed box) to 0/105/135/6.
const SHADOW_MAP_SIZE = 4096; // VISUAL_UPGRADE.md §3d / §10 (was 2048)
const SHADOW_EXTENT = 40; // conservative box, and the fit's upper clamp
const SHADOW_MIN_EXTENT = 10; // never shrink past this (fit sanity clamp)
const SHADOW_FAR = 160;
const SHADOW_PAD = 1.5; // m of slack around the fitted static bounds
const SUN_DISTANCE = 60; // light sits this far along the sun direction
const SUN_ELEVATION = 0.42; // rad (~24 deg) — the golden-hour art direction
const BOUNDS_MAX_RADIUS = 42; // backdrop ring inner radius (min SkylineDef.minR)
// mapRenderer draws the floor slab at sizeX+8 / sizeZ+8, i.e. 4m of apron past
// the playable extent on every side. The fit must cover it or the outermost
// ground ring stops receiving shadows.
const FIT_GROUND_MARGIN = 4;
// DecoZone carries no height; every prop family the map renderer scatters tops
// out well under this, and the boxes it stands on are fitted at full height.
const FIT_DECO_HEIGHT = 3;
// Outdoor near-plane floor: the depth at which the SkylineDef backdrop ring
// begins. Pushing the near plane out to here clips ring landmarks standing
// between the sun and the map out of the shadow pass BY CONSTRUCTION — the job
// the old hand-computed SHADOW_NEAR_OUTDOOR constant did. fitShadowFrustum()
// never pushes past the nearest real caster, so this can only remove backdrop,
// never a real shadow.
const BACKDROP_NEAR = SUN_DISTANCE - BOUNDS_MAX_RADIUS * Math.cos(SUN_ELEVATION);
// normalBias in texels: the ground plane is the acne surface at golden-hour
// incidence. Derived from the FITTED texel size so it tracks the box instead
// of being tuned for one resolution (2 texels of an 80m/2048 box = 0.078m,
// which peter-pans badly once the texels are 3.5x smaller).
const SHADOW_NORMAL_BIAS_TEXELS = 2.5;
const SHADOW_NORMAL_BIAS_MIN = 0.012;
const SHADOW_NORMAL_BIAS_MAX = 0.08;

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

// ---- rig-owned sky dome + sun disc -------------------------------------------
// THE ONLY VISIBLE SKY (seam rule 1). The map renderer's dome is a plain
// 2-stop gradient; the rig renders its own dome just inside it (opaque,
// depth-tested: it covers theirs fully and can never z-fight it). Three stops,
// all straight from the theme — theme.horizon -> theme.sky -> theme.skyHigh.
// The sun disc is an additive shader quad parked at the theme azimuth at
// SUN_ELEVATION — exactly where the light comes from.
const SKY_DOME_RADIUS = 395; // the map renderer's dome is r=400
const SUN_DISC_DISTANCE = 380; // inside the rig dome
const SUN_DISC_SIZE = 150; // halo spans the full quad
const SUN_DISC_INTENSITY = 1.15; // punch through the horizon band without washing S1
const SUN_DISC_CORE_PALE = 0.5; // core lerp: graded sun -> paper

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

// ---- outdoor golden-hour grade (keyed by the theme's sky color) ---------------
// §3d: the hemisphere comes DOWN outdoors. It used to be multiplied UP (1.10 -
// 1.25x) on top of already-high per-map values, which flooded the shade and
// left the sun with nothing to carve — "the shadows barely register". The maps
// have since dropped their own hemiIntensity, so the rig must not put it back:
// hemiBoost is <= 1 on every daylight grade now, and the ambient floor
// (MIN_AMBIENT_LUMINANCE, enforced after grading) still guarantees readability.
//
// The two hue fields are §3d's free hue split: the hemisphere's SKY half is
// pulled cool and its GROUND half warm, so every single surface in the frame
// picks up a warm/cool gradient from top to bottom for zero draw cost.
interface OutdoorGrade {
  readonly sunWarm: number; // lerp sun color -> muzzle (golden key)
  readonly hemiCool: number; // lerp hemi SKY tint -> skyCold (cool from above)
  readonly groundWarm: number; // lerp hemi GROUND tint -> fogDusk (warm bounce below)
  readonly sunBoost: number; // sun intensity multiplier (a low sun starves the floor)
  readonly hemiBoost: number; // hemi intensity multiplier (<= 1: shade must stay shade)
}
const GRADE_FALLBACK: OutdoorGrade = { sunWarm: 0.45, hemiCool: 0.22, groundWarm: 0.22, sunBoost: 1.25, hemiBoost: 0.95 };
const OUTDOOR_GRADES: ReadonlyArray<readonly [string, OutdoorGrade]> = [
  // dustbowl: already dusk — keep the warm key, and let the cool zenith reach
  // the shade side so the map's signature violet/sand split reads in the LIGHT
  // as well as in the sky
  [PALETTE.skyDusk, { sunWarm: 0.28, hemiCool: 0.3, groundWarm: 0.3, sunBoost: 1.35, hemiBoost: 1.0 }],
  // urbana/crossfire: daylight paper sun -> golden-hour key over a cool sky fill
  [PALETTE.skyDay, { sunWarm: 0.68, hemiCool: 0.25, groundWarm: 0.28, sunBoost: 1.22, hemiBoost: 0.9 }],
  // frostbite: warm key against the cool fill — the MW2 cold-map look. Small
  // ground warm only: the map is monochrome by design (§3a), value does the work
  [PALETTE.skyCold, { sunWarm: 0.55, hemiCool: 0.12, groundWarm: 0.12, sunBoost: 1.28, hemiBoost: 0.95 }],
];

// ---- indoor grade ---------------------------------------------------------------
// Same hue split, fluorescent flavour: cool steel from the ceiling, warm sandy
// bounce off the floor. The hemisphere IS the light indoors, so it is NOT
// pulled down here — only outdoor maps have a sun to protect.
const INDOOR_HEMI_COOL = 0.4; // hemi sky -> steelLit (cool-white fluorescent fill)
const INDOOR_HEMI_BOOST = 1.22; // hemi intensity multiplier
const INDOOR_GROUND_LIFT = 0.45; // hemi ground -> sandLit (lifts AND warms the floor bounce)
const INDOOR_FOG_BOOST = 1.32; // moodier fog; readability kept via ambient floor

// ---- post grade ------------------------------------------------------------------
// The lift is deliberately small and CENTRE-WEIGHTED (see POST_FRAG): a flat
// additive lift raises the blacks everywhere, which is exactly the value-soup
// this round exists to kill. Corners get almost none of it, so the vignette and
// the lift pull in the same direction instead of cancelling.
const POST_VIGNETTE_OUTDOOR = 0.34; // corner darkening (0 = off, 1 = black corners)
const POST_VIGNETTE_INDOOR = 0.46; // moodier indoors
const POST_LIFT_OUTDOOR = 0.03; // additive warm lift (tiny — a grade, not a tint)
const POST_LIFT_INDOOR = 0.018;
const POST_LIFT_EDGE = 0.3; // how much of the lift survives at the frame edge

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
 * from the one thing that separates an interior unambiguously: the HORIZON.
 * An interior has no sky to see, so its horizon stop is a near-black interior
 * void (ink 0.006 / charcoal 0.017 / tarmacDeep 0.033); every outdoor horizon
 * is a haze band (fogDay 0.48, fogDusk 0.46, fogCold 0.66, plaster 0.62) an
 * order of magnitude above it. The threshold sits in that gap with ~3x margin
 * on both sides, so F1-F6 can retune their themes freely without silently
 * flipping a map's lighting family. (The old test also required
 * `sky === PALETTE.steel`, which pinned two maps' mid sky stop to one exact
 * palette entry for no reason — sky luminance is useless as a discriminator
 * anyway: indoor steel is 0.361, brighter than outdoor skyDay's 0.353.)
 */
function isIndoorTheme(theme: MapTheme): boolean {
  return luminanceOf(theme.horizon) < 0.1;
}

const SUN_DISC_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Crisp core + tight inner glow + halo, all radial over the quad. The halo is
// tighter and weaker than it was: it is additive over the dome, and a broad
// wash flattens exactly the zenith-to-horizon separation S1 exists to create.
const SUN_DISC_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform vec3 uCore;
  uniform vec3 uHalo;
  uniform float uIntensity;
  void main() {
    float r = length(vUv - 0.5) * 2.0; // 0 center -> 1 quad edge
    float core = 1.0 - smoothstep(0.095, 0.12, r); // crisp-edged sun
    float inner = pow(max(0.0, 1.0 - r * 2.4), 1.6) * 0.5; // tight glow
    float halo = pow(max(0.0, 1.0 - r), 2.3) * 0.3; // warm wash, kept local
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

// 3 stops, all from the theme: theme.horizon -> theme.sky -> theme.skyHigh.
// The ramps are shaped so each stop OWNS a band of the dome — a horizon band
// hugging the skyline, a mid band through the normal combat pitch range, and a
// zenith that reaches full strength well before straight up. If the zenith ramp
// only completes at t=1 (the old 0.12..0.75 pair, which also let `hi` start
// eating the horizon band at 12 deg) the S1 separation the map author authored
// is squeezed into a patch of sky nobody looks at.
const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uHorizon;
  uniform vec3 uMid;
  uniform vec3 uZenith;
  void main() {
    float t = normalize(vDir).y; // -1 nadir -> 1 zenith
    float lo = smoothstep(-0.06, 0.14, t); // horizon band -> mid
    float hi = smoothstep(0.2, 0.62, t); // mid -> zenith
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
// The vignette falls off from further in and squares off toward the corners
// (r*r) so it reads as a lens, not as a black ring; the lift is scaled by the
// same radius so the centre of frame — where the target is — keeps its warmth
// while the corners keep their blacks.
const POST_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform vec3 uWarm;
  uniform float uLift;
  uniform float uVignette;
  uniform float uEdgeLift;
  uniform float uAspect;
  void main() {
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
    float r = clamp(length(p) * 1.4142, 0.0, 1.0); // 0 center -> ~1 corners
    float fall = smoothstep(0.42, 1.05, r);
    float vig = fall * fall * uVignette;
    float lift = uLift * mix(1.0, uEdgeLift, fall);
    gl_FragColor = vec4(uWarm * lift, vig);
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
  private readonly fitScratch = new THREE.Vector3(); // shadow-fit corner, per theme
  private readonly fitMatrix = new THREE.Matrix4(); // world -> light space, per theme

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
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE); // §3d
    this.setShadowBox(-SHADOW_EXTENT, SHADOW_EXTENT, -SHADOW_EXTENT, SHADOW_EXTENT, 1, SHADOW_FAR);
    // long-shadow tuning: at golden-hour incidence the ground plane is the
    // acne surface. normalBias is derived from the live texel size in
    // setShadowBox() so it shrinks with the fitted box instead of peter-panning
    // crates; a whisper of negative depth bias stops speckle along the terminator.
    this.sun.shadow.bias = -0.00012;
    this.sun.shadow.radius = 3; // soften staircase edges (ignored by PCFSoft — harmless safeguard)
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

    // rig-owned 3-stop sky dome: opaque, covers the map renderer's 2-stop dome.
    // These are placeholders only — setTheme drives all three stops from the
    // MapTheme (skyHigh / sky / horizon) before the first frame is ever drawn.
    this.skyDomeMat = new THREE.ShaderMaterial({
      uniforms: {
        uHorizon: { value: new THREE.Color(PALETTE.fogDay) },
        uMid: { value: new THREE.Color(PALETTE.skyDay) },
        uZenith: { value: new THREE.Color(PALETTE.skyDayHigh) },
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
        uEdgeLift: { value: POST_LIFT_EDGE },
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

    this.hemi.color.set(theme.sky);
    this.hemi.groundColor.set(theme.ground);
    this.hemi.intensity = theme.hemiIntensity;

    this.sun.color.set(theme.sunColor);
    this.sun.intensity = theme.sunIntensity;

    // S2 is the map's job and the rig must not undo it: the fog colour is the
    // theme's, untouched, so it stays identical to the horizon stop the dome
    // paints below. (The old rig lerped fog toward fogDusk by up to 0.15,
    // which silently broke the fog/horizon match on every daylight map.)
    const fogHex = theme.fog;
    let fogDensity = theme.fogDensity;

    if (indoor) {
      // fake interior lighting: cool fluorescent hemi over a warm floor bounce,
      // moodier fog (the ambient floor below still guards readability)
      this.hemi.color.lerp(this.gradeScratchA.set(PALETTE.steelLit), INDOOR_HEMI_COOL);
      this.hemi.groundColor.lerp(this.gradeScratchA.set(PALETTE.sandLit), INDOOR_GROUND_LIFT);
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
      // §3d hue split, for free, on every surface: cool sky half over a warm
      // ground half. Both endpoints are palette entries, so the result is
      // traceable. hemiBoost is <= 1 here — the shade must stay shade or the
      // sun has nothing to carve against.
      this.hemi.color.lerp(this.gradeScratchA.set(PALETTE.skyCold), grade.hemiCool);
      this.hemi.groundColor.lerp(this.gradeScratchA.set(PALETTE.fogDusk), grade.groundWarm);
      this.hemi.intensity *= grade.hemiBoost;

      // art-directed sun: the theme's azimuth, golden-hour elevation. The sun
      // never moves after this, which is what lets the cascade be fitted once
      // per map instead of every frame (see the rig note up top).
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

    // Start from the safe, over-covering box, then tighten onto this map's real
    // static bounds (§3d). The sun is static per theme and the bounds come from
    // map data, so the fit is exact from the very first frame — no waiting for
    // geometry to join the graph, and nothing dynamic can ever drag it open.
    this.setShadowBox(-SHADOW_EXTENT, SHADOW_EXTENT, -SHADOW_EXTENT, SHADOW_EXTENT, 1, SHADOW_FAR);
    this.fitShadowFrustum(theme, indoor);

    // ---- THE SKY IS DATA (VISUAL_UPGRADE.md §1 S1/S2, seam rule 1) ----------
    // Three stops, three theme fields, no rig-side recolouring:
    //   zenith  = theme.skyHigh  (S1: cooler and >= 12 L darker than horizon)
    //   mid     = theme.sky
    //   horizon = theme.horizon  (S2: identical to theme.fog below)
    // This is the ONLY dome the player sees. Anything hardcoded here makes S1
    // a gate that scores nothing and throws away every map author's sky work.
    const uHorizon = this.skyDomeMat.uniforms.uHorizon;
    const uMid = this.skyDomeMat.uniforms.uMid;
    const uZenith = this.skyDomeMat.uniforms.uZenith;
    if (uHorizon !== undefined) (uHorizon.value as THREE.Color).set(theme.horizon);
    if (uMid !== undefined) (uMid.value as THREE.Color).set(theme.sky);
    if (uZenith !== undefined) (uZenith.value as THREE.Color).set(theme.skyHigh);

    this.scene.fog = new THREE.FogExp2(fogHex, fogDensity);
    this.renderer.setClearColor(fogHex); // any gap in the dome reads as haze, not as sky

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
    this.trauma = shakeDecay(this.trauma, dt);
    this.shakeT += dt * SHAKE_SPEED;

    this.camera.position.set(pos.x, pos.y, pos.z);
    let rx = pitch;
    let ry = yaw;
    let rz = 0;
    if (this.trauma > 0) {
      const mag = shakeMagnitudeRad(this.trauma);
      rx += mag * this.noise(0);
      ry += mag * this.noise(1);
      rz += mag * SHAKE_ROLL * this.noise(2);
    }
    // rx/ry are re-seeded from the pitch/yaw ARGUMENTS every frame and the
    // offset is written only into the three.js camera — never back into the
    // input controller, never into anything the server sees. Shake therefore
    // cannot accumulate and cannot desync the camera from where shots go.
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

  /**
   * Add shake energy. Callers: own fire kick, damage taken.
   *
   * `ceiling` bounds what THIS source may stack the trauma up to (default 1).
   * The fire kick passes a low ceiling so that emptying a magazine cannot pin
   * the camera at full amplitude while you are trying to hold an aim; an
   * incoming hit is rare and uses the full range. A source never LOWERS trauma
   * already present from a bigger event.
   */
  shake(amount: number, ceiling = 1): void {
    const cap = Math.min(1, Math.max(0, ceiling));
    const next = Math.min(cap, Math.max(0, this.trauma + amount));
    this.trauma = Math.max(this.trauma, next);
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
        `#${this.gradeScratchA.copy(this.sun.color).lerp(this.gradeScratchB.set(PALETTE.paper), SUN_DISC_CORE_PALE).getHexString()}`,
      );
    }
    if (halo !== undefined) {
      halo.value = srgbColor(`#${this.gradeScratchA.copy(this.sun.color).getHexString()}`);
    }
    this.sunDisc.visible = true;
  }

  /**
   * Write the shadow cascade's ortho box and re-derive normalBias from the
   * resulting texel size. Everything that moves the box goes through here so
   * the bias can never drift out of step with the resolution (§3d).
   */
  private setShadowBox(
    left: number,
    right: number,
    bottom: number,
    top: number,
    near: number,
    far: number,
  ): void {
    const sc = this.sun.shadow.camera;
    sc.left = left;
    sc.right = right;
    sc.bottom = bottom;
    sc.top = top;
    sc.near = near;
    sc.far = far;
    sc.updateProjectionMatrix();
    const texel = Math.max(right - left, top - bottom) / SHADOW_MAP_SIZE;
    this.sun.shadow.normalBias = Math.min(
      SHADOW_NORMAL_BIAS_MAX,
      Math.max(SHADOW_NORMAL_BIAS_MIN, texel * SHADOW_NORMAL_BIAS_TEXELS),
    );
  }

  /**
   * §3d — fit the 4096 cascade to the map's ACTUAL static bounds, measured in
   * the shadow camera's own basis. The fixed +/-40 box it replaces spent an 80m
   * span on maps 32-48m across, and at a 24 deg sun the vertical span of the
   * light frustum has almost nothing to do with world y, so a world-space
   * bounding box would have to be padded back out to uselessness. Light space
   * measures exactly what the shadow map stores.
   *
   * The bounds come from MAP DATA — the MapDef whose `theme` this rig was handed
   * — and never from the scene graph. Scanning baked vertices cannot work: bake()
   * merges the whole map into one mesh per material, so the SkylineDef backdrop
   * ring is welded into the same buffers as the playfield and no per-vertex
   * radius reject can remove a landmark as a unit (a 13-34m wide mesa at r=46
   * keeps its inner corners around r=32 and votes the box straight back open).
   * `MapDef` has no backdrop in it, so the ring and the cloud bands are excluded
   * by construction, and dynamic meshes can never drag the box open either.
   *
   * What is fitted, in world space:
   *   - the rendered floor slab: sizeX/sizeZ plus FIT_GROUND_MARGIN per side;
   *   - every collision box at full extents (the walls, and everything the
   *     renderer articulates onto them stays within a few cm of them);
   *   - every accent overlay;
   *   - every deco scatter rect, at FIT_DECO_HEIGHT.
   * Checked against the built geometry of all six maps: every static vertex
   * lands inside, worst overshoot 1.5cm against SHADOW_PAD = 1.5m of slack.
   *
   * Outdoors the near plane is then pushed out to BACKDROP_NEAR where that is
   * further than the fit alone put it — but never past the nearest real caster,
   * so it can only remove backdrop, never a real shadow. That is the guarantee
   * the deleted SHADOW_NEAR_OUTDOOR constant used to provide.
   *
   * Runs once per setTheme (the sun is static per theme). An unrecognised theme
   * keeps the safe over-covering box.
   */
  private fitShadowFrustum(theme: MapTheme, indoor: boolean): void {
    let map: MapDef | undefined;
    for (const m of MAP_LIST) {
      if (m.theme === theme) {
        map = m;
        break;
      }
    }
    if (map === undefined) return; // not a registered map — keep the safe box

    // replicate three's shadow-camera basis exactly (position = light, lookAt
    // = light target, default up) so the measured box IS the rendered box
    const sc = this.sun.shadow.camera;
    sc.position.copy(this.sun.position);
    sc.lookAt(this.sun.target.position);
    sc.updateMatrixWorld();
    this.fitMatrix.copy(sc.matrixWorld).invert();

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const v = this.fitScratch;
    const addBox = (x: number, y: number, z: number, w: number, h: number, d: number): void => {
      for (let c = 0; c < 8; c++) {
        v.set(
          x + ((c & 1) === 0 ? -w : w) / 2,
          y + ((c & 2) === 0 ? -h : h) / 2,
          z + ((c & 4) === 0 ? -d : d) / 2,
        ).applyMatrix4(this.fitMatrix); // -> light space
        if (v.x < minX) minX = v.x;
        if (v.x > maxX) maxX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.y > maxY) maxY = v.y;
        if (v.z < minZ) minZ = v.z;
        if (v.z > maxZ) maxZ = v.z;
      }
    };

    addBox(0, 0, 0, map.sizeX + FIT_GROUND_MARGIN * 2, 0.1, map.sizeZ + FIT_GROUND_MARGIN * 2);
    for (const b of map.boxes) addBox(b.x, b.y, b.z, b.w, b.h, b.d);
    for (const a of map.accents ?? []) addBox(a.x, a.y, a.z, a.w, a.h, a.d);
    for (const z of map.deco) {
      addBox(
        (z.x0 + z.x1) / 2,
        FIT_DECO_HEIGHT / 2,
        (z.z0 + z.z1) / 2,
        Math.abs(z.x1 - z.x0),
        FIT_DECO_HEIGHT,
        Math.abs(z.z1 - z.z0),
      );
    }

    // sanity clamps: a bad fit must degrade to "slightly loose", never to
    // "shadows vanish". The camera looks down -z, so depth = -z.
    const halfX = Math.min(SHADOW_EXTENT, Math.max(SHADOW_MIN_EXTENT, (maxX - minX) / 2 + SHADOW_PAD));
    const halfY = Math.min(SHADOW_EXTENT, Math.max(SHADOW_MIN_EXTENT, (maxY - minY) / 2 + SHADOW_PAD));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let near = Math.max(0.5, -maxZ - SHADOW_PAD);
    // outdoor: clip the SkylineDef ring by construction, but never at the cost
    // of a real caster — -maxZ is the depth of the closest static geometry.
    if (!indoor) near = Math.min(-maxZ, Math.max(near, BACKDROP_NEAR));
    const far = Math.min(SHADOW_FAR, Math.max(near + 20, -minZ + SHADOW_PAD));
    this.setShadowBox(cx - halfX, cx + halfX, cy - halfY, cy + halfY, near, far);
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
