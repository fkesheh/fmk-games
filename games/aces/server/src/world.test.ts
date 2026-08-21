// ============================================================================
// server/src/world.test.ts — S_SIM coverage.
//
// Strategy: the frozen shared physics is already covered by its own suite;
// these tests pin the WORLD's integration law — per-tick ordering, swept
// no-tunnel hits, friendly-fire pass-through, jam/resume, crate economy,
// crash-death crediting, god immunity, and seed determinism. Combat states
// are constructed directly (planes teleported, bullets hand-placed) so each
// scenario tests one rule instead of hoping an emergent furball cooperates.
// Geometry notes inline use fighter radius 16 + BULLET_HIT_R 3 ⇒ hit circle
// r = 19, and dt = 1/30 (TICK_RATE).
// ============================================================================
import { describe, expect, it } from 'vitest';
import { BOOST_MAX, CRATE_LIFE_S, HEAT_MAX, HEAT_RESUME, SPAWN_PROTECT_SECONDS } from '@aces/shared/config';
import { buildMap, isOpenWater } from '@aces/shared/maps';
import type { GameEvent, PlaneState } from '@aces/shared/types';
import type { TeamId } from '@aces/shared/config';
import { World } from './world.js';

function makeWorld(seed = 0xc0ffee): World {
  return new World(buildMap(), { teamSize: 4, difficulty: 'normal', botFill: true, debug: false }, seed);
}

function planeOf(w: World, id: string): PlaneState {
  const p = w.planes.find((q) => q.id === id);
  if (!p) throw new Error(`test setup bug: no plane ${id}`);
  return p;
}

/** Seat + spawn + strip spawn protection — most scenarios want mortal planes. */
function seat(w: World, id: string, name: string, team: TeamId): PlaneState {
  w.addPlayer(id, name, team, false);
  w.spawn(id, 'fighter');
  const p = planeOf(w, id);
  p.invulnT = 0;
  return p;
}

let seqCounter = 0;
function input(o: Partial<{ th: number; tr: number; fire: boolean; boost: boolean }> = {}) {
  seqCounter++;
  return { seq: seqCounter, th: o.th ?? 0, tr: o.tr ?? 0, fire: o.fire ?? false, boost: o.boost ?? false };
}

describe('World determinism', () => {
  it('same seed + same input sequence ⇒ identical planes/bullets/crates and event log', () => {
    const run = (): { snap: string; events: string; shots: number } => {
      const w = makeWorld(4242);
      seat(w, 'r1', 'Royal A', 'royal');
      seat(w, 'i1', 'Iron B', 'iron');
      const evLog: string[] = [];
      // Scripted head-on furball: both full throttle toward each other,
      // weaving and burst-firing — exercises stepPlane, volley jitter draws,
      // swept hits, kills, burn ticks and stats over a real engagement.
      for (let i = 0; i < 480; i++) {
        w.setInput('r1', input({ th: 1, tr: Math.sin(i / 17) * 0.6, fire: i % 9 < 4, boost: i % 41 < 8 }));
        w.setInput('i1', input({ th: 1, tr: Math.cos(i / 23) * 0.6, fire: i % 7 < 3 }));
        evLog.push(JSON.stringify(w.step(1 / 30)));
      }
      return {
        snap: JSON.stringify({ planes: w.planes, bullets: w.bullets, crates: w.crates }),
        events: JSON.stringify(evLog),
        shots: w.stats.get('r1')?.shots ?? -1,
      };
    };
    const a = run();
    const b = run();
    expect(a.snap).toBe(b.snap); // JSON of planes/bullets (+crates) byte-equal
    expect(a.events).toBe(b.events);
    // Sanity: the script must have actually pulled triggers so the jitter
    // stream was exercised — otherwise the equality proves little.
    expect(a.shots).toBeGreaterThan(0);
  });
});

