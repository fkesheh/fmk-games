// ============================================================================
// ART 1/6 — scene rig: renderer + camera + time-of-day lighting/fog/sky.
//
// This is the single most important art file in OUTPOST. The previous build
// shipped 65% of every frame below luma 20 (STRICKEN measures 2-3%) and a mud
// floor at luma 15.9 — "you cannot see the ground under your feet." The cause
// was arithmetic, not taste, and it is TWO TRAPS baked into three.js itself:
//
//   TRAP 1 — a HemisphereLight's COLOUR MULTIPLIES its intensity. A sky
//   swatch at ~0.2 linear luminance with `intensity: 1` delivers ~0.2 of the
//   intended fill, not 1.0. `enforceAmbientFloor()` below measures the actual
//   linear luminance of the current sky colour and lifts intensity to
//   compensate, so the floor is guaranteed by CODE rather than by a constant
//   that "looks right" in source.
//
//   TRAP 2 — three's Lambert BRDF divides irradiance by PI
//   (`BRDF_Lambert = RECIPROCAL_PI * diffuseColor`, verified against this
//   repo's own three@0.185.1 shader chunks). A nominal light intensity of 1.2
//   delivers ~0.38x albedo to any face it reaches. Every intensity chosen
//   below already prices this in — they read high on paper on purpose.
//
// `scripts/capture-outpost.mjs` measures the rendered PNG against
// VISUAL_GATES, not the constants in this file. This module cannot be
// verified by reading it; it is tuned by principled reasoning about the two
// traps above plus generous headroom against the previous failure mode, and
// is expected to be re-graded against real captures by the art-director loop
// once the other five render modules exist to compose the scene with.
//
// Rig layout (STYLE_BIBLE "Lighting recipe"), ported from STRICKEN's proven
// games/fps/client/src/render/scene.ts (2 400+ meshes, shipped, passing
// gates) and adapted to OUTPOST's frozen TimeOfDay ('dusk' | 'night') instead
// of STRICKEN's per-map MapTheme:
//   - hemisphere ambient (sky tint over ground bounce) — the floor of the
//     image, see TRAP 1.
//   - a directional moon/last-light KEY: castShadow, 4096 map, ONE static
//     ortho cascade fitted in light space to RIDGELINE's real static bounds
//     (fitted ONCE — this is a single frozen map with a fixed light
//     direction, unlike STRICKEN's per-map refit).
//   - a shadowless cool sky-bounce fill from the opposite azimuth.
//   - a shadowless camera-follow fill (~0.4) repositioned every applyCamera —
//     without this the horde becomes black cutouts (STYLE_BIBLE).
//   - warm practicals: 4 top-deck floodlights aimed outward-and-down, a
//     brazier at the gate, a brazier on deck 1. At most ONE practical
//     (the north floodlight, over the gate) casts a shadow. Braziers are
//     omnidirectional PointLights, so their `.distance` cutoff is kept under
//     the vertical gap to the slab above/below them — a SpotLight aimed
//     outward past the tower's own footprint cannot re-enter it regardless of
//     range, but a PointLight radiates in every direction and WILL bleed
//     through a slab if its radius reaches past it (the exact previous-build
//     failure: "a beacon two storeys up lighting the ground floor through a
//     metre of concrete").
//   - a rig-owned 3-stop gradient sky dome (opaque, depth-tested, covers
//     whatever placeholder dome render/world.ts's buildWorld() may draw —
//     same "closer wins" seam STRICKEN uses between its rig dome and its map
//     renderer's dome) + a moon disc with a soft halo + a Points starfield
//     that fades in at night.
//   - FogExp2 whose colour is ALWAYS the mood's dedicated fog key
//     (`duskFog` / `fogNight`) — NEVER the sky dome's horizon stop. OUTPOST's
//     dusk horizon (`duskHorizon`, the one warm band) is deliberately NOT the
//     fog colour: painting fog with the horizon band collapses the horde's
//     dusk value contrast from ~48 L* to ~37.5 L* for waves 1-3, the exact
//     waves a new player sees first (STYLE_BIBLE). Night has no separate
//     horizon key, so its dome horizon stop and its fog legitimately share
//     `fogNight` — only dusk's dome/fog pair differs on purpose.
//   - the hand-rolled post pass (warm lift + vignette, no EffectComposer),
//     ported verbatim from STRICKEN — it is generic screen-space grading with
//     no per-game logic.
//   - screen shake with STRICKEN's proven tuning (roll damped, see the header
//     of the ported file for the amplitude/duration reasoning).
// ============================================================================
import * as THREE from 'three';
import {
  DECK1_Y,
  DECK2_Y,
  FEATURES,
  FENCE_HALF,
  PALETTE,
  PLATEAU_RADIUS,
  SEGMENTS,
  STATIC_BOXES,
  TOWER_HALF,
  segmentAABB,
  type TimeOfDay,
} from '@outpost/shared';
import { vrng } from '../contract/visual.js';

