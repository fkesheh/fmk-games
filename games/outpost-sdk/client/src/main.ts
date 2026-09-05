// ============================================================================
// cl-main — OUTPOST boot shell. Mirrors games/fps/client/src/main.ts: resolves
// #app/#game/#hud/#menu/#boot from index.html, mirrors PALETTE onto CSS custom
// properties, installs window.onerror/unhandledrejection guards behind a
// visible error banner, dismisses the boot splash, runs a dt-clamped rAF loop
// with a PER-FRAME try/catch, forwards resize, unlocks audio on the first user
// gesture, and installs `window.__outpost` implementing `OutpostDebugApi`
// (frozen in shared/src/types.ts) IN FULL — both verification harnesses assert
// this whole surface exists before doing anything else, and a missing method
// fails the build.
//
// GAME SEAM. CONTRACT.md's `OutpostGame` snippet spells out only the five
// debug-backing methods that have nowhere else to live (debugState/telemetry/
// freeCam/releaseCam/setTimeOfDay). The rest of `OutpostDebugApi` — join,
// createPrivate, joinPrivate, start, the scenario-staging verbs, and the input
// verbs (setLook/setMove/press/fireOnce/reload/switchWeapon/buyWeapon/
// buyAmmo) — need Net, the predictor and InputController, which per
// CONTRACT.md only `game.ts` may broadly import ("The ONLY file allowed broad
// concrete imports"). This file is the boot shell, not the integrator, so it
// cannot reach those directly; it therefore forwards each of those verbs to a
// same-named method on `OutpostGame`, exactly mirroring the STRICKEN
// C10/C11 seam (games/fps/client/src/main.ts calls g.joinQuick/g.buy/
// g.debugSetLook/etc. on `ClientGame` for the identical reason). If cl-game's
// actual surface uses different names, that is a naming reconciliation at
// integration, not a redesign — every call below is a thin pass-through to
// state OutpostGame already owns. `mapInfo()` and `clearOverlays()` need no
// such forwarding: the former reads `MAP_INFO` straight off the frozen shared
// map data, the latter calls `menus.hideAll()` directly since this file is the
// one that constructs `Menus`.
// ============================================================================
import { MAP_INFO, PALETTE } from '@outpost/shared';
import type { OutpostDebugApi } from '@outpost/shared';
import { OutpostGame } from './game.js';
import { Hud } from './ui/hud.js';
import { Menus } from './ui/menus.js';
import './style.css';

declare global {
  interface Window {
    __outpost?: OutpostDebugApi;
  }
}

const MAX_FRAME_MS = 100; // dt clamp — a background-tab gap must not teleport the sim
const BOOT_FADE_MS = 260; // must cover .boot-splash's opacity transition
// OutpostDebugApi.join()/createPrivate() take an OPTIONAL name; Net's
// underlying calls (per CONTRACT.md) do not. This is the fallback used when a
// harness omits one.
const DEFAULT_DEBUG_NAME = 'Survivor';

function must<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`missing ${selector} element`);
  return el;
}

// ---- PALETTE -> CSS custom properties (single source of truth) --------------
// Shell-only mirror (page/canvas/boot/error banner). ui-hud and ui-menus mirror
// PALETTE independently into their own injected <style> per CONTRACT.md, so
// this table only has to be a superset of what THIS file's style.css reads —
// it is not a surface those modules consume. Applied at module load, before
// any DOM is built and before window.onerror can paint the error banner.
const PALETTE_CSS_VARS: ReadonlyArray<readonly [name: string, hex: string]> = [
  ['--outpost-ink', PALETTE.ink], //             page + shell base
  ['--outpost-shell', PALETTE.charcoal], //      shell gradient lift
  ['--outpost-text', PALETTE.hudText], //        body copy
  ['--outpost-accent', PALETTE.hudAccent], //    focus ring, selection, boot mark
  ['--outpost-accent-lit', PALETTE.hazardAmberLit], // accent highlight
  ['--outpost-danger', PALETTE.danger], //       fatal banner
  ['--outpost-danger-deep', PALETTE.blood], //   fatal banner floor
];

