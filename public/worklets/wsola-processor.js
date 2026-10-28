/**
 * wsola-processor.js - WSOLA pitch / time engine (AudioWorkletProcessor).
 * =====================================================================
 *
 * This file is a plain ES module loaded from the static URL
 * `/worklets/wsola-processor.js` (it lives in `public/worklets/` so the build
 * copies it verbatim - it is never bundled, because AudioWorklet modules are
 * loaded by the browser, not by Vite).
 *
 * It is the single DSP core behind both the Pitch Shifter and the Time
 * Stretcher: one worklet, two sets of numbers.
 *
 * ---------------------------------------------------------------------
 * Algorithm - WSOLA (Waveform Similarity Overlap-Add)
 * ---------------------------------------------------------------------
 *
 * Two independent ratios drive the processor:
 *
 *   pitchRatio  frequency multiplier (2 = +12 semitones = one octave up)
 *   tempoRatio  playback-speed multiplier (2 = twice as fast = half length)
 *
 * The output is always built the same way, and the two ratios compose
 * cleanly:
 *
 *   1. The input is *resampled* by `pitchRatio` while being read - reading the
 *      source at a fractional step of `pitchRatio` samples per output sample
 *      shifts every frequency by exactly that factor.
 *   2. The resampled signal (call it x_r) is then *time-stretched* by WSOLA by
 *      a factor  beta = pitchRatio / tempoRatio, so that the output length
 *      lands on  sourceLength / tempoRatio  regardless of the pitch shift.
 *
 *   resample by pitchRatio :  length L        -> L / pitchRatio,  pitch * pitchRatio
 *   time-stretch by beta   :  length L/p      -> L / tempoRatio,  pitch unchanged
 *
 * When beta = 1 the stretch is a no-op and the processor degenerates to a
 * pure resampler - which is exactly what "shift the pitch and let the length
 * change too" means, so the same code path serves both modes.
 *
 * WSOLA frame geometry (all in samples at the context sample rate):
 *
 *   frame N        ≈ 0.05 s   analysis window (periodic Hann)
 *   synthesis hop  Hs = N / 2  fixed 50 % overlap-add, constant-gain COLA
 *   analysis hop   Ha = Hs * tempoRatio / pitchRatio
 *   search window  ±10 ms, cross-correlation against the previous frame
 *
 * Fixing Hs (rather than the analysis hop) keeps the overlap constant across
 * the whole 0.25x–4x range: at 0.25x a lot of heavily-overlapping input
 * frames are read; at 4x frames are read far apart and the gaps discarded.
 *
 * Phase coherence - the "waveform similarity" half of WSOLA: before emitting
 * a frame, the processor searches a small window of input positions for the
 * segment whose overlap region best correlates (normalised cross-correlation,
 * strided 4:1 for speed) with the previous frame's tail. That keeps
 * consecutive frames phase-aligned instead of butting together at random
 * phases. The search is skipped when |Ha - Hs| < 1 sample, i.e. when there is
 * no stretch and the read pointer is already contiguous.
 *
 * Known artefacts (honest list - the UI repeats the important ones):
 * - metallic / "flanging" smearing on transients and percussive attacks,
 *     because a frame is a copy of an earlier or later waveform region;
 * - the smearing gets worse as |pitchRatio - 1| grows, worst near the
 *     extremes of the 0.25x–4x range;
 * - linear interpolation when resampling loses some high-frequency energy
 *     (mild aliasing above a few kHz at large upward shifts);
 * - a short fade at the very start and end of the render.
 *
 * The processor owns a full copy of the decoded file channel data (posted from
 * the main thread), so it has the random access that WSOLA needs. Parameters
 * are ordinary AudioParams (k-rate), so both ratios can be changed while
 * playback runs; a one-pole smoother (~12 ms) removes zipper noise.
 */

const FRAME_SECONDS = 0.05;
const SEARCH_SECONDS = 0.01;
const CORR_STRIDE = 4;
/** One-pole coefficient applied per 128-sample block (~12 ms time constant). */
const PARAM_SMOOTH = 0.25;

