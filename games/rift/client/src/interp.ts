// ============================================================================
// ANCIENTS (rift) — INTERP (T8). Snapshot buffer + entity interpolation.
// CONTRACT §6: render 2 snaps (100ms) behind; interpolate positions between
// the two most recent snapshots that contain each entity.
//
// THE GHOST RULES (handoff §2.4 — where the bugs live):
//   * an entity that VANISHES from the newest snapshot leaves a ghost at its
//     last known (interpolated, as-last-seen) position that fades over 0.5s —
//     never snap to origin, never interpolate toward a stale target;
//   * an entity that REAPPEARS spawns its interpolation fresh from the new
//     position (from == to) — never lerp from where it was five seconds ago;
//   * structures NEVER ghost (they are in every snapshot by protocol; if one
//     is ever absent it is simply dropped).
//
// NEUTRALS (`EntTeam` = `TeamId | 2`). `InterpEnt.team` and `GhostEnt.team` are
// widened, so jungle camps arrive here on the same path as players' units. This
// module indexes NOTHING per team — no colour tuple, no marker table, no
// per-team array — so it needs no `isPlayerTeam` narrowing; its whole
// obligation is to carry the value through unchanged (`copyAux`, `makeSlot`,
// and the ghost copy in `push`), and to treat a camp as the ordinary mobile
// entity it is: camps are not structures, so they DO ghost when they walk out
// of vision. The narrowing obligation lands on the consumers that do index —
// ui/nameLabels.ts, ui/minimap.ts, render/units.ts.
//
// No per-frame allocation: one Slot per entity id holds a pooled InterpEnt and
// a pooled GhostEnt that are mutated in place; the two output arrays are
// reused across calls. Slots live in an array kept sorted by entity id
// (binary-search insert), so sample()/ghosts() order is deterministic and no
// sort runs per frame.
// ============================================================================
import type { EntKind, EntSnap } from '@rift/shared';
import type { GhostEnt, InterpEnt, InterpHandle, SnapMsg } from './contract.js';

/** Render delay behind the newest snapshot: 2 ticks at 20Hz (CONTRACT §6). */
const RENDER_DELAY_MS = 100;
/** Ghost fade duration (CONTRACT §6: 0.5s). */
const GHOST_FADE_MS = 500;

