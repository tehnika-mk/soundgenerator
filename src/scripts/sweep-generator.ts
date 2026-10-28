/**
 * Frequency sweep generator page wiring.
 *
 * One SweepVoice drives the live playback and reports progress; the same
 * configuration is rendered offline for the WAV export so the file matches
 * exactly what was heard.
 */

import { ensureContext, type Waveform } from '../lib/audio/engine';
import { SweepVoice } from '../lib/audio/voices';
import { encodeWav, downloadBlob, renderSweep, wavFilename, WAV_SAMPLE_RATE } from '../lib/audio/wav';
import { formatHz } from '../lib/audio/notes';
import { mountScopes } from '../lib/audio/scope';
import { clamp, on, qs, qsa, setStatus, setText } from '../lib/ui/dom';

const FREQ_MIN = 1;
const FREQ_MAX = 20000;
const DURATION_MIN = 0.5;
const DURATION_MAX = 120;
/** Match the live per-voice ceiling so the exported file sounds like what you hear. */
const PER_VOICE_MAX = 0.6;

const root = qs<HTMLElement>('#sweep') ?? document.body;
const statusEl = qs('[data-sweep="status"]', root);
const playBtn = qs<HTMLButtonElement>('[data-sweep="play"]', root);
const stopBtn = qs<HTMLButtonElement>('[data-sweep="stop"]', root);
const exportBtn = qs<HTMLButtonElement>('[data-sweep="export"]', root);
const liveBadge = qs('[data-sweep="live"]', root);
const elapsedEl = qs('[data-sweep="elapsed"]', root);
const currentEl = qs('[data-sweep="current"]', root);
const barEl = qs<HTMLElement>('[data-sweep="bar"]', root);
const progressBar = qs<HTMLElement>('[data-sweep="progressbar"]', root);

const startInput = qs<HTMLInputElement>('[data-sweep="start"]', root);
const endInput = qs<HTMLInputElement>('[data-sweep="end"]', root);
const durationInput = qs<HTMLInputElement>('[data-sweep="duration"]', root);
const waveInput = qs<HTMLSelectElement>('[data-sweep="wave"]', root);
const startLevelInput = qs<HTMLInputElement>('[data-sweep="start-level"]', root);
const endLevelInput = qs<HTMLInputElement>('[data-sweep="end-level"]', root);
const startLevelRead = qs('[data-sweep="start-level-read"]', root);
const endLevelRead = qs('[data-sweep="end-level-read"]', root);
const holdInput = qs<HTMLInputElement>('[data-sweep="hold"]', root);
const loopInput = qs<HTMLInputElement>('[data-sweep="loop"]', root);
const rampButtons = qsa<HTMLButtonElement>('[data-sweep="ramp"]', root);

let voice: SweepVoice | null = null;
let playing = false;

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */

type SweepConfig = {
  start: number;
  end: number;
  duration: number;
  waveform: Waveform;
  ramp: 'linear' | 'exp';
  startLevel: number;
  endLevel: number;
  hold: boolean;
  loop: boolean;
};

function currentRamp(): 'linear' | 'exp' {
  const pressed = rampButtons.find((b) => b.getAttribute('aria-pressed') === 'true');
  return pressed?.dataset.value === 'linear' ? 'linear' : 'exp';
}

function readConfig(): SweepConfig {
  return {
    start: Number((startInput?.value ?? '').trim().replace(',', '.')),
    end: Number((endInput?.value ?? '').trim().replace(',', '.')),
    duration: Number(durationInput?.value ?? 5),
    waveform: (waveInput?.value ?? 'sine') as Waveform,
    ramp: currentRamp(),
    startLevel: Number(startLevelInput?.value ?? 50),
    endLevel: Number(endLevelInput?.value ?? 50),
    hold: holdInput?.checked ?? false,
    loop: loopInput?.checked ?? false,
  };
}

