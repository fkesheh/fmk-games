// ============================================================================
// ANCIENTS (rift) client — MENUS (CONTRACT §6 ui/menus.ts + §8, T9). The three
// non-live screens: .menu (name entry, create with teamSize + speed settings,
// join-by-code with ?code= prefill), .lobby (team roster, hero pick grid with
// role/blurb/ability tooltips, human-taken heroes greyed, teamSize readout,
// START reflecting canStart, invite code), and .end-screen (winner banner, the
// full rift_end stats table, back-to-menu). All states per §8 look intentional:
// every screen renders real copy even when its data is still arriving.
//
// DOM CLASS CONTRACT (§6): only .menu .menu-* .lobby .lobby-* .pick-grid
// .pick-card .end-screen .end-* .banner .error-banner classes are rendered;
// structural children are classless (T8 styles via descendant selectors).
// Inline colours are APAL entries only (team identity + hero accents); team
// identity always pairs colour with the AZURE/EMBER label (§8).
//
// SEAM RESOLUTION (contract gap, reported to the orchestrator — NOT patched
// around): the frozen UiActions carries in-room messages only (rift_*); the
// lobby-level transports (create/join/list rooms) and the room list never
// reach ClientState. The only contract-frozen surface that can carry menu
// actions is the §6 debug surface window.__rift — createPrivate(name,
// settings?) and joinPrivate(name, code) are FROZEN and game.ts (T8) must
// implement them — so the menu's create/join buttons drive exactly those (the
// same path the e2e drives; UI and e2e can never diverge). The public room
// list rides game.ts's ADDITIVE __rift extensions — rooms() / joinPublic() /
// quickJoin() / createPublic() (ClientState still has no channel; extending
// UiActions is the orchestrator's call) — each probed with typeof and degraded
// to an honest unavailable state when absent (unit harness). If __rift is
// absent entirely, every button disables honestly.
// ============================================================================
import { APAL, HERO_LIST, MAX_TEAM_SIZE, MIN_TEAM_SIZE, heroById } from '@rift/shared';
import type { HeroDef, HeroId, RosterEntry } from '@rift/shared';
import type { RoomInfo } from '@platform/shared';
import type { ClientState, UiActions, UiHandle } from '../contract.js';

const FONT_MIN_PX = 12;

const TEAM_LABEL: readonly string[] = ['AZURE', 'EMBER'];
const TEAM_APAL: readonly string[] = [APAL.azure, APAL.ember];

/** The frozen §6 debug surface, the menu's create/join transport (see header).
 *  rooms()/quickJoin()/createPublic()/joinPublic() are the ADDITIVE surface
 *  game.ts provides for public rooms; they are probed per call and degrade
 *  honestly. */
interface RiftDebugSurface {
  createPrivate(name: string, settings?: Record<string, unknown>): void;
  joinPrivate(name: string, code: string): void;
  rooms?(): readonly RoomInfo[];
  quickJoin?(name: string): void;
  createPublic?(name: string, settings?: Record<string, unknown>): void;
  joinPublic?(name: string, roomId: string): void;
}

function debugSurface(): RiftDebugSurface | null {
  const w = window as unknown as { __rift?: Partial<RiftDebugSurface> };
  const d = w.__rift;
  if (d && typeof d.createPrivate === 'function' && typeof d.joinPrivate === 'function') {
    return d as RiftDebugSurface;
  }
  return null;
}

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

function setText(e: HTMLElement, s: string): void {
  if (e.textContent !== s) e.textContent = s;
}

function accentColor(accent: string): string {
  return (APAL as Record<string, string>)[accent] ?? APAL.paper;
}

function heroTooltip(def: HeroDef): string {
  const lines = def.abilities.map((ab, i) => {
    const key = ['Q', 'W', 'E', 'R'][i] ?? '?';
    return `${key} — ${ab.name}: ${ab.blurb}`;
  });
  return `${def.name}, ${def.title} — ${def.role}\n${def.blurb}\n${lines.join('\n')}`;
}

