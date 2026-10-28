/**
 * Multiple tone generator page wiring.
 *
 * Up to eight independent ToneVoices, each driven from one DOM row. The rows
 * are the source of truth for the configuration so that add / remove / preset /
 * share all work off the same read path. While the master transport is running,
 * editing a row retunes the live voice instead of restarting it.
 */

import { ensureContext, type Waveform } from '../lib/audio/engine';
import { ToneVoice } from '../lib/audio/voices';
import { describeFrequency, formatHz, roundTo } from '../lib/audio/notes';
import { mountScopes } from '../lib/audio/scope';
import {
  clamp,
  copyText,
  debounce,
  decodeShare,
  encodeShare,
  on,
  qs,
  qsa,
  setStatus,
  setText,
  setQueryParam,
} from '../lib/ui/dom';

const FREQ_MIN = 1;
const FREQ_MAX = 20000;
const MAX_VOICES = 8;
const MIN_VOICES = 1;
/** Never drive a raw oscillator above ~0.6 (contract §5) - eight voices sum into the limiter. */
const PER_VOICE_MAX = 0.6;

const WAVEFORMS: Waveform[] = ['sine', 'square', 'sawtooth', 'triangle'];

type VoiceConfig = {
  frequency: number;
  waveform: Waveform;
  /** 0..100 */
  level: number;
  /** -1..1 */
  pan: number;
  enabled: boolean;
};

const root = qs<HTMLElement>('#multi') ?? document.body;
const listEl = qs<HTMLElement>('[data-voice-list]', root) ?? root;
const statusEl = qs('[data-voice="status"]', root);
const playBtn = qs<HTMLButtonElement>('[data-voice="play"]', root);
const stopBtn = qs<HTMLButtonElement>('[data-voice="stop"]', root);
const addBtn = qs<HTMLButtonElement>('[data-voice="add"]', root);
const removeBtn = qs<HTMLButtonElement>('[data-voice="remove-voice"]', root);
const shareBtn = qs<HTMLButtonElement>('[data-voice="share"]', root);
const countEl = qs('[data-voice="count"]', root);
const freqListEl = qs('[data-voice="freq-list"]', root);

const rows = (): HTMLElement[] => qsa<HTMLElement>('[data-voice-row]', listEl);

/** Detached clone of the first server-rendered row - prototype for new voices. */
const proto = rows()[0]?.cloneNode(true) as HTMLElement | undefined;

/** row element -> running voice (only present while the master transport is on). */
const live = new Map<HTMLElement, ToneVoice>();
let playing = false;

/* ------------------------------------------------------------------ */
/* Reading and writing a row                                          */
/* ------------------------------------------------------------------ */

function gainFor(level: number): number {
  return PER_VOICE_MAX * (clamp(level, 0, 100) / 100);
}

function panLabel(value: number): string {
  if (value === 0) return 'C';
  return value < 0 ? `L${Math.abs(value)}` : `R${value}`;
}

function readConfig(row: HTMLElement): VoiceConfig {
  const raw = (qs<HTMLInputElement>('[data-voice="freq"]', row)?.value ?? '').trim().replace(',', '.');
  const n = Number(raw);
  return {
    frequency: Number.isFinite(n) ? n : NaN,
    waveform: (qs<HTMLSelectElement>('[data-voice="wave"]', row)?.value ?? 'sine') as Waveform,
    level: Number(qs<HTMLInputElement>('[data-voice="level"]', row)?.value ?? 60),
    pan: Number(qs<HTMLInputElement>('[data-voice="pan"]', row)?.value ?? 0) / 100,
    enabled: qs('[data-voice="toggle"]', row)?.getAttribute('aria-pressed') === 'true',
  };
}

function syncFill(input: HTMLInputElement | null): void {
  if (!input) return;
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value);
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}

function applyConfig(row: HTMLElement, cfg: VoiceConfig): void {
  const toggle = qs<HTMLButtonElement>('[data-voice="toggle"]', row);
  const freq = qs<HTMLInputElement>('[data-voice="freq"]', row);
  const wave = qs<HTMLSelectElement>('[data-voice="wave"]', row);
  const level = qs<HTMLInputElement>('[data-voice="level"]', row);
  const pan = qs<HTMLInputElement>('[data-voice="pan"]', row);

  if (toggle) toggle.setAttribute('aria-pressed', String(cfg.enabled));
  qs('[data-voice="led"]', row)?.setAttribute('data-on', cfg.enabled ? 'true' : 'false');
  if (freq) freq.value = Number.isInteger(cfg.frequency) ? String(cfg.frequency) : String(roundTo(cfg.frequency, 2));
  if (wave && WAVEFORMS.includes(cfg.waveform)) wave.value = cfg.waveform;
  if (level) level.value = String(clamp(Math.round(cfg.level), 0, 100));
  if (pan) pan.value = String(clamp(Math.round(cfg.pan * 100), -100, 100));
}

