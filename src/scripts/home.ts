/**
 * Home page wiring: the tone generator panel plus the derived-property
 * readouts (wavelength, period, MIDI number, cents) and the logarithmic
 * frequency slider.
 */

import { initToneGenerator } from '../lib/ui/tone-generator';
import { describeFrequency, midiToFreq, roundTo } from '../lib/audio/notes';
import { on, qs, setText, bindSliderFill, clamp } from '../lib/ui/dom';

const SLIDER_MIN = 20;
const SLIDER_MAX = 20000;

const generatorRoot = qs<HTMLElement>('#generator') ?? document.body;

const slider = qs<HTMLInputElement>('#freq-slider');
const speedOfSound = 343; // m/s at 20 °C

const stats = {
  wavelength: qs('[data-stat="wavelength"]'),
  period: qs('[data-stat="period"]'),
  midi: qs('[data-stat="midi"]'),
  nearest: qs('[data-stat="nearest"]'),
  cents: qs('[data-stat="cents"]'),
  octave: qs('[data-stat="octave"]'),
};

function toSlider(hz: number): number {
  const value = (Math.log(hz / SLIDER_MIN) / Math.log(SLIDER_MAX / SLIDER_MIN)) * 1000;
  return Math.round(clamp(value, 0, 1000));
}

function fromSlider(value: number): number {
  const ratio = Math.pow(SLIDER_MAX / SLIDER_MIN, value / 1000);
  const hz = SLIDER_MIN * ratio;
  if (hz >= 1000) return Math.round(hz);
  if (hz >= 100) return roundTo(hz, 1);
  return roundTo(hz, 2);
}

const controller = initToneGenerator({
  root: generatorRoot,
  defaultFrequency: 440,
  urlSync: true,
  exportSeconds: 10,
  onFrequencyChange: (hz) => {
    renderStats(hz);
    if (slider && document.activeElement !== slider) {
      slider.value = String(toSlider(hz));
      slider.style.setProperty('--fill', `${Number(slider.value) / 10}%`);
    }
  },
});

function renderStats(hz: number): void {
  if (!Number.isFinite(hz) || hz <= 0) return;
  const info = describeFrequency(hz, 440);
  setText(stats.wavelength, hz > 0 ? `${(speedOfSound / hz).toFixed(hz > 1000 ? 3 : 2)} m` : ' - ');
  setText(stats.period, `${(1000 / hz).toFixed(hz > 1000 ? 4 : 3)} ms`);
  setText(stats.midi, String(info.midi));
  setText(stats.nearest, `${info.name} · ${info.targetHz} Hz`);
  setText(stats.cents, info.cents === 0 ? 'exact' : `${info.cents > 0 ? '+' : ''}${info.cents} ¢`);
  setText(stats.octave, String(info.octave));
}

if (slider) {
  bindSliderFill(slider);
  slider.value = String(toSlider(controller.getFrequency()));
  slider.style.setProperty('--fill', `${Number(slider.value) / 10}%`);
  on(slider, 'input', () => {
    const hz = fromSlider(Number(slider.value));
    controller.setFrequency(hz);
    renderStats(hz);
  });
}

// Nudge / octave buttons: data-nudge="1" | "-10" | "x2" | "/2"
document.querySelectorAll<HTMLButtonElement>('[data-nudge]').forEach((button) => {
  on(button, 'click', () => {
    const current = controller.getFrequency();
    const rule = button.dataset.nudge ?? '0';
    let next = current;
    if (rule === 'x2') next = current * 2;
    else if (rule === '/2') next = current / 2;
    else next = current + Number(rule);
    next = clamp(next, SLIDER_MIN, SLIDER_MAX);
    controller.setFrequency(next);
    renderStats(next);
    if (slider) {
      slider.value = String(toSlider(next));
      slider.style.setProperty('--fill', `${Number(slider.value) / 10}%`);
    }
  });
});

// A4 reference selector only changes the note readout on this page.
const reference = qs<HTMLSelectElement>('#a4-reference');
if (reference) {
  on(reference, 'change', () => {
    const a4 = Number(reference.value) || 440;
    const hz = controller.getFrequency();
    const info = describeFrequency(hz, a4);
    setText(qs('[data-tg="note"]'), info.name);
    setText(qs('[data-tg="cents"]'), info.cents === 0 ? 'in tune' : `${info.cents > 0 ? '+' : ''}${info.cents} ¢`);
    if (stats.nearest) setText(stats.nearest, `${info.name} · ${roundTo(midiToFreq(info.midi, a4), 2)} Hz`);
  });
}

renderStats(controller.getFrequency());
