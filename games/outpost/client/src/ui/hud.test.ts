// ============================================================================
// ui-hud pure-logic suite. This workspace has no jsdom, so — per the brief
// ("keep pure display logic in exported pure functions so it is
// unit-testable headlessly") — this file exercises ONLY the exported pure
// functions from hud.ts, none of which touch `document`. The `Hud` class
// itself (DOM construction + update() wiring) is exercised at runtime by the
// e2e/capture harnesses in a real browser, mirroring how games/rift and
// games/splat split "logic" from "DOM" for a jsdom-less workspace, minus
// building a full DOM double (out of scope for this file's pure-logic bar).
// ============================================================================
import { describe, expect, it } from 'vitest';
import { DOWNED, FENCE, PALETTE, SURVIVOR } from '@outpost/shared';
import type { HudState, RunStats, SegmentSnap } from '@outpost/shared';

import {
  alpha,
  ammoText,
  arcRotationDeg,
  bleedoutRemaining01,
  canAfford,
  damageSeverity01,
  formatCountdown,
  formatDistance,
  formatSeconds,
  interactPrompt,
  lowHpIntensity01,
  phaseLabel,
  ringIndexOnSide,
  ringRotationDeg,
  ringSide,
  sortedDowned,
  sortedRunStats,
  tickerColorKey,
  tickVisual,
  weaponLabel,
} from './hud.js';

function seg(hp: number, br: boolean, rb: number): SegmentSnap {
  return { hp, br, rb };
}

describe('tickVisual', () => {
  it('reads intact segments as intact, coloured hpGreen, filled to hp', () => {
    expect(tickVisual(seg(1, false, 0))).toEqual({ state: 'intact', fill01: 1, colorKey: 'hpGreen' });
    expect(tickVisual(seg(0.6, false, 0))).toEqual({ state: 'intact', fill01: 0.6, colorKey: 'hpGreen' });
  });

  it('crosses into damaged strictly below the 0.6 threshold', () => {
    expect(tickVisual(seg(0.599, false, 0)).state).toBe('damaged');
    expect(tickVisual(seg(0.599, false, 0)).colorKey).toBe('hudAccent');
    expect(tickVisual(seg(0.1, false, 0)).state).toBe('damaged');
  });

  it('breach flag wins over hp even while hp is climbing during a rebuild', () => {
    // fence.ts: "a segment being rebuilt has hp climbing from 0 while still
    // breached" — the ring must not read this as merely "damaged".
    const v = tickVisual(seg(0.4, true, 0.2));
    expect(v.state).toBe('breached');
    expect(v.colorKey).toBe('downedRed');
    // fill tracks REBUILD progress, not hp, while breached
    expect(v.fill01).toBe(0.2);
  });

  it('clamps a breached fill to 0..1 defensively', () => {
    expect(tickVisual(seg(0, true, -1)).fill01).toBe(0);
    expect(tickVisual(seg(0, true, 1.4)).fill01).toBe(1);
  });
});

