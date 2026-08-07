// ============================================================================
// ANCIENTS (rift) — POST-PROCESSING STACK (R_POST).
//
// STYLE_BIBLE §6 fixes the pass order and it is not negotiable here:
//
//   RenderPass -> screen-space AO -> layer-masked selective bloom
//              -> colour grade + vignette -> OutputPass -> AA
//
// Three structural decisions, each forced by a rule rather than by taste:
//
// 1. BLOOM IS LAYER-MASKED, NEVER THRESHOLD-MASKED. A global luminance
//    threshold cannot tell an emissive crystal from sun-lit metal — it blooms
//    the stone lanes at midday and hazes the whole map. So the emissives are
//    captured in a SECOND composer whose camera is restricted to
//    `BLOOM_LAYER` (the layer `kit.markBloom()` enables), blurred by
//    `UnrealBloomPass` with `threshold = 0`, and added back into the main
//    chain by `BLOOM_COMBINE_SHADER`. Threshold stays at 0 on purpose: the
//    mask IS the layer, and a non-zero threshold would quietly reintroduce
//    the luminance masking the bible bans.
//
// 2. THE AA PASS IS `FXAAPass`, NOT `SMAAPass`. The bible mandates the order
//    "OutputPass (tone mapping + sRGB) THEN SMAA/FXAA" and offers either
//    operator. three r185's `SMAAPass` documents that it works in linear-sRGB
//    and must run BEFORE `OutputPass`; `FXAAPass` is the one that wants
//    display-referred sRGB input and therefore runs AFTER it. FXAA is thus the
//    only choice that keeps the mandated order AND feeds the engine the colour
//    space it asks for. Reordering to fit SMAA would have been a bible
//    violation; the operator was the free variable, the order was not.
//    (AMENDMENT_3 §F ratifies this.)
//
// 3. TONE MAPPING AND EXPOSURE ARE NOT TOUCHED HERE. `OutputPass` reads
//    `renderer.toneMapping` / `toneMappingExposure` off the renderer every
//    frame, and R_SCENE owns both (NeutralToneMapping, 2.75 day -> 1.9 night).
//    `setTimeOfDay` below moves bloom, AO and the grade — nothing else. Two
//    owners of exposure is how a night frame ends up black or washed out.
//
// WHAT THE BLOOM CAPTURE FEEDS THE COMBINE, AND WHY IT IS NOT THE COMPOSER'S
// READ BUFFER. `UnrealBloomPass` blends its own result additively back over
// its input (`blendMaterial`, `AdditiveBlending`), so after `bloomComp.render`
// the bloom composer's read buffer holds `rawEmissiveCapture + strength*blur`,
// NOT the blur alone. Adding that to the beauty buffer — which already drew
// the same emissives — emits every bloomed pixel at 2x, and the surplus is the
// raw capture, which `bloomPass.strength` does not scale. The day/night bloom
// knob would then move only half of what it appears to, and cores would clip
// to white before the knob had said so. The combine therefore samples
// `bloomPass.renderTargetsHorizontal[0]`, the mip-pyramid composite the pass
// writes immediately BEFORE that additive blend: it is the blur alone, already
// multiplied by `strength` and shaped by `radius`, so `base + glow` is exact
// and every bloom constant tuned in the judge loop is calibrated against a 1x
// base.
//
// CAPTURE PARITY. Three pieces of scene state are swapped for the duration of
// the capture and restored before the frame pass returns, so nothing outside
// that function can observe any of them (AMENDMENT_3 §F ratifies the pattern
// for `scene.background`; the other two are the same shape and the same
// reason):
//   * `background` -> null. The background is not layer-masked by the
//     renderer, so a sky colour would paint the whole capture and every pixel
//     in the frame would bloom.
//   * `fog.color` -> black. Fog MIXES toward its colour, so over the capture's
//     black clear a lit fog colour is ADDED to every distant pixel and comes
//     back through the combine as a fog-coloured additive halo — worst at
//     night, where the horizon is the brightest thing in the sky. Black keeps
//     the useful half (a distant crystal is attenuated exactly as the beauty
//     pass attenuates it) and drops the halo.
//   * every light in the scene gains `BLOOM_LAYER`. `camera.layers.set` does
//     not only mask meshes: `WebGLRenderer.projectObject` layer-tests LIGHTS
//     against the camera too, so a camera restricted to `BLOOM_LAYER` collects
//     no light at all and the capture would be lit by `scene.environment`
//     alone — brighter or dimmer than the beauty pass depending on sun angle,
//     with no way to tell from the code. Borrowing the lights for the capture
//     is what makes the halo the blurred image of the thing as drawn. The
//     lights are borrowed without their shadows — `castShadow` off for the
//     capture — because `WebGLShadowMap` layer-tests casters against the SCENE
//     camera: a shadow map rendered from here would hold the bloom-marked
//     meshes and nothing else, and would consume R_SCENE's one per-frame
//     `needsUpdate` (AMENDMENT_3 §D.3) on the way. That also means the capture
//     adds ZERO shadow draws, in either shadow-update mode.
//
// METERING. `renderer.info.autoReset` stays `false` and `renderer.info.reset()`
// is never called from this file. The composer resets nothing by itself, so
// the per-frame draw-call and triangle totals accumulate across the scene
// pass, the AO gbuffer + AO + denoise passes, the bloom capture, the combine,
// the grade, the output pass and the AA pass — which is exactly what
// GRAPHICS_CONTRACT §5 measures against the ≤ 700 budget.
//
// Measured through `renderer.info` in headless Chrome on a real WebGL2 context
// (ANGLE/Metal, Apple M2), shadow pass included, against a scene of 18 meshes
// and 17 shadow casters — 35 draws for a direct `renderer.render`:
//
//   with the post stack, AMENDMENT_3 §D.3 in force  79 draws  (+44)
//   with the post stack, shadowMap.autoUpdate = true 96 draws  (+61)
//
// The +44 is NOT a constant, and quoting it as one is how this budget gets
// mis-planned. It is:
//
//   21  fullscreen quads — 13 inside UnrealBloomPass (1 high-pass, 10
//       separable blur, 1 mip composite, 1 additive blend), 4 for GTAO's AO
//       and denoise, 4 for combine + grade + output + AA. FIXED, and the only
//       part that resolution changes the COST of rather than the count.
//   +   the GTAO gbuffer, which is one more full traversal of the beauty pass
//       (18 here) — so it scales 1:1 with visible draw calls.
//   +   the bloom capture, one traversal of the BLOOM_LAYER meshes alone
//       (5 here) and no shadow draws at all.
//
// The extra 17 in the `autoUpdate = true` row is the shadow map rendered a
// second time by GTAO's traversal — the double shadow render AMENDMENT_3 §D.3
// assigns to R_SCENE, not to this file. The bloom capture contributes zero
// shadow draws in either row (see CAPTURE PARITY).
//
// DEGRADATION. Every construction step runs inside one try/catch. If any pass
// fails to build (no WebGL2, a shader that will not compile, an out-of-memory
// render target) the whole stack is disposed, `setFramePass(null)` hands the
// frame back to `renderer.render(three, camera)`, and `enabled()` reports
// `false`. The same path runs if the composer throws mid-frame. `degrade()`
// unbinds the render target FIRST, before anything else: `EffectComposer
// .render()` restores the renderer's previous target as its LAST statement and
// has no `finally`, so a pass that throws mid-chain leaves the renderer bound
// to an offscreen half-float target, and the direct `renderer.render` that is
// supposed to be the safe fallback would draw into that target instead of the
// canvas — for that frame and every frame after it. A playable un-post-
// processed frame is the required failure mode; a blank canvas is not, and
// "blank forever" least of all. Disabling a pass to buy frame time is a banned
// regression — the only sanctioned lever is capture resolution, which is why
// the bloom capture runs at `BLOOM_RES_SCALE` rather than at full size.
//
// ALLOCATION. Both composers are constructed against a render target already
// sized in DRAWING-BUFFER pixels, and pinned to pixel ratio 1 before any pass
// is added. Left to itself `new EffectComposer(renderer)` sizes its pair at
// `getSize() * getPixelRatio()`; `setPixelRatio(1)` immediately resizes it down
// to CSS pixels; `addPass` then sizes every pass to that wrong size; and the
// first `refit` resizes all of it back up. Measured at pixel ratio 2, counting
// `WebGLRenderTarget.dispose` — a GPU storage release plus a lazy realloc on
// next bind — through construction: 12 disposals that way, 0 as written.
// Nothing in the frame pass allocates after the first frame: the drawing-
// buffer probe writes into a pooled `Vector2`, the grade colours are pooled
// `Color`s written in place by `setTimeOfDay`, the saved fog colour is a
// pooled `Color`, the camera layer mask is a local number, and the borrowed
// lights plus their masks and shadow flags go into three scratch arrays that
// grow exactly once, to the number of lights in the rig.
// ============================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { APAL } from '@rift/shared';
import type { PostHandle, SceneHandle } from '../contract.js';
import { sceneCore, type SceneCore } from './core.js';
import { BLOOM_LAYER } from './kit.js';

