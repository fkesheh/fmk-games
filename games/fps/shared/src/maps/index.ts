// FROZEN CONTRACT — map registry. New map files register ONLY here.
import type { MapId } from '../types.js';
import type { MapDef } from './types.js';
import { dustbowl } from './dustbowl.js';
import { crossfire } from './crossfire.js';
import { office } from './office.js';
import { frostbite } from './frostbite.js';
import { urbana } from './urbana.js';
import { bunker } from './bunker.js';

export const MAPS: Record<MapId, MapDef> = {
  dustbowl,
  crossfire,
  office,
  frostbite,
  urbana,
  bunker,
};

export const MAP_LIST: MapDef[] = [dustbowl, crossfire, office, frostbite, urbana, bunker];

export * from './types.js';
