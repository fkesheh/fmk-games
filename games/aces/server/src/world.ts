// ============================================================================
// server/src/world.ts — S_SIM: the authoritative ACES combat simulation.
//
// Integrates planes/bullets via the FROZEN shared physics, resolves swept
// bullet hits, applies burn deaths, and owns supply crates end-to-end (fall
// timers, pickups, expiry, the interval spawner). Emits GameEvents in the
// contract's canonical per-tick order:
//
//   inputs → stepPlane · firing/fireVolley (+spread jitter) · stepBullets ·
//   swept hit resolution (first-intersect-wins) · burn ticks · crates ·
//   crate spawner · tick++
//
// Determinism law: identical constructor seed + identical input sequence ⇒
// byte-identical state. All gameplay randomness flows through ONE mulberry32
// stream (constructor seed); draws happen in a fixed order (planes in array
// order, muzzles per volley). Maps/Sets are only probed by key, never
// iterated, so insertion order can never leak into the sim.
//
// NOTE on the §4 sketch: the contract prose shows `step(dt, intents)`; the
// sealed surface this module implements (per the orchestrator brief S_ROOM
// codes against blind) keeps per-player LATEST input via setInput(id, frame)
// and steps with `step(dt)`. Latest-wins; stale-seq filtering is the caller's
// job. Events come back as the return value instead of a sink callback.
// ============================================================================

import {
  BOOST_MAX,
  BURN_DPS,
  CLASSES,
  CRATES_MAX,
  CRATE_FALL_S,
  CRATE_HEAL,
  CRATE_INTERVAL_S,
  CRATE_LIFE_S,
  CRATE_PICKUP_R,
  FIRE_BELOW,
  SPAWN_PROTECT_SECONDS,
} from '@aces/shared/config';
import type { PlaneClassId, RoomSettings, TeamId } from '@aces/shared/config'; // ids live in config; types.ts imports but does not re-export them
import { isOpenWater, mulberry32 } from '@aces/shared/maps';
import type { AcesMap } from '@aces/shared/maps';
import { bulletHits, fireVolley, stepBullets, stepPlane } from '@aces/shared/physics';
import type { BulletState, CrateState, GameEvent, InputFrame, PlaneState } from '@aces/shared/types';

export interface WorldStats {
  shots: number;
  hits: number;
}

/** Input applied when a plane has sent nothing yet — hands off, cruise throttle. */
const NEUTRAL_INPUT: InputFrame = { seq: 0, th: 0, tr: 0, fire: false, boost: false };

const DEG2RAD = Math.PI / 180;

export class World {
  readonly map: AcesMap;
  readonly settings: Required<RoomSettings>;
  planes: PlaneState[] = [];
  bullets: BulletState[] = [];
  crates: CrateState[] = [];
  tick = 0;
  /** Debug no-damage flags (room `god` verb). Planes here take no bullet/burn damage. */
  godIds = new Set<string>();
  /** Per-plane shot/hit tallies for the scoreboard accuracy readout. */
  stats = new Map<string, WorldStats>();

  private readonly stream: () => number;
  /** Latest InputFrame per seated player — overwritten every send (latest wins). */
  private readonly inputs = new Map<string, InputFrame>();
  private nextBulletId = 1;
  private nextCrateId = 1;
  private crateTimer = 0;
  /**
   * Event buffer handed back by step(). Reused every tick (RULES 4): the room
   * flushes events immediately after each step, so returning the SAME array —
   * cleared at the top of step — is allocation-free and safe. Debug verbs that
   * fire between ticks (forceCrate) push into this buffer and flush on the
   * next step, costing at most one tick of latency.
   */
  private readonly events: GameEvent[] = [];
  /** Inter-step emissions (debug verbs); flushed at the head of the next step. */
  private readonly parkedEvents: GameEvent[] = [];
  private inStep = false;
  /**
   * Swept-hit scratch buffers (RULES 4: zero per-tick allocation). Before
   * stepBullets moves each bullet we snapshot its position; stepBullets splices
   * expired rounds out mid-array, so expiredFlags records which capture slots
   * die this tick and a cursor walks survivors back to their snapshots.
   */
  private readonly prevXs: number[] = [];
  private readonly prevYs: number[] = [];
  private readonly expiredFlags: boolean[] = [];

  constructor(map: AcesMap, settings: Required<RoomSettings>, seed: number) {
    this.map = map;
    this.settings = settings;
    this.stream = mulberry32(seed);
  }

