// ============================================================================
// GENERIC PHONE-PAD PAGE — self-rendering virtual controller served at
// /pad/?game=<id> (docs/PLATFORM.md §4.4). Server-generated HTML, no build
// step (same pattern as the launcher page). The page connects to /ws itself,
// exchanges {t:'join_as_pad'} with the pairing code, renders the game's
// PadLayout, streams {t:'pad_input'} ≤ PADS.inputMaxHz, tracks pad_input_echo
// for latency display.
// Owner: P8_PAD_PAGE — implement renderPadPage; keep this signature.
// ============================================================================

import { AUTH, CLAIM_ALPHABET, PADS } from '@platform/shared';
import type { PadLayout } from '@platform/shared';

/** Full standalone HTML document for the pad page. Never throws. */
export function renderPadPage(opts: {
  readonly gameId: string;
  readonly gameName: string;
  readonly layout: PadLayout;
}): string {
  try {
    return buildPadPage(opts.gameId, opts.gameName, opts.layout);
  } catch {
    // Contract (P8): never throw — a broken layout still yields a usable page.
    return FALLBACK_PAGE;
  }
}

// ---------------------------------------------------------------------------
// Server-side helpers
// ---------------------------------------------------------------------------

/** Last-resort page if page assembly itself ever fails. */
const FALLBACK_PAGE =
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
  '<title>Pad</title>\n<style>body{margin:0;height:100vh;display:flex;' +
  'align-items:center;justify-content:center;background:#14171c;color:#e8ecf1;' +
  'font-family:system-ui,sans-serif}</style>\n</head>\n<body>' +
  '<p>Controller page failed to load. Please reopen the link.</p>' +
  '</body>\n</html>';

/** Registry values are trusted constants; escape anyway before inlining into HTML. */
function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * JSON for inline <script> embedding: escapes `<` (defuses `</script>`
 * breakouts) plus U+2028/U+2029 (legacy JS line terminators).
 */
function jsonForScript(v: unknown): string {
  return JSON.stringify(v)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function cleanLabel(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, 24) : '';
}

interface SafeStick {
  readonly id: 'l' | 'r';
  readonly label: string;
}
interface SafeButton {
  readonly bit: number;
  readonly label: string;
}
interface SafePadLayout {
  readonly sticks: readonly SafeStick[];
  readonly buttons: readonly SafeButton[];
}

/**
 * Defensive re-validation of the declared layout before anything is embedded.
 * Dedupes sticks by id and buttons by bit; bit 31 is platform-reserved (⏸)
 * and dropped here — the page renders its own pause button unconditionally.
 * Returns null for structurally-broken layouts (page shows an error banner).
 */
function safeLayout(raw: PadLayout): SafePadLayout | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as unknown as Record<string, unknown>;
  const sticksRaw: unknown[] | null = Array.isArray(r.sticks) ? (r.sticks as unknown[]) : null;
  const buttonsRaw: unknown[] | null = Array.isArray(r.buttons) ? (r.buttons as unknown[]) : null;
  if (sticksRaw === null || buttonsRaw === null) return null;

  const sticks: SafeStick[] = [];
  const seenIds = new Set<string>();
  for (const s of sticksRaw) {
    if (typeof s !== 'object' || s === null) continue;
    const rec = s as Record<string, unknown>;
    const id = rec.id;
    if ((id !== 'l' && id !== 'r') || seenIds.has(id)) continue;
    seenIds.add(id);
    sticks.push({ id, label: cleanLabel(rec.label) });
  }

  const buttons: SafeButton[] = [];
  const seenBits = new Set<number>();
  const maxListedBit = PADS.maxButtons - 2; // bit 31 reserved for platform pause
  for (const b of buttonsRaw) {
    if (typeof b !== 'object' || b === null) continue;
    const rec = b as Record<string, unknown>;
    const bit = rec.bit;
    if (typeof bit !== 'number' || !Number.isInteger(bit)) continue;
    if (bit < 0 || bit > maxListedBit || seenBits.has(bit)) continue;
    seenBits.add(bit);
    buttons.push({ bit, label: cleanLabel(rec.label) });
  }

  return { sticks, buttons };
}

