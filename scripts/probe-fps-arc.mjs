#!/usr/bin/env node
// TEMP: 30s timestamped arc — join, then poll overlay/state/banner/wslog every 1s.
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
    protocolTimeout: 180000,
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => errors.push(`pageerror:${e.message.slice(0, 160)}`));
    await page.evaluateOnNewDocument(() => {
      window.__wslog = [];
      const Orig = window.WebSocket;
      const stamp = () => Math.round(performance.now());
      window.WebSocket = function (url, proto) {
        const ws = proto === undefined ? new Orig(url) : new Orig(url, proto);
        window.__wslog.push(`${stamp()} ctor`);
        const origSend = ws.send.bind(ws);
        ws.send = (data) => {
          const s = String(data);
          const tag = s.startsWith('{"t":"input"') ? `input#${JSON.parse(s).seq}` : s.slice(0, 80);
          window.__wslog.push(`${stamp()} send[${ws.readyState}] ${tag}`);
          return origSend(data);
        };
        ws.addEventListener('open', () => window.__wslog.push(`${stamp()} open`));
        ws.addEventListener('close', (e) => window.__wslog.push(`${stamp()} close code=${e.code} clean=${e.wasClean}`));
        ws.addEventListener('error', () => window.__wslog.push(`${stamp()} sockerror`));
        ws.addEventListener('message', (e) => {
          const s = typeof e.data === 'string' ? e.data : '(bin)';
          if (!s.startsWith('{"t":"snapshot"') && !s.startsWith('{"t":"pong"')) {
            window.__wslog.push(`${stamp()} msg :: ${s.slice(0, 100)}`);
          }
        });
        return ws;
      };
      window.WebSocket.prototype = Orig.prototype;
      window.WebSocket.OPEN = Orig.OPEN;
      window.WebSocket.CLOSED = Orig.CLOSED;
    });
    await page.goto(`${BASE}/fps/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!window.__fps, { timeout: 30000 });
    await sleep(1500);
    await page.evaluate(() => window.__fps.joinQuick('ProbeArc'));
    let lastLen = 0;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const row = await page.evaluate(() => {
        const st = window.__fps.state();
        const layers = [...document.querySelectorAll('.m9-layer')]
          .filter((l) => window.getComputedStyle(l).display !== 'none')
          .map((l) => l.querySelector('.m9-join-sub')?.textContent ?? (l.querySelector('.m9-main') ? 'MAIN' : 'other'))
          .join(',');
        const banner = document.querySelector('.error-banner')?.textContent ?? null;
        return { room: st.roomId, players: st.players, layers, banner, hidden: document.hidden, logLen: window.__wslog.length };
      }).catch((e) => ({ err: e.message.slice(0, 60) }));
      if (row.err) { console.log(`t=${i + 1}s EVAL-ERR ${row.err}`); continue; }
      const fresh = await page.evaluate((n) => window.__wslog.slice(n), lastLen).catch(() => []);
      lastLen = row.logLen;
      console.log(`t=${i + 1}s room=${row.room} players=${row.players} layers=[${row.layers}]${row.banner ? ` BANNER:${row.banner.slice(0, 80)}` : ''}${row.hidden ? ' HIDDEN' : ''}`);
      for (const f of fresh) console.log(`    ${f}`);
      if (errors.length > 0) { for (const e of errors.splice(0, errors.length)) console.log(`    CONERR: ${e}`); }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}
main().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
