#!/usr/bin/env node
// ============================================================================
// e2e-p2p-ancients — ANCIENTS·SDK host-authoritative P2P proof (§12.6): two
// headless pages, ONE production server that never runs the match. Host
// creates a private room through the debug surface → guest joins by code over
// the DataChannel → seating gate → host START → both reach live with the host
// tab simming. Asserts shared state both pages can only get from one live
// sim. A MOBA match is long, so this proves SHARED SIMULATION (same ticks,
// same board, mutual entity visibility) — never a win.
//
// Drives window.__ancients (the main.ts alias of the frozen __rift surface),
// never __rift directly: the alias itself is under test.
//
// Requires `npm run build` first (ancients dist must contain the P2P
// transport — default boot is P2P; ?online=1 is the escape). Env: E2E_PORT
// (default 8195).
//
// P2P lessons applied (kart/outpost): headless:'shell' (rAF ticks on every
// page), 640x360 viewports (SwiftShader cost starves ICE), health-gated boot,
// domcontentloaded (networkidle2 flakes), START gated on seated proof (DC
// join lags the code display), live HUD/parsed snaps asserted (never static
// chrome), zero console/page errors.
// ============================================================================
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8195);
const BASE = `http://127.0.0.1:${PORT}`;
const SETTINGS = { teamSize: 2, speed: 20 };
// speed is the room's public e2e hook (CONTRACT §2): the host tab renders the
// full three.js scene under SwiftShader while feeding its tick interval, so
// at speed 1 the sim crawls (~1 game-tps measured — creeps spawn at tick 200
// and would never arrive). At speed 20 on ANGLE-SwiftShader the same tab sims
// at ~12 game-tps: first wave lands ~16s wall, the mid clash ~1min, the hero
// walk to mid ~15s. e2e-rift uses the same setting for the same reason. A
// short P2P match can never end under us: 12+ game-minutes at ~12tps is still
// ~20min of wall clock.
const MID = 48; // map side is 96 at 1 lane (teamSize 2) — mid is (48,48)

