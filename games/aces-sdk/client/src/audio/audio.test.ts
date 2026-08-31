// ============================================================================
// ACES C_AUDIO tests — headless, mirroring games/splat/client/src/audio.test.ts
// (and outpost's audio structure) exactly in approach: NO real WebAudio, no
// jsdom. Layers covered:
//   · PURE helpers headless: attenuation() distance law, engineFreq() bounds /
//     boost bump / monotonicity, farCutoff() muffle seats, admitVoice() FIFO
//     bookkeeping (the VOICE_CAP steal-oldest policy)
//   · mute persistence round-trip through a MOCKED globalThis.localStorage,
//     an injected store, and a blocked (throwing) store
//   · degradation: with window absent, or present WITHOUT an AudioContext
//     constructor, createAudio() is a complete silent no-op that never throws
//   · fake gesture: a minimal recording AudioContext stub installed as
//     window.AudioContext proves unlock() builds the graph ONCE (idempotent),
//     builds engine+wind rigs at unlock, drives per-frame params through
//     setTargetAtTime, schedules every recipe's expected node shapes, skips
//     one-shots while muted, resumes (not rebuilds) a suspended context, and
//     actually STEALS the oldest voices past the concurrent-voice cap
//     (observable as second stop() calls on the earliest scheduled sources).
// ============================================================================
import { describe, expect, it } from 'vitest';
import { BOOST_MULT, STREAK_ACE, STREAK_LEGEND } from '@aces/shared/config.js';
import type { AudioApi } from '../contract/seams.js';
import {
  DIST_REF_U,
  ENGINE_MAX_HZ,
  ENGINE_MIN_HZ,
  MUTED_KEY,
  VOICE_CAP,
  admitVoice,
  attenuation,
  createAudio,
  engineFreq,
  farCutoff,
  loadMuted,
  saveMuted,
} from './audio.js';

// ---- global hygiene -----------------------------------------------------------
// Every test starts from a bare realm: whatever a suite needs (window,
// localStorage) it installs itself and removes again.
function bareGlobals(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.window;
  delete g.localStorage;
}

// ---- mocked localStorage --------------------------------------------------------

/** Install a Map-backed localStorage onto globalThis (splat hud.test.ts
    precedent) and hand back the backing map for direct key assertions. */
function installLocalStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage = {
    getItem: (k: string): string | null => (backing.has(k) ? (backing.get(k) as string) : null),
    setItem: (k: string, v: string): void => void backing.set(k, String(v)),
    removeItem: (k: string): void => void backing.delete(k),
    clear: (): void => void backing.clear(),
  };
  return backing;
}

function uninstallLocalStorage(): void {
  delete (globalThis as unknown as Record<string, unknown>).localStorage;
}

// ---- fake AudioContext ------------------------------------------------------------
// Minimal node-shaped objects whose params RECORD automation calls, so graph
// wiring and envelopes are provable without WebAudio. setTargetAtTime lands in
// `targets` (the per-frame channel); exponential envelope ramps land in
// `ramps` (one-shot layer peaks are asserted through those).

interface FakeParam {
  value: number;
  targets: number[];
  ramps: number[];
  setValueAtTime(v: number, t: number): void;
  setTargetAtTime(v: number, t: number, c: number): void;
  exponentialRampToValueAtTime(v: number, t: number): void;
}

function fakeParam(value = 0): FakeParam {
  return {
    value,
    targets: [],
    ramps: [],
    setValueAtTime(v: number) { this.value = v; },
    setTargetAtTime(v: number) { this.value = v; this.targets.push(v); },
    exponentialRampToValueAtTime(v: number) { this.value = v; this.ramps.push(v); },
  };
}

interface FakeSource {
  buffer: unknown;
  loop: boolean;
  playbackRate: FakeParam;
  started: number;
  /** stop() invocations: ONE from scheduling (stop(t)) plus one more iff this
      source's event was stolen by the VOICE_CAP eviction. */
  stops: number;
}

interface FakeOsc {
  type: string;
  frequency: FakeParam;
}

interface FakeFilter {
  type: string;
  frequency: FakeParam;
  Q: FakeParam;
}

