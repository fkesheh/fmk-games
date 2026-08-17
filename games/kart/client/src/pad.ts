// ============================================================================
// KART GP — PHONE PAD PAGE (/kart/pad/). A standalone touch controller: it
// joins a kart room as a PAD session (docs/PAD.md) and streams the bound
// player's kart_input at SIM_HZ. There is deliberately no game rendering
// here — the phone is an input device; the desktop renders the race.
//
// FLOW (contract: docs/PAD.md lifecycle)
//   1. `room` + `token` arrive on the query string (the pairing QR target,
//      KART_PAD_PAGE_PATH). Missing → a "scan the QR" page; there is nothing
//      else this page can legitimately do.
//   2. Open /ws; on {t:'welcome'} answer {t:'join_as_pad', room, token}.
//   3. {t:'error'} → the PAD.md error taxonomy (no_room / pad_unsupported /
//      pad_rejected), each with its message + action hint, all terminal.
//      {t:'pad_joined'} → the controller UI. {t:'pad_left'} → the taken-over
//      / player-left screen. Everything else parses to null and is dropped.
//   4. Socket close mid-session → "Reconnecting…" and the join flow re-runs
//      from scratch. The token is single-use, so a reconnect after a clean
//      bind will surface pad_rejected — that is the CORRECT outcome (PAD.md).
//
// INPUT: multi-touch bookkeeping reuses the tablet pad's TouchPointers
// (drive.ts — DOM-free, unit-tested); this file owns the DOM: the targets,
// the rect-cached hit test, and the listeners. Steering is two thumb zones
// (TOUCH_PWA.md §4.2.1 — a stick is imprecise under a thumb), with an
// optional tilt mode. No brake/reverse by design — stuck auto-respawn on
// the desktop compensates; a manual respawn chip is still provided.
// ============================================================================
import { SIM_DT, SIM_HZ, parseKartPadToPadS2C } from '@kart/shared';
import type { KartC2S, KartInputMsg } from '@kart/shared';
import type { LobbyC2S } from '@platform/shared';
import { TouchPointers } from './drive.js';
import type { TouchControl } from './drive.js';

// ---- reconnect backoff --------------------------------------------------------
/** First delay after a mid-session socket drop… */
const RECONNECT_MIN_MS = 1500;
/** …doubling each failed attempt up to this ceiling; reset on a successful join. */
const RECONNECT_MAX_MS = 15_000;

// ---- tilt steering tuning ---------------------------------------------------
/** Exponential smoothing: filtered = 0.8·filtered + 0.2·raw (per sensor event). */
const TILT_SMOOTH = 0.2;
/** Degrees around the calibrated neutral that still read as straight. */
const TILT_DEAD_DEG = 3;
/** Degrees of tilt from neutral that produce full lock. */
const TILT_FULL_DEG = 30;
/** How long to wait for the first usable sensor event before falling back. */
const TILT_ARM_MS = 1500;

// ---- structural types for optional browser APIs (no `any`) ------------------

/** iOS 13+ hangs a permission prompt off the event constructor. */
interface DeviceOrientationPermissionCtor {
  requestPermission?: () => Promise<string>;
}

