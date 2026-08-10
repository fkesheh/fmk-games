// ============================================================================
// C4 audio tests. Headless: no window, no AudioContext — constructing a
// SplatAudio and driving every method must be a complete, silent no-op that
// never throws (the contract's robustness rule: audio must never crash the
// client). Plus a fake-gesture run with a stub AudioContext to prove resume()
// is idempotent and the rig/one-shot graph code paths execute cleanly, and
// unit tests for the pure distanceGain() curve (1/(1 + d/12)).
// ============================================================================
import { describe, expect, it } from 'vitest';
import { distanceGain, SplatAudio } from './audio';

describe('SplatAudio — headless no-op', () => {
  it('every method is a safe silent no-op with no AudioContext', () => {
    const a = new SplatAudio();
    expect(() => {
      a.resume();
      a.resume(); // idempotent
      a.wind(1);
      a.wind(0);
      a.wind(-1); // out-of-range input is clamped, still safe
      a.wind(Number.NaN);
      a.carve(1);
      a.carve(0);
      a.sfx('rustle');
      a.sfx('beep');
      a.sfx('go', { distance: 30 });
      a.sfx('finish', { distance: -5 });
      a.sfx('sting', {});
    }).not.toThrow();
  });
});

describe('distanceGain', () => {
  it('is full gain for own events (undefined / zero / negative distance)', () => {
    expect(distanceGain(undefined)).toBe(1);
    expect(distanceGain(0)).toBe(1);
    expect(distanceGain(-10)).toBe(1);
  });
  it('follows 1/(1 + d/12), smooth and never zero', () => {
    expect(distanceGain(12)).toBeCloseTo(0.5, 10);
    expect(distanceGain(30)).toBeCloseTo(1 / 3.5, 10);
    expect(distanceGain(120)).toBeCloseTo(1 / 11, 10);
    expect(distanceGain(10000)).toBeGreaterThan(0);
  });
  it('is monotonically decreasing with distance', () => {
    let prev = 1;
    for (let d = 1; d <= 200; d += 7) {
      const g = distanceGain(d);
      expect(g).toBeLessThan(prev);
      prev = g;
    }
  });
});

// ---- fake-gesture path -------------------------------------------------------
// A minimal AudioContext stub: every factory returns a node-shaped object
// whose params record setTargetAtTime calls, so we can prove the rig wires up
// and per-frame gates actually move — all without real WebAudio.

interface FakeParam {
  value: number;
  targets: number[];
  setValueAtTime(v: number, t: number): void;
  setTargetAtTime(v: number, t: number, c: number): void;
  exponentialRampToValueAtTime(v: number, t: number): void;
}

function fakeParam(value = 0): FakeParam {
  return {
    value,
    targets: [],
    setValueAtTime(v: number) { this.value = v; },
    setTargetAtTime(v: number) { this.value = v; this.targets.push(v); },
    exponentialRampToValueAtTime(v: number) { this.value = v; },
  };
}

function fakeNode(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { connect() { /* graph wiring is a no-op in the stub */ }, ...extra };
}

class FakeAudioContext {
  /** The instance most recently built via `new` — resume() constructs its own. */
  static last: FakeAudioContext | null = null;
  constructor() {
    FakeAudioContext.last = this;
  }
  state: AudioContextState = 'running';
  currentTime = 0;
  sampleRate = 8000; // small: the noise-buffer fill loop stays cheap
  destination = fakeNode();
  resumeCalls = 0;
  gains: { gain: FakeParam }[] = [];
  filters: { frequency: FakeParam; Q: FakeParam; type: string }[] = [];
  sources: { buffer: unknown; loop: boolean; playbackRate: FakeParam; started: number }[] = [];
  oscillators = 0;
  resume(): Promise<void> { this.resumeCalls++; return Promise.resolve(); }
  createGain(): unknown {
    const g = fakeNode({ gain: fakeParam(1) });
    this.gains.push(g as { gain: FakeParam });
    return g;
  }
  createDynamicsCompressor(): unknown {
    return fakeNode({
      threshold: fakeParam(), knee: fakeParam(), ratio: fakeParam(),
      attack: fakeParam(), release: fakeParam(),
    });
  }
  createBuffer(channels: number, length: number, rate: number): unknown {
    const data = new Float32Array(length);
    return { getChannelData: (i: number) => (i === 0 ? data : new Float32Array(0)) };
  }
  createBufferSource(): unknown {
    const s = fakeNode({
      buffer: null, loop: false, playbackRate: fakeParam(1), started: 0,
      start() { (this as { started: number }).started++; },
      stop() { /* one-shots stop themselves */ },
    });
    this.sources.push(s as { buffer: unknown; loop: boolean; playbackRate: FakeParam; started: number });
    return s;
  }
  createBiquadFilter(): unknown {
    const f = fakeNode({ frequency: fakeParam(), Q: fakeParam(1), type: 'lowpass' });
    this.filters.push(f as { frequency: FakeParam; Q: FakeParam; type: string });
    return f;
  }
  createOscillator(): unknown {
    this.oscillators++;
    return fakeNode({
      type: 'sine', frequency: fakeParam(), detune: fakeParam(),
      start() { /* scheduled */ }, stop() { /* scheduled */ },
    });
  }
}