describe('Bullet hit resolution', () => {
  it('a round fired at range kills: exactly one HitEvent(killed) + KillEvent(crash=false), stats update', () => {
    const w = makeWorld();
    const s = seat(w, 'r1', 'Royal', 'royal');
    const v = seat(w, 'i1', 'Iron', 'iron');
    // Stage the duel: shooter at x=1000 facing east, victim 600 u east flying
    // straight at him (closure ≈ 1410 u/s ⇒ contact inside ~13 ticks).
    s.x = 1000; s.y = 1000; s.h = 0; s.vx = 110; s.vy = 0;
    v.x = 1600; v.y = 1000; v.h = Math.PI; v.vx = -110; v.vy = 0;
    v.hp = 3; // any single fighter round is lethal
    // Direct-constructed tracer closing at 1300 u/s along y=1000 — through the
    // victim's exact centerline, so the swept segment cannot miss.
    w.bullets.push({ id: 999, team: 'royal', owner: 'r1', x: 1000, y: 1000, vx: 1300, vy: 0, t: 1.15 });

    const seen: GameEvent[] = [];
    for (let i = 0; i < 30 && !v.dead; i++) seen.push(...w.step(1 / 30));

    expect(v.dead).toBe(true);
    expect(v.hp).toBe(0);
    const hits = seen.filter((e) => e.kind === 'hit');
    expect(hits).toHaveLength(1);
    expect(hits[0]!).toMatchObject({ target: 'i1', by: 'r1', dmg: 5, killed: true }); // fighter gun dmg
    const kills = seen.filter((e) => e.kind === 'kill');
    expect(kills).toHaveLength(1);
    expect(kills[0]!).toMatchObject({
      killer: 'r1',
      killerName: 'Royal',
      victim: 'i1',
      victimName: 'Iron',
      killerTeam: 'royal',
      victimTeam: 'iron',
      crash: false,
      streak: 1,
    });
    // shots only counts volleys actually fired (none here — bullet hand-placed)
    expect(w.stats.get('r1')).toMatchObject({ shots: 0, hits: 1 });
  });

  it('NO-TUNNEL: a head-on sweep whose BOTH endpoints miss the circle still registers exactly ONE hit', () => {
    const w = makeWorld();
    seat(w, 'r1', 'Owner of record', 'royal'); // physically elsewhere; only cls/stats matter
    const v = seat(w, 'i1', 'Target', 'iron');
    v.x = 1000; v.y = 1000; v.h = Math.PI / 2; v.vx = 0; v.vy = 110; v.hp = 50;
    // 1400 u/s = 46.67 u/tick. Circle spans x∈[981,1019]; the tick's segment
    // runs [978 → 1024.67]: both endpoints >19 from center, so a static
    // point-in-circle check would tunnel clean through. The sweep must not.
    w.bullets.push({ id: 1, team: 'royal', owner: 'r1', x: 978, y: 1000, vx: 1400, vy: 0, t: 1 });

    const e1 = [...w.step(1 / 30)]; // snapshot: step() reuses its events buffer
    expect(e1.filter((e) => e.kind === 'hit')).toHaveLength(1);
    expect(v.hp).toBe(45); // exactly one fighter round connected
    // The bullet flies on past the target — second tick connects with nothing.
    const e2 = [...w.step(1 / 30)];
    expect([...e1, ...e2].filter((e) => e.kind === 'hit')).toHaveLength(1);
    expect(v.dead).toBe(false);
  });

  it('friendly fire is off: a royal round sweeping a royal ally connects with nothing', () => {
    const w = makeWorld();
    seat(w, 'r1', 'Shooter', 'royal');
    const ally = seat(w, 'r2', 'Ally', 'royal');
    ally.x = 1000; ally.y = 1000; ally.h = Math.PI / 2; ally.vx = 0; ally.vy = 110; ally.hp = 50;
    // Same crossing geometry as the NO-TUNNEL case — but same-team.
    w.bullets.push({ id: 1, team: 'royal', owner: 'r1', x: 978, y: 1000, vx: 1400, vy: 0, t: 1 });
    const e = w.step(1 / 30);
    expect(e.filter((x) => x.kind === 'hit' || x.kind === 'kill')).toHaveLength(0);
    expect(ally.hp).toBe(50);
  });
});

