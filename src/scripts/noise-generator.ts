/**
 * Noise generator wiring.
 *
 * White / pink / brown noise is routed through a gain node owned by this page
 * (the level slider) before it reaches the shared master bus, so the level
 * control is independent of the global header volume. Optional low-pass and
 * high-pass filters are created on the NoiseVoice itself and adjusted live.
 *
 * Only one colour sounds at a time: changing the colour or pressing play while
 * something is running stops the previous buffer source first.
 */

import {
  ensureContext,
  getCtx,
  getContextOrNull,
  getInput,
  positionToGain,
  gainToDb,
} from '../lib/audio/engine';
import { NoiseVoice, type NoiseColor } from '../lib/audio/voices';
import { renderNoise, encodeWav, downloadBlob, wavFilename } from '../lib/audio/wav';
import { mountScopes } from '../lib/audio/scope';
import {
  bindSliderFill,
  clamp,
  on,
  qs,
  qsa,
  roundTo,
  setActive,
  setPressed,
  setStatus,
  setText,
} from '../lib/ui/dom';

const root = qs<HTMLElement>('#noise') ?? document.body;

const MIN_HZ = 20;
const MAX_HZ = 20000;
const VOICE_GAIN = 0.6; // NoiseVoice internal gain, kept below the 0.6 guidance
const EXPORT_GAIN = 0.5;

const COLOR_LABEL: Record<NoiseColor, string> = { white: 'White', pink: 'Pink', brown: 'Brown' };

/* ----------------------------------------------------------------- */
/* log frequency sliders                                             */
/* ----------------------------------------------------------------- */

function hzToSlider(hz: number): number {
  const value = (Math.log(hz / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ)) * 1000;
  return Math.round(clamp(value, 0, 1000));
}

function sliderToHz(value: number): number {
  const hz = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, value / 1000);
  if (hz >= 1000) return Math.round(hz);
  if (hz >= 100) return Math.round(hz);
  return roundTo(hz, 1);
}

function formatHz(hz: number): string {
  if (hz >= 1000) return `${roundTo(hz / 1000, hz < 10000 ? 2 : 1)} kHz`;
  return `${Math.round(hz)} Hz`;
}

/* ----------------------------------------------------------------- */
/* state                                                             */
/* ----------------------------------------------------------------- */

let color: NoiseColor = 'white';
let level = 60; // 0..100
let lowpassOn = false;
let highpassOn = false;
let lowpassHz = 8000;
let highpassHz = 120;
let exportSeconds = 10;
let playing = false;
let voice: NoiseVoice | null = null;
let levelNode: GainNode | null = null;

/* ----------------------------------------------------------------- */
/* DOM                                                               */
/* ----------------------------------------------------------------- */

const playBtn = qs<HTMLButtonElement>('[data-ng="play"]', root);
const stopBtn = qs<HTMLButtonElement>('[data-ng="stop"]', root);
const exportBtn = qs<HTMLButtonElement>('[data-ng="export"]', root);
const secondsSel = qs<HTMLSelectElement>('[data-ng="seconds"]', root);
const statusEl = qs<HTMLElement>('[data-ng="status"]', root);
const colorButtons = qsa<HTMLButtonElement>('[data-ng="color"]', root);
const levelSlider = qs<HTMLInputElement>('#ng-level', root);
const lpToggle = qs<HTMLInputElement>('#ng-lp-on', root);
const lpSlider = qs<HTMLInputElement>('#ng-lp-hz', root);
const hpToggle = qs<HTMLInputElement>('#ng-hp-on', root);
const hpSlider = qs<HTMLInputElement>('#ng-hp-hz', root);

const stats = {
  color: qs('[data-stat="color"]', root),
  rate: qs('[data-stat="rate"]', root),
  level: qs('[data-stat="level"]', root),
  lowpass: qs('[data-stat="lowpass"]', root),
  highpass: qs('[data-stat="highpass"]', root),
};

/* ----------------------------------------------------------------- */
/* audio                                                             */
/* ----------------------------------------------------------------- */

function ensureLevelNode(): GainNode {
  const ctx = ensureContext();
  if (!levelNode) {
    levelNode = ctx.createGain();
    levelNode.gain.value = positionToGain(level);
    levelNode.connect(getInput());
  }
  return levelNode;
}

function effectiveLowpass(): number {
  return lowpassOn ? lowpassHz : MAX_HZ;
}

function effectiveHighpass(): number {
  return highpassOn ? highpassHz : MIN_HZ;
}

function stopVoice(): void {
  if (voice) {
    voice.stop();
    voice = null;
  }
}

function start(): void {
  ensureContext();
  const destination = ensureLevelNode();
  stopVoice();
  voice = new NoiseVoice({
    color,
    gain: VOICE_GAIN,
    lowpass: effectiveLowpass(),
    highpass: effectiveHighpass(),
    destination,
  });
  playing = true;
  updateTransport();
  setStatus(
    statusEl,
    `Playing ${color} noise · ${lowpassOn ? formatHz(lowpassHz) : 'open'} low-pass · ${
      highpassOn ? formatHz(highpassHz) : 'open'
    } high-pass · level ${Math.round(level)}%`,
    'ok',
  );
}

