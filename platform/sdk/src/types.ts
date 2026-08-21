// ============================================================================
// @platform/sdk CONTRACT — the client integration surface (docs/PLATFORM.md
// §4.5). Types-only; implementations live in net.ts, rooms.ts, profile.ts,
// saves.ts, input.ts, audio.ts, padQr.ts, client.ts. Each implementer owns
// its file and appends its re-exports to src/index.ts ONLY.
// FROZEN — additive changes only, by architect decision.
// ============================================================================

import type {
  C2S,
  LobbyS2C,
  PadLayout,
  ProfileId,
  SaveRecord,
  SaveSlot,
  SaveSummary,
} from '@platform/shared';

// ---- input -----------------------------------------------------------------

/**
 * One normalized input frame — the merged result of every active source
 * (keyboard, Gamepad API, local touch overlay). Axes are -1..1.
 */
export interface InputFrame {
  /** Lateral move axis (strafe / steer). */
  readonly moveX: number;
  /** Forward/back axis: +1 = forward intent, -1 = back. */
  readonly moveZ: number;
  /** Look deltas accumulated since last frame(), radians (mouse/pad-stick). */
  readonly lookDX: number;
  readonly lookDY: number;
  /** uint32 button bitmask; bit meanings are GAME-defined via BUTTONS consts. */
  readonly buttons: number;
}

/** Discrete press events, drained once per frame(). */
export type InputEdge =
  | { kind: 'press'; bit: number }
  | { kind: 'release'; bit: number };

/** Keyboard binding table (game supplies its own to remap). */
export interface KeyBindings {
  /** moveX negative (left). */
  readonly left: string[];
  readonly right: string[];
  readonly forward: string[];
  readonly back: string[];
  /** Bit index per action key list; pressed-any => bit set. */
  readonly actions: ReadonlyArray<{ readonly bit: number; readonly keys: readonly string[] }>;
}

/** Standard-mapping gamepad defaults used by InputHub when a pad connects. */
export interface PadBindings {
  readonly stickDeadzone: number; // default 0.15
  /** standard-map button index -> output bit. */
  readonly buttonMap: ReadonlyArray<{ readonly from: number; readonly bit: number }>;
  /** Right stick drives look at this rad/s at full deflection. */
  readonly lookSpeedRadPerSec: number;
}

/** Local touch controls config (virtual joystick + buttons overlay). */
export interface TouchOpts {
  enabled: boolean;
  readonly actions: ReadonlyArray<{ readonly bit: number; readonly label: string }>;
}

// ---- audio -----------------------------------------------------------------

/** Tiny synth kit voices. Games pass params; no samples ever. */
export interface SfxOpts {
  /** Base frequency Hz (voice-dependent meaning). */
  readonly freq?: number;
  /** 0..1. */
  readonly vol?: number;
  /** Attenuation by distance in world units; null = UI sound (default null). */
  readonly dist?: number | null;
  /** Seconds (default voice default). */
  readonly durSec?: number;
}

// ---- input -----------------------------------------------------------------

/**
 * Merged input source hub. start() attaches keyboard + gamepad polling +
 * touch overlay; frame() drains the current merged state; edges() drains
 * press/release events queued since the last call.
 */
export interface InputHub {
  /** Override default WASD/arrows binding. */
  setKeyBindings(b: KeyBindings): void;
  /** Override standard-mapping gamepad defaults. */
  setPadBindings(b: PadBindings): void;
  /** Enable the local touch overlay (mobile browsers). */
  setTouch(opts: TouchOpts): void;
  /** Pointer-lock mouse look: games call request() from a click handler. */
  requestPointerLock(): Promise<void>;
  locked(): boolean;
  onLockChange: ((locked: boolean) => void) | null;
  start(): void;
  stop(): void;
  /** Current merged frame (stable object, mutated in place — read same tick). */
  frame(): InputFrame;
  edges(): InputEdge[];
  /** True while any gamepad is connected. */
  padConnected(): boolean;
}

/** Synthesized audio kit — oscillators/noise only, zero samples. */
export interface AudioKit {
  /** Create/unlock the AudioContext on first user gesture; safe anytime. */
  resume(): void;
  /**
   * One synthesized voice. dist=null means UI sound; otherwise units-based
   * falloff (full volume <10u, silent ≥45u).
   */
  sfx(voice: SfxVoice, opts?: SfxOpts): void;
  /** Looping ambience bed ('wind' | 'hum'); call again to switch. */
  ambient(kind: 'wind' | 'hum' | 'off'): void;
}

