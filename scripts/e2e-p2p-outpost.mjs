#!/usr/bin/env node
// ============================================================================
// e2e-p2p-outpost — OUTPOST·SDK host-authoritative pilot (docs/PLATFORM.md
// §12.6): two headless pages, ONE production server that never runs the run.
// Host creates a public room → guest joins through ITS OWN menu (public row
// click = quick_join) over the DataChannel → both reach wave 1 with the host
// tab simming. Asserts shared state both pages can only get from one live sim.
//
// Join-flow note: private-code join is DOM-impossible on this client — the
// join input caps at 5 chars (menus.ts PRIVATE_CODE_LEN) while shell codes
// are 6 — so this script exercises the public matchmaking join (the bank
// scenario-B precedent). The ONE-code proof is asserted by comparing
// state().code on BOTH pages.
//
// Requires `npm run build` first (plus integrator registration of
// outpostModule/outpostSdkModule in platform/server/src/registry.ts).
// Env: E2E_PORT (default 8193).
// ============================================================================
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8193);
const BASE = `http://127.0.0.1:${PORT}`;
let n = 0;
const failures = [];
function ok(cond, label, extra = '') {
  n += 1;
  console.log(`${String(n).padStart(2, '0')} ${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : ` — ${extra}`}`);
  if (!cond) failures.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opState = (pg) => pg.evaluate(() => {
  try {
    return window.__outpost?.state() ?? null;
  } catch {
    return null;
  }
});

async function main() {
  const server = spawn('node', [path.join(ROOT, 'platform/server/dist/server.js')], {
    env: { ...process.env, PORT: String(PORT), PLATFORM_DB: ':memory:' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await sleep(4500);
  // Cold boots (wordbomb dict + 14-game mount) can take a while: gate the
  // browser on the health endpoint instead of a fixed sleep.
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  const browser = await puppeteer.launch({
    // 'shell' (old headless): rAF ticks on EVERY page. 'new' freezes rAF on
    // hidden pages while timers/DC keep running — the sim runs but no
    // per-frame HUD (wave chip, lobby roster) ever refreshes off-screen.
    headless: 'shell',
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const errors = { A: [], B: [] };
  try {
    const ctxA = await browser.createBrowserContext();
    const ctxB = await browser.createBrowserContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    for (const [k, pg] of [['A', a], ['B', b]]) {
      pg.on('pageerror', (e) => errors[k].push(String(e)));
      pg.on('console', (m) => {
        const t = m.text();
        if (m.type() === 'error' && !t.includes('404') && !t.includes('manifest') && !t.includes('favicon')) errors[k].push(t);
      });
      // domcontentloaded (not networkidle2): the client's boot keeps the
      // network busy and idle-timing flakes under SwiftShader load; the
      // __outpost surface poll below is the real readiness gate.
      await pg.goto(`${BASE}/outpost-sdk/`, { waitUntil: 'domcontentloaded' });
    }
    await sleep(1500);
    // Debug surface present on both pages (frozen OutpostDebugApi); poll —
    // the client bundle boots after domcontentloaded.
    let surf = ['state'];
    for (let i = 0; i < 40 && surf.length > 0; i++) {
      await sleep(500);
      surf = await a.evaluate(() => ['state', 'telemetry', 'start', 'clearOverlays'].filter((f) => typeof window.__outpost?.[f] !== 'function'));
    }
    ok(surf.length === 0, '01 outpost-sdk client boots with the debug surface', surf.join(','));
    // Host creates a PUBLIC room through ITS OWN menu.
    await a.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent === 'CREATE PUBLIC')?.click(); });
    let hosted = null;
    for (let i = 0; i < 40 && hosted === null; i++) {
      await sleep(250);
      hosted = await opState(a).then((s) => (s !== null && s.joined ? s : null));
    }
    ok(hosted !== null, '02 host room up (create_public → joined)', JSON.stringify(hosted));
    // Guest joins through ITS OWN menu: the QUICK JOIN button. (Row-click
    // needs the public list, which the P2P shim answers empty at boot; the
    // menu's own empty-state points users at Quick Join. quick_join lands
    // the guest in the host's public shell; the DC carries the rest.)
    await b.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent === 'QUICK JOIN')?.click(); });
    let guestIn = null;
    for (let i = 0; i < 80 && guestIn === null; i++) {
      await sleep(500);
      guestIn = await opState(b).then((s) => (s !== null && s.joined ? s : null));
    }
    ok(guestIn !== null, '03 guest joins the host shell through its own menu', JSON.stringify(guestIn));
    // Seating lags the join by a DC round-trip: START is gated on seated proof.
    let seated = 0;
    for (let i = 0; i < 80 && seated !== 2; i++) {
      await sleep(250);
      seated = (await opState(a))?.seated ?? 0;
    }
    ok(seated === 2, '04 host sees TWO seated (guest joined its sim)', `seated=${seated}`);
    const codeA = (await opState(a))?.code ?? null;
    const codeB = (await opState(b))?.code ?? null;
    ok(typeof codeA === 'string' && codeA === codeB, '05 ONE code on BOTH pages over the DataChannel', `${codeA}/${codeB}`);
    // Dismiss first-run onboarding so the HUD reads live, then START.
    // (Skipped unless both tabs are seated — otherwise every step below
    // would throw instead of recording its FAIL in the scoreboard.)
    if (hosted !== null && guestIn !== null && seated === 2) {
    await a.evaluate(() => window.__outpost.clearOverlays());
    await b.evaluate(() => window.__outpost.clearOverlays());
    await a.evaluate(() => { document.querySelector('.op-start-btn')?.click(); });
    }
    async function phase(pg) {
      for (let i = 0; i < 80; i++) {
        const s = await opState(pg);
        if (s !== null && s.phase === 'wave') return s;
        await sleep(250);
      }
      return await opState(pg);
    }
    const [sa, sb] = await Promise.all([phase(a), phase(b)]);
    ok(sa?.phase === 'wave', '06 host reaches wave 1 after START', JSON.stringify(sa));
    ok(sb?.phase === 'wave', '07 guest reaches wave 1 after START', JSON.stringify(sb));
    // Airtight shared-sim proof: the HUD wave chip reads the wave number from
    // LIVE snapshots (per-frame render; static chrome can never fake it), and
    // the guest's zombie count can only come from the host tab's sim.
    async function waveChip(pg) {
      for (let i = 0; i < 60; i++) {
        const v = await pg.evaluate(() => document.querySelector('.oh-wave-num')?.textContent ?? null);
        if (v !== null && v !== '' && v !== '—') return v.trim();
        await sleep(250);
      }
      return null;
    }
    const [wa, wb] = await Promise.all([waveChip(a), waveChip(b)]);
    ok(wa === '1' && wb === '1', '08 live HUD wave chip reads 1 on BOTH pages', `${wa}/${wb}`);
    let gz = -1;
    for (let i = 0; i < 80 && gz <= 0; i++) {
      await sleep(500);
      gz = await b.evaluate(() => {
        try {
          return window.__outpost.telemetry().zombiesAlive;
        } catch {
          return -1;
        }
      });
    }
    ok(gz > 0, '09 guest renders host-simmed zombies (shared sim proof)', `zombiesAlive=${gz}`);
    ok(errors.A.length === 0, '10 zero console errors on host', errors.A.slice(0, 2).join(' | '));
    ok(errors.B.length === 0, '11 zero console errors on guest', errors.B.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    await sleep(300);
    server.kill('SIGKILL');
  }
  console.log(`\ne2e-p2p-outpost: ${n - failures.length}/${n} assertions passed`);
  if (failures.length > 0) process.exit(1);
}
main().catch((err) => {
  console.error('e2e-p2p-outpost crashed:', err);
  process.exit(1);
});