// ---- tuning ----------------------------------------------------------------

/** Resolution of the bloom capture relative to the drawing buffer. Bloom is a
 *  wide blur, so half resolution is visually free and pays for the second
 *  scene traversal. This is the ONE sanctioned performance lever — reducing
 *  capture resolution, never removing a pass. */
const BLOOM_RES_SCALE = 0.5;

/** `UnrealBloomPass` threshold. Zero, permanently: the bloom input already
 *  contains nothing but `BLOOM_LAYER` objects, so a threshold could only
 *  re-add the luminance masking STYLE_BIBLE §6 forbids. */
const BLOOM_THRESHOLD = 0;

/** GTAO radius in METRES. Tuned to contact scale, not scene scale: we want the
 *  darkening where a unit's foot meets the ground and where a rock meets a
 *  rock, in the centimetres-to-a-metre range. A scene-scale radius produces a
 *  soft global dimming that reads as a mistuned exposure, not as occlusion. */
const AO_RADIUS_M = 0.55;

/** GTAO strength multiplier inside the AO shader. With `blendIntensity` at 1.0
 *  this is what makes the AO survive a side-by-side on/off check. */
const AO_SCALE = 1.35;

/** GTAO sample count. 16 is the quality knee: 8 aliases into visible banding
 *  on the cliff faces, 32 costs roughly double for a difference the denoiser
 *  hides anyway. */
