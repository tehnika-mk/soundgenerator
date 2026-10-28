/**
 * The tone-generator panel controller.
 *
 * One implementation powers the home page generator, the 432 Hz page, the
 * subwoofer test rig, the hearing test and any other page that needs "set a
 * frequency, press play".
 *
 * DOM contract - drop these attributes anywhere inside the root element:
 *
 *   data-tone-generator                 wrapper (optional; defaults to <body>)
 *   [data-tg="freq"]                    frequency input (text or number)
 *   [data-tg="note"] / [data-tg="cents"]musical readout
 *   [data-tg="play"] [data-tg="stop"]   transport
 *   [data-tg="export"]                  render + download a WAV
 *   [data-tg="export-seconds"]          select/number controlling clip length
 *   [data-tg="waveform"][data-value=…]  waveform buttons (aria-pressed managed)
 *   [data-tg="status"]                  status line
 *   [data-tg="preset"][data-freq=…]     frequency preset buttons
 *   [data-tg="key"][data-freq=…]        momentary piano keys
 *   [data-tg="share"]                   copy a shareable link
 *   canvas[data-scope="wave|spectrum"]  live analysis displays
 */

import {
  FREQ_MAX,
  FREQ_MIN,
  describeFrequency,
  centsLabel,
  formatHz,
  isValidFrequency,
  roundTo,
} from '../audio/notes';
import {
  ensureContext,
  getSampleRate,
  type Waveform,
} from '../audio/engine';
import { ToneVoice } from '../audio/voices';
import { exportTone, encodeWav, renderTone, downloadBlob, wavFilename } from '../audio/wav';
import { mountScopes, type ScopeHandle } from '../audio/scope';
import {
  announce,
  clamp,
  on,
  queryNumber,
  queryString,
  setActive,
  setPressed,
  setQueryParam,
  setStatus,
  setText,
  slot,
  slots,
  copyText,
} from './dom';

