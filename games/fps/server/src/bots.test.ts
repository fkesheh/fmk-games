// ============================================================================
// T4 — BotBrain (S4) unit tests. The brain is pure and deterministic, so every
// case here is a closed loop over hand-built percepts: no room, no timers.
//
// The percepts use dustbowl's MapDef for its extents but an EMPTY solid list,
// so line of sight is always clear and the whole walk grid is open — the tests
// are about weapon resolution and trigger discipline, not pathing.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { HEAD_BOX_H, INPUT_FIRE, MAPS, PLAYER, WEAPONS, playerHitboxes } from '@fps/shared';
import type { WeaponId } from '@fps/shared';
import { BotBrain } from './bots.js';
import type { BotCommand, BotPercept } from './bots.js';

const MAP = MAPS.dustbowl;

interface SelfOver {
  weapon?: WeaponId;
  mag?: number;
  reserve?: number;
  reloading?: boolean;
  yaw?: number;
  pitch?: number;
  owned?: WeaponId[];
}

/**
 * One percept: the bot stands at the origin, an enemy stands 10m dead ahead
 * (-z), both at full standing height. `owned` deliberately keeps 'knife' at
 * index 0 — exactly the shape the room hands over — so any test that passes
 * only because the brain read owned[0] would be reading a knife.
 */
function percept(over: SelfOver = {}, opts: { enemy?: boolean; tick?: number } = {}): BotPercept {
  const enemy = opts.enemy ?? true;
  const weapon = over.weapon ?? 'pistol';
  return {
    self: {
      x: 0, y: 0, z: 0,
      yaw: over.yaw ?? 0,
      pitch: over.pitch ?? 0,
      hp: 100,
      mag: over.mag ?? WEAPONS[weapon].mag,
      reserve: over.reserve ?? WEAPONS[weapon].reserve,
      reloading: over.reloading ?? false,
      crouch: false,
      weapon,
    },
    enemies: enemy
      ? [{ id: 'e1', x: 0, y: 0, z: -10, height: PLAYER.heightStand, alive: true }]
      : [],
    solids: [],
    map: MAP,
    tick: opts.tick ?? 0,
    phase: 'live',
    money: 0,
    owned: over.owned ?? ['knife', 'pistol', 'rifle'],
    canBuy: false,
  };
}

/**
 * Drive `n` ticks, feeding the command's yaw/pitch back in as the bot's next
 * orientation — the closed loop the room actually runs. Nothing about the
 * brain's internal aim maths is reproduced here: the bot converges on the
 * target by itself and starts shooting when it decides it is on target.
 */
function run(brain: BotBrain, n: number, over: SelfOver = {}, opts: { enemy?: boolean } = {}): BotCommand[] {
  const out: BotCommand[] = [];
  let yaw = over.yaw ?? 0;
  let pitch = over.pitch ?? 0;
  for (let t = 0; t < n; t++) {
    const cmd = brain.tick(percept({ ...over, yaw, pitch }, { ...opts, tick: t }));
    out.push({ ...cmd });
    yaw = cmd.yaw;
    pitch = cmd.pitch;
  }
  return out;
}

/** Lengths of the consecutive runs of fire ticks in a command sequence. */
function fireRuns(cmds: BotCommand[]): number[] {
  const runs: number[] = [];
  let cur = 0;
  for (const c of cmds) {
    if ((c.buttons & INPUT_FIRE) !== 0) cur++;
    else if (cur > 0) {
      runs.push(cur);
      cur = 0;
    }
  }
  if (cur > 0) runs.push(cur);
  return runs;
}

