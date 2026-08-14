// ============================================================================
// FROZEN CONTRACT — OUTPOST palette.
//
// The cohesion engine. Six independent art agents read this instead of each
// other's code; when every one of them pulls from the same named ramp their
// output is colour-coordinated automatically. An ad-hoc hex literal anywhere
// in outpost code is a CONTRACT VIOLATION that reviewers flag.
//
// We inherit STRICKEN's full 81-colour ramp verbatim (so the two games read as
// one universe and the proven value-ladder discipline carries over) and add an
// OUTPOST-only family for the things STRICKEN never had: rotting flesh, night
// skies, conifer treelines, mud, rust, sandbags and torchlight.
//
// VALUE LADDER (inherited law, enforced by palette.test.ts):
//   `<name>Lit`  trim / top-light     >= base + 8 L*
//   `<name>`     base
//   `<name>Dark` shaded side          <= base - 8 L*
//   `<name>Deep` contact / floor line <= dark - 8 L*
// Four tiers per family is what stops a flat-shaded scene reading as a colour
// swatch — the single clearest "programmer art" tell in the previous build.
//
// THE HORDE READS BY VALUE, NOT HUE. The previous OUTPOST staked its art
// thesis on "the horde is the one saturated element" and measured 0.00%
// saturated-green pixels with zombies on screen: fog desaturated them into the
// background long before they arrived. The rot family below is therefore
// deliberately HIGH-VALUE (rotPale sits at L* ~84) against a low-value dusk
// ground and near-black treeline. A pale figure stays lighter than its
// backdrop at every distance and through any amount of fog; a saturated one
// does not. Hue is the accent, value is the mechanism.
// ============================================================================

import { PALETTE as FPS_PALETTE } from '@fps/shared';
import type { MatKind } from './map.js';

/** OUTPOST-only additions. Everything else comes from STRICKEN's ramp. */
const OUTPOST_ADD = {
  // --- The horde. High-value sickly flesh; reads against dark ground at range.
  rotPale: '#cdd6ae', // L* ~84 — the silhouette colour. Chest, skull, forearms.
  rotFlesh: '#9aa87c', // L* ~66 — base body tone
  rotDark: '#5f6b46', // L* ~42 — shaded side, tattered clothing
  rotDeep: '#363d27', // L* ~24 — contact band, deep creases
  gore: '#7a2b2b', // wounds, exposed viscera (distinct from PALETTE.blood spray)
  zeye: '#d9ff5c', // EMISSIVE ONLY — eye glow. Never a body colour.

  // --- Night. Values chosen so the unlit sky dome does not sit BELOW the
  //     VISUAL_GATES shadow threshold (luma 20) by construction — the first
  //     draft's zenith measured luma 19.5, i.e. it counted as "murk" in every
  //     sky-bearing shot and no amount of lighting could have fixed it.
  skyNight: '#22304a', // luma 47
  skyNightHigh: '#161f30', // luma 30
  fogNight: '#232d3d', // luma 44
  moonlight: '#b9c8e6', // the cool key at night

  // --- Dusk. OUTPOST-SPECIFIC, and deliberately NOT STRICKEN's skyDusk/fogDusk.
  //     STRICKEN's dusk is a warm desert sky (#d8a878, L* 72). Against it the
  //     horde's whole readability mechanism collapses: rotPale is L* 84, so a
  //     pale zombie lerped toward that fog sits 11.8 L* from its backdrop —
  //     BELOW even this file's own 8 L* per-tier step. Waves 1-3 are dusk, so
  //     that is the first thing a player ever sees, and the frozen palette test
  //     only checked night and was blind to it. This is the previous build's
  //     hue-space failure reincarnated in value space.
  //     A cool, dark dusk restores the contrast: rotPale - duskFog = ~48 L*.
  duskSkyHigh: '#26324a',
  duskSky: '#3b4a63',
  duskHorizon: '#7d6a68', // the one warm band, low on the horizon
  duskFog: '#4a5468',

  // --- Conifer treeline ringing the plateau.
  pineLit: '#3d5c40',
  pine: '#2c4530',
  pineDark: '#1c2d20',
  // Darkened from #101c13 (L* 8.9): that left only 7.75 L* below pineDark and
  // broke this file's own four-tier law. Caught by palette.test.ts pre-freeze.
  pineDeep: '#0c1510',

  // --- The plateau floor: churned mud, gravel, trampled earth.
  mudLit: '#6b5f4a',
  mud: '#4e4536',
  mudDark: '#363023',
  mudDeep: '#221e15',
  gravelLit: '#8f8b80',
  gravel: '#6a675e',
  gravelDark: '#494740',
  gravelDeep: '#2b2a25',

  // --- Stone. The tower footing, gate piers and boulders. STRICKEN has no
  //     `stone` key at all (its rock family is two tiers, rockDark/rockDeep),
  //     yet the model sheet calls for stone on three of the five surfaces in
  //     the mandated fence-line framing — and `articulate()` drops the plinth
  //     entirely when a contact tier is null, which is the exact "wall floats /
  //     flat swatch" tell the gates exist to catch.
  stoneLit: '#9a958c',
  stone: '#7b766d',
  stoneDark: '#565249',
  stoneDeep: '#35322b',

  // --- Fortification materials.
  sandbagLit: '#b8a878',
  sandbag: '#8f8259',
  sandbagDark: '#5e553a',
  sandbagDeep: '#3a3524',
  rustLit: '#a5643c', // corrugated panels lashed to the palisade
  rust: '#7d4527',
  rustDark: '#4f2c19',
  rustDeep: '#2c180d',

  // --- Light sources. Kept separate so one swatch never does four jobs (the
  //     previous build had `lanternCore` serving as key light, bulb, status
  //     light AND the hero object: "the core reads as a giant unlit marshmallow").
  floodBeam: '#ffe9c2', // tower floodlight cone + its bulb
  torchCore: '#ffb347', // hand torch / brazier flame core
  emberGlow: '#ff7a2f', // brazier embers, dying fire

  // --- Co-op HUD states. Meaning is never encoded by colour alone (see UX
  //     bible) but these are the accent tier for the three states that matter.
  reviveCyan: '#4fd1c5', // a teammate is downed and reachable
  downedRed: '#e04b4b', // you are down / bleeding out
  scrapGold: '#e0b74a', // the currency
} as const;

