// ============================================================================
// Gate for the STRICKEN §C4 death-feedback pass (task B2).
//
// Lives under src/render/ ON PURPOSE: vitest.config.ts's ONLY include glob for
// the fps client is `games/fps/client/src/client/render/**` -- a suite written
// next to hud.ts in src/ui/ would be silently skipped, which has already
// happened three times in this repo. Verified with
// `rtk proxy "npx vitest list --filesOnly"`, which lists this file.
//
// Everything asserted here is pure. The DOM half (element creation, WAAPI
// restart) is verified on pixels instead -- there is no jsdom in this repo and
// SceneRig needs a WebGL context, so neither can be constructed headlessly.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  damageSeverity01,
  deathCardText,
  lowHpIntensity01,
  painFlashAlpha,
} from '../ui/hud.js';
import {
  SHAKE_FIRE_ADD,
  SHAKE_FIRE_CEIL,
  shakeDecay,
  shakeMagnitudeRad,
  shakeTraumaForDamage,
} from './scene.js';

const deg = (rad: number): number => (rad * 180) / Math.PI;

/** Peak shake in DEGREES for an incoming hit of `dmg`, end to end. */
const shakeDegForDamage = (dmg: number): number =>
  deg(shakeMagnitudeRad(shakeTraumaForDamage(damageSeverity01(dmg))));

// ---------------------------------------------------------------------------
// C4: killer-name resolution. The null case is the one that would embarrass us
// in front of a player, so it is asserted from every direction it can arrive.
// ---------------------------------------------------------------------------
describe('deathCardText', () => {
  it('renders a NEUTRAL form for a null killer (suicide / console kill / world)', () => {
    const r = deathCardText(null);
    expect(r.head).toBe('ELIMINATED');
    expect(r.name).toBe('');
  });

  it('never emits the string "undefined" for any absent-killer spelling', () => {
    for (const absent of [null, undefined, '', '   ', '\t\n']) {
      const r = deathCardText(absent);
      expect(r.head).toBe('ELIMINATED');
      expect(r.name).toBe('');
      expect(`${r.head} ${r.name}`).not.toContain('undefined');
      expect(`${r.head} ${r.name}`).not.toContain('null');
      expect(r.head).not.toContain('KILLED BY');
    }
  });

  it('renders KILLED BY <name> for a real killer', () => {
    const r = deathCardText('Bravo');
    expect(r.head).toBe('KILLED BY');
    expect(r.name).toBe('Bravo');
  });

  it('trims but otherwise preserves the name verbatim (casing included)', () => {
    expect(deathCardText('  xX_sniper_Xx  ').name).toBe('xX_sniper_Xx');
    expect(deathCardText('BOT Alpha').name).toBe('BOT Alpha');
  });
});

