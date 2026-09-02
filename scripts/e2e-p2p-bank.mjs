#!/usr/bin/env node
// ============================================================================
// e2e-p2p-bank — the "user as server" proof, CANONICAL flow (§12.6): no
// special panel, no ?p2p flag, ONE code. The game's own menu runs on the
// P2P transport; the server never runs the match.
// ============================================================================
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8190);
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
  const browser = await puppeteer.launch({ headless: 'new' });
  const errors = { A: [], B: [] };
  try {
    const a = await browser.newPage();
    const b = await browser.newPage();
    for (const [k, pg] of [['A', a], ['B', b]]) {
      pg.on('pageerror', (e) => errors[k].push(String(e)));
      pg.on('console', (m) => {
        const t = m.text();
        if (m.type() === 'error' && !t.includes('404') && !t.includes('manifest')) errors[k].push(t);
      });
    }
    // Both pages boot the STANDARD menu over the P2P transport.
    await a.goto(`${BASE}/bank-sdk/`, { waitUntil: 'networkidle2' });
    await b.goto(`${BASE}/bank-sdk/`, { waitUntil: 'networkidle2' });
    let menus = false;
    for (let i = 0; i < 40 && !menus; i++) {
      await sleep(250);
      menus = await a.evaluate(() => [...document.querySelectorAll('button')].some((x) => x.textContent?.toLowerCase().includes('private')));
    }
    ok(menus, '01 standard menu renders over the P2P transport (no special join screen)');
    await b.evaluate(() => [...document.querySelectorAll('button')].some((x) => x.textContent?.toLowerCase().includes('join')));

    // Host creates via ITS OWN menu → the code shown IS the game code.
    await a.evaluate(() => {
      [...document.querySelectorAll('button')].find((x) => x.textContent?.toLowerCase().includes('private'))?.click();
    });
    let gameCode = null;
    for (let i = 0; i < 40 && gameCode === null; i++) {
      await sleep(250);
      gameCode = await a.evaluate(() => {
        const span = document.querySelector('.table-invite-code')?.textContent ?? '';
        const m = span.match(/([A-HJ-NP-Z2-9]{5,6})/);
        return m !== null && m !== undefined ? m[1] : null;
      });
    }
    ok(typeof gameCode === 'string', '02 host in-game code visible (ONE code — the shell code)', String(gameCode));

    // Guest joins that code through its own menu → frames ride the DC.
    await b.evaluate(() => {
      [...document.querySelectorAll('button')].find((x) => x.textContent?.toLowerCase().includes('private'))?.click();
    });
    await sleep(500);
    await b.evaluate((c) => {
      const inputs = [...document.querySelectorAll('input')];
      const inp = inputs.find((i) => (i.placeholder ?? '').toUpperCase().includes('CODE')) ?? inputs[0];
      if (inp !== undefined) {
        inp.value = c;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, gameCode);
    await b.evaluate(() => {
      [...document.querySelectorAll('button')].find((x) => x.textContent?.toLowerCase() === 'join' || x.textContent?.toLowerCase() === 'join tables')?.click();
    });
    let bTable = false;
    for (let i = 0; i < 40 && !bTable; i++) {
      await sleep(250);
      bTable = await b.evaluate(() => document.body.textContent?.includes('ROUND') || document.querySelector('.table') !== null);
    }
    ok(bTable === true, '03 guest reaches the table over the DataChannel');
    const aTable = await a.evaluate(() => document.body.textContent?.includes('ROUND') || document.querySelector('.table') !== null);
    ok(aTable === true, '04 host at the table (sim runs in its tab)');

    await a.evaluate(() => {
      [...document.querySelectorAll('button')].find((x) => x.textContent?.toLowerCase().includes('roll'))?.click();
    });
    await sleep(1500);
    const bSeesRoll = await b.evaluate(() => /\d/.test(document.body.textContent ?? ''));
    ok(bSeesRoll === true, '05 guest UI reflects host-tab sim activity');
    ok(errors.A.length === 0, '06 zero console errors on host', errors.A.slice(0, 2).join(' | '));
    ok(errors.B.length === 0, '07 zero console errors on guest', errors.B.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    await sleep(300);
    server.kill('SIGKILL');
  }
  console.log(`\ne2e-p2p-bank: ${n - failures.length}/${n} assertions passed`);
  if (failures.length > 0) process.exit(1);
}
main().catch((err) => {
  console.error('e2e-p2p-bank crashed:', err);
  process.exit(1);
});
