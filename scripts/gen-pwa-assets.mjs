#!/usr/bin/env node
// ============================================================================
// PWA asset generator — manifests + icons for every game (and the launcher).
//
// docs/TOUCH_PWA.md §1.2/§1.4: icons are GENERATED from each game's existing
// palette, never hand-drawn binaries with no provenance, and never external
// assets/fonts (the repo bans those). Everything below is drawn with flat
// primitives into a supersampled RGB buffer and written as a zero-dependency
// PNG (node:zlib only).
//
// TWO SOURCES OF TRUTH, BOTH READ AT GENERATE TIME — never copied here:
//   1. colours    -> games/<id>/shared/src/palette.ts   (looked up BY KEY NAME)
//   2. background -> games/<id>/client/index.html       (the pre-boot paint
//      guard hex, VISUAL_UPGRADE.md §7 seam rule 6). The manifest's
//      background_color/theme_color MUST byte-match it or the install flashes
//      a different colour than the app paints (TOUCH_PWA.md §1.2), so it is
//      extracted from the page rather than restated.
// A missing key or a missing paint guard is a hard error, not a fallback: a
// silent default here would ship a wrong colour that nobody would notice until
// an iPad was in a child's hands.
//
// Usage:
//   node scripts/gen-pwa-assets.mjs      # regenerates all four games in place
//
// SCOPE: the four GAME installs only. The launcher's own manifest and icons
// (`/manifest.webmanifest`, `/icons/…`) are generated and served by
// platform/server/src/pwa.ts — deliberately not duplicated here, because two
// generators for one icon is how the launcher ends up with two different looks.
//
// Outputs per game, at the paths frozen in TOUCH_PWA.md §2.0 (vite copies
// <client>/public/** to the dist root, and the platform serves that dist at
// /<id>/, so public/x lands at /<id>/x in BOTH dev and the built output):
//   games/<id>/client/public/manifest.webmanifest
//   games/<id>/client/public/icons/icon-192.png
//   games/<id>/client/public/icons/icon-512.png
//   games/<id>/client/public/icons/icon-maskable-512.png
//   games/<id>/client/public/icons/apple-touch-icon.png
// ============================================================================

import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- PNG (8-bit truecolour, no alpha — every icon is fully opaque) ----------
// iOS composites a transparent apple-touch-icon onto black and Android maskable
// icons must bleed to the edge; opaque RGB sidesteps both hazards.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** @param {number} w @param {number} h @param {Uint8Array} rgb w*h*3 */
function encodePng(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None) — flat art compresses fine
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- a tiny supersampled painter ------------------------------------------
// All geometry is in NORMALISED units (0..1 across the icon) so one glyph
// definition serves 180 / 192 / 512 and the shrunken maskable variant.

const SS = 4; // supersample factor; box-downsampled on export => clean edges

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

class Canvas {
  constructor(size) {
    this.size = size;
    this.n = size * SS;
    this.buf = new Uint8Array(this.n * this.n * 3);
  }
  fill(hex) {
    const [r, g, b] = hexToRgb(hex);
    for (let i = 0; i < this.buf.length; i += 3) {
      this.buf[i] = r;
      this.buf[i + 1] = g;
      this.buf[i + 2] = b;
    }
  }
  #px(x, y, r, g, b) {
    if (x < 0 || y < 0 || x >= this.n || y >= this.n) return;
    const i = (y * this.n + x) * 3;
    this.buf[i] = r;
    this.buf[i + 1] = g;
    this.buf[i + 2] = b;
  }
  rect(x, y, w, h, hex) {
    const [r, g, b] = hexToRgb(hex);
    const x0 = Math.round(x * this.n);
    const y0 = Math.round(y * this.n);
    const x1 = Math.round((x + w) * this.n);
    const y1 = Math.round((y + h) * this.n);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.#px(xx, yy, r, g, b);
  }
  circle(cx, cy, rad, hex) {
    this.ring(cx, cy, rad, 0, hex);
  }
  /** filled annulus; rIn = 0 gives a disc */
  ring(cx, cy, rOut, rIn, hex) {
    const [r, g, b] = hexToRgb(hex);
    const c = { x: cx * this.n, y: cy * this.n };
    const ro = rOut * this.n;
    const ri = rIn * this.n;
    const y0 = Math.max(0, Math.floor(c.y - ro));
    const y1 = Math.min(this.n, Math.ceil(c.y + ro));
    const x0 = Math.max(0, Math.floor(c.x - ro));
    const x1 = Math.min(this.n, Math.ceil(c.x + ro));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const dx = xx + 0.5 - c.x;
        const dy = yy + 0.5 - c.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= ro * ro && d2 >= ri * ri) this.#px(xx, yy, r, g, b);
      }
    }
  }
  roundRect(x, y, w, h, rad, hex) {
    const r = Math.min(rad, w / 2, h / 2);
    this.rect(x + r, y, w - 2 * r, h, hex);
    this.rect(x, y + r, w, h - 2 * r, hex);
    this.circle(x + r, y + r, r, hex);
    this.circle(x + w - r, y + r, r, hex);
    this.circle(x + r, y + h - r, r, hex);
    this.circle(x + w - r, y + h - r, r, hex);
  }
  /** thick line as a chain of discs — smooth ends, no trigonometry per pixel */
  stroke(x0, y0, x1, y1, width, hex) {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * this.n);
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      this.circle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width / 2, hex);
    }
  }
  /** box-downsample the supersampled buffer to the final size */
  toPng() {
    const out = new Uint8Array(this.size * this.size * 3);
    const area = SS * SS;
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const i = ((y * SS + sy) * this.n + (x * SS + sx)) * 3;
            r += this.buf[i];
            g += this.buf[i + 1];
            b += this.buf[i + 2];
          }
        }
        const o = (y * this.size + x) * 3;
        out[o] = Math.round(r / area);
        out[o + 1] = Math.round(g / area);
        out[o + 2] = Math.round(b / area);
      }
    }
    return encodePng(this.size, this.size, out);
  }
}

