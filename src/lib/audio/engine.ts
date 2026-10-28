/**
 * Central Web Audio engine.
 *
 * Every tool on the site routes through this singleton so that:
 * - one AudioContext is created (browsers cap the number of contexts),
 * - the master volume / mute state is shared across pages,
 * - a safety limiter protects headphones and speakers from clipping,
 * - a single AnalyserNode feeds every scope and spectrum display.
 *
 * Signal path:  voice -> master (volume) -> limiter (safety) -> analyser -> output
 */

export type Waveform = 'sine' | 'square' | 'sawtooth' | 'triangle';

export const WAVEFORMS: Waveform[] = ['sine', 'square', 'sawtooth', 'triangle'];

export const MASTER_STORAGE_KEY = 'sg.master.v1';

type Engine = {
  ctx: AudioContext;
  master: GainNode;
  limiter: DynamicsCompressorNode;
  analyser: AnalyserNode;
};

let engine: Engine | null = null;
let masterPosition = 50; // 0..100, perceptual (squared) taper
let muted = false;
const listeners = new Set<() => void>();

function readStoredPosition(): number {
  try {
    const raw = localStorage.getItem(MASTER_STORAGE_KEY);
    if (raw == null) return 50;
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(n, 0, 100) : 50;
  } catch {
    return 50;
  }
}

