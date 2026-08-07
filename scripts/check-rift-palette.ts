// ============================================================================
// check-rift-palette — standalone CLI gate for the ANCIENTS (rift) palette.
//
// The CLI twin of games/rift/shared/src/valueLadder.test.ts: same laws, same
// thresholds, no vitest. It exists so the palette can be measured outside a
// test runner — during a retune, from a hook, or from an agent loop that has
// no workspace installed — and it prints every measured value so a failure
// says WHICH pair collided and BY HOW MUCH.
//
// EXTENDED for the PBR + terrain pass (GRAPHICS_CONTRACT §3) with the Wave-0
// keys: the tier law over cliff/dirt/wetStone/water/canopy/bark/fern/iron/
// bronze/gold/neutral, large-surface separation from open ground, the
// neutral-camp identity against both teams and the whole accent band, the
// night sky state under the same S1/S2/S4 laws as day, and the APAL <->
// APAL_CSS_VARS mirror.
//
// THRESHOLDS ARE EXTENDED, NEVER WEAKENED. Every constant below is the value
// valueLadder.test.ts freezes; a palette that fails is retuned, not a
// threshold that is loosened.
//
// COVERAGE IS ITSELF A CHECK. Every check declares the APAL keys it touches,
// and the last check fails if any key in APAL was touched by nothing. That is
// the mechanism that makes "cover any palette keys added in Wave 0" true by
// construction rather than by remembering: add a key, and this script goes red
// until a law is written for it.
//
// Exit 0 only when every check passes. `node scripts/check-rift-palette.ts`.
// ============================================================================
import { L, hueDistance, blueBias, isCooler, composite } from '../platform/shared/src/color.ts';
import { APAL, APAL_CSS_VARS } from '../games/rift/shared/src/palette.ts';
import type { AncientsPaletteKey } from '../games/rift/shared/src/palette.ts';

// ---- thresholds (mirrored from valueLadder.test.ts — never weakened) -------
const TIER_SPAN_MIN = 8; // Lit >= base + 8 L*, Deep <= base - 8 L*
const TIER_BASE_MIN = 16; // absolute-Deep-step scope: bases at or above this L*
/** Below TIER_BASE_MIN there is not 8 L* of room BELOW the base, so the Deep
 *  step becomes proportional instead of absolute: Deep must sit at or under
 *  this fraction of the base's L*. The Lit step is NOT relaxed — headroom above
 *  a near-black base is exactly what does exist. This replaces an unconditional
 *  `check(..., true, ...)` under which `inkLit` and `inkDeep` could both be
 *  #000000 and the ladder stay green while counting as covered. */
const TIER_EXEMPT_DEEP_RATIO = 0.6;
const GROUND_FLOOR_MIN = 22; // L5: the darkest large surface still reads
const STONE_VS_MOSS_MIN = 15; // lane paving vs open ground
const MONUMENT_VS_MOSS_MIN = 20; // tower/ancient bodies vs open ground
const TEAM_L_MIN = 18; // team colour vs ground: >= 18 L* …
const TEAM_HUE_MIN = 30; // … OR >= 30 deg of hue
const TEAM_VS_TEAM_HUE_MIN = 25; // azure vs ember: >= 25 deg …
const TEAM_VS_TEAM_L_MIN = 20; // … OR >= 20 L*
const SKY_L_MIN = 12; // S1: zenith >= 12 L* darker than horizon
const PAPER_ON_INK_MIN = 60; // HUD text contrast floor
const ACCENT_HUE_MIN = 25; // hero accents pairwise: >= 25 deg …
const ACCENT_L_MIN = 20; // … OR >= 20 L*
const FOG_SHROUD_ALPHA = 0.55; // explored-not-visible ground composite
const LARGE_VS_MOSS_L_MIN = 12; // large surfaces vs open ground: >= 12 L* …
const LARGE_VS_MOSS_HUE_MIN = 25; // … OR >= 25 deg of hue
const NEUTRAL_HUE_MIN = 25; // neutral camps vs teams/accents: >= 25 deg …
const NEUTRAL_L_MIN = 20; // … OR >= 20 L*
const CSS_VAR_PATTERN = /^--[a-z][a-z0-9-]*$/;

