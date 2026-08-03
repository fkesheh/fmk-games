// ============================================================================
// PWA layer (docs/TOUCH_PWA.md §2, task T2) — everything the platform server
// serves so a game can be installed to a home screen and launched fullscreen.
//
// WHAT THIS FILE IS. The service worker is JAVASCRIPT SHIPPED TO A BROWSER, not
// server code, so it cannot be a normal module here: platform/server is bundled
// by esbuild for node (`--platform=node`) and there is no client build step for
// the platform (the launcher page is generated inline for the same reason). The
// worker is therefore authored as a source STRING that this module stamps with
// per-scope constants. Consequence that matters for the §7 gate: the worker is
// inlined into `platform/server/dist/server.js` by the existing build command,
// so it is present in the built output by construction — there is no asset that
// can be forgotten by a COPY or dropped by a bundler.
//
// FROZEN PATHS (§2.0) — these are the T1/T2 interface and are not negotiable:
//   /sw.js                     scope /
//   /<gameId>/sw.js            scope /<gameId>/       (a worker's scope can
//   /manifest.webmanifest                              never exceed its own
//   /icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon}.png
// T1 writes the registration calls against these; this module makes them serve.
//
// STRATEGY, PER ASSET CLASS (§2.1):
//   documents (navigations, *.html, directory URLs)  NETWORK-FIRST
//       A cache-first document is how a PWA gets permanently stuck on an old
//       build. Network-first means a deploy is live on the FIRST reload: the
//       new index.html names new content-hashed bundles, which are cache
//       misses, so they come from the network too.
//   content-hashed build assets (<base>assets/…)     CACHE-FIRST
//       Vite puts a content hash in the filename, so the URL is immutable: a
//       new build is a new URL, never new bytes at an old URL. This is the only
//       class where cache-first is safe, and it is what makes a launch instant.
//   everything else in scope (icons, manifest)       STALE-WHILE-REVALIDATE
//       Unhashed but rarely changing: serve instantly, refresh in background.
//   everything else                                  PASS THROUGH, untouched
//       Non-GET, cross-origin, range requests, and — explicitly — /ws. The
//       multiplayer transport is a WebSocket; a worker that touches it breaks
//       every game silently. (A WebSocket handshake does not even generate a
//       fetch event, so the /ws guard is defence in depth, not the mechanism.)
//
// CACHE VERSIONING. The cache name embeds a fingerprint of the exact document
// the worker was generated for (the built index.html for a game, the generated
// launcher HTML for /). A new build therefore produces a byte-different sw.js,
// which is precisely the condition the browser uses to install an update; the
// new worker then deletes every cache in ITS OWN namespace that is not the
// current one. The namespace qualifier is load-bearing: CacheStorage is shared
// per ORIGIN, so a launcher worker that deleted "every non-matching cache"
// literally would delete the four games' caches on every activate.
//
// DEV (§2.1 "disabled in dev"). When a game is proxied to a live vite dev
// server, its sw.js is served as a SELF-DESTRUCTING worker: it unregisters
// itself and drops its caches. Not registering is not enough — a worker
// installed by an earlier production build on the same origin (localhost is the
// same origin for both) would otherwise keep serving cached bundles over the
// top of vite, which is exactly the debugging nightmare the contract forbids.
// ============================================================================
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import type { AssetResponse, Mount } from './net.js';

/** Colour tokens the PWA surfaces need, sourced from the launcher's LPAL. */
export interface PwaColors {
  readonly ink: string; // page floor; also background_color / theme_color
  readonly paper: string; // primary type
  readonly steel: string; // secondary type
  readonly metalDark: string; // hairlines
}

/** One game's identity: the accent + tint its offline card and icons use. */
export interface PwaIdentity {
  readonly accent: string;
  readonly tint: string;
}

export interface PwaGame {
  readonly id: string;
  readonly name: string;
  readonly identity: PwaIdentity;
}

export interface PwaOptions {
  readonly games: readonly PwaGame[];
  readonly colors: PwaColors;
  readonly identities: readonly PwaIdentity[]; // launcher icon glyph colours
  readonly launcherHtml: string;
  readonly mounts: readonly Mount[];
  readonly launcherName: string; // <title>-independent install name
  readonly launcherShortName: string; // ≤ 12 chars (§1.2)
}

const ICON_FILES = [
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
] as const;

const NO_CACHE = 'no-cache';
const JS_TYPE = 'text/javascript; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';

function fingerprint(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 10);
}

// ---------------------------------------------------------------------------
// SERVICE WORKER SOURCE
// ---------------------------------------------------------------------------

