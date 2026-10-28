/**
 * Sound sources. Each voice owns its oscillators/buffers and registers itself
 * with the engine so global Stop buttons and page-hide cleanup always silence
 * everything.
 *
 * All voices connect into the engine's master bus (or a node you pass in) and
 * always fade in/out - abrupt starts and stops are audible clicks.
 */

import {
  getCtx,
  getInput,
  trackVoice,
  untrackVoice,
  clamp,
  type Waveform,
} from './engine';

const MIN_RAMP = 0.004;

export type VoiceBase = {
  /** Fade out and release. */
  stop: () => void;
  /** Cut instantly (still click-free: 4 ms) - used for key-press style tones. */
  stopNow: () => void;
  readonly ctx: AudioContext;
  readonly output: GainNode;
};

export type ToneOptions = {
  frequency: number;
  waveform?: Waveform;
  /** Linear gain of this voice, 0..1. Master volume is applied on top. */
  gain?: number;
  /** Stereo position, -1 = left, 0 = centre, 1 = right. */
  pan?: number;
  /** Seconds - fade in / fade out to avoid clicks. */
  fadeIn?: number;
  fadeOut?: number;
  destination?: AudioNode;
  /** Register with the global voice list (default true). */
  track?: boolean;
};

export class ToneVoice implements VoiceBase {
  readonly ctx: AudioContext;
  readonly output: GainNode;
  readonly oscillator: OscillatorNode;
  private readonly panNode: StereoPannerNode;
  private readonly gain: number;
  private readonly fadeOut: number;
  private readonly tracked: boolean;
  private stopped = false;

  constructor(options: ToneOptions) {
    const ctx = options.destination ? getCtx() : getCtx();
    this.ctx = ctx;
    this.gain = options.gain ?? 1;
    this.fadeOut = options.fadeOut ?? 0.03;
    this.tracked = options.track !== false;

    this.output = ctx.createGain();
    this.output.gain.value = 0;

    this.panNode = ctx.createStereoPanner();
    this.panNode.pan.value = clamp(options.pan ?? 0, -1, 1);

    this.oscillator = ctx.createOscillator();
    this.oscillator.type = options.waveform ?? 'sine';
    this.oscillator.frequency.value = clamp(options.frequency, 0.001, 22050);

    this.oscillator.connect(this.output);
    this.output.connect(this.panNode);
    this.panNode.connect(options.destination ?? getInput());

    const now = ctx.currentTime;
    const fadeIn = Math.max(options.fadeIn ?? 0.012, MIN_RAMP);
    this.output.gain.setValueAtTime(0, now);
    this.output.gain.linearRampToValueAtTime(this.gain, now + fadeIn);
    this.oscillator.start(now);

    if (this.tracked) trackVoice(this);
  }

  /** Frequency in Hz. Short ramp avoids a click when sweeping by hand. */
  setFrequency(hz: number, ramp = 0.01): void {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    const value = clamp(hz, 0.001, this.ctx.sampleRate / 2 - 1);
    if (ramp <= 0) {
      this.oscillator.frequency.cancelScheduledValues(now);
      this.oscillator.frequency.setValueAtTime(value, now);
      return;
    }
    this.oscillator.frequency.cancelScheduledValues(now);
    this.oscillator.frequency.setTargetAtTime(value, now, ramp / 3);
  }

  setWaveform(waveform: Waveform): void {
    if (this.stopped) return;
    this.oscillator.type = waveform;
  }

  setGain(value: number, ramp = 0.02): void {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    const gain = clamp(value, 0, 1);
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setTargetAtTime(gain, now, ramp / 3);
  }

  setPan(value: number): void {
    if (this.stopped) return;
    this.panNode.pan.setTargetAtTime(clamp(value, -1, 1), this.ctx.currentTime, 0.01);
  }

  get frequency(): number {
    return this.oscillator.frequency.value;
  }

  get running(): boolean {
    return !this.stopped;
  }

  stop(): void {
    this.fadeOutAndStop(this.fadeOut);
  }

