/**
 * Subwoofer test page.
 *
 * One tone voice at a time for the step buttons and the level-matched A/B
 * compare, plus a SweepVoice for the continuous 16 → 120 Hz sweep. The rattle
 * mode repeats the sweep with a triangle wave so its harmonics excite buzzes a
 * pure sine leaves silent.
 */

import { ToneVoice, SweepVoice } from '../lib/audio/voices';
import { ensureContext, stopAllVoices } from '../lib/audio/engine';
import { mountScopes } from '../lib/audio/scope';
import { renderTone, encodeWav, downloadBlob, wavFilename } from '../lib/audio/wav';
import { clamp, on, qs, qsa, setStatus, setText } from '../lib/ui/dom';

const SPEED_OF_SOUND = 343;
const COMPARE_GAIN = 0.5; // identical gain for every tone and the A/B compare

const root = qs<HTMLElement>('#sub') ?? document.body;

const stepButtons = qsa<HTMLButtonElement>('[data-step]', root);
const downloadButtons = qsa<HTMLButtonElement>('[data-dl-step]', root);
const abButtons = qsa<HTMLButtonElement>('[data-ab]', root);
const sweepBtn = qs<HTMLButtonElement>('[data-sweep]', root);
const sweepDuration = qs<HTMLInputElement>('[data-sweep-duration]', root);
const rattleInput = qs<HTMLInputElement>('[data-rattle]', root);
const sweepReadout = qs('[data-sweep-readout]', root);
const statusEl = qs('[data-status]', root);
const stopAllBtn = qs<HTMLButtonElement>('[data-stop-all]', root);

let tone: ToneVoice | null = null;
let activeKey: string | null = null;

let sweep: SweepVoice | null = null;
let sweepRepeating = false;
let sweepRestartTimer = 0;

/* ------------------------------------------------------------------ */
/* Tone transport (steps + A/B)                                        */
/* ------------------------------------------------------------------ */

function clearHighlights(): void {
  qsa<HTMLButtonElement>('[data-step], [data-ab]', root).forEach((b) => b.setAttribute('aria-pressed', 'false'));
}

function highlight(key: string): void {
  qsa<HTMLButtonElement>('[data-step], [data-ab]', root).forEach((b) => {
    const bKey = b.dataset.step ? `step:${b.dataset.step}` : `ab:${b.dataset.ab}`;
    b.setAttribute('aria-pressed', String(bKey === key));
  });
}

function stopTone(): void {
  tone?.stop();
  tone = null;
  activeKey = null;
  clearHighlights();
}

function playTone(key: string, hz: number): void {
  ensureContext();
  stopSweep();
  tone?.stop();
  tone = new ToneVoice({ frequency: hz, waveform: 'sine', gain: COMPARE_GAIN });
  activeKey = key;
  highlight(key);
  setText(
    statusEl,
    `Playing ${hz} Hz · λ ${(SPEED_OF_SOUND / hz).toFixed(2)} m · gain ${COMPARE_GAIN}`,
  );
  statusEl?.setAttribute('data-kind', 'ok');
}

function toggleTone(key: string, hz: number): void {
  if (activeKey === key) {
    stopTone();
    setStatus(statusEl, 'Stopped.', 'idle');
  } else {
    playTone(key, hz);
  }
}

/* ------------------------------------------------------------------ */
/* WAV export                                                          */
/* ------------------------------------------------------------------ */