const AO_SAMPLES = 16;

/** Poisson-denoise sample count for the AO buffer. */
const AO_DENOISE_SAMPLES = 16;

/** How far the grade tints are pushed toward their pure hue before being
 *  blended in. The palette entries used as tints are near-black sky colours;
 *  multiplying by them raw would crush the frame, so each is normalised to
 *  peak 1.0 and then pulled back toward white by this factor. The result tints
 *  hue without moving value. */
const TINT_PURITY = 0.55;

/** Linear-space pivot the contrast curve rotates around — 18% mid grey. */
const GRADE_PIVOT = 0.18;

/** Luminance where the split tone hands over from the shadow tint to the
 *  highlight tint. ONE number, used as the END of the shadow window and the
 *  START of the highlight window, which is what makes the two windows provably
 *  disjoint: `shadowW > 0` only below it, `highW > 0` only above it, and both
 *  are exactly `0` at it. No pixel can ever be multiplied by both tints, which
 *  is the invariant the pass's own doc comment states.
 *
 *  It was two numbers — shadows faded out at 0.42, highlights began at 0.30 —
 *  so every pixel with `l` in [0.30, 0.42] took the cool tint AND the warm one,
 *  i.e. exactly the mid-tones the split is supposed to leave alone. Folding
 *  them into one constant makes the overlap unrepresentable rather than merely
 *  absent, and `smoothstep` is C¹ at both ends so the hand-over is a smooth
 *  fade through neutral, not a seam. */
const SPLIT_HANDOVER = 0.3;

/** Luminance at which the highlight tint reaches full weight. Above the
 *  handover, so the warm half ramps across the whole upper range instead of
 *  snapping on. */
const SPLIT_HIGH_END = 1.4;

/** Per-state grade/bloom/AO tuning. `setTimeOfDay` interpolates DAY -> NIGHT.
 *  Night is not "day with the lights off": bloom roughly doubles so the team
 *  crystals, braziers and hearts become the dominant light in the frame, the
 *  vignette closes down, and AO backs off because the ambient term that
 *  produced the occlusion has itself dimmed. */
interface PostState {
  readonly bloomStrength: number;
  readonly bloomRadius: number;
  readonly aoIntensity: number;
  readonly split: number;
  readonly contrast: number;
  readonly vignette: number;
  readonly shadowTint: string;
  readonly highlightTint: string;
}

const DAY: PostState = {
  bloomStrength: 0.62,
  bloomRadius: 0.48,
  aoIntensity: 1.0,
  split: 0.3,
  contrast: 1.05,
  vignette: 0.22,
  shadowTint: APAL.skyHigh,
  highlightTint: APAL.goldLit,
};

/** Night's warm half is `APAL.gold` — the palette's "shop, bounty, ancient
 *  glow" entry, i.e. literally the colour of the light that dominates a night
 *  frame once the sun is gone. It was `APAL.paper`, and that made the warm half
 *  of the split inert: `paper` is a near-neutral #e8e6df, so after
 *  {@link gradeTint} normalises it to peak 1.0 and pulls it 45% back toward
 *  white it resolves to (1.000, 0.989, 0.953) — a 4.7% blue reduction at FULL
 *  weight, invisible, while `split` climbed from 0.30 to 0.42 to push it.
 *  `gold` resolves to (1.000, 0.803, 0.541) — both numbers read back off the
 *  live `uHighlightTint` uniform at `setTimeOfDay(1)` — so the warm end is a
 *  real tint that the `split` ramp can actually move. It is not
 *  a team colour: `gold` sits ~24° off `ember` and ~172° off `azure`, and the
 *  highlight window only reaches pixels above {@link SPLIT_HANDOVER}. */
const NIGHT: PostState = {
  bloomStrength: 1.25,
  bloomRadius: 0.72,
  aoIntensity: 0.78,
  split: 0.42,
  contrast: 1.1,
  vignette: 0.36,
  shadowTint: APAL.nightSky,
  highlightTint: APAL.gold,
};