  stopNow(): void {
    this.fadeOutAndStop(MIN_RAMP);
  }

  private fadeOutAndStop(fade: number): void {
    if (this.stopped) return;
    this.stopped = true;
    const now = this.ctx.currentTime;
    const end = now + Math.max(fade, MIN_RAMP);
    try {
      this.output.gain.cancelScheduledValues(now);
      this.output.gain.setValueAtTime(this.output.gain.value, now);
      this.output.gain.linearRampToValueAtTime(0, end);
      this.oscillator.stop(end + 0.01);
    } catch {
      /* already stopped */
    }
    const cleanup = () => {
      try {
        this.oscillator.disconnect();
        this.output.disconnect();
        this.panNode.disconnect();
      } catch {
        /* ignore */
      }
      if (this.tracked) untrackVoice(this);
    };
    window.setTimeout(cleanup, Math.ceil((fade + 0.08) * 1000));
  }
}

export function createTone(options: ToneOptions): ToneVoice {
  return new ToneVoice(options);
}

/* ------------------------------------------------------------------ */
/* Noise                                                              */
/* ------------------------------------------------------------------ */

export type NoiseColor = 'white' | 'pink' | 'brown';

/**
 * Build a long, seamlessly looping noise buffer.
 * - white: flat spectrum
 * - pink:  -3 dB / octave (Paul Kellet's filter)
 * - brown: -6 dB / octave (leaky integration of white)
 */
export function createNoiseBuffer(ctx: BaseAudioContext, color: NoiseColor, seconds = 4): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);

  if (color === 'white') {
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  if (color === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    normalisePeak(data, 0.9);
    return buffer;
  }

  // Brown noise: leaky integration of white noise gives -6 dB / octave above the
  // corner frequency (~35 Hz at 44.1 kHz). The leak keeps DC and rumble from
  // running away, and peak normalisation keeps the level usable.
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.005 * white) / 1.005;
    data[i] = last;
  }
  normalisePeak(data, 0.9);
  return buffer;
}

/** Scale a buffer so its largest absolute sample equals `target`. */
function normalisePeak(data: Float32Array, target: number): void {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i]);
    if (abs > peak) peak = abs;
  }
  if (peak === 0) return;
  const scale = target / peak;
  for (let i = 0; i < data.length; i++) data[i] *= scale;
}

export type NoiseOptions = {
  color?: NoiseColor;
  gain?: number;
  /** Optional band shaping, in Hz. */
  lowpass?: number;
  highpass?: number;
  destination?: AudioNode;
};

export class NoiseVoice implements VoiceBase {
  readonly ctx: AudioContext;
  readonly output: GainNode;
  private readonly source: AudioBufferSourceNode;
  private readonly lowpassNode?: BiquadFilterNode;
  private readonly highpassNode?: BiquadFilterNode;
  private stopped = false;

  constructor(options: NoiseOptions = {}) {
    const ctx = getCtx();
    this.ctx = ctx;
    const gain = options.gain ?? 0.5;

    this.output = ctx.createGain();
    this.output.gain.value = 0;

    this.source = ctx.createBufferSource();
    this.source.buffer = createNoiseBuffer(ctx, options.color ?? 'white');
    this.source.loop = true;

    let node: AudioNode = this.source;
    if (options.highpass) {
      this.highpassNode = ctx.createBiquadFilter();
      this.highpassNode.type = 'highpass';
      this.highpassNode.frequency.value = options.highpass;
      this.highpassNode.Q.value = 0.7;
      node.connect(this.highpassNode);
      node = this.highpassNode;
    }
    if (options.lowpass) {
      this.lowpassNode = ctx.createBiquadFilter();
      this.lowpassNode.type = 'lowpass';
      this.lowpassNode.frequency.value = options.lowpass;
      this.lowpassNode.Q.value = 0.7;
      node.connect(this.lowpassNode);
      node = this.lowpassNode;
    }
    node.connect(this.output);
    this.output.connect(options.destination ?? getInput());

    const now = ctx.currentTime;
    this.output.gain.setValueAtTime(0, now);
    this.output.gain.linearRampToValueAtTime(gain, now + 0.05);
    this.source.start(now);
    trackVoice(this);
  }

