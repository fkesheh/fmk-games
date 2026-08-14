// ============================================================================
// ANCIENTS (rift) — PROTOCOL. Wire shapes + validators. The platform routes
// any {t:string} it does not own RAW to the room; parseRiftC2S is the only
// door into the sim, and it never throws — bad input is dropped in silence.
// parseRiftSettings THROWS Error(message); the platform converts that to
// {t:'error',code:'bad_settings'}. Frozen: server and client both import
// these; neither revalidates differently.
// ============================================================================
import { INVENTORY_SLOTS, MAP_COORD_MAX, MAX_TEAM_SIZE, MIN_TEAM_SIZE } from './config.js';
import { isHeroId, type HeroId } from './hero.js';
import { isItemId, type ItemId } from './item.js';
import type {
  BoardEntry,
  EndReason,
  EntSnap,
  Phase,
  PlayerStats,
  RiftSettings,
  RosterEntry,
  TeamId,
  YouSnap,
} from './types.js';

// --- Client -> server -------------------------------------------------------------
export type RiftC2S =
  | { readonly t: 'rift_pick'; readonly hero: HeroId }
  | { readonly t: 'rift_start' }
  | { readonly t: 'rift_order'; readonly kind: 'move' | 'attackmove'; readonly x: number; readonly z: number }
  | { readonly t: 'rift_order'; readonly kind: 'attack'; readonly target: number }
  | { readonly t: 'rift_order'; readonly kind: 'stop' }
  | { readonly t: 'rift_cast'; readonly slot: number; readonly x?: number; readonly z?: number; readonly target?: number }
  | { readonly t: 'rift_item'; readonly slot: number; readonly x?: number; readonly z?: number }
  | { readonly t: 'rift_buy'; readonly item: ItemId }
  /** Sell the item in `slot` back for SELL_REFUND of its TOTAL gold cost
   *  (item.ts sellValue). Gated exactly like `rift_buy`: alive, and inside your
   *  own fountain radius — the shop gate, not a second one. */
  | { readonly t: 'rift_sell'; readonly slot: number }
  /** Discard the item in `slot` from ANYWHERE, alive, for no refund. The
   *  escape hatch for a full inventory away from the fountain. */
  | { readonly t: 'rift_drop'; readonly slot: number }
  | { readonly t: 'rift_skill'; readonly slot: number };

// --- Server -> client ---------------------------------------------------------------
export type RiftS2C =
  | {
      readonly t: 'rift_hello';
      readonly you: string;
      readonly roomId: string;
      readonly code: string | null;
      readonly team: TeamId;
      readonly teamSize: number; // live setting (0 = auto until locked)
      readonly roster: readonly RosterEntry[];
    }
  | {
      readonly t: 'rift_lobby';
      readonly seated: number;
      readonly humans: number;
      readonly minPlayers: number;
      readonly canStart: boolean;
      readonly teamSize: number; // resolved size it WOULD lock at now
      readonly picks: Readonly<Record<string, HeroId | null>>;
      readonly countdownEndsAt: number; // absolute server ms, 0 = none
    }
  | {
      readonly t: 'rift_begin';
      readonly lanes: number;
      readonly teamSize: number;
      readonly startAtTick: number;
      /** Seat -> assigned lane index, for every player incl. humans (drives
       *  the onboarding lane arrow). Round-robin per team at lock. */
      readonly laneAssignment: Readonly<Record<string, number>>;
    }
  | {
      readonly t: 'rift_snap';
      readonly tick: number;
      readonly serverTime: number;
      readonly phase: Phase;
      readonly matchTick: number;
      readonly overtime: boolean;
      /** Day/night cycle position: 0 = full day, 1 = full night, continuous and
       *  WRAPPING — it ramps 0->1 across the first half of a cycle and 1->0 back
       *  across the second, so it is a phase, not a monotonic clock. Derived on
       *  the server purely from `matchTick` and `DAY_PERIOD_S` (TERRAIN_CONTRACT
       *  §6), starting at full day. It is on the wire only so a RECONNECTING
       *  client's lighting is correct immediately: the sim derives night for the
       *  vision multiplier itself and never reads this field back. The client
       *  feeds it straight to `SceneHandle.setTimeOfDay`. Always present, always
       *  in [0,1] — never interpolate it across snapshots at a wrap. */
      readonly dayPhase: number;
      readonly wardStock: number;
      /** Authoritative team kill totals, [team0, team1]. */
      readonly kills: readonly [number, number];
      /** Live scoreboard, one row per seat. */
      readonly board: readonly BoardEntry[];
      readonly you: YouSnap | null; // null for a spectator-less disconnect edge
      readonly ents: readonly EntSnap[];
    };

/** Events travel inside the platform envelope { t:'event', ev: RiftEvent }.
 *  Cast and miss events are only sent to teams that can see the acting entity.
 *  Kill events carry PLAYER ids (killer null = executed by creeps/towers);
 *  clients map ids to names/heroes via the snap board. */
