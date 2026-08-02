// ============================================================================
// server/src/bots.ts (S4) — server-driven bot players.
// BotBrain is a pure, deterministic policy: one seeded rng stream, no Date,
// no I/O. The room (S2) builds a BotPercept every tick and feeds the returned
// BotCommand through the same input/reload/buy path as human clients.
// Allocation-light: the walkability grid, BFS buffers, and path buffers are
// preallocated once per brain (rebuilt only if the map changes); tick()
// allocates nothing beyond the small command object it must return.
// ============================================================================
import {
  HEAD_BOX_H,
  INPUT_FIRE,
  INPUT_JUMP,
  PLAYER,
  TICK_DT,
  WEAPONS,
  raycastSolids,
  rng,
  rngInt,
} from '@fps/shared';
import type { AABB, MapDef, PlayerId, RoomPhase, Vec3, WeaponId } from '@fps/shared';

export interface BotPercept {
  self: { x: number; y: number; z: number; yaw: number; pitch: number; hp: number;
          mag: number; reserve: number; reloading: boolean; crouch: boolean;
          // The weapon the bot is holding RIGHT NOW — the same id the server's
          // own fire path resolves (PlayerState.weapon). NOT owned[0]: owned is
          // the ownership list and its first entry is always 'knife'.
          weapon: WeaponId };
  enemies: Array<{ id: PlayerId; x: number; y: number; z: number; height: number; alive: boolean }>;
  solids: AABB[];
  map: MapDef;
  tick: number;
  phase: RoomPhase;
  money: number;
  /** Everything owned, knife first. Ownership only — never "my gun". */
  owned: WeaponId[];
  canBuy: boolean;
}

export interface BotCommand {
  moveX: number; moveZ: number; yaw: number; pitch: number; buttons: number; // INPUT_* bits
  reload: boolean;
  buy: WeaponId | null;
  /**
   * The weapon the bot wants to be HOLDING, or null when it is already holding
   * it. The room feeds this straight into `handleSwitch` — the same handler a
   * human client's `{ t: 'switch' }` message hits — so a bot can never equip
   * something the switch rules would refuse a human (unowned, or while dead).
   * Buying does NOT equip: `handleBuy` only re-equips when the held weapon
   * LEAVES the owned list, so without this a bot that bought a rifle while
   * holding a pistol kept the pistol forever.
   */
  switchTo: WeaponId | null;
}

type PerceptEnemy = BotPercept['enemies'][number];

const CELL = 0.75; // walkability grid resolution (m)
const PERCEPT_RANGE = 45; // m, 360° awareness
const TURN_RATE = 6; // rad/s, combined yaw+pitch aim speed
const FIRE_ERR_RAD = (3 * Math.PI) / 180; // fire only when aim error < 3°
// 233ms at 30Hz before firing on a newly acquired target. Was 9 (300ms), tuned
// down once bots could actually hold a rifle. 233ms is a good human player's
// visual reaction; going below ~200ms would be superhuman and is the line this
// knob must not cross (I4 — bots stay beatable).
const REACTION_TICKS = 7;
const REPATH_TICKS = 150; // 5s max path age
const BLOCKED_TICKS_REPATH = 15; // repath when blocked > 0.5s
const BLOCKED_TICKS_JUMP = 2; // hop when stuck on the ground
const BLOCK_DIST_SQ = 0.03 * 0.03; // moved less than this while trying => blocked
const ARRIVE_DIST = 0.5; // waypoint arrival radius
const NODE_REACH_SQ = 0.45 * 0.45; // path node advance radius
const MIN_GOAL_DIST_SQ = 4; // patrol goals must be >= 2m away (when possible)
const PITCH_MAX = 1.45; // matches protocol clamp
const LOOKAHEAD = 16; // max path nodes considered for string-pulling

// Descending preference over weapons a bot will hold. Module-level and frozen
// so `pickSwitch` allocates nothing per tick (I3). Weapons a bot never buys
// (shotgun, sniper) are deliberately absent: an unlisted weapon is simply not
// preferred, and the pistol below it is always owned, so the loop always
// terminates on something real.
const WEAPON_PREF: readonly WeaponId[] = ['rifle', 'smg', 'pistol', 'knife'];

