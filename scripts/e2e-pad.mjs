#!/usr/bin/env node
// ============================================================================
// e2e-pad — prove KART phone-as-controller (docs/PAD.md) works end-to-end
// against the PRODUCTION platform server, with no browsers: two bare
// WebSocket connections play the desktop player and the phone pad.
//
//   PLAYER ws: create_private(game:'kart')        -> kart_joined (roomId/code)
//   PLAYER:    {t:'pad_pair_request'}             -> pad_pair {room, token}
//   PAD ws:    welcome -> join_as_pad(room,token) -> pad_joined;
//              PLAYER observes pad_status bound:true
//   PAD:       kart_input seq 0..59 @30Hz ~2s     -> PLAYER gets pad_input
//              echoes AND kart_snapshot you.lastProcessedSeq advances
//   PAD:       {t:'leave'}                        -> PLAYER pad_status bound:false
//   FRESH ws:  join_as_pad with the consumed token -> error pad_rejected
//   HTTP:      GET /kart/pad.html is the PAD page (not the SPA fallback);
//              GET /kart/ still serves the game.
//
// No race is started: inputs are acked in every phase, so a lone seated
// player in the lobby phase is enough. Requires `npm run build` first
// (platform/server/dist/server.js + games/kart/client/dist/pad.html).
//
// Env: E2E_PORT overrides the default port 8184.
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
  if (!existsSync(path.join(ROOT, 'games/kart/client/dist/pad.html')))
    fail('games/kart/client/dist/pad.html missing — run npm run build first');
  server = spawn(process.execPath, [serverEntry], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
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

  // -- (b) pair request -> pad_pair token --------------------------------------
  currentStep = 'b. pad_pair_request';
  player.send({ t: 'pad_pair_request' });
  const pair = await player.waitFor((m) => m.t === 'pad_pair', 'pad_pair');
  if (typeof pair.room !== 'string' || typeof pair.token !== 'string')
    fail(`pad_pair missing room/token: ${JSON.stringify(pair)}`);
  if (pair.room !== joined.code) fail(`pad_pair.room ${pair.room} != private code ${joined.code}`);
  ok(`pad_pair room=${pair.room} token=${pair.token} expiresInMs=${pair.expiresInMs}`);

  // -- (c) pad joins; player sees bound:true -----------------------------------
  currentStep = 'c. join_as_pad';
  const pad = new Client('PAD');
  await pad.connect();
  await pad.waitFor((m) => m.t === 'welcome', 'welcome');
  pad.send({ t: 'join_as_pad', room: pair.room, token: pair.token });
  const padJoined = await pad.waitFor((m) => m.t === 'pad_joined', 'pad_joined');
  if (padJoined.name !== 'PadPlayer') fail(`pad_joined.name ${padJoined.name} != PadPlayer`);
  ok(`pad_joined name=${padJoined.name}`);
  const bound = await player.waitFor(
    (m) => m.t === 'pad_status' && m.bound === true,
    'pad_status bound:true',
  );
  ok(`player saw pad_status bound:${bound.bound}`);

  // -- (d) pad streams input; player gets echoes + advancing ack ---------------
  currentStep = 'd. input stream';
  const lastSeq = () =>
    player.inbox.reduce(
      (acc, m) => (m.t === 'kart_snapshot' && m.you ? m.you.lastProcessedSeq : acc),
      -1,
    );
  const seqBefore = lastSeq();
  const N = 60; // ~2s at 30Hz
  for (let seq = 0; seq < N; seq++) {
    pad.send({
      t: 'kart_input',
      seq,
      throttle: 1,
      brake: 0,
      steer: 0,
      drift: false,
      respawn: false,
      dt: 1 / 30,
    });
    await new Promise((r) => setTimeout(r, 33));
  }
  const echo = await player.waitFor((m) => m.t === 'pad_input', 'pad_input echo');
  if (echo.input?.t !== 'kart_input' || echo.input.throttle !== 1)
    fail(`pad_input echo malformed: ${JSON.stringify(echo)}`);
  const echoes = player.inbox.filter((m) => m.t === 'pad_input').length;
  ok(`${echoes} pad_input echoes received (first seq ${echo.input.seq})`);
  const acked = await player.waitFor(
    (m) => m.t === 'kart_snapshot' && m.you && m.you.lastProcessedSeq >= N - 10,
    `snapshot with lastProcessedSeq >= ${N - 10}`,
    8000,
  );
  ok(`lastProcessedSeq ${seqBefore} -> ${acked.you.lastProcessedSeq} (phase ${acked.phase})`);

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
  const err = await late.waitFor((m) => m.t === 'error', 'error');
  if (err.code !== 'pad_rejected') fail(`expected pad_rejected, got ${JSON.stringify(err)}`);
  ok(`consumed token rejected with code pad_rejected`);
  late.close();

  // -- HTTP: the pad page is real, the game page still serves -------------------
  currentStep = 'http static';
  const padRes = await fetch(`${BASE}/kart/pad.html`);
  const padHtml = await padRes.text();
  if (padRes.status !== 200) fail(`GET /kart/pad.html -> ${padRes.status}`);
  if (!padHtml.includes('Phone Controller'))
    fail('GET /kart/pad.html is not the pad page (SPA fallback served?)');
  ok('GET /kart/pad.html -> 200, pad-page markup');
  const gameRes = await fetch(`${BASE}/kart/`);
  if (gameRes.status !== 200) fail(`GET /kart/ -> ${gameRes.status}`);
  ok('GET /kart/ -> 200');

  player.close();
  console.log('\nPASS: pad e2e smoke green');
  cleanup(0);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
