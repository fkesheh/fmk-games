#!/usr/bin/env node
// ============================================================================
// e2e-p2p-splat — SPLAT·SDK host-authoritative pilot (docs/PLATFORM.md §12.6):
// two headless pages, ONE production server that never runs the race.
// Host creates private room → guest joins by code over the DataChannel →
// both reach countdown/race with the host tab simming. Asserts shared
// state both pages can only get from one live sim.
// Requires `npm run build` first. Env: E2E_PORT (default 8193).
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
    args: [
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
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
      await pg.setViewport({ width: 640, height: 360 });
      await pg.goto(`${BASE}/splat-sdk/`, { waitUntil: 'networkidle2' });
    }
    await sleep(1500);
    // Host creates a private room through ITS OWN menu (real button click).
    await a.evaluate(() => {
      for (const el of document.querySelectorAll('.menu-name')) el.value = 'Holly';
      [...document.querySelectorAll('button')].find((x) => x.textContent === 'CREATE PRIVATE')?.click();
    });
    // The invite code: state().code first (the client's own join receipt),
    // then the lobby overlay's CODE line (element-scoped — never body text).
    let code = null;
    for (let i = 0; i < 40 && code === null; i++) {
      await sleep(250);
      code = await a.evaluate(() => {
        try {
          const s = window.__splat?.state?.();
          if (s && typeof s.code === 'string' && s.code.length > 0) return s.code;
        } catch { /* surface not ready yet */ }
        const s = document.querySelector('.lobby-code')?.textContent ?? '';
        const m = s.match(/([A-HJ-NP-Z2-9]{5,6})/);
        return m ? m[1] : null;
      });
    }
    ok(typeof code === 'string', '01 host room up with joinable code', String(code));
    // Guest joins that code through ITS OWN menu: type + JOIN BY CODE.
    await b.evaluate((c) => {
      for (const el of document.querySelectorAll('.menu-name')) el.value = 'Gus';
      const inputs = [...document.querySelectorAll('input')];
      const inp = inputs.find((i) => (i.placeholder ?? '').toUpperCase().includes('CODE')) ?? inputs[0];
      if (inp !== undefined) { inp.value = c; inp.dispatchEvent(new Event('input', { bubbles: true })); }
    }, code);
    await b.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent === 'JOIN BY CODE')?.click(); });
    // Guest must actually hold the same room before START means anything.
    let gcode = null;
    for (let i = 0; i < 40 && gcode !== code; i++) {
      await sleep(250);
      gcode = await b.evaluate(() => {
        try {
          const s = window.__splat?.state?.();
          if (s && typeof s.code === 'string' && s.code.length > 0) return s.code;
        } catch { /* surface not ready yet */ }
        const s = document.querySelector('.lobby-code')?.textContent ?? '';
        const m = s.match(/([A-HJ-NP-Z2-9]{5,6})/);
        return m ? m[1] : null;
      });
    }
    ok(gcode === code, '02 guest holds the SAME room code over the DataChannel', String(gcode));
    // Seating lags the code display by a DC round-trip: START is a silent
    // no-op until TWO are seated, so gate the click on chips === 2 on BOTH
    // pages. The lobby roster only fills from the host tab's live sim.
    async function chips(pg) {
      for (let i = 0; i < 120; i++) {
        const v = await pg.evaluate(() => document.querySelectorAll('.lobby-players .player-chip').length);
        if (v === 2) return v;
        await sleep(250);
      }
      return await pg.evaluate(() => document.querySelectorAll('.lobby-players .player-chip').length);
    }
    const ca = await chips(a);
    ok(ca === 2, '03 host seats TWO skiers (guest joined its sim)', String(ca));
    const cb = await chips(b);
    ok(cb === 2, '04 guest seats TWO skiers over the DataChannel', String(cb));
    // Host starts the race through ITS OWN START button (waits for canStart).
    for (let i = 0; i < 80; i++) {
      const ready = await a.evaluate(() => {
        try { return window.__splat?.state?.()?.canStart === true; } catch { return false; }
      });
      if (ready) break;
      await sleep(250);
    }
    await a.evaluate(() => { document.querySelector('.lobby-start')?.click(); });
    // Race proof: the countdown overlay unhides ONLY during countdown/GO
    // (per-frame render; static chrome can never fake it).
    async function countdownSeen(pg) {
      for (let i = 0; i < 160; i++) {
        const v = await pg.evaluate(() => !(document.querySelector('.sh-countdown')?.classList.contains('hidden') ?? true));
        if (v) return true;
        await sleep(250);
      }
      return false;
    }
    const ra = await countdownSeen(a);
    ok(ra, '05 host reaches countdown after START', String(ra));
    const rb = await countdownSeen(b);
    ok(rb, '06 guest reaches countdown after START', String(rb));
    // Shared-sim proof on BOTH pages: each interpolates the OTHER skier —
    // a remote sample exists only from snapshots of one shared sim.
    async function remotes(pg) {
      for (let i = 0; i < 120; i++) {
        const v = await pg.evaluate(() => {
          try { return window.__splat?.telemetry?.()?.remotes?.length ?? null; } catch { return null; }
        });
        if (v === 1) return v;
        await sleep(250);
      }
      return await pg.evaluate(() => {
        try { return window.__splat?.telemetry?.()?.remotes?.length ?? null; } catch { return null; }
      });
    }
    const ma = await remotes(a);
    const mb = await remotes(b);
    ok(ma === 1 && mb === 1, '07 both pages interpolate the OTHER skier (1 remote each)', `A=${String(ma)} B=${String(mb)}`);
    ok(errors.A.length === 0, '08 zero console errors on host', errors.A.slice(0, 2).join(' | '));
    ok(errors.B.length === 0, '09 zero console errors on guest', errors.B.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    await sleep(300);
    server.kill('SIGKILL');
  }
  console.log(`\ne2e-p2p-splat: ${n - failures.length}/${n} assertions passed`);
  if (failures.length > 0) process.exit(1);
}
main().catch((err) => {
  console.error('e2e-p2p-splat crashed:', err);
  process.exit(1);
});
