// ============================================================================
// PLATFORM v2 SERVICES CONTRACT — types + wire validators for profiles,
// saves, stats and pads. Types-only surface (validators are pure functions,
// same status as protocol.ts's clean* helpers). Server and SDK both import
// from here so neither side can drift. Docs: docs/PLATFORM.md §4–§5.
// FROZEN — additive changes only, by architect decision.
// ============================================================================

import { AUTH, PADS, SAVES } from './limits.js';

// ---- identity --------------------------------------------------------------

/** Server-side profile id (opaque, url-safe). */
export type ProfileId = string;
/** Device/session bearer token minted by POST /api/auth/*. */
export type AuthToken = string;

/** The authenticated half of a session, as the platform reports it. */
export interface Profile {
  readonly id: ProfileId;
  /** Platform display name; games may still use their own join name. */
  readonly name: string;
  /** Epoch ms. */
  readonly createdAt: number;
}

// ---- saves -----------------------------------------------------------------

/** Slot key, /^[a-z0-9_-]{1,24}$/. Games choose their own names ('best', 'save1', …). */
export type SaveSlot = string;

/** One stored slot. `data` is game-owned JSON (plain object or array). */
export interface SaveRecord<T = unknown> {
  readonly slot: SaveSlot;
  /** Monotonic version; PUT must carry the rev it was based on. */
  readonly rev: number;
  readonly data: T;
  /** Epoch ms of last write. */
  readonly updatedAt: number;
}

/** Listing entry without the payload. */
export interface SaveSummary {
  readonly slot: SaveSlot;
  readonly rev: number;
  readonly updatedAt: number;
  /** Serialized size in bytes (for quota UI). */
  readonly size: number;
}

// ---- stats -----------------------------------------------------------------

/** Counter deltas a room reports; keys are game-defined. */
export type StatsDelta = Record<string, number>;

/** One aggregated counter row. */
export interface StatRow {
  readonly gameId: string;
  readonly key: string;
  readonly value: number;
}

// ---- pads ------------------------------------------------------------------

/**
 * A virtual-controller schema a game declares (`GameModule.padLayout`). The
 * generic pad page at /pad/ renders itself from this; SDK InputHub maps
 * physical gamepads onto the same ids.
 */
export interface PadLayout {
  /** Which sticks appear. ids are fixed: 'l' = left, 'r' = right. */
  readonly sticks: ReadonlyArray<{ readonly id: 'l' | 'r'; readonly label: string }>;
  /**
   * Buttons, each mapped to one bit of PadFrame.buttons (0..PADS.maxButtons-1).
   * Bits not listed here are reserved for the platform (bit 31 = pad "pause").
   */
  readonly buttons: ReadonlyArray<{ readonly bit: number; readonly label: string }>;
}

/**
 * The ONE normalized pad frame. Sticks in [-1,1]; buttons is a uint32 bitmask.
 * Phone pads and Gamepad-API devices both produce this shape.
 */
export interface PadFrame {
  readonly lx: number;
  readonly ly: number;
  readonly rx: number;
  readonly ry: number;
  readonly buttons: number;
}

// ---- wire validators (pure; never throw) -----------------------------------

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SLOT_RE = /^[a-z0-9_-]{1,24}$/;
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/; // no I, O, 0, 1 — claim codes AND pad pair codes

export function isValidToken(v: unknown): v is AuthToken {
  return typeof v === 'string' && TOKEN_RE.test(v);
}
export function isValidSaveSlot(v: unknown): v is SaveSlot {
  return typeof v === 'string' && SLOT_RE.test(v);
}
export function isValidClaimCode(v: unknown): v is string {
  return typeof v === 'string' && CODE_RE.test(v);
}
/** Pad pairing code — same shape/namespace discipline as claim codes. */
export function isValidPairCode(v: unknown): v is string {
  return typeof v === 'string' && CODE_RE.test(v);
}
/** Plain object or array only — no primitives at the top level. */
export function isValidSaveData(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  if (Array.isArray(v)) return true;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}
/** Clamp any number into [-1,1]; non-finite => 0. */
export function clampAxis(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(-1, Math.min(1, v));
}
/** Validate/clamp a raw pad frame object (already envelope-checked), or null. */
export function cleanPadFrame(raw: unknown): PadFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.buttons !== 'number' || !Number.isFinite(r.buttons)) return null;
  const buttons = Math.max(0, Math.min(0xffffffff, Math.trunc(r.buttons)));
  return {
    lx: clampAxis(r.lx),
    ly: clampAxis(r.ly),
    rx: clampAxis(r.rx),
    ry: clampAxis(r.ry),
    buttons,
  };
}

/** Claim-code alphabet (no I/O/0/1), for generators on both sides. */
export const CLAIM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
