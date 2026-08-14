// ============================================================================
// ANCIENTS (rift) — UNITS (CONTRACT §4, T3). advance() step (7): the wave
// spawner (composition/growth/surge per config), respawns, fountain heal,
// regen, passive gold, summon/ward expiry, team ward-stock restock — plus the
// xp/level-up machinery the loot step (combat.ts) drives through grantXp.
//
// Waves: first at WAVE_FIRST_AT_S, then every WAVE_PERIOD_S, at each base per
// lane, walking toward the enemy base. Wave N (1-based) carries WAVE_MELEE
// melee + WAVE_RANGED ranged per lane per team, plus one siege when
// N % SIEGE_EVERY_NTH_WAVE === 0. Wave index i (0-based) scales creep hp and
// damage by (1 + growth)^i; growth is WAVE_GROWTH, replaced by
// SURGE_WAVE_GROWTH in overtime, which also adds one melee per wave per
// elapsed overtime minute (SURGE_EXTRA_MELEE_PERIOD_S).
//
// NEUTRAL SAFETY (TERRAIN_CONTRACT §5). Jungle camps are a third team and their
// creeps live in this world's mobile map like everything else, so every rule in
// this file is deliberately blind to them. There are exactly five guards, and
// each one covers a case no other guard covers — they are not belt-and-braces
// restatements of one another, and units.test.ts pins each one with a test that
// goes red when that guard alone is reverted:
//   1. wave composition, growth and the overtime surge are derived from the
//      wave counter and the match clock alone — never from a population count —
//      so a jungle full of neutrals cannot perturb wave sizing;
//   2. the respawn loop takes heroes only, which is what excludes the camp
//      kinds (no camp kind is 'hero') AND every other player-team mobile that
//      might carry a respawn stamp;
//   3. the respawn loop then narrows with isPlayerTeam, which is a strictly
//      different case: a hero-KIND entity sitting on NEUTRAL_TEAM. That narrow
//      is also what makes `fountainSpot` — which takes a TeamId — legal to call;
//   4. the expiry reaper treats any non-positive expireAtTick as "never", so
//      the -1 camp members are spawned with is not read as a tick in the past;
//   5. the expiry reaper also skips camp kinds outright, which covers the case
//      the sentinel does not: a camp member carrying a positive stamp.
// Two further properties fall out of the code shape rather than a guard: the
// per-team ward stock is indexed by the literal team ids 0 and 1 only, so no
// neutral event can reach it; and the fountain tick asks `w.atOwnFountain(e)`
// instead of indexing a per-team tuple here, so there is no team index in this
// file to get wrong.
// ============================================================================
import {
  FOUNTAIN_HEAL_PCT,
  FOUNTAIN_MANA_PCT,
  LEVEL_CAP,
  OVERTIME_AT_S,
  PASSIVE_GOLD_PER_S,
  SIEGE_EVERY_NTH_WAVE,
  SKILL_POINTS_PER_LEVEL,
  SURGE_EXTRA_MELEE_PERIOD_S,
  SURGE_WAVE_GROWTH,
  TICK_DT,
  TICK_RATE,
  WARD_RESTOCK_S,
  WARD_TEAM_STOCK,
  WAVE_GROWTH,
  WAVE_MELEE,
  WAVE_PERIOD_S,
  WAVE_RANGED,
  XP_THRESHOLDS,
  heroById,
  isCampKind,
  isPlayerTeam,
} from '@rift/shared';
import type { TeamId } from '@rift/shared';
import type { Ent } from './types.js';
import type { SimWorld } from './world.js';

/** Grant xp to a hero and process any level-ups: thresholds from
 *  XP_THRESHOLDS (cumulative, index = level), +SKILL_POINTS_PER_LEVEL per
 *  level, growth applied to the hero's base stat core, and the gained max
 *  hp/mana also added to current pools (a level-up heals by the gain). */
export function grantXp(w: SimWorld, h: Ent, amount: number): void {
  if (h.kind !== 'hero' || !(amount > 0)) return;
  h.xp += amount;
  let gained = 0;
  while (h.level < LEVEL_CAP) {
    const need = XP_THRESHOLDS[h.level + 1];
    if (need === undefined || h.xp < need) break;
    h.level += 1;
    h.skillPoints += SKILL_POINTS_PER_LEVEL;
    gained += 1;
  }
  if (gained === 0 || h.hero === null) return;
  const def = heroById(h.hero);
  const core = w.base.get(h.id);
  if (!core) return;
  core.maxHp += def.growth.hp * gained;
  core.maxMana += def.growth.mana * gained;
  core.damage += def.growth.damage * gained;
  w.recomputeEnt(h);
  h.hp = Math.min(h.maxHp, h.hp + def.growth.hp * gained);
  h.mana = Math.min(h.maxMana, h.mana + def.growth.mana * gained);
}

/** Spawn one team's wave for one lane. Creeps appear just inside the base on
 *  their lane's first waypoint, fanned perpendicular to the travel direction,
 *  with wave-growth hp/damage baked into both the ent and its base core. */
