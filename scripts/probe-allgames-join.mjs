#!/usr/bin/env node
// TEMP prod smoke: every game joins a room from a real browser, calling the
// join entry IMMEDIATELY after the debug surface appears (the CONNECTING
// race window the send-queue fix closes). One sequential pass per game.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require('puppeteer');

const BASE = 'https://fmk-games.fly.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* keep polling */ }
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(250);
  }
}

/** @type {Array<{id:string, surface:string, join:string, check:string, timeout:number}>} */
const GAMES = [
  {
    id: 'fps', surface: '__fps',
    join: `window.__fps.joinQuick('Probe')`,
    check: `(() => { const s = window.__fps.state(); return s.roomId ? 'room=' + s.roomId + ' players=' + s.players : null; })()`,
    timeout: 12000,
  },
  {
    id: 'bank', surface: '__bank',
    join: `window.__bank.createPrivate('Alice')`,
    check: `(() => { const s = window.__bank.state(); return s && Array.isArray(s.players) && s.players.some((p) => p.name === 'Alice') ? 'phase=' + s.phase + ' n=' + s.players.length : null; })()`,
    timeout: 12000,
  },
  {
    id: 'kart', surface: '__kart',
    join: `window.__kart.createPrivate('Alice')`,
    check: `(() => { const s = window.__kart.state(); return s && s.phase !== 'menu' ? 'phase=' + s.phase : null; })()`,
    timeout: 12000,
  },
  {
    id: 'wordbomb', surface: '__wordbomb',
    join: `window.__wordbomb.createPrivate('Alice', { rounds: 20, difficulty: 'easy' })`,
    check: `(() => { const s = window.__wordbomb.state(); return s && Array.isArray(s.players) && s.players.some((p) => p.name === 'Alice') ? 'phase=' + s.phase + ' n=' + s.players.length : null; })()`,
    timeout: 12000,
  },
  {
    id: 'rift', surface: '__rift',
    join: `window.__rift.createPrivate('Alice', { teamSize: 2, speed: 20 })`,
    check: `(() => { const s = window.__rift.state(); return s && s.phase === 'lobby' && s.you !== null ? 'lobby team=' + s.team : null; })()`,
    timeout: 15000,
  },
  {
    id: 'splat', surface: '__splat',
    join: `window.__splat.startRace(42)`,
    check: `(() => { const s = window.__splat.state(); return s && s.phase !== 'menu' ? 'phase=' + s.phase : null; })()`,
    timeout: 12000,
  },
  {
    id: 'outpost', surface: '__outpost',
    join: `window.__outpost.createPrivate('Alice')`,
    check: `(() => { const s = window.__outpost.state(); return s && s.joined === true ? 'code=' + s.code : null; })()`,
    timeout: 12000,
  },
  {
    id: 'aces', surface: '__ACES',
    join: `window.__ACES.join({ kind: 'private', settings: { debug: true } })`,
    check: `(() => { const s = window.__ACES.state(); return s && (s.phase === 'lobby' || s.phase === 'live') ? 'phase=' + s.phase : null; })()`,
    timeout: 25000,
  },
  {
    id: 'ancients', surface: '__ancients',
    join: `window.__ancients.createPrivate('Alice', { teamSize: 2, speed: 20 })`,
    check: `(() => { const s = window.__ancients.state(); return s && s.phase === 'lobby' && s.you !== null ? 'lobby team=' + s.team : null; })()`,
    timeout: 15000,
  },
];

async function main() {
  // Fresh browser PER GAME (not one browser for all nine): churning nine
  // heavy WebGL pages through a single headless-shell degrades it (GPU
  // contexts, renderer bloat, CPU) until late pages (rift 5th, ancients
  // 9th) time out their joins while isolated identical joins pass 3/3
  // (measured 2026-10-01). ~2-3s per launch is the price of a real gate.
  let pass = 0;
  for (const g of GAMES) {
    const browser = await puppeteer.launch({
      headless: 'shell',
      args: ['--mute-audio', '--disable-background-timer-throttling', '--enable-unsafe-swiftshader'],
      protocolTimeout: 120000,
    });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)); });
      page.on('pageerror', (e) => errors.push(`pageerror:${e.message.slice(0, 120)}`));
      try {
        await page.goto(`${BASE}/${g.id}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const ready = await waitFor(() => page.evaluate((s) => !!window[s], g.surface), 30000);
        if (!ready) { console.log(`FAIL  ${g.id}: no debug surface`); continue; }
        await page.evaluate(g.join); // immediately: the race window
        const detail = await waitFor(() => page.evaluate(g.check), g.timeout);
        if (detail) { pass++; console.log(`PASS  ${g.id}: ${detail}${errors.length ? ` (${errors.length} conerr)` : ''}`); }
        else console.log(`FAIL  ${g.id}: join timed out${errors.length ? ` conerr[0]=${errors[0]}` : ''}`);
      } catch (e) {
        console.log(`FAIL  ${g.id}: ${e.message.slice(0, 140)}`);
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      await browser.close().catch(() => {});
    }
  }
  console.log(`\nPROD SMOKE: ${pass}/${GAMES.length} joined`);
  process.exit(pass === GAMES.length ? 0 : 1);
}
main().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
