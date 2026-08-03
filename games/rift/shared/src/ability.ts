// ============================================================================
// ANCIENTS (rift) — ABILITY PRIMITIVE SCHEMA. Abilities are DATA (handoff
// §2.7): a fixed set of effect primitives composed declaratively. The server
// ability engine implements these kinds and NOTHING else; a hero that needs a
// ninth primitive is a contract change, not a code task.
//
// Per-rank arrays have length == the ability's maxRank (4 for q/w/e, 2 for r)
// unless documented scalar. heroes.test.ts asserts this mechanically.
// ============================================================================

export type AbilitySlot = 0 | 1 | 2 | 3; // q, w, e, r

export type Targeting = 'none' | 'point' | 'unit';

/** For unit-targeted abilities: which units may be targeted. */
export type TargetTeam = 'enemy' | 'ally' | 'any';

/** Stats an aura can modify. pct=true reads amount as a fraction (0.2 = +20%);
 *  pct=false reads it as a flat bonus. radius 0 = self only. */
export type AuraStat =
  | 'armor'
  | 'damage'
  | 'attackSpeed'
  | 'moveSpeed'
  | 'hpRegen'
  | 'manaRegen';

export type Effect =
  | { readonly kind: 'damage'; readonly school: 'physical' | 'magic'; readonly amount: readonly number[] }
  | { readonly kind: 'heal'; readonly amount: readonly number[] }
  | { readonly kind: 'stun'; readonly duration: readonly number[] }
  | { readonly kind: 'slow'; readonly pct: readonly number[]; readonly duration: readonly number[] }
  | { readonly kind: 'dash'; readonly distance: number } // scalar
  | {
      readonly kind: 'aura';
      readonly stat: AuraStat;
      readonly amount: readonly number[];
      readonly pct: boolean;
      readonly radius: number; // scalar; 0 = self only
      readonly duration: number; // scalar seconds; 0 = passive (isPassive abilities only)
    }
  | { readonly kind: 'summon'; readonly unit: 'shade'; readonly count: readonly number[]; readonly duration: readonly number[] };

/** Delivery: when present, the ability's effects land where the projectile
 *  arrives. Unit-targeted projectiles HOME onto their target; point-targeted
 *  fly straight for `range`, hitting the first enemy unit within radius
 *  (or, with pierce:true, every enemy unit it passes, each once). */
export interface ProjectileSpec {
  readonly speed: number;
  readonly radius: number;
  readonly range: number;
  /** Pass through everything in range, applying effects to each unit hit. */
  readonly pierce: boolean;
}

export interface AbilityDef {
  readonly id: string; // unique within the hero, e.g. 'bullwark_q'
  readonly name: string;
  /** HUD glyph — a single unicode char rendered as text, no assets. */
  readonly icon: string;
  readonly targeting: Targeting;
  /** unit-targeted only; omitted otherwise. */
  readonly targetTeam?: TargetTeam;
  /** Passive abilities have no cast: their aura effects are always on. */
  readonly isPassive: boolean;
  /** Slot 3 (r) abilities are ults: maxRank 2, level-gated by ULT_LEVEL_REQ. */
  readonly ult: boolean;
  readonly maxRank: number;
  /** Distance the caster can target. Scalar-allowed fields are per-rank here. */
  readonly castRange: readonly number[];
  readonly cooldown: readonly number[];
  readonly manaCost: readonly number[];
  /** Area-of-effect radius around the impact point / target unit. Omitted =
   *  single target. Per-rank. */
  readonly aoeRadius?: readonly number[];
  readonly projectile?: ProjectileSpec;
  readonly effects: readonly Effect[];
  /** One line for tooltips, e.g. "Dash to a point, stunning enemies on arrival." */
  readonly blurb: string;
}
