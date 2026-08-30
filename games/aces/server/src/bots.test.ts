// ============================================================================
// server/src/bots.test.ts — S_BOTS coverage.
//
// Strategy: every scenario constructs its own duel geometry by hand (planes
// teleported onto the shared map, velocities set directly) so each test pins
// ONE behavior law instead of hoping an emergent furball cooperates — same
// discipline as world.test.ts. Steering purity uses a difficulty spec with
// turnJitter 0, which zeroes the weave personality term and leaves raw
// geometric steering; determinism tests use the real table to prove the full
// pipeline (weave + rng blips + reaction clocks) replays byte-identically.
//
// Geometry notes inline use fighter gun muzzle velocity 800 u/s (CLASSES),
// RIM_MARGIN_U 260 on the 4200×3000 strait, and dt = 1/30 (TICK_RATE).
// ============================================================================
import { describe, expect, it } from 'vitest';
import { BOOST_MAX, BOT_AI, BOT_DIFFICULTY, CLASSES } from '@aces/shared/config';
import type { BotDifficultySpec, TeamId } from '@aces/shared/config';
import { buildMap, mulberry32 } from '@aces/shared/maps';
import { stepPlane } from '@aces/shared/physics';
import type { InputFrame, PlaneState } from '@aces/shared/types';
import { computeIntent } from './bots.js';
import type { BotMem, BotView } from './bots.js';

const MAP = buildMap();
const DT = 1 / 30;

/** turnJitter 0 ⇒ zero weave offset: intent.tr becomes pure P-control on the
 *  heading error, so sign/magnitude assertions read straight off the geometry. */
const STEADY: BotDifficultySpec = { ...BOT_DIFFICULTY.normal, turnJitter: 0 };

function mkPlane(id: string, team: TeamId, over: Partial<PlaneState> = {}): PlaneState {
  return {
    id,
    name: id,
    team,
    cls: 'fighter',
    bot: true,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    h: 0,
    hp: CLASSES.fighter.hp,
    heat: 0,
    jammed: false,
    boost: BOOST_MAX,
    boosting: false,
    throttle: 1,
    invulnT: 0,
    fireCd: 0,
    dead: false,
    respawnT: 0,
    streak: 0,
    ...over,
  };
}

function viewOf(self: PlaneState, others: readonly PlaneState[]): BotView {
  return { self, others, bullets: [], map: MAP };
}

/** Mem pre-seeded as if the named target were already acquired and reacted —
 *  most scenarios want steering NOW, not after the acquisition clock. */
const memOn = (targetId: string | null): BotMem => ({ targetId, reactT: 0, weavePhase: 0 });

describe('Lead pursuit', () => {
  it('leads a crossing target: turns toward the INTERCEPT point, not the chase position', () => {
    // Shooter mid-map facing east; bandit crossing left-to-right (vy>0) ahead.
    // Fighter rounds fly 800 u/s; the intercept math puts the solution BELOW
    // the boresight (positive y-down bearing ≈ +7.8°) even though the bandit's
    // CURRENT position sits ABOVE it (≈ −14°). A chase-position servo slams
    // the stick negative; a lead pilot eases positive. That sign flip IS the
    // test: same shooter, same position, only the target's velocity differs.
    const crossing = mkPlane('t', 'iron', { x: 1400, y: 900, vy: 300 });
    const shooterA = mkPlane('me', 'royal', { x: 1000, y: 1000, h: 0, vx: 150 });
    const lead = computeIntent(viewOf(shooterA, [crossing]), STEADY, mulberry32(1), memOn('t'), DT);

    const parked = mkPlane('t', 'iron', { x: 1400, y: 900 }); // identical, velocity stripped
    const shooterB = mkPlane('me', 'royal', { x: 1000, y: 1000, h: 0, vx: 150 });
    const chase = computeIntent(viewOf(shooterB, [parked]), STEADY, mulberry32(1), memOn('t'), DT);

    // Toward the solution (unsaturated: proportional, precise), AWAY from the
    // chase point — a bot aiming where the target IS would fail this.
    expect(lead.tr).toBeGreaterThan(0.05);
    expect(Math.abs(lead.tr)).toBeLessThan(1);
    expect(chase.tr).toBeLessThan(0);
  });
});