// ---- shaders ---------------------------------------------------------------

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Additive combine of the layer-masked bloom into the AO'd beauty buffer.
 *  Both are linear HDR at this point in the chain — bloom must be added before
 *  `OutputPass` or it would be added on top of tone-mapped, sRGB-encoded
 *  pixels and would blow out instead of glowing. Strength lives on
 *  `UnrealBloomPass`, so this is a pure add with no knob of its own.
 *
 *  `tBloom` is `UnrealBloomPass`'s mip composite, NOT the bloom composer's
 *  read buffer — see the header. The read buffer still holds the raw emissive
 *  capture that the pass blended over, and adding that to a beauty buffer
 *  which already drew the same emissives doubles them at a strength the bloom
 *  knob does not scale. */
const BLOOM_COMBINE_SHADER = {
  name: 'RiftBloomCombine',
  uniforms: {
    tDiffuse: { value: null },
    tBloom: { value: null },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
varying vec2 vUv;
void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  vec3 glow = max(texture2D(tBloom, vUv).rgb, vec3(0.0));
  gl_FragColor = vec4(base.rgb + glow, base.a);
}
`,
};

/** Colour grade + vignette — the pass that unifies the frame into "one
 *  photograph". Three moves, all in linear HDR:
 *
 *   * split tone — shadows toward the cool tint, highlights toward the warm
 *     one, weighted by luminance so mid-tones are left alone. The two windows
 *     meet at {@link SPLIT_HANDOVER} and neither reaches past it, so "left
 *     alone" is exact: no pixel is multiplied by both tints;
 *   * a gentle contrast rotation about 18% grey, which is a filmic S in
 *     everything but name and, being a power function, preserves HDR headroom
 *     for `OutputPass` to tone map;
 *   * a radial vignette normalised so `r` is 0 at the centre and 1 at the
 *     corner at ANY aspect ratio (`uAspect` carries that normalisation, set
 *     on resize), so the vignette does not stretch into an oval on a wide
 *     window.
 */
const GRADE_SHADER = {
  name: 'RiftGrade',
  uniforms: {
    tDiffuse: { value: null },
    uShadowTint: { value: new THREE.Color(1, 1, 1) },
    uHighlightTint: { value: new THREE.Color(1, 1, 1) },
    uSplit: { value: 0 },
    uContrast: { value: 1 },
    uVignette: { value: 0 },
    uAspect: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform float uSplit;
uniform float uContrast;
uniform float uVignette;
uniform vec2 uAspect;
varying vec2 vUv;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float PIVOT = ${GRADE_PIVOT.toFixed(4)};
// One handover luminance ends the shadow window and starts the highlight
// window, so the two cannot overlap. See SPLIT_HANDOVER in post.ts.
const float SPLIT_HANDOVER = ${SPLIT_HANDOVER.toFixed(4)};
const float SPLIT_HIGH_END = ${SPLIT_HIGH_END.toFixed(4)};

void main() {
  vec4 texel = texture2D(tDiffuse, vUv);
  vec3 c = max(texel.rgb, vec3(0.0));

  float l = dot(c, LUMA);
  float shadowW = 1.0 - smoothstep(0.0, SPLIT_HANDOVER, l);
  float highW = smoothstep(SPLIT_HANDOVER, SPLIT_HIGH_END, l);
  c *= mix(vec3(1.0), uShadowTint, shadowW * uSplit);
  c *= mix(vec3(1.0), uHighlightTint, highW * uSplit);

  c = pow(c / PIVOT, vec3(uContrast)) * PIVOT;

  vec2 d = (vUv - vec2(0.5)) * uAspect;
  float r = length(d);
  c *= 1.0 - uVignette * smoothstep(0.60, 1.0, r);

  gl_FragColor = vec4(c, texel.a);
}
`,
};

// ---- uniform accessors -----------------------------------------------------
// `ShaderPass` deep-clones the template uniforms, so the live objects must be
// read back off the constructed pass. These throw on a missing or wrong-typed
// slot, which can only happen if a shader above and its accessor drift apart —
// and the throw lands in createPost's try/catch, i.e. it degrades the stack
// rather than white-screening the game.

function numberSlot(pass: ShaderPass, name: string): { value: number } {
  const slot = pass.uniforms[name];
  if (slot === undefined || typeof slot.value !== 'number') {
    throw new Error(`rift post: shader uniform '${name}' is not a number`);
  }
  return slot as { value: number };
}

function textureSlot(pass: ShaderPass, name: string): { value: THREE.Texture | null } {
  const slot = pass.uniforms[name];
  if (slot === undefined) {
    throw new Error(`rift post: shader uniform '${name}' is missing`);
  }
  return slot as { value: THREE.Texture | null };
}

function colorSlot(pass: ShaderPass, name: string): THREE.Color {
  const slot = pass.uniforms[name];
  const value: unknown = slot === undefined ? null : slot.value;
  if (!(value instanceof THREE.Color)) {
    throw new Error(`rift post: shader uniform '${name}' is not a Color`);
  }
  return value;
}

function vec2Slot(pass: ShaderPass, name: string): THREE.Vector2 {
  const slot = pass.uniforms[name];
  const value: unknown = slot === undefined ? null : slot.value;
  if (!(value instanceof THREE.Vector2)) {
    throw new Error(`rift post: shader uniform '${name}' is not a Vector2`);
  }
  return value;
}