describe('BotBrain weapon resolution (contract C1 / invariants I1, I2)', () => {
  it('reloads an empty rifle magazine', () => {
    // The bug this guards: the brain used to resolve owned[0], which is always
    // the knife (mag -1), so the reload branch was unreachable and a bot that
    // burned its magazine held fire for the rest of the round.
    const brain = new BotBrain(1234);
    const cmds = run(brain, 20, { weapon: 'rifle', mag: 0, reserve: 90 });
    expect(cmds.some((c) => c.reload)).toBe(true);
  });

  it('never holds fire forever on an empty magazine (I2)', () => {
    const brain = new BotBrain(99);
    const cmds = run(brain, 40, { weapon: 'smg', mag: 0, reserve: 120 });
    // every single tick of a dry gun asks for the reload, not just the first
    expect(cmds.every((c) => c.reload)).toBe(true);
    expect(cmds.every((c) => (c.buttons & INPUT_FIRE) === 0)).toBe(true);
  });

  it('never presses fire and reload in the same tick', () => {
    const brain = new BotBrain(7);
    const cmds = [
      ...run(new BotBrain(7), 60, { weapon: 'rifle' }),
      ...run(brain, 60, { weapon: 'rifle', mag: 0, reserve: 90 }),
    ];
    expect(cmds.some((c) => c.reload && (c.buttons & INPUT_FIRE) !== 0)).toBe(false);
  });

  it('does not ask a knife to reload', () => {
    // mag -1 means melee: there is nothing to reload and the room would ignore
    // it, but a brain that asks is a brain that mis-resolved its weapon.
    const brain = new BotBrain(5);
    const cmds = run(brain, 40, { weapon: 'knife', mag: -1, reserve: -1 });
    expect(cmds.some((c) => c.reload)).toBe(false);
  });

  it('resolves the HELD weapon, not owned[0] (I1)', () => {
    // Identical `owned` in both runs — only self.weapon differs. A brain that
    // read owned[0] would produce the same trigger pattern twice.
    const auto = fireRuns(run(new BotBrain(4242), 120, { weapon: 'rifle' }));
    const semi = fireRuns(run(new BotBrain(4242), 120, { weapon: 'pistol' }));
    expect(auto.length).toBeGreaterThan(0);
    expect(semi.length).toBeGreaterThan(0);
    expect(Math.max(...auto)).toBeGreaterThan(1);
    expect(Math.max(...semi)).toBe(1);
  });
});

describe('BotBrain weapon equip (switchTo)', () => {
  // The defect this guards: a bot bought a primary successfully and then never
  // held it. `handleBuy` re-equips only when the HELD weapon leaves the owned
  // list, so a pistol-holder who bought a rifle kept the pistol; and BotCommand
  // had no switch field at all, so the bot had no mechanism to change weapons
  // ever. Measured: 23 successful rifle/SMG buys, every observed held weapon
  // 'pistol'.
  it('asks to equip the rifle it owns but is not holding', () => {
    const brain = new BotBrain(1);
    const cmd = brain.tick(percept({ weapon: 'pistol', owned: ['knife', 'pistol', 'rifle'] }));
    expect(cmd.switchTo).toBe('rifle');
  });

  it('asks to equip the smg when that is the best it owns', () => {
    const brain = new BotBrain(1);
    const cmd = brain.tick(percept({ weapon: 'pistol', owned: ['knife', 'pistol', 'smg'] }));
    expect(cmd.switchTo).toBe('smg');
  });

  it('prefers the rifle over the smg when it owns both', () => {
    const brain = new BotBrain(1);
    const cmd = brain.tick(percept({ weapon: 'smg', owned: ['knife', 'pistol', 'smg', 'rifle'] }));
    expect(cmd.switchTo).toBe('rifle');
  });

  it('stays silent once it already holds its best weapon', () => {
    // null, not the weapon itself: handleSwitch would no-op anyway, but a
    // command that re-asks every tick would reset bloom on the server.
    const brain = new BotBrain(1);
    const cmd = brain.tick(percept({ weapon: 'rifle', owned: ['knife', 'pistol', 'rifle'] }));
    expect(cmd.switchTo).toBeNull();
  });

  it('never asks for a weapon it does not own', () => {
    // Ownership is the room's business, but a brain that asks for an unowned
    // gun is a brain that would drift out of sync the moment handleSwitch
    // silently refused it.
    const brain = new BotBrain(1);
    for (let t = 0; t < 60; t++) {
      const cmd = brain.tick(percept({ weapon: 'pistol', owned: ['knife', 'pistol'] }, { tick: t }));
      expect(cmd.switchTo === null || ['knife', 'pistol'].includes(cmd.switchTo)).toBe(true);
    }
  });

  it('falls back to the pistol rather than the knife', () => {
    const brain = new BotBrain(1);
    const cmd = brain.tick(percept({ weapon: 'knife', owned: ['knife', 'pistol'] }));
    expect(cmd.switchTo).toBe('pistol');
  });

  it('keeps asking every tick until the room actually equips it', () => {
    // The switch trails the buy by a tick and the room may refuse it (dead,
    // mid-removal). A one-shot request would leave the bot holding the pistol
    // for the rest of the round, which is the original defect in miniature.
    const brain = new BotBrain(1);
    for (let t = 0; t < 30; t++) {
      const cmd = brain.tick(percept({ weapon: 'pistol', owned: ['knife', 'pistol', 'rifle'] }, { tick: t }));
      expect(cmd.switchTo).toBe('rifle');
    }
  });
});

