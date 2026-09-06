#!/usr/bin/env node
// ============================================================================
// e2e-p2p-kart — KART·SDK host-authoritative pilot (docs/PLATFORM.md §12.6):
// two headless pages, ONE production server that never runs the race.
// Host creates private room → guest joins by code over the DataChannel →
// both reach countdown/race with the host tab simming. Asserts shared
// state both pages can only get from one live sim.
// Requires `npm run build` first. Env: E2E_PORT (default 8192).
// ============================================================================
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8192);
const BASE = `http://127.0.0.1:${PORT}`;
let n = 0;
const failures = [];
function ok(cond, label, extra = '') {
  n += 1;
  console.log(`${String(n).padStart(2, '0')} ${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : ` — ${extra}`}`);
  if (!cond) failures.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = spawn('node', [path.join(ROOT, 'platform/server/dist/server.js')], {
    env: { ...process.env, PORT: String(PORT), PLATFORM_DB: ':memory:' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await sleep(4500);
  const browser = await puppeteer.launch({
    // 'shell' (old headless): rAF ticks on EVERY page. 'new' freezes rAF on
    // hidden pages while timers/DC keep running — the sim races but no
    // per-frame HUD (chip, countdown overlay) ever refreshes off-screen.
    headless: 'shell',
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
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
      // Small viewport: SwiftShader raster cost scales with pixels, and a
      // saturated renderer starves the page's own ICE/DC timers (splat lesson).
      await pg.setViewport({ width: 640, height: 360 });
      await pg.goto(`${BASE}/kart-sdk/`, { waitUntil: 'networkidle2' });
    }
    await sleep(1500);
    // Host creates a private room through ITS OWN menu.
    await a.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent === 'CREATE PRIVATE')?.click(); });
    let code = null;
    for (let i = 0; i < 40 && code === null; i++) {
      await sleep(250);
      code = await a.evaluate(() => {
        const s = document.querySelector('.race-invite-code')?.textContent ?? '';
        const m = s.match(/([A-HJ-NP-Z2-9]{5,6})/);
        return m ? m[1] : null;
      });
    }
    ok(typeof code === 'string', '01 host room up with joinable code', String(code));
    // Guest joins that code through ITS OWN menu.
    await b.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent === 'JOIN')?.click(); });
    await sleep(500);
    await b.evaluate((c) => {
      const inputs = [...document.querySelectorAll('input')];
      const inp = inputs.find((i) => (i.placeholder ?? '').toUpperCase().includes('CODE')) ?? inputs[0];
      if (inp !== undefined) { inp.value = c; inp.dispatchEvent(new Event('input', { bubbles: true })); }
    }, code);
    await b.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent?.toLowerCase() === 'join' || x.textContent?.toLowerCase() === 'join tables')?.click(); });
    // Race proof: the countdown overlay unhides ONLY during countdown/GO
    // (per-frame render; static chrome can never fake it).
    async function countdownSeen(pg) {
      for (let i = 0; i < 160; i++) {
        const v = await pg.evaluate(() => !(document.querySelector('.countdown-overlay')?.classList.contains('hidden') ?? true));
        if (v) return true;
        await sleep(250);
      }
      return false;
    }
    // Guest must actually hold the same room before START means anything.
    let gcode = null;
    for (let i = 0; i < 40 && gcode !== code; i++) {
      await sleep(250);
      gcode = await b.evaluate(() => {
        const s = document.querySelector('.race-invite-code')?.textContent ?? document.body.textContent ?? '';
        const m = s.match(/([A-HJ-NP-Z2-9]{5,6})/);
        return m ? m[1] : null;
      });
    }
    ok(gcode === code, '02 guest holds the SAME room code over the DataChannel', String(gcode));
    // Airtight shared-sim proof: the position chip reads `/N` from LIVE
    // snapshots (N = known karts). Solo rooms show /1; only one shared sim
    // shows /2 on BOTH pages. Menu chrome can never fake this.
    // (Reads the HUD chip directly — the old body-text scan matched any /N.)
    async function places(pg) {
      for (let i = 0; i < 120; i++) {
        const v = await pg.evaluate(() => document.querySelector('.hud-pos-total')?.textContent ?? null);
        if (v !== null && v !== '') return v.trim();
        await sleep(250);
      }
      return null;
    }
    // Seating lags the code display by a DC join round-trip: START is a
    // silent no-op until TWO are seated, so gate the click on host /2.
    const pa = await places(a);
    ok(pa === '/2', '03 host sees TWO karts (guest joined its sim)', String(pa));
    // Host starts the race first (kart rooms wait for START).
    await a.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent?.toLowerCase().includes('start'))?.click(); });
    const ra = await countdownSeen(a);
    ok(ra, '04 host reaches countdown after START', String(ra));
    const rb = await countdownSeen(b);
    ok(rb, '05 guest reaches countdown after START', String(rb));
    const pb = await places(b);
    ok(pb === '/2', '06 guest sees TWO karts over the DataChannel', String(pb));
    ok(errors.A.length === 0, '07 zero console errors on host', errors.A.slice(0, 2).join(' | '));
    ok(errors.B.length === 0, '08 zero console errors on guest', errors.B.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    await sleep(300);
    server.kill('SIGKILL');
  }
  console.log(`\ne2e-p2p-kart: ${n - failures.length}/${n} assertions passed`);
  if (failures.length > 0) process.exit(1);
}
main().catch((err) => {
  console.error('e2e-p2p-kart crashed:', err);
  process.exit(1);
});