// ---- reporting -------------------------------------------------------------
const n = (v: number): string => v.toFixed(1);
/** Widen the literal type: APAL entries are `as const`, so comparing two of
 *  them directly is a compile error ("no overlap") even when the comparison is
 *  exactly the law being checked (S2 fog === horizon, S4 moss !== horizon). */
const hex = (k: AncientsPaletteKey): string => APAL[k];

const touched = new Set<AncientsPaletteKey>();
let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail: string, keys: readonly AncientsPaletteKey[]): void {
  for (const k of keys) touched.add(k);
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
}

/** The OR-law used by every readability rule: separated by value OR by hue. */
function separated(a: AncientsPaletteKey, b: AncientsPaletteKey, lMin: number, hMin: number): {
  ok: boolean;
  detail: string;
} {
  const dL = Math.abs(L(hex(a)) - L(hex(b)));
  const dH = hueDistance(hex(a), hex(b));
  return {
    ok: dL >= lMin || dH >= hMin,
    detail: `dL=${n(dL)} (need >=${lMin}) dH=${n(dH)} (need >=${hMin})`,
  };
}

// ============================================================================
// TIER FLOORS — every Lit/Deep step clears 8 L* against its base.
// Scoped to bases with L >= 16: below that the headroom does not exist in
// sRGB, so the law would be unmeetable rather than merely unmet. `ink` is the
// one family that lands in the exemption, and the scoping says so out loud.
// ============================================================================
const TIERS: readonly (readonly [string, AncientsPaletteKey, AncientsPaletteKey, AncientsPaletteKey])[] = [
  ['moss', 'moss', 'mossLit', 'mossDeep'],
  ['stone', 'stone', 'stoneLit', 'stoneDeep'],
  ['monument', 'monument', 'monumentLit', 'monumentDeep'],
  ['azure', 'azure', 'azureLit', 'azureDeep'],
  ['ember', 'ember', 'emberLit', 'emberDeep'],
  ['ink', 'ink', 'inkLit', 'inkDeep'],
  // --- added by the PBR + terrain pass (GRAPHICS_CONTRACT §3). Each family's
  //     {base, Lit, Deep} is also its seeded tint ladder (STYLE_BIBLE §8), so
  //     a step under the floor is scatter whose variation is invisible.
  ['cliff', 'cliff', 'cliffLit', 'cliffDeep'],
  ['dirt', 'dirt', 'dirtLit', 'dirtDeep'],
  ['wetStone', 'wetStone', 'wetStoneLit', 'wetStoneDeep'],
  ['water', 'water', 'waterLit', 'waterDeep'],
  ['canopy', 'canopy', 'canopyLit', 'canopyDeep'],
  ['bark', 'bark', 'barkLit', 'barkDeep'],
  ['fern', 'fern', 'fernLit', 'fernDeep'],
  ['iron', 'iron', 'ironLit', 'ironDeep'],
  ['bronze', 'bronze', 'bronzeLit', 'bronzeDeep'],
  ['gold', 'gold', 'goldLit', 'goldDeep'],
  ['neutral', 'neutral', 'neutralLit', 'neutralDeep'],
];

for (const [name, base, lit, deep] of TIERS) {
  const lb = L(hex(base));
  const ll = L(hex(lit));
  const ld = L(hex(deep));
  // The LIT step is absolute for every family, in scope or out of it: however
  // dark the base, sRGB always has 8 L* of room above it.
  check(`tier ${name} Lit`, ll - lb >= TIER_SPAN_MIN, `L ${n(ll)} - ${n(lb)} = ${n(ll - lb)} (need >=${TIER_SPAN_MIN})`, [base, lit]);
  if (lb >= TIER_BASE_MIN) {
    check(`tier ${name} Deep`, lb - ld >= TIER_SPAN_MIN, `L ${n(lb)} - ${n(ld)} = ${n(lb - ld)} (need >=${TIER_SPAN_MIN})`, [base, deep]);
  } else {
    // Below the scope floor only `lb` L* of headroom exists beneath the base, so
    // an 8 L* Deep step is unmeetable rather than merely unmet. The law becomes
    // PROPORTIONAL — Deep at or under TIER_EXEMPT_DEEP_RATIO of the base — which
    // is a real measurement, not the unconditional pass this used to be.
    // `ink` is the one family that lands here.
    const limit = lb * TIER_EXEMPT_DEEP_RATIO;
    check(
      `tier ${name} Deep (proportional, base L ${n(lb)} < ${TIER_BASE_MIN})`,
      ld <= limit,
      `L(Deep)=${n(ld)} (need <=${n(limit)} = ${TIER_EXEMPT_DEEP_RATIO} x base ${n(lb)}); ` +
        `8 L* of absolute headroom does not exist below this base`,
      [base, deep],
    );
  }
}

