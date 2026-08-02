// ============================================================================
// C11 — app shell + boot + debug surface. Builds the DOM-side roots (index.html
// provides #app/#game/#hud/#menu/#boot), mirrors PALETTE onto the --c11-* CSS
// custom properties style.css consumes, constructs ClientState/Hud/Menus/
// ClientGame, runs the rAF loop (dt-clamped), forwards resize, unlocks audio on
// the first gesture, shows a ?debug overlay, exposes the frozen window.__fps
// surface used by e2e, dismisses the boot splash, and guards every failure path
// with a visible error banner.
//
// C10/C11 SEAM (specs/C11.md — ClientGame's frozen table has no audio, resize,
// buy, or debug hooks, so these are additive public methods C10 implements and
// main.ts calls; do not rename without syncing both sides):
//   game.resize(): void                      — forwards to SceneRig.resize()
//   game.buy(w: WeaponId): void              — send C2S buy (menu onBuy + debug)
//   game.addBot(): void                      — send C2S add_bot (menu onAddBot + debug)
//   game.removeBot(): void                   — send C2S remove_bot (menu onRemoveBot + debug)
//   game.removeAllBots(): number             — kick every bot (menu onRemoveAllBots + console)
//   game.switchTeam(team: Team): void        — send C2S switch_team (menu onSwitchTeam + debug)
//   game.reload(): void                      — send C2S reload (debug)
//   game.debugSetLook(yaw, pitch): void      — writes InputController yaw/pitch
//   game.debugSetMove(x, z): void            — overrides move axes (0,0 releases)
//   game.debugSetButton(btn, down): void     — sets/clears an INPUT_* held bit
//   game.debugInfo(): { pos: [x,y,z]; players: number; pingMs: number }
//   game.consoleExec(text): string           — dev console Enter + e2e debug hook
//   plus room-flow hud.show(true on joined / false on leave) inside ClientGame.
// Reverse direction: main dispatches ONE 'fps:gesture' window Event on the
// first pointerdown/keydown; ClientGame listens for it and resumes its
// internally-constructed AudioEngine (browsers gate AudioContext on a gesture).
// ============================================================================
import { PALETTE } from '@fps/shared';
import type { GearId, MapId, RoomId, RoomPhase, Team, WeaponId } from '@fps/shared';
import { ClientState } from './game/state';
import { ClientGame } from './game/clientGame';
import { Hud } from './ui/hud';
import { Menus } from './ui/menus';
import './style.css';

// ---- frozen e2e surface (CONTRACT.md "Debug & test surface") ---------------
type DebugButton = 'fire' | 'jump' | 'crouch' | 'alt' | 'walk';

// JSON-safe snapshot of everything a test driver needs; pos is [x, y, z] feet.
interface FpsState {
  phase: RoomPhase;
  roomId: RoomId | null;
  code: string | null;
  mapId: MapId | null;
  team: Team | null;
  hp: number;
  armor: number; // kevlar points 0..100 (GEAR.armorStart after a vest buy)
  alive: boolean;
  pos: [number, number, number];
  players: number;
  rosterSize: number;
  ping: number;
  money: number;
  mag: number;
  reserve: number;
  round: number;
  scoreT: number;
  scoreCT: number;
  weapon: WeaponId;
}

interface FpsApi {
  state(): FpsState;
  joinQuick(name: string): void;
  createPublic(name: string, mapId: MapId): void;
  createPrivate(name: string, mapId: MapId): void;
  joinPrivate(name: string, code: string): void;
  addBot(): void;
  removeBot(): void;
  debug: {
    setLook(yaw: number, pitch: number): void;
    setMove(x: number, z: number): void;
    press(btn: DebugButton, down: boolean): void;
    reload(): void;
    buy(w: WeaponId): void;
    scoreboard(down: boolean): void;
    switchTeam(team: Team): void;
    console(text: string): string; // dev console command, exactly like Enter
  };
}

declare global {
  interface Window {
    __fps?: FpsApi;
  }
}

const MAX_FRAME_MS = 100; // dt clamp: background-tab gaps must not teleport the sim
const DEBUG_HZ_MS = 250; // ?debug overlay refresh (4Hz)
const BOOT_FADE_MS = 260; // must cover .boot-splash's opacity transition

function must<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`missing ${selector} element`);
  return el;
}

