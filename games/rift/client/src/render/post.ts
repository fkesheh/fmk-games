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
//
// 3. TONE MAPPING AND EXPOSURE ARE NOT TOUCHED HERE. `OutputPass` reads
//    `renderer.toneMapping` / `toneMappingExposure` off the renderer every
//    frame, and R_SCENE owns both (NeutralToneMapping, 2.75 day -> 1.9 night).
//    `setTimeOfDay` below moves bloom, AO and the grade — nothing else. Two
//    owners of exposure is how a night frame ends up black or washed out.
//
// METERING. `renderer.info.autoReset` stays `false` and `renderer.info.reset()`
// is never called from this file. The composer resets nothing by itself, so
// the per-frame draw-call and triangle totals accumulate across the scene
// pass, the AO gbuffer + AO + denoise passes, the bloom capture, the combine,
// the grade, the output pass and the AA pass — which is exactly what
// GRAPHICS_CONTRACT §5 measures against the ≤ 700 budget.
//
// DEGRADATION. Every construction step runs inside one try/catch. If any pass
// fails to build (no WebGL2, a shader that will not compile, an out-of-memory
// render target) the whole stack is disposed, `setFramePass(null)` hands the
// frame back to `renderer.render(three, camera)`, and `enabled()` reports
// `false`. The same path runs if the composer throws mid-frame — one bad frame
// uninstalls the stack instead of repeating a black screen forever. A playable
// un-post-processed frame is the required failure mode; a blank canvas is not.
// Disabling a pass to buy frame time is a banned regression — the only
// sanctioned lever is capture resolution, which is why the bloom capture runs
// at `BLOOM_RES_SCALE` rather than at full size.
//
// ALLOCATION. Nothing in the frame pass allocates: the drawing-buffer probe
// writes into a pooled `Vector2`, the grade colours are pooled `Color`s written
// in place by `setTimeOfDay`, and the camera layer mask is saved as a number.
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

const NIGHT: PostState = {
  bloomStrength: 1.25,
  bloomRadius: 0.72,
  aoIntensity: 0.78,
  split: 0.42,
  contrast: 1.1,
  vignette: 0.36,
  shadowTint: APAL.nightSky,
  highlightTint: APAL.paper,
};

// ---- shaders ---------------------------------------------------------------

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Additive combine of the layer-masked bloom capture into the AO'd beauty
 *  buffer. Both are linear HDR at this point in the chain — bloom must be
 *  added before `OutputPass` or it would be added on top of tone-mapped,
 *  sRGB-encoded pixels and would blow out instead of glowing. Strength lives
 *  on `UnrealBloomPass`, so this is a pure add with no knob of its own. */
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
 *     one, weighted by luminance so mid-tones are left alone;
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

void main() {
  vec4 texel = texture2D(tDiffuse, vUv);
  vec3 c = max(texel.rgb, vec3(0.0));

  float l = dot(c, LUMA);
  float shadowW = 1.0 - smoothstep(0.0, 0.42, l);
  float highW = smoothstep(0.30, 1.40, l);
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

// ---- helpers ---------------------------------------------------------------

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
 * This is the ONLY legal caller of `SceneCore.setFramePass`, and it calls it
 * exactly twice at most: once at construction to install the composer, and
 * once with `null` if the stack has to be torn down. There is no stacking — a
 * second `createPost` on the same scene would silently orphan the first
 * composer — so R_WIRE constructs this once, immediately after `createScene`.
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

  // Live uniform slots (bound after construction).
  let uBloomTex: { value: THREE.Texture | null } | null = null;
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
    if (installed) {
      installed = false;
      core.setFramePass(null);
    }
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
    uBloomTex = null;
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
      // The camera layer mask is the whole selective-bloom mechanism. The
      // background is nulled for this capture only: it is not layer-masked by
      // the renderer, so a sky colour would paint the entire target and every
      // pixel of the frame would bloom. Fog stays on so a distant crystal
      // glows exactly as strongly as it is drawn in the beauty pass. Both are
      // restored before the pass returns — nothing outside this function ever
      // observes the swap.
      const savedMask = camera.layers.mask;
      const savedBackground = three.background;
      camera.layers.set(BLOOM_LAYER);
      three.background = null;
      try {
        bloomComp.render(dt);
      } finally {
        three.background = savedBackground;
        camera.layers.mask = savedMask;
      }

      if (uBloomTex !== null) uBloomTex.value = bloomComp.readBuffer.texture;

      // --- main chain ------------------------------------------------------
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

    // --- bloom capture composer ------------------------------------------
    // Its RenderPass clears to true black with alpha 0. Black is the identity
    // of an additive combine, not a palette decision — an APAL colour here
    // would lift every pixel in the frame.
    bloomComposer = new EffectComposer(renderer);
    disposables.push(bloomComposer);
    bloomComposer.renderToScreen = false;
    bloomComposer.setPixelRatio(1);

    const bloomRender = new RenderPass(three, camera, null, new THREE.Color(0, 0, 0), 0);
    disposables.push(bloomRender);
    bloomComposer.addPass(bloomRender);

    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(
        Math.max(1, Math.round(w0 * BLOOM_RES_SCALE)),
        Math.max(1, Math.round(h0 * BLOOM_RES_SCALE)),
      ),
      DAY.bloomStrength,
      DAY.bloomRadius,
      BLOOM_THRESHOLD,
    );
    disposables.push(bloomPass);
    bloomComposer.addPass(bloomPass);

    // --- main composer, STYLE_BIBLE §6 order ------------------------------
    composer = new EffectComposer(renderer);
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
    combinePass = new ShaderPass(BLOOM_COMBINE_SHADER);
    disposables.push(combinePass);
    uBloomTex = textureSlot(combinePass, 'tBloom');
    uBloomTex.value = bloomComposer.readBuffer.texture;
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