/** localStorage is a courtesy, never a dependency (§6: try/catch'd). */
function storedName(): string {
  try {
    return window.localStorage.getItem('rift.name') ?? '';
  } catch {
    return '';
  }
}

function storeName(name: string): void {
  try {
    window.localStorage.setItem('rift.name', name);
  } catch {
    // private mode etc. — the name simply won't persist
  }
}

/** ?code= invite prefill (§6); read once, T8 owns the replaceState cleanup. */
function urlCode(): string {
  try {
    return new URLSearchParams(window.location.search).get('code')?.toUpperCase() ?? '';
  } catch {
    return '';
  }
}

export function createMenus(parent: HTMLElement): UiHandle {
  const root = document.createElement('div');
  parent.appendChild(root);

  // ============================== MENU =======================================
  const menu = el('div', 'menu', root);
  menu.style.display = 'none';
  const menuTitle = el('h1', 'menu-title', menu);
  menuTitle.textContent = 'ANCIENTS';
  const menuSub = el('p', 'menu-sub', menu);
  menuSub.style.fontSize = '14px';
  menuSub.textContent = 'a miniature battle of two dying campfires — push the lane, break the Ancient';

  const menuError = el('div', 'error-banner', menu);
  menuError.style.display = 'none';
  menuError.style.fontSize = '14px';

  const nameLabel = el('label', 'menu-label', menu);
  nameLabel.style.fontSize = `${FONT_MIN_PX}px`;
  nameLabel.textContent = 'YOUR NAME';
  const nameInput = el('input', 'menu-name', nameLabel);
  nameInput.maxLength = 16;
  nameInput.placeholder = 'Player';
  nameInput.value = storedName();

  const createBox = el('div', 'menu-create', menu);
  const createTitle = el('h2', 'menu-heading', createBox);
  createTitle.style.fontSize = '14px';
  createTitle.textContent = 'CREATE A ROOM';
  const sizeLabel = el('label', 'menu-label', createBox);
  sizeLabel.style.fontSize = `${FONT_MIN_PX}px`;
  sizeLabel.textContent = 'TEAM SIZE ';
  const sizeSelect = el('select', 'menu-teamsize', sizeLabel);
  const autoOpt = el('option', null, sizeSelect);
  autoOpt.value = '0';
  autoOpt.textContent = 'auto';
  for (let n = MIN_TEAM_SIZE; n <= MAX_TEAM_SIZE; n++) {
    const opt = el('option', null, sizeSelect);
    opt.value = String(n);
    opt.textContent = `${n}v${n}`;
  }
  const speedLabel = el('label', 'menu-label', createBox);
  speedLabel.style.fontSize = `${FONT_MIN_PX}px`;
  speedLabel.textContent = 'SIM SPEED ';
  const speedSelect = el('select', 'menu-speed', speedLabel);
  for (let n = 1; n <= 20; n++) {
    const opt = el('option', null, speedSelect);
    opt.value = String(n);
    opt.textContent = n === 1 ? '1× (normal)' : `${n}×`;
  }
  const createBtn = el('button', 'menu-btn', createBox);
  createBtn.style.fontSize = '14px';
  createBtn.textContent = 'CREATE PRIVATE ROOM';
  // CREATE PUBLIC shares the same teamSize/speed selectors (it is the listed,
  // joinable-by-strangers twin of the private create — round-6 UX: 'where is
  // the public room creation?'). It rides the additive __rift.createPublic and
  // degrades honestly when the surface is absent.
  const createPublicBtn = el('button', 'menu-btn menu-public', createBox);
  createPublicBtn.style.fontSize = '14px';
  createPublicBtn.textContent = 'CREATE PUBLIC ROOM';

  const joinBox = el('div', 'menu-join', menu);
  const joinTitle = el('h2', 'menu-heading', joinBox);
  joinTitle.style.fontSize = '14px';
  joinTitle.textContent = 'JOIN BY INVITE CODE';
  const codeInput = el('input', 'menu-code', joinBox);
  codeInput.maxLength = 5;
  codeInput.placeholder = 'CODE';
  codeInput.value = urlCode();
  const joinBtn = el('button', 'menu-btn', joinBox);
  joinBtn.style.fontSize = '14px';
  joinBtn.textContent = 'JOIN PRIVATE ROOM';

  const quickBtn = el('button', 'menu-btn menu-quick', menu);
  quickBtn.style.fontSize = '14px';
  quickBtn.textContent = 'QUICK MATCH — first open public room';

  const roomsTitle = el('h2', 'menu-rooms-title', menu);
  roomsTitle.style.fontSize = '14px';
  roomsTitle.textContent = 'PUBLIC ROOMS';
  const roomsList = el('div', 'menu-rooms', menu);

  const menuNote = el('p', 'menu-note', menu);
  menuNote.style.fontSize = `${FONT_MIN_PX}px`;
  menuNote.textContent =
    'Empty seats fill with bots; friends join with your invite code; a disconnected hero keeps fighting until you return.';

  function cleanName(): string {
    const n = nameInput.value.trim().slice(0, 16);
    return n || 'Player';
  }

  /** teamSize/speed selectors -> settings record, shared by both creates. */
  function currentSettings(): Record<string, unknown> {
    const settings: Record<string, unknown> = {};
    const teamSize = Number(sizeSelect.value);
    if (teamSize >= MIN_TEAM_SIZE && teamSize <= MAX_TEAM_SIZE) settings.teamSize = teamSize;
    const speed = Number(speedSelect.value);
    if (speed > 1) settings.speed = speed;
    return settings;
  }

  createBtn.onclick = () => {
    const d = debugSurface();
    if (!d) return;
    const name = cleanName();
    storeName(name);
    d.createPrivate(name, currentSettings());
  };
  createPublicBtn.onclick = () => {
    const d = debugSurface();
    if (!d || typeof d.createPublic !== 'function') return;
    const name = cleanName();
    storeName(name);
    d.createPublic(name, currentSettings());
  };
  joinBtn.onclick = () => {
    const d = debugSurface();
    if (!d) return;
    const code = codeInput.value.trim().toUpperCase();
    if (code.length === 0) return;
    const name = cleanName();
    storeName(name);
    d.joinPrivate(name, code);
  };
  quickBtn.onclick = () => {
    const d = debugSurface();
    if (!d || typeof d.quickJoin !== 'function') return;
    const name = cleanName();
    storeName(name);
    d.quickJoin(name);
  };

  // -- public room list (additive __rift surface; game.ts polls list_rooms in
  //    menu phase, this rebuilds only when the visible set actually changes) --
  let roomsSig = '';

  function roomEmptyState(text: string): void {
    roomsList.replaceChildren();
    const empty = el('div', 'room-empty', roomsList);
    empty.style.fontSize = `${FONT_MIN_PX}px`;
    empty.textContent = text;
  }

  function rebuildRooms(): void {
    const d = debugSurface();
    if (d === null || typeof d.rooms !== 'function' || typeof d.joinPublic !== 'function') {
      if (roomsSig !== 'unavailable') {
        roomsSig = 'unavailable';
        roomEmptyState('room list unavailable — no connection layer');
      }
      return;
    }
    const rooms = d
      .rooms()
      .filter((r) => r.visibility === 'public')
      .sort((a, b) => a.phase.localeCompare(b.phase) || b.players - a.players);
    if (rooms.length === 0) {
      if (roomsSig !== 'empty') {
        roomsSig = 'empty';
        roomEmptyState('No public rooms yet — create one and friends can find it here.');
      }
      return;
    }
    const sig = rooms
      .map((r) => `${r.id}:${r.label}:${r.players}/${r.maxPlayers}:${r.phase}`)
      .join('|');
    if (sig === roomsSig) return;
    roomsSig = sig;
    roomsList.replaceChildren();
    for (const room of rooms) {
      const row = el('button', 'room-row room-row--joinable', roomsList);
      const title = el('span', 'room-title', row);
      title.style.fontSize = '14px';
      title.textContent = room.label;
      const label = el('span', 'room-label', row);
      label.style.fontSize = `${FONT_MIN_PX}px`;
      label.textContent = room.phase === 'lobby' ? 'IN LOBBY' : 'LIVE — join mid-match';
      const meta = el('span', 'room-meta', row);
      meta.style.fontSize = `${FONT_MIN_PX}px`;
      meta.textContent = `${room.players}/${room.maxPlayers} seated`;
      const roomId = room.id;
      row.onclick = () => {
        const d2 = debugSurface();
        if (!d2 || typeof d2.joinPublic !== 'function') return;
        const name = cleanName();
        storeName(name);
        d2.joinPublic(name, roomId);
      };
    }
  }

  // ============================== LOBBY ======================================
  const lobby = el('div', 'lobby', root);
  lobby.style.display = 'none';
  const lobbyTitle = el('h1', 'lobby-title', lobby);
  lobbyTitle.style.fontSize = '20px';
  const lobbyCount = el('div', 'lobby-count', lobby);
  lobbyCount.style.fontSize = `${FONT_MIN_PX}px`;
  const lobbyCode = el('div', 'lobby-code', lobby);
  lobbyCode.style.fontSize = '14px';
  const lobbyTeams = el('div', 'lobby-teams', lobby);
  const teamCols: HTMLElement[] = [];
  for (const t of [0, 1] as const) {
    const col = el('div', 'lobby-team', lobbyTeams);
    const head = el('h2', 'lobby-heading', col);
    head.style.fontSize = '14px';
    head.style.color = TEAM_APAL[t] ?? APAL.paper;
    head.textContent = `${TEAM_LABEL[t] ?? ''} TEAM`;
    teamCols.push(col);
  }
  const pickTitle = el('h2', 'lobby-heading', lobby);
  pickTitle.style.fontSize = '14px';
  pickTitle.textContent = 'CHOOSE YOUR HERO — manual picks are unique across both teams';
  const pickGrid = el('div', 'pick-grid', lobby);
  const lobbyStart = el('button', 'lobby-start', lobby);
  lobbyStart.style.fontSize = '16px';
  const lobbyLeave = el('button', 'lobby-leave', lobby);
  lobbyLeave.style.fontSize = `${FONT_MIN_PX}px`;
  lobbyLeave.textContent = 'LEAVE ROOM';

  let lobbySig = '';
  let actionsRef: UiActions | null = null;
  lobbyLeave.onclick = () => actionsRef?.leaveToMenu();

  /** Newest roster wins: a rift_roster event is fresher than hello.roster. */
  function currentRoster(s: ClientState): readonly RosterEntry[] {
    const events = s.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev && ev.t === 'rift_roster') return ev.roster;
    }
    return s.hello?.roster ?? [];
  }

  function rebuildLobby(s: ClientState): void {
    const roster = currentRoster(s);
    const picks = s.lobby?.picks ?? {};
    const me = s.hello?.you ?? '';

    for (const [t, col] of teamCols.entries()) {
      // keep the heading (first child), rebuild the seat rows
      const head = col.querySelector('h2');
      col.replaceChildren(...(head ? [head] : []));
      for (const r of roster) {
        if (r.team !== t) continue;
        const seat = el('div', 'lobby-seat', col);
        seat.style.fontSize = '14px';
        const hero = r.pick ? heroById(r.pick).name : 'choosing…';
        const tags = `${r.bot ? ' [BOT]' : ''}${r.connected || r.bot ? '' : ' [OFFLINE]'}`;
        seat.textContent = `${r.name}${tags} — ${hero}`;
        if (r.id === me) seat.style.textDecoration = 'underline';
      }
    }

    // a hero is taken when another HUMAN picked it (bots/auto-fill may dupe)
    const taken = new Set<HeroId>();
    for (const r of roster) {
      if (!r.bot && r.pick !== null && r.id !== me) taken.add(r.pick);
    }

    pickGrid.replaceChildren();
    for (const def of HERO_LIST) {
      const card = el('button', 'pick-card', pickGrid);
      card.title = heroTooltip(def);
      const isMine = picks[me] === def.id;
      const isTaken = taken.has(def.id);
      card.disabled = isTaken;
      card.style.opacity = isTaken ? '0.35' : '';
      card.style.outline = isMine ? `2px solid ${accentColor(def.visual.accent)}` : '';
      const glyph = el('b', null, card);
      glyph.textContent = def.name.slice(0, 1);
      glyph.style.color = accentColor(def.visual.accent);
      const name = el('span', null, card);
      name.style.fontSize = '14px';
      name.textContent = def.name;
      const role = el('i', null, card);
      role.style.fontSize = `${FONT_MIN_PX}px`;
      role.textContent = `${def.role} — ${def.blurb}`;
      if (!isTaken) {
        card.onclick = () => actionsRef?.send({ t: 'rift_pick', hero: def.id });
      }
    }
  }

  // ============================== END ========================================
  const end = el('div', 'end-screen', root);
  end.style.display = 'none';
  const endBanner = el('h1', 'end-banner', end);
  endBanner.style.fontSize = '28px';
  const endReason = el('div', 'end-reason', end);
  endReason.style.fontSize = '14px';
  const endTable = el('div', 'end-table', end);
  const endNote = el('div', 'end-note', end);
  endNote.style.fontSize = `${FONT_MIN_PX}px`;
  endNote.textContent = 'the room resets to its lobby shortly — picks are kept';
  const endBack = el('button', 'end-back', end);
  endBack.style.fontSize = '14px';
  endBack.textContent = 'LEAVE TO MENU';
  endBack.onclick = () => actionsRef?.leaveToMenu();

  let endRef: ClientState['end'] = null;

  function rebuildEnd(s: ClientState): void {
    const e = s.end;
    if (!e) return;
    const myTeam = s.hello?.team ?? null;
    if (e.winner === null) {
      setText(endBanner, 'DRAW');
      endBanner.style.color = APAL.paper;
    } else {
      const won = myTeam !== null && e.winner === myTeam;
      setText(endBanner, `${TEAM_LABEL[e.winner] ?? ''} ${won ? 'VICTORY' : 'WINS'}`);
      endBanner.style.color = TEAM_APAL[e.winner] ?? APAL.paper;
    }
    const reason =
      e.reason === 'ancient'
        ? 'the Ancient has fallen'
        : e.reason === 'tiebreak'
          ? 'hard cap — tiebreak decides'
          : 'hard cap — perfectly even';
    setText(endReason, reason);

    endTable.replaceChildren();
    const head = el('div', 'end-row', endTable);
    head.style.fontSize = `${FONT_MIN_PX}px`;
    head.textContent = 'HERO — PLAYER — K/D/A — GOLD — HERO DMG — STRUCTURE DMG';
    const rows = [...e.stats].sort((a, b) => a.team - b.team || b.kills - a.kills);
    for (const st of rows) {
      const row = el('div', 'end-row', endTable);
      row.style.fontSize = `${FONT_MIN_PX}px`;
      row.style.color = TEAM_APAL[st.team] ?? APAL.paper;
      const hero = heroById(st.hero).name;
      row.textContent =
        `${TEAM_LABEL[st.team] ?? ''} — ${hero} — ${st.name} — ` +
        `${st.kills}/${st.deaths}/${st.assists} — ${Math.floor(st.goldEarned)}g — ` +
        `${Math.floor(st.heroDamage)} — ${Math.floor(st.structureDamage)}`;
    }
  }

  // ============================== RENDER =======================================
  return {
    root,

    render(s: ClientState, a: UiActions): void {
      actionsRef = a;
      const showMenu = s.phase === 'menu';
      const showLobby = s.phase === 'lobby';
      const showEnd = s.phase === 'ended';
      menu.style.display = showMenu ? '' : 'none';
      lobby.style.display = showLobby ? '' : 'none';
      end.style.display = showEnd ? '' : 'none';

      if (showMenu) {
        // errors surface here (bad code, full room, ...) — §8 error state
        menuError.style.display = s.error ? '' : 'none';
        if (s.error) setText(menuError, s.error);
        // without the debug surface (unit harness) the buttons say so honestly
        const d = debugSurface();
        createBtn.disabled = d === null;
        joinBtn.disabled = d === null;
        createBtn.title = d === null ? 'unavailable — no connection layer' : 'Create a private room';
        joinBtn.title = d === null ? 'unavailable — no connection layer' : 'Join with an invite code';
        const canCreatePublic = d !== null && typeof d.createPublic === 'function';
        createPublicBtn.disabled = !canCreatePublic;
        createPublicBtn.title = canCreatePublic
          ? 'Create a public room — it is listed under PUBLIC ROOMS for anyone to join'
          : 'unavailable — no connection layer';
        const canQuick = d !== null && typeof d.quickJoin === 'function';
        quickBtn.disabled = !canQuick;
        quickBtn.title = canQuick
          ? 'Join the first open public room (a fresh one is created if none exists)'
          : 'unavailable — no connection layer';
        rebuildRooms();
      } else {
        roomsSig = ''; // force a fresh rebuild on the next menu visit
      }

      if (showLobby) {
        const l = s.lobby;
        const roster = currentRoster(s);
        const sig =
          JSON.stringify(roster) +
          JSON.stringify(l?.picks ?? {}) +
          String(l?.teamSize ?? 0) +
          String(l?.canStart ?? false) +
          String(s.hello?.code ?? '') +
          String(s.hello?.you ?? '');
        if (sig !== lobbySig) {
          lobbySig = sig;
          setText(
            lobbyTitle,
            l ? `LOBBY — ${l.teamSize}v${l.teamSize}` : 'LOBBY',
          );
          setText(
            lobbyCount,
            l
              ? `${l.seated} seated — ${l.humans} human${l.humans === 1 ? '' : 's'} — bots fill every empty seat (min ${l.minPlayers})`
              : '',
          );
          const code = s.hello?.code ?? null;
          lobbyCode.style.display = code ? '' : 'none';
          if (code) setText(lobbyCode, `INVITE CODE: ${code}`);
          rebuildLobby(s);
        }
        if (l) {
          // CSS owns the look: .lobby-start is a gold accent when enabled and
          // greys ONLY via :disabled — never inline opacity, so an enabled
          // START can never read as disabled (round-1 UX failure)
          lobbyStart.disabled = !l.canStart;
          if (l.countdownEndsAt > 0) {
            // countdownEndsAt is server-epoch ms; the clock offset lives in
            // T8's net layer, so this is the honest coarse readout
            const leftMs = l.countdownEndsAt - Date.now();
            setText(
              lobbyStart,
              leftMs > 0 ? `STARTING IN ${Math.max(1, Math.ceil(leftMs / 1000))}…` : 'STARTING…',
            );
            lobbyStart.disabled = true;
            // the countdown is the most time-critical readout of the pre-match
            // flow — it must NOT wear the disabled greys (round-5 UX: it read
            // dimmer than LEAVE ROOM beneath it). CSS owns the bright state.
            lobbyStart.classList.add('lobby-start--countdown');
          } else {
            lobbyStart.classList.remove('lobby-start--countdown');
            setText(lobbyStart, l.canStart ? 'START MATCH' : 'START — waiting for players');
          }
          lobbyStart.onclick = l.canStart ? () => actionsRef?.send({ t: 'rift_start' }) : null;
        }
      }

      if (showEnd) {
        if (s.end !== endRef) {
          endRef = s.end;
          rebuildEnd(s);
        }
      } else {
        endRef = null;
      }
    },
  };
}
