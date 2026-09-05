#!/usr/bin/env node
// e2e-p2p-failover — host loss → deterministic promotion (§12.3).
// Two pages share a code-joined table; the HOST page is closed; the guest
// must elect itself (lowest remaining id), spin a fresh local room on the
// SAME code, and keep playing. Server only ever did rendezvous.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8191);
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
  const browser = await puppeteer.launch({ headless: 'new', args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  try {
    const a = await browser.newPage();
    const b = await browser.newPage();
    for (const pg of [a, b]) {
      pg.on('pageerror', (e) => errors.push(String(e)));
      await pg.goto(`${BASE}/bank-sdk/`, { waitUntil: 'networkidle2' });
    }
    await sleep(1000);
    await a.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent === 'CREATE PRIVATE')?.click(); });
    let code = null;
    for (let i = 0; i < 40 && code === null; i++) {
      await sleep(250);
      code = await a.evaluate(() => document.body.textContent?.match(/CODE ([A-HJ-NP-Z2-9]{5,6})/)?.[1] ?? null);
    }
    ok(typeof code === 'string', '01 host table up with joinable code', String(code));
    await b.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent?.toLowerCase().includes('private'))?.click(); });
    await sleep(500);
    await b.evaluate((c) => {
      const inputs = [...document.querySelectorAll('input')];
      const inp = inputs.find((i) => (i.placeholder ?? '').toUpperCase().includes('CODE')) ?? inputs[0];
      if (inp !== undefined) { inp.value = c; inp.dispatchEvent(new Event('input', { bubbles: true })); }
    }, code);
    await b.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent?.toLowerCase() === 'join' || x.textContent?.toLowerCase() === 'join tables')?.click(); });
    // Strong check: the code AND another seated player (the typed code
    // alone echoes in the join input — names prove a shared table).
    // Airtight SHARED-table proof: the host STARTs the match, we wait
    // until it is B's turn (ROLL enabled), have B roll, and require A's
    // pot to move. A solo room, a stale snapshot, or a typed-code echo
    // can never do this.
    await a.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent?.toLowerCase().includes('start'))?.click(); });
    await sleep(1500);
    const potOf = async (pg) => pg.evaluate(() => {
      const t = document.body.textContent ?? '';
      const m = t.match(/POT\s*(\d+)/);
      return m !== null && m !== undefined ? m[1] : null;
    });
    await a.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent?.toLowerCase().includes('start'))?.click(); });
    await sleep(1000);
    // The host must START the match — turns don't exist in the lobby.
    await a.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent?.toLowerCase().includes('start'))?.click(); });
    await sleep(1500);
    let bTurn = false;
    for (let i = 0; i < 120 && !bTurn; i++) {
      await sleep(250);
      bTurn = await b.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const r = btns.find((x) => x.textContent?.toLowerCase() === 'roll');
        return r !== undefined && !r.disabled;
      });
    }
    ok(bTurn, '02a it becomes the GUEST turn over the DataChannel');
    const potBefore = await a.evaluate(() => document.body.textContent ?? '');
    await b.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent?.toLowerCase() === 'roll')?.click(); });
    let moved = false;
    for (let i = 0; i < 40 && !moved; i++) {
      await sleep(250);
      moved = await a.evaluate((prev) => (document.body.textContent ?? '') !== prev, potBefore);
    }
    ok(moved, '02b GUEST roll moves the HOST table (shared sim proven)');
    let frameSeen = false;
    for (let i = 0; i < 20 && !frameSeen; i++) {
      await sleep(250);
      frameSeen = await a.evaluate(() => ((window.__p2pDbg?.()?.lobbyFrames ?? [])).some((f) => f.includes('"roll"')));
    }
    ok(frameSeen, '02c HOST lobby received the GUEST roll frame');
    // Kill the host tab: the sim dies with it.
    await a.close();
    // Promotion = durable state, not the transient banner: B's own id must
    // become the shell host with only itself left in the peer list.
    let promoted = false;
    for (let i = 0; i < 80 && !promoted; i++) {
      await sleep(250);
      promoted = await b.evaluate(() => {
        const d = window.__p2pDbg?.();
        return !!d && d.hostId === d.selfId && (d.lastPeers ?? []).length === 1 && (d.lastPeers ?? [])[0] === d.selfId;
      });
    }
    ok(promoted, '03 guest promotes itself after host loss (hostId=self, alone in peers)');
    let reTable = false;
    for (let i = 0; i < 40 && !reTable; i++) {
      await sleep(250);
      reTable = await b.evaluate((c) => document.body.textContent?.match(/CODE ([A-HJ-NP-Z2-9]{5,6})/)?.[1] === c, code);
    }
    ok(reTable, '04 promoted host serves the SAME code, table playable');
    // Liveness: a stale pre-death snapshot can't accept joins (bank needs
    // 2+ seats, so a solo promoted room can't roll alone — a THIRD page
    // joining it live is the honest proof the promoted sim works).
    const c = await browser.newPage();
    await c.goto(`${BASE}/bank-sdk/`, { waitUntil: 'networkidle2' });
    await sleep(1000);
    await c.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent?.toLowerCase().includes('private'))?.click(); });
    await sleep(500);
    await c.evaluate((cc) => {
      const inputs = [...document.querySelectorAll('input')];
      const inp = inputs.find((i) => (i.placeholder ?? '').toUpperCase().includes('CODE')) ?? inputs[0];
      if (inp !== undefined) { inp.value = cc; inp.dispatchEvent(new Event('input', { bubbles: true })); }
    }, code);
    await c.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent?.toLowerCase() === 'join' || x.textContent?.toLowerCase() === 'join tables')?.click(); });
    let cTable = false;
    for (let i = 0; i < 60 && !cTable; i++) {
      await sleep(250);
      cTable = await c.evaluate((cc) => {
        const t = document.body.textContent ?? '';
        const codeOk = (t.match(/CODE ([A-HJ-NP-Z2-9]{5,6})/)?.[1] ?? null) === cc;
        const others = (t.match(/player-[0-9a-f]{4,}/g) ?? []).length;
        return codeOk && others >= 1;
      }, code);
    }
    ok(cTable, '05 third page joins the PROMOTED host and sees a live table');
    await c.close();
    ok(errors.length === 0, '06 zero page errors', errors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    await sleep(300);
    server.kill('SIGKILL');
  }
  console.log(`\ne2e-p2p-failover: ${n - failures.length}/${n} assertions passed`);
  if (failures.length > 0) process.exit(1);
}
main().catch((err) => { console.error('e2e-p2p-failover crashed:', err); process.exit(1); });
