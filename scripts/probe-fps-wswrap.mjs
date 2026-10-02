#!/usr/bin/env node
// TEMP: wrap window.WebSocket pre-load; log every send()/state + frames via CDP.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require('puppeteer');

const BASE = 'https://fmk-games.fly.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--mute-audio', '--disable-background-timer-throttling', '--enable-unsafe-swiftshader'],
    protocolTimeout: 120000,
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => errors.push(`pageerror:${e.message.slice(0, 200)}`));
    await page.evaluateOnNewDocument(() => {
      window.__wslog = [];
      const Orig = window.WebSocket;
      window.__wsCount = 0;
      window.WebSocket = function (url, proto) {
        const id = ++window.__wsCount;
        const ws = proto === undefined ? new Orig(url) : new Orig(url, proto);
        window.__wslog.push(`ctor#${id} ${url}`);
        const origSend = ws.send.bind(ws);
        ws.send = (data) => {
          window.__wslog.push(`send#${id} state=${ws.readyState} bytes=${String(data).length} :: ${String(data).slice(0, 160)}`);
          return origSend(data);
        };
        ws.addEventListener('open', () => window.__wslog.push(`open#${id}`));
        ws.addEventListener('close', (e) => window.__wslog.push(`close#${id} code=${e.code}`));
        ws.addEventListener('error', () => window.__wslog.push(`error#${id}`));
        ws.addEventListener('message', (e) => {
          const s = typeof e.data === 'string' ? e.data : '(binary)';
          if (!s.startsWith('{"t":"snapshot"')) window.__wslog.push(`msg#${id} :: ${s.slice(0, 160)}`);
        });
        return ws;
      };
      window.WebSocket.prototype = Orig.prototype;
      window.WebSocket.OPEN = Orig.OPEN;
    });
    await page.goto(`${BASE}/fps/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!window.__fps, { timeout: 30000 });
    await sleep(2000); // let the boot room-list flow settle
    const preLog = await page.evaluate(() => window.__wslog.slice());
    console.log('--- ws activity BEFORE joinQuick ---');
    for (const l of preLog) console.log(`  ${l}`);
    await page.evaluate(() => window.__fps.joinQuick('ProbeWrap'));
    const calledAt = new Date().toISOString();
    await sleep(8000);
    const postLog = await page.evaluate((n) => window.__wslog.slice(n), preLog.length);
    console.log(`joinQuick called at ${calledAt}`);
    console.log('--- ws activity AFTER joinQuick ---');
    for (const l of postLog) console.log(`  ${l}`);
    const st = await page.evaluate(() => window.__fps.state());
    console.log(`state: roomId=${st.roomId} phase=${st.phase} players=${st.players} consoleErrors=${errors.length}`);
    for (const e of errors.slice(0, 5)) console.log(`  conerr: ${e}`);
  } finally {
    await browser.close().catch(() => {});
  }
}
main().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
