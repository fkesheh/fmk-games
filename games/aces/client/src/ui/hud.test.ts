// ============================================================================
// ACES — C_UI hud.test.ts. This workspace has no jsdom, so (mirroring
// games/outpost/client/src/ui/hud.test.ts and the rift/splat house pattern)
// this suite exercises ONLY the exported PURE display logic of hud.ts and
// screens.ts — projection math, tick-window expiry, percentage math, stat-strip
// normalization, model-derived strings. None of it touches `document` or a
// canvas; both modules keep their top level DOM-free precisely for this. The
// DOM/canvas classes themselves are exercised at runtime by the e2e harness.
//
// Every describe block names the brief/bible law it pins.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { ALT, SNAP_RATE } from '@aces/shared/config.js';
import type { CameraView } from '../contract/seams.js';
import type { Banner, KillFeedEntry } from '../contract/seams.js';

import {
  accPct,
  altLow,
  altPct,
  altText,
  altWarn,
  bannerAlpha,
  bannerLive,
  CLS_GLYPH,
  clockText,
  edgeArrow,
  feedAlpha,
  feedExpired,
  formatKeys,
  matchClock,
  TEAM_LETTER,
  ticketPct,
} from './hud.js';
import {
  classStrips,
  controlsRows,
  disconnectNote,
  endBanner,
  lobbyLine,
  pickerWaiting,
  RE_ENLIST_LABEL,
  respawnLine,
  spawnHotkey,
} from './screens.js';

// ---- fixtures -----------------------------------------------------------------

/**
 * GRAPHICS_3D §2 seam repair: CameraView now REQUIRES project() (the frozen
 * amendment), so these fixtures carry a stub. The edge-arrow suite below is
 * pure post-projection clamp math — projection itself is pinned by
 * render3d/scene.test.ts against the live rig.
 */
const CAM: CameraView = { x: 0, y: 0, zoom: 1, project: () => ({ sx: 0, sy: 0, visible: false }) };
void CAM;

function feedEntry(bornTick: number, over: Partial<KillFeedEntry> = {}): KillFeedEntry {
  return {
    id: 1,
    killerName: 'Lt. Kestrel',
    victimName: 'Cpl. Voss',
    killerTeam: 'royal',
    crash: false,
    killerCls: 'fighter',
    bornTick,
    ...over,
  };
}

function banner(kind: Banner['kind'], bornTick: number): Banner {
  return { kind, text: kind === 'ace' ? 'ACE' : kind === 'legend' ? 'LEGEND' : 'SUDDEN DEATH', bornTick };
}

// ---------------------------------------------------------------------------
// 1 · Edge-arrow clamping (D4: where are enemies) — pure POST-projection math
// ---------------------------------------------------------------------------

