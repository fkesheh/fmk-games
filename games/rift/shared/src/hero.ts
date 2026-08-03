// ============================================================================
// ANCIENTS (rift) — HERO ROSTER. Pure data against the ability schema. The
// six heroes are contract, not content: their numbers are frozen here so
// balance coherence is reviewable in one place. Adding a seventh hero later
// costs one entry + palette accents, no engine work.
// ============================================================================
import type { AbilityDef } from './ability.js';

export type HeroId = 'bullwark' | 'longbow' | 'reaver' | 'hex' | 'mender' | 'shade';

export type HeroRole =
  | 'tank'
  | 'ranged-carry'
  | 'melee-carry'
  | 'mage'
  | 'support'
  | 'assassin';

export interface HeroBaseStats {
  readonly hp: number;
  readonly hpRegen: number; // per second
  readonly mana: number;
  readonly manaRegen: number; // per second
  readonly damage: number;
  readonly armor: number;
  readonly attackPeriod: number; // seconds between attacks
  readonly attackRange: number;
  readonly moveSpeed: number; // metres per second
}

/** Added per level above 1. */
export interface HeroGrowth {
  readonly hp: number;
  readonly mana: number;
  readonly damage: number;
}

/** Client silhouette language. accent is an APAL key; the unit's trim/glow. */
export interface HeroVisual {
  readonly build: 'bulky' | 'standard' | 'lithe';
  readonly height: number; // metres, model scale anchor
  readonly accent: string; // palette key, e.g. 'arcane'
}

export interface HeroDef {
  readonly id: HeroId;
  readonly name: string;
  readonly title: string;
  readonly role: HeroRole;
  readonly base: HeroBaseStats;
  readonly growth: HeroGrowth;
  /** Exactly 4, slot order q/w/e/r. Slot 3 has ult:true, maxRank 2; the
   *  others ult:false, maxRank 4. Passives have isPassive:true and only
   *  aura effects with duration 0. */
  readonly abilities: readonly AbilityDef[];
  readonly visual: HeroVisual;
  readonly blurb: string;
}

// --- BULLWARK — tank / initiator ------------------------------------------------
const BULLWARK: HeroDef = {
  id: 'bullwark',
  name: 'BULLWARK',
  title: 'the Rampart',
  role: 'tank',
  base: { hp: 720, hpRegen: 2.5, mana: 280, manaRegen: 0.9, damage: 52, armor: 6, attackPeriod: 1.2, attackRange: 1.8, moveSpeed: 4.9 },
  growth: { hp: 95, mana: 18, damage: 4.5 },
  abilities: [
    {
      id: 'bullwark_q', name: 'Shield Crash', icon: '⬢', targeting: 'point',
      isPassive: false, ult: false, maxRank: 4,
      castRange: [7, 7, 7, 7], cooldown: [14, 13, 12, 11], manaCost: [70, 70, 70, 70],
      aoeRadius: [2.2, 2.2, 2.2, 2.2],
      effects: [
        { kind: 'dash', distance: 7 },
        { kind: 'damage', school: 'physical', amount: [70, 120, 170, 220] },
        { kind: 'stun', duration: [0.8, 1.0, 1.2, 1.4] },
      ],
      blurb: 'Dash to a point, damaging and stunning enemies on arrival.',
    },
    {
      id: 'bullwark_w', name: 'Bulwark', icon: '⛨', targeting: 'none',
      isPassive: true, ult: false, maxRank: 4,
      castRange: [0, 0, 0, 0], cooldown: [0, 0, 0, 0], manaCost: [0, 0, 0, 0],
      effects: [
        { kind: 'aura', stat: 'armor', amount: [3, 5, 7, 9], pct: false, radius: 8, duration: 0 },
      ],
      blurb: 'Passive: nearby allies gain armour.',
    },
    {
      id: 'bullwark_e', name: 'Ground Slam', icon: '◉', targeting: 'none',
      isPassive: false, ult: false, maxRank: 4,
      castRange: [0, 0, 0, 0], cooldown: [9, 9, 9, 9], manaCost: [60, 65, 70, 75],
      aoeRadius: [4, 4, 4, 4],
      effects: [
        { kind: 'damage', school: 'magic', amount: [60, 110, 160, 210] },
        { kind: 'slow', pct: [0.3, 0.35, 0.4, 0.45], duration: [2.5, 2.5, 2.5, 2.5] },
      ],
      blurb: 'Slam the ground, damaging and slowing enemies around you.',
    },
    {
      id: 'bullwark_r', name: 'Rally', icon: '⚑', targeting: 'none',
      isPassive: false, ult: true, maxRank: 2,
      castRange: [0, 0], cooldown: [80, 70], manaCost: [120, 160],
      aoeRadius: [10, 10],
      effects: [
        { kind: 'heal', amount: [200, 400] },
        { kind: 'aura', stat: 'armor', amount: [6, 12], pct: false, radius: 10, duration: 6 },
      ],
      blurb: 'Heal nearby allies and steel their armour for 6 seconds.',
    },
  ],
  visual: { build: 'bulky', height: 2.1, accent: 'pine' },
  blurb: 'Walks in first. Stays standing longest.',
};

