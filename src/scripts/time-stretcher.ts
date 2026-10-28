/**
 * Time Stretcher page wiring.
 *
 * Drives the shared WSOLA engine (stretch-engine.ts) with
 *   tempoRatio = tempo            (0.25× … 4×)
 *   pitchRatio = 1                (Preserve pitch ON  → length changes only)
 *   pitchRatio = tempo            (Preserve pitch OFF → plain resample / varispeed)
 * and exports the offline render as a 16-bit WAV.
 */

import {
  createStretchPlayer,
  createWaveformView,
  formatDuration,
  formatClock,
  loadAudioFile,
  renderStretched,
  type LoadedAudio,
  type StretchPlayer,
} from '../lib/tools/stretch-engine';
import { encodeWav, downloadBlob, wavFilename } from '../lib/audio/wav';
import { qs, qsa, on, clamp, setStatus, setText } from '../lib/ui/dom';

const TEMPO_MIN = 0.25;
const TEMPO_MAX = 4;

const el = {
  file: qs<HTMLInputElement>('[data-ts="file"]'),
  drop: qs<HTMLElement>('[data-ts="drop"]') ?? qs<HTMLElement>('#ts-drop'),
  wave: qs<HTMLCanvasElement>('[data-ts="wave"]'),
  name: qs('[data-ts="name"]'),
  duration: qs('[data-ts="duration"]'),
  rate: qs('[data-ts="rate"]'),
  channels: qs('[data-ts="channels"]'),
  time: qs('[data-ts="time"]'),
  play: qs<HTMLButtonElement>('[data-ts="play"]'),
  pause: qs<HTMLButtonElement>('[data-ts="pause"]'),
  stop: qs<HTMLButtonElement>('[data-ts="stop"]'),
  export: qs<HTMLButtonElement>('[data-ts="export"]'),
  exportProgress: qs<HTMLElement>('[data-ts="export-progress"]'),
  exportBar: qs<HTMLElement>('[data-ts="export-bar"]'),
  exportPct: qs('[data-ts="export-pct"]'),
  status: qs('[data-ts="status"]'),
  engineBadge: qs('[data-ts="engine-badge"]'),

  tempo: qs<HTMLInputElement>('[data-ts="tempo"]'),
  tempoNum: qs<HTMLInputElement>('[data-ts="tempo-num"]'),
  tempoPct: qs('[data-ts="tempo-pct"]'),
  preserve: qs<HTMLButtonElement>('[data-ts="preserve"]'),
  pitchHelp: qs('[data-ts="pitch-help"]'),
  loopToggle: qs<HTMLButtonElement>('[data-ts="loop"]'),
  loopReset: qs<HTMLButtonElement>('[data-ts="loop-reset"]'),
  loopStart: qs('[data-ts="loop-start"]'),
  loopEnd: qs('[data-ts="loop-end"]'),
  loopLen: qs('[data-ts="loop-len"]'),
  srclen: qs('[data-ts="srclen"]'),
  outlen: qs('[data-ts="outlen"]'),
  pitchratio: qs('[data-ts="pitchratio"]'),
  temporatio: qs('[data-ts="temporatio"]'),
};

let loaded: LoadedAudio | null = null;
let player: StretchPlayer | null = null;
let tempo = 1;
let preservePitch = true;
let loopEnabled = false;
let loopStart = 0;
let loopEnd = 0;
let playerPromise: Promise<void> | null = null;

const waveform = el.wave
  ? createWaveformView(el.wave, {
      loop: true,
      onSeek: (seconds) => {
        if (!loaded) return;
        player?.seek(seconds);
        waveform?.setPlayhead(seconds);
        renderTime(seconds, loaded.duration);
      },
      onLoopChange: (start, end) => {
        loopStart = start;
        loopEnd = end;
        applyLoop();
        renderLoop();
      },
    })
  : null;

/* ------------------------------------------------------------------ */
/* Derived values                                                      */
/* ------------------------------------------------------------------ */

function pitchRatio(): number {
  return preservePitch ? 1 : tempo;
}

