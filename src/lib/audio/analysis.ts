/**
 * Offline analysis helpers.
 *
 * These are used by the automated audio checks (src/pages/dev/audio-checks.astro
 * + tools/audio_tests.mjs) to prove that a rendered signal really has the
 * frequency, amplitude and spectrum the UI claims. They also make handy building
 * blocks for future measurement tools (level meters, tuner, spectrum readouts).
 *
 * Everything here is plain arithmetic on Float32Array data - no Web Audio API,
 * so it can run in Node as well as the browser.
 */

/** Root-mean-square level of a sample buffer, 0..1. */
export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Largest absolute sample in a buffer. */
export function peak(samples: Float32Array): number {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > max) max = abs;
  }
  return max;
}

/**
 * Single-frequency magnitude via the Goertzel algorithm.
 * Cheaper and more precise than a full FFT when you only care about a handful
 * of frequencies (which is exactly what the DSP tests do).
 */
export function goertzel(samples: Float32Array, sampleRate: number, frequency: number): number {
  const n = samples.length;
  const k = Math.round((n * frequency) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const real = s1 - s2 * Math.cos(omega);
  const imag = s2 * Math.sin(omega);
  return (2 * Math.sqrt(real * real + imag * imag)) / n;
}

/** Magnitude of a frequency expressed in dBFS (-Infinity for digital silence). */
export function magnitudeDb(samples: Float32Array, sampleRate: number, frequency: number): number {
  const magnitude = goertzel(samples, sampleRate, frequency);
  return magnitude <= 0 ? -Infinity : 20 * Math.log10(magnitude);
}

/**
 * Average level (dB) of a frequency band, probed at log-spaced frequencies.
 *
 * A single Goertzel probe of a noise signal is a random variable with several dB
 * of spread; averaging squared magnitudes over many probes inside the band gives
 * a stable estimate of the band's energy, which is what the noise checks need.
 */
export function bandLevelDb(
  samples: Float32Array,
  sampleRate: number,
  fromHz: number,
  toHz: number,
  probes = 24,
): number {
  let sum = 0;
  for (let i = 0; i < probes; i++) {
    const hz = fromHz * Math.pow(toHz / fromHz, i / (probes - 1));
    const magnitude = goertzel(samples, sampleRate, hz);
    sum += magnitude * magnitude;
  }
  const mean = sum / probes;
  return mean <= 0 ? -Infinity : 10 * Math.log10(mean);
}

/** Difference in band level between two bands, in dB (positive = low band louder). */
export function bandSlopeDb(
  samples: Float32Array,
  sampleRate: number,
  lowBand: [number, number],
  highBand: [number, number],
): number {
  return (
    bandLevelDb(samples, sampleRate, lowBand[0], lowBand[1]) -
    bandLevelDb(samples, sampleRate, highBand[0], highBand[1])
  );
}

/** Slice a buffer to [fromSeconds, toSeconds) in seconds. */
export function slice(samples: Float32Array, sampleRate: number, fromSeconds: number, toSeconds: number): Float32Array {
  const from = Math.max(0, Math.floor(fromSeconds * sampleRate));
  const to = Math.min(samples.length, Math.floor(toSeconds * sampleRate));
  return samples.subarray(from, Math.max(from, to));
}

/** Frequency estimate from zero crossings in a window. */
export function estimateFrequencyIn(
  samples: Float32Array,
  sampleRate: number,
  fromSeconds: number,
  toSeconds: number,
): number {
  const window = slice(samples, sampleRate, fromSeconds, toSeconds);
  let crossings = 0;
  for (let i = 1; i < window.length; i++) {
    if ((window[i - 1] < 0 && window[i] >= 0) || (window[i - 1] > 0 && window[i] <= 0)) crossings++;
  }
  const duration = window.length / sampleRate;
  return duration > 0 ? crossings / 2 / duration : 0;
}

/** Count samples above a threshold - used to detect clicks at a clip boundary. */
export function countAbove(samples: Float32Array, threshold: number): number {
  let count = 0;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) > threshold) count++;
  return count;
}

/** Highest magnitude frequency within a coarse grid search (for diagnosis only). */
export function dominantFrequency(
  samples: Float32Array,
  sampleRate: number,
  minHz = 20,
  maxHz = 20000,
  steps = 2000,
): { frequency: number; db: number } {
  let best = { frequency: 0, db: -Infinity };
  for (let i = 0; i <= steps; i++) {
    const hz = minHz * Math.pow(maxHz / minHz, i / steps);
    const db = magnitudeDb(samples, sampleRate, hz);
    if (db > best.db) best = { frequency: hz, db };
  }
  return best;
}