describe('ringRotationDeg', () => {
  it('is the identity conversion, radians to degrees, clockwise-positive', () => {
    expect(ringRotationDeg(0)).toBe(0);
    expect(ringRotationDeg(Math.PI / 2)).toBeCloseTo(90);
    expect(ringRotationDeg(-Math.PI)).toBeCloseTo(-180);
  });

  it('degrades non-finite yaw to 0 rather than propagating NaN into CSS', () => {
    expect(ringRotationDeg(Number.NaN)).toBe(0);
    expect(ringRotationDeg(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('ringSide / ringIndexOnSide', () => {
  it('mirrors map.ts SEGMENTS: 0-3 north, 4-7 east, 8-11 south, 12-15 west', () => {
    expect(ringSide(0)).toBe('north');
    expect(ringSide(3)).toBe('north');
    expect(ringSide(4)).toBe('east');
    expect(ringSide(7)).toBe('east');
    expect(ringSide(8)).toBe('south');
    expect(ringSide(11)).toBe('south');
    expect(ringSide(12)).toBe('west');
    expect(ringSide(15)).toBe('west');
  });

  it('covers every segment id exactly once across the four sides', () => {
    const bySide: Record<string, number> = { north: 0, east: 0, south: 0, west: 0 };
    for (let id = 0; id < FENCE.segments; id++) bySide[ringSide(id)]!++;
    expect(bySide).toEqual({ north: 4, east: 4, south: 4, west: 4 });
  });

  it('gives each side\'s 4 ticks ascending positions in id order', () => {
    expect(ringIndexOnSide(0)).toBe(0);
    expect(ringIndexOnSide(3)).toBe(3);
    expect(ringIndexOnSide(4)).toBe(0);
    expect(ringIndexOnSide(15)).toBe(3);
  });
});

describe('bleedoutRemaining01', () => {
  it('is 1 at a full bleedout window and 0 at zero', () => {
    expect(bleedoutRemaining01(DOWNED.bleedoutSec)).toBe(1);
    expect(bleedoutRemaining01(0)).toBe(0);
  });

  it('is proportional at the midpoint', () => {
    expect(bleedoutRemaining01(DOWNED.bleedoutSec / 2)).toBeCloseTo(0.5);
  });
});

describe('formatSeconds / formatDistance / formatCountdown', () => {
  it('formatSeconds rounds UP so it never reads "0s" a tick before death', () => {
    expect(formatSeconds(12.1)).toBe('13s');
    expect(formatSeconds(0)).toBe('0s');
    expect(formatSeconds(-4)).toBe('0s');
  });

  it('formatDistance rounds to the nearest metre', () => {
    expect(formatDistance(12.4)).toBe('12m');
    expect(formatDistance(12.6)).toBe('13m');
    expect(formatDistance(-1)).toBe('0m');
  });

  it('formatCountdown renders mm:ss with a zero-padded seconds field', () => {
    expect(formatCountdown(14000)).toBe('0:14');
    expect(formatCountdown(65000)).toBe('1:05');
    expect(formatCountdown(0)).toBe('0:00');
  });
});

describe('ammoText', () => {
  it('renders melee (mag -1) as dashes, never "-1"', () => {
    expect(ammoText(-1, -1)).toEqual({ magText: '—', resText: '—', melee: true, emptyReserve: false });
  });

  it('renders normal ammo and flags empty reserve as its own state', () => {
    expect(ammoText(30, 90)).toEqual({ magText: '30', resText: '90', melee: false, emptyReserve: false });
    expect(ammoText(0, 0)).toEqual({ magText: '0', resText: '0', melee: false, emptyReserve: true });
    expect(ammoText(6, 0).emptyReserve).toBe(true);
  });
});

describe('interactPrompt', () => {
  it('is null for "none" — no interactable in range', () => {
    expect(interactPrompt('none', 0)).toBeNull();
  });

  it('quotes verb + cost, never a bare "Press E"', () => {
    expect(interactPrompt('repair', 112)).toEqual({ verb: 'REPAIR', costLabel: '112 SCRAP' });
    expect(interactPrompt('revive', 0)).toEqual({ verb: 'REVIVE', costLabel: null });
    expect(interactPrompt('weaponRack', 0)).toEqual({ verb: 'WEAPON RACK', costLabel: null });
    expect(interactPrompt('ammoCrate', 60)).toEqual({ verb: 'RESUPPLY', costLabel: '60 SCRAP' });
  });
});

describe('canAfford', () => {
  it('is true for a free/zero-cost action regardless of scrap', () => {
    expect(canAfford(0, 0)).toBe(true);
    expect(canAfford(0, -5)).toBe(true);
  });

  it('compares scrap to cost otherwise', () => {
    expect(canAfford(100, 60)).toBe(true);
    expect(canAfford(59, 60)).toBe(false);
    expect(canAfford(60, 60)).toBe(true);
  });
});

describe('tickerColorKey', () => {
  it('gives breach and down the highest-contrast colour', () => {
    expect(tickerColorKey('breach')).toBe('downedRed');
    expect(tickerColorKey('down')).toBe('downedRed');
  });

  it('gives wave/revive/kill their own distinct colours', () => {
    expect(tickerColorKey('wave')).toBe('hudAccent');
    expect(tickerColorKey('revive')).toBe('reviveCyan');
    expect(tickerColorKey('kill')).toBe('hudText');
  });
});

describe('damageSeverity01', () => {
  it('is 0 for non-positive or non-finite damage', () => {
    expect(damageSeverity01(0)).toBe(0);
    expect(damageSeverity01(-5)).toBe(0);
    expect(damageSeverity01(Number.NaN)).toBe(0);
  });

  it('scales relative to a survivor\'s own max HP and clamps at 1', () => {
    const full = SURVIVOR.maxHp * 0.45;
    expect(damageSeverity01(full)).toBeCloseTo(1);
    expect(damageSeverity01(full * 2)).toBe(1);
    expect(damageSeverity01(full / 2)).toBeCloseTo(0.5);
  });
});

describe('arcRotationDeg', () => {
  it('is the identity conversion, straight-ahead at 0', () => {
    expect(arcRotationDeg(0)).toBe(0);
    expect(arcRotationDeg(Math.PI / 2)).toBeCloseTo(90);
  });

  it('degrades non-finite input to 0', () => {
    expect(arcRotationDeg(Number.NaN)).toBe(0);
  });
});

describe('lowHpIntensity01', () => {
  it('is 0 at/above the low-hp threshold and 1 at/below the floor', () => {
    expect(lowHpIntensity01(SURVIVOR.maxHp)).toBe(0);
    expect(lowHpIntensity01(SURVIVOR.maxHp * 0.3)).toBe(0);
    expect(lowHpIntensity01(0)).toBe(1);
  });

  it('ramps linearly between the floor and the threshold', () => {
    const low = SURVIVOR.maxHp * 0.3;
    const floor = SURVIVOR.maxHp * 0.08;
    const mid = (low + floor) / 2;
    expect(lowHpIntensity01(mid)).toBeCloseTo(0.5);
  });

  it('degrades non-finite hp to 0 rather than propagating NaN', () => {
    expect(lowHpIntensity01(Number.NaN)).toBe(0);
  });
});

describe('sortedRunStats', () => {
  it('orders by kills desc, then damage desc as the tiebreak', () => {
    const stats: RunStats[] = [
      { id: 'a', name: 'A', kills: 2, headshots: 0, damage: 400, repairHp: 0, revivesGiven: 0, timesDowned: 0 },
      { id: 'b', name: 'B', kills: 5, headshots: 0, damage: 100, repairHp: 0, revivesGiven: 0, timesDowned: 0 },
      { id: 'c', name: 'C', kills: 2, headshots: 0, damage: 900, repairHp: 0, revivesGiven: 0, timesDowned: 0 },
    ];
    expect(sortedRunStats(stats).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate the input array', () => {
    const stats: RunStats[] = [
      { id: 'a', name: 'A', kills: 1, headshots: 0, damage: 0, repairHp: 0, revivesGiven: 0, timesDowned: 0 },
      { id: 'b', name: 'B', kills: 9, headshots: 0, damage: 0, repairHp: 0, revivesGiven: 0, timesDowned: 0 },
    ];
    const copy = [...stats];
    sortedRunStats(stats);
    expect(stats).toEqual(copy);
  });
});

describe('sortedDowned', () => {
  it('orders nearest-first', () => {
    const downed: HudState['downed'] = [
      { id: 'a', name: 'A', dist: 30, bleedout: 10, beingRevived: false },
      { id: 'b', name: 'B', dist: 5, bleedout: 40, beingRevived: true },
      { id: 'c', name: 'C', dist: 12, bleedout: 20, beingRevived: false },
    ];
    expect(sortedDowned(downed).map((d) => d.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('weaponLabel', () => {
  it('uppercases the weapon id', () => {
    expect(weaponLabel('shotgun')).toBe('SHOTGUN');
  });
});

describe('phaseLabel', () => {
  it('has a label for every Phase', () => {
    expect(phaseLabel('lobby')).toBe('LOBBY');
    expect(phaseLabel('wave')).toBe('WAVE');
    expect(phaseLabel('intermission')).toBe('INTERMISSION');
    expect(phaseLabel('ended')).toBe('RUN ENDED');
  });
});

describe('alpha', () => {
  it('converts a #rrggbb PALETTE hex into an rgba() string carrying the same colour', () => {
    expect(alpha(PALETTE.scrapGold, 0.5)).toBe('rgba(224,183,74,0.5)');
    expect(alpha(PALETTE.reviveCyan, 1)).toBe('rgba(79,209,197,1)');
    expect(alpha(PALETTE.downedRed, 0)).toBe('rgba(224,75,75,0)');
  });
});