function outputLength(): number {
  return loaded ? loaded.duration / tempo : 0;
}

function renderTime(position: number, duration: number): void {
  if (!Number.isFinite(duration) || duration <= 0) {
    setText(el.time, ' - / - ');
    return;
  }
  setText(el.time, `${formatDuration(position)} / ${formatDuration(duration)} · at ${tempo.toFixed(2)}× → ${formatDuration(duration / tempo)}`);
}

function renderLoop(): void {
  if (!loaded) {
    setText(el.loopStart, ' - ');
    setText(el.loopEnd, ' - ');
    setText(el.loopLen, ' - ');
    return;
  }
  setText(el.loopStart, formatDuration(loopStart));
  setText(el.loopEnd, formatDuration(loopEnd));
  setText(el.loopLen, formatDuration(Math.max(0, loopEnd - loopStart)));
}

function renderReadouts(): void {
  setText(el.tempoPct, `${Math.round(tempo * 100)} %`);
  setText(el.srclen, loaded ? formatDuration(loaded.duration) : ' - ');
  setText(el.outlen, loaded ? formatDuration(outputLength()) : ' - ');
  setText(el.pitchratio, pitchRatio().toFixed(4));
  setText(el.temporatio, tempo.toFixed(4));
  if (el.tempoNum && document.activeElement !== el.tempoNum) el.tempoNum.value = String(round2(tempo));
  if (el.tempo && document.activeElement !== el.tempo) el.tempo.value = String(tempo);

  // Preset durations and the active preset highlight.
  qsa<HTMLButtonElement>('[data-ts="preset"]').forEach((button) => {
    const value = Number(button.dataset.value);
    button.setAttribute('aria-pressed', String(Math.abs(value - tempo) < 0.001));
    const dur = button.querySelector<HTMLElement>('[data-ts="preset-dur"]');
    if (dur) setText(dur, loaded ? formatClock(loaded.duration / value) : ' - : - ');
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function renderToggles(): void {
  if (el.preserve) {
    el.preserve.setAttribute('aria-pressed', String(preservePitch));
    const led = el.preserve.querySelector('.led');
    if (led) led.setAttribute('data-on', String(preservePitch));
  }
  if (el.loopToggle) {
    el.loopToggle.setAttribute('aria-pressed', String(loopEnabled));
    const led = el.loopToggle.querySelector('.led');
    if (led) led.setAttribute('data-on', String(loopEnabled));
  }
  if (el.pitchHelp) {
    el.pitchHelp.textContent = preservePitch
      ? 'On - overlap-add resynthesis changes the length only; the pitch stays put.'
      : 'Off - plain playback-rate change: the pitch moves with the tempo (chipmunk effect).';
  }
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
  if (el.loopReset) el.loopReset.disabled = !hasFile;
}

function applyRatios(): void {
  if (!player) return;
  player.setTempoRatio(tempo);
  player.setPitchRatio(pitchRatio());
}

function applyLoop(): void {
  if (!player) return;
  if (loopEnabled && loopEnd > loopStart) player.setLoop(loopStart, loopEnd);
  else player.setLoop(0, 0);
}

async function buildPlayer(): Promise<void> {
  if (!loaded) return;
  const audio = loaded;
  try {
    player?.dispose();
    const created = await createStretchPlayer({
      buffer: audio.buffer,
      pitchRatio: pitchRatio(),
      tempoRatio: tempo,
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
    applyLoop();
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
    loopStart = 0;
    loopEnd = audio.duration;
    waveform?.setBuffer(audio.buffer);
    waveform?.setLoop(0, audio.duration);
    waveform?.setPlayhead(0);
    renderTime(0, audio.duration);
    renderLoop();
    renderReadouts();
    setTransport(false, true);
    setStatus(
      el.status,
      `Loaded · ${formatDuration(audio.duration)} · at ${tempo.toFixed(2)}× the result is ${formatDuration(outputLength())}. Preparing the engine…`,
      'ok',
    );
    playerPromise = ensurePlayer().then(() => {
      if (loaded === audio) {
        setStatus(
          el.status,
          `Ready · ${formatDuration(audio.duration)} · at ${tempo.toFixed(2)}× the result is ${formatDuration(outputLength())}. Press play.`,
          'ok',
        );
      }
    });
  } catch (error) {
    loaded = null;
    player?.dispose();
    player = null;
    playerPromise = null;
    setText(el.engineBadge, 'error');
    waveform?.setBuffer(null);
    waveform?.setLoop(null, null);
    setTransport(false, false);
    renderReadouts();
    renderLoop();
    setStatus(el.status, `Could not decode that file: ${(error as Error).message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

function setTempo(value: number): void {
  tempo = clamp(Math.round(value * 100) / 100, TEMPO_MIN, TEMPO_MAX);
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
on(document, 'dragover', (event) => event.preventDefault());
on(document, 'drop', (event) => event.preventDefault());

on(el.tempo, 'input', () => setTempo(Number(el.tempo?.value ?? 1)));
on(el.tempoNum, 'input', () => {
  const value = Number(el.tempoNum?.value);
  if (Number.isFinite(value)) setTempo(value);
});

qsa<HTMLButtonElement>('[data-ts="preset"]').forEach((button) => {
  on(button, 'click', () => {
    setTempo(Number(button.dataset.value ?? 1));
    if (loaded) {
      setStatus(el.status, `${tempo.toFixed(2)}× - result length ${formatDuration(outputLength())}.`, 'idle');
    }
  });
});

on(el.preserve, 'click', () => {
  preservePitch = !preservePitch;
  renderToggles();
  renderReadouts();
  applyRatios();
  setStatus(
    el.status,
    preservePitch
      ? 'Preserve pitch on - the tempo changes, the key stays put.'
      : 'Preserve pitch off - resampling: the pitch moves with the tempo.',
    'idle',
  );
});

on(el.loopToggle, 'click', () => {
  loopEnabled = !loopEnabled;
  renderToggles();
  applyLoop();
  if (!loaded) return;
  setStatus(
    el.status,
    loopEnabled
      ? `Looping ${formatDuration(loopStart)} → ${formatDuration(loopEnd)}.`
      : 'Loop off - playback runs to the end.',
    'idle',
  );
});

on(el.loopReset, 'click', () => {
  if (!loaded) return;
  loopStart = 0;
  loopEnd = loaded.duration;
  waveform?.setLoop(0, loaded.duration);
  applyLoop();
  renderLoop();
});

on(el.play, 'click', async () => {
  await ensurePlayer();
  if (!player) return;
  player.play();
  setTransport(true, true);
  setStatus(
    el.status,
    `Playing at ${tempo.toFixed(2)}×${preservePitch ? ' · pitch preserved' : ' · pitch shifts with tempo'}`,
    'ok',
  );
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
  setStatus(el.status, 'Rendering the stretched file offline…', 'idle');

  try {
    const rendered = await renderStretched({
      buffer: loaded.buffer,
      pitchRatio: pitchRatio(),
      tempoRatio: tempo,
      onProgress: (ratio) => {
        const pct = Math.round(ratio * 100);
        if (el.exportBar) el.exportBar.style.width = `${pct}%`;
        setText(el.exportPct, `${pct}%`);
        if (el.exportProgress) el.exportProgress.hidden = false;
      },
    });
    const blob = encodeWav(rendered);
    const tag = `${tempo.toFixed(2)}x${preservePitch ? '-pitch' : '-resample'}`;
    const base = (loaded.name.replace(/\.[^.]+$/, '') || 'audio') + `-tempo${tag}`;
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

renderReadouts();
renderToggles();
renderLoop();
renderTime(0, 0);
setTransport(false, false);
if (typeof AudioWorkletNode === 'undefined') {
  setText(el.engineBadge, 'unsupported');
  setStatus(el.status, 'This browser does not support AudioWorklet - the time stretcher needs a recent Chrome, Edge, Firefox or Safari.', 'error');
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
