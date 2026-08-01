// ============================================================================
// FROZEN CONTRACT — KART GP circuit registry. New circuits register ONLY here.
//
// Adding a track is two edits plus the new file, and nothing else:
//   1. games/kart/shared/src/tracks/<id>.ts  — the authored TrackSource
//   2. one member on `TrackId` (track.ts) AND one entry in TRACKS below
// TRACKS is typed Record<TrackId, TrackSource>, so a TrackId member without a
// TRACKS entry is a compile error: the wire's track ids and the circuits that
// actually exist cannot drift. TRACK_LIST is DERIVED from TRACKS (see below),
// so there is exactly one place to register a circuit — it is impossible to
// add a track that is live on the wire but never validated (the test suite
// iterates TRACK_LIST/TRACKS). A track that fails validateTrack() fails the
// shared test suite.
// ============================================================================
import type { TrackId, TrackSource } from '../track.js';
import { greenvale } from './greenvale.js';

export const TRACKS: Record<TrackId, TrackSource> = {
  greenvale,
};

/**
 * Registry order — the championship calendar and any track-select UI.
 * Derived from TRACKS, never hand-maintained: `Object.values` preserves the
 * literal declaration order of `TRACKS`'s own properties, so an author
 * controls calendar order purely by where they place the entry in TRACKS
 * above — there is no second list to remember to update, and no way for a
 * circuit to be registered without also being validated.
 */
export const TRACK_LIST: readonly TrackSource[] = Object.values(TRACKS);

/** The circuit a room gets when no trackId is supplied. */
export const DEFAULT_TRACK_ID: TrackId = 'greenvale';

/** Narrowing guard for anything that arrives off the wire or out of settings. */
export function isTrackId(v: unknown): v is TrackId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(TRACKS, v);
}

/** The authored source for an id (registry lookup, never undefined). */
export function trackSource(id: TrackId): TrackSource {
  return TRACKS[id];
}

export * from './greenvale.js';
