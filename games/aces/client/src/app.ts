// ============================================================================
// ACES — C_APP composition root (app.ts). The FINAL module: every sibling has
// landed green; this file wires them into one running game and owns nothing
// that a sibling could own (CONTRACT §2 import law: app composes, render
// never imports ui, ui never imports render internals).
//
// OWNERS HERE: DOM canvases + their stacking, the rAF loop with its 1/60
// accumulator, the camera rig (follow / lookahead / zoom / shake), input
// mapping from INPUT_KEYS to seq-stamped InputFrames sent at TICK_RATE,
// HudModel/OverlayModel assembly, killfeed/banner caches, screen-state flow,
// the reconnect policy over NET.BACKOFF_MS, film-grain + vignette passes,
// window.__ACES, and teardown.
//
// FLOW (BUILD LAW): boot → showMenu(localStorage 'aces.name') → onPlay →
// audio.unlock + showConnecting → net.connect → onWelcome (build map/renderer
// LAZILY here, predictor.setClass('fighter')) → snapshots drive lobby/live/
// end screens · auto first spawn 'fighter' when live · local RESPAWN_SECONDS
// countdown while dead (the wire omits `you` while dead — room.ts deletes it
// — so the timer is client-side) → picker via screens' own digit keys →
// PhaseMsg end → showEnd → auto-restart resets round-local caches.
//
// LOOP: rAF accumulates real dt into fixed 1/60 steps for sim-side logic;
// rendering happens once per frame in SCREEN→WORLD order: world.drawBelow →
// crates → projectiles → remote planes (interp at now−INTERP_MS) → OWN plane
// (predictor.state merged with server-authoritative fields — reconcile keeps
// hp/heat/jammed/… verbatim, movement is predicted) → effects particles →
// world.drawAbove (clouds occlude) → transform reset → HUD canvas model →
// grain tile → vignette. Every subsystem is wrapped in guarded(): one throw
// logs ONCE and skips that subsystem from then on — the loop itself cannot
// be killed by a sibling (RULES 5).
//
// SHAKE SPLIT (deliberate): C_FX already emits impulses internally where it
// draws the cause (hitSpark → SMALL per its header SHAKE LAW; explosion →
// MEDIUM/LARGE by the `size` argument). C_APP therefore adds exactly ONE
// impulse of its own — SHAKE.SMALL when YOU are hit (no C_FX path exists
// there) — and chooses explosion SIZE by proximity so the internal mapping
// yields "MEDIUM far / LARGE near-or-own-death": victim===me or blast within
// DIST_REF_U (borrowed from C_AUDIO as the shared "in your face" radius)
// ⇒ 'large', else 'small'. Adding app-side shake for explosions too would
// double every impulse.
//
// DOCUMENTED CHOICES / DEVIATIONS (task report mirrors these):
//  · Remote gun VOLLEY sounds are skipped entirely — the contract requires
//    only explosions/hits; own guns are predicted locally (RULES 10).
//  · Crate landing puffs are derived client-side from the snapshot diff
//    fall→active (the wire has no distinct "landed" event).
//  · After NET.BACKOFF_MS retries are exhausted the frozen Screens surface
//    has no menu-return control (its disconnect layer carries only notes),
//    so the app holds the manual-note screen; re-enlisting means reload.
//  · Respawn countdown is local because SnapPlane `you` is omitted while
//    dead (server truth, room.ts sendSnapshots).
//  · Throttle mapping uses physics.ts semantics directly: th=1 held-up,
//    th=−0.3 held-down (airbrake), th=0 released (targets speedMin cruise).
//    Any ramping would invent an unstated tunable.
// ============================================================================

import {
  CAMERA,
  CLASSES,
  FIRE_BELOW,
  INPUT_KEYS,
  NET,
  RESPAWN_SECONDS,
  SHAKE,
  SNAP_RATE,
  SMOKE_BELOW,
  STREAK_ACE,
  STREAK_LEGEND,
  TICK_RATE,
  TICKETS_TO_WIN,
  WORLD,
} from '@aces/shared/config.js';
import type { PlaneClassId, RoomSettings, TeamId } from '@aces/shared/config.js';
import { buildMap, isOpenWater } from '@aces/shared/maps.js';
import type { AcesMap } from '@aces/shared/maps.js';
import type { GameEvent, InputFrame, MatchPhase, ScoreRow } from '@aces/shared/types.js';
import type { SnapPlane } from '@aces/shared/protocol.js';
import type {
  Banner,
  CameraView,
  HudModel,
  JoinKind,
  KillFeedEntry,
  NetHandlers,
  OverlayModel,
  SnapshotView,
} from './contract/seams.js';
import { createNet, RemoteInterp } from './net.js';
import { OwnPredictor } from './prediction.js';
import { createWorldRenderer } from './render/world.js';
import type { WorldRenderer } from './render/world.js';
import { drawCrate, drawPlane } from './render/planes.js';
import { createEffects } from './render/effects.js';
import { createHud } from './ui/hud.js';
import type { Hud } from './ui/hud.js';
import { createScreens } from './ui/screens.js';
import type { Screens } from './ui/screens.js';
import { DIST_REF_U, createAudio, loadMuted, saveMuted } from './audio/audio.js';
import {
  PAL,
  drawGrain,
  fitCanvas,
  hashStr,
  makeGrainTiles,
  makeVignette,
} from './contract/visual.js';