// --- LONGBOW — ranged carry -----------------------------------------------------
const LONGBOW: HeroDef = {
  id: 'longbow',
  name: 'LONGBOW',
  title: 'the Far Eye',
  role: 'ranged-carry',
  base: { hp: 540, hpRegen: 1.5, mana: 240, manaRegen: 0.8, damage: 48, armor: 2, attackPeriod: 1.0, attackRange: 10, moveSpeed: 5.1 },
  growth: { hp: 62, mana: 14, damage: 5.5 },
  abilities: [
    {
      id: 'longbow_q', name: 'Piercing Arrow', icon: '➶', targeting: 'point',
      isPassive: false, ult: false, maxRank: 4,
      castRange: [14, 14, 14, 14], cooldown: [10, 9, 8, 7], manaCost: [55, 55, 55, 55],
      projectile: { speed: 22, radius: 1.2, range: 14, pierce: true },
      effects: [
        { kind: 'damage', school: 'physical', amount: [80, 140, 200, 260] },
      ],
      blurb: 'Fire an arrow that pierces every enemy in a line.',
    },
    {
      id: 'longbow_w', name: 'Focus', icon: '◎', targeting: 'none',
      isPassive: true, ult: false, maxRank: 4,
      castRange: [0, 0, 0, 0], cooldown: [0, 0, 0, 0], manaCost: [0, 0, 0, 0],
      effects: [
        { kind: 'aura', stat: 'attackSpeed', amount: [0.1, 0.15, 0.2, 0.25], pct: true, radius: 0, duration: 0 },
      ],
      blurb: 'Passive: attack speed bonus.',
    },
    {
      id: 'longbow_e', name: 'Frost Arrow', icon: '❄', targeting: 'unit', targetTeam: 'enemy',
      isPassive: false, ult: false, maxRank: 4,
      castRange: [10, 10, 10, 10], cooldown: [8, 8, 8, 8], manaCost: [45, 45, 45, 45],
      effects: [
        { kind: 'damage', school: 'magic', amount: [40, 70, 100, 130] },
        { kind: 'slow', pct: [0.35, 0.35, 0.35, 0.35], duration: [2, 2.5, 3, 3.5] },
      ],
      blurb: 'Chill an enemy, damaging and slowing them.',
    },
    {
      id: 'longbow_r', name: 'Rain of Arrows', icon: '☄', targeting: 'point',
      isPassive: false, ult: true, maxRank: 2,
      castRange: [12, 12], cooldown: [90, 75], manaCost: [150, 200],
      aoeRadius: [5, 5],
      effects: [
        { kind: 'damage', school: 'magic', amount: [250, 400] },
        { kind: 'slow', pct: [0.25, 0.25], duration: [2, 2] },
      ],
      blurb: 'Call down a volley on an area, damaging and slowing enemies.',
    },
  ],
  visual: { build: 'lithe', height: 1.8, accent: 'frost' },
  blurb: 'Wins the fight before it reaches her.',
};

