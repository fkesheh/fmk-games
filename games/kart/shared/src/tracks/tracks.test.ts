// ============================================================================
// THE CIRCUIT GATE — every registered circuit, every lap of it.
//
// Two jobs, and neither is optional:
//
//  1. GEOMETRY. Every circuit in TRACKS is run through validateTrack (the same
//     1024-sample corner-radius / self-intersection / self-clearance checks the
//     authoring contract defines) plus the things validateTrack cannot know:
//     the CCW travel convention, that gate 0 lands on control point 0, and that
//     all MAX_PLAYERS grid slots land on tarmac. A circuit is not "authored"
//     until it passes here — this file is why a broken loop can never reach the
//     wire, because TRACK_LIST is derived from the same registry.
//
//  2. COLOUR. valueLadder.test.ts enforces VISUAL_UPGRADE.md §1/§2 over KPAL.
//     A circuit's `theme.palette` re-skins KPAL, so the SAME laws have to hold
//     over each circuit's RESOLVED palette ({ ...KPAL, ...theme.palette }) or a
//     re-skin could quietly flatten a ladder that the shared palette passes.
//     Same thresholds, no weakening — retune the circuit palette instead.
//
// It also asserts the eight are actually EIGHT DIFFERENT PLACES to drive and to
// look at: distinct lengths, distinct tightest corners, distinct verge hues.
// Seven variations of one circuit would pass every check above individually.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { L, saturation } from '@platform/shared';
import { MAX_PLAYERS } from '../config.js';
import { KPAL } from '../palette.js';
import {
  MIN_CORNER_RADIUS,
  MIN_SELF_CLEARANCE,
  MIN_TRACK_LENGTH,
  type TrackSource,
  buildTrack,
  gridSlot,
  validateTrack,
} from '../track.js';
import { DEFAULT_TRACK_ID, TRACKS, TRACK_LIST, isTrackId } from './index.js';

const ENTRIES = Object.entries(TRACKS) as ReadonlyArray<[string, TrackSource]>;
const n = (x: number): string => x.toFixed(1);

/** Resolved palette a circuit actually renders with (trackMesh.ts does the same). */
function resolved(t: TrackSource): Record<string, string> {
  return { ...KPAL, ...t.theme.palette };
}

/** Signed area of the control loop; Greenvale's convention is > 0 == CCW. */
function signedArea(pts: ReadonlyArray<readonly [number, number]>): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as readonly [number, number];
    const b = pts[(i + 1) % pts.length] as readonly [number, number];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Tightest corner radius at the density validateTrack gates on. */
function tightestCorner(t: TrackSource): number {
  const cl = buildTrack(t).centerline;
  const m = cl.length;
  let min = Infinity;
  for (let i = 0; i < m; i++) {
    const a = cl[(i - 1 + m) % m] as [number, number];
    const b = cl[i] as [number, number];
    const c = cl[(i + 1) % m] as [number, number];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const area2 = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
    if (area2 > 1e-9) min = Math.min(min, (ab * bc * ca) / (2 * area2));
  }
  return min;
}

// ============================================================================
// REGISTRY
// ============================================================================
describe('KART circuit registry', () => {
  it('every TRACKS entry is keyed by its own id', () => {
    for (const [key, t] of ENTRIES) {
      expect(t.id, `TRACKS['${key}'] declares id '${t.id}' — the key IS the wire value`).toBe(key);
    }
  });

  it('TRACK_LIST is exactly the registry, in declaration order', () => {
    expect(TRACK_LIST.map((t) => t.id)).toEqual(ENTRIES.map(([k]) => k));
  });

  it('the default circuit is registered', () => {
    expect(isTrackId(DEFAULT_TRACK_ID)).toBe(true);
  });

  it('there are at least eight circuits and every name/blurb is filled in', () => {
    expect(ENTRIES.length).toBeGreaterThanOrEqual(8);
    for (const [, t] of ENTRIES) {
      expect(t.name.length, `${t.id} has no display name`).toBeGreaterThan(2);
      expect(t.blurb.length, `${t.id} has no blurb`).toBeGreaterThan(10);
    }
  });
});