/** `UnrealBloomPass`'s mip composite — the ONE buffer inside the pass that
 *  holds the bloom on its own, already multiplied by `strength` and shaped by
 *  `radius`. The pass writes it and then blends it additively over its input,
 *  so it is the last state of the bloom before the raw capture is folded back
 *  in; see the header for why the combine must sample this and not the bloom
 *  composer's read buffer.
 *
 *  Stable across resizes: `setSize` resizes the pass's targets in place and
 *  never replaces the array entries or the `Texture` objects hanging off them,
 *  so binding this once at construction is correct for the composer's life.
 *  The throw is a real guard, not decoration — it is how a three upgrade that
 *  renames the buffer degrades the stack instead of silently blooming nothing. */
function bloomComposite(pass: UnrealBloomPass): THREE.Texture {
  const target = pass.renderTargetsHorizontal[0];
  if (target === undefined) {
    throw new Error('rift post: UnrealBloomPass exposes no mip composite target');
  }
  return target.texture;
}

// ---- helpers ---------------------------------------------------------------

/** `Object3D` carries no `isLight`, so the bloom capture's light scan needs
 *  this to narrow. `Light.isLight` is the same discriminant
 *  `WebGLRenderer.projectObject` itself tests. */
function isLight(o: THREE.Object3D): o is THREE.Light {
  return (o as Partial<THREE.Light>).isLight === true;
}

/** The working buffer an `EffectComposer` would have built for itself, but
 *  sized in drawing-buffer pixels up front. `HalfFloatType` is not optional:
 *  the whole chain up to `OutputPass` is linear HDR, and an 8-bit working
 *  buffer would clip every emissive before the bloom combine ever saw it.
 *  The composer clones this for its second buffer, so one call yields the
 *  pair. */
