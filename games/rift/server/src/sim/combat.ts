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
// equally among living heroes of the PAYING team within XP_SHARE_RADIUS; hero
// kills pay KILL_GOLD_BASE + KILL_GOLD_PER_LEVEL * victimLevel (+
// FIRST_BLOOD_BONUS once), kill xp splits among ALL living enemy-team heroes
// within XP_SHARE_RADIUS of the victim, and non-killer hero damagers inside
// ASSIST_WINDOW_S share ASSIST_GOLD and are credited assists. Tower bounty
// goes to every living enemy hero.
//
// TERRAIN (TERRAIN_CONTRACT §4). A basic attack whose attacker stands on
// ELEV_LOW at a target on ELEV_HIGH misses with probability HIGH_GROUND_MISS.
// The gate lives in fire() and nowhere else, so abilities are unaffected
// (DESIGN_DELTA §1); melee, ranged and towers are treated identically. The
// roll is the pure hash missRoll(tick, attacker, target) — no RNG stream, no
// world state — because balance.test.ts replays headless bot matches and
// compares bit-for-bit.
//
// NEUTRALS (TERRAIN_CONTRACT §5). A jungle camp creep carries NEUTRAL_TEAM, so
// "every team that is not the victim's" would pay BOTH player teams for one
// neutral death. Loot therefore names a single paying team — the enemy team for
// a player-team death, the KILLER's team for a neutral one — and a neutral
// death is a creep death in every other respect: no first blood, no 'kill'
// SimEvent (it carries a victimPid and a camp has none), no hero deaths.
// Because Ent.lastHitBy is only an id, the killer's TEAM is captured every tick
// while the killer is still readable (see captureKillerTeams): a neutral that
// outlives its last hitter must still pay that hitter's team, not nobody.
// ============================================================================
import {
  ASSIST_GOLD,
  ASSIST_WINDOW_S,
  ELEV_HIGH,
  ELEV_LOW,
  elevationAt,
  FIRST_BLOOD_BONUS,
  HERO_KILL_XP_BASE,
  HERO_KILL_XP_PER_LEVEL,
  HIGH_GROUND_MISS,
  isPlayerTeam,
  KILL_GOLD_BASE,
  KILL_GOLD_PER_LEVEL,
  missRoll,
  RESPAWN_BASE_S,
  RESPAWN_PER_LEVEL_S,
  TICK_RATE,
  TOWER_HERO_AGGRO_WINDOW_S,
  XP_SHARE_RADIUS,
} from '@rift/shared';
import type { TeamId } from '@rift/shared';
import { NO_ENT } from './types.js';
import type { Ent, EntId } from './types.js';
import { inAttackRange } from './movement.js';
import { grantXp } from './units.js';
import type { SimWorld } from './world.js';

function isWaveCreepOrSummon(e: Ent): boolean {
  return e.kind === 'melee' || e.kind === 'ranged' || e.kind === 'siege' || e.kind === 'shade';
}

/** The uphill roll (TERRAIN_CONTRACT §4). True only when the attacker stands on
 *  low ground, the target on high ground, and this tick's deterministic hash
 *  falls inside HIGH_GROUND_MISS. `elevationAt` reads a ramp as ELEV_HIGH and a
 *  cliff as ELEV_LOW, so the answer is defined everywhere on the grid. */
function uphillMiss(w: SimWorld, a: Ent, t: Ent): boolean {
  const terrain = w.map.terrain;
  if (elevationAt(terrain, a.x, a.z) !== ELEV_LOW) return false;
  if (elevationAt(terrain, t.x, t.z) !== ELEV_HIGH) return false;
  return missRoll(w.tick, a.id, t.id) < HIGH_GROUND_MISS;
}

/** One attacker swing: cooldown, tracer target, uphill roll, damage, lifesteal.
 *  The cooldown is stamped and atkTarget is set BEFORE the roll, so a miss
 *  still spends the swing and still draws the client's tracer — it simply deals
 *  no damage and applies no on-hit effect. */