export type RiftEvent =
  | { readonly t: 'rift_kill'; readonly killer: string | null; readonly victim: string; readonly gold: number; readonly firstBlood: boolean }
  | { readonly t: 'rift_structure'; readonly team: TeamId; readonly kind: 'tower' | 'guard' | 'ancient'; readonly lane: number | null }
  | { readonly t: 'rift_surge' }
  | { readonly t: 'rift_pick'; readonly id: string; readonly hero: HeroId | null }
  | { readonly t: 'rift_roster'; readonly roster: readonly RosterEntry[] }
  | { readonly t: 'rift_cast'; readonly id: number; readonly slot: number; readonly x: number; readonly z: number }
  /** An uphill basic attack that missed (TERRAIN_CONTRACT §4). `attacker` and
   *  `target` are ENTITY ids, as in rift_cast — not player ids. Emitted from
   *  `fire()` on the tick the swing resolves, after the cooldown is stamped and
   *  `atkTarget` is set, so the client still draws the tracer; the swing was
   *  spent, it simply dealt no damage. Filtered by team vision exactly like
   *  rift_cast. Abilities never miss, so this only ever accompanies a basic
   *  attack. The HUD floats a `MISS` marker on it — a miss with no feedback
   *  reads as a bug. */
  | { readonly t: 'rift_miss'; readonly attacker: number; readonly target: number }
  | { readonly t: 'rift_end'; readonly winner: TeamId | null; readonly reason: EndReason; readonly stats: readonly PlayerStats[] };

// --- Settings ---------------------------------------------------------------------
export const DEFAULT_SETTINGS: RiftSettings = {};

export function parseRiftSettings(raw: unknown): RiftSettings {
  if (raw === undefined || raw === null) return { ...DEFAULT_SETTINGS };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('settings must be an object');
  const o = raw as Record<string, unknown>;
  const out: { teamSize?: number; speed?: number } = {};
  if (o.teamSize !== undefined) {
    const n = o.teamSize;
    if (typeof n !== 'number' || !Number.isInteger(n) || n !== 0 && (n < MIN_TEAM_SIZE || n > MAX_TEAM_SIZE)) {
      throw new Error(`teamSize must be 0 (auto) or ${MIN_TEAM_SIZE}..${MAX_TEAM_SIZE}`);
    }
    if (n !== 0) out.teamSize = n;
  }
  if (o.speed !== undefined) {
    const n = o.speed;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 1 || n > 20) {
      throw new Error('speed must be 1..20');
    }
    out.speed = n;
  }
  return out;
}

// --- Parser helpers ------------------------------------------------------------------
function coord(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAP_COORD_MAX ? v : null;
}

function entId(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1_000_000 ? v : null;
}

function slot(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < max ? v : null;
}

/** The only door into the sim. Returns null for anything malformed — callers
 *  drop nulls in silence (never an error, never a throw). */
export function parseRiftC2S(raw: unknown): RiftC2S | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'rift_pick':
      return isHeroId(m.hero) ? { t: 'rift_pick', hero: m.hero } : null;
    case 'rift_start':
      return { t: 'rift_start' };
    case 'rift_order': {
      if (m.kind === 'stop') return { t: 'rift_order', kind: 'stop' };
      if (m.kind === 'attack') {
        const target = entId(m.target);
        return target === null ? null : { t: 'rift_order', kind: 'attack', target };
      }
      if (m.kind === 'move' || m.kind === 'attackmove') {
        const x = coord(m.x);
        const z = coord(m.z);
        return x === null || z === null ? null : { t: 'rift_order', kind: m.kind, x, z };
      }
      return null;
    }
    case 'rift_cast': {
      const s = slot(m.slot, 4);
      if (s === null) return null;
      const out: { t: 'rift_cast'; slot: number; x?: number; z?: number; target?: number } = { t: 'rift_cast', slot: s };
      const x = coord(m.x);
      const z = coord(m.z);
      const target = entId(m.target);
      if (x !== null && z !== null) {
        out.x = x;
        out.z = z;
      }
      if (target !== null) out.target = target;
      return out;
    }
    case 'rift_item': {
      const s = slot(m.slot, INVENTORY_SLOTS);
      if (s === null) return null;
      const out: { t: 'rift_item'; slot: number; x?: number; z?: number } = { t: 'rift_item', slot: s };
      const x = coord(m.x);
      const z = coord(m.z);
      if (x !== null && z !== null) {
        out.x = x;
        out.z = z;
      }
      return out;
    }
    case 'rift_buy':
      return isItemId(m.item) ? { t: 'rift_buy', item: m.item } : null;
    case 'rift_sell': {
      // Same slot sanitisation as rift_item: integer, 0..INVENTORY_SLOTS-1.
      // Anything else (float, negative, NaN, string, missing) is dropped.
      const s = slot(m.slot, INVENTORY_SLOTS);
      return s === null ? null : { t: 'rift_sell', slot: s };
    }
    case 'rift_drop': {
      const s = slot(m.slot, INVENTORY_SLOTS);
      return s === null ? null : { t: 'rift_drop', slot: s };
    }
    case 'rift_skill': {
      const s = slot(m.slot, 4);
      return s === null ? null : { t: 'rift_skill', slot: s };
    }
    default:
      return null;
  }
}
