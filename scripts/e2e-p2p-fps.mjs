#!/usr/bin/env node
// ============================================================================
// e2e-p2p-fps — FPS·SDK host-authoritative pilot (docs/PLATFORM.md §12.6):
// two headless pages, ONE production server that never runs the match.
// Host creates a public room through ITS OWN menu → guest quick-joins into
// the same shell → the host tab sims (GameRoom) while frames ride the
// DataChannel. START is gated on seated proof; shared-state proof reads
// live snapshots on BOTH pages. Asserts live HUD/state only, never static
// chrome. Requires `npm run build` first. Env: E2E_PORT (default 8193).
//
// NOTE headless:'shell' is MANDATORY — headless:'new' freezes rAF on hidden
// pages while timers/DC keep running, so the sim would advance with no
// per-frame HUD ever refreshing off-screen.
//
// Join-path note: private-code joins are unreachable in P2P — the frozen
// menu caps the code input at PRIVATE_CODE_LEN (5) while shell codes are 6.
// Public create + quick-join is the working path (same as bank's tables).
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
const fpsState = (pg) => pg.evaluate(() => window.__fps?.state() ?? null);

async function main() {
  const server = spawn('node', [path.join(ROOT, 'platform/server/dist/server.js')], {
    env: { ...process.env, PORT: String(PORT), PLATFORM_DB: ':memory:' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await sleep(4500);
  // Cold boots (wordbomb dict + 16-game mount) can take a while: gate the
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
    // hidden pages while timers/DC keep running — the sim advances but no
    // per-frame HUD (chip, START bar, phase banners) ever refreshes off-screen.
    headless: 'shell',
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const errors = { A: [], B: [] };
  let done = false;
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
      // domcontentloaded (not networkidle2): idle-timing flakes under
      // SwiftShader load; the menu poll below is the real readiness gate.
      await pg.goto(`${BASE}/fps-sdk/`, { waitUntil: 'domcontentloaded' });
    }
    await sleep(1500);
    // Both pages boot the STANDARD menu over the P2P transport.
    let menus = false;
    for (let i = 0; i < 80 && !menus; i++) {
      await sleep(250);
      menus = await a.evaluate(() => [...document.querySelectorAll('button')].some((x) => x.textContent === 'QUICK JOIN'));
    }
    ok(menus, '01 standard menu renders over the P2P transport (no special join screen)');
    if (!menus) {
      console.log('\nBLOCKED: /fps-sdk/ is not served — the fps-sdk module is not registered yet (see registration snippet in the task report).');
      done = true;
      return;
    }
    // Host creates a PUBLIC room through ITS OWN menu (map picker default).
    await a.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent === 'CREATE PUBLIC')?.click(); });
    let code = null;
    for (let i = 0; i < 80 && code === null; i++) {
      await sleep(250);
      code = await a.evaluate(() => {
        const s = document.querySelector('.m9-chip-code')?.textContent ?? '';
        const m = s.match(/([A-HJ-NP-Z2-9]{5,6})/);
        return m ? m[1] : null;
      });
    }
    ok(typeof code === 'string', '02 host room up with joinable code (ONE code — the shell code)', String(code));
    // Guest quick-joins into the same public shell through ITS OWN menu.
    await sleep(1000); // let the public shell list before matchmaking runs
    await b.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent === 'QUICK JOIN')?.click(); });
    // Guest must actually hold the same room before START means anything.
    let gcode = null;
    for (let i = 0; i < 80 && gcode !== code; i++) {
      await sleep(250);
      gcode = await b.evaluate(() => document.querySelector('.m9-chip-code')?.textContent?.trim() ?? null);
    }
    ok(gcode === code, '03 guest holds the SAME room code over the DataChannel', String(gcode));
    // Seating gate: START is a silent no-op until TWO are seated, so gate the
    // click on both pages reporting a 2-roster from LIVE snapshots.
    async function seated(pg) {
      for (let i = 0; i < 160; i++) {
        const st = await fpsState(pg);
        if (st !== null && st.rosterSize === 2) return st;
        await sleep(250);
      }
      return await fpsState(pg);
    }
    const [sa, sb] = await Promise.all([seated(a), seated(b)]);
    ok(sa !== null && sa.rosterSize === 2, '04 host sees TWO seated (guest joined its sim)', JSON.stringify(sa === null ? null : { roster: sa.rosterSize, players: sa.players }));
    ok(sb !== null && sb.rosterSize === 2, '05 guest sees TWO seated over the DataChannel', JSON.stringify(sb === null ? null : { roster: sb.rosterSize, players: sb.players }));
    // Host starts the match through the HUD's own START control (real player path).
    for (let i = 0; i < 80; i++) {
      const enabled = await a.evaluate(() => {
        const btn = document.querySelector('.fh-start-btn');
        return btn !== null && !btn.disabled;
      });
      if (enabled) break;
      await sleep(250);
    }
    await a.evaluate(() => { document.querySelector('.fh-start-btn')?.click(); });
    // Shared-sim proof: warmup NEVER ends by itself — a phase past warmup on
    // a page proves it is consuming the host tab's live sim.
    async function leftWarmup(pg) {
      for (let i = 0; i < 160; i++) {
        const st = await fpsState(pg);
        if (st !== null && st.phase !== 'warmup') return st;
        await sleep(250);
      }
      return await fpsState(pg);
    }
    const [pa, pb] = await Promise.all([leftWarmup(a), leftWarmup(b)]);
    ok(pa !== null && pa.phase !== 'warmup', '06 host leaves warmup after START', String(pa === null ? null : pa.phase));
    ok(pb !== null && pb.phase !== 'warmup', '07 guest leaves warmup after START (shared sim)', String(pb === null ? null : pb.phase));
    const match = pa !== null && pb !== null && pa.phase === pb.phase && pa.round === pb.round && pa.round >= 1;
    ok(match, '08 both pages agree on live phase+round', JSON.stringify({ a: pa === null ? null : [pa.phase, pa.round], b: pb === null ? null : [pb.phase, pb.round] }));
    ok(errors.A.length === 0, '09 zero console errors on host', errors.A.slice(0, 2).join(' | '));
    ok(errors.B.length === 0, '10 zero console errors on guest', errors.B.slice(0, 2).join(' | '));
    done = true;
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    await sleep(300);
    server.kill('SIGKILL');
  }
  console.log(`\ne2e-p2p-fps: ${n - failures.length}/${n} assertions passed`);
  if (failures.length > 0 || !done) process.exit(1);
}
main().catch((err) => {
  console.error('e2e-p2p-fps crashed:', err);
  process.exit(1);
});