class FakeAudioContext {
  /** The instance most recently built via `new` — unlock() constructs it. */
  static last: FakeAudioContext | null = null;
  constructor() {
    FakeAudioContext.last = this;
  }
  state: AudioContextState = 'running';
  currentTime = 0;
  sampleRate = 8000; // small: the seeded noise-buffer fill stays cheap
  destination = { connect(): void { /* graph wiring is a no-op in the stub */ } };
  resumeCalls = 0;
  comps = 0;
  gains: { gain: FakeParam }[] = [];
  filters: FakeFilter[] = [];
  sources: FakeSource[] = [];
  oscList: FakeOsc[] = [];

  resume(): Promise<void> { this.resumeCalls++; return Promise.resolve(); }
  createGain(): unknown {
    const g = { connect(): void { /* noop */ }, gain: fakeParam(1) };
    this.gains.push(g as { gain: FakeParam });
    return g;
  }
  createDynamicsCompressor(): unknown {
    this.comps++;
    return {
      connect(): void { /* noop */ },
      threshold: fakeParam(), knee: fakeParam(), ratio: fakeParam(),
      attack: fakeParam(), release: fakeParam(),
    };
  }
  createBuffer(_channels: number, length: number, _rate: number): unknown {
    const data = new Float32Array(length);
    return { getChannelData: (i: number): Float32Array => (i === 0 ? data : new Float32Array(0)) };
  }
  createBufferSource(): unknown {
    const s = {
      connect(): void { /* noop */ },
      buffer: null, loop: false, playbackRate: fakeParam(1), started: 0, stops: 0,
      start(): void { this.started++; },
      stop(): void { this.stops++; },
    };
    this.sources.push(s as FakeSource);
    return s;
  }
  createBiquadFilter(): unknown {
    const f = {
      connect(): void { /* noop */ },
      frequency: fakeParam(), Q: fakeParam(1), type: 'lowpass',
    };
    this.filters.push(f as FakeFilter);
    return f;
  }
  createOscillator(): unknown {
    const o = {
      connect(): void { /* noop */ },
      type: 'sine', frequency: fakeParam(), detune: fakeParam(),
      start(): void { /* scheduled */ }, stop(): void { /* scheduled */ },
    };
    this.oscList.push(o as FakeOsc);
    return o;
  }
}

function installFakeContext(): void {
  FakeAudioContext.last = null;
  const w = globalThis as unknown as { window?: Record<string, unknown> };
  w.window = { ...(w.window ?? {}), AudioContext: FakeAudioContext };
}

function uninstallFakeContext(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
}

function created(): FakeAudioContext {
  const f = FakeAudioContext.last;
  if (!f) throw new Error('createAudio/unlock did not construct an AudioContext');
  return f;
}

/** Install the fake context, run a fresh unlock, hand back api + recorder.
    Every caller wraps in try/finally { uninstallFakeContext(); }. */
async function withRig(fn: (a: AudioApi, fake: FakeAudioContext) => Promise<void> | void): Promise<void> {
  installFakeContext();
  try {
    const a = createAudio();
    await a.unlock();
    await fn(a, created());
  } finally {
    uninstallFakeContext();
  }
}

/** Most recent setTargetAtTime value across these filters (−∞ when none). */
function maxLastTarget(filters: FakeFilter[]): number {
  let max = -Infinity;
  for (const f of filters) {
    const v = f.frequency.targets.at(-1);
    if (v !== undefined && v > max) max = v;
  }
  return max;
}

/** Last setTargetAtTime value on one param, or throw — for asserts that NEED
    a recorded move (distinguishes "no target" from "targeted 0"). */
function lastTarget(p: FakeParam): number {
  const v = p.targets.at(-1);
  if (v === undefined) throw new Error('expected a recorded setTargetAtTime');
  return v;
}

/** Every automated value ever recorded on any GAIN param (targets + ramps) —
    lets recipe tests find a specific layer peak without node identity. */
function allGainAutomation(fake: FakeAudioContext): number[] {
  return fake.gains.flatMap((g) => [...g.gain.targets, ...g.gain.ramps]);
}

// ============================================================================
// Headless no-op degradation (RULES 5 — one missing subsystem never crashes)
// ============================================================================

