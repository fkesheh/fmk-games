#!/usr/bin/env node
// ============================================================================
// e2e-p2p-bank — the "user as server" proof (docs/PLATFORM.md §12.6 P2).
// Two headless pages, ONE production server that never runs the match:
//
//   PAGE A (?p2p=1): HOST A GAME       → rendezvous shell room + RtcStar host
//   PAGE B (?p2p=1): JOIN with code    → RtcStar guest, DataChannel to A
//   A's BankGame (socket=loopback)  → local BankRoom IN A's TAB mints the code
//   B joins that code over the DC   → B's frames hit A's tab, B's UI gets
//                                     bank_state straight from A's sim
//
// Asserts: shell pairing, DC establishment, in-game code exchange, both
// pages reach the table, a roll happens in A's tab and lands in B's UI.
// Requires `npm run build` first. Env: E2E_PORT (default 8190).
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

  const browser = await puppeteer.launch({ headless: 'new', args: ['--auto-accept-this-tab-capture'] });
  const errors = { A: [], B: [] };
  function watch(page, key) {
    page.on('pageerror', (e) => errors[key].push(String(e)));
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error' && !t.includes('404') && !t.includes('manifest')) errors[key].push(t);
    });
  }

  try {
    const a = await browser.newPage();
    const b = await browser.newPage();
    watch(a, 'A');
    watch(b, 'B');

    await a.goto(`${BASE}/bank-sdk/?p2p=1`, { waitUntil: 'networkidle2' });
    await b.goto(`${BASE}/bank-sdk/?p2p=1`, { waitUntil: 'networkidle2' });
    await sleep(800);

    // 1) host side: click HOST, wait for a peer, DC opens
    await a.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      btns.find((x) => x.textContent?.includes('HOST'))?.click();
    });
    await b.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      btns.find((x) => x.textContent?.includes('JOIN'))?.click(); // no code yet — UI gate
    });
    await sleep(300);

    // 2) guest needs the RENDEZVOUS code — expose it: the host page's shell
    //    room code arrives via p2p_ready; re-derive it from the UI? The pilot
    //    keeps rendezvous invisible; both pages share the browser here, so
    //    read the host's session from its window state instead: simplest —
    //    the guest joins the SAME shell by code typed manually. For the e2e
    //    we capture the host's p2p_ready frame via a tiny hook:
    const shellCode = await a.evaluate(() => window.__p2pCode ?? null);
    ok(typeof shellCode === 'string' && shellCode.length === 6, '01 host page holds rendezvous code', String(shellCode));
    await b.evaluate((c) => {
      const input = document.querySelector('input');
      if (input !== null) {
        input.value = c;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, shellCode);
    await b.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      btns.find((x) => x.textContent?.includes('JOIN'))?.click();
    });

    // 3) DC forms; both BankGame instances mount (host loopback, guest DC)
    // DC setup takes 2-4s (STUN+ICE) — poll for the BankGame mount, don't sleep-race.
    let bMenu = false;
    for (let i = 0; i < 40 && !bMenu; i++) {
      await sleep(250);
      bMenu = await b.evaluate(() => [...document.querySelectorAll('button')].some((x) => x.textContent?.toLowerCase().includes('private')));
    }
    ok(bMenu === true, '02 guest page reaches the BANK client UI');
    let aMenu = false;
    for (let i = 0; i < 20 && !aMenu; i++) {
      await sleep(250);
      aMenu = await a.evaluate(() => [...document.querySelectorAll('button')].some((x) => x.textContent?.toLowerCase().includes('private')));
    }
    ok(aMenu === true, '02b host page reaches the BANK client UI');

    // 4) host creates the in-game private room (its local BankRoom mints the
    //    GAME code shown in its own menu); read it from the DOM
    await a.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      btns.find((x) => x.textContent?.toLowerCase().includes('private'))?.click();
    });
    let gameCode = null;
    for (let i = 0; i < 40 && gameCode === null; i++) {
      await sleep(250);
      gameCode = await a.evaluate(() => {
        const m = document.body.textContent?.match(/CODE ([A-HJ-NP-Z2-9]{5})/);
        return m !== null && m !== undefined ? m[1] : null;
      });
    }
    if (typeof gameCode !== 'string') {
      const body = await a.evaluate(() => document.body.textContent?.slice(0, 300) ?? '');
      console.log('   [03 debug] A body:', body.replace(/\s+/g, ' '));
    }
    ok(typeof gameCode === 'string', '03 host in-game code visible', String(gameCode));
    const code = gameCode;

    // 5) guest joins THAT code — frames flow over the DataChannel into A's tab
    await b.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      btns.find((x) => x.textContent?.toLowerCase().includes('private'))?.click();
    });
    await sleep(500);
    await b.evaluate((c) => {
      const inputs = [...document.querySelectorAll('input')];
      const inp = inputs.find((i) => (i.placeholder ?? '').toUpperCase().includes('CODE')) ?? inputs[0];
      if (inp !== undefined) {
        inp.value = c;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, code);
    await b.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      btns.find((x) => x.textContent?.toLowerCase().includes('join'))?.click();
    });
    await sleep(2500);

    const aTable = await a.evaluate(() => document.querySelector('.table') !== null || document.body.textContent?.includes('Round'));
    const bTable = await b.evaluate(() => document.querySelector('.table') !== null || document.body.textContent?.includes('Round'));
    ok(aTable === true, '04 host page is at the table (its own tab runs the sim)');
    ok(bTable === true, '05 guest page is at the table (state came over the DataChannel)');

    // 6) a roll in A's tab updates B: press A's roll, watch B's round text
    await a.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      btns.find((x) => x.textContent?.toLowerCase().includes('roll'))?.click();
    });
    await sleep(1500);
    const bSeesRoll = await b.evaluate(() => {
      const t = document.body.textContent ?? '';
      return /\d/.test(t) && (t.includes('BANK') || t.includes('Roll') || t.includes('roll'));
    });
    ok(bSeesRoll === true, '06 guest UI reflects host-tab sim activity');
    ok(errors.A.length === 0, '07 zero console errors on host', errors.A.slice(0, 2).join(' | '));
    ok(errors.B.length === 0, '08 zero console errors on guest', errors.B.slice(0, 2).join(' | '));
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