function stop(): void {
  stopVoice();
  playing = false;
  updateTransport();
  setStatus(statusEl, 'Stopped.', 'idle');
}

function restartIfPlaying(): void {
  if (playing) start();
}

function applyFilters(): void {
  if (!voice) return;
  voice.setLowpass(effectiveLowpass());
  voice.setHighpass(effectiveHighpass());
}

/* ----------------------------------------------------------------- */
/* UI updates                                                        */
/* ----------------------------------------------------------------- */

function updateTransport(): void {
  setActive(playBtn, playing);
  playBtn?.setAttribute('aria-pressed', String(playing));
  setActive(stopBtn, false);
  if (stopBtn) stopBtn.disabled = !playing;
}

function updateStats(): void {
  const ctx = getContextOrNull();
  setText(stats.color, `${COLOR_LABEL[color]} noise`);
  setText(stats.rate, ctx ? `${ctx.sampleRate} Hz` : ' - ');
  const db = gainToDb(positionToGain(level));
  setText(stats.level, level <= 0 || !Number.isFinite(db) ? '−∞ dB' : `${db.toFixed(1)} dB`);
  setText(stats.lowpass, lowpassOn ? formatHz(lowpassHz) : 'open');
  setText(stats.highpass, highpassOn ? formatHz(highpassHz) : 'open');
}

/* ----------------------------------------------------------------- */
/* wiring                                                            */
/* ----------------------------------------------------------------- */

colorButtons.forEach((button) => {
  const value = button.dataset.value as NoiseColor | undefined;
  on(button, 'click', () => {
    if (!value || value === color) return;
    color = value;
    colorButtons.forEach((other) => setPressed(other, other === button));
    restartIfPlaying();
    updateStats();
    if (playing) return; // start() already wrote a status line
    setStatus(statusEl, `${COLOR_LABEL[color]} noise selected. Press play to sound it.`, 'idle');
  });
});

on(playBtn, 'click', () => start());
on(stopBtn, 'click', () => stop());

if (levelSlider) {
  bindSliderFill(levelSlider);
  levelSlider.value = String(Math.round(level));
  levelSlider.dispatchEvent(new Event('input'));
  on(levelSlider, 'input', () => {
    level = Number(levelSlider.value);
    if (levelNode) {
      const ctx = getCtx();
      levelNode.gain.setTargetAtTime(positionToGain(level), ctx.currentTime, 0.02);
    }
    updateStats();
  });
}

if (lpSlider) {
  lpSlider.value = String(hzToSlider(lowpassHz));
  bindSliderFill(lpSlider);
  on(lpSlider, 'input', () => {
    lowpassHz = sliderToHz(Number(lpSlider.value));
    if (lowpassOn) applyFilters();
    updateStats();
  });
}

if (hpSlider) {
  hpSlider.value = String(hzToSlider(highpassHz));
  bindSliderFill(hpSlider);
  on(hpSlider, 'input', () => {
    highpassHz = sliderToHz(Number(hpSlider.value));
    if (highpassOn) applyFilters();
    updateStats();
  });
}

on(lpToggle, 'change', () => {
  lowpassOn = !!lpToggle?.checked;
  if (lpSlider) lpSlider.disabled = !lowpassOn;
  applyFilters();
  updateStats();
});

on(hpToggle, 'change', () => {
  highpassOn = !!hpToggle?.checked;
  if (hpSlider) hpSlider.disabled = !highpassOn;
  applyFilters();
  updateStats();
});

if (secondsSel) {
  exportSeconds = Number(secondsSel.value) || 10;
  on(secondsSel, 'change', () => {
    const next = Number(secondsSel.value);
    if (Number.isFinite(next) && next > 0) exportSeconds = clamp(next, 1, 60);
  });
}

on(exportBtn, 'click', async () => {
  exportBtn?.setAttribute('aria-busy', 'true');
  setStatus(statusEl, `Rendering ${exportSeconds} s of ${color} noise…`, 'idle');
  try {
    const buffer = await renderNoise({
      color,
      seconds: exportSeconds,
      gain: EXPORT_GAIN,
      lowpass: effectiveLowpass(),
      highpass: effectiveHighpass(),
    });
    const blob = encodeWav(buffer);
    downloadBlob(blob, wavFilename(`${color}-noise-${exportSeconds}s`));
    setStatus(
      statusEl,
      `Saved ${color} noise · ${exportSeconds} s · 16-bit PCM ${buffer.sampleRate} Hz · ${(
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

// Escape always stops sound; the global Stop-all button resets our transport.
on(document, 'keydown', (event) => {
  if (event.key === 'Escape') stop();
});

document.addEventListener('sg:stop-all', () => {
  voice = null;
  playing = false;
  updateTransport();
});

/* ----------------------------------------------------------------- */
/* init                                                              */
/* ----------------------------------------------------------------- */

updateStats();
updateTransport();
mountScopes(root);