let n = 0;
const failures = [];
function ok(cond, label, extra = '') {
  n += 1;
  console.log(`${String(n).padStart(2, '0')} ${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : ` — ${extra}`}`);
  if (!cond) failures.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ancState = (pg) => pg.evaluate(() => {
  try {
    return window.__ancients?.state() ?? null;
  } catch {
    return null;
  }
});
const lastSnap = (pg) => pg.evaluate(() => {
  try {
    const s = window.__ancients?.snaps() ?? [];
    return s.length > 0 ? s[s.length - 1] : null;
  } catch {
    return null;
  }
});
const lastFrame = (pg, t) => pg.evaluate((tag) => {
  try {
    const log = window.__ancients?.messageLog() ?? [];
    for (let i = log.length - 1; i >= 0; i--) {
      const m = log[i];
      if (m !== null && typeof m === 'object' && m.t === tag) return m;
    }
    return null;
  } catch {
    return null;
  }
}, t);

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // page mid-navigation etc. — keep polling
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout (${timeoutMs}ms) waiting for ${label}`);
    await sleep(250);
  }
}

async function main() {
  // Hermetic static serving: the platform proxies a game to its vite dev
  // server when localhost:<devPort> answers the one-shot probe, and a stale
  // dev server from another checkout (IPv6-loopback-only is enough) would
  // silently replace the built client under test. The child gets IPv4-first
  // DNS order PLUS Happy Eyeballs disabled, so 'localhost' probes try
  // 127.0.0.1 only (refused with no IPv4 dev server) and every mount —
  // including /ancients/ — serves its built dist. Order alone does not
  // suffice: refused-first-then-fallback would still reach an IPv6 dev
  // server. No-ops in a clean env (probes refuse either way).
  const childNodeOpts = `${process.env.NODE_OPTIONS ?? ''} --dns-result-order=ipv4first --no-network-family-autoselection`.trim();
  const server = spawn('node', [path.join(ROOT, 'platform/server/dist/server.js')], {
    env: { ...process.env, PORT: String(PORT), PLATFORM_DB: ':memory:', NODE_OPTIONS: childNodeOpts },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await sleep(2000);
  // Health-gate the browser on the server instead of a fixed sleep.
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await sleep(500);
  }

  // Two SEPARATE browser processes (the e2e-rift pattern), not two contexts
  // in one: each page renders the full three.js scene, and a single browser's
  // shared GPU process serializes both renderers while the host tab must ALSO
  // feed its 3ms sim interval.
  // ANGLE-on-SwiftShader (the e2e-rift relaunch flags), NOT legacy
  // --use-gl=swiftshader: measured on the host tab, legacy GL couples the sim
  // interval to the frame loop (~1 tick/frame, ~0.7 game-tps — first creeps
  // spawn at tick 200 and never arrived); ANGLE yields between frames and the
  // same tab sims at ~12 game-tps with an identical scene.
  const GL_ARGS = [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ];
  const browserA = await puppeteer.launch({
    headless: 'shell',
    args: [
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      ...GL_ARGS,
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  const browserB = await puppeteer.launch({
    headless: 'shell',
    args: [
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      ...GL_ARGS,
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  const errors = { A: [], B: [] };
  try {
    const a = await (await browserA.createBrowserContext()).newPage();
    const b = await (await browserB.createBrowserContext()).newPage();
    for (const [k, pg] of [['A', a], ['B', b]]) {
      pg.on('pageerror', (e) => errors[k].push(String(e)));
      pg.on('console', (m) => {
        const t = m.text();
        if (m.type() === 'error' && !t.includes('404') && !t.includes('manifest') && !t.includes('favicon')) errors[k].push(t);
      });
      // 640x360: SwiftShader cost scales with pixels, and a saturated
      // renderer starves the page's own ICE/DC timers (splat lesson).
      await pg.setViewport({ width: 640, height: 360 });
      await pg.goto(`${BASE}/ancients/`, { waitUntil: 'domcontentloaded' });
    }

    // 00 — fail fast when the served page is NOT the built client (a vite
    // dev proxy would make every check below test the wrong sources).
    // Polled: __p2pDbg lands late in startP2p (after rendezvous welcome).
    let built = null;
    {
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        built = await Promise.all([a, b].map((pg) => pg.evaluate(() => ({
          vite: [...document.scripts].some((s) => s.src.includes('@vite/client')),
          p2pDbg: typeof window.__p2pDbg,
        }))));
        if (built.every((r) => r.vite === false && r.p2pDbg === 'function')) break;
        await sleep(500);
      }
    }
    const builtOk = built.every((r) => r.vite === false && r.p2pDbg === 'function');
    ok(builtOk, '00 both pages serve the BUILT client (no vite dev proxy)', JSON.stringify(built));
    if (!builtOk) throw new Error('served client is not the built dist — refusing to test the wrong sources');

    // 01 — the __ancients alias is live on both pages (P2P boot path).
    const surf = await waitFor(async () => {
      const [sa, sb] = await Promise.all([ancState(a), ancState(b)]);
      return sa !== null && sb !== null ? { sa, sb } : null;
    }, 30000, '__ancients.state() on both pages');
    ok(surf.sa.phase === 'menu' && surf.sb.phase === 'menu', '01 ancients P2P client boots with the __ancients alias on both pages',
      `A.phase=${surf.sa.phase} B.phase=${surf.sb.phase}`);

    // Host creates a private room; the code comes from ITS OWN hello.
    await a.evaluate((s) => window.__ancients.createPrivate('Alice', s), SETTINGS);
    const hosted = await waitFor(async () => {
      const s = await ancState(a);
      return s !== null && s.phase === 'lobby' && s.you !== null ? s : null;
    }, 20000, 'host in lobby after createPrivate');
    const hello = await lastFrame(a, 'rift_hello');
    const code = hello !== null && typeof hello.code === 'string' && hello.code.length > 0 ? hello.code : null;
    ok(code !== null && hosted.team === 0, '02 host createPrivate -> lobby with a private code over the shim',
      `code=${code} team=${hosted.team} hello.teamSize=${hello?.teamSize}`);

    // Guest joins that code — frames ride the DataChannel from here on.
    await b.evaluate((c) => window.__ancients.joinPrivate('Bob', c), code);
    // 03 — SEATING GATE: START is a silent no-op until 2 are seated, and the
    // code display leads the DC join by a round-trip — gate on both pages'
    // rift_lobby showing 2 humans.
    const seated = await waitFor(async () => {
      const [la, lb, sb] = await Promise.all([lastFrame(a, 'rift_lobby'), lastFrame(b, 'rift_lobby'), ancState(b)]);
      return la !== null && lb !== null && sb !== null && sb.phase === 'lobby' && la.humans === 2 && lb.humans === 2
        ? { la, lb, sb }
        : null;
    }, 45000, 'both pages seated (rift_lobby humans=2)');
    ok(seated.la.canStart === true && seated.sb.team === 1, '03 guest joins over the DC — both pages see a 2-human startable lobby',
      `A.canStart=${seated.la.canStart} B.canStart=${seated.lb?.canStart} B.team=${seated.sb.team}`);

    // Host starts; the 3s lobby countdown runs in the HOST tab.
    await a.evaluate(() => window.__ancients.start());
    const begins = await waitFor(async () => {
      const [ba, bb, sa, sb] = await Promise.all([lastFrame(a, 'rift_begin'), lastFrame(b, 'rift_begin'), ancState(a), ancState(b)]);
      return ba !== null && bb !== null && sa?.phase === 'live' && sb?.phase === 'live' ? { ba, bb, sa, sb } : null;
    }, 25000, 'rift_begin on both pages');
    const seats = Object.keys(begins.ba.laneAssignment).length;
    ok(begins.ba.lanes === 1 && begins.ba.teamSize === 2 && begins.bb.lanes === 1 && seats === 4,
      '04 match begin on BOTH pages from the host-tab sim (lanes=1 teamSize=2, 2 humans + 2 bots)',
      `A{lanes=${begins.ba.lanes} teamSize=${begins.ba.teamSize}} B{lanes=${begins.bb.lanes}} seats=${seats}`);

    // 05 — snaps flow live on both pages.
    const flow = await waitFor(async () => {
      const [na, nb] = await Promise.all([lastSnap(a), lastSnap(b)]);
      if (na === null || nb === null) return null;
      if (na.phase !== 'live' || nb.phase !== 'live' || na.you === null || nb.you === null) return null;
      return { na, nb };
    }, 20000, "live snaps with a 'you' on both pages");
    const tick1 = flow.na.matchTick;
    const wall1 = Date.now();
    // Poll for ANY advance (up to 15s): a single short sample can straddle a
    // SwiftShader hitch at match start and read a 0-tick delta on a live sim.
    let flow2 = null;
    {
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && flow2 === null) {
        await sleep(2000);
        const s = await lastSnap(a);
        if (s !== null && s.matchTick > tick1) flow2 = s;
      }
    }
    const tps = flow2 !== null ? (flow2.matchTick - tick1) / ((Date.now() - wall1) / 1000) : 0;
    ok(flow2 !== null && flow2.matchTick > tick1 && flow.na.ents.length > 0 && flow.nb.ents.length > 0,
      '05 live rift_snap stream on BOTH pages (matchTick advances, entities present)',
      `tick ${tick1} -> ${flow2?.matchTick} (~${tps.toFixed(1)} game-tps under SwiftShader) A.ents=${flow.na.ents.length} B.ents=${flow.nb.ents.length}`);

    // 06 — SHARED-SIM proof, part 1: one sim means one clock and one board.
    // Sample both pages until the boards agree, then compare ticks.
    let shared = null;
    {
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && shared === null) {
        const [na, nb] = await Promise.all([lastSnap(a), lastSnap(b)]);
        if (na !== null && nb !== null && JSON.stringify(na.board) === JSON.stringify(nb.board)) {
          shared = { na, nb };
        } else {
          await sleep(300);
        }
      }
    }
    const tickGap = shared !== null ? Math.abs(shared.na.matchTick - shared.nb.matchTick) : null;
    ok(shared !== null && tickGap !== null && tickGap <= 60,
      '06 SAME sim on both pages: identical scoreboard + near-identical matchTick',
      shared === null ? 'boards never agreed within 15s' : `matchTick ${shared.na.matchTick}/${shared.nb.matchTick} (gap ${tickGap}) board=${shared.na.board.length} rows`);

    // 07 + 08 — SHARED-SIM proof, parts 2+3: mutual entity visibility.
    // Both heroes walk to mid (re-issued: a tower may kill a walker and the
    // respawn walks again; sightings latch). Two things can then only be true
    // if both pages read ONE world: each page sees the OTHER team's creeps
    // (07 — they meet at the mid clash and walk past each other), and each
    // page renders the OTHER player's hero entity with a pid match no solo
    // sim could impersonate (08). Polled together: at the host tab's
    // starved tick rate the clash lands ~2min wall in, and the heroes usually
    // arrive first and lend their own vision.
    const youA = (await ancState(a))?.you;
    const youB = (await ancState(b))?.you;
    const teamA = (await ancState(a))?.team;
    const teamB = (await ancState(b))?.team;
    const isCreep = (e) => e.k === 'melee' || e.k === 'ranged' || e.k === 'siege';
    let creepA = null;
    let creepB = null;
    let heroA = false;
    let heroB = false;
    {
      const t0 = Date.now();
      let iter = 0;
      while (Date.now() - t0 < 240000 && !(creepA !== null && creepB !== null && heroA && heroB)) {
        await Promise.all([
          a.evaluate((x, z) => window.__ancients.order('move', x, z), MID, MID),
          b.evaluate((x, z) => window.__ancients.order('move', x, z), MID, MID),
        ]);
        await sleep(2500);
        const [na, nb] = await Promise.all([lastSnap(a), lastSnap(b)]);
        iter += 1;
        if (iter % 12 === 0) {
          console.log(`... visibility poll ${Math.round((Date.now() - t0) / 1000)}s ` +
            `matchTick=${na?.matchTick}/${nb?.matchTick} creepA=${creepA !== null} creepB=${creepB !== null} heroA=${heroA} heroB=${heroB}`);
        }
        if (na !== null) {
          if (creepA === null) {
            const c = na.ents.find((e) => isCreep(e) && e.team !== teamA && e.hp > 0);
            if (c !== undefined) creepA = c;
          }
          if (!heroA && youB !== null && na.ents.some((e) => e.k === 'hero' && e.pid === youB)) heroA = true;
        }
        if (nb !== null) {
          if (creepB === null) {
            const c = nb.ents.find((e) => isCreep(e) && e.team !== teamB && e.hp > 0);
            if (c !== undefined) creepB = c;
          }
          if (!heroB && youA !== null && nb.ents.some((e) => e.k === 'hero' && e.pid === youA)) heroB = true;
        }
      }
    }
    ok(creepA !== null && creepB !== null, "07 each page sees the OTHER team's creeps (one shared world)",
      creepA !== null && creepB !== null
        ? `A sees team${creepA.team} ${creepA.k}#${creepA.id} / B sees team${creepB.team} ${creepB.k}#${creepB.id}`
        : `only A=${creepA !== null} B=${creepB !== null} within 240s`);
    ok(heroA && heroB, "08 each page renders the OTHER player's hero entity at mid",
      `host-sees-guest=${heroA} guest-sees-host=${heroB}`);

    try {
      await a.screenshot({ path: path.join(ROOT, 'screenshots', 'e2e-p2p-ancients-live.png'), timeout: 30000 });
      console.log('shot  e2e-p2p-ancients-live.png');
    } catch {
      console.log('shot  e2e-p2p-ancients-live.png: capture failed — not a gate');
    }
    ok(errors.A.length === 0, '09 zero console/page errors on host', errors.A.slice(0, 2).join(' | '));
    ok(errors.B.length === 0, '10 zero console/page errors on guest', errors.B.slice(0, 2).join(' | '));
  } finally {
    await Promise.all([browserA.close().catch(() => undefined), browserB.close().catch(() => undefined)]);
    server.kill('SIGTERM');
    await sleep(300);
    server.kill('SIGKILL');
  }
  console.log(`\ne2e-p2p-ancients: ${n - failures.length}/${n} assertions passed`);
  if (failures.length > 0) process.exit(1);
}
main().catch((err) => {
  console.error('e2e-p2p-ancients crashed:', err);
  process.exit(1);
});
