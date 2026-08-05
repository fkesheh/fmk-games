#!/usr/bin/env node
// repro-quickjoin — Bug 2 investigation harness (NOT part of the e2e gate).
// A quick-joins, then B quick-joins. Assert both land in the SAME room by
// comparing rift_hello.roomId, and dump the room list phases the lobby saw.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8097);
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

const LAUNCH_OPTS = {
  headless: 'shell',
  args: ['--mute-audio', '--disable-background-timer-throttling', '--enable-unsafe-swiftshader'],
  protocolTimeout: 120000,
};

async function main() {
  const server = spawn(process.execPath, ['platform/server/dist/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stdout.write(`[server!] ${d}`));
  const browsers = [];
  try {
    await waitFor(async () => {
      const res = await fetch(`${BASE}/rift/`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
      return res !== null && res.ok;
    }, 20000, 'server up');

    const open = async (tag) => {
      const browser = await puppeteer.launch(LAUNCH_OPTS);
      browsers.push(browser);
      const page = await browser.newPage();
      await page.setViewport({ width: 640, height: 360 });
      page.on('pageerror', (e) => console.log(`[${tag}] pageerror: ${e.message}`));
      await page.goto(`${BASE}/rift/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitFor(() => page.evaluate(() => !!window.__rift), 15000, `__rift on ${tag}`);
      return page;
    };

    const lastFrame = (page, t) =>
      page.evaluate((tag) => {
        const log = window.__rift?.messageLog() ?? [];
        for (let i = log.length - 1; i >= 0; i--) {
          const m = log[i];
          if (m !== null && typeof m === 'object' && m.t === tag) return m;
        }
        return null;
      }, t);

    const A = await open('A');
    const B = await open('B');

    await A.evaluate(() => window.__rift.quickJoin('Alice'));
    const aHello = await waitFor(async () => lastFrame(A, 'rift_hello'), 10000, 'A rift_hello');
    console.log(`A hello: roomId=${aHello.roomId} team=${aHello.team} roster=${JSON.stringify(aHello.roster)}`);

    // what does the room list look like to B BEFORE joining?
    const roomsSeenByB = await waitFor(async () => {
      const rl = await lastFrame(B, 'room_list');
      return rl !== null && rl.rooms.length > 0 ? rl : null;
    }, 8000, 'B sees a non-empty room_list');
    console.log(`B room_list: ${JSON.stringify(roomsSeenByB.rooms)}`);

    await B.evaluate(() => window.__rift.quickJoin('Bob'));
    await sleep(1500);
    const bHello = await lastFrame(B, 'rift_hello');
    const bError = await lastFrame(B, 'error');
    console.log(`B hello: ${bHello ? `roomId=${bHello.roomId} team=${bHello.team} roster=${JSON.stringify(bHello.roster)}` : 'null'} error=${JSON.stringify(bError)}`);

    const same = bHello !== null && bHello.roomId === aHello.roomId;
    console.log(`\nRESULT: same room = ${same} (A=${aHello.roomId} B=${bHello?.roomId ?? 'none'})`);
    process.exitCode = same ? 0 : 1;
  } finally {
    for (const b of browsers) await b.close().catch(() => {});
    if (server.exitCode === null) server.kill('SIGTERM');
  }
}

await main();
