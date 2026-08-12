// ============================================================================
// scene.test.ts — the W4 unit gates (CONTRACT_V3 §12.5.5).
//
// No splat test imported any render/* file before V3, so "the suite passes
// unchanged" proved nothing about the scene. These gates measure the SHIPPED
// helpers in render/scene.ts — setCamera calls carveRoll() and
// pitchFromTerrain() directly, and the bloom/ambient models here are the same
// constants the renderer installs — so this is production behaviour, not a
// replica of it.
//
// Headless by construction: SplatScene itself needs a DOM and a WebGL context,
// so none of these tests construct it. Everything asserted here is a pure
// function of the frozen constants, which is exactly what makes it gateable in
// CI. The four things that genuinely need pixels (§12.5a's mean-luma,
// std-dev, sky-visible and speed-predicate checks) belong to the W6 capture
// harness and are NOT restated here.
//
// Covered:
//   §12.1     the airborne carve-roll gate
//   §12.3g    the camera-pitch envelope under §12.2a's raised relief
//   §12.5a.2  the ambient floor — no shadowed outdoor region reads black
//   §V3.5     the fog band's depth ramp and shell placement
//   §V3.6     the bright-pass threshold: snow and paper must never bloom
// ============================================================================
import { describe, expect, it } from 'vitest';
import { MAX_SPEED, SPAL } from '@splat/shared';
import { genSlope } from '@splat/shared/slope.js';
import {
  brightPassWeight,
  brightPassWeightOfHex,
  carveRoll,
  displayLuma,
  fogBandShellRadii,
  fogBandWeight,
  hexDisplayLuma,
  pitchFromTerrain,
  shadedSurfaceLuma,
  shadedSurfaceSrgb,
  shadowedRegionLuma,
} from './scene.js';

const DEG = 180 / Math.PI;
const ROLL_MAX_DEG = 4; // STYLE_BIBLE's carve bank
const SPAL_KEYS = Object.keys(SPAL) as Array<keyof typeof SPAL>;

/** ndotUp samples: straight down, side-on, straight up, and between. */
const NORMALS = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];

// ---------------------------------------------------------------------------
// §12.1 — the camera must not bank into a turn the sim ignores
// ---------------------------------------------------------------------------
describe('carve roll is gated on airborne (CONTRACT_V3 §12.1)', () => {
  it('is EXACTLY zero while fully airborne, for every steer and speed', () => {
    for (const steer of [-1, -0.7, -0.2, 0, 0.2, 0.7, 1]) {
      for (const v of [0, 5, 12, 20, MAX_SPEED, MAX_SPEED * 1.5]) {
        // Math.abs so a signed -0 (steer < 0 times a zero gate) still reads as
        // "no bank at all" — -0 and +0 rotate the camera identically.
        expect(Math.abs(carveRoll(steer, v, 1)), `steer ${steer} v ${v}`).toBe(0);
      }
    }
  });

  it('is unchanged from the grounded formula while grounded', () => {
    // the HEAD expression: clamp(steer,-1,1) * (|v|/MAX_SPEED) * ROLL_MAX
    for (const steer of [-1, -0.35, 0, 0.35, 1]) {
      for (const v of [0, 9, 18, MAX_SPEED]) {
        const expected = (steer * (Math.abs(v) / MAX_SPEED) * ROLL_MAX_DEG) / DEG;
        expect(carveRoll(steer, v, 0)).toBeCloseTo(expected, 12);
      }
    }
  });

  it('reaches the full ~4 degree bank at full lock and full speed', () => {
    expect(carveRoll(1, MAX_SPEED, 0) * DEG).toBeCloseTo(ROLL_MAX_DEG, 9);
    expect(carveRoll(-1, MAX_SPEED, 0) * DEG).toBeCloseTo(-ROLL_MAX_DEG, 9);
  });

  it('fades linearly through the eased airborne flag — never snaps', () => {
    const grounded = carveRoll(1, MAX_SPEED, 0);
    expect(carveRoll(1, MAX_SPEED, 0.25)).toBeCloseTo(grounded * 0.75, 12);
    expect(carveRoll(1, MAX_SPEED, 0.5)).toBeCloseTo(grounded * 0.5, 12);
    expect(carveRoll(1, MAX_SPEED, 0.75)).toBeCloseTo(grounded * 0.25, 12);
    // strictly monotone decreasing in airVis
    let prev = Infinity;
    for (let a = 0; a <= 1.0001; a += 0.1) {
      const r = carveRoll(1, MAX_SPEED, a);
      expect(r).toBeLessThan(prev);
      prev = r;
    }
  });

  it('clamps steer and the airborne flag out of range', () => {
    expect(carveRoll(5, MAX_SPEED, 0)).toBe(carveRoll(1, MAX_SPEED, 0));
    expect(carveRoll(-5, MAX_SPEED, 0)).toBe(carveRoll(-1, MAX_SPEED, 0));
    expect(carveRoll(1, MAX_SPEED, 4)).toBe(0);
    expect(carveRoll(1, MAX_SPEED, -3)).toBe(carveRoll(1, MAX_SPEED, 0));
  });
});

