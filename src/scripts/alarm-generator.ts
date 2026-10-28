/**
 * Alarm generator.
 *
 * The pattern is scheduled ahead of the audio clock the same way a metronome
 * is: a light interval timer wakes up every 20 ms and schedules the pulses
 * that fall inside the next 200 ms directly onto the AudioContext timeline.
 * Timing is therefore sample-accurate; the JavaScript timer only decides
 * *when to book* events, never *when to sound* them.
 *
 * The same pulse builders feed the canvas timeline and the offline WAV render,
 * so what you see and export is what you hear.
 */

import { ensureContext, getInput, trackVoice, untrackVoice, clamp } from '../lib/audio/engine';
import { renderOffline, encodeWav, downloadBlob, wavFilename } from '../lib/audio/wav';
import { ALARM_PATTERNS, type AlarmPattern } from '../lib/audio/notes';
import { on, qs, qsa, setStatus, setText, setPressed, bindSliderFill } from '../lib/ui/dom';

const EXPORT_SECONDS = 10;
const PULSE_PEAK = 0.5;
const SWEEP_PEAK = 0.5;
const PULSED: AlarmPattern[] = ['beep', 'double', 'pulse-train'];
const SWEEP_PATTERNS: AlarmPattern[] = ['siren', 'warble', 'continuous'];

type Params = {
  pattern: AlarmPattern;
  base: number;
  second: number;
  rate: number;
  beepMs: number;
  level: number; // 0..1
};

const isPulsed = (pattern: AlarmPattern): boolean => PULSED.includes(pattern);

function cycleSeconds(rate: number): number {
  return 60 / clamp(rate, 1, 600);
}

/** Pulse events (offset within a cycle, duration, frequency) for a pulsed pattern. */
function pulseOffsets(pattern: AlarmPattern, base: number, beepSec: number, cycle: number): { offset: number; dur: number; freq: number }[] {
  if (pattern === 'beep') {
    return [{ offset: 0, dur: Math.min(beepSec, cycle), freq: base }];
  }
  if (pattern === 'double') {
    const b = Math.min(beepSec, cycle / 3);
    return [
      { offset: 0, dur: b, freq: base },
      { offset: b * 2, dur: b, freq: base },
    ].filter((p) => p.offset + p.dur <= cycle + 1e-9);
  }
  // pulse-train: a fast stutter burst of short pulses
  const pd = clamp(beepSec / 6, 0.008, 0.06);
  const spacing = pd * 2;
  const pulses: { offset: number; dur: number; freq: number }[] = [];
  for (let i = 0; i < 24 && i * spacing + pd <= cycle + 1e-9; i++) {
    pulses.push({ offset: i * spacing, dur: pd, freq: base });
  }
  return pulses;
}

/** Frequency timeline points for the swept / continuous patterns. */
function sweepPoints(params: Params, durationSec: number): { t: number; f: number }[] {
  const cycle = cycleSeconds(params.rate);
  const { base, second } = params;
  if (params.pattern === 'continuous') {
    return [
      { t: 0, f: base },
      { t: durationSec, f: base },
    ];
  }
  if (params.pattern === 'siren') {
    const points: { t: number; f: number }[] = [{ t: 0, f: base }];
    for (let c = 0; c * cycle < durationSec; c++) {
      const t0 = c * cycle;
      points.push({ t: Math.min(t0 + cycle / 2, durationSec), f: second });
      points.push({ t: Math.min(t0 + cycle, durationSec), f: base });
    }
    return points;
  }
  // warble: four alternations per cycle
  const step = cycle / 4;
  const points: { t: number; f: number }[] = [];
  const steps = Math.ceil(durationSec / step);
  for (let i = 0; i <= steps; i++) {
    points.push({ t: Math.min(i * step, durationSec), f: i % 2 === 0 ? base : second });
  }
  if (points[points.length - 1].t < durationSec) points.push({ t: durationSec, f: base });
  return points;
}

/* ------------------------------------------------------------------ */
/* Live scheduler                                                      */
/* ------------------------------------------------------------------ */