/**
 * The full OUTPOST ramp: STRICKEN's 81 colours plus the OUTPOST family above.
 * Values are typed `string` (not literals) — callers pass them to `mat()`.
 */
export const PALETTE = { ...FPS_PALETTE, ...OUTPOST_ADD };

export type PaletteKey = keyof typeof PALETTE;

/** The OUTPOST-only keys, for the value-ladder test and the review lens. */
export const OUTPOST_PALETTE_KEYS = Object.keys(OUTPOST_ADD) as Array<keyof typeof OUTPOST_ADD>;

/**
 * The four tiers `articulate()` needs for one surface, matching its
 * `ArticulateColors` shape (body / trim / dark / contact).
 */
export interface MatColors {
  body: string;
  trim: string | null;
  dark: string | null;
  contact: string | null;
}

/**
 * MatKind -> palette tiers. THE MISSING LINK, and the one every art agent needs.
 *
 * `map.ts` stamps every static box with a `MatKind` and says "the client maps
 * these to PALETTE families", and `visual.ts` tells implementers to resolve
 * them "from the frozen tables in @outpost/shared" — but in the first draft no
 * such table existed anywhere. STRICKEN's MAT_COLORS is keyed by ITS material
 * union, and only one of OUTPOST's nine kinds ('concrete') is even a valid key
 * there; 'timber', 'timberDark' and 'stone' are not palette keys in either ramp.
 *
 * Without this, `art-structures` and `art-world` each invent their own mapping,
 * the tower's timber and the world's props stop sharing a value ladder, and the
 * palette's entire reason for existing — "six independent art agents read this
 * instead of each other's code" — is defeated at exactly the seam it was built
 * to hold.
 */
export const MAT_COLORS: Record<MatKind, MatColors> = {
  timber: { body: PALETTE.wood, trim: PALETTE.woodLit, dark: PALETTE.woodDark, contact: PALETTE.woodDeep },
  // `timberDark` sits one tier below `timber`, so its own dark tier is already
  // the bottom of the wood ladder and there is nothing legal below it for a
  // contact band. `contact: null` is the CORRECT answer here, not a gap:
  // `articulate()` skips the plinth rather than emitting a zero-contrast one.
  // (Setting dark and contact to the same key — as the first draft did — is a
  // silent 0.0 L* violation of this file's own four-tier law.) This kind is
  // framing and posts — never wall-scale surfaces, so no ground line is
  // lost. (They ARE still articulated: MIN_ARTICULATE_H gates on height.)
  timberDark: { body: PALETTE.woodDark, trim: PALETTE.wood, dark: PALETTE.woodDeep, contact: null },
  stone: { body: PALETTE.stone, trim: PALETTE.stoneLit, dark: PALETTE.stoneDark, contact: PALETTE.stoneDeep },
  concrete: { body: PALETTE.concrete, trim: PALETTE.concreteLit, dark: PALETTE.concreteDark, contact: PALETTE.concreteDeep },
  steel: { body: PALETTE.steel, trim: PALETTE.steelLit, dark: PALETTE.metalDark, contact: PALETTE.metalDeep },
  rust: { body: PALETTE.rust, trim: PALETTE.rustLit, dark: PALETTE.rustDark, contact: PALETTE.rustDeep },
  sandbag: { body: PALETTE.sandbag, trim: PALETTE.sandbagLit, dark: PALETTE.sandbagDark, contact: PALETTE.sandbagDeep },
  mud: { body: PALETTE.mud, trim: PALETTE.mudLit, dark: PALETTE.mudDark, contact: PALETTE.mudDeep },
  gravel: { body: PALETTE.gravel, trim: PALETTE.gravelLit, dark: PALETTE.gravelDark, contact: PALETTE.gravelDeep },
};
