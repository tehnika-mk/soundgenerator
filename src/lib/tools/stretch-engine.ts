/**
 * stretch-engine.ts - the shared pitch / time engine.
 * ===================================================
 *
 * One TypeScript surface over the WSOLA AudioWorklet
 * (`public/worklets/wsola-processor.js`). Both the Pitch Shifter and the Time
 * Stretcher pages use exactly this module, so the two tools are the same DSP
 * with different numbers in front of it.
 *
 * Ratios
 * ------
 *   pitchRatio  1 = unchanged, 2 = +12 semitones (one octave up), 0.5 = one
 *               octave down. Allowed range 0.25 … 4.
 *   tempoRatio  1 = original speed, 2 = twice as fast (half the length),
 *               0.5 = half speed (twice the length). Range 0.25 … 4.
 *
 * The two are independent. The rendered output length is always
 *
 *     outputSeconds = sourceSeconds / tempoRatio
 *
 * so a pitch shift on its own (tempoRatio = 1) preserves the duration, and a
 * tempo change on its own (pitchRatio = 1) preserves the pitch. Setting
 * tempoRatio = pitchRatio reproduces a plain resample / playback-rate change
 * (both pitch and length move together) - which is how the "let the length
 * change too" and "plain playback rate" modes are implemented.
 *
 * API (everything the two pages call)
 * -----------------------------------
 *   loadAudioFile(file)                                  -> LoadedAudio
 *   createStretchPlayer({ buffer, pitchRatio, tempoRatio }) -> Promise<StretchPlayer>
 *   renderStretched({ buffer, pitchRatio, tempoRatio, onProgress }) -> Promise<AudioBuffer>
 *   createWaveformView(canvas, options)                  -> WaveformView
 *   pitchRatioFromSemitones(semitones, cents)            -> number
 *
 * The worklet echo of the algorithm: read the source resampled by pitchRatio,
 * overlap-add it back with a Hann window at a fixed synthesis hop, choosing
 * each frame's read position by cross-correlating against the previous frame
 * (WSOLA), so the output length is sourceLength / tempoRatio.
 */

import { ensureContext, getInput, trackVoice } from '../audio/engine';
import { clamp } from '../ui/dom';

export const WORKLET_URL = '/worklets/wsola-processor.js';
export const PITCH_MIN = 0.25;
export const PITCH_MAX = 4;
export const TEMPO_MIN = 0.25;
export const TEMPO_MAX = 4;

export type StretchRatios = {
  pitchRatio: number;
  tempoRatio: number;
};

export type LoadedAudio = {
  file: File;
  name: string;
  buffer: AudioBuffer;
  /** Length of the source in seconds. */
  duration: number;
  sampleRate: number;
  channels: number;
};

export type ProgressInfo = {
  /** Position in the source file, seconds. */
  position: number;
  duration: number;
  /** Fraction of the source consumed, 0…1. */
  ratio: number;
  /** Position in the output timeline, seconds. */
  outputPosition: number;
  /** Expected output length, seconds. */
  outputDuration: number;
};

/* ------------------------------------------------------------------ */
/* Worklet module loading                                              */
/* ------------------------------------------------------------------ */

// addModule() rejects if called twice for the same URL on the same context, so
// cache one promise per context.
const moduleLoads = new WeakMap<BaseAudioContext, Promise<void>>();

function ensureWorklet(ctx: BaseAudioContext): Promise<void> {
  let pending = moduleLoads.get(ctx);
  if (!pending) {
    pending = ctx.audioWorklet.addModule(WORKLET_URL);
    moduleLoads.set(ctx, pending);
  }
  return pending;
}

function offlineCtor(): typeof OfflineAudioContext {
  const ctor =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!ctor) throw new Error('OfflineAudioContext is not supported in this browser.');
  return ctor;
}

/** Copy a decoded buffer's channels into fresh arrays (transferable to the worklet). */
function channelCopies(buffer: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(new Float32Array(buffer.getChannelData(c)));
  }
  return channels;
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Decode an audio file in the browser. Nothing is uploaded - `decodeAudioData`
 * runs on the shared AudioContext, which must already exist (i.e. this is
 * called from a user gesture such as choosing a file or dropping one).
 */
