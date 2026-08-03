// ============================================================================
// ANCIENTS (rift) — COMBAT + DEATHS/LOOT (CONTRACT §4, T3). advance() steps
// (5) and (6).
//
// Basic attacks: one swing per attackPeriod when the ordered/aggro target is
// in edge-to-edge range; all basic attacks are physical and land instantly,
// setting Ent.atkTarget for the client's tracers (cleared every tick before
// combat runs). Mitigation (armor formula, hero magic resist), the siege
// multiplier and Fortify live in SimWorld.dealDamage so ability damage walks
// the same pipe; lifesteal (basic attacks only, post-mitigation, vs units) is
// applied here.
//
// Tower targeting: nearest enemy creep/summon in range; switches to a hero
// that damaged an allied hero within tower range in the last
// TOWER_HERO_AGGRO_WINDOW_S. Creep acquisition itself lives in movement.ts
// (it must position the creep); combat consumes orderTarget.
//
// Loot (step 6): last-hitter hero takes the creep bounty; creep xp splits
// equally among living enemy heroes within XP_SHARE_RADIUS; hero kills pay
// KILL_GOLD_BASE + KILL_GOLD_PER_LEVEL * victimLevel (+ FIRST_BLOOD_BONUS
// once), kill xp splits among ALL living enemy-team heroes within
// XP_SHARE_RADIUS of the victim, and non-killer hero damagers inside
// ASSIST_WINDOW_S share ASSIST_GOLD and are credited assists. Tower bounty
// goes to every living enemy hero.
// ============================================================================
import {
  ASSIST_GOLD,
  ASSIST_WINDOW_S,
  FIRST_BLOOD_BONUS,
  HERO_KILL_XP_BASE,
  HERO_KILL_XP_PER_LEVEL,
  KILL_GOLD_BASE,
  KILL_GOLD_PER_LEVEL,
  RESPAWN_BASE_S,
  RESPAWN_PER_LEVEL_S,
  TICK_RATE,
  TOWER_HERO_AGGRO_WINDOW_S,
  XP_SHARE_RADIUS,
} from '@rift/shared';
import { NO_ENT } from './types.js';
import type { Ent } from './types.js';
import { inAttackRange } from './movement.js';
import { grantXp } from './units.js';
import type { SimWorld } from './world.js';

function isWaveCreepOrSummon(e: Ent): boolean {
  return e.kind === 'melee' || e.kind === 'ranged' || e.kind === 'siege' || e.kind === 'shade';
}

/** One attacker swing: cooldown, tracer target, damage, lifesteal. */
function fire(w: SimWorld, a: Ent, t: Ent): void {
  a.nextAttackTick = w.tick + Math.max(1, Math.round(a.attackPeriod * TICK_RATE));
  a.atkTarget = t.id;
  const dealt = w.dealDamage(a.id, t.id, a.damage, 'physical');
  // Lifesteal: post-mitigation physical basic-attack damage vs units only.
  if (a.lifesteal > 0 && dealt > 0 && t.id >= 1000) {
    w.heal(a.id, dealt * a.lifesteal);
  }
}

/** Tower/guard target: a hero that damaged an allied hero within tower range
 *  inside the aggro window takes priority; otherwise the nearest enemy
 *  creep/summon in range. Heroes are never shot without the aggro trigger. */
function towerTarget(w: SimWorld, s: Ent): Ent | undefined {
  const windowTicks = Math.round(TOWER_HERO_AGGRO_WINDOW_S * TICK_RATE);
  const n = w.inRadius(s.x, s.z, s.attackRange + 3, w.scratchB);
  let offender: Ent | undefined;
  let offenderTick = -1;
  let bestCreep: Ent | undefined;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const t = w.scratchB[i];
    if (!t || t.id < 1000 || !t.alive || t.team === s.team) continue;
    if (!isWaveCreepOrSummon(t) && t.kind !== 'hero') continue;
    if (!inAttackRange(s, t)) continue;
    if (isWaveCreepOrSummon(t)) {
      const d = Math.hypot(t.x - s.x, t.z - s.z);
      if (d < bestD) {
        bestD = d;
        bestCreep = t;
      }
      continue;
    }
    // Hero: does it appear in an in-range allied hero's recent damagers?
    for (const v of w.mobileMap.values()) {
      if (v.kind !== 'hero' || v.team !== s.team || !v.alive) continue;
      if (!inAttackRange(s, v)) continue;
      for (const rd of v.recentDamagers) {
        if (rd.id !== t.id) continue;
        if (w.tick - rd.tick > windowTicks) continue;
        if (rd.tick > offenderTick) {
          offenderTick = rd.tick;
          offender = t;
        }
      }
    }
  }
  return offender ?? bestCreep;
}

export function stepCombat(w: SimWorld): void {
  // atkTarget drives per-snapshot tracers: cleared each tick before combat.
  for (const e of w.all()) e.atkTarget = NO_ENT;

  // Mobiles (heroes, creeps, summons) swing at their order/aggro target.
  for (const e of w.mobileMap.values()) {
    if (!e.alive) continue;
    if (e.kind === 'ward' || e.kind === 'proj') continue;
    if (w.tick < e.stunUntilTick) continue; // stun zeroes attacks
    if (e.orderTarget === NO_ENT) continue;
    const t = w.get(e.orderTarget);
    if (!t || !t.alive || t.team === e.team) continue;
    if (t.kind === 'ward' || t.kind === 'proj') continue;
    if (w.tick < e.nextAttackTick) continue;
    if (!inAttackRange(e, t)) continue;
    fire(w, e, t);
  }

  // Towers and guards fire on the tower targeting rule; ancients never attack.
  for (const s of w.structures) {
    if (!s.alive || s.kind === 'ancient') continue;
    if (w.tick < s.nextAttackTick) continue;
    const t = towerTarget(w, s);
    if (t) fire(w, s, t);
  }
}