  setGain(value: number, ramp = 0.05): void {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setTargetAtTime(clamp(value, 0, 1), now, ramp / 3);
  }

  setLowpass(hz: number): void {
    this.lowpassNode?.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.02);
  }

  setHighpass(hz: number): void {
    this.highpassNode?.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.02);
  }

  get running(): boolean {
    return !this.stopped;
  }

  stop(): void {
    this.stopped = true;
    const now = this.ctx.currentTime;
    try {
      this.output.gain.cancelScheduledValues(now);
      this.output.gain.setValueAtTime(this.output.gain.value, now);
      this.output.gain.linearRampToValueAtTime(0, now + 0.08);
      this.source.stop(now + 0.1);
    } catch {
      /* ignore */
    }
    window.setTimeout(() => {
      try {
        this.source.disconnect();
        this.output.disconnect();
        this.lowpassNode?.disconnect();
        this.highpassNode?.disconnect();
      } catch {
        /* ignore */
      }
      untrackVoice(this);
    }, 160);
  }

  stopNow(): void {
    this.stop();
  }
}

/* ------------------------------------------------------------------ */
/* Frequency sweep                                                     */
/* ------------------------------------------------------------------ */

export type SweepOptions = {
  startHz: number;
  endHz: number;
  duration: number;
  waveform?: Waveform;
  /** 'linear' or 'exp' - exponential sounds musically even across octaves. */
  ramp?: 'linear' | 'exp';
  /** Linear gains, 0..1. */
  startGain?: number;
  endGain?: number;
  /** Keep the final tone running when the sweep completes. */
  maintain?: boolean;
  destination?: AudioNode;
  onProgress?: (ratio: number, hz: number) => void;
  onEnd?: () => void;
};

export class SweepVoice implements VoiceBase {
  readonly ctx: AudioContext;
  readonly output: GainNode;
  private oscillators: OscillatorNode[];
  private raf = 0;
  private stopped = false;
  private readonly options: SweepOptions;
  private currentHz: number;

