// ============================================================================
// Platform entry: wire NetServer <-> Lobby over the game registry, serve the
// generated launcher page at / and every registered game under /<gameId>/ —
// PROXIED to its vite dev server when GameModule.devPort answers (dev mode,
// per-prefix HMR included), else its built client dist with SPA fallback
// (production; games without a build on disk are listed but not mounted) —
// run the 1s stale sweep (closes sockets of input-stale/kicked players; the
// lobby reaps empty rooms in the same poll), and shut down cleanly on
// SIGTERM/SIGINT. A throwing hook must never kill the process: net.ts wraps
// hook calls, the lobby wraps its bodies, and the sweep wraps its poll.
// ============================================================================
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { GameModule } from '@platform/shared';
import { NetServer, probeDevServer, type Mount } from './net.js';
import { Lobby } from './lobby.js';
import { createPwaResolver, type PwaIdentity } from './pwa.js';
import { GAMES } from './registry.js';

const PORT = Number(process.env.PORT ?? 8080);

/**
 * Mounts for the multi-game layout: one '/<id>/' prefix per registered
 * module. A module whose devPort answers the one-shot probe is proxied to
 * that vite dev server (single dev entry point through this server);
 * otherwise its built client (index.html on disk) is served statically —
 * the only mode possible in production, where no vite server runs. A game
 * with neither is skipped here but still appears on the launcher (404s).
 */
async function resolveMounts(modules: readonly GameModule[]): Promise<Mount[]> {
  const resolved = await Promise.all(
    modules.map(async (mod): Promise<Mount | null> => {
      const prefix = `/${mod.id}/`;
      if (mod.devPort !== undefined && (await probeDevServer(mod.devPort, prefix))) {
        return { kind: 'proxy', prefix, port: mod.devPort };
      }
      if (existsSync(path.join(mod.clientDist, 'index.html'))) {
        return { kind: 'static', prefix, dir: mod.clientDist };
      }
      return null;
    }),
  );
  return resolved.filter((m): m is Mount => m !== null);
}

/** Registry values are trusted constants; escape anyway before inlining into HTML. */
function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ---------------------------------------------------------------------------
// LAUNCHER PAGE (VISUAL_UPGRADE.md §7, task P1) — the product's front door.
//
// COLOUR SOURCING. This file is the platform composition root's sibling and
// must NOT import a game's shared package (package.json here depends on the
// game SERVER packages only, and platform code does not reach into game
// internals). §0 still bans ad-hoc hex, so the launcher's small colour set is
// declared ONCE below as named constants, each MIRRORING an exact entry of a
// frozen game palette — the source entry is named in the comment. This is the
// same discipline as the `:root` palette mirrors in the game stylesheets
// (§7 seam rule 7): every value is traceable, nothing is eyeballed.
//
// Where a colour needs transparency, an 8-digit hex is built by suffixing an
// alpha pair onto one of these constants (e.g. `${LPAL.paper}14`). The RGB
// always comes from a named entry; only the alpha is authored here.
// ---------------------------------------------------------------------------

const LPAL = {
  // ---- room (mirrors games/fps/shared/src/palette.ts) ----
  ink: '#14171c', //        PALETTE.ink      — page floor
  inkDeep: '#070a08', //    BPAL.inkDeep     — vignette / drop-shadow floor
  charcoal: '#23282f', //   PALETTE.charcoal — raised surface
  metalDark: '#3c4249', //  PALETTE.metalDark— hairline borders
  metalDeep: '#21252a', //  PALETTE.metalDeep— card body
  paper: '#e8e6df', //      PALETTE.paper    — primary type
  steel: '#9aa3ad', //      PALETTE.steel    — secondary type
  steelDeep: '#5a616a', //  KPAL.steelDeep   — tertiary type

  // ---- per-game identity accents (each game's own signature colour) ----
  fpsAccent: '#e5b055', //  PALETTE.tLit     — STRICKEN: dusk amber
  fpsTint: '#8a7550', //    PALETTE.dust     — STRICKEN: packed-earth ground
  bankAccent: '#d8b45a', // BPAL.gold        — BANK: table gold
  bankTint: '#1d5c3f', //   BPAL.felt        — BANK: felt
  kartAccent: '#7fa4c9', // KPAL.sky         — KART GP: arcade sky
  kartTint: '#4a7a3d', //   KPAL.grass       — KART GP: verge green
  wordbombAccent: '#f0a63c', // WPAL.fuse    — WORDBOMB: the lit fuse
  wordbombTint: '#28303a', //  WPAL.slate    — WORDBOMB: dark-room slate
  riftAccent: '#d9b25f', //    APAL.gold     — ANCIENTS: ancient gold
  riftTint: '#2e3827', //      APAL.moss     — ANCIENTS: dusk moss

  // ---- fallback identity for a game with no launcher copy yet ----
  neutralAccent: '#9aa3ad', // PALETTE.steel
  neutralTint: '#3c4249', //   PALETTE.metalDark
} as const;