/** What startAces hands back to the boot shell (seams.ts creator note). */
export interface AcesDebug {
  /** Lobby envelopes through NetClient — quick public seat or private room. */
  join(kind?: { kind?: 'quick' } | { kind: 'private'; settings?: RoomSettings }): Promise<void>;
  spawn(cls: PlaneClassId): void;
  state(): {
    phase: MatchPhase;
    timeLeftS: number;
    tickets: { royal: number; iron: number };
    you: boolean;
    board: ScoreRow[];
  };
  god(): void;
  warpTo(x: number, y: number): void;
  giveCrate(x?: number, y?: number): void;
  fastForward(ticks: number): void;
  /** Pin camera zoom for hero captures (null restores speed-auto). */
  zoomTo(z: number | null): void;
  muted(): boolean;
  /** e2e probing handles — read-only refs, nothing mutates game truth. */
  _internals: {
    net: ReturnType<typeof createNet>;
    predictor: OwnPredictor;
    interp: RemoteInterp;
    latestSnap(): SnapshotView | undefined;
  };
}

declare global {
  interface Window {
    __ACES?: AcesDebug;
  }
}

export interface AcesApp {
  destroy(): void;
}

// ---- module-private tunables -------------------------------------------------
// The frozen config carries gameplay numbers only; feel constants live beside
// the code that uses them (house pattern: world.ts TILE_U, effects.ts FX).

/** Sim/render substep — CONTRACT §5 pins render-side logic at 60 Hz. */
const STEP_S = 1 / 60;
/** Spiral-of-death clamp: drop backlog past this instead of freezing. */
const MAX_FRAME_S = 0.25;
const MAX_STEPS_PER_FRAME = 5;

/** Camera position ease rate, 1/s. Higher = tighter follow. Tuned so a full
 *  throttle turn keeps the nose comfortably inside the frame at ZOOM_MIN. */
const CAM_EASE_POS = 6;
/** Camera zoom ease rate, 1/s — slower than position so zoom breathes. */
const CAM_EASE_ZOOM = 3.5;

/** Shake decay, 1/s exponential; below SHAKE_CUTOFF_U the amp zeroes so the
 *  sines stop nudging sub-pixel values forever. */
const SHAKE_DECAY_PER_S = 6.5;
const SHAKE_CUTOFF_U = 0.05;
/** Accumulation ceiling ≈ one LARGE + margin — stacked hits can't fling the
 *  camera off-map. */
const SHAKE_MAX_U = SHAKE.LARGE * 1.25;
/** Incommensurate sine frequencies for the shake offset: deterministic (no
 *  Math.random — RULES 3), allocation-free, and the Lissajous pair never
 *  repeats visibly inside a burst. */
const SHAKE_FQ_A = 37.7;
const SHAKE_FQ_B = 29.3;
const SHAKE_Y_BIAS = 0.83; // vertical component slightly softer than horizontal

/** Nose offset ahead of center, u — mirrors fireVolley's muzzle placement in
 *  shared/physics.ts (single source: the volley itself). */
const NOSE_U = 18;

/** Killfeed/banner TTLs in SNAPSHOT ticks. 4 s mirrors hud.ts's internal
 *  FEED_TTL_TICKS (SNAP_RATE*4) so entries expire as their slips fade out. */
const FEED_TTL_TICKS = SNAP_RATE * 4;
const FEED_MAX = 8;
const BANNER_TTL_TICKS = SNAP_RATE * 4;
const BANNER_MAX = 4;

/** Auto-spawn resend cadence while the server has not yet confirmed a seat
 *  (spawn msg lost / join raced the live transition). Bounded self-healing. */
const AUTO_SPAWN_RETRY_MS = 1000;

/** localStorage keys. Name per task law; mute persistence lives in C_AUDIO
 *  (MUTED_KEY) and is reused through loadMuted/saveMuted — one store, one key. */
const NAME_KEY = 'aces.name';
const NAME_FALLBACK = 'PLAYER';

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return ''; // privacy mode / storage disabled — menu just starts empty
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // best-effort persistence only
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ============================================================================
// The composition root
// ============================================================================