// --- REAVER — melee carry ---------------------------------------------------------
const REAVER: HeroDef = {
  id: 'reaver',
  name: 'REAVER',
  title: 'the Red Harvest',
  role: 'melee-carry',
  base: { hp: 640, hpRegen: 2.0, mana: 220, manaRegen: 0.7, damage: 58, armor: 4, attackPeriod: 1.0, attackRange: 1.8, moveSpeed: 5.3 },
  growth: { hp: 78, mana: 12, damage: 6.0 },
  abilities: [
    {
      id: 'reaver_q', name: 'Cleave', icon: '⚒', targeting: 'none',
      isPassive: false, ult: false, maxRank: 4,
      castRange: [0, 0, 0, 0], cooldown: [8, 7.5, 7, 6.5], manaCost: [40, 40, 40, 40],
      aoeRadius: [3, 3, 3, 3],
      effects: [
        { kind: 'damage', school: 'physical', amount: [70, 130, 190, 250] },
      ],
      blurb: 'Sweep your blade through every enemy around you.',
    },
    {
      id: 'reaver_w', name: 'Frenzy', icon: '♨', targeting: 'none',
      isPassive: false, ult: false, maxRank: 4,
      castRange: [0, 0, 0, 0], cooldown: [14, 14, 14, 14], manaCost: [50, 50, 50, 50],
      effects: [
        { kind: 'aura', stat: 'attackSpeed', amount: [0.3, 0.45, 0.6, 0.75], pct: true, radius: 0, duration: 5 },
      ],
      blurb: 'Greatly increase your attack speed for 5 seconds.',
    },
    {
      id: 'reaver_e', name: 'Lunge', icon: '↯', targeting: 'unit', targetTeam: 'enemy',
      isPassive: false, ult: false, maxRank: 4,
      castRange: [6, 6, 6, 6], cooldown: [12, 11, 10, 9], manaCost: [45, 45, 45, 45],
      effects: [
        { kind: 'dash', distance: 6 },
        { kind: 'damage', school: 'physical', amount: [50, 90, 130, 170] },
      ],
      blurb: 'Lunge to an enemy, striking as you arrive.',
    },
    {
      id: 'reaver_r', name: 'Dismember', icon: '☠', targeting: 'unit', targetTeam: 'enemy',
      isPassive: false, ult: true, maxRank: 2,
      castRange: [2.5, 2.5], cooldown: [75, 60], manaCost: [120, 160],
      effects: [
        { kind: 'damage', school: 'physical', amount: [250, 450] },
        { kind: 'stun', duration: [1.2, 1.6] },
      ],
      blurb: 'A brutal strike that damages and stuns one enemy.',
    },
  ],
  visual: { build: 'standard', height: 1.95, accent: 'gold' },
  blurb: 'Every fight he walks into, he walks out of.',
};