  /** The world's seeded randomness stream (spread jitter, crate placement). */
  rng(): number {
    return this.stream();
  }

  /**
   * Seat a player. The plane starts DEAD at its team airfield — spawn() makes
   * it live. Re-seating an existing id returns the existing plane (idempotent),
   * and its stat tally survives leave/rejoin on purpose: the scoreboard may
   * outlive a socket.
   */
  addPlayer(id: string, name: string, team: TeamId, bot: boolean): PlaneState {
    const existing = this.planeById(id);
    if (existing) return existing;
    const field = team === 'royal' ? this.map.fields[0] : this.map.fields[1];
    const p: PlaneState = {
      id,
      name,
      team,
      cls: 'fighter',
      bot,
      x: field.x,
      y: field.y,
      vx: 0,
      vy: 0,
      h: Math.atan2(this.map.h / 2 - field.y, this.map.w / 2 - field.x),
      hp: CLASSES.fighter.hp,
      heat: 0,
      jammed: false,
      boost: BOOST_MAX,
      boosting: false,
      throttle: 0,
      invulnT: 0,
      fireCd: 0,
      dead: true,
      respawnT: 0,
      streak: 0,
    };
    this.planes.push(p);
    if (!this.stats.has(id)) this.stats.set(id, { shots: 0, hits: 0 });
    return p;
  }

  /**
   * Remove seat + pending input + god flag. Stats stay (see addPlayer).
   * In-flight bullets keep the departed id as `owner`; hit resolution treats
   * them as inert rather than crediting a ghost.
   */
  removePlayer(id: string): void {
    const i = this.planes.findIndex((p) => p.id === id);
    if (i >= 0) this.planes.splice(i, 1);
    this.inputs.delete(id);
    this.godIds.delete(id);
  }

  /** Store the player's latest control frame. Caller drops stale seqs. */
  setInput(id: string, frame: InputFrame): void {
    if (!this.planeById(id)) return; // unknown seat — ignore silently, like parseC2S garbage
    this.inputs.set(id, frame);
  }

  /**
   * Make a plane live: own airfield, headed at map center, rolling at min
   * speed (the no-stall law means spawns are already flying, not accelerating
   * from a standstill), full HP/fuel, SPAWN_PROTECT_SECONDS of protection.
   * streak is intentionally untouched — only dying resets it, and spawn()
   * only ever follows a death or a fresh seat (both already 0).
   */
  spawn(id: string, cls: PlaneClassId): void {
    const p = this.planeById(id);
    if (!p) return;
    const field = p.team === 'royal' ? this.map.fields[0] : this.map.fields[1];
    const spec = CLASSES[cls];
    p.cls = cls;
    p.x = field.x;
    p.y = field.y;
    p.h = Math.atan2(this.map.h / 2 - field.y, this.map.w / 2 - field.x);
    p.vx = Math.cos(p.h) * spec.speedMin;
    p.vy = Math.sin(p.h) * spec.speedMin;
    p.hp = spec.hp;
    p.heat = 0;
    p.jammed = false;
    p.boost = BOOST_MAX;
    p.boosting = false;
    p.throttle = 0;
    p.invulnT = SPAWN_PROTECT_SECONDS;
    p.fireCd = 0;
    p.dead = false;
    p.respawnT = 0; // the ROOM owns the respawn queue; sim just clears the marker
  }

  /** Toggle the debug no-damage flag (room `god` verb toggles per §S_ROOM). */
  applyGod(id: string): void {
    if (this.godIds.has(id)) this.godIds.delete(id);
    else this.godIds.add(id);
  }

  /** Debug teleport. Momentum is kept — warping doesn't stop an aircraft. */
  applyWarp(id: string, x: number, y: number): void {
    const p = this.planeById(id);
    if (!p) return;
    p.x = x;
    p.y = y;
  }

  /**
   * Debug verb: drop a supply crate NOW (bypasses CRATES_MAX — the room's
   * debug surface is authoritative). With coordinates, trust them; without,
   * rejection-sample open water on the seeded stream.
   */
  forceCrate(x?: number, y?: number): void {
    if (x !== undefined && y !== undefined) {
      this.placeCrate(x, y);
      return;
    }
    const spot = this.randomOpenWater();
    this.placeCrate(spot.x, spot.y);
  }