// ---- shake tuning — STRICKEN's proven numbers, verbatim (roll damped) -----
// Peaks (mag = SHAKE_MAX_RAD * trauma^SHAKE_EXP): own fire ceilinged at 0.34
// -> 0.295 deg; a near-lethal hit at trauma ~0.98 -> 1.445 deg. Roll rides at
// 0.45x the other two axes — it is the most nausea-inducing axis and the
// least informative, so it is damped rather than scaled with them.
const SHAKE_MAX_RAD = 0.026;
const SHAKE_EXP = 1.5;
const SHAKE_DECAY = 1.9; // trauma per second
const SHAKE_SPEED = 22; // noise clock rate, rad/s
const SHAKE_ROLL = 0.45;

// ---- camera-follow fill — keeps a zombie's shaded face readable -----------
const FILL_INTENSITY = 0.4;
const FILL_AHEAD = 8;

// ---- ambient floor (TRAP 1) -------------------------------------------------
// Higher than STRICKEN's proven 0.12: OUTPOST's mud/timber palette runs
// darker on average than STRICKEN's desert ramp (mud L* ~29, mudDark ~20,
// mudDeep ~13, vs STRICKEN's sand family sitting well above that), and the
// previous OUTPOST's catastrophic floor failure (65% of every frame < luma
// 20) makes this the single highest-risk number in the file. Enforced at
// runtime against the ACTUAL linear luminance of whichever sky colour the
// current mood picked — never against the raw intensity constant.
const MIN_AMBIENT_LUMINANCE = 0.2;
const AMBIENT_FLOOR_SCRATCH = new THREE.Color(); // reused — no per-call alloc

// ---- moon key + shadow cascade ---------------------------------------------
// RIDGELINE is one frozen map with a fixed light direction — unlike
// STRICKEN's per-map theme, the cascade is fitted exactly ONCE, in the
// constructor, from the map's own real static bounds (STATIC_BOXES +
// SEGMENTS), never refitted per mood (only colour/intensity change with
// TimeOfDay, never direction).
const SHADOW_MAP_SIZE = 4096;
const SHADOW_FAR = 220;
const SHADOW_PAD = 2.0; // m of slack around the fitted static bounds
// The fit also nets a flat ground apron out to this radius, so the mud
// beyond the fence still receives the fort's shadow. Deliberately NOT
// PLATEAU_RADIUS (84): the outer treeline ring is decorative backdrop built
// by render/world.ts, not photographed for fine directional shadow detail,
// and including it would spend 4096 texels on a ring nobody needs sharp
// (the exact "backdrop steals texels from the playfield" failure STRICKEN's
// own fit comments document). 50 clears the fence (20) and every field
// obstacle (out to ~38) with room to spare, short of the treeline's leading
// edge (56).
const SHADOW_GROUND_RADIUS = Math.min(50, PLATEAU_RADIUS);
const SHADOW_NORMAL_BIAS_TEXELS = 2.5;
const SHADOW_NORMAL_BIAS_MIN = 0.015;
const SHADOW_NORMAL_BIAS_MAX = 0.09;
const MOON_DISTANCE = 140; // light sits this far along the moon direction
const MOON_ELEVATION = 0.384; // ~22 deg — STYLE_BIBLE's raking angle for long shadows
const MOON_AZIMUTH = 0.61; // ~35 deg — a diagonal rake across the square compound

// ---- cool sky-bounce fill (opposite azimuth, shadowless) ------------------
const BOUNCE_ELEVATION = 0.6; // rad — a sky light, not a horizon light
const BOUNCE_DISTANCE = 90;
const BOUNCE_INTENSITY_DUSK = 0.32;
const BOUNCE_INTENSITY_NIGHT = 0.24;

// ---- rig-owned sky dome + moon disc + starfield ----------------------------
// Radii mirror STRICKEN's exact proven relationship to its far=500 camera
// (world dome ~400, rig dome 395, rig disc/stars just inside that) — OUTPOST
// shares the same near/far (STYLE_BIBLE: "near 0.1 / far 500"), and this rig
// dome must stay CLOSER than whatever placeholder dome render/world.ts's
// buildWorld() draws so it wins the depth test and covers it (opaque,
// depthWrite: true — "closer wins", the same seam rule STRICKEN's header
// documents between its rig dome and its map renderer's dome).
const SKY_DOME_RADIUS = 380;
const MOON_DISC_DISTANCE = 365;
const MOON_DISC_SIZE = 90;
const MOON_DISC_INTENSITY_MULT = 1; // per-mood multiplier applied to uIntensity