class AlarmVoice {
  private readonly ctx: AudioContext;
  private readonly out: GainNode;
  private params: Params;
  private timer = 0;
  private nextTime = 0;
  private sweepOsc: OscillatorNode | null = null;
  private stopped = true;

  constructor(ctx: AudioContext, params: Params) {
    this.ctx = ctx;
    this.params = params;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(getInput());
  }

  get playing(): boolean {
    return !this.stopped;
  }

  setParams(next: Params): void {
    this.params = next;
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setTargetAtTime(next.level, now, 0.02);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setTargetAtTime(this.params.level, now, 0.01);

    if (SWEEP_PATTERNS.includes(this.params.pattern)) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(clamp(this.params.base, 20, this.ctx.sampleRate / 2 - 1), now);
      osc.connect(this.out);
      osc.start(now);
      this.sweepOsc = osc;
    }

    this.nextTime = now + 0.06;
    trackVoice(this);
    this.timer = window.setInterval(this.tick, 20);
    this.tick();
  }

  private tick = (): void => {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    if (this.nextTime < now - 0.5) this.nextTime = now + 0.05; // recover after a stall
    const horizon = now + 0.2;
    let guard = 0;
    while (this.nextTime < horizon && guard++ < 500) {
      this.scheduleCycle(this.nextTime);
      this.nextTime += cycleSeconds(this.params.rate);
    }
  };

  private scheduleCycle(t: number): void {
    const p = this.params;
    const cycle = cycleSeconds(p.rate);

    if (isPulsed(p.pattern)) {
      const beepSec = clamp(p.beepMs, 20, 500) / 1000;
      for (const pulse of pulseOffsets(p.pattern, p.base, beepSec, cycle)) {
        this.scheduleTone(t + pulse.offset, pulse.dur, pulse.freq);
      }
      return;
    }

    const osc = this.sweepOsc;
    if (!osc) return;
    const hi = this.ctx.sampleRate / 2 - 1;
    const b = clamp(p.base, 20, hi);
    const s = clamp(p.second, 20, hi);

    if (p.pattern === 'continuous') {
      osc.frequency.setValueAtTime(b, t);
    } else if (p.pattern === 'siren') {
      osc.frequency.setValueAtTime(b, t);
      osc.frequency.linearRampToValueAtTime(s, t + cycle / 2);
      osc.frequency.linearRampToValueAtTime(b, t + cycle);
    } else {
      const step = cycle / 4;
      osc.frequency.setValueAtTime(b, t);
      osc.frequency.linearRampToValueAtTime(s, t + step);
      osc.frequency.linearRampToValueAtTime(b, t + step * 2);
      osc.frequency.linearRampToValueAtTime(s, t + step * 3);
      osc.frequency.linearRampToValueAtTime(b, t + step * 4);
    }
  }

  private scheduleTone(when: number, dur: number, freq: number): void {
    const ctx = this.ctx;
    if (dur <= 0.001) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(clamp(freq, 20, ctx.sampleRate / 2 - 1), when);
    const g = ctx.createGain();
    const attack = Math.min(0.005, dur / 2);
    const release = Math.min(0.012, dur / 2);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(PULSE_PEAK, when + attack);
    g.gain.setValueAtTime(PULSE_PEAK, when + Math.max(dur - release, attack));
    g.gain.linearRampToValueAtTime(0, when + dur);
    osc.connect(g).connect(this.out);
    osc.start(when);
    osc.stop(when + dur + 0.02);
    osc.onended = () => {
      try {
        osc.disconnect();
        g.disconnect();
      } catch {
        /* already gone */
      }
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    window.clearInterval(this.timer);
    this.timer = 0;
    const now = this.ctx.currentTime;
    const osc = this.sweepOsc;
    this.sweepOsc = null;
    try {
      this.out.gain.cancelScheduledValues(now);
      this.out.gain.setValueAtTime(this.out.gain.value, now);
      this.out.gain.linearRampToValueAtTime(0, now + 0.04);
      osc?.stop(now + 0.06);
    } catch {
      /* already stopped */
    }
    window.setTimeout(() => {
      try {
        osc?.disconnect();
        this.out.disconnect();
      } catch {
        /* ignore */
      }
    }, 180);
    untrackVoice(this);
  }
}

