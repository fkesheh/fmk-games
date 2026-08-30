// ============================================================================
// PLATFORM v2 LIMITS — pure data. Every quota, TTL and rate cap for the
// platform services (auth, saves, stats, pads) lives here so server and SDK
// can never disagree about a limit. DATA ONLY — no logic in this file.
// Docs: docs/PLATFORM.md §4.
// ============================================================================

/** Auth / device-token + claim-code limits. */
export const AUTH = {
  /** Entropy of a device token: 32 bytes => 43 base64url chars. */
  tokenBytes: 32,
  /** Claim-code length (A-Z0-9, no ambiguous glyphs). */
  claimCodeLen: 6,
  /** How long a claim code stays valid. */
  claimTtlMs: 10 * 60_000,
  /** Max linked devices per profile. */
  maxDevicesPerProfile: 8,
} as const;

/** Cloud-save quotas. */
export const SAVES = {
  /** Max serialized JSON bytes per slot (UTF-8). */
  maxBytes: 65_536,
  /** Max slots per game per profile. */
  maxSlots: 12,
  /** Slot-name length cap: /^[a-z0-9_-]{1,24}$/. */
  slotMaxLen: 24,
} as const;

/** Phone-pad pairing + input relay limits. */
export const PADS = {
  /** Pairing token TTL; single use. */
  pairTtlMs: 5 * 60_000,
  /** Max accepted pad_input messages per second per pad session. */
  inputMaxHz: 30,
  /** Button bitmask width. */
  maxButtons: 32,
} as const;

/** Stats delta guards. */
export const STATS = {
  /** Max keys per reportStats call. */
  maxKeysPerDelta: 16,
  /** |value| clamp applied to every counter. */
  maxValue: 1e6,
} as const;

/** P2P signaling relay (docs/PLATFORM.md §12): rendezvous-only traffic. */
export const RTC = {
  /** Max serialized SDP/ICE blob per signal (JSON string bytes). */
  maxSignalBytes: 16_384,
  /** Signals per second per sending session (burst headroom for ICE). */
  maxSignalsPerSec: 30,
} as const;
