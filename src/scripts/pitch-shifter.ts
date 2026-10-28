/**
 * Pitch Shifter page wiring.
 *
 * Loads a file, drives the shared WSOLA engine (stretch-engine.ts) with
 *   pitchRatio = 2^(semitones/12 + cents/1200)
 *   tempoRatio = 1                     (Maintain tempo ON  → duration kept)
 *   tempoRatio = pitchRatio            (Maintain tempo OFF → resample, length changes)
 * and exports the offline render as a 16-bit WAV.
 */

import {
  createStretchPlayer,
  createWaveformView,
  formatDuration,
  loadAudioFile,
  pitchRatioFromSemitones,
  renderStretched,
  type LoadedAudio,
  type StretchPlayer,
} from '../lib/tools/stretch-engine';
import { encodeWav, downloadBlob, wavFilename } from '../lib/audio/wav';
import { qs, on, clamp, setStatus, setText } from '../lib/ui/dom';

const PITCH_MIN = 0.25;
const PITCH_MAX = 4;
const REFERENCE_HZ = 440;

const el = {
  file: qs<HTMLInputElement>('[data-ps="file"]'),
  drop: qs<HTMLElement>('[data-ps="drop"]') ?? qs<HTMLElement>('#ps-drop'),
  wave: qs<HTMLCanvasElement>('[data-ps="wave"]'),
  name: qs('[data-ps="name"]'),
  duration: qs('[data-ps="duration"]'),
  rate: qs('[data-ps="rate"]'),
  channels: qs('[data-ps="channels"]'),
  time: qs('[data-ps="time"]'),
  play: qs<HTMLButtonElement>('[data-ps="play"]'),
  pause: qs<HTMLButtonElement>('[data-ps="pause"]'),
  stop: qs<HTMLButtonElement>('[data-ps="stop"]'),
  export: qs<HTMLButtonElement>('[data-ps="export"]'),
  exportProgress: qs<HTMLElement>('[data-ps="export-progress"]'),
  exportBar: qs<HTMLElement>('[data-ps="export-bar"]'),
  exportPct: qs('[data-ps="export-pct"]'),
  status: qs('[data-ps="status"]'),
  engineBadge: qs('[data-ps="engine-badge"]'),

  semitone: qs<HTMLInputElement>('[data-ps="semitone"]'),
  semitoneNum: qs<HTMLInputElement>('[data-ps="semitone-num"]'),
  cents: qs<HTMLInputElement>('[data-ps="cents"]'),
  centsNum: qs<HTMLInputElement>('[data-ps="cents-num"]'),
  maintain: qs<HTMLButtonElement>('[data-ps="maintain"]'),
  modeHelp: qs('[data-ps="mode-help"]'),
  ratio: qs('[data-ps="ratio"]'),
  ratioOut: qs('[data-ps="ratio-out"]'),
  pitch440: qs('[data-ps="pitch440"]'),
  srclen: qs('[data-ps="srclen"]'),
  outlen: qs('[data-ps="outlen"]'),
};

let loaded: LoadedAudio | null = null;
let player: StretchPlayer | null = null;
let playerPromise: Promise<void> | null = null;
let semitones = 0;
let cents = 0;
let maintainTempo = true;

const waveform = el.wave
  ? createWaveformView(el.wave, {
      onSeek: (seconds) => {
        if (!loaded) return;
        player?.seek(seconds);
        waveform?.setPlayhead(seconds);
        renderTime(seconds, loaded.duration);
      },
    })
  : null;

/* ------------------------------------------------------------------ */
/* Derived values                                                      */
/* ------------------------------------------------------------------ */

function pitchRatio(): number {
  return clamp(pitchRatioFromSemitones(semitones, cents), PITCH_MIN, PITCH_MAX);
}

function tempoRatio(): number {
  return maintainTempo ? 1 : pitchRatio();
}

function outputLength(): number {
  return loaded ? loaded.duration / tempoRatio() : 0;
}

function renderTime(position: number, duration: number): void {
  if (!Number.isFinite(duration) || duration <= 0) {
    setText(el.time, ' - / - ');
    return;
  }
  setText(el.time, `${formatDuration(position)} / ${formatDuration(duration)}`);
}

function renderReadouts(): void {
  const ratio = pitchRatio();
  setText(el.ratio, `×${ratio.toFixed(4)}`);
  setText(el.ratioOut, ratio.toFixed(4));
  setText(el.pitch440, `${(REFERENCE_HZ * ratio).toFixed(1)} Hz`);
  setText(el.srclen, loaded ? formatDuration(loaded.duration) : ' - ');
  setText(el.outlen, loaded ? formatDuration(outputLength()) : ' - ');

  if (el.maintain) {
    el.maintain.setAttribute('aria-pressed', String(maintainTempo));
    const led = el.maintain.querySelector('.led');
    if (led) led.setAttribute('data-on', String(maintainTempo));
  }
  if (el.modeHelp) {
    el.modeHelp.textContent = maintainTempo
      ? 'On - overlap-add resynthesis keeps the clip length fixed; only the pitch moves.'
      : 'Off - the file is resampled like tape at the wrong speed: the pitch and the length change together.';
  }
}