// --- deaths + loot (step 6) ------------------------------------------------------

function killStructure(w: SimWorld, d: Ent): void {
  // Tower bounty (towers AND guard towers) to every living enemy hero.
  if (d.bounty > 0) {
    for (const e of w.mobileMap.values()) {
      if (e.kind !== 'hero' || !e.alive || e.team === d.team) continue;
      e.gold += d.bounty;
      e.goldEarned += d.bounty;
    }
  }
  const kind = d.kind === 'ancient' ? 'ancient' : d.kind === 'guard' ? 'guard' : 'tower';
  w.pushEvent({ k: 'structure', team: d.team, kind, lane: d.lane >= 0 ? d.lane : null });
}

function killCreep(w: SimWorld, d: Ent): void {
  // Last-hit bounty: the killing-blow owner only, and only if it is a hero.
  const killer = d.lastHitBy !== NO_ENT ? w.get(d.lastHitBy) : undefined;
  if (killer && killer.kind === 'hero' && killer.team !== d.team) {
    killer.gold += d.bounty;
    killer.goldEarned += d.bounty;
  }
  // Creep xp splits equally among living enemy heroes within the share radius.
  splitXpAmongHeroes(w, d, d.xpValue);
}

/** Split `amount` xp equally among living heroes of the team ENEMY to `d`
 *  within XP_SHARE_RADIUS of d's corpse. */
function splitXpAmongHeroes(w: SimWorld, d: Ent, amount: number): void {
  if (!(amount > 0)) return;
  const n = w.inRadius(d.x, d.z, XP_SHARE_RADIUS, w.scratchA);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const e = w.scratchA[i];
    if (e && e.kind === 'hero' && e.alive && e.team !== d.team) count += 1;
  }
  if (count === 0) return;
  const per = amount / count;
  for (let i = 0; i < n; i++) {
    const e = w.scratchA[i];
    if (e && e.kind === 'hero' && e.alive && e.team !== d.team) grantXp(w, e, per);
  }
}

function killHero(w: SimWorld, v: Ent): void {
  v.deaths += 1;
  v.respawnAtTick =
    w.tick + Math.round((RESPAWN_BASE_S + RESPAWN_PER_LEVEL_S * v.level) * TICK_RATE);
  const killerEnt = v.lastHitBy !== NO_ENT ? w.get(v.lastHitBy) : undefined;
  const killer =
    killerEnt && killerEnt.kind === 'hero' && killerEnt.team !== v.team ? killerEnt : undefined;

  let gold = 0;
  let firstBlood = false;
  if (killer) {
    killer.kills += 1;
    gold = KILL_GOLD_BASE + KILL_GOLD_PER_LEVEL * v.level;
    if (!w.firstBloodDone) {
      w.firstBloodDone = true;
      gold += FIRST_BLOOD_BONUS;
      firstBlood = true;
    }
    killer.gold += gold;
    killer.goldEarned += gold;
  }

  // Kill xp splits among ALL living enemy-team heroes within the share radius.
  splitXpAmongHeroes(w, v, HERO_KILL_XP_BASE + HERO_KILL_XP_PER_LEVEL * v.level);

  // Assists: non-killer hero damagers inside the window share ASSIST_GOLD.
  const windowTicks = Math.round(ASSIST_WINDOW_S * TICK_RATE);
  w.scratchB.length = 0;
  for (const rd of v.recentDamagers) {
    if (w.tick - rd.tick > windowTicks) continue;
    if (killer && rd.id === killer.id) continue;
    const dm = w.get(rd.id);
    if (!dm || dm.kind !== 'hero' || dm.team === v.team) continue;
    let seen = false;
    for (const e of w.scratchB) if (e.id === dm.id) seen = true;
    if (!seen) w.scratchB.push(dm);
  }
  if (w.scratchB.length > 0) {
    const share = ASSIST_GOLD / w.scratchB.length;
    for (const dm of w.scratchB) {
      dm.assists += 1;
      dm.gold += share;
      dm.goldEarned += share;
    }
  }
  w.scratchB.length = 0;

  w.pushEvent({
    k: 'kill',
    killerPid: killer ? killer.pid : null,
    victimPid: v.pid ?? '',
    gold,
    firstBlood,
  });
}

export function stepDeaths(w: SimWorld): void {
  w.deadBuf.length = 0;
  for (const s of w.structures) {
    if (s.alive && s.hp <= 0) w.deadBuf.push(s);
  }
  for (const e of w.mobileMap.values()) {
    if (e.alive && e.hp <= 0) w.deadBuf.push(e);
  }
  for (const d of w.deadBuf) {
    d.alive = false;
    d.hp = 0;
    d.atkTarget = NO_ENT;
    d.orderTarget = NO_ENT;
    d.order = 'idle';
    if (d.kind === 'hero') killHero(w, d);
    else if (d.id < 1000) killStructure(w, d);
    else killCreep(w, d);
  }
  // Corpses of non-hero mobiles leave the store (heroes stay: they respawn).
  for (const d of w.deadBuf) {
    if (d.id >= 1000 && d.kind !== 'hero') {
      w.mobileMap.delete(d.id);
      w.base.delete(d.id);
      w.passiveAuras.delete(d.id);
    }
  }
  w.deadBuf.length = 0;
}