// --- HEX — burst mage ---------------------------------------------------------------
const HEX: HeroDef = {
  id: 'hex',
  name: 'HEX',
  title: 'the Hollow Star',
  role: 'mage',
  base: { hp: 520, hpRegen: 1.4, mana: 380, manaRegen: 1.4, damage: 46, armor: 1, attackPeriod: 1.1, attackRange: 9, moveSpeed: 5.0 },
  growth: { hp: 55, mana: 30, damage: 4.0 },
  abilities: [
    {
      id: 'hex_q', name: 'Hexbolt', icon: '✦', targeting: 'unit', targetTeam: 'enemy',
      isPassive: false, ult: false, maxRank: 4,
      castRange: [10, 10, 10, 10], cooldown: [7, 6.5, 6, 5.5], manaCost: [60, 65, 70, 75],
      projectile: { speed: 18, radius: 0.8, range: 12, pierce: false },
      effects: [
        { kind: 'damage', school: 'magic', amount: [90, 150, 210, 270] },
      ],
      blurb: 'Hurl a bolt of void at an enemy.',
    },
    {
      id: 'hex_w', name: 'Cripple', icon: '⌖', targeting: 'point',
      isPassive: false, ult: false, maxRank: 4,
      castRange: [9, 9, 9, 9], cooldown: [12, 12, 12, 12], manaCost: [70, 70, 70, 70],
      aoeRadius: [3.5, 3.5, 3.5, 3.5],
      effects: [
        { kind: 'damage', school: 'magic', amount: [40, 70, 100, 130] },
        { kind: 'slow', pct: [0.4, 0.45, 0.5, 0.55], duration: [2, 2.5, 3, 3.5] },
      ],
      blurb: 'Warp the ground, damaging and slowing enemies in an area.',
    },
    {
      id: 'hex_e', name: 'Blink', icon: '⌁', targeting: 'point',
      isPassive: false, ult: false, maxRank: 4,
      castRange: [8, 8, 8, 8], cooldown: [16, 14, 12, 10], manaCost: [60, 60, 60, 60],
      effects: [
        { kind: 'dash', distance: 8 },
      ],
      blurb: 'Blink a short distance.',
    },
    {
      id: 'hex_r', name: 'Annihilate', icon: '✹', targeting: 'point',
      isPassive: false, ult: true, maxRank: 2,
      castRange: [10, 10], cooldown: [100, 85], manaCost: [180, 240],
      aoeRadius: [4.5, 4.5],
      effects: [
        { kind: 'damage', school: 'magic', amount: [350, 550] },
        { kind: 'stun', duration: [1.0, 1.4] },
      ],
      blurb: 'Detonate the void, damaging and stunning enemies in an area.',
    },
  ],
  visual: { build: 'lithe', height: 1.85, accent: 'void' },
  blurb: 'Appears. Ends someone. Vanishes.',
};

// --- MENDER — support -----------------------------------------------------------------
const MENDER: HeroDef = {
  id: 'mender',
  name: 'MENDER',
  title: 'the Green Vow',
  role: 'support',
  base: { hp: 560, hpRegen: 1.8, mana: 360, manaRegen: 1.3, damage: 42, armor: 2, attackPeriod: 1.1, attackRange: 8, moveSpeed: 5.0 },
  growth: { hp: 60, mana: 26, damage: 3.5 },
  abilities: [
    {
      id: 'mender_q', name: 'Mend', icon: '✚', targeting: 'unit', targetTeam: 'ally',
      isPassive: false, ult: false, maxRank: 4,
      castRange: [9, 9, 9, 9], cooldown: [8, 7, 6, 5], manaCost: [55, 60, 65, 70],
      effects: [
        { kind: 'heal', amount: [90, 150, 210, 270] },
      ],
      blurb: 'Heal an allied unit.',
    },
    {
      id: 'mender_w', name: 'Smite', icon: '⚡', targeting: 'unit', targetTeam: 'enemy',
      isPassive: false, ult: false, maxRank: 4,
      castRange: [8, 8, 8, 8], cooldown: [9, 9, 9, 9], manaCost: [50, 50, 50, 50],
      effects: [
        { kind: 'damage', school: 'magic', amount: [60, 100, 140, 180] },
        { kind: 'slow', pct: [0.25, 0.25, 0.25, 0.25], duration: [1.5, 2, 2.5, 3] },
      ],
      blurb: 'Strike an enemy with searing light, slowing them.',
    },
    {
      id: 'mender_e', name: 'Sanctuary', icon: '❋', targeting: 'point',
      isPassive: false, ult: false, maxRank: 4,
      castRange: [8, 8, 8, 8], cooldown: [14, 14, 14, 14], manaCost: [70, 70, 70, 70],
      aoeRadius: [4, 4, 4, 4],
      effects: [
        { kind: 'heal', amount: [60, 100, 140, 180] },
        { kind: 'aura', stat: 'hpRegen', amount: [4, 7, 10, 13], pct: false, radius: 4, duration: 4 },
      ],
      blurb: 'Bless an area: allies are healed and mend faster for 4 seconds.',
    },
    {
      id: 'mender_r', name: 'Guardian', icon: '❈', targeting: 'none',
      isPassive: false, ult: true, maxRank: 2,
      castRange: [0, 0], cooldown: [110, 90], manaCost: [150, 200],
      aoeRadius: [12, 12],
      effects: [
        { kind: 'heal', amount: [200, 350] },
        { kind: 'aura', stat: 'armor', amount: [8, 14], pct: false, radius: 12, duration: 5 },
      ],
      blurb: 'Heal all nearby allies and ward them with armour for 5 seconds.',
    },
  ],
  visual: { build: 'standard', height: 1.8, accent: 'heal' },
  blurb: 'Her team does not die. That is the whole plan.',
};