describe('BotBrain trigger discipline', () => {
  it('an auto weapon drives the burst path, not the semi path', () => {
    const cmds = run(new BotBrain(2026), 240, { weapon: 'rifle' });
    const runs = fireRuns(cmds);
    expect(runs.length).toBeGreaterThan(1); // more than one burst in 8 seconds
    // the semi path can never produce two adjacent fire ticks (it always sets a
    // cooldown of >= 1 tick after pressing), so a run of 2+ is proof of burst
    expect(Math.max(...runs)).toBeGreaterThan(1);
    // Full bursts stay inside the designed 3-5 SHOT window (the final run may
    // be clipped by the end of the sample, so it is excluded). The knob is in
    // shots, so the tick window is shots x the weapon's ticks-per-shot: a rifle
    // at interval 0.1s costs 3 ticks a shot, hence 9-15 held ticks.
    const ticksPerShot = Math.ceil(WEAPONS.rifle.interval * 30);
    expect(ticksPerShot).toBe(3);
    for (const r of runs.slice(0, -1)) {
      expect(r).toBeGreaterThanOrEqual(3 * ticksPerShot);
      expect(r).toBeLessThanOrEqual(5 * ticksPerShot);
    }
  });

  it('measures the burst in shots, so an auto burst is never 1-2 bullets', () => {
    // The defect this guards: the burst knob used to count HELD TICKS. 4-8
    // ticks is 4-8 pistol shots but only 1-2 rifle shots (3 ticks per shot),
    // so the moment bots could hold a rifle the "burst" was a double-tap and
    // an armed bot was no deadlier than an unarmed one.
    const runs = fireRuns(run(new BotBrain(555), 300, { weapon: 'rifle' }));
    expect(runs.length).toBeGreaterThan(1);
    const ticksPerShot = Math.ceil(WEAPONS.rifle.interval * 30);
    for (const r of runs.slice(0, -1)) {
      expect(Math.floor(r / ticksPerShot)).toBeGreaterThanOrEqual(3);
    }
  });

  it('a semi weapon fires single ticks spaced by the cooldown', () => {
    const cmds = run(new BotBrain(2026), 240, { weapon: 'pistol' });
    const fireTicks: number[] = [];
    cmds.forEach((c, i) => {
      if ((c.buttons & INPUT_FIRE) !== 0) fireTicks.push(i);
    });
    expect(fireTicks.length).toBeGreaterThan(3);
    expect(Math.max(...fireRuns(cmds))).toBe(1); // never two ticks in a row
    for (let i = 1; i < fireTicks.length; i++) {
      const gap = (fireTicks[i] ?? 0) - (fireTicks[i - 1] ?? 0);
      expect(gap).toBeGreaterThanOrEqual(6);
      expect(gap).toBeLessThanOrEqual(10);
    }
  });

  it('holds fire until the reaction delay has elapsed', () => {
    // REACTION_TICKS = 7 (233ms at 30Hz): nothing may be fired inside the first
    // 7 ticks of contact. This is the floor that keeps bots from being
    // superhuman — a reaction under ~200ms (6 ticks) is not a human reaction,
    // so if this number is ever lowered again, it is a fairness decision (I4)
    // and not a tuning tweak.
    const cmds = run(new BotBrain(31), 12, { weapon: 'rifle' });
    expect(cmds.slice(0, 7).every((c) => (c.buttons & INPUT_FIRE) === 0)).toBe(true);
    expect(cmds.some((c) => (c.buttons & INPUT_FIRE) !== 0)).toBe(true); // and it does eventually fire
  });
});