export type ToneGeneratorOptions = {
  root?: HTMLElement;
  defaultFrequency?: number;
  minFrequency?: number;
  maxFrequency?: number;
  /** Reference pitch used by the note readout (440 / 432 / …). */
  a4?: number;
  /** Read ?freq= and ?waveform= on load and keep the URL in sync. */
  urlSync?: boolean;
  /** Clip length produced by the Save button, in seconds. */
  exportSeconds?: number;
  defaultWaveform?: Waveform;
  onFrequencyChange?: (hz: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
};

export type ToneGeneratorController = {
  start: (hz?: number) => void;
  stop: () => void;
  toggle: () => void;
  setFrequency: (hz: number) => void;
  getFrequency: () => number;
  setWaveform: (waveform: Waveform) => void;
  setExportSeconds: (seconds: number) => void;
  isPlaying: () => boolean;
  destroy: () => void;
};

const VALID_WAVEFORMS: Waveform[] = ['sine', 'square', 'sawtooth', 'triangle'];

/** One reusable voice - keeps "play/stop/play" from leaking oscillators. */
export class VoicePlayer {
  private voice: ToneVoice | null = null;
  private waveform: Waveform;

  constructor(waveform: Waveform = 'sine') {
    this.waveform = waveform;
  }

  get playing(): boolean {
    return this.voice !== null && this.voice.running;
  }

  get frequency(): number {
    return this.voice?.frequency ?? 0;
  }

  get wave(): Waveform {
    return this.waveform;
  }

  play(hz: number, waveform?: Waveform): void {
    ensureContext();
    if (waveform) this.waveform = waveform;
    if (this.voice && this.voice.running) {
      this.voice.setWaveform(this.waveform);
      this.voice.setFrequency(hz);
      return;
    }
    this.voice = new ToneVoice({ frequency: hz, waveform: this.waveform, gain: 1 });
  }

  setFrequency(hz: number): void {
    if (this.voice?.running) this.voice.setFrequency(hz);
  }

  setWaveform(waveform: Waveform): void {
    this.waveform = waveform;
    if (this.voice?.running) this.voice.setWaveform(waveform);
  }

  stop(): void {
    this.voice?.stop();
    this.voice = null;
  }
}

function readFrequencyInput(input: HTMLInputElement | null, fallback: number): number {
  if (!input) return fallback;
  const raw = input.value.trim().replace(',', '.');
  const value = Number(raw);
  return Number.isFinite(value) ? value : NaN;
}

export function initToneGenerator(options: ToneGeneratorOptions = {}): ToneGeneratorController {
  const root = options.root ?? document.body;
  const min = options.minFrequency ?? FREQ_MIN;
  const max = options.maxFrequency ?? FREQ_MAX;
  const a4 = options.a4 ?? 440;
  const urlSync = options.urlSync ?? false;
  let exportSeconds = options.exportSeconds ?? 10;

  const freqInput = slot<HTMLInputElement>(root, 'freq');
  const noteOut = slot(root, 'note');
  const centsOut = slot(root, 'cents');
  const playBtn = slot<HTMLButtonElement>(root, 'play');
  const stopBtn = slot<HTMLButtonElement>(root, 'stop');
  const exportBtn = slot<HTMLButtonElement>(root, 'export');
  const exportSecondsInput = slot<HTMLInputElement | HTMLSelectElement>(root, 'export-seconds');
  const statusEl = slot(root, 'status');
  const shareBtn = slot<HTMLButtonElement>(root, 'share');
  const waveformButtons = slots<HTMLButtonElement>(root, 'waveform');
  const presetButtons = slots<HTMLButtonElement>(root, 'preset');
  const keyButtons = slots<HTMLButtonElement>(root, 'key');

  // ---- initial state -------------------------------------------------
  let frequency = clamp(options.defaultFrequency ?? 440, min, max);
  if (urlSync) {
    const fromUrl = queryNumber('freq', NaN);
    if (Number.isFinite(fromUrl)) frequency = clamp(fromUrl, min, max);
  }
  let waveform: Waveform = options.defaultWaveform ?? 'sine';
  if (urlSync) {
    const fromUrl = queryString('waveform').toLowerCase() as Waveform;
    if (VALID_WAVEFORMS.includes(fromUrl)) waveform = fromUrl;
  }

  const player = new VoicePlayer(waveform);
  let scopes: ScopeHandle[] = [];

  const updateReadouts = () => {
    const info = describeFrequency(frequency, a4);
    setText(noteOut, frequency >= 16 ? info.name : ' - ');
    setText(centsOut, frequency >= 16 ? centsLabel(info.cents) : '');
    if (freqInput && document.activeElement !== freqInput) {
      freqInput.value = Number.isInteger(frequency) ? String(frequency) : String(roundTo(frequency, 2));
    }
  };

  const updateTransport = () => {
    const playing = player.playing;
    setActive(playBtn, playing);
    if (playBtn) playBtn.setAttribute('aria-pressed', String(playing));
    setActive(stopBtn, false);
    if (stopBtn) stopBtn.disabled = !playing;
    options.onPlayStateChange?.(playing);
  };

  const setFrequency = (hz: number, opts: { silent?: boolean } = {}) => {
    const next = clamp(hz, min, max);
    frequency = next;
    if (player.playing) player.setFrequency(next);
    updateReadouts();
    if (freqInput) freqInput.setAttribute('aria-invalid', 'false');
    if (urlSync) setQueryParam('freq', Number.isInteger(next) ? next : roundTo(next, 2));
    if (!opts.silent) options.onFrequencyChange?.(next);
  };

  const start = (hz?: number) => {
    const target = hz ?? readFrequencyInput(freqInput, frequency);
    if (!isValidFrequency(target) || target < min || target > max) {
      if (freqInput) freqInput.setAttribute('aria-invalid', 'true');
      setStatus(statusEl, `Enter a frequency between ${min} and ${max} Hz.`, 'error');
      announce('Invalid frequency');
      return;
    }
    if (hz !== undefined) frequency = clamp(hz, min, max);
    if (freqInput) {
      const info = describeFrequency(frequency, a4);
      setStatus(statusEl, `Playing ${formatHz(frequency)} · ${info.name} ${info.cents === 0 ? '' : centsLabel(info.cents)} · ${waveform}`, 'ok');
    }
    ensureContext();
    player.play(frequency, waveform);
    updateReadouts();
    updateTransport();
  };

  const stop = () => {
    player.stop();
    updateTransport();
    setStatus(statusEl, 'Stopped.', 'idle');
  };

  const toggle = () => {
    if (player.playing) stop();
    else start();
  };

  const setWaveform = (next: Waveform) => {
    waveform = next;
    player.setWaveform(next);
    waveformButtons.forEach((button) => setPressed(button, button.dataset.value === next));
    if (urlSync) setQueryParam('waveform', next === 'sine' ? null : next);
    if (player.playing) setStatus(statusEl, `Playing ${formatHz(frequency)} · ${waveform}`, 'ok');
  };

  // ---- wiring --------------------------------------------------------
  waveformButtons.forEach((button) => setPressed(button, button.dataset.value === waveform));
  updateReadouts();
  updateTransport();
  if (stopBtn) stopBtn.disabled = true;

  on(playBtn, 'click', () => start());
  on(stopBtn, 'click', () => stop());

  on(freqInput, 'input', () => {
    const value = readFrequencyInput(freqInput, NaN);
    if (!Number.isFinite(value)) {
      freqInput?.setAttribute('aria-invalid', 'true');
      setStatus(statusEl, 'Numbers only.', 'error');
      return;
    }
    freqInput?.setAttribute('aria-invalid', 'false');
    // Live tuning: while a tone is playing, typing retunes it in real time.
    if (value >= min && value <= max) setFrequency(value);
    else {
      const info = describeFrequency(value, a4);
      setText(noteOut, info.name);
      setText(centsOut, centsLabel(info.cents));
    }
  });

  on(freqInput, 'blur', () => {
    const value = readFrequencyInput(freqInput, NaN);
    setFrequency(Number.isFinite(value) ? value : frequency);
  });

  on(freqInput, 'keydown', (event) => {
    const step = event.shiftKey ? 10 : 1;
    const value = readFrequencyInput(freqInput, frequency);
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setFrequency(value + step);
      if (player.playing) setStatus(statusEl, `Playing ${formatHz(frequency)}`, 'ok');
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setFrequency(value - step);
      if (player.playing) setStatus(statusEl, `Playing ${formatHz(frequency)}`, 'ok');
    } else if (event.key === 'Enter') {
      event.preventDefault();
      start();
    }
  });

  waveformButtons.forEach((button) => {
    on(button, 'click', () => {
      const value = button.dataset.value as Waveform | undefined;
      if (value && VALID_WAVEFORMS.includes(value)) setWaveform(value);
    });
  });

  presetButtons.forEach((button) => {
    on(button, 'click', () => {
      const hz = Number(button.dataset.freq);
      if (Number.isFinite(hz)) {
        setFrequency(hz);
        announce(`${hz} hertz`);
      }
    });
  });

  // Momentary keys: press to sound, release to stop (does not disturb transport).
  keyButtons.forEach((button) => {
    const hz = Number(button.dataset.freq);
    if (!Number.isFinite(hz)) return;
    const press = (event: Event) => {
      event.preventDefault();
      ensureContext();
      player.play(hz, waveform);
      updateTransport();
      keyButtons.forEach((other) => setPressed(other, other === button));
      setText(noteOut, describeFrequency(hz, a4).name);
      setText(centsOut, '');
    };
    const release = () => {
      player.stop();
      updateTransport();
      keyButtons.forEach((other) => setPressed(other, false));
      updateReadouts();
    };
    on(button, 'pointerdown', press);
    on(button, 'pointerup', release);
    on(button, 'pointerleave', release);
    on(button, 'pointercancel', release);
    on(button, 'keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') press(event);
    });
    on(button, 'keyup', (event) => {
      if (event.key === 'Enter' || event.key === ' ') release();
    });
  });

  // Master volume and mute live in the global header transport
  // (src/lib/ui/transport.ts) so they are present on every page.

  if (exportSecondsInput) {
    const preset = Number(exportSecondsInput.value);
    if (Number.isFinite(preset) && preset > 0) exportSeconds = preset;
    on(exportSecondsInput, 'change', () => {
      const next = Number(exportSecondsInput.value);
      if (Number.isFinite(next) && next > 0) exportSeconds = clamp(next, 0.5, 60);
    });
  }

  on(exportBtn, 'click', async () => {
    const target = readFrequencyInput(freqInput, frequency);
    if (!isValidFrequency(target) || target < min || target > max) {
      setStatus(statusEl, `Enter a frequency between ${min} and ${max} Hz.`, 'error');
      return;
    }
    exportBtn?.setAttribute('aria-busy', 'true');
    setStatus(statusEl, `Rendering ${exportSeconds} s WAV…`, 'idle');
    try {
      const buffer = await renderTone({ frequency: target, waveform, seconds: exportSeconds, gain: 0.5 });
      const blob = encodeWav(buffer);
      downloadBlob(blob, wavFilename(`${Math.round(target)}hz-${waveform}`));
      const size = (blob.size / 1024).toFixed(0);
      setStatus(
        statusEl,
        `Saved ${Math.round(target)} Hz·${waveform} · ${exportSeconds}s · 16-bit PCM ${getSampleRate()} Hz · ${size} KB`,
        'ok',
      );
      announce('WAV file saved');
    } catch (error) {
      setStatus(statusEl, `Export failed: ${(error as Error).message}`, 'error');
    } finally {
      exportBtn?.removeAttribute('aria-busy');
    }
  });

  on(shareBtn, 'click', async () => {
    const url = new URL(window.location.href);
    url.searchParams.set('freq', String(Number.isInteger(frequency) ? frequency : roundTo(frequency, 2)));
    if (waveform !== 'sine') url.searchParams.set('waveform', waveform);
    url.searchParams.delete('__');
    const ok = await copyText(url.toString());
    setStatus(statusEl, ok ? `Link copied - ${url.toString()}` : url.toString(), ok ? 'ok' : 'warn');
    announce(ok ? 'Link copied to clipboard' : 'Copy failed');
  });

  // Global shortcuts: space toggles, escape stops, +/- nudges.
  on(document, 'keydown', (event) => {
    const target = event.target as HTMLElement | null;
    const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
    if (event.key === 'Escape') {
      stop();
      return;
    }
    if (typing) return;
    if (event.code === 'Space') {
      event.preventDefault();
      toggle();
    }
  });

  scopes = mountScopes(root);

  const controller: ToneGeneratorController = {
    start,
    stop,
    toggle,
    setFrequency: (hz: number) => setFrequency(hz),
    getFrequency: () => frequency,
    setWaveform,
    setExportSeconds: (seconds: number) => {
      exportSeconds = clamp(seconds, 0.5, 60);
    },
    isPlaying: () => player.playing,
    destroy: () => {
      player.stop();
      scopes.forEach((scope) => scope.stop());
      scopes = [];
    },
  };

  // Test hook: tools/browser_qa.mjs drives the panel through this object.
  (window as unknown as { __sgTone?: ToneGeneratorController }).__sgTone = controller;

  return controller;
}

/** Render a tone as a Blob without downloading (used by tests and previews). */
export { exportTone };