function refreshNote(row: HTMLElement): void {
  const cfg = readConfig(row);
  setText(qs('[data-voice="note"]', row), Number.isFinite(cfg.frequency) ? describeFrequency(cfg.frequency).name : ' - ');
}

function syncReads(row: HTMLElement): void {
  const level = qs<HTMLInputElement>('[data-voice="level"]', row);
  const pan = qs<HTMLInputElement>('[data-voice="pan"]', row);
  setText(qs('[data-voice="level-read"]', row), String(Math.round(Number(level?.value ?? 0))));
  setText(qs('[data-voice="pan-read"]', row), panLabel(Math.round(Number(pan?.value ?? 0))));
}

/* ------------------------------------------------------------------ */
/* Live voices                                                        */
/* ------------------------------------------------------------------ */

function startVoice(row: HTMLElement): void {
  const cfg = readConfig(row);
  if (!cfg.enabled || !Number.isFinite(cfg.frequency)) return;
  live.get(row)?.stop();
  const voice = new ToneVoice({
    frequency: clamp(cfg.frequency, FREQ_MIN, FREQ_MAX),
    waveform: cfg.waveform,
    gain: gainFor(cfg.level),
    pan: cfg.pan,
  });
  live.set(row, voice);
}

function stopLocal(): void {
  live.forEach((voice) => voice.stop());
  live.clear();
}

/* ------------------------------------------------------------------ */
/* Status / stats / transport                                         */
/* ------------------------------------------------------------------ */

function updateStats(): void {
  const cfgs = rows().map(readConfig);
  const enabled = cfgs.filter((c) => c.enabled && Number.isFinite(c.frequency));
  const playingFreqs = rows()
    .filter((row) => live.has(row))
    .map((row) => readConfig(row).frequency)
    .filter((f) => Number.isFinite(f));

  if (playing) {
    setText(countEl, `${playingFreqs.length} voice${playingFreqs.length === 1 ? '' : 's'} playing`);
  } else {
    setText(countEl, `${enabled.length} of ${cfgs.length} voices enabled`);
  }

  const list = (playing ? playingFreqs : enabled.map((c) => c.frequency)).filter((f) => Number.isFinite(f));
  setText(freqListEl, list.length ? list.map((f) => formatHz(f)).join(' · ') : ' - ');
}

function updateTransport(): void {
  if (playBtn) {
    playBtn.setAttribute('aria-pressed', String(playing));
    playBtn.setAttribute('data-state', playing ? 'on' : 'off');
  }
  if (stopBtn) stopBtn.disabled = !playing;
}

/* ------------------------------------------------------------------ */
/* Transport actions                                                  */
/* ------------------------------------------------------------------ */

function play(): void {
  const cfgs = rows().map(readConfig);
  const enabled = cfgs.filter((c) => c.enabled);
  if (enabled.length === 0) {
    setStatus(statusEl, 'No voices are enabled. Turn one on to play.', 'warn');
    return;
  }
  const bad = enabled.find((c) => !Number.isFinite(c.frequency) || c.frequency < FREQ_MIN || c.frequency > FREQ_MAX);
  if (bad) {
    setStatus(statusEl, `Each voice needs a frequency between ${FREQ_MIN} and ${FREQ_MAX} Hz.`, 'error');
    return;
  }

  ensureContext();
  stopLocal();
  rows().forEach((row) => {
    if (readConfig(row).enabled) startVoice(row);
  });
  playing = true;
  updateTransport();
  updateStats();
  setStatus(
    statusEl,
    `Playing ${enabled.length} voice${enabled.length === 1 ? '' : 's'} - ${enabled.map((c) => formatHz(c.frequency)).join(' · ')}`,
    'ok',
  );
}

function stop(): void {
  stopLocal();
  playing = false;
  updateTransport();
  updateStats();
  setStatus(statusEl, 'Stopped.', 'idle');
}

/* ------------------------------------------------------------------ */
/* Row wiring                                                         */
/* ------------------------------------------------------------------ */

