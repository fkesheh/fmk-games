#!/usr/bin/env node
// Usage: node scripts/screenshot.mjs <url> <outfile.png> [width] [height] [waitMs]
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const [url, outfile, widthArg, heightArg, waitArg] = process.argv.slice(2);

if (!url || !outfile) {
  console.error('usage: node scripts/screenshot.mjs <url> <outfile.png> [width] [height] [waitMs]');
  process.exit(1);
}

const width = Number(widthArg ?? 1600);
const height = Number(heightArg ?? 900);
const waitMs = Number(waitArg ?? 3000);

if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(waitMs)) {
  console.error('width, height and waitMs must be numbers');
  process.exit(1);
}

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  await mkdir(path.dirname(path.resolve(outfile)), { recursive: true });
  await page.screenshot({ path: outfile });
  console.log(`screenshot saved to ${outfile}`);
} finally {
  await browser.close();
}