describe('AcesAudio — headless no-op', () => {
  it('every method is a safe silent no-op with NO window at all', async () => {
    bareGlobals();
    const a = createAudio();
    await expect(a.unlock()).resolves.toBeUndefined();
    expect(() => {
      a.setMuted(true);
      a.setMuted(false);
      a.ownEngine(0.5, 0.5, false);
      a.ownEngine(Number.NaN, Number.NaN, true);
      a.shot(true, 0);
      a.shot(false, -50);
      a.shot(false, Number.NaN);
      a.hitConfirm();
      a.hurt();
      a.killConfirm();
      a.explosion(1200);
      a.explosion(-1);
      a.pickup();
      a.overheatJam();
      a.streak(1);
      a.streak(Number.NaN);
      a.ui('click');
      a.ui('spawn');
      a.ui('win');
      a.ui('lose');
      a.wind(1);
      a.wind(-1);
      a.wind(Number.NaN);
    }).not.toThrow();
  });

  it('unlock() is idempotent even without a context', async () => {
    bareGlobals();
    const a = createAudio();
    await expect(a.unlock()).resolves.toBeUndefined();
    await expect(a.unlock()).resolves.toBeUndefined();
  });

  it('degrades to no-ops when window EXISTS but the AudioContext constructor is gone', async () => {
    bareGlobals();
    (globalThis as unknown as { window?: Record<string, unknown> }).window = {};
    try {
      const a = createAudio();
      await expect(a.unlock()).resolves.toBeUndefined();
      expect(() => {
        a.shot(true, 0);
        a.explosion(600);
        a.wind(0.8);
        a.ownEngine(1, 1, true);
        a.ui('win');
      }).not.toThrow();
    } finally {
      bareGlobals();
    }
  });
});

// ============================================================================
// Pure curves
// ============================================================================

describe('attenuation — the one distance law (1/(1 + d/600))', () => {
  it('full gain at the ear: zero, negative and non-finite distances', () => {
    expect(attenuation(0)).toBe(1);
    expect(attenuation(-10)).toBe(1);
    expect(attenuation(Number.NaN)).toBe(1);
  });
  it('hits the reference-law values exactly', () => {
    expect(attenuation(DIST_REF_U)).toBeCloseTo(0.5, 12); // half at 600 u
    expect(attenuation(2 * DIST_REF_U)).toBeCloseTo(1 / 3, 12);
    expect(attenuation(100000)).toBeGreaterThan(0); // never fully silent
  });
  it('is strictly monotonically decreasing with distance', () => {
    let prev = 1;
    for (let d = 1; d <= 2000; d += 13) {
      const g = attenuation(d);
      expect(g).toBeLessThan(prev);
      prev = g;
    }
  });
});

describe('engineFreq — throttle/speed pitch law', () => {
  it('unboosted stays inside the ≈55–115 Hz band across the input square', () => {
    for (const th of [-1, 0, 0.25, 0.5, 0.75, 1, 2]) {
      for (let sf = 0; sf <= 1.0001; sf += 0.1) {
        const f = engineFreq(th, sf, false);
        expect(f).toBeGreaterThanOrEqual(ENGINE_MIN_HZ - 1e-9);
        expect(f).toBeLessThanOrEqual(ENGINE_MAX_HZ + 1e-9);
      }
    }
  });
  it('boost bumps the pitch by exactly BOOST_MULT (the physics factor)', () => {
    for (const th of [0, 0.5, 1]) {
      for (const sf of [0, 0.5, 1]) {
        const base = engineFreq(th, sf, false);
        expect(engineFreq(th, sf, true)).toBeCloseTo(base * BOOST_MULT, 12);
        expect(engineFreq(th, sf, true)).toBeGreaterThan(base);
      }
    }
    expect(engineFreq(1, 1, true)).toBeLessThanOrEqual(ENGINE_MAX_HZ * BOOST_MULT + 1e-9);
  });
  it('is monotonically increasing in speedFrac at fixed throttle', () => {
    for (const th of [0, 0.5, 1]) {
      let prev = -Infinity;
      for (let sf = 0; sf <= 1.0001; sf += 0.05) {
        const f = engineFreq(th, sf, false);
        expect(f).toBeGreaterThan(prev);
        prev = f;
      }
    }
  });
  it('clamps out-of-range inputs and survives NaN', () => {
    expect(engineFreq(-1, 0.5, false)).toBe(engineFreq(0, 0.5, false));
    expect(engineFreq(2, 0.5, false)).toBe(engineFreq(1, 0.5, false));
    expect(engineFreq(Number.NaN, Number.NaN, false)).toBe(engineFreq(0, 0, false));
  });
});

