// RIFT audio — T3: event derivation.
//
// Turns server snapshots (`rift_snap`) and wire events (`RiftEvent`) into the rich
// `AudioEvent` stream the cue layer plays from. PURE: no WebAudio, no DOM, no timers, no
// `Date.now()` — every fact used here comes from the snapshot, the wire event, or the
// `AudioWorldCtx` passed in, plus this module's own internal diff-baseline memory. That is
// what makes it unit-testable under vitest's node environment (see AUDIO_CONTRACT.md §T3).
//
// Tick domains matter: `snap.tick` is a snapshot SEQUENCE NUMBER (used only for the
// out-of-order guard below); `snap.matchTick` is the simulation clock. Every cooldown /
// respawn comparison in this file uses `matchTick`, never `tick`.

import { heroById } from '@rift/shared';
import type {
  AttackerKind,
  AudioEvent,
  AudioEventTag,
  AudioWorldCtx,
  CastColour,
  CreateDeriver,
  DeriverHandle,
  EntKind,
  EntSnap,
  RiftEvent,
  SnapMsg,
  TeamId,
  YouSnap,
} from './contract.js';
import { DERIVE, EVENT_PRIORITY } from './config.js';

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

/** hp/maxHp, never NaN/Infinity: maxHp <= 0 reads as fraction 0. */
function hpFraction(hp: number, maxHp: number): number {
  return maxHp > 0 ? hp / maxHp : 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lo = sorted[mid - 1];
    const hi = sorted[mid];
    return lo === undefined || hi === undefined ? 0 : (lo + hi) / 2;
  }
  const m = sorted[mid];
  return m === undefined ? 0 : m;
}

/** tower/guard/ancient collapse to the single 'tower' archetype everywhere in this
 *  module — the same collapsing `attack.kind` and the `hit` school table both rely on. */
function isStructureKind(k: EntKind): boolean {
  return k === 'tower' || k === 'guard' || k === 'ancient';
}

/** AttackerKind for a swinging entity, or null when the kind cannot swing (e.g. 'ward',
 *  already-excluded 'proj'). Mirrors `Game.combatFx`'s tracer-kind switch. */
function attackerKind(k: EntKind): AttackerKind | null {
  if (isStructureKind(k)) return 'tower';
  if (k === 'hero' || k === 'melee' || k === 'ranged' || k === 'siege' || k === 'shade') return k;
  return null;
}

/** True when a hero (by base stats) fights at range, per `DERIVE`'s implicit melee/ranged
 *  split — the same > 3 m threshold used for both `attack.ranged` and `hit.school`. */
function isRangedHero(e: EntSnap): boolean {
  return e.hero !== undefined && heroById(e.hero).base.attackRange > 3;
}

function isRangedAttacker(kind: AttackerKind, e: EntSnap): boolean {
  if (kind === 'ranged' || kind === 'siege' || kind === 'tower') return true;
  if (kind === 'hero') return isRangedHero(e);
  return false;
}

/** Physical-damage attacker archetypes for `hit.school`: melee/siege/hero-melee/tower. */
function isPhysicalAttacker(e: EntSnap): boolean {
  if (e.k === 'melee' || e.k === 'siege' || isStructureKind(e.k)) return true;
  if (e.k === 'hero') return !isRangedHero(e);
  return false;
}

/** Cast damage/utility colour from an ability's effects, per the precedence documented on
 *  `CastColour`: damage(physical) > damage(magic) > heal > dash > stun|slow (control) >
 *  summon > buff. */
function castColour(effects: ReturnType<typeof heroById>['abilities'][number]['effects']): CastColour {
  let hasMagicDamage = false;
  let hasHeal = false;
  let hasDash = false;
  let hasControl = false;
  let hasSummon = false;
  for (const eff of effects) {
    if (eff.kind === 'damage') {
      if (eff.school === 'physical') return 'physical';
      hasMagicDamage = true;
    } else if (eff.kind === 'heal') {
      hasHeal = true;
    } else if (eff.kind === 'dash') {
      hasDash = true;
    } else if (eff.kind === 'stun' || eff.kind === 'slow') {
      hasControl = true;
    } else if (eff.kind === 'summon') {
      hasSummon = true;
    }
  }
  if (hasMagicDamage) return 'magic';
  if (hasHeal) return 'heal';
  if (hasDash) return 'dash';
  if (hasControl) return 'control';
  if (hasSummon) return 'summon';
  return 'buff';
}

