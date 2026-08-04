// ============================================================================
// server/src/bots.ts (T6) — server-driven bot heroes.
// BotBrain is a pure, deterministic policy (fps bots discipline): ONE seeded
// rng stream per brain, no Date, no Math.random, no I/O. The room (T10) builds
// a team-vision-filtered BotPercept every tick and feeds the returned commands
// through the SAME intake handlers a human client hits — a bot gets no door a
// human can't use. tick() allocates nothing beyond the small fresh command
// array the seam allows: every scan is an indexed loop over the percept, all
// helper functions are created once per brain, scratch is module/brain state.
// ============================================================================
import { rng } from '@platform/shared';
import {
  FORTIFY_RADIUS,
  ITEMS,
  TOWER,
  ULT_LEVEL_REQ,
  WARD_PLACE_RANGE,
  heroById,
} from '@rift/shared';
import type { AbilityDef, HeroDef, HeroId, HeroRole, ItemId, TeamId, Vec2 } from '@rift/shared';
import type { BotBrain, BotCommand, BotPercept, Ent } from './sim/types.js';

// --- Behaviour knobs (bot policy, not game balance — those live in config) ---
const RETREAT_HP = 0.32; // fall back to fountain below this hp fraction
const RESUME_HP = 0.8; // stay at the fountain until healed past this (latch)
const LASTHIT_SLOP = 0.15; // seeded +-15% wobble on the last-hit threshold
const HEAL_ALLY_FRAC = 0.6; // support heals the lowest ally under this
const FORTIFY_BYPASS_HP = 0.15; // fortified towers may be hit under this fraction
const TOWER_HOLD_MARGIN = 2.5; // start holding this far outside tower range
const TOWER_HOLD_GAP = 1; // hold position sits this far outside tower range
const ENGAGE_RANGE = 12; // carries "in a fight" radius for cast-on-cooldown
const OUTNUMBERED_MARGIN = 1; // fall back when nearby foes > nearby allies + this
const ISOLATION_RADIUS = 8; // assassin: a hero with no ally hero this near is isolated
const TANK_ENGAGE_COUNT = 2; // tank dashes in when this many enemies are in dash range
const WARD_OWN_RADIUS = 12; // an own ward this near lane mid counts as covered
const WARD_REFRESH_TICKS = 600; // 30s between ward attempts at the same spot
const SKILL_RETRY_TICKS = 100; // re-try a silently-refused skill slot after 5s
const WAYPOINT_SLACK = 0.75; // aim at the next waypoint past this travel distance
const LASTHIT_RANGE_EPS = 0.1; // slack on the in-attack-range check

/** Per-role build orders, declared as data (CONTRACT §5). Bought in order at
 *  the fountain; wardstone re-enters the support rotation because its slot
 *  clears when the last charge is placed (item.ts ward rule). */
const BUILD_ORDER: Record<HeroRole, readonly ItemId[]> = {
  tank: ['warmail', 'plategirdle', 'aegisheart', 'swiftboots', 'warhorn', 'bladestone'],
  'ranged-carry': ['stormbow', 'bladestone', 'swiftboots', 'fang', 'aegisheart', 'warhorn'],
  'melee-carry': ['bladestone', 'fang', 'swiftboots', 'aegisheart', 'plategirdle', 'stormbow'],
  mage: ['manacharm', 'blinkstone', 'stormbow', 'bladestone', 'aegisheart', 'swiftboots'],
  support: ['wardstone', 'manacharm', 'aegisheart', 'warhorn', 'swiftboots', 'plategirdle'],
  assassin: ['bladestone', 'fang', 'swiftboots', 'blinkstone', 'stormbow', 'aegisheart'],
};

function distSq(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

function isCreepKind(k: Ent['kind']): boolean {
  return k === 'melee' || k === 'ranged' || k === 'siege';
}

function hpFrac(e: Ent): number {
  return e.maxHp > 0 ? e.hp / e.maxHp : 1;
}

/** Total polyline length. */
function pathTotal(path: readonly Vec2[]): number {
  let total = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (!a || !b) continue;
    total += Math.sqrt(distSq(a.x, a.z, b.x, b.z));
  }
  return total;
}