// ---------------------------------------------------------------------------
// §12.3g — the pitch envelope under §12.2a's raised terrain
// ---------------------------------------------------------------------------
describe('camera pitch survives the raised relief (CONTRACT_V3 §12.3g)', () => {
  /** Pitch envelope, in degrees, over a sampled traverse. */
  function envelope(seed: number, xs: number[], yaws: number[], dz: number) {
    const s = genSlope(seed);
    let lo = Infinity;
    let hi = -Infinity;
    for (let z = 0; z <= s.finishZ; z += dz) {
      for (const x of xs) {
        const y = s.height(x, z);
        for (const yaw of yaws) {
          const p = pitchFromTerrain(s, x, y, z, yaw) * DEG;
          if (p < lo) lo = p;
          if (p > hi) hi = p;
        }
      }
    }
    return { lo, hi, span: hi - lo };
  }

  it('never pitches UP, anywhere on 20 seeds, at any heading a skier can hold', () => {
    // This is the failure §12.3g names: with the raised amplitude and no
    // compression the raw terrain pitch reaches +1.77 deg across these seeds —
    // the camera looking at the sky over a crest. It must always look downhill.
    for (let seed = 1; seed <= 20; seed++) {
      const e = envelope(seed, [-27, -20, -10, 0, 10, 20, 27], [-1.2, -0.6, 0, 0.6, 1.2], 1);
      expect(e.hi, `seed ${seed} max pitch ${e.hi.toFixed(2)} deg`).toBeLessThan(0);
      expect(e.lo, `seed ${seed} min pitch ${e.lo.toFixed(2)} deg`).toBeGreaterThan(-24);
    }
  });

  it('holds seed 42 inside round 0 framing on the fall line', () => {
    // HEAD (pre-§12.2a terrain, LOOK_AHEAD 14) measured -19.72..-9.13 deg,
    // span 10.58. The raised relief raw is -22.38..-6.12, span 16.26. The
    // §12.3g compression must put it back, or round-1 captures differ from
    // round 0 for camera reasons instead of art reasons.
    const e = envelope(42, [0], [0], 0.5);
    expect(e.span, `seed 42 fall-line span ${e.span.toFixed(2)} deg`).toBeLessThanOrEqual(11.0);
    expect(e.lo).toBeGreaterThan(-21);
    expect(e.hi).toBeLessThan(-8);
  });

  it('stays bounded across the seed-42 traverse the shot list actually flies', () => {
    const e = envelope(42, [-20, 0, 20], [-0.6, -0.3, 0, 0.3, 0.6], 0.5);
    expect(e.lo).toBeGreaterThan(-21);
    expect(e.hi).toBeLessThan(-5);
    expect(e.span).toBeLessThanOrEqual(15);
  });

  it('is continuous — no step larger than a degree over half a metre of run', () => {
    const s = genSlope(42);
    let prev: number | null = null;
    for (let z = 0; z <= s.finishZ; z += 0.5) {
      const p = pitchFromTerrain(s, 0, s.height(0, z), z, 0) * DEG;
      if (prev !== null) expect(Math.abs(p - prev)).toBeLessThan(1);
      prev = p;
    }
  });
});

