/**
 * Voice recorder.
 *
 * Captures the microphone with getUserMedia + MediaRecorder, draws the live
 * input level on a canvas from a dedicated AnalyserNode (never routed to the
 * speakers, so there is no feedback from this page itself), and offers each
 * take for playback or download.
 *
 * The WAV download is real: the captured blob is decoded back to samples and
 * re-encoded as 16-bit PCM. If that decode fails, the original file is offered
 * in its true format and the status line says so.
 */

import { ensureContext } from '../lib/audio/engine';
import { encodeWav, downloadBlob } from '../lib/audio/wav';
import { on, qs, setStatus, setText, formatTime } from '../lib/ui/dom';

type Take = {
  id: number;
  blob: Blob;
  url: string;
  seconds: number;
  bytes: number;
  mime: string;
  ext: string;
};

const root = qs<HTMLElement>('[data-vr="root"]') ?? document.body;
const els = {
  wave: qs<HTMLCanvasElement>('[data-vr="wave"]', root),
  record: qs<HTMLButtonElement>('[data-vr="record"]', root),
  stop: qs<HTMLButtonElement>('[data-vr="stop"]', root),
  led: qs('[data-vr="led"]', root),
  timer: qs('[data-vr="timer"]', root),
  status: qs('[data-vr="status"]', root),
  badge: qs('[data-vr="state-badge"]', root),
  message: qs<HTMLElement>('[data-vr="message"]', root),
  messageBody: qs('[data-vr="message-body"]', root),
  player: qs<HTMLAudioElement>('[data-vr="player"]', root),
  takes: qs<HTMLElement>('[data-vr="takes"]', root),
  empty: qs<HTMLElement>('[data-vr="empty"]', root),
  clear: qs<HTMLButtonElement>('[data-vr="clear"]', root),
};

const takes: Take[] = [];
let nextId = 1;

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let analyser: AnalyserNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let chunks: BlobPart[] = [];

let recording = false;
let startedAt = 0;
let elapsedAccum = 0;
let tickTimer = 0;
let rafId = 0;
let activeTakeId = 0;

/* ------------------------------------------------------------------ */
/* Live waveform                                                       */
/* ------------------------------------------------------------------ */

const waveData = new Uint8Array(2048);

