#!/usr/bin/env node
// ============================================================================
// e2e-pad — prove PLATFORM phone-as-pad (docs/PLATFORM.md §4.4) works end to
// end against the PRODUCTION platform server, with no browsers: two bare
// WebSocket connections play the desktop player and the phone pad.
//
//   PLAYER ws: create_private(game:'kart')        -> kart_joined (roomId/code)
//   PLAYER:    {t:'pad_pair_request'}             -> pad_pair {room, token, urlPath}
//   PAD ws:    welcome -> join_as_pad(room,token) -> pad_joined;
//              PLAYER observes pad_status bound:true
//   PAD:       pad_input seq 0..59 @30Hz ~2s      -> PAD gets pad_input_echo
//              acks for every frame (lobby relayed each into the room)
//   PAD:       {t:'leave'}                        -> PLAYER pad_status bound:false
//   FRESH ws:  join_as_pad with the consumed token -> pad_rejected (bad_code)
//   HTTP:      GET /pad/?game=ancients is the PAD page (200 + pad markup);
//              GET /pad/?game=kart is 404 no_pad (kart declares no padLayout —
//              additive opt-in); GET /kart/ still serves the game.
//
// No race/match is started: pairing, relay, echo and unbind are all
// phase-independent, so a lone seated player in the lobby phase is enough.
// In-room pad driving (stick -> sim orders) is covered by unit tests
// (games/rift/server/src/module.variant.test.ts) for the one game that
// implements seat resolution; kart has no padOwner yet, so no sim advance is
// asserted here. Requires `npm run build` first (platform/server/dist).
//
// Env: E2E_PORT overrides the default port 8184. PLATFORM_STATIC=1 is forced
// for the spawned server so a foreign vite squatter on a dev port can never
// hijack a mount into a proxy mid-suite.
// ============================================================================
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8184);
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;

let server = null;
let currentStep = 'boot';

function fail(msg) {
  console.error(`\nFAIL [${currentStep}]: ${msg}`);
  cleanup(1);
}

function ok(msg) {
  console.log(`  ok [${currentStep}] ${msg}`);
}

function cleanup(code) {
  if (server !== null) {
    server.kill('SIGTERM');
    server = null;
  }
  process.exit(code);
}

process.on('SIGINT', () => cleanup(130));
process.on('SIGTERM', () => cleanup(143));
setTimeout(() => fail('overall watchdog (90s) exceeded'), 90_000).unref();

