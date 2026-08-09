// ============================================================================
// ANCIENTS (rift) client — HUD (CONTRACT §6 ui/hud.ts + §8 UX bible, T9;
// re-dressed for the PBR pass by R_HUD, GRAPHICS_CONTRACT §6 + STYLE_BIBLE §0).
// Bottom-centre portrait/hp/mana/XP/state-chip cluster, ability and item bars
// with cooldowns, gold, K/D/A, top-centre match clock + day/night dial + team
// score + towers standing, top-right kill feed, TAB scoreboard, death overlay,
// first-60-seconds onboarding (ONE text hint at a time — RMB-move >
// learn-to-cast > shop — dismissed on use, plus the lane arrow, a SEPARATE
// directional indicator that must read AT SPAWN (§8) and so never queues
// behind the move hint; it is dismissed on arrival at the lane midpoint;
// everything is suppressed while the scoreboard is open), and the disconnect
// banner. Action feedback (round-6 UX): a successful BUY pops the item slot it
// landed in (one-shot scale) and floats a '-Ng' gold number off the gold
// readout; a spent skill point flashes the ability slot green (one-shot).
// Pure DOM — style.css owns layout and static look; this file owns structure,
// text, dynamic widths/opacities, and the ONLY colours it sets inline are APAL
// entries (team identity, hero accents, terrain-state chips) or `mix()` of two
// APAL entries.
//
// ---- WHAT THE PBR PASS ADDED (GRAPHICS_CONTRACT §6 "HUD and minimap") -------
// Four terrain/time affordances, because the world now HAS terrain and time
// and a HUD that does not report them leaves the player guessing at three
// mechanics they cannot see:
//
//   1. DAY/NIGHT DIAL on the match clock. `snap.dayPhase` (0 = full day,
//      1 = full night, continuous, wrapping) drives a sun->moon disc that
//      crossfades continuously — that continuity IS the anticipation cue, the
//      player watches night coming — plus a DAY/NIGHT word at the phase
//      midpoint and the LIVE vision penalty beside it, read out of the frozen
//      `nightVisionScale(dayPhase)` that `sim/vision.ts` itself applies. The
//      penalty ramps, so the readout ramps; quoting NIGHT_VISION_MULT's -25%
//      from the midpoint on would have doubled the figure the sim was using.
//      Never colour alone: dial AND word AND figure.
//   2. HIGH/LOW GROUND CHIP on the self readout. `elevationAt` at the hero's
//      own position. Bright on HIGH (the advantaged state: attackers below you
//      miss at HIGH_GROUND_MISS), dim on LOW — a MOBA HUD signals the
//      exception, not the default.
//   3. CONCEALED CHIP. `isConcealing` at the hero's position; hidden entirely
//      when not in foliage, so it costs no width in the common case.
//   4. MISS FLOAT on `rift_miss`. The event carries ENTITY ids, so the local
//      hero's entity is resolved by `pid` out of `snap.ents` — only on a miss
//      event, never per frame. The two directions are told apart by WORD,
//      ANCHOR and COLOUR, never by colour alone (§8): your own whiffed swing
//      floats the word MISS in danger-red off the PORTRAIT (the thing that
//      swung), an enemy's whiff against you floats EVADED in heal-green off
//      the HP BAR (the thing that was spared). An uphill miss with no feedback
//      reads as a bug (protocol.ts, rift_miss).
//
//      *** THIS CANNOT FIRE YET — TWO LINKS OF THE CHAIN ARE MISSING. ***
//      Traced end to end on the tree as it stands, and BOTH gaps are outside
//      this module:
//        1. `server/src/room.ts` `dispatchEvents` switches on `ev.k` over
//           cast/kill/structure/surge/end and has NO `'miss'` arm, so the
//           `SimEvent` that `AMENDMENT_1` §B.2 added — and that
//           `sim/types.ts:281` documents room.ts as mapping — is drained and
//           dropped. Nothing ever puts `rift_miss` on the wire. (S_ROOM.)
//        2. `client/src/net.ts` `parseEvent` (net.ts:303) has no `rift_miss`
//           case, so even once it is on the wire every miss event falls
//           through `default: return null` and never reaches
//           `ClientState.events`. (R_WIRE, recorded in AMENDMENT_3.)
//      The float below is correct and is tested against a synthetic event, but
//      it is UNREACHABLE in a real match until both land. Neither file is this
//      module's to edit. Do NOT report this affordance as working; the tripwire
//      in hud.test.ts fails if this note is removed while the gaps remain.
//
// DOM CLASSES ADDED BY THIS PASS — three, not zero. An earlier report of this
// work claimed "zero new DOM classes" while adding `.bar-hp--low`,
// `.match-clock--night` and `.team-score--you`; AMENDMENT_3 §F ratified all
// three on the merits (they are `--modifier` states of frozen classes, which
// is the established extension form and mints no new element name) and
// required that they be reported rather than elided. They are reported here.
// Two further modifiers, `.match-clock--surge` and `.item-slot--empty`,
// already existed in style.css but were never toggled from this file; this
// pass drives them for the first time, which is a new binding but not a new
// name. Everything else is genuinely classless: the day/night mark lives
// inside `.match-clock` as classless children, the two chips are classless
// children of `.hud-bars`, and the MISS float reuses `.dmg-number`.
//
// PER-FRAME COST, MEASURED. `dayPhase` moves continuously, so the dial's
// gradient and glow strings are PRE-BUILT at module load into a 25-step ladder
// and written only when the quantised step changes; `buildMap` is called at
// most once per match and its `MapDef` serves both the lane arrow and the
// terrain chips. Driven in headless Chrome for 6000 frames — a full 0 -> 1
// dayPhase traverse at tick rate — `render()` costs mean 0.01 ms, p95 0.1 ms,
// p99 0.1 ms, max 0.3 ms. A MutationObserver over the whole `.hud` subtree
// plus an instrumented `textContent` setter report ZERO style mutations and
// ZERO text writes on a settled frame, which is what GRAPHICS_CONTRACT §5
// asks for. It was not zero until this pass: the level-gated ult's sweep
// overlay was written twice per frame (see the ability loop), and that was the
// only traffic left. `hud.test.ts` pins it, so it stays zero.
//
// DOM CLASS CONTRACT (§6): only classes from the frozen list are rendered:
//   .hud .hud-portrait .hud-bars .bar .bar-hp .bar-mana .bar-xp
//   .ability-bar .ability-slot .ability-cd .ability-rank .ability-plus
//   .item-bar .item-slot .item-charges .item-cd .gold-readout .kda
//   .topbar .match-clock .team-score .tower-count .killfeed .kill-row
//   .scoreboard .death-overlay .respawn-count .hint .banner .dmg-number
//   .tooltip
// `.tooltip` is the ONE class the ability-tooltip pass added (ratified in
// CONTRACT §6's class list): a single shared element, never rebuilt per frame.
// Structural children that have no class in the contract (bar fills, glyph
// spans, key hints, the dial, the state chips, scoreboard columns, tooltip
// sections) are CLASSLESS elements — style.css styles them via descendant
// selectors (e.g. `.bar > i`, `.ability-slot > b`, `.match-clock > i`,
// `.hud-bars > div`, `.tooltip > ul > li`).
// State MODIFIERS of a frozen class are the established extension form and
// mint no new element name. The full set this file toggles is `--ready`,
// `--ult-locked`, `--learned`, `--pop`, `--empty`, `--denied`, `--low`,
// `--night`, `--surge` and `--you`; the last three plus `--low` are the ones
// this pass introduced or first bound (see the note above). Every numeric
// readout gets an inline font-size >= 12px so the §8 floor holds no matter
// what CSS lands.
//
// Team identity is NEVER colour alone (§8): every team readout pairs the APAL
// team colour with the AZURE/EMBER text label.
//
// The lane arrow assumes T7's fixed camera yaw (render/scene.ts: the camera
// sits at targetZ - back and looks along world +z), which maps world +z to
// screen UP and world +x to screen LEFT — verified against rendered shots
// (mid (48,48) renders up-left of the team-0 fountain (11,11)). If T7's scene
// ever changes that yaw, update laneArrowAngle() (one function, flagged there).
// ============================================================================
import { mix } from '@platform/shared';
import {
  APAL,
  CONCEAL_REVEAL_RADIUS,
  ELEV_HIGH,
  FOUNTAIN_RADIUS,
  ITEMS,
  LEVEL_CAP,
  SURGE_WAVE_GROWTH,
  TICK_DT,
  ULT_LEVEL_REQ,
  WAVE_GROWTH,
  XP_THRESHOLDS,
  buildMap,
  elevationAt,
  heroById,
  isConcealing,
  nightVisionScale,
} from '@rift/shared';
import type {
  AbilityDef,
  AuraStat,
  BoardEntry,
  Effect,
  HeroId,
  ItemId,
  MapDef,
  RiftEvent,
  RosterEntry,
  TeamId,
  YouSnap,
} from '@rift/shared';
import type { ClientState, UiActions, UiHandle } from '../contract.js';