// ---- aim point (difficulty knob) -------------------------------------------
// The head box is the top HEAD_BOX_H of a body, standing or crouched (see
// playerHitboxes in @fps/shared/physics). Bots deliberately aim AIM_DROP below
// its base — the upper chest — so the head is never the intended target but
// residual aim error, target movement and weapon spread still clip it now and
// then. That is the design call: bots should land the occasional headshot,
// never hunt for one.
// MEASURED at 0.12m: ~1 headshot per 5 hits (20.2% duel / 21.1% team over 80
// matches). The previous "~1 per 8" was measured when every bot was stuck
// holding a pistol; automatic fire sprays bloom across the head box far more
// often, so the same drop now yields a materially higher rate. Left at 0.12m
// because the balance measurement lands in target WITH that rate — but it is
// the first knob to raise if bots start reading as unfair, since a rifle
// headshot (33 x 4 = 132) is an outright one-shot kill.
// A fixed drop (rather than a fraction of height) keeps the aim point on the
// same part of the body whether the target is standing or crouched.
// HEAD_BOX_H is imported from @fps/shared/physics — the same constant
// playerHitboxes builds the head AABB from, so the aim point and the hitbox it
// is aiming under can never drift apart.
const AIM_DROP = 0.12;
// Semi-auto trigger discipline, in ticks between shots. The floor is what makes
// a pistol bot dangerous without becoming a metronome; the server's own
// per-weapon `interval` still gates the actual rate.
const SEMI_COOLDOWN_MIN = 6;
const SEMI_COOLDOWN_MAX = 9;

// ---- automatic burst discipline (difficulty knob) --------------------------
// Counted in SHOTS, not ticks. This unit matters: the server gates the real
// rate of fire by the weapon's `interval`, so a burst measured in HELD TICKS
// buys a different number of bullets on every weapon. The old 4-8 TICK burst
// was 4-8 bullets from a pistol but only 1-2 from a rifle (interval 0.1s = 3
// ticks per shot) — which is why, once bots could finally hold a rifle, they
// were no more dangerous than they had been with a pistol. 3-5 rounds is a
// disciplined rifle burst and now means that on every automatic weapon.
const BURST_SHOTS_MIN = 3;
const BURST_SHOTS_MAX = 5;
// Ticks between bursts. Sized to let the weapon's bloom recover: a rifle sheds
// the ~2.8deg a 5-round burst adds in about 0.4s at spreadRecover 7deg/s.
const PAUSE_TICKS_MIN = 8;
const PAUSE_TICKS_MAX = 15;

