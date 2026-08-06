#!/usr/bin/env node
// ============================================================================
// audio-render-rift — the audio equivalent of the screenshot script (T12 of
// the RIFT audio build, docs/rift-audio/AUDIO_CONTRACT.md). Serves the BUILT
// platform, drives `games/rift/client/audio-lab.html` (the audio lab entry
// point built by a SIBLING task, T11) with puppeteer, renders every cue and
// every scene offline through `window.__riftAudio` (AudioLabApi) and the
// legacy comparison module through `window.__riftAudioBaseline`
// (BaselineLabApi), writes WAV + waveform/spectrogram PNG + an anonymised
// blind A/B set + a metrics manifest, and ASSERTS the SONIC_BIBLE benchmark
// table (§9) plus the mix/headroom law (§8). Client dist must already exist
// — this harness NEVER builds (run `npm run build -w @rift/client` first).
//
// Follows verify-rift.mjs's shape: serve the built server, puppeteer, print
// a JSON manifest as the LAST stdout line, exit non-zero on ANY failure.
// Server/page chatter goes to stderr via log(); only the final manifest and
// (for --help) the usage text go to stdout.
//
// Exit 0 means "the audio is actually good" — never "nothing crashed". The
// assertion list below includes SILENCE FLOORS as well as upper bounds: a
// build where every cue renders digital silence must exit non-zero.
//
// Mirrored (never imported) config facts — games/rift/client/src/audio/
// config.ts is a TypeScript module; this harness runs under plain node, so
// (following the e2e-rift.mjs precedent of mirroring pure-data config facts
// rather than importing .ts) the handful of numeric constants and the scene
// list it needs are copied here as literals. If config.ts changes any of
// these values, this file must be updated to match — grep for "MIRRORED".
//
// Flags:   --help          print usage and exit 0 (no server, no browser).
//          --keep-server   leave the platform server up for debugging.
// Env:     RIFT_AUDIO_PORT              port for the platform server (default 8093).
//          RIFT_AUDIO_PROTOCOL_TIMEOUT  puppeteer protocol timeout, ms (default 300000).
// ============================================================================
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.RIFT_AUDIO_PORT ?? 8093);
const BASE = `http://localhost:${PORT}`;
const SERVER_ENTRY = path.join(ROOT, 'platform/server/dist/server.js');
const LAB_PATH = '/rift/audio-lab.html';

const OUT_DIR = path.join(ROOT, 'screenshots', 'rift-audio');
const WAV_DIR = path.join(OUT_DIR, 'wav');
const PNG_DIR = path.join(OUT_DIR, 'png');
const AB_DIR = path.join(OUT_DIR, 'ab');
const METRICS_PATH = path.join(OUT_DIR, 'metrics.json');

const HELP_TEXT = `audio-render-rift — render every RIFT audio cue/scene offline and grade it
against the SONIC_BIBLE benchmark (docs/rift-audio/SONIC_BIBLE.md §9).

Usage:
  node scripts/audio-render-rift.mjs [--keep-server]
  node scripts/audio-render-rift.mjs --help

Requires the client + server already built (npm run build -w @rift/client,
npm run build -w @platform/server) — this script never builds.

Flags:
  --keep-server   leave the platform server running after the run for debugging
  --help, -h      print this message and exit 0

Env:
  RIFT_AUDIO_PORT               platform server port (default 8093)
  RIFT_AUDIO_PROTOCOL_TIMEOUT   puppeteer protocol timeout in ms (default 300000)

Output:
  screenshots/rift-audio/wav/*.wav       16-bit stereo renders, one per cue/scene/baseline id
  screenshots/rift-audio/png/*.png       waveform + spectrogram, captioned with the id
  screenshots/rift-audio/ab/<n>-A|B.png  anonymised blind A/B pairs (no id, no side label)
  screenshots/rift-audio/metrics.json    every measurement, the assertion ledger, and the
                                          A/B key (which side is baseline vs rebuilt)

Exit code 0 means the audio actually passed the benchmark, not just that nothing crashed.`;

// ---- MIRRORED config facts (games/rift/client/src/audio/config.ts + contract.ts) ------
const TRUE_PEAK_GATE_DBTP = -1.0; // config.ts TRUE_PEAK_GATE_DBTP
const LIMIT_CEILING_DB = -2.0; // config.ts LIMIT_CEILING_DB (sample-domain limiter asymptote)
const INFO_FLOOR_HZ = 800; // config.ts INFO_FLOOR_HZ
const INFO_BAND_MAX_PCT = 8; // config.ts INFO_BAND_MAX_PCT

// config.ts SCENES — name + total render length in seconds. `lastHitInFight`
// additionally carries the mirrored onset of its `ui.lastHit` SceneStep
// (atSec: 1.4), which is when the "chime cuts through" gate takes its window.
const SCENES = [
  { name: 'menuBed', seconds: 6 },
  { name: 'laning', seconds: 8 },
  { name: 'skirmish', seconds: 8 },
  { name: 'teamfight', seconds: 10 },
  { name: 'lastHitInFight', seconds: 6, chimeOnsetS: 1.4 },
  { name: 'towerFallInFight', seconds: 10 },
  { name: 'ancientFall', seconds: 12 },
  { name: 'victory', seconds: 10 },
];