function storePosition(pos: number): void {
  try {
    localStorage.setItem(MASTER_STORAGE_KEY, String(Math.round(pos)));
  } catch {
    /* storage unavailable (private mode) - volume just won't persist */
  }
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Slider position (0..100) -> linear gain. Squared taper: 50 -> 0.25, 100 -> 1.0. */
export function positionToGain(position: number): number {
  const p = clamp(position, 0, 100) / 100;
  return p * p;
}

export function gainToDb(gain: number): number {
  if (gain <= 0.000001) return -Infinity;
  return 20 * Math.log10(gain);
}

export function formatDb(gain: number, digits = 1): string {
  const db = gainToDb(gain);
  if (!Number.isFinite(db)) return '-inf dB';
  const sign = db > 0 ? '+' : '';
  return `${sign}${db.toFixed(digits)} dB`;
}

/** Create (or resume) the shared AudioContext. Call from a user gesture. */
export function ensureContext(): AudioContext {
  if (!engine) {
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API is not supported in this browser.');
    const ctx = new Ctor({ latencyHint: 'interactive' });

    const master = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    // Conservative brick-wall-ish safety net: keeps a full-scale square wave
    // (which sums well above 1.0 in the harmonics) from frying headphones.
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    analyser.minDecibels = -96;
    analyser.maxDecibels = -6;

    master.connect(limiter).connect(analyser).connect(ctx.destination);
    masterPosition = readStoredPosition();
    master.gain.value = positionToGain(masterPosition);

    engine = { ctx, master, limiter, analyser };
  }

  if (engine.ctx.state === 'suspended') void engine.ctx.resume();
  if (engine.ctx.state === 'running' && muted) {
    muted = false;
    engine.master.gain.value = positionToGain(masterPosition);
  }
  emit();
  return engine.ctx;
}

export function getContextOrNull(): AudioContext | null {
  return engine?.ctx ?? null;
}

export function getCtx(): AudioContext {
  if (!engine) return ensureContext();
  // Any code path that reaches for the context is normally inside a user
  // gesture (a Play handler), so make sure a context that was created early - 
  // by a scope canvas, say - actually starts. Without this, pages that only
  // schedule short clicks through playClick() stay silent on the first press.
  if (engine.ctx.state === 'suspended') void engine.ctx.resume();
  return engine.ctx;
}

export function getMasterGain(): GainNode {
  getCtx();
  return engine!.master;
}

export function getAnalyser(): AnalyserNode {
  getCtx();
  return engine!.analyser;
}

/** Node that every voice should connect into. */
export function getInput(): GainNode {
  return getMasterGain();
}

export function getSampleRate(): number {
  return getCtx().sampleRate;
}

export function getMasterPosition(): number {
  return masterPosition;
}

export function getMasterGainValue(): number {
  return muted ? 0 : positionToGain(masterPosition);
}

export function isMuted(): boolean {
  return muted;
}

export function setMasterPosition(position: number, persist = true): void {
  masterPosition = clamp(position, 0, 100);
  if (!muted) {
    const gain = positionToGain(masterPosition);
    const g = getMasterGain().gain;
    // Short ramp so dragging the slider does not produce zipper noise.
    if (engine) {
      const now = engine.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setTargetAtTime(gain, now, 0.012);
    } else {
      g.value = gain;
    }
  }
  if (persist) storePosition(masterPosition);
  emit();
}

export function setMuted(next: boolean): void {
  muted = next;
  const master = getMasterGain();
  if (engine) {
    const now = engine.ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setTargetAtTime(next ? 0 : positionToGain(masterPosition), now, 0.02);
  } else {
    master.gain.value = next ? 0 : positionToGain(masterPosition);
  }
  emit();
}

export function toggleMuted(): boolean {
  setMuted(!muted);
  return muted;
}

/** Subscribe to global engine state (volume / mute / running). Returns an unsubscribe fn. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const listener of listeners) listener();
}

/* ------------------------------------------------------------------ */
/* Analysis buffers - allocated once, reused every animation frame.    */
/* The element types are derived from the AnalyserNode signatures so    */
/* they stay correct across TypeScript's typed-array generics.          */
/* ------------------------------------------------------------------ */

type TimeDataArray = Parameters<AnalyserNode['getFloatTimeDomainData']>[0];
type FrequencyDataArray = Parameters<AnalyserNode['getByteFrequencyData']>[0];

let timeBuffer: TimeDataArray | null = null;
let freqBuffer: FrequencyDataArray | null = null;

export function readTimeDomain(): TimeDataArray {
  const analyser = getAnalyser();
  if (!timeBuffer || timeBuffer.length !== analyser.fftSize) {
    timeBuffer = new Float32Array(analyser.fftSize);
  }
  analyser.getFloatTimeDomainData(timeBuffer);
  return timeBuffer;
}

export function readFrequency(): FrequencyDataArray {
  const analyser = getAnalyser();
  const bins = analyser.frequencyBinCount;
  if (!freqBuffer || freqBuffer.length !== bins) {
    freqBuffer = new Uint8Array(bins);
  }
  analyser.getByteFrequencyData(freqBuffer);
  return freqBuffer;
}

/** RMS of the current output, 0..1. Handy for VU meters and silent-playback checks. */
export function currentLevel(): number {
  const data = readTimeDomain();
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}

/** Peak sample of the current output, 0..1. */
export function currentPeak(): number {
  const data = readTimeDomain();
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i]);
    if (abs > peak) peak = abs;
  }
  return peak;
}

/* ------------------------------------------------------------------ */
/* Shared voice bookkeeping                                            */
/* ------------------------------------------------------------------ */

const liveVoices = new Set<{ stop: (immediate?: boolean) => void }>();

export function trackVoice(voice: { stop: (immediate?: boolean) => void }): { stop: () => void } {
  liveVoices.add(voice);
  return {
    stop: () => {
      voice.stop();
      liveVoices.delete(voice);
    },
  };
}

export function untrackVoice(voice: { stop: (immediate?: boolean) => void }): void {
  liveVoices.delete(voice);
}

/** Stop every registered voice. Called on page hide and by global Stop buttons. */
export function stopAllVoices(): void {
  for (const voice of [...liveVoices]) {
    try {
      voice.stop();
    } catch {
      /* already stopped */
    }
    liveVoices.delete(voice);
  }
}

export function activeVoiceCount(): number {
  return liveVoices.size;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => stopAllVoices());
  document.addEventListener('visibilitychange', () => {
    // Mobile browsers suspend the context when backgrounded; nothing to stop,
    // but reports should not claim sound is playing while suspended.
    if (document.visibilityState === 'visible' && engine?.ctx.state === 'suspended') {
      void engine.ctx.resume();
    }
  });
}