export async function loadAudioFile(file: File): Promise<LoadedAudio> {
  const ctx = ensureContext();
  const bytes = await file.arrayBuffer();
  const buffer = await ctx.decodeAudioData(bytes);
  return {
    file,
    name: file.name || 'audio',
    buffer,
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
  };
}

/* ------------------------------------------------------------------ */
/* Streaming player (preview while playing)                            */
/* ------------------------------------------------------------------ */

export type StretchPlayer = {
  readonly node: AudioWorkletNode;
  readonly isPlaying: boolean;
  /** Position in the source file, seconds. */
  readonly position: number;
  /** Source length, seconds. */
  readonly duration: number;
  /** Expected output length at the current tempo, seconds. */
  readonly outputDuration: number;
  readonly pitchRatio: number;
  readonly tempoRatio: number;
  play(): void;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  setPitchRatio(ratio: number): void;
  setTempoRatio(ratio: number): void;
  /** Loop a section of the source; pass (0, 0) to disable looping. */
  setLoop(startSeconds: number, endSeconds: number): void;
  onProgress?: (info: ProgressInfo) => void;
  onEnded?: () => void;
  onStop?: () => void;
  dispose(): void;
};

class StretchPlayerImpl implements StretchPlayer {
  readonly node: AudioWorkletNode;
  private readonly ctx: AudioContext;
  private readonly untrack: { stop: () => void };
  private readonly sourceDuration: number;
  private _pitchRatio: number;
  private _tempoRatio: number;
  private _position = 0;
  private _playing = false;

  onProgress?: (info: ProgressInfo) => void;
  onEnded?: () => void;
  onStop?: () => void;

  constructor(ctx: AudioContext, node: AudioWorkletNode, buffer: AudioBuffer, ratios: StretchRatios) {
    this.ctx = ctx;
    this.node = node;
    this.sourceDuration = buffer.length / buffer.sampleRate;
    this._pitchRatio = clamp(ratios.pitchRatio, PITCH_MIN, PITCH_MAX);
    this._tempoRatio = clamp(ratios.tempoRatio, TEMPO_MIN, TEMPO_MAX);

    node.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } & Partial<ProgressInfo>;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'progress') {
        this._position = data.position ?? 0;
        this.onProgress?.({
          position: this._position,
          duration: data.duration ?? this.sourceDuration,
          ratio: data.ratio ?? 0,
          outputPosition: data.outputPosition ?? 0,
          outputDuration: data.outputDuration ?? this.sourceDuration / this._tempoRatio,
        });
      } else if (data.type === 'ended') {
        this._playing = false;
        this._position = this.sourceDuration;
        this.onEnded?.();
      }
    };

    node.connect(getInput());
    // Register with the engine so the global "Stop all" button silences us.
    this.untrack = trackVoice({ stop: () => this.stop() });
  }

  get isPlaying(): boolean {
    return this._playing;
  }

  get position(): number {
    return this._position;
  }

  get duration(): number {
    return this.sourceDuration;
  }

  get outputDuration(): number {
    return this.sourceDuration / this._tempoRatio;
  }

  get pitchRatio(): number {
    return this._pitchRatio;
  }

  get tempoRatio(): number {
    return this._tempoRatio;
  }

  play(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this._playing = true;
    this.node.port.postMessage({ type: 'play' });
  }

  pause(): void {
    this._playing = false;
    this.node.port.postMessage({ type: 'pause' });
  }

  stop(): void {
    this._playing = false;
    this._position = 0;
    this.node.port.postMessage({ type: 'stop' });
    this.onStop?.();
  }

  seek(seconds: number): void {
    this._position = clamp(seconds, 0, this.sourceDuration);
    this.node.port.postMessage({ type: 'seek', position: this._position });
  }

  setPitchRatio(ratio: number): void {
    this._pitchRatio = clamp(ratio, PITCH_MIN, PITCH_MAX);
    this.node.parameters.get('pitchRatio')?.setValueAtTime(this._pitchRatio, this.ctx.currentTime);
  }

  setTempoRatio(ratio: number): void {
    this._tempoRatio = clamp(ratio, TEMPO_MIN, TEMPO_MAX);
    this.node.parameters.get('tempoRatio')?.setValueAtTime(this._tempoRatio, this.ctx.currentTime);
  }

  setLoop(startSeconds: number, endSeconds: number): void {
    this.node.port.postMessage({ type: 'loop', start: startSeconds, end: endSeconds });
  }

  dispose(): void {
    this.stop();
    try {
      this.node.disconnect();
      this.node.port.onmessage = null;
    } catch {
      /* already gone */
    }
    this.untrack.stop();
  }
}