describe('Heat & jam', () => {
  it('jam swallows every trigger pull until heat cools below HEAT_RESUME, then guns resume', () => {
    const w = makeWorld();
    const p = seat(w, 'i1', 'Gunner', 'iron');
    p.x = 2000; p.y = 2000; p.h = 0; p.vx = 150; p.vy = 0; // quiet corner, straight & level
    w.setInput('i1', input({ th: 0.5, fire: true }));
    p.heat = 0.999; // next twin-gun volley (+0.0076×2) crosses HEAT_MAX THIS volley

    w.step(1 / 30);
    expect(p.jammed).toBe(true);
    expect(p.heat).toBe(HEAT_MAX);
    const afterJamVolley = w.bullets.length;
    expect(afterJamVolley).toBeGreaterThan(0);

    // Release the trigger through the cooldown: the moment the jam lifts,
    // a held trigger would legally fire in the SAME step (jam clears in the
    // flight phase, firing runs after) — we want an unambiguous resume.
    w.setInput('i1', input({ th: 0.5, fire: false }));
    let ticks = 0;
    while (p.jammed && ticks < 90) {
      w.step(1 / 30);
      ticks++;
    }
    expect(ticks).toBeLessThan(90); // ~44 ticks at HEAT_COOL_IDLE 0.45/s
    expect(p.heat).toBeLessThanOrEqual(HEAT_RESUME);
    expect(w.bullets.length).toBeLessThanOrEqual(afterJamVolley); // nothing NEW fired while jammed

    const before = w.bullets.length;
    w.setInput('i1', input({ th: 0.5, fire: true })); // re-arm
    w.step(1 / 30);
    expect(w.bullets.length).toBe(before + 2); // twin guns resume
    expect(w.stats.get('i1')).toMatchObject({ shots: 4 }); // two volleys × two barrels total
  });
});

describe('Crates', () => {
  it('pickup heals (clamped), unjams, refills boost, emits CrateEvent and removes the crate', () => {
    const w = makeWorld();
    const p = seat(w, 'r1', 'Lucky', 'royal');
    p.x = 2000; p.y = 1200; p.h = Math.PI / 2; p.vx = 0; p.vy = 110; // drifts ~3.7 u/tick, well inside pickup r=34
    p.hp = 90; // heal 45 would overshoot maxHp 100 ⇒ clamps
    p.heat = 0.9;
    p.jammed = true;
    p.boost = 4;

    w.forceCrate(2000, 1200); // debug drop right on top of him
    expect(w.crates).toHaveLength(1);
    const crate = w.crates[0]!;
    crate.phase = 'active'; // fast-forward the parachute: pickups need landed crates
    crate.t = CRATE_LIFE_S;

    const e = w.step(1 / 30);
    const pickups = e.filter((x) => x.kind === 'crate' && x.what === 'pickup');
    expect(pickups).toHaveLength(1);
    expect(pickups[0]!).toMatchObject({ kind: 'crate', what: 'pickup', by: 'r1' });
    expect(p.hp).toBe(100); // min(maxHp, hp + CRATE_HEAL)
    expect(p.heat).toBe(0);
    expect(p.jammed).toBe(false);
    expect(p.boost).toBe(BOOST_MAX);
    expect(w.crates).toHaveLength(0); // consumed
  });

  it('forceCrate() without coords always lands on open water, deterministically', () => {
    const run = (): string[] => {
      const w = makeWorld(777);
      const coords: string[] = [];
      for (let i = 0; i < 16; i++) {
        w.forceCrate(); // bypasses CRATES_MAX on purpose — debug authority
        const c = w.crates[w.crates.length - 1]!;
        coords.push(`${c.x.toFixed(6)},${c.y.toFixed(6)}`);
        expect(isOpenWater(w.map, c.x, c.y)).toBe(true);
      }
      return coords;
    };
    expect(run()).toEqual(run()); // seeded stream ⇒ identical placements
  });
});

