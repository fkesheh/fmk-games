// ============================================================================
// BROWSER IDENTITY — the signature every game client presents.
//
// Two durable things live here, shared by every game on the platform:
//
//   1. a SIGNATURE: "which browser is this", stable across reloads and across
//      games. Minted once, never shown to the player.
//   2. a NAME: one display name for the whole platform. Type it in kart and
//      rift already knows it. Games each used to keep their own key
//      (rift.name, bank.name, wordbomb.name, stricken.name) and kart kept
//      none at all; those are migrated in on first read (see LEGACY_NAME_KEYS)
//      so nobody loses the name they had.
//
// Plus a per-game SESSION pointer — {playerId, roomId, code} — which is what
// actually gets a returning player back into the room they were in rather
// than a fresh one. A resume token is useless without it: reconnecting to
// SOME room is not resuming.
//
// Why a signature at all, when the wire already had `resume` (the previous
// playerId)? Because a playerId is ephemeral — minted per socket, dropped
// when the room purges the ghost. It chains correctly only while the tab
// stays alive. The signature is still correct after a purge, after a
// rotation, and after three reconnects in a row, so a room can rebind by
// `resume` first and fall back to `sig`.
//
// Every storage access is try/catch'd: localStorage may be blocked (private
// mode, embedded webview, cookie policy). When it is, identity still works
// for the life of the page from the in-memory mirror — it just doesn't
// outlive the tab. Storage is a courtesy here, never a dependency.
//
// IMPORTANT: this module is imported by the SERVER too (via the barrel). It
// must have no top-level side effects and must never touch `window`,
// `localStorage`, or `crypto` at import time — only inside functions.
// ============================================================================

/** localStorage key holding the shared `{ sig, name }` record. */
export const IDENTITY_KEY = 'play.identity';

/** localStorage key prefix for the per-game rejoin pointer; + GameModule.id. */
export const SESSION_PREFIX = 'play.session.';

/** Display names are capped platform-wide (mirrors the server's cleanName). */
export const NAME_MAX = 16;

/** What an empty name renders as, server-side and in placeholders. */
export const DEFAULT_NAME = 'Player';

/** Signature length bounds — the wire validator (cleanSig) enforces these. */
export const SIG_MIN = 8;
export const SIG_MAX = 64;

/**
 * Per-game name keys written before the identity was shared. Read once, in
 * this order, when the shared record has no name yet; never written again.
 * Order is "most recently built game first" — the newest key is the most
 * likely to hold the name the player actually wants.
 */
export const LEGACY_NAME_KEYS: readonly string[] = ['rift.name', 'bank.name', 'wordbomb.name', 'stricken.name'];

/** The durable, cross-game browser identity. */
export interface Identity {
  /** Stable per-browser signature; presented on every join as `sig`. */
  readonly sig: string;
  /** Display name, or '' when the player has never typed one. */
  readonly name: string;
}

/** Where a player was, so a reload can go back to the same room. */
export interface SessionRecord {
  /** The playerId of the session that was dropped — sent back as `resume`. */
  readonly playerId: string;
  /** Public room id, for `join_public`. null when the room was private. */
  readonly roomId: string | null;
  /** Private join code, for `join_private`. null when the room was public. */
  readonly code: string | null;
}

// ---- in-memory mirror (survives blocked storage for the life of the page) --
let memIdentity: Identity | null = null;
const memSessions = new Map<string, SessionRecord>();

/**
 * The slice of `localStorage` we actually use, typed structurally rather than
 * as the DOM's ambient `Storage`. This package is compiled by BOTH the browser
 * clients and the Node server, and only one of those two tsconfigs has the DOM
 * lib. Naming `Storage`/`Crypto` here would make the shared contract fail to
 * type-check on whichever side is missing those ambient declarations — and
 * "add @types/node to the shared package" would be the wrong fix for code the
 * browser also compiles. Structural types belong to neither environment and
 * satisfy both.
 */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Likewise: just the one crypto method newSig() needs. */
interface CryptoLike {
  getRandomValues(array: Uint8Array): Uint8Array;
}

function storage(): StorageLike | null {
  try {
    // `globalThis.localStorage` throws outright in some sandboxed frames.
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    /* quota, private mode, blocked — the in-memory mirror still holds */
  }
}

function drop(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* non-fatal */
  }
}

