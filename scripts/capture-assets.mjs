#!/usr/bin/env node
// Capture the asset library for art-director judging. One browser, sequential
// pages. Waits on window.__ASSETS_READY (set after the first rendered frame).
//
// Usage: node scripts/capture-assets.mjs [baseUrl] [outDir]
//   baseUrl defaults to http://localhost:5199
//   outDir  defaults to judge/captures/trees
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const BASE = process.argv[2] ?? 'http://localhost:5199';
const OUT = process.argv[3] ?? 'judge/captures/trees';

const SPECIES = ['oak', 'birch', 'pine', 'snag', 'palm'];
const ANGLES = ['three-quarter', 'front', 'high', 'closeup'];

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  for (const id of SPECIES) {
    for (const angle of ANGLES) {
      const url = `${BASE}/?asset=${id}&lod=hero&wind=0&ui=0&autorot=0&angle=${angle}`;
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
      await page.waitForFunction(() => window.__ASSETS_READY === true, { timeout: 30_000 });
      const file = path.join(OUT, `${id}-${angle}.png`);
      await mkdir(path.dirname(path.resolve(file)), { recursive: true });
      await page.screenshot({ path: file });
      console.log(`captured ${file}`);
    }
    // capture variations 1 and 2 (v0 IS the three-quarter default — the
    // round-1 judge correctly flagged the duplicate as padding)
    for (let v = 1; v < 3; v++) {
      await page.goto(
        `${BASE}/?asset=${id}&variation=${v}&lod=hero&wind=0&ui=0&autorot=0&angle=three-quarter`,
        { waitUntil: 'networkidle0', timeout: 60_000 },
      );
      await page.waitForFunction(() => window.__ASSETS_READY === true, { timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 150));
      const file = path.join(OUT, `${id}-v${v}.png`);
      await page.screenshot({ path: file });
      console.log(`captured ${file}`);
    }
  }
} finally {
  await browser.close();
}
console.log('done.');