const STAR_COUNT = 520;
const STAR_RADIUS = 372;
const STAR_SEED = 9001; // deterministic — Math.random is a contract violation
// Spherical-cap sampling: phi in [0, acos(1 - STAR_CAP)] measured from the
// zenith, i.e. stars land within ~71 deg of straight up and never clutter
// the low, fogged horizon band the treeline occupies.
const STAR_CAP = 0.68;

// ---- practicals: 4 top-deck floodlights + 2 braziers -----------------------
// Positions are DERIVED from the frozen map constants (DECK2_Y, TOWER_HALF,
// FENCE_HALF, the gate SegmentGeom, the weaponRack FeaturePoint), never
// hardcoded literals independent of them, so a map-constant change cannot
// silently bury a light in geometry or aim it at empty air.
const FLOOD_MOUNT_INSET = 0.5; // in from the parapet edge
const FLOOD_MOUNT_Y_OFFSET = 0.6; // above DECK2_Y, mounted on the parapet rail
const FLOOD_TARGET_Y = 0.9; // aimed at roughly firing-step height on the fence
const FLOOD_RANGE = 30; // reaches a little past the fence, not into the treeline
const FLOOD_ANGLE = 0.5; // rad, ~28.6 deg cone
const FLOOD_PENUMBRA = 0.45;
// A SpotLight's cone is directionally gated, so a floodlight aimed OUTWARD
// past the tower's own footprint geometrically cannot illuminate the deck
// below it regardless of `.distance` — the slab-crossing risk (STYLE_BIBLE:
// "no practical light may have a range that crosses a floor slab") is a
// PointLight problem (see the braziers below), not a floodlight one.

const GATE_BRAZIER_INSET = 2.2; // inward from the gate segment's outward face
const GATE_BRAZIER_Y = 1.1;
const GATE_BRAZIER_RANGE = 7.5; // open ground at the gate — no slab overhead to leak through

const DECK_BRAZIER_Y_OFFSET = 0.5; // above the weaponRack feature point (on DECK1_Y)
// PointLights are omnidirectional, so this radius is the load-bearing number
// in the file for the slab rule: the deck-2 slab's underside sits ~3.2 m
// above DECK1_Y and the ground floor sits below it, so 3.2 keeps the sphere
// entirely within deck 1's own vertical band on both sides — "the ground
// floor lit through a metre of concrete from a beacon two storeys up" is
// exactly the bug a larger number here would reproduce.
const DECK_BRAZIER_RANGE = 3.2;

const FLOOD_COLOR = PALETTE.floodBeam;
const BRAZIER_COLOR = PALETTE.torchCore; // fire doesn't change hue when the sky darkens — only relative prominence does

// ---- post grade -------------------------------------------------------------
const POST_VIGNETTE = 0.36;
const POST_LIFT_DUSK = 0.026;
const POST_LIFT_NIGHT = 0.02;
const POST_LIFT_EDGE = 0.3;

/** Blend two PALETTE hexes in linear space, module-load-time only (never per-frame). */
function lerpHex(a: string, b: string, t: number): string {
  return `#${new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString()}`;
}