function halfFloatTarget(w: number, h: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Resolve an APAL entry into a grade tint: sRGB -> linear working space,
 *  normalised to peak 1.0 so it tints hue without dragging value down, then
 *  pulled back toward white by {@link TINT_PURITY}. Writes into `out`. */
function gradeTint(hex: string, out: THREE.Color): THREE.Color {
  out.setStyle(hex, THREE.SRGBColorSpace);
  const peak = Math.max(out.r, out.g, out.b, 1e-4);
  out.setRGB(
    lerp(1, out.r / peak, TINT_PURITY),
    lerp(1, out.g / peak, TINT_PURITY),
    lerp(1, out.b / peak, TINT_PURITY),
  );
  return out;
}

/** The handle returned when the stack could not be built (or was torn down).
 *  Every member is a safe no-op: the scene is drawing itself directly. */
function disabledHandle(): PostHandle {
  return {
    resize: () => {
      /* no composer to re-fit — the renderer draws straight to the canvas */
    },
    setTimeOfDay: () => {
      /* no grade to ramp; R_SCENE still moves the lighting rig and exposure */
    },
    enabled: () => false,
  };
}

// ---- factory ---------------------------------------------------------------

/**
 * Build the post stack and install it as the scene's frame pass.
 *
 * This is the ONLY legal caller of `SceneCore.setFramePass`. On the happy path
 * it calls it exactly once, at construction, to install the composer; every
 * teardown — a pass that fails to build, `setFramePass` itself throwing, a
 * frame that throws mid-chain — adds exactly one `setFramePass(null)`. There
 * is no stacking, so a second `createPost` on the same scene would silently
 * orphan the first composer: R_WIRE constructs this once, immediately after
 * `createScene`.
 */
export function createPost(scene: SceneHandle): PostHandle {
  // A handle that did not come out of createScene carries no core; degrade
  // rather than dereference undefined (GRAPHICS_CONTRACT §7.7).
  const maybeCore = sceneCore(scene) as SceneCore | undefined;
  if (maybeCore === undefined || maybeCore === null) {
    return disabledHandle();
  }
  const core: SceneCore = maybeCore;

  const { three, camera, renderer } = core;

  let composer: EffectComposer | null = null;
  let bloomComposer: EffectComposer | null = null;
  let installed = false;

  // Every pass, held for tuning and disposal.
  let gtaoPass: GTAOPass | null = null;
  let bloomPass: UnrealBloomPass | null = null;
  let combinePass: ShaderPass | null = null;
  let gradePass: ShaderPass | null = null;
  const disposables: { dispose(): void }[] = [];

  // Live uniform slots (bound after construction). `tBloom` is not among them:
  // it points at a buffer inside `bloomPass` that survives every resize, so it
  // is bound once and never touched again.
  let uShadowTint: THREE.Color | null = null;
  let uHighlightTint: THREE.Color | null = null;
  let uSplit: { value: number } | null = null;
  let uContrast: { value: number } | null = null;
  let uVignette: { value: number } | null = null;
  let uAspect: THREE.Vector2 | null = null;

  // Pooled scratch — never reallocated, never read across frames.
  const bufSize = new THREE.Vector2();
  const dayShadow = new THREE.Color();
  const dayHigh = new THREE.Color();
  const nightShadow = new THREE.Color();
  const nightHigh = new THREE.Color();
  const savedFogColor = new THREE.Color();

  // The lights the bloom capture borrows, and the layer mask + shadow flag
  // each had before it borrowed them. Parallel arrays rather than a list of
  // records so the per-frame scan allocates nothing; they grow once, on the
  // first capture, to the size of R_SCENE's light rig (one `DirectionalLight`)
  // and are reused from then on. `capturedLights` is truncated in `degrade` so
  // a torn-down stack holds no reference into a scene it no longer draws.
  const capturedLights: THREE.Light[] = [];
  const capturedMasks: number[] = [];
  const capturedShadow: boolean[] = [];
  let capturedCount = 0;

  let lastW = 0;
  let lastH = 0;
  let phase = 0;

  /** Re-fit the composer and every pass target to the renderer's CURRENT
   *  drawing-buffer size. No argument by design: the size and pixel ratio come
   *  back off the renderer, which `SceneHandle.resize()` has already set, so
   *  the composer and the canvas cannot disagree. Both composers run at
   *  pixel-ratio 1 against drawing-buffer pixels — the ratio is already baked
   *  into the drawing-buffer size, and applying it twice would allocate targets
   *  at 4x the area on a retina display. */
  function refit(force: boolean): void {
    if (composer === null || bloomComposer === null) return;
    renderer.getDrawingBufferSize(bufSize);
    const w = Math.max(1, Math.round(bufSize.x));
    const h = Math.max(1, Math.round(bufSize.y));
    if (!force && w === lastW && h === lastH) return;
    lastW = w;
    lastH = h;

    composer.setSize(w, h);
    bloomComposer.setSize(
      Math.max(1, Math.round(w * BLOOM_RES_SCALE)),
      Math.max(1, Math.round(h * BLOOM_RES_SCALE)),
    );

    // Normalise the vignette radius so r == 1 at the corner at any aspect.
    if (uAspect !== null) {
      const ax = w >= h ? w / h : 1;
      const ay = w >= h ? 1 : h / w;
      const corner = Math.hypot(ax * 0.5, ay * 0.5);
      const k = corner > 0 ? 1 / corner : 1;
      uAspect.set(ax * k, ay * k);
    }
  }

  /** Tear the stack down and hand the frame back to `renderer.render`. Called
   *  when construction fails and when a frame throws — the two cases the
   *  `null` argument of `setFramePass` exists for. */
  function degrade(err: unknown): void {
    // FIRST STATEMENT, before the unhook and before disposal.
    // `EffectComposer.render()` saves the renderer's render target, runs the
    // pass chain, and restores the target as its LAST statement — with no
    // `finally`. A pass that throws mid-chain therefore leaves the renderer
    // bound to an offscreen half-float target, and every later
    // `renderer.render(three, camera)` — starting with the one in `framePass`'s
    // own catch, which exists precisely to keep the game visible — draws into
    // that target instead of the canvas. The screen would go blank on that frame
    // and STAY blank forever, which is the exact inverse of the mandated
    // degradation. Unbinding here is what makes "playable, un-post-processed"
    // true rather than aspirational.
    renderer.setRenderTarget(null);

    // Unconditional, NOT guarded on `installed`. The case that most needs the
    // unhook is `core.setFramePass(framePass)` itself throwing: `installed` is
    // still false at that point, yet the seam may already be holding a pass
    // whose composer this call is about to dispose. Nulling a slot that was
    // never filled is a no-op — R_POST is the only legal caller and there is no
    // stacking — so there is nothing to guard against and everything to lose.
    installed = false;
    try {
      core.setFramePass(null);
    } catch (unhookErr) {
      // A seam that cannot be un-hooked is R_SCENE's problem, not a reason to
      // skip disposal; the frame pass below still degrades to a direct render.
      console.error('[rift] post: setFramePass(null) failed while degrading', unhookErr);
    }

    capturedLights.length = 0;
    capturedMasks.length = 0;
    capturedShadow.length = 0;
    capturedCount = 0;

    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        // A dispose that throws on a half-built pass must not mask the real
        // failure, and there is nothing left to clean up either way.
      }
    }
    disposables.length = 0;
    composer = null;
    bloomComposer = null;
    gtaoPass = null;
    bloomPass = null;
    combinePass = null;
    gradePass = null;
    uShadowTint = null;
    uHighlightTint = null;
    uSplit = null;
    uContrast = null;
    uVignette = null;
    uAspect = null;
    console.error('[rift] post-processing disabled, rendering direct', err);
  }

  /** Push the interpolated state of `phase` into every pass. */
  function applyState(): void {
    const t = phase;
    if (bloomPass !== null) {
      bloomPass.strength = lerp(DAY.bloomStrength, NIGHT.bloomStrength, t);
      bloomPass.radius = lerp(DAY.bloomRadius, NIGHT.bloomRadius, t);
      bloomPass.threshold = BLOOM_THRESHOLD;
    }
    if (gtaoPass !== null) {
      gtaoPass.blendIntensity = lerp(DAY.aoIntensity, NIGHT.aoIntensity, t);
    }
    if (uSplit !== null) uSplit.value = lerp(DAY.split, NIGHT.split, t);
    if (uContrast !== null) uContrast.value = lerp(DAY.contrast, NIGHT.contrast, t);
    if (uVignette !== null) uVignette.value = lerp(DAY.vignette, NIGHT.vignette, t);
    if (uShadowTint !== null) uShadowTint.lerpColors(dayShadow, nightShadow, t);
    if (uHighlightTint !== null) uHighlightTint.lerpColors(dayHigh, nightHigh, t);
  }

  /** The frame pass. Installed on the core seam, it replaces
   *  `renderer.render(three, camera)` for as long as the stack is alive. */
  function framePass(dtMs: number): void {
    const comp = composer;
    const bloomComp = bloomComposer;
    if (comp === null || bloomComp === null) {
      renderer.render(three, camera);
      return;
    }
    try {
      // No resize hook exists on the core seam, so the frame pass is where a
      // window resize is noticed. Targets are only reallocated on a real change.
      refit(false);

      const dt = dtMs * 0.001;

      // --- bloom capture: BLOOM_LAYER only ---------------------------------
      // The camera layer mask is the whole selective-bloom mechanism, and the
      // three swaps around it are what make the capture agree with the beauty
      // pass instead of merely resembling it. See CAPTURE PARITY in the header
      // for why each one is necessary; all three are restored in the `finally`
      // below, so nothing outside this function ever observes any of them.
      const savedMask = camera.layers.mask;
      const savedBackground = three.background;
      const fog = three.fog;
      camera.layers.set(BLOOM_LAYER);
      three.background = null;
      if (fog !== null) {
        savedFogColor.copy(fog.color);
        fog.color.setRGB(0, 0, 0);
      }
      // Lights are layer-tested against the camera exactly like meshes, so
      // without this the capture is lit by `scene.environment` alone. Depth 1:
      // R_SCENE builds the whole rendered rig — one `DirectionalLight`, sun by
      // day and moon by night — as a direct child of the scene root, and the
      // PMREM `environment` that carries the fill is scene state and is never
      // layer-masked at all. A full `traverse` here would walk every baked
      // chunk and every unit every frame to find one object.
      //
      // The lights are borrowed WITHOUT their shadows, and that is not an
      // optimisation. `WebGLShadowMap` layer-tests casters against the SCENE
      // camera, not against the shadow camera, so a shadow map rendered from
      // inside this capture would contain the bloom-marked meshes and NOTHING
      // ELSE — and under AMENDMENT_3 §D.3 it would consume R_SCENE's one
      // `needsUpdate` for the frame, leaving the beauty pass to shade the whole
      // map against a shadow map of nothing but crystals. Measured on a rig of
      // 17 casters: every one of the 17 shadow draws vanished from the beauty
      // pass, and the capture grew 5. `castShadow = false` empties
      // `shadowsArray`, `WebGLShadowMap.render` returns before it clears
      // `needsUpdate`, and the beauty pass renders the real shadow map exactly
      // once. The capture is therefore lit but unshadowed, which moves a
      // blurred half-resolution halo by a fraction of the emissive that
      // dominates it.
      const roots = three.children;
      capturedCount = 0;
      for (let i = 0; i < roots.length; i++) {
        const child = roots[i];
        if (child === undefined || !isLight(child)) continue;
        capturedLights[capturedCount] = child;
        capturedMasks[capturedCount] = child.layers.mask;
        capturedShadow[capturedCount] = child.castShadow;
        capturedCount++;
        child.layers.enable(BLOOM_LAYER);
        child.castShadow = false;
      }
      try {
        bloomComp.render(dt);
      } finally {
        for (let i = 0; i < capturedCount; i++) {
          const light = capturedLights[i];
          const mask = capturedMasks[i];
          const casts = capturedShadow[i];
          // All three reads are `| undefined` under `noUncheckedIndexedAccess`;
          // `capturedCount` is the length that was just written.
          if (light === undefined || mask === undefined || casts === undefined) continue;
          light.layers.mask = mask;
          light.castShadow = casts;
        }
        if (fog !== null) fog.color.copy(savedFogColor);
        three.background = savedBackground;
        camera.layers.mask = savedMask;
      }

      // --- main chain ------------------------------------------------------
      // `tBloom` needs no per-frame rebind: it points into `bloomPass`, whose
      // buffers are resized in place and never replaced.
      comp.render(dt);
    } catch (err) {
      degrade(err);
      renderer.render(three, camera);
    }
  }

  try {
    gradeTint(DAY.shadowTint, dayShadow);
    gradeTint(DAY.highlightTint, dayHigh);
    gradeTint(NIGHT.shadowTint, nightShadow);
    gradeTint(NIGHT.highlightTint, nightHigh);

    renderer.getDrawingBufferSize(bufSize);
    const w0 = Math.max(1, Math.round(bufSize.x));
    const h0 = Math.max(1, Math.round(bufSize.y));
    const bw0 = Math.max(1, Math.round(w0 * BLOOM_RES_SCALE));
    const bh0 = Math.max(1, Math.round(h0 * BLOOM_RES_SCALE));

    // --- bloom capture composer ------------------------------------------
    // Its RenderPass clears to true black with alpha 0. Black is the identity
    // of an additive combine, not a palette decision — an APAL colour here
    // would lift every pixel in the frame.
    //
    // Both composers are handed a target sized in DRAWING-BUFFER pixels and
    // then pinned to pixel ratio 1, before any pass is added — see ALLOCATION
    // in the header for the 12-disposal churn that costs when it is left out.
    // The ratio is already baked into the drawing-buffer size; applying it
    // again would allocate at 4x the area on a retina display.
    bloomComposer = new EffectComposer(renderer, halfFloatTarget(bw0, bh0));
    disposables.push(bloomComposer);
    bloomComposer.renderToScreen = false;
    bloomComposer.setPixelRatio(1);

    const bloomRender = new RenderPass(three, camera, null, new THREE.Color(0, 0, 0), 0);
    disposables.push(bloomRender);
    bloomComposer.addPass(bloomRender);

    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(bw0, bh0),
      DAY.bloomStrength,
      DAY.bloomRadius,
      BLOOM_THRESHOLD,
    );
    disposables.push(bloomPass);
    bloomComposer.addPass(bloomPass);

    // --- main composer, STYLE_BIBLE §6 order ------------------------------
    composer = new EffectComposer(renderer, halfFloatTarget(w0, h0));
    disposables.push(composer);
    composer.setPixelRatio(1);

    // 1. RenderPass
    const scenePass = new RenderPass(three, camera);
    disposables.push(scenePass);
    composer.addPass(scenePass);

    // 2. Ambient occlusion (GTAO). It renders its own depth+normal gbuffer,
    //    which is a second traversal of the scene and is the largest single
    //    line item in the raised ≤ 700 draw-call budget.
    gtaoPass = new GTAOPass(three, camera, w0, h0);
    disposables.push(gtaoPass);
    gtaoPass.output = GTAOPass.OUTPUT.Default;
    gtaoPass.blendIntensity = DAY.aoIntensity;
    gtaoPass.updateGtaoMaterial({
      radius: AO_RADIUS_M,
      distanceExponent: 1,
      thickness: 1,
      distanceFallOff: 1,
      scale: AO_SCALE,
      samples: AO_SAMPLES,
      screenSpaceRadius: false,
    });
    gtaoPass.updatePdMaterial({
      lumaPhi: 10,
      depthPhi: 2,
      normalPhi: 3,
      radius: 4,
      radiusExponent: 1,
      rings: 2,
      samples: AO_DENOISE_SAMPLES,
    });
    composer.addPass(gtaoPass);

    // 3. Selective bloom, combined additively from the layer-masked capture.
    //    The source is the pass's mip composite — the blur alone, scaled by
    //    `strength` — not the composer's read buffer, which still carries the
    //    raw emissive capture the pass blended over.
    combinePass = new ShaderPass(BLOOM_COMBINE_SHADER);
    disposables.push(combinePass);
    textureSlot(combinePass, 'tBloom').value = bloomComposite(bloomPass);
    composer.addPass(combinePass);

    // 4. Colour grade + vignette.
    gradePass = new ShaderPass(GRADE_SHADER);
    disposables.push(gradePass);
    uShadowTint = colorSlot(gradePass, 'uShadowTint');
    uHighlightTint = colorSlot(gradePass, 'uHighlightTint');
    uSplit = numberSlot(gradePass, 'uSplit');
    uContrast = numberSlot(gradePass, 'uContrast');
    uVignette = numberSlot(gradePass, 'uVignette');
    uAspect = vec2Slot(gradePass, 'uAspect');
    composer.addPass(gradePass);

    // 5. OutputPass — tone mapping + sRGB, both inherited from the renderer.
    const outputPass = new OutputPass();
    disposables.push(outputPass);
    composer.addPass(outputPass);

    // 6. Antialiasing, after OutputPass, on display-referred sRGB (see header).
    const aaPass = new FXAAPass();
    disposables.push(aaPass);
    composer.addPass(aaPass);

    refit(true);
    applyState();

    core.setFramePass(framePass);
    installed = true;
  } catch (err) {
    degrade(err);
    return disabledHandle();
  }

  return {
    resize: () => {
      if (!installed) return;
      refit(false);
    },
    setTimeOfDay: (t: number) => {
      if (!installed) return;
      phase = t < 0 ? 0 : t > 1 ? 1 : t;
      applyState();
    },
    enabled: () => installed,
  };
}
