# TOUCH + PWA — FROZEN CONTRACT

Goal: **a child taps a KART icon on an iPad home screen and is racing, fullscreen,
with two thumbs.** Everything here serves that sentence.

§1–§4 are immutable. No task may change a name, path, or signature defined here,
or widen its ownership in §6. If a task believes the contract is wrong, it STOPS
and reports — it never renegotiates with a sibling.

---

## §1 PWA shape

### 1.1 Per-game installs, plus the launcher

**Each game gets its own manifest and is independently installable**, and the
launcher gets one too. Five manifests total.

Why per-game and not one root PWA: iOS **does not support manifest `shortcuts`**,
so a single root install would force a child through the launcher on every
launch. A KART icon that opens straight into KART is the entire point.

| install | `start_url` | `scope` |
|---|---|---|
| launcher | `/` | `/` |
| kart | `/kart/` | `/kart/` |
| fps | `/fps/` | `/fps/` |
| bank | `/bank/` | `/bank/` |
| wordbomb | `/wordbomb/` | `/wordbomb/` |

### 1.2 Manifest fields (all five)

- `display: "standalone"` — hides browser chrome. On a tablet this is a large
  usable-area gain and is most of why this is worth doing.
- `orientation: "landscape"` for **kart and fps**; `"any"` for bank and wordbomb
  (they are readable in portrait, and forcing rotation on a text game is worse).
