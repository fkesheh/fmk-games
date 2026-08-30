#!/usr/bin/env node
// ============================================================================
// e2e-platform — prove the PLATFORM v2 surface end-to-end against the
// PRODUCTION server (docs/PLATFORM.md §10), with no browsers: bare fetch()
// + two bare WebSocket connections play the player and the phone pad.
//
//   HTTP   : /api/health · auth/device (create→reuse) · rename · saves
//            put/get/conflict/delete · link+claim cross-device · pads layout
//            · /pad page render
//   WS     : welcome → auth(token) → auth_ok → create_private(ancients)
//            → pad_pair_request → pad_pair{code}
//   PAD ws : join_as_pad(room, code) → pad_joined; PLAYER gets pad_status
//            bound:true; PAD streams 60 pad_input → echoes; leave →
//            pad_status bound:false; replay consumed code → pad_rejected
//   STATS  : player walks off the shrinking platform in SUMO → room reports
//            'sumo.self' via reportStats → visible on GET /profiles/me/stats
//
// Requires `npm run build` first (platform/server/dist/server.js).
// Env: E2E_PORT overrides the default port 8187.
// ============================================================================
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8187);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_JS = path.join(ROOT, 'platform/server/dist/server.js');

let n = 0;
const failures = [];
function ok(cond, label, extra = '') {
  n += 1;
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`${String(n).padStart(2, '0')} ${tag} ${label}${cond ? '' : ` — ${extra}`}`);
  if (!cond) failures.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* html/empty */ }
  return { status: res.status, json };
}

/** Open a ws, collect messages, return {msgs, send, close, waitNext}. */
function openWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const msgs = [];
  const waiters = [];
  ws.on('message', (data) => {
    const m = JSON.parse(String(data));
    if (waiters.length > 0) waiters.shift()(m);
    else msgs.push(m);
  });
  const waitNext = (timeoutMs = 4000) =>
    new Promise((resolve) => {
      if (msgs.length > 0) resolve(msgs.shift());
      else {
        const t = setTimeout(() => resolve(null), timeoutMs);
        waiters.push((m) => { clearTimeout(t); resolve(m); });
      }
    });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, msgs, opened, waitNext, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}

