/**
 * DTMF (Touch-Tone) signal generator.
 *
 * A key press holds its dual tone (playDualTone with duration 0, stopped on
 * release). A dialled-number display accumulates keys and can replay them as a
 * timed sequence. The telephony buttons play the standard call-progress tones:
 * continuous ones run until Stop, cadenced ones repeat their on/off pattern.
 */

import { ensureContext } from '../lib/audio/engine';
import { playDualTone } from '../lib/audio/voices';
import { renderOffline, encodeWav, downloadBlob, wavFilename } from '../lib/audio/wav';
import { dtmfFrequencies, TELEPHONY_TONES } from '../lib/audio/notes';
import { mountScopes } from '../lib/audio/scope';
import {
  clamp,
  on,
  qs,
  qsa,
  setActive,
  setPressed,
  setStatus,
  setText,
} from '../lib/ui/dom';

const root = qs<HTMLElement>('#dtmf') ?? document.body;

const DUAL_GAIN = 0.35;
const MAX_DIGITS = 24;

/** Cadenced telephony tones: on/off durations in ms. null = continuous. */
const CADENCE: Record<string, { on: number; off: number } | null> = {
  dial: null,
  ringback: { on: 2000, off: 4000 },
  busy: { on: 500, off: 500 },
  special: null,
  'uk-dial': null,
  'uk-busy': { on: 375, off: 375 },
};

/* ----------------------------------------------------------------- */
/* state                                                             */
/* ----------------------------------------------------------------- */

let digits: string[] = [];
let toneMs = 100;
let gapMs = 70;
let heldStop: (() => void) | null = null;
let dialGen = 0;
let toneStop: (() => void) | null = null;
let cadenceTimer = 0;

/* ----------------------------------------------------------------- */
/* DOM                                                               */
/* ----------------------------------------------------------------- */

const displayEl = qs<HTMLElement>('[data-dtmf="display"]', root);
const freqEl = qs<HTMLElement>('[data-dtmf="freq"]', root);
const statusEl = qs<HTMLElement>('[data-dtmf="status"]', root);
const keyButtons = qsa<HTMLButtonElement>('[data-dtmf="key"]', root);
const telephonyButtons = qsa<HTMLButtonElement>('[data-dtmf="telephony"]', root);
const dialSeqBtn = qs<HTMLButtonElement>('[data-dtmf="dial"]', root);
const clearBtn = qs<HTMLButtonElement>('[data-dtmf="clear"]', root);
const backBtn = qs<HTMLButtonElement>('[data-dtmf="back"]', root);
const exportBtn = qs<HTMLButtonElement>('[data-dtmf="export"]', root);
const toneInput = qs<HTMLInputElement>('#dtmf-tone', root);
const gapInput = qs<HTMLInputElement>('#dtmf-gap', root);

/* ----------------------------------------------------------------- */
/* helpers                                                           */
/* ----------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function renderDisplay(): void {
  setText(displayEl, digits.length ? digits.join(' ') : ' - ');
}

function highlightKey(key: string, on: boolean): void {
  keyButtons.forEach((button) => setPressed(button, on && button.dataset.key === key));
}

function clearHighlights(): void {
  keyButtons.forEach((button) => setPressed(button, false));
}

function stopHeld(): void {
  heldStop?.();
  heldStop = null;
}

function stopTelephony(): void {
  window.clearTimeout(cadenceTimer);
  toneStop?.();
  toneStop = null;
  telephonyButtons.forEach((button) => setPressed(button, false));
}

function stopEverything(): void {
  dialGen++;
  stopHeld();
  stopTelephony();
  clearHighlights();
}

/* ----------------------------------------------------------------- */
/* key press / release                                               */
/* ----------------------------------------------------------------- */

function pressKey(key: string, element?: HTMLElement | null): void {
  const pair = dtmfFrequencies(key);
  if (!pair) return;
  ensureContext();
  stopHeld();
  heldStop = playDualTone(pair[0], pair[1], 0, DUAL_GAIN);
  keyButtons.forEach((button) => setPressed(button, element ? button === element : button.dataset.key === key));
  setText(freqEl, `${pair[0]} + ${pair[1]} Hz`);
}

function releaseKey(): void {
  stopHeld();
  clearHighlights();
}

function addDigit(key: string): void {
  if (digits.length >= MAX_DIGITS) digits.shift();
  digits.push(key);
  renderDisplay();
}

/* ----------------------------------------------------------------- */
/* dial sequence                                                     */
/* ----------------------------------------------------------------- */

async function dialSequence(): Promise<void> {
  if (!digits.length) {
    setStatus(statusEl, 'Dial some digits first.', 'warn');
    return;
  }
  const gen = ++dialGen;
  stopHeld();
  stopTelephony();
  ensureContext();
  const tone = toneMs / 1000;
  const gap = gapMs / 1000;
  const sequence = digits.slice();
  setStatus(statusEl, `Dialling ${sequence.join('')}…`, 'ok');

  for (const key of sequence) {
    if (gen !== dialGen) return;
    const pair = dtmfFrequencies(key);
    if (!pair) continue;
    highlightKey(key, true);
    setText(freqEl, `${pair[0]} + ${pair[1]} Hz`);
    playDualTone(pair[0], pair[1], tone, DUAL_GAIN);
    await sleep((tone + gap) * 1000);
    if (gen !== dialGen) return;
    clearHighlights();
  }
  setStatus(statusEl, `Dialled ${sequence.length} digit${sequence.length === 1 ? '' : 's'} · ${toneMs} ms tone · ${gapMs} ms gap`, 'ok');
}

/* ----------------------------------------------------------------- */
/* telephony tones                                                   */
/* ----------------------------------------------------------------- */