// ---- PALETTE -> CSS custom properties (single source of truth) --------------
// style.css consumes these and carries NO hex fallbacks: a fallback is a second
// source of truth that silently diverges (that is exactly how --c11-accent came
// to be read but never written). This table must therefore stay a SUPERSET of
// every --c11-* var style.css reads. Applied at module load, before any DOM is
// built and before window.onerror can paint the error banner.
const PALETTE_CSS_VARS: ReadonlyArray<readonly [name: string, hex: string]> = [
  ['--c11-ink', PALETTE.ink], //             page + shell base
  ['--c11-shell', PALETTE.charcoal], //      shell gradient lift
  ['--c11-text', PALETTE.hudText], //        body copy
  ['--c11-accent', PALETTE.hudAccent], //    focus ring, selection, boot bar
  // The shell accent is `hudAccent` amber; its highlight must be the amber's own
  // lit tier, NOT a team tier. It read `tLit` only because `tLit` happened to be
  // that amber — it no longer is (the T family moved to hue 6), and the boot bar
  // must not turn the enemy's colour.
  ['--c11-accent-lit', PALETTE.hazardAmberLit], // accent highlight
  ['--c11-danger', PALETTE.danger], //       fatal banner
  ['--c11-danger-deep', PALETTE.blood], //   fatal banner floor
];

// Alpha companions: rgba() needs channels, and mixing in a literal rgb() would
// reintroduce the hex this pass removes. Only the three used with opacity.
const PALETTE_CSS_RGB_VARS: ReadonlyArray<readonly [name: string, hex: string]> = [
  ['--c11-ink-rgb', PALETTE.ink],
  ['--c11-text-rgb', PALETTE.hudText],
  ['--c11-accent-rgb', PALETTE.hudAccent],
];