  /**
   * Advance one fixed tick; returns this tick's events in emit order. The
   * returned array is reused — consume it before the next step(). Events
   * emitted between steps (debug verbs) are parked and flushed here first.
   */
  step(dt: number): GameEvent[] {
    const ev = this.events;
    ev.length = 0;
    this.inStep = true;
    // Flush events emitted between ticks (debug verbs land here).
    if (this.parkedEvents.length > 0) {
      for (const e of this.parkedEvents) ev.push(e);
      this.parkedEvents.length = 0;
    }

    // -- 1. flight: every plane integrates its latest stored input ------------
    for (const p of this.planes) {
      stepPlane(p, this.inputs.get(p.id) ?? NEUTRAL_INPUT, dt);
    }

    // -- 2. firing: volley gating lives in shared fireVolley ------------------
    for (const p of this.planes) {
      if (p.dead) continue;
      const input = this.inputs.get(p.id);
      if (!input || !input.fire) continue;
      const fired = fireVolley(p, () => this.nextBulletId++);
      if (fired.length === 0) continue;
      const st = this.stats.get(p.id);
      const spreadRad = CLASSES[p.cls].gun.spreadDeg * DEG2RAD;
      for (const b of fired) {
        // Spread jitter is rolled HERE on the world stream — one draw per
        // bullet, planes in array order then muzzles in volley order, so the
        // stream stays deterministic. Clients render where bullets actually
        // went; nobody re-simulates spread client-side (CONTRACT §4).
        const jit = (this.stream() * 2 - 1) * spreadRad;
        const speed = Math.hypot(b.vx, b.vy);
        const ang = Math.atan2(b.vy, b.vx) + jit;
        b.vx = Math.cos(ang) * speed;
        b.vy = Math.sin(ang) * speed;
        if (st) st.shots++;
        this.bullets.push(b);
      }
    }

    // -- 3. bullet motion, with pre-move positions captured for the sweep -----
    const n = this.bullets.length;
    this.prevXs.length = n;
    this.prevYs.length = n;
    this.expiredFlags.length = n;
    for (let i = 0; i < n; i++) {
      const b = this.bullets[i]!;
      this.prevXs[i] = b.x;
      this.prevYs[i] = b.y;
      // Predict expiry with the exact arithmetic stepBullets uses (t -= dt,
      // gone when ≤ 0) — bit-identical, so slot matching below never lies.
      this.expiredFlags[i] = b.t - dt <= 0;
    }
    stepBullets(this.bullets, dt);

    // -- 4. swept hit resolution: first plane intersected along the segment --
    let si = 0; // cursor into the capture buffers, skipping spliced-out slots
    for (const b of this.bullets) {
      while (si < n && this.expiredFlags[si]) si++;
      // Survivor count ≤ captured slots, so the cursor cannot overrun.
      const bx0 = this.prevXs[si]!;
      const by0 = this.prevYs[si]!;
      si++;
      const shooter = this.planeById(b.owner);
      if (!shooter) continue; // owner left mid-flight: bullet is inert, credits no ghost
      for (const p of this.planes) {
        // Immunity policy lives HERE, not in physics: spawn protection must
        // shield against incoming fire too (a protected plane cannot shoot
        // back), and god is exactly that — no damage, period.
        if (p.invulnT > 0 || this.godIds.has(p.id)) continue;
        if (!bulletHits(b, bx0, by0, p)) continue;
        this.applyHit(ev, shooter, p, b.x, b.y);
        break; // first intersected along the segment wins
      }
    }

    // -- 5. burn ticks: FIRE_BELOW planes cook until they crash ---------------
    for (const p of this.planes) {
      if (p.dead || p.invulnT > 0 || this.godIds.has(p.id)) continue;
      if (p.hp / CLASSES[p.cls].hp >= FIRE_BELOW) continue;
      p.hp -= BURN_DPS * dt;
      if (p.hp > 0) continue;
      // Crash death: credits NOBODY (rooms move tickets only on credited
      // kills). Killer fields carry the victim so the wire shape stays total —
      // killfeed renders the crash variant off crash=true.
      p.hp = 0;
      p.dead = true;
      p.streak = 0;
      ev.push({
        kind: 'kill',
        killer: p.id,
        killerName: p.name,
        victim: p.id,
        victimName: p.name,
        killerTeam: p.team,
        victimTeam: p.team,
        killerCls: p.cls,
        victimCls: p.cls,
        crash: true,
        streak: 0,
        x: p.x,
        y: p.y,
      });
    }

    // -- 6. crates: fall → active → pickup/expire ------------------------------
    for (let ci = this.crates.length - 1; ci >= 0; ci--) {
      const c = this.crates[ci]!;
      c.t -= dt;
      if (c.phase === 'fall') {
        // Landing itself is silent — clients animate the descent from
        // phase+t; the spawn event already fired at drop time.
        if (c.t <= 0) {
          c.phase = 'active';
          c.t = CRATE_LIFE_S;
        }
        continue;
      }
      if (c.t <= 0) {
        ev.push({ kind: 'crate', what: 'expire', x: c.x, y: c.y });
        this.crates.splice(ci, 1);
        continue;
      }
      // Pickup: first living plane inside the radius consumes the crate.
      // Invulnerable planes may grab too — generous, and keeps escape-route
      // crates useful during the protected exit roll.
      for (const p of this.planes) {
        if (p.dead) continue;
        const dx = p.x - c.x;
        const dy = p.y - c.y;
        if (dx * dx + dy * dy > CRATE_PICKUP_R * CRATE_PICKUP_R) continue;
        p.hp = Math.min(CLASSES[p.cls].hp, p.hp + CRATE_HEAL); // heal clamps at maxHp
        p.heat = 0;
        p.jammed = false;
        p.boost = BOOST_MAX;
        ev.push({ kind: 'crate', what: 'pickup', x: c.x, y: c.y, by: p.id });
        this.crates.splice(ci, 1);
        break;
      }
    }

    // -- 7. crate spawner: CRATE_INTERVAL_S cadence while under CRATES_MAX ----
    // The timer accrues only while below the cap: a saturated map PAUSES the
    // cadence rather than banking a burst that would dump all at once the
    // moment one slot frees. Placement rolls the world stream → deterministic.
    if (this.crates.length < CRATES_MAX) {
      this.crateTimer += dt;
      while (this.crateTimer >= CRATE_INTERVAL_S && this.crates.length < CRATES_MAX) {
        this.crateTimer -= CRATE_INTERVAL_S;
        const spot = this.randomOpenWater();
        this.placeCrate(spot.x, spot.y);
      }
    }

    this.tick++;
    this.inStep = false;
    return ev;
  }