// ============================================================================
// GROUND LAW (L5) AND STRUCTURE SEPARATION
// ============================================================================
check('L5 moss floor', L(hex('moss')) >= GROUND_FLOOR_MIN, `L(moss)=${n(L(hex('moss')))} (need >=${GROUND_FLOOR_MIN})`, ['moss']);
check(
  'stone vs moss',
  L(hex('stone')) - L(hex('moss')) >= STONE_VS_MOSS_MIN,
  `${n(L(hex('stone')) - L(hex('moss')))} (need >=${STONE_VS_MOSS_MIN})`,
  ['stone', 'moss'],
);
check(
  'monument vs moss',
  L(hex('monument')) - L(hex('moss')) >= MONUMENT_VS_MOSS_MIN,
  `${n(L(hex('monument')) - L(hex('moss')))} (need >=${MONUMENT_VS_MOSS_MIN})`,
  ['monument', 'moss'],
);

// ============================================================================
// LARGE-SURFACE SEPARATION — anything that covers a large fraction of the
// frame must be tellable from the ground it sits on. The branches are not
// interchangeable: cliff/dirt/water clear it on hue AND value, while canopy
// deliberately shares moss's hue (a forest IS the ground's colour family) and
// carries the whole separation on value. That is why the law is an OR.
// ============================================================================
const LARGE_SURFACES: readonly AncientsPaletteKey[] = ['cliff', 'dirt', 'canopy', 'water'];
for (const name of LARGE_SURFACES) {
  const r = separated(name, 'moss', LARGE_VS_MOSS_L_MIN, LARGE_VS_MOSS_HUE_MIN);
  check(`${name} vs moss`, r.ok, r.detail, [name, 'moss']);
}
// The remaining new families are not full-frame surfaces, but they still stand
// ON moss and must not merge into it.
const RELIEF_SURFACES: readonly AncientsPaletteKey[] = ['wetStone', 'bark', 'fern', 'iron', 'bronze', 'trunk'];
for (const name of RELIEF_SURFACES) {
  const r = separated(name, 'moss', LARGE_VS_MOSS_L_MIN, LARGE_VS_MOSS_HUE_MIN);
  check(`${name} vs moss`, r.ok, r.detail, [name, 'moss']);
}
// `leaf` is deliberately NOT held to the separation law: it is the scattered
// foliage cluster colour and it is MEANT to sit inside moss's family (canopy
// is the entry that carries the jungle's value separation). Its own law is the
// two-step tint ladder it forms with leafDeep — a scatter whose seeded tint
// step is invisible is the defect that matters here.
check(
  'leaf Deep step',
  L(hex('leaf')) - L(hex('leafDeep')) >= TIER_SPAN_MIN,
  `L ${n(L(hex('leaf')))} - ${n(L(hex('leafDeep')))} = ${n(L(hex('leaf')) - L(hex('leafDeep')))} (need >=${TIER_SPAN_MIN})`,
  ['leaf', 'leafDeep'],
);

// ============================================================================
// TEAM COLOURS — readable on raw moss AND on fog-darkened moss.
// ============================================================================
const foggedMoss = composite(hex('moss'), hex('shroud'), FOG_SHROUD_ALPHA);
for (const team of ['azure', 'ember'] as const) {
  const r = separated(team, 'moss', TEAM_L_MIN, TEAM_HUE_MIN);
  check(`${team} vs moss`, r.ok, r.detail, [team, 'moss']);
  const dLf = Math.abs(L(hex(team)) - L(foggedMoss));
  const dHf = hueDistance(hex(team), foggedMoss);
  check(
    `${team} vs fogged moss (${foggedMoss})`,
    dLf >= TEAM_L_MIN || dHf >= TEAM_HUE_MIN,
    `dL=${n(dLf)} (need >=${TEAM_L_MIN}) dH=${n(dHf)} (need >=${TEAM_HUE_MIN})`,
    [team, 'moss', 'shroud'],
  );
}
{
  const r = separated('azure', 'ember', TEAM_VS_TEAM_L_MIN, TEAM_VS_TEAM_HUE_MIN);
  check('azure vs ember', r.ok, r.detail, ['azure', 'ember']);
}