function wireRow(row: HTMLElement): void {
  const toggle = qs<HTMLButtonElement>('[data-voice="toggle"]', row);
  const freqInput = qs<HTMLInputElement>('[data-voice="freq"]', row);
  const waveSel = qs<HTMLSelectElement>('[data-voice="wave"]', row);
  const level = qs<HTMLInputElement>('[data-voice="level"]', row);
  const levelRead = qs('[data-voice="level-read"]', row);
  const pan = qs<HTMLInputElement>('[data-voice="pan"]', row);
  const panRead = qs('[data-voice="pan-read"]', row);
  const remove = qs<HTMLButtonElement>('[data-voice="remove"]', row);

  syncFill(level);
  syncFill(pan);
  refreshNote(row);
  syncReads(row);

  on(freqInput, 'input', () => {
    refreshNote(row);
    const cfg = readConfig(row);
    const voice = live.get(row);
    if (voice && Number.isFinite(cfg.frequency)) voice.setFrequency(clamp(cfg.frequency, FREQ_MIN, FREQ_MAX));
    updateURLSoon();
    updateStats();
  });

  on(waveSel, 'change', () => {
    live.get(row)?.setWaveform(readConfig(row).waveform);
    updateURLSoon();
  });

  on(level, 'input', () => {
    syncFill(level);
    const cfg = readConfig(row);
    setText(levelRead, String(Math.round(cfg.level)));
    live.get(row)?.setGain(gainFor(cfg.level));
    updateURLSoon();
  });

  on(pan, 'input', () => {
    syncFill(pan);
    const cfg = readConfig(row);
    setText(panRead, panLabel(Math.round(cfg.pan * 100)));
    live.get(row)?.setPan(cfg.pan);
    updateURLSoon();
  });

  on(toggle, 'click', () => {
    const next = toggle?.getAttribute('aria-pressed') !== 'true';
    toggle?.setAttribute('aria-pressed', String(next));
    qs('[data-voice="led"]', row)?.setAttribute('data-on', next ? 'true' : 'false');
    if (playing) {
      if (next && !live.has(row)) startVoice(row);
      else if (!next && live.has(row)) {
        live.get(row)?.stop();
        live.delete(row);
      }
    }
    updateStats();
    updateURLSoon();
  });

  on(remove, 'click', () => removeRow(row));
}

function syncIndices(): void {
  rows().forEach((row, i) => {
    const n = i + 1;
    setText(qs('[data-voice="index"]', row), String(n));
    setText(qs('.voice-freq__field .visually-hidden', row), `Voice ${n} frequency in hertz`);
    setText(qs('.voice-wave .visually-hidden', row), `Voice ${n} waveform`);
    qs<HTMLInputElement>('[data-voice="level"]', row)?.setAttribute('aria-label', `Voice ${n} level, percent`);
    qs<HTMLInputElement>('[data-voice="pan"]', row)?.setAttribute('aria-label', `Voice ${n} stereo pan`);
    qs<HTMLButtonElement>('[data-voice="toggle"]', row)?.setAttribute('aria-label', `Voice ${n} enable toggle`);
    qs<HTMLButtonElement>('[data-voice="remove"]', row)?.setAttribute('aria-label', `Remove voice ${n}`);
  });
}

function addRow(cfg?: Partial<VoiceConfig>): void {
  if (rows().length >= MAX_VOICES) {
    setStatus(statusEl, `Maximum of ${MAX_VOICES} voices.`, 'warn');
    return;
  }
  if (!proto) return;
  const index = rows().length;
  const node = proto.cloneNode(true) as HTMLElement;
  applyConfig(node, {
    frequency: cfg?.frequency ?? 440 + index * 220,
    waveform: cfg?.waveform ?? 'sine',
    level: cfg?.level ?? 60,
    pan: cfg?.pan ?? 0,
    enabled: cfg?.enabled ?? true,
  });
  listEl.appendChild(node);
  wireRow(node);
  syncIndices();
  updateStats();
  updateURLSoon();
}

function removeRow(row: HTMLElement): void {
  if (rows().length <= MIN_VOICES) {
    setStatus(statusEl, 'At least one voice is required.', 'warn');
    return;
  }
  live.get(row)?.stop();
  live.delete(row);
  row.remove();
  syncIndices();
  updateStats();
  updateURLSoon();
}

function setVoices(list: VoiceConfig[]): void {
  stop();
  rows().forEach((row) => row.remove());
  list.slice(0, MAX_VOICES).forEach((cfg) => addRow(cfg));
  syncIndices();
  updateStats();
}

