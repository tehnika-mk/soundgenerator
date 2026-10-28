/**
 * 432 Hz page.
 *
 * Reuses the shared tone-generator controller for frequency entry, transport,
 * WAV export and copy-link, and adds a reference-pitch selector plus a
 * chromatic note picker. Every frequency is derived from midiToFreq() against
 * the selected A4 - nothing is hard-coded.
 */

import { initToneGenerator } from '../lib/ui/tone-generator';
import {
  A4_REFERENCE_PRESETS,
  centsLabel,
  describeFrequency,
  midiToFreq,
  noteLabel,
  roundTo,
} from '../lib/audio/notes';
import { on, qs, qsa, setText } from '../lib/ui/dom';

const root = qs<HTMLElement>('#generator-432') ?? document.body;

const notesHost = qs<HTMLElement>('[data-notes]', root);
const refButtons = qsa<HTMLButtonElement>('[data-ref-hz]', root);
const refDetail = qs('[data-ref-detail]', root);
const a4Readout = qs('[data-a4-readout]', root);
const noteReadout = qs('[data-ref-note]', root);
const centsReadout = qs('[data-ref-cents]', root);

let a4 = 440;

// Declared before initToneGenerator runs because the controller fires its
// state callbacks during construction, before the assignment completes.
let controller: ReturnType<typeof initToneGenerator>;

/* ------------------------------------------------------------------ */
/* Readouts driven by the selected reference                           */
/* ------------------------------------------------------------------ */

function renderNote(): void {
  if (!controller) return;
  const hz = controller.getFrequency();
  if (!Number.isFinite(hz) || hz <= 0) {
    setText(noteReadout, ' - ');
    setText(centsReadout, ' - ');
    return;
  }
  const info = describeFrequency(hz, a4);
  setText(noteReadout, hz >= 16 ? info.name : ' - ');
  setText(centsReadout, hz >= 16 ? centsLabel(info.cents) : '');
}

// Initialise the shared controller now that renderNote() exists. Its
// construction calls onPlayStateChange immediately, hence the guard above.
controller = initToneGenerator({
  root,
  defaultFrequency: 432,
  urlSync: true,
  exportSeconds: 10,
  a4: 440,
  onFrequencyChange: () => renderNote(),
  onPlayStateChange: () => renderNote(),
});

/* ------------------------------------------------------------------ */
/* Chromatic note picker (C3 – C6)                                     */
/* ------------------------------------------------------------------ */

function buildPicker(): void {
  if (!notesHost) return;
  notesHost.replaceChildren();
  for (let midi = 48; midi <= 84; midi++) {
    const name = noteLabel(midi);
    const hz = roundTo(midiToFreq(midi, a4), 2);
    const key = document.createElement('button');
    key.type = 'button';
    key.className = 'key';
    key.dataset.midi = String(midi);
    key.dataset.black = String(name.includes('#'));
    key.setAttribute('aria-pressed', 'false');
    key.setAttribute('aria-label', `${name}, ${hz} hertz`);

    const nameEl = document.createElement('span');
    nameEl.className = 'key__name';
    nameEl.textContent = name;
    const hzEl = document.createElement('span');
    hzEl.className = 'key__hz mono';
    hzEl.textContent = hz.toFixed(2);
    key.append(nameEl, hzEl);

    on(key, 'click', () => {
      const value = roundTo(midiToFreq(midi, a4), 2);
      controller.setFrequency(value);
      controller.start(value);
      qsa<HTMLButtonElement>('.key', root).forEach((k) =>
        k.setAttribute('aria-pressed', String(k === key)),
      );
      renderNote();
    });

    notesHost.appendChild(key);
  }
}

/** Recompute every picker key's frequency for the current reference. */
function refreshPickerFrequencies(): void {
  qsa<HTMLButtonElement>('.key', root).forEach((key) => {
    const midi = Number(key.dataset.midi);
    if (!Number.isFinite(midi)) return;
    const hz = roundTo(midiToFreq(midi, a4), 2);
    const hzEl = key.querySelector('.key__hz');
    setText(hzEl, hz.toFixed(2));
    const name = key.querySelector('.key__name')?.textContent ?? noteLabel(midi);
    key.setAttribute('aria-label', `${name}, ${hz} hertz`);
  });
}

/* ------------------------------------------------------------------ */
/* Reference selector                                                  */
/* ------------------------------------------------------------------ */

function setReference(next: number): void {
  a4 = next;
  refButtons.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.refHz) === a4)));
  const preset = A4_REFERENCE_PRESETS.find((p) => p.hz === a4);
  if (refDetail) setText(refDetail, preset ? `${preset.detail}.` : '');
  setText(a4Readout, String(a4));
  refreshPickerFrequencies();
  renderNote();
}

refButtons.forEach((button) => {
  on(button, 'click', () => {
    const next = Number(button.dataset.refHz);
    if (Number.isFinite(next)) setReference(next);
  });
});

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

buildPicker();
setReference(440);
renderNote();

(window as unknown as { __sg432?: unknown }).__sg432 = {
  setReference,
  getReference: () => a4,
  controller,
};