/** Periodic Hann window - COLA (sums to 1) at 50 % overlap. */
function hann(length) {
  const w = new Float32Array(length);
  for (let i = 0; i < length; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / length));
  return w;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

class WsolaProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pitchRatio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' },
      { name: 'tempoRatio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    this.sr = sampleRate;
    this.frame = Math.max(256, 2 * Math.round((FRAME_SECONDS * sampleRate) / 2));
    this.hop = this.frame >> 1;
    this.searchRadius = Math.max(1, Math.round(SEARCH_SECONDS * sampleRate));
    this.window = hann(this.frame);

    this.channels = null;
    this.numChannels = 0;
    this.inputLength = 0;

    this.pitch = 1;
    this.tempo = 1;

    this.playing = false;
    this.finished = false;
    this.endedPosted = false;

    this.readPos = 0; // nominal position in the resampled (x_r) domain
    this.emitted = 0; // output samples produced
    this.sourcePos = 0; // position in the original source, in samples

    this.loopStart = 0; // original-domain samples
    this.loopEnd = 0; // 0 disables looping

    this.acc = null;
    this.prevRead = null;

    // Output ring buffer (interleaved by share index: one r/w for all channels).
    this.cap = 1;
    while (this.cap < this.frame + 512) this.cap <<= 1;
    this.queue = null;
    this.w = 0;
    this.r = 0;

    this.reportCountdown = 0;
    this.fadeIn = 0;

    this.port.onmessage = (event) => this.handleMessage(event.data);

    // Initial data arrives through processorOptions, not a port message: the
    // constructor runs before the first render quantum, whereas messages posted
    // to an OfflineAudioContext worklet are only delivered after rendering
    // finishes - which would leave the offline render silent.
    const initial = options && options.processorOptions ? options.processorOptions : null;
    if (initial && initial.channels) {
      this.initChannels(initial.channels, initial.inputLength);
      this.pitch = clamp(initial.pitchRatio ?? 1, 0.25, 4);
      this.tempo = clamp(initial.tempoRatio ?? 1, 0.25, 4);
      if (initial.loopStart != null && initial.loopEnd != null) {
        this.loopStart = Math.max(0, initial.loopStart);
        this.loopEnd = Math.max(0, initial.loopEnd);
        if (this.loopEnd <= this.loopStart) this.loopEnd = 0;
      }
      this.playing = initial.play === true;
    }
  }

  /** Adopt a decoded file's channel data and rebuild the working buffers. */
  initChannels(channels, inputLength) {
    this.channels = channels;
    this.numChannels = channels.length;
    this.inputLength = inputLength;
    this.queue = [];
    this.acc = [];
    for (let c = 0; c < this.numChannels; c++) {
      this.queue.push(new Float32Array(this.cap));
      this.acc.push(new Float32Array(this.frame));
    }
    this.resetTimeline();
  }

  /* ------------------------------------------------------------------ */
  /* Messaging from the page                                             */
  /* ------------------------------------------------------------------ */

  handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'load': {
        this.initChannels(msg.channels, msg.inputLength);
        this.pitch = clamp(msg.pitchRatio ?? 1, 0.25, 4);
        this.tempo = clamp(msg.tempoRatio ?? 1, 0.25, 4);
        this.playing = msg.play === true;
        this.port.postMessage({ type: 'loaded', duration: this.inputLength / this.sr });
        break;
      }
      case 'play':
        if (this.channels) {
          if (this.finished) this.resetTimeline();
          this.playing = true;
          this.endedPosted = false;
        }
        break;
      case 'pause':
        this.playing = false;
        break;
      case 'stop':
        this.playing = false;
        this.resetTimeline();
        break;
      case 'seek':
        this.seekTo(msg.position ?? 0);
        break;
      case 'loop':
        this.loopStart = Math.max(0, Math.min(msg.start ?? 0, this.inputLength));
        this.loopEnd = Math.max(0, Math.min(msg.end ?? 0, this.inputLength));
        if (this.loopEnd <= this.loopStart) this.loopEnd = 0;
        break;
      case 'ratios':
        // Fallback path; the AudioParams do the real work.
        break;
      default:
        break;
    }
  }

  resetTimeline() {
    this.readPos = 0;
    this.emitted = 0;
    this.sourcePos = 0;
    this.finished = false;
    this.endedPosted = false;
    this.fadeIn = 0;
    this.prevRead = null;
    if (this.acc) for (const a of this.acc) a.fill(0);
    this.w = 0;
    this.r = 0;
  }

  seekTo(seconds) {
    const target = clamp(seconds, 0, this.inputLength / this.sr);
    this.sourcePos = target * this.sr;
    this.readPos = (target * this.sr) / this.pitch;
    this.emitted = Math.round((target * this.sr) / this.tempo);
    this.finished = false;
    this.endedPosted = false;
    this.fadeIn = 0;
    this.prevRead = null;
    if (this.acc) for (const a of this.acc) a.fill(0);
    this.w = 0;
    this.r = 0;
    this.port.postMessage({ type: 'seeked', position: target });
  }

  /* ------------------------------------------------------------------ */
  /* Ring buffer                                                         */
  /* ------------------------------------------------------------------ */

  available() {
    let a = this.w - this.r;
    if (a < 0) a += this.cap;
    return a;
  }

  /* ------------------------------------------------------------------ */
  /* Resampled read: x_r(v) = x(v * pitch)                               */
  /* ------------------------------------------------------------------ */

  sampleAt(ch, pos) {
    const data = this.channels[ch];
    if (pos <= 0 || pos >= this.inputLength - 1) return 0;
    const i0 = pos | 0;
    const f = pos - i0;
    return data[i0] * (1 - f) + data[i0 + 1] * f;
  }

  readResampled(ch, v) {
    return this.sampleAt(ch, v * this.pitch);
  }

  /* ------------------------------------------------------------------ */
  /* One WSOLA frame                                                     */
  /* ------------------------------------------------------------------ */

  /** Find the search offset that best continues the previous frame. */
  findOffset(nominal) {
    if (!this.prevRead) return 0;
    const hop = this.hop;
    const template = this.prevRead; // length = frame; tail is [hop .. frame)
    const R = this.searchRadius;
    const lo = Math.max(-R, -Math.floor(nominal));
    const hi = R;

    let bestOffset = 0;
    let bestScore = -Infinity;

    for (let d = lo; d <= hi; d++) {
      let dot = 0;
      let ea = 0;
      let eb = 0;
      let valid = 0;
      for (let i = 0; i < hop; i += CORR_STRIDE) {
        const candidate = this.readResampled(0, nominal + d + i);
        const t = template[hop + i];
        dot += candidate * t;
        ea += candidate * candidate;
        eb += t * t;
        valid++;
      }
      if (valid === 0) continue;
      const score = ea > 1e-9 && eb > 1e-9 ? dot / Math.sqrt(ea * eb) : -Infinity;
      if (score > bestScore) {
        bestScore = score;
        bestOffset = d;
      }
    }
    return bestOffset;
  }

  /** Produce one synthesis hop of output into the ring buffer. */
  emitFrame() {
    const frame = this.frame;
    const hop = this.hop;
    const pitch = this.pitch;
    const tempo = this.tempo;
    const Ha = (hop * tempo) / pitch;
    const xrLength = this.inputLength / pitch;

    if (this.readPos >= xrLength + Ha) {
      this.finished = true;
      return false;
    }

    // Phase-coherence search only matters when we are actually stretching.
    let offset = 0;
    if (Math.abs(Ha - hop) > 1) offset = this.findOffset(this.readPos);
    const start = this.readPos + offset;

    // Read one windowed frame, window into the accumulator, and remember the
    // raw (unwindowed) samples for the next frame's correlation template.
    if (!this.prevRead) this.prevRead = new Float32Array(frame);
    for (let c = 0; c < this.numChannels; c++) {
      const data = this.channels[c];
      const accum = this.acc[c];
      const prev = this.prevRead;
      for (let i = 0; i < frame; i++) {
        const v = this.readResampled(c, start + i);
        if (c === 0) prev[i] = v; // correlation template uses channel 0
        accum[i] += v * this.window[i];
      }
    }

    // Flush the first `hop` samples (they are final) into the ring.
    for (let i = 0; i < hop; i++) {
      // Short fade-in so the very first frames do not click.
      if (this.fadeIn < this.sr * 0.005) this.fadeIn++;
      const gain = this.fadeIn < this.sr * 0.005 ? this.fadeIn / (this.sr * 0.005) : 1;
      for (let c = 0; c < this.numChannels; c++) {
        this.queue[c][this.w] = this.acc[c][i] * gain;
      }
      this.w = (this.w + 1) % this.cap;
    }

    // Shift the accumulator left by one hop and clear the tail.
    for (let c = 0; c < this.numChannels; c++) {
      const accum = this.acc[c];
      accum.copyWithin(0, hop);
      accum.fill(0, frame - hop);
    }

    this.readPos += Ha;
    this.emitted += hop;
    this.sourcePos = this.readPos * pitch;

    // Loop a section: wrap the read pointer when the source position passes
    // the loop end.
    if (this.loopEnd > this.loopStart && this.sourcePos >= this.loopEnd) {
      this.readPos = this.loopStart / pitch;
      this.sourcePos = this.loopStart;
      this.prevRead = null;
      for (let c = 0; c < this.numChannels; c++) this.acc[c].fill(0);
    } else if (this.loopEnd <= this.loopStart && this.readPos >= xrLength) {
      this.finished = true;
    }

    return true;
  }

  /* ------------------------------------------------------------------ */
  /* AudioWorklet entry point                                            */
  /* ------------------------------------------------------------------ */

  process(_inputs, outputs, params) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const blockSize = output[0].length;

    // k-rate parameters: one value per render quantum. Smooth them so a ratio
    // change while playing does not step the read geometry discontinuously.
    const targetPitch = params.pitchRatio[0];
    const targetTempo = params.tempoRatio[0];
    this.pitch += (targetPitch - this.pitch) * PARAM_SMOOTH;
    this.tempo += (targetTempo - this.tempo) * PARAM_SMOOTH;

    if (!this.channels || !this.playing) {
      for (let c = 0; c < output.length; c++) output[c].fill(0);
      return true;
    }

    let guard = 0;
    while (this.available() < blockSize && !this.finished && guard++ < 128) {
      if (!this.emitFrame()) break;
    }

    for (let i = 0; i < blockSize; i++) {
      for (let c = 0; c < output.length; c++) {
        const q = this.queue[c];
        output[c][i] = this.available() > 0 ? q[this.r] : 0;
      }
      if (this.available() > 0) this.r = (this.r + 1) % this.cap;
    }

    if (--this.reportCountdown <= 0) {
      this.reportCountdown = Math.max(1, Math.round((0.05 * this.sr) / blockSize));
      this.port.postMessage({
        type: 'progress',
        position: this.sourcePos / this.sr,
        duration: this.inputLength / this.sr,
        ratio: this.inputLength > 0 ? this.sourcePos / this.inputLength : 0,
        outputPosition: this.emitted / this.sr,
        outputDuration: this.inputLength / (this.tempo * this.sr),
        playing: true,
      });
    }

    if (this.finished && this.available() === 0 && !this.endedPosted) {
      this.endedPosted = true;
      this.playing = false;
      this.port.postMessage({
        type: 'ended',
        position: this.inputLength / this.sr,
        duration: this.inputLength / this.sr,
      });
    }

    return true;
  }
}

registerProcessor('wsola-processor', WsolaProcessor);