// ---- tuning constants -------------------------------------------------------
const HINT_WINDOW_S = 60; // first-60-seconds onboarding window (§8)
const KILLFEED_ROW_MS = 6000; // a kill row lives this long, then drops
const KILLFEED_MAX_ROWS = 5;
const MOVE_HINT_DISMISS_M = 2; // hero moved this far from spawn = hint used
const SHOP_HINT_GOLD = 400; // §8: shop hint first appears at 400+ gold
const FONT_MIN_PX = 12; // §8: smallest HUD text at 1080p
const VALUE_FONT_PX = 13; // bar values + mana costs: above the 12px floor (round-2 UX)
const CHIP_FONT_PX = 12; // terrain state chips: exactly on the §8 floor
const LANE_ARROW_ARRIVE_M = 10; // hero this close to the lane midpoint = arrow used
const LANE_ARROW_OFFSET_PX = 200; // screen-space orbit radius (round-5 UX: 150 sat ON the hero)
const LANE_LABEL_MAX_S = 20; // hard fallback: the lane TEXT retires after 20s live (round-5 UX)
const UI_SCALE_MIN_W = 2200; // 21:9 ultrawide breakpoint (matches style.css)
const UI_SCALE_ULTRA = 1.2; // ultrawide HUD chrome scale (round-5 UX)

const TEAM_LABEL: readonly string[] = ['AZURE', 'EMBER'];
const TEAM_APAL: readonly string[] = [APAL.azure, APAL.ember];
const SLOT_KEYS: readonly string[] = ['Q', 'W', 'E', 'R'];

/** Lane display names in buildMap path order (edge WN, edge SE, mid). */
const LANE_NAMES: readonly (readonly string[])[] = [
  [],
  ['MID'],
  ['TOP', 'BOT'],
  ['TOP', 'BOT', 'MID'],
];

// ---- day / night dial ladder --------------------------------------------------
// `dayPhase` is continuous, so a naive implementation rebuilds a gradient
// string every frame — a per-frame allocation in the render loop, which §5
// bans outright. Instead the whole ramp is baked ONCE at module load into
// PHASE_STEPS+1 pre-joined strings and the render loop writes one of them only
// when the quantised step actually moves. `dayPhase` is a wrapping TRIANGLE
// over DAY_PERIOD_S = 600 s (config.ts), so it crosses 0 -> 1 in 300 s and 24
// steps is one write every 12.5 s of match time.
//
// The step size is small enough that the crossfade still reads as continuous,
// but not uniformly: computing CIE L* of each rung's mix() and taking the
// largest adjacent difference gives 0.318 L* on the disc core, 1.224 L* on its
// rim, and 1.856 L* on the glow. Only the core is under 1 L*; the two others
// are under the ~2.3 L* just-noticeable difference for adjacent large patches,
// which is the bar that actually matters. Raising PHASE_STEPS is the lever if
// the glow ever bands.
//
// Both endpoints of every mix() are APAL entries (STYLE_BIBLE §3): the sun is
// the gold family, the moon is `moon` over the `wetStone` shaded side, and the
// glow runs from goldDeep to nightHorizon so the dial's halo cools with the
// sky it reports.
const PHASE_STEPS = 24;
const DIAL_FILL: string[] = [];
const DIAL_GLOW: string[] = [];
const DIAL_SHADE: string[] = [];
const PHASE_TAG: string[] = [];
const PHASE_TITLE: string[] = [];
for (let i = 0; i <= PHASE_STEPS; i++) {
  const t = i / PHASE_STEPS;
  const core = mix(APAL.goldLit, APAL.moon, t);
  const rim = mix(APAL.gold, APAL.wetStoneLit, t);
  const glow = mix(APAL.goldDeep, APAL.nightHorizon, t);
  DIAL_FILL.push(`radial-gradient(circle at 34% 30%, ${core} 0%, ${rim} 74%)`);
  DIAL_GLOW.push(`0 0 ${(3 + 5 * t).toFixed(1)}px ${glow}`);
  DIAL_SHADE.push(t.toFixed(3));
  // THE PENALTY IS A RAMP, NOT A SWITCH — and getting this wrong is how a HUD
  // starts lying. `config.ts`'s `nightVisionScale` is a SMOOTH 1 ->
  // NIGHT_VISION_MULT ramp over the phase (AMENDMENT_1 §C, which amended
  // TERRAIN_CONTRACT §4.3's boolean snap), and `sim/vision.ts` scales every
  // hero and creep radius by exactly this call. Printing NIGHT_VISION_MULT's
  // full -25% from the halfway point onward would have stated twice the
  // penalty the sim was applying. What is baked below is the frozen function
  // evaluated at the same phase, so the readout cannot drift from the rule.
  const pct = Math.round((1 - nightVisionScale(t)) * 100);
  const word = t >= 0.5 ? 'NIGHT' : 'DAY';
  PHASE_TAG.push(pct >= 1 ? `${word} · VIS −${String(pct)}%` : word);
  PHASE_TITLE.push(
    pct >= 1
      ? `${word} — heroes and creeps see ${String(pct)}% less far. Wards, towers and ancients keep full sight.`
      : 'Full day — every unit has its full vision radius. The dial darkens as night comes on.',
  );
}

/** The overtime explanation. `renderDayNight` used to write `clock.title`
 *  unconditionally, which meant the SURGE word on the clock — a state that
 *  changes how every creep wave in the match behaves — had no explanation
 *  anywhere in the HUD: whatever a surge tooltip said was overwritten by the
 *  phase title on the very next dial rung. The two now COMPOSE (see
 *  `writeClockTitle`), and the numbers are read out of `config.ts` rather
 *  than typed here, so the tooltip cannot drift from the rule it describes. */
const SURGE_TITLE =
  `SURGE — overtime. Creep waves now compound at ` +
  `+${String(Math.round(SURGE_WAVE_GROWTH * 100))}% hp and damage per wave instead of ` +
  `+${String(Math.round(WAVE_GROWTH * 100))}%, and gain an extra melee creep for every ` +
  `full period of overtime elapsed. Pushing gets harder the longer you wait.`;

const CONCEAL_TITLE =
  `Concealed by foliage — enemies lose sight of you until one closes to ` +
  `${String(CONCEAL_REVEAL_RADIUS)} m`;
const HIGH_GROUND_TITLE =
  'HIGH GROUND — you see over the low ground and attacks fired up at you can miss';
const LOW_GROUND_TITLE =
  'LOW GROUND — you cannot see onto the plateau, and your attacks up at it can miss';

// ---- small helpers ------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string | null,
  parent: HTMLElement,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== null) e.className = cls;
  parent.appendChild(e);
  return e;
}

/** Write text only when it changed — per-frame DOM churn is the enemy. */
function setText(e: HTMLElement, s: string): void {
  if (e.textContent !== s) e.textContent = s;
}

/** Write a style property only when it changed. Same motive as setText: a
 *  redundant style write dirties layout even when the value is identical. */
function setStyle(e: HTMLElement, prop: 'background' | 'boxShadow' | 'opacity' | 'color', v: string): void {
  if (e.style[prop] !== v) e.style[prop] = v;
}

function fmtClock(gameSeconds: number): string {
  const s = Math.max(0, Math.floor(gameSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function fmtCooldown(gameSeconds: number): string {
  return gameSeconds >= 10 ? String(Math.ceil(gameSeconds)) : gameSeconds.toFixed(1);
}

/** APAL lookup by hero accent key; accents are palette keys per hero.ts but
 *  typed as plain string — resolve defensively, fall back to paper. */
function accentColor(accent: string): string {
  return (APAL as Record<string, string>)[accent] ?? APAL.paper;
}

/** Per-rank value with bounds safety (noUncheckedIndexedAccess). */
function rankVal(arr: readonly number[], rank: number): number {
  const idx = Math.min(Math.max(rank, 1), arr.length) - 1;
  return arr[idx] ?? 0;
}

/** Quantise `dayPhase` onto the pre-built dial ladder. Out-of-range input
 *  clamps rather than indexing past the end — the field is contractually
 *  [0,1] but a HUD must never throw on a bad number off the wire. */
function phaseStep(t: number): number {
  if (!Number.isFinite(t)) return 0;
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return Math.round(c * PHASE_STEPS);
}

/** Arc-length midpoint of a lane polyline (the arrow target). */
function laneMidpoint(path: readonly { readonly x: number; readonly z: number }[]): {
  x: number;
  z: number;
} {
  let total = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (a && b) total += Math.hypot(b.x - a.x, b.z - a.z);
  }
  let remain = total / 2;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (!a || !b) continue;
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (remain <= seg || i + 2 === path.length) {
      const u = seg > 1e-9 ? Math.min(1, Math.max(0, remain / seg)) : 0;
      return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u };
    }
    remain -= seg;
  }
  const last = path[path.length - 1];
  return { x: last?.x ?? 0, z: last?.z ?? 0 };
}

/** Screen angle (radians, CSS rotate) for the lane arrow. T7's camera looks
 *  along world +z from behind (scene.ts applyCamera), so world +z is screen
 *  UP and world +x is screen LEFT: screen dx = -(world dx), screen dy(screen
 *  down) = -(world dz). Yields a direct CSS rotate() angle (0 = pointing
 *  right, positive clockwise). */
function laneArrowAngle(camX: number, camZ: number, tx: number, tz: number): number {
  return Math.atan2(-(tz - camZ), -(tx - camX));
}

// ---- per-slot DOM structs ------------------------------------------------------

interface AbilitySlotDom {
  slot: HTMLButtonElement;
  glyph: HTMLElement;
  key: HTMLElement;
  cost: HTMLElement;
  cd: HTMLElement;
  rank: HTMLElement;
  plus: HTMLButtonElement;
}

interface ItemSlotDom {
  slot: HTMLButtonElement;
  glyph: HTMLElement;
  key: HTMLElement;
  charges: HTMLElement;
  cd: HTMLElement;
}

interface KillRow {
  key: string;
  html: string;
  at: number;
}