// ---------------------------------------------------------------------------
// Damage-flash scaling: a graze and a near-kill must not read identically.
// ---------------------------------------------------------------------------
describe('damageSeverity01', () => {
  it('is 0 for non-positive or malformed damage', () => {
    // Infinity is malformed, not "maximum damage": a garbled event degrades to
    // NO extra response rather than to a full-screen whiteout + max shake.
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(damageSeverity01(bad)).toBe(0);
    }
  });

  it('is monotonically non-decreasing in damage', () => {
    let prev = -1;
    for (let d = 0; d <= 120; d += 3) {
      const v = damageSeverity01(d);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('saturates at 1 and never exceeds it', () => {
    expect(damageSeverity01(60)).toBeCloseTo(1, 6);
    expect(damageSeverity01(89)).toBe(1);
    expect(damageSeverity01(10_000)).toBe(1);
  });
});

describe('painFlashAlpha', () => {
  it('does not flash at all when no damage was dealt', () => {
    expect(painFlashAlpha(0)).toBe(0);
    expect(painFlashAlpha(-1)).toBe(0);
  });

  it('separates a 12-damage graze from an 89-damage near-kill by a wide margin', () => {
    const graze = painFlashAlpha(12);
    const nearKill = painFlashAlpha(89);
    // the defect this pass exists to fix: these used to be the SAME pixels
    expect(nearKill).toBeGreaterThan(graze * 2);
    expect(graze).toBeGreaterThan(0.15); // still unmistakably a hit
    expect(nearKill).toBeLessThanOrEqual(0.6); // never a blinding whiteout
  });

  it('stays a legal opacity across the whole damage range', () => {
    for (let d = 1; d <= 150; d += 1) {
      const a = painFlashAlpha(d);
      expect(a).toBeGreaterThan(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });
});

describe('lowHpIntensity01', () => {
  it('is silent at healthy HP and fully lit when nearly dead', () => {
    expect(lowHpIntensity01(100)).toBe(0);
    expect(lowHpIntensity01(30)).toBe(0); // LOW_HP is the threshold, not below it
    expect(lowHpIntensity01(8)).toBe(1);
    expect(lowHpIntensity01(1)).toBe(1);
  });

  it('ramps monotonically between the threshold and the floor', () => {
    let prev = -1;
    for (let hp = 30; hp >= 0; hp -= 1) {
      const v = lowHpIntensity01(hp);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
    expect(lowHpIntensity01(20)).toBeGreaterThan(0);
    expect(lowHpIntensity01(20)).toBeLessThan(1);
  });

  it('degrades to silent on malformed HP rather than to NaN styling', () => {
    expect(lowHpIntensity01(Number.NaN)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Camera shake. The audit measured the old peak at 0.0018 rad = 0.103 deg,
// which is imperceptible -- the feature effectively did not exist.
// ---------------------------------------------------------------------------
describe('shakeMagnitudeRad', () => {
  it('is 0 for no trauma and clamps above trauma 1', () => {
    expect(shakeMagnitudeRad(0)).toBe(0);
    expect(shakeMagnitudeRad(-1)).toBe(0);
    expect(shakeMagnitudeRad(Number.NaN)).toBe(0);
    expect(shakeMagnitudeRad(5)).toBe(shakeMagnitudeRad(1));
  });

  it('is monotonically increasing in trauma', () => {
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const v = shakeMagnitudeRad(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('peaks around 1.5 degrees -- perceptible, not sickening', () => {
    const peak = deg(shakeMagnitudeRad(1));
    expect(peak).toBeGreaterThan(1.2);
    expect(peak).toBeLessThan(2.0);
  });
});

describe('shake magnitude, end to end from damage', () => {
  it('makes a taken hit PERCEPTIBLE -- the old flat 0.103 deg did not', () => {
    // regression pin: anything at or below the old peak is invisible on screen
    expect(shakeDegForDamage(12)).toBeGreaterThan(0.4);
    expect(shakeDegForDamage(25)).toBeGreaterThan(0.6);
    expect(shakeDegForDamage(89)).toBeGreaterThan(1.2);
  });

  it('grades the shake by damage instead of a flat 15x on everything', () => {
    const graze = shakeDegForDamage(12);
    const body = shakeDegForDamage(25);
    const nearKill = shakeDegForDamage(89);
    expect(body).toBeGreaterThan(graze);
    expect(nearKill).toBeGreaterThan(body);
    // a near-lethal hit must be a clearly bigger event than a graze
    expect(nearKill / graze).toBeGreaterThan(2);
  });

  it('never exceeds the motion-sickness ceiling even on an absurd hit', () => {
    expect(shakeDegForDamage(10_000)).toBeLessThan(2.0);
  });

  it('agrees with the HUD flash: both scale off the same severity', () => {
    // guards against the two halves drifting apart in a later retune
    const pairs = [10, 25, 45, 70].map((d) => [painFlashAlpha(d), shakeDegForDamage(d)] as const);
    for (let i = 1; i < pairs.length; i++) {
      const [aPrev, sPrev] = pairs[i - 1]!;
      const [aCur, sCur] = pairs[i]!;
      expect(aCur).toBeGreaterThanOrEqual(aPrev);
      expect(sCur).toBeGreaterThanOrEqual(sPrev);
    }
  });
});

describe('own-fire shake must not spoil aim', () => {
  it('stays far below the taken-damage response', () => {
    const fire = deg(shakeMagnitudeRad(SHAKE_FIRE_CEIL));
    expect(fire).toBeGreaterThan(0.15); // perceptible as a kick
    expect(fire).toBeLessThan(0.4); // but never enough to fight the crosshair
    expect(fire).toBeLessThan(shakeDegForDamage(12));
  });

  it('cannot be stacked past its ceiling by emptying a magazine', () => {
    // simulate 30 rounds with NO decay at all -- the worst possible case
    let trauma = 0;
    for (let i = 0; i < 30; i++) {
      trauma = Math.min(SHAKE_FIRE_CEIL, trauma + SHAKE_FIRE_ADD);
    }
    expect(trauma).toBe(SHAKE_FIRE_CEIL);
    expect(deg(shakeMagnitudeRad(trauma))).toBeLessThan(0.4);
  });
});

describe('shakeDecay', () => {
  it('never goes negative and settles to exactly zero', () => {
    expect(shakeDecay(0.5, 10)).toBe(0);
    expect(shakeDecay(0, 0.016)).toBe(0);
    expect(shakeDecay(Number.NaN, 0.016)).toBe(0);
  });

  it('is monotone and reaches zero in a bounded, human time', () => {
    let t = shakeTraumaForDamage(1); // the biggest hit in the game
    let elapsed = 0;
    const dt = 1 / 60;
    while (t > 0 && elapsed < 5) {
      const next = shakeDecay(t, dt);
      expect(next).toBeLessThan(t);
      t = next;
      elapsed += dt;
    }
    expect(t).toBe(0);
    // long enough to actually oscillate, short enough not to linger
    expect(elapsed).toBeGreaterThan(0.3);
    expect(elapsed).toBeLessThan(0.9);
  });
});

describe('shakeTraumaForDamage', () => {
  it('clamps its input and stays inside the legal trauma range', () => {
    for (const s of [-1, 0, 0.5, 1, 2, Number.NaN]) {
      const t = shakeTraumaForDamage(s);
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThanOrEqual(1);
    }
    expect(shakeTraumaForDamage(-1)).toBe(shakeTraumaForDamage(0));
    expect(shakeTraumaForDamage(2)).toBe(shakeTraumaForDamage(1));
  });
});