describe('Trigger discipline', () => {
  // Snapshot solution: bandit dead ahead 400 u out (inside fireRangeU 520),
  // stationary, so the intercept sits on the nose — cone error exactly 0.
  function duelState(): { self: PlaneState; foe: PlaneState; view: BotView } {
    const self = mkPlane('me', 'royal', { x: 2100, y: 1500, h: 0, vx: 110 });
    const foe = mkPlane('t', 'iron', { x: 2500, y: 1500 });
    return { self, foe, view: viewOf(self, [foe]) };
  }

  it('releases above RELEASE_HEAT and holds below/at it (boundary inclusive)', () => {
    const { self, view } = duelState();
    self.heat = BOT_AI.RELEASE_HEAT + 0.01;
    expect(computeIntent(view, STEADY, mulberry32(1), memOn('t'), DT).fire).toBe(false);

    self.heat = BOT_AI.RELEASE_HEAT; // ≤ releases: bots stop BEFORE the jam…
    expect(computeIntent(view, STEADY, mulberry32(1), memOn('t'), DT).fire).toBe(true);

    self.heat = 0.74;
    expect(computeIntent(view, STEADY, mulberry32(1), memOn('t'), DT).fire).toBe(true);
  });

  it('never fires while spawn-protected or jammed, though the solution is perfect', () => {
    const { self, view } = duelState();
    self.invulnT = 2;
    expect(computeIntent(view, STEADY, mulberry32(1), memOn('t'), DT).fire).toBe(false);

    self.invulnT = 0;
    self.jammed = true;
    expect(computeIntent(view, STEADY, mulberry32(1), memOn('t'), DT).fire).toBe(false);

    self.jammed = false; // sanity: the geometry itself is a firing solution
    expect(computeIntent(view, STEADY, mulberry32(1), memOn('t'), DT).fire).toBe(true);
  });
});

describe('Rim avoidance', () => {
  it('near the map edge steering flips hard toward center vs the pursuit-only control', () => {
    // Bandit hangs south-west of the nose; facing west, pursuit wants a hard
    // negative (clockwise-up) correction. Hug the west rim inside
    // RIM_MARGIN_U 260 and the wheel must instead slam POSITIVE — the shortest
    // arc back toward the strait's center (due east from the south shore).
    const foeRelX = -300;
    const foeRelY = 250;
    const mem = memOn('t');

    const free = mkPlane('me', 'royal', { x: 800, y: 1500, h: Math.PI, vx: -110 });
    const freeFoe = mkPlane('t', 'iron', { x: 800 + foeRelX, y: 1500 + foeRelY });
    const pursuitOnly = computeIntent(viewOf(free, [freeFoe]), STEADY, mulberry32(1), mem, DT);
    expect(pursuitOnly.tr).toBe(-1); // saturated toward the bandit

    const rimmed = mkPlane('me', 'royal', { x: 120, y: 1500, h: Math.PI, vx: -110 });
    const rimFoe = mkPlane('t', 'iron', { x: 120 + foeRelX, y: 1500 + foeRelY });
    const rim = computeIntent(viewOf(rimmed, [rimFoe]), STEADY, mulberry32(1), memOn('t'), DT);
    expect(rim.tr).toBe(1); // saturated toward map center — strict sign flip

    expect(rim.th).toBe(1); // escaping the band outranks throttle games
  });
});