export function startAces(container: HTMLElement): AcesApp {
  // ---- canvases (world below, hud above; CSS stacks them absolutely) -------
  const worldCanvas = document.createElement('canvas');
  worldCanvas.className = 'aces-cv aces-cv-world';
  const hudCanvas = document.createElement('canvas');
  hudCanvas.className = 'aces-cv aces-cv-hud';
  container.appendChild(worldCanvas);
  container.appendChild(hudCanvas);
  const ctx0 = worldCanvas.getContext('2d');
  if (ctx0 === null) throw new Error('aces: 2d canvas context unavailable');
  const ctx: CanvasRenderingContext2D = ctx0; // non-null for the whole session

  // ---- siblings -------------------------------------------------------------
  const audio = createAudio();
  let muted = loadMuted(); // persisted mute restored before any sound plays
  audio.setMuted(muted);

  const effects = createEffects(hashStr('fx'));
  const net = createNet();
  const predictor = new OwnPredictor('fighter'); // class re-set at welcome
  const interp = new RemoteInterp();

  // Pre-baked frame unification kit (RULES 11): grain tiles once, vignette
  // rebuilt only when the backing-store size changes.
  const grainTiles = makeGrainTiles(1917, 3);
  let vignette: HTMLCanvasElement | null = null;
  let vigW = -1;
  let vigH = -1;

  // World renderer is LAZY: buildMap(seed) needs the welcome's seed.
  let map: AcesMap | undefined;
  let worldRenderer: WorldRenderer | undefined;
  let builtSeed = -1;
  let wrW = -1;
  let wrH = -1;
  let wrDpr = -1;

  const hud = createHud(hudCanvas); // after hudCanvas exists (its ctx capture)

  // ---- connection / match state ---------------------------------------------
  let destroyed = false;
  let welcomed = false;
  let myId = '';
  let playerName = '';
  let joinKind: JoinKind = { kind: 'quick' };
  let attempts = 0; // consumed BACKOFF_MS entries
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  let haveSnap = false;
  let lastSnap: SnapshotView | undefined;
  let snapTick = 0;
  let phase: MatchPhase = 'lobby';
  let timeLeftS = 0;
  const tickets = { royal: 0, iron: 0 };
  let winnerVar: TeamId | undefined;
  let boardCache: ScoreRow[] = [];
  let boardVer = 0;
  let shownLobbySec = -2;
  let shownBoardVer = -1;
  let matchUIShown = false;
  let endShown = false;
  let sdShown = false; // sudden-death banner/stamp fires ONCE per round

  // Own-plane bookkeeping. seenYouRow gates everything HUD-side ("null while
  // spectating pre-first-spawn"); respawnT is LOCAL because the wire omits
  // `you` while dead.
  let seenYouRow = false;
  let everSpawned = false;
  let deadRemainS = 0;
  let maxHpCache = CLASSES.fighter.hp;
  let lastSpawnTryMs = -Infinity;

  // Round caches rebuilt on welcome / round restart.
  const feed: KillFeedEntry[] = [];
  let feedSeq = 0;
  const banners: Banner[] = [];
  let hitConfirmTick = 0;
  let hurtTick = 0;
  const fallingCrates = new Set<number>(); // crate ids seen mid-drop (land fx)

  // ---- camera rig -----------------------------------------------------------
  const camView: CameraView = { x: WORLD.W / 2, y: WORLD.H / 2, zoom: CAMERA.ZOOM_MAX };
  /** Judge/capture zoom pin (STYLE_BIBLE §4 hero close-ups); null = speed-auto. */
  let zoomOverride: number | null = null;
  let shakeAmp = 0;
  let speedFracCache = 0;
  let frameIdx = 0;

  function snapCamera(): void {
    camView.x = predictor.state.x;
    camView.y = predictor.state.y;
    camView.zoom = CAMERA.ZOOM_MAX;
    shakeAmp = 0;
  }

  // ---- input ------------------------------------------------------------------
  // Held-code set → sampled InputSource. Digit1/2/3, Tab, M, Escape are NEVER
  // touched here: screens owns them (picker hotkeys / scoreboard swallow /
  // mute hook / controls card) — double-handling would double-fire spawns.
  const held = new Set<string>();
  const PREVENT_CODES = new Set<string>([
    ...INPUT_KEYS.scoreboard,
    ...INPUT_KEYS.fire,
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
  ]);

  function anyHeld(codes: readonly string[]): boolean {
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c !== undefined && held.has(c)) return true;
    }
    return false;
  }

  function clearHeld(): void {
    held.clear();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (destroyed) return;
    if (e.repeat) return;
    // Typing the callsign must not feed the flight controls.
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    if (welcomed && phase === 'live' && PREVENT_CODES.has(e.code)) e.preventDefault();
    held.add(e.code);
  }

  function onKeyUp(e: KeyboardEvent): void {
    held.delete(e.code);
  }

  function onBlur(): void {
    clearHeld(); // RULES 6: blur clears inputs
  }

  function onVisibility(): void {
    if (document.hidden) clearHeld();
  }

  // ---- scratch (RULES 4: zero per-frame allocation in steady state) ----------
  const remoteOut: SnapPlane[] = []; // filled by sampleRemotes (pooled rows)
  const scratchOwn: SnapPlane = {
    id: '', name: '', team: 'royal', cls: 'fighter', bot: false,
    x: 0, y: 0, h: 0, sp: 0, vx: 0, vy: 0,
    hp: 0, maxHp: 1, heat: 0, jammed: false,
    boost: 0, boosting: false, throttle: 0,
    invulnT: 0, dead: false, streak: 0, seq: 0,
  };
  type TargetRow = { x: number; y: number; team: TeamId; cls: PlaneClassId; hpFrac: number };
  const targetsPool: TargetRow[] = [];

  const hmYou: NonNullable<HudModel['you']> = {
    cls: 'fighter', team: 'royal', hp: 0, maxHp: 1, heat: 0, jammed: false,
    boost: 0, throttle: 0, alive: false, respawnT: 0, streak: 0,
  };
  const hm: HudModel = {
    tick: 0, phase: 'lobby', timeLeftS: 0, suddenDeath: false,
    tickets: { royal: 0, iron: 0 },
    you: null, board: [], feed: [], banners: [], muted,
  };
  const om: OverlayModel = {
    alive: false, heading: 0, speedFrac: 0, heat: 0, jammed: false,
    targets: targetsPool, cam: camView, hitConfirmTick: 0, hurtTick: 0,
  };

  // ---- per-subsystem exception guard (RULES 5) --------------------------------
  // One throw logs ONCE and that subsystem is skipped for the rest of the
  // session — a poisoned draw call must never white-screen nor spam console.
  const failed = new Set<string>();
  function guarded(key: string, fn: () => void): void {
    if (failed.has(key)) return;
    try {
      fn();
    } catch (err) {
      failed.add(key);
      console.error(`[aces] ${key} disabled after throw:`, err);
    }
  }

  // ---- net handlers --------------------------------------------------------------
  function applySnapshot(snap: SnapshotView): void {
      if (destroyed || !welcomed) return;
      lastSnap = snap;
      haveSnap = true;
      snapTick = snap.tick;
      tickets.royal = snap.tickets.royal;
      tickets.iron = snap.tickets.iron;
      applyPhase(snap.phase);
      timeLeftS = snap.timeLeftS;
      interp.push(snap);
      checkSuddenDeath();

      // Crate landing puff: fall→active transition visible only in snapshots.
      for (let i = 0; i < snap.crates.length; i++) {
        const c = snap.crates[i];
        if (c === undefined) continue;
        if (c.phase === 'fall') fallingCrates.add(c.id);
        else if (fallingCrates.delete(c.id)) effects.crateFx('land', c.x, c.y);
      }

      // Own-row edges. reconcile() copies server-authoritative fields
      // verbatim (hp/heat/jammed/dead/name/team/cls/streak…) and integrates
      // movement snap-or-blend+replay — the merge the BUILD LAW asks for is
      // exactly this predictor contract.
      const hadRow = seenYouRow;
      const wasDead = predictor.state.dead;
      predictor.reconcile(snap.you);
      if (snap.you !== undefined) {
        maxHpCache = snap.you.maxHp > 0 ? snap.you.maxHp : CLASSES[snap.you.cls].hp;
        if (!hadRow) {
          seenYouRow = true;
          everSpawned = true;
          snapCamera(); // first-ever row: jump the camera to the spawn strip
        } else if (wasDead && !predictor.state.dead) {
          everSpawned = true;
          snapCamera(); // rebirth
        }
      }
      if (hadRow && !wasDead && predictor.state.dead) {
        deadRemainS = RESPAWN_SECONDS; // death edge — local timer (see header)
      }

      // Auto first spawn: live + never spawned → ask for a fighter. Sent at
      // ≤1 Hz until the server confirms a you-row (lost-msg self-healing);
      // seats joined during LOBBY are auto-spawned server-side at the live
      // transition, so this mostly covers mid-live joins.
      if (!everSpawned && snap.phase === 'live') {
        const nowMs = performance.now();
        if (nowMs - lastSpawnTryMs >= AUTO_SPAWN_RETRY_MS) {
          lastSpawnTryMs = nowMs;
          net.sendSpawn('fighter');
        }
      }
  }

  const handlers: NetHandlers = {
    onWelcome(w) {
      if (destroyed) return;
      attempts = 0; // healthy session resets the backoff ladder
      myId = w.id;
      welcomed = true;
      boardCache = w.roster;
      boardVer++;

      // LAZY world build: identical seed → identical terrain (maps.ts law).
      // A reconnect to a same-seed room reuses the baked renderer.
      if (builtSeed !== w.seed || worldRenderer === undefined) {
        builtSeed = w.seed;
        map = buildMap(w.seed);
        worldRenderer = createWorldRenderer(worldCanvas, map);
        wrW = -1; // force resize handoff on next frame
      }

      predictor.setClass('fighter');

      // Fresh seat (reconnect mints one — CONTRACT §5): wipe round-local UI
      // state so stale feed/banners from the dropped session can't leak.
      seenYouRow = false;
      everSpawned = false;
      deadRemainS = 0;
      lastSpawnTryMs = -Infinity;
      feed.length = 0;
      banners.length = 0;
      sdShown = false;
      endShown = false;
      matchUIShown = false;
      shownLobbySec = -2;
      fallingCrates.clear();
      hitConfirmTick = 0;
      hurtTick = 0;
      snapCamera();
    },

    onSnapshot(fn) {
      if (destroyed) return;
      // FROZEN-SEAM REGISTRATION (seams.ts): the hook hands us the producer's
      // registrar; we hand back our consumer IMMEDIATELY — a synchronous
      // round-trip, so even the very first parsed view (the event that
      // triggers C_NET's register-on-first-use bridge) is delivered. The one
      // narrow assertion below exists because the seam types the parameter as
      // the consumer itself while its real contract is registrar-shaped (see
      // header + report); the runtime callee simply captures what it receives,
      // so the disguise is exact. Reconnects re-register because net resets
      // its pump slot per connect().
      (fn as unknown as (consumer: (snap: SnapshotView) => void) => void)(applySnapshot);
    },

    onEvent(e) {
      if (destroyed || !welcomed) return;
      handleEvent(e);
    },

    onPhase(p, endsAtS, winner) {
      if (destroyed || !welcomed) return;
      applyPhase(p);
      timeLeftS = endsAtS; // same match-relative clock as snapshot timeLeftS
      if (winner !== undefined) winnerVar = winner;
    },

    onScore(board) {
      if (destroyed) return;
      boardCache = board;
      boardVer++;
    },

    onClose() {
      if (destroyed) return;
      scheduleReconnect();
    },
  };

  // ---- flow: join / reconnect ---------------------------------------------------
  function beginJoin(name: string, join: JoinKind): Promise<void> {
    playerName = name;
    joinKind = join;
    saveName(name);
    attempts = 0;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    // AudioContext creation is gesture-gated; PLAY clicks are gestures.
    void audio.unlock().catch(() => undefined);
    // Register the pilot name even for __ACES/debug joins that skip the menu
    // path — screens captures prefName for roster/board "(YOU)" highlighting.
    // Same-task swap into connecting, so only the connecting layer paints.
    screens.showMenu(playerName);
    screens.showConnecting();
    return attemptConnect();
  }

  function attemptConnect(): Promise<void> {
    return net.connect(playerName, joinKind, handlers).then(
      () => undefined, // socket open — the room welcome drives everything next
      () => {
        scheduleReconnect(); // never opened: backoff path, same as a drop
      },
    );
  }

  function scheduleReconnect(): void {
    if (destroyed) return;
    welcomed = false;
    haveSnap = false;
    const delay = attempts < NET.BACKOFF_MS.length ? NET.BACKOFF_MS[attempts] : undefined;
    attempts++;
    if (delay === undefined) {
      // Backoff exhausted: manual-note screen (deviation documented in header
      // — the frozen Screens layer offers no menu-return control).
      screens.showDisconnected(false);
      return;
    }
    screens.showDisconnected(true);
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void attemptConnect();
    }, delay);
  }

  // ---- phase / screens ------------------------------------------------------------
  function applyPhase(next: MatchPhase): void {
    if (next === phase) return;
    const prev = phase;
    phase = next;
    matchUIShown = false;
    if (next === 'end') {
      endShown = false;
    } else if (next === 'live' && prev === 'end') {
      // Auto-restart into a fresh live round: reset round-local caches.
      feed.length = 0;
      banners.length = 0;
      sdShown = false;
      deadRemainS = 0;
      fallingCrates.clear();
      endShown = false;
    }
  }

  function checkSuddenDeath(): void {
    if (sdShown || phase !== 'live') return;
    const tie = tickets.royal === tickets.iron;
    const bothCapped = tickets.royal >= TICKETS_TO_WIN && tickets.iron >= TICKETS_TO_WIN;
    // Server rule: higher tickets wins at time expiry; tie → sudden death,
    // next credited kill ends it. Also covers a simultaneous 25-25 tick.
    if (tie && (timeLeftS <= 0 || bothCapped)) {
      sdShown = true;
      banners.push({ kind: 'suddendeath', text: 'SUDDEN DEATH', bornTick: snapTick });
      trimBanners();
    }
  }

  function updateScreens(): void {
    if (!welcomed) return;
    switch (phase) {
      case 'lobby': {
        const sec = Math.max(0, Math.ceil(timeLeftS));
        if (sec !== shownLobbySec || boardVer !== shownBoardVer) {
          shownLobbySec = sec;
          shownBoardVer = boardVer;
          screens.showLobby(sec, boardCache); // diffs internally
        }
        break;
      }
      case 'live': {
        if (seenYouRow && predictor.state.dead) {
          matchUIShown = false;
          screens.showDeath(Math.max(0, deadRemainS), predictor.state.cls);
        } else if (!matchUIShown) {
          matchUIShown = true;
          screens.showMatchUI();
        }
        break;
      }
      case 'end': {
        if (!endShown) {
          endShown = true;
          const wnr =
            winnerVar ??
            (tickets.royal > tickets.iron
              ? 'royal'
              : tickets.iron > tickets.royal
                ? 'iron'
                : undefined);
          screens.showEnd(boardCache, wnr);
          if (seenYouRow) audio.ui(predictor.state.team === wnr ? 'win' : 'lose');
        }
        break;
      }
    }
  }

  // ---- events → models/fx/audio ------------------------------------------------------
  function trimFeed(): void {
    for (let i = feed.length - 1; i >= 0; i--) {
      const f = feed[i];
      if (f !== undefined && snapTick - f.bornTick >= FEED_TTL_TICKS) feed.splice(i, 1);
    }
    while (feed.length > FEED_MAX) feed.shift();
  }

  function trimBanners(): void {
    for (let i = banners.length - 1; i >= 0; i--) {
      const b = banners[i];
      if (b !== undefined && snapTick - b.bornTick >= BANNER_TTL_TICKS) banners.splice(i, 1);
    }
    while (banners.length > BANNER_MAX) banners.shift();
  }

  function handleEvent(e: GameEvent): void {
    switch (e.kind) {
      case 'kill': {
        // Crash variant renders from VICTIM fields per types.ts wire-shape law
        // (killer fields carry the victim's identity when crash=true).
        feed.push({
          id: ++feedSeq,
          killerName: e.killerName,
          victimName: e.victimName,
          killerTeam: e.killerTeam,
          crash: e.crash,
          killerCls: e.killerCls,
          bornTick: snapTick,
        });
        trimFeed();

        const mp = map;
        const overWater = mp !== undefined ? isOpenWater(mp, e.x, e.y) : false;
        const dist = Math.hypot(e.x - camView.x, e.y - camView.y);
        // Size law (header "SHAKE SPLIT"): near blast / own death = large,
        // distant = small — C_FX maps these onto MEDIUM/LARGE impulses.
        const size = e.victim === myId || dist <= DIST_REF_U ? ('large' as const) : ('small' as const);
        effects.explosion(e.x, e.y, size, overWater);
        audio.explosion(dist);

        if (myId !== '' && e.killer === myId) {
          audio.killConfirm();
          audio.streak(e.streak); // two-note stinger at ACE/LEGEND thresholds
          if (e.streak >= STREAK_LEGEND) banners.push({ kind: 'legend', text: 'LEGEND', bornTick: snapTick });
          else if (e.streak >= STREAK_ACE) banners.push({ kind: 'ace', text: 'ACE', bornTick: snapTick });
          trimBanners();
        }
        break;
      }
      case 'hit': {
        if (myId !== '' && e.by === myId) {
          hitConfirmTick = snapTick;
          // Spark backsplash cone points away from MY gunline.
          const st = predictor.state;
          effects.hitSpark(e.x, e.y, Math.atan2(e.y - st.y, e.x - st.x));
          audio.hitConfirm();
        } else if (e.target === myId) {
          hurtTick = snapTick;
          audio.hurt();
          effects.shake(SHAKE.SMALL); // the ONE app-side impulse (see header)
        }
        // Remote volleys produce no sounds by documented choice.
        break;
      }
      case 'crate': {
        if (myId !== '' && e.what === 'pickup' && e.by === myId) {
          effects.crateFx('pickup', e.x, e.y);
          audio.pickup();
        }
        break;
      }
    }
  }

  // ---- fixed-step logic (60 Hz) ---------------------------------------------------
  let sendAccS = 0;
  let prevFireHeld = false;
  let prevJammed = false;
  let seqCounter = 1;
  const SEND_EVERY_S = 1 / TICK_RATE;

  function stepFixed(dt: number): void {
    const th = anyHeld(INPUT_KEYS.throttleUp) ? 1 : anyHeld(INPUT_KEYS.throttleDown) ? -0.3 : 0;
    const tr = (anyHeld(INPUT_KEYS.turnRight) ? 1 : 0) - (anyHeld(INPUT_KEYS.turnLeft) ? 1 : 0);
    const fire = anyHeld(INPUT_KEYS.fire);
    const boost = anyHeld(INPUT_KEYS.boost);

    sendAccS += dt;
    const due = sendAccS >= SEND_EVERY_S;
    if (due) sendAccS -= SEND_EVERY_S;

    if (!welcomed) {
      prevFireHeld = fire; // keep edges honest across connect boundaries
      return;
    }

    const st = predictor.state;
    if (!st.dead) predictor.advance(dt); // death freeze is the predictor's law

    if (deadRemainS > 0) deadRemainS = Math.max(0, deadRemainS - dt);

    // Jam edge → clunk+rattle (D2: the cost of holding trigger).
    if (!prevJammed && st.jammed && !st.dead) audio.overheatJam();
    prevJammed = st.jammed;

    // Trigger rising edge → SAME-FRAME cosmetics (RULES 10, ≤100 ms budget):
    // flash + tracer stub + shot, gated like the server's fireVolley
    // (dead/jammed/spawn-protected guns stay silent).
    if (fire && !prevFireHeld && !st.dead && !st.jammed && st.invulnT <= 0) {
      const nx = st.x + Math.cos(st.h) * NOSE_U;
      const ny = st.y + Math.sin(st.h) * NOSE_U;
      effects.muzzleFlash(nx, ny, st.h);
      effects.tracerStub(nx, ny, st.h);
      audio.shot(true, 0);
    }
    prevFireHeld = fire;

    effects.update(dt);

    if (due) {
      // Wire-crossing object — allocation-exempt (RULES 4). Shared BY
      // REFERENCE with the predictor's pending queue (InputFrame readonly).
      const frame: InputFrame = { seq: seqCounter++, th, tr, fire, boost };
      net.sendInput(frame);
      predictor.onLocalInput(frame);
    }
  }

  // ---- trails ------------------------------------------------------------------------
  function trailLevel(hp: number, maxHp: number): 'smoke' | 'fire' | null {
    if (maxHp <= 0) return null;
    const frac = hp / maxHp;
    if (frac < FIRE_BELOW) return 'fire';
    if (frac < SMOKE_BELOW) return 'smoke';
    return null;
  }

  function emitTrails(): void {
    const st = predictor.state;
    for (let i = 0; i < remoteOut.length; i++) {
      const row = remoteOut[i];
      if (row === undefined || row.id === myId || row.dead) continue;
      effects.trail(row.id, row.x, row.y, trailLevel(row.hp, row.maxHp));
    }
    if (myId === '') return;
    // Own emitter: level follows merged view; explicit null while dead clears.
    effects.trail(myId, st.x, st.y, st.dead ? null : trailLevel(st.hp, maxHpCache));
  }

  // ---- models -------------------------------------------------------------------------
  function fillScratchOwn(): void {
    const st = predictor.state;
    // Movement + all combat fields come from the predictor's state — its
    // reconcile already merges server-authoritative mirrors over prediction.
    scratchOwn.id = st.id;
    scratchOwn.name = st.name;
    scratchOwn.team = st.team;
    scratchOwn.cls = st.cls;
    scratchOwn.bot = false;
    scratchOwn.x = st.x;
    scratchOwn.y = st.y;
    scratchOwn.h = st.h;
    scratchOwn.sp = Math.hypot(st.vx, st.vy);
    scratchOwn.vx = st.vx;
    scratchOwn.vy = st.vy;
    scratchOwn.hp = st.hp;
    scratchOwn.maxHp = maxHpCache;
    scratchOwn.heat = st.heat;
    scratchOwn.jammed = st.jammed;
    scratchOwn.boost = st.boost;
    scratchOwn.boosting = st.boosting;
    scratchOwn.throttle = st.throttle;
    scratchOwn.invulnT = st.invulnT;
    scratchOwn.dead = st.dead;
    scratchOwn.streak = st.streak;
    scratchOwn.seq = 0;
  }

  function assembleModels(): void {
    hm.tick = snapTick;
    hm.phase = phase;
    hm.timeLeftS = timeLeftS;
    hm.suddenDeath = sdShown && phase === 'live';
    hm.tickets.royal = tickets.royal;
    hm.tickets.iron = tickets.iron;
    hm.board = boardCache;
    hm.feed = feed;
    hm.banners = banners;
    hm.muted = muted;

    const st = predictor.state;
    if (!seenYouRow) {
      hm.you = null; // spectating pre-first-spawn
    } else {
      hmYou.cls = st.cls;
      hmYou.team = st.team;
      hmYou.hp = st.hp;
      hmYou.maxHp = maxHpCache;
      hmYou.heat = st.heat;
      hmYou.jammed = st.jammed;
      hmYou.boost = st.boost;
      hmYou.throttle = st.throttle;
      hmYou.alive = !st.dead;
      hmYou.respawnT = deadRemainS;
      hmYou.streak = st.streak;
      hm.you = hmYou;
    }

    om.alive = seenYouRow && !st.dead;
    om.heading = st.h;
    om.speedFrac = speedFracCache;
    om.heat = st.heat;
    om.jammed = st.jammed;
    om.hitConfirmTick = hitConfirmTick;
    om.hurtTick = hurtTick;

    // Enemies in snapshot order; pooled rows keep the loop alloc-free.
    let ti = 0;
    for (let i = 0; i < remoteOut.length; i++) {
      const row = remoteOut[i];
      if (row === undefined || row.dead || row.id === myId) continue;
      if (seenYouRow && row.team === st.team) continue;
      let slot = targetsPool[ti];
      if (slot === undefined) {
        slot = { x: 0, y: 0, team: row.team, cls: row.cls, hpFrac: 0 };
        targetsPool.push(slot);
      }
      slot.x = row.x;
      slot.y = row.y;
      slot.team = row.team;
      slot.cls = row.cls;
      slot.hpFrac = row.maxHp > 0 ? clamp01(row.hp / row.maxHp) : 0;
      ti++;
    }
    targetsPool.length = ti;
  }

  // ---- render pass ----------------------------------------------------------------------
  let lastMs = -1;
  let accS = 0;

  function render(nowMs: number, dtS: number): void {
    const fitted = fitCanvas(worldCanvas);
    const wCss = fitted.w;
    const hCss = fitted.h;
    const cw = worldCanvas.width;
    const ch = worldCanvas.height;
    const dpr = cw / Math.max(1, wCss);

    if (cw !== vigW || ch !== vigH) {
      vigW = cw;
      vigH = ch;
      vignette = makeVignette(cw, ch); // device-pixel bake, drawn at identity
    }

    // --- camera rig ---
    const st = predictor.state;
    const spec = CLASSES[st.cls];
    speedFracCache = clamp01(Math.hypot(st.vx, st.vy) / spec.speedMax);
    const tx = st.x + st.vx * CAMERA.LOOKAHEAD_S;
    const ty = st.y + st.vy * CAMERA.LOOKAHEAD_S;
    const kp = 1 - Math.exp(-CAM_EASE_POS * dtS);
    camView.x += (tx - camView.x) * kp;
    camView.y += (ty - camView.y) * kp;
    const zoomTarget = zoomOverride ?? CAMERA.ZOOM_MAX + (CAMERA.ZOOM_MIN - CAMERA.ZOOM_MAX) * speedFracCache;
    camView.zoom += (zoomTarget - camView.zoom) * (1 - Math.exp(-CAM_EASE_ZOOM * dtS));

    const tS = nowMs / 1000;
    shakeAmp = Math.min(SHAKE_MAX_U, shakeAmp + effects.consumeShake());
    const shx = Math.sin(tS * SHAKE_FQ_A) * shakeAmp;
    const shy = Math.cos(tS * SHAKE_FQ_B) * shakeAmp * SHAKE_Y_BIAS;
    shakeAmp *= Math.exp(-SHAKE_DECAY_PER_S * dtS);
    if (shakeAmp < SHAKE_CUTOFF_U) shakeAmp = 0;

    // Clear + sea base under everything (drawBelow paints the live sea over
    // this once built; pre-welcome the menus cover it anyway).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = PAL.seaDeep;
    ctx.fillRect(0, 0, cw, ch);

    // World transform: pan + zoom + DPR-center math; shake rides the camera.
    const z = camView.zoom;
    ctx.setTransform(
      dpr * z,
      0,
      0,
      dpr * z,
      dpr * (wCss / 2 - (camView.x + shx) * z),
      dpr * (hCss / 2 - (camView.y + shy) * z),
    );

    const wr = worldRenderer;
    if (wr !== undefined) {
      if (wCss !== wrW || hCss !== wrH || dpr !== wrDpr) {
        wrW = wCss;
        wrH = hCss;
        wrDpr = dpr;
        wr.resize(wCss, hCss, dpr);
      }
      guarded('world.below', () => wr.drawBelow(ctx, camView, tS));
    }

    const snap = lastSnap;
    if (haveSnap && snap !== undefined) {
      guarded('crates', () => {
        for (let i = 0; i < snap.crates.length; i++) {
          const c = snap.crates[i];
          if (c !== undefined) drawCrate(ctx, c, tS);
        }
      });
      guarded('projectiles', () => effects.drawProjectiles(ctx, snap.bullets));
    }

    interp.sampleRemotes(nowMs, remoteOut); // pooled rows, no allocation
    guarded('planes.remote', () => {
      for (let i = 0; i < remoteOut.length; i++) {
        const row = remoteOut[i];
        if (row === undefined || row.id === myId || row.dead) continue;
        drawPlane(ctx, row, tS);
      }
    });

    const ownVisible = seenYouRow && !predictor.state.dead;
    if (ownVisible) {
      fillScratchOwn();
      guarded('planes.own', () => drawPlane(ctx, scratchOwn, tS));
    }

    guarded('fx.trails', emitTrails);
    guarded('fx.draw', () => effects.draw(ctx, camView));
    if (wr !== undefined) guarded('world.above', () => wr.drawAbove(ctx, camView, tS));

    // --- screen space: HUD model → grain → vignette ---
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    assembleModels();
    if (welcomed) guarded('hud', () => hud.update(hm, om));

    guarded('grain', () => drawGrain(ctx, cw, ch, grainTiles, frameIdx));
    frameIdx++;
    const vg = vignette;
    if (vg !== null) guarded('vignette', () => ctx.drawImage(vg, 0, 0));

    // Engine + wind follow the merged own view; idle-fade while dead/off-line.
    guarded('audio.frame', () => {
      if (ownVisible) {
        audio.ownEngine(predictor.state.throttle, speedFracCache, predictor.state.boosting);
        audio.wind(speedFracCache);
      } else {
        audio.ownEngine(0, 0, false);
        audio.wind(0);
      }
    });
  }

  // ---- rAF loop --------------------------------------------------------------------------
  let raf = 0;

  function frame(nowMs: number): void {
    if (destroyed) return;
    raf = window.requestAnimationFrame(frame);

    let dtS = lastMs < 0 ? 0 : (nowMs - lastMs) / 1000;
    lastMs = nowMs;
    if (!(dtS > 0)) dtS = 0;
    if (dtS > MAX_FRAME_S) dtS = MAX_FRAME_S;

    accS += dtS;
    let steps = 0;
    while (accS >= STEP_S && steps < MAX_STEPS_PER_FRAME) {
      stepFixed(STEP_S);
      accS -= STEP_S;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accS = 0; // dump pathological backlog

    try {
      render(nowMs, dtS);
      updateScreens();
    } catch (err) {
      // Belt-and-braces around the composition itself; subsystems are already
      // individually guarded — this catches camera/model math regressions.
      guarded('frame', () => {
        throw err;
      });
    }
  }

  // ---- hooks + debug surface ------------------------------------------------------------
  function toggleMute(): void {
    muted = !muted;
    saveMuted(muted);
    audio.setMuted(muted);
  }

  const screens = createScreens({
    onPlay(name, join) {
      void beginJoin(name, join);
    },
    onSpawn(cls) {
      // Local airframe swap keeps prediction honest until the next snapshot
      // re-authors resources; the server remains sole authority.
      predictor.setClass(cls);
      net.sendSpawn(cls);
      audio.ui('spawn');
    },
    onMuteToggle() {
      toggleMute();
    },
    onHelp() {
      // Informational card — screens owns visibility; nothing to mirror.
    },
  });

  window.__ACES = {
    join(kind) {
      let jk: JoinKind = { kind: 'quick' };
      if (kind !== undefined && kind.kind === 'private') {
        jk = { kind: 'private', settings: kind.settings ?? {} };
      }
      return beginJoin(loadName() || NAME_FALLBACK, jk);
    },
    spawn(cls) {
      predictor.setClass(cls);
      net.sendSpawn(cls);
    },
    state() {
      return {
        phase,
        timeLeftS,
        tickets: { royal: tickets.royal, iron: tickets.iron },
        you: seenYouRow && !predictor.state.dead,
        board: boardCache,
      };
    },
    god() {
      net.sendDebug('god');
    },
    warpTo(x, y) {
      net.sendDebug('warp', x, y);
    },
    giveCrate(x, y) {
      net.sendDebug('crate', x, y);
    },
    fastForward(ticks) {
      net.sendDebug('tick', ticks);
    },
    /** Judge/capture hook (STYLE_BIBLE §4): pin the camera zoom. null = auto. */
    zoomTo(z: number | null) {
      zoomOverride = z === null ? null : Math.max(0.5, Math.min(6, z));
    },
    muted() {
      toggleMute();
      return muted;
    },
    _internals: {
      net,
      predictor,
      interp,
      latestSnap: () => lastSnap,
    },
  };

  // ---- wiring + boot ----------------------------------------------------------------------
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  raf = window.requestAnimationFrame(frame);

  screens.showMenu(loadName());

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      if (retryTimer !== null) clearTimeout(retryTimer);
      net.close(); // closedByUser path — suppresses onClose reconnect UX
      hud.destroy();
      screens.hideAll(); // frozen Screens exposes no destroy — hide is best-effort
      delete window.__ACES;
      worldCanvas.remove();
      hudCanvas.remove();
      // audio/Screens own no teardown in the frozen seams; dropping refs lets
      // the GC reclaim them once their internal timers drain.
    },
  };
}


