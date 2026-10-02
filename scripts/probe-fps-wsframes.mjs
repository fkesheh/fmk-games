#!/usr/bin/env node
// TEMP: CDP websocket-frame capture for a real-browser fps joinQuick on prod.
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
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    const frames = [];
    cdp.on('Network.webSocketCreated', (e) => frames.push(`SOCKET created ${e.url}`));
    cdp.on('Network.webSocketClosed', (e) => frames.push(`SOCKET closed code=${e.code} reason=${e.reason}`));
    cdp.on('Network.webSocketFrameSent', (e) => frames.push(`SENT: ${e.response.payloadData.slice(0, 220)}`));
    cdp.on('Network.webSocketFrameReceived', (e) => frames.push(`RECV: ${e.response.payloadData.slice(0, 220)}`));
    cdp.on('Network.webSocketHandshakeResponseReceived', (e) => frames.push(`HANDSHAKE: ${JSON.stringify(e.response.status)}`));
    await page.goto(`${BASE}/fps/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!window.__fps, { timeout: 30000 });
    const t0 = Date.now();
    await page.evaluate(() => window.__fps.joinQuick('ProbeCDP'));
    await sleep(10000);
    const st = await page.evaluate(() => window.__fps.state());
    console.log(`state after 10s: roomId=${st.roomId} phase=${st.phase} players=${st.players}`);
    console.log(`--- frames (${frames.length}, names redacted beyond first 220 chars) ---`);
    // cap RECV snapshot spam: show first 3 snapshots then counts
    let snapCount = 0;
    for (const f of frames) {
      if (f.startsWith('RECV: {"t":"snapshot"')) {
        snapCount++;
        if (snapCount <= 2) console.log(f);
        continue;
      }
      console.log(f);
    }
    if (snapCount > 2) console.log(`(... +${snapCount - 2} more snapshot frames)`);
    console.log(`consoleErrors=${errors.length}`);
    for (const e of errors.slice(0, 5)) console.log(`  conerr: ${e}`);
    console.log(`elapsed=${Date.now() - t0}ms`);
  } finally {
    await browser.close().catch(() => {});
  }
}
main().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