// ---------------------------------------------------------------------------
// §12.5a.2 — the ambient floor
// ---------------------------------------------------------------------------
describe('the shadow-side floor (CONTRACT_V3 §12.5a.2)', () => {
  // SPAL.ink is excluded on purpose: it is the deliberate near-black UI /
  // silhouette accent (panel text, ski sidewall, W5's gloves), not a
  // snow-country surface albedo. It is SUPPOSED to be the darkest note in the
  // frame. Every other SPAL entry is something the mountain is made of.
  const OUTDOOR = SPAL_KEYS.filter((k) => k !== 'ink');

  it('no fully shadowed outdoor region falls below 0.10 luma', () => {
    for (const k of OUTDOOR) {
      for (const nd of NORMALS) {
        const v = shadowedRegionLuma(SPAL[k], nd);
        expect(v, `${k} at ndotUp=${nd} -> ${v.toFixed(4)}`).toBeGreaterThanOrEqual(0.1);
      }
    }
  });

  it('the worst case is a dark up-facing surface, and it clears with margin', () => {
    // Measured worst: pineDark facing straight up (it sees only the hemisphere
    // SKY stop) in the frame corner where the vignette is full and the warm
    // grade lift is weakest.
    const worst = shadowedRegionLuma(SPAL.pineDark, 1);
    expect(worst).toBeGreaterThan(0.11);
    expect(worst).toBeLessThan(0.2); // ...and it is still clearly a DARK note
  });

  it('was genuinely broken before: HEAD lighting put pineDark at 0.0475', () => {
    // The round-0 near-black frame. Reproduced with HEAD's constants
    // (hemi sky = skyZenith/skyHorizon 50-50 at 0.8, ground = snow, NO
    // ambient) this surface measured 0.0475 display luma. The shipped value
    // must be a large multiple of that, or the fix is cosmetic.
    expect(shadedSurfaceLuma(SPAL.pineDark, 0)).toBeGreaterThan(0.0475 * 2);
  });

  it('keeps shadows reading as SHADOW, not as flat light', () => {
    // Fully shadowed snow must stay well below the ~0.80 a sunlit piste
    // reaches, or the floor has flattened the mountain.
    expect(shadedSurfaceLuma(SPAL.snow, 1)).toBeLessThan(0.7);
    expect(shadedSurfaceLuma(SPAL.snow, 1)).toBeGreaterThan(0.1);
  });

  it('preserves the snow value ladder under indirect light only', () => {
    const lit = shadedSurfaceLuma(SPAL.snowLit, 1);
    const base = shadedSurfaceLuma(SPAL.snow, 1);
    const shade = shadedSurfaceLuma(SPAL.snowShade, 1);
    const deep = shadedSurfaceLuma(SPAL.snowDeep, 1);
    expect(lit).toBeGreaterThan(base);
    expect(base).toBeGreaterThan(shade);
    expect(shade).toBeGreaterThan(deep);
  });

  it('a shadowed snow surface reads BLUE, never grey and never black (§V1)', () => {
    // Channel-level proof, not a value proxy: under sun-free indirect light
    // alone, every snow-ladder surface must come out with blue leading red by
    // a visible margin. A grey shadow would have b - r near zero.
    for (const hex of [SPAL.snowLit, SPAL.snow, SPAL.snowShade, SPAL.snowDeep]) {
      for (const nd of [-1, 0, 1]) {
        const [r, g, b] = shadedSurfaceSrgb(hex, nd);
        expect(b, `${hex} nd=${nd} b=${b.toFixed(3)} r=${r.toFixed(3)}`).toBeGreaterThan(r + 0.02);
        expect(b).toBeGreaterThan(g); // ...and blue leads green too: it is cool, not teal
      }
    }
  });

  it('the ambient tint itself is cool — the floor cannot grey out the shade', () => {
    // A neutral (pure white) surface lit only by this scene's indirect terms
    // must still come back blue. That is the ambient/hemisphere colour choice
    // doing its job; a neutral ambient would give r === g === b.
    const [r, , b] = shadedSurfaceSrgb(SPAL.snowLit, 0);
    expect(b - r).toBeGreaterThan(0.03);
  });

  it('the floor is monotone in albedo — brighter paint is never darker', () => {
    for (const nd of NORMALS) {
      expect(shadedSurfaceLuma(SPAL.rockLit, nd)).toBeGreaterThan(
        shadedSurfaceLuma(SPAL.rock, nd),
      );
      expect(shadedSurfaceLuma(SPAL.pineLit, nd)).toBeGreaterThan(
        shadedSurfaceLuma(SPAL.pineDark, nd),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §V3.5 — the fog band
// ---------------------------------------------------------------------------
describe('fog band depth ramp (STYLE_BIBLE_V3 §V3.5)', () => {
  it('is identically zero at and inside 60 m — the near field is never touched', () => {
    for (let r = 0; r <= 60; r += 0.5) {
      expect(fogBandWeight(r), `r=${r}`).toBe(0);
    }
  });

  it('is identically zero at and beyond 140 m', () => {
    for (let r = 140; r <= 400; r += 5) {
      expect(fogBandWeight(r), `r=${r}`).toBe(0);
    }
  });

  it('is strictly positive across the whole 60-140 m band interior', () => {
    for (let r = 61; r <= 139; r += 1) {
      expect(fogBandWeight(r), `r=${r}`).toBeGreaterThan(0);
    }
  });

  it('peaks at the middle of the band and is capped at 1', () => {
    expect(fogBandWeight(95)).toBeCloseTo(1, 9);
    for (let r = 0; r <= 400; r += 0.5) {
      expect(fogBandWeight(r)).toBeLessThanOrEqual(1);
    }
  });

  it('places every shell strictly inside the band, ascending, clear of 60 m', () => {
    const shells = fogBandShellRadii();
    expect(shells.length).toBeGreaterThanOrEqual(3);
    let prev = 0;
    for (const r of shells) {
      expect(r, `shell ${r}`).toBeGreaterThan(60);
      expect(r, `shell ${r}`).toBeLessThan(140);
      // a real clearance, not a hairline — the camera can never reach it
      expect(r).toBeGreaterThanOrEqual(70);
      expect(fogBandWeight(r), `shell ${r} weight`).toBeGreaterThan(0);
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
  });
});

// ---------------------------------------------------------------------------
// §V3.6 — the bright-pass threshold
// ---------------------------------------------------------------------------
describe('bloom bright pass (STYLE_BIBLE_V3 §V3.6)', () => {
  it('a frame of pure snow produces a ZERO bright-pass result', () => {
    // The contract's headline requirement. snow is #eef2f8, luma 0.947 — the
    // whole lit piste paints near this, and blooming it is the named failure.
    expect(brightPassWeightOfHex(SPAL.snow)).toBe(0);
  });

  it('a frame of pure paper produces a ZERO bright-pass result', () => {
    // paper is the W5 glove cuff and a fog-band tint; luma 0.967.
    expect(brightPassWeightOfHex(SPAL.paper)).toBe(0);
  });

  it('sunWarm — the sun disc tint — does not bloom on its own either', () => {
    expect(brightPassWeightOfHex(SPAL.sunWarm)).toBe(0);
  });

  it('nothing in SPAL blooms except pure snowLit', () => {
    for (const k of SPAL_KEYS) {
      const w = brightPassWeightOfHex(SPAL[k]);
      if (k === 'snowLit') expect(w, k).toBe(1);
      else expect(w, `${k} (luma ${hexDisplayLuma(SPAL[k]).toFixed(3)})`).toBe(0);
    }
  });

  it('pins the palette lumas the threshold was chosen against', () => {
    expect(hexDisplayLuma(SPAL.snowLit)).toBeCloseTo(1.0, 6);
    expect(hexDisplayLuma(SPAL.snow)).toBeCloseTo(0.947, 3);
    expect(hexDisplayLuma(SPAL.paper)).toBeCloseTo(0.967, 3);
    expect(hexDisplayLuma(SPAL.sunWarm)).toBeCloseTo(0.949, 3);
  });

  it('has its knee floor above every one of those — 0.99, not 0.95', () => {
    // Guards the rev-1 value (0.97 / knee 0.02) that would start the bright
    // pass at 0.95 and bloom most of the lit piste. Nothing below 0.99 passes.
    expect(brightPassWeight(0.99, 0.99, 0.99)).toBe(0);
    expect(brightPassWeight(0.98, 0.98, 0.98)).toBe(0);
    expect(brightPassWeight(0.9673, 0.9673, 0.9673)).toBe(0);
    expect(brightPassWeight(1, 1, 1)).toBe(1);
  });

  it('is monotone non-decreasing in luma and stays in 0..1', () => {
    let prev = -1;
    for (let l = 0; l <= 1.0001; l += 0.005) {
      const w = brightPassWeight(l, l, l);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
  });

  it('weights luma by Rec.709, matching the composite shader', () => {
    expect(displayLuma(1, 0, 0)).toBeCloseTo(0.2126, 9);
    expect(displayLuma(0, 1, 0)).toBeCloseTo(0.7152, 9);
    expect(displayLuma(0, 0, 1)).toBeCloseTo(0.0722, 9);
    expect(displayLuma(1, 1, 1)).toBeCloseTo(1, 9);
  });
});