describe('edgeArrow — offscreen screen points pin to the correct viewport edge', () => {
  const VW = 800;
  const VH = 600;

  it('returns null while the point is on-screen inside the inset box', () => {
    expect(edgeArrow(100, 50, VW, VH)).toBeNull();
    // hugging the inset box without crossing it still counts as visible
    // (screen (750,560) vs bounds x≤774, y≤574)
    expect(edgeArrow(350, 260, VW, VH)).toBeNull();
  });

  it('pins a point far LEFT to the left edge pointing west', () => {
    const a = edgeArrow(-5000, 300, VW, VH); // vertically centered: the ray stays flat
    expect(a).not.toBeNull();
    expect(a!.x).toBeCloseTo(26, 6); // exactly the inset margin
    expect(Math.abs(a!.y - 300)).toBeLessThan(1); // vertical ray barely bends
    expect(a!.angle).toBeGreaterThan(Math.PI * 0.99); // points back (west)
  });

  it('pins a point far RIGHT to the right edge pointing east', () => {
    const a = edgeArrow(5000, 300, VW, VH)!;
    expect(a.x).toBeCloseTo(VW - 26, 6);
    expect(a.y).toBeCloseTo(300, 6);
    expect(a.angle).toBeCloseTo(0, 6);
  });

  it('pins a point far ABOVE the top edge pointing north', () => {
    const a = edgeArrow(400, -5000, VW, VH)!;
    expect(a.y).toBeCloseTo(26, 6);
    expect(a.x).toBeCloseTo(400, 6);
    expect(a.angle).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('clamps a corner overshoot INSIDE the inset box on both axes', () => {
    const a = edgeArrow(5000, -5000, VW, VH)!;
    expect(a.x).toBeGreaterThanOrEqual(26);
    expect(a.x).toBeLessThanOrEqual(VW - 26);
    expect(a.y).toBeGreaterThanOrEqual(26);
    expect(a.y).toBeLessThanOrEqual(VH - 26);
    // the shorter axis distance wins the clamp: north edge reached first
    expect(a.y).toBeCloseTo(26, 6);
  });

  it('honors a custom inset margin (projection owns zoom now, not this helper)', () => {
    const a = edgeArrow(5000, 300, VW, VH, 60)!;
    expect(a.x).toBeCloseTo(VW - 60, 6);
    // and a point that stays inside the wider inset stays unpinned
    expect(edgeArrow(700, 300, VW, VH, 60)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2 · Feed + banner expiry windows vs m.tick (~4 s slips, ~2.5 s stamps)
// ---------------------------------------------------------------------------

describe('killfeed expiry — paper slips fade after ~4 s of snapshot ticks', () => {
  const TTL = SNAP_RATE * 4;

  it('keeps a slip alive up to one tick short of the TTL, dead at it', () => {
    const e = feedEntry(100);
    expect(feedExpired(e, 100)).toBe(false);
    expect(feedExpired(e, 100 + TTL - 1)).toBe(false);
    expect(feedExpired(e, 100 + TTL)).toBe(true);
  });

  it('holds full opacity until the final second, then fades linearly', () => {
    const e = feedEntry(0);
    expect(feedAlpha(e, 0)).toBe(1);
    expect(feedAlpha(e, TTL - SNAP_RATE)).toBe(1); // still ≥1 s left
    const mid = feedAlpha(e, TTL - SNAP_RATE / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(mid).toBeCloseTo((SNAP_RATE / 2) / (SNAP_RATE * 1), 6);
    expect(feedAlpha(e, TTL)).toBe(0);
  });
});

describe('streak banners — ACE/LEGEND hold ~2.5 s then fade; sudden death never uses the DOM slot', () => {
  // the implementation quantizes "~2.5 s" into whole snapshot ticks
  const TTL = Math.round(SNAP_RATE * 2.5);

  it('expires an ACE banner vs m.tick', () => {
    const b = banner('ace', 500);
    expect(bannerLive(b, 500)).toBe(true);
    expect(bannerLive(b, 500 + TTL - 1)).toBe(true);
    expect(bannerLive(b, 500 + TTL)).toBe(false);
    expect(bannerAlpha(b, 500)).toBe(1);
    expect(bannerAlpha(b, 500 + TTL)).toBe(0);
  });

  it('fades LEGEND across its tail window, monotonically', () => {
    const b = banner('legend', 0);
    let prev = 1;
    for (let t = 0; t <= TTL; t += 1) {
      const a = bannerAlpha(b, t);
      expect(a).toBeLessThanOrEqual(prev + 1e-9);
      prev = a;
    }
    expect(prev).toBe(0);
  });

  it('routes kind suddendeath away from the DOM banner (canvas owns the stamp)', () => {
    const b = banner('suddendeath', 0);
    expect(bannerLive(b, 0)).toBe(false);
    expect(bannerAlpha(b, 999_999)).toBe(1); // steady, never used to hide
  });
});

// ---------------------------------------------------------------------------
// 3 · Ticket-bar percentage math (top-center bars vs TICKETS_TO_WIN)
// ---------------------------------------------------------------------------

describe('ticket bars — fill percent clamps at the win threshold', () => {
  it('maps tickets-to-win onto 0..100%', () => {
    expect(ticketPct(0)).toBe(0);
    expect(ticketPct(12)).toBeCloseTo(48, 6); // 12/25
    expect(ticketPct(25)).toBe(100);
  });

  it('clamps overflow once tickets pass the target (overtime kills still count)', () => {
    expect(ticketPct(30)).toBe(100);
  });

  it('guards non-finite and negative wire noise defensively', () => {
    expect(ticketPct(-5)).toBe(0);
    expect(ticketPct(Number.NaN)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3b · §8 altimeter — whole-unit value, 0..ALT.MAX bar, warn/LOW thresholds
// ---------------------------------------------------------------------------

describe('altimeter row — ALT readout, vertical position bar and sea-proximity flags', () => {
  it('renders whole cruise units, plain (no ft flavor)', () => {
    expect(altText(12)).toBe('12');
    expect(altText(41.6)).toBe('42'); // Math.round
    expect(altText(0)).toBe('0');
    expect(altText(ALT.MAX)).toBe(String(ALT.MAX));
  });

  it('treats non-finite wire noise as sea level, never "NaN"', () => {
    expect(altText(Number.NaN)).toBe('0');
    expect(altPct(Number.NaN)).toBe(0);
    expect(altWarn(Number.NaN)).toBe(false);
    expect(altLow(Number.NaN)).toBe(false);
  });

  it('maps altitude onto 0..100% of ALT.MAX for the vertical bar, clamped', () => {
    expect(altPct(0)).toBe(0);
    expect(altPct(ALT.MAX / 2)).toBe(50);
    expect(altPct(ALT.MAX)).toBe(100);
    expect(altPct(ALT.MAX + 30)).toBe(100); // server clamps, HUD clamps too
    expect(altPct(-4)).toBe(0);
  });

  it('warns inside the 14u ground-avoid band; boundary belongs to calm', () => {
    expect(altWarn(13.9)).toBe(true);
    expect(altWarn(14)).toBe(false);
    expect(altWarn(40)).toBe(false);
  });

  it('stamps LOW below ALT.CRASH × 3 — the sea is three crash-heights away', () => {
    expect(ALT.CRASH).toBe(1.2); // frozen config the threshold derives from
    expect(altLow(3.6)).toBe(false); // exactly ×3: not yet LOW
    expect(altLow(3.59)).toBe(true);
    expect(altLow(1)).toBe(true);
    expect(altLow(5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4 · Scoreboard accuracy — hits/shots with the div-by-zero guard
// ---------------------------------------------------------------------------

describe('accuracy percent — a pilot who never fired has NO accuracy, not 0%', () => {
  it('is null at zero shots', () => {
    expect(accPct(0, 0)).toBeNull();
  });

  it('rounds hits/shots to whole percents', () => {
    expect(accPct(8, 4)).toBe(50);
    expect(accPct(3, 2)).toBe(67);
    expect(accPct(480, 240)).toBe(50);
  });

  it('clamps pathological hit counts at 100 instead of overflowing', () => {
    expect(accPct(2, 5)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 5 · Class-picker stat strips normalized across CLASSES (requisition forms)
// ---------------------------------------------------------------------------

describe('classStrips — SCOUT tops speed/agility, GUNSHIP tops guns, all in 0..1', () => {
  it('normalizes speedMax against the fastest airframe', () => {
    expect(classStrips('scout').speed).toBeCloseTo(1, 6); // 250/250
    expect(classStrips('fighter').speed).toBeCloseTo(225 / 250, 6);
    expect(classStrips('gunship').speed).toBeCloseTo(190 / 250, 6);
  });

  it('normalizes turnRate against the tightest turner', () => {
    expect(classStrips('scout').agility).toBeCloseTo(1, 6); // 3.7/3.7
    expect(classStrips('fighter').agility).toBeCloseTo(3.0 / 3.7, 6);
    expect(classStrips('gunship').agility).toBeCloseTo(2.2 / 3.7, 6);
  });

  it('normalizes raw DPS (dmg×count×rateHz) against the heaviest hitter', () => {
    // scout 72 · fighter 110 · gunship 120 (CONTRACT §Balance table)
    expect(classStrips('scout').guns).toBeCloseTo(72 / 120, 6);
    expect(classStrips('fighter').guns).toBeCloseTo(110 / 120, 6);
    expect(classStrips('gunship').guns).toBeCloseTo(1, 6);
  });

  it('keeps every strip inside (0..1] so no card ever draws an empty bar', () => {
    for (const cls of ['scout', 'fighter', 'gunship'] as const) {
      const s = classStrips(cls);
      expect(s.speed).toBeGreaterThan(0);
      expect(s.speed).toBeLessThanOrEqual(1);
      expect(s.agility).toBeGreaterThan(0);
      expect(s.agility).toBeLessThanOrEqual(1);
      expect(s.guns).toBeGreaterThan(0);
      expect(s.guns).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 6 · Sudden-death flag propagation into model-derived strings (clock hides)
// ---------------------------------------------------------------------------

describe('match clock — sudden death replaces the digits with the canvas stamp', () => {
  it('formats timeLeftS as ceiling mm:ss', () => {
    expect(clockText(480)).toBe('8:00');
    expect(clockText(125)).toBe('2:05');
    expect(clockText(47.2)).toBe('0:48'); // ceil: 47.2 means 48 seconds left
    expect(clockText(0)).toBe('0:00');
    expect(clockText(-3)).toBe('0:00'); // defensive against wire noise
  });

  it('empties the clock string EXACTLY when suddenDeath flips on', () => {
    expect(matchClock(125, false)).toBe('2:05');
    expect(matchClock(125, true)).toBe('');
    expect(matchClock(0, true)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// supporting vocabulary — D4 letters/glyphs, key formatting, state lines
// ---------------------------------------------------------------------------

describe('D4 double-encoding vocabulary', () => {
  it('carries team LETTERS distinct per team', () => {
    expect(TEAM_LETTER.royal).toBe('R');
    expect(TEAM_LETTER.iron).toBe('I');
  });

  it('carries distinct class glyphs', () => {
    expect(CLS_GLYPH.scout).not.toBe(CLS_GLYPH.fighter);
    expect(CLS_GLYPH.fighter).not.toBe(CLS_GLYPH.gunship);
    expect(CLS_GLYPH.gunship).not.toBe(CLS_GLYPH.scout);
  });
});

describe('keyboard labels + controls listing derive FROM INPUT_KEYS', () => {
  it('pretty-prints modifier/arrow codes', () => {
    expect(formatKeys(['KeyA', 'ArrowLeft'])).toBe('A / ←');
    expect(formatKeys(['Space'])).toBe('SPACE');
    // mirrored physical keys dedupe to ONE stamp (INPUT_KEYS.boost pair)
    expect(formatKeys(['ShiftLeft', 'ShiftRight'])).toBe('SHIFT');
  });

  it('lists one row per binding family, all ≥14px-worthy non-empty text', () => {
    const rows = controlsRows();
    expect(rows.length).toBe(7);
    for (const r of rows) {
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.keys.length).toBeGreaterThan(0);
    }
    const byLabel = new Map(rows.map((r) => [r.label, r.keys]));
    expect(byLabel.get('FIRE GUNS')).toContain('SPACE');
    expect(byLabel.get('SCOREBOARD')).toContain('TAB');
    expect(byLabel.get('CONTROLS CARD')).toContain('ESC');
  });
});

describe('state lines derived from model/wire data', () => {
  it('endBanner names the winning squadron or calls a draw', () => {
    expect(endBanner('royal')).toBe('VICTORY ROYAL');
    expect(endBanner('iron')).toBe('VICTORY IRON');
    expect(endBanner(undefined)).toBe('DRAW');
  });

  it('lobbyLine counts down or admits the room is still forming', () => {
    expect(lobbyLine(5)).toBe('FIRST PATROL LAUNCHES IN 5');
    expect(lobbyLine(0.2)).toBe('FIRST PATROL LAUNCHES IN 1'); // ceil
    expect(lobbyLine(null)).toContain('AWAITING SQUADRON');
  });

  it('respawnLine switches from countdown to picker prompt at zero', () => {
    expect(respawnLine(2.4)).toBe('NEXT AIRFRAME IN 2.4S');
    expect(respawnLine(0)).toBe('CHOOSE YOUR AIRFRAME');
    expect(respawnLine(Number.NaN)).toBe('CHOOSE YOUR AIRFRAME'); // defensive
  });

  it('disconnectNote reports the real backoff schedule while retrying', () => {
    expect(disconnectNote(true)).toContain('BACKOFF');
    expect(disconnectNote(true)).toContain('1000 / 2000 / 4000');
    expect(disconnectNote(false)).toContain('FRESH SEAT');
  });

  it('spawnHotkey maps the cards\u2019 painted numerals 1·2·3 to classes', () => {
    expect(spawnHotkey('Digit1')).toBe('scout');
    expect(spawnHotkey('Numpad2')).toBe('fighter');
    expect(spawnHotkey('Digit3')).toBe('gunship');
    expect(spawnHotkey('KeyZ')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7 · Death interstitial — picker visible (dimmed) through the countdown (D3)
// ---------------------------------------------------------------------------

describe('pickerWaiting — requisition form stays up, dimmed, while the clock runs', () => {
  it('flags .waiting for any positive respawn time and opens at zero', () => {
    expect(pickerWaiting(3.5)).toBe(true); // RESPAWN_SECONDS window
    expect(pickerWaiting(0.04)).toBe(true); // final fraction of a second
    expect(pickerWaiting(0)).toBe(false);
    expect(pickerWaiting(-1)).toBe(false);
    expect(pickerWaiting(Number.NaN)).toBe(false); // defensive vs wire noise
  });

  it('pairs with the prompt line: waiting counts down, open invites the pick', () => {
    expect(respawnLine(2.4)).toContain('NEXT AIRFRAME');
    expect(respawnLine(0)).toContain('CHOOSE');
  });
});

// ---------------------------------------------------------------------------
// 8 · Disconnect screen — always ships an explicit way back in (F4)
// ---------------------------------------------------------------------------

describe('disconnect actions — the dead-end screen carries a reload-wired RE-ENLIST', () => {
  it('labels the primary action RE-ENLIST', () => {
    expect(RE_ENLIST_LABEL).toBe('RE-ENLIST');
  });
});