// AUDIO_CONTRACT.md §T12 — the frozen legacy-id -> new-SoundId pairing for
// the blind A/B set. Order is fixed so `<n>` in the output filenames is stable.
const PAIRS = [
  { legacyId: 'rift_kill', riftId: 'die.hero' },
  { legacyId: 'rift_structure', riftId: 'obj.tower' },
  { legacyId: 'rift_cast', riftId: 'cast.hex.0' },
  { legacyId: 'rift_surge', riftId: 'obj.surge' },
  { legacyId: 'rift_end', riftId: 'ann.victory' },
  { legacyId: 'click', riftId: 'ui.click' },
  { legacyId: 'buy', riftId: 'ui.buy' },
  { legacyId: 'error', riftId: 'ui.error' },
  { legacyId: 'levelup', riftId: 'ui.levelUp' },
];

// Deterministic seed for the AB side-assignment RNG. NOT the audio module's
// own AUDIO_SEED (config.ts) — this is a harness-level concern, unrelated to
// cue synthesis, but "no Math.random" is a repo-wide law this file honours too.
const AB_SEED = 0xa17f1d3c;

const LAUNCH_ARGS = [
  // verify-rift.mjs's args, minus --mute-audio (AUDIO_CONTRACT.md §T12: we need audio).
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--enable-unsafe-swiftshader',
  '--disable-background-networking',
  '--disable-component-extensions-with-background-pages',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints',
];
const LAUNCH_OPTS = {
  headless: 'shell',
  args: LAUNCH_ARGS,
  protocolTimeout: Number(process.env.RIFT_AUDIO_PROTOCOL_TIMEOUT ?? 300000),
};

// ---- tiny framework (mirrors verify-rift.mjs / e2e-rift.mjs conventions) --------------
const T0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const elapsed = () => `${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s`;
const log = (msg) => console.error(`[${elapsed()}] ${msg}`); // stdout ends with the JSON manifest
const errText = (err) => (err instanceof Error ? err.message : String(err));

const failures = [];
const fail = (msg) => {
  failures.push(msg);
  log(`[FAILED] ${msg}`);
};

const report = {
  meta: { generatedAt: null, sampleRate: 48000, abSeed: AB_SEED },
  cues: {},
  scenes: {},
  baseline: {},
  pairs: [],
  assertions: [],
};

function check(name, ok, detail = '') {
  report.assertions.push({ name, ok, detail });
  if (!ok) fail(`${name}${detail ? ` — ${detail}` : ''}`);
}

// deterministic PRNG (mulberry32) — no Math.random anywhere in this file.
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- server -----------------------------------------------------------------------
let serverChild = null;
let serverExit = null;
let tearingDown = false;

async function startServer() {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `missing ${path.relative(ROOT, SERVER_ENTRY)} — run 'npm run build -w @platform/server' first`,
    );
  }
  const inUse = await fetch(BASE, { signal: AbortSignal.timeout(1500) }).then(
    () => true,
    () => false,
  );
  if (inUse) throw new Error(`something is already listening on :${PORT} — kill it or set RIFT_AUDIO_PORT`);
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverChild = child;
  child.stdout.on('data', (d) => process.stderr.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server!] ${d}`));
  child.on('exit', (code, signal) => {
    serverExit = { code, signal };
    if (!tearingDown) {
      process.stderr.write(`[server] EXITED mid-run (code ${code}, signal ${signal})\n`);
    }
  });
}

async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    if (serverChild.exitCode !== null) throw new Error(`server exited early (${serverChild.exitCode})`);
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`server did not listen on :${PORT} within ${timeoutMs}ms`);
    await sleep(250);
  }
}

async function stopServer() {
  if (serverChild === null) return;
  tearingDown = true;
  serverChild.kill('SIGTERM');
  await Promise.race([
    new Promise((r) => serverChild.once('exit', r)),
    sleep(5000).then(() => serverChild.kill('SIGKILL')),
  ]);
}

// ---- browser ------------------------------------------------------------------------
const pageErrors = [];

function trackErrors(page) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url ?? '';
    if (/favicon/.test(url) || /favicon/.test(m.text())) return;
    pageErrors.push(`console.error: ${m.text()} (${url})`);
  });
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on('error', (e) => pageErrors.push(`page CRASHED: ${e.message}`));
  page.on('requestfailed', (r) => {
    if (/favicon/.test(r.url())) return;
    pageErrors.push(`requestfailed: ${r.url()} — ${r.failure()?.errorText ?? '?'}`);
  });
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // keep polling
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout (${timeoutMs}ms) waiting for ${label}`);
    await sleep(150);
  }
}

// ============================================================================
// IN-PAGE FUNCTIONS. Everything below this line runs inside the browser via
// page.evaluate(fn, ...args) — Puppeteer serialises the function body, so
// each one must be fully self-contained (no closures over Node-scope
// variables; only its own params and page globals such as `window`).
// ============================================================================