describe('Evade', () => {
  it('below EVADE_HP_FRACTION: hard perpendicular break, throttle cut, pulsing boost, cold guns', () => {
    // Wounded (0.30 hp fraction < 0.35) with the threat north-east: the break
    // must pick the perpendicular AWAY variant nearer the nose (south-east,
    // bearing +45°) → tr slams POSITIVE, while healthy pursuit of the same
    // bandit slams NEGATIVE. The flip proves the defensive turn took over.
    const wounded = mkPlane('me', 'royal', { x: 2100, y: 1500, h: 0, vx: 110, hp: 30 });
    const threat = mkPlane('t', 'iron', { x: 2400, y: 1200 });

    const breaking = computeIntent(
      viewOf(wounded, [threat]),
      STEADY,
      mulberry32(1),
      { targetId: 't', reactT: 0, weavePhase: Math.PI / 2 }, // sine up → pulse ON
      DT,
    );
    expect(breaking.tr).toBe(1); // perpendicular away, saturating the stick
    expect(breaking.th).toBe(BOT_AI.EVADE_THROTTLE); // tighten the circle
    expect(breaking.boost).toBe(true); // fuel 100 > 40, sine positive
    expect(breaking.fire).toBe(false); // breaks stay cold: no trigger chatter

    // Same geometry, half-cycle later: the pulse gate shuts (fuel economy —
    // §Balance punishes dumping the whole boost pool in one breath).
    wounded.hp = 30;
    const coasting = computeIntent(
      viewOf(wounded, [threat]),
      STEADY,
      mulberry32(1),
      { targetId: 't', reactT: 0, weavePhase: -Math.PI / 2 }, // sine down
      DT,
    );
    expect(coasting.boost).toBe(false);

    // Control: full-health plane in the SAME spot flies straight at him.
    const healthy = mkPlane('me', 'royal', { x: 2100, y: 1500, h: 0, vx: 110 });
    const chasing = computeIntent(
      viewOf(healthy, [threat]),
      STEADY,
      mulberry32(1),
      memOn('t'),
      DT,
    );
    expect(chasing.tr).toBe(-1); // pursuit, opposite stick from the break
    expect(chasing.th).toBe(1);
  });
});

describe('Reaction memory', () => {
  it('first contact costs the reaction clock before tracking begins', () => {
    // Fresh brain spots a perfect broadside solution dead ahead — and must
    // STILL fly hands-off until the acquisition clock is paid.
    const self = mkPlane('me', 'royal', { x: 2100, y: 1500, h: 0, vx: 110 });
    const foe = mkPlane('t', 'iron', { x: 2500, y: 1500 });
    const mem: BotMem = { targetId: null, reactT: 0, weavePhase: 0 };

    const first = computeIntent(viewOf(self, [foe]), STEADY, mulberry32(1), mem, DT);
    expect(mem.targetId).toBe(null); // nothing committed yet
    expect(mem.reactT).toBeGreaterThan(0); // clock armed
    expect(first.fire).toBe(false); // no snap-shooting the new contact

    const paid = computeIntent(viewOf(self, [foe]), STEADY, mulberry32(1), mem, 0.5);
    expect(paid.fire).toBe(true); // clock paid → mark committed, guns live
    expect(mem.targetId).toBe('t');
  });

  it('a closer new bandit costs reactionMs of HELD steering before the mark swaps', () => {
    // Committed to 'a' astern (bearing π, in-band); 'b' appears closer off the
    // bow. Every intent during the window keeps flying 'a's solution — stick
    // pinned positive toward the OLD mark — then snaps to 'b' the tick the
    // clock expires (tr 0 + trigger live on the now-perfect snapshot).
    // Window length asserted as a RANGE, not an exact tick: reactionMs
    // quantizes onto whole 1/30 s steps (plus the arm tick), which is exactly
    // the slop a real 30 Hz pilot has anyway.
    const self = mkPlane('me', 'royal', { x: 2100, y: 1500, h: 0, vx: 110 });
    const oldMark = mkPlane('a', 'iron', { x: 1900, y: 1500 }); // astern, 200 u
    const newMark = mkPlane('b', 'iron', { x: 2200, y: 1500 }); // ahead, 100 u
    const view = viewOf(self, [newMark, oldMark]);
    const mem = memOn('a');

    let swapAt = -1;
    let swapped: InputFrame | null = null;
    const held: InputFrame[] = [];
    for (let i = 0; i < 60 && swapAt < 0; i++) {
      const f = computeIntent(view, STEADY, mulberry32(1), mem, DT);
      if (mem.targetId === 'b') {
        swapAt = i;
        swapped = f;
        break;
      }
      held.push(f);
    }
    if (swapAt < 0 || swapped === null) throw new Error('acquisition never completed');

    expect(held.length).toBe(swapAt);
    expect(swapAt).toBeGreaterThanOrEqual(9); // the wait is real (~reactionMs)
    expect(swapAt).toBeLessThan(18); // …and bounded (~reactionMs, quantized)
    for (const f of held) {
      expect(f.tr).toBe(1); // course HELD on the old mark's solution
      expect(f.fire).toBe(false); // his cone faces astern: cold
    }
    expect(mem.targetId).toBe('b'); // committed exactly on payment
    expect(Math.abs(swapped.tr)).toBeLessThan(1e-9); // now dead on 'b'
    expect(swapped.fire).toBe(true);
  });

  it('empty sky clears the mark and cruises full-throttle, straight', () => {
    const self = mkPlane('me', 'royal', { x: 2100, y: 1500, h: 0, vx: 110 });
    const mem = memOn('gone');
    const f = computeIntent(viewOf(self, []), STEADY, mulberry32(1), mem, DT);
    expect(mem.targetId).toBe(null);
    expect(f.tr).toBe(0);
    expect(f.th).toBe(1);
    expect(f.fire).toBe(false);
    expect(f.boost).toBe(false);
  });
});