function isStructure(k: EntKind): boolean {
  return k === 'tower' || k === 'guard' || k === 'ancient';
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

interface Slot {
  readonly ent: InterpEnt; // pooled output object — mutated, never re-created
  readonly ghost: GhostEnt; // pooled ghost marker — mutated, never re-created
  fromX: number;
  fromZ: number;
  fromT: number; // arrival ms of the snap `from` was taken from
  toX: number;
  toZ: number;
  toT: number; // arrival ms of the newest snap containing this id
  seenPush: number; // push counter of the newest snap containing this id
  ghostStart: number; // ms the ghost appeared; <0 = no active ghost
}

/** Copy the newest wire data into the pooled output ent (optional fields are
 *  deleted when absent — `atk` in particular is transient per snap and drives
 *  tracer transitions in fx). */
function copyAux(dst: InterpEnt, src: EntSnap): void {
  dst.k = src.k;
  dst.team = src.team;
  dst.hp = src.hp;
  dst.maxHp = src.maxHp;
  if (src.lvl !== undefined) dst.lvl = src.lvl;
  else delete dst.lvl;
  if (src.hero !== undefined) dst.hero = src.hero;
  else delete dst.hero;
  if (src.pid !== undefined) dst.pid = src.pid;
  else delete dst.pid;
  if (src.atk !== undefined) dst.atk = src.atk;
  else delete dst.atk;
  if (src.tx !== undefined) dst.tx = src.tx;
  else delete dst.tx;
  if (src.tz !== undefined) dst.tz = src.tz;
  else delete dst.tz;
  if (src.fx !== undefined) dst.fx = src.fx;
  else delete dst.fx;
}

export function createInterp(): InterpHandle {
  let slots: Slot[] = []; // sorted by ent.id
  let pushCount = 0;
  let latestMsg: SnapMsg | null = null;
  const outEnts: InterpEnt[] = [];
  const outGhosts: GhostEnt[] = [];

  /** Index of the slot with `id`, or the bitwise-NOT insertion point. */
  function slotIndex(id: number): number {
    let lo = 0;
    let hi = slots.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const s = slots[mid];
      if (s === undefined) break; // unreachable: mid < hi <= length
      if (s.ent.id < id) lo = mid + 1;
      else hi = mid;
    }
    return lo < slots.length && slots[lo]?.ent.id === id ? lo : ~lo;
  }

  function makeSlot(e: EntSnap): Slot {
    const ent: InterpEnt = {
      id: e.id,
      k: e.k,
      team: e.team,
      x: e.x,
      z: e.z,
      hp: e.hp,
      maxHp: e.maxHp,
    };
    const ghost: GhostEnt = { id: e.id, k: e.k, team: e.team, x: e.x, z: e.z, fade: 1 };
    copyAux(ent, e);
    return {
      ent,
      ghost,
      fromX: e.x,
      fromZ: e.z,
      fromT: 0,
      toX: e.x,
      toZ: e.z,
      toT: 0,
      seenPush: 0,
      ghostStart: -1,
    };
  }

  /** The render position of a slot at `nowMs`: interpolation between its two
   *  most recent sightings, RENDER_DELAY_MS behind, clamped at both ends
   *  (never extrapolates past the newest known position — a starved buffer
   *  freezes in place rather than guessing). */
  function writePosition(slot: Slot, nowMs: number, out: { x: number; z: number }): void {
    const span = slot.toT - slot.fromT;
    if (span <= 0) {
      out.x = slot.toX;
      out.z = slot.toZ;
      return;
    }
    const a = clamp01((nowMs - RENDER_DELAY_MS - slot.fromT) / span);
    out.x = slot.fromX + (slot.toX - slot.fromX) * a;
    out.z = slot.fromZ + (slot.toZ - slot.fromZ) * a;
  }

  const scratch = { x: 0, z: 0 }; // module-lifetime scratch, no per-call alloc

  function push(msg: SnapMsg): void {
    pushCount++;
    latestMsg = msg;
    const now = performance.now();
    for (const e of msg.ents) {
      const idx = slotIndex(e.id);
      let slot: Slot;
      if (idx >= 0) {
        const found = slots[idx];
        if (found === undefined) continue; // unreachable: idx >= 0 means a hit
        slot = found;
      } else {
        slot = makeSlot(e);
        slots.splice(~idx, 0, slot); // event-time insert, keeps id sort order
      }
      if (slot.seenPush === pushCount - 1) {
        // Continuous presence: shift the interpolation window one snap forward.
        slot.fromX = slot.toX;
        slot.fromZ = slot.toZ;
        slot.fromT = slot.toT;
      } else {
        // Brand-new or REAPPEARING entity: fresh interpolation from the new
        // position (from == to) — never lerp from a stale position.
        slot.fromX = e.x;
        slot.fromZ = e.z;
        slot.fromT = now;
      }
      slot.toX = e.x;
      slot.toZ = e.z;
      slot.toT = now;
      slot.seenPush = pushCount;
      slot.ghostStart = -1; // visible now: any old ghost is superseded
      copyAux(slot.ent, e);
    }
    // Vanish detection: present in the immediately previous push, absent now.
    for (const slot of slots) {
      if (slot.seenPush !== pushCount - 1) continue;
      if (isStructure(slot.ent.k)) continue; // structures never ghost
      // The ghost sits at the position the player LAST SAW — the interpolated
      // render position right now, which is never the origin and never a raw
      // snap endpoint the unit had not visibly reached yet.
      writePosition(slot, now, scratch);
      slot.ghost.k = slot.ent.k;
      slot.ghost.team = slot.ent.team;
      slot.ghost.x = scratch.x;
      slot.ghost.z = scratch.z;
      slot.ghost.fade = 1;
      slot.ghostStart = now;
    }
  }

  function sample(): readonly InterpEnt[] {
    const now = performance.now();
    outEnts.length = 0;
    for (const slot of slots) {
      if (slot.seenPush !== pushCount) continue; // vanished: ghost, not ent
      writePosition(slot, now, scratch);
      slot.ent.x = scratch.x;
      slot.ent.z = scratch.z;
      outEnts.push(slot.ent);
    }
    return outEnts;
  }

  function ghosts(): readonly GhostEnt[] {
    const now = performance.now();
    outGhosts.length = 0;
    for (const slot of slots) {
      if (slot.ghostStart < 0) continue;
      const fade = 1 - (now - slot.ghostStart) / GHOST_FADE_MS;
      if (fade <= 0) {
        slot.ghostStart = -1; // faded out: retire the marker
        continue;
      }
      slot.ghost.fade = fade;
      outGhosts.push(slot.ghost);
    }
    return outGhosts;
  }

  function latest(): SnapMsg | null {
    return latestMsg;
  }

  return { push, sample, ghosts, latest };
}