function buildPadPage(gameId: unknown, gameName: unknown, rawLayout: PadLayout): string {
  const safeGameId: string = typeof gameId === 'string' && gameId !== '' ? gameId : '';
  const safeName: string = typeof gameName === 'string' && gameName !== '' ? gameName : 'Game';
  const boot: SafePadLayout | null = safeLayout(rawLayout);

  const cfg = jsonForScript({
    gameId: safeGameId,
    gameName: safeName,
    hz: PADS.inputMaxHz,
    codeLen: AUTH.claimCodeLen,
    alphabet: CLAIM_ALPHABET,
    deadzone: 0.12,
    boot,
  });

  // Structurally-broken layout opt ⇒ ship the page WITH an error banner (the
  // client still tries GET /api/pads/<id> and recovers if that answers well).
  const fatalHtml =
    boot === null
      ? '    <div id="fatal"><p>This game has no valid controller layout.</p>' +
        '<button type="button" id="retryBtn">RELOAD</button></div>\n'
      : '    <div id="fatal" class="hidden"><p></p>' +
        '<button type="button" id="retryBtn">RELOAD</button></div>\n';

  const title = escapeHtml(`${safeName} — Pad`);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
  <meta name="color-scheme" content="dark" />
  <meta name="theme-color" content="#14171c" />
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    html, body { height: 100%; }
    body {
      height: 100vh; height: 100dvh; overflow: hidden;
      display: flex; flex-direction: column;
      background: #14171c; color: #e8ecf1;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      touch-action: none;
      -webkit-user-select: none; user-select: none;
      overscroll-behavior: none;
    }
    header {
      flex: none; display: flex; align-items: center; gap: 10px;
      padding: 10px 14px; background: #191e25; border-bottom: 1px solid #262d37;
      padding-top: calc(10px + env(safe-area-inset-top));
    }
    header h1 { font-size: 17px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    header .sub { color: #9aa7b5; font-size: 13px; }
    .dot { flex: none; width: 12px; height: 12px; border-radius: 50%; background: #5a6472; transition: background .15s; }
    .dot.ok { background: #35c46f; }
    .dot.wait { background: #e0a63c; animation: pulse 1s ease-in-out infinite; }
    .dot.bad { background: #e5533d; }
    @keyframes pulse { 50% { opacity: .35; } }
    #rtt { margin-left: auto; color: #9aa7b5; font-size: 13px; font-variant-numeric: tabular-nums; }
    main { flex: 1; display: flex; min-height: 0; position: relative; }
    .hidden { display: none !important; }

    #loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #9aa7b5; }

    /* pairing card */
    #pairCard {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: min(92vw, 340px); z-index: 10; text-align: center;
      background: #1a2027; border: 1px solid #303a46; border-radius: 16px;
      padding: 20px 22px; box-shadow: 0 12px 40px rgba(0,0,0,.45);
    }
    #pairCard h2 { font-size: 19px; margin-bottom: 6px; }
    #pairCard .hint { color: #9aa7b5; font-size: 13px; margin-bottom: 14px; }
    #code {
      width: 100%; text-align: center; text-transform: uppercase;
      font-size: 34px; font-weight: 700; letter-spacing: .28em;
      color: #e8ecf1; background: #12161c; border: 2px solid #333d4a;
      border-radius: 12px; padding: 10px 4px 10px calc(4px + .28em);
      outline: none; caret-color: #3f8cff;
    }
    #code:focus { border-color: #3f8cff; }
    .keys { color: #6d7885; font-size: 12px; margin-top: 8px; letter-spacing: .06em; }
    #connectBtn {
      margin-top: 14px; width: 100%; min-height: 54px;
      font-size: 18px; font-weight: 800; letter-spacing: .08em;
      color: #fff; background: #2456a8; border: 1px solid #3f8cff; border-radius: 12px;
    }
    #connectBtn:disabled { opacity: .45; }
    #connectBtn:not(:disabled):active { transform: scale(.98); }
    .warn { color: #e0a63c; font-size: 13px; margin-top: 12px; }
    .err { color: #ff8a76; font-size: 14px; margin-top: 12px; overflow-wrap: anywhere; }

    /* disconnected banner + fatal error card */
    #banner {
      position: absolute; left: 50%; top: 10px; transform: translateX(-50%);
      z-index: 9; display: flex; align-items: center; gap: 12px;
      background: #2a1714; border: 1px solid rgba(229,83,61,.55); border-radius: 12px;
      padding: 10px 14px; font-size: 14px; color: #ffd9d2; white-space: nowrap;
    }
    #banner button, #fatal button {
      min-height: 38px; padding: 0 14px; font-weight: 800; font-size: 13px; letter-spacing: .06em;
      color: #fff; background: #2456a8; border: 1px solid #3f8cff; border-radius: 9px;
    }
    #fatal {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: min(92vw, 340px); z-index: 11; text-align: center;
      background: #1a2027; border: 1px solid #303a46; border-radius: 16px; padding: 22px;
      color: #ffb9ac;
    }
    #fatal p { font-size: 15px; margin-bottom: 14px; overflow-wrap: anywhere; }

    /* controls */
    #controls { flex: 1; display: flex; min-height: 0; width: 100%; }
    .half { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-width: 0; }
    .mid { flex: 1.2; display: flex; align-items: center; justify-content: center; padding: 8px; min-width: 0; overflow: auto; }
    #btnGrid { display: grid; grid-template-columns: repeat(2, minmax(86px, 118px)); gap: 10px; }
    .btn {
      min-height: 62px; border-radius: 14px; padding: 6px;
      display: flex; align-items: center; justify-content: center; text-align: center;
      background: #232a33; border: 1px solid #303a46; color: #e8ecf1;
      font-family: inherit; font-size: clamp(15px, 2.4vh, 20px); font-weight: 700;
      overflow-wrap: break-word; touch-action: none;
    }
    .btn.on { background: #2f6fce; border-color: #4d8fe8; transform: scale(.96); }
    .btn.pause { border-color: #4a5563; color: #cdd6df; }
    .stick-label { color: #9aa7b5; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
    .stick-pad {
      width: min(42vmin, 185px); aspect-ratio: 1 / 1; border-radius: 50%;
      background: #1b212a; border: 2px solid #333d4a;
      position: relative; touch-action: none;
    }
    .stick-pad.live { border-color: #3f8cff; }
    .dz {
      position: absolute; left: 50%; top: 50%; width: 24%; aspect-ratio: 1 / 1;
      transform: translate(-50%, -50%); border-radius: 50%;
      border: 2px dashed #39434f; pointer-events: none;
    }
    .knob {
      position: absolute; left: 50%; top: 50%; width: 42%; aspect-ratio: 1 / 1;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, #4d5a6b, #2b333e);
      border: 1px solid #46536480;
      transform: translate(-50%, -50%); pointer-events: none;
      box-shadow: 0 4px 14px rgba(0,0,0,.4);
    }
    #controls.locked .stick-pad, #controls.locked .btn { opacity: .45; pointer-events: none; }

    @media (orientation: portrait) {
      #controls { flex-direction: column; }
      .half { flex-direction: row; justify-content: space-evenly; }
      .mid { flex: 1; }
      .stick-pad { width: min(38vw, 165px); }
    }
  </style>
</head>
<body>
  <header>
    <span class="dot" id="dot"></span>
    <h1 id="gameTitle">${escapeHtml(safeName)}</h1>
    <span class="sub">controller</span>
    <span id="rtt" aria-live="polite"></span>
  </header>
  <main>
    <div id="loading"><p>Loading controller&hellip;</p></div>
${fatalHtml}    <div id="banner" class="hidden">
      <span>Controller disconnected</span>
      <button type="button" id="reconnectBtn">RECONNECT</button>
    </div>
    <section id="controls" class="hidden locked">
      <div class="half" id="halfL"></div>
      <div class="mid"><div id="btnGrid"></div></div>
      <div class="half" id="halfR"></div>
    </section>
    <section id="pairCard">
      <h2>Pair controller</h2>
      <p class="hint">Enter the code shown on the game screen.</p>
      <input id="code" maxlength="${AUTH.claimCodeLen}" autocomplete="off" autocapitalize="characters"
             spellcheck="false" inputmode="latin" placeholder="&middot;&middot;&middot;&middot;&middot;&middot;" />
      <div class="keys">A&ndash;Z (no I&nbsp;/&nbsp;O) &middot; 2&ndash;9</div>
      <button type="button" id="connectBtn" disabled>CONNECT</button>
      <p id="roomNote" class="warn hidden">Missing room parameter (?r=&hellip;) &mdash; reopen this page from the game&rsquo;s PAIR screen.</p>
      <p id="pairErr" class="err hidden"></p>
    </section>
  </main>
  <script>
(function () {
'use strict';
var CFG = ${cfg};

function el(id) { return document.getElementById(id); }

var dotEl = el('dot');
var rttEl = el('rtt');
var loadingEl = el('loading');
var fatalEl = el('fatal');
var retryBtn = el('retryBtn');
var bannerEl = el('banner');
var reconnectBtn = el('reconnectBtn');
var controls = el('controls');
var halfL = el('halfL');
var halfR = el('halfR');
var btnGrid = el('btnGrid');
var pairCard = el('pairCard');
var codeInput = el('code');
var connectBtn = el('connectBtn');
var roomNote = el('roomNote');
var pairErr = el('pairErr');

var qs = new URLSearchParams(location.search);
var gameId = qs.get('game') || CFG.gameId || '';
var roomId = qs.get('r') || '';

var phase = 'boot';        // boot | pair | connecting | bound | pair-back | disconnected | error
var ws = null;
var bound = false;
var rejecting = false;
var savedCode = '';
var seq = 0;
var sentAt = {};           // seq -> Date.now(), pruned to last 64
var sticks = { l: { x: 0, y: 0 }, r: { x: 0, y: 0 } };
var stickEls = {};
var pressed = [];          // list of pressed bits
var timer = null;

el('gameTitle').textContent = CFG.gameName;
if (!roomId) roomNote.classList.remove('hidden');

function setDot(mode) { dotEl.className = 'dot' + (mode ? ' ' + mode : ''); }

// ---- layout load + validation -------------------------------------------------

function cleanLabel(v) { return typeof v === 'string' ? v.slice(0, 24) : ''; }

function validateLayout(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Array.isArray(raw.sticks) || !Array.isArray(raw.buttons)) return null;
  var out = { sticks: [], buttons: [] };
  var seenIds = {};
  var i, s, id, b, bit, seenBits = {};
  for (i = 0; i < raw.sticks.length; i++) {
    s = raw.sticks[i];
    if (!s || typeof s !== 'object') continue;
    id = s.id === 'l' ? 'l' : (s.id === 'r' ? 'r' : null);
    if (!id || seenIds[id]) continue;
    seenIds[id] = 1;
    out.sticks.push({ id: id, label: cleanLabel(s.label) });
  }
  for (i = 0; i < raw.buttons.length; i++) {
    b = raw.buttons[i];
    if (!b || typeof b !== 'object') continue;
    bit = typeof b.bit === 'number' && isFinite(b.bit) ? Math.floor(b.bit) : -1;
    if (bit < 0 || bit > 30 || seenBits[bit]) continue; // bit 31 is the platform pause button
    seenBits[bit] = 1;
    out.buttons.push({ bit: bit, label: cleanLabel(b.label) });
  }
  return out;
}

function fatal(msg) {
  phase = 'error';
  bound = false;
  stopStream();
  loadingEl.classList.add('hidden');
  pairCard.classList.add('hidden');
  bannerEl.classList.add('hidden');
  controls.classList.add('hidden');
  var p = fatalEl.firstElementChild;
  if (p) p.textContent = msg;
  fatalEl.classList.remove('hidden');
  setDot('bad');
}

function useLayout(layout) {
  buildControls(layout);
  loadingEl.classList.add('hidden');
  fatalEl.classList.add('hidden');
  controls.classList.remove('hidden');
  phase = 'pair';
  setDot('');
  refreshConnect();
  codeInput.focus();
}

function loadLayout() {
  fetch('/api/pads/' + encodeURIComponent(gameId))
    .then(function (res) {
      if (!res.ok) throw new Error('http ' + res.status);
      return res.json();
    })
    .then(function (json) {
      var v = validateLayout(json);
      if (!v) throw new Error('bad layout');
      useLayout(v);
    })
    .catch(function () {
      var v = validateLayout(CFG.boot);
      if (v) { useLayout(v); return; }
      fatal('No controller found for this game. It may not support phone pads.');
    });
}

// ---- controls ------------------------------------------------------------------

function makeStick(host, id, label) {
  var wrap = document.createElement('div');
  wrap.className = 'stick';
  var lab = document.createElement('div');
  lab.className = 'stick-label';
  lab.textContent = label || '';
  var pad = document.createElement('div');
  pad.className = 'stick-pad';
  var ring = document.createElement('div');
  ring.className = 'dz';
  var knob = document.createElement('div');
  knob.className = 'knob';
  pad.appendChild(ring);
  pad.appendChild(knob);
  wrap.appendChild(lab);
  wrap.appendChild(pad);
  host.appendChild(wrap);
  stickEls[id] = { pad: pad, knob: knob };

  var activePid = null;
  var DZ = CFG.deadzone > 0 && CFG.deadzone < 1 ? CFG.deadzone : 0.12;

  function zero() {
    sticks[id].x = 0;
    sticks[id].y = 0;
    knob.style.transform = 'translate(-50%, -50%)';
    pad.classList.remove('live');
  }

  function move(e) {
    var rect = pad.getBoundingClientRect();
    var rad = rect.width / 2;
    if (rad <= 0) return;
    var dx = e.clientX - (rect.left + rad);
    var dy = e.clientY - (rect.top + rect.height / 2);
    var mag = Math.sqrt(dx * dx + dy * dy) / rad;
    var ux = mag > 0 ? dx / (mag * rad) : 0;
    var uy = mag > 0 ? dy / (mag * rad) : 0;
    var cm = Math.min(1, mag);                       // clamp onto the pad circle
    var out = cm <= DZ ? 0 : (cm - DZ) / (1 - DZ);   // deadzone-rescaled magnitude
    sticks[id].x = out * ux;
    sticks[id].y = out * uy;
    var kf = rad * 0.58 * cm;                        // knob travel stays inside the pad
    knob.style.transform = 'translate(-50%, -50%) translate(' +
      (ux * kf).toFixed(1) + 'px,' + (uy * kf).toFixed(1) + 'px)';
  }

  pad.addEventListener('pointerdown', function (e) {
    if (activePid !== null) return;
    e.preventDefault();
    activePid = e.pointerId;
    try { pad.setPointerCapture(e.pointerId); } catch (err) {}
    pad.classList.add('live');
    move(e);
  });
  pad.addEventListener('pointermove', function (e) {
    if (e.pointerId === activePid) move(e);
  });
  pad.addEventListener('pointerup', function (e) {
    if (e.pointerId === activePid) { activePid = null; zero(); }
  });
  pad.addEventListener('pointercancel', function (e) {
    if (e.pointerId === activePid) { activePid = null; zero(); }
  });
  pad.addEventListener('lostpointercapture', function () {
    if (activePid !== null) { activePid = null; zero(); }
  });
}

function makeButton(bit, label, isPause) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = isPause ? 'btn pause' : 'btn';
  b.setAttribute('aria-label', label || ('Button ' + bit));
  var span = document.createElement('span');
  span.textContent = label;
  b.appendChild(span);

  function setPressed(on) {
    var i = pressed.indexOf(bit);
    if (on && i < 0) pressed.push(bit);
    if (!on && i >= 0) pressed.splice(i, 1);
    b.classList.toggle('on', on);
  }
  b.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    try { b.setPointerCapture(e.pointerId); } catch (err) {}
    setPressed(true);
  });
  b.addEventListener('pointerup', function () { setPressed(false); });
  b.addEventListener('pointercancel', function () { setPressed(false); });
  b.addEventListener('lostpointercapture', function () { setPressed(false); });
  btnGrid.appendChild(b);
}

function buildControls(layout) {
  var i, s;
  for (i = 0; i < layout.sticks.length; i++) {
    s = layout.sticks[i];
    makeStick(s.id === 'l' ? halfL : halfR, s.id, s.label);
  }
  for (i = 0; i < layout.buttons.length; i++) {
    makeButton(layout.buttons[i].bit, layout.buttons[i].label, false);
  }
  makeButton(31, '\\u23f8 Pause', true); // bit 31 is ALWAYS rendered (reserved pause)
}

function resetInputState() {
  pressed = [];
  sticks.l.x = 0; sticks.l.y = 0;
  sticks.r.x = 0; sticks.r.y = 0;
  if (stickEls.l) { stickEls.l.knob.style.transform = 'translate(-50%, -50%)'; stickEls.l.pad.classList.remove('live'); }
  if (stickEls.r) { stickEls.r.knob.style.transform = 'translate(-50%, -50%)'; stickEls.r.pad.classList.remove('live'); }
  var kids = btnGrid.children;
  for (var i = 0; i < kids.length; i++) kids[i].classList.remove('on');
}

// ---- pairing --------------------------------------------------------------------

function inputComplete() {
  return roomId !== '' && codeInput.value.length === CFG.codeLen;
}

function refreshConnect() {
  connectBtn.disabled = !inputComplete();
  if (phase === 'pair' || phase === 'pair-back') {
    connectBtn.textContent = 'CONNECT';
  }
}

codeInput.addEventListener('input', function () {
  var v = codeInput.value.toUpperCase();
  var out = '';
  var i, ch;
  for (i = 0; i < v.length && out.length < CFG.codeLen; i++) {
    ch = v.charAt(i);
    if (CFG.alphabet.indexOf(ch) >= 0) out += ch;
  }
  if (codeInput.value !== out) codeInput.value = out;
  refreshConnect();
});
codeInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && inputComplete()) connect();
});

connectBtn.addEventListener('click', function () { connect(); });

function connect() {
  if (!inputComplete()) return;
  savedCode = codeInput.value;
  phase = 'connecting';
  pairErr.classList.add('hidden');
  bannerEl.classList.add('hidden');
  setDot('wait');
  connectBtn.disabled = true;
  connectBtn.textContent = 'CONNECTING\\u2026';
  openSocket();
}

function openSocket() {
  cleanupSocket();
  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    ws = new WebSocket(proto + '://' + location.host + '/ws');
  } catch (e) {
    ws = null;
    onClosed();
    return;
  }
  ws.onopen = function () {
    send({ t: 'join_as_pad', room: roomId, token: savedCode });
  };
  ws.onmessage = function (ev) { handleMessage(ev.data); };
  ws.onerror = function () { /* close event follows */ };
  ws.onclose = function () { onClosed(); };
}

function cleanupSocket() {
  if (!ws) return;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
  try { ws.close(); } catch (e) {}
  ws = null;
}

function send(obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
}

function handleMessage(data) {
  var m;
  try { m = JSON.parse(String(data)); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  if (m.t === 'pad_joined') {
    onJoined();
  } else if (m.t === 'pad_rejected') {
    onRejected(typeof m.reason === 'string' && m.reason !== '' ? m.reason : 'Pairing refused.');
  } else if (m.t === 'pad_input_echo') {
    var t0 = sentAt[m.seq];
    if (typeof t0 === 'number') {
      delete sentAt[m.seq];
      rttEl.textContent = String(Math.max(0, Math.round(Date.now() - t0))) + ' ms';
    }
  }
}

function onJoined() {
  bound = true;
  phase = 'bound';
  rejecting = false;
  resetInputState();
  pairCard.classList.add('hidden');
  bannerEl.classList.add('hidden');
  controls.classList.remove('locked');
  setDot('ok');
  startStream();
}

function onRejected(reason) {
  bound = false;
  stopStream();
  pairErr.textContent = reason;
  pairErr.classList.remove('hidden');
  pairCard.classList.remove('hidden');
  phase = 'pair-back';
  setDot('bad');
  rejecting = true; // our own close; suppresses the disconnected banner
  cleanupSocket();
  refreshConnect();
}

function onClosed() {
  var wasBound = bound || phase === 'bound';
  bound = false;
  stopStream();
  ws = null;
  refreshConnect();
  if (rejecting) {
    rejecting = false;
    phase = 'pair';
    return;
  }
  if (phase === 'connecting' || wasBound) {
    phase = 'disconnected';
    rttEl.textContent = '';
    setDot('bad');
    bannerEl.classList.remove('hidden');
  }
}

reconnectBtn.addEventListener('click', function () {
  if (savedCode.length !== CFG.codeLen || roomId === '') {
    bannerEl.classList.add('hidden');
    pairCard.classList.remove('hidden');
    phase = 'pair';
    setDot('');
    return;
  }
  bannerEl.classList.add('hidden');
  phase = 'connecting';
  setDot('wait');
  openSocket();
});

retryBtn.addEventListener('click', function () { location.reload(); });

// ---- input streaming ----------------------------------------------------------

var HZ = CFG.hz > 0 && CFG.hz <= 120 ? CFG.hz : 30;
var INTERVAL = Math.ceil(1000 / HZ); // >= ceil(1000/30)ms -> strictly <= 30 frames/s

function mask() {
  var m = 0;
  for (var i = 0; i < pressed.length; i++) {
    m += pressed[i] >= 31 ? 2147483648 : Math.pow(2, pressed[i]);
  }
  return m;
}

function tick() {
  if (!bound || !ws || ws.readyState !== 1) return;
  var f = {
    t: 'pad_input',
    seq: seq,
    lx: sticks.l.x,
    ly: sticks.l.y,
    rx: sticks.r.x,
    ry: sticks.r.y,
    buttons: mask(),
  };
  try { ws.send(JSON.stringify(f)); } catch (e) { return; }
  sentAt[f.seq] = Date.now();
  seq++;
  pruneSent();
}

function pruneSent() {
  var k = Object.keys(sentAt);
  var i;
  if (k.length > 64) {
    k.sort(function (a, b) { return Number(a) - Number(b); });
    for (i = 0; i < k.length - 64; i++) delete sentAt[k[i]];
  }
}

function startStream() {
  if (timer) return;
  tick();
  timer = setInterval(tick, INTERVAL);
}

function stopStream() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Release edge discipline: while bound the 30 Hz loop carries every state
 * change (including releases). When binding ends we emit ONE final all-zero
 * frame so the host never holds stuck inputs.
 */
function finalRelease() {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify({
        t: 'pad_input', seq: seq, lx: 0, ly: 0, rx: 0, ry: 0, buttons: 0,
      }));
      seq++;
    } catch (e) { /* socket gone — nothing more to do */ }
  }
}
window.addEventListener('pagehide', finalRelease);
window.addEventListener('beforeunload', finalRelease);

// long-press context menu / iOS pinch-zoom would fight multi-touch
document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
document.addEventListener('gesturestart', function (e) { e.preventDefault(); });

loadLayout();
})();
  </script>
</body>
</html>`;
}
