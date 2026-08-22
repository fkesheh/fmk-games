// ============================================================================
// SUMO APP — the client orchestrator (specs/P10.md). Wires @platform/sdk
// (net/rooms/input/audio) to the renderer/HUD/screens and owns ONE 30Hz loop:
//
//   onTick   read merged input -> send {t:'input',seq,mx,mz,bits} at the sim
//            rate; drain snapshot events into audio + banners + killfeed.
//   onRender sample the interp buffer INTERP_MS behind serverNow, update
//            world + HUD, derive bump/dash SFX from interpolated motion.
//
// Server-authoritative, zero prediction: your own capsule is interpolated
// like everyone else's.
// ============================================================================
import { createGameClient } from '@platform/sdk';
import type { GameClient } from '@platform/sdk';
import { Loop } from '@platform/engine';
import { clearSession, saveSession } from '@platform/shared';
import {
  INPUT_SEND_HZ,
  INTERP_MS,
  PLATFORM_R_END,
  PLATFORM_R_START,
  WINS_TO_MATCH,
} from '@sumo/shared';
import type { SumoEvent, SumoJoinedMsg } from '@sumo/shared';
import type { Sampled } from './net.js';
import { SumoNet } from './net.js';
import { SumoRenderer } from './render.js';
import { Hud } from './ui/hud.js';
import { Screens } from './ui/screens.js';

const BUMP_DIST = 1.25; // capsule centers closer than this = contact
const BUMP_CLOSING = 2.5; // u/s of closing speed for an audible thud
const THUD_MIN_GAP_MS = 90;

export interface SumoHooksState {
  screen: string;
  roomId: string | null;
  phase: string;
  players: Array<{ id: string; name: string; alive: boolean; wins: number }>;
  youPos: [number, number] | null;
  cooldowns: { dash: number };
}

/** e2e surface (specs/P10.md): state/joinQuick/createPrivate/debug.* */
export interface SumoHooks {
  state(): SumoHooksState;
  joinQuick(name: string): void;
  createPrivate(name: string): void;
  debug: {
    move(x: number, z: number): void;
    press(bit: number, down: boolean): void;
    addBot(): void;
  };
}

declare global {
  interface Window {
    __sumo?: SumoHooks;
  }
}

interface Pose {
  x: number;
  y: number;
  z: number;
  dashing: boolean;
}

export class SumoApp {
  private readonly net: SumoNet = new SumoNet();
  private readonly hud: Hud;
  private readonly screens: Screens;
  private readonly renderer: SumoRenderer;
  private readonly prevPoses = new Map<string, Pose>();
  private lastSampled: Sampled[] = [];
  private lastThudAt = 0;
  private boardOpen = false;
  private seq = 0;
  private joinedRoomId: string | null = null;
  private busy = false;
  // e2e/debug input injection (window.__sumo.debug.*)
  private moveOverride: { x: number; z: number } | null = null;
  private readonly pressLatch = new Map<number, boolean>();