/** Install the stub as window.AudioContext; the instance resume() builds is
 *  read back via created() (SplatAudio constructs the context, not the test). */
function installFakeContext(): void {
  FakeAudioContext.last = null;
  const w = globalThis as unknown as { window?: Record<string, unknown> };
  w.window = { ...(w.window ?? {}), AudioContext: FakeAudioContext };
}

function created(): FakeAudioContext {
  const f = FakeAudioContext.last;
  if (!f) throw new Error('SplatAudio did not construct an AudioContext');
  return f;
}

function uninstallFakeContext(): void {
  const w = globalThis as unknown as { window?: Record<string, unknown> };
  delete w.window;
}

describe('SplatAudio — with a stubbed AudioContext (fake gesture)', () => {
  it('resume() builds the graph once, idempotently; voices gate per frame', () => {
    installFakeContext();
    try {
      const a = new SplatAudio();
      a.resume();
      a.resume(); // second gesture: must NOT build a second context/graph
      const fake = created(); // the context resume() constructed
      const gainsAfterResume = fake.gains.length;
      expect(gainsAfterResume).toBe(1); // master only; rig is lazy

      a.wind(1); // first voice call builds the rig (2 sources: wind + carve)
      a.carve(1);
      a.wind(0.5);
      a.carve(0.25);
      a.resume(); // still no rebuild
      expect(fake.sources.filter((s) => s.started > 0).length).toBe(2);
      const looped = fake.sources.filter((s) => s.loop && s.started === 1);
      expect(looped.length).toBe(2); // each persistent voice started exactly once
      // detuned playbackRates so the two loops never phase-lock
      expect(looped[0]?.playbackRate.value).not.toBe(looped[1]?.playbackRate.value);

      // wind gain gate: speedFrac^2 — the last wind(0.5) targeted 0.11 * 0.25
      const windGate = fake.gains.find((g) => g.gain.targets.includes(0.11 * 0.5 * 0.5));
      expect(windGate).toBeDefined();
      // carve gain gate: follows the amount — carve(0.25) targeted 0.2 * 0.25
      const carveGate = fake.gains.find((g) => g.gain.targets.includes(0.2 * 0.25));
      expect(carveGate).toBeDefined();
      // two different filter characters: wind is wide (Q 0.5), carve tight (Q 1.9)
      const qs = fake.filters.map((f) => f.Q.value).sort();
      expect(qs).toContain(0.5);
      expect(qs).toContain(1.9);
    } finally {
      uninstallFakeContext();
    }
  });

  it('every sfx kind schedules its graph without throwing; distance attenuates', () => {
    installFakeContext();
    try {
      const a = new SplatAudio();
      a.resume();
      const fake = created(); // the context resume() constructed
      const before = fake.sources.length + fake.oscillators;
      expect(() => {
        a.sfx('rustle');
        a.sfx('beep');
        a.sfx('go');
        a.sfx('finish');
        a.sfx('sting');
        a.sfx('rustle', { distance: 30 });
      }).not.toThrow();
      // one-shots actually scheduled nodes (rustle = 1 burst + 1 beep, etc.)
      expect(fake.sources.length + fake.oscillators).toBeGreaterThan(before);
      // a suspended context resumes on the next gesture instead of rebuilding
      fake.state = 'suspended';
      const gainsBefore = fake.gains.length;
      a.resume();
      expect(fake.resumeCalls).toBe(1);
      expect(fake.gains.length).toBe(gainsBefore);
      fake.state = 'running';
      // and while suspended, one-shots are silent no-ops (autoplay policy)
      fake.state = 'suspended';
      const nodesBefore = fake.sources.length + fake.oscillators;
      expect(() => a.sfx('go')).not.toThrow();
      expect(fake.sources.length + fake.oscillators).toBe(nodesBefore);
    } finally {
      uninstallFakeContext();
    }
  });
});
