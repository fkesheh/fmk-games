#!/usr/bin/env node
// TEMP: rift B-join diagnosis — A creates, B joinPrivate, dump both messageLogs.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require('puppeteer');

const PORT = 8191;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = spawn(process.execPath, ['platform/server/dist/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PLATFORM_STATIC: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stdout.write(`[server!] ${d}`));
  const kill = () => server.kill('SIGTERM');
  process.on('exit', kill);
  try {
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`http://localhost:${PORT}/rift/`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) break;
      } catch { /* retry */ }
      await sleep(500);
    }
    const mkBrowser = () => puppeteer.launch({
      headless: 'shell',
      args: ['--mute-audio', '--disable-background-timer-throttling', '--enable-unsafe-swiftshader'],
      protocolTimeout: 60000,
    });
    const bA = await mkBrowser();
    const bB = await mkBrowser();
    const browsers = [bA, bB];
    try {
      const A = await bA.newPage();
      const B = await bB.newPage();
      await A.goto(`http://localhost:${PORT}/rift/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await B.goto(`http://localhost:${PORT}/rift/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await A.waitForFunction(() => !!window.__rift, { timeout: 15000 });
      await B.waitForFunction(() => !!window.__rift, { timeout: 15000 });
      await A.evaluate((s) => window.__rift.createPrivate('Alice', s), { teamSize: 2, speed: 20 });
      await sleep(2500);
      const hello = await A.evaluate(() => {
        const log = window.__rift.messageLog();
        for (let i = log.length - 1; i >= 0; i--) if (log[i]?.t === 'rift_hello') return log[i];
        return null;
      });
      console.log('A hello:', JSON.stringify(hello));
      if (!hello?.code) { console.log('A never got a code — abort'); return; }
      await B.evaluate((c) => window.__rift.joinPrivate('Bob', c), hello.code);
      await sleep(5000);
      const dump = async (page, tag) => {
        const st = await page.evaluate(() => window.__rift.state());
        const log = await page.evaluate(() => window.__rift.messageLog().slice(-12));
        console.log(`--- ${tag} state: phase=${st.phase} team=${st.team} you=${st.you !== null} error=${st.error ?? 'none'}`);
        for (const m of log) console.log(`    ${tag} << ${JSON.stringify(m).slice(0, 160)}`);
      };
      await dump(A, 'A');
      await dump(B, 'B');
    } finally {
      for (const b of browsers) await b.close().catch(() => {});
    }
  } finally {
    process.off('exit', kill);
    server.kill('SIGTERM');
  }
}
main().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