interface GameCopy {
  genre: string;
  blurb: string;
  tags: readonly string[];
}

/**
 * Launcher copy per registered game id. A module missing from this map still
 * gets a card (neutral identity, generic copy) — the launcher never hides a
 * registered game.
 */
const COPY: Record<string, GameCopy | undefined> = {
  fps: {
    genre: 'Tactical FPS',
    blurb:
      'Round-based 7v7. Buy your loadout, hold the angle, one life per round — across six hand-built maps.',
    tags: ['6 maps'],
  },
  bank: {
    genre: 'Push-your-luck dice',
    blurb: 'Roll to grow the pot, bank before it busts. One bad die wipes the table clean.',
    tags: ['Party'],
  },
  kart: {
    genre: 'Arcade racer',
    blurb: 'Twenty karts, drift boost and nitro. Three laps, and the brake is a suggestion.',
    tags: ['Drift + nitro'],
  },
  wordbomb: {
    genre: 'Simultaneous word game',
    blurb:
      "Same three letters for everyone, a fuse nobody can see. Match someone else's word and you split the points.",
    tags: ['10 rounds'],
  },
  rift: {
    genre: 'Mini MOBA',
    blurb:
      'Push lanes, last-hit for gold, raze towers. Break their Ancient before they break yours — 2v2 to 8v8, bots fill the rest.',
    tags: ['2v2–8v8', 'Bot fill'],
  },
};

/**
 * The launcher page at `/`, generated inline (no build step): a product page
 * for the platform — wordmark, then one identity-coloured card per registered
 * game linking to its /<id>/ client. Responsive down to one column; all colour
 * comes from `LPAL`.
 */
const LAUNCHER_NAME = 'ARCADE — four browser multiplayer games';
const LAUNCHER_SHORT_NAME = 'ARCADE'; // ≤ 12 chars so a home-screen label is not truncated (§1.2)

/**
 * Per-game identity colours, reusing the launcher's own card accents so the
 * offline card and the launcher icon can never drift from the page (§1.2's
 * single-source-of-truth rule applied to the PWA surface).
 */
const IDENTITY: Record<string, PwaIdentity | undefined> = {
  fps: { accent: LPAL.fpsAccent, tint: LPAL.fpsTint },
  bank: { accent: LPAL.bankAccent, tint: LPAL.bankTint },
  kart: { accent: LPAL.kartAccent, tint: LPAL.kartTint },
  wordbomb: { accent: LPAL.wordbombAccent, tint: LPAL.wordbombTint },
};
const NEUTRAL_IDENTITY: PwaIdentity = {
  accent: LPAL.neutralAccent,
  tint: LPAL.neutralTint,
};

/**
 * `registerSw` is the §2.1 "disabled in dev" guard. Dev is defined as "a vite
 * dev server is answering at least one game prefix" — precisely the situation
 * the contract calls a debugging nightmare — rather than NODE_ENV, which the
 * e2e harness does not set and which would silently switch the worker off in
 * the one automated run that exercises it.
 */