// ---- glyphs ----------------------------------------------------------------
// `s` is the glyph box edge in normalised units, centred on the icon. Each
// glyph must read at 48 CSS px on a home screen and be told apart from the
// other four by SHAPE ALONE — a 4-year-old navigates by colour first, but two
// games sharing a hue family must not also share a silhouette.

const GLYPHS = {
  /** KART — chequered flag: a 4x4 chequer block. */
  kart(c, s, col) {
    const n = 4;
    const cell = s / n;
    const x0 = 0.5 - s / 2;
    const y0 = 0.5 - s / 2;
    c.rect(x0, y0, s, s, col.light);
    for (let row = 0; row < n; row++) {
      for (let colIdx = 0; colIdx < n; colIdx++) {
        if ((row + colIdx) % 2 === 1) continue;
        c.rect(x0 + colIdx * cell, y0 + row * cell, cell, cell, col.dark);
      }
    }
  },
  /** STRICKEN — a crosshair: ring, four ticks, hot centre dot. */
  fps(c, s, col) {
    const r = s / 2;
    c.ring(0.5, 0.5, r * 0.78, r * 0.6, col.light);
    const t = s * 0.055; // tick thickness
    const inner = r * 0.32;
    const outer = r * 1.0;
    c.rect(0.5 - outer, 0.5 - t / 2, outer - inner, t, col.light);
    c.rect(0.5 + inner, 0.5 - t / 2, outer - inner, t, col.light);
    c.rect(0.5 - t / 2, 0.5 - outer, t, outer - inner, col.light);
    c.rect(0.5 - t / 2, 0.5 + inner, t, outer - inner, col.light);
    c.circle(0.5, 0.5, s * 0.075, col.hot);
  },
  /** BANK — a die showing five. */
  bank(c, s, col) {
    const x0 = 0.5 - s / 2;
    const y0 = 0.5 - s / 2;
    c.roundRect(x0, y0, s, s, s * 0.18, col.light);
    const p = s * 0.085; // pip radius
    const d = s * 0.26; // pip offset from centre
    for (const [dx, dy] of [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]]) {
      c.circle(0.5 + dx * d, 0.5 + dy * d, p, col.dark);
    }
  },
  /** WORDBOMB — a bomb with a lit fuse. */
  wordbomb(c, s, col) {
    const body = s * 0.38;
    const cy = 0.5 + s * 0.08;
    c.circle(0.5, cy, body, col.dark);
    // cap
    c.roundRect(0.5 - s * 0.11, cy - body - s * 0.09, s * 0.22, s * 0.13, s * 0.03, col.dark);
    // fuse: two segments arcing up and right
    const fx = 0.5 + s * 0.06;
    const fy = cy - body - s * 0.08;
    c.stroke(fx, fy, fx + s * 0.14, fy - s * 0.12, s * 0.055, col.dark);
    c.stroke(fx + s * 0.14, fy - s * 0.12, fx + s * 0.3, fy - s * 0.08, s * 0.055, col.dark);
    // spark
    c.circle(fx + s * 0.32, fy - s * 0.07, s * 0.085, col.hot);
    c.circle(fx + s * 0.32, fy - s * 0.07, s * 0.04, col.light);
  },
};

// ---- palette + paint-guard extraction --------------------------------------

/** Look a colour up BY KEY in a palette file. Missing key => hard error. */
function paletteColor(paletteFile, key) {
  const src = readFileSync(path.join(ROOT, paletteFile), 'utf8');
  const m = src.match(new RegExp(`^\\s*${key}:\\s*'(#[0-9a-fA-F]{3,8})'`, 'm'));
  if (!m) throw new Error(`${paletteFile}: no palette key '${key}' — icon colours must trace to the palette`);
  return m[1];
}