function findEntById(snap: SnapMsg, id: number): EntSnap | null {
  for (const e of snap.ents) {
    if (e.id === id) return e;
  }
  return null;
}

function findEntByPid(snap: SnapMsg, pid: string): EntSnap | null {
  for (const e of snap.ents) {
    if (e.pid === pid) return e;
  }
  return null;
}

function teamOfPid(snap: SnapMsg, pid: string): TeamId | null {
  for (const b of snap.board) {
    if (b.id === pid) return b.team;
  }
  const e = findEntByPid(snap, pid);
  return e === null ? null : e.team;
}

/** Cap output at `DERIVE.maxPerSnap`, dropping by `EVENT_PRIORITY` (highest number —
 *  least important — first). The relative order of events that survive is left exactly as
 *  generated, so "newest last" chronology inside one snapshot is preserved for everything
 *  that isn't dropped. */
function capEvents(events: readonly AudioEvent[]): readonly AudioEvent[] {
  if (events.length <= DERIVE.maxPerSnap) return events;
  const excess = events.length - DERIVE.maxPerSnap;
  const order = events.map((_, i) => i);
  // Sort a copy of the indices worst-first (highest priority number first; ties broken by
  // dropping the later-generated one first) so the FRONT of this array is exactly what
  // should be dropped.
  order.sort((ia, ib) => {
    const ea = events[ia];
    const eb = events[ib];
    if (ea === undefined || eb === undefined) return 0;
    const pa = EVENT_PRIORITY[ea.t];
    const pb = EVENT_PRIORITY[eb.t];
    if (pa !== pb) return pb - pa;
    return ib - ia;
  });
  const dropped = new Set<number>(order.slice(0, excess));
  const kept: AudioEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    if (dropped.has(i)) continue;
    const e = events[i];
    if (e !== undefined) kept.push(e);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export const createDeriver: CreateDeriver = () => {
  let hasBaseline = false;
  let prevSnap: SnapMsg | null = null;
  /** -1 = not currently in any low-HP band; otherwise the deepest armed band index. */
  let lowHpArmedBand = -1;
  let ancientThreatArmed = false;

  function resetBaseline(): void {
    hasBaseline = false;
    prevSnap = null;
    lowHpArmedBand = -1;
    ancientThreatArmed = false;
  }

  function deriveAttacks(snap: SnapMsg, prevById: Map<number, EntSnap>, ctx: AudioWorldCtx): AudioEvent[] {
    const out: AudioEvent[] = [];
    for (const e of snap.ents) {
      if (e.atk === undefined || e.k === 'proj') continue;
      const p = prevById.get(e.id);
      if (p !== undefined && p.atk === e.atk) continue; // same swing, already emitted
      const kind = attackerKind(e.k);
      if (kind === null) continue;
      out.push({
        t: 'attack',
        kind,
        ranged: isRangedAttacker(kind, e),
        x: e.x,
        z: e.z,
        self: e.id === ctx.selfEntId,
        visible: ctx.isVisible(e.x, e.z),
      });
    }
    return out;
  }

  function deriveHits(
    snap: SnapMsg,
    prevById: Map<number, EntSnap>,
    curById: Map<number, EntSnap>,
    ctx: AudioWorldCtx,
  ): AudioEvent[] {
    type Candidate = { readonly victim: EntSnap; readonly drop: number };
    const candidates: Candidate[] = [];
    for (const e of snap.ents) {
      const p = prevById.get(e.id);
      if (p === undefined) continue;
      const drop = p.hp - e.hp;
      if (drop >= DERIVE.hitMinHp) candidates.push({ victim: e, drop });
    }
    if (candidates.length === 0) return [];
    const med = median(candidates.map((c) => c.drop));
    const out: AudioEvent[] = [];
    for (const c of candidates) {
      const victim = c.victim;
      let physical = false;
      for (const e of snap.ents) {
        if (e.atk !== victim.id) continue;
        if (isPhysicalAttacker(e)) {
          physical = true;
          break;
        }
      }
      out.push({
        t: 'hit',
        school: physical ? 'physical' : 'magic',
        crit: c.drop > med * 1.6,
        x: victim.x,
        z: victim.z,
        self: victim.id === ctx.selfEntId,
        visible: ctx.isVisible(victim.x, victim.z),
      });
    }
    // keep curById referenced so a future maintainer sees it is intentionally unused here —
    // hit position/visibility come from the CURRENT snapshot's victim, already `e`/`victim`.
    void curById;
    return out;
  }

  function deriveUnitDeaths(
    prev: SnapMsg,
    curById: Map<number, EntSnap>,
    ctx: AudioWorldCtx,
  ): AudioEvent[] {
    const out: AudioEvent[] = [];
    for (const p of prev.ents) {
      if (p.pid !== undefined) continue;
      if (isStructureKind(p.k) || p.k === 'proj') continue;
      if (curById.has(p.id)) continue; // still present, or merely walked out of vision
      if (!ctx.isVisible(p.x, p.z)) continue;
      out.push({ t: 'unitDeath', kind: p.k, x: p.x, z: p.z, visible: true });
    }
    return out;
  }

  function deriveHurt(you: YouSnap | null, prevYou: YouSnap | null): AudioEvent[] {
    if (you === null || prevYou === null) return [];
    const drop = prevYou.hp - you.hp;
    if (!(you.hp < prevYou.hp - DERIVE.hurtMinHp)) return [];
    return [
      {
        t: 'hurt',
        frac: drop / Math.max(1, you.maxHp),
        hpFrac: hpFraction(you.hp, you.maxHp),
        x: you.x,
        z: you.z,
      },
    ];
  }

  function deriveLowHp(you: YouSnap | null): AudioEvent[] {
    if (you === null) {
      // No local hero to track (e.g. spectating): nothing to re-arm against, nothing to say.
      return [];
    }
    const hpFrac = hpFraction(you.hp, you.maxHp);
    let band = -1;
    for (let i = 0; i < DERIVE.lowHpBands.length; i++) {
      const threshold = DERIVE.lowHpBands[i];
      if (threshold !== undefined && hpFrac < threshold) band = i;
    }
    const out: AudioEvent[] = [];
    if (band > lowHpArmedBand) {
      out.push({ t: 'lowHp', band, hpFrac });
      lowHpArmedBand = band;
    } else if (band === -1 && lowHpArmedBand !== -1) {
      out.push({ t: 'lowHp', band: -1, hpFrac });
      lowHpArmedBand = -1;
    }
    return out;
  }

  function deriveGold(you: YouSnap | null, prevYou: YouSnap | null, sawUnitDeath: boolean): AudioEvent[] {
    if (you === null || prevYou === null) return [];
    const delta = you.gold - prevYou.gold;
    if (delta < DERIVE.goldMinDelta) return [];
    return [
      {
        t: 'gold',
        amount: delta,
        lastHit: delta >= DERIVE.lastHitMinGold && sawUnitDeath,
      },
    ];
  }

  function deriveLevelUp(you: YouSnap | null, prevYou: YouSnap | null): AudioEvent[] {
    if (you === null || prevYou === null) return [];
    if (you.level > prevYou.level && you.level > 1) return [{ t: 'levelUp', level: you.level }];
    return [];
  }

  function deriveSkillPoint(you: YouSnap | null, prevYou: YouSnap | null): AudioEvent[] {
    if (you === null || prevYou === null) return [];
    if (you.skillPoints > prevYou.skillPoints) {
      return [{ t: 'skillPointAvailable', count: you.skillPoints }];
    }
    return [];
  }

  function deriveAbilityReady(
    you: YouSnap | null,
    prevYou: YouSnap | null,
    prevMatchTick: number,
    matchTick: number,
  ): AudioEvent[] {
    if (you === null || prevYou === null) return [];
    const out: AudioEvent[] = [];
    for (let slot = 0; slot < you.abilities.length; slot++) {
      const cur = you.abilities[slot];
      const prevAbility = prevYou.abilities[slot];
      if (cur === undefined || prevAbility === undefined) continue;
      const wasOnCd = prevAbility.cdUntilTick > prevMatchTick;
      const isReady = cur.cdUntilTick <= matchTick;
      if (wasOnCd && isReady && cur.rank > 0) out.push({ t: 'abilityReady', slot });
    }
    return out;
  }

  function deriveRespawn(
    you: YouSnap | null,
    prevYou: YouSnap | null,
    prevMatchTick: number,
  ): AudioEvent[] {
    if (you === null || prevYou === null) return [];
    const wasRespawning = prevYou.respawnAtTick > 0 && prevMatchTick < prevYou.respawnAtTick;
    if (wasRespawning && you.respawnAtTick === 0) return [{ t: 'respawn' }];
    return [];
  }

  function deriveAncientThreat(
    prev: SnapMsg,
    snap: SnapMsg,
    prevById: Map<number, EntSnap>,
    curById: Map<number, EntSnap>,
    ctx: AudioWorldCtx,
  ): AudioEvent[] {
    if (ctx.selfTeam === null) return [];
    let ownAncientCur: EntSnap | null = null;
    for (const e of curById.values()) {
      if (e.k === 'ancient' && e.team === ctx.selfTeam) {
        ownAncientCur = e;
        break;
      }
    }
    if (ownAncientCur === null || ownAncientCur.maxHp <= 0) return [];
    let ownAncientPrev: EntSnap | null = null;
    for (const e of prevById.values()) {
      if (e.k === 'ancient' && e.team === ctx.selfTeam) {
        ownAncientPrev = e;
        break;
      }
    }
    if (ownAncientPrev === null || ownAncientPrev.maxHp <= 0) return [];
    const prevFrac = hpFraction(ownAncientPrev.hp, ownAncientPrev.maxHp);
    const curFrac = hpFraction(ownAncientCur.hp, ownAncientCur.maxHp);
    const out: AudioEvent[] = [];
    if (!ancientThreatArmed && prevFrac >= DERIVE.ancientThreatFrac && curFrac < DERIVE.ancientThreatFrac) {
      out.push({ t: 'ancientThreat', hpFrac: curFrac });
      ancientThreatArmed = true;
    } else if (ancientThreatArmed && curFrac >= DERIVE.ancientThreatFrac) {
      ancientThreatArmed = false;
    }
    // prev/snap kept only for symmetry/readability with the other derive* helpers.
    void prev;
    void snap;
    return out;
  }

  const handle: DeriverHandle = {
    snapshot(snap, ctx) {
      try {
        if (!hasBaseline) {
          hasBaseline = true;
          prevSnap = snap;
          lowHpArmedBand = -1;
          if (snap.you !== null) {
            const hpFrac = hpFraction(snap.you.hp, snap.you.maxHp);
            for (let i = 0; i < DERIVE.lowHpBands.length; i++) {
              const threshold = DERIVE.lowHpBands[i];
              if (threshold !== undefined && hpFrac < threshold) lowHpArmedBand = i;
            }
          }
          ancientThreatArmed = false;
          if (ctx.selfTeam !== null) {
            for (const e of snap.ents) {
              if (e.k === 'ancient' && e.team === ctx.selfTeam && e.maxHp > 0) {
                ancientThreatArmed = hpFraction(e.hp, e.maxHp) < DERIVE.ancientThreatFrac;
                break;
              }
            }
          }
          return [];
        }

        const prev = prevSnap;
        if (prev === null) return []; // unreachable given hasBaseline, but keeps this pure/safe

        if (snap.tick <= prev.tick) return []; // out-of-order: return empty, change nothing

        const prevById = new Map<number, EntSnap>();
        for (const e of prev.ents) prevById.set(e.id, e);
        const curById = new Map<number, EntSnap>();
        for (const e of snap.ents) curById.set(e.id, e);

        const unitDeaths = deriveUnitDeaths(prev, curById, ctx);

        const candidates: AudioEvent[] = [
          ...deriveAttacks(snap, prevById, ctx),
          ...deriveHits(snap, prevById, curById, ctx),
          ...unitDeaths,
          ...deriveHurt(snap.you, prev.you),
          ...deriveLowHp(snap.you),
          ...deriveGold(snap.you, prev.you, unitDeaths.length > 0),
          ...deriveLevelUp(snap.you, prev.you),
          ...deriveSkillPoint(snap.you, prev.you),
          ...deriveAbilityReady(snap.you, prev.you, prev.matchTick, snap.matchTick),
          ...deriveRespawn(snap.you, prev.you, prev.matchTick),
          ...deriveAncientThreat(prev, snap, prevById, curById, ctx),
        ];

        prevSnap = snap;
        return capEvents(candidates);
      } catch {
        return [];
      }
    },

    wire(ev, snap, ctx) {
      try {
        return deriveWire(ev, snap, ctx);
      } catch {
        return [];
      }
    },

    reset() {
      resetBaseline();
    },
  };

  return handle;
};

// ---------------------------------------------------------------------------
// wire event mapping
// ---------------------------------------------------------------------------

function deriveWire(ev: RiftEvent, snap: SnapMsg | null, ctx: AudioWorldCtx): readonly AudioEvent[] {
  switch (ev.t) {
    case 'rift_cast': {
      const caster = snap === null ? null : findEntById(snap, ev.id);
      const self = caster !== null && caster.pid !== undefined && caster.pid === ctx.selfPid;
      const visible = ctx.isVisible(ev.x, ev.z);

      if (ev.slot >= 4) {
        // Item active. Inventory is private: only populate `item` for the local player.
        const item = self && snap !== null && snap.you !== null ? snap.you.items[ev.slot - 4] ?? null : null;
        return [
          {
            t: 'cast',
            hero: null,
            slot: ev.slot,
            item,
            colour: 'buff',
            ult: false,
            x: ev.x,
            z: ev.z,
            self,
            visible,
          },
        ];
      }

      if (caster !== null && caster.hero !== undefined) {
        const def = heroById(caster.hero);
        const ability = def.abilities[ev.slot];
        if (ability !== undefined) {
          return [
            {
              t: 'cast',
              hero: caster.hero,
              slot: ev.slot,
              item: null,
              colour: castColour(ability.effects),
              ult: ability.ult,
              x: ev.x,
              z: ev.z,
              self,
              visible,
            },
          ];
        }
      }

      // Caster unresolved (event outran the snapshot, or the caster already vanished):
      // degrade to a generic, un-attributed cast rather than dropping it silently.
      return [
        {
          t: 'cast',
          hero: null,
          slot: ev.slot,
          item: null,
          colour: 'buff',
          ult: false,
          x: ev.x,
          z: ev.z,
          self,
          visible,
        },
      ];
    }

    case 'rift_kill': {
      const self = ev.victim === ctx.selfPid;
      const byMe = ev.killer !== null && ev.killer === ctx.selfPid;
      let x = 0;
      let z = 0;
      let visible = false;
      let resolvedPos = false;
      if (snap !== null) {
        const victimEnt = findEntByPid(snap, ev.victim);
        if (victimEnt !== null) {
          x = victimEnt.x;
          z = victimEnt.z;
          resolvedPos = true;
        } else if (self && snap.you !== null) {
          x = snap.you.x;
          z = snap.you.z;
          resolvedPos = true;
        }
      }
      if (resolvedPos) visible = ctx.isVisible(x, z);

      let friendly = false;
      if (snap !== null && ctx.selfTeam !== null) {
        const team = teamOfPid(snap, ev.victim);
        friendly = team !== null && team === ctx.selfTeam;
      }

      return [
        {
          t: 'heroDeath',
          self,
          friendly,
          byMe,
          firstBlood: ev.firstBlood,
          x,
          z,
          visible,
        },
      ];
    }

    case 'rift_structure': {
      let x = 0;
      let z = 0;
      if (snap !== null) {
        for (const e of snap.ents) {
          if (e.k === ev.kind && e.team === ev.team && e.hp <= 0) {
            x = e.x;
            z = e.z;
            break;
          }
        }
      }
      return [
        {
          t: 'structure',
          kind: ev.kind,
          friendly: ev.team === ctx.selfTeam,
          x,
          z,
        },
      ];
    }

    case 'rift_surge':
      return [{ t: 'surge' }];

    case 'rift_pick':
      if (ev.hero === null) return [];
      return [{ t: 'heroPick', hero: ev.hero, self: ev.id === ctx.selfPid }];

    case 'rift_roster':
      return [];

    case 'rift_end':
      return [
        {
          t: 'matchEnd',
          won: ev.winner !== null && ev.winner === ctx.selfTeam,
          draw: ev.reason === 'draw' || ev.winner === null,
        },
      ];

    default: {
      const _exhaustive: never = ev;
      return _exhaustive;
    }
  }
}

// Re-exported only so `AudioEventTag` stays referenced for reviewers grepping this file for
// contract usage; `capEvents` is the actual consumer.
export type { AudioEventTag };