describe('Deaths', () => {
  it('burn death emits a crash kill whose killer fields are the VICTIM — nobody gets credit', () => {
    const w = makeWorld();
    const v = seat(w, 'i1', 'Wick', 'iron');
    seat(w, 'r1', 'Innocent Bystander', 'royal'); // nearby enemy who must NOT be credited
    v.x = 2000; v.y = 800; v.h = Math.PI; v.vx = 110; v.vy = 0;
    v.hp = 0.05; // < FIRE_BELOW fraction (25 hp) ⇒ burning; BURN_DPS·dt = 0.067 finishes him this tick

    const e = w.step(1 / 30);
    const kills = e.filter((x) => x.kind === 'kill');
    expect(kills).toHaveLength(1);
    expect(kills[0]!).toMatchObject({
      crash: true,
      killer: 'i1', // killer fields carry the victim…
      killerName: 'Wick',
      victim: 'i1',
      killerTeam: 'iron',
      streak: 0, // his own streak resets; rooms move no tickets off crash=true
    });
    expect(e.some((x) => x.kind === 'hit')).toBe(false); // not a bullet death
    expect(v.dead).toBe(true);
  });

  it('god planes take neither burn nor bullet damage; applyGod toggles back off', () => {
    const w = makeWorld();
    const g = seat(w, 'r1', 'Untouchable', 'royal');
    g.x = 2000; g.y = 800; g.vx = 110; g.vy = 0;
    g.hp = 0.05; // would burn to death in one tick if unprotected
    w.applyGod('r1');

    for (let i = 0; i < 10; i++) w.step(1 / 30);
    expect(g.dead).toBe(false);
    expect(g.hp).toBe(0.05); // untouched — burn skipped entirely, no float drift

    // Bullets pass through harmlessly too.
    const shooter = seat(w, 'i1', 'Shooter', 'iron');
    shooter.x = 4000; shooter.y = 800; // far away; only ownership matters
    w.bullets.push({ id: 7, team: 'iron', owner: 'i1', x: 1978, y: 800, vx: 1400, vy: 0, t: 1 });
    const e = w.step(1 / 30);
    expect(e.some((x) => x.kind === 'hit')).toBe(false);
    expect(g.hp).toBe(0.05);

    // Toggle off ⇒ mortality resumes. Clear the still-flying tracer first:
    // the target has drifted downrange (planes never stop), so leaving it
    // would kill him by BULLET this tick instead of by burn.
    w.bullets.length = 0;
    w.applyGod('r1');
    const e2 = [...w.step(1 / 30)]; // snapshot: step() reuses its events buffer
    const crashes = e2.filter((x) => x.kind === 'kill' && x.crash);
    expect(crashes).toHaveLength(1);
    expect(g.dead).toBe(true);
  });
});

describe('Spawning', () => {
  it('spawn seats the plane at its own airfield, heading for map center, with protection', () => {
    const w = makeWorld();
    w.addPlayer('r1', 'Rookie', 'royal', false);
    const p = planeOf(w, 'r1');
    expect(p.dead).toBe(true); // dead until spawn()
    w.spawn('r1', 'gunship');

    const field = w.map.fields[0];
    expect(field.team).toBe('royal');
    expect(p.dead).toBe(false);
    expect(p.cls).toBe('gunship');
    expect(p.x).toBe(field.x);
    expect(p.y).toBe(field.y);
    expect(p.invulnT).toBe(SPAWN_PROTECT_SECONDS);
    expect(p.hp).toBe(170); // gunship spec
    expect(p.boost).toBe(BOOST_MAX);
    // Heading points toward the map center (within a right angle).
    const want = Math.atan2(w.map.h / 2 - field.y, w.map.w / 2 - field.x);
    let dh = Math.abs(p.h - want) % (Math.PI * 2);
    if (dh > Math.PI) dh = Math.PI * 2 - dh;
    expect(dh).toBeLessThan(Math.PI / 2);
  });
});