function spawnWaveLane(
  w: SimWorld,
  lane: number,
  team: TeamId,
  melee: number,
  ranged: number,
  siege: number,
  growthMult: number,
): void {
  const path = w.map.paths[lane];
  if (!path || path.length < 2) return;
  const from = team === 0 ? path[0] : path[path.length - 1];
  const to = team === 0 ? path[1] : path[path.length - 2];
  if (!from || !to) return;
  const d = Math.hypot(to.x - from.x, to.z - from.z) || 1;
  const dx = (to.x - from.x) / d;
  const dz = (to.z - from.z) / d;
  const total = melee + ranged + siege;
  let idx = 0;
  const spawnOne = (kind: 'melee' | 'ranged' | 'siege'): void => {
    const lat = (idx - (total - 1) / 2) * 0.9;
    const x = from.x + dx * 3 - dz * lat;
    const z = from.z + dz * 3 + dx * lat;
    const id = w.spawnMobile(kind, team, x, z, lane, 0, -1);
    idx += 1;
    const e = w.get(id);
    const core = w.base.get(id);
    if (!e || !core) return;
    core.maxHp *= growthMult;
    core.damage *= growthMult;
    w.recomputeEnt(e);
    e.hp = e.maxHp;
  };
  for (let i = 0; i < melee; i++) spawnOne('melee');
  for (let i = 0; i < ranged; i++) spawnOne('ranged');
  for (let i = 0; i < siege; i++) spawnOne('siege');
}

/** Wave spawner. Note what it does NOT read: the entity population. Wave size,
 *  growth and the surge bonus are pure functions of `w.waveIndex`, `w.overtime`
 *  and `w.tick`, and the two teams it spawns for are the literals 0 and 1 —
 *  both `TeamId`. There is therefore no enumeration of units here for a neutral
 *  to slip into, which is exactly the property TERRAIN_CONTRACT §5 asks for:
 *  a jungle full of camps leaves lane waves bit-identical. Any future edit that
 *  wants to count units here must filter with `isPlayerTeam(e.team)` first. */
function stepWaves(w: SimWorld): void {
  if (w.tick < w.nextWaveTick) return;
  const waveNo = w.waveIndex + 1; // 1-based wave number
  // Growth is piecewise, NOT a base-swap on the absolute wave index.
  //
  // This used to read `pow(1 + (overtime ? SURGE : WAVE), waveIndex)`, which
  // applied the overtime surge RETROACTIVELY to every wave since minute zero.
  // At OVERTIME_AT_S (11:00, wave 22) the multiplier jumped 1.52x -> 9.9x in a
  // single wave — melee creeps went from 32 damage / 682 hp to 209 / 4470 — and
  // kept compounding at 11% on the absolute index (65x by wave 40). Creeps
  // simply started killing everyone at a fixed clock time in every match.
  //
  // The surge is meant to compound FROM the overtime boundary: normal growth up
  // to it, then the faster rate on the waves elapsed since. This is continuous
  // across the boundary (1.02^21 = 1.52 -> 1.02^22 * 1.11^0 = 1.55).
  const otIndex = Math.ceil(OVERTIME_AT_S / WAVE_PERIOD_S);
  const baseMult = Math.pow(1 + WAVE_GROWTH, Math.min(w.waveIndex, otIndex));
  const surgeMult = w.overtime
    ? Math.pow(1 + SURGE_WAVE_GROWTH, Math.max(0, w.waveIndex - otIndex))
    : 1;
  const growthMult = baseMult * surgeMult;
  let melee = WAVE_MELEE;
  if (w.overtime) {
    melee += Math.floor((w.tick * TICK_DT - OVERTIME_AT_S) / SURGE_EXTRA_MELEE_PERIOD_S);
  }
  const siege = waveNo % SIEGE_EVERY_NTH_WAVE === 0 ? 1 : 0;
  for (let lane = 0; lane < w.map.lanes; lane++) {
    for (const team of [0, 1] as const) {
      spawnWaveLane(w, lane, team, melee, WAVE_RANGED, siege, growthMult);
    }
  }
  w.waveIndex += 1;
  w.nextWaveTick += Math.round(WAVE_PERIOD_S * TICK_RATE);
}

/** HERO respawn only. A neutral camp creep also carries a `respawnAtTick`-shaped
 *  timer on its CampState, but camps respawn whole through stepCamps — nothing
 *  here may pick one up. Two guards with DISJOINT coverage do that work: the
 *  kind test excludes every non-hero mobile (which is what the camp kinds are),
 *  and the isPlayerTeam narrowing excludes the case the kind test cannot see —
 *  a hero-kind entity on NEUTRAL_TEAM — while also being what makes
 *  `fountainSpot`, which takes a TeamId, legal to call. Neither is redundant
 *  with the other; reverting either one alone turns a test in units.test.ts red. */