function playTelephony(button: HTMLButtonElement): void {
  const id = button.dataset.id ?? '';
  const entry = TELEPHONY_TONES.find((tone) => tone.id === id);
  if (!entry) return;
  stopHeld();
  stopTelephony();
  ensureContext();
  telephonyButtons.forEach((other) => setPressed(other, other === button));

  const cadence = CADENCE[id] ?? null;
  if (!cadence) {
    toneStop = playDualTone(entry.a, entry.b, 0, DUAL_GAIN);
    setStatus(statusEl, `${entry.label} · continuous ${entry.a} + ${entry.b} Hz - press Stop to end.`, 'ok');
    return;
  }

  const tick = () => {
    toneStop = playDualTone(entry.a, entry.b, cadence.on / 1000, DUAL_GAIN);
    cadenceTimer = window.setTimeout(tick, cadence.on + cadence.off);
  };
  tick();
  setStatus(
    statusEl,
    `${entry.label} · ${entry.a} + ${entry.b} Hz · ${cadence.on / 1000}s on / ${cadence.off / 1000}s off (approximate cadence) - press Stop to end.`,
    'ok',
  );
}

/* ----------------------------------------------------------------- */
/* wiring: keypad                                                    */
/* ----------------------------------------------------------------- */

keyButtons.forEach((button) => {
  const key = button.dataset.key ?? '';
  on(button, 'pointerdown', (event) => {
    event.preventDefault();
    pressKey(key, button);
    addDigit(key);
  });
  on(button, 'pointerup', releaseKey);
  on(button, 'pointerleave', releaseKey);
  on(button, 'pointercancel', releaseKey);
  on(button, 'keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      pressKey(key, button);
      addDigit(key);
    }
  });
  on(button, 'keyup', (event) => {
    if (event.key === 'Enter' || event.key === ' ') releaseKey();
  });
});

// Number-row keyboard input dials the same keys.
const keyboardKeys = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#']);
on(document, 'keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
  if (event.key === 'Escape') {
    stopEverything();
    setStatus(statusEl, 'Stopped.', 'idle');
    return;
  }
  if (!keyboardKeys.has(event.key) || event.repeat) return;
  const button = keyButtons.find((b) => b.dataset.key === event.key) ?? null;
  pressKey(event.key, button);
  addDigit(event.key);
  window.setTimeout(() => releaseKey(), 120);
});

/* ----------------------------------------------------------------- */
/* wiring: transport / display                                       */
/* ----------------------------------------------------------------- */

on(dialSeqBtn, 'click', () => void dialSequence());

on(clearBtn, 'click', () => {
  digits = [];
  renderDisplay();
  setStatus(statusEl, 'Number cleared.', 'idle');
});

on(backBtn, 'click', () => {
  digits.pop();
  renderDisplay();
});

telephonyButtons.forEach((button) => {
  on(button, 'click', () => playTelephony(button));
});

const stopAllBtn = qs<HTMLButtonElement>('[data-dtmf="stopall"]', root);
on(stopAllBtn, 'click', () => {
  stopEverything();
  setStatus(statusEl, 'All tones stopped.', 'idle');
});

if (toneInput) {
  toneMs = clamp(Number(toneInput.value) || 100, 20, 2000);
  on(toneInput, 'change', () => {
    toneMs = clamp(Number(toneInput.value) || 100, 20, 2000);
    toneInput.value = String(toneMs);
  });
}

if (gapInput) {
  gapMs = clamp(Number(gapInput.value) || 70, 0, 2000);
  on(gapInput, 'change', () => {
    gapMs = clamp(Number(gapInput.value) || 70, 0, 2000);
    gapInput.value = String(gapMs);
  });
}

on(exportBtn, 'click', async () => {
  if (!digits.length) {
    setStatus(statusEl, 'Dial some digits first.', 'warn');
    return;
  }
  const sequence = digits.slice();
  const tone = toneMs / 1000;
  const step = tone + gapMs / 1000;
  const seconds = sequence.length * step;
  exportBtn?.setAttribute('aria-busy', 'true');
  setStatus(statusEl, `Rendering ${sequence.length}-digit WAV…`, 'idle');
  try {
    const buffer = await renderOffline(
      seconds,
      (ctx, destination) => {
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, 0);
        env.connect(destination);
        sequence.forEach((key, index) => {
          const pair = dtmfFrequencies(key);
          if (!pair) return;
          const start = index * step;
          env.gain.setValueAtTime(0, start);
          env.gain.linearRampToValueAtTime(DUAL_GAIN, start + 0.004);
          env.gain.setValueAtTime(DUAL_GAIN, Math.max(start + tone - 0.004, start + 0.004));
          env.gain.linearRampToValueAtTime(0, start + tone);
          for (const hz of pair) {
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = hz;
            osc.connect(env);
            osc.start(start);
            osc.stop(start + tone + 0.02);
          }
        });
      },
      { channels: 1 },
    );
    const blob = encodeWav(buffer);
    downloadBlob(blob, wavFilename(`dtmf-${sequence.join('')}`));
    setStatus(
      statusEl,
      `Saved WAV · ${sequence.join('')} · ${seconds.toFixed(2)} s · 16-bit PCM ${buffer.sampleRate} Hz · ${(
        blob.size / 1024
      ).toFixed(0)} KB`,
      'ok',
    );
  } catch (error) {
    setStatus(statusEl, `Export failed: ${(error as Error).message}`, 'error');
  } finally {
    exportBtn?.removeAttribute('aria-busy');
  }
});

document.addEventListener('sg:stop-all', () => {
  stopEverything();
});

/* ----------------------------------------------------------------- */
/* init                                                             */
/* ----------------------------------------------------------------- */

renderDisplay();
setText(freqEl, 'press a key');
mountScopes(root);
