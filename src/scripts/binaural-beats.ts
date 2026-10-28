/**
 * Binaural beat generator.
 *
 * Two sine ToneVoices are hard-panned: one to the left ear, one to the right.
 * The two ear frequencies are derived from a carrier and a beat:
 *
 *   left  = carrier - beat / 2
 *   right = carrier + beat / 2
 *
 * so the difference between the ears is exactly the beat frequency. The effect
 * only exists when each ear receives its own frequency - i.e. with headphones.
 * The offline export renders a real stereo file with one oscillator per channel.
 */

import { ensureContext, getCtx, getInput, positionToGain } from '../lib/audio/engine';
import { ToneVoice } from '../lib/audio/voices';
import { renderOffline, encodeWav, downloadBlob, wavFilename } from '../lib/audio/wav';
import { BINAURAL_BANDS } from '../lib/audio/notes';
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

const root = qs<HTMLElement>('#binaural') ?? document.body;

const VOICE_GAIN = 0.5;
const EXPORT_GAIN = 0.4;
const MIN_CARRIER = 20;
const MAX_CARRIER = 20000;

type Band = (typeof BINAURAL_BANDS)[number];

/* ----------------------------------------------------------------- */
/* state                                                             */
/* ----------------------------------------------------------------- */

let carrier = 200;
let beat = 10;
let level = 55; // 0..100
let playing = false;
let exportSeconds = 10;
let leftVoice: ToneVoice | null = null;
let rightVoice: ToneVoice | null = null;
let levelNode: GainNode | null = null;

function leftHz(): number {
  return clamp(carrier - beat / 2, 1, 22050);
}
function rightHz(): number {
  return clamp(carrier + beat / 2, 1, 22050);
}

function bandFor(hz: number): Band {
  if (hz < 4) return BINAURAL_BANDS[0];
  if (hz < 8) return BINAURAL_BANDS[1];
  if (hz < 13) return BINAURAL_BANDS[2];
  if (hz < 30) return BINAURAL_BANDS[3];
  return BINAURAL_BANDS[4];
}

function formatHz(hz: number): string {
  if (hz >= 1000) return `${roundTo(hz / 1000, 2)} kHz`;
  return `${roundTo(hz, hz < 100 ? 1 : 0)} Hz`;
}

/* ----------------------------------------------------------------- */
/* DOM                                                               */
/* ----------------------------------------------------------------- */

const carrierInput = qs<HTMLInputElement>('#bb-carrier', root);
const beatInput = qs<HTMLInputElement>('#bb-beat', root);
const levelSlider = qs<HTMLInputElement>('#bb-level', root);
const playBtn = qs<HTMLButtonElement>('[data-bb="play"]', root);
const stopBtn = qs<HTMLButtonElement>('[data-bb="stop"]', root);
const exportBtn = qs<HTMLButtonElement>('[data-bb="export"]', root);
const secondsSel = qs<HTMLSelectElement>('[data-bb="seconds"]', root);
const statusEl = qs<HTMLElement>('[data-bb="status"]', root);
const bandButtons = qsa<HTMLButtonElement>('[data-bb="band"]', root);
const carrierButtons = qsa<HTMLButtonElement>('[data-bb="carrier"]', root);

const stats = {
  left: qs('[data-stat="left"]', root),
  right: qs('[data-stat="right"]', root),
  beat: qs('[data-stat="beat"]', root),
  band: qs('[data-stat="band"]', root),
  carrier: qs('[data-stat="carrier"]', root),
  stereo: qs('[data-stat="stereo"]', root),
};

/* ----------------------------------------------------------------- */
/* audio                                                            */
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

function stopVoices(): void {
  leftVoice?.stop();
  rightVoice?.stop();
  leftVoice = null;
  rightVoice = null;
}

function start(): void {
  ensureContext();
  const destination = ensureLevelNode();
  stopVoices();
  leftVoice = new ToneVoice({
    frequency: leftHz(),
    waveform: 'sine',
    pan: -1,
    gain: VOICE_GAIN,
    destination,
  });
  rightVoice = new ToneVoice({
    frequency: rightHz(),
    waveform: 'sine',
    pan: 1,
    gain: VOICE_GAIN,
    destination,
  });
  playing = true;
  updateTransport();
  setStatus(
    statusEl,
    `Playing L ${roundTo(leftHz(), 1)} Hz · R ${roundTo(rightHz(), 1)} Hz · beat ${roundTo(beat, 1)} Hz`,
    'ok',
  );
}

function stop(): void {
  stopVoices();
  playing = false;
  updateTransport();
  setStatus(statusEl, 'Stopped.', 'idle');
}

function retune(): void {
  if (!playing) return;
  leftVoice?.setFrequency(leftHz());
  rightVoice?.setFrequency(rightHz());
  setStatus(
    statusEl,
    `L ${roundTo(leftHz(), 1)} Hz · R ${roundTo(rightHz(), 1)} Hz · beat ${roundTo(beat, 1)} Hz`,
    'ok',
  );
}

