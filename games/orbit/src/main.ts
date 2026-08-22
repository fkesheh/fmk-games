// ============================================================================
// ORBIT MAIN — composition root (specs/P9.md). Wires the @platform/sdk facade
// + engine Loop to the pure sim, owns the save lifecycle, and exposes the
// window.__orbit e2e hooks.
//
// SAVE LIFECYCLE (cloud via SDK updateSave merge + localStorage mirrors):
//   slot 'best'   {score, dist, date} — keep-max on run end.
//   slot 'resume' {seed, dist, score} — every 5s while a run is alive with
//                   score > 0; deleted when a run ends. Boot offers CONTINUE
//                   only when score > 0. Unreachable cloud ⇒ offline banner;
//                   locals are always written first so play never blocks.
//
// WHOOSH LOOP: SynthKit exposes fixed ambient beds only, so speed is voiced
// as the wind bed plus periodic noise ticks whose rate/frequency scale with
// current speed (deviation documented in the module report).
// ============================================================================

import { createGameClient, updateSave } from '@platform/sdk';
import type { GameClient } from '@platform/sdk';
import { Loop as GameLoop, createDebugHud } from '@platform/engine';
import type { DebugHud, Loop } from '@platform/engine';
import { rng } from '@platform/shared';
import {
  SIM,
  createRun,
  currentSpeed,
  drainEvents,
  scoreOf,
  speedAt,
  step as stepSim,
  tryBoost,
} from './run.js';
import type { ResumeData, RunState } from './run.js';
import { GameRenderer } from './render.js';
import { Ui } from './ui.js';

// ---- save schemas -------------------------------------------------------------

interface BestSave {
  readonly score: number;
  readonly dist: number;
  readonly date: string;
}

const BEST_KEY = 'orbit.best';
const RESUME_KEY = 'orbit.resume';

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function parseBest(v: unknown): BestSave | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isNum(o.score) || o.score < 0 || !isNum(o.dist) || typeof o.date !== 'string') return null;
  return { score: o.score, dist: o.dist, date: o.date };
}

export function parseResume(v: unknown): ResumeData & { readonly seed: number } | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isNum(o.seed) || !isNum(o.dist) || !isNum(o.score)) return null;
  if (o.dist <= 0 || o.dist > 1e7 || o.score <= 0) return null;
  return { seed: o.seed >>> 0, dist: o.dist, score: o.score };
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

function removeLocalJson(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // ignore
  }
}

/** Fresh-run seed: house rule routes "random" through rng(Date.now()), never Math.random. */
function freshSeed(): number {
  return Math.floor(rng(Date.now() >>> 0)() * 0x100000000) >>> 0;
}

// ---- e2e hook surface ------------------------------------------------------------

export interface OrbitHooks {
  state(): {
    screen: string;
    score: number;
    best: number | null;
    dist: number;
    speed: number;
    combo: number;
    shields: number;
    alive: boolean;
  };
  start(): void;
  steer(x: number, y: number): void;
  press(bit: number, down: boolean): void;
}

declare global {
  interface Window {
    __orbit?: OrbitHooks;
  }
}

// ---- app -------------------------------------------------------------------------