async function saveStep(hz: number): Promise<void> {
  try {
    setStatus(statusEl, `Rendering ${hz} Hz…`, 'idle');
    const buffer = await renderTone({ frequency: hz, seconds: 10, waveform: 'sine', gain: 0.5 });
    const blob = encodeWav(buffer);
    downloadBlob(blob, wavFilename(`${hz}hz-subwoofer`));
    setStatus(
      statusEl,
      `Saved ${hz} Hz · 10 s · 16-bit PCM 44.1 kHz · ${(blob.size / 1024).toFixed(0)} KB`,
      'ok',
    );
  } catch (error) {
    setStatus(statusEl, `Export failed: ${(error as Error).message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Sweep                                                               */
/* ------------------------------------------------------------------ */

function runSweep(duration: number, rattle: boolean): void {
  sweep = new SweepVoice({
    startHz: 16,
    endHz: 120,
    duration,
    waveform: rattle ? 'triangle' : 'sine',
    ramp: 'exp',
    startGain: 0.4,
    endGain: 0.4,
    onProgress: (ratio, hz) => {
      setText(sweepReadout, `${hz.toFixed(1)} Hz · ${Math.round(ratio * 100)}%`);
    },
    onEnd: () => {
      if (!sweepRepeating) {
        stopSweep();
        return;
      }
      // Short gap, then restart so you can keep walking the room.
      sweepRestartTimer = window.setTimeout(() => {
        if (sweepRepeating) runSweep(duration, rattle);
      }, 300);
    },
  });
}

function startSweep(): void {
  ensureContext();
  stopTone();
  const duration = clamp(Number(sweepDuration?.value) || 10, 2, 60);
  const rattle = Boolean(rattleInput?.checked);
  sweepRepeating = rattle;
  runSweep(duration, rattle);
  if (sweepBtn) {
    sweepBtn.textContent = rattle ? 'Stop rattle sweep' : 'Stop sweep';
    sweepBtn.setAttribute('aria-pressed', 'true');
  }
  setStatus(
    statusEl,
    `${rattle ? 'Rattle' : 'Sweep'} · 16 → 120 Hz over ${duration} s${rattle ? ' · repeating' : ''}`,
    'ok',
  );
}

function stopSweep(): void {
  sweepRepeating = false;
  if (sweepRestartTimer) {
    window.clearTimeout(sweepRestartTimer);
    sweepRestartTimer = 0;
  }
  sweep?.stop();
  sweep = null;
  if (sweepBtn) {
    sweepBtn.textContent = 'Start sweep';
    sweepBtn.setAttribute('aria-pressed', 'false');
  }
  setText(sweepReadout, ' - ');
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

stepButtons.forEach((button) => {
  const hz = Number(button.dataset.step);
  if (!Number.isFinite(hz)) return;
  on(button, 'click', () => toggleTone(`step:${hz}`, hz));
});

abButtons.forEach((button) => {
  const hz = Number(button.dataset.ab);
  if (!Number.isFinite(hz)) return;
  on(button, 'click', () => toggleTone(`ab:${hz}`, hz));
});

downloadButtons.forEach((button) => {
  const hz = Number(button.dataset.dlStep);
  if (!Number.isFinite(hz)) return;
  on(button, 'click', () => void saveStep(hz));
});

on(sweepBtn, 'click', () => {
  if (sweep) stopSweep();
  else startSweep();
});

on(stopAllBtn, 'click', () => {
  stopSweep();
  stopTone();
  stopAllVoices();
  setStatus(statusEl, 'All sound stopped.', 'idle');
});

on(document, 'keydown', (event) => {
  if (event.key === 'Escape') {
    stopSweep();
    stopTone();
    setStatus(statusEl, 'Stopped.', 'idle');
  }
});

document.addEventListener('sg:stop-all', () => {
  sweepRepeating = false;
  sweep = null;
  tone = null;
  activeKey = null;
  clearHighlights();
  if (sweepBtn) {
    sweepBtn.textContent = 'Start sweep';
    sweepBtn.setAttribute('aria-pressed', 'false');
  }
  setText(sweepReadout, ' - ');
});

mountScopes(root);

// Test hook.
(window as unknown as { __sgSub?: unknown }).__sgSub = {
  playTone,
  stopTone,
  startSweep,
  stopSweep,
  getState: () => ({ activeKey, sweeping: sweep !== null }),
};
