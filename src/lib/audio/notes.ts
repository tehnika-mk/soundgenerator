/**
 * Musical maths: frequency <-> note conversion and the reference tables the
 * tuning / presets / hearing-test tools are built from.
 *
 * All values are equal temperament against a configurable A4 reference
 * (440 Hz concert pitch, 432 Hz "Verdi" tuning, 435, 415 baroque ...).
 */

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
export type NoteName = (typeof NOTE_NAMES)[number];

export const A4_REFERENCE_PRESETS = [
  { hz: 440, label: 'A4 = 440 Hz', detail: 'Standard concert pitch (ISO 16)' },
  { hz: 432, label: 'A4 = 432 Hz', detail: 'Popular alternative tuning' },
  { hz: 435, label: 'A4 = 435 Hz', detail: 'French diapason normal, 1859' },
  { hz: 415, label: 'A4 = 415 Hz', detail: 'Baroque pitch' },
] as const;

export type NoteInfo = {
  /** e.g. "A4" */
  name: string;
  /** Scientific pitch notation octave */
  octave: number;
  midi: number;
  /** Signed deviation from the nearest equal-tempered note, in cents (-50..50) */
  cents: number;
  /** Frequency of the nearest note */
  targetHz: number;
};

export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function freqToMidi(freq: number, a4 = 440): number {
  return 69 + 12 * Math.log2(freq / a4);
}