/** Trimmed, length-capped display name; DEFAULT_NAME when whitespace-only. */
export function cleanName(v: string): string {
  return v.trim().slice(0, NAME_MAX) || DEFAULT_NAME;
}

/** A fresh 32-char hex signature. Prefers crypto; degrades rather than throws. */
export function newSig(): string {
  try {
    const c = (globalThis as { crypto?: CryptoLike }).crypto;
    if (c !== undefined && typeof c.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      c.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    /* fall through to the arithmetic fallback */
  }
  let out = '';
  while (out.length < 32) out += Math.floor(Math.random() * 16).toString(16);
  return out.slice(0, 32);
}

function parseIdentity(raw: string): { sig: string; name: string } {
  let sig = '';
  let name = '';
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const rec = parsed as Record<string, unknown>;
      if (typeof rec.sig === 'string' && rec.sig.length >= SIG_MIN && rec.sig.length <= SIG_MAX) sig = rec.sig;
      if (typeof rec.name === 'string') name = rec.name.trim().slice(0, NAME_MAX);
    }
  } catch {
    /* corrupt record: treat as absent and mint a fresh one */
  }
  return { sig, name };
}

/** The first non-empty legacy per-game name, or '' when there is none. */
function migrateLegacyName(): string {
  for (const key of LEGACY_NAME_KEYS) {
    const v = read(key);
    if (v !== null && v.trim() !== '') return v.trim().slice(0, NAME_MAX);
  }
  return '';
}

function persist(id: Identity): void {
  write(IDENTITY_KEY, JSON.stringify({ sig: id.sig, name: id.name }));
}

/**
 * The browser's identity, minting and persisting a signature on first call.
 * Idempotent and cheap after the first call (memoized in `memIdentity`).
 *
 * `name` may be '' — that means "never typed one", and callers should show a
 * placeholder rather than pre-filling the field with DEFAULT_NAME.
 */
export function loadIdentity(): Identity {
  if (memIdentity !== null) return memIdentity;

  const raw = read(IDENTITY_KEY);
  const { sig: storedSig, name: storedName } = raw !== null ? parseIdentity(raw) : { sig: '', name: '' };

  const id: Identity = {
    sig: storedSig !== '' ? storedSig : newSig(),
    name: storedName !== '' ? storedName : migrateLegacyName(),
  };
  memIdentity = id;
  persist(id);
  return id;
}

/** The signature alone — the value to put on a join message's `sig` field. */
export function loadSig(): string {
  return loadIdentity().sig;
}

/** The stored display name, or '' when never set. */
export function loadName(): string {
  return loadIdentity().name;
}

/** Persist the display name platform-wide. Trims and caps; no-op if unchanged. */
export function saveName(name: string): void {
  const current = loadIdentity();
  const next = name.trim().slice(0, NAME_MAX);
  if (next === current.name) return;
  const updated: Identity = { sig: current.sig, name: next };
  memIdentity = updated;
  persist(updated);
}

function sessionKey(game: string): string {
  return SESSION_PREFIX + game;
}

/** Where this browser last was in `game`, or null when it has no record. */
export function loadSession(game: string): SessionRecord | null {
  const cached = memSessions.get(game);
  if (cached !== undefined) return cached;

  const raw = read(sessionKey(game));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.playerId !== 'string' || rec.playerId === '') return null;
    const session: SessionRecord = {
      playerId: rec.playerId,
      roomId: typeof rec.roomId === 'string' && rec.roomId !== '' ? rec.roomId : null,
      code: typeof rec.code === 'string' && rec.code !== '' ? rec.code : null,
    };
    memSessions.set(game, session);
    return session;
  } catch {
    return null;
  }
}

/** Record where the player is, so a reload rejoins THIS room. */
export function saveSession(game: string, rec: SessionRecord): void {
  memSessions.set(game, rec);
  write(sessionKey(game), JSON.stringify({ playerId: rec.playerId, roomId: rec.roomId, code: rec.code }));
}

/** Forget the room pointer — call on an explicit leave, never on a drop. */
export function clearSession(game: string): void {
  memSessions.delete(game);
  drop(sessionKey(game));
}

/**
 * Test-only: drop the memoized identity/session mirrors so the next call
 * re-reads storage. Never call this from game code — a fresh read mid-match
 * would hand out a new signature if storage is blocked.
 */
export function __resetIdentityCache(): void {
  memIdentity = null;
  memSessions.clear();
}
