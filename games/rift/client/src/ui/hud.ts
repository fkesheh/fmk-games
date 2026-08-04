// ============================================================================
// ANCIENTS (rift) client — HUD (CONTRACT §6 ui/hud.ts + §8 UX bible, T9).
// Bottom-centre portrait/hp/mana/ability/item cluster, top-centre match clock
// + team score + towers standing, top-right kill feed, gold/shop button, K/D/A,
// level + XP bar, TAB scoreboard, death overlay, first-60-seconds onboarding
// (ONE text hint at a time — RMB-move > shop — dismissed on use, plus the lane
// arrow, a SEPARATE directional indicator that must read AT SPAWN (§8) and so
// never queues behind the move hint; it is dismissed on arrival at the lane
// midpoint; everything is suppressed while the scoreboard is open), and the
// disconnect banner. Pure DOM — T8's style.css owns layout and static look;
// this file owns structure, text, dynamic widths/opacities, and the ONLY
// colours it sets inline are APAL entries (team identity + hero accents).
//
// DOM CLASS CONTRACT (§6): only classes from the frozen list are rendered:
//   .hud .hud-portrait .hud-bars .bar .bar-hp .bar-mana .bar-xp
//   .ability-bar .ability-slot .ability-cd .ability-rank .ability-plus
//   .item-bar .item-slot .item-charges .item-cd .gold-readout .kda
//   .topbar .match-clock .team-score .tower-count .killfeed .kill-row
//   .scoreboard .death-overlay .respawn-count .hint .banner
// Structural children that have no class in the contract (bar fills, glyph
// spans, key hints) are CLASSLESS elements — T8 styles them via descendant
// selectors (e.g. `.bar > i`, `.ability-slot > b`). Every numeric readout gets
// an inline font-size >= 12px so the §8 floor holds no matter what CSS lands.
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
import {
  APAL,
  FOUNTAIN_RADIUS,
  ITEMS,
  LEVEL_CAP,
  TICK_DT,
  ULT_LEVEL_REQ,
  XP_THRESHOLDS,
  buildMap,
  heroById,
} from '@rift/shared';
import type {
  AbilityDef,
  BoardEntry,
  HeroId,
  ItemId,
  RosterEntry,
  TeamId,
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
const LANE_ARROW_ARRIVE_M = 10; // hero this close to the lane midpoint = arrow used
const LANE_ARROW_OFFSET_PX = 150; // screen-space orbit radius around the hero

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

  // -- top bar -------------------------------------------------------------------
  const topbar = el('div', 'topbar', root);
  const scoreA = el('span', 'team-score', topbar);
  scoreA.style.fontSize = '18px';
  const towersA = el('span', 'tower-count', topbar);
  towersA.style.fontSize = '14px';
  const clock = el('span', 'match-clock', topbar);
  clock.style.fontSize = '20px';
  const towersB = el('span', 'tower-count', topbar);
  towersB.style.fontSize = '14px';
  const scoreB = el('span', 'team-score', topbar);
  scoreB.style.fontSize = '18px';

  // -- kill feed (top right) -------------------------------------------------------
  const killfeed = el('div', 'killfeed', root);

  // -- disconnect banner -------------------------------------------------------------
  const banner = el('div', 'banner', root);
  banner.style.display = 'none';
  banner.style.fontSize = '16px';
  banner.textContent = 'CONNECTION LOST — reconnecting…';

  // -- bottom-centre cluster ---------------------------------------------------------
  const bottom = el('div', null, root); // classless row wrapper (T8: `.hud > div`)

  const portrait = el('button', 'hud-portrait', bottom);
  const portraitGlyph = el('b', null, portrait);
  const portraitName = el('span', null, portrait);
  portraitName.style.fontSize = `${FONT_MIN_PX}px`;

  const bars = el('div', 'hud-bars', bottom);
  const barHp = el('div', 'bar bar-hp', bars);
  const barHpFill = el('i', null, barHp);
  const barHpText = el('span', null, barHp);
  barHpText.style.fontSize = `${VALUE_FONT_PX}px`;
  const barMana = el('div', 'bar bar-mana', bars);
  const barManaFill = el('i', null, barMana);
  const barManaText = el('span', null, barMana);
  barManaText.style.fontSize = `${VALUE_FONT_PX}px`;
  const barXp = el('div', 'bar bar-xp', bars);
  const barXpFill = el('i', null, barXp);
  const barXpText = el('span', null, barXp);
  barXpText.style.fontSize = `${VALUE_FONT_PX}px`;

  const abilityBar = el('div', 'ability-bar', bottom);
  const abilityDoms: AbilitySlotDom[] = [];
  for (let i = 0; i < 4; i++) {
    const slot = el('button', 'ability-slot', abilityBar);
    const glyph = el('b', null, slot);
    const key = el('kbd', null, slot);
    key.textContent = SLOT_KEYS[i] ?? '';
    key.style.fontSize = `${FONT_MIN_PX}px`;
    const cd = el('div', 'ability-cd', slot);
    const cost = el('span', null, slot); // T8: `.ability-slot > span` (mana cost)
    cost.style.fontSize = `${VALUE_FONT_PX}px`;
    const rank = el('div', 'ability-rank', slot);
    rank.style.fontSize = `${FONT_MIN_PX}px`;
    const plus = el('button', 'ability-plus', slot);
    plus.textContent = '+';
    plus.style.fontSize = '14px';
    plus.style.display = 'none';
    abilityDoms.push({ slot, glyph, key, cost, cd, rank, plus });
  }

  const itemBar = el('div', 'item-bar', bottom);
  const itemDoms: ItemSlotDom[] = [];
  for (let i = 0; i < 6; i++) {
    const slot = el('button', 'item-slot', itemBar);
    const glyph = el('b', null, slot);
    const key = el('kbd', null, slot);
    key.textContent = String(i + 1);
    key.style.fontSize = `${FONT_MIN_PX}px`;
    const charges = el('span', 'item-charges', slot);
    charges.style.fontSize = `${FONT_MIN_PX}px`;
    const cd = el('div', 'item-cd', slot);
    itemDoms.push({ slot, glyph, key, charges, cd });
  }

  const gold = el('button', 'gold-readout', bottom);
  gold.style.fontSize = '16px';
  gold.title = 'Open the shop (must stand at your fountain to buy)';

  const kda = el('span', 'kda', bottom);
  kda.style.fontSize = '14px';

  // -- death overlay -----------------------------------------------------------------
  const death = el('div', 'death-overlay', root);
  death.style.display = 'none';
  const deathText = el('div', null, death);
  deathText.textContent = 'YOU DIED';
  const respawn = el('div', 'respawn-count', death);
  respawn.style.fontSize = '48px';

  // -- scoreboard (TAB) -------------------------------------------------------------
  const scoreboard = el('div', 'scoreboard', root);
  scoreboard.style.display = 'none';

  // -- first-60-seconds onboarding -------------------------------------------------
  const hintMove = el('div', 'hint', root);
  hintMove.style.display = 'none';
  hintMove.style.fontSize = '16px';
  hintMove.textContent = 'RIGHT-CLICK the ground to move';
  // lane arrow: a SEPARATE directional indicator (§8), not one of the queued
  // text hints — it must read at spawn, so it never waits behind hintMove.
  // T9 positions it inline (screen-space orbit toward the lane midpoint);
  // T8's .hint rule supplies the pill look; the inline left/top/bottom/
  // transform override the pill's default bottom-centre anchor.
  const hintLane = el('div', 'hint', root);
  hintLane.style.display = 'none';
  hintLane.style.fontSize = '16px';
  hintLane.style.bottom = 'auto';
  hintLane.style.transform = 'translate(-50%, -50%)';
  const hintLaneArrow = el('b', null, hintLane);
  hintLaneArrow.textContent = '➤';
  hintLaneArrow.style.display = 'inline-block'; // transformable
  hintLaneArrow.style.fontSize = '24px';
  const hintLaneText = el('span', null, hintLane);
  const hintShop = el('div', 'hint', root);
  hintShop.style.display = 'none';
  hintShop.style.fontSize = '16px';
  hintShop.textContent = 'You have gold — open the SHOP at your fountain';

  // -- render-cycle state (no per-frame allocation beyond the killfeed rebuild) --------
  let heroId: HeroId | null = null; // hero of the current match (slot glyphs are static per match)
  let heroDefs: readonly AbilityDef[] = [];
  let beginRef: ClientState['begin'] = null; // identity watch: a new begin = a new match
  let spawnX = 0;
  let spawnZ = 0;
  let spawnKnown = false;
  let movedEnough = false;
  let shopOpenedOnce = false;
  let laneTarget: { x: number; z: number } | null = null;
  let laneName = '';
  let killRows: KillRow[] = [];
  let eventsSeenLen = 0; // killfeed rebuild only when the events tail changes
  let eventsSeenLast: unknown = null;
  let scoreboardSig = '';
  let scoreboardWasOpen = false;

  function resetMatchHints(): void {
    spawnKnown = false;
    movedEnough = false;
    shopOpenedOnce = false;
    laneTarget = null;
    laneName = '';
  }

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
    // DOM writes only when the visible row set actually changed
    let dirty = killRows.length !== killfeed.childElementCount;
    if (!dirty) {
      for (let i = 0; i < killRows.length; i++) {
        const rowEl = killfeed.children[i];
        const row = killRows[i];
        if (!rowEl || !row || (rowEl as HTMLElement).dataset.key !== row.key) {
          dirty = true;
          break;
        }
      }
    }
    if (!dirty) return;
    killfeed.replaceChildren(
      ...killRows.map((r) => {
        const row = document.createElement('div');
        row.className = 'kill-row';
        row.dataset.key = r.key;
        row.style.fontSize = `${FONT_MIN_PX}px`;
        row.innerHTML = r.html;
        return row;
      }),
    );
  }

  function rebuildScoreboard(s: ClientState): void {
    const snap = s.snap;
    if (!snap) return;
    buildNameMap(s, nameMap);
    const sigParts: string[] = [];
    for (const b of snap.board) {
      sigParts.push(
        `${b.id}:${b.hero}:${b.team}:${b.level}:${b.kills}:${b.deaths}:${b.assists}:${b.bot ? 1 : 0}:${b.connected ? 1 : 0}`,
      );
    }
    const sig = sigParts.join('|');
    if (sig === scoreboardSig && scoreboardWasOpen) return;
    scoreboardSig = sig;

    // build into a detached host, then swap in one replaceChildren
    const host = document.createElement('div');
    const head = el('div', null, host);
    head.style.fontSize = '14px';
    head.textContent = 'SCOREBOARD';
    for (const team of [0, 1] as const) {
      const label = el('div', null, host);
      label.style.fontSize = '14px';
      label.style.color = TEAM_APAL[team] ?? APAL.paper;
      label.textContent = `${TEAM_LABEL[team] ?? ''} — ${snap.kills[team] ?? 0} kills`;
      const rows = snap.board
        .filter((b) => b.team === team)
        .sort((a, b2) => b2.kills - a.kills || a.deaths - b2.deaths);
      for (const b of rows) {
        const row = el('div', null, host);
        row.style.fontSize = `${FONT_MIN_PX}px`;
        const hero = heroById(b.hero);
        const name = nameMap.get(b.id) ?? (b.bot ? 'Bot' : 'Player');
        const tags = `${b.bot ? ' [BOT]' : ''}${b.connected ? '' : ' [OFFLINE]'}`;
        row.textContent =
          `${hero.name} — ${name}${tags} — LV ${b.level} — ${b.kills}/${b.deaths}/${b.assists}`;
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

      // match boundary: a new begin resets the onboarding hints
      if (s.begin !== beginRef) {
        beginRef = s.begin;
        resetMatchHints();
      }

      // disconnect banner rides every live frame
      banner.style.display = s.connected ? 'none' : '';

      const snap = s.snap;
      const you = snap?.you ?? null;
      const matchTick = snap?.matchTick ?? 0;
      const gameS = matchTick * TICK_DT;

      // ---- top bar ---------------------------------------------------------------
      const myTeam: TeamId = s.hello?.team ?? 0;
      setText(scoreA, `${TEAM_LABEL[0] ?? ''} ${snap?.kills[0] ?? 0}`);
      scoreA.style.color = TEAM_APAL[0] ?? APAL.paper;
      if (myTeam === 0) scoreA.style.textDecoration = 'underline';
      else scoreA.style.textDecoration = '';
      setText(scoreB, `${snap?.kills[1] ?? 0} ${TEAM_LABEL[1] ?? ''}`);
      scoreB.style.color = TEAM_APAL[1] ?? APAL.paper;
      if (myTeam === 1) scoreB.style.textDecoration = 'underline';
      else scoreB.style.textDecoration = '';

      let towers0 = 0;
      let towers1 = 0;
      let ownAncientX = 0;
      let ownAncientZ = 0;
      let ownAncientFound = false;
      if (snap) {
        for (const e of snap.ents) {
          if (e.k === 'tower' || e.k === 'guard') {
            if (e.hp > 0) {
              if (e.team === 0) towers0++;
              else towers1++;
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

      const clockText = snap?.overtime === true ? `${fmtClock(gameS)} SURGE` : fmtClock(gameS);
      setText(clock, clockText);
      clock.style.color = snap?.overtime === true ? APAL.gold : APAL.paper;
      clock.title = snap?.overtime === true ? 'Overtime surge — waves grow stronger' : 'Match time';

      // ---- kill feed (rebuild only when the events tail changed) ---------------------
      const nowMs = performance.now();
      const tail = s.events.length > 0 ? s.events[s.events.length - 1] : null;
      if (s.events.length !== eventsSeenLen || tail !== eventsSeenLast) {
        eventsSeenLen = s.events.length;
        eventsSeenLast = tail;
        buildNameMap(s, nameMap);
      }
      rebuildKillfeed(s, nowMs);

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
            dom.slot.title = `${ab.name} — ${ab.blurb}`;
          }
        }

        const hpFrac = you.maxHp > 0 ? Math.max(0, Math.min(1, you.hp / you.maxHp)) : 0;
        barHpFill.style.width = `${(hpFrac * 100).toFixed(1)}%`;
        setText(barHpText, `${Math.ceil(you.hp)} / ${Math.ceil(you.maxHp)}`);
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
          dom.cd.style.height = `${(cdFrac * 100).toFixed(1)}%`;
          setText(dom.cd, remainingS > 0.05 ? fmtCooldown(remainingS) : '');
          const cost = rankVal(ab.manaCost, Math.max(rank, 1));
          setText(dom.cost, ab.isPassive ? '—' : cost > 0 ? String(cost) : '');
          // greyed: ult before its level gate, unranked actives, not enough mana
          const ultLocked = ab.ult && you.level < (ULT_LEVEL_REQ[rank] ?? Infinity);
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
          if (ultLocked) {
            dom.cd.style.height = '100%';
            setText(dom.cd, `LV ${ULT_LEVEL_REQ[rank] ?? '?'}`);
          }
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
            dom.slot.style.opacity = '0.3';
            dom.slot.title = 'Empty item slot';
            dom.slot.onclick = null;
            continue;
          }
          const def = heroItem(id);
          setText(dom.glyph, def.icon);
          dom.slot.style.opacity = '';
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

        setText(gold, `${Math.floor(you.gold)}g — SHOP`);
        gold.onclick = () => a.toggleShop();
        setText(kda, `${you.kills} / ${you.deaths} / ${you.assists}`);
        kda.title = 'Kills / Deaths / Assists';

        portrait.onclick = () => a.centerCamera();

        // ---- death overlay -------------------------------------------------------------
        const dead = you.respawnAtTick > 0 && matchTick < you.respawnAtTick;
        death.style.display = dead ? '' : 'none';
        if (dead) {
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
        // bar. Priority: RMB-move > shop. The lane arrow is NOT part of this
        // queue — it is a directional indicator that must read AT SPAWN, so
        // it shows alongside whichever text hint is up, positioned on a
        // screen-space orbit around the hero, and is dismissed on arrival at
        // the lane midpoint (or at the end of the onboarding window). All are
        // suppressed while the scoreboard is open so overlays never fight.
        const showMove = inWindow && !movedEnough && !boardOpen;
        hintMove.style.display = showMove ? '' : 'none';

        // lane arrow toward the assigned lane's midpoint (begin.laneAssignment)
        if (inWindow && laneTarget === null && laneName === '' && s.begin && s.hello) {
          const lane = s.begin.laneAssignment[s.hello.you];
          if (lane !== undefined) {
            const map = buildMap(s.begin.lanes);
            const path = map.paths[lane];
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
          hintLaneArrow.style.transform = `rotate(${angle}rad`;
          // text label rides only BEFORE the first move order (round-3 UX:
          // past 0:58 the full text box persisted alongside the RMB hint — two
          // hint boxes at once. Once the player has moved, the arrow alone
          // carries the direction and the box collapses to it).
          setText(hintLaneText, movedEnough ? '' : ` your lane: ${laneName}`);
        }

        const nearFountain =
          ownAncientFound &&
          Math.hypot(you.x - ownAncientX, you.z - ownAncientZ) <= FOUNTAIN_RADIUS + 1;
        const showShop =
          !showMove &&
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
        hintShop.style.display = 'none';
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