/* ----------------------------------------------------------------- */
/* UI                                                               */
/* ----------------------------------------------------------------- */

function updateTransport(): void {
  setActive(playBtn, playing);
  playBtn?.setAttribute('aria-pressed', String(playing));
  setActive(stopBtn, false);
  if (stopBtn) stopBtn.disabled = !playing;
}

function updateStats(): void {
  setText(stats.left, `${roundTo(leftHz(), 1)} Hz`);
  setText(stats.right, `${roundTo(rightHz(), 1)} Hz`);
  setText(stats.beat, `${roundTo(beat, 2)} Hz`);
  const band = bandFor(beat);
  setText(stats.band, `${band.label} · ${band.range}`);
  setText(stats.carrier, formatHz(carrier));
  setText(stats.stereo, 'L carrier − beat/2 · R carrier + beat/2');
}

function syncBeatButtons(): void {
  bandButtons.forEach((button) => {
    const value = Number(button.dataset.hz);
    setPressed(button, Number.isFinite(value) && Math.abs(value - beat) < 0.001);
  });
}

function syncCarrierButtons(): void {
  carrierButtons.forEach((button) => {
    const value = Number(button.dataset.hz);
    setPressed(button, Number.isFinite(value) && Math.abs(value - carrier) < 0.001);
  });
}

/* ----------------------------------------------------------------- */
/* wiring                                                           */
/* ----------------------------------------------------------------- */

on(playBtn, 'click', () => start());
on(stopBtn, 'click', () => stop());

on(carrierInput, 'input', () => {
  const value = Number(carrierInput?.value);
  if (!Number.isFinite(value)) return;
  carrier = clamp(value, MIN_CARRIER, MAX_CARRIER);
  retune();
  updateStats();
  syncCarrierButtons();
});

on(beatInput, 'input', () => {
  const value = Number(beatInput?.value);
  if (!Number.isFinite(value)) return;
  beat = clamp(value, 0.1, 100);
  retune();
  updateStats();
  syncBeatButtons();
});

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
  });
}

bandButtons.forEach((button) => {
  on(button, 'click', () => {
    const hz = Number(button.dataset.hz);
    if (!Number.isFinite(hz)) return;
    beat = hz;
    if (beatInput) beatInput.value = String(hz);
    retune();
    updateStats();
    syncBeatButtons();
    setStatus(statusEl, `Beat set to ${hz} Hz - ${bandFor(hz).label} band.`, 'ok');
  });
});

carrierButtons.forEach((button) => {
  on(button, 'click', () => {
    const hz = Number(button.dataset.hz);
    if (!Number.isFinite(hz)) return;
    carrier = hz;
    if (carrierInput) carrierInput.value = String(hz);
    retune();
    updateStats();
    syncCarrierButtons();
    setStatus(statusEl, `Carrier set to ${hz} Hz.`, 'ok');
  });
});

if (secondsSel) {
  exportSeconds = Number(secondsSel.value) || 10;
  on(secondsSel, 'change', () => {
    const next = Number(secondsSel.value);
    if (Number.isFinite(next) && next > 0) exportSeconds = clamp(next, 5, 120);
  });
}

on(exportBtn, 'click', async () => {
  exportBtn?.setAttribute('aria-busy', 'true');
  setStatus(statusEl, `Rendering ${exportSeconds} s stereo WAV…`, 'idle');
  try {
    const left = leftHz();
    const right = rightHz();
    const buffer = await renderOffline(
      exportSeconds,
      (ctx, destination) => {
        const fade = 0.02;
        const build = (hz: number, pan: number) => {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = hz;
          const panner = ctx.createStereoPanner();
          panner.pan.value = pan;
          const env = ctx.createGain();
          env.gain.setValueAtTime(0, 0);
          env.gain.linearRampToValueAtTime(EXPORT_GAIN, fade);
          env.gain.setValueAtTime(EXPORT_GAIN, Math.max(exportSeconds - fade, fade));
          env.gain.linearRampToValueAtTime(0, exportSeconds);
          osc.connect(panner).connect(env).connect(destination);
          osc.start(0);
          osc.stop(exportSeconds + 0.02);
        };
        build(left, -1);
        build(right, 1);
      },
      { channels: 2 },
    );
    const blob = encodeWav(buffer);
    downloadBlob(blob, wavFilename(`binaural-${Math.round(carrier)}hz-beat-${roundTo(beat, 1)}hz`));
    setStatus(
      statusEl,
      `Saved stereo WAV · L ${roundTo(left, 1)} Hz / R ${roundTo(right, 1)} Hz · ${exportSeconds} s · ${(
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
  if (event.key === 'Escape') stop();
});

document.addEventListener('sg:stop-all', () => {
  leftVoice = null;
  rightVoice = null;
  playing = false;
  updateTransport();
});

/* ----------------------------------------------------------------- */
/* init                                                             */
/* ----------------------------------------------------------------- */

updateStats();
updateTransport();
syncBeatButtons();
syncCarrierButtons();
mountScopes(root);