function validate(cfg: SweepConfig): string | null {
  if (!Number.isFinite(cfg.start) || !Number.isFinite(cfg.end)) return 'Enter a start and an end frequency.';
  if (cfg.start < FREQ_MIN || cfg.start > FREQ_MAX || cfg.end < FREQ_MIN || cfg.end > FREQ_MAX) {
    return `Frequencies must be between ${FREQ_MIN} Hz and ${FREQ_MAX} Hz.`;
  }
  if (Math.abs(cfg.end - cfg.start) < 0.01) return 'End frequency must differ from the start frequency.';
  if (!Number.isFinite(cfg.duration) || cfg.duration < DURATION_MIN || cfg.duration > DURATION_MAX) {
    return `Duration must be between ${DURATION_MIN} and ${DURATION_MAX} seconds.`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Progress + transport                                               */
/* ------------------------------------------------------------------ */

function syncFill(input: HTMLInputElement | null): void {
  if (!input) return;
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value);
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}

function updateProgress(ratio: number, hz: number, duration: number, elapsedOverride?: number): void {
  const elapsed = elapsedOverride ?? ratio * duration;
  setText(elapsedEl, `${elapsed.toFixed(2)} s / ${duration.toFixed(2)} s`);
  setText(currentEl, formatHz(hz));
  const pct = clamp(ratio * 100, 0, 100);
  if (barEl) barEl.style.width = `${pct}%`;
  progressBar?.setAttribute('aria-valuenow', String(Math.round(pct)));
}

function updateTransport(): void {
  if (playBtn) {
    playBtn.setAttribute('aria-pressed', String(playing));
    playBtn.setAttribute('data-state', playing ? 'on' : 'off');
  }
  if (stopBtn) stopBtn.disabled = !playing;
  if (liveBadge) liveBadge.hidden = !playing;
}

/* ------------------------------------------------------------------ */
/* Playback                                                           */
/* ------------------------------------------------------------------ */

function startSweep(cfg: SweepConfig): void {
  voice?.stop();
  updateProgress(0, cfg.start, cfg.duration, 0);
  const created = new SweepVoice({
    startHz: cfg.start,
    endHz: cfg.end,
    duration: cfg.duration,
    waveform: cfg.waveform,
    ramp: cfg.ramp,
    startGain: (cfg.startLevel / 100) * PER_VOICE_MAX,
    endGain: (cfg.endLevel / 100) * PER_VOICE_MAX,
    // A looping sweep must not also hold, or two tones would overlap.
    maintain: cfg.hold && !cfg.loop,
    onProgress: (ratio, hz) => {
      // A newer sweep may have replaced this one mid-flight.
      if (voice !== created) return;
      updateProgress(ratio, hz, cfg.duration);
    },
    onEnd: () => handleEnd(cfg),
  });
  voice = created;
  playing = true;
  updateTransport();
}

function handleEnd(cfg: SweepConfig): void {
  if (cfg.loop) {
    startSweep(readConfig());
    return;
  }
  updateProgress(1, cfg.end, cfg.duration, cfg.duration);
  if (cfg.hold) {
    // maintain:true keeps the final tone running until Stop.
    playing = true;
    setStatus(statusEl, `Sweep complete - holding ${formatHz(cfg.end)}.`, 'ok');
  } else {
    voice = null;
    playing = false;
    setStatus(statusEl, 'Sweep complete.', 'idle');
  }
  updateTransport();
}

function play(): void {
  const cfg = readConfig();
  const error = validate(cfg);
  if (error) {
    setStatus(statusEl, error, 'error');
    return;
  }
  ensureContext();
  startSweep(cfg);
  const rampWord = cfg.ramp === 'exp' ? 'exponential' : 'linear';
  setStatus(
    statusEl,
    `Sweeping ${formatHz(cfg.start)} → ${formatHz(cfg.end)} · ${cfg.duration.toFixed(2)} s · ${rampWord} · ${cfg.waveform}`,
    'ok',
  );
}

function stop(): void {
  voice?.stop();
  voice = null;
  playing = false;
  updateTransport();
  setStatus(statusEl, 'Stopped.', 'idle');
}

/* ------------------------------------------------------------------ */
/* Export                                                             */
/* ------------------------------------------------------------------ */

on(exportBtn, 'click', async () => {
  const cfg = readConfig();
  const error = validate(cfg);
  if (error) {
    setStatus(statusEl, error, 'error');
    return;
  }
  exportBtn?.setAttribute('aria-busy', 'true');
  setStatus(statusEl, `Rendering ${cfg.duration.toFixed(2)} s sweep…`, 'idle');
  try {
    const buffer = await renderSweep({
      startHz: cfg.start,
      endHz: cfg.end,
      seconds: cfg.duration,
      waveform: cfg.waveform,
      ramp: cfg.ramp,
      startGain: (cfg.startLevel / 100) * PER_VOICE_MAX,
      endGain: (cfg.endLevel / 100) * PER_VOICE_MAX,
    });
    const blob = encodeWav(buffer);
    const name = wavFilename(`sweep-${Math.round(cfg.start)}-to-${Math.round(cfg.end)}hz-${cfg.ramp}`);
    downloadBlob(blob, name);
    const kb = (blob.size / 1024).toFixed(0);
    setStatus(
      statusEl,
      `Saved ${name} · ${cfg.duration.toFixed(2)} s · 16-bit PCM ${WAV_SAMPLE_RATE} Hz · ${kb} KB`,
      'ok',
    );
  } catch (err) {
    setStatus(statusEl, `Export failed: ${(err as Error).message}`, 'error');
  } finally {
    exportBtn?.removeAttribute('aria-busy');
  }
});

/* ------------------------------------------------------------------ */
/* Wiring                                                             */
/* ------------------------------------------------------------------ */

on(playBtn, 'click', () => play());
on(stopBtn, 'click', () => stop());

rampButtons.forEach((button) => {
  on(button, 'click', () => {
    rampButtons.forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
    setStatus(statusEl, button.dataset.value === 'linear' ? 'Linear ramp selected.' : 'Exponential ramp selected.', 'idle');
  });
});

on(startLevelInput, 'input', () => {
  syncFill(startLevelInput);
  setText(startLevelRead, String(Math.round(Number(startLevelInput?.value ?? 0))));
});
on(endLevelInput, 'input', () => {
  syncFill(endLevelInput);
  setText(endLevelRead, String(Math.round(Number(endLevelInput?.value ?? 0))));
});

on(document, 'keydown', (event) => {
  if (event.key === 'Escape') stop();
});

document.addEventListener('sg:stop-all', () => {
  voice = null;
  playing = false;
  updateTransport();
});

// Startup
syncFill(startLevelInput);
syncFill(endLevelInput);
setText(startLevelRead, String(Math.round(Number(startLevelInput?.value ?? 50))));
setText(endLevelRead, String(Math.round(Number(endLevelInput?.value ?? 50))));
rampButtons.forEach((button) => {
  if (button.getAttribute('aria-pressed') === null) {
    button.setAttribute('aria-pressed', button.dataset.value === 'exp' ? 'true' : 'false');
  }
});
updateProgress(0, Number(startInput?.value ?? 20), Number(durationInput?.value ?? 5), 0);
updateTransport();
mountScopes(root);