/* ------------------------------------------------------------------ */
/* Offline WAV render                                                  */
/* ------------------------------------------------------------------ */

function scheduleOfflineTone(ctx: OfflineAudioContext, dest: AudioNode, when: number, dur: number, freq: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(clamp(freq, 20, ctx.sampleRate / 2 - 1), when);
  const g = ctx.createGain();
  const attack = Math.min(0.005, dur / 2);
  const release = Math.min(0.012, dur / 2);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(PULSE_PEAK, when + attack);
  g.gain.setValueAtTime(PULSE_PEAK, when + Math.max(dur - release, attack));
  g.gain.linearRampToValueAtTime(0, when + dur);
  osc.connect(g).connect(dest);
  osc.start(when);
  osc.stop(when + dur + 0.02);
}

async function renderAlarm(params: Params, seconds: number): Promise<AudioBuffer> {
  return renderOffline(
    seconds,
    (ctx, destination) => {
      const master = ctx.createGain();
      master.gain.value = params.level;
      master.connect(destination);

      if (isPulsed(params.pattern)) {
        const cycle = cycleSeconds(params.rate);
        const beepSec = clamp(params.beepMs, 20, 500) / 1000;
        const cycles = Math.ceil(seconds / cycle) + 1;
        for (let c = 0; c < cycles; c++) {
          for (const pulse of pulseOffsets(params.pattern, params.base, beepSec, cycle)) {
            const t = c * cycle + pulse.offset;
            if (t >= seconds) continue;
            const dur = Math.min(pulse.dur, seconds - t);
            scheduleOfflineTone(ctx, master, t, dur, pulse.freq);
          }
        }
        return;
      }

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const points = sweepPoints(params, seconds);
      osc.frequency.setValueAtTime(clamp(points[0].f, 20, ctx.sampleRate / 2 - 1), 0);
      for (let i = 1; i < points.length; i++) {
        osc.frequency.linearRampToValueAtTime(
          clamp(points[i].f, 20, ctx.sampleRate / 2 - 1),
          Math.min(Math.max(points[i].t, 0.001), seconds),
        );
      }
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, 0);
      g.gain.linearRampToValueAtTime(SWEEP_PEAK, 0.02);
      g.gain.setValueAtTime(SWEEP_PEAK, Math.max(seconds - 0.02, 0.02));
      g.gain.linearRampToValueAtTime(0, seconds);
      osc.connect(g).connect(master);
      osc.start(0);
      osc.stop(seconds + 0.01);
    },
    { sampleRate: 44100, channels: 1 },
  );
}

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

const root = qs<HTMLElement>('[data-al="root"]') ?? document.body;
const els = {
  patternButtons: qsa<HTMLButtonElement>('[data-al="pattern"]', root),
  patternDetail: qs('[data-al="pattern-detail"]', root),
  base: qs<HTMLInputElement>('[data-al="base"]', root),
  second: qs<HTMLInputElement>('[data-al="second"]', root),
  secondHint: qs('[data-al="second-hint"]', root),
  rate: qs<HTMLInputElement>('[data-al="rate"]', root),
  rateOut: qs('[data-al="rate-out"]', root),
  rateUnit: qs('[data-al="rate-unit"]', root),
  rateHint: qs('[data-al="rate-hint"]', root),
  beep: qs<HTMLInputElement>('[data-al="beep"]', root),
  beepOut: qs('[data-al="beep-out"]', root),
  beepHint: qs('[data-al="beep-hint"]', root),
  level: qs<HTMLInputElement>('[data-al="level"]', root),
  levelOut: qs('[data-al="level-out"]', root),
  autostop: qs<HTMLSelectElement>('[data-al="autostop"]', root),
  play: qs<HTMLButtonElement>('[data-al="play"]', root),
  stop: qs<HTMLButtonElement>('[data-al="stop"]', root),
  export: qs<HTMLButtonElement>('[data-al="export"]', root),
  status: qs('[data-al="status"]', root),
  statusInline: qs('[data-al="status-inline"]', root),
  timeline: qs<HTMLCanvasElement>('#al-timeline'),
};