export type CreatePlayerOptions = StretchRatios & {
  buffer: AudioBuffer;
  loop?: { start: number; end: number };
};

/**
 * Create a streaming player: a source that runs through the WSOLA worklet with
 * independent pitchRatio / tempoRatio AudioParams. Await this (the worklet
 * module has to be fetched) - it returns a controller with transport methods.
 */
export async function createStretchPlayer(options: CreatePlayerOptions): Promise<StretchPlayer> {
  const ctx = ensureContext();
  await ensureWorklet(ctx);
  // Do not await resume(): if playback is blocked by the autoplay policy the
  // promise stays pending until the user gestures, which would hang player
  // creation. The node is usable while the context is suspended; play() kicks
  // the resume again from the click handler.
  if (ctx.state === 'suspended') void ctx.resume();

  const channels = options.buffer.numberOfChannels;
  const loopSamples = options.loop
    ? {
        loopStart: Math.max(0, Math.round(options.loop.start * options.buffer.sampleRate)),
        loopEnd: Math.max(0, Math.round(options.loop.end * options.buffer.sampleRate)),
      }
    : {};
  const copies = channelCopies(options.buffer);
  const node = new AudioWorkletNode(ctx, 'wsola-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
    parameterData: {
      pitchRatio: clamp(options.pitchRatio ?? 1, PITCH_MIN, PITCH_MAX),
      tempoRatio: clamp(options.tempoRatio ?? 1, TEMPO_MIN, TEMPO_MAX),
    },
    // The decoded audio travels through processorOptions so it is available in
    // the processor constructor, before the first render quantum.
    processorOptions: {
      channels: copies,
      sampleRate: options.buffer.sampleRate,
      inputLength: options.buffer.length,
      pitchRatio: options.pitchRatio ?? 1,
      tempoRatio: options.tempoRatio ?? 1,
      play: false,
      ...loopSamples,
    },
  });

  const player = new StretchPlayerImpl(ctx, node, options.buffer, {
    pitchRatio: options.pitchRatio ?? 1,
    tempoRatio: options.tempoRatio ?? 1,
  });

  if (options.loop) player.setLoop(options.loop.start, options.loop.end);
  return player;
}

/* ------------------------------------------------------------------ */
/* Offline render (export)                                             */
/* ------------------------------------------------------------------ */

export type RenderOptions = StretchRatios & {
  buffer: AudioBuffer;
  onProgress?: (ratio: number) => void;
};

/**
 * Render the stretched / shifted result offline with OfflineAudioContext +
 * the same worklet. This is what the Export button saves, so the file is
 * computed, not faked - the same algorithm that previews it.
 */
export async function renderStretched(options: RenderOptions): Promise<AudioBuffer> {
  const { buffer } = options;
  const pitchRatio = clamp(options.pitchRatio ?? 1, PITCH_MIN, PITCH_MAX);
  const tempoRatio = clamp(options.tempoRatio ?? 1, TEMPO_MIN, TEMPO_MAX);
  const sampleRate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const outFrames = Math.max(1, Math.round(buffer.length / tempoRatio));
  const tail = Math.round(0.05 * sampleRate);

  const Ctor = offlineCtor();
  const ctx = new Ctor(channels, outFrames + tail, sampleRate);
  await ensureWorklet(ctx);

  const copies = channelCopies(buffer);
  const node = new AudioWorkletNode(ctx, 'wsola-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
    parameterData: { pitchRatio, tempoRatio },
    // Passed to the processor constructor: a port message would only arrive
    // after an OfflineAudioContext has finished rendering.
    processorOptions: {
      channels: copies,
      sampleRate,
      inputLength: buffer.length,
      pitchRatio,
      tempoRatio,
      play: true,
    },
  });

  if (options.onProgress) {
    node.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; ratio?: number };
      if (data?.type === 'progress') options.onProgress?.(clamp(data.ratio ?? 0, 0, 1));
    };
  }

  node.connect(ctx.destination);

  const rendered = await ctx.startRendering();

  // Trim the render tail back to the mathematically expected length.
  const out = new AudioBuffer({ length: outFrames, numberOfChannels: channels, sampleRate });
  for (let c = 0; c < channels; c++) {
    const src = rendered.getChannelData(c);
    const dst = out.getChannelData(c);
    dst.set(src.subarray(0, Math.min(outFrames, src.length)));
  }
  options.onProgress?.(1);
  return out;
}