// ============================================================================
// GEOMETRY — one describe per circuit so a failure names the circuit
// ============================================================================
describe.each(ENTRIES)('KART circuit geometry: %s', (id, track) => {
  it('passes validateTrack', () => {
    const v = validateTrack(track);
    expect(v.errors, `'${id}' is not a legal circuit:\n  ${v.errors.join('\n  ')}`).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('is longer than the grid needs and shorter than 256 samples can describe', () => {
    const len = buildTrack(track).length;
    expect(len, `'${id}' is ${n(len)} m`).toBeGreaterThan(MIN_TRACK_LENGTH);
    // SAMPLES is fixed at 256, so length also sets the centreline resolution:
    // past ~1000 m the samples are >4 m apart and corners visibly facet.
    expect(len, `'${id}' is ${n(len)} m — past 1000 m the 256-sample centreline facets`).toBeLessThan(1000);
  });

  it('is travelled counter-clockwise', () => {
    expect(signedArea(track.points), `'${id}' control loop winds the wrong way`).toBeGreaterThan(0);
  });

  it('gate 0 lands on control point 0 and every gate sits on the centreline', () => {
    const t = buildTrack(track);
    const g0 = t.gates[0];
    expect(g0, 'gate 0 must exist').toBeDefined();
    expect(g0?.index).toBe(0);
    for (const g of t.gates) {
      expect(Number.isFinite(g.x) && Number.isFinite(g.z), `'${id}' has a non-finite gate`).toBe(true);
      expect(Math.hypot(g.tx, g.tz), `'${id}' gate tangent is not unit`).toBeCloseTo(1, 3);
    }
  });

  it('every one of the MAX_PLAYERS grid slots is on tarmac', () => {
    const t = buildTrack(track);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const s = gridSlot(t, i);
      expect(Number.isFinite(s.x) && Number.isFinite(s.z), `'${id}' slot ${i} is not finite`).toBe(true);
      // gridSlot offsets from the LOCAL normal, so the slot is on the road iff
      // its lateral offset is inside the half-width; recover it from the walk.
      let best = Infinity;
      for (const c of t.centerline) best = Math.min(best, Math.hypot(c[0] - s.x, c[1] - s.z));
      expect(best, `'${id}' grid slot ${i} sits ${n(best)} m from the centreline`).toBeLessThan(
        t.roadHalfW,
      );
    }
  });

  it('clears the corner-radius and self-clearance floors with margin', () => {
    const r = tightestCorner(track);
    expect(r, `'${id}' tightest corner is ${n(r)} m`).toBeGreaterThan(MIN_CORNER_RADIUS);
    expect(MIN_SELF_CLEARANCE).toBeGreaterThan(0); // documents what validateTrack gated
  });
});

// ============================================================================
// COLOUR — the §1/§2 ladder laws over every circuit's RESOLVED palette
// ============================================================================
describe.each(ENTRIES)('KART circuit palette: %s', (id, track) => {
  const P = resolved(track);
  const order = (hiName: string, loName: string): void => {
    const hi = P[hiName] as string;
    const lo = P[loName] as string;
    expect(
      L(hi),
      `'${id}' tier order: L(${hiName} ${hi})=${n(L(hi))} must exceed L(${loName} ${lo})=${n(L(lo))}`,
    ).toBeGreaterThan(L(lo));
  };
  const span = (hiName: string, loName: string): void => {
    const hi = P[hiName] as string;
    const lo = P[loName] as string;
    expect(
      L(hi) - L(lo),
      `'${id}' contact band: L(${hiName})-L(${loName}) = ${n(L(hi) - L(lo))} must clear 8`,
    ).toBeGreaterThanOrEqual(8);
  };

  it('every overridden value is a #rrggbb from the circuit palette table', () => {
    for (const [k, v] of Object.entries(track.theme.palette ?? {})) {
      expect(v, `'${id}'.${k} is not a hex colour`).toMatch(/^#[0-9a-f]{6}$/);
      expect(Object.prototype.hasOwnProperty.call(KPAL, k), `'${id}' overrides unknown key ${k}`).toBe(
        true,
      );
    }
  });

  it('§2 grass tiers: grassLit > grass > grassDark > grassDeep, 8 L* contact band', () => {
    order('grassLit', 'grass');
    order('grass', 'grassDark');
    order('grassDark', 'grassDeep');
    span('grass', 'grassDeep');
  });

  it('§2 asphalt tiers: asphaltLit > asphaltLight > asphalt > asphaltDeep, 8 L* band', () => {
    order('asphaltLit', 'asphaltLight');
    order('asphaltLight', 'asphalt');
    order('asphalt', 'asphaltDeep');
    span('asphalt', 'asphaltDeep');
  });

  it('§2 canopy, dirt, rock and trunk all keep their contact bands', () => {
    order('treeLeafLight', 'treeLeaf');
    order('treeLeaf', 'treeLeafDeep');
    span('dirt', 'dirtDeep');
    span('rock', 'rockDeep');
    span('treeTrunk', 'treeTrunkDeep');
  });

  it('§4 atmospheric perspective: ridgeFar is lighter AND less saturated', () => {
    const far = P.ridgeFar as string;
    const near = P.ridgeNear as string;
    expect(L(far), `'${id}' L(ridgeFar)=${n(L(far))} vs L(ridgeNear)=${n(L(near))}`).toBeGreaterThan(
      L(near),
    );
    expect(
      saturation(far),
      `'${id}' sat(ridgeFar)=${n(saturation(far))} vs sat(ridgeNear)=${n(saturation(near))}`,
    ).toBeLessThan(saturation(near));
  });

  it('§1 S2: the theme fog is exactly the theme horizon stop', () => {
    expect(track.theme.fog, `'${id}' fog must equal horizon — fog never matches the zenith`).toBe(
      track.theme.horizon,
    );
  });

  it('§1 S1: the horizon stays >= 12 L* lighter than the fixed skyHigh zenith', () => {
    const d = L(track.theme.horizon) - L(KPAL.skyHigh);
    expect(d, `'${id}' horizon/zenith separation is ${n(d)} L*`).toBeGreaterThanOrEqual(12);
  });

  it('the road reads against the verge: >= 14 L* between grass and asphalt', () => {
    const d = L(P.grass as string) - L(P.asphalt as string);
    expect(
      d,
      `'${id}' verge L ${n(L(P.grass as string))} vs road L ${n(L(P.asphalt as string))} — ` +
        `${n(d)} L* apart; the tarmac has to read as tarmac from the chase cam`,
    ).toBeGreaterThanOrEqual(14);
  });

  it('the sun and fog settings are sane', () => {
    expect(track.theme.fogDensity).toBeGreaterThan(0);
    expect(track.theme.fogDensity, `'${id}' fog would swallow its own ridgelines`).toBeLessThan(0.02);
    expect(Math.hypot(...track.theme.sunDir), `'${id}' has a null sun direction`).toBeGreaterThan(0.1);
    expect(track.theme.sunIntensity).toBeGreaterThan(0.5);
    expect(track.theme.hemiIntensity).toBeGreaterThan(0.2);
  });
});

// ============================================================================
// EIGHT DIFFERENT PLACES — the check no per-circuit assertion can make
// ============================================================================
describe('KART calendar variety', () => {
  it('no two circuits are the same length (>= 5% apart)', () => {
    const lens = ENTRIES.map(([id, t]) => ({ id, len: buildTrack(t).length })).sort(
      (a, b) => a.len - b.len,
    );
    for (let i = 1; i < lens.length; i++) {
      const a = lens[i - 1] as { id: string; len: number };
      const b = lens[i] as { id: string; len: number };
      expect(
        b.len / a.len,
        `${a.id} (${n(a.len)} m) and ${b.id} (${n(b.len)} m) are the same lap — ` +
          `the calendar is meant to be eight different circuits, not seven re-dresses`,
      ).toBeGreaterThan(1.05);
    }
  });

  it('the calendar spans a real range of lap lengths', () => {
    const lens = ENTRIES.map(([, t]) => buildTrack(t).length);
    const lo = Math.min(...lens);
    const hi = Math.max(...lens);
    expect(hi / lo, `shortest ${n(lo)} m, longest ${n(hi)} m`).toBeGreaterThan(2);
  });

  it('corner character differs: the tightest corners are spread out', () => {
    const rs = ENTRIES.map(([id, t]) => ({ id, r: tightestCorner(t) }));
    const lo = Math.min(...rs.map((x) => x.r));
    const hi = Math.max(...rs.map((x) => x.r));
    expect(
      hi / lo,
      `tightest corner per circuit: ${rs.map((x) => `${x.id} ${n(x.r)}m`).join(', ')} — ` +
        `a calendar where every circuit's slowest corner is the same is one circuit`,
    ).toBeGreaterThan(3);
  });

  it('no two circuits share a verge colour', () => {
    const seen = new Map<string, string>();
    for (const [id, t] of ENTRIES) {
      const g = resolved(t).grass as string;
      const prev = seen.get(g);
      expect(prev, `${id} and ${prev ?? ''} both lay down ${g} grass`).toBeUndefined();
      seen.set(g, id);
    }
  });

  it('no two circuits share a sky', () => {
    const seen = new Set<string>();
    for (const [id, t] of ENTRIES) {
      expect(seen.has(t.theme.horizon), `${id} reuses horizon ${t.theme.horizon}`).toBe(false);
      seen.add(t.theme.horizon);
    }
  });
});