// ============================================================================
// SKY LAW — S1 (zenith cooler AND darker), S2 (fog IS horizon), S4 (ground
// never matches the sky stops). Bound at t=0 (day) and at t=1 (night) by the
// same three rules: setTimeOfDay interpolates between the two endpoints, so a
// night state that breaks a law breaks it for every intermediate t as well.
// ============================================================================
const SKY_STATES: readonly (readonly [string, AncientsPaletteKey, AncientsPaletteKey, AncientsPaletteKey, AncientsPaletteKey])[] = [
  ['day', 'skyHigh', 'horizon', 'fog', 'moss'],
  ['night', 'nightSky', 'nightHorizon', 'nightFog', 'nightGround'],
];
for (const [state, zenith, horizon, fog, ground] of SKY_STATES) {
  check(
    `S1 ${state} cooler`,
    isCooler(hex(zenith), hex(horizon)),
    `blueBias ${n(blueBias(hex(zenith)))} vs ${n(blueBias(hex(horizon)))}`,
    [zenith, horizon],
  );
  check(
    `S1 ${state} darker>=${SKY_L_MIN}`,
    L(hex(horizon)) - L(hex(zenith)) >= SKY_L_MIN,
    `${n(L(hex(horizon)) - L(hex(zenith)))} (need >=${SKY_L_MIN})`,
    [zenith, horizon],
  );
  check(`S2 ${state} fog==horizon`, hex(fog) === hex(horizon), `${hex(fog)} vs ${hex(horizon)}`, [fog, horizon]);
  check(`S4 ${state} ground!=horizon`, hex(ground) !== hex(horizon), `${hex(ground)} vs ${hex(horizon)}`, [ground, horizon]);
}
// The moon disc/light tint is the night state's key light: it must read as
// light against the night sky it hangs in, or the moon is invisible.
check(
  'moon vs nightSky',
  L(hex('moon')) - L(hex('nightSky')) >= PAPER_ON_INK_MIN,
  `${n(L(hex('moon')) - L(hex('nightSky')))} (need >=${PAPER_ON_INK_MIN})`,
  ['moon', 'nightSky'],
);

// ============================================================================
// HUD TEXT
// ============================================================================
check(
  'paper on ink',
  L(hex('paper')) - L(hex('ink')) >= PAPER_ON_INK_MIN,
  `${n(L(hex('paper')) - L(hex('ink')))} (need >=${PAPER_ON_INK_MIN})`,
  ['paper', 'ink'],
);
// The two dimmed text steps must still separate from the surface they sit on,
// and from each other, or the HUD's three-level type hierarchy collapses.
check(
  'paperDim on ink',
  L(hex('paperDim')) - L(hex('ink')) >= LARGE_VS_MOSS_L_MIN,
  `${n(L(hex('paperDim')) - L(hex('ink')))} (need >=${LARGE_VS_MOSS_L_MIN})`,
  ['paperDim', 'ink'],
);
check(
  'paperDeep on ink',
  L(hex('paperDeep')) - L(hex('ink')) >= LARGE_VS_MOSS_L_MIN,
  `${n(L(hex('paperDeep')) - L(hex('ink')))} (need >=${LARGE_VS_MOSS_L_MIN})`,
  ['paperDeep', 'ink'],
);

// ============================================================================
// HERO ACCENTS — pairwise tellable apart, none equal to a team colour.
// ============================================================================
const ACCENTS: readonly AncientsPaletteKey[] = ['frost', 'heal', 'shade', 'pine', 'void', 'gold'];
for (let i = 0; i < ACCENTS.length; i++) {
  for (let j = i + 1; j < ACCENTS.length; j++) {
    const a = ACCENTS[i];
    const b = ACCENTS[j];
    if (a === undefined || b === undefined) continue;
    const r = separated(a, b, ACCENT_L_MIN, ACCENT_HUE_MIN);
    check(`accent ${a} vs ${b}`, r.ok, r.detail, [a, b]);
  }
}
for (const name of ACCENTS) {
  check(
    `accent ${name} != team identity`,
    hex(name) !== hex('azure') && hex(name) !== hex('ember'),
    `${hex(name)} vs azure ${hex('azure')} / ember ${hex('ember')}`,
    [name, 'azure', 'ember'],
  );
}
// `arcane` is an ability-FX accent rather than a chassis accent, so it is not
// in the pairwise chassis set — but it must still not read as team identity.
check(
  'accent arcane != team identity',
  hex('arcane') !== hex('azure') && hex('arcane') !== hex('ember'),
  `${hex('arcane')} vs azure ${hex('azure')} / ember ${hex('ember')}`,
  ['arcane', 'azure', 'ember'],
);
// `danger` and `ward` are semantic UI colours read against dark HUD chrome and
// against each other; a danger marker that reads as a ward is a misclick.
{
  const r = separated('danger', 'ward', ACCENT_L_MIN, ACCENT_HUE_MIN);
  check('danger vs ward', r.ok, r.detail, ['danger', 'ward']);
}