/** Wake Lock (TOUCH_PWA.md §3): degrade silently where unsupported. */
interface WakeLockSentinelLike {
  release: () => Promise<void>;
}
interface WakeLockLike {
  request: (type: 'screen') => Promise<WakeLockSentinelLike>;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

/**
 * The screen's rotation away from the device's natural orientation, in the
 * Screen Orientation API's convention (degrees clockwise; 90 = device top
 * pointing to the user's right). Legacy iOS `window.orientation` runs the
 * other way (+90 = top edge to the LEFT), so it is normalised, not trusted.
 */
function screenAngle(): number {
  const so: ScreenOrientation | undefined = screen.orientation;
  if (so !== undefined && typeof so.angle === 'number') {
    return ((so.angle % 360) + 360) % 360;
  }
  const legacy = (window as Window & { orientation?: unknown }).orientation;
  const deg = typeof legacy === 'number' ? legacy : 0;
  return (((360 - deg) % 360) + 360) % 360;
}

/**
 * Steering-wheel tilt as a signed degree value (positive = steer RIGHT) in
 * whatever axis the current orientation puts that motion on. Portrait roll
 * is gamma; rotate the device and the same physical motion lands on beta
 * with an orientation-dependent sign. null = sensor absent or not reporting
 * (desktop, insecure context) — the caller must not treat that as 0.
 */
function readTiltAxis(e: DeviceOrientationEvent): number | null {
  switch (screenAngle()) {
    case 90:
      return e.beta === null ? null : -e.beta;
    case 180:
      return e.gamma === null ? null : -e.gamma;
    case 270:
      return e.beta === null ? null : e.beta;
    default:
      return e.gamma;
  }
}

type TiltEnableResult = 'ok' | 'denied' | 'unavailable';

/**
 * Tilt steering: calibrated to how the phone is held at enable time,
 * low-pass filtered (0.8/0.2 exponential), dead-zoned around neutral, and
 * clamped to -1..1. Never throws — every failure path (no API, iOS
 * permission denied, sensor never reports) resolves to a fallback result.
 */
class TiltSteer {
  active = false;
  /** Current filtered steering, -1..1. Sampled by the input tick. */
  steer = 0;
  private neutral = 0;
  private filtered = 0;
  private sawEvent = false;
  private armResolve: ((got: boolean) => void) | null = null;

  private readonly onOrientation = (e: DeviceOrientationEvent): void => {
    const raw = readTiltAxis(e);
    if (raw === null) return; // sensor present but not reporting a usable axis
    if (!this.sawEvent) {
      // calibration: the orientation at enable time IS straight ahead
      this.sawEvent = true;
      this.neutral = raw;
      this.filtered = raw;
      const resolve = this.armResolve;
      this.armResolve = null;
      resolve?.(true);
    }
    this.filtered += (raw - this.filtered) * TILT_SMOOTH;
    const rel = this.filtered - this.neutral;
    const beyond = Math.max(0, Math.abs(rel) - TILT_DEAD_DEG);
    const v = (beyond / (TILT_FULL_DEG - TILT_DEAD_DEG)) * Math.sign(rel);
    this.steer = Math.max(-1, Math.min(1, v));
  };

  /**
   * Enable tilt. MUST be called from a user gesture — iOS only honours
   * requestPermission() inside one.
   */
  async enable(): Promise<TiltEnableResult> {
    if (!('DeviceOrientationEvent' in window)) return 'unavailable';
    const ctor = window.DeviceOrientationEvent as unknown as DeviceOrientationPermissionCtor;
    if (typeof ctor.requestPermission === 'function') {
      try {
        if ((await ctor.requestPermission()) !== 'granted') return 'denied';
      } catch {
        return 'denied';
      }
    }
    this.sawEvent = false;
    this.steer = 0;
    window.addEventListener('deviceorientation', this.onOrientation);
    // Sensors need a secure context AND real hardware; neither is detectable
    // up front, so the proof is an actual event arriving. If none does, the
    // thumb zones stay in charge.
    const got = await new Promise<boolean>((resolve) => {
      // a re-entered enable() must never strand the previous waiter
      const previous = this.armResolve;
      previous?.(false);
      this.armResolve = resolve;
      window.setTimeout(() => {
        const pending = this.armResolve;
        this.armResolve = null;
        pending?.(this.sawEvent);
      }, TILT_ARM_MS);
    });
    if (!got) {
      window.removeEventListener('deviceorientation', this.onOrientation);
      return 'unavailable';
    }
    this.active = true;
    return 'ok';
  }