/** Distance along the polyline (team-0 -> team-1 parametrisation) of the point
 *  nearest to (x, z). */
function pathProgress(path: readonly Vec2[], x: number, z: number): number {
  let bestD2 = Infinity;
  let along = 0;
  let cum = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lenSq = dx * dx + dz * dz;
    const len = Math.sqrt(lenSq);
    let t = 0;
    if (lenSq > 1e-9) {
      t = ((x - a.x) * dx + (z - a.z) * dz) / lenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const d2 = distSq(x, z, a.x + dx * t, a.z + dz * t);
    if (d2 < bestD2) {
      bestD2 = d2;
      along = cum + t * len;
    }
    cum += len;
  }
  return along;
}

/** The next lane waypoint in the owning team's travel direction (team 1 walks
 *  the polyline reversed). Writes into `out`. */
function nextWaypoint(
  path: readonly Vec2[],
  x: number,
  z: number,
  team: TeamId,
  out: { x: number; z: number },
): void {
  const total = pathTotal(path);
  const prog = pathProgress(path, x, z);
  const travel = team === 0 ? prog : total - prog; // distance walked from own base
  let chosen: Vec2 | undefined;
  if (team === 0) {
    let cum = 0;
    for (let i = 0; i < path.length; i++) {
      const w = path[i];
      if (!w) continue;
      if (i > 0) {
        const prev = path[i - 1];
        if (prev) cum += Math.sqrt(distSq(prev.x, prev.z, w.x, w.z));
      }
      if (cum > travel + WAYPOINT_SLACK) {
        chosen = w;
        break;
      }
    }
    if (!chosen) chosen = path[path.length - 1];
  } else {
    let cumFromEnd = 0;
    for (let i = path.length - 1; i >= 0; i--) {
      const w = path[i];
      if (!w) continue;
      if (i < path.length - 1) {
        const nxt = path[i + 1];
        if (nxt) cumFromEnd += Math.sqrt(distSq(w.x, w.z, nxt.x, nxt.z));
      }
      if (cumFromEnd > travel + WAYPOINT_SLACK) {
        chosen = w;
        break;
      }
    }
    if (!chosen) chosen = path[0];
  }
  if (chosen) {
    out.x = chosen.x;
    out.z = chosen.z;
  }
}

/** Own-base endpoint of the bot's lane (the fountain sits on the own Ancient). */
function fountainPoint(p: BotPercept, out: { x: number; z: number }): boolean {
  const path = p.paths[p.lane];
  if (!path || path.length === 0) return false;
  const w = p.self.team === 0 ? path[0] : path[path.length - 1];
  if (!w) return false;
  out.x = w.x;
  out.z = w.z;
  return true;
}