describe('Determinism', () => {
  it('double-call equality: fresh identical mem + rng seeds give the identical frame', () => {
    const build = (): { view: BotView; mem: BotMem } => ({
      view: viewOf(
        mkPlane('me', 'royal', { x: 1000, y: 1200, h: 0.3, vx: 150, vy: 20 }),
        [mkPlane('t', 'iron', { x: 1350, y: 1050, vx: -40, vy: 220 })],
      ),
      mem: { targetId: null, reactT: 0, weavePhase: 0.7 },
    });
    const a = build();
    const b = build();
    const fa = computeIntent(a.view, BOT_DIFFICULTY.hard, mulberry32(0xace5), a.mem, DT);
    const fb = computeIntent(b.view, BOT_DIFFICULTY.hard, mulberry32(0xace5), b.mem, DT);
    expect(fa).toEqual(fb);
    expect(a.mem).toEqual(b.mem); // mem advanced identically too
  });

  it('full scripted engagement replays byte-identical intents and end state', () => {
    // Closed 10-second loop: head-on merge against a scripted weaving bandit,
    // real difficulty table (jitter/reaction/blips live), planes integrated
    // with the frozen stepPlane so pursuit, fire windows, heat release, and
    // rim excursions all actually occur along the way.
    const run = (): { frames: string[]; end: string } => {
      const me = mkPlane('me', 'royal', { x: 320, y: 1500, h: 0, vx: 110 });
      const foe = mkPlane('foe', 'iron', { x: 3800, y: 1500, h: Math.PI, vx: -110 });
      const view = viewOf(me, [foe]);
      const mem: BotMem = { targetId: null, reactT: 0, weavePhase: 0 };
      const rng = mulberry32(19170401);
      const frames: string[] = [];
      for (let i = 0; i < 300; i++) {
        const f = computeIntent(view, BOT_DIFFICULTY.normal, rng, mem, DT);
        frames.push(JSON.stringify(f));
        stepPlane(me, f, DT);
        stepPlane(foe, { seq: i, th: 1, tr: Math.sin(i * 0.11) * 0.7, fire: false, boost: false }, DT);
      }
      return { frames, end: JSON.stringify({ me, foe }) };
    };
    const a = run();
    const b = run();
    expect(a.frames).toEqual(b.frames);
    expect(a.end).toBe(b.end);
    // Sanity: the engagement must have developed — varied intents mean turns,
    // trigger states and boost actually changed; otherwise equality is cheap.
    expect(new Set(a.frames).size).toBeGreaterThan(3);
  });
});