  disable(): void {
    this.active = false;
    this.steer = 0;
    const resolve = this.armResolve;
    this.armResolve = null;
    resolve?.(false);
    window.removeEventListener('deviceorientation', this.onOrientation);
  }
}

class PadApp {
  private ws: WebSocket | null = null;
  private joined = false;
  /** Terminal screens (error taxonomy, pad_left): never auto-reconnect. */
  private terminal = false;
  private seq = 0; // the pad's OWN input stream — starts at 0 per bind
  private respawnNext = false; // one-tick latch set by the respawn chip
  private reconnectTimer: number | null = null;
  /** Backoff for the next reconnect attempt; reset to MIN on a successful join. */
  private reconnectDelay = RECONNECT_MIN_MS;
  private wakeLock: WakeLockSentinelLike | null = null;
  /** A tilt enable() is in its arm window — further TILT taps are ignored. */
  private tiltArming = false;

  private readonly room: string;
  private readonly token: string;

  // ---- DOM ----
  private readonly statusEl: HTMLDivElement;
  private readonly statusTitle: HTMLDivElement;
  private readonly statusHint: HTMLDivElement;
  private readonly padEl: HTMLDivElement;
  private readonly padName: HTMLElement;
  private readonly padNote: HTMLDivElement;
  private readonly tiltBtn: HTMLButtonElement;
  private readonly respawnBtn: HTMLButtonElement;
  private readonly steerDot: HTMLDivElement;

  private readonly touch = new TouchPointers();
  private readonly tilt = new TiltSteer();
  /** Pad targets in hit-test order + a flat rect cache (x0,y0,x1,y1). */
  private readonly touchTargets: { el: HTMLElement; control: TouchControl }[] = [];
  private readonly touchRects: number[] = [];
  private touchRectsDirty = true;

