/**
 * Hearing-test page.
 *
 * Walks through the audiometric frequency list, sounds a pure sine tone at a
 * user-chosen attenuation below a fixed, deliberately low safety ceiling, and
 * records a heard / not-heard verdict per frequency. Results are kept in
 * localStorage so a reload does not lose them, and can be exported as CSV or
 * copied as a plain-text summary.
 *
 * This is an informal, self-guided sweep - not a calibrated audiogram.
 */

import { ensureContext, clamp } from '../lib/audio/engine';
import { ToneVoice } from '../lib/audio/voices';
import { HEARING_TEST_FREQUENCIES } from '../lib/audio/notes';
import { downloadBlob } from '../lib/audio/wav';
import { mountScopes } from '../lib/audio/scope';
import { copyText, on, qs, qsa, setStatus, setText, bindSliderFill } from '../lib/ui/dom';

const STORAGE_KEY = 'sg.hearing.v1';
/** Fixed safe ceiling, in dBFS, relative to full scale. */
const CEILING_DB = -18;
const FREQS = HEARING_TEST_FREQUENCIES;

type Verdict = 'heard' | 'not-heard';
type Result = { verdict: Verdict; db: number };
type Saved = { version: number; attenuation: number; duration: number; index: number; results: Record<string, Result> };

/** Compact label: 125 Hz, 8 kHz, 17.4 kHz. */
const hzLabel = (hz: number): string => (hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz` : `${hz} Hz`);

const root = qs<HTMLElement>('[data-ht="root"]') ?? document.body;
const els = {
  freqValue: qs('[data-ht="freq-value"]', root),
  freqIndex: qs('[data-ht="freq-index"]', root),
  progress: qs('[data-ht="progress"]', root),
  bar: qs('[data-ht="bar-fill"]', root),
  level: qs<HTMLInputElement>('[data-ht="level"]', root),
  levelOut: qs('[data-ht="level-out"]', root),
  duration: qs<HTMLSelectElement>('[data-ht="duration"]', root),
  play: qs<HTMLButtonElement>('[data-ht="play"]', root),
  stop: qs<HTMLButtonElement>('[data-ht="stop"]', root),
  heard: qs<HTMLButtonElement>('[data-ht="heard"]', root),
  cannot: qs<HTMLButtonElement>('[data-ht="cannot"]', root),
  status: qs('[data-ht="status"]', root),
  rows: qs<HTMLElement>('[data-ht="rows"]', root),
  summary: qs('[data-ht="summary"]', root),
  csv: qs<HTMLButtonElement>('[data-ht="csv"]', root),
  copy: qs<HTMLButtonElement>('[data-ht="copy"]', root),
  restart: qs<HTMLButtonElement>('[data-ht="restart"]', root),
  clear: qs<HTMLButtonElement>('[data-ht="clear"]', root),
};

let index = 0;
let attenuation = 12; // dB of attenuation (positive magnitude, shown negative)
let duration = 3; // seconds
let results: Record<string, Result> = {};
let voice: ToneVoice | null = null;
let autoStop = 0;

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

function persist(): void {
  try {
    const payload: Saved = { version: 1, attenuation, duration, index, results };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* storage unavailable - results simply will not survive a reload */
  }
}

function restore(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<Saved>;
    if (parsed.version !== 1) return;
    if (typeof parsed.attenuation === 'number') attenuation = clamp(parsed.attenuation, 0, 60);
    if (typeof parsed.duration === 'number') duration = clamp(parsed.duration, 1, 30);
    if (typeof parsed.index === 'number') index = clamp(Math.floor(parsed.index), 0, FREQS.length - 1);
    if (parsed.results && typeof parsed.results === 'object') results = parsed.results;
  } catch {
    results = {};
  }
}

/* ------------------------------------------------------------------ */
/* Audio                                                               */
/* ------------------------------------------------------------------ */

/** Linear gain for an attenuation, below the fixed ceiling. */
function gainFor(dbAtten: number): number {
  return Math.pow(10, (CEILING_DB - dbAtten) / 20);
}

function stopTone(): void {
  if (autoStop) {
    window.clearTimeout(autoStop);
    autoStop = 0;
  }
  voice?.stop();
  voice = null;
  if (els.stop) els.stop.disabled = true;
  if (els.play) {
    els.play.dataset.state = 'off';
    els.play.setAttribute('aria-pressed', 'false');
  }
}

function playTone(): void {
  const hz = FREQS[index];
  ensureContext();
  stopTone();
  voice = new ToneVoice({ frequency: hz, waveform: 'sine', gain: gainFor(attenuation) });
  if (els.stop) els.stop.disabled = false;
  if (els.play) {
    els.play.dataset.state = 'on';
    els.play.setAttribute('aria-pressed', 'true');
  }
  setStatus(els.status, `Playing ${hzLabel(hz)} at −${attenuation} dB · auto-stop in ${duration} s`, 'ok');
  autoStop = window.setTimeout(() => {
    stopTone();
    setStatus(els.status, `Tone ended. Answer for ${hzLabel(hz)}.`, 'idle');
  }, duration * 1000);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function currentResult(hz: number): Result | undefined {
  return results[String(hz)];
}

function render(): void {
  const hz = FREQS[index];
  const doneCount = Object.keys(results).length;

  setText(els.freqValue, hzLabel(hz));
  setText(els.freqIndex, `step ${index + 1} / ${FREQS.length}`);
  setText(els.progress, `Frequency ${index + 1} of ${FREQS.length}`);
  if (els.bar) els.bar.style.width = `${(doneCount / FREQS.length) * 100}%`;
  qsa('[role="progressbar"]').forEach((el) => {
    el.setAttribute('aria-valuenow', String(doneCount));
  });

  // Highlight the active row and fill verdict cells.
  qsa<HTMLTableRowElement>('[data-ht="row"]', root).forEach((row) => {
    const rowHz = Number(row.dataset.hz);
    row.dataset.active = String(Number(row.dataset.index) === index);
    const result = currentResult(rowHz);
    const verdictCell = qs('[data-ht="cell-verdict"]', row);
    const levelCell = qs('[data-ht="cell-level"]', row);
    if (result) {
      setText(verdictCell, result.verdict === 'heard' ? 'heard' : 'not heard');
      setText(levelCell, result.verdict === 'heard' ? `−${result.db} dB` : ' - ');
      if (verdictCell) verdictCell.dataset.heard = result.verdict === 'heard' ? 'yes' : 'no';
    } else {
      setText(verdictCell, ' - ');
      setText(levelCell, ' - ');
      if (verdictCell) delete verdictCell.dataset.heard;
    }
  });

  setText(els.summary, summarize());
}

function summarize(): string {
  const entries = FREQS.map((hz) => ({ hz, r: currentResult(hz) })).filter((e) => e.r);
  if (entries.length === 0) return 'No results yet. Answer a frequency to begin.';
  const heard = entries.filter((e) => e.r!.verdict === 'heard');
  const highest = heard.length ? heard[heard.length - 1].hz : null;
  const parts = [`${heard.length} of ${entries.length} answered frequencies heard`];
  if (highest) parts.push(`highest confirmed ${hzLabel(highest)}`);
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ */
/* Verdicts                                                            */
/* ------------------------------------------------------------------ */

function record(verdict: Verdict): void {
  const hz = FREQS[index];
  stopTone();
  results[String(hz)] = { verdict, db: attenuation };
  if (index < FREQS.length - 1) index += 1;
  persist();
  render();
  setStatus(
    els.status,
    verdict === 'heard'
      ? `Logged ${hzLabel(hz)} as heard at −${attenuation} dB.`
      : `Logged ${hzLabel(hz)} as not heard.`,
    verdict === 'heard' ? 'ok' : 'idle',
  );
}

/* ------------------------------------------------------------------ */
/* Exports                                                             */
/* ------------------------------------------------------------------ */

function csv(): string {
  const lines = ['frequency_hz,verdict,level_db'];
  for (const hz of FREQS) {
    const r = currentResult(hz);
    lines.push(`${hz},${r ? r.verdict : ''},${r && r.verdict === 'heard' ? r.db : ''}`);
  }
  return lines.join('\n');
}

function summaryText(): string {
  const lines = ['Sound Generator - hearing test summary'];
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Frequencies answered: ${Object.keys(results).length} of ${FREQS.length}`);
  lines.push('');
  for (const hz of FREQS) {
    const r = currentResult(hz);
    if (!r) continue;
    lines.push(`${hzLabel(hz)}: ${r.verdict === 'heard' ? `heard at −${r.db} dB` : 'not heard'}`);
  }
  lines.push('');
  lines.push('Informal, browser-based sweep - not a clinical audiogram.');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Init + wiring                                                       */
