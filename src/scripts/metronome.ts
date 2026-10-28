/**
 * Metronome page.
 *
 * Sample-accurate scheduling uses the Web Audio clock with a look-ahead
 * scheduler (the standard Chris Wilson approach): a timer wakes every
 * LOOKAHEAD_MS, but it only *schedules* clicks that fall inside the next
 * SCHEDULE_AHEAD seconds, handing the exact start time to playClick(). The
 * audible grid therefore comes from the sound card clock, not from setTimeout.
 */

import { SUBDIVISIONS, subdivisionById, tempoTerm } from '../lib/tools/metronome';
import { ensureContext, getCtx, getInput } from '../lib/audio/engine';
import { playClick } from '../lib/audio/voices';
import { mountScopes } from '../lib/audio/scope';
import { bindSliderFill, clamp, on, qs, qsa, setStatus, setText } from '../lib/ui/dom';

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.1; // seconds of audio scheduled in advance

const root = qs<HTMLElement>('#metronome') ?? document.body;

const bpmNumber = qs<HTMLInputElement>('[data-bpm-number]', root);
const bpmSlider = qs<HTMLInputElement>('[data-bpm-slider]', root);
const bpmStepButtons = qsa<HTMLButtonElement>('[data-bpm-step]', root);
const bpmReadout = qs('[data-bpm-readout]', root);
const tempoNameEl = qs('[data-tempo-name]', root);
const tempoDetailEl = qs('[data-tempo-detail]', root);
const tapBtn = qs<HTMLButtonElement>('[data-tap]', root);
const tapReadout = qs('[data-tap-bpm]', root);
const numeratorInput = qs<HTMLInputElement>('[data-numerator]', root);
const subdivisionHost = qs<HTMLElement>('[data-subdivision]', root);
const subdivisionButtons = qsa<HTMLButtonElement>('[data-value]', subdivisionHost ?? root);
const clickLevelInput = qs<HTMLInputElement>('[data-click-level]', root);
const clickLevelReadout = qs('[data-click-level-readout]', root);
const countInInput = qs<HTMLInputElement>('[data-count-in]', root);
const playBtn = qs<HTMLButtonElement>('[data-play]', root);
const stopBtn = qs<HTMLButtonElement>('[data-stop]', root);
const beatsHost = qs<HTMLElement>('[data-beats]', root);
const barEl = qs('[data-bar]', root);
const statusEl = qs('[data-status]', root);
const srBadge = qs('[data-sr-badge]', root);

let bpm = 120;
let numerator = 4;
let subdivision = subdivisionById('quarter');
let countIn = false;
let running = false;

let nextNoteTime = 0;
let beat = 0;
let sub = 0;
let bar = 1;
let phase: 'count' | 'pattern' = 'pattern';
let countBeat = 0;

let scheduleTimer = 0;
let raf = 0;
let flashToken = 0;
const flashQueue: { time: number; beat: number; bar: number }[] = [];

let clickBus: GainNode | null = null;
let tapTimes: number[] = [];

/* ------------------------------------------------------------------ */
/* Click bus - a separate gain stage so the click level is independent */
/* of the header master volume (the master still scales the output).   */
/* ------------------------------------------------------------------ */

function clickGain(): number {
  const p = clamp(Number(clickLevelInput?.value ?? 80), 0, 100) / 100;
  return p * p;
}

function getClickBus(): GainNode {
  const ctx = getCtx();
  if (!clickBus) {
    clickBus = ctx.createGain();
    clickBus.connect(getInput());
  }
  clickBus.gain.value = clickGain();
  return clickBus;
}

/* ------------------------------------------------------------------ */
/* Scheduling                                                          */
/* ------------------------------------------------------------------ */

function secondsPerBeat(): number {
  return 60 / bpm;
}

function scheduleNote(time: number, isDownbeat: boolean, isBeat: boolean): void {
  let frequency: number;
  let gain: number;
  if (isDownbeat) {
    frequency = 1500;
    gain = 0.5;
  } else if (isBeat) {
    frequency = 1050;
    gain = 0.4;
  } else {
    frequency = subdivision.pitch || 800;
    gain = 0.26;
  }
  playClick({ frequency, gain, duration: 0.045, when: time, destination: getClickBus() });
}