  constructor(root: HTMLElement) {
    const params = new URLSearchParams(location.search);
    this.room = params.get('room')?.trim() ?? '';
    this.token = params.get('token')?.trim() ?? '';

    // ---- status screen ----
    this.statusEl = el('div', 'status');
    this.statusTitle = el('div', 'status-title');
    this.statusHint = el('div', 'status-hint');
    this.statusEl.append(this.statusTitle, this.statusHint);

    // ---- controller screen ----
    this.padEl = el('div', 'pad');
    this.padEl.style.display = 'none';
    const top = el('div', 'pad-top');
    const nameWrap = el('div', 'pad-name', 'Controlling ');
    this.padName = el('b', '');
    nameWrap.appendChild(this.padName);
    this.tiltBtn = el('button', 'pad-chip', 'TILT');
    this.tiltBtn.type = 'button';
    this.respawnBtn = el('button', 'pad-chip pad-chip--respawn', 'RESPAWN');
    this.respawnBtn.type = 'button';
    top.append(nameWrap, this.tiltBtn, this.respawnBtn);
    this.padNote = el('div', 'pad-note');

    const body = el('div', 'pad-body');
    const steer = el('div', 'steer');
    steer.append(this.target('zone', 'left', '◀'), this.target('zone', 'right', '▶'));
    const actions = el('div', 'actions');
    actions.append(
      this.target('btn btn--nitro', 'nitro', 'NITRO'),
      this.target('btn btn--drift', 'drift', 'DRIFT'),
      this.target('btn btn--gas', 'gas', 'GAS'),
    );
    body.append(steer, actions);

    const meter = el('div', 'steer-meter');
    this.steerDot = el('div', 'steer-dot');
    meter.appendChild(this.steerDot);

    const rotate = el('div', 'rotate-hint', 'Rotate your phone');
    rotate.appendChild(el('span', '', 'This controller is played in landscape.'));

    this.padEl.append(top, this.padNote, body, meter);
    root.append(this.statusEl, this.padEl, rotate);

    this.bindPointerHandlers();

    // The input stream runs off a timer, not rAF: a backgrounded phone tab
    // throttles rAF to zero, which would silently stop the kart.
    window.setInterval(() => this.tick(), 1000 / SIM_HZ);

    window.addEventListener('resize', () => {
      this.touchRectsDirty = true;
    });
    window.addEventListener('orientationchange', () => {
      this.touchRectsDirty = true;
    });
    // A blurred/hidden page must release every latched control — there is no
    // pointer left alive to do it (TOUCH_PWA.md §4.3 stuck-steering rule).
    const releaseAll = (): void => {
      this.touch.clear();
      this.paintTouch();
    };
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        releaseAll();
      } else if (this.joined) {
        // the OS drops the wake lock when the page hides; re-take it
        void this.acquireWakeLock();
      }
    });

    if (this.room === '' || this.token === '') {
      this.terminal = true;
      this.showStatus(
        'No pairing code',
        'Scan the QR code on the game screen to use this phone as a controller.',
        false,
      );
      return;
    }
    this.showStatus('Connecting…', 'Pairing this phone with the game.', true);
    this.connect();
  }

  // ---- controller DOM --------------------------------------------------------

  private target(className: string, control: TouchControl, label: string): HTMLDivElement {
    const node = el('div', className, label);
    this.touchTargets.push({ el: node, control });
    return node;
  }

  /**
   * Pointer Events, keyed by pointerId, on ONE container with a cached-rect
   * hit test — never per-button handlers. Per-button handlers with pointer
   * capture report every later move to the first-pressed element, which is
   * exactly how "thumb slid from gas onto drift" turns into stuck throttle
   * (TOUCH_PWA.md §4.3). Mouse and stylus ride the same path.
   */
  private bindPointerHandlers(): void {
    const pad = this.padEl;
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
    pad.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault(); // no scroll, no synthetic click, no text selection
      const control = this.hitTest(e.clientX, e.clientY);
      // Dead space is tracked too (press(null)): a thumb that lands between
      // targets and slides onto one must engage it.
      const engaged = this.touch.press(e.pointerId, control);
      if (engaged && control === 'nitro') this.send({ t: 'nitro' });
      this.paintTouch();
    });
    pad.addEventListener('pointermove', (e: PointerEvent) => {
      if (this.touch.count() === 0) return; // a hovering mouse must not steer
      const control = this.hitTest(e.clientX, e.clientY);
      const engaged = this.touch.retarget(e.pointerId, control);
      if (engaged && control === 'nitro') this.send({ t: 'nitro' });
      this.paintTouch(); // a slide can RELEASE a control without engaging one
    });
    const release = (e: PointerEvent): void => {
      this.touch.release(e.pointerId);
      this.paintTouch();
    };
    pad.addEventListener('pointerup', release);
    pad.addEventListener('pointercancel', release); // system-cancelled press frees the control
    pad.addEventListener('lostpointercapture', release);

    // Header chips are not steering surfaces: keep their presses out of the
    // multi-touch bookkeeping and handle them directly.
    this.tiltBtn.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      void this.toggleTilt();
    });
    this.respawnBtn.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.joined) return;
      this.respawnNext = true; // respawn:true for exactly one tick
      this.respawnBtn.classList.add('is-on');
      window.setTimeout(() => this.respawnBtn.classList.remove('is-on'), 200);
    });
  }

  /** Re-measure the pad targets. Layout read only — never inside pointermove. */
  private measurePad(): void {
    const r = this.touchRects;
    r.length = 0;
    for (const t of this.touchTargets) {
      const box = t.el.getBoundingClientRect();
      // a hidden pad measures 0x0 — kept anyway so the indices stay aligned,
      // and a zero-area rect can never be hit
      r.push(box.left, box.top, box.right, box.bottom);
    }
    this.touchRectsDirty = false;
  }

  private hitTest(x: number, y: number): TouchControl | null {
    if (this.touchRectsDirty) this.measurePad();
    const r = this.touchRects;
    for (let i = 0; i < this.touchTargets.length; i++) {
      const x0 = r[i * 4] ?? 0;
      const y0 = r[i * 4 + 1] ?? 0;
      const x1 = r[i * 4 + 2] ?? 0;
      const y1 = r[i * 4 + 3] ?? 0;
      if (x1 <= x0 || y1 <= y0) continue;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) return this.touchTargets[i]?.control ?? null;
    }
    return null; // dead space
  }

  /** Mirror the held set onto the targets. Event-driven, not per frame. */
  private paintTouch(): void {
    for (const t of this.touchTargets) {
      t.el.classList.toggle('is-down', this.touch.isDown(t.control));
    }
  }

  // ---- tilt -------------------------------------------------------------------

  private async toggleTilt(): Promise<void> {
    if (this.tilt.active) {
      this.tilt.disable();
      this.setTiltUi(false, 'Tilt off — thumb zones are steering.');
      return;
    }
    // Re-entry guard: enable() waits out an arm window (up to TILT_ARM_MS);
    // a second tap in that window must not start a competing enable.
    if (this.tiltArming) return;
    this.tiltArming = true;
    this.padNote.textContent = 'Enabling tilt…';
    try {
      const result = await this.tilt.enable();
      if (result === 'ok') {
        this.setTiltUi(true, 'Tilt steering on — how you held the phone at enable is straight.');
      } else if (result === 'denied') {
        this.setTiltUi(false, 'Tilt permission denied — thumb zones are steering.');
      } else {
        this.setTiltUi(false, 'No tilt sensor on this device — thumb zones are steering.');
      }
    } finally {
      this.tiltArming = false;
    }
  }

  private setTiltUi(on: boolean, note: string): void {
    this.tiltBtn.classList.toggle('is-on', on);
    this.padEl.classList.toggle('pad--tilt', on);
    this.padNote.textContent = note;
  }

  // ---- screens ------------------------------------------------------------------

  private showStatus(title: string, hint: string, busy: boolean): void {
    this.padEl.style.display = 'none';
    this.statusEl.style.display = '';
    this.statusEl.classList.toggle('status--busy', busy);
    this.statusTitle.textContent = title;
    this.statusHint.textContent = hint;
  }

  private showPad(name: string): void {
    this.statusEl.style.display = 'none';
    this.padEl.style.display = '';
    this.padName.textContent = name;
    this.touchRectsDirty = true; // the pad just became visible: cached rects are lies
  }

  // ---- connection ---------------------------------------------------------------

  private connect(): void {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data);
      } catch {
        return; // never throw on wire data
      }
      this.onMessage(raw);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onClosed();
    };
    ws.onerror = () => {
      /* the close event that follows does the state work */
    };
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const t = (raw as { t?: unknown }).t;
    if (t === 'welcome') {
      // lobby handshake done → the pad join is a lobby-level message
      this.send({ t: 'join_as_pad', room: this.room, token: this.token });
      return;
    }
    if (t === 'error') {
      this.onError(raw as { code?: unknown; message?: unknown });
      return;
    }
    // Room-level pad protocol; anything else (snapshots, race events meant
    // for player sessions, unknown tags) parses to null and is dropped.
    const msg = parseKartPadToPadS2C(raw);
    if (msg === null) return;
    if (msg.t === 'pad_joined') {
      this.joined = true;
      this.seq = 0; // fresh bind: the room reset the player's seq gate for us
      this.reconnectDelay = RECONNECT_MIN_MS; // a successful join resets the backoff
      this.showPad(msg.name);
      void this.acquireWakeLock();
    } else {
      // pad_left: stop sending; the room already unbound us
      this.joined = false;
      this.terminal = true;
      this.touch.clear();
      this.respawnNext = false; // no tick will consume the latch now
      void this.releaseWakeLock();
      this.ws?.close();
      if (msg.reason === 'replaced') {
        this.showStatus(
          'Another phone took over',
          'Ask the player to generate a new QR code if this phone should keep driving.',
          false,
        );
      } else {
        this.showStatus('The player left the game', 'You can close this page.', false);
      }
    }
  }

  /** The PAD.md error taxonomy — every code terminal, each with its action hint. */
  private onError(msg: { code?: unknown; message?: unknown }): void {
    this.terminal = true;
    this.ws?.close();
    switch (msg.code) {
      case 'no_room':
        this.showStatus('Game not found', 'Rescan the QR code on the game screen.', false);
        break;
      case 'pad_unsupported':
        this.showStatus('No phone-controller mode', 'This game has no phone-controller mode.', false);
        break;
      case 'pad_rejected':
        // also the expected outcome of a reconnect: the token is single-use
        this.showStatus(
          'Pairing expired',
          'Regenerate the QR code on the game screen and scan it again.',
          false,
        );
        break;
      default:
        this.showStatus(
          "Couldn't connect",
          typeof msg.message === 'string' && msg.message !== ''
            ? msg.message
            : 'Rescan the QR code on the game screen.',
          false,
        );
    }
  }

  /** Socket dropped. Terminal screens stay put; anything else reconnects. */
  private onClosed(): void {
    const wasJoined = this.joined;
    this.joined = false;
    this.touch.clear(); // nothing may stay held across a reconnect
    this.respawnNext = false; // a one-tick latch must not outlive its session
    void this.releaseWakeLock();
    if (this.terminal) return;
    this.showStatus(
      wasJoined ? 'Connection lost' : 'Connecting…',
      wasJoined ? 'Reconnecting…' : 'Pairing this phone with the game.',
      true,
    );
    // Exponential backoff with a ceiling: an unreachable server gets retried
    // forever, but at a dwindling rate, not a fixed 1.5s hammer. The delay
    // resets to RECONNECT_MIN_MS on the next successful pad_joined.
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** No-op unless the socket is open (mirrors the server's Session.send). */
  private send(msg: LobbyC2S | KartC2S): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg)); // the wire is plain JSON
    } catch {
      /* the close event that follows handles state */
    }
  }

  // ---- wake lock (TOUCH_PWA.md §3: a screen that sleeps mid-race is the game's fault) ---

  private async acquireWakeLock(): Promise<void> {
    const nav = navigator as Navigator & { wakeLock?: WakeLockLike };
    if (nav.wakeLock === undefined || this.wakeLock !== null) return;
    try {
      this.wakeLock = await nav.wakeLock.request('screen');
    } catch {
      /* unsupported or denied: race on without it */
    }
  }

  private async releaseWakeLock(): Promise<void> {
    const lock = this.wakeLock;
    this.wakeLock = null;
    if (lock === null) return;
    try {
      await lock.release();
    } catch {
      /* already released */
    }
  }

  // ---- input stream --------------------------------------------------------------

  /**
   * One SIM_HZ tick of driver intent. Latched STATE is sampled, never events:
   * whatever the thumbs and tilt sensor say right now is this tick's input.
   */
  private tick(): void {
    if (!this.joined) return;
    const steer = this.tilt.active ? this.tilt.steer : this.touch.steer();
    const msg: KartInputMsg = {
      t: 'kart_input',
      seq: this.seq,
      throttle: this.touch.isDown('gas') ? 1 : 0,
      brake: 0, // no brake/reverse by design (TOUCH_PWA.md §4.2.1)
      steer,
      drift: this.touch.isDown('drift'),
      respawn: this.respawnNext,
      dt: SIM_DT, // honest clients always send SIM_DT
    };
    this.seq += 1;
    this.respawnNext = false;
    this.send(msg);
    // the steering readout is the tilt driver's only feedback — update it at
    // the same rate the inputs actually leave
    this.steerDot.style.left = `${50 + steer * 46}%`;
  }
}

const root = document.getElementById('app');
if (root !== null) {
  new PadApp(root);
}
