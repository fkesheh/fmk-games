#!/usr/bin/env node
// TEMP puppeteer probe: real-browser fps join paths against PRODUCTION
// (local platform server mis-mounts /fps/ as a proxy due to a foreign vite
// on :5173 in this sandbox; prod serves all-static per its boot log).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require('puppeteer');

const BASE = 'https://fmk-games.fly.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* keep polling */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
}

const LAUNCH_OPTS = {
  headless: 'shell',
  args: ['--mute-audio', '--disable-background-timer-throttling', '--enable-unsafe-swiftshader'],
  protocolTimeout: 120000,
};

async function overlayText(page) {
  return page.evaluate(() => {
    const layers = [...document.querySelectorAll('.m9-layer')].map((l) => {
      const vis = window.getComputedStyle(l).display !== 'none';
      const join = l.querySelector('.m9-join-sub')?.textContent ?? null;
      const main = l.querySelector('.m9-main') ? 'main' : null;
      return `${l.className.split(' ')[0]}:${vis ? 'vis' : 'hid'}${join ? '/' + join : ''}${main ? '/MAIN' : ''}`;
    });
    return layers.join(' | ');
  }).catch((e) => `overlay-read-error:${e.message}`);
}

async function main() {
  const browsers = [];
  try {
    // ---- Test A: fresh join (no session) ----
    {
      const browser = await puppeteer.launch(LAUNCH_OPTS);
      browsers.push(browser);
      const page = await browser.newPage();
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
      page.on('pageerror', (e) => errors.push(`pageerror:${e.message.slice(0, 200)}`));
      await page.goto(`${BASE}/fps/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitFor(() => page.evaluate(() => !!window.__fps), 30000, '__fps');
      await page.evaluate(() => window.__fps.joinQuick('ProbeA'));
      await sleep(8000);
      const st = await page.evaluate(() => window.__fps.state());
      console.log(`A fresh-join: roomId=${st.roomId} phase=${st.phase} players=${st.players} consoleErrors=${errors.length}`);
      console.log(`  layers: ${await overlayText(page)}`);
      for (const e of errors.slice(0, 5)) console.log(`  conerr: ${e}`);
      await page.close();
    }

    // ---- Test B: stale session (returning user, dead room) ----
    {
      const browser = await puppeteer.launch(LAUNCH_OPTS);
      browsers.push(browser);
      const page = await browser.newPage();
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
      page.on('pageerror', (e) => errors.push(`pageerror:${e.message.slice(0, 200)}`));
      await page.goto(`${BASE}/fps/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitFor(() => page.evaluate(() => !!window.__fps), 30000, '__fps');
      await page.evaluate(() => {
        localStorage.setItem('play.session.fps', JSON.stringify({ playerId: 'deadbeef', roomId: 'DEAD1234', code: null }));
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitFor(() => page.evaluate(() => !!window.__fps), 30000, '__fps');
      const seen = [];
      for (let i = 0; i < 8; i++) {
        seen.push(await overlayText(page));
        await sleep(1500);
      }
      const st = await page.evaluate(() => window.__fps.state());
      const sess = await page.evaluate(() => localStorage.getItem('play.session.fps'));
      console.log(`B stale-session: roomId=${st.roomId} sessionAfter=${sess} consoleErrors=${errors.length}`);
      console.log(`  layers timeline:`);
      for (const s of seen) console.log(`    ${s}`);
      for (const e of errors.slice(0, 5)) console.log(`  conerr: ${e}`);
      await page.close();
    }
  } finally {
    for (const b of browsers) await b.close().catch(() => {});
  }
}
main().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