describe('farCutoff — remote-gunfire muffle seat', () => {
  it('falls with distance but never below its dull floor', () => {
    expect(farCutoff(0)).toBeGreaterThan(farCutoff(10 * DIST_REF_U)); // near bite vs far slump
    let prev = Infinity;
    for (let d = 0; d <= 5000; d += 125) {
      const c = farCutoff(d);
      expect(c).toBeLessThan(prev); // duller the farther the shooter
      prev = c;
    }
    expect(farCutoff(100000)).toBeGreaterThan(0); // floor, not silence
    // the burst ramps f1 = cutoff * 0.45 — always a falling sweep ("energy leaving")
    expect(farCutoff(0) * 0.45).toBeLessThan(farCutoff(0));
  });
});

// ============================================================================
// Voice-cap bookkeeping (steal-oldest FIFO)
// ============================================================================

describe('admitVoice / VOICE_CAP — the concurrency budget', () => {
  it('admits freely until the cap is reached (never evicts below it)', () => {
    let q: readonly number[] = [];
    for (let i = 0; i < VOICE_CAP; i++) {
      const res = admitVoice(q, i, VOICE_CAP);
      expect(res.evicted).toBeNull();
      q = res.queue;
    }
    expect(q).toHaveLength(VOICE_CAP);
  });

  it('steals the OLDEST entry FIFO once over, forever', () => {
    let q: readonly number[] = [];
    const stolen: number[] = [];
    for (let i = 0; i < 50; i++) {
      const res = admitVoice(q, i, VOICE_CAP);
      q = res.queue;
      const ev = res.evicted;
      if (ev !== null) stolen.push(ev);
      expect(q.length).toBeLessThanOrEqual(VOICE_CAP);
    }
    // 50 arrivals through a 24-slot budget evict exactly arrivals 0..25
    expect(stolen).toHaveLength(26);
    stolen.forEach((v, i) => expect(v).toBe(i)); // strict FIFO order
  });

  it('coerces a degenerate cap (<1) to 1 — the newcomer always plays', () => {
    let q: readonly number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = admitVoice(q, i, 0);
      expect(res.evicted).not.toBe(i); // never steals the voice it just admitted
      q = res.queue;
      expect(q).toEqual([i]);
    }
  });
});

// ============================================================================
// Mute persistence (mocked localStorage + injected/blocked stores)
// ============================================================================

describe('mute persistence — aces.muted round-trip', () => {
  it("round-trips through the global localStorage ('1'/'0' flags)", () => {
    installLocalStorage();
    try {
      expect(loadMuted()).toBe(false); // absent key reads unmuted
      saveMuted(true);
      expect(loadMuted()).toBe(true);
      expect(localStorage.getItem(MUTED_KEY)).toBe('1');
      saveMuted(false);
      expect(loadMuted()).toBe(false);
      expect(localStorage.getItem(MUTED_KEY)).toBe('0');
    } finally {
      uninstallLocalStorage();
    }
  });

  it('round-trips through an INJECTED store without touching any global', () => {
    const backing = new Map<string, string>();
    const store = {
      getItem: (k: string): string | null => (backing.has(k) ? (backing.get(k) as string) : null),
      setItem: (k: string, v: string): void => void backing.set(k, String(v)),
    };
    expect(loadMuted(store)).toBe(false);
    saveMuted(true, store);
    expect(loadMuted(store)).toBe(true);
    saveMuted(false, store);
    expect(loadMuted(store)).toBe(false);
  });

  it('survives BLOCKED storage: reads unmuted, saves silently', () => {
    const hostile = {
      getItem(): string { throw new Error('storage blocked'); },
      setItem(): void { throw new Error('storage blocked'); },
    };
    expect(() => saveMuted(true, hostile)).not.toThrow();
    expect(loadMuted(hostile)).toBe(false);
    expect(loadMuted(undefined)).toBe(false); // no store at all either
  });
});

// ============================================================================
// Fake-gesture runs — the real graph paths, recorded
// ============================================================================