- `background_color` and `theme_color` MUST byte-match that game's existing
  pre-boot paint guard in its `index.html` (KART's is `#14171c`). A mismatch
  produces a visible flash on launch. `VISUAL_UPGRADE.md` §7 seam rule 6 already
  governs this hex; do not introduce a second source of truth.
- `name` / `short_name` per game. `short_name` must fit under a home-screen icon
  without truncation — keep it ≤ 12 characters.

### 1.3 iOS additionally requires meta tags

`display: standalone` alone does not give iOS a fullscreen install. Each
`index.html` also needs `apple-mobile-web-app-capable`,
`apple-mobile-web-app-status-bar-style`, and an `apple-touch-icon` link. Without
these the iPad install opens in a Safari chrome window and the whole exercise
fails on the target device. **Verify on the actual behaviour, not on the tags
being present.**

### 1.4 Icons

192px and 512px PNG per game, plus a maskable variant, plus a 180px
`apple-touch-icon`. **Generated from each game's existing palette** — no external
assets, no fonts, no downloaded images (the repo bans these). A flat background
in the game's identity colour with a simple distinguishing glyph is sufficient
and is what a 4-year-old actually navigates by.

Generate them with a committed script so they can be regenerated, not hand-drawn
binaries with no provenance.

---

## §2 Service worker

### 2.0 Frozen paths — the T1/T2 interface

These are fixed here precisely so the two tasks never have to agree on them:

| artifact | URL | scope |
|---|---|---|
| launcher SW | `/sw.js` | `/` |
| per-game SW | `/<gameId>/sw.js` | `/<gameId>/` |
| per-game manifest | `/<gameId>/manifest.webmanifest` | — |
| per-game icons | `/<gameId>/icons/icon-{192,512,maskable-512}.png`, `/<gameId>/icons/apple-touch-icon.png` | — |
| launcher manifest | `/manifest.webmanifest` | — |
| launcher icons | `/icons/…` (same filenames) | — |

A service worker's scope cannot exceed its own path, which is why each game's
worker is served from inside its own directory. **T1 writes the registration
call against these paths; T2 makes them serve.** Neither may change a path.
Registration is guarded so it is a no-op when the file is absent, so T1 and T2
can land in either order without breaking a page.

### 2.1 Rules that are not negotiable

- **Never intercept `/ws`.** The multiplayer transport is a WebSocket; a
  service worker that touches it breaks every game silently and confusingly.
  Pass through anything that is not a same-origin GET for a static asset.
- **Never cache HTML with a cache-first strategy.** Network-first (or
  stale-while-revalidate) for documents, cache-first only for hashed build
  assets. A cache-first HTML document is how a PWA gets permanently stuck on an
  old build.
- **Versioned cache name**, and delete every non-matching cache in `activate`.
- **Disabled in dev.** Vite's dev server plus a caching service worker is a
  debugging nightmare. Register only in production builds.
- **The update path must be tested, not assumed.** Deploy a change, reload
  twice, confirm the new build is live. A stale service worker serving an old
  bundle against a new server protocol is the single most likely way this
  feature breaks a working game — and it will present as a bug in the game, not
  as a caching bug.

### 2.2 Offline

Cache the shell and built assets so a launch is fast and works with no network.
The games themselves are multiplayer and cannot function offline; an offline
launch must fail **gracefully and legibly**, not hang on a blank canvas.

---

## §3 Touch-safety (all games)

These apply to every game's page, not just KART. Without them a tablet is
unplayable regardless of control scheme.

- `touch-action: none` on the canvas and all control surfaces — otherwise a
  steering drag scrolls or zooms the page.
- Prevent double-tap zoom, pinch zoom, pull-to-refresh, and iOS rubber-band
  overscroll. Note that iOS Safari **ignores `user-scalable=no`** in the viewport
  meta; `touch-action` and `overscroll-behavior` are what actually work.
- Respect safe-area insets (`env(safe-area-inset-*)`) so controls are not under
  a notch or the home indicator.
- **Wake Lock** while a match is live. A screen that sleeps mid-race is
  infuriating and will be blamed on the game. Release it on leave, and degrade
  silently where unsupported.
- Audio must start on a user gesture (iOS requires it). Verify the existing
  audio layers still initialise after an install-launch, where there may be no
  prior interaction.

---

## §4 KART touch controls

### 4.1 The seam already exists — use it

`games/kart/client/src/drive.ts` has an external input latch
(`setInput()` / `this.ext`) that merges with keyboard into `this.eff`. **Touch
feeds through that latch.** Do not add a second input path, do not modify the
keyboard handlers, and do not make touch and keyboard mutually exclusive — a
tablet with a keyboard attached should work with either.

### 4.2 Scheme

**There are TWO layouts, and which one you get is decided by KIDS MODE.**

#### Default layout (the standard mobile-racing split — thumbs never share a job)

- **Left side: steering only.** Two large adjacent zones/buttons — left and
  right. Not a virtual stick; a stick is imprecise under a thumb and
  unusable for a child.
- **Right side: accelerate, nitro, handbrake.** Accelerate is the large primary
  target and sits lowest/outermost where the thumb rests. Nitro and handbrake
  are smaller, clearly separated, and positioned so a thumb pulling accelerate
  cannot clip them.
- Nitro maps to the existing nitro hook; handbrake maps to the existing `drift`
  input. Neither is a new mechanic — this is a new *surface* for controls KART
  already has.
- **Sides are swappable** in settings for left-handed players. Cheap to support,
  and irritating to retrofit.

#### KIDS MODE layout (existing flag, `localStorage` key `kart.kids`)

Collapses to the simplest possible surface:

- **Steering zones only. Auto-throttle forced ON.** No accelerate, no nitro, no
  handbrake — those controls are not rendered at all, not merely disabled.
- The entire control surface is two zones and nothing else.

Do NOT invent a second assist flag — extend the existing KIDS MODE. The whole
point is that one toggle turns an adult's five-control racing game into a
two-button game for a 4-year-old, with no explanation required.

Auto-throttle is also available as a standalone setting for an adult who wants
it without the rest of KIDS MODE.

### 4.3 Multi-touch is a correctness requirement, not a nicety

Track pointers **by `pointerId`**. Two thumbs are down simultaneously in normal
play; naive `touchstart`/`touchend` handling that assumes a single touch will
drop inputs and produce stuck steering. Specifically test:

- both thumbs down at once (result: straight)
- lifting one thumb while the other stays down (result: steer toward the held
  side, not neutral)
- a thumb sliding from one zone into the other
- a pointer cancelled by the system mid-press (`pointercancel`) — this must
  release the input, or steering sticks until the next press

Use Pointer Events, not Touch Events, so mouse and stylus work identically.

### 4.4 The controls must be invisible to keyboard players

Touch UI renders only when a touch-capable pointer is detected, and must never
appear on a desktop. Do not sniff the user agent; use pointer/hover media
queries or the first real pointer event.

---

## §5 Out of scope

FPS touch controls (aiming needs a scheme this contract does not cover), BANK
and WORDBOMB touch input (both need a keyboard), SPLAT (its own contract),
push notifications, and any app-store packaging.

---

## §6 File ownership — exclusive

| Task | Owns |
|---|---|
| **T1** PWA shell | `games/{fps,bank,kart,wordbomb}/client/index.html`, each game's static-asset dir (manifests + icons), the icon-generation script |
| **T2** service worker | the service-worker source, `platform/server/src/index.ts` (launcher head + asset routes), `platform/server/src/net.ts` if serving requires it |
| **T3** KART touch | `games/kart/client/src/drive.ts`, `app.ts`, `style.css` |

Touch-safety CSS (§3) belongs to **T3** for KART's own stylesheet and to **T1**
for the other three games' pages.

---

## §7 Gates

1. `node node_modules/typescript/bin/tsc --noEmit -p <workspace>`, invoked
   directly with `$?` captured. **Never trust `rtk` for a gate** — in this repo
   it has reported "No errors found" for a file with 6 real errors, returned
   exit 0 for failing runs, and swallowed an entire `npx vitest list` listing.
2. `npx vitest run` — floor **1004 passing**.
3. `npm run build` exit 0, and the manifests/icons/service worker must be
   present and correctly pathed **in the built output**, not only in dev.
4. `env E2E_PORT=<port> node scripts/e2e.mjs` — floor 29/29. A service worker or
   a viewport change can break a headless run; that is the point of running it.
5. Every gate proven able to fail before its green is trusted.

**Required evidence beyond unit tests — verify on a real touch surface:**

- Emulate a tablet (device emulation with touch enabled) and **actually drive a
  lap with simulated touch**, including the four multi-touch cases in §4.3.
  Screenshot the control layout and LOOK at it: are the zones reachable by
  thumbs, do the buttons sit clear of the steering areas, is anything under a
  notch or the home indicator?
- Confirm the touch UI does **not** appear on a desktop pointer.
- Confirm a service-worker update actually takes effect (§2.1).
- Report anything that can only be confirmed on real hardware — an iPad install
  is the true acceptance test and cannot be fully simulated. Say plainly what
  you verified and what remains unverified.
