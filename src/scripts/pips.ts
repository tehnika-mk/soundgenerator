/**
 * The Pips - the BBC-style six-pip time signal.
 *
 * Five short 1000 Hz pips one second apart, then one long pip on the hour. The
 * tone timing is scheduled against AudioContext time (playClick's `when`), not
 * setTimeout, so the pips stay sample-accurate instead of drifting with timer
 * jitter. The optional hourly auto-play aligns the long pip with the top of the
 * hour using the same mechanism.
 */

import { ensureContext, getCtx } from '../lib/audio/engine';
import { ToneVoice, playClick } from '../lib/audio/voices';
import { renderOffline, encodeWav, downloadBlob, wavFilename } from '../lib/audio/wav';
import { PIPS } from '../lib/audio/notes';
import { mountScopes } from '../lib/audio/scope';
import {
  on,
  qs,
  qsa,
  setActive,
  setPressed,
  setStatus,
  setText,
} from '../lib/ui/dom';

const root = qs<HTMLElement>('#pips') ?? document.body;

const PIP_GAIN = 0.45;
const HOUR_MS = 3_600_000;

/* ----------------------------------------------------------------- */
/* state                                                             */
/* ----------------------------------------------------------------- */

let pipFrequency = 1000;
let autoPlay = false;
let reference: ToneVoice | null = null;
let scheduledKey = 0;

/* ----------------------------------------------------------------- */
/* DOM                                                               */
/* ----------------------------------------------------------------- */

const playBtn = qs<HTMLButtonElement>('[data-pips="play"]', root);
const refBtn = qs<HTMLButtonElement>('[data-pips="ref"]', root);
const exportBtn = qs<HTMLButtonElement>('[data-pips="export"]', root);
const autoToggle = qs<HTMLInputElement>('#pips-auto', root);
const statusEl = qs<HTMLElement>('[data-pips="status"]', root);
const clockEl = qs<HTMLElement>('[data-pips="clock"]', root);
const countdownEl = qs<HTMLElement>('[data-pips="countdown"]', root);
const nextEl = qs<HTMLElement>('[data-pips="next"]', root);
const freqButtons = qsa<HTMLButtonElement>('[data-pips="freq"]', root);

/* ----------------------------------------------------------------- */
/* pips                                                              */
/* ----------------------------------------------------------------- */

/** Fire the six pips so the long pip starts exactly at `when` (ctx seconds). */
function schedulePips(when: number): void {
  for (let i = 0; i < 5; i++) {
    playClick({ frequency: pipFrequency, duration: PIPS.short, gain: PIP_GAIN, when: when + i });
  }
  playClick({ frequency: pipFrequency, duration: PIPS.long, gain: PIP_GAIN, when: when + 5 });
}

/** Manual play: pips start almost immediately, 1 s apart. */
function playPipsNow(): void {
  const ctx = ensureContext();
  schedulePips(ctx.currentTime + 0.12);
  setStatus(statusEl, `Playing the six pips at ${pipFrequency} Hz (last pip sustained to 0.5 s).`, 'ok');
}

/** Hourly play: the long pip lands on the top of the hour. */
function armForNextHour(): void {
  const now = Date.now();
  const boundary = Math.ceil(now / HOUR_MS) * HOUR_MS;
  const secondsUntil = (boundary - now) / 1000;
  const ctx = ensureContext();
  const longPipAt = ctx.currentTime + secondsUntil;
  // Short pips at boundary−5 … boundary−1, long pip at the boundary.
  schedulePips(longPipAt - 5);
  setStatus(
    statusEl,
    `Pips armed for ${new Date(boundary).toLocaleTimeString()} - keep this tab open.`,
    'ok',
  );
}

function updateClock(): void {
  const now = Date.now();
  const boundary = Math.ceil(now / HOUR_MS) * HOUR_MS;
  const left = Math.max(0, boundary - now);
  const totalSeconds = Math.floor(left / 1000);
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const ss = String(totalSeconds % 60).padStart(2, '0');
  setText(clockEl, new Date(now).toLocaleTimeString());
  setText(countdownEl, `${mm}:${ss}`);
  setText(nextEl, new Date(boundary).toLocaleTimeString());
}