/** Held ticks that yield BURST_SHOTS_MIN..MAX actual shots from `def`. */
function burstTicks(next: () => number, def: { interval: number }): number {
  const ticksPerShot = Math.max(1, Math.ceil(def.interval / TICK_DT));
  return rngInt(next, BURST_SHOTS_MIN, BURST_SHOTS_MAX) * ticksPerShot;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export class BotBrain {
  private readonly next: () => number;

  // ---- cached walkability grid (built once per map) ----
  private gridMapId: string | null = null;
  private nx = 0;
  private nz = 0;
  private sizeX = 0;
  private sizeZ = 0;
  private walkable: Uint8Array = new Uint8Array(0);
  private stamp: Int32Array = new Int32Array(0); // BFS visit stamps (no clearing)
  private bfsStamp = 0;
  private cameFrom: Int32Array = new Int32Array(0);
  private queue: Int32Array = new Int32Array(0); // BFS ring buffer
  private pathX: Float64Array = new Float64Array(0);
  private pathZ: Float64Array = new Float64Array(0);

  // ---- patrol state ----
  private hasPath = false;
  private pathLen = 0;
  private pathIdx = 0;
  private pathSetTick = -1_000_000;

  // ---- engagement state ----
  private targetId: PlayerId | null = null;
  private acquiredTick = 0;
  // Rolled on every target acquisition (which always precedes the first shot,
  // since targetId starts null), sized from the HELD weapon's fire interval.
  private burstLeft = 0;
  private pauseLeft = 0;
  private semiCooldown = 0;

  // ---- blocked detection ----
  private prevX = 0;
  private prevZ = 0;
  private havePrev = false;
  private intendedMove = false;
  private blockedTicks = 0;

  // ---- scratch vectors (reused, never retained) ----
  private readonly scratchO: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchD: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(seed: number) {
    this.next = rng(seed);
  }

  tick(p: BotPercept): BotCommand {
    this.ensureGrid(p.map, p.solids);

    // blocked measurement: last tick we wanted to move but barely did
    if (this.havePrev) {
      const dx = p.self.x - this.prevX;
      const dz = p.self.z - this.prevZ;
      this.blockedTicks =
        this.intendedMove && dx * dx + dz * dz < BLOCK_DIST_SQ ? this.blockedTicks + 1 : 0;
    }
    this.prevX = p.self.x;
    this.prevZ = p.self.z;
    this.havePrev = true;

    const cmd: BotCommand = {
      moveX: 0, moveZ: 0, yaw: p.self.yaw, pitch: p.self.pitch, buttons: 0,
      reload: false, buy: null, switchTo: null,
    };

    // buy is legal whenever the room says so (freeze + live buy window)
    if (p.canBuy) {
      if (!p.owned.includes('rifle') && p.money >= WEAPONS.rifle.price) cmd.buy = 'rifle';
      else if (!p.owned.includes('smg') && p.money >= WEAPONS.smg.price) cmd.buy = 'smg';
    }

    // Equip the best weapon we OWN. Unconditional (not gated on `active`): the
    // buy happens in freeze, and the resulting switch must land in freeze too,
    // so the bot walks out of the buy window already holding its rifle. A buy
    // made this tick is not visible in `owned` until the room refreshes the
    // percept, so the switch trails its buy by exactly one tick (33ms) — the
    // same round trip a human client pays for a switch message.
    cmd.switchTo = this.pickSwitch(p);

    // bodies only simulate in warmup/live; a dead bot (hp 0) stays put
    const active = (p.phase === 'warmup' || p.phase === 'live') && p.self.hp > 0;
    if (active) {
      const target = this.acquire(p);
      if (target !== null) this.engage(p, target, cmd);
      else {
        this.targetId = null;
        this.patrol(p, cmd);
      }
    } else {
      this.targetId = null;
    }

    this.intendedMove = cmd.moveX !== 0 || cmd.moveZ !== 0;
    return cmd;
  }

  /**
   * The best owned weapon by WEAPON_PREF, or null when it is already held.
   * Reads `owned` (ownership) and `self.weapon` (what is held) — the two are
   * different things per C1, and conflating them is the bug this fixes.
   */
  private pickSwitch(p: BotPercept): WeaponId | null {
    for (const w of WEAPON_PREF) {
      if (!p.owned.includes(w)) continue;
      return w === p.self.weapon ? null : w;
    }
    return null; // owns nothing preferred: hold whatever the room gave us
  }

  // -------------------------------------------------------------------------
  // Perception: nearest alive enemy with clear LOS within 45m, 360° awareness.
  // -------------------------------------------------------------------------

  private acquire(p: BotPercept): PerceptEnemy | null {
    const selfHeight = p.self.crouch ? PLAYER.heightCrouch : PLAYER.heightStand;
    const o = this.scratchO;
    o.x = p.self.x;
    o.y = p.self.y + selfHeight - PLAYER.eyeOffset;
    o.z = p.self.z;
    const d = this.scratchD;
    let best: PerceptEnemy | null = null;
    let bestD2 = PERCEPT_RANGE * PERCEPT_RANGE;
    for (const e of p.enemies) {
      if (!e.alive) continue;
      const dx = e.x - o.x;
      const dy = e.y + e.height - PLAYER.eyeOffset - o.y;
      const dz = e.z - o.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= bestD2) continue;
      const dist = Math.sqrt(d2);
      if (dist > 1e-6) {
        d.x = dx / dist;
        d.y = dy / dist;
        d.z = dz / dist;
        if (raycastSolids(o, d, p.solids, dist) >= 0) continue; // wall between the eyes
      }
      best = e;
      bestD2 = d2;
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Engage: track the chest at <= 6 rad/s, 300ms reaction, disciplined fire.
  // -------------------------------------------------------------------------

  private engage(p: BotPercept, target: PerceptEnemy, cmd: BotCommand): void {
    const selfHeight = p.self.crouch ? PLAYER.heightCrouch : PLAYER.heightStand;
    const eyeY = p.self.y + selfHeight - PLAYER.eyeOffset;
    const chestY = target.y + target.height - HEAD_BOX_H - AIM_DROP;
    const dx = target.x - p.self.x;
    const dz = target.z - p.self.z;
    const desiredYaw = Math.atan2(-dx, -dz);
    const desiredPitch = clamp(
      Math.atan2(chestY - eyeY, Math.hypot(dx, dz)),
      -PITCH_MAX,
      PITCH_MAX,
    );

    const def = WEAPONS[p.self.weapon];

    // target acquisition resets the reaction clock and the burst pattern
    if (this.targetId !== target.id) {
      this.targetId = target.id;
      this.acquiredTick = p.tick;
      this.burstLeft = burstTicks(this.next, def);
      this.pauseLeft = 0;
      this.semiCooldown = 0;
    }

    // rate-limited turn toward the chest (combined yaw+pitch <= 6 rad/s)
    let dYaw = wrapPi(desiredYaw - p.self.yaw);
    let dPitch = desiredPitch - p.self.pitch;
    const maxTurn = TURN_RATE * TICK_DT;
    const turnMag = Math.hypot(dYaw, dPitch);
    if (turnMag > maxTurn) {
      const k = maxTurn / turnMag;
      dYaw *= k;
      dPitch *= k;
    }
    cmd.yaw = p.self.yaw + dYaw;
    cmd.pitch = clamp(p.self.pitch + dPitch, -PITCH_MAX, PITCH_MAX);

    // strafe while engaging
    cmd.moveX = clamp(Math.sin(p.tick / 20), -1, 1);

    // residual aim error of the command being sent
    const aimErr = Math.hypot(wrapPi(desiredYaw - cmd.yaw), desiredPitch - cmd.pitch);
    const reacted = p.tick - this.acquiredTick >= REACTION_TICKS;

    if (p.self.reloading) return;
    if (p.self.mag === 0 && def.mag !== -1) {
      cmd.reload = true; // never in the same tick as a fire press
      return;
    }
    if (!reacted || aimErr >= FIRE_ERR_RAD) return;

    if (def.auto) {
      // bursts of BURST_SHOTS_MIN..MAX rounds separated by 8-15 tick pauses
      if (this.burstLeft > 0) {
        cmd.buttons |= INPUT_FIRE;
        this.burstLeft--;
        if (this.burstLeft === 0) {
          this.pauseLeft = rngInt(this.next, PAUSE_TICKS_MIN, PAUSE_TICKS_MAX);
        }
      } else {
        this.pauseLeft--;
        if (this.pauseLeft <= 0) this.burstLeft = burstTicks(this.next, def);
      }
    } else {
      // semi: single fire ticks every ~10 ticks (edge-triggered server-side)
      if (this.semiCooldown <= 0) {
        cmd.buttons |= INPUT_FIRE;
        this.semiCooldown = rngInt(this.next, SEMI_COOLDOWN_MIN, SEMI_COOLDOWN_MAX);
      } else {
        this.semiCooldown--;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Patrol: BFS over the cached walkability grid to seeded reachable waypoints.
  // -------------------------------------------------------------------------

  private patrol(p: BotPercept, cmd: BotCommand): void {
    if (
      !this.hasPath ||
      this.pathIdx >= this.pathLen ||
      p.tick - this.pathSetTick >= REPATH_TICKS ||
      this.blockedTicks > BLOCKED_TICKS_REPATH
    ) {
      this.repath(p);
    }
    if (!this.hasPath || this.pathIdx >= this.pathLen) return;

    // advance past nodes we are already on top of
    // (typed-array reads below: indices are provably < pathLen <= buffer length)
    while (this.pathIdx < this.pathLen - 1) {
      const dx = this.pathX[this.pathIdx]! - p.self.x;
      const dz = this.pathZ[this.pathIdx]! - p.self.z;
      if (dx * dx + dz * dz >= NODE_REACH_SQ) break;
      this.pathIdx++;
    }
    // string-pull: walk straight to the furthest clearly-walkable node
    const maxLook = Math.min(this.pathLen - 1, this.pathIdx + LOOKAHEAD);
    for (let i = this.pathIdx + 1; i <= maxLook; i++) {
      if (this.walkLineClear(p.self.x, p.self.z, this.pathX[i]!, this.pathZ[i]!)) this.pathIdx = i;
      else break;
    }
    let tx = this.pathX[this.pathIdx]!;
    let tz = this.pathZ[this.pathIdx]!;
    // pushed off the path (collision, knockback): repath once
    if (!this.walkLineClear(p.self.x, p.self.z, tx, tz)) {
      this.repath(p);
      if (!this.hasPath || this.pathIdx >= this.pathLen) return;
      tx = this.pathX[this.pathIdx]!;
      tz = this.pathZ[this.pathIdx]!;
    }

    const dx = tx - p.self.x;
    const dz = tz - p.self.z;
    const distSq = dx * dx + dz * dz;
    if (this.pathIdx >= this.pathLen - 1 && distSq < ARRIVE_DIST * ARRIVE_DIST) {
      this.hasPath = false; // arrived: pick a fresh waypoint next tick
      return;
    }
    if (distSq < 1e-6) return;

    cmd.yaw = Math.atan2(-dx, -dz); // face the walk direction
    cmd.pitch = 0;
    cmd.moveZ = 1;
    if (this.blockedTicks >= BLOCKED_TICKS_JUMP) cmd.buttons |= INPUT_JUMP;
  }

  private repath(p: BotPercept): void {
    this.hasPath = false;
    const start = this.nearestWalkable(this.cellOfX(p.self.x), this.cellOfZ(p.self.z));
    if (start < 0) return;
    this.bfs(start);
    const goal = this.pickGoal(p, start);
    if (goal < 0) return;

    // reconstruct goal -> start, then reverse in place
    let n = 0;
    let cur = goal;
    while (cur !== start && n < this.pathX.length) {
      this.pathX[n] = this.cellCenterX(cur % this.nx);
      this.pathZ[n] = this.cellCenterZ((cur / this.nx) | 0);
      n++;
      const prev = this.cameFrom[cur]!; // cur is BFS-visited => cameFrom written
      if (prev < 0 || prev === cur) break;
      cur = prev;
    }
    for (let a = 0, b = n - 1; a < b; a++, b--) {
      const tmpX = this.pathX[a]!;
      this.pathX[a] = this.pathX[b]!;
      this.pathX[b] = tmpX;
      const tmpZ = this.pathZ[a]!;
      this.pathZ[a] = this.pathZ[b]!;
      this.pathZ[b] = tmpZ;
    }
    this.pathLen = n;
    this.pathIdx = 0;
    this.hasPath = n > 0;
    this.pathSetTick = p.tick;
  }

  private bfs(start: number): void {
    this.bfsStamp++;
    const stamp = this.bfsStamp;
    const nx = this.nx;
    const nz = this.nz;
    const q = this.queue;
    let qh = 0;
    let qt = 0;
    q[qt++] = start;
    this.stamp[start] = stamp;
    this.cameFrom[start] = start;
    while (qh < qt) {
      const cur = q[qh++]!; // qh < qt <= enqueued count
      const ci = cur % nx;
      const cj = (cur / nx) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
          const idx = j * nx + i;
          if (this.stamp[idx] === stamp || this.walkable[idx] === 0) continue;
          if (di !== 0 && dj !== 0) {
            // no corner cutting: both orthogonal cells must be walkable
            if (this.walkable[cj * nx + i] === 0 || this.walkable[j * nx + ci] === 0) continue;
          }
          this.stamp[idx] = stamp;
          this.cameFrom[idx] = cur;
          q[qt++] = idx;
        }
      }
    }
  }

  // Seeded pick among reachable cells; in 'live' prefer the enemy half of the
  // map (sign of the mean enemy z; pushing across mid when none are visible).
  private pickGoal(p: BotPercept, start: number): number {
    let biasSign = 0;
    if (p.phase === 'live') {
      let ez = 0;
      let n = 0;
      for (const e of p.enemies) {
        if (e.alive) {
          ez += e.z;
          n++;
        }
      }
      biasSign = n > 0 ? Math.sign(ez) : p.self.z >= 0 ? -1 : 1;
    }

    const stamp = this.bfsStamp;
    const nx = this.nx;
    let visitedCount = 0;
    let farCount = 0;
    let biasedCount = 0;
    for (let idx = 0; idx < this.stamp.length; idx++) {
      if (this.stamp[idx] !== stamp || idx === start) continue;
      visitedCount++;
      const cx = this.cellCenterX(idx % nx);
      const cz = this.cellCenterZ((idx / nx) | 0);
      const dx = cx - p.self.x;
      const dz = cz - p.self.z;
      if (dx * dx + dz * dz < MIN_GOAL_DIST_SQ) continue;
      farCount++;
      if (biasSign !== 0 && (cz >= 0 ? 1 : -1) === biasSign) biasedCount++;
    }
    // pool: 1 = far + biased, 2 = far, 3 = any visited
    const pool = biasedCount > 0 ? 1 : farCount > 0 ? 2 : visitedCount > 0 ? 3 : 0;
    if (pool === 0) return -1;
    const poolSize = pool === 1 ? biasedCount : pool === 2 ? farCount : visitedCount;
    let k = rngInt(this.next, 0, poolSize - 1);
    for (let idx = 0; idx < this.stamp.length; idx++) {
      if (this.stamp[idx] !== stamp || idx === start) continue;
      if (pool !== 3) {
        const cx = this.cellCenterX(idx % nx);
        const cz = this.cellCenterZ((idx / nx) | 0);
        const dx = cx - p.self.x;
        const dz = cz - p.self.z;
        if (dx * dx + dz * dz < MIN_GOAL_DIST_SQ) continue;
        if (pool === 1 && (cz >= 0 ? 1 : -1) !== biasSign) continue;
      }
      if (k === 0) return idx;
      k--;
    }
    return -1;
  }

  // -------------------------------------------------------------------------
  // Walkability grid: 0.75m cells from map solids. A cell is walkable when a
  // standing player at its center overlaps no solid that is neither
  // step-up-able (top <= stepUp) nor overhead (base >= stand height).
  // -------------------------------------------------------------------------

  private ensureGrid(map: MapDef, solids: AABB[]): void {
    if (this.gridMapId === map.id) return;
    this.gridMapId = map.id;
    this.sizeX = map.sizeX;
    this.sizeZ = map.sizeZ;
    this.nx = Math.max(1, Math.ceil(map.sizeX / CELL));
    this.nz = Math.max(1, Math.ceil(map.sizeZ / CELL));
    const n = this.nx * this.nz;
    this.walkable = new Uint8Array(n);
    this.stamp = new Int32Array(n);
    this.cameFrom = new Int32Array(n);
    this.queue = new Int32Array(n);
    this.pathX = new Float64Array(n);
    this.pathZ = new Float64Array(n);
    this.bfsStamp = 0;
    this.hasPath = false;
    this.pathLen = 0;
    this.pathIdx = 0;
    this.blockedTicks = 0;
    this.havePrev = false;

    const r = PLAYER.radius;
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const cx = this.cellCenterX(i);
        const cz = this.cellCenterZ(j);
        let ok = 1;
        for (const s of solids) {
          if (s.maxY <= PLAYER.stepUp) continue; // can step onto it
          if (s.minY >= PLAYER.heightStand) continue; // overhead clearance
          if (cx - r < s.maxX && cx + r > s.minX && cz - r < s.maxZ && cz + r > s.minZ) {
            ok = 0;
            break;
          }
        }
        this.walkable[j * this.nx + i] = ok;
      }
    }
  }

  private cellOfX(x: number): number {
    return clamp(Math.floor((x + this.sizeX / 2) / CELL), 0, this.nx - 1);
  }

  private cellOfZ(z: number): number {
    return clamp(Math.floor((z + this.sizeZ / 2) / CELL), 0, this.nz - 1);
  }

  private cellCenterX(i: number): number {
    return (i + 0.5) * CELL - this.sizeX / 2;
  }

  private cellCenterZ(j: number): number {
    return (j + 0.5) * CELL - this.sizeZ / 2;
  }

  private nearestWalkable(ci: number, cj: number): number {
    const nx = this.nx;
    const nz = this.nz;
    if (ci >= 0 && cj >= 0 && ci < nx && cj < nz && this.walkable[cj * nx + ci] === 1) {
      return cj * nx + ci;
    }
    // expanding Chebyshev rings
    for (let r = 1; r <= 6; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
          if (this.walkable[j * nx + i] === 1) return j * nx + i;
        }
      }
    }
    return -1;
  }

  private walkLineClear(x0: number, z0: number, x1: number, z1: number): boolean {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / (CELL * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const i = this.cellOfX(x0 + dx * t);
      const j = this.cellOfZ(z0 + dz * t);
      if (this.walkable[j * this.nx + i] === 0) return false;
    }
    return true;
  }
}
