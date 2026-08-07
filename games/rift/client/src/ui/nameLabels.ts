// ============================================================================
// ANCIENTS (rift) client — HERO NAME LABELS (CONTRACT §8's never-colour-alone
// law: every visible hero carries its player name ABOVE the unit in-world,
// team-coloured AND prefixed with a per-team SHAPE marker ▲/◆, subtle ink
// text-shadow for legibility). Pooled, classless DOM (the §6 class list has
// no label class and is orchestrator-frozen) projected per frame through
// SceneHandle.groundToScreen.
//
// SEAM (round-5): ClientState/UiActions do NOT carry the scene handle, so no
// UiHandle module (hud.ts) can project world -> screen. This factory is
// therefore driven one level up by game.ts (T8 owns modules.scene + interp).
// The wiring the round-5 handoff asked the orchestrator for is IN PLACE:
// `ClientModules.nameLabels` (contract.ts), `createNameLabels(root)` in the
// wire.ts modules literal, and the per-frame `m.nameLabels.update(...)` call
// in game.ts `step()`.
//
// Fog law: interp.sample() only contains server-visible ents, so fog-hidden
// heroes simply never arrive here — no client-side fog check is needed (or
// possible without leaking). Dead heroes (hp <= 0) get no label. The pool
// caps at MAX_TEAM_SIZE * 2 — every seat in the match, no per-frame alloc.
// ============================================================================
import { APAL, MAX_TEAM_SIZE, heroById, isPlayerTeam } from '@rift/shared';
import type { TeamId } from '@rift/shared';
import type { InterpEnt } from '../contract.js';

const POOL_SIZE = MAX_TEAM_SIZE * 2;
const FONT_PX = 12; // §8 floor
/** Per-team SHAPE markers — team identity is shape AND colour, never colour
 *  alone (§8). ▲ = AZURE (team 0), ◆ = EMBER (team 1).
 *
 *  Both tuples are indexed by `TeamId`, NOT by `InterpEnt.team`, which is the
 *  widened `EntTeam` (`TeamId | 2`) — a neutral jungle camp rides the same
 *  snapshot path as a player's units. Index either with `NEUTRAL_TEAM` and the
 *  read is out of bounds: the marker falls back to '' and the colour to
 *  `APAL.paper`, i.e. a nameless label in the wrong family. `isPlayerTeam` is
 *  the only sanctioned narrowing (types.ts) and `update` applies it before it
 *  reaches either table. */
const TEAM_MARKER: readonly string[] = ['▲', '◆'];
const TEAM_COLOUR: readonly string[] = [APAL.azureLit, APAL.emberLit];

/** SceneHandle.groundToScreen's signature, restated so ui/ never imports
 *  a T7 module (contract-types only across territories). */
export type GroundProjectFn = (x: number, z: number, out: { x: number; y: number }) => boolean;
/** pid -> player display name (roster); undefined = unknown (hero-name
 *  fallback kicks in). */
export type PlayerNameFn = (pid: string) => string | undefined;

export interface NameLabelsHandle {
  /** Per frame, from the interp sample (fog-filtered server-side) + the
   *  scene projector + roster names. */
  update(ents: readonly InterpEnt[], project: GroundProjectFn, nameOf: PlayerNameFn): void;
}

export function createNameLabels(parent: HTMLElement): NameLabelsHandle {
  const pool: HTMLElement[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const e = document.createElement('div'); // classless — §6 list is frozen
    e.style.position = 'fixed';
    e.style.left = '0';
    e.style.top = '0';
    e.style.zIndex = '2'; // world overlay: above the canvas, under the HUD chrome
    e.style.pointerEvents = 'none';
    e.style.whiteSpace = 'nowrap';
    e.style.fontSize = `${FONT_PX}px`;
    e.style.fontWeight = '700';
    e.style.letterSpacing = '0.04em';
    e.style.textShadow = `0 1px 3px ${APAL.inkDeep}, 0 0 2px ${APAL.inkDeep}`;
    e.style.display = 'none';
    parent.appendChild(e);
    pool.push(e);
  }

  const pt = { x: 0, y: 0 }; // reused projection scratch — no per-frame alloc

  return {
    update(ents, project, nameOf) {
      let used = 0;
      for (const e of ents) {
        if (used >= pool.length) break; // cap at visible heroes
        if (e.k !== 'hero' || e.hp <= 0) continue;
        // A neutral (NEUTRAL_TEAM) never gets a team-coloured name label: it
        // belongs to no player team, has no roster name, and both tables below
        // are TeamId-indexed. Skipped BEFORE a pool slot is taken, so a stray
        // neutral cannot displace a real hero's label. Heroes are player-team
        // by construction today; this is the narrowing the widened `EntTeam`
        // requires, not a guess about who might appear here.
        if (!isPlayerTeam(e.team)) continue;
        if (!project(e.x, e.z, pt)) continue; // behind the camera — stays hidden
        // anchor off the viewport = the hero is off-screen too (round-5:
        // groundToScreen's z-range check still passes just past the edges)
        if (pt.x < 0 || pt.y < 0 || pt.x > window.innerWidth || pt.y > window.innerHeight) continue;
        const label = pool[used];
        if (!label) break;
        used++;
        const team: TeamId = e.team;
        const name =
          (e.pid !== undefined ? nameOf(e.pid) : undefined) ??
          (e.hero !== undefined ? heroById(e.hero).name : 'hero');
        const text = `${TEAM_MARKER[team] ?? ''} ${name}`;
        if (label.textContent !== text) label.textContent = text;
        const colour = TEAM_COLOUR[team] ?? APAL.paper;
        if (label.style.color !== colour) label.style.color = colour;
        // groundToScreen anchors ~1m up (torso centre, zoom-correct); the
        // translate lifts the label just above the head.
        label.style.transform = `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px) translate(-50%, -130%)`;
        label.style.display = '';
      }
      for (let i = used; i < pool.length; i++) {
        const label = pool[i];
        if (label && label.style.display !== 'none') label.style.display = 'none';
      }
    },
  };
}