/* ------------------------------------------------------------------ */
/* Ratio helpers                                                       */
/* ------------------------------------------------------------------ */

/** Convert a semitone offset (and optional cents) to a frequency ratio. */
export function pitchRatioFromSemitones(semitones: number, cents = 0): number {
  return Math.pow(2, semitones / 12 + cents / 1200);
}

/** Format a duration as mm:ss.d for readouts. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ' - ';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds % 1) * 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}

/** Format a duration as m:ss for compact preset labels. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ' - ';
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Waveform view (static peak envelope + playhead + optional loop)     */
/* ------------------------------------------------------------------ */

export type WaveformView = {
  /** Attach (or clear) the decoded buffer this view draws. */
  setBuffer(buffer: AudioBuffer | null): void;
  draw(): void;
  setPlayhead(seconds: number | null): void;
  setLoop(start: number | null, end: number | null): void;
  readonly loopStart: number;
  readonly loopEnd: number;
  destroy(): void;
};

export type WaveformViewOptions = {
  /** Click / drag on the body seeks to that time. */
  onSeek?: (seconds: number) => void;
  /** Enable draggable loop start / end handles. */
  loop?: boolean;
  onLoopChange?: (start: number, end: number) => void;
};

/**
 * A static peak-envelope overview of a decoded file plus a playhead (and, on
 * the Time Stretcher, draggable loop handles). It is deliberately *not* the
 * live analyser scope: a file waveform is computed once and redrawn only when
 * the playhead or loop changes.
 */