describe('AcesAudio — with a stubbed AudioContext (fake gesture)', () => {
  it('unlock() builds the whole graph ONCE: limiter bus, engine drone, wind bed', async () => {
    await withRig(async (a, fake) => {
      // bus: master -> compressor -> destination
      expect(fake.comps).toBe(1);
      // engine rig exists at unlock (brief: continuous sawtooth->lowpass voice)
      const saw = fake.oscList.find((o) => o.type === 'sawtooth');
      if (!saw) throw new Error('engine oscillator missing');
      expect(saw.frequency.value).toBe(ENGINE_MIN_HZ); // parked until first ownEngine
      // wind rig exists at unlock: exactly one LOOPED noise source, started once
      const loops = fake.sources.filter((s) => s.loop);
      expect(loops).toHaveLength(1);
      expect(loops[0]?.started).toBe(1);

      // idempotence: a second gesture must not rebuild anything
      const snap = (): number[] => [
        fake.gains.length, fake.filters.length, fake.sources.length,
        fake.oscList.length, fake.comps,
      ];
      const before = snap();
      await a.unlock();
      expect(snap()).toEqual(before);
      expect(loops[0]?.started).toBe(1); // still started exactly once
    });
  });

  it('ownEngine tracks engineFreq() through setTargetAtTime; boost surges audibly', async () => {
    await withRig(async (a, fake) => {
      const saw = fake.oscList.find((o) => o.type === 'sawtooth');
      if (!saw) throw new Error('engine oscillator missing');

      a.ownEngine(0, 0, false); // idle
      expect(lastTarget(saw.frequency)).toBeCloseTo(engineFreq(0, 0, false), 9);
      const idleCut = maxLastTarget(fake.filters.filter((f) => f.type === 'lowpass'));

      a.ownEngine(1, 1, true); // everything up, boosted
      const boosted = lastTarget(saw.frequency);
      expect(boosted).toBeCloseTo(engineFreq(1, 1, true), 9);
      expect(boosted).toBeGreaterThan(ENGINE_MAX_HZ); // surge past the band
      const fullCut = maxLastTarget(fake.filters.filter((f) => f.type === 'lowpass'));
      expect(fullCut).toBeGreaterThan(idleCut); // cutoff opens with drive

      a.ownEngine(0.5, 0.25, false);
      expect(lastTarget(saw.frequency)).toBeCloseTo(engineFreq(0.5, 0.25, false), 9);
    });
  });

  it('wind gates gain ∝ speedFrac² on exactly ONE gain param, smoothly', async () => {
    await withRig(async (a, fake) => {
      const lensBefore = fake.gains.map((g) => g.gain.targets.length);
      a.wind(0.2);
      a.wind(0.6);
      a.wind(1);
      // exactly one GAIN received three new targets (the wind gate); the filter
      // cutoff moves too but lives on a filter param, not a gain
      const movers: number[][] = [];
      fake.gains.forEach((g, i) => {
        const delta = g.gain.targets.length - (lensBefore[i] ?? 0);
        if (delta === 3) {
          const last3 = g.gain.targets.slice(-3);
          if (last3.length === 3) movers.push(last3);
        }
      });
      expect(movers).toHaveLength(1);
      const tri = movers[0];
      if (!tri) throw new Error('wind gate did not record its targets');
      const [lo, mid, hi] = tri;
      if (lo === undefined || mid === undefined || hi === undefined) {
        throw new Error('incomplete wind-gate record');
      }
      expect(hi).toBeGreaterThan(mid);
      expect(mid).toBeGreaterThan(lo); // frac² ladder: quiet → roaring
    });
  });

  it('own guns: crisp highpass crack + bandpass body, no oscillators, full gain', async () => {
    await withRig(async (a, fake) => {
      const s0 = fake.sources.length;
      const f0 = fake.filters.length;
      const o0 = fake.oscList.length;
      a.shot(true, 0);
      expect(fake.sources.length - s0).toBe(2);
      expect(fake.oscList.length - o0).toBe(0);
      expect(fake.filters.slice(f0).map((f) => f.type).sort()).toEqual(['bandpass', 'highpass']);
    });
  });

  it('distant guns: ONE lowpass layer, muffled along the shared distance law', async () => {
    await withRig(async (a, fake) => {
      const f0 = fake.filters.length;
      a.shot(false, 1200);
      const flt = fake.filters[f0];
      if (!flt) throw new Error('distant shot scheduled no filter');
      expect(flt.type).toBe('lowpass');
      // the burst schedules f0=farCutoff(d) then ramps down to cutoff*0.45 —
      // the recorded final value must be exactly that sweep floor
      expect(flt.frequency.value).toBeCloseTo(farCutoff(1200) * 0.45, 6);
    });
  });

  it('voice cap: 30 rapid volleys schedule 60 sources and STEAL the oldest 6 events', async () => {
    await withRig(async (a, fake) => {
      const s0 = fake.sources.length;
      for (let i = 0; i < 30; i++) a.shot(true, 0);
      // every volley scheduled its two layers…
      expect(fake.sources.length - s0).toBe(30 * 2);
      // …and the FIFO stole 30 − 24 = 6 whole events. A stolen event gets a
      // SECOND stop() on each of its layers (the first came from scheduling),
      // so exactly 12 sources show stops === 2 — the oldest ones.
      const twiceStopped = fake.sources.filter((s) => s.stops === 2);
      expect(twiceStopped).toHaveLength((30 - VOICE_CAP) * 2);
      expect(fake.sources.every((s) => s.stops <= 2)).toBe(true); // each event stolen at most once
    });
  });

  it('combat feedback recipes schedule their layered shapes', async () => {
    await withRig(async (a, fake) => {
      const count = (): { s: number; o: number } =>
        ({ s: fake.sources.length, o: fake.oscList.length });

      let b = count();
      a.hitConfirm(); // metallic ping (pitch-drop sine) + highpass tick
      expect(count().o - b.o).toBe(1);
      expect(count().s - b.s).toBe(1);
      expect(fake.oscList[b.o]?.type).toBe('sine');

      b = count();
      a.hurt(); // low thud + grit noise
      expect(count().o - b.o).toBe(1);
      expect(count().s - b.s).toBe(1);
      const thud = fake.oscList[b.o];
      if (!thud) throw new Error('hurt scheduled no oscillator');
      expect(thud.frequency.value).toBeCloseTo(62, 6); // the thud lands LOW

      b = count();
      a.killConfirm(); // thunk + ring = two layers
      expect(count().o - b.o).toBe(2);
      expect(fake.oscList.slice(b.o).map((o) => o.type).sort())
        .toEqual(['sine', 'triangle']);
    });
  });

  it('explosion: sub drop lands at 40 Hz and gain rides the distance law', async () => {
    await withRig(async (a, fake) => {
      const s0 = fake.sources.length;
      const o0 = fake.oscList.length;
      a.explosion(1200);
      expect(fake.sources.length - s0).toBe(2); // noise mass + debris band
      expect(fake.oscList.length - o0).toBe(1); // the sub
      const sub = fake.oscList[o0];
      if (!sub) throw new Error('explosion scheduled no sub oscillator');
      expect(sub.frequency.value).toBeCloseTo(40, 6); // 90 → 40 Hz fall
      // the sub layer's peak is exactly 0.6 × attenuation(dist) — the ONE law
      const want = 0.6 * attenuation(1200);
      const hit = allGainAutomation(fake).some((t) => Math.abs(t - want) < 1e-9);
      expect(hit).toBe(true);
    });
  });

  it('pickups, jams and UI stingers schedule their exact shapes', async () => {
    await withRig(async (a, fake) => {
      const count = (): { s: number; o: number } =>
        ({ s: fake.sources.length, o: fake.oscList.length });

      let b = count();
      a.pickup(); // two-note chime + wood tick
      expect(count().o - b.o).toBe(2);
      expect(count().s - b.s).toBe(1);

      b = count();
      a.overheatJam(); // square clunk + two rattle taps
      expect(count().o - b.o).toBe(1);
      expect(count().s - b.s).toBe(2);
      expect(fake.oscList[b.o]?.type).toBe('square');

      b = count();
      a.ui('click'); // single blip
      expect(count().o - b.o).toBe(1);
      expect(count().s - b.s).toBe(0);

      b = count();
      a.ui('spawn'); // pure air: one swept band, no oscillator body
      expect(count().o - b.o).toBe(0);
      expect(count().s - b.s).toBe(1);
    });
  });

  it('streak stinger climbs the config ladder: pair → brighter pair at ACE → triad at LEGEND', async () => {
    await withRig(async (a, fake) => {
      let n0 = fake.oscList.length;

      a.streak(STREAK_ACE - 1); // warming up: modest fifth lift
      const base = fake.oscList.slice(n0).map((o) => o.frequency.value);
      expect(base).toEqual([392, 587.33]);
      n0 += base.length;

      a.streak(STREAK_ACE); // ACE: brighter pair
      const ace = fake.oscList.slice(n0).map((o) => o.frequency.value);
      expect(ace).toEqual([440, 659.25]);
      n0 += ace.length;

      a.streak(STREAK_LEGEND); // LEGEND: three-note major-triad climb
      const legend = fake.oscList.slice(n0).map((o) => o.frequency.value);
      expect(legend).toEqual([587.33, 739.99, 880]);
    });
  });

  it('win lifts major and ascending, lose falls minor and descending — 4 notes each', async () => {
    await withRig(async (a, fake) => {
      const o0 = fake.oscList.length;
      a.ui('win');
      const winOscs = fake.oscList.slice(o0);
      const win = winOscs.map((o) => o.frequency.value);
      expect(win).toHaveLength(4); // contract: ≤ 4 notes
      expect(win).toEqual([...win].sort((x, y) => x - y)); // a LIFT
      expect(win[0]).toBeCloseTo(261.63, 6); // C4 root
      expect(win[3]).toBeCloseTo(523.25, 6); // octave top
      expect(winOscs.every((o) => o.type === 'triangle')).toBe(true);

      const l0 = fake.oscList.length;
      a.ui('lose');
      const loseOscs = fake.oscList.slice(l0);
      const lose = loseOscs.map((o) => o.frequency.value);
      expect(lose).toHaveLength(4);
      expect(lose).toEqual([...lose].sort((x, y) => x - y).reverse()); // a FALL
      expect(lose[0]).toBeCloseTo(329.63, 6); // E4 — starts below win's root
      expect(loseOscs.every((o) => o.type === 'sine')).toBe(true);
    });
  });

  it('mute: ramps the master to silence, persists the flag, and SKIPS one-shot scheduling', async () => {
    installLocalStorage();
    try {
      installFakeContext();
      try {
        const a = createAudio();
        await a.unlock();
        const fake = created();

        a.setMuted(true);
        expect(localStorage.getItem(MUTED_KEY)).toBe('1'); // persisted
        expect(fake.gains.some((g) => g.gain.value === 0.0001)).toBe(true); // bus dipped
        const s0 = fake.sources.length;
        const o0 = fake.oscList.length;
        a.shot(true, 0);
        a.explosion(0);
        a.ui('win');
        expect(fake.sources.length).toBe(s0); // zero doomed nodes scheduled
        expect(fake.oscList.length).toBe(o0);

        a.setMuted(false);
        expect(localStorage.getItem(MUTED_KEY)).toBe('0');
        expect(fake.gains.some((g) => g.gain.value === 0.5)).toBe(true); // bus restored
        a.shot(true, 0);
        expect(fake.sources.length).toBeGreaterThan(s0); // live fire again
      } finally {
        uninstallFakeContext();
      }
    } finally {
      uninstallLocalStorage();
    }
  });

  it('a persisted mute is ADOPTED at unlock (master starts dipped)', async () => {
    installLocalStorage();
    try {
      localStorage.setItem(MUTED_KEY, '1');
      installFakeContext();
      try {
        const a = createAudio();
        await a.unlock();
        const fake = created();
        expect(fake.gains.some((g) => g.gain.value === 0.0001)).toBe(true);
      } finally {
        uninstallFakeContext();
      }
    } finally {
      uninstallLocalStorage();
    }
  });

  it('a SUSPENDED context: everything stays silent; next unlock resumes instead of rebuilding', async () => {
    await withRig(async (a, fake) => {
      fake.state = 'suspended';
      const s0 = fake.sources.length;
      const t0 = fake.gains.reduce((n, g) => n + g.gain.targets.length, 0);
      a.shot(true, 0);
      a.wind(1);
      a.ownEngine(1, 1, true);
      expect(fake.sources.length).toBe(s0);
      expect(fake.gains.reduce((n, g) => n + g.gain.targets.length, 0)).toBe(t0);

      await a.unlock(); // gesture #2 while suspended: resume, never rebuild
      expect(fake.resumeCalls).toBe(1);
      expect(fake.sources.length).toBe(s0);
      expect(fake.comps).toBe(1); // still the one bus limiter
    });
  });
});