export function createHud(parent: HTMLElement): UiHandle {
  const root = el('div', 'hud', parent);
  root.style.display = 'none';

  // -- ultrawide inline-font scaling (round-5 UX) -------------------------------
  // A stylesheet can NEVER override an inline font-size, and transform:scale
  // never changes computed text size — so every inline px goes through
  // fitText and is re-applied when the 2200px breakpoint flips. style.css
  // owns the geometry side of the same 1.2x scale.
  let uiScaleApplied = 1;
  const scaledTexts: { e: HTMLElement; base: number }[] = [];
  const scaledPx = (base: number): string =>
    `${Math.round(base * uiScaleApplied * 10) / 10}px`;
  function fitText(e: HTMLElement, basePx: number): void {
    scaledTexts.push({ e, base: basePx });
    e.style.fontSize = scaledPx(basePx);
  }
  function applyUiScale(): void {
    const s = window.innerWidth >= UI_SCALE_MIN_W ? UI_SCALE_ULTRA : 1;
    if (s === uiScaleApplied) return;
    uiScaleApplied = s;
    for (const t of scaledTexts) t.e.style.fontSize = scaledPx(t.base);
    for (const row of Array.from(killfeed.children)) {
      (row as HTMLElement).style.fontSize = scaledPx(FONT_MIN_PX);
    }
    scoreboardSig = ''; // force a rebuild at the new scale
  }

  // -- top bar -------------------------------------------------------------------
  // Each score plate is `<b>NAME</b><i>n</i>` (team 1 mirrored) so the team
  // label is a real element instead of a colour — §8's never-colour-alone law
  // — and so the number can carry tabular figures without dragging the label.
  const topbar = el('div', 'topbar', root);
  const scoreA = el('span', 'team-score', topbar);
  const scoreAName = el('b', null, scoreA);
  scoreAName.textContent = TEAM_LABEL[0] ?? '';
  fitText(scoreAName, 13);
  const scoreAVal = el('i', null, scoreA);
  fitText(scoreAVal, 18);
  const towersA = el('span', 'tower-count', topbar);
  fitText(towersA, 14);

  const clock = el('span', 'match-clock', topbar);
  // the dial: a sun/moon disc whose crescent shade rides in as night falls
  const dial = el('i', null, clock);
  const dialShade = el('u', null, dial);
  const clockText = el('b', null, clock);
  fitText(clockText, 20);
  const phaseTag = el('em', null, clock);
  fitText(phaseTag, FONT_MIN_PX);

  const towersB = el('span', 'tower-count', topbar);
  fitText(towersB, 14);
  const scoreB = el('span', 'team-score', topbar);
  const scoreBVal = el('i', null, scoreB);
  fitText(scoreBVal, 18);
  const scoreBName = el('b', null, scoreB);
  scoreBName.textContent = TEAM_LABEL[1] ?? '';
  fitText(scoreBName, 13);

  // -- kill feed (top right) -------------------------------------------------------
  const killfeed = el('div', 'killfeed', root);

  // -- disconnect banner -------------------------------------------------------------
  const banner = el('div', 'banner', root);
  banner.style.display = 'none';
  fitText(banner, 16);
  banner.textContent = 'CONNECTION LOST — reconnecting…';

  // -- bottom-centre cluster ---------------------------------------------------------
  const bottom = el('div', null, root); // classless row wrapper (`.hud > div`)

  const portrait = el('button', 'hud-portrait', bottom);
  const portraitGlyph = el('b', null, portrait);
  const portraitName = el('span', null, portrait);
  fitText(portraitName, FONT_MIN_PX);

  const bars = el('div', 'hud-bars', bottom);
  const barHp = el('div', 'bar bar-hp', bars);
  const barHpFill = el('i', null, barHp);
  const barHpText = el('span', null, barHp);
  fitText(barHpText, VALUE_FONT_PX);
  const barMana = el('div', 'bar bar-mana', bars);
  const barManaFill = el('i', null, barMana);
  const barManaText = el('span', null, barMana);
  fitText(barManaText, VALUE_FONT_PX);
  const barXp = el('div', 'bar bar-xp', bars);
  const barXpFill = el('i', null, barXp);
  const barXpText = el('span', null, barXp);
  fitText(barXpText, VALUE_FONT_PX);
  // terrain state chips — the classless 4th child of .hud-bars. Sized in CSS
  // to fit the slack the bars column already had under the taller item bar,
  // which is what drives the cluster's height, so the cluster does not grow.
  // RE-MEASURED at 1920x1080 (headless Chrome driving this file's real
  // createHud against the pre-PBR pair at 14abcbd): the cluster went
  // 906.39x107 -> 872.56x99, i.e. -10600 px², and the top bar went the OTHER
  // way — +2046 px² by day, +5860 at night, +6114 in overtime. Net over the
  // two panels: -7.73% day, -4.28% night, -3.96% overtime. The old "5-7% less"
  // figure quoted here was the day pose only; style.css's header carries the
  // full table.
  const stateRow = el('div', null, bars);
  const chipElev = el('span', null, stateRow);
  fitText(chipElev, CHIP_FONT_PX);
  const chipHide = el('span', null, stateRow);
  fitText(chipHide, CHIP_FONT_PX);
  chipHide.style.display = 'none';
  chipHide.textContent = '❋ HIDDEN';
  chipHide.title = CONCEAL_TITLE;
  chipHide.style.color = APAL.fernLit;

  const abilityBar = el('div', 'ability-bar', bottom);
  const abilityDoms: AbilitySlotDom[] = [];
  for (let i = 0; i < 4; i++) {
    const slot = el('button', 'ability-slot', abilityBar);
    const glyph = el('b', null, slot);
    const key = el('kbd', null, slot);
    key.textContent = SLOT_KEYS[i] ?? '';
    fitText(key, FONT_MIN_PX);
    const cd = el('div', 'ability-cd', slot);
    const cost = el('span', null, slot); // `.ability-slot > span` (mana cost)
    fitText(cost, VALUE_FONT_PX);
    const rank = el('div', 'ability-rank', slot);
    fitText(rank, FONT_MIN_PX);
    const plus = el('button', 'ability-plus', slot);
    plus.textContent = '+';
    fitText(plus, 14);
    plus.style.display = 'none';
    abilityDoms.push({ slot, glyph, key, cost, cd, rank, plus });
  }

  // -- ability tooltip (one shared card for all four slots) ---------------------
  // Replaces the native `title` one-liner. Built ONCE here; populated and
  // positioned on pointerenter/focus, hidden on pointerleave/blur — never
  // touched by the per-frame render (GRAPHICS_CONTRACT §5). pointer-events:
  // none in style.css, so it can never swallow a click meant for the bar.
  const tooltip = el('div', 'tooltip', root);
  tooltip.style.display = 'none';
  for (let i = 0; i < abilityDoms.length; i++) {
    const dom = abilityDoms[i];
    if (!dom) continue;
    dom.slot.onpointerenter = () => showAbilityTooltip(i);
    dom.slot.onfocus = () => showAbilityTooltip(i);
    dom.slot.onpointerleave = hideAbilityTooltip;
    dom.slot.onblur = hideAbilityTooltip;
  }

  const itemBar = el('div', 'item-bar', bottom);
  const itemDoms: ItemSlotDom[] = [];
  for (let i = 0; i < 6; i++) {
    const slot = el('button', 'item-slot', itemBar);
    const glyph = el('b', null, slot);
    const key = el('kbd', null, slot);
    key.textContent = String(i + 1);
    fitText(key, FONT_MIN_PX);
    const charges = el('span', 'item-charges', slot);
    fitText(charges, FONT_MIN_PX);
    const cd = el('div', 'item-cd', slot);
    itemDoms.push({ slot, glyph, key, charges, cd });
  }

  const gold = el('button', 'gold-readout', bottom);
  fitText(gold, 16);
  gold.title = 'Open the shop (must stand at your fountain to buy)';

  const kda = el('span', 'kda', bottom);
  fitText(kda, 14);

  // -- death overlay -----------------------------------------------------------------
  const death = el('div', 'death-overlay', root);
  death.style.display = 'none';
  const deathText = el('div', null, death);
  deathText.textContent = 'YOU DIED';
  const respawn = el('div', 'respawn-count', death);
  fitText(respawn, 48);

  // -- scoreboard (TAB) -------------------------------------------------------------
  const scoreboard = el('div', 'scoreboard', root);
  scoreboard.style.display = 'none';

  // -- first-60-seconds onboarding -------------------------------------------------
  const hintMove = el('div', 'hint', root);
  hintMove.style.display = 'none';
  fitText(hintMove, 16);
  hintMove.textContent = 'RIGHT-CLICK the ground to move';
  // lane arrow: a SEPARATE directional indicator (§8), not one of the queued
  // text hints — it must read at spawn, so it never waits behind hintMove.
  // It is positioned inline (screen-space orbit toward the lane midpoint);
  // the .hint rule supplies the pill look; the inline left/top/bottom/
  // transform override the pill's default bottom-centre anchor.
  const hintLane = el('div', 'hint', root);
  hintLane.style.display = 'none';
  fitText(hintLane, 16);
  hintLane.style.bottom = 'auto';
  hintLane.style.transform = 'translate(-50%, -50%)';
  const hintLaneArrow = el('b', null, hintLane);
  hintLaneArrow.textContent = '➤';
  hintLaneArrow.style.display = 'inline-block'; // transformable
  fitText(hintLaneArrow, 24);
  const hintLaneText = el('span', null, hintLane);
  const hintShop = el('div', 'hint', root);
  hintShop.style.display = 'none';
  fitText(hintShop, 16);
  hintShop.textContent = 'You have gold — open the SHOP at your fountain';
  // learn-to-cast (round-6 UX): a hero with an unspent first point and every
  // ability at rank 0 cannot cast at all — say so, between the move hint and
  // the shop hint in priority. Retires on the first point spent (the
  // all-rank-0 condition below) or at the end of the onboarding window.
  const hintLearn = el('div', 'hint', root);
  hintLearn.style.display = 'none';
  fitText(hintLearn, 16);
  hintLearn.textContent = 'Press + (or Ctrl+Q) to learn an ability — then Q/W/E/R to cast';

  // -- cast-denied toast (T8 bugfix: QWER used to fail in silence) ---------------
  // Same .hint pill, --denied modifier (frozen class list allows modifiers):
  // no pulse animation, danger accent. input.ts preflights each quick-cast
  // through game.ts and pushes the reason into ClientState.toast.
  const castToast = el('div', 'hint hint--denied', root);
  castToast.style.display = 'none';
  fitText(castToast, 14);
  castToast.style.bottom = '176px'; // above the onboarding pill's 130px anchor

  // -- render-cycle state (no per-frame allocation beyond the killfeed rebuild) --------
  let heroId: HeroId | null = null; // hero of the current match (slot glyphs are static per match)
  let heroDefs: readonly AbilityDef[] = [];
  let lastYou: YouSnap | null = null; // latest you-snapshot — the tooltip reads ranks off it at hover time
  let beginRef: ClientState['begin'] = null; // identity watch: a new begin = a new match
  let matchMap: MapDef | null = null; // built once per match: lane arrow + terrain chips
  let matchMapFailed = false; // buildMap threw (impossible lane count) — never retry
  let spawnX = 0;
  let spawnZ = 0;
  let spawnKnown = false;
  let movedEnough = false;
  let orderIssued = false; // first move ORDER retires the lane text + RMB hint
  let shopOpenedOnce = false;
  let laneTarget: { x: number; z: number } | null = null;
  let laneName = '';
  let killRows: KillRow[] = [];
  /** key -> the live `.kill-row` element, so a rebuild can keep the elements
   *  it is not changing. Kept in lockstep with `killfeed`'s children. */
  const killRowEls = new Map<string, HTMLElement>();
  let eventsSeenLen = 0; // killfeed rebuild only when the events tail changes
  let eventsSeenLast: unknown = null;
  let scoreboardSig = '';
  let scoreboardWasOpen = false;
  let dialStep = -1; // last written rung of the day/night ladder
  let dialInit = false; // the dial + word have been written at least once
  let clockSurge = false; // last written overtime state (feeds the clock title)
  let elevHighShown = false; // last written high/low chip state
  let elevChipInit = false;
  let chipsShown = true; // last written visibility of the terrain-chip row

  // ---- action feedback (buy pop + gold float + skill flash) -------------------
  // Snap-diffed: baseline on the FIRST sight of `you` (a late joiner must not
  // pop every owned slot), then a slot going empty -> filled pops it, a gold
  // drop floats '-Ng' (buying is the ONLY gold sink), a rank going up flashes
  // green. All animations are one-shot (no >1Hz flashing — § flash law).
  let prevItems: readonly (ItemId | null)[] | null = null;
  let prevGold: number | null = null;
  const prevRanks = [0, 0, 0, 0]; // preallocated — no per-frame array churn
  let ranksBaselined = false;
  const poppingSlots = new Set<number>(); // item slots mid-pop
  const flashingSlots = new Set<number>(); // ability slots mid-flash

  // ---- rift_miss feed ---------------------------------------------------------
  // The events window is a rolling tail of stable objects, so "what is new" is
  // "everything after the last object I saw". A window whose tail I no longer
  // recognise (a reconnect, a >32-event burst) RESYNCS silently rather than
  // replaying six seconds of misses at once.
  let lastEventSeen: RiftEvent | null = null;
  let eventsBaselined = false;

  // FLOAT BUDGETS ARE PER CHANNEL, not global. A single shared cap meant an
  // uphill brawl — which can produce several misses a second, and is exactly
  // the situation the miss float exists for — filled every slot and starved
  // the gold-spend pill, so a purchase made during a fight silently produced
  // no feedback at all. Two independent budgets: the miss channel can flood
  // and drop its own overflow without ever touching the gold channel. Gold
  // needs only 2 because purchases are hand-paced and the pill lives 900 ms.
  type FloatChannel = 'miss' | 'gold';
  const FLOAT_CAP: Readonly<Record<FloatChannel, number>> = { miss: 4, gold: 2 };
  const liveFloats: Record<FloatChannel, number> = { miss: 0, gold: 0 };

  /** Show or hide the terrain-chip row as a unit.
   *
   *  The chips report where the hero is STANDING, so they are a lie the moment
   *  there is no hero standing anywhere: with no `you` in the snapshot, and
   *  while the hero is dead under the death overlay, a stale '▼ LOW' kept
   *  rendering — a corpse does not hold low ground, and the overlay is
   *  translucent so the player reads it right through the shroud.
   *
   *  `visibility`, not `display`. `.hud-bars` is a column inside a
   *  `align-items: flex-end` row, so removing the 12px row from flow would
   *  slide all three bars down 16px on death and back up on respawn. Hiding it
   *  keeps the box and its geometry exactly where they were. `elevChipInit` is
   *  cleared on hide so the next live frame writes fresh text rather than
   *  trusting the pre-death cached state. */
  function setChipsVisible(v: boolean): void {
    if (v === chipsShown) return;
    chipsShown = v;
    stateRow.style.visibility = v ? '' : 'hidden';
    if (!v) elevChipInit = false;
  }

  function popItemSlot(i: number): void {
    if (poppingSlots.has(i)) return;
    const dom = itemDoms[i];
    if (!dom) return;
    poppingSlots.add(i);
    dom.slot.classList.add('item-slot--pop');
    window.setTimeout(() => {
      poppingSlots.delete(i);
      dom.slot.classList.remove('item-slot--pop');
    }, 400); // > the 0.35s pop animation
  }

  function flashAbilitySlot(i: number): void {
    if (flashingSlots.has(i)) return;
    const dom = abilityDoms[i];
    if (!dom) return;
    flashingSlots.add(i);
    dom.slot.classList.add('ability-slot--learned');
    window.setTimeout(() => {
      flashingSlots.delete(i);
      dom.slot.classList.remove('ability-slot--learned');
    }, 700); // > the 0.6s learn flash
  }

  /** A `.dmg-number` pill launched off a HUD element — the same rising pill
   *  the world-space numbers use (fx sets the colour inline; so do we — APAL
   *  only). Capped per channel, because an uphill brawl can produce several
   *  misses a second: a HUD that stacks 30 pills is worse than one that stacks
   *  none, and a miss flood must never be able to eat the gold pill's slot. */
  function floatFrom(
    anchor: HTMLElement,
    text: string,
    color: string,
    dy: number,
    channel: FloatChannel,
  ): void {
    if (liveFloats[channel] >= FLOAT_CAP[channel]) return;
    const rect = anchor.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return; // anchor not laid out
    const n = document.createElement('div');
    n.className = 'dmg-number';
    n.textContent = text;
    n.style.position = 'fixed';
    n.style.left = `${(rect.left + rect.width / 2).toFixed(0)}px`;
    n.style.top = `${(rect.top - dy).toFixed(0)}px`;
    n.style.color = color;
    n.style.pointerEvents = 'none';
    root.appendChild(n);
    liveFloats[channel]++;
    window.setTimeout(() => {
      n.remove();
      liveFloats[channel]--;
    }, 900); // > the 0.8s rise animation
  }

  // ---- ability tooltip content -------------------------------------------------
  // The card's numbers are read out of the SAME sources the per-frame ability
  // render uses — the frozen `AbilityDef` (heroDefs) and the live rank off
  // `lastYou.abilities` — evaluated ONCE at hover time. An unlearned ability
  // previews its rank-1 values and says so; a learned one below max rank shows
  // the next rank's value after an arrow, but only where the value actually
  // changes (a flat 70 mana cost across all ranks reads `70`, not `70 → 70`).

  /** Compact number: integers stay bare, fractions keep one decimal. */
  function fmtNum(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  /** Human-readable aura stat names (schema vocabulary is camelCase). */
  const AURA_STAT_LABEL: Record<AuraStat, string> = {
    armor: 'Armour',
    damage: 'Damage',
    attackSpeed: 'Attack speed',
    moveSpeed: 'Move speed',
    hpRegen: 'Health regen',
    manaRegen: 'Mana regen',
  };

  /** Row label for one effect primitive. */
  function effectLabel(fx: Effect): string {
    switch (fx.kind) {
      case 'damage':
        return fx.school === 'magic' ? 'Magic damage' : 'Physical damage';
      case 'heal':
        return 'Heal';
      case 'stun':
        return 'Stun';
      case 'slow':
        return 'Slow';
      case 'dash':
        return 'Dash';
      case 'aura': {
        const stat = AURA_STAT_LABEL[fx.stat] ?? fx.stat;
        return fx.duration === 0 ? `Aura — ${stat}` : `${stat} bonus`;
      }
      case 'summon':
        return 'Summon';
    }
  }

  /** One effect's headline numbers at `rank` (1-based). */
  function effectValue(fx: Effect, rank: number): string {
    switch (fx.kind) {
      case 'damage':
      case 'heal':
        return fmtNum(rankVal(fx.amount, rank));
      case 'stun':
        return `${fmtNum(rankVal(fx.duration, rank))}s`;
      case 'slow':
        return `${String(Math.round(rankVal(fx.pct, rank) * 100))}% · ${fmtNum(rankVal(fx.duration, rank))}s`;
      case 'dash':
        return `${fmtNum(fx.distance)}m`; // scalar — same at every rank
      case 'aura': {
        const v = fx.pct
          ? `+${String(Math.round(rankVal(fx.amount, rank) * 100))}%`
          : `+${fmtNum(rankVal(fx.amount, rank))}`;
        const bits = [v];
        if (fx.radius > 0) bits.push(`${fmtNum(fx.radius)}m`);
        if (fx.duration > 0) bits.push(`${fmtNum(fx.duration)}s`);
        return bits.join(' · ');
      }
      case 'summon': {
        const count = rankVal(fx.count, rank);
        return `${String(count)} shade${count > 1 ? 's' : ''} · ${fmtNum(rankVal(fx.duration, rank))}s`;
      }
    }
  }

  function showAbilityTooltip(i: number): void {
    const dom = abilityDoms[i];
    const ab = heroDefs[i];
    if (!dom || !ab) return; // no hero bound yet — nothing honest to show
    const rank = lastYou?.abilities[i]?.rank ?? 0;
    const cur = Math.max(rank, 1); // unlearned previews rank-1 values
    const nxt = rank >= 1 && rank < ab.maxRank ? rank + 1 : null;

    // Built into a detached host, then swapped in one replaceChildren — the
    // same pattern as rebuildScoreboard, and hover-triggered, never per frame.
    // Every element is classless; style.css styles `.tooltip > *` descendants.
    const host = document.createElement('div');
    const header = el('header', null, host);
    el('b', null, header).textContent = ab.icon;
    el('strong', null, header).textContent = ab.name;
    el('kbd', null, header).textContent = SLOT_KEYS[i] ?? '';
    if (ab.ult) el('em', null, header).textContent = 'ULT';
    else if (ab.isPassive) el('em', null, header).textContent = 'PASSIVE';
    el('i', null, host).textContent = ab.blurb;

    const list = el('ul', null, host);
    const row = (label: string, curText: string, nextText?: string): void => {
      const li = el('li', null, list);
      el('span', null, li).textContent = label;
      el('b', null, li).textContent =
        nextText !== undefined && nextText !== curText
          ? `${curText} → ${nextText}`
          : curText;
    };
    const at = (arr: readonly number[], suffix: string): [string, string | undefined] => [
      `${fmtNum(rankVal(arr, cur))}${suffix}`,
      nxt === null ? undefined : `${fmtNum(rankVal(arr, nxt))}${suffix}`,
    ];
    row(
      'Rank',
      rank === 0
        ? `not learned — rank 1 of ${String(ab.maxRank)}`
        : `${String(rank)} of ${String(ab.maxRank)}`,
    );
    if (!ab.isPassive) {
      row('Cooldown', ...at(ab.cooldown, 's'));
      row('Mana cost', ...at(ab.manaCost, ''));
    }
    if (rankVal(ab.castRange, cur) > 0) row('Cast range', ...at(ab.castRange, 'm'));
    if (ab.aoeRadius) row('Effect radius', ...at(ab.aoeRadius, 'm'));
    for (const fx of ab.effects) {
      row(effectLabel(fx), effectValue(fx, cur), nxt === null ? undefined : effectValue(fx, nxt));
    }
    tooltip.replaceChildren(...Array.from(host.childNodes));

    // Above the hovered slot, horizontally clamped to the viewport (the bar
    // sits bottom-centre, so there is always room above it).
    tooltip.style.display = '';
    const rect = dom.slot.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(rect.left + rect.width / 2 - box.width / 2, window.innerWidth - box.width - 8),
    );
    tooltip.style.left = `${left.toFixed(0)}px`;
    tooltip.style.top = `${Math.max(8, rect.top - box.height - 10).toFixed(0)}px`;
  }

  function hideAbilityTooltip(): void {
    if (tooltip.style.display !== 'none') tooltip.style.display = 'none';
  }

  function resetMatchHints(): void {
    spawnKnown = false;
    movedEnough = false;
    orderIssued = false;
    shopOpenedOnce = false;
    laneTarget = null;
    laneName = '';
    matchMap = null;
    matchMapFailed = false;
    prevItems = null; // re-baseline: a new match must not float the old gold delta
    prevGold = null;
    ranksBaselined = false;
    eventsBaselined = false;
    lastEventSeen = null;
  }

  /** The match's `MapDef`, built at most once and shared by the lane arrow and
   *  the terrain chips. `buildMap` throws on an impossible lane count, and a
   *  HUD that throws takes the frame with it (§10 robustness), so a failure is
   *  latched and the terrain affordances simply stay quiet. */
  function mapOf(s: ClientState): MapDef | null {
    if (matchMap !== null || matchMapFailed) return matchMap;
    const begin = s.begin;
    if (!begin) return null;
    try {
      matchMap = buildMap(begin.lanes);
    } catch {
      matchMapFailed = true;
      matchMap = null;
    }
    return matchMap;
  }

  // First move ORDER detection (round-5 UX: the 'your lane: MID' text and the
  // RMB hint were both still up at 0:59). input.ts sends orders straight to
  // the net — unreachable through the frozen ClientState/UiActions seams — so
  // hud listens to the SAME raw verbs input.ts maps onto rift_order: RMB down
  // (move/attack), A (attack-move arm), S (stop). Capture phase, inert in the
  // unit harness, reset per match; the snap-observed position fallback
  // (movedEnough) and the hard 20s clock (LANE_LABEL_MAX_S) back it up.
  window.addEventListener(
    'pointerdown',
    (ev) => {
      if (ev.button === 2) orderIssued = true;
    },
    true,
  );
  window.addEventListener(
    'keydown',
    (ev) => {
      if (ev.code === 'KeyA' || ev.code === 'KeyS') orderIssued = true;
    },
    true,
  );

  /** id -> display name, from hello.roster + the newest rift_roster event. */
  function buildNameMap(s: ClientState, out: Map<string, string>): void {
    out.clear();
    const helloRoster: readonly RosterEntry[] | undefined = s.hello?.roster;
    if (helloRoster) {
      for (const r of helloRoster) out.set(r.id, r.name);
    }
    const events = s.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev && ev.t === 'rift_roster') {
        for (const r of ev.roster) out.set(r.id, r.name);
        break; // newest roster event wins
      }
    }
  }

  const nameMap = new Map<string, string>();

  function boardEntry(s: ClientState, id: string): BoardEntry | null {
    const board = s.snap?.board;
    if (!board) return null;
    for (const b of board) {
      if (b.id === id) return b;
    }
    return null;
  }

  function playerLabel(s: ClientState, id: string | null): string {
    if (id === null) return 'the creeps';
    const name = nameMap.get(id);
    const b = boardEntry(s, id);
    const hero = b ? heroById(b.hero).name : null;
    if (name && hero) return `${name} (${hero})`;
    if (name) return name;
    if (hero) return hero;
    return 'a hero';
  }

  function playerTeam(s: ClientState, id: string | null): TeamId | null {
    if (id === null) return null;
    return boardEntry(s, id)?.team ?? null;
  }

  /** The local hero's ENTITY id, or -1. `rift_miss` carries entity ids while
   *  `hello.you` is a player id, and `YouSnap` has no entity id — the join is
   *  `EntSnap.pid`. Only called when a miss event actually lands, so this scan
   *  costs nothing per frame. */
  function ownEntityId(s: ClientState): number {
    const snap = s.snap;
    const me = s.hello?.you;
    if (!snap || me === undefined) return -1;
    for (const e of snap.ents) {
      if (e.k === 'hero' && e.pid === me) return e.id;
    }
    return -1;
  }

  /** Float a marker for every uphill whiff the local hero was part of.
   *
   *  THREE DISCRIMINATORS, NEVER JUST HUE (§8). The two directions previously
   *  floated the identical word at the identical anchor in two different
   *  colours, which is a colour-alone signal and unreadable to ~8% of players:
   *
   *    you whiffed      -> 'MISS'   danger, off the PORTRAIT (you swung)
   *    they whiffed you -> 'EVADED' heal,   off the HP BAR   (you were spared)
   *
   *  The words differ, the colours differ, and the two pills launch from
   *  genuinely separate places: measured at 1920x1080 the portrait centre is
   *  x=567.72 and the hp-bar centre x=709.72, so the pills spawn 142 px apart
   *  horizontally (and 6 px apart vertically). Any one of the three cues
   *  carries the meaning on its own.
   *
   *  NOTE — unreachable in a real match: room.ts never puts `rift_miss` on the
   *  wire and net.ts:303 `parseEvent` would drop it if it did. Both gaps are
   *  other modules'; see the file header for the trace. */
  function drainMisses(s: ClientState): void {
    const events = s.events;
    if (!eventsBaselined) {
      eventsBaselined = true;
      lastEventSeen = events.length > 0 ? events[events.length - 1] ?? null : null;
      return;
    }
    let start = 0;
    if (lastEventSeen !== null) {
      const idx = events.lastIndexOf(lastEventSeen);
      // tail no longer in the window: resync, do not replay the whole buffer
      start = idx >= 0 ? idx + 1 : events.length;
    }
    if (start >= events.length) return;
    let mine = -2; // -2 = not resolved yet this drain
    for (let i = start; i < events.length; i++) {
      const ev = events[i];
      if (!ev || ev.t !== 'rift_miss') continue;
      if (mine === -2) mine = ownEntityId(s);
      if (mine < 0) continue;
      if (ev.attacker === mine) floatFrom(portrait, 'MISS', APAL.danger, 10, 'miss');
      else if (ev.target === mine) floatFrom(barHp, 'EVADED', APAL.heal, 10, 'miss');
    }
    lastEventSeen = events[events.length - 1] ?? lastEventSeen;
  }

  /** Day/night dial + word + vision tag. Everything written here is either a
   *  pre-built string off the ladder or a two-state constant, and every write
   *  is guarded on change, so a continuously moving `dayPhase` costs at most
   *  three property writes every ~12 s of match time. */
  function renderDayNight(t: number): void {
    const step = phaseStep(t);
    if (step === dialStep && dialInit) return;
    dialStep = step;
    dialInit = true;
    setStyle(dial, 'background', DIAL_FILL[step] ?? DIAL_FILL[0] ?? '');
    setStyle(dial, 'boxShadow', DIAL_GLOW[step] ?? DIAL_GLOW[0] ?? '');
    setStyle(dialShade, 'opacity', DIAL_SHADE[step] ?? '0');
    // the word flips at the phase midpoint; the figure beside it moves with
    // every rung, because the penalty itself does
    const night = step * 2 >= PHASE_STEPS;
    clock.classList.toggle('match-clock--night', night);
    setText(phaseTag, PHASE_TAG[step] ?? 'DAY');
    setStyle(phaseTag, 'color', night ? APAL.moon : APAL.goldLit);
    writeClockTitle();
  }

  /** The clock plate reports TWO independent states — the day/night phase and
   *  whether the match is in overtime — and one `title` has to carry both.
   *  Composing rather than assigning is the whole point: `renderDayNight`
   *  fires on every dial rung, so anything it wrote unconditionally would
   *  erase the surge explanation within ~12 s of it appearing. Guarded on
   *  change, because both callers run on frames where nothing moved. */
  function writeClockTitle(): void {
    const phase = PHASE_TITLE[dialStep] ?? '';
    const next = clockSurge ? `${SURGE_TITLE}\n\n${phase}` : phase;
    if (clock.title !== next) clock.title = next;
  }

  function rebuildKillfeed(s: ClientState, nowMs: number): void {
    const events = s.events;
    // occurrence ordinals make textually-identical kills distinct keys
    const ordinals = new Map<string, number>();
    const fresh: KillRow[] = [];
    const kept = new Set<string>();
    for (let i = events.length - 1; i >= 0 && fresh.length < KILLFEED_MAX_ROWS; i--) {
      const ev = events[i];
      if (!ev || ev.t !== 'rift_kill') continue;
      const base = `${ev.killer ?? ''}>${ev.victim}>${ev.gold}>${ev.firstBlood ? 1 : 0}`;
      const ord = (ordinals.get(base) ?? 0) + 1;
      ordinals.set(base, ord);
      const key = `${base}#${ord}`;
      kept.add(key);
      const existing = killRows.find((r) => r.key === key);
      if (existing) {
        fresh.push(existing);
        continue;
      }
      const killer = playerLabel(s, ev.killer);
      const victim = playerLabel(s, ev.victim);
      const kt = playerTeam(s, ev.killer);
      const vt = playerTeam(s, ev.victim);
      const kc = kt === null ? APAL.paperDim : TEAM_APAL[kt] ?? APAL.paper;
      const vc = vt === null ? APAL.paperDim : TEAM_APAL[vt] ?? APAL.paper;
      const ktName = kt === null ? '' : `${TEAM_LABEL[kt] ?? ''} `;
      const vtName = vt === null ? '' : `${TEAM_LABEL[vt] ?? ''} `;
      const fb = ev.firstBlood ? ' — FIRST BLOOD' : '';
      // bounty suffix only when gold actually changed hands (round-3 UX:
      // creep kills read '+0g' — pure noise on every wave clear)
      const bounty = ev.gold > 0 ? ` +${ev.gold}g` : '';
      const suffix = `${bounty}${fb}`;
      // team identity: colour AND the AZURE/EMBER label, never colour alone
      const html =
        `<span style="color:${kc}">${ktName}${escapeHtml(killer)}</span>` +
        ` ⚔ <span style="color:${vc}">${vtName}${escapeHtml(victim)}</span>` +
        (suffix === '' ? '' : `<i>${suffix}</i>`);
      fresh.push({ key, html, at: nowMs });
    }
    // drop expired rows and rows no longer in the events window
    killRows = fresh.filter((r) => nowMs - r.at <= KILLFEED_ROW_MS && kept.has(r.key));

    // ---- INCREMENTAL DOM: a row element outlives the rebuild that keeps it --
    // This used to be one `replaceChildren(...killRows.map(create))`, which
    // destroys and recreates EVERY row on every change. `.kill-row` carries a
    // one-shot `rift-feed-in` slide, and a freshly-created element always runs
    // it — so a single new kill re-slid the entire stack, and five simultaneous
    // kills produced five identical animations of five rows. The whole point of
    // that animation is that a row reads as an EVENT; replaying it on rows that
    // did not change destroys the signal it exists to carry.
    //
    // So: rows are matched by key against the elements already in the DOM.
    // Departed rows are removed, new rows are inserted at their position, and
    // a row that survives is never detached — which is what preserves both its
    // running animation and its already-finished one. Kills arrive newest-first
    // and surviving rows keep their relative order, so in practice the only
    // operations are 'insert at the front' and 'remove from the end'; the
    // `insertBefore` on an existing element below is the correctness backstop
    // for a reorder, not the common path.
    for (const [key, node] of killRowEls) {
      if (!kept.has(key) || !killRows.some((r) => r.key === key)) {
        node.remove();
        killRowEls.delete(key);
      }
    }
    let ref: ChildNode | null = killfeed.firstChild;
    for (const r of killRows) {
      const existing = killRowEls.get(r.key);
      if (existing === undefined) {
        const row = document.createElement('div');
        row.className = 'kill-row';
        row.dataset.key = r.key;
        row.style.fontSize = scaledPx(FONT_MIN_PX);
        row.innerHTML = r.html;
        killRowEls.set(r.key, row);
        killfeed.insertBefore(row, ref);
        ref = row.nextSibling;
      } else if (existing === ref) {
        ref = existing.nextSibling; // already in place: touch nothing
      } else {
        killfeed.insertBefore(existing, ref);
        ref = existing.nextSibling;
      }
    }
  }

  function rebuildScoreboard(s: ClientState): void {
    const snap = s.snap;
    if (!snap) return;
    buildNameMap(s, nameMap);
    const you = s.hello?.you ?? null;
    const sigParts: string[] = [];
    for (const b of snap.board) {
      sigParts.push(
        `${b.id}:${b.hero}:${b.team}:${b.level}:${b.kills}:${b.deaths}:${b.assists}:${b.bot ? 1 : 0}:${b.connected ? 1 : 0}`,
      );
    }
    const sig = sigParts.join('|');
    if (sig === scoreboardSig && scoreboardWasOpen) return;
    scoreboardSig = sig;

    // Build into a detached host, then swap in one replaceChildren. The three
    // row kinds are told apart by TAG, not by class, so the frozen class list
    // is untouched: <h3> title, <h4> team header, <div> player row (four
    // classless <span> columns that style.css grids into alignment).
    const host = document.createElement('div');
    const head = el('h3', null, host);
    head.style.fontSize = scaledPx(14);
    head.textContent = 'SCOREBOARD';
    for (const team of [0, 1] as const) {
      const label = el('h4', null, host);
      label.style.fontSize = scaledPx(14);
      label.style.color = TEAM_APAL[team] ?? APAL.paper;
      label.textContent = `${TEAM_LABEL[team] ?? ''} — ${snap.kills[team] ?? 0} kills`;
      const rows = snap.board
        .filter((b) => b.team === team)
        .sort((a, b2) => b2.kills - a.kills || a.deaths - b2.deaths);
      for (const b of rows) {
        const row = el('div', null, host);
        row.style.fontSize = scaledPx(FONT_MIN_PX);
        if (you !== null && b.id === you) row.style.color = APAL.goldLit;
        const hero = heroById(b.hero);
        const name = nameMap.get(b.id) ?? (b.bot ? 'Bot' : 'Player');
        // [OFFLINE] marks a disconnected HUMAN seat only — a bot is never
        // 'offline', it just plays (round-5 UX: bots read '[BOT] [OFFLINE]')
        const tags = `${b.bot ? ' [BOT]' : ''}${!b.bot && !b.connected ? ' [OFFLINE]' : ''}`;
        // hero identity rides as a colour BAR down the row's leading edge, not
        // as coloured text: the darkest accents (pine, shade) are barely
        // legible at 12px on the ink plate, and a rule beside paper-white text
        // carries the same identity at full contrast
        row.style.boxShadow = `inset 3px 0 0 0 ${accentColor(hero.visual.accent)}`;
        el('span', null, row).textContent = hero.name;
        el('span', null, row).textContent = `${name}${tags}`;
        el('span', null, row).textContent = `LV ${b.level}`;
        el('span', null, row).textContent = `${b.kills} / ${b.deaths} / ${b.assists}`;
      }
    }
    scoreboard.replaceChildren(...Array.from(host.childNodes));
  }

  return {
    root,

    render(s: ClientState, a: UiActions): void {
      const live = s.phase === 'live';
      root.style.display = live ? '' : 'none';
      if (!live) return;

      applyUiScale(); // 21:9 ultrawide: inline fonts scale ~1.2x (round-5 UX)

      // match boundary: a new begin resets the onboarding hints
      if (s.begin !== beginRef) {
        beginRef = s.begin;
        resetMatchHints();
      }

      // disconnect banner rides every live frame
      banner.style.display = s.connected ? 'none' : '';

      // cast-denied toast (input.ts preflight; game.ts expires it via untilMs)
      const toastNow = s.toast;
      const showToast = toastNow !== null && performance.now() < toastNow.untilMs;
      castToast.style.display = showToast ? '' : 'none';
      if (showToast) setText(castToast, toastNow.text);

      const snap = s.snap;
      const you = snap?.you ?? null;
      lastYou = you;
      const matchTick = snap?.matchTick ?? 0;
      const gameS = matchTick * TICK_DT;

      // ---- top bar ---------------------------------------------------------------
      const myTeam: TeamId = s.hello?.team ?? 0;
      setText(scoreAVal, String(snap?.kills[0] ?? 0));
      scoreA.style.color = TEAM_APAL[0] ?? APAL.paper;
      scoreA.classList.toggle('team-score--you', myTeam === 0);
      setText(scoreBVal, String(snap?.kills[1] ?? 0));
      scoreB.style.color = TEAM_APAL[1] ?? APAL.paper;
      scoreB.classList.toggle('team-score--you', myTeam === 1);

      let towers0 = 0;
      let towers1 = 0;
      let ownAncientX = 0;
      let ownAncientZ = 0;
      let ownAncientFound = false;
      if (snap) {
        for (const e of snap.ents) {
          if (e.k === 'tower' || e.k === 'guard') {
            // structures are never neutral, but count explicitly rather than
            // treating "not team 0" as team 1 (EntTeam narrowing discipline)
            if (e.hp > 0) {
              if (e.team === 0) towers0++;
              else if (e.team === 1) towers1++;
            }
          } else if (e.k === 'ancient' && e.team === myTeam) {
            ownAncientX = e.x;
            ownAncientZ = e.z;
            ownAncientFound = true;
          }
        }
      }
      setText(towersA, `⛫ ${towers0}`);
      towersA.style.color = TEAM_APAL[0] ?? APAL.paper;
      towersA.title = `${TEAM_LABEL[0] ?? ''} towers standing`;
      setText(towersB, `⛫ ${towers1}`);
      towersB.style.color = TEAM_APAL[1] ?? APAL.paper;
      towersB.title = `${TEAM_LABEL[1] ?? ''} towers standing`;

      const overtime = snap?.overtime === true;
      setText(clockText, overtime ? `${fmtClock(gameS)} SURGE` : fmtClock(gameS));
      clock.classList.toggle('match-clock--surge', overtime);
      clockSurge = overtime;
      renderDayNight(snap?.dayPhase ?? 0);
      // renderDayNight early-returns on an unchanged dial rung, so the surge
      // half of the tooltip needs its own write on the frame overtime flips
      writeClockTitle();

      // ---- kill feed (rebuild only when the events tail changed) ---------------------
      const nowMs = performance.now();
      const tail = s.events.length > 0 ? s.events[s.events.length - 1] : null;
      if (s.events.length !== eventsSeenLen || tail !== eventsSeenLast) {
        eventsSeenLen = s.events.length;
        eventsSeenLast = tail;
        buildNameMap(s, nameMap);
      }
      rebuildKillfeed(s, nowMs);
      drainMisses(s);

      // ---- personal cluster -----------------------------------------------------------
      const boardOpen = s.scoreboardOpen && snap !== null; // hints + scoreboard never coexist
      if (you) {
        if (heroId !== you.hero) {
          heroId = you.hero;
          const def = heroById(you.hero);
          heroDefs = def.abilities;
          setText(portraitGlyph, def.name.slice(0, 1));
          portraitGlyph.style.color = accentColor(def.visual.accent);
          portrait.style.borderColor = accentColor(def.visual.accent);
          portrait.title = `${def.name}, ${def.title} — ${def.role}. Click to centre the camera.`;
          for (let i = 0; i < abilityDoms.length; i++) {
            const dom = abilityDoms[i];
            const ab = heroDefs[i];
            if (!dom || !ab) continue;
            setText(dom.glyph, ab.icon);
            // The rich `.tooltip` card owns the long-form explanation now, so
            // the slot carries NO native `title` (a one-line plain-text popup
            // duplicating the card would be the worse of the two); aria-label
            // keeps the one-line accessible name.
            dom.slot.setAttribute('aria-label', `${ab.name} (${SLOT_KEYS[i] ?? ''})`);
          }
        }

        const hpFrac = you.maxHp > 0 ? Math.max(0, Math.min(1, you.hp / you.maxHp)) : 0;
        barHpFill.style.width = `${(hpFrac * 100).toFixed(1)}%`;
        setText(barHpText, `${Math.ceil(you.hp)} / ${Math.ceil(you.maxHp)}`);
        // low-hp state: the bar itself reads danger, so the player never has to
        // read a numeral to know they are about to die
        barHp.classList.toggle('bar-hp--low', hpFrac <= 0.3);
        const manaFrac = you.maxMana > 0 ? Math.max(0, Math.min(1, you.mana / you.maxMana)) : 0;
        barManaFill.style.width = `${(manaFrac * 100).toFixed(1)}%`;
        setText(barManaText, `${Math.ceil(you.mana)} / ${Math.ceil(you.maxMana)}`);

        const lvl = Math.min(you.level, LEVEL_CAP);
        setText(portraitName, `LV ${lvl}`); // hero level numeral lives on the portrait
        const lo = XP_THRESHOLDS[lvl] ?? 0;
        const hi = XP_THRESHOLDS[lvl + 1];
        const xpFrac = hi === undefined || hi <= lo ? 1 : Math.max(0, Math.min(1, (you.xp - lo) / (hi - lo)));
        barXpFill.style.width = `${(xpFrac * 100).toFixed(1)}%`;
        // XP progress numerals — NOT a second 'LV n' (that lives only on the
        // portrait; round-2 UX: the duplicate read as a broken XP bar)
        setText(
          barXpText,
          hi === undefined ? 'MAX LEVEL' : `${Math.max(0, Math.floor(you.xp - lo))} / ${hi - lo} XP`,
        );
        barXp.title = `${Math.floor(you.xp)} xp total — level ${lvl}`;

        // ---- terrain state chips (GRAPHICS_CONTRACT §6) -------------------------
        // Elevation and concealment are read straight off the same shared
        // terrain the sim uses, at the hero's own position, so the HUD can
        // never disagree with the rules it is reporting.
        // Dead heroes stand nowhere. `dead` is computed further down for the
        // overlay; the chip row needs the same fact here, so it is derived
        // once and reused rather than recomputed.
        const heroDead = you.respawnAtTick > 0 && matchTick < you.respawnAtTick;
        const map = mapOf(s);
        setChipsVisible(map !== null && !heroDead);
        if (map && !heroDead) {
          const high = elevationAt(map.terrain, you.x, you.z) === ELEV_HIGH;
          if (high !== elevHighShown || !elevChipInit) {
            elevHighShown = high;
            elevChipInit = true;
            setText(chipElev, high ? '▲ HIGH' : '▼ LOW');
            setStyle(chipElev, 'color', high ? APAL.cliffLit : APAL.paperDeep);
            chipElev.title = high ? HIGH_GROUND_TITLE : LOW_GROUND_TITLE;
          }
          const hidden = isConcealing(map.terrain, you.x, you.z);
          const wantHide = hidden ? '' : 'none';
          if (chipHide.style.display !== wantHide) chipHide.style.display = wantHide;
        }

        // abilities
        for (let i = 0; i < abilityDoms.length; i++) {
          const dom = abilityDoms[i];
          const ab = heroDefs[i];
          const st = you.abilities[i];
          if (!dom || !ab || !st) continue;
          const rank = st.rank;
          setText(dom.rank, '●'.repeat(rank) + '○'.repeat(Math.max(0, ab.maxRank - rank)));
          const remainingS = Math.max(0, (st.cdUntilTick - matchTick) * TICK_DT);
          const totalS = rank >= 1 ? rankVal(ab.cooldown, rank) : 0;
          const cdFrac = totalS > 0 ? Math.min(1, remainingS / totalS) : 0;
          const cost = rankVal(ab.manaCost, Math.max(rank, 1));
          setText(dom.cost, ab.isPassive ? '—' : cost > 0 ? String(cost) : '');
          // greyed: ult before its level gate, unranked actives, not enough mana
          const ultLocked = ab.ult && you.level < (ULT_LEVEL_REQ[rank] ?? Infinity);
          // The sweep overlay has TWO jobs — the cooldown wipe and, on a
          // level-gated ult, a full-height 'LV n' plate — and it is resolved to
          // one value before it is written. It used to be written twice per
          // frame: the cooldown pass first, then the ult branch overwriting it,
          // which churned the ult slot's height 100% -> 0% -> 100% and its text
          // '' -> 'LV 6' on EVERY frame for the whole first six levels of every
          // match. Measured with a MutationObserver over the .hud subtree, that
          // was the only DOM traffic a steady-state frame produced: 2 style
          // mutations and 2 text writes, all of them on this element, against a
          // §5 rule that says a frame writes nothing that did not change.
          const unusable =
            ultLocked || (!ab.isPassive && rank === 0) || (!ab.isPassive && you.mana < cost);
          dom.slot.style.opacity = unusable ? '0.35' : '';
          // control-surface states (frozen state classes, §6): a castable
          // active glows --ready; a level-gated ult wears --ult-locked and its
          // sweep overlay reads the unlock level ('LV 6') instead of a cooldown
          const ready =
            !ab.isPassive && !unusable && rank >= 1 && remainingS <= 0.05;
          dom.slot.classList.toggle('ability-slot--ready', ready);
          dom.slot.classList.toggle('ability-slot--ult-locked', ultLocked);
          const cdHeight = ultLocked ? '100%' : `${(cdFrac * 100).toFixed(1)}%`;
          if (dom.cd.style.height !== cdHeight) dom.cd.style.height = cdHeight;
          setText(
            dom.cd,
            ultLocked
              ? `LV ${ULT_LEVEL_REQ[rank] ?? '?'}`
              : remainingS > 0.05
                ? fmtCooldown(remainingS)
                : '',
          );
          // '+' : a skill point is waiting and this rank is legal
          const canRank =
            you.skillPoints > 0 &&
            rank < ab.maxRank &&
            (!ab.ult || you.level >= (ULT_LEVEL_REQ[rank] ?? Infinity));
          dom.plus.style.display = canRank ? '' : 'none';
          dom.plus.onclick = canRank
            ? (ev) => {
                ev.stopPropagation();
                a.send({ t: 'rift_skill', slot: i });
              }
            : null;
          // click casts only targetless abilities; point/unit casts need the
          // cursor, which input.ts owns (QWER quick-cast)
          dom.slot.onclick =
            !ab.isPassive && ab.targeting === 'none' && rank >= 1
              ? () => a.send({ t: 'rift_cast', slot: i })
              : null;
        }

        // items
        for (let i = 0; i < itemDoms.length; i++) {
          const dom = itemDoms[i];
          if (!dom) continue;
          const id = you.items[i] ?? null;
          if (id === null) {
            setText(dom.glyph, '');
            setText(dom.charges, '');
            dom.cd.style.height = '0%';
            setText(dom.cd, '');
            dom.slot.classList.add('item-slot--empty');
            dom.slot.title = 'Empty item slot';
            dom.slot.onclick = null;
            continue;
          }
          const def = heroItem(id);
          setText(dom.glyph, def.icon);
          dom.slot.classList.remove('item-slot--empty');
          dom.slot.title = `${def.name} — ${def.blurb}`;
          const charges = you.itemCharges[i] ?? 0;
          setText(dom.charges, def.active?.kind === 'ward' ? String(charges) : '');
          const remainingS = Math.max(0, ((you.itemCdUntilTick[i] ?? 0) - matchTick) * TICK_DT);
          const totalS =
            def.active && def.active.kind !== 'ward' ? def.active.cooldown : 0;
          const cdFrac = totalS > 0 ? Math.min(1, remainingS / totalS) : 0;
          dom.cd.style.height = `${(cdFrac * 100).toFixed(1)}%`;
          setText(dom.cd, remainingS > 0.05 ? fmtCooldown(remainingS) : '');
          dom.slot.onclick = () => a.send({ t: 'rift_item', slot: i });
        }

        // ---- action feedback diffs (buy pop + gold float + skill flash) ---------
        // Baseline on first sight, then diff — a late joiner's existing items
        // and ranks must NOT fire the feedback. Buying is the only gold sink,
        // so any drop is a purchase.
        for (let i = 0; i < 4; i++) {
          const r = you.abilities[i]?.rank ?? 0;
          if (ranksBaselined && r > (prevRanks[i] ?? 0)) flashAbilitySlot(i);
          prevRanks[i] = r;
        }
        ranksBaselined = true;
        if (prevItems !== null) {
          for (let i = 0; i < 6; i++) {
            if ((prevItems[i] ?? null) === null && (you.items[i] ?? null) !== null) {
              popItemSlot(i);
            }
          }
        }
        prevItems = you.items;
        if (prevGold !== null && you.gold < prevGold - 0.5) {
          floatFrom(gold, `-${String(Math.round(prevGold - you.gold))}g`, APAL.gold, 8, 'gold');
        }
        prevGold = you.gold;

        setText(gold, `${Math.floor(you.gold)}g — SHOP`);
        gold.onclick = () => a.toggleShop();
        setText(kda, `${you.kills} / ${you.deaths} / ${you.assists}`);
        kda.title = 'Kills / Deaths / Assists';

        portrait.onclick = () => a.centerCamera();

        // ---- death overlay -------------------------------------------------------------
        // `heroDead` is the same fact the chip row was hidden on, computed once
        // above; the overlay and the chips must never disagree about it.
        death.style.display = heroDead ? '' : 'none';
        if (heroDead) {
          setText(respawn, String(Math.max(1, Math.ceil((you.respawnAtTick - matchTick) * TICK_DT))));
        }

        // ---- first-60-seconds hints --------------------------------------------------------
        if (!spawnKnown) {
          spawnKnown = true;
          spawnX = you.x;
          spawnZ = you.z;
        }
        if (!movedEnough && Math.hypot(you.x - spawnX, you.z - spawnZ) > MOVE_HINT_DISMISS_M) {
          movedEnough = true;
        }
        if (s.shopOpen) shopOpenedOnce = true;
        const inWindow = gameS <= HINT_WINDOW_S;

        // ONE text hint at a time (§8): stacking popups occluded the ability
        // bar. Priority: RMB-move > learn-to-cast > shop. The lane arrow is
        // NOT part of this queue — it is a directional indicator that must
        // read AT SPAWN, so it shows alongside whichever text hint is up,
        // positioned on a screen-space orbit around the hero, and is dismissed
        // on arrival at the lane midpoint (or at the end of the onboarding
        // window). All are suppressed while the scoreboard is open so overlays
        // never fight.
        const showMove = inWindow && !movedEnough && !orderIssued && !boardOpen;
        hintMove.style.display = showMove ? '' : 'none';

        // learn-to-cast: an unspent point with EVERY ability at rank 0 means
        // the hero cannot cast at all — say how. Retires on the first point
        // spent (any rank leaves 0) or with the window.
        const allRankZero =
          (you.abilities[0]?.rank ?? 0) === 0 &&
          (you.abilities[1]?.rank ?? 0) === 0 &&
          (you.abilities[2]?.rank ?? 0) === 0 &&
          (you.abilities[3]?.rank ?? 0) === 0;
        const showLearn =
          !showMove && inWindow && you.skillPoints > 0 && allRankZero && !boardOpen;
        hintLearn.style.display = showLearn ? '' : 'none';

        // lane arrow toward the assigned lane's midpoint (begin.laneAssignment)
        if (inWindow && laneTarget === null && laneName === '' && s.begin && s.hello) {
          const lane = s.begin.laneAssignment[s.hello.you];
          const laneMap = map;
          if (lane !== undefined && laneMap) {
            const path = laneMap.paths[lane];
            if (path) {
              laneTarget = laneMidpoint(path);
              laneName = LANE_NAMES[s.begin.lanes]?.[lane] ?? `LANE ${lane + 1}`;
            }
          }
        }
        // dismissed on use: arriving at the lane midpoint retires the arrow
        if (
          laneTarget !== null &&
          Math.hypot(you.x - laneTarget.x, you.z - laneTarget.z) <= LANE_ARROW_ARRIVE_M
        ) {
          laneTarget = null;
        }
        const showLane = inWindow && laneTarget !== null && !boardOpen;
        hintLane.style.display = showLane ? '' : 'none';
        if (showLane && laneTarget !== null) {
          const angle = laneArrowAngle(you.x, you.z, laneTarget.x, laneTarget.z);
          const px = window.innerWidth / 2 + Math.cos(angle) * LANE_ARROW_OFFSET_PX;
          const py = window.innerHeight / 2 + Math.sin(angle) * LANE_ARROW_OFFSET_PX;
          hintLane.style.left = `${px.toFixed(0)}px`;
          hintLane.style.top = `${py.toFixed(0)}px`;
          hintLaneArrow.style.transform = `rotate(${angle}rad)`;
          // The text label rides only until the player's first move ORDER
          // (round-5 UX: past 0:58 the full text box persisted alongside the
          // RMB hint — two hint boxes at once). Three retire signals, any one
          // suffices: orderIssued (raw input verb), movedEnough (snap-observed
          // position), and the hard 20s clock. The arrow-only indicator may
          // persist per contract; the box collapses to it.
          const labelRetired = orderIssued || movedEnough || gameS > LANE_LABEL_MAX_S;
          setText(hintLaneText, labelRetired ? '' : ` your lane: ${laneName}`);
        }

        const nearFountain =
          ownAncientFound &&
          Math.hypot(you.x - ownAncientX, you.z - ownAncientZ) <= FOUNTAIN_RADIUS + 1;
        const showShop =
          !showMove &&
          !showLearn &&
          inWindow &&
          !shopOpenedOnce &&
          you.gold >= SHOP_HINT_GOLD &&
          nearFountain &&
          !boardOpen;
        hintShop.style.display = showShop ? '' : 'none';
      } else {
        death.style.display = 'none';
        hintMove.style.display = 'none';
        hintLane.style.display = 'none';
        hintLearn.style.display = 'none';
        hintShop.style.display = 'none';
        // no `you` = no hero position = nothing for the terrain chips to
        // report. They used to keep whatever they last said.
        setChipsVisible(false);
      }

      // ---- scoreboard (TAB) ------------------------------------------------------------
      const open = boardOpen;
      scoreboard.style.display = open ? '' : 'none';
      if (open) {
        scoreboardWasOpen = true;
        rebuildScoreboard(s);
      } else {
        scoreboardWasOpen = false;
      }
    },
  };
}

/** ItemDef lookup — local alias so the render loop reads clean. */
function heroItem(id: ItemId) {
  return ITEMS[id];
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