function launcherHtml(modules: readonly GameModule[], registerSw: boolean): string {
  const swScript = registerSw
    ? `    <script>
      // PWA (docs/TOUCH_PWA.md §2.0): scope '/' is the launcher's own, and the
      // worker only touches launcher files — each game's page is controlled by
      // its own /<gameId>/sw.js. Guarded so an absent worker is a no-op.
      if ('serviceWorker' in navigator) {
        addEventListener('load', function () {
          navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
        });
      }
    </script>\n`
    : '';
  const cards = modules
    .map((m) => {
      const known = Object.prototype.hasOwnProperty.call(COPY, m.id);
      const copy = COPY[m.id];
      const id = escapeHtml(m.id);
      const kind = known ? ` card--${id}` : '';
      const mark = known ? ` mark--${id}` : '';
      // Seat range comes from the module, never from hand-written copy —
      // every hardcoded count on this page had gone stale.
      const seats = `${m.minPlayers}\u2013${m.maxPlayers} players`;
      const tags = [seats, ...(copy?.tags ?? [])]
        .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
        .join('');
      return (
        `      <a class="card${kind}" href="/${id}/">\n` +
        `        <span class="mark${mark}" aria-hidden="true"></span>\n` +
        `        <span class="head">\n` +
        `          <span class="name">${escapeHtml(m.name)}</span>\n` +
        `          <span class="genre">${escapeHtml(copy?.genre ?? 'Multiplayer')}</span>\n` +
        `        </span>\n` +
        `        <span class="blurb">${escapeHtml(copy?.blurb ?? 'Jump in and play.')}</span>\n` +
        `        <span class="tags">${tags}<span class="tag path">/${id}/</span></span>\n` +
        `        <span class="cta"><span>Enter</span><span class="arrow">&rarr;</span></span>\n` +
        `      </a>`
      );
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark" />
    <meta name="description" content="Four browser multiplayer games on one server: STRICKEN, BANK, KART GP and WORDBOMB." />
    <title>ARCADE — STRICKEN · BANK · KART GP · WORDBOMB</title>
    <!-- PWA install surface (docs/TOUCH_PWA.md §1). theme-color MUST stay
         byte-equal to the page floor below (LPAL.ink) or the launch flashes.
         The apple-* tags are not decoration: display:standalone alone does NOT
         give iOS a fullscreen install — without them the home-screen icon opens
         a Safari chrome window and the whole exercise fails on the iPad. -->
    <meta name="theme-color" content="${LPAL.ink}" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="${LAUNCHER_SHORT_NAME}" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
    <link rel="icon" href="/icons/icon-192.png" type="image/png" />
    <style>
      * { box-sizing: border-box; }
      html { -webkit-text-size-adjust: 100%; }
      body {
        margin: 0; min-height: 100vh; display: flex; flex-direction: column;
        color: ${LPAL.paper};
        background-color: ${LPAL.ink};
        /* Four washes, one per game, on four non-overlapping anchors — upper
           left, upper right, mid-left flank, bottom centre — so no two tints
           stack into mud. WORDBOMB's slate is the coolest and takes the
           otherwise-empty mid-left band between the fps and bank pools. */
        background-image:
          radial-gradient(90ch 52ch at 18% -12%, ${LPAL.fpsTint}2e, transparent 62%),
          radial-gradient(80ch 46ch at 84% 6%, ${LPAL.kartTint}26, transparent 60%),
          radial-gradient(64ch 42ch at 0% 54%, ${LPAL.wordbombTint}44, transparent 60%),
          radial-gradient(120ch 70ch at 50% 118%, ${LPAL.bankTint}26, transparent 64%),
          linear-gradient(180deg, ${LPAL.charcoal} 0%, ${LPAL.ink} 46%, ${LPAL.inkDeep} 100%);
        background-attachment: fixed;
        font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
        font-size: 16px; line-height: 1.5;
        -webkit-font-smoothing: antialiased;
      }
      .page {
        margin: auto; width: 100%; max-width: 1060px;
        /* Safe-area insets (§3): an installed iOS launch uses
           apple-mobile-web-app-status-bar-style: black-translucent, so the page
           starts UNDER the status bar and the notch/home indicator. */
        padding:
          calc(clamp(36px, 7vh, 88px) + env(safe-area-inset-top, 0px))
          calc(clamp(16px, 4vw, 32px) + env(safe-area-inset-right, 0px))
          calc(clamp(36px, 7vh, 88px) + env(safe-area-inset-bottom, 0px))
          calc(clamp(16px, 4vw, 32px) + env(safe-area-inset-left, 0px));
        display: flex; flex-direction: column; gap: clamp(26px, 4.4vh, 46px);
      }

      /* ---- hero ---- */
      .hero { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 14px; }
      .eyebrow {
        margin: 0; font-size: clamp(10px, 1.5vw, 12px); font-weight: 600;
        letter-spacing: 0.42em; text-indent: 0.42em; text-transform: uppercase;
        color: ${LPAL.steel};
      }
      h1 {
        margin: 0; font-size: clamp(40px, 11vw, 82px); font-weight: 900; line-height: 0.98;
        letter-spacing: 0.18em; text-indent: 0.18em;
        color: ${LPAL.paper};
        /* Four accents, hue-ordered hot -> cool so the sweep never doubles
           back: WORDBOMB's saturated fuse orange leads, the two near-identical
           ambers (fps dusk, bank gold) are packed close in the middle so they
           read as one warm body rather than two wasted thirds, and KART's sky
           takes the long cool tail. */
        background-image: linear-gradient(96deg, ${LPAL.wordbombAccent} 5%, ${LPAL.fpsAccent} 30%, ${LPAL.bankAccent} 48%, ${LPAL.kartAccent} 95%);
        -webkit-background-clip: text; background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      .rule {
        width: min(320px, 70%); height: 1px; border: 0; margin: 2px 0 0;
        background: linear-gradient(90deg, transparent, ${LPAL.paper}3d, transparent);
      }
      .lede {
        margin: 0; max-width: 54ch; font-size: clamp(14px, 1.9vw, 17px); color: ${LPAL.steel};
      }

      /* ---- cards ---- */
      /* One column when narrow. Above that, an even 2x2: with four games,
         auto-fit settles on three columns at this max-width and orphans the
         fourth card alone on its own row. The 760px cap keeps each card at
         roughly the width three columns used to give it. */
      .grid {
        display: grid; gap: clamp(14px, 2vw, 20px);
        grid-template-columns: repeat(auto-fit, minmax(248px, 1fr));
      }
      @media (min-width: 640px) {
        .grid {
          grid-template-columns: repeat(2, 1fr);
          max-width: 760px; margin-inline: auto; width: 100%;
        }
      }
      .card {
        --accent: ${LPAL.neutralAccent};
        --tint: ${LPAL.neutralTint};
        --wash: ${LPAL.neutralTint}2b;
        --halo: ${LPAL.neutralAccent}1f;
        position: relative; overflow: hidden;
        display: flex; flex-direction: column; align-items: flex-start; gap: 13px;
        padding: 22px 20px 18px;
        border: 1px solid ${LPAL.metalDark}; border-radius: 16px;
        background-image:
          radial-gradient(72ch 30ch at 12% -18%, var(--wash), transparent 66%),
          linear-gradient(168deg, ${LPAL.charcoal} 0%, ${LPAL.metalDeep} 58%, ${LPAL.ink} 100%);
        box-shadow: 0 1px 0 ${LPAL.paper}0f inset, 0 14px 30px -18px ${LPAL.inkDeep};
        color: inherit; text-decoration: none;
        transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
      }
      .card::before {
        content: ''; position: absolute; inset: 0 0 auto; height: 2px;
        background: linear-gradient(90deg, transparent, var(--accent), transparent);
        opacity: 0.8;
      }
      .card--fps { --accent: ${LPAL.fpsAccent}; --tint: ${LPAL.fpsTint}; --wash: ${LPAL.fpsTint}3d; --halo: ${LPAL.fpsAccent}2b; }
      .card--bank { --accent: ${LPAL.bankAccent}; --tint: ${LPAL.bankTint}; --wash: ${LPAL.bankTint}4d; --halo: ${LPAL.bankAccent}2b; }
      .card--kart { --accent: ${LPAL.kartAccent}; --tint: ${LPAL.kartTint}; --wash: ${LPAL.kartTint}3d; --halo: ${LPAL.kartAccent}2b; }
      /* WORDBOMB's tint is the darkest of the four (WPAL.slate, L 19), so its
         wash carries more alpha to land at the same visual weight. */
      .card--wordbomb { --accent: ${LPAL.wordbombAccent}; --tint: ${LPAL.wordbombTint}; --wash: ${LPAL.wordbombTint}70; --halo: ${LPAL.wordbombAccent}2b; }
      .card--rift { --accent: ${LPAL.riftAccent}; --tint: ${LPAL.riftTint}; --wash: ${LPAL.riftTint}70; --halo: ${LPAL.riftAccent}2b; }

      .mark {
        width: 50px; height: 50px; border-radius: 13px; flex: none;
        border: 1px solid var(--halo);
        background-color: var(--wash);
        background-repeat: no-repeat;
        box-shadow: 0 0 0 1px ${LPAL.inkDeep}66 inset;
      }
      /* Each mark is pure CSS gradient geometry — no assets, no fonts. */
      .mark--fps {
        background-image:
          linear-gradient(var(--accent), var(--accent)),
          linear-gradient(var(--accent), var(--accent)),
          radial-gradient(circle at 50% 50%, transparent 30%, var(--accent) 31%, var(--accent) 36%, transparent 37%);
        background-size: 2px 62%, 62% 2px, 100% 100%;
        background-position: 50% 50%, 50% 50%, 50% 50%;
      }
      .mark--bank {
        background-image:
          linear-gradient(var(--accent), var(--accent)),
          linear-gradient(var(--accent), var(--accent)),
          linear-gradient(var(--accent), var(--accent));
        background-size: 62% 5px, 50% 5px, 38% 5px;
        background-position: 50% 74%, 50% 52%, 50% 30%;
      }
      .mark--kart {
        background-image: repeating-linear-gradient(72deg, var(--accent) 0 3px, transparent 3px 11px);
        background-size: 74% 62%;
        background-position: 50% 50%;
      }
      /* WORDBOMB: a bomb. Four layers, top to bottom — the spark (detached
         from the fuse tip so it reads as a spark and not a pinhead), a short
         steep fuse (the "/" iso-lines of a 155deg gradient), the collar on the
         casing's upper-right shoulder, and the filled casing. The casing is
         solid rather than a ring: outlined, it reads as a magnifying glass. */
      .mark--wordbomb {
        background-image:
          radial-gradient(circle closest-side, var(--accent) 0 42%, transparent 46%),
          linear-gradient(155deg, transparent calc(50% - 1.2px), var(--accent) calc(50% - 1.2px) calc(50% + 1.2px), transparent calc(50% + 1.2px)),
          linear-gradient(var(--accent), var(--accent)),
          radial-gradient(circle closest-side, var(--accent) 0 96%, transparent 100%);
        background-size: 22% 22%, 20% 24%, 16% 10%, 46% 46%;
        background-position: 94% 4%, 80% 30%, 58% 50%, 28% 82%;
      }
      /* ANCIENTS: a monolith gate — two leaning slabs and a floating crystal
         diamond between them, the ancient's silhouette in three layers. */
      .mark--rift {
        background-image:
          linear-gradient(45deg, transparent calc(50% - 1px), var(--accent) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)),
          linear-gradient(-45deg, transparent calc(50% - 1px), var(--accent) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)),
          linear-gradient(100deg, var(--accent), var(--accent)),
          linear-gradient(80deg, var(--accent), var(--accent));
        background-size: 26% 26%, 26% 26%, 14% 52%, 14% 52%;
        background-position: 50% 26%, 50% 26%, 30% 72%, 70% 72%;
      }

      .head { display: flex; flex-direction: column; gap: 3px; }
      .name { font-size: clamp(19px, 2.6vw, 23px); font-weight: 800; letter-spacing: 0.14em; }
      .genre {
        font-size: 11px; font-weight: 600; letter-spacing: 0.24em; text-transform: uppercase;
        color: var(--accent);
      }
      .blurb { font-size: 13.5px; line-height: 1.55; color: ${LPAL.steel}; }
      .tags { display: flex; flex-wrap: wrap; gap: 6px; }
      .tag {
        font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase;
        padding: 3px 8px; border-radius: 999px;
        border: 1px solid ${LPAL.metalDark}; color: ${LPAL.steel};
        background: ${LPAL.ink}80;
      }
      .path {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        text-transform: none; letter-spacing: 0.04em; color: ${LPAL.steelDeep};
      }
      .cta {
        margin-top: auto; width: 100%; padding-top: 13px;
        display: flex; align-items: center; justify-content: space-between;
        border-top: 1px solid ${LPAL.metalDark};
        font-size: 12px; font-weight: 700; letter-spacing: 0.26em; text-transform: uppercase;
        color: var(--accent);
      }
      .arrow { font-size: 15px; transition: transform 160ms ease; }

      .card:hover, .card:focus-visible {
        transform: translateY(-3px);
        border-color: var(--accent);
        box-shadow: 0 1px 0 ${LPAL.paper}1a inset, 0 22px 40px -20px ${LPAL.inkDeep},
                    0 0 0 1px var(--halo);
      }
      .card:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
      .card:hover .arrow, .card:focus-visible .arrow { transform: translateX(4px); }
      .card:active { transform: translateY(-1px); }

      /* ---- footer ---- */
      .foot {
        text-align: center; font-size: 11.5px; letter-spacing: 0.14em; text-transform: uppercase;
        color: ${LPAL.steelDeep};
      }

      @media (max-width: 560px) {
        .card { padding: 18px 16px 15px; gap: 11px; }
        .mark { width: 42px; height: 42px; border-radius: 11px; }
      }
      @media (prefers-reduced-motion: reduce) {
        .card, .arrow { transition: none; }
        .card:hover, .card:focus-visible, .card:active { transform: none; }
        .card:hover .arrow, .card:focus-visible .arrow { transform: none; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <header class="hero">
        <p class="eyebrow">Four games &middot; one tab &middot; no install</p>
        <h1>ARCADE</h1>
        <hr class="rule" />
        <p class="lede">Real-time multiplayer, straight from the browser. Pick a game, grab a room, send the invite link.</p>
      </header>
      <main class="grid">
${cards}
      </main>
      <footer class="foot">Browser multiplayer &middot; instant rooms &middot; invite by link</footer>
    </div>
${swScript}  </body>
</html>
`;
}

const lobby = new Lobby(GAMES);
const net = new NetServer({
  onMessage: (sess, msg) => lobby.handleMessage(sess, msg),
  onDisconnect: (sess) => lobby.handleDisconnect(sess),
});

// Probing dev servers is async; everything else (lobby, sweep, signals) is
// safe to set up now — net.close() tolerates a never-started NetServer.
resolveMounts(GAMES)
  .then((mounts) => {
    // A live vite dev server on any prefix means "dev": no caching worker is
    // registered, and every sw.js serves the kill switch instead (§2.1).
    const dev = mounts.some((m) => m.kind === 'proxy');
    const html = launcherHtml(GAMES, !dev);
    const identities = GAMES.map((g) => IDENTITY[g.id] ?? NEUTRAL_IDENTITY);
    const assets = createPwaResolver({
      games: GAMES.map((g) => ({
        id: g.id,
        name: g.name,
        identity: IDENTITY[g.id] ?? NEUTRAL_IDENTITY,
      })),
      colors: {
        ink: LPAL.ink,
        paper: LPAL.paper,
        steel: LPAL.steel,
        metalDark: LPAL.metalDark,
      },
      identities,
      launcherHtml: html,
      mounts,
      launcherName: LAUNCHER_NAME,
      launcherShortName: LAUNCHER_SHORT_NAME,
    });
    net.start(PORT, mounts, html, assets);
  })
  .catch((err: unknown) => {
    console.error('[server] startup failed', err);
    process.exit(1);
  });

// 1s sweep: rooms report input-stale players; their sockets are closed here.
// The same poll reaps empty rooms.
const sweep = setInterval(() => {
  try {
    for (const sess of lobby.pollStaleSessions()) sess.close();
  } catch (err) {
    console.error('[server] stale sweep failed', err);
  }
}, 1000);

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal}: shutting down`);
  clearInterval(sweep);
  lobby.close(); // stop room tick intervals
  net.close(); // terminate sockets, close ws + http
  setTimeout(() => process.exit(0), 200).unref(); // let close frames flush
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