function syncInputs(): void {
  if (el.semitone && document.activeElement !== el.semitone) el.semitone.value = String(semitones);
  if (el.semitoneNum && document.activeElement !== el.semitoneNum) el.semitoneNum.value = String(semitones);
  if (el.cents && document.activeElement !== el.cents) el.cents.value = String(cents);
  if (el.centsNum && document.activeElement !== el.centsNum) el.centsNum.value = String(cents);
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

function setTransport(playing: boolean, hasFile: boolean): void {
  if (el.play) {
    el.play.disabled = !hasFile;
    el.play.setAttribute('aria-pressed', String(playing));
  }
  if (el.pause) el.pause.disabled = !hasFile || !playing;
  if (el.stop) el.stop.disabled = !hasFile;
  if (el.export) el.export.disabled = !hasFile;
}

async function buildPlayer(): Promise<void> {
  if (!loaded) return;
  const audio = loaded;
  try {
    player?.dispose();
    const created = await createStretchPlayer({
      buffer: audio.buffer,
      pitchRatio: pitchRatio(),
      tempoRatio: tempoRatio(),
    });
    if (loaded !== audio) {
      created.dispose();
      return;
    }
    player = created;
    player.onProgress = (info) => {
      renderTime(info.position, info.duration);
      waveform?.setPlayhead(info.position);
    };
    player.onEnded = () => {
      setTransport(false, true);
      if (loaded) {
        renderTime(loaded.duration, loaded.duration);
        waveform?.setPlayhead(loaded.duration);
      }
      setStatus(el.status, 'Reached the end. Play again or export.', 'idle');
    };
    player.onStop = () => setTransport(false, true);
    setText(el.engineBadge, 'ready');
  } catch (error) {
    setText(el.engineBadge, 'error');
    setStatus(el.status, `Audio engine failed to start: ${(error as Error).message}`, 'error');
    player = null;
  }
}

/** Build the player once per file and let callers await readiness. */
function ensurePlayer(): Promise<void> {
  if (!playerPromise) playerPromise = buildPlayer();
  return playerPromise;
}

async function loadFile(file: File): Promise<void> {
  playerPromise = null;
  setStatus(el.status, `Decoding ${file.name}…`, 'idle');
  setText(el.engineBadge, 'decoding');
  try {
    const audio = await loadAudioFile(file);
    loaded = audio;
    setText(el.name, audio.name.length > 22 ? `${audio.name.slice(0, 21)}…` : audio.name);
    setText(el.duration, formatDuration(audio.duration));
    setText(el.rate, `${(audio.sampleRate / 1000).toFixed(1)} kHz`);
    setText(el.channels, audio.channels === 1 ? 'mono' : audio.channels === 2 ? 'stereo' : `${audio.channels} ch`);
    waveform?.setBuffer(audio.buffer);
    waveform?.setPlayhead(0);
    renderTime(0, audio.duration);
    renderReadouts();
    setTransport(false, true);
    setStatus(el.status, `Loaded · ${formatDuration(audio.duration)} · result ${formatDuration(outputLength())}. Preparing the engine…`, 'ok');
    playerPromise = ensurePlayer().then(() => {
      if (loaded === audio) {
        setStatus(el.status, `Ready · ${formatDuration(audio.duration)} · result ${formatDuration(outputLength())}. Press play.`, 'ok');
      }
    });
  } catch (error) {
    loaded = null;
    player?.dispose();
    player = null;
    playerPromise = null;
    setText(el.engineBadge, 'error');
    waveform?.setBuffer(null);
    setTransport(false, false);
    renderReadouts();
    setStatus(el.status, `Could not decode that file: ${(error as Error).message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

function applyRatios(): void {
  if (player) {
    player.setPitchRatio(pitchRatio());
    player.setTempoRatio(tempoRatio());
  }
}

function setSemitones(value: number): void {
  semitones = Math.round(clamp(value, -24, 24));
  syncInputs();
  renderReadouts();
  applyRatios();
}

function setCents(value: number): void {
  cents = Math.round(clamp(value, -100, 100));
  syncInputs();
  renderReadouts();
  applyRatios();
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

on(el.file, 'change', () => {
  const file = el.file?.files?.[0];
  if (file) void loadFile(file);
});

for (const type of ['dragenter', 'dragover'] as const) {
  on(el.drop, type, (event) => {
    event.preventDefault();
    el.drop?.setAttribute('data-over', 'true');
  });
}
for (const type of ['dragleave', 'dragend'] as const) {
  on(el.drop, type, () => el.drop?.setAttribute('data-over', 'false'));
}
on(el.drop, 'drop', (event) => {
  event.preventDefault();
  el.drop?.setAttribute('data-over', 'false');
  const file = (event as DragEvent).dataTransfer?.files?.[0];
  if (file) void loadFile(file);
});
// Stop the browser navigating away when a file is dropped outside the zone.
on(document, 'dragover', (event) => event.preventDefault());
on(document, 'drop', (event) => event.preventDefault());

on(el.semitone, 'input', () => setSemitones(Number(el.semitone?.value ?? 0)));
on(el.semitoneNum, 'input', () => setSemitones(Number(el.semitoneNum?.value ?? 0)));
on(el.cents, 'input', () => setCents(Number(el.cents?.value ?? 0)));
on(el.centsNum, 'input', () => setCents(Number(el.centsNum?.value ?? 0)));

document.querySelectorAll<HTMLButtonElement>('[data-ps="nudge"]').forEach((button) => {
  on(button, 'click', () => setSemitones(semitones + Number(button.dataset.value ?? 0)));
});
on(qs<HTMLButtonElement>('[data-ps="reset"]'), 'click', () => {
  setSemitones(0);
  setCents(0);
});

on(el.maintain, 'click', () => {
  maintainTempo = !maintainTempo;
  renderReadouts();
  applyRatios();
  if (loaded) {
    setStatus(
      el.status,
      maintainTempo
        ? `Maintain tempo on - duration stays ${formatDuration(loaded.duration)}.`
        : `Maintain tempo off - resample: duration becomes ${formatDuration(outputLength())}.`,
      'idle',
    );
  }
});

on(el.play, 'click', async () => {
  await ensurePlayer();
  if (!player) return;
  player.play();
  setTransport(true, true);
  setStatus(el.status, `Playing · ${pitchRatio().toFixed(4)}× pitch${maintainTempo ? ' · duration preserved' : ' · resampled'}`, 'ok');
});

on(el.pause, 'click', () => {
  player?.pause();
  setTransport(false, true);
  setStatus(el.status, 'Paused.', 'idle');
});

on(el.stop, 'click', () => {
  player?.stop();
  setTransport(false, true);
  waveform?.setPlayhead(0);
  if (loaded) renderTime(0, loaded.duration);
  setStatus(el.status, 'Stopped.', 'idle');
});

on(document, 'keydown', (event) => {
  if (event.key !== 'Escape') return;
  player?.pause();
  setTransport(false, true);
});

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

on(el.export, 'click', async () => {
  if (!loaded) return;
  player?.pause();
  setTransport(false, true);
  el.export?.setAttribute('aria-busy', 'true');
  if (el.exportProgress) el.exportProgress.hidden = false;
  setStatus(el.status, 'Rendering the shifted file offline…', 'idle');

  try {
    const rendered = await renderStretched({
      buffer: loaded.buffer,
      pitchRatio: pitchRatio(),
      tempoRatio: tempoRatio(),
      onProgress: (ratio) => {
        const pct = Math.round(ratio * 100);
        if (el.exportBar) el.exportBar.style.width = `${pct}%`;
        setText(el.exportPct, `${pct}%`);
        if (el.exportProgress) el.exportProgress.hidden = false;
      },
    });
    const blob = encodeWav(rendered);
    const tag = `${semitones >= 0 ? '+' : ''}${semitones}st${cents ? `${cents >= 0 ? '+' : ''}${cents}c` : ''}${maintainTempo ? '-tempo' : '-resample'}`;
    const base = (loaded.name.replace(/\.[^.]+$/, '') || 'audio') + `-pitch${tag}`;
    downloadBlob(blob, wavFilename(base));
    const seconds = rendered.length / rendered.sampleRate;
    setStatus(
      el.status,
      `Exported ${formatDuration(seconds)} · ${rendered.numberOfChannels === 1 ? 'mono' : 'stereo'} 16-bit PCM ${rendered.sampleRate} Hz · ${(blob.size / 1024).toFixed(0)} KB`,
      'ok',
    );
  } catch (error) {
    setStatus(el.status, `Export failed: ${(error as Error).message}`, 'error');
  } finally {
    el.export?.removeAttribute('aria-busy');
    if (el.exportProgress) el.exportProgress.hidden = true;
    if (el.exportBar) el.exportBar.style.width = '0%';
    setText(el.exportPct, '0%');
  }
});

/* ------------------------------------------------------------------ */
/* Initial state                                                       */
/* ------------------------------------------------------------------ */

if (el.semitoneNum) {
  if (el.cents) el.cents.setAttribute('aria-valuetext', '0 cents');
}
syncInputs();
renderReadouts();
renderTime(0, 0);
setTransport(false, false);
if (typeof AudioWorkletNode === 'undefined') {
  setText(el.engineBadge, 'unsupported');
  setStatus(el.status, 'This browser does not support AudioWorklet - the pitch shifter needs a recent Chrome, Edge, Firefox or Safari.', 'error');
}

// The header "Stop all" stops the engine's voices; keep the transport UI honest
// when that happens.
document.addEventListener('sg:stop-all', () => {
  player?.stop();
  setTransport(false, Boolean(loaded));
  waveform?.setPlayhead(0);
  if (loaded) renderTime(0, loaded.duration);
  setStatus(el.status, 'Stopped from the global control.', 'idle');
});
