/**
 * Offline rendering + WAV export.
 *
 * The original site asked a PHP endpoint to generate 10-second WAV files.
 * Everything here is generated in the browser instead: an OfflineAudioContext
 * renders the exact signal into a buffer, the buffer is encoded to 16-bit PCM
 * WAV, and the result is handed to the user as a download. No server, works
 * offline, and the export sounds identical to the live preview.
 */

import { clamp, type Waveform } from './engine';
import { createNoiseBuffer, type NoiseColor } from './voices';

export const WAV_SAMPLE_RATE = 44100;

export type OfflineBuild = (ctx: OfflineAudioContext, destination: AudioNode) => void;

/** Render any signal graph offline and return the mono/stereo PCM. */
export async function renderOffline(
  seconds: number,
  build: OfflineBuild,
  options: { sampleRate?: number; channels?: number; tail?: number } = {},
): Promise<AudioBuffer> {
  const sampleRate = options.sampleRate ?? WAV_SAMPLE_RATE;
  const channels = options.channels ?? 1;
  const tail = options.tail ?? 0.05;
  const frames = Math.max(1, Math.ceil((seconds + tail) * sampleRate));
  const OfflineCtor: typeof OfflineAudioContext =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new OfflineCtor(channels, frames, sampleRate);
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);
  build(ctx, master);
  return ctx.startRendering();
}

export type ToneRenderOptions = {
  frequency: number;
  seconds?: number;
  waveform?: Waveform;
  /** Linear peak amplitude of the file, 0..1. */
  gain?: number;
  sampleRate?: number;
  /** Fade applied at both ends, in seconds, so the file starts and ends on zero. */
  fade?: number;
};

/** Render a steady tone. Deterministic: same input always gives the same file. */
export async function renderTone(options: ToneRenderOptions): Promise<AudioBuffer> {
  const seconds = options.seconds ?? 10;
  const gain = clamp(options.gain ?? 0.5, 0, 1);
  const fade = options.fade ?? 0.01;
  return renderOffline(
    seconds,
    (ctx, destination) => {
      const osc = ctx.createOscillator();
      osc.type = options.waveform ?? 'sine';
      osc.frequency.value = clamp(options.frequency, 0.01, (options.sampleRate ?? WAV_SAMPLE_RATE) / 2 - 1);

      const env = ctx.createGain();
      env.gain.setValueAtTime(0, 0);
      env.gain.linearRampToValueAtTime(gain, fade);
      env.gain.setValueAtTime(gain, Math.max(seconds - fade, fade));
      env.gain.linearRampToValueAtTime(0, seconds);

      osc.connect(env).connect(destination);
      osc.start(0);
      osc.stop(seconds + 0.01);
    },
    { sampleRate: options.sampleRate, channels: 1 },
  );
}

export type NoiseRenderOptions = {
  color?: NoiseColor;
  seconds?: number;
  gain?: number;
  sampleRate?: number;
  lowpass?: number;
  highpass?: number;
};

export async function renderNoise(options: NoiseRenderOptions = {}): Promise<AudioBuffer> {
  const seconds = options.seconds ?? 10;
  const gain = clamp(options.gain ?? 0.4, 0, 1);
  return renderOffline(
    seconds,
    (ctx, destination) => {
      const source = ctx.createBufferSource();
      source.buffer = createNoiseBuffer(ctx, options.color ?? 'white', Math.max(seconds, 2));
      source.loop = true;

      let node: AudioNode = source;
      if (options.highpass) {
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = options.highpass;
        node.connect(hp);
        node = hp;
      }
      if (options.lowpass) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = options.lowpass;
        node.connect(lp);
        node = lp;
      }

      const env = ctx.createGain();
      env.gain.setValueAtTime(0, 0);
      env.gain.linearRampToValueAtTime(gain, 0.05);
      env.gain.setValueAtTime(gain, Math.max(seconds - 0.05, 0.05));
      env.gain.linearRampToValueAtTime(0, seconds);

      node.connect(env).connect(destination);
      source.start(0);
      source.stop(seconds + 0.01);
    },
    { sampleRate: options.sampleRate, channels: 1 },
  );
}

export type SweepRenderOptions = {
  startHz: number;
  endHz: number;
  seconds: number;
  waveform?: Waveform;
  ramp?: 'linear' | 'exp';
  startGain?: number;
  endGain?: number;
  sampleRate?: number;
};

export async function renderSweep(options: SweepRenderOptions): Promise<AudioBuffer> {
  const seconds = options.seconds;
  const startGain = clamp(options.startGain ?? 0.4, 0, 1);
  const endGain = clamp(options.endGain ?? startGain, 0, 1);
  const ramp = options.ramp ?? 'exp';
  return renderOffline(
    seconds,
    (ctx, destination) => {
      const osc = ctx.createOscillator();
      osc.type = options.waveform ?? 'sine';
      osc.frequency.setValueAtTime(Math.max(options.startHz, 0.01), 0);
      if (ramp === 'exp') {
        osc.frequency.exponentialRampToValueAtTime(Math.max(options.endHz, 0.01), seconds);
      } else {
        osc.frequency.linearRampToValueAtTime(options.endHz, seconds);
      }

      const env = ctx.createGain();
      env.gain.setValueAtTime(0, 0);
      env.gain.linearRampToValueAtTime(startGain, 0.02);
      env.gain.linearRampToValueAtTime(endGain, seconds);

      osc.connect(env).connect(destination);
      osc.start(0);
      osc.stop(seconds + 0.01);
    },
    { sampleRate: options.sampleRate, channels: 1 },
  );
}

/* ------------------------------------------------------------------ */
/* WAV encoding                                                        */
/* ------------------------------------------------------------------ */

/** Encode an AudioBuffer as a 16-bit PCM WAV blob. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = clamp(channelData[c][i], -1, 1);
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  return encodeWav(buffer);
}

/** Trigger a browser download for a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the download a moment to start before releasing the object URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function wavFilename(descriptor: string): string {
  const safe = descriptor
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${safe || 'tone'}.wav`;
}

/** Render a steady tone and hand it to the user as a .wav download. */
export async function exportTone(options: ToneRenderOptions & { name?: string }): Promise<Blob> {
  const buffer = await renderTone(options);
  const blob = encodeWav(buffer);
  const name = options.name ?? `${Math.round(options.frequency)}hz-${options.waveform ?? 'sine'}`;
  downloadBlob(blob, wavFilename(name));
  return blob;
}

/** Peak amplitude of a rendered buffer - used by the automated DSP checks. */
export function bufferPeak(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  return peak;
}

export function bufferRms(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}

/** Count zero crossings in a slice - a cheap frequency estimate for tests. */
export function countZeroCrossings(buffer: AudioBuffer, fromSeconds = 0.1, toSeconds = 0.9): number {
  const data = buffer.getChannelData(0);
  const from = Math.floor(fromSeconds * buffer.sampleRate);
  const to = Math.min(Math.floor(toSeconds * buffer.sampleRate), data.length);
  let crossings = 0;
  for (let i = from + 1; i < to; i++) {
    if ((data[i - 1] < 0 && data[i] >= 0) || (data[i - 1] > 0 && data[i] <= 0)) crossings++;
  }
  return crossings;
}

/** Estimated fundamental frequency of a rendered buffer, in Hz. */
export function estimateFrequency(buffer: AudioBuffer, fromSeconds = 0.1, toSeconds = 0.9): number {
  const crossings = countZeroCrossings(buffer, fromSeconds, toSeconds);
  const window = toSeconds - fromSeconds;
  if (window <= 0) return 0;
  return crossings / 2 / window;
}