function scheduler(): void {
  if (!running) return;
  const ctx = getCtx();
  while (nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
    if (phase === 'count') {
      scheduleNote(nextNoteTime, countBeat === 0, true);
      flashQueue.push({ time: nextNoteTime, beat: countBeat, bar: 1 });
      countBeat++;
      if (countBeat >= 4) {
        phase = 'pattern';
        beat = 0;
        sub = 0;
        bar = 1;
      }
      nextNoteTime += secondsPerBeat();
    } else {
      const isBeat = sub === 0;
      scheduleNote(nextNoteTime, beat === 0 && isBeat, isBeat);
      if (isBeat) flashQueue.push({ time: nextNoteTime, beat, bar });

      sub++;
      if (sub >= subdivision.perBeat) {
        sub = 0;
        beat++;
        if (beat >= numerator) {
          beat = 0;
          bar++;
        }
      }
      nextNoteTime += secondsPerBeat() / subdivision.perBeat;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Visual beat indicator (decorative)                                  */
/* ------------------------------------------------------------------ */

function renderBeats(): void {
  if (!beatsHost) return;
  beatsHost.replaceChildren();
  for (let i = 0; i < numerator; i++) {
    const dot = document.createElement('span');
    dot.className = 'beat';
    dot.dataset.index = String(i);
    if (i === 0) dot.dataset.role = 'first';
    beatsHost.appendChild(dot);
  }
}

function clearBeats(): void {
  qsa<HTMLElement>('.beat', root).forEach((dot) => dot.setAttribute('data-active', 'false'));
}

function flashBeat(index: number, barNumber: number): void {
  const dots = qsa<HTMLElement>('.beat', root);
  dots.forEach((dot, i) => dot.setAttribute('data-active', String(i === index)));
  setText(barEl, `Bar ${barNumber}`);
  const token = ++flashToken;
  window.setTimeout(() => {
    if (token !== flashToken) return;
    dots.forEach((dot) => dot.setAttribute('data-active', 'false'));
  }, 90);
}

function visualLoop(): void {
  if (!running) return;
  const now = getCtx().currentTime;
  while (flashQueue.length && flashQueue[0].time <= now) {
    const item = flashQueue.shift()!;
    const index = Math.min(item.beat, numerator - 1);
    flashBeat(index, item.bar);
  }
  raf = requestAnimationFrame(visualLoop);
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

function updateTransport(): void {
  if (playBtn) {
    playBtn.setAttribute('aria-pressed', String(running));
    playBtn.setAttribute('data-state', running ? 'on' : 'off');
    playBtn.disabled = running;
  }
  if (stopBtn) {
    stopBtn.disabled = !running;
    stopBtn.setAttribute('data-state', 'off');
  }
}

function start(): void {
  if (running) return;
  const ctx = ensureContext();
  getClickBus();
  running = true;
  phase = countIn ? 'count' : 'pattern';
  countBeat = 0;
  beat = 0;
  sub = 0;
  bar = 1;
  flashQueue.length = 0;
  nextNoteTime = ctx.currentTime + 0.08;
  updateTransport();
  setStatus(statusEl, countIn ? 'Count-in…' : `Playing ${bpm} BPM · ${numerator}/4 · ${subdivision.label}`, 'ok');
  scheduler();
  scheduleTimer = window.setInterval(scheduler, LOOKAHEAD_MS);
  raf = requestAnimationFrame(visualLoop);
}

function stop(): void {
  running = false;
  if (scheduleTimer) {
    window.clearInterval(scheduleTimer);
    scheduleTimer = 0;
  }
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  flashQueue.length = 0;
  flashToken++;
  clearBeats();
  setText(barEl, 'Bar 1');
  updateTransport();
  setStatus(statusEl, 'Stopped.', 'idle');
}

function toggle(): void {
  if (running) stop();
  else start();
}

/* ------------------------------------------------------------------ */
/* Tempo                                                               */
/* ------------------------------------------------------------------ */

function setBpm(value: number, announce = true): void {
  const next = clamp(Math.round(value), 20, 300);
  bpm = next;
  if (bpmNumber && document.activeElement !== bpmNumber) bpmNumber.value = String(next);
  if (bpmSlider && document.activeElement !== bpmSlider) {
    bpmSlider.value = String(next);
    bpmSlider.style.setProperty('--fill', `${((next - 20) / 280) * 100}%`);
  }
  setText(bpmReadout, String(next));
  const term = tempoTerm(next);
  setText(tempoNameEl, term.name);
  setText(tempoDetailEl, term.detail);
  if (announce && running) setStatus(statusEl, `${next} BPM · ${term.name}`, 'ok');
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

bpmStepButtons.forEach((button) => {
  on(button, 'click', () => {
    const delta = Number(button.dataset.bpmStep);
    if (Number.isFinite(delta)) setBpm(bpm + delta);
  });
});

on(bpmNumber, 'input', () => {
  const value = Number(bpmNumber?.value);
  if (Number.isFinite(value)) setBpm(value, false);
});

on(bpmSlider, 'input', () => {
  const value = Number(bpmSlider?.value);
  if (Number.isFinite(value)) setBpm(value, false);
});

// Tap tempo - average the last four inter-tap intervals.
on(tapBtn, 'click', () => {
  const now = performance.now();
  if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) tapTimes = [];
  tapTimes.push(now);
  if (tapTimes.length > 5) tapTimes = tapTimes.slice(-5);

  if (tapTimes.length < 2) {
    setText(tapReadout, 'keep tapping…');
    return;
  }
  const intervals: number[] = [];
  for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
  const recent = intervals.slice(-4);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  if (avg <= 0) return;
  const detected = clamp(Math.round(60000 / avg), 20, 300);
  setBpm(detected);
  setText(tapReadout, `${detected} BPM`);
  setStatus(statusEl, `Tap tempo: ${detected} BPM from ${recent.length} interval${recent.length > 1 ? 's' : ''}.`, 'ok');
});

on(numeratorInput, 'input', () => {
  const value = clamp(Math.round(Number(numeratorInput?.value) || 4), 1, 12);
  numerator = value;
  if (beat >= numerator) beat = 0;
  renderBeats();
  if (running) setStatus(statusEl, `${bpm} BPM · ${numerator} beats per bar`, 'ok');
});

subdivisionButtons.forEach((button) => {
  on(button, 'click', () => {
    const id = button.dataset.value ?? 'quarter';
    subdivision = subdivisionById(id);
    sub = 0;
    subdivisionButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === id)));
    if (running) setStatus(statusEl, `${bpm} BPM · ${subdivision.label} subdivisions`, 'ok');
  });
});

if (clickLevelInput) {
  bindSliderFill(clickLevelInput);
  const updateLevel = () => {
    const value = Number(clickLevelInput.value) || 0;
    setText(clickLevelReadout, `${Math.round(value)}%`);
    if (clickBus) clickBus.gain.value = clickGain();
  };
  on(clickLevelInput, 'input', updateLevel);
  updateLevel();
}

on(countInInput, 'change', () => {
  countIn = Boolean(countInInput?.checked);
});

on(playBtn, 'click', () => start());
on(stopBtn, 'click', () => stop());

on(document, 'keydown', (event) => {
  if (event.key === 'Escape') {
    stop();
    return;
  }
  const target = event.target as HTMLElement | null;
  const typing = target && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName);
  if (typing) return;
  if (event.code === 'Space') {
    event.preventDefault();
    toggle();
  }
});

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

if (bpmSlider) {
  bindSliderFill(bpmSlider);
  bpmSlider.style.setProperty('--fill', `${((bpm - 20) / 280) * 100}%`);
}

renderBeats();
setBpm(bpm, false);
updateTransport();
setText(srBadge, `${(44100).toLocaleString()} Hz clock`);
mountScopes(root);

// The header "Stop all" control has to silence the metronome too: its clicks are
// scheduled oscillators rather than registered voices, so nothing else can stop it.
document.addEventListener('sg:stop-all', () => {
  if (running) stop();
});

// Test hook.
(window as unknown as { __sgMetronome?: unknown }).__sgMetronome = {
  start,
  stop,
  isRunning: () => running,
  getState: () => ({ bpm, numerator, subdivision: subdivision.id, running }),
};