function rgbChannels(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}`;
}

function applyPaletteVars(): void {
  const rootStyle = document.documentElement.style;
  for (const [name, hex] of PALETTE_CSS_VARS) rootStyle.setProperty(name, hex);
  for (const [name, hex] of PALETTE_CSS_RGB_VARS) rootStyle.setProperty(name, rgbChannels(hex));
}

applyPaletteVars();

// ---- boot splash (index.html #boot): removed once the shell is live ---------
function dismissBootSplash(immediate: boolean): void {
  const el = document.getElementById('boot');
  if (el === null) return;
  if (immediate) {
    el.remove();
    return;
  }
  el.classList.add('is-dismissed');
  window.setTimeout(() => el.remove(), BOOT_FADE_MS);
}

// ---- fatal error surface (CONTRACT RULE 9) ----------------------------------
let bannerEl: HTMLDivElement | null = null;
function showError(text: string): void {
  dismissBootSplash(true); // a failure must never hide behind a loading spinner
  if (bannerEl === null) {
    bannerEl = document.createElement('div');
    bannerEl.className = 'error-banner';
    document.body.appendChild(bannerEl);
  }
  bannerEl.textContent = text;
}

window.onerror = (_event, _source, _lineno, _colno, error) => {
  showError(`Error: ${error?.message ?? 'unknown'} — reload to retry`);
};
window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
  showError(`Error: ${ev.reason instanceof Error ? ev.reason.message : String(ev.reason)}`);
});

function boot(): void {
  const app = must<HTMLDivElement>('#app');
  const canvas = must<HTMLCanvasElement>('#game');

  const state = new ClientState();
  const hud = new Hud(must<HTMLElement>('#hud'));
  hud.show(false); // ClientGame flips it on at 'joined' and off on leave (C10 flow)

  // Menu callbacks wire straight onto ClientGame's frozen join/leave API plus
  // the seam methods in the header. They can only fire after boot completes,
  // by which point `game` is set — optional calls cover the boot-failure path.
  let game: ClientGame | null = null;
  const menus = new Menus(must<HTMLElement>('#menu'), {
    onQuickJoin: (name) => game?.joinQuick(name),
    onCreatePublic: (name, mapId) => game?.createPublic(name, mapId),
    onCreatePrivate: (name, mapId) => game?.createPrivate(name, mapId),
    onJoinPrivate: (name, code) => game?.joinPrivate(name, code),
    onListRooms: () => game?.listRooms() ?? Promise.resolve([]),
    onBuy: (weapon) => game?.buy(weapon),
    onBuyGear: (item: GearId) => game?.buyGear(item),
    onAddBot: () => game?.addBot(),
    onRemoveBot: () => game?.removeBot(),
    onRemoveAllBots: () => game?.removeAllBots(),
    onSwitchTeam: (team) => game?.switchTeam(team),
    onResume: () => {
      // re-request pointer lock on the canvas directly; may reject when the
      // browser refuses (e.g. too soon after Esc) — not fatal, user clicks again
      void Promise.resolve(canvas.requestPointerLock()).catch(() => undefined);
    },
    onLeave: () => game?.leave(),
  });

  // SceneRig (WebGL) is constructed inside ClientGame — this is where a missing
  // WebGL context throws; guard it with a readable error instead of a white screen.
  try {
    game = new ClientGame({ canvas, hud, menus, state });
  } catch (err) {
    showError(`Cannot start: WebGL unavailable (${err instanceof Error ? err.message : String(err)})`);
    return;
  }
  const g: ClientGame = game;

  // ---- rAF loop: one bad frame must never kill the loop (RULE 9) ------------
  let last = -1;
  let frames = 0; // counted between ?debug overlay refreshes
  const loop = (now: number): void => {
    const clamped = last < 0 ? now : Math.min(now, last + MAX_FRAME_MS);
    last = clamped;
    frames += 1;
    try {
      g.frame(clamped);
    } catch (err) {
      showError(`Frame error: ${err instanceof Error ? err.message : String(err)}`);
    }
    window.requestAnimationFrame(loop);
  };
  window.requestAnimationFrame(loop);

  // ---- resize → game (SceneRig.resize inside; seam) --------------------------
  window.addEventListener('resize', () => g.resize());

  // ---- first-gesture audio unlock: 'fps:gesture' seam event ------------------
  const onGesture = (): void => {
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
    window.dispatchEvent(new Event('fps:gesture')); // ClientGame resumes its AudioEngine
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);

  // ---- ?debug overlay: fps / ping / pos / phase @ 4Hz -------------------------
  if (new URLSearchParams(window.location.search).has('debug')) {
    const overlay = document.createElement('div');
    overlay.className = 'debug-overlay';
    app.appendChild(overlay);
    window.setInterval(() => {
      const fps = Math.round(frames * (1000 / DEBUG_HZ_MS));
      frames = 0;
      const info = g.debugInfo();
      overlay.textContent =
        `fps   ${fps}\n` +
        `ping  ${Math.round(info.pingMs)}ms\n` +
        `pos   ${info.pos[0].toFixed(1)} ${info.pos[1].toFixed(1)} ${info.pos[2].toFixed(1)}\n` +
        `phase ${state.phase}`;
    }, DEBUG_HZ_MS);
  }

  // ---- frozen e2e debug surface ----------------------------------------------
  window.__fps = {
    state: (): FpsState => {
      const you = state.latestYou;
      const info = g.debugInfo();
      return {
        phase: state.phase,
        roomId: state.roomId,
        code: state.code,
        mapId: state.mapId,
        team: state.team,
        hp: you?.hp ?? 100,
        armor: you?.armor ?? 0,
        alive: you?.alive ?? false,
        pos: [info.pos[0], info.pos[1], info.pos[2]],
        players: info.players,
        rosterSize: state.roster.size,
        ping: Math.round(info.pingMs),
        money: you?.money ?? 0,
        mag: you?.mag ?? 0,
        reserve: you?.reserve ?? 0,
        round: state.round,
        scoreT: state.scoreT,
        scoreCT: state.scoreCT,
        weapon: you?.weapon ?? 'knife',
      };
    },
    joinQuick: (name) => g.joinQuick(name),
    createPublic: (name, mapId) => g.createPublic(name, mapId),
    createPrivate: (name, mapId) => g.createPrivate(name, mapId),
    joinPrivate: (name, code) => g.joinPrivate(name, code),
    addBot: () => g.addBot(),
    removeBot: () => g.removeBot(),
    debug: {
      setLook: (yaw, pitch) => g.debugSetLook(yaw, pitch),
      setMove: (x, z) => g.debugSetMove(x, z),
      press: (btn, down) => g.debugSetButton(btn, down),
      reload: () => g.reload(),
      buy: (w) => g.buy(w),
      scoreboard: (down) => g.scoreboard(down),
      switchTeam: (team) => g.switchTeam(team),
      console: (text) => g.consoleExec(text),
    },
  };

  menus.showMain();
  dismissBootSplash(false); // shell is live: fade the loading state out
}

try {
  boot();
} catch (err) {
  showError(`Boot failed: ${err instanceof Error ? err.message : String(err)}`);
}
