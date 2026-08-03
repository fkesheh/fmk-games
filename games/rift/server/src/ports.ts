// ============================================================================
// ANCIENTS (rift) — PORTS. The server-internal seam between the room (T10)
// and the module plug (T10), mirroring games/wordbomb/server/src/ports.ts.
//
// The room takes its dependencies rather than importing them, so room.test.ts
// can drive it with a deterministic `rand` instead of the module-scope stream.
// `rand` feeds ONLY non-secret generation the contract assigns to it: the room
// id + private join code (CONTRACT §5, "from ROOM_ALPHABET via the injected
// rand") and the createWorld seam argument (the sim core is deterministic and
// does not consume it; bot determinism comes from hashSeed(roomId, index)).
// ============================================================================
import type { RoomIO, Visibility } from '@platform/shared';
import type { RiftSettings } from '@rift/shared';

export interface RoomDeps {
  rand: () => number;
}

/** The constructor shape module.ts's plug must call (wordbomb shape). */
export type RiftRoomCtor = new (
  visibility: Visibility,
  io: RoomIO,
  settings: RiftSettings,
  deps: RoomDeps,
) => import('@platform/shared').GameRoomHandle;
