#!/usr/bin/env node
// probe-stall — is the e2e creep-stall server-side or client-drain?
// One browser, private room at speed 20, solo start. Samples every 5s:
// client snap tick, and whether NON-snap traffic (pong) still arrives.
// If pongs continue while snaps stall, the SERVER stopped sending snaps.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8095);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* keep polling */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(150);
  }
}

const server = spawn(process.execPath, ['platform/server/dist/server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
let browser = null;
try {
  await waitFor(async () => {
    const res = await fetch(`${BASE}/rift/`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    return res !== null && res.ok;
  }, 20000, 'server up');
  browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--mute-audio', '--disable-background-timer-throttling', '--enable-unsafe-swiftshader'],
    protocolTimeout: 120000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 360 });
  await page.goto(`${BASE}/rift/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => page.evaluate(() => !!window.__rift), 15000, '__rift');
  await waitFor(async () => (await page.evaluate(() => window.__rift.state()))?.connected === true, 10000, 'ws connected');
  await page.evaluate(() => window.__rift.createPrivate('Solo', { teamSize: 2, speed: 20 }));
  await waitFor(async () => (await page.evaluate(() => window.__rift.state()))?.phase === 'lobby', 10000, 'lobby');
  await page.evaluate(() => window.__rift.start());
  await waitFor(async () => (await page.evaluate(() => window.__rift.state()))?.phase === 'live', 20000, 'live');
  console.log('live; sampling for 75s');
  const t0 = Date.now();
  let last = null;
  for (let i = 0; i < 15; i++) {
    await sleep(5000);
    const s = await page.evaluate(() => {
      const snaps = window.__rift?.snaps() ?? [];
      const snap = snaps.length > 0 ? snaps[snaps.length - 1] : null;
      const log = window.__rift?.messageLog() ?? [];
      const lastLog = log.length > 0 ? log[log.length - 1] : null;
      const st = window.__rift?.state() ?? null;
      let welcomes = 0;
      let errors = 0;
      let hellos = 0;
      for (const m of log) {
        if (m?.t === 'welcome') welcomes += 1;
        if (m?.t === 'error') errors += 1;
        if (m?.t === 'rift_hello') hellos += 1;
      }
      return {
        tick: snap?.tick ?? null,
        matchTick: snap?.matchTick ?? null,
        lagMs: snap ? Date.now() - snap.serverTime : null,
        lastLogT: lastLog?.t ?? null,
        logLen: log.length,
        connected: st?.connected ?? null,
        phase: st?.phase ?? null,
        welcomes,
        errors,
        hellos,
      };
    });
    const rate = last !== null && s.tick !== null ? ((s.tick - last.tick) / 5).toFixed(1) : '?';
    console.log(
      `t=${((Date.now() - t0) / 1000).toFixed(0)}s tick=${s.tick} matchTick=${s.matchTick} ` +
        `rate=${rate}/s lagMs=${s.lagMs} logLen=${s.logLen} lastLog=${s.lastLogT} ` +
        `conn=${s.connected} phase=${s.phase} welcomes=${s.welcomes} errors=${s.errors} hellos=${s.hellos}`,
    );
    last = s;
  }
} finally {
  if (browser !== null) await browser.close().catch(() => {});
  if (server.exitCode === null) server.kill('SIGTERM');
}
