// ============================================================================
// GHOSTRUN MAIN — composition root (specs/P11.md). Wires @platform/sdk facade
// + engine Loop/rig to the pure track/sim, owns the save lifecycle, and
// exposes the window.__ghostrun e2e hooks.
//
// CLOUD SAVES AS GAMEPLAY DATA: slot 'ghost' stores today's replay blob
// {date,timeMs,samples} (2-decimal quantized); slot 'best' mirrors
// {timeMs,date} for fast menu loads. When the cloud is unreachable the game
// keeps working — localStorage mirrors + an "offline" banner.
// ============================================================================

import { updateSave, createGameClient } from '@platform/sdk';
import type { GameClient } from '@platform/sdk';
import { Loop as GameLoop, createDebugHud } from '@platform/engine';
import type { DebugHud, Loop } from '@platform/engine';
import {
  CHECKPOINT_STRIDE,
  buildTrack,
  todayDateKey,
} from './track.js';
import type { Track } from './track.js';
import {
  createSim,
  drainEvents,
  finalTimeMs,
  quantizeSamples,
  step as stepSim,
} from './sim.js';
import type { GhostSamples, SimState } from './sim.js';
import { GameRenderer } from './render.js';
import type { RenderView } from './render.js';
import { Ui } from './ui.js';

// ---- save schemas -----------------------------------------------------------

interface BestSave {
  readonly timeMs: number;
  readonly date: string;
}

interface GhostSave {
  readonly date: string;
  readonly timeMs: number;
  readonly samples: GhostSamples;
}

const BEST_KEY = 'ghostrun.best';
const GHOST_KEY = 'ghostrun.ghost';

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function numArray(v: unknown, n: number): number[] | null {
  if (!Array.isArray(v) || v.length !== n) return null;
  const out: number[] = [];
  for (const x of v) {
    if (!isNum(x)) return null;
    out.push(x);
  }
  return out;
}

/** Strict-enough readers: corrupt/missing saves degrade to "fresh start". */
export function parseBest(v: unknown): BestSave | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isNum(o.timeMs) || o.timeMs <= 0 || typeof o.date !== 'string') return null;
  return { timeMs: o.timeMs, date: o.date };
}

export function parseGhost(v: unknown): GhostSave | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.date !== 'string' || !isNum(o.timeMs) || o.timeMs <= 0) return null;
  const s = o.samples;
  if (typeof s !== 'object' || s === null) return null;
  const sv = s as Record<string, unknown>;
  const t = numArray(sv.t, Array.isArray(sv.x) ? sv.x.length : -1);
  if (t === null || t.length < 2) return null;
  const x = numArray(sv.x, t.length);
  const y = numArray(sv.y, t.length);
  const z = numArray(sv.z, t.length);
  const yaw = numArray(sv.yaw, t.length);
  if (x === null || y === null || z === null || yaw === null) return null;
  return { date: o.date, timeMs: o.timeMs, samples: { t, x, y, z, yaw } };
}