function stepRespawns(w: SimWorld): void {
  for (const e of w.mobileMap.values()) {
    if (e.kind !== 'hero') continue;
    if (e.alive || e.respawnAtTick <= 0) continue;
    if (w.tick < e.respawnAtTick) continue;
    const team = e.team;
    if (!isPlayerTeam(team)) continue; // a neutral has no fountain to return to
    e.alive = true;
    e.respawnAtTick = 0;
    const spot = w.fountainSpot(team, 0);
    e.x = spot[0] ?? e.x;
    e.z = spot[1] ?? e.z;
    e.stunUntilTick = 0;
    e.slowPct = 0;
    e.slowUntilTick = 0;
    e.dashUntilTick = 0;
    e.order = 'idle';
    e.orderTarget = -1;
    e.lastHitBy = -1;
    e.recentDamagers.length = 0;
    // Timed auras die with the hero; permanent self-passives persist.
    const arr = e.auras;
    for (let i = arr.length - 1; i >= 0; i--) {
      const a = arr[i];
      if (a && a.untilTick !== 0) {
        const top = arr.pop();
        if (top !== undefined && i < arr.length) arr[i] = top;
      }
    }
    w.recomputeEnt(e);
    e.hp = e.maxHp;
    e.mana = e.maxMana;
  }
}

/** Lifetime expiry. The abilities engine retires its projectiles and capped
 *  summons by stamping expireAtTick = world.tick, so this reaps ALL expired
 *  mobiles — projs included. No loot on expiry; heroes are exempt.
 *
 *  Camp members are exempt too, by two guards that cover different cases.
 *  The sentinel test is `<= 0`, not `=== 0` (sim/types.ts, AMENDMENT_1 §B.3):
 *  any non-positive stamp means "never expires", which matters because camps
 *  spawn with -1 (TERRAIN_CONTRACT §5) and a strict `=== 0` would read -1 as a
 *  tick already in the past and reap the entire jungle on its first tick. That
 *  sentinel protects every kind, not just camps. The isCampKind test then
 *  covers what the sentinel cannot: a camp member carrying a POSITIVE stamp,
 *  which keeps the exemption independent of how camps.ts stamps its spawns. */
function stepExpiry(w: SimWorld): void {
  w.deadBuf.length = 0;
  for (const e of w.mobileMap.values()) {
    if (e.expireAtTick <= 0 || w.tick < e.expireAtTick) continue;
    if (e.kind === 'hero' || isCampKind(e.kind)) continue;
    w.deadBuf.push(e);
  }
  for (const e of w.deadBuf) {
    w.mobileMap.delete(e.id);
    w.base.delete(e.id);
    w.passiveAuras.delete(e.id);
  }
  w.deadBuf.length = 0;
}

export function stepUnits(w: SimWorld): void {
  // Passive gold from match start, for every hero, living or dead.
  for (const e of w.mobileMap.values()) {
    if (e.kind !== 'hero') continue;
    const g = PASSIVE_GOLD_PER_S * TICK_DT;
    e.gold += g;
    e.goldEarned += g;
  }
  // Regen + fountain heal (living mobiles; only heroes have mana pools).
  for (const e of w.mobileMap.values()) {
    if (!e.alive) continue;
    if (e.hpRegen > 0 && e.hp < e.maxHp) {
      e.hp = Math.min(e.maxHp, e.hp + e.hpRegen * TICK_DT);
    }
    if (e.kind !== 'hero') continue;
    if (e.manaRegen > 0 && e.mana < e.maxMana) {
      e.mana = Math.min(e.maxMana, e.mana + e.manaRegen * TICK_DT);
    }
    // The fountain test goes through w.atOwnFountain, the same predicate the
    // shop gates on, so this file never indexes a per-team tuple by an entity's
    // team at all. An entity with no fountain of its own — anything neutral —
    // simply gets no fountain tick.
    if (!w.atOwnFountain(e)) continue;
    e.hp = Math.min(e.maxHp, e.hp + e.maxHp * FOUNTAIN_HEAL_PCT * TICK_DT);
    e.mana = Math.min(e.maxMana, e.mana + e.maxMana * FOUNTAIN_MANA_PCT * TICK_DT);
  }
  // Team ward stock restock: +1 per WARD_RESTOCK_S up to WARD_TEAM_STOCK.
  // wardStockArr is a two-element per-team tuple and is indexed here by the
  // TeamId literals 0 and 1 only — never by an entity's team — so no neutral
  // event (a camp dying, a camp spawning) can reach it.
  const restockTicks = Math.round(WARD_RESTOCK_S * TICK_RATE);
  if (w.tick - w.lastRestockTick >= restockTicks) {
    w.lastRestockTick += restockTicks;
    w.wardStockArr[0] = Math.min(WARD_TEAM_STOCK, (w.wardStockArr[0] ?? 0) + 1);
    w.wardStockArr[1] = Math.min(WARD_TEAM_STOCK, (w.wardStockArr[1] ?? 0) + 1);
  }
  stepRespawns(w);
  stepExpiry(w);
  stepWaves(w);
}
