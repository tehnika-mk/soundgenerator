/**
 * Instrument tuning page.
 *
 * Renders one momentary string button per detuned string of the selected
 * instrument, plays an equal-tempered reference pitch derived from the chosen
 * A4, and can cycle through every string hands-free or export each one as WAV.
 */

import { INSTRUMENTS, A4_REFERENCE_PRESETS, midiToFreq, noteLabel, roundTo } from '../lib/audio/notes';
import { VoicePlayer } from '../lib/ui/tone-generator';
import { ensureContext } from '../lib/audio/engine';
import { mountScopes } from '../lib/audio/scope';
import { renderTone, encodeWav, downloadBlob, wavFilename } from '../lib/audio/wav';
import { on, qs, qsa, setText, setStatus, clamp } from '../lib/ui/dom';

const root = qs<HTMLElement>('#tuning') ?? document.body;

const instrumentSelect = qs<HTMLSelectElement>('[data-instrument]', root);
const stringsHost = qs<HTMLElement>('[data-strings]', root);
const holdBtn = qs<HTMLButtonElement>('[data-hold]', root);
const cycleBtn = qs<HTMLButtonElement>('[data-cycle]', root);
const cycleSecondsInput = qs<HTMLInputElement>('[data-cycle-seconds]', root);
const statusEl = qs('[data-status]', root);
const refDetail = qs('[data-ref-detail]', root);
const refBadge = qs('[data-sr-badge]', root);
const statRef = qs('[data-stat="ref"]', root);
const statCount = qs('[data-stat="count"]', root);
const statLow = qs('[data-stat="low"]', root);
const statHigh = qs('[data-stat="high"]', root);
const refReadouts = qsa('[data-ref-readout]');
const refButtons = qsa<HTMLButtonElement>('[data-a4]', root);

const player = new VoicePlayer('sine');

let a4 = 440;
let instrument = INSTRUMENTS[0];
let hold = false;
let activeMidi: number | null = null;
let cycleTimer = 0;
let cycleIndex = 0;

const SECONDS_PER_STRING = () => clamp(Number(cycleSecondsInput?.value) || 4, 1, 30);

function freqFor(midi: number): number {
  return midiToFreq(midi, a4);
}

function formatFreq(hz: number): string {
  return `${roundTo(hz, 2).toFixed(2)} Hz`;
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

function stopTone(): void {
  player.stop();
  activeMidi = null;
  qsa<HTMLButtonElement>('.string__btn', root).forEach((b) => b.setAttribute('aria-pressed', 'false'));
}

function playMidi(midi: number): void {
  ensureContext();
  const hz = freqFor(midi);
  player.play(hz);
  activeMidi = midi;
  qsa<HTMLButtonElement>('.string__btn', root).forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.midi) === midi));
  });
  setStatus(statusEl, `Playing ${noteLabel(midi)} · ${formatFreq(hz)} · A4 = ${a4} Hz`, 'ok');
}

function toggleLatch(midi: number): void {
  if (activeMidi === midi) stopTone();
  else playMidi(midi);
}

function pressString(midi: number): void {
  if (hold) toggleLatch(midi);
  else playMidi(midi);
}

function releaseString(midi: number): void {
  if (hold) return; // latching: release does nothing
  if (activeMidi === midi) stopTone();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderStrings(): void {
  if (!stringsHost) return;
  stringsHost.replaceChildren();

  instrument.strings.forEach((string) => {
    const hz = freqFor(string.midi);
    const wrap = document.createElement('div');
    wrap.className = 'string';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'string__btn';
    btn.dataset.midi = String(string.midi);
    btn.dataset.freq = String(roundTo(hz, 2));
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', `${string.label}, ${formatFreq(hz)}`);

    const note = document.createElement('span');
    note.className = 'string__note';
    note.textContent = string.label;
    const hzEl = document.createElement('span');
    hzEl.className = 'string__hz mono';
    hzEl.textContent = formatFreq(hz);
    btn.append(note, hzEl);

    on(btn, 'pointerdown', (event) => {
      event.preventDefault();
      pressString(string.midi);
    });
    on(btn, 'pointerup', () => releaseString(string.midi));
    on(btn, 'pointerleave', () => releaseString(string.midi));
    on(btn, 'pointercancel', () => releaseString(string.midi));
    on(btn, 'keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        pressString(string.midi);
      }
    });
    on(btn, 'keyup', (event) => {
      if (event.key === 'Enter' || event.key === ' ') releaseString(string.midi);
    });

    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'btn btn--ghost btn--sm string__dl';
    dl.dataset.dl = String(string.midi);
    dl.textContent = '↓';
    dl.title = `Save ${string.label} WAV`;
    dl.setAttribute('aria-label', `Download ${string.label} ${formatFreq(hz)} as WAV`);
    on(dl, 'click', () => void saveString(string.midi, string.label));

    wrap.append(btn, dl);
    stringsHost.appendChild(wrap);
  });
}

function renderStats(): void {
  const list = instrument.strings;
  const lo = list[0];
  const hi = list[list.length - 1];
  setText(statRef, `A4 = ${a4} Hz`);
  setText(statCount, String(list.length));
  setText(statLow, `${lo.label} · ${formatFreq(freqFor(lo.midi))}`);
  setText(statHigh, `${hi.label} · ${formatFreq(freqFor(hi.midi))}`);
  setText(refBadge, `${list.length} strings · ${a4} Hz`);
  refReadouts.forEach((el) => setText(el, String(a4)));
}

