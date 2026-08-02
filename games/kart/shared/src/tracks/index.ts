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
//
// CALENDAR ORDER (the order below IS the order a championship runs, because
// TRACK_LIST is Object.values of this literal): the eight circuits are laid out
// so no two neighbours drive alike — a short sprint never follows a short
// sprint, and the two longest are split across the calendar.
//   greenvale  598 m  all-round parkland, the home circuit
//   copper     395 m  the sprint: shortest lap, constant traffic
//   thunder    745 m  a 177 m straight into a 12 m hairpin
//   lantern    518 m  twenty corners, one straight — the drift circuit
//   cobalt     703 m  sweepers only, barely a braking point
//   switchback 803 m  decreasing-radius corners that punish greed
//   crown      660 m  double apex, increasing-radius sweep, chicane
//   highland   891 m  the endurance lap
// tracks.test.ts gates the spread: no two laps within 5 % of each other, and a
// better than 2x range from the shortest circuit to the longest.
// ============================================================================
import type { TrackId, TrackSource } from '../track.js';
import { cobalt } from './cobalt.js';
import { copper } from './copper.js';
import { crown } from './crown.js';
import { greenvale } from './greenvale.js';
import { highland } from './highland.js';
import { lantern } from './lantern.js';
import { switchback } from './switchback.js';
import { thunder } from './thunder.js';

export const TRACKS: Record<TrackId, TrackSource> = {
  greenvale,
  copper,
  thunder,
  lantern,
  cobalt,
  switchback,
  crown,
  highland,
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

export * from './palette.js';
export * from './cobalt.js';
export * from './copper.js';
export * from './crown.js';
export * from './greenvale.js';
export * from './highland.js';
export * from './lantern.js';
export * from './switchback.js';
export * from './thunder.js';