export function createBotBrain(seed: number, hero: HeroId): BotBrain {
  const rand = rng(seed);
  const def: HeroDef = heroById(hero);
  const role = def.role;
  const build = BUILD_ORDER[role];

  // --- brain state (created once; tick() reuses it) ---
  let retreating = false;
  let lastWardTick = -WARD_REFRESH_TICKS;
  // A skill command that the sim silently refused (unknown local rank cap) is
  // backed off for SKILL_RETRY_TICKS so the bot can't wedge on one slot.
  const skillBlockedUntil = [0, 0, 0, 0];
  let skillAttemptSlot = -1;
  let skillAttemptTick = -1;
  let skillAttemptPoints = -1;
  let skillAttemptRank = -1;
  const wp = { x: 0, z: 0 }; // scratch waypoint / hold point

  function castReady(self: Ent, tick: number, slot: number): AbilityDef | null {
    const a = def.abilities[slot];
    if (!a || a.isPassive) return null;
    const rank = self.abilityRanks[slot] ?? 0;
    if (rank < 1) return null;
    if ((self.abilityCdUntilTick[slot] ?? 0) > tick) return null;
    if (self.mana < (a.manaCost[rank - 1] ?? Infinity)) return null;
    return a;
  }

  function castRangeOf(a: AbilityDef, self: Ent, slot: number): number {
    const rank = self.abilityRanks[slot] ?? 1;
    return a.castRange[rank - 1] ?? 0;
  }

  function aoeOf(a: AbilityDef, self: Ent, slot: number): number {
    const rank = self.abilityRanks[slot] ?? 1;
    return a.aoeRadius?.[rank - 1] ?? 0;
  }

  function hasEffect(a: AbilityDef, kind: string): boolean {
    for (let i = 0; i < a.effects.length; i++) {
      if (a.effects[i]?.kind === kind) return true;
    }
    return false;
  }

  function pushCastAt(out: BotCommand[], slot: number, a: AbilityDef, t: Ent): void {
    if (a.targeting === 'unit') out.push({ c: 'cast', slot, target: t.id });
    else if (a.targeting === 'point') out.push({ c: 'cast', slot, x: t.x, z: t.z });
    else out.push({ c: 'cast', slot });
  }

  function pickSkillSlot(self: Ent, tick: number): number {
    const ult = def.abilities[3];
    const ultRank = self.abilityRanks[3] ?? 0;
    if (ult && ultRank < ult.maxRank && tick >= (skillBlockedUntil[3] ?? 0)) {
      if (self.level >= (ULT_LEVEL_REQ[ultRank] ?? Infinity)) return 3;
    }
    for (let s = 0; s < 3; s++) {
      const a = def.abilities[s];
      if (!a) continue;
      if ((self.abilityRanks[s] ?? 0) < a.maxRank && tick >= (skillBlockedUntil[s] ?? 0)) return s;
    }
    return -1;
  }

  /** First unowned build-order item; buy it only when locally affordable into
   *  a free slot (the server re-validates; this keeps the wire clean). */
  function nextPurchase(self: Ent): ItemId | null {
    for (let i = 0; i < build.length; i++) {
      const item = build[i];
      if (!item) continue;
      let owned = false;
      let freeSlot = false;
      for (let s = 0; s < self.items.length; s++) {
        const held = self.items[s];
        if (held === item) owned = true;
        if (held === null) freeSlot = true;
      }
      if (owned) continue;
      if (!freeSlot) return null;
      const cost = ITEMS[item].cost;
      return self.gold >= cost ? item : null;
    }
    return null;
  }

  /** Inventory slot holding a wardstone with charges left, else -1. */
  function wardSlot(self: Ent): number {
    for (let s = 0; s < self.items.length; s++) {
      if (self.items[s] === 'wardstone' && (self.itemCharges[s] ?? 0) > 0) return s;
    }
    return -1;
  }

  function ownWardNear(p: BotPercept, x: number, z: number): boolean {
    for (let i = 0; i < p.visible.length; i++) {
      const e = p.visible[i];
      if (!e || e.kind !== 'ward' || e.team !== p.self.team || !e.alive) continue;
      if (distSq(e.x, e.z, x, z) <= WARD_OWN_RADIUS * WARD_OWN_RADIUS) return true;
    }
    return false;
  }

  function ownCreepNear(p: BotPercept, x: number, z: number, r: number): boolean {
    const r2 = r * r;
    for (let i = 0; i < p.visible.length; i++) {
      const e = p.visible[i];
      if (!e || !isCreepKind(e.kind) || e.team !== p.self.team || !e.alive) continue;
      if (distSq(e.x, e.z, x, z) <= r2) return true;
    }
    return false;
  }

  function nearestEnemyHero(p: BotPercept, range: number): Ent | null {
    const self = p.self;
    const r2 = range * range;
    let best: Ent | null = null;
    let bestD2 = r2;
    for (let i = 0; i < p.visible.length; i++) {
      const e = p.visible[i];
      if (!e || e.kind !== 'hero' || e.team === self.team || !e.alive) continue;
      const d2 = distSq(self.x, self.z, e.x, e.z);
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = e;
      }
    }
    return best;
  }

  /** True if another enemy hero stands within r of `target` (target excluded). */
  function hasNearbyEnemyHero(p: BotPercept, target: Ent, r: number): boolean {
    const r2 = r * r;
    for (let i = 0; i < p.visible.length; i++) {
      const e = p.visible[i];
      if (!e || e.id === target.id) continue;
      if (e.kind !== 'hero' || e.team === p.self.team || !e.alive) continue;
      if (distSq(e.x, e.z, target.x, target.z) <= r2) return true;
    }
    return false;
  }

  /** Archetype casting (CONTRACT §5). Pushes at most one cast command. */
  function tryRoleCast(p: BotPercept, out: BotCommand[]): void {
    const self = p.self;
    if (role === 'mage') {
      // Nuke the lowest-hp enemy hero inside the first ready nuke's range.
      for (let s = 0; s < 4; s++) {
        const a = castReady(self, p.tick, s);
        if (!a || !hasEffect(a, 'damage')) continue;
        const r = castRangeOf(a, self, s);
        const r2 = r * r;
        let best: Ent | null = null;
        for (let i = 0; i < p.visible.length; i++) {
          const e = p.visible[i];
          if (!e || e.kind !== 'hero' || e.team === self.team || !e.alive) continue;
          if (distSq(self.x, self.z, e.x, e.z) > r2) continue;
          if (!best || e.hp < best.hp) best = e;
        }
        if (best) {
          pushCastAt(out, s, a, best);
          return;
        }
      }
      return;
    }
    if (role === 'support') {
      // Heal the lowest-fraction ally (self included) under HEAL_ALLY_FRAC.
      let best: Ent | null = null;
      let bestFrac = HEAL_ALLY_FRAC;
      if (hpFrac(self) < bestFrac) {
        best = self;
        bestFrac = hpFrac(self);
      }
      for (let i = 0; i < p.visible.length; i++) {
        const e = p.visible[i];
        if (!e || e.team !== self.team || !e.alive) continue;
        if (e.kind !== 'hero' && !isCreepKind(e.kind)) continue;
        const f = hpFrac(e);
        if (f < bestFrac) {
          bestFrac = f;
          best = e;
        }
      }
      if (!best) return;
      for (let s = 0; s < 4; s++) {
        const a = castReady(self, p.tick, s);
        if (!a || !hasEffect(a, 'heal')) continue;
        const r = a.targeting === 'none' ? aoeOf(a, self, s) : castRangeOf(a, self, s);
        if (distSq(self.x, self.z, best.x, best.z) > r * r) continue;
        pushCastAt(out, s, a, best);
        return;
      }
      return;
    }
    if (role === 'tank') {
      // Dash into the fray when enough enemies cluster inside dash range.
      for (let s = 0; s < 4; s++) {
        const a = castReady(self, p.tick, s);
        if (!a || !hasEffect(a, 'dash') || a.targeting !== 'point') continue;
        const r = castRangeOf(a, self, s);
        const r2 = r * r;
        let count = 0;
        let cx = 0;
        let cz = 0;
        for (let i = 0; i < p.visible.length; i++) {
          const e = p.visible[i];
          if (!e || e.team === self.team || !e.alive) continue;
          if (e.kind !== 'hero' && !isCreepKind(e.kind)) continue;
          if (distSq(self.x, self.z, e.x, e.z) <= r2) {
            count++;
            cx += e.x;
            cz += e.z;
          }
        }
        if (count >= TANK_ENGAGE_COUNT) {
          out.push({ c: 'cast', slot: s, x: cx / count, z: cz / count });
          return;
        }
      }
      return;
    }
    if (role === 'assassin') {
      // Strike a slowed target first, else an isolated one.
      for (let s = 0; s < 4; s++) {
        const a = castReady(self, p.tick, s);
        if (!a || !hasEffect(a, 'damage')) continue;
        const r = castRangeOf(a, self, s);
        const r2 = r * r;
        let isolated: Ent | null = null;
        for (let i = 0; i < p.visible.length; i++) {
          const e = p.visible[i];
          if (!e || e.kind !== 'hero' || e.team === self.team || !e.alive) continue;
          if (distSq(self.x, self.z, e.x, e.z) > r2) continue;
          if (e.slowPct > 0 && e.slowUntilTick > p.tick) {
            pushCastAt(out, s, a, e);
            return;
          }
          if (!isolated && !hasNearbyEnemyHero(p, e, ISOLATION_RADIUS)) isolated = e;
        }
        if (isolated) {
          pushCastAt(out, s, a, isolated);
          return;
        }
      }
      return;
    }
    // Carries: cast on cooldown during engagements.
    const t = nearestEnemyHero(p, ENGAGE_RANGE);
    if (!t) return;
    for (let s = 0; s < 4; s++) {
      const a = castReady(self, p.tick, s);
      if (!a) continue;
      if (a.targeting === 'none') {
        // Self-buff (radius-0 timed aura) or point-blank AoE: fire in a fight.
        const aoe = aoeOf(a, self, s);
        if (aoe > 0 && distSq(self.x, self.z, t.x, t.z) > aoe * aoe) continue;
        out.push({ c: 'cast', slot: s });
        return;
      }
      if (a.targeting === 'unit' && a.targetTeam === 'ally') continue;
      const r = castRangeOf(a, self, s);
      if (distSq(self.x, self.z, t.x, t.z) > r * r) continue;
      pushCastAt(out, s, a, t);
      return;
    }
  }

  /** Nearest fortified (no own creep within FORTIFY_RADIUS) enemy tower/guard
   *  in this lane standing at >= FORTIFY_BYPASS_HP and inside the hold zone —
   *  the anti-backdoor rule: never hit a tower Fortify would proc on. */
  function holdTower(p: BotPercept): Ent | null {
    const self = p.self;
    const holdR = TOWER.attackRange + TOWER_HOLD_MARGIN;
    let best: Ent | null = null;
    let bestD2 = holdR * holdR;
    for (let i = 0; i < p.visible.length; i++) {
      const e = p.visible[i];
      if (!e || e.team === self.team || !e.alive || e.hp <= 0) continue;
      if (e.kind !== 'tower' && e.kind !== 'guard') continue;
      if (e.kind === 'tower' && e.lane !== p.lane) continue;
      if (hpFrac(e) < FORTIFY_BYPASS_HP) continue; // finishing blow is legal
      if (ownCreepNear(p, e.x, e.z, FORTIFY_RADIUS)) continue; // fortify off
      const d2 = distSq(self.x, self.z, e.x, e.z);
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = e;
      }
    }
    return best;
  }

  function tick(p: BotPercept): BotCommand[] {
    const out: BotCommand[] = [];
    const self = p.self;
    if (p.phase !== 'live' || !self.alive) return out;
    const now = p.tick;
    const frac = hpFrac(self);

    // --- skill points: ult whenever legal, then q > w > e ---
    if (skillAttemptSlot >= 0 && now > skillAttemptTick) {
      // The sim never answered (silent no-op): back that slot off for a while.
      if (
        self.skillPoints === skillAttemptPoints &&
        (self.abilityRanks[skillAttemptSlot] ?? 0) === skillAttemptRank
      ) {
        skillBlockedUntil[skillAttemptSlot] = now + SKILL_RETRY_TICKS;
      }
      skillAttemptSlot = -1;
    }
    if (self.skillPoints > 0) {
      const slot = pickSkillSlot(self, now);
      if (slot >= 0) {
        out.push({ c: 'skill', slot });
        skillAttemptSlot = slot;
        skillAttemptTick = now;
        skillAttemptPoints = self.skillPoints;
        skillAttemptRank = self.abilityRanks[slot] ?? 0;
      }
    }

    // --- fountain: buy the next build-order item ---
    if (p.atFountain) {
      const item = nextPurchase(self);
      if (item) out.push({ c: 'buy', item });
    }

    // --- support: ward the lane-mid waypoint when stock allows ---
    if (role === 'support' && p.wardStock > 0 && now - lastWardTick >= WARD_REFRESH_TICKS) {
      const path = p.paths[p.lane];
      const mid = path && path.length > 0 ? path[path.length >> 1] : undefined;
      if (mid) {
        const slot = wardSlot(self);
        if (
          slot >= 0 &&
          distSq(self.x, self.z, mid.x, mid.z) <= WARD_PLACE_RANGE * WARD_PLACE_RANGE &&
          !ownWardNear(p, mid.x, mid.z)
        ) {
          out.push({ c: 'item', slot, x: mid.x, z: mid.z });
          lastWardTick = now;
        }
      }
    }

    // --- retreat latch: fall back under 32%, hold at fountain till > 80% ---
    if (frac < RETREAT_HP) retreating = true;
    else if (retreating && frac > RESUME_HP) retreating = false;
    if (retreating) {
      if (!p.atFountain && fountainPoint(p, wp)) {
        out.push({ c: 'order', kind: 'move', x: wp.x, z: wp.z });
      }
      return out;
    }

    // --- archetype cast (at most one per tick) ---
    tryRoleCast(p, out);

    // --- numbers discipline: never keep contesting when outnumbered nearby.
    //  Feeding loops (walk back, die again) are the main even-skill failure
    //  mode; a committed cast this tick rides, otherwise fall back toward
    //  the fountain until the local numbers even out. ---
    if (!out.some((c) => c.c === 'cast')) {
      let foes = 0;
      let allies = 0;
      for (let i = 0; i < p.visible.length; i++) {
        const e = p.visible[i];
        if (!e || e.kind !== 'hero' || !e.alive || e.id === self.id) continue;
        if (distSq(self.x, self.z, e.x, e.z) > ENGAGE_RANGE * ENGAGE_RANGE) continue;
        if (e.team === self.team) allies += 1;
        else foes += 1;
      }
      if (foes > allies + OUTNUMBERED_MARGIN && fountainPoint(p, wp)) {
        out.push({ c: 'order', kind: 'move', x: wp.x, z: wp.z });
        return out;
      }
    }

    // --- last-hit: seeded +-15% slop on the expected-damage threshold ---
    const lethality = self.damage * (1 - LASTHIT_SLOP + 2 * LASTHIT_SLOP * rand());
    let lastHit: Ent | null = null;
    for (let i = 0; i < p.visible.length; i++) {
      const e = p.visible[i];
      if (!e || !isCreepKind(e.kind) || e.team === self.team || !e.alive) continue;
      if (e.lane !== p.lane) continue;
      const r = self.attackRange + e.radius + LASTHIT_RANGE_EPS;
      if (distSq(self.x, self.z, e.x, e.z) > r * r) continue;
      if (e.hp <= lethality && (!lastHit || e.hp < lastHit.hp)) lastHit = e;
    }
    if (lastHit) {
      out.push({ c: 'order', kind: 'attack', target: lastHit.id });
      return out;
    }

    // --- never walk into a tower Fortify protects: hold just outside range ---
    const tower = holdTower(p);
    if (tower) {
      const d = Math.sqrt(distSq(self.x, self.z, tower.x, tower.z));
      const want = TOWER.attackRange + TOWER_HOLD_GAP;
      if (d > 1e-3) {
        wp.x = tower.x + ((self.x - tower.x) / d) * want;
        wp.z = tower.z + ((self.z - tower.z) / d) * want;
      } else if (!fountainPoint(p, wp)) {
        return out; // degenerate: no path data, simply hold position
      }
      out.push({ c: 'order', kind: 'attackmove', x: wp.x, z: wp.z });
      return out;
    }

    // --- lane discipline: shadow the own wave, else attack-move forward ---
    const path = p.paths[p.lane];
    if (!path || path.length === 0) {
      out.push({ c: 'order', kind: 'stop' });
      return out;
    }
    const total = pathTotal(path);
    let wave: Ent | null = null;
    let waveProg = -1;
    for (let i = 0; i < p.visible.length; i++) {
      const e = p.visible[i];
      if (!e || !isCreepKind(e.kind) || e.team !== self.team || !e.alive) continue;
      if (e.lane !== p.lane) continue;
      const prog = pathProgress(path, e.x, e.z);
      const travel = self.team === 0 ? prog : total - prog;
      if (travel > waveProg) {
        waveProg = travel;
        wave = e;
      }
    }
    if (wave) {
      out.push({ c: 'order', kind: 'attackmove', x: wave.x, z: wave.z });
      return out;
    }
    nextWaypoint(path, self.x, self.z, self.team, wp);
    out.push({ c: 'order', kind: 'attackmove', x: wp.x, z: wp.z });
    return out;
  }

  return { tick };
}