function renderTable(): void {
  qsa<HTMLElement>('[data-midis]').forEach((cell) => {
    const midis = (cell.dataset.midis ?? '').split(',').filter(Boolean).map(Number);
    cell.textContent = midis.map((m) => roundTo(midiToFreq(m, a4), 2).toFixed(2)).join(' · ');
  });
}

function renderReference(): void {
  refButtons.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.a4) === a4)));
  const preset = A4_REFERENCE_PRESETS.find((p) => p.hz === a4);
  if (refDetail) setText(refDetail, preset ? `${preset.detail}.` : '');
}

function refreshAll(): void {
  // Retune a sounding string to the new reference without restarting it.
  if (activeMidi !== null && player.playing) player.play(freqFor(activeMidi));
  renderStrings();
  renderStats();
  renderTable();
}

/* ------------------------------------------------------------------ */
/* WAV export                                                          */
/* ------------------------------------------------------------------ */

async function saveString(midi: number, label: string): Promise<void> {
  const hz = freqFor(midi);
  try {
    setStatus(statusEl, `Rendering ${label} (${formatFreq(hz)})…`, 'idle');
    const buffer = await renderTone({ frequency: hz, seconds: 10, waveform: 'sine', gain: 0.5 });
    const blob = encodeWav(buffer);
    downloadBlob(blob, wavFilename(`${label}-${a4}-${roundTo(hz, 2)}hz`));
    setStatus(
      statusEl,
      `Saved ${label} · ${formatFreq(hz)} · 10 s · 16-bit PCM 44.1 kHz · ${(blob.size / 1024).toFixed(0)} KB`,
      'ok',
    );
  } catch (error) {
    setStatus(statusEl, `Export failed: ${(error as Error).message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Auto cycle                                                          */
/* ------------------------------------------------------------------ */

function cycleStep(): void {
  const string = instrument.strings[cycleIndex];
  if (string) playMidi(string.midi);
  cycleIndex = (cycleIndex + 1) % instrument.strings.length;
}

function stopCycle(): void {
  if (cycleTimer) {
    window.clearInterval(cycleTimer);
    cycleTimer = 0;
  }
  if (cycleBtn) {
    cycleBtn.textContent = 'Start cycle';
    cycleBtn.setAttribute('aria-pressed', 'false');
  }
}

function startCycle(): void {
  ensureContext();
  cycleIndex = 0;
  cycleStep();
  cycleTimer = window.setInterval(cycleStep, SECONDS_PER_STRING() * 1000);
  if (cycleBtn) {
    cycleBtn.textContent = 'Stop cycle';
    cycleBtn.setAttribute('aria-pressed', 'true');
  }
  setStatus(statusEl, `Cycling ${instrument.strings.length} strings at ${SECONDS_PER_STRING()} s each.`, 'ok');
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

refButtons.forEach((button) => {
  on(button, 'click', () => {
    const next = Number(button.dataset.a4);
    if (!Number.isFinite(next) || next === a4) return;
    a4 = next;
    renderReference();
    refreshAll();
    setStatus(statusEl, `Reference set to A4 = ${a4} Hz. All frequencies recomputed.`, 'ok');
  });
});

on(instrumentSelect, 'change', () => {
  const next = INSTRUMENTS.find((i) => i.id === instrumentSelect?.value);
  if (!next) return;
  stopCycle();
  stopTone();
  instrument = next;
  refreshAll();
  setStatus(statusEl, `${instrument.name} · ${instrument.strings.length} strings.`, 'idle');
});

on(holdBtn, 'click', () => {
  hold = !hold;
  holdBtn?.setAttribute('aria-pressed', String(hold));
  if (holdBtn) holdBtn.textContent = `Hold (latch) : ${hold ? 'on' : 'off'}`;
  if (!hold) {
    // Leaving latch mode stops anything held.
    stopTone();
  }
  setStatus(statusEl, hold ? 'Hold on - click a string to latch it, click again to stop.' : 'Hold off - press and hold to sound.', 'idle');
});

on(cycleBtn, 'click', () => {
  if (cycleTimer) stopCycle();
  else startCycle();
});

on(cycleSecondsInput, 'change', () => {
  if (cycleTimer) {
    stopCycle();
    startCycle();
  }
});

// Escape always stops every sound on the page.
on(document, 'keydown', (event) => {
  if (event.key === 'Escape') {
    stopCycle();
    stopTone();
    setStatus(statusEl, 'Stopped.', 'idle');
  }
});

// The global Stop-all button clears the UI state too.
document.addEventListener('sg:stop-all', () => {
  stopCycle();
  activeMidi = null;
  qsa<HTMLButtonElement>('.string__btn', root).forEach((b) => b.setAttribute('aria-pressed', 'false'));
});

renderReference();
renderStrings();
renderStats();
renderTable();
mountScopes(root);

// Test hook.
(window as unknown as { __sgTuning?: unknown }).__sgTuning = {
  playMidi,
  stopTone,
  setReference: (hz: number) => {
    a4 = hz;
    renderReference();
    refreshAll();
  },
  getState: () => ({ a4, instrument: instrument.id, activeMidi, playing: player.playing }),
};