/** The pre-boot paint guard hex from a game page (TOUCH_PWA.md §1.2). */
function paintGuardHex(htmlFile) {
  const src = readFileSync(path.join(ROOT, htmlFile), 'utf8');
  const m = src.match(/background:\s*(#[0-9a-fA-F]{3,8})\s*;/);
  if (!m) throw new Error(`${htmlFile}: no pre-boot paint guard 'background: #…;' to match the manifest against`);
  return m[1];
}

// ---- the four game installs (TOUCH_PWA.md §1.1) ----------------------------
// The fifth install in §1.1 is the launcher; it lives in platform/server (T2).

const GAMES = [
  {
    id: 'kart',
    name: 'KART GP',
    shortName: 'KART GP', // 7 chars — §1.2 caps short_name at 12
    orientation: 'landscape',
    glyph: 'kart',
    palette: 'games/kart/shared/src/palette.ts',
    html: 'games/kart/client/index.html',
    out: 'games/kart/client/public',
    colors: { bg: 'kartRed', light: 'curbWhite', dark: 'ink' },
  },
  {
    id: 'fps',
    name: 'STRICKEN',
    shortName: 'STRICKEN', // 8
    orientation: 'landscape',
    glyph: 'fps',
    palette: 'games/fps/shared/src/palette.ts',
    html: 'games/fps/client/index.html',
    out: 'games/fps/client/public',
    colors: { bg: 'ctBlue', light: 'paper', hot: 'tAmber' },
  },
  {
    id: 'bank',
    name: 'BANK',
    shortName: 'BANK', // 4
    orientation: 'any',
    glyph: 'bank',
    palette: 'games/bank/shared/src/palette.ts',
    html: 'games/bank/client/index.html',
    out: 'games/bank/client/public',
    colors: { bg: 'felt', light: 'diceFace', dark: 'dicePip' },
  },
  {
    id: 'wordbomb',
    name: 'WORDBOMB',
    shortName: 'WORDBOMB', // 8
    orientation: 'any',
    glyph: 'wordbomb',
    palette: 'games/wordbomb/shared/src/palette.ts',
    html: 'games/wordbomb/client/index.html',
    out: 'games/wordbomb/client/public',
    colors: { bg: 'fuse', light: 'paperLit', dark: 'ink', hot: 'boom' },
  },
];

const ICONS = [
  // Standard icons carry a generous glyph; the MASKABLE variant must keep the
  // glyph inside the 80% safe zone or Android's circle/squircle mask clips it.
  { file: 'icon-192.png', size: 192, glyphScale: 0.62, purpose: 'any' },
  { file: 'icon-512.png', size: 512, glyphScale: 0.62, purpose: 'any' },
  { file: 'icon-maskable-512.png', size: 512, glyphScale: 0.46, purpose: 'maskable' },
  { file: 'apple-touch-icon.png', size: 180, glyphScale: 0.62, purpose: 'apple' },
];

function renderIcon(size, bg, glyph, glyphScale, colors) {
  const c = new Canvas(size);
  c.fill(bg);
  GLYPHS[glyph](c, glyphScale, colors);
  return c.toPng();
}

function writeGame(game) {
  const bg = paletteColor(game.palette, game.colors.bg);
  const glyphColors = {};
  for (const [role, key] of Object.entries(game.colors)) {
    if (role === 'bg') continue;
    glyphColors[role] = paletteColor(game.palette, key);
  }
  const guard = paintGuardHex(game.html);

  const iconsDir = path.join(ROOT, game.out, 'icons');
  mkdirSync(iconsDir, { recursive: true });
  const written = [];
  for (const icon of ICONS) {
    writeFileSync(
      path.join(iconsDir, icon.file),
      renderIcon(icon.size, bg, game.glyph, icon.glyphScale, glyphColors),
    );
    written.push(`${game.out}/icons/${icon.file}`);
  }

  const manifest = {
    name: game.name,
    short_name: game.shortName,
    id: `/${game.id}/`,
    start_url: `/${game.id}/`,
    scope: `/${game.id}/`,
    display: 'standalone',
    orientation: game.orientation,
    background_color: guard,
    theme_color: guard,
    icons: ICONS.filter((i) => i.purpose !== 'apple').map((i) => ({
      src: `/${game.id}/icons/${i.file}`,
      sizes: `${i.size}x${i.size}`,
      type: 'image/png',
      purpose: i.purpose,
    })),
  };
  const manifestPath = path.join(ROOT, game.out, 'manifest.webmanifest');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  written.push(`${game.out}/manifest.webmanifest`);

  if (game.shortName.length > 12) throw new Error(`${game.id}: short_name > 12 chars (§1.2)`);
  console.log(`${game.id}: bg ${bg}  guard ${guard}  -> ${written.length} files`);
}

for (const game of GAMES) writeGame(game);