function main(): void {
  const DEBUG = new URLSearchParams(window.location.search).has('debug');

  document.getElementById('boot')?.classList.add('gone');

  const canvas = document.getElementById('cv') as HTMLCanvasElement | null;
  if (canvas === null) throw new Error('ORBIT: #cv canvas missing');
  const client: GameClient = createGameClient({ gameId: 'orbit', canvas });
  client.input.setTouch({ enabled: true, actions: [{ bit: 0, label: 'BOOST' }] });
  client.input.start();

  const renderer = new GameRenderer(canvas);
  window.addEventListener('resize', () => renderer.resize());

  // ---- persistent state (local mirrors first — instant menu) -------------------
  let best = parseBest(readLocalJson(BEST_KEY));
  let resume = parseResume(readLocalJson(RESUME_KEY));
  let localOnly = false;

  // ---- run state ----------------------------------------------------------------
  let st: RunState | null = null;
  let preBest: number | null = null;
  let topCombo = 0;
  let resumeAcc = 0;
  let whooshT = 0;
  let lastSpeed = speedAt(0);
  let steerHook: { x: number; y: number } | null = null;
  let hookBoostQueued = false;

  function refreshMenu(): void {
    ui.showMenu({
      best: best?.score ?? null,
      canResume: resume !== null && resume.score > 0,
      localOnly,
    });
  }

  const ui = new Ui({
    onStart: () => beginRun(false),
    onContinue: () => beginRun(true),
    onRetry: () => beginRun(false),
    onMenu: () => {
      st = null;
      renderer.sync(null, 0, { ax: 0, ay: 0 });
      refreshMenu();
    },
  });

  function beginRun(useResume: boolean): void {
    const r = useResume && resume !== null ? { dist: resume.dist, score: resume.score } : undefined;
    const seed = useResume && resume !== null ? resume.seed : freshSeed();
    st = createRun(seed, r);
    preBest = best?.score ?? null;
    topCombo = 0;
    resumeAcc = 0;
    whooshT = 0;
    steerHook = null;
    hookBoostQueued = false;
    client.audio.resume();
    client.audio.ambient('wind');
    client.audio.sfx('click');
    ui.showHud();
  }

  function toMenu(): void {
    client.audio.ambient('off');
    st = null;
    renderer.sync(null, 0, { ax: 0, ay: 0 });
    refreshMenu();
  }

  // ---- saves ----------------------------------------------------------------------

  /** Snapshot the live run into slot 'resume' (local mirror first). */
  function saveResume(): void {
    if (st === null || !st.alive || st.finished) return;
    const data = {
      seed: st.seed,
      dist: Math.round(st.dist * 100) / 100,
      score: scoreOf(st),
    };
    if (data.score <= 0) return;
    resume = data;
    writeLocalJson(RESUME_KEY, data);
    void updateSave<unknown>(client.saves, 'resume', () => data).catch(() => {
      localOnly = true;
    });
  }

  async function loadCloudSaves(): Promise<boolean> {
    const [bestRes, resumeRes] = await Promise.allSettled([
      client.saves.get<unknown>('best'),
      client.saves.get<unknown>('resume'),
    ]);
    if (bestRes.status === 'rejected' && resumeRes.status === 'rejected') return false;
    if (bestRes.status === 'fulfilled') {
      const parsed = parseBest(bestRes.value.data);
      if (parsed !== null && (best === null || parsed.score > best.score)) best = parsed;
    }
    if (resumeRes.status === 'fulfilled') {
      const parsed = parseResume(resumeRes.value.data);
      // prefer whichever snapshot is further into its run
      if (parsed !== null && (resume === null || parsed.score > resume.score)) resume = parsed;
    }
    return true;
  }

  /** Keep-max write of the final score into slot 'best'. */
  function persistBest(final: number, dist: number): void {
    const record: BestSave = { score: final, dist, date: new Date().toISOString().slice(0, 10) };
    best = record;
    writeLocalJson(BEST_KEY, record);
    void updateSave<unknown>(client.saves, 'best', (cur) => {
      const c = parseBest(cur);
      return c !== null && c.score >= final ? cur : record;
    }).catch(() => {
      localOnly = true;
    });
  }

  /** A finished run invalidates its resume point. */
  function clearResume(): void {
    resume = null;
    removeLocalJson(RESUME_KEY);
    void client.saves.del('resume').catch(() => {
      /* offline — nothing to clear remotely */
    });
  }

  // ---- run end ----------------------------------------------------------------------

  function endRun(finishedSt: RunState): void {
    client.audio.ambient('off');
    const final = scoreOf(finishedSt);
    const isPb = preBest === null || final > preBest;
    persistBest(final, finishedSt.dist);
    clearResume();
    window.setTimeout(() => {
      ui.showGameOver({
        score: final,
        dist: finishedSt.dist,
        nearMisses: finishedSt.nearMisses,
        topCombo,
        prevBest: preBest,
        isPb,
      });
    }, 900);
  }

  // ---- loop ----------------------------------------------------------------------

  let fpsEma = 60;
  let hudDebug: DebugHud | null = null;
  if (DEBUG) {
    hudDebug = createDebugHud(() => [
      `${fpsEma.toFixed(0)} fps · loop ${loop.tickCount}`,
      `screen=${ui.screen}`,
      st === null
        ? 'no run'
        : `score=${scoreOf(st)} dist=${st.dist.toFixed(0)} spd=${currentSpeed(st).toFixed(1)}`,
      st === null ? '' : `combo=${st.combo} near=${st.nearMisses} sh=${st.shields}`,
      st === null ? '' : `boost=${st.boostT.toFixed(2)}/${st.boostCd.toFixed(2)} obs=${st.obstacles.length}`,
      `seed=#${(st?.seed ?? 0).toString(16)}`,
    ]);
  }

  const loop: Loop = new GameLoop({
    tickHz: 30, // spec: 30Hz logic is fine
    onTick: (dt) => {
      const f = client.input.frame();
      for (const e of client.input.edges()) {
        if (e.kind === 'press' && e.bit === 0 && st !== null) tryBoost(st);
      }
      if (st === null || st.finished) return;

      const ax = steerHook !== null ? steerHook.x : f.moveX;
      const ay = steerHook !== null ? steerHook.y : f.moveZ;
      if (hookBoostQueued) {
        hookBoostQueued = false;
        tryBoost(st);
      }
      stepSim(st, { ax, ay }, dt);
      lastSpeed = currentSpeed(st);
      topCombo = Math.max(topCombo, st.combo);

      // whoosh loop: tick rate + pitch ride the current speed
      whooshT -= dt;
      if (whooshT <= 0 && st.alive) {
        const frac = Math.min(1, (lastSpeed - SIM.speedStart) / (SIM.speedEnd - SIM.speedStart));
        whooshT = 0.55 - frac * 0.3;
        client.audio.sfx('hit', { freq: 240 + frac * 900, vol: 0.05 + frac * 0.06, durSec: 0.22 });
      }

      for (const ev of drainEvents(st)) {
        switch (ev.kind) {
          case 'near':
            client.audio.sfx('score', { freq: 440 * Math.pow(1.0595, Math.min(12, ev.combo)), vol: 0.35 });
            renderer.nearPing(st.x, st.y, st.z - 1);
            break;
          case 'pickup':
            client.audio.sfx('pickup', { vol: 0.8 });
            renderer.pickupFx(st.x, st.y, st.z - 1);
            ui.toast('SHIELD UP');
            break;
          case 'shieldhit':
            client.audio.sfx('deny');
            renderer.shieldBurst(st.x, st.y, st.z - 1);
            ui.toast('SHIELD LOST', true);
            break;
          case 'explode':
            client.audio.sfx('explode');
            renderer.explosion(st.x, st.y, st.z);
            endRun(st);
            break;
          case 'boost':
            client.audio.sfx('jump', { vol: 0.6 });
            break;
        }
      }

      // autosave resume point every 5s
      resumeAcc += dt;
      if (resumeAcc >= 5) {
        resumeAcc = 0;
        saveResume();
      }
    },
    onRender: (dtFrame) => {
      fpsEma += (1 / Math.max(dtFrame, 1e-4) - fpsEma) * 0.05;

      if (st !== null && st.alive && !st.finished) {
        const boosting = st.boostT > 0;
        const cdSpan = SIM.boostDurSec + SIM.boostCooldownSec;
        ui.updateHud({
          score: scoreOf(st),
          combo: st.combo,
          speed: lastSpeed,
          shields: st.shields,
          boostFrac: boosting ? 1 : 1 - Math.min(1, st.boostCd / cdSpan),
        });
      }

      const ax = steerHook !== null ? steerHook.x : 0;
      const ay = steerHook !== null ? steerHook.y : 0;
      renderer.sync(st, dtFrame, { ax, ay });
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

  // ---- e2e hooks --------------------------------------------------------------------
  window.__orbit = {
    state() {
      return {
        screen: ui.screen,
        score: st !== null ? scoreOf(st) : 0,
        best: best?.score ?? null,
        dist: st?.dist ?? 0,
        speed: st !== null && st.alive ? lastSpeed : 0,
        combo: st?.combo ?? 0,
        shields: st?.shields ?? 0,
        alive: st?.alive ?? false,
      };
    },
    start() {
      beginRun(false);
    },
    steer(x, y) {
      steerHook = { x, y };
    },
    press(bit, down) {
      if (bit === 0 && down) hookBoostQueued = true;
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