function drawWave(): void {
  const canvas = els.wave;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, rect.width);
  const H = Math.max(1, rect.height);
  if (canvas.width !== Math.floor(W * dpr) || canvas.height !== Math.floor(H * dpr)) {
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(H / 2) + 0.5);
  ctx.lineTo(W, Math.round(H / 2) + 0.5);
  ctx.stroke();

  if (!analyser) {
    // idle: flat line
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();
    return;
  }

  if (waveData.length !== analyser.fftSize) return;
  analyser.getByteTimeDomainData(waveData);
  ctx.strokeStyle = '#12d8a0';
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const step = waveData.length / W;
  for (let x = 0; x < W; x++) {
    const v = (waveData[Math.floor(x * step)] ?? 128) / 128 - 1;
    const y = H / 2 - v * (H / 2 - 4);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function loop(): void {
  drawWave();
  rafId = requestAnimationFrame(loop);
}

function startLoop(): void {
  if (!rafId) rafId = requestAnimationFrame(loop);
}

function stopLoop(): void {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  drawWave();
}

/* ------------------------------------------------------------------ */
/* Timer                                                               */
/* ------------------------------------------------------------------ */

function currentSeconds(): number {
  if (!recording) return elapsedAccum;
  return elapsedAccum + (performance.now() - startedAt) / 1000;
}

function updateTimer(): void {
  setText(els.timer, formatTime(currentSeconds()));
}

function startTimer(): void {
  stopTimer();
  tickTimer = window.setInterval(updateTimer, 100);
  updateTimer();
}

function stopTimer(): void {
  if (tickTimer) {
    window.clearInterval(tickTimer);
    tickTimer = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Recorder                                                            */
/* ------------------------------------------------------------------ */

function extFor(mime: string): string {
  if (/webm/.test(mime)) return 'webm';
  if (/ogg/.test(mime)) return 'ogg';
  if (/mp4|m4a|aac/.test(mime)) return 'm4a';
  if (/wav/.test(mime)) return 'wav';
  if (/mpeg|mp3/.test(mime)) return 'mp3';
  return 'bin';
}

function setBadge(text: string, onState: boolean): void {
  setText(els.badge, text);
  els.badge?.classList.toggle('badge--live', onState);
  if (els.led) els.led.setAttribute('data-on', String(onState));
}

function showMessage(text: string): void {
  if (els.messageBody) setText(els.messageBody, text);
  if (els.message) els.message.hidden = false;
}

function hideMessage(): void {
  if (els.message) els.message.hidden = true;
}

function releaseStream(): void {
  source?.disconnect();
  source = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
}

async function startRecording(): Promise<void> {
  if (recording) return;
  hideMessage();

  if (!navigator.mediaDevices?.getUserMedia) {
    showMessage('This browser or context does not expose getUserMedia. Microphone capture needs a secure (HTTPS) page and a modern browser.');
    setStatus(els.status, 'Microphone capture unavailable.', 'error');
    return;
  }
  if (typeof MediaRecorder === 'undefined') {
    showMessage('This browser does not support MediaRecorder, so recording is not possible here.');
    setStatus(els.status, 'MediaRecorder unavailable.', 'error');
    return;
  }

  setStatus(els.status, 'Requesting microphone access…', 'idle');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    const err = error as DOMException;
    if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
      showMessage('Microphone access was denied. Allow the microphone for this site in your browser settings, then press Record again.');
      setStatus(els.status, 'Permission denied.', 'error');
    } else if (err?.name === 'NotFoundError' || err?.name === 'DevicesNotFoundError') {
      showMessage('No microphone was found. Connect or enable an input device and try again.');
      setStatus(els.status, 'No microphone found.', 'error');
    } else if (err?.name === 'NotReadableError') {
      showMessage('The microphone is connected but could not be read - another application may be using it.');
      setStatus(els.status, 'Microphone busy.', 'error');
    } else {
      showMessage(`Could not start recording: ${err?.message || 'unknown error'}.`);
      setStatus(els.status, 'Recording failed to start.', 'error');
    }
    releaseStream();
    return;
  }

  // A dedicated analyser for the display only. It is deliberately NOT
  // connected to the audio destination, so the page cannot feed back.
  try {
    const ctx = ensureContext();
    source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
  } catch {
    analyser = null;
  }

  try {
    recorder = new MediaRecorder(stream);
  } catch {
    recorder = new MediaRecorder(stream, undefined);
  }
  chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = () => {
    finalizeTake();
  };
  recorder.onerror = () => {
    setStatus(els.status, 'Recording error - the take may be incomplete.', 'error');
  };

  recorder.start(250); // gather a chunk every quarter second

  recording = true;
  elapsedAccum = 0;
  startedAt = performance.now();
  if (els.record) {
    els.record.dataset.state = 'on';
    els.record.setAttribute('aria-pressed', 'true');
  }
  if (els.stop) els.stop.disabled = false;
  setBadge('recording', true);
  setStatus(els.status, 'Recording. Speak into the microphone.', 'ok');
  startTimer();
  startLoop();
}

function stopRecording(): void {
  if (!recording) return;
  elapsedAccum = currentSeconds();
  recording = false;
  try {
    recorder?.stop();
  } catch {
    /* ignore */
  }
  stopTimer();
  updateTimer();
  if (els.record) {
    els.record.dataset.state = 'off';
    els.record.setAttribute('aria-pressed', 'false');
  }
  if (els.stop) els.stop.disabled = true;
  setBadge('idle', false);
}

function finalizeTake(): void {
  const seconds = elapsedAccum;
  const mime = recorder?.mimeType || 'audio/webm';
  const blob = new Blob(chunks, { type: mime });
  chunks = [];
  releaseStream();
  analyser = null;
  stopLoop();

  if (blob.size === 0) {
    setStatus(els.status, 'Nothing was captured - the take was empty.', 'warn');
    return;
  }

  const take: Take = {
    id: nextId++,
    blob,
    url: URL.createObjectURL(blob),
    seconds,
    bytes: blob.size,
    mime,
    ext: extFor(mime),
  };
  takes.push(take);
  renderTakes();
  loadTake(take.id);
  setStatus(
    els.status,
    `Take ${take.id} captured · ${seconds.toFixed(1)} s · ${(blob.size / 1024).toFixed(0)} KB · ${mime}`,
    'ok',
  );
}

/* ------------------------------------------------------------------ */
/* Takes                                                               */
/* ------------------------------------------------------------------ */

function loadTake(id: number): void {
  const take = takes.find((t) => t.id === id);
  if (!take || !els.player) return;
  activeTakeId = id;
  els.player.src = take.url;
  renderTakes();
}

function downloadTake(take: Take): void {
  setStatus(els.status, 'Decoding take and encoding WAV…', 'idle');
  const buffer = take.blob;
  buffer
    .arrayBuffer()
    .then(async (arrayBuffer) => {
      const ctx = ensureContext();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      const wav = encodeWav(audioBuffer);
      downloadBlob(wav, `take-${take.id}.wav`);
      setStatus(
        els.status,
        `Take ${take.id} saved as WAV · ${audioBuffer.duration.toFixed(1)} s · 16-bit PCM ${audioBuffer.sampleRate} Hz · ${(wav.size / 1024).toFixed(0)} KB`,
        'ok',
      );
    })
    .catch((error: unknown) => {
      // Honest fallback: hand back the real capture, in its real format.
      try {
        downloadBlob(take.blob, `take-${take.id}.${take.ext}`);
        setStatus(
          els.status,
          `WAV conversion failed (${(error as Error).message}); downloaded the original .${take.ext} file instead.`,
          'warn',
        );
      } catch (fallbackError) {
        setStatus(els.status, `Download failed: ${(fallbackError as Error).message}`, 'error');
      }
    });
}

function renderTakes(): void {
  const host = els.takes;
  if (!host) return;
  host.innerHTML = '';

  if (takes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'mono vr__empty';
    empty.textContent = 'No takes yet. Recordings appear here.';
    host.appendChild(empty);
    return;
  }

  for (const take of takes) {
    const row = document.createElement('div');
    row.className = 'vr__take';
    row.dataset.active = String(take.id === activeTakeId);

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'vr__take-main';
    main.setAttribute('aria-label', `Load take ${take.id} into the player`);
    const name = document.createElement('span');
    name.className = 'vr__take-name';
    name.textContent = `Take ${take.id}`;
    const meta = document.createElement('span');
    meta.className = 'vr__take-meta';
    meta.textContent = `${take.seconds.toFixed(1)} s · ${(take.bytes / 1024).toFixed(0)} KB · ${take.ext}`;
    main.append(name, meta);
    main.addEventListener('click', () => loadTake(take.id));

    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'btn btn--sm vr__take-dl';
    dl.textContent = 'Download WAV';
    dl.addEventListener('click', () => downloadTake(take));

    row.append(main, dl);
    host.appendChild(row);
  }
}

function clearTakes(): void {
  for (const take of takes) URL.revokeObjectURL(take.url);
  takes.length = 0;
  activeTakeId = 0;
  if (els.player) {
    els.player.removeAttribute('src');
    els.player.load();
  }
  renderTakes();
  setStatus(els.status, 'Takes cleared.', 'idle');
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

on(els.record, 'click', () => {
  void startRecording();
});
on(els.stop, 'click', () => stopRecording());
on(els.clear, 'click', () => clearTakes());

on(document, 'keydown', (event) => {
  if (event.key === 'Escape' && recording) stopRecording();
});

on(window, 'resize', () => drawWave());

window.addEventListener('pagehide', () => {
  if (recording) {
    try {
      recorder?.stop();
    } catch {
      /* ignore */
    }
  }
  stopTimer();
  releaseStream();
  stopLoop();
});

renderTakes();
drawWave();
setBadge('idle', false);