/* ------------------------------------------------------------------ */

restore();
mountScopes(root);

if (els.level) {
  els.level.value = String(attenuation);
  bindSliderFill(els.level);
  on(els.level, 'input', () => {
    attenuation = clamp(Number(els.level!.value), 0, 60);
    setText(els.levelOut, `−${attenuation} dB`);
    if (voice) voice.setGain(gainFor(attenuation));
    persist();
  });
}
setText(els.levelOut, `−${attenuation} dB`);

if (els.duration) {
  els.duration.value = String(duration);
  on(els.duration, 'change', () => {
    duration = clamp(Number(els.duration!.value), 1, 30);
    persist();
  });
}

on(els.play, 'click', playTone);
on(els.stop, 'click', () => {
  stopTone();
  setStatus(els.status, 'Stopped.', 'idle');
});
on(els.heard, 'click', () => record('heard'));
on(els.cannot, 'click', () => record('not-heard'));

qsa<HTMLTableRowElement>('[data-ht="row"]', root).forEach((row) => {
  on(row, 'click', () => {
    const next = Number(row.dataset.index);
    if (Number.isFinite(next)) {
      stopTone();
      index = clamp(next, 0, FREQS.length - 1);
      render();
      setStatus(els.status, `Jumped to ${hzLabel(FREQS[index])}.`, 'idle');
    }
  });
});

on(els.csv, 'click', () => {
  try {
    const blob = new Blob([csv()], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'hearing-test-results.csv');
    setStatus(els.status, 'CSV downloaded.', 'ok');
  } catch (error) {
    setStatus(els.status, `Export failed: ${(error as Error).message}`, 'error');
  }
});

on(els.copy, 'click', async () => {
  const ok = await copyText(summaryText());
  setStatus(els.status, ok ? 'Summary copied to clipboard.' : 'Copy failed - select the table to copy manually.', ok ? 'ok' : 'warn');
});

on(els.restart, 'click', () => {
  stopTone();
  index = 0;
  results = {};
  persist();
  render();
  setStatus(els.status, 'Restarted. Results cleared.', 'idle');
});

on(els.clear, 'click', () => {
  stopTone();
  index = 0;
  results = {};
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  render();
  setStatus(els.status, 'Saved results cleared.', 'idle');
});

on(document, 'keydown', (event) => {
  const target = event.target as HTMLElement | null;
  const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
  if (event.key === 'Escape') stopTone();
  if (typing) return;
  if (event.code === 'Space') {
    event.preventDefault();
    playTone();
  }
});

// "Stop all" in the header must silence the tone being tested.
document.addEventListener('sg:stop-all', () => stopTone());

window.addEventListener('pagehide', () => stopTone());

render();