// Alpha companions: rgba() needs channels, and mixing in a literal rgb() would
// reintroduce the hex this pass removes. Only the three used with opacity.
const PALETTE_CSS_RGB_VARS: ReadonlyArray<readonly [name: string, hex: string]> = [
  ['--outpost-ink-rgb', PALETTE.ink],
  ['--outpost-text-rgb', PALETTE.hudText],
  ['--outpost-accent-rgb', PALETTE.hudAccent],
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

// ---- fatal error surface: never a silent white/black screen -----------------
let bannerEl: HTMLDivElement | null = null;
function showError(text: string): void {
  dismissBootSplash(true); // a failure must never hide behind a loading splash
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
  // Resolve every root index.html promises, up front: a missing one is a
  // malformed page and should fail loudly rather than null-deref deep inside
  // a renderer later.
  must<HTMLDivElement>('#app');
  must<HTMLDivElement>('#boot');
  const canvas = must<HTMLCanvasElement>('#game');

  const hud = new Hud(must<HTMLElement>('#hud'));
  hud.show(false); // OutpostGame flips it on at 'joined' and off on leave

  // Menu callbacks wire onto OutpostGame's join/leave/economy surface. They
  // can only fire after boot completes, by which point `game` is set —
  // optional calls cover the (narrow) boot-failure window.
  let game: OutpostGame | null = null;

  // The lobby shows TWO start affordances: the menu panel's `.op-start-btn`
  // and the HUD's own `.oh-start-btn`. `Hud.onStart` is a separate hook from
  // `MenuCallbacks.onStart` below, and leaving it unassigned shipped a visible,
  // clickable START button that silently did nothing — the run just never
  // began. Both must point at the same place.
  hud.onStart = () => game?.start();
  const menus = new Menus(must<HTMLElement>('#menu'), {
    onQuickJoin: (name) => game?.quickJoin(name),
    onCreatePublic: (name) => game?.createPublic(name),
    onCreatePrivate: (name) => game?.createPrivate(name),
    onJoinPrivate: (name, code) => game?.joinPrivate(name, code),
    onListRooms: () => game?.listRooms() ?? Promise.resolve([]),
    onStart: () => game?.start(),
    onBuyWeapon: (weapon) => game?.buyWeapon(weapon),
    onBuyAmmo: () => game?.buyAmmo(),
    onResume: () => {
      // re-request pointer lock on the canvas directly; may reject when the
      // browser refuses (e.g. too soon after Esc) — not fatal, the player
      // just clicks again.
      void Promise.resolve(canvas.requestPointerLock()).catch(() => undefined);
    },
    onLeave: () => game?.leave(),
  });

  // SceneRig (WebGL) is constructed inside OutpostGame — this is where a
  // missing/lost context throws; guard it with a readable message instead of
  // a blank canvas (RULE: "guard for missing WebGL and degrade").
  try {
    game = new OutpostGame({ canvas, hud, menus });
  } catch (err) {
    showError(`Cannot start: WebGL unavailable (${err instanceof Error ? err.message : String(err)})`);
    return;
  }
  const g: OutpostGame = game;

  // ---- rAF loop: one bad frame must never kill the loop (RULE 9) ------------
  let last = -1;
  const loop = (now: number): void => {
    const clamped = last < 0 ? now : Math.min(now, last + MAX_FRAME_MS);
    const dt = last < 0 ? 0 : (clamped - last) / 1000; // seconds
    last = clamped;
    try {
      g.frame(dt);
    } catch (err) {
      showError(`Frame error: ${err instanceof Error ? err.message : String(err)}`);
    }
    window.requestAnimationFrame(loop);
  };
  window.requestAnimationFrame(loop);

  // ---- resize -> game (SceneRig.resize inside; seam) --------------------------
  window.addEventListener('resize', () => g.resize());

  // ---- first-gesture audio unlock: 'outpost:gesture' seam event -------------
  // OutpostGame owns the AudioApi instance and is expected to listen for this
  // window Event and call its resume() — browsers gate AudioContext creation
  // on a user gesture, and this boot-shell file does not own audio.
  const onGesture = (): void => {
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
    window.dispatchEvent(new Event('outpost:gesture'));
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);

  // ---- frozen debug surface (OutpostDebugApi, shared/src/types.ts) ----------
  // EVERY method of the interface must exist — both harnesses assert the whole
  // surface before doing anything else, and a missing method fails the build.
  window.__outpost = {
    state: () => g.debugState(),
    telemetry: () => g.telemetry(),

    // lobby
    join: (name) => g.quickJoin(name ?? DEFAULT_DEBUG_NAME),
    createPrivate: (name) => g.createPrivate(name ?? DEFAULT_DEBUG_NAME),
    joinPrivate: (name, code) => g.joinPrivate(name, code),
    start: (seed) => g.start(seed),

    // scenario staging — server-authoritative, so these must round-trip
    // through OutpostGame's Net rather than fake anything client-side.
    hurtSelf: (dmg) => g.hurtSelf(dmg),
    teleport: (x, y, z) => g.teleport(x, y, z),
    breachSegment: (seg) => g.breachSegment(seg),
    spawnAt: (kind, x, z) => g.spawnAt(kind, x, z),
    endRun: () => g.endRun(),
    setInvulnerable: (on) => g.setInvulnerable(on),

    // control
    setLook: (yaw, pitch) => g.setLook(yaw, pitch),
    setMove: (x, z) => g.setMove(x, z),
    press: (btn, down) => g.press(btn, down),
    fireOnce: () => g.fireOnce(),
    reload: () => g.reload(),
    switchWeapon: (w) => g.switchWeapon(w),
    buyWeapon: (w) => g.buyWeapon(w),
    buyAmmo: () => g.buyAmmo(),

    // capture-harness affordances — a screenshot must never be a lie
    mapInfo: () => MAP_INFO,
    freeCam: (x, y, z, yaw, pitch) => g.freeCam(x, y, z, yaw, pitch),
    releaseCam: () => g.releaseCam(),
    setTimeOfDay: (tod) => g.setTimeOfDay(tod),
    // Dismiss every MODAL overlay directly — main.ts constructs `menus`, so it
    // does not need to round-trip through OutpostGame for this. The always-on
    // HUD is never an overlay (CONTRACT.md), so it is left alone here; only
    // `MenusApi.hideAll()` feeds `telemetry().overlays`, which must read 0
    // immediately afterward.
    clearOverlays: () => menus.hideAll(),
  };

  menus.showMain();
  dismissBootSplash(false); // shell is live: fade the loading state out
}

try {
  boot();
} catch (err) {
  showError(`Boot failed: ${err instanceof Error ? err.message : String(err)}`);
}