/** Built-in voices; each is a distinct synthesis recipe. */
export type SfxVoice =
  | 'click'
  | 'deny'
  | 'jump'
  | 'land'
  | 'hit'
  | 'explode'
  | 'pickup'
  | 'score'
  | 'win'
  | 'lose';

// ---- facade ----------------------------------------------------------------

export interface GameClientOpts {
  /** GameModule.id — also selects the launcher path prefix /<gameId>/. */
  readonly gameId: string;
  /** Canvas for engine SceneRig ownership (optional for DOM-only games). */
  readonly canvas?: HTMLCanvasElement;
  /** Auto-send {t:'auth'} with the stored token after connect (default true). */
  readonly autoAuth?: boolean;
  /** Auto-reconnect on abnormal close with backoff (default true). */
  readonly autoReconnect?: boolean;
}

/**
 * The one-stop game client. Build it in main(); hand pieces to your modules.
 * Every service is usable standalone too — construct them directly if you
* don't want the facade.
 */
export interface GameClient {
  readonly gameId: string;
  /** Resolves once identity is loaded and the first ws connect attempt settled. */
  readonly ready: Promise<void>;
  readonly net: SdkConnection;
  readonly rooms: RoomsApi;
  readonly profile: ProfileApi;
  readonly saves: SavesApi;
  readonly input: InputHub;
  readonly audio: AudioKit;
  /** Renders the phone-pairing QR overlay (no-op when gameId has no padLayout). */
  showPadPairing(): void;
  dispose(): void;
}

// ---- net -------------------------------------------------------------------

/** Connection facade: raw envelope passthrough + clock/rtt + reconnect. */
export interface SdkConnection {
  onMessage: ((msg: LobbyS2C & Record<string, unknown>) => void) | null;
  onClose: ((clean: boolean) => void) | null;
  onOpen: (() => void) | null;
  connect(url?: string): Promise<void>;
  send(msg: C2S): void;
  /** Smoothed RTT ms (EMA over app-level pings). */
  pingMs(): number;
  serverNow(): number;
  close(): void;
}

// ---- rooms -----------------------------------------------------------------

/** Thin typed senders over lobby verbs; replies arrive via net.onMessage. */
export interface RoomsApi {
  list(): void;
  quickJoin(name: string): void;
  joinPublic(name: string, roomId: string): void;
  createPublic(name: string, settings?: Record<string, unknown>): void;
  createPrivate(name: string, settings?: Record<string, unknown>): void;
  joinPrivate(name: string, code: string): void;
  leave(): void;
}

// ---- profile ---------------------------------------------------------------

export interface ProfileInfo {
  readonly id: ProfileId;
  readonly name: string;
}

export interface ProfileApi {
  /** Current profile or null (anonymous). Updated by auth_ok/auth_err. */
  me(): ProfileInfo | null;
  /** Server token if we have one (from localStorage), else null. */
  token(): string | null;
  /** Exchange this browser's sig for a profile token (POST /api/auth/device). */
  ensureDeviceAuth(): Promise<ProfileInfo | null>;
  /** Rename platform-wide; resolves the updated profile. */
  rename(name: string): Promise<ProfileInfo>;
  /** Mint a claim code for linking another device. */
  claimCode(): Promise<string>;
  /** Claim a code minted on another device; adopts that profile here. */
  claim(code: string): Promise<ProfileInfo>;
}

// ---- saves -----------------------------------------------------------------

/** Cloud slots for ONE game (the facade binds gameId). */
export interface SavesApi {
  list(): Promise<ReadonlyArray<SaveSummary>>;
  get<T = unknown>(slot: SaveSlot): Promise<SaveRecord<T>>;
  /**
   * Optimistic write: send `expectedRev`; on conflict resolve {ok:false, record}
   * with the CURRENT record so callers can merge/retry. Network errors throw.
   */
  put(slot: SaveSlot, expectedRev: number, data: unknown): Promise<{ ok: boolean; record: SaveRecord }>;
  del(slot: SaveSlot): Promise<void>;
}

// ---- pads ------------------------------------------------------------------

/** Fetch this game's pad layout (null when the game declares none). */
export type PadLayoutFetcher = () => Promise<PadLayout | null>;