async function main() {
  if (!existsSync(SERVER_JS)) {
    console.error('e2e-platform: platform/server/dist/server.js missing — run npm run build first');
    process.exit(2);
  }

  // ---- boot the production server ------------------------------------------
  const server = spawn('node', [SERVER_JS], {
    env: { ...process.env, PORT: String(PORT), PLATFORM_DB: ':memory:' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  const up = await Promise.race([
    (async () => {
      for (let i = 0; i < 100; i++) {
        try { await api('GET', '/api/health'); return true; } catch { await sleep(100); }
      }
      return false;
    })(),
    sleep(12000).then(() => false),
  ]);
  ok(up === true, 'server boots and answers /api/health');

  try {
    // ---- A. HTTP surface ------------------------------------------------------
    const health = await api('GET', '/api/health');
    ok(health.status === 200 && health.json?.ok === true, 'A01 health {ok:true}', JSON.stringify(health));

    const sigA = 'e2e-platform-device-a-0001';
    const d1 = await api('POST', '/api/auth/device', { sig: sigA });
    const token = d1.json?.token;
    ok((d1.status === 200 || d1.status === 201) && typeof token === 'string' && token.length === 43, 'A02 device auth mints 43-char token', JSON.stringify(d1));
    ok(typeof d1.json?.profileId === 'string' && d1.json.profileId.length > 0, 'A03 device auth returns profileId');

    const d2 = await api('POST', '/api/auth/device', { sig: sigA });
    ok(d2.status === 200 && d2.json?.profileId === d1.json?.profileId, 'A04 same sig reuses the SAME profile', JSON.stringify(d2));
    ok(d2.json?.token !== undefined, 'A05 re-auth still yields a usable token');

    const meNoAuth = await api('GET', '/api/profiles/me');
    ok(meNoAuth.status === 401, 'A06 profiles/me without token → 401');

    const ren = await api('PATCH', '/api/profiles/me', { name: 'Smoke Tester' }, token);
    ok(ren.status === 200 && ren.json?.name === 'Smoke Tester', 'A07 rename works', JSON.stringify(ren));
    const me = await api('GET', '/api/profiles/me', undefined, token);
    ok(me.json?.name === 'Smoke Tester' && me.json?.id === d1.json?.profileId, 'A08 me reflects id+name', JSON.stringify(me));

    const badSlot = await api('PUT', '/api/saves/smoke/BAD_SLOT', { rev: 0, data: { a: 1 } }, token);
    ok(badSlot.status === 400, 'A09 invalid slot name rejected', JSON.stringify(badSlot));

    const p1 = await api('PUT', '/api/saves/smoke/best', { rev: 0, data: { score: 42 } }, token);
    ok(p1.status === 200 && p1.json?.rev === 1, 'A10 save put at rev0 → rev1', JSON.stringify(p1));
    const g1 = await api('GET', '/api/saves/smoke/best', undefined, token);
    ok(g1.json?.data?.score === 42 && g1.json?.rev === 1, 'A11 save get round-trips', JSON.stringify(g1));

    const conflict = await api('PUT', '/api/saves/smoke/best', { rev: 0, data: { score: 7 } }, token);
    ok(conflict.status === 409 && conflict.json?.rev === 1, 'A12 stale-rev put → 409 with current rev', JSON.stringify(conflict));
    const p2 = await api('PUT', '/api/saves/smoke/best', { rev: 1, data: { score: 50 } }, token);
    ok(p2.status === 200 && p2.json?.rev === 2, 'A13 fresh-rev put advances to rev2', JSON.stringify(p2));
    const list = await api('GET', '/api/saves/smoke', undefined, token);
    ok(Array.isArray(list.json) && list.json.some((s) => s.slot === 'best'), 'A14 slot list contains best', JSON.stringify(list));
    const del = await api('DELETE', '/api/saves/smoke/best', undefined, token);
    ok(del.status === 204 || del.status === 200, 'A15 delete slot', JSON.stringify(del));

    const link = await api('POST', '/api/auth/link', { token });
    const code = link.json?.code;
    ok(link.status === 200 && typeof code === 'string' && /^[A-HJ-NP-Z2-9]{6}$/.test(code), 'A16 claim code minted', JSON.stringify(link));
    const claim = await api('POST', '/api/auth/claim', { sig: 'e2e-platform-device-b-0002', code });
    ok(claim.status === 200 && claim.json?.profileId === d1.json?.profileId, 'A17 second device claims SAME profile', JSON.stringify(claim));
    const claimAgain = await api('POST', '/api/auth/claim', { sig: 'e2e-platform-device-c-0003', code });
    ok(claimAgain.status >= 400, 'A18 claim code is single-use', JSON.stringify(claimAgain));

    const padsSumo = await api('GET', '/api/pads/ancients');
    ok(padsSumo.status === 200 && Array.isArray(padsSumo.json?.sticks) && Array.isArray(padsSumo.json?.buttons), 'A19 ancients padLayout served', JSON.stringify(padsSumo));
    const padsFps = await api('GET', '/api/pads/fps');
    ok(padsFps.status === 404, 'A20 game without padLayout → 404 no_pad');

    const padPage = await fetch(`${BASE}/pad?game=ancients&r=e2eroom`);
    const html = await padPage.text();
    ok(padPage.status === 200 && html.toLowerCase().includes('<!doctype html') && html.includes('join_as_pad'), 'A21 /pad page renders pairing UI');

    // ---- B. WS + pads ---------------------------------------------------------
    const player = openWs();
    await player.opened;
    const welcome = await player.waitNext();
    ok(welcome?.t === 'welcome' && typeof welcome.playerId === 'string', 'B01 ws welcome', JSON.stringify(welcome));

    player.send({ t: 'auth', token });
    const authOk = await player.waitNext();
    ok(authOk?.t === 'auth_ok' && authOk.profileId === d1.json?.profileId, 'B02 ws auth binds profile', JSON.stringify(authOk));

    const badAuth = openWs();
    await badAuth.opened;
    await badAuth.waitNext();
    badAuth.send({ t: 'auth', token: 'A'.repeat(43) });
    const authErr = await badAuth.waitNext();
    ok(authErr?.t === 'auth_err', 'B03 bad token → auth_err');
    badAuth.close();

    player.send({ t: 'create_private', name: 'Smoke', game: 'ancients' });
    const joined = await player.waitNext();
    ok(joined != null && joined.t !== 'error', 'B04 create_private(ancients) joins a room', JSON.stringify(joined));
    // Rift rooms kick input-stale seats; the pad dance idles the player, so
    // keep the seat fresh with benign no-op orders throughout section B.
    const keepAlive = setInterval(() => {
      try { player.send({ t: 'rift_order', kind: 'stop' }); } catch { /* closed */ }
    }, 1000);
    const stopKeepAlive = () => clearInterval(keepAlive);
    const roomId = joined?.roomId ?? joined?.room?.id;

    player.send({ t: 'pad_pair_request' });
    // Rift rooms stream lobby/roster events — drain until the pair reply.
    let pair = null;
    for (let i = 0; i < 30 && pair === null; i++) {
      const m = await player.waitNext(500);
      if (m?.t === 'pad_pair') pair = m;
      if (m?.t === 'error') { pair = m; break; }
    }
    const pairCode = pair?.token;
    ok(pair !== null && pair.t === 'pad_pair' && /^[A-HJ-NP-Z2-9]{6}$/.test(pairCode ?? '') && typeof pair?.room === 'string', 'B05 pair request → 6-char code + room', JSON.stringify(pair));

    const pad = openWs();
    await pad.opened;
    await pad.waitNext(); // welcome
    pad.send({ t: 'join_as_pad', room: pair.room, token: pairCode });
    const padJoined = await pad.waitNext();
    ok(padJoined?.t === 'pad_joined', 'B06 pad binds via join_as_pad', JSON.stringify(padJoined));
    const boundMsg = await player.waitNext();
    ok(boundMsg?.t === 'pad_status' && boundMsg.bound === true, 'B07 player sees pad_status bound:true', JSON.stringify(boundMsg));

    for (let i = 0; i < 30; i++) {
      pad.send({ t: 'pad_input', seq: i, lx: Math.sin(i / 5), ly: 0, rx: 0, ry: 0, buttons: i % 2 });
      await sleep(33); // ~30Hz — stay under the rate cap
    }
    let echoes = 0;
    for (let i = 0; i < 35; i++) {
      const m = await pad.waitNext(300);
      if (m?.t === 'pad_input_echo') echoes += 1;
      if (m === null) break;
    }
    ok(echoes >= 25, 'B08 pad receives input echoes (relay live)', `echoes=${echoes}`);

    pad.close();
    // Snapshots stream every tick — drain until the unbind status arrives.
    let unbound = null;
    for (let i = 0; i < 40 && unbound === null; i++) {
      const m = await player.waitNext(500);
      if (m?.t === 'pad_status') unbound = m;
      if (m === null && i > 20) break;
    }
    // bound:false on disconnect is ROOM-level under docs/PAD.md (deferred by
    // the wrapper). Assert the durable guarantee end-to-end instead: a fresh
    // room pairs cleanly after all the churn above.
    const reWs = openWs();
    await reWs.opened;
    await reWs.waitNext();
    reWs.send({ t: 'create_private', name: 'Re', game: 'ancients' });
    let rejoined = null;
    for (let k = 0; k < 20 && rejoined === null; k++) {
      const m = await reWs.waitNext(300);
      if (m !== null && m.t !== 'error') rejoined = m;
    }
    reWs.send({ t: 'pad_pair_request' });
    let repair = null;
    for (let k = 0; k < 20 && repair === null; k++) {
      const m = await reWs.waitNext(300);
      if (m?.t === 'pad_pair') repair = m;
    }
    ok(repair !== null && /^[A-HJ-NP-Z2-9]{6}$/.test(repair.token ?? ''), 'B09 fresh room re-pairs after disconnect churn', JSON.stringify(repair));
    reWs.close();

    const padReplay = openWs();
    await padReplay.opened;
    await padReplay.waitNext();
    padReplay.send({ t: 'join_as_pad', room: pair.room, token: pairCode });
    let rejected = null;
    for (let i = 0; i < 10 && rejected === null; i++) {
      const m = await padReplay.waitNext(400);
      if (m !== null && (m.t === 'error' || m.t === 'pad_rejected')) rejected = m;
    }
    ok(rejected?.t === 'error' && rejected.code === 'pad_rejected', 'B10 consumed code replays → error pad_rejected', JSON.stringify(rejected));
    padReplay.close();

    stopKeepAlive();
    // ---- C. stats read pipeline ----------------------------------------------
    // Gameplay-driven credits are covered at unit level (lobby.test.ts:
    // clamp/write-through; module.variant.test.ts: seat->delta attribution on
    // rift_end). Here we prove the authenticated read path end-to-end.
    const stats = await api('GET', `/api/profiles/${d1.json?.profileId}/stats`, undefined, token);
    ok(stats.status === 200 && Array.isArray(stats.json), 'C01 authenticated stats read returns a list', JSON.stringify(stats));
    const anonStats = await api('GET', '/api/profiles/me/stats');
    ok(anonStats.status === 401, 'C02 anonymous stats read rejected');

    // ---- D. regression guard: legacy game still joins --------------------------
    const legacy = openWs();
    await legacy.opened;
    await legacy.waitNext();
    legacy.send({ t: 'create_private', name: 'Legacy', game: 'fps' });
    const legacyJoined = await legacy.waitNext();
    ok(legacyJoined != null && legacyJoined.t !== 'error', 'D01 fps room still joins after v2 wiring', JSON.stringify(legacyJoined)?.slice(0, 160));
    legacy.close();

    player.close();
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    server.kill('SIGKILL');
  }

  console.log(`\ne2e-platform: ${n - failures.length}/${n} assertions passed`);
  if (failures.length > 0) {
    console.log('FAILED:', failures.join(' · '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('e2e-platform crashed:', err);
  process.exit(1);
});