export function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export function noteLabel(midi: number): string {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

/** Nearest note plus the cents deviation for a given frequency. */
export function describeFrequency(freq: number, a4 = 440): NoteInfo {
  if (!Number.isFinite(freq) || freq <= 0) {
    return { name: ' - ', octave: 0, midi: 0, cents: 0, targetHz: 0 };
  }
  const exact = freqToMidi(freq, a4);
  const midi = Math.round(exact);
  const cents = Math.round((exact - midi) * 100);
  return {
    name: noteLabel(midi),
    octave: Math.floor(midi / 12) - 1,
    midi,
    cents,
    targetHz: roundTo(midiToFreq(midi, a4), 2),
  };
}

export function centsLabel(cents: number): string {
  if (cents === 0) return 'in tune';
  return `${cents > 0 ? '+' : ''}${cents} ¢`;
}

/** Frequency range guard used by every generator on the site. */
export const FREQ_MIN = 1;
export const FREQ_MAX = 20000;

export function isValidFrequency(value: unknown): boolean {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= FREQ_MIN && n <= FREQ_MAX;
}

export function formatHz(freq: number): string {
  if (!Number.isFinite(freq)) return ' - ';
  if (freq >= 1000) {
    const k = freq / 1000;
    return `${k.toFixed(k < 10 ? 3 : 2)} kHz`;
  }
  return `${freq.toFixed(freq < 10 ? 3 : 1)} Hz`;
}

export function formatFrequencyInput(freq: number): string {
  if (!Number.isFinite(freq)) return '';
  return Number.isInteger(freq) ? String(freq) : String(roundTo(freq, 2));
}

/* ------------------------------------------------------------------ */
/* Instrument tuning tables (MIDI note numbers)                        */
/* ------------------------------------------------------------------ */

export type TuningString = { midi: number; label: string };
export type Instrument = {
  id: string;
  name: string;
  strings: TuningString[];
  note?: string;
};

function strings(...midis: number[]): TuningString[] {
  return midis.map((midi) => ({ midi, label: noteLabel(midi) }));
}

export const INSTRUMENTS: Instrument[] = [
  { id: 'guitar', name: 'Guitar (standard EADGBE)', strings: strings(40, 45, 50, 55, 59, 64) },
  { id: 'guitar-drop-d', name: 'Guitar (drop D)', strings: strings(38, 45, 50, 55, 59, 64) },
  { id: 'guitar-half-step', name: 'Guitar (half step down)', strings: strings(39, 44, 49, 54, 58, 63) },
  { id: 'bass-4', name: 'Bass guitar (4-string EADG)', strings: strings(28, 33, 38, 43) },
  { id: 'bass-5', name: 'Bass guitar (5-string BEADG)', strings: strings(23, 28, 33, 38, 43) },
  { id: 'ukulele', name: 'Ukulele (GCEA, high G)', strings: strings(67, 60, 64, 69) },
  { id: 'ukulele-low-g', name: 'Ukulele (GCEA, low G)', strings: strings(55, 60, 64, 69) },
  { id: 'violin', name: 'Violin (GDAE)', strings: strings(55, 62, 69, 76) },
  { id: 'viola', name: 'Viola (CGDA)', strings: strings(48, 55, 62, 69) },
  { id: 'cello', name: 'Cello (CGDA)', strings: strings(36, 43, 50, 57) },
  { id: 'double-bass', name: 'Double bass (EADG)', strings: strings(28, 33, 38, 43) },
  { id: 'mandolin', name: 'Mandolin (GDAE)', strings: strings(55, 62, 69, 76) },
  { id: 'banjo-5', name: 'Banjo (5-string open G)', strings: strings(67, 50, 55, 59, 62) },
  { id: 'chromatic', name: 'Chromatic reference (C4–B4)', strings: strings(60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71) },
];

/* ------------------------------------------------------------------ */
/* Practical reference frequencies                                     */
/* ------------------------------------------------------------------ */

export type Preset = { label: string; hz: number; note?: string };

export const COMMON_PRESETS: Preset[] = [
  { label: '20 Hz', hz: 20, note: 'sub-bass limit' },
  { label: '30 Hz', hz: 30, note: 'subwoofer' },
  { label: '50 Hz', hz: 50, note: 'mains hum (EU)' },
  { label: '60 Hz', hz: 60, note: 'mains hum (US)' },
  { label: '100 Hz', hz: 100, note: 'bass punch' },
  { label: '440 Hz', hz: 440, note: 'A4 concert' },
  { label: '432 Hz', hz: 432, note: 'alt. A4' },
  { label: '1 kHz', hz: 1000, note: 'reference' },
  { label: '2 kHz', hz: 2000, note: 'presence' },
  { label: '4 kHz', hz: 4000, note: 'intelligibility' },
  { label: '8 kHz', hz: 8000, note: 'brilliance' },
  { label: '10 kHz', hz: 10000, note: 'HF test' },
  { label: '14 kHz', hz: 14000, note: 'HF limit test' },
  { label: '17.4 kHz', hz: 17400, note: 'mosquito tone' },
  { label: '20 kHz', hz: 20000, note: 'audible limit' },
];

/** Audiometric test frequencies (extended high-frequency audiometry). */
export const HEARING_TEST_FREQUENCIES = [
  125, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000,
];

/** Subwoofer / low-frequency test steps. */
export const SUBWOOFER_STEPS = [16, 20, 25, 30, 35, 40, 50, 60, 70, 80, 90, 100, 120, 150, 200];

/** Binaural beat bands. */
export const BINAURAL_BANDS = [
  { id: 'delta', label: 'Delta', range: '0.5 – 4 Hz', hz: 2, detail: 'Deep sleep, 0.5–4 Hz' },
  { id: 'theta', label: 'Theta', range: '4 – 8 Hz', hz: 6, detail: 'Drowsiness, meditation, 4–8 Hz' },
  { id: 'alpha', label: 'Alpha', range: '8 – 13 Hz', hz: 10, detail: 'Relaxed wakefulness, 8–13 Hz' },
  { id: 'beta', label: 'Beta', range: '13 – 30 Hz', hz: 18, detail: 'Alert focus, 13–30 Hz' },
  { id: 'gamma', label: 'Gamma', range: '30 – 50 Hz', hz: 40, detail: 'High-level processing, 30–50 Hz' },
] as const;

/** Standard DTMF telephone keypad (row/column frequencies in Hz). */
export const DTMF_ROWS = [697, 770, 852, 941];
export const DTMF_COLS = [1209, 1336, 1477, 1633];
export const DTMF_KEYPAD: { key: string; row: number; col: number }[] = [
  { key: '1', row: 0, col: 0 }, { key: '2', row: 0, col: 1 }, { key: '3', row: 0, col: 2 }, { key: 'A', row: 0, col: 3 },
  { key: '4', row: 1, col: 0 }, { key: '5', row: 1, col: 1 }, { key: '6', row: 1, col: 2 }, { key: 'B', row: 1, col: 3 },
  { key: '7', row: 2, col: 0 }, { key: '8', row: 2, col: 1 }, { key: '9', row: 2, col: 2 }, { key: 'C', row: 2, col: 3 },
  { key: '*', row: 3, col: 0 }, { key: '0', row: 3, col: 1 }, { key: '#', row: 3, col: 2 }, { key: 'D', row: 3, col: 3 },
];

export function dtmfFrequencies(key: string): [number, number] | null {
  const entry = DTMF_KEYPAD.find((item) => item.key === key);
  if (!entry) return null;
  return [DTMF_ROWS[entry.row], DTMF_COLS[entry.col]];
}

/** Named telephony signalling tones. */
export const TELEPHONY_TONES = [
  { id: 'dial', label: 'Dial tone (US)', a: 350, b: 440, detail: 'Continuous 350 + 440 Hz' },
  { id: 'ringback', label: 'Ringback (US)', a: 440, b: 480, detail: '440 + 480 Hz, 2 s on / 4 s off' },
  { id: 'busy', label: 'Busy signal (US)', a: 480, b: 620, detail: '480 + 620 Hz, 0.5 s on / 0.5 s off' },
  { id: 'special', label: 'Special information (SIT)', a: 985, b: 1428, detail: 'Intercept tone, 985 + 1428 Hz' },
  { id: 'uk-dial', label: 'Dial tone (UK)', a: 350, b: 450, detail: 'Continuous 350 + 450 Hz' },
  { id: 'uk-busy', label: 'Busy (UK)', a: 400, b: 450, detail: '400 + 450 Hz, 0.375 s on / 0.375 s off' },
] as const;

/** BBC-style "pips" time signal: six 1000 Hz pips, last one sustained. */
export const PIPS = {
  frequency: 1000,
  short: 0.1,
  long: 0.5,
  gap: 0.9,
} as const;

/** Alarm generator patterns. */
export const ALARM_PATTERNS = [
  { id: 'beep', label: 'Beep', detail: 'Short pulses of one tone' },
  { id: 'double', label: 'Double beep', detail: 'Two pulses per cycle' },
  { id: 'siren', label: 'Siren', detail: 'Smooth rise and fall between two tones' },
  { id: 'warble', label: 'Warble / urgent', detail: 'Fast alternation between two tones' },
  { id: 'continuous', label: 'Continuous', detail: 'Uninterrupted tone' },
  { id: 'pulse-train', label: 'Pulse train', detail: 'Fast stutter bursts' },
] as const;

export type AlarmPattern = (typeof ALARM_PATTERNS)[number]['id'];

/** Human labels for the four oscillator waveforms. */
export const WAVEFORMS_LABEL = {
  sine: 'Sine',
  square: 'Square',
  sawtooth: 'Sawtooth',
  triangle: 'Triangle',
} as const;


/** Note-offset keyboard A4 row used by the piano strip (one octave + fifth). */
export function octaveKeys(octave = 4, a4 = 440): { midi: number; label: string; freq: number; black: boolean }[] {
  const startMidi = (octave + 1) * 12; // C of the given octave
  const keys: { midi: number; label: string; freq: number; black: boolean }[] = [];
  for (let i = 0; i < 17; i++) {
    const midi = startMidi + i;
    const name = NOTE_NAMES[midi % 12];
    keys.push({
      midi,
      label: `${name}${Math.floor(midi / 12) - 1}`,
      freq: roundTo(midiToFreq(midi, a4), 2),
      black: name.includes('#'),
    });
  }
  return keys;
}
