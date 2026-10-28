/**
 * Acoustic theory page: the wavelength / period / nearest-note calculator.
 *
 * Pure DOM and note maths. No audio is created on this page, so no
 * AudioContext is needed and nothing has to run inside a user gesture.
 */

import { describeFrequency } from '../lib/audio/notes';
import { on, qs, setText } from '../lib/ui/dom';

/** Speed of sound in dry air at 20 °C, in metres per second. */
const SPEED_OF_SOUND = 343;
const FREQ_MIN = 1;
const FREQ_MAX = 20000;

const input = qs<HTMLInputElement>('[data-calc="freq"]');
const wavelengthM = qs<HTMLElement>('[data-calc="wavelength-m"]');
const wavelengthMm = qs<HTMLElement>('[data-calc="wavelength-mm"]');
const periodMs = qs<HTMLElement>('[data-calc="period-ms"]');
const nearest = qs<HTMLElement>('[data-calc="nearest"]');

function clearReadouts(): void {
  setText(wavelengthM, '-');
  setText(wavelengthMm, '-');
  setText(periodMs, '-');
  setText(nearest, '-');
}

function render(): void {
  if (!input) return;

  const hz = Number(input.value.trim().replace(',', '.'));
  if (!Number.isFinite(hz) || hz < FREQ_MIN || hz > FREQ_MAX) {
    clearReadouts();
    return;
  }

  const lambda = SPEED_OF_SOUND / hz;
  const lambdaMm = lambda * 1000;

  setText(wavelengthM, `${lambda.toFixed(lambda >= 10 ? 2 : 3)} m`);
  setText(wavelengthMm, `${lambdaMm.toFixed(lambdaMm >= 100 ? 0 : 1)} mm`);
  setText(periodMs, `${(1000 / hz).toFixed(hz >= 1000 ? 3 : 2)} ms`);

  const info = describeFrequency(hz);
  setText(nearest, `${info.name} · ${info.targetHz} Hz`);
}

if (input) {
  on(input, 'input', render);
  on(input, 'change', render);
  render();
}