function fire(w: SimWorld, a: Ent, t: Ent): void {
  a.nextAttackTick = w.tick + Math.max(1, Math.round(a.attackPeriod * TICK_RATE));
  a.atkTarget = t.id;
  if (uphillMiss(w, a, t)) {
    // AMENDMENT_1 §B.2: 'miss' is a real SimEvent member; attacker and target
    // are ENTITY ids, matching `rift_miss` on the wire — never player ids.
    w.pushEvent({ k: 'miss', attacker: a.id, target: t.id });
    return;
  }
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

/** Killing teams that must outlive the killer, keyed by world so nothing is
 *  shared between matches and nothing survives one.
 *
 *  `Ent.lastHitBy` is an id, not a team, and the ent behind it is not permanent:
 *  units.ts reaps expired projectiles and summons at step (7), and this file
 *  reaps creep corpses at step (6), while a neutral can die much later from a
 *  source that writes no `lastHitBy` at all — `camps.ts` culls orphaned members
 *  by writing `hp = 0` directly. Resolving the killer through `w.get` then
 *  answers undefined, and the neutral would pay NOBODY: strictly worse than the
 *  double payment this task set out to remove. So the killing team is captured
 *  while the killer is still readable, and read back after it is gone. */
const killerTeams = new WeakMap<SimWorld, Map<EntId, TeamId>>();

/** Record the team of every living neutral's current last hitter, and forget
 *  ids no living neutral names any more. Runs once per tick at the top of
 *  stepDeaths, which is before this tick's corpse reaping and before units.ts'
 *  expiry reaping, so a killer alive when it landed the blow is always recorded
 *  at least once. The table therefore holds at most one entry per living
 *  neutral — it cannot grow with match length. */
function captureKillerTeams(w: SimWorld): void {
  let table = killerTeams.get(w);
  for (const e of w.mobileMap.values()) {
    if (!e.alive || isPlayerTeam(e.team) || e.lastHitBy === NO_ENT) continue;
    if (table !== undefined && table.has(e.lastHitBy)) continue;
    const killer = w.get(e.lastHitBy);
    if (killer === undefined || !isPlayerTeam(killer.team)) continue;
    if (table === undefined) {
      table = new Map<EntId, TeamId>();
      killerTeams.set(w, table);
    }
    table.set(e.lastHitBy, killer.team);
  }
  if (table === undefined) return;
  for (const id of table.keys()) {
    let named = false;
    for (const e of w.mobileMap.values()) {
      if (e.alive && !isPlayerTeam(e.team) && e.lastHitBy === id) {
        named = true;
        break;
      }
    }
    if (!named) table.delete(id);
  }
}

/** The ONE team whose heroes are paid for `d`'s death, or null when nobody is.
 *
 *  For a player-team victim this is the other player team — identical to the
 *  old `e.team !== d.team` filter, because heroes are never neutral.
 *
 *  For a NEUTRAL victim (TERRAIN_CONTRACT §5) that filter admitted heroes from
 *  BOTH teams and paid the camp's xp twice. A camp is an enemy to everyone, so
 *  "the enemy team" is not a team at all: the payer is the team of whoever
 *  landed the killing blow, whether or not that killer is still in the store —
 *  {@link captureKillerTeams} recorded its team while it was. A camp with no
 *  last-hitter, or one finished off by another neutral, pays nobody: there is no
 *  third team to pay. */
function lootTeam(w: SimWorld, d: Ent): TeamId | null {
  if (isPlayerTeam(d.team)) return d.team === 0 ? 1 : 0;
  if (d.lastHitBy === NO_ENT) return null;
  const killer = w.get(d.lastHitBy);
  if (killer !== undefined) return isPlayerTeam(killer.team) ? killer.team : null;
  return killerTeams.get(w)?.get(d.lastHitBy) ?? null;
}

function killStructure(w: SimWorld, d: Ent): void {
  // Tower bounty (towers AND guard towers) to every living enemy hero. This
  // needs no team guard: `e.team === d.team` excludes the owner whatever the
  // owner is, so the payout is correct for any value `d.team` can hold.
  if (d.bounty > 0) {
    for (const e of w.mobileMap.values()) {
      if (e.kind !== 'hero' || !e.alive || e.team === d.team) continue;
      e.gold += d.bounty;
      e.goldEarned += d.bounty;
    }
  }
  // The EVENT, and only the event, needs a player team: `SimEvent.structure`
  // carries a TeamId that the client uses to index two-element colour/marker
  // tuples, and writing NEUTRAL_TEAM into it is the out-of-bounds read
  // TERRAIN_CONTRACT §5 forbids. A structure is never neutral — StructureDef.team
  // is a TeamId and the world builds every structure ent straight from it — so
  // this narrow guard is that proof, and it must not swallow the bounty with it.
  if (!isPlayerTeam(d.team)) return;
  const kind = d.kind === 'ancient' ? 'ancient' : d.kind === 'guard' ? 'guard' : 'tower';
  w.pushEvent({ k: 'structure', team: d.team, kind, lane: d.lane >= 0 ? d.lane : null });
}

/** Wave creeps, summons AND neutral camp creeps: everything mobile that is not
 *  a hero. A neutral death differs only in WHO is paid — it emits no event,
 *  touches no first blood and increments nobody's deaths. */
function killCreep(w: SimWorld, d: Ent): void {
  // Last-hit bounty: the killing-blow owner only, and only if it is a hero.
  const killer = d.lastHitBy !== NO_ENT ? w.get(d.lastHitBy) : undefined;
  if (killer && killer.kind === 'hero' && killer.team !== d.team) {
    killer.gold += d.bounty;
    killer.goldEarned += d.bounty;
  }
  // Creep xp splits equally among the paying team's heroes in the share radius.
  splitXpAmongHeroes(w, d, d.xpValue, lootTeam(w, d));
}

/** Split `amount` xp equally among living heroes of `team` within
 *  XP_SHARE_RADIUS of d's corpse. `team` is the single paying team from
 *  {@link lootTeam}; null means the death pays nobody. */
function splitXpAmongHeroes(w: SimWorld, d: Ent, amount: number, team: TeamId | null): void {
  if (team === null || !(amount > 0)) return;
  const n = w.inRadius(d.x, d.z, XP_SHARE_RADIUS, w.scratchA);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const e = w.scratchA[i];
    if (e && e.kind === 'hero' && e.alive && e.team === team) count += 1;
  }
  if (count === 0) return;
  const per = amount / count;
  for (let i = 0; i < n; i++) {
    const e = w.scratchA[i];
    if (e && e.kind === 'hero' && e.alive && e.team === team) grantXp(w, e, per);
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
  splitXpAmongHeroes(w, v, HERO_KILL_XP_BASE + HERO_KILL_XP_PER_LEVEL * v.level, lootTeam(w, v));

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
  // Before anything is reaped: remember who is currently killing each neutral.
  captureKillerTeams(w);
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
    // Hero loot is the only path that touches first blood, the 'kill' event
    // (whose victimPid a neutral has not got) and a deaths counter. The branch
    // keys on kind ALONE: a hero is the victim or it is not. Adding
    // `&& isPlayerTeam(d.team)` would route a hero to killCreep, which never
    // writes respawnAtTick, while the corpse loop below never removes a hero —
    // a permanent soft-lock wearing the costume of a safety check.
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