describe('BotBrain aim point', () => {
  it('aims below the head box, so headshots are incidental rather than hunted', () => {
    // The head box is the top HEAD_BOX_H of the body. The bot's steady-state
    // pitch must point under it — at the target's upper chest.
    const brain = new BotBrain(11);
    const cmds = run(brain, 60, { weapon: 'rifle' });
    const last = cmds[cmds.length - 1];
    if (last === undefined) throw new Error('no commands');
    const eyeY = PLAYER.heightStand - PLAYER.eyeOffset; // bot stands at y = 0
    const aimY = eyeY + Math.tan(last.pitch) * 10; // enemy is 10m away
    const headBase = PLAYER.heightStand - HEAD_BOX_H;
    expect(aimY).toBeLessThan(headBase);
    expect(aimY).toBeGreaterThan(headBase - 0.35); // still the upper chest, not the belt
  });

  it('the head box the bot aims under is the one the hitscan actually tests', () => {
    // Silent-drift guard. bots.ts used to hard-code 0.3 for the head height
    // while the real number lived un-exported inside playerHitboxes; the two
    // could diverge with nothing to catch it. bots.ts now consumes the exported
    // constant, and this pins the constant to the hitbox it describes.
    const hb = playerHitboxes(0, 0, 0, PLAYER.heightStand);
    expect(hb.head.maxY - hb.head.minY).toBeCloseTo(HEAD_BOX_H, 12);
    expect(hb.body.maxY).toBeCloseTo(PLAYER.heightStand - HEAD_BOX_H, 12); // body ends where the head starts
    expect(HEAD_BOX_H).toBe(0.3); // the value bots.ts hard-coded before the export
  });
});

describe('BotBrain determinism (I3)', () => {
  it('same seed + same percept sequence produces identical commands', () => {
    // The sequence deliberately mixes patrol (no enemy: repath consumes the rng
    // stream) with engagement (target acquisition reseeds the burst counter),
    // so both rng consumers are exercised.
    const script = (brain: BotBrain): BotCommand[] => {
      const out: BotCommand[] = [];
      let yaw = 0;
      let pitch = 0;
      for (let t = 0; t < 300; t++) {
        const enemy = t % 100 >= 50; // 50 ticks patrolling, 50 ticks engaging
        const cmd = brain.tick(percept({ weapon: 'rifle', yaw, pitch }, { enemy, tick: t }));
        out.push({ ...cmd });
        yaw = cmd.yaw;
        pitch = cmd.pitch;
      }
      return out;
    };
    const a = script(new BotBrain(0xc0ffee));
    const b = script(new BotBrain(0xc0ffee));
    expect(a).toEqual(b);
    // and a different seed must actually diverge, or the test above is vacuous
    const c = script(new BotBrain(0xbadf00d));
    expect(c).not.toEqual(a);
  });

  it('tick returns a fresh command object and never retains the percept', () => {
    const brain = new BotBrain(3);
    const p = percept({ weapon: 'rifle' });
    const first = brain.tick(p);
    const second = brain.tick(p);
    expect(first).not.toBe(second);
  });
});