function tick(): void {
  updateClock();
  if (!autoPlay) return;
  const now = Date.now();
  const boundary = Math.ceil(now / HOUR_MS) * HOUR_MS;
  const msLeft = boundary - now;
  if (msLeft <= 6000 && scheduledKey !== boundary) {
    scheduledKey = boundary;
    armForNextHour();
  }
}

/* ----------------------------------------------------------------- */
/* reference tone                                                    */
/* ----------------------------------------------------------------- */

function toggleReference(): void {
  if (reference && reference.running) {
    reference.stop();
    reference = null;
    setActive(refBtn, false);
    if (refBtn) refBtn.setAttribute('aria-pressed', 'false');
    setStatus(statusEl, 'Reference tone stopped.', 'idle');
    return;
  }
  ensureContext();
  reference = new ToneVoice({ frequency: 1000, waveform: 'sine', gain: 0.4 });
  setActive(refBtn, true);
  if (refBtn) refBtn.setAttribute('aria-pressed', 'true');
  setStatus(statusEl, 'Reference tone: 1000 Hz continuous sine.', 'ok');
}

/* ----------------------------------------------------------------- */
/* wiring                                                            */
/* ----------------------------------------------------------------- */

on(playBtn, 'click', () => playPipsNow());

on(refBtn, 'click', () => toggleReference());

freqButtons.forEach((button) => {
  on(button, 'click', () => {
    const hz = Number(button.dataset.hz);
    if (!Number.isFinite(hz)) return;
    pipFrequency = hz;
    freqButtons.forEach((other) => setPressed(other, other === button));
    setStatus(statusEl, `Pip frequency set to ${hz} Hz.`, 'ok');
  });
});

if (autoToggle) {
  on(autoToggle, 'change', () => {
    autoPlay = !!autoToggle.checked;
    scheduledKey = 0;
    if (autoPlay) {
      setStatus(statusEl, 'Auto-play armed. The tab must stay open for the pips to fire.', 'warn');
      tick();
    } else {
      setStatus(statusEl, 'Auto-play off. Any pips already armed for the next hour may still sound.', 'idle');
    }
  });
}

on(exportBtn, 'click', async () => {
  exportBtn?.setAttribute('aria-busy', 'true');
  setStatus(statusEl, 'Rendering the six-pip sequence…', 'idle');
  try {
    const buffer = await renderOffline(
      6,
      (ctx, destination) => {
        const pip = (at: number, duration: number) => {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = pipFrequency;
          const env = ctx.createGain();
          env.gain.setValueAtTime(0, at);
          env.gain.linearRampToValueAtTime(PIP_GAIN, at + 0.003);
          env.gain.setValueAtTime(PIP_GAIN, Math.max(at + duration - 0.01, at + 0.003));
          env.gain.linearRampToValueAtTime(0, at + duration);
          osc.connect(env).connect(destination);
          osc.start(at);
          osc.stop(at + duration + 0.02);
        };
        for (let i = 0; i < 5; i++) pip(i, PIPS.short);
        pip(5, PIPS.long);
      },
      { channels: 1 },
    );
    const blob = encodeWav(buffer);
    downloadBlob(blob, wavFilename(`the-pips-${pipFrequency}hz`));
    setStatus(
      statusEl,
      `Saved the six-pip signal · ${pipFrequency} Hz · 16-bit PCM ${buffer.sampleRate} Hz · ${(
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

on(document, 'keydown', (event) => {
  if (event.key === 'Escape') {
    reference?.stop();
    reference = null;
    setActive(refBtn, false);
    if (refBtn) refBtn.setAttribute('aria-pressed', 'false');
  }
});

document.addEventListener('sg:stop-all', () => {
  reference = null;
  setActive(refBtn, false);
  if (refBtn) refBtn.setAttribute('aria-pressed', 'false');
});

/* ----------------------------------------------------------------- */
/* init                                                             */
/* ----------------------------------------------------------------- */

updateClock();
window.setInterval(tick, 1000);
mountScopes(root);