export function createWaveformView(canvas: HTMLCanvasElement, options: WaveformViewOptions = {}): WaveformView {
  const ctx2d = canvas.getContext('2d');
  let buffer: AudioBuffer | null = null;
  let peaks: Float32Array | null = null;
  let playhead: number | null = null;
  let loopStart = 0;
  let loopEnd = 0;
  let dragMode: 'seek' | 'loop-start' | 'loop-end' | null = null;

  const SIGNAL = '#12d8a0';
  const GRID = 'rgba(255,255,255,0.05)';

  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

  const resize = (): { w: number; h: number } => {
    const scale = dpr();
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * scale));
    const h = Math.max(1, Math.floor(rect.height * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w, h };
  };

  const computePeaks = (columns: number): void => {
    if (!buffer) return;
    const data = buffer.getChannelData(0);
    const out = new Float32Array(columns);
    const step = data.length / columns;
    for (let x = 0; x < columns; x++) {
      const start = Math.floor(x * step);
      const end = Math.min(data.length, Math.max(start + 1, Math.floor((x + 1) * step)));
      let peak = 0;
      for (let i = start; i < end; i++) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
      }
      out[x] = peak;
    }
    peaks = out;
  };

  const draw = (): void => {
    if (!ctx2d) return;
    const { w, h } = resize();
    const scale = dpr();
    ctx2d.setTransform(scale, 0, 0, scale, 0, 0);
    const cssW = w / scale;
    const cssH = h / scale;
    ctx2d.clearRect(0, 0, cssW, cssH);

    // Grid.
    ctx2d.strokeStyle = GRID;
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    for (let i = 1; i < 8; i++) {
      const x = Math.round((cssW / 8) * i) + 0.5;
      ctx2d.moveTo(x, 0);
      ctx2d.lineTo(x, cssH);
    }
    ctx2d.moveTo(0, Math.round(cssH / 2) + 0.5);
    ctx2d.lineTo(cssW, Math.round(cssH / 2) + 0.5);
    ctx2d.stroke();

    if (!buffer) {
      ctx2d.fillStyle = 'rgba(168,176,186,0.5)';
      ctx2d.font = '11px ui-monospace, monospace';
      ctx2d.fillText('Load an audio file to see its waveform', 10, cssH / 2 - 6);
      return;
    }

    const columns = Math.max(1, Math.floor(cssW));
    if (!peaks || peaks.length !== columns) computePeaks(columns);
    const mid = cssH / 2;
    const amp = mid - 3;

    // Loop region tint.
    if (options.loop && loopEnd > loopStart) {
      const x0 = (loopStart / buffer.duration) * cssW;
      const x1 = (loopEnd / buffer.duration) * cssW;
      ctx2d.fillStyle = 'rgba(18,216,160,0.07)';
      ctx2d.fillRect(x0, 0, x1 - x0, cssH);
    }

    ctx2d.strokeStyle = SIGNAL;
    ctx2d.globalAlpha = 0.9;
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    for (let x = 0; x < columns; x++) {
      const peak = peaks ? peaks[x] : 0;
      const top = mid - peak * amp;
      const bottom = mid + peak * amp;
      ctx2d.moveTo(x + 0.5, top);
      ctx2d.lineTo(x + 0.5, bottom);
    }
    ctx2d.stroke();
    ctx2d.globalAlpha = 1;

    // Loop handles.
    if (options.loop && loopEnd > loopStart) {
      const drawHandle = (seconds: number) => {
        const x = Math.round((seconds / buffer!.duration) * cssW) + 0.5;
        ctx2d.strokeStyle = SIGNAL;
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.moveTo(x, 0);
        ctx2d.lineTo(x, cssH);
        ctx2d.stroke();
      };
      drawHandle(loopStart);
      drawHandle(loopEnd);
    }

    // Playhead.
    if (playhead != null) {
      const x = Math.round((playhead / buffer.duration) * cssW) + 0.5;
      ctx2d.strokeStyle = '#e8ebef';
      ctx2d.lineWidth = 1.5;
      ctx2d.beginPath();
      ctx2d.moveTo(x, 0);
      ctx2d.lineTo(x, cssH);
      ctx2d.stroke();
    }
  };

  const timeAt = (event: PointerEvent): number => {
    const rect = canvas.getBoundingClientRect();
    const t = (event.clientX - rect.left) / rect.width;
    return clamp(t, 0, 1) * (buffer?.duration ?? 0);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (!buffer) return;
    const t = timeAt(event);
    if (options.loop && loopEnd > loopStart) {
      const span = buffer.duration;
      const nearStart = Math.abs(t - loopStart) < span * 0.03;
      const nearEnd = Math.abs(t - loopEnd) < span * 0.03;
      if (nearStart) dragMode = 'loop-start';
      else if (nearEnd) dragMode = 'loop-end';
      else dragMode = 'seek';
    } else {
      dragMode = 'seek';
    }
    canvas.setPointerCapture(event.pointerId);
    handleDrag(event);
  };

  const handleDrag = (event: PointerEvent): void => {
    if (!buffer || !dragMode) return;
    const t = timeAt(event);
    if (dragMode === 'seek') {
      options.onSeek?.(t);
    } else if (dragMode === 'loop-start') {
      loopStart = Math.min(t, loopEnd - buffer.duration * 0.01);
      options.onLoopChange?.(loopStart, loopEnd);
      draw();
    } else if (dragMode === 'loop-end') {
      loopEnd = Math.max(t, loopStart + buffer.duration * 0.01);
      options.onLoopChange?.(loopStart, loopEnd);
      draw();
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (dragMode) handleDrag(event);
  };

  const onPointerUp = (): void => {
    dragMode = null;
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => draw()) : null;
  resizeObserver?.observe(canvas);

  return {
    setBuffer(next: AudioBuffer | null) {
      buffer = next;
      peaks = null;
      playhead = null;
      draw();
    },
    draw,
    setPlayhead(seconds: number | null) {
      playhead = seconds;
      draw();
    },
    setLoop(start: number | null, end: number | null) {
      loopStart = start ?? 0;
      loopEnd = end ?? 0;
      draw();
    },
    get loopStart() {
      return loopStart;
    },
    get loopEnd() {
      return loopEnd;
    },
    destroy() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      resizeObserver?.disconnect();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Test hook                                                           */
/* ------------------------------------------------------------------ */

// Exposed so an automated browser check can drive the real engine (and the
// real worklet) without a page-specific API.
if (typeof window !== 'undefined') {
  (window as unknown as { __sgStretch?: unknown }).__sgStretch = {
    WORKLET_URL,
    loadAudioFile,
    createStretchPlayer,
    renderStretched,
    pitchRatioFromSemitones,
  };
}