  constructor(
    private readonly client: GameClient,
    canvas: HTMLCanvasElement,
    root: HTMLElement,
  ) {
    this.renderer = new SumoRenderer(canvas);
    this.hud = new Hud(root);
    this.screens = new Screens(root, {
      onQuickJoin: (name) => this.joinQuick(name),
      onCreatePrivate: (name) => this.createPrivate(name),
      onJoinCode: (name, code) => this.joinPrivate(name, code),
      onLeave: () => this.leave(),
    });

    // DASH on shift/K, JUMP on space — bits mirror the padLayout contract.
    this.client.input.setKeyBindings({
      left: ['KeyA', 'ArrowLeft'],
      right: ['KeyD', 'ArrowRight'],
      forward: ['KeyW', 'ArrowUp'],
      back: ['KeyS', 'ArrowDown'],
      actions: [
        { bit: 0, keys: ['ShiftLeft', 'ShiftRight', 'KeyK'] },
        { bit: 1, keys: ['Space'] },
      ],
    });
    this.client.input.setTouch({
      enabled: true,
      actions: [
        { bit: 0, label: 'DASH' },
        { bit: 1, label: 'JUMP' },
      ],
    });

    this.net.onError = (_code, message) => {
      this.screens.toast(message);
      if (this.busy) {
        this.busy = false;
        this.screens.busy(false);
      }
    };
    this.client.net.onMessage = (msg) => this.net.handle(msg);

    // Tab scoreboard (hold)
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab') {
        e.preventDefault();
        this.boardOpen = true;
        this.showBoard();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') {
        this.boardOpen = false;
        this.hud.hideBoard();
      }
    });
  }

  // ---- lobby verbs -------------------------------------------------------------

  private enterRoom(msg: SumoJoinedMsg): void {
    this.joinedRoomId = msg.roomId;
    saveSession('sumo', { playerId: msg.you, roomId: msg.roomId, code: msg.code });
    const names = new Map<string, string>();
    for (const p of msg.players) names.set(p.id, p.name);
    this.hud.setNames(names);
    this.busy = false;
    this.screens.setScreen('game');
    this.hud.show();
    this.screens.toast(`room ${msg.roomId}${msg.code !== null ? ` · code ${msg.code}` : ''}`);
  }

  private guardJoin(): boolean {
    this.client.audio.resume();
    if (this.busy) return false;
    this.busy = true;
    this.screens.busy(true);
    return true;
  }

  joinQuick(name: string): void {
    if (!this.guardJoin()) return;
    this.client.rooms.quickJoin(name);
  }

  createPrivate(name: string): void {
    if (!this.guardJoin()) return;
    this.client.rooms.createPrivate(name);
  }

  private joinPrivate(name: string, code: string): void {
    if (!this.guardJoin()) return;
    this.client.rooms.joinPrivate(name, code);
  }

  leave(): void {
    this.client.rooms.leave();
    clearSession('sumo');
    this.net.clearRoom();
    this.joinedRoomId = null;
    this.lastSampled = [];
    this.prevPoses.clear();
    this.boardOpen = false;
    this.moveOverride = null;
    this.pressLatch.clear();
    this.hud.hide();
    this.hud.hideBoard();
    this.screens.setScreen('menu');
  }

  private showBoard(): void {
    const meta = this.net.meta;
    if (meta !== null) this.hud.showBoard(meta.wins, this.net.youId);
  }

  // ---- loop ----------------------------------------------------------------------

  start(): void {
    const loop = new Loop({
      tickHz: INPUT_SEND_HZ, // 30Hz — matches the server sim
      onTick: () => this.tick(),
      onRender: (dtFrame) => this.render(dtFrame),
    });
    loop.start();
  }

  private tick(): void {
    if (this.joinedRoomId !== null) {
      const f = this.client.input.frame();
      let mx = f.moveX;
      let mz = f.moveZ;
      if (this.moveOverride !== null) {
        mx = this.moveOverride.x;
        mz = this.moveOverride.z;
      }
      let bits = f.buttons & 0b11;
      for (const [bit, down] of this.pressLatch) {
        if (down) bits |= 1 << bit;
      }
      this.seq += 1;
      this.client.net.send({ t: 'input', seq: this.seq, mx, mz, bits });
    }
    for (const ev of this.net.drainEvents()) this.onEvent(ev);
  }

  private findSampled(id: string | null): Sampled | null {
    if (id === null) return null;
    for (const p of this.lastSampled) {
      if (p.id === id) return p;
    }
    return null;
  }

  /** Distance from a world point to YOU, clamped to the sfx falloff range. */
  private distToYou(x: number, z: number): number | null {
    const you = this.findSampled(this.net.youId);
    if (you === null || !you.alive) return null;
    return Math.min(45, Math.hypot(you.x - x, you.z - z));
  }

  private render(dtFrame: number): void {
    const meta = this.net.meta;
    const nowSrv = this.client.net.serverNow();
    const sampled = this.net.buffer.sample(nowSrv - INTERP_MS);
    this.lastSampled = sampled;

    this.detectMotionFx(sampled, dtFrame);

    let you: Sampled | null = null;
    if (this.net.youId !== null) {
      for (const p of sampled) {
        if (p.id === this.net.youId && p.alive) {
          you = p;
          break;
        }
      }
    }
    this.renderer.update(
      {
        sampled,
        radius: meta?.radius ?? PLATFORM_R_START,
        phaseLive: meta?.phase === 'live',
        dtFrame,
      },
      you,
    );

    if (meta !== null && this.joinedRoomId !== null) {
      let alive = 0;
      for (const p of sampled) if (p.alive) alive++;
      const frac =
        (Math.max(PLATFORM_R_END, Math.min(PLATFORM_R_START, meta.radius)) - PLATFORM_R_END) /
        (PLATFORM_R_START - PLATFORM_R_END);
      this.hud.update({
        phase: meta.phase,
        msLeft: Math.max(0, meta.phaseEndsAt - nowSrv),
        alive,
        round: meta.round,
        radiusFrac: frac,
        dashCdSec: this.net.youState?.cooldowns.dash ?? 0,
      });
    }
  }

  /**
   * The wire carries no bump events — thuds/whooshes are derived locally from
   * interpolated motion (cheap, and matches what the player actually sees).
   * Previous poses are READ before they are rewritten.
   */
  private detectMotionFx(sampled: Sampled[], dtFrame: number): void {
    const now = performance.now();
    const dt = Math.max(1e-3, dtFrame);

    // dash whoosh on rising dashing edge
    for (const p of sampled) {
      const prev = this.prevPoses.get(p.id);
      if (prev !== undefined && p.dashing && !prev.dashing) {
        const d = p.id === this.net.youId ? null : this.distToYou(p.x, p.z);
        this.client.audio.sfx('jump', { freq: 460, vol: 0.42, dist: d });
      }
    }
    // bump thud when an alive pair closes into contact range fast enough
    if (now - this.lastThudAt >= THUD_MIN_GAP_MS) {
      pairLoop: for (let i = 0; i < sampled.length; i++) {
        const a = sampled[i];
        if (a === undefined || !a.alive) continue;
        for (let j = i + 1; j < sampled.length; j++) {
          const b = sampled[j];
          if (b === undefined || !b.alive) continue;
          const pa = this.prevPoses.get(a.id);
          const pb = this.prevPoses.get(b.id);
          if (pa === undefined || pb === undefined) continue;
          const d = Math.hypot(a.x - b.x, a.z - b.z);
          if (d >= BUMP_DIST) continue;
          const dPrev = Math.hypot(pa.x - pb.x, pa.z - pb.z);
          if ((dPrev - d) / dt < BUMP_CLOSING) continue;
          const midX = (a.x + b.x) / 2;
          const midZ = (a.z + b.z) / 2;
          this.client.audio.sfx('land', { freq: 140, vol: 0.7, dist: this.distToYou(midX, midZ) });
          this.renderer.thud(midX, a.y, midZ);
          this.lastThudAt = now;
          break pairLoop;
        }
      }
    }
    // write poses LAST
    for (const p of sampled) {
      this.prevPoses.set(p.id, { x: p.x, y: p.y, z: p.z, dashing: p.dashing });
    }
  }

  private onEvent(ev: SumoEvent): void {
    const audio = this.client.audio;
    const youId = this.net.youId;
    switch (ev.kind) {
      case 'countdown':
        audio.sfx('click');
        this.hud.showBanner(String(ev.n), 'get ready…', '', 900);
        break;
      case 'go':
        audio.sfx('pickup', { vol: 0.8 });
        this.hud.showBanner('GO!', null, '', 700);
        break;
      case 'ko': {
        const pos = this.prevPoses.get(ev.victim) ?? this.findSampled(ev.victim);
        if (pos !== undefined && pos !== null) {
          const joined = this.net.joined;
          let colorIdx = 0;
          if (joined !== null) {
            for (const pl of joined.players) {
              if (pl.id === ev.victim) {
                colorIdx = pl.color;
                break;
              }
            }
          }
          this.renderer.splash(pos.x, pos.y, pos.z, colorIdx);
          audio.sfx('explode', {
            freq: 900,
            vol: 0.8,
            dist: ev.victim === youId ? null : this.distToYou(pos.x, pos.z),
          });
        }
        this.hud.feedEvent(ev, youId);
        if (ev.victim === youId) {
          audio.sfx('lose', { vol: 0.5 });
          this.hud.showBanner('OUT!', 'you fell into space', 'lose', 1600);
        } else if (ev.by === youId) {
          audio.sfx('score', { freq: 660, vol: 0.5 });
        }
        break;
      }
      case 'round_end':
        this.hud.feedEvent(ev, youId);
        if (ev.draw || ev.winner === null) {
          this.hud.showBanner('DRAW', 'nobody survived', '', 2200);
          audio.sfx('deny', { vol: 0.6 });
        } else if (ev.winner === youId) {
          this.hud.showBanner('ROUND WIN', `first to ${WINS_TO_MATCH} takes the match`, 'win', 2400);
          audio.sfx('win', { vol: 0.9 });
        } else {
          this.hud.showBanner('ROUND LOST', `${this.hud.nameOf(ev.winner)} survived`, 'lose', 2200);
          audio.sfx('lose', { vol: 0.55 });
        }
        break;
      case 'match_end': {
        const mine = ev.champion === youId;
        this.hud.feedEvent(ev, youId);
        this.hud.showBanner(
          mine ? 'MATCH WINNER!' : `${this.hud.nameOf(ev.champion)} WINS`,
          'scores reset — next match starting',
          mine ? 'win' : 'lose',
          3200,
        );
        audio.sfx('win', { vol: 1 });
        break;
      }
    }
    if (this.boardOpen) this.showBoard();
  }

  dispose(): void {
    this.renderer.dispose();
    this.client.dispose();
  }

  // ---- lifecycle plumbing for main.ts -------------------------------------------

  resize(): void {
    this.renderer.resize();
  }

  unlockAudio(): void {
    this.client.audio.resume();
  }

  ambientSpace(): void {
    this.client.audio.ambient('wind');
  }

  // ---- e2e hook plumbing -------------------------------------------------------

  hookState(): SumoHooksState {
    const meta = this.net.meta;
    const winsById = new Map<string, number>();
    if (meta !== null) {
      for (const w of meta.wins) winsById.set(w.id, w.wins);
    }
    const players: SumoHooksState['players'] = [];
    for (const p of this.lastSampled) {
      players.push({ id: p.id, name: p.name, alive: p.alive, wins: winsById.get(p.id) ?? 0 });
    }
    const you = this.findSampled(this.net.youId);
    return {
      screen: this.screens.screen,
      roomId: this.joinedRoomId,
      phase: meta?.phase ?? 'warmup',
      players,
      youPos: you !== null ? [you.x, you.z] : null,
      cooldowns: { dash: this.net.youState?.cooldowns.dash ?? 0 },
    };
  }

  hookMove(x: number, z: number): void {
    this.moveOverride =
      Number.isFinite(x) && Number.isFinite(z)
        ? { x: Math.max(-1, Math.min(1, x)), z: Math.max(-1, Math.min(1, z)) }
        : null;
  }

  hookPress(bit: number, down: boolean): void {
    if (bit < 0 || bit > 31) return;
    if (down) this.pressLatch.set(bit, true);
    else this.pressLatch.delete(bit);
  }

  hookAddBot(): void {
    if (this.joinedRoomId !== null) this.client.net.send({ t: 'debug_bot' });
  }
}

/** Mount everything for main.ts; returns the e2e hook surface. */
export function bootApp(canvas: HTMLCanvasElement, root: HTMLElement): { app: SumoApp; hooks: SumoHooks } {
  const client = createGameClient({ gameId: 'sumo', canvas });
  client.input.start();
  const app = new SumoApp(client, canvas, root);
  const hooks: SumoHooks = {
    state: () => app.hookState(),
    joinQuick: (name) => app.joinQuick(name),
    createPrivate: (name) => app.createPrivate(name),
    debug: {
      move: (x, z) => app.hookMove(x, z),
      press: (bit, down) => app.hookPress(bit, down),
      addBot: () => app.hookAddBot(),
    },
  };
  return { app, hooks };
}