  constructor(options: SweepOptions) {
    const ctx = getCtx();
    this.ctx = ctx;
    this.options = options;
    this.currentHz = options.startHz;

    this.output = ctx.createGain();
    this.output.connect(options.destination ?? getInput());

    const now = ctx.currentTime + 0.03;
    const start = clamp(options.startHz, 1, ctx.sampleRate / 2 - 1);
    const end = clamp(options.endHz, 1, ctx.sampleRate / 2 - 1);
    const ramp = options.ramp ?? 'exp';
    const startGain = clamp(options.startGain ?? 0.4, 0, 1);
    const endGain = clamp(options.endGain ?? startGain, 0, 1);

    const osc = ctx.createOscillator();
    osc.type = options.waveform ?? 'sine';
    osc.frequency.setValueAtTime(start, now);
    if (ramp === 'exp') {
      osc.frequency.exponentialRampToValueAtTime(Math.max(end, 0.01), now + options.duration);
    } else {
      osc.frequency.linearRampToValueAtTime(end, now + options.duration);
    }

    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(0, now);
    voiceGain.gain.linearRampToValueAtTime(startGain, now + 0.02);
    voiceGain.gain.linearRampToValueAtTime(endGain, now + options.duration);

    osc.connect(voiceGain).connect(this.output);
    osc.start(now);
    this.oscillators = [osc];

    // Progress reporting for the UI readout.
    const startedAt = performance.now();
    const tick = () => {
      if (this.stopped) return;
      const elapsed = (performance.now() - startedAt) / 1000;
      const ratio = clamp(elapsed / options.duration, 0, 1);
      const hz = ramp === 'exp' ? start * Math.pow(end / start, ratio) : start + (end - start) * ratio;
      this.currentHz = hz;
      options.onProgress?.(ratio, hz);
      if (ratio >= 1) {
        if (!options.maintain) this.stop();
        options.onEnd?.();
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);

    trackVoice(this);
  }

  get frequency(): number {
    return this.currentHz;
  }

  get running(): boolean {
    return !this.stopped;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    const now = this.ctx.currentTime;
    try {
      this.output.gain.cancelScheduledValues(now);
      this.output.gain.setValueAtTime(this.output.gain.value, now);
      this.output.gain.linearRampToValueAtTime(0, now + 0.04);
      for (const osc of this.oscillators) osc.stop(now + 0.06);
    } catch {
      /* ignore */
    }
    window.setTimeout(() => {
      try {
        for (const osc of this.oscillators) osc.disconnect();
        this.output.disconnect();
      } catch {
        /* ignore */
      }
      untrackVoice(this);
    }, 120);
  }

  stopNow(): void {
    this.stop();
  }
}

/* ------------------------------------------------------------------ */
/* Transient helpers                                                   */
/* ------------------------------------------------------------------ */

export type ClickOptions = {
  frequency?: number;
  duration?: number;
  gain?: number;
  waveform?: Waveform;
  when?: number;
  destination?: AudioNode;
};

/** One-shot percussive blip (metronome clicks, pips, keypad feedback). */
export function playClick(options: ClickOptions = {}): void {
  const ctx = getCtx();
  const when = options.when ?? ctx.currentTime;
  const duration = options.duration ?? 0.05;
  const gain = options.gain ?? 0.5;

  const osc = ctx.createOscillator();
  osc.type = options.waveform ?? 'sine';
  osc.frequency.setValueAtTime(options.frequency ?? 1000, when);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(gain, when + 0.002);
  env.gain.exponentialRampToValueAtTime(0.0001, when + duration);

  osc.connect(env).connect(options.destination ?? getInput());
  osc.start(when);
  osc.stop(when + duration + 0.02);

  // Clicks are often scheduled ahead of time (metronome, pips, alarm patterns).
  // Register them so the global "Stop all" can cancel a pip that has not sounded
  // yet - otherwise the sequence keeps firing after the user asked for silence.
  const handle = {
    stop: () => {
      const now = ctx.currentTime;
      try {
        env.gain.cancelScheduledValues(now);
        env.gain.setValueAtTime(0, now);
      } catch {
        /* node already finished */
      }
      window.setTimeout(() => {
        try {
          osc.stop();
        } catch {
          /* already stopped */
        }
        osc.disconnect();
        env.disconnect();
      }, 30);
      untrackVoice(handle);
    },
  };
  trackVoice(handle);

  osc.onended = () => {
    osc.disconnect();
    env.disconnect();
    untrackVoice(handle);
  };
}

/** Two simultaneous sine tones - DTMF digits and telephony signalling. */
export function playDualTone(
  freqA: number,
  freqB: number | null,
  duration = 0.12,
  gain = 0.35,
  destination?: AudioNode,
): () => void {
  const ctx = getCtx();
  const now = ctx.currentTime;
  const nodes: OscillatorNode[] = [];
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(gain, now + 0.005);
  env.connect(destination ?? getInput());

  for (const hz of freqB == null ? [freqA] : [freqA, freqB]) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = hz;
    osc.connect(env);
    osc.start(now);
    nodes.push(osc);
  }

  const stop = () => {
    const t = ctx.currentTime;
    try {
      env.gain.cancelScheduledValues(t);
      env.gain.setValueAtTime(env.gain.value, t);
      env.gain.linearRampToValueAtTime(0, t + 0.01);
      for (const osc of nodes) osc.stop(t + 0.02);
    } catch {
      /* ignore */
    }
    window.setTimeout(() => {
      for (const osc of nodes) osc.disconnect();
      env.disconnect();
    }, 60);
  };

  if (duration > 0) window.setTimeout(stop, duration * 1000);
  return stop;
}