/** Rec.709 relative luminance of a PALETTE hex, decoded to linear (TRAP 1 measurement). */
function luminanceOf(hex: string): number {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

// Dusk key = "last-light", not pure moonlight: a last-light warmth blended
// into the cool moon tint. Night key is pure moonlight.
const DUSK_KEY_COLOR = lerpHex(PALETTE.moonlight, PALETTE.duskHorizon, 0.4);

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// 3 stops, all from the current mood: horizon -> mid -> zenith. Each stop
// owns a band of the dome so the horizon read (where the horde stands
// against the treeline) is never squeezed into a sliver by the zenith ramp.
const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uHorizon;
  uniform vec3 uMid;
  uniform vec3 uZenith;
  void main() {
    float t = normalize(vDir).y;
    float lo = smoothstep(-0.06, 0.14, t);
    float hi = smoothstep(0.2, 0.62, t);
    vec3 col = mix(uHorizon, uMid, lo);
    col = mix(col, uZenith, hi);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const MOON_DISC_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Crisp core + tight inner glow + a soft halo — a cooler, quieter cousin of
// STRICKEN's sun disc (lower core intensity befits a moon, not a sun).
const MOON_DISC_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform vec3 uCore;
  uniform vec3 uHalo;
  uniform float uIntensity;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float core = 1.0 - smoothstep(0.09, 0.115, r);
    float inner = pow(max(0.0, 1.0 - r * 2.4), 1.6) * 0.45;
    float halo = pow(max(0.0, 1.0 - r), 2.4) * 0.26;
    vec3 col = uCore * (core + inner) + uHalo * halo;
    gl_FragColor = vec4(col * uIntensity, 1.0);
  }
`;

const POST_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Vignette rides alpha, the warm lift rides RGB. Blending is
// (ONE, ONE_MINUS_SRC_ALPHA): result = warm*lift + frame*(1 - vignette).
const POST_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform vec3 uWarm;
  uniform float uLift;
  uniform float uVignette;
  uniform float uEdgeLift;
  uniform float uAspect;
  void main() {
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
    float r = clamp(length(p) * 1.4142, 0.0, 1.0);
    float fall = smoothstep(0.42, 1.05, r);
    float vig = fall * fall * uVignette;
    float lift = uLift * mix(1.0, uEdgeLift, fall);
    gl_FragColor = vec4(uWarm * lift, vig);
  }
`;

interface Mood {
  readonly hemiSky: string;
  readonly hemiGround: string;
  readonly hemiIntensity: number;
  readonly keyColor: string;
  readonly keyIntensity: number;
  readonly bounceColor: string;
  readonly bounceIntensity: number;
  readonly fogColor: string;
  readonly fogDensity: number;
  readonly domeHorizon: string;
  readonly domeMid: string;
  readonly domeZenith: string;
  readonly moonDiscIntensity: number;
  readonly starOpacity: number;
  readonly floodIntensity: number;
  readonly brazierGateIntensity: number;
  readonly brazierDeckIntensity: number;
  readonly postLift: number;
}

// Every intensity below already prices in TRAP 2 (Lambert's /PI): they read
// high on paper on purpose. `enforceAmbientFloor()` is the backstop, not the
// plan — these are the plan.
const MOODS: Record<TimeOfDay, Mood> = {
  dusk: {
    hemiSky: PALETTE.duskSky,
    hemiGround: PALETTE.mudLit,
    hemiIntensity: 1.1,
    keyColor: DUSK_KEY_COLOR,
    keyIntensity: 1.6,
    bounceColor: PALETTE.duskSkyHigh,
    bounceIntensity: BOUNCE_INTENSITY_DUSK,
    fogColor: PALETTE.duskFog, // NEVER duskHorizon — see file header
    fogDensity: 0.013,
    domeHorizon: PALETTE.duskHorizon, // the one warm band, distinct from the fog colour
    domeMid: PALETTE.duskSky,
    domeZenith: PALETTE.duskSkyHigh,
    moonDiscIntensity: 0.5,
    starOpacity: 0,
    floodIntensity: 200,
    brazierGateIntensity: 22,
    brazierDeckIntensity: 14,
    postLift: POST_LIFT_DUSK,
  },
  night: {
    hemiSky: PALETTE.skyNight,
    hemiGround: PALETTE.mudDark,
    hemiIntensity: 0.8,
    keyColor: PALETTE.moonlight,
    keyIntensity: 0.85,
    bounceColor: PALETTE.skyNightHigh,
    bounceIntensity: BOUNCE_INTENSITY_NIGHT,
    fogColor: PALETTE.fogNight,
    fogDensity: 0.019,
    domeHorizon: PALETTE.fogNight, // no dedicated night-horizon key — legitimately shared with fog
    domeMid: PALETTE.skyNight,
    domeZenith: PALETTE.skyNightHigh,
    moonDiscIntensity: 1.15,
    starOpacity: 0.85,
    floodIntensity: 420, // the dominant light source at night (STYLE_BIBLE)
    brazierGateIntensity: 42,
    brazierDeckIntensity: 26,
    postLift: POST_LIFT_NIGHT,
  },
};

type Uniforms = THREE.ShaderMaterial['uniforms'];

export class SceneRig {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private readonly canvas: HTMLCanvasElement;

  private readonly hemi: THREE.HemisphereLight;
  private readonly moon: THREE.DirectionalLight; // KEY
  private readonly bounce: THREE.DirectionalLight; // cool sky fill, shadowless
  private readonly fill: THREE.DirectionalLight; // camera-follow fill, shadowless
  private readonly fillTarget: THREE.Object3D;

  private readonly floodN: THREE.SpotLight; // over the gate — the one shadow-casting practical
  private readonly floodE: THREE.SpotLight;
  private readonly floodS: THREE.SpotLight;
  private readonly floodW: THREE.SpotLight;
  private readonly brazierGate: THREE.PointLight;
  private readonly brazierDeck: THREE.PointLight;

  private readonly skyDome: THREE.Mesh;
  private readonly skyDomeMat: THREE.ShaderMaterial;
  private readonly moonDisc: THREE.Mesh;
  private readonly moonDiscMat: THREE.ShaderMaterial;
  private readonly stars: THREE.Points;
  private readonly starsMat: THREE.PointsMaterial;

  private readonly postScene: THREE.Scene;
  private readonly postCam: THREE.OrthographicCamera;
  private readonly postQuad: THREE.Mesh;
  private readonly postMat: THREE.ShaderMaterial;

  private readonly forwardScratch = new THREE.Vector3(); // fill-light aim, per frame
  private readonly moonDirScratch = new THREE.Vector3(); // fixed for the whole game, computed once
  private readonly fitScratch = new THREE.Vector3(); // shadow-fit corner, used once
  private readonly fitMatrix = new THREE.Matrix4(); // world -> light space, used once

  private trauma = 0; // 0..1 shake energy
  private shakeT = 0; // accumulated noise clock
  private lastMs = -1; // last applyCamera timestamp, -1 = unset

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
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
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 500); // STYLE_BIBLE: near 0.1 / far 500
    this.camera.rotation.order = 'YXZ'; // yaw about Y, then pitch about local X

    // ---- lights: created once, re-tinted per mood — no add/remove churn ----
    this.hemi = new THREE.HemisphereLight(PALETTE.duskSky, PALETTE.mudLit, 1);
    this.scene.add(this.hemi);

    this.moon = new THREE.DirectionalLight(PALETTE.moonlight, 1);
    this.moon.castShadow = true;
    this.moon.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.moon.shadow.bias = -0.00012;
    this.moon.shadow.radius = 3;
    this.scene.add(this.moon);
    this.scene.add(this.moon.target);

    this.bounce = new THREE.DirectionalLight(PALETTE.skyNightHigh, 0);
    this.bounce.castShadow = false;
    this.scene.add(this.bounce);
    this.scene.add(this.bounce.target);

    this.fill = new THREE.DirectionalLight(PALETTE.paper, FILL_INTENSITY);
    this.fill.castShadow = false;
    this.fillTarget = new THREE.Object3D();
    this.fill.target = this.fillTarget;
    this.scene.add(this.fill);
    this.scene.add(this.fillTarget);

    // ---- moon direction: FIXED for the whole game (only colour/intensity
    // vary with mood), so the cascade is fitted exactly once, below. ----
    const cosE = Math.cos(MOON_ELEVATION);
    this.moonDirScratch.set(
      -Math.sin(MOON_AZIMUTH) * cosE,
      -Math.sin(MOON_ELEVATION),
      -Math.cos(MOON_AZIMUTH) * cosE,
    );
    this.moon.position.copy(this.moonDirScratch).multiplyScalar(-MOON_DISTANCE);
    this.moon.target.position.set(0, DECK1_Y * 0.5, 0); // aimed at the compound's vertical middle
    this.moon.target.updateMatrixWorld();
    this.fitShadowBox();

    const bounceAzimuth = MOON_AZIMUTH + Math.PI; // opposite the moon
    const cosB = Math.cos(BOUNCE_ELEVATION);
    this.bounce.position.set(
      Math.sin(bounceAzimuth) * cosB * BOUNCE_DISTANCE,
      Math.sin(BOUNCE_ELEVATION) * BOUNCE_DISTANCE,
      Math.cos(bounceAzimuth) * cosB * BOUNCE_DISTANCE,
    );
    this.bounce.target.position.set(0, 0, 0);
    this.bounce.target.updateMatrixWorld();

    // ---- practicals ----
    const floodY = DECK2_Y + FLOOD_MOUNT_Y_OFFSET;
    const floodInset = TOWER_HALF - FLOOD_MOUNT_INSET;
    this.floodN = this.buildFloodlight(0, floodY, -floodInset, 0, FLOOD_TARGET_Y, -FENCE_HALF, true);
    this.floodE = this.buildFloodlight(floodInset, floodY, 0, FENCE_HALF, FLOOD_TARGET_Y, 0, false);
    this.floodS = this.buildFloodlight(0, floodY, floodInset, 0, FLOOD_TARGET_Y, FENCE_HALF, false);
    this.floodW = this.buildFloodlight(-floodInset, floodY, 0, -FENCE_HALF, FLOOD_TARGET_Y, 0, false);

    const gateSeg = SEGMENTS.find((s) => s.gate);
    const gateCx = gateSeg?.cx ?? 5;
    const gateCz = gateSeg?.cz ?? -FENCE_HALF;
    const gateNx = gateSeg?.nx ?? 0;
    const gateNz = gateSeg?.nz ?? -1;
    this.brazierGate = this.buildBrazier(
      gateCx - gateNx * GATE_BRAZIER_INSET,
      GATE_BRAZIER_Y,
      gateCz - gateNz * GATE_BRAZIER_INSET,
      GATE_BRAZIER_RANGE,
    );

    const rack = FEATURES.find((f) => f.key === 'weaponRack');
    const rackX = rack?.x ?? -2.5;
    const rackY = rack?.y ?? DECK1_Y;
    const rackZ = rack?.z ?? -2.5;
    this.brazierDeck = this.buildBrazier(rackX, rackY + DECK_BRAZIER_Y_OFFSET, rackZ, DECK_BRAZIER_RANGE);

    // ---- rig-owned sky dome ----
    this.skyDomeMat = new THREE.ShaderMaterial({
      uniforms: {
        uHorizon: { value: new THREE.Color(PALETTE.duskHorizon) },
        uMid: { value: new THREE.Color(PALETTE.duskSky) },
        uZenith: { value: new THREE.Color(PALETTE.duskSkyHigh) },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: true,
      fog: false,
    });
    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(SKY_DOME_RADIUS, 32, 16), this.skyDomeMat);
    this.skyDome.frustumCulled = false;
    this.scene.add(this.skyDome);

    // ---- moon disc ----
    this.moonDiscMat = new THREE.ShaderMaterial({
      uniforms: {
        uCore: { value: SceneRig.srgbColor(PALETTE.paper) },
        uHalo: { value: SceneRig.srgbColor(PALETTE.moonlight) },
        uIntensity: { value: 0.5 },
      },
      vertexShader: MOON_DISC_VERT,
      fragmentShader: MOON_DISC_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.moonDisc = new THREE.Mesh(new THREE.PlaneGeometry(MOON_DISC_SIZE, MOON_DISC_SIZE), this.moonDiscMat);
    this.moonDisc.frustumCulled = false;
    this.moonDisc.position.copy(this.moonDirScratch).multiplyScalar(-MOON_DISC_DISTANCE);
    this.moonDisc.lookAt(0, 0, 0);
    this.scene.add(this.moonDisc);

    // ---- starfield: deterministic seeded placement, never Math.random ----
    this.starsMat = new THREE.PointsMaterial({
      color: PALETTE.paper,
      size: 2,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const starGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(STAR_COUNT * 3);
    const rand = vrng(STAR_SEED);
    for (let i = 0; i < STAR_COUNT; i++) {
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(1 - rand() * STAR_CAP);
      const sinPhi = Math.sin(phi);
      positions[i * 3] = STAR_RADIUS * sinPhi * Math.cos(theta);
      positions[i * 3 + 1] = STAR_RADIUS * Math.cos(phi);
      positions[i * 3 + 2] = STAR_RADIUS * sinPhi * Math.sin(theta);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.stars = new THREE.Points(starGeo, this.starsMat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    // ---- post grade: fullscreen vignette + warm lift, after the world ----
    this.postScene = new THREE.Scene();
    this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postMat = new THREE.ShaderMaterial({
      uniforms: {
        uWarm: { value: SceneRig.srgbColor(PALETTE.torchCore) },
        uLift: { value: POST_LIFT_DUSK },
        uVignette: { value: POST_VIGNETTE },
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
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat);
    this.postQuad.frustumCulled = false;
    this.postScene.add(this.postQuad);

    this.resize();
    this.setTimeOfDay('dusk'); // the run always starts at dusk (DESIGN_BIBLE)
  }

  /** Re-tint lights/fog/sky/practicals for the mood. Idempotent. */
  setTimeOfDay(tod: TimeOfDay): void {
    const m = MOODS[tod];

    this.hemi.color.set(m.hemiSky);
    this.hemi.groundColor.set(m.hemiGround);
    this.hemi.intensity = m.hemiIntensity;
    this.enforceAmbientFloor();

    this.moon.color.set(m.keyColor);
    this.moon.intensity = m.keyIntensity;

    this.bounce.color.set(m.bounceColor);
    this.bounce.intensity = m.bounceIntensity;

    this.floodN.intensity = m.floodIntensity;
    this.floodE.intensity = m.floodIntensity;
    this.floodS.intensity = m.floodIntensity;
    this.floodW.intensity = m.floodIntensity;
    this.brazierGate.intensity = m.brazierGateIntensity;
    this.brazierDeck.intensity = m.brazierDeckIntensity;

    SceneRig.setColorUniform(this.skyDomeMat.uniforms, 'uHorizon', m.domeHorizon);
    SceneRig.setColorUniform(this.skyDomeMat.uniforms, 'uMid', m.domeMid);
    SceneRig.setColorUniform(this.skyDomeMat.uniforms, 'uZenith', m.domeZenith);

    SceneRig.setColorUniform(this.moonDiscMat.uniforms, 'uHalo', m.keyColor);
    SceneRig.setNumberUniform(this.moonDiscMat.uniforms, 'uIntensity', m.moonDiscIntensity * MOON_DISC_INTENSITY_MULT);
    this.moonDisc.visible = true;

    this.starsMat.opacity = m.starOpacity;
    this.stars.visible = m.starOpacity > 0;

    this.scene.fog = new THREE.FogExp2(m.fogColor, m.fogDensity);
    this.renderer.setClearColor(m.fogColor); // any dome gap reads as haze, not as sky

    SceneRig.setNumberUniform(this.postMat.uniforms, 'uLift', m.postLift);
    SceneRig.setNumberUniform(this.postMat.uniforms, 'uVignette', POST_VIGNETTE);
  }

  /**
   * Position/aim the camera for this frame and advance shake. fovDeg is only
   * pushed to the projection matrix when it changes. Shake decays by wall
   * clock here (applyCamera runs exactly once per rendered frame).
   */
  applyCamera(x: number, y: number, z: number, yaw: number, pitch: number, fovDeg: number): void {
    const nowMs = performance.now();
    const dt = this.lastMs < 0 ? 0 : Math.min((nowMs - this.lastMs) / 1000, 0.1);
    this.lastMs = nowMs;
    this.trauma = Math.max(0, this.trauma - dt * SHAKE_DECAY);
    this.shakeT += dt * SHAKE_SPEED;

    this.camera.position.set(x, y, z);
    let rx = pitch;
    let ry = yaw;
    let rz = 0;
    if (this.trauma > 0) {
      const mag = SHAKE_MAX_RAD * Math.pow(Math.min(1, this.trauma), SHAKE_EXP);
      rx += mag * this.noise(0);
      ry += mag * this.noise(1);
      rz += mag * SHAKE_ROLL * this.noise(2);
    }
    this.camera.rotation.set(rx, ry, rz);

    // camera-follow fill: rides the view, aimed ahead of it
    this.camera.getWorldDirection(this.forwardScratch);
    this.fill.position.copy(this.camera.position);
    this.fillTarget.position.copy(this.camera.position).addScaledVector(this.forwardScratch, FILL_AHEAD);
    this.fillTarget.updateMatrixWorld();

    if (this.camera.fov !== fovDeg) {
      this.camera.fov = fovDeg;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Add shake energy (own-fire kick, damage taken). Clamped to [0, 1]. */
  shake(amount: number): void {
    if (!Number.isFinite(amount)) return;
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
    SceneRig.setNumberUniform(this.postMat.uniforms, 'uAspect', w / h);
  }

  /**
   * One frame: world pass, then the fullscreen vignette/warm-lift pass over it.
   *
   * `info.autoReset` is turned OFF and `info.reset()` is driven from here
   * instead. three.js resets `renderer.info` at the START of every
   * `render()` call while autoReset is on, so with TWO passes per frame the
   * counters left standing afterwards describe only the LAST one — the post
   * quad. `telemetry().drawCalls` read exactly that and reported a constant
   * `1` for a scene drawing a fort, a 16-segment fence and 48 zombies, which
   * silently turned the PERF.maxDrawCalls (420) budget into an assertion
   * that could never fail. Resetting once per frame makes the counters sum
   * ACROSS both passes, which is the number the budget is written against.
   */
  render(): void {
    const r = this.renderer;
    r.info.autoReset = false;
    r.info.reset();
    r.autoClear = false;
    r.clear();
    r.render(this.scene, this.camera);
    r.render(this.postScene, this.postCam); // vignette + warm lift over the frame
    r.autoClear = true;
  }

  /** Release GPU resources. Materials from visual.ts's mat() cache are not used here. */
  dispose(): void {
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points || obj instanceof THREE.Line) {
        obj.geometry.dispose();
      }
    });
    this.skyDomeMat.dispose();
    this.moonDiscMat.dispose();
    this.starsMat.dispose();
    this.postQuad.geometry.dispose();
    this.postMat.dispose();
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
  }

  // ---- private helpers --------------------------------------------------------

  private buildFloodlight(
    x: number,
    y: number,
    z: number,
    tx: number,
    ty: number,
    tz: number,
    castsShadow: boolean,
  ): THREE.SpotLight {
    const light = new THREE.SpotLight(FLOOD_COLOR, 0, FLOOD_RANGE, FLOOD_ANGLE, FLOOD_PENUMBRA, 2);
    light.position.set(x, y, z);
    light.target.position.set(tx, ty, tz);
    light.castShadow = castsShadow;
    if (castsShadow) {
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.bias = -0.0018;
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = FLOOD_RANGE + 4;
    }
    this.scene.add(light);
    this.scene.add(light.target);
    light.target.updateMatrixWorld();
    return light;
  }

  private buildBrazier(x: number, y: number, z: number, range: number): THREE.PointLight {
    const light = new THREE.PointLight(BRAZIER_COLOR, 0, range, 2);
    light.position.set(x, y, z);
    light.castShadow = false; // at most ONE practical casts a shadow — the north floodlight does
    this.scene.add(light);
    return light;
  }

  /**
   * §TRAP 1 — fit the 4096 cascade to RIDGELINE's ACTUAL static bounds,
   * measured in the shadow camera's own basis, exactly once (the moon
   * direction is fixed for the whole game). Ported from STRICKEN's per-map
   * `fitShadowFrustum`, simplified: one map, one light direction, one fit.
   */
  private fitShadowBox(): void {
    const sc = this.moon.shadow.camera;
    sc.position.copy(this.moon.position);
    sc.lookAt(this.moon.target.position);
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
        ).applyMatrix4(this.fitMatrix);
        if (v.x < minX) minX = v.x;
        if (v.x > maxX) maxX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.y > maxY) maxY = v.y;
        if (v.z < minZ) minZ = v.z;
        if (v.z > maxZ) maxZ = v.z;
      }
    };

    for (const b of STATIC_BOXES) addBox(b.x, b.y, b.z, b.w, b.h, b.d);
    for (const seg of SEGMENTS) {
      const a = segmentAABB(seg);
      addBox((a.minX + a.maxX) / 2, (a.minY + a.maxY) / 2, (a.minZ + a.maxZ) / 2, a.maxX - a.minX, a.maxY - a.minY, a.maxZ - a.minZ);
    }
    // flat ground apron so the mud beyond the fence still receives the fort's shadow
    addBox(0, 0, 0, SHADOW_GROUND_RADIUS * 2, 0.1, SHADOW_GROUND_RADIUS * 2);

    const halfX = (maxX - minX) / 2 + SHADOW_PAD;
    const halfY = (maxY - minY) / 2 + SHADOW_PAD;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const near = Math.max(0.5, -maxZ - SHADOW_PAD);
    const far = Math.min(SHADOW_FAR, -minZ + SHADOW_PAD);
    this.setShadowBox(cx - halfX, cx + halfX, cy - halfY, cy + halfY, near, far);
  }

  /** Write the ortho box and re-derive normalBias from the resulting texel size. */
  private setShadowBox(left: number, right: number, bottom: number, top: number, near: number, far: number): void {
    const sc = this.moon.shadow.camera;
    sc.left = left;
    sc.right = right;
    sc.bottom = bottom;
    sc.top = top;
    sc.near = near;
    sc.far = far;
    sc.updateProjectionMatrix();
    const texel = Math.max(right - left, top - bottom) / SHADOW_MAP_SIZE;
    this.moon.shadow.normalBias = Math.min(
      SHADOW_NORMAL_BIAS_MAX,
      Math.max(SHADOW_NORMAL_BIAS_MIN, texel * SHADOW_NORMAL_BIAS_TEXELS),
    );
  }

  /**
   * §TRAP 1 — enforce the ambient floor against the sky colour's ACTUAL
   * linear luminance x intensity, never against the raw intensity constant.
   * Lifts intensity to compensate; a degenerate near-black sky colour is
   * lerped halfway toward PALETTE.moonlight first, since intensity alone
   * cannot rescue a colour with ~0 luminance.
   */
  private enforceAmbientFloor(): void {
    const c = this.hemi.color;
    let lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    if (lum < 1e-3) {
      c.lerp(AMBIENT_FLOOR_SCRATCH.set(PALETTE.moonlight), 0.5);
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

  private static setColorUniform(uniforms: Uniforms, name: string, hex: string): void {
    const u = uniforms[name];
    if (u !== undefined) (u.value as THREE.Color).set(hex);
  }

  private static setNumberUniform(uniforms: Uniforms, name: string, value: number): void {
    const u = uniforms[name];
    if (u !== undefined) u.value = value;
  }

  /**
   * Display-space (sRGB) copy of a PALETTE hex for custom-shader uniforms.
   * ShaderMaterial output skips three's tonemap/colorspace chunks, so
   * uniforms feeding raw shader writes must be authored as display-space
   * values (the round trip Color->linear->sRGB recovers the hex byte values).
   */
  private static srgbColor(hex: string): THREE.Color {
    return new THREE.Color(hex).convertLinearToSRGB();
  }

  /** Tracked context-error overlay (single element; never duplicated). */
  private static contextErrorEl: HTMLDivElement | null = null;

  /**
   * Remove the context-error overlay if present. Idempotent — safe to call
   * when no overlay is shown.
   */
  static clearContextError(): void {
    SceneRig.contextErrorEl?.remove();
    SceneRig.contextErrorEl = null;
  }

  /** Full-viewport readable failure message (PALETTE colors); idempotent. */
  static showContextError(): void {
    if (SceneRig.contextErrorEl?.isConnected) return;
    SceneRig.clearContextError();
    const div = document.createElement('div');
    div.textContent = 'WebGL is not available in this browser — OUTPOST needs GPU rendering to run.';
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
