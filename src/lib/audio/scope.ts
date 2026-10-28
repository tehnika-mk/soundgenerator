/**
 * Canvas renderers for the oscilloscope and spectrum displays.
 *
 * Both are driven by the shared AnalyserNode, so every page shows the signal
 * that is actually leaving the mixer (post limiter), not a simulation.
 */

import { currentPeak, readFrequency, readTimeDomain } from './engine';

export type ScopeMode = 'wave' | 'spectrum';

export type ScopeOptions = {
  /** Draw a peak-hold line on the spectrum display. */
  peakHold?: boolean;
  /** Colour override (defaults to the design token --color-signal). */
  color?: string;
  /** Line width in CSS pixels. */
  lineWidth?: number;
  /** Disable the animated grid / glow for low-power devices. */
  simple?: boolean;
};

export type ScopeHandle = {
  stop: () => void;
  /** Re-measure after a layout change. */
  resize: () => void;
  /** Draw one static frame (used when nothing is playing). */
  idle: () => void;
};

const SIGNAL = '#12d8a0';
const GRID = 'rgba(255,255,255,0.045)';
const GRID_STRONG = 'rgba(255,255,255,0.09)';

export function mountScope(canvas: HTMLCanvasElement, mode: ScopeMode, options: ScopeOptions = {}): ScopeHandle {
  const ctx2d = canvas.getContext('2d');
  const color = options.color ?? SIGNAL;
  const lineWidth = options.lineWidth ?? 1.6;
  let raf = 0;
  let stopped = false;
  let peakBars: Float32Array | null = null;

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (ctx2d) {
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  };

  const drawGrid = (w: number, h: number, divisions = 8) => {
    if (!ctx2d) return;
    ctx2d.lineWidth = 1;
    ctx2d.strokeStyle = GRID;
    ctx2d.beginPath();
    for (let i = 1; i < divisions; i++) {
      const x = Math.round((w / divisions) * i) + 0.5;
      ctx2d.moveTo(x, 0);
      ctx2d.lineTo(x, h);
    }
    ctx2d.stroke();

    ctx2d.strokeStyle = GRID_STRONG;
    ctx2d.beginPath();
    ctx2d.moveTo(0, Math.round(h / 2) + 0.5);
    ctx2d.lineTo(w, Math.round(h / 2) + 0.5);
    ctx2d.stroke();
  };

  const drawWave = () => {
    if (!ctx2d) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx2d.clearRect(0, 0, w, h);
    drawGrid(w, h, 8);

    const data = readTimeDomain();
    const peak = currentPeak();

    ctx2d.strokeStyle = color;
    ctx2d.globalAlpha = 0.95;
    ctx2d.lineWidth = lineWidth;
    ctx2d.lineJoin = 'round';
    ctx2d.beginPath();
    const step = data.length / w;
    for (let x = 0; x < w; x++) {
      const index = Math.floor(x * step);
      const v = data[index] ?? 0;
      const y = h / 2 - v * (h / 2 - 4);
      if (x === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();

    if (!options.simple) {
      ctx2d.globalAlpha = 0.28;
      ctx2d.fillStyle = color;
      ctx2d.fillRect(0, h - 2, Math.min(1, peak) * w, 2);
    }
    ctx2d.globalAlpha = 1;
  };

  const drawSpectrum = () => {
    if (!ctx2d) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx2d.clearRect(0, 0, w, h);

    const data = readFrequency();
    const bars = Math.max(24, Math.min(96, Math.floor(w / 6)));
    const gap = 1;
    const barWidth = (w - gap * (bars - 1)) / bars;
    if (!peakBars || peakBars.length !== bars) peakBars = new Float32Array(bars);

    for (let i = 0; i < bars; i++) {
      // Log-ish bin mapping so bass does not dominate the display.
      const t0 = Math.pow(i / bars, 1.6);
      const t1 = Math.pow((i + 1) / bars, 1.6);
      const start = Math.floor(t0 * data.length);
      const end = Math.max(start + 1, Math.floor(t1 * data.length));
      let sum = 0;
      for (let j = start; j < end; j++) sum += data[j];
      const value = sum / (end - start) / 255;

      if (options.peakHold) {
        peakBars[i] = Math.max(peakBars[i] * 0.94, value);
      }

      const x = i * (barWidth + gap);
      const barHeight = Math.max(1, value * (h - 6));
      ctx2d.fillStyle = color;
      ctx2d.globalAlpha = 0.5 + value * 0.5;
      ctx2d.fillRect(x, h - barHeight, barWidth, barHeight);

      if (options.peakHold && peakBars) {
        ctx2d.globalAlpha = 0.9;
        ctx2d.fillRect(x, h - peakBars[i] * (h - 6) - 1, barWidth, 1.5);
      }
    }
    ctx2d.globalAlpha = 1;
  };

  const frame = () => {
    if (stopped) return;
    if (canvas.clientWidth !== 0) {
      if (mode === 'wave') drawWave();
      else drawSpectrum();
    }
    raf = requestAnimationFrame(frame);
  };

  resize();
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);

  const idle = () => {
    if (mode === 'wave') drawWave();
    else drawSpectrum();
  };

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    idle();
    const interval = window.setInterval(idle, 180);
    return {
      stop: () => {
        stopped = true;
        window.clearInterval(interval);
        observer?.disconnect();
      },
      resize,
      idle,
    };
  }

  raf = requestAnimationFrame(frame);

  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(raf);
      observer?.disconnect();
    },
    resize,
    idle,
  };
}

/** Mount every [data-scope] canvas inside a root element. */
export function mountScopes(root: ParentNode = document): ScopeHandle[] {
  const handles: ScopeHandle[] = [];
  root.querySelectorAll<HTMLCanvasElement>('canvas[data-scope]').forEach((canvas) => {
    const mode = (canvas.dataset.scope as ScopeMode) || 'wave';
    handles.push(
      mountScope(canvas, mode, { peakHold: canvas.dataset.peak === 'true', simple: canvas.dataset.simple === 'true' }),
    );
  });
  return handles;
}