// --- SHADE — assassin ------------------------------------------------------------------
const SHADE: HeroDef = {
  id: 'shade',
  name: 'SHADE',
  title: 'the Ninth Cut',
  role: 'assassin',
  base: { hp: 580, hpRegen: 1.7, mana: 260, manaRegen: 0.9, damage: 60, armor: 3, attackPeriod: 0.9, attackRange: 1.7, moveSpeed: 5.5 },
  growth: { hp: 66, mana: 15, damage: 6.5 },
  abilities: [
    {
      id: 'shade_q', name: 'Shadow Strike', icon: '🗡', targeting: 'unit', targetTeam: 'enemy',
      isPassive: false, ult: false, maxRank: 4,
      castRange: [7, 7, 7, 7], cooldown: [13, 12, 11, 10], manaCost: [55, 55, 55, 55],
      effects: [
        { kind: 'dash', distance: 7 },
        { kind: 'damage', school: 'physical', amount: [80, 140, 200, 260] },
      ],
      blurb: 'Dash to an enemy and cut them on arrival.',
    },
    {
      id: 'shade_w', name: 'Smoke', icon: '☁', targeting: 'point',
      isPassive: false, ult: false, maxRank: 4,
      castRange: [7, 7, 7, 7], cooldown: [14, 14, 14, 14], manaCost: [60, 60, 60, 60],
      aoeRadius: [4, 4, 4, 4],
      effects: [
        { kind: 'damage', school: 'magic', amount: [50, 90, 130, 170] },
        { kind: 'slow', pct: [0.3, 0.4, 0.5, 0.6], duration: [2, 2, 2, 2] },
      ],
      blurb: 'Burst of choking smoke, damaging and slowing enemies.',
    },
    {
      id: 'shade_e', name: 'Mark', icon: '✕', targeting: 'none',
      isPassive: true, ult: false, maxRank: 4,
      castRange: [0, 0, 0, 0], cooldown: [0, 0, 0, 0], manaCost: [0, 0, 0, 0],
      effects: [
        { kind: 'aura', stat: 'damage', amount: [12, 20, 28, 36], pct: false, radius: 0, duration: 0 },
      ],
      blurb: 'Passive: bonus attack damage.',
    },
    {
      id: 'shade_r', name: 'Phantoms', icon: '♆', targeting: 'none',
      isPassive: false, ult: true, maxRank: 2,
      castRange: [0, 0], cooldown: [90, 75], manaCost: [140, 180],
      effects: [
        { kind: 'summon', unit: 'shade', count: [2, 3], duration: [8, 8] },
        { kind: 'aura', stat: 'moveSpeed', amount: [0.15, 0.25], pct: true, radius: 0, duration: 6 },
      ],
      blurb: 'Split into phantoms that fight beside you, and move faster.',
    },
  ],
  visual: { build: 'lithe', height: 1.75, accent: 'shade' },
  blurb: 'You will not see the cut that matters.',
};

// --- Registry ------------------------------------------------------------------------
/** Roster in display order. Lookup via heroById; a test asserts every HeroId
 *  is present exactly once, so the roster can never drift from the union. */
export const HERO_LIST: readonly HeroDef[] = [BULLWARK, LONGBOW, REAVER, HEX, MENDER, SHADE];

export function heroById(id: HeroId): HeroDef {
  const h = HERO_LIST.find((d) => d.id === id);
  if (!h) throw new Error(`unknown hero '${id}'`);
  return h;
}

export function isHeroId(v: unknown): v is HeroId {
  return typeof v === 'string' && HERO_LIST.some((d) => d.id === v);
}