// ============================================================================
// NEUTRAL-CAMP IDENTITY (GRAPHICS_CONTRACT §3) — the failure this prevents is
// concrete: a player blinks at a camp, reads it as an enemy wave, walks in and
// dies. Held to the same margin against BOTH teams and the WHOLE accent band.
// ============================================================================
const NEUTRAL_RIVALS: readonly AncientsPaletteKey[] = [
  'azure',
  'ember',
  'frost',
  'arcane',
  'heal',
  'shade',
  'pine',
  'void',
  'gold',
];
for (const name of NEUTRAL_RIVALS) {
  const r = separated('neutral', name, NEUTRAL_L_MIN, NEUTRAL_HUE_MIN);
  check(`neutral vs ${name}`, r.ok, r.detail, ['neutral', name]);
}
check(
  'neutral != team identity',
  hex('neutral') !== hex('azure') && hex('neutral') !== hex('ember'),
  `${hex('neutral')} vs azure ${hex('azure')} / ember ${hex('ember')}`,
  ['neutral', 'azure', 'ember'],
);

// ============================================================================
// CSS-VAR MIRROR — APAL_CSS_VARS is a complete, exact 1:1 mirror of APAL.
// ============================================================================
const palKeys = Object.keys(APAL) as AncientsPaletteKey[];
const varKeys = Object.keys(APAL_CSS_VARS) as AncientsPaletteKey[];
const missingVars = palKeys.filter((k) => !(k in APAL_CSS_VARS));
const extraVars = varKeys.filter((k) => !(k in APAL));
check(
  'css mirror complete',
  missingVars.length === 0 && extraVars.length === 0,
  `${palKeys.length} palette keys, ${varKeys.length} vars; missing=[${missingVars.join(', ')}] extra=[${extraVars.join(', ')}]`,
  // Deliberately touches NOTHING: this check is satisfied by a key merely
  // existing, so counting it as coverage would make the coverage gate below
  // vacuously green for every key in the palette.
  [],
);
const varNames = palKeys.map((k) => APAL_CSS_VARS[k]);
const badVarNames = varNames.filter((v) => !CSS_VAR_PATTERN.test(v));
check(
  'css var names well formed',
  badVarNames.length === 0,
  badVarNames.length === 0 ? `all ${varNames.length} match ${String(CSS_VAR_PATTERN)}` : `bad: [${badVarNames.join(', ')}]`,
  [],
);
const dupVarNames = varNames.filter((v, i) => varNames.indexOf(v) !== i);
check(
  'css var names unique',
  dupVarNames.length === 0,
  dupVarNames.length === 0 ? 'no duplicates' : `duplicated: [${[...new Set(dupVarNames)].join(', ')}]`,
  [],
);

// ============================================================================
// COVERAGE — the check that keeps this file honest as the palette grows. A key
// added to APAL with no law written for it fails HERE, by name.
// ============================================================================
const uncovered = palKeys.filter((k) => !touched.has(k));
check(
  'every APAL key is covered by a law',
  uncovered.length === 0,
  uncovered.length === 0
    ? `all ${palKeys.length} keys exercised`
    : `${uncovered.length} key(s) with no law: [${uncovered.join(', ')}] — write a law or delete the key`,
  [],
);

console.log(
  failures === 0
    ? `ALL GREEN — ${checks} checks over ${palKeys.length} palette keys`
    : `${failures} FAILURES of ${checks} checks`,
);
process.exit(failures === 0 ? 0 : 1);