let pattern: AlarmPattern = 'beep';
let voice: AlarmVoice | null = null;
let autostopTimer = 0;

function readParams(): Params {
  return {
    pattern,
    base: clamp(Number(els.base?.value) || 800, 200, 4000),
    second: clamp(Number(els.second?.value) || 1000, 200, 4000),
    rate: clamp(Number(els.rate?.value) || 120, 30, 600),
    beepMs: clamp(Number(els.beep?.value) || 120, 20, 500),
    level: clamp((Number(els.level?.value) ?? 70) / 100, 0, 1),
  };
}

const usesSecond = (p: AlarmPattern): boolean => p === 'siren' || p === 'warble';
const isContinuous = (p: AlarmPattern): boolean => p === 'continuous';

function signalColor(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--color-signal').trim();
  return value || '#12d8a0';
}

function drawTimeline(params: Params): void {
  const canvas = els.timeline;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, rect.width);
  const H = Math.max(1, rect.height);
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const cycles = 2;
  const cycle = cycleSeconds(params.rate);
  const total = cycles * cycle;
  const color = signalColor();

  // cycle boundaries
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  for (let c = 0; c <= cycles; c++) {
    const x = Math.round((c / cycles) * W) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }

  const lo = Math.min(params.base, params.second) * 0.85;
  const hi = Math.max(params.base, params.second) * 1.12;
  const yFor = (f: number) => H - ((f - lo) / (hi - lo)) * H;

  if (isPulsed(params.pattern)) {
    const beepSec = clamp(params.beepMs, 20, 500) / 1000;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    for (let c = 0; c < cycles; c++) {
      for (const pulse of pulseOffsets(params.pattern, params.base, beepSec, cycle)) {
        const x0 = ((c * cycle + pulse.offset) / total) * W;
        const x1 = ((c * cycle + pulse.offset + pulse.dur) / total) * W;
        const y = yFor(pulse.freq);
        ctx.fillRect(x0, y, Math.max(1.5, x1 - x0), H - y);
      }
    }
    ctx.globalAlpha = 1;
  } else {
    const points = sweepPoints(params, total);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach((pt, i) => {
      const x = (pt.t / total) * W;
      const y = yFor(pt.f);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // baseline
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(H - 0.5) + 0.5);
  ctx.lineTo(W, Math.round(H - 0.5) + 0.5);
  ctx.stroke();
}

function updateEnabled(params: Params): void {
  const continuous = isContinuous(params.pattern);
  if (els.rate) els.rate.disabled = continuous;
  if (els.beep) els.beep.disabled = continuous;
  if (els.second) els.second.disabled = !usesSecond(params.pattern);

  setText(els.rateUnit, continuous ? 'n/a' : isPulsed(params.pattern) ? 'pulses / min' : 'cycles / min');
  setText(
    els.rateHint,
    continuous
      ? 'Not used for a continuous tone.'
      : `At ${params.rate}, one ${isPulsed(params.pattern) ? 'pulse' : 'cycle'} every ${(cycleSeconds(params.rate)).toFixed(2)} s.`,
  );
  setText(els.beepHint, continuous ? 'Not used for a continuous tone.' : 'Length of each pulse in the pulsing patterns.');
  setText(els.secondHint, usesSecond(params.pattern) ? 'Used by siren and warble.' : 'Used by siren and warble only.');

  const detail = ALARM_PATTERNS.find((p) => p.id === params.pattern)?.detail ?? '';
  setText(els.patternDetail, detail);
}

function updateStatusInline(params: Params): void {
  const unit = isContinuous(params.pattern) ? 'continuous' : isPulsed(params.pattern) ? `${params.rate} pulses / min` : `${params.rate} cycles / min`;
  setText(els.statusInline, `${params.pattern.replace('-', ' ')} · ${unit}`);
}

function refresh(restartIfPlaying: boolean): void {
  const params = readParams();
  setText(els.rateOut, String(params.rate));
  setText(els.beepOut, `${Math.round(params.beepMs)} ms`);
  setText(els.levelOut, `${Math.round(params.level * 100)}%`);
  updateEnabled(params);
  updateStatusInline(params);
  drawTimeline(params);
  if (voice?.playing) {
    if (restartIfPlaying) {
      voice.stop();
      voice = null;
      startPlaying(params);
    } else {
      voice.setParams(params);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

function startPlaying(params: Params): void {
  ensureContext();
  voice = new AlarmVoice(ensureContext(), params);
  voice.start();
  if (els.play) {
    els.play.dataset.state = 'on';
    els.play.setAttribute('aria-pressed', 'true');
  }
  if (els.stop) els.stop.disabled = false;
  setStatus(els.status, `Playing ${params.pattern.replace('-', ' ')} at ${params.base} Hz`, 'ok');

  const auto = Number(els.autostop?.value || 0);
  if (autostopTimer) window.clearTimeout(autostopTimer);
  if (auto > 0) {
    autostopTimer = window.setTimeout(() => stopPlaying(`Auto-stopped after ${auto} s.`), auto * 1000);
  }
}

function stopPlaying(message = 'Stopped.'): void {
  if (autostopTimer) {
    window.clearTimeout(autostopTimer);
    autostopTimer = 0;
  }
  voice?.stop();
  voice = null;
  if (els.play) {
    els.play.dataset.state = 'off';
    els.play.setAttribute('aria-pressed', 'false');
  }
  if (els.stop) els.stop.disabled = true;
  setStatus(els.status, message, 'idle');
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

els.patternButtons.forEach((button) => {
  on(button, 'click', () => {
    const value = button.dataset.value as AlarmPattern | undefined;
    if (!value || value === pattern) return;
    pattern = value;
    els.patternButtons.forEach((b) => setPressed(b, b === button));
    refresh(true);
  });
});

[els.base, els.second, els.rate, els.beep, els.level].forEach((input) => {
  if (!input) return;
  on(input, 'input', () => refresh(false));
  on(input, 'change', () => refresh(false));
});

if (els.level) bindSliderFill(els.level);
if (els.rate) bindSliderFill(els.rate);
if (els.beep) bindSliderFill(els.beep);

on(els.play, 'click', () => {
  const params = readParams();
  if (voice?.playing) {
    stopPlaying();
    return;
  }
  startPlaying(params);
});

on(els.stop, 'click', () => stopPlaying());

on(els.export, 'click', async () => {
  const params = readParams();
  els.export?.setAttribute('aria-busy', 'true');
  setStatus(els.status, `Rendering ${EXPORT_SECONDS} s WAV…`, 'idle');
  try {
    const buffer = await renderAlarm(params, EXPORT_SECONDS);
    const blob = encodeWav(buffer);
    downloadBlob(blob, wavFilename(`alarm-${params.pattern}-${params.base}hz`));
    const size = (blob.size / 1024).toFixed(0);
    setStatus(
      els.status,
      `Saved ${params.pattern} · ${params.base} Hz · ${EXPORT_SECONDS} s · 16-bit PCM 44.1 kHz · ${size} KB`,
      'ok',
    );
  } catch (error) {
    setStatus(els.status, `Export failed: ${(error as Error).message}`, 'error');
  } finally {
    els.export?.removeAttribute('aria-busy');
  }
});

on(document, 'keydown', (event) => {
  const target = event.target as HTMLElement | null;
  const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
  if (event.key === 'Escape' && voice?.playing) stopPlaying();
  if (typing) return;
  if (event.code === 'Space') {
    event.preventDefault();
    if (voice?.playing) stopPlaying();
    else startPlaying(readParams());
  }
});

// "Stop all" in the header must silence the alarm: pulses are scheduled
// oscillators, not registered voices.
document.addEventListener('sg:stop-all', () => {
  if (voice || autostopTimer) stopPlaying('Stopped from the global control.');
});

window.addEventListener('pagehide', () => stopPlaying());
window.addEventListener('resize', () => drawTimeline(readParams()));

refresh(false);