interface SwConfig {
  readonly scopeKey: string; // 'root' | gameId — namespaces the cache keys
  readonly version: string;
  readonly offlineUrl: string;
  readonly precache: readonly string[];
  readonly ownExact: readonly string[];
  readonly ownPrefix: readonly string[];
  readonly hashedPrefix: readonly string[];
  /**
   * true  — an offline navigation may serve the cached shell (the launcher is
   *         a static page and is genuinely usable with no network).
   * false — an offline navigation always serves the offline card. A game is
   *         multiplayer: its shell would boot and then hang, and §2.2 requires
   *         a legible failure over a blank canvas.
   */
  readonly preferShellOffline: boolean;
}

/** JSON is a valid JS literal here and escapes quotes/newlines for us. */
function lit(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * The worker itself. Written in ES5-flavoured JS with no template literals so
 * it can live inside one (nothing here needs escaping), and with no imports so
 * it needs no build step.
 */
function swSource(cfg: SwConfig): string {
  const prefix = `arcade-${cfg.scopeKey}-`;
  return `// GENERATED by platform/server/src/pwa.ts — do not edit; see docs/TOUCH_PWA.md §2.
'use strict';
var CACHE_PREFIX = ${lit(prefix)};
var CACHE = ${lit(prefix + cfg.version)};
var OFFLINE_URL = ${lit(cfg.offlineUrl)};
var PRECACHE = ${lit(cfg.precache)};
var OWN_EXACT = ${lit(cfg.ownExact)};
var OWN_PREFIX = ${lit(cfg.ownPrefix)};
var HASHED_PREFIX = ${lit(cfg.hashedPrefix)};
var PREFER_SHELL_OFFLINE = ${cfg.preferShellOffline ? 'true' : 'false'};

function owns(p) {
  for (var i = 0; i < OWN_EXACT.length; i++) if (OWN_EXACT[i] === p) return true;
  for (var j = 0; j < OWN_PREFIX.length; j++) if (p.indexOf(OWN_PREFIX[j]) === 0) return true;
  return false;
}
function isHashed(p) {
  for (var i = 0; i < HASHED_PREFIX.length; i++) if (p.indexOf(HASHED_PREFIX[i]) === 0) return true;
  return false;
}
function isDocument(req, p) {
  if (req.mode === 'navigate' || req.destination === 'document') return true;
  return p.charAt(p.length - 1) === '/' || p.slice(-5) === '.html';
}
// Only same-origin, complete, 200 responses may enter the cache. A 206 makes
// cache.put throw, and an opaque response would poison the cache with a body
// we cannot read.
function cacheable(res) {
  return !!res && res.status === 200 && res.type === 'basic';
}
function offlineFallback(cache) {
  return cache.match(OFFLINE_URL).then(function (hit) {
    return hit || new Response(
      '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
        '<body style="font:16px system-ui;padding:2rem">You are offline. ' +
        '<a href="' + OFFLINE_URL + '">Try again</a></body>',
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // allSettled, not cache.addAll: addAll is atomic, so one asset that is
      // not on disk yet (an icon a sibling task has not landed) would abort the
      // whole install and leave the page with no worker at all.
      return Promise.allSettled(
        PRECACHE.map(function (url) {
          return fetch(new Request(url, { cache: 'reload' })).then(function (res) {
            if (cacheable(res)) return cache.put(url, res);
          });
        }),
      );
    }).then(function () {
      // Take over immediately. The alternative (waiting for every tab to
      // close) is the classic way a PWA strands a user on an old build, and
      // the contract ranks staleness as the worse failure.
      return self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (k) {
          // CacheStorage is per-origin and shared with the other four workers,
          // so only this worker's own namespace is swept.
          if (k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE) return caches.delete(k);
          return null;
        }),
      );
    }).then(function () {
      return self.clients.claim();
    }),
  );
});

function networkFirstDocument(event, req) {
  return caches.open(CACHE).then(function (cache) {
    return fetch(req).then(function (res) {
      if (cacheable(res)) event.waitUntil(cache.put(req, res.clone()));
      return res;
    }).catch(function () {
      if (!PREFER_SHELL_OFFLINE) return offlineFallback(cache);
      return cache.match(req, { ignoreSearch: true }).then(function (hit) {
        return hit || offlineFallback(cache);
      });
    });
  });
}

function cacheFirst(event, req) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (cacheable(res)) event.waitUntil(cache.put(req, res.clone()));
        return res;
      }).catch(function () {
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    });
  });
}

function staleWhileRevalidate(event, req) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(req).then(function (hit) {
      var live = fetch(req).then(function (res) {
        if (cacheable(res)) return cache.put(req, res.clone()).then(function () { return res; });
        return res;
      });
      if (hit) {
        event.waitUntil(live.catch(function () {}));
        return hit;
      }
      return live.catch(function () {
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  // Anything not answered here falls through to the network untouched.
  if (req.method !== 'GET') return;
  if (req.headers.get('range')) return;
  if (req.headers.get('upgrade')) return;
  var url;
  try {
    url = new URL(req.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  var p = url.pathname;
  // NEVER the multiplayer transport (docs/TOUCH_PWA.md §2.1).
  if (p === '/ws' || p.indexOf('/ws/') === 0) return;
  if (!owns(p)) return;
  if (isDocument(req, p)) {
    event.respondWith(networkFirstDocument(event, req));
    return;
  }
  if (isHashed(p)) {
    event.respondWith(cacheFirst(event, req));
    return;
  }
  event.respondWith(staleWhileRevalidate(event, req));
});
`;
}

/**
 * The dev-mode worker: a kill switch. Unregisters itself and drops every cache
 * in its namespace, so a worker left behind by a production build cannot serve
 * stale bundles over a vite dev server.
 */
function swKillSwitch(scopeKey: string): string {
  return `// GENERATED by platform/server/src/pwa.ts — DEV MODE kill switch.
// A vite dev server is answering this game's prefix, so caching is disabled
// (docs/TOUCH_PWA.md §2.1). This worker exists only to remove any worker a
// previous production build installed on this origin.
'use strict';
var CACHE_PREFIX = ${lit(`arcade-${scopeKey}-`)};
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k.indexOf(CACHE_PREFIX) === 0 ? caches.delete(k) : null;
      }));
    }).then(function () {
      return self.registration.unregister();
    }).then(function () {
      return self.clients.matchAll({ type: 'window' });
    }).then(function (clients) {
      clients.forEach(function (c) { c.navigate(c.url); });
    }),
  );
});
`;
}

// ---------------------------------------------------------------------------
// OFFLINE CARD (§2.2)
// ---------------------------------------------------------------------------

/**
 * What a parent sees when a launch has no network. Deliberately not the game
 * shell: these games are multiplayer, so the shell would boot and then sit on a
 * black canvas forever. One sentence, one big button, and a self-retry when the
 * connection comes back.
 */
function offlineHtml(colors: PwaColors, title: string, accent: string, home: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="${colors.ink}" />
    <title>${title} — offline</title>
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; height: 100%; background: ${colors.ink}; color: ${colors.paper}; }
      body {
        display: flex; align-items: center; justify-content: center;
        padding: calc(24px + env(safe-area-inset-top, 0px)) calc(24px + env(safe-area-inset-right, 0px))
                 calc(24px + env(safe-area-inset-bottom, 0px)) calc(24px + env(safe-area-inset-left, 0px));
        font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; line-height: 1.5;
        text-align: center; -webkit-font-smoothing: antialiased;
      }
      .card {
        max-width: 30rem; display: flex; flex-direction: column; align-items: center; gap: 18px;
        padding: 32px 26px; border: 1px solid ${colors.metalDark}; border-radius: 18px;
      }
      .plug {
        width: 64px; height: 64px; border-radius: 50%;
        border: 3px solid ${accent};
        background-image: linear-gradient(135deg, transparent calc(50% - 2px), ${accent} calc(50% - 2px) calc(50% + 2px), transparent calc(50% + 2px));
      }
      h1 { margin: 0; font-size: clamp(22px, 6vw, 30px); letter-spacing: 0.1em; }
      .who { margin: 0; font-size: 12px; letter-spacing: 0.28em; text-transform: uppercase; color: ${accent}; }
      p { margin: 0; color: ${colors.steel}; font-size: clamp(15px, 4vw, 17px); }
      button {
        font: inherit; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;
        min-height: 56px; padding: 0 32px; border-radius: 999px; border: 0; cursor: pointer;
        background: ${accent}; color: ${colors.ink}; touch-action: manipulation;
      }
      a { color: ${colors.steel}; font-size: 14px; }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="plug" aria-hidden="true"></div>
      <p class="who">${title}</p>
      <h1>No internet</h1>
      <p>This game is played with other people, so it needs a connection. Check the Wi-Fi, then try again.</p>
      <button type="button" onclick="location.reload()">Try again</button>
      <a href="${home}">All games</a>
    </main>
    <script>
      // Come back on its own the moment the network returns.
      addEventListener('online', function () { location.reload(); });
    </script>
  </body>
</html>
`;
}

// ---------------------------------------------------------------------------
// LAUNCHER MANIFEST + ICONS
// ---------------------------------------------------------------------------

function launcherManifest(opts: PwaOptions): string {
  return `${JSON.stringify(
    {
      name: opts.launcherName,
      short_name: opts.launcherShortName,
      description: 'Four browser multiplayer games on one server.',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'any',
      background_color: opts.colors.ink,
      theme_color: opts.colors.ink,
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2,
  )}\n`;
}

// ---- minimal PNG encoder (no deps, no binary assets in the repo) ------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode an RGBA byte array (size*size*4) as a PNG. */
function encodePng(size: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size * 4; x++) raw[rowStart + 1 + x] = rgba[y * size * 4 + x] as number;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * The launcher icon: the four games' signature colours as a 2x2 of rounded
 * tiles on the platform's ink. A 4-year-old navigates a home screen by shape
 * and colour, and this reads as "the box with all the games in it" next to the
 * four single-colour game icons. Rendered at 2x and box-downsampled so the
 * rounded corners are not staircased — no fonts, no external assets (§1.4).
 */
function launcherIcon(
  size: number,
  maskable: boolean,
  colors: PwaColors,
  identities: readonly PwaIdentity[],
): Buffer {
  const ss = 2; // supersample factor
  const n = size * ss;
  const px = new Uint8Array(n * n * 4);
  const [br, bg, bb] = hexRgb(colors.ink);
  for (let i = 0; i < n * n; i++) {
    px[i * 4] = br;
    px[i * 4 + 1] = bg;
    px[i * 4 + 2] = bb;
    px[i * 4 + 3] = 255;
  }
  // A maskable icon may be cropped to a circle of 80% of the canvas, so its
  // glyph is inset harder — it must survive the crop, not merely fit the square.
  const span = maskable ? 0.58 : 0.72;
  const gap = n * 0.035;
  const block = n * span;
  const originX = (n - block) / 2;
  const originY = (n - block) / 2;
  const tile = (block - gap) / 2;
  const radius = tile * 0.26;
  const tiles = identities.slice(0, 4);
  for (let t = 0; t < tiles.length; t++) {
    const ident = tiles[t];
    if (ident === undefined) continue;
    const [r, g, b] = hexRgb(ident.accent);
    const x0 = originX + (t % 2) * (tile + gap);
    const y0 = originY + Math.floor(t / 2) * (tile + gap);
    for (let y = Math.floor(y0); y < Math.ceil(y0 + tile); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x0 + tile); x++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        // rounded-rect test: clamp to the inner rect, measure the corner radius
        const cx = Math.min(Math.max(x + 0.5, x0 + radius), x0 + tile - radius);
        const cy = Math.min(Math.max(y + 0.5, y0 + radius), y0 + tile - radius);
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > radius) continue;
        const i = (y * n + x) * 4;
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
        px[i + 3] = 255;
      }
    }
  }
  // box-downsample ss x ss
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const i = ((y * ss + dy) * n + (x * ss + dx)) * 4;
          r += px[i] as number;
          g += px[i + 1] as number;
          b += px[i + 2] as number;
        }
      }
      const o = (y * size + x) * 4;
      const area = ss * ss;
      out[o] = Math.round(r / area);
      out[o + 1] = Math.round(g / area);
      out[o + 2] = Math.round(b / area);
      out[o + 3] = 255; // always opaque: iOS composites apple-touch-icon on white
    }
  }
  return encodePng(size, out);
}

// ---------------------------------------------------------------------------
// ROUTING
// ---------------------------------------------------------------------------

/**
 * Pull the same-origin absolute asset URLs out of a built index.html so the
 * worker can precache exactly what that document needs (vite emits
 * `<base>assets/<name>-<hash>.js|css`, plus whatever T1's PWA head adds).
 */
export function extractAssetUrls(html: string, prefix: string): string[] {
  const urls = new Set<string>();
  const attr = /(?:src|href)\s*=\s*"([^"]+)"/g;
  let m = attr.exec(html);
  while (m !== null) {
    const raw = m[1];
    if (raw !== undefined && raw.startsWith(prefix) && !raw.startsWith('//')) urls.add(raw);
    m = attr.exec(html);
  }
  return [...urls];
}

/**
 * Serve the PWA surface. Consulted BEFORE the game mounts so `/kart/sw.js`
 * cannot be swallowed by that mount's SPA fallback (which answers any miss with
 * index.html — a worker registration against an HTML body fails on MIME).
 */
export function createPwaResolver(
  opts: PwaOptions,
): (pathname: string) => Promise<AssetResponse | null> {
  const { colors, games, launcherHtml } = opts;
  const byId = new Map(games.map((g) => [g.id, g]));
  const mountFor = new Map(opts.mounts.map((m) => [m.prefix, m]));

  const launcherVersion = fingerprint(launcherHtml);
  const manifest = launcherManifest(opts);
  const launcherOffline = offlineHtml(
    colors,
    opts.launcherShortName,
    opts.identities[0]?.accent ?? colors.paper,
    '/',
  );
  const icons = new Map<string, Buffer>([
    ['icon-192.png', launcherIcon(192, false, colors, opts.identities)],
    ['icon-512.png', launcherIcon(512, false, colors, opts.identities)],
    ['icon-maskable-512.png', launcherIcon(512, true, colors, opts.identities)],
    ['apple-touch-icon.png', launcherIcon(180, false, colors, opts.identities)],
  ]);

  const launcherSw = swSource({
    scopeKey: 'root',
    version: launcherVersion,
    offlineUrl: '/offline.html',
    // The launcher document is generated inline and has no external assets
    // beyond its own PWA surface, so this list is the whole shell.
    precache: ['/', '/offline.html', '/manifest.webmanifest', ...ICON_FILES.map((f) => `/icons/${f}`)],
    // Scope '/' would otherwise make this worker the controller for every game
    // page whose own worker is not registered yet, and it would then cache four
    // games' bundles under the launcher's version. It owns its own files only.
    ownExact: ['/', '/offline.html', '/manifest.webmanifest'],
    ownPrefix: ['/icons/'],
    hashedPrefix: [],
    preferShellOffline: true, // the launcher is a static page: it works offline
  });

  async function gameSw(game: PwaGame): Promise<AssetResponse> {
    const prefix = `/${game.id}/`;
    const mount = mountFor.get(prefix);
    if (mount === undefined || mount.kind === 'proxy') {
      // dev (or not built): kill switch, never a caching worker
      return { body: swKillSwitch(game.id), contentType: JS_TYPE, cacheControl: NO_CACHE };
    }
    let html: string;
    try {
      html = await readFile(path.join(mount.dir, 'index.html'), 'utf8');
    } catch {
      return { body: swKillSwitch(game.id), contentType: JS_TYPE, cacheControl: NO_CACHE };
    }
    // Fingerprinting the built document is what makes an update deterministic:
    // a new build changes index.html (new hashed bundle names), which changes
    // these bytes, which is the browser's trigger to install a new worker.
    return {
      body: swSource({
        scopeKey: game.id,
        version: fingerprint(html),
        offlineUrl: `${prefix}offline.html`,
        precache: [prefix, `${prefix}offline.html`, ...extractAssetUrls(html, prefix)],
        ownExact: [],
        ownPrefix: [prefix],
        hashedPrefix: [`${prefix}assets/`],
        preferShellOffline: false, // multiplayer: an offline shell would hang
      }),
      contentType: JS_TYPE,
      cacheControl: NO_CACHE,
    };
  }

  return async function resolve(pathname: string): Promise<AssetResponse | null> {
    if (pathname === '/sw.js') {
      // The launcher page only registers this in production (see index.ts), but
      // serve the kill switch in dev so a stale worker is cleaned up too.
      const dev = opts.mounts.some((m) => m.kind === 'proxy');
      return {
        body: dev ? swKillSwitch('root') : launcherSw,
        contentType: JS_TYPE,
        cacheControl: NO_CACHE,
      };
    }
    if (pathname === '/offline.html') {
      return { body: launcherOffline, contentType: HTML_TYPE, cacheControl: NO_CACHE };
    }
    if (pathname === '/manifest.webmanifest') {
      return { body: manifest, contentType: 'application/manifest+json; charset=utf-8', cacheControl: NO_CACHE };
    }
    if (pathname.startsWith('/icons/')) {
      const png = icons.get(pathname.slice('/icons/'.length));
      if (png === undefined) return null;
      return { body: png, contentType: 'image/png', cacheControl: 'public, max-age=86400' };
    }

    const slash = pathname.indexOf('/', 1);
    if (slash < 0) return null;
    const game = byId.get(pathname.slice(1, slash));
    if (game === undefined) return null;
    const rest = pathname.slice(slash + 1);
    if (rest === 'sw.js') return gameSw(game);
    if (rest === 'offline.html') {
      return {
        body: offlineHtml(colors, game.name, game.identity.accent, '/'),
        contentType: HTML_TYPE,
        cacheControl: NO_CACHE,
      };
    }
    return null;
  };
}