/* ------------------------------------------------------------------ */
/* Presets                                                            */
/* ------------------------------------------------------------------ */

function voice(frequency: number, level = 60): VoiceConfig {
  return { frequency, waveform: 'sine', level, pan: 0, enabled: true };
}

const PRESETS: Record<string, { voices: VoiceConfig[]; note: string }> = {
  octave: {
    voices: [voice(440), voice(880), voice(1320), voice(1760)],
    note: 'Octave stack - 440, 880, 1320 and 1760 Hz, four harmonics of the same note.',
  },
  major: {
    voices: [voice(261.63), voice(329.63), voice(392.0)],
    note: 'Major triad - C4, E4, G4 (261.63 / 329.63 / 392 Hz).',
  },
  minor: {
    voices: [voice(261.63), voice(311.13), voice(392.0)],
    note: 'Minor triad - C4, E♭4, G4 (261.63 / 311.13 / 392 Hz).',
  },
  fifth: {
    voices: [voice(440), voice(660)],
    note: 'Perfect fifth - 440 and 660 Hz, a 3:2 ratio.',
  },
  beat: {
    voices: [voice(440), voice(441)],
    note: 'Beating pair - 440 and 441 Hz differ by 1 Hz, so the loudness swells once per second. That slow pulse is the beat.',
  },
  harmonic: {
    voices: [voice(110), voice(220), voice(330), voice(440)],
    note: 'Harmonic series - 110, 220, 330 and 440 Hz, the first four harmonics of 110 Hz.',
  },
};

qsa<HTMLButtonElement>('[data-preset]', root).forEach((button) => {
  on(button, 'click', () => {
    const key = button.dataset.preset ?? '';
    const preset = PRESETS[key];
    if (!preset) return;
    setVoices(preset.voices);
    setStatus(statusEl, preset.note, 'ok');
  });
});

/* ------------------------------------------------------------------ */
/* Share / restore                                                    */
/* ------------------------------------------------------------------ */

const currentConfigs = (): VoiceConfig[] =>
  rows()
    .map(readConfig)
    .filter((c) => Number.isFinite(c.frequency));

const updateURLSoon = debounce(() => {
  const cfgs = currentConfigs();
  try {
    setQueryParam('v', cfgs.length ? encodeShare(cfgs) : null);
  } catch {
    /* storage/URL unavailable - sharing just won't persist */
  }
}, 350);

on(shareBtn, 'click', async () => {
  const url = new URL(window.location.href);
  url.searchParams.set('v', encodeShare(currentConfigs()));
  const ok = await copyText(url.toString());
  setStatus(statusEl, ok ? 'Share link copied to the clipboard.' : url.toString(), ok ? 'ok' : 'warn');
});

function normalize(cfg: Partial<VoiceConfig> | null | undefined): VoiceConfig {
  const freq = Number(cfg?.frequency);
  return {
    frequency: Number.isFinite(freq) ? freq : 440,
    waveform: WAVEFORMS.includes(cfg?.waveform as Waveform) ? (cfg!.waveform as Waveform) : 'sine',
    level: clamp(Number(cfg?.level ?? 60), 0, 100),
    pan: clamp(Number(cfg?.pan ?? 0), -1, 1),
    enabled: cfg?.enabled !== false,
  };
}

/* ------------------------------------------------------------------ */
/* Buttons + startup                                                  */
/* ------------------------------------------------------------------ */

on(playBtn, 'click', () => play());
on(stopBtn, 'click', () => stop());
on(addBtn, 'click', () => addRow());
on(removeBtn, 'click', () => {
  const r = rows();
  if (r.length) removeRow(r[r.length - 1]);
});

// Escape always silences the page (contract §6).
on(document, 'keydown', (event) => {
  if (event.key === 'Escape') stop();
});

// Global "Stop all" fired by the shared header transport.
document.addEventListener('sg:stop-all', () => {
  live.clear();
  playing = false;
  updateTransport();
  updateStats();
});

// Wire the server-rendered rows, then restore a shared configuration if present.
rows().forEach((row) => wireRow(row));
syncIndices();
updateTransport();
updateStats();

const shared = new URLSearchParams(window.location.search).get('v');
if (shared) {
  const decoded = decodeShare<VoiceConfig[] | null>(shared, null);
  if (Array.isArray(decoded) && decoded.length) {
    setVoices(decoded.slice(0, MAX_VOICES).map(normalize));
    setStatus(statusEl, 'Loaded a shared voice configuration.', 'ok');
  }
}

mountScopes(root);
