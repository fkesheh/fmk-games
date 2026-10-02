#!/usr/bin/env node
// TEMP: dense timeline — poll state/overlay/rAF-heartbeat/visibility every 500ms for 25s after join.
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
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => errors.push(`pageerror:${e.message.slice(0, 160)}`));
    await page.evaluateOnNewDocument(() => {
      window.__wslog = [];
      window.__rafBeats = 0;
      const Orig = window.WebSocket;
      window.WebSocket = function (url, proto) {
        const ws = proto === undefined ? new Orig(url) : new Orig(url, proto);
        window.__wslog.push(`ctor ${url}`);
        const origSend = ws.send.bind(ws);
        ws.send = (data) => {
          const s = String(data);
          const tag = s.startsWith('{"t":"input"') ? 'input' : s.startsWith('{"t":"snapshot"') ? 'snap' : s.slice(0, 90);
          window.__wslog.push(`send[${ws.readyState}] ${tag}`);
          return origSend(data);
        };
        ws.addEventListener('close', (e) => window.__wslog.push(`close code=${e.code}`));
        ws.addEventListener('message', (e) => {
          const s = typeof e.data === 'string' ? e.data : '(bin)';
          if (!s.startsWith('{"t":"snapshot"') && !s.startsWith('{"t":"pong"')) window.__wslog.push(`msg :: ${s.slice(0, 110)}`);
        });
        return ws;
      };
      window.WebSocket.prototype = Orig.prototype;
      const beat = () => { window.__rafBeats++; window.requestAnimationFrame(beat); };
      window.requestAnimationFrame(beat);
    });
    await page.goto(`${BASE}/fps/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!window.__fps, { timeout: 30000 });
    await sleep(1500);
    await page.evaluate(() => window.__fps.joinQuick('ProbeDense'));
    console.log('t(s) | roomId | players | phase | joinOverlay | rAFbeats | wslogΔ | hidden | errors');
    let lastLogLen = 0;
    for (let i = 0; i < 50; i++) {
      await sleep(500);
      const row = await page.evaluate(() => {
        const st = window.__fps.state();
        const joinEl = document.querySelector('.m9-join');
        const joinVis = joinEl !== null && window.getComputedStyle(joinEl.closest('.m9-layer')).display !== 'none';
        const sub = joinVis ? joinEl.querySelector('.m9-join-sub')?.textContent : '';
        return {
          room: st.roomId, players: st.players, phase: st.phase,
          join: joinVis ? `JOINING[${sub}]` : 'hidden',
          beats: window.__rafBeats, hidden: document.hidden,
          logLen: window.__wslog.length,
        };
      }).catch((e) => ({ err: e.message.slice(0, 80) }));
      if (row.err) { console.log(`${(i * 0.5).toFixed(1)} | EVAL-ERR ${row.err}`); continue; }
      const fresh = await page.evaluate((n) => window.__wslog.slice(n), lastLogLen).catch(() => []);
      lastLogLen = row.logLen;
      const newSends = fresh.filter((l) => l.startsWith('send')).length;
      const newMsgs = fresh.filter((l) => l.startsWith('msg')).length;
      const newClose = fresh.filter((l) => l.startsWith('close')).length;
      const newCtor = fresh.filter((l) => l.startsWith('ctor')).length;
      console.log(`${(i * 0.5).toFixed(1)} | ${row.room} | ${row.players} | ${row.phase} | ${row.join} | ${row.beats} | +${newSends}s/+${newMsgs}m/ctor${newCtor}/close${newClose} | ${row.hidden} | ${errors.length}`);
      for (const f of fresh) { if (!f.startsWith('send[input')) console.log(`      ${f}`); }
      if (errors.length > 0) { for (const e of errors.splice(0, errors.length)) console.log(`      CONERR: ${e}`); }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}
main().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