  // ------------------------------------------------------------------ internals

  private planeById(id: string): PlaneState | undefined {
    return this.planes.find((p) => p.id === id);
  }

  private placeCrate(x: number, y: number): void {
    this.crates.push({ id: this.nextCrateId++, x, y, phase: 'fall', t: CRATE_FALL_S });
    // Debug verbs fire between steps — park there; in-step spawner flushes live.
    (this.inStep ? this.events : this.parkedEvents).push({
      kind: 'crate',
      what: 'spawn',
      x,
      y,
    });
  }

  /**
   * Uniform rejection-sample over the whole map until isOpenWater agrees
   * (256 tries is overkill for this island density). The map center sits in
   * the shipping-lane corridor that buildMap keeps island-free by
   * construction, so the fallback is provably open water.
   */
  private randomOpenWater(): { x: number; y: number } {
    for (let tries = 0; tries < 256; tries++) {
      const x = this.stream() * this.map.w;
      const y = this.stream() * this.map.h;
      if (isOpenWater(this.map, x, y)) return { x, y };
    }
    return { x: this.map.w / 2, y: this.map.h / 2 };
  }

  /** Apply one confirmed bullet hit: damage, HitEvent, death bookkeeping. */
  private applyHit(ev: GameEvent[], shooter: PlaneState, victim: PlaneState, x: number, y: number): void {
    const dmg = CLASSES[shooter.cls].gun.dmg;
    victim.hp -= dmg;
    const st = this.stats.get(shooter.id);
    if (st) st.hits++;
    const killed = victim.hp <= 0;
    ev.push({ kind: 'hit', target: victim.id, by: shooter.id, x, y, dmg, killed });
    if (!killed) return;
    victim.hp = 0;
    victim.dead = true;
    victim.streak = 0;
    shooter.streak++;
    ev.push({
      kind: 'kill',
      killer: shooter.id,
      killerName: shooter.name,
      victim: victim.id,
      victimName: victim.name,
      killerTeam: shooter.team,
      victimTeam: victim.team,
      killerCls: shooter.cls,
      victimCls: victim.cls,
      crash: false,
      streak: shooter.streak, // killer's NEW streak — drives ACE/LEGEND banners
      x: victim.x, // wreck anchor at the death instant
      y: victim.y,
    });
    // respawnT deliberately untouched: the room queue owns respawns (§4).
  }
}