// ---- tiny ws test client: queues every inbound message; waitFor scans it ---
class Client {
  constructor(label) {
    this.label = label;
    this.inbox = []; // every parsed S2C, in arrival order
    this.waiters = []; // {pred, resolve, timer}
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      this.ws.on('open', () => resolve());
      this.ws.on('error', (err) => reject(new Error(`${this.label} ws error: ${err.message}`)));
      this.ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        this.inbox.push(msg);
        this.waiters = this.waiters.filter((w) => {
          if (!w.pred(msg)) return true;
          clearTimeout(w.timer);
          w.resolve(msg);
          return false;
        });
      });
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Next message matching pred (already-seen messages included). */
  waitFor(pred, what, timeoutMs = 5000) {
    const seen = this.inbox.find(pred);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${what} on ${this.label}`)),
        timeoutMs,
      );
      this.waiters.push({ pred, resolve, timer });
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  // -- spawn the production server -------------------------------------------
  currentStep = 'spawn server';
  const serverEntry = path.join(ROOT, 'platform/server/dist/server.js');
  if (!existsSync(serverEntry)) fail(`${serverEntry} missing — run npm run build first`);
  server = spawn(process.execPath, [serverEntry], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PLATFORM_STATIC: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  server.on('exit', (code) => fail(`server exited early (code ${code})`));
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/kart/`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > 15_000) fail(`server did not serve /kart/ on :${PORT} within 15s`);
    await new Promise((r) => setTimeout(r, 150));
  }
  ok(`production server up on :${PORT}`);

  // -- (a) PLAYER creates a private kart room ---------------------------------
  currentStep = 'a. create_private';
  const player = new Client('PLAYER');
  await player.connect();
  const welcome = await player.waitFor((m) => m.t === 'welcome', 'welcome');
  ok(`welcome (playerId ${welcome.playerId})`);
  player.send({ t: 'create_private', name: 'PadPlayer', game: 'kart' });
  const joined = await player.waitFor((m) => m.t === 'kart_joined', 'kart_joined');
  if (typeof joined.roomId !== 'string' || typeof joined.code !== 'string')
    fail(`kart_joined missing roomId/code: ${JSON.stringify(joined)}`);
  ok(`kart_joined roomId=${joined.roomId} code=${joined.code} phase=${joined.phase}`);

  // -- (b) pair request -> pad_pair token + phone URL -------------------------
  currentStep = 'b. pad_pair_request';
  player.send({ t: 'pad_pair_request' });
  const pair = await player.waitFor((m) => m.t === 'pad_pair', 'pad_pair');
  if (typeof pair.room !== 'string' || typeof pair.token !== 'string')
    fail(`pad_pair missing room/token: ${JSON.stringify(pair)}`);
  if (pair.room !== joined.roomId) fail(`pad_pair.room ${pair.room} != roomId ${joined.roomId}`);
  if (!/^[A-Z0-9]{6}$/.test(pair.token)) fail(`pad_pair.token not a 6-char code: ${pair.token}`);
  const wantUrl = `/pad/?game=kart&r=${joined.roomId}`;
  if (pair.urlPath !== wantUrl) fail(`pad_pair.urlPath ${pair.urlPath} != ${wantUrl}`);
  ok(`pad_pair room=${pair.room} token=${pair.token} urlPath=${pair.urlPath}`);

  // -- (c) pad joins; player sees bound:true -----------------------------------
  currentStep = 'c. join_as_pad';
  const pad = new Client('PAD');
  await pad.connect();
  await pad.waitFor((m) => m.t === 'welcome', 'welcome');
  pad.send({ t: 'join_as_pad', room: pair.room, token: pair.token });
  await pad.waitFor((m) => m.t === 'pad_joined', 'pad_joined');
  ok('pad_joined');
  const bound = await player.waitFor(
    (m) => m.t === 'pad_status' && m.bound === true,
    'pad_status bound:true',
  );
  ok(`player saw pad_status bound:${bound.bound}`);

  // -- (d) pad streams input; every frame is relayed + acked -------------------
  currentStep = 'd. input stream';
  const N = 60; // ~2s at 30Hz, under the 30Hz relay cap
  for (let seq = 0; seq < N; seq++) {
    pad.send({ t: 'pad_input', seq, lx: 0, ly: 1, rx: 0, ry: 0, buttons: 0 });
    await new Promise((r) => setTimeout(r, 33));
  }
  const echoes = [];
  for (let seq = 0; seq < N; seq++) {
    echoes.push(await pad.waitFor((m) => m.t === 'pad_input_echo' && m.seq === seq, `echo ${seq}`, 8000));
  }
  ok(`${echoes.length}/${N} pad_input_echo acks received (seqs 0..${N - 1}, first ${echoes[0].seq})`);

  // -- (e) pad leaves; player sees bound:false ---------------------------------
  currentStep = 'e. pad leave';
  pad.send({ t: 'leave' });
  await player.waitFor(
    (m) => m.t === 'pad_status' && m.bound === false,
    'pad_status bound:false',
  );
  ok('player saw pad_status bound:false');
  pad.close();

  // -- (f) consumed token is rejected ------------------------------------------
  currentStep = 'f. consumed token';
  const late = new Client('LATE');
  await late.connect();
  await late.waitFor((m) => m.t === 'welcome', 'welcome');
  late.send({ t: 'join_as_pad', room: pair.room, token: pair.token });
  const rej = await late.waitFor((m) => m.t === 'pad_rejected', 'pad_rejected');
  if (rej.reason !== 'bad_code') fail(`expected reason bad_code, got ${JSON.stringify(rej)}`);
  ok('consumed token rejected with reason bad_code');
  late.close();

  // -- HTTP: the generic pad page serves; games without layouts 404 ----------
  currentStep = 'http static';
  const pageRes = await fetch(`${BASE}/pad/?game=ancients`);
  const pageHtml = await pageRes.text();
  if (pageRes.status !== 200) fail(`GET /pad/?game=ancients -> ${pageRes.status}`);
  if (!pageHtml.includes('id="gameTitle"') || !pageHtml.includes(' — Pad</title>'))
    fail('GET /pad/?game=ancients is not the pad page (fallback served?)');
  ok('GET /pad/?game=ancients -> 200, pad-page markup');
  const noPadRes = await fetch(`${BASE}/pad/?game=kart`);
  if (noPadRes.status !== 404) fail(`GET /pad/?game=kart -> ${noPadRes.status}, want 404 no_pad`);
  const noPadBody = await noPadRes.json().catch(() => null);
  if (noPadBody?.error !== 'no_pad') fail(`GET /pad/?game=kart body is not no_pad: ${JSON.stringify(noPadBody)}`);
  ok('GET /pad/?game=kart -> 404 no_pad (additive opt-in: kart declares no layout)');
  const gameRes = await fetch(`${BASE}/kart/`);
  if (gameRes.status !== 200) fail(`GET /kart/ -> ${gameRes.status}`);
  ok('GET /kart/ -> 200');

  player.close();
  console.log('\nPASS: pad e2e smoke green');
  cleanup(0);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