/** Defines window.__audioHarness. Call once per page, before any capture. */
function installAudioHarness() {
  const LIMIT_CEILING_LINEAR = Math.pow(10, -2.0 / 20); // mirrors config.ts LIMIT_CEILING_DB

  function downmix(l, r) {
    const n = l.length;
    const m = new Float64Array(n);
    for (let i = 0; i < n; i++) m[i] = (l[i] + r[i]) * 0.5;
    return m;
  }
  function peakLinear(ch) {
    let m = 0;
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > m) m = a;
    }
    return m;
  }
  function rmsLinear(ch) {
    let s = 0;
    for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i];
    return Math.sqrt(s / Math.max(1, ch.length));
  }
  function clippedCount(ch) {
    let n = 0;
    for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) >= 0.999) n++;
    return n;
  }
  function attackMs(mono, sr) {
    const peak = peakLinear(mono);
    if (peak <= 0) return 0;
    const target = peak * 0.9;
    for (let i = 0; i < mono.length; i++) {
      if (Math.abs(mono[i]) >= target) return (i / sr) * 1000;
    }
    return (mono.length / sr) * 1000;
  }
  function lengthMsTo60(mono, sr) {
    const peak = peakLinear(mono);
    if (peak <= 0) return 0;
    const thresh = peak * Math.pow(10, -60 / 20);
    let last = 0;
    for (let i = 0; i < mono.length; i++) if (Math.abs(mono[i]) >= thresh) last = i;
    return ((last + 1) / sr) * 1000;
  }
  function stereoCorrelation(l, r) {
    let sll = 0;
    let srr = 0;
    let slr = 0;
    for (let i = 0; i < l.length; i++) {
      sll += l[i] * l[i];
      srr += r[i] * r[i];
      slr += l[i] * r[i];
    }
    const denom = Math.sqrt(sll * srr);
    return denom > 0 ? slr / denom : 0;
  }
  function limiterActivePct(preL, preR) {
    let n = 0;
    for (let i = 0; i < preL.length; i++) {
      if (Math.abs(preL[i]) >= LIMIT_CEILING_LINEAR || Math.abs(preR[i]) >= LIMIT_CEILING_LINEAR) n++;
    }
    return preL.length > 0 ? (100 * n) / preL.length : 0;
  }

  function hannWindow(n) {
    const w = new Float64Array(n);
    if (n === 1) {
      w[0] = 1;
      return w;
    }
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
  }
  function nextPow2(n) {
    let p = 1;
    while (p < n) p *= 2;
    return Math.max(2, p);
  }
  /** In-place iterative radix-2 Cooley-Tukey FFT. `re`/`im` length must be a power of 2. */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr0 = Math.cos(ang);
      const wi0 = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curWr = 1;
        let curWi = 0;
        for (let k = 0; k < len / 2; k++) {
          const ure = re[i + k];
          const uim = im[i + k];
          const vre = re[i + k + len / 2] * curWr - im[i + k + len / 2] * curWi;
          const vim = re[i + k + len / 2] * curWi + im[i + k + len / 2] * curWr;
          re[i + k] = ure + vre;
          im[i + k] = uim + vim;
          re[i + k + len / 2] = ure - vre;
          im[i + k + len / 2] = uim - vim;
          const nwr = curWr * wr0 - curWi * wi0;
          const nwi = curWr * wi0 + curWi * wr0;
          curWr = nwr;
          curWi = nwi;
        }
      }
    }
  }

  const BANDS = [
    ['0-120', 0, 120],
    ['120-400', 120, 400],
    ['400-800', 400, 800],
    ['800-2000', 800, 2000],
    ['2000-4000', 2000, 4000],
    ['4000-20000', 4000, 20000],
  ];

  /** Averaged power spectrum over the whole buffer (2048-pt FFT, 50% overlap). */
  function analyzeSpectrum(mono, sr) {
    const FFT_SIZE = 2048;
    const HOP = 1024;
    const win = hannWindow(FFT_SIZE);
    const bandPower = new Array(BANDS.length).fill(0);
    for (let start = 0; start < mono.length; start += HOP) {
      const re = new Float64Array(FFT_SIZE);
      const im = new Float64Array(FFT_SIZE);
      for (let i = 0; i < FFT_SIZE; i++) {
        const idx = start + i;
        re[i] = (idx < mono.length ? mono[idx] : 0) * win[i];
      }
      fft(re, im);
      for (let bin = 0; bin <= FFT_SIZE / 2; bin++) {
        const freq = (bin * sr) / FFT_SIZE;
        if (freq > 20000) break;
        const p = re[bin] * re[bin] + im[bin] * im[bin];
        for (let b = 0; b < BANDS.length; b++) {
          if (freq >= BANDS[b][1] && freq < BANDS[b][2]) {
            bandPower[b] += p;
            break;
          }
        }
      }
    }
    const total = bandPower.reduce((a, b) => a + b, 0);
    const bandPct = {};
    for (let b = 0; b < BANDS.length; b++) bandPct[BANDS[b][0]] = total > 0 ? (100 * bandPower[b]) / total : 0;
    // centroid over the same bounded band set (a second lightweight pass keeps this function simple).
    let weighted = 0;
    for (let b = 0; b < BANDS.length; b++) weighted += ((BANDS[b][1] + BANDS[b][2]) / 2) * bandPower[b];
    const centroidHz = total > 0 ? weighted / total : 0;
    return { bandPct, centroidHz };
  }

  /** Single-window band power in dB (power domain, 10*log10), for the chime cut-through gate. */
  function bandPowerDbWindow(mono, sr, startSec, endSec, loHz, hiHz) {
    const startIdx = Math.max(0, Math.round(startSec * sr));
    const endIdx = Math.min(mono.length, Math.round(endSec * sr));
    const len = Math.max(1, endIdx - startIdx);
    const fftSize = nextPow2(len);
    const win = hannWindow(len);
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    for (let i = 0; i < len; i++) {
      const idx = startIdx + i;
      re[i] = (idx < mono.length ? mono[idx] : 0) * win[i];
    }
    fft(re, im);
    let power = 0;
    for (let bin = 0; bin <= fftSize / 2; bin++) {
      const freq = (bin * sr) / fftSize;
      if (freq >= loHz && freq < hiHz) power += re[bin] * re[bin] + im[bin] * im[bin];
    }
    return 10 * Math.log10(power + 1e-12);
  }

  async function truePeakDbtp(left, right, sampleRate) {
    const factor = 4; // >=4x oversampling — inter-sample overshoot is the point of this gate.
    const src = new AudioBuffer({ length: left.length, numberOfChannels: 2, sampleRate });
    src.copyToChannel(Float32Array.from(left), 0);
    src.copyToChannel(Float32Array.from(right), 1);
    const octx = new OfflineAudioContext(2, left.length * factor, sampleRate * factor);
    const node = octx.createBufferSource();
    node.buffer = src;
    node.connect(octx.destination);
    node.start(0);
    const rendered = await octx.startRendering();
    let peak = 0;
    for (let c = 0; c < rendered.numberOfChannels; c++) {
      const d = rendered.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
      }
    }
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  }

  async function computeMetrics(audio) {
    const { sampleRate, left, right, preLimitLeft, preLimitRight } = audio;
    const mono = downmix(left, right);
    const peak = Math.max(peakLinear(left), peakLinear(right));
    const peakDbfs = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    const rms = rmsLinear(mono);
    const rmsDbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    const crestDb = Number.isFinite(peakDbfs) && Number.isFinite(rmsDbfs) ? peakDbfs - rmsDbfs : 0;
    const spec = analyzeSpectrum(mono, sampleRate);
    const truePeak = await truePeakDbtp(left, right, sampleRate);
    const limiterPct =
      preLimitLeft && preLimitRight ? limiterActivePct(preLimitLeft, preLimitRight) : null;
    return {
      sampleRate,
      lengthSamples: left.length,
      durationS: left.length / sampleRate,
      peakDbfs,
      truePeakDbtp: truePeak,
      rmsDbfs,
      crestDb,
      attackMs: attackMs(mono, sampleRate),
      lengthMs: lengthMsTo60(mono, sampleRate),
      spectralCentroidHz: spec.centroidHz,
      bandEnergyPct: spec.bandPct,
      stereoCorrelation: stereoCorrelation(left, right),
      clippedSamples: clippedCount(left) + clippedCount(right),
      limiterActivePct: limiterPct,
    };
  }

  function chimeWindow(audio, onsetSec) {
    const mono = downmix(audio.left, audio.right);
    const chimeDb = bandPowerDbWindow(mono, audio.sampleRate, onsetSec, onsetSec + 0.12, 2000, 4000);
    const bedDb = bandPowerDbWindow(mono, audio.sampleRate, Math.max(0, onsetSec - 0.5), onsetSec, 2000, 4000);
    return { chimeDb, bedDb, deltaDb: chimeDb - bedDb };
  }

  function encodeWav(audio) {
    const { sampleRate, left, right } = audio;
    const n = left.length;
    const blockAlign = 4;
    const dataSize = n * blockAlign;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);
    let off = 44;
    for (let i = 0; i < n; i++) {
      const l = Math.max(-1, Math.min(1, left[i]));
      const r = Math.max(-1, Math.min(1, right[i]));
      view.setInt16(off, l < 0 ? l * 0x8000 : l * 0x7fff, true);
      off += 2;
      view.setInt16(off, r < 0 ? r * 0x8000 : r * 0x7fff, true);
      off += 2;
    }
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function magmaLike(t) {
    const c = Math.max(0, Math.min(1, t));
    const r = Math.round(255 * Math.min(1, Math.max(0, (c - 0.25) * 1.6)));
    const g = Math.round(255 * Math.min(1, Math.max(0, (c - 0.5) * 2)));
    const b = Math.round(255 * Math.min(1, c * 1.3));
    return [r, g, b];
  }

  /** caption-only PNG: no cue id anywhere else in the image (blind A/B safety). */
  function drawImage(audio, caption) {
    const W = 1200;
    const H = 700;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#e8e8e8';
    ctx.font = '16px monospace';
    ctx.fillText(String(caption), 12, 22);

    const { left, right, sampleRate } = audio;
    const mono = downmix(left, right);
    const n = mono.length;

    // -- waveform (top ~35%) -----------------------------------------------------------
    const waveTop = 32;
    const waveH = Math.floor(H * 0.33);
    const midY = waveTop + waveH / 2;
    ctx.strokeStyle = '#333';
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(W, midY);
    ctx.stroke();
    ctx.strokeStyle = '#7fd0ff';
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor((x / W) * n);
      const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / W) * n));
      let mn = 0;
      let mx = 0;
      for (let i = i0; i < i1 && i < n; i++) {
        const v = mono[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      ctx.moveTo(x, midY - mx * (waveH / 2));
      ctx.lineTo(x, midY - mn * (waveH / 2));
    }
    ctx.stroke();

    // -- spectrogram (remaining space, log-frequency y-axis) ---------------------------
    const specTop = waveTop + waveH + 28;
    const specH = H - specTop - 22;
    const FFT_SIZE = 1024;
    const HOP = 256;
    const win = hannWindow(FFT_SIZE);
    const frames = [];
    for (let start = 0; start < n; start += HOP) {
      const re = new Float64Array(FFT_SIZE);
      const im = new Float64Array(FFT_SIZE);
      for (let i = 0; i < FFT_SIZE; i++) {
        const idx = start + i;
        re[i] = (idx < n ? mono[idx] : 0) * win[i];
      }
      fft(re, im);
      const mags = new Float64Array(FFT_SIZE / 2);
      for (let b = 0; b < FFT_SIZE / 2; b++) mags[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      frames.push(mags);
    }
    if (frames.length === 0) frames.push(new Float64Array(FFT_SIZE / 2));
    const minHz = 20;
    const maxHz = Math.min(20000, sampleRate / 2);
    const logMin = Math.log10(minHz);
    const logMax = Math.log10(maxHz);
    const img = ctx.createImageData(W, specH);
    for (let x = 0; x < W; x++) {
      const frame = frames[Math.min(frames.length - 1, Math.floor((x / W) * frames.length))];
      for (let y = 0; y < specH; y++) {
        const frac = 1 - y / specH;
        const hz = Math.pow(10, logMin + frac * (logMax - logMin));
        const bin = Math.min(frame.length - 1, Math.round((hz * FFT_SIZE) / sampleRate));
        const mag = frame[bin];
        const db = 20 * Math.log10(mag + 1e-9);
        const t = (db + 90) / 90; // -90..0 dB -> 0..1
        const [r, g, b] = magmaLike(t);
        const idx = (y * W + x) * 4;
        img.data[idx] = r;
        img.data[idx + 1] = g;
        img.data[idx + 2] = b;
        img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, specTop);
    ctx.fillStyle = '#bbbbbb';
    ctx.font = '11px monospace';
    for (const hz of [100, 1000, 10000]) {
      if (hz < minHz || hz > maxHz) continue;
      const frac = (Math.log10(hz) - logMin) / (logMax - logMin);
      const y = specTop + specH - frac * specH;
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.fillText(`${hz}Hz`, 4, y - 2);
    }
    ctx.strokeStyle = '#555';
    ctx.strokeRect(0, specTop, W, specH);

    return canvas.toDataURL('image/png');
  }

  window.__audioHarness = { computeMetrics, chimeWindow, encodeWav, drawImage };
}

/** Render one cue and capture everything the harness needs about it. */
async function renderCueAndCapture(id, seconds, offsetM, caption) {
  const audio = await window.__riftAudio.renderCue(id, seconds, offsetM);
  const metrics = await window.__audioHarness.computeMetrics(audio);
  const wavBase64 = window.__audioHarness.encodeWav(audio);
  const pngDataUrl = window.__audioHarness.drawImage(audio, caption);
  return { metrics, wavBase64, pngDataUrl };
}

/** Render one scripted scene; `chimeOnsetS` (or null) drives the chime cut-through gate. */
async function renderSceneAndCapture(name, seconds, caption, chimeOnsetS) {
  const audio = await window.__riftAudio.renderScene(name, seconds);
  const metrics = await window.__audioHarness.computeMetrics(audio);
  const wavBase64 = window.__audioHarness.encodeWav(audio);
  const pngDataUrl = window.__audioHarness.drawImage(audio, caption);
  const chime = chimeOnsetS != null ? window.__audioHarness.chimeWindow(audio, chimeOnsetS) : null;
  return { metrics, wavBase64, pngDataUrl, chime };
}

/** Render one legacy (baseline) id and capture it. */
async function renderBaselineAndCapture(id, seconds, caption) {
  const audio = await window.__riftAudioBaseline.render(id, seconds);
  const metrics = await window.__audioHarness.computeMetrics(audio);
  const wavBase64 = window.__audioHarness.encodeWav(audio);
  const pngDataUrl = window.__audioHarness.drawImage(audio, caption);
  return { metrics, wavBase64, pngDataUrl };
}

/** Image-only capture for the anonymised A/B set: caption must be "A" or "B", nothing else. */
async function captureAnonymizedCue(id, seconds, offsetM, caption) {
  const audio = await window.__riftAudio.renderCue(id, seconds, offsetM);
  return window.__audioHarness.drawImage(audio, caption);
}
async function captureAnonymizedBaseline(id, seconds, caption) {
  const audio = await window.__riftAudioBaseline.render(id, seconds);
  return window.__audioHarness.drawImage(audio, caption);
}

// ============================================================================
// Node-side orchestration resumes here.
// ============================================================================

async function writeDataUrlPng(filePath, dataUrl) {
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  await writeFile(filePath, Buffer.from(base64, 'base64'));
}
async function writeBase64Wav(filePath, base64) {
  await writeFile(filePath, Buffer.from(base64, 'base64'));
}

function isWorldCue(id) {
  // SONIC_BIBLE §2 law 2: "Every sound is positioned unless it is UI or announcer."
  return !id.startsWith('ui.') && !id.startsWith('ann.');
}

/** Heuristic per-id render window, generous enough to cover the longest tail
 *  in each family (ultimates 0.8-1.6s, structure deaths up to 3.0s + IR_HALL
 *  2.8s tail, UI <=700ms) per SONIC_BIBLE §5 layer budget. */
function cueRenderSeconds(id) {
  if (id === 'ui.levelUp') return 2.5;
  if (id.startsWith('ui.')) return 1.5;
  if (id.startsWith('ann.')) return 6;
  if (id.startsWith('obj.')) return 8;
  if (id.startsWith('cast.') && id.endsWith('.3')) return 3.5;
  if (id.startsWith('cast.')) return 2.5;
  return 2; // atk.*, hit.*, die.*
}
function baselineRenderSeconds(id) {
  return /kill|structure|end/.test(id) ? 6 : 3;
}

function pctDiff(a, b) {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-6);
  return (Math.abs(a - b) / denom) * 100;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP_TEXT);
    return;
  }
  const keepServer = args.includes('--keep-server');

  await mkdir(WAV_DIR, { recursive: true });
  await mkdir(PNG_DIR, { recursive: true });
  await mkdir(AB_DIR, { recursive: true });

  let browser = null;
  try {
    await startServer();
    await waitForServer();
    log(`platform server up on :${PORT}`);

    browser = await puppeteer.launch(LAUNCH_OPTS);
    const page = await browser.newPage();
    trackErrors(page);

    await page.goto(`${BASE}${LAB_PATH}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // -- fail loudly, first, if the sibling page (T11) isn't there yet ----------------
    const title = await page.title();
    if (title !== 'RIFT AUDIO LAB') {
      throw new Error(
        `document.title is "${title}", expected "RIFT AUDIO LAB" at ${LAB_PATH} — the platform ` +
          `server serves the game's index.html with 200 on any miss, so this means audio-lab.html ` +
          `is missing from the build, isn't listed in vite.config.ts rollupOptions.input, or T11 ` +
          `hasn't landed yet. Build with: npm run build -w @rift/client`,
      );
    }
    const html = await page.content();
    if (html.includes('/@vite/client')) {
      throw new Error(`${LAB_PATH} is proxied to a vite dev server — stop it and re-run against the build`);
    }
    const apiTypes = await page.evaluate(() => ({
      lab: typeof window.__riftAudio,
      baseline: typeof window.__riftAudioBaseline,
    }));
    if (apiTypes.lab !== 'object') {
      throw new Error(
        `window.__riftAudio is ${apiTypes.lab}, expected an object — audio/lab.ts (T11) did not ` +
          `attach AudioLabApi, or it threw during page load`,
      );
    }
    if (apiTypes.baseline !== 'object') {
      throw new Error(
        `window.__riftAudioBaseline is ${apiTypes.baseline}, expected an object — audio/lab.ts ` +
          `(T11) did not attach BaselineLabApi, or it threw during page load`,
      );
    }
    log('audio-lab.html mounted, both lab APIs present');

    await page.evaluate(installAudioHarness);

    const soundIds = await page.evaluate(() => window.__riftAudio.ids());
    const baselineIds = await page.evaluate(() => window.__riftAudioBaseline.ids());
    if (!Array.isArray(soundIds) || soundIds.length === 0) {
      throw new Error('window.__riftAudio.ids() returned no ids — the cue registry is empty or broken');
    }
    log(`${soundIds.length} SoundIds, ${SCENES.length} scenes, ${baselineIds.length} baseline ids to render`);

    // ---- cues ------------------------------------------------------------------------
    for (const id of soundIds) {
      const seconds = cueRenderSeconds(id);
      const entry = { primary: null, offset18: null };
      try {
        const caption = `${id}  (offsetM 0, ${seconds}s render)`;
        const r = await page.evaluate(renderCueAndCapture, id, seconds, 0, caption);
        entry.primary = r.metrics;
        await writeBase64Wav(path.join(WAV_DIR, `${id}.wav`), r.wavBase64);
        await writeDataUrlPng(path.join(PNG_DIR, `${id}.png`), r.pngDataUrl);
      } catch (err) {
        fail(`cue '${id}' (offsetM 0): render failed — ${errText(err)}`);
      }
      if (isWorldCue(id)) {
        try {
          const caption = `${id}  (offsetM 18, ${seconds}s render)`;
          const r = await page.evaluate(renderCueAndCapture, id, seconds, 18, caption);
          entry.offset18 = r.metrics;
          await writeBase64Wav(path.join(WAV_DIR, `${id}.offset18.wav`), r.wavBase64);
          await writeDataUrlPng(path.join(PNG_DIR, `${id}.offset18.png`), r.pngDataUrl);
        } catch (err) {
          fail(`cue '${id}' (offsetM 18): render failed — ${errText(err)}`);
        }
      }
      report.cues[id] = entry;
    }
    log(`rendered ${Object.keys(report.cues).length} cues`);

    // ---- scenes ------------------------------------------------------------------------
    for (const scene of SCENES) {
      try {
        const r = await page.evaluate(
          renderSceneAndCapture,
          scene.name,
          scene.seconds,
          scene.name,
          scene.chimeOnsetS ?? null,
        );
        report.scenes[scene.name] = { metrics: r.metrics, chime: r.chime };
        await writeBase64Wav(path.join(WAV_DIR, `scene.${scene.name}.wav`), r.wavBase64);
        await writeDataUrlPng(path.join(PNG_DIR, `scene.${scene.name}.png`), r.pngDataUrl);
      } catch (err) {
        fail(`scene '${scene.name}': render failed — ${errText(err)}`);
        report.scenes[scene.name] = { metrics: null, chime: null };
      }
    }
    log(`rendered ${SCENES.length} scenes`);

    // ---- baseline ------------------------------------------------------------------------
    for (const id of baselineIds) {
      const seconds = baselineRenderSeconds(id);
      try {
        const caption = `baseline: ${id}  (${seconds}s render)`;
        const r = await page.evaluate(renderBaselineAndCapture, id, seconds, caption);
        report.baseline[id] = r.metrics;
        await writeBase64Wav(path.join(WAV_DIR, `baseline.${id}.wav`), r.wavBase64);
        await writeDataUrlPng(path.join(PNG_DIR, `baseline.${id}.png`), r.pngDataUrl);
      } catch (err) {
        fail(`baseline '${id}': render failed — ${errText(err)}`);
        report.baseline[id] = null;
      }
    }
    log(`rendered ${baselineIds.length} baseline ids`);

    // ---- blind A/B set: anonymised, side drawn from a seeded RNG, key only in metrics.json --
    const rng = makeRng(AB_SEED);
    for (let i = 0; i < PAIRS.length; i++) {
      const { legacyId, riftId } = PAIRS[i];
      const n = i + 1;
      const aIsRift = rng() < 0.5;
      const riftSeconds = cueRenderSeconds(riftId);
      const legacySeconds = baselineRenderSeconds(legacyId);
      try {
        const riftPng = await page.evaluate(captureAnonymizedCue, riftId, riftSeconds, 0, aIsRift ? 'A' : 'B');
        const legacyPng = await page.evaluate(
          captureAnonymizedBaseline,
          legacyId,
          legacySeconds,
          aIsRift ? 'B' : 'A',
        );
        const aPng = aIsRift ? riftPng : legacyPng;
        const bPng = aIsRift ? legacyPng : riftPng;
        await writeDataUrlPng(path.join(AB_DIR, `${n}-A.png`), aPng);
        await writeDataUrlPng(path.join(AB_DIR, `${n}-B.png`), bPng);
        report.pairs.push({
          n,
          legacyId,
          riftId,
          aSide: aIsRift ? 'rift' : 'legacy',
          bSide: aIsRift ? 'legacy' : 'rift',
        });
      } catch (err) {
        fail(`AB pair ${n} (${legacyId} vs ${riftId}): render failed — ${errText(err)}`);
      }
    }
    log(`wrote ${PAIRS.length} anonymised A/B pairs`);

    // ==== ASSERTIONS ==================================================================
    // silence floors — every rendered item, including baselines.
    const allItems = [];
    for (const [id, e] of Object.entries(report.cues)) {
      if (e.primary) allItems.push([`cue ${id} @0m`, e.primary]);
      if (e.offset18) allItems.push([`cue ${id} @18m`, e.offset18]);
    }
    for (const [name, e] of Object.entries(report.scenes)) {
      if (e.metrics) allItems.push([`scene ${name}`, e.metrics]);
    }
    for (const [id, m] of Object.entries(report.baseline)) {
      if (m) allItems.push([`baseline ${id}`, m]);
    }
    for (const [label, m] of allItems) {
      check(`silence floor: ${label} rmsDbfs > -70`, m.rmsDbfs > -70, `got ${m.rmsDbfs.toFixed(1)} dBFS`);
      check(`silence floor: ${label} peakDbfs > -60`, m.peakDbfs > -60, `got ${m.peakDbfs.toFixed(1)} dBFS`);
    }

    // headroom — cues + scenes only (the baseline is an honest "before" picture and may
    // legitimately clip/overshoot; only the rebuilt audio's headroom is gated).
    const newBuildItems = [];
    for (const [id, e] of Object.entries(report.cues)) {
      if (e.primary) newBuildItems.push([`cue ${id} @0m`, e.primary]);
      if (e.offset18) newBuildItems.push([`cue ${id} @18m`, e.offset18]);
    }
    for (const [name, e] of Object.entries(report.scenes)) {
      if (e.metrics) newBuildItems.push([`scene ${name}`, e.metrics]);
    }
    for (const [label, m] of newBuildItems) {
      check(
        `headroom: ${label} truePeakDbtp <= ${TRUE_PEAK_GATE_DBTP}`,
        m.truePeakDbtp <= TRUE_PEAK_GATE_DBTP,
        `got ${m.truePeakDbtp.toFixed(2)} dBTP`,
      );
      check(`headroom: ${label} clippedSamples === 0`, m.clippedSamples === 0, `got ${m.clippedSamples}`);
    }
    for (const [name, e] of Object.entries(report.scenes)) {
      if (!e.metrics || e.metrics.limiterActivePct === null) continue;
      check(
        `headroom: scene ${name} limiterActivePct <= 2`,
        e.metrics.limiterActivePct <= 2,
        `got ${e.metrics.limiterActivePct.toFixed(2)}%`,
      );
    }

    // sub-bass weight.
    const subBassTargets = [
      ['obj.ancient', 45],
      ['obj.tower', 35],
      ['obj.guard', 35],
    ];
    for (const [id, minPct] of subBassTargets) {
      const m = report.cues[id]?.primary;
      if (!m) {
        fail(`sub-bass weight: ${id} was never rendered — cannot assert`);
        continue;
      }
      const pct = m.bandEnergyPct['0-120'];
      check(`sub-bass weight: ${id} bandEnergyPct[0-120] >= ${minPct}`, pct >= minPct, `got ${pct.toFixed(1)}%`);
    }

    // attack crispness — every atk.* cue.
    for (const id of soundIds) {
      if (!id.startsWith('atk.')) continue;
      const m = report.cues[id]?.primary;
      if (!m) continue; // already failed as a render failure above
      check(`attack crispness: ${id} attackMs < 8`, m.attackMs < 8, `got ${m.attackMs.toFixed(2)}ms`);
      check(`attack crispness: ${id} lengthMs < 200`, m.lengthMs < 200, `got ${m.lengthMs.toFixed(1)}ms`);
      check(`attack crispness: ${id} crestDb > 8`, m.crestDb > 8, `got ${m.crestDb.toFixed(1)}dB`);
    }

    // the info-register law — every non-info cue (everything not in ui.*/ann.*).
    for (const id of soundIds) {
      if (id.startsWith('ui.') || id.startsWith('ann.')) continue;
      const m = report.cues[id]?.primary;
      if (!m) continue;
      const infoPct =
        m.bandEnergyPct['800-2000'] + m.bandEnergyPct['2000-4000'] + m.bandEnergyPct['4000-20000'];
      check(
        `info register: ${id} energy above ${INFO_FLOOR_HZ}Hz <= ${INFO_BAND_MAX_PCT}%`,
        infoPct <= INFO_BAND_MAX_PCT,
        `got ${infoPct.toFixed(1)}%`,
      );
    }

    // the chime cuts through — lastHitInFight.
    const lastHit = report.scenes.lastHitInFight;
    if (lastHit?.chime) {
      check(
        `chime cut-through: lastHitInFight 2-4kHz onset >= bed + 8dB`,
        lastHit.chime.deltaDb >= 8,
        `chime ${lastHit.chime.chimeDb.toFixed(1)}dB, bed ${lastHit.chime.bedDb.toFixed(1)}dB, delta ${lastHit.chime.deltaDb.toFixed(1)}dB`,
      );
    } else {
      fail('chime cut-through: lastHitInFight scene did not render — cannot assert');
    }

    // dynamic range.
    const laning = report.scenes.laning?.metrics;
    const teamfight = report.scenes.teamfight?.metrics;
    if (laning) {
      check('dynamic range: laning rmsDbfs <= -30', laning.rmsDbfs <= -30, `got ${laning.rmsDbfs.toFixed(1)} dBFS`);
    } else {
      fail('dynamic range: laning scene did not render — cannot assert');
    }
    if (teamfight) {
      check(
        'dynamic range: teamfight rmsDbfs >= -18',
        teamfight.rmsDbfs >= -18,
        `got ${teamfight.rmsDbfs.toFixed(1)} dBFS`,
      );
    } else {
      fail('dynamic range: teamfight scene did not render — cannot assert');
    }

    // hero distinctness — within each hero, min pairwise centroid separation >= 15%.
    const byHero = new Map();
    for (const id of soundIds) {
      if (!id.startsWith('cast.')) continue;
      const parts = id.split('.');
      const hero = parts[1];
      if (hero === undefined || hero === 'item') continue;
      const m = report.cues[id]?.primary;
      if (!m) continue;
      if (!byHero.has(hero)) byHero.set(hero, []);
      byHero.get(hero).push([id, m.spectralCentroidHz]);
    }
    for (const [hero, slots] of byHero) {
      if (slots.length < 2) continue;
      let minPct = Infinity;
      let minPair = null;
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          const d = pctDiff(slots[i][1], slots[j][1]);
          if (d < minPct) {
            minPct = d;
            minPair = [slots[i][0], slots[j][0]];
          }
        }
      }
      check(
        `hero distinctness: ${hero} min pairwise centroid separation >= 15%`,
        minPct >= 15,
        `closest pair ${minPair?.join(' vs ')} at ${minPct.toFixed(1)}%`,
      );
    }

    // space — every world cue's offsetM:18 render has |stereoCorrelation| < 0.98.
    for (const [id, e] of Object.entries(report.cues)) {
      if (!isWorldCue(id) || !e.offset18) continue;
      const corr = Math.abs(e.offset18.stereoCorrelation);
      check(`space: ${id} @18m |stereoCorrelation| < 0.98`, corr < 0.98, `got ${corr.toFixed(3)}`);
    }

    // page/console errors — any is a failure.
    if (pageErrors.length > 0) {
      fail(`${pageErrors.length} page error(s):\n  ${pageErrors.slice(0, 12).join('\n  ')}`);
    }

    await browser.close();
    browser = null;

    report.meta.generatedAt = new Date().toISOString();
    await writeFile(METRICS_PATH, JSON.stringify(report, null, 2));
    log(`wrote ${path.relative(ROOT, METRICS_PATH)}`);
  } finally {
    if (browser !== null) {
      try {
        await browser.close();
      } catch {
        // already gone
      }
    }
    if (serverChild !== null && !keepServer) {
      await stopServer();
    }
  }

  const ok = failures.length === 0;
  log(
    ok
      ? `GREEN: ${report.assertions.length} assertions, 0 failures`
      : `RED: ${failures.length} failure(s) of ${report.assertions.length} assertions`,
  );
  console.log(
    JSON.stringify({
      ok,
      failureCount: failures.length,
      failures: failures.slice(0, 30),
      assertionCount: report.assertions.length,
      cueCount: Object.keys(report.cues).length,
      sceneCount: Object.keys(report.scenes).length,
      baselineCount: Object.keys(report.baseline).length,
      pairCount: report.pairs.length,
      metrics: path.relative(ROOT, METRICS_PATH),
    }),
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  log(`FATAL: ${errText(err)}`);
  console.log(JSON.stringify({ ok: false, fatal: errText(err) }));
  process.exit(1);
});