// guarded localStorage (identity.ts precedent: storage is a courtesy)
function readLocalJson(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw === null || raw === undefined ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function writeLocalJson(key: string, data: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(data));
  } catch {
    // quota/private mode — page-local play still works
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`save timeout ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

// ---- e2e hook surface ----------------------------------------------------------

export interface GhostrunHooks {
  state(): {
    screen: string;
    timeMs: number;
    bestTimeMs: number | null;
    hasGhost: boolean;
    pos: [number, number, number];
    onGround: boolean;
  };
  start(): void;
  move(x: number, z: number): void;
  press(bit: number, down: boolean): void;
}

declare global {
  interface Window {
    __ghostrun?: GhostrunHooks;
  }
}

// ---- app --------------------------------------------------------------------

function main(): void {
  const DEBUG = new URLSearchParams(window.location.search).has('debug');

  document.getElementById('boot')?.classList.add('gone');

  const canvas = document.getElementById('cv') as HTMLCanvasElement | null;
  if (canvas === null) throw new Error('GHOSTRUN: #cv canvas missing');
  const client: GameClient = createGameClient({ gameId: 'ghostrun', canvas });
  client.input.setTouch({ enabled: true, actions: [{ bit: 0, label: 'JUMP' }] });
  client.input.start();

  const renderer = new GameRenderer(canvas);
  window.addEventListener('resize', () => renderer.resize());

  const track: Track = buildTrack(todayDateKey());
  renderer.buildWorld(track);

  // ---- persistent state (local mirrors first — instant menu) -------------------
  const todayKey = track.dateKey;
  let best: BestSave | null = parseBest(readLocalJson(BEST_KEY));
  const localGhostRaw = parseGhost(readLocalJson(GHOST_KEY));
  let ghostToday: GhostSave | null =
    localGhostRaw !== null && localGhostRaw.date === todayKey ? localGhostRaw : null;
  let localOnly = false;
  let raceGhost = ghostToday !== null;

  // ---- run state -----------------------------------------------------------------
  let st: SimState | null = null;
  let preRunBestMs: number | null = null;
  let hadGhostAtStart = false;
  let camYaw = track.startYaw;
  let pitch = -0.14;
  let manualLookTimer = 0;
  let hookMove: { x: number; z: number } | null = null;
  let synthJumpDown = false;
  let stepDist = 0;

  function beginRun(): void {
    st = createSim(track);
    preRunBestMs = best?.timeMs ?? null;
    hadGhostAtStart = raceGhost && ghostToday !== null;
    renderer.setGhost(hadGhostAtStart ? (ghostToday?.samples ?? null) : null);
    camYaw = track.startYaw;
    pitch = -0.14;
    manualLookTimer = 0;
    stepDist = 0;
    client.audio.resume();
    client.audio.ambient('wind');
    client.audio.sfx('click');
    ui.showHud(preRunBestMs);
  }

  function refreshMenu(): void {
    ui.showMenu({
      dateKey: todayKey,
      seed: track.seed,
      bestTimeMs: best?.timeMs ?? null,
      hasGhostToday: ghostToday !== null,
      ghostTimeMs: ghostToday?.timeMs ?? null,
      raceGhost,
      localOnly,
    });
  }

  const ui = new Ui({
    onStart: () => beginRun(),
    onToggleRace: (on) => {
      raceGhost = on;
    },
    onRetry: () => beginRun(),
    onMenu: () => {
      st = null;
      renderer.setGhost(null);
      refreshMenu();
    },
  });

  // ---- cloud saves: upgrade the local picture, or flag offline -----------------
  async function loadCloudSaves(): Promise<boolean> {
    const [bestRes, ghostRes] = await Promise.allSettled([
      withTimeout(client.saves.get<unknown>('best'), 3500),
      withTimeout(client.saves.get<unknown>('ghost'), 3500),
    ]);
    if (bestRes.status === 'rejected' && ghostRes.status === 'rejected') return false;
    if (bestRes.status === 'fulfilled') {
      const parsed = parseBest(bestRes.value.data);
      if (parsed !== null && (best === null || parsed.timeMs < best.timeMs)) best = parsed;
    }
    if (ghostRes.status === 'fulfilled') {
      const parsed = parseGhost(ghostRes.value.data);
      if (parsed !== null && parsed.date === todayKey) {
        if (ghostToday === null || parsed.timeMs < ghostToday.timeMs) ghostToday = parsed;
      }
    }
    return true;
  }

  /** Fire-and-forget writeback. Local mirrors are ALWAYS written first. */
  function persist(pb: boolean, beatGhost: boolean, timeMs: number, samples: GhostSamples): void {
    if (pb) {
      const b: BestSave = { timeMs, date: todayKey };
      best = b;
      writeLocalJson(BEST_KEY, b);
    }
    if (pb || beatGhost) {
      const g: GhostSave = { date: todayKey, timeMs, samples: quantizeSamples(samples) };
      ghostToday = g;
      writeLocalJson(GHOST_KEY, g);
    }
    void (async () => {
      try {
        if (pb) {
          await updateSave<unknown>(client.saves, 'best', (cur) => {
            const c = parseBest(cur);
            return c !== null && c.timeMs <= timeMs ? cur : { timeMs, date: todayKey };
          });
        }
        if (pb || beatGhost) {
          await updateSave<unknown>(client.saves, 'ghost', (cur) => {
            const c = parseGhost(cur);
            if (c !== null && c.date === todayKey && c.timeMs <= timeMs) return cur;
            return { date: todayKey, timeMs, samples: quantizeSamples(samples) };
          });
        }
      } catch {
        localOnly = true; // unreachable cloud — banner explains; locals already safe
      }
    })();
  }

  function finishRun(stf: SimState): void {
    const t = finalTimeMs(stf);
    const pb = preRunBestMs === null || t < preRunBestMs;
    const beatGhost =
      hadGhostAtStart && ghostToday !== null && t < ghostToday.timeMs;
    client.audio.sfx(beatGhost || pb ? 'win' : 'score');
    if (pb || beatGhost) {
      renderer.confetti(track.finishPos.x, track.finishPos.y, track.finishPos.z);
    }
    persist(pb, beatGhost, t, stf.samples);
    window.setTimeout(() => {
      ui.showResults({
        timeMs: t,
        deltaMs: preRunBestMs === null ? null : t - preRunBestMs,
        isPb: pb,
        beatGhost,
        respawns: stf.respawns,
        name: client.profile.me()?.name ?? 'Guest',
      });
    }, 1000);
  }

  // ---- loop --------------------------------------------------------------------
  let fpsEma = 60;
  let hudDebug: DebugHud | null = null;
  if (DEBUG) {
    hudDebug = createDebugHud(() => [
      `${fpsEma.toFixed(0)} fps · loop ${loop.tickCount}`,
      `screen=${ui.screen}`,
      st === null ? 'no run' : `t=${st.timeMs.toFixed(0)} pen=${st.penaltyMs}`,
      st === null
        ? ''
        : `pos=${st.pos.x.toFixed(1)},${st.pos.y.toFixed(1)},${st.pos.z.toFixed(1)} gnd=${st.groundKind}`,
      st === null ? '' : `samples=${st.samples.t.length}`,
      `seed=#${track.seed.toString(16)}`,
    ]);
  }

  const view: RenderView = {
    mode: 'menu',
    px: track.startPos.x,
    py: track.startPos.y,
    pz: track.startPos.z,
    camYaw: track.startYaw,
    pitch: -0.14,
    airTime: 0,
    vx: 0,
    vz: 0,
    timeMs: 0,
    nextCpIndex: -1,
  };

  const loop: Loop = new GameLoop({
    tickHz: 60,
    onTick: (dt) => {
      if (st === null || st.finished) return;
      const f = client.input.frame();
      const mx = hookMove !== null ? hookMove.x : f.moveX;
      const mz = hookMove !== null ? hookMove.z : f.moveZ;
      const jump = (f.buttons & 1) !== 0 || synthJumpDown;
      st.yaw = camYaw; // movement stays camera-relative
      stepSim(st, { mx, mz, jump }, dt);

      // footsteps
      const hs = Math.hypot(st.vel.x, st.vel.z);
      if (st.onGround && hs > 3) {
        stepDist += hs * dt;
        if (stepDist > 2.6) {
          stepDist = 0;
          client.audio.sfx('click', { freq: 820, vol: 0.07 });
        }
      }

      for (const ev of drainEvents(st)) {
        switch (ev.kind) {
          case 'jump':
            client.audio.sfx('jump', { vol: 0.5 });
            renderer.jumpPuff(st.pos.x, st.pos.y, st.pos.z);
            break;
          case 'land':
            client.audio.sfx('land', { vol: 0.45 });
            renderer.landDust(st.pos.x, st.pos.y, st.pos.z);
            break;
          case 'checkpoint':
            client.audio.sfx('pickup', { freq: 740, vol: 0.6 });
            ui.toast(`CHECKPOINT ${ev.i / CHECKPOINT_STRIDE}`);
            break;
          case 'respawn':
            client.audio.sfx('deny');
            ui.toast('+1.00s FALL PENALTY', true);
            camYaw = st.yaw;
            break;
          case 'finish':
            finishRun(st);
            break;
        }
      }
    },
    onRender: (dtFrame) => {
      fpsEma += (1 / Math.max(dtFrame, 1e-4) - fpsEma) * 0.05;
      const f = client.input.frame();
      client.input.edges();

      if (st !== null && !st.finished) {
        // free-look + gentle auto-face down the velocity vector
        const looked = Math.abs(f.lookDX) + Math.abs(f.lookDY) > 1e-4;
        camYaw -= f.lookDX;
        pitch = Math.min(0.55, Math.max(-0.95, pitch - f.lookDY));
        manualLookTimer = looked ? 1.2 : Math.max(0, manualLookTimer - dtFrame);
        const hs = Math.hypot(st.vel.x, st.vel.z);
        if (hs > 2 && manualLookTimer <= 0) {
          const target = Math.atan2(-st.vel.x, -st.vel.z);
          let d = (target - camYaw) % (Math.PI * 2);
          if (d > Math.PI) d -= Math.PI * 2;
          if (d < -Math.PI) d += Math.PI * 2;
          camYaw += d * (1 - Math.exp(-4.5 * dtFrame));
        }
      }
      if (st !== null) ui.updateTimer(finalTimeMs(st));

      view.mode = st === null ? 'menu' : 'run';
      view.px = st?.pos.x ?? track.startPos.x;
      view.py = st?.pos.y ?? track.startPos.y;
      view.pz = st?.pos.z ?? track.startPos.z;
      view.camYaw = camYaw;
      view.pitch = pitch;
      view.airTime = st?.airTime ?? 0;
      view.vx = st?.vel.x ?? 0;
      view.vz = st?.vel.z ?? 0;
      view.timeMs = st !== null ? st.timeMs : performance.now() % 3_600_000;
      if (st === null) {
        view.nextCpIndex = -1;
      } else {
        const ci = st.lastCp / CHECKPOINT_STRIDE;
        view.nextCpIndex =
          ci >= track.checkpoints.length - 1 ? -1 : Math.floor(ci) + 1;
      }
      renderer.sync(view, dtFrame);
      renderer.render();
      hudDebug?.update();
    },
  });
  loop.start();

  // first gesture unlocks WebAudio (SynthKit contract)
  const unlock = (): void => {
    client.audio.resume();
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  // ---- e2e hooks ------------------------------------------------------------------
  window.__ghostrun = {
    state() {
      return {
        screen: ui.screen,
        timeMs: st?.timeMs ?? 0,
        bestTimeMs: best?.timeMs ?? null,
        hasGhost: raceGhost && ghostToday !== null,
        pos: [
          Number((st?.pos.x ?? track.startPos.x).toFixed(2)),
          Number((st?.pos.y ?? track.startPos.y).toFixed(2)),
          Number((st?.pos.z ?? track.startPos.z).toFixed(2)),
        ],
        onGround: st?.onGround ?? true,
      };
    },
    start() {
      if (ui.screen !== 'run') beginRun();
    },
    move(x, z) {
      hookMove = { x, z };
    },
    press(bit, down) {
      if (bit === 0) synthJumpDown = down;
    },
  };

  // ---- go -------------------------------------------------------------------------
  refreshMenu();
  void loadCloudSaves().then((online) => {
    localOnly = !online;
    refreshMenu();
  });
}

main();
