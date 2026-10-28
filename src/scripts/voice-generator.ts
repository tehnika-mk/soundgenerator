/**
 * Voice generator - Web Speech API (speechSynthesis).
 *
 * The voice list is populated asynchronously: some browsers return an empty
 * array from getVoices() on load and fill it later, firing `voiceschanged`.
 * Both cases are handled honestly - an empty list shows a clear message
 * instead of a broken control.
 */

import { on, qs, setStatus, setText, bindSliderFill } from '../lib/ui/dom';

const root = qs<HTMLElement>('[data-vg="root"]') ?? document.body;
const els = {
  voice: qs<HTMLSelectElement>('[data-vg="voice"]', root),
  text: qs<HTMLTextAreaElement>('[data-vg="text"]', root),
  rate: qs<HTMLInputElement>('[data-vg="rate"]', root),
  rateOut: qs('[data-vg="rate-out"]', root),
  pitch: qs<HTMLInputElement>('[data-vg="pitch"]', root),
  pitchOut: qs('[data-vg="pitch-out"]', root),
  volume: qs<HTMLInputElement>('[data-vg="volume"]', root),
  volumeOut: qs('[data-vg="volume-out"]', root),
  speak: qs<HTMLButtonElement>('[data-vg="speak"]', root),
  pause: qs<HTMLButtonElement>('[data-vg="pause"]', root),
  resume: qs<HTMLButtonElement>('[data-vg="resume"]', root),
  stop: qs<HTMLButtonElement>('[data-vg="stop"]', root),
  status: qs('[data-vg="status"]', root),
  count: qs('[data-vg="count"]', root),
  unsupported: qs<HTMLElement>('[data-vg="unsupported"]', root),
  novoice: qs<HTMLElement>('[data-vg="novoice"]', root),
};

const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

let voices: SpeechSynthesisVoice[] = [];

function describe(voice: SpeechSynthesisVoice): string {
  const lang = voice.lang || 'unknown';
  return `${voice.name} - ${lang}${voice.default ? ' (default)' : ''}${voice.localService ? '' : ' (network)'}`;
}

function populate(): void {
  voices = window.speechSynthesis.getVoices();
  const select = els.voice;
  if (!select) return;

  if (voices.length === 0) {
    select.innerHTML = '';
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No voices available';
    select.appendChild(option);
    select.disabled = true;
    if (els.novoice) els.novoice.hidden = false;
    setText(els.count, '0 voices');
    if (els.speak) els.speak.disabled = true;
    setStatus(els.status, 'No voices installed - see the note above.', 'warn');
    return;
  }

  if (els.novoice) els.novoice.hidden = true;
  const previous = select.value;
  select.innerHTML = '';
  for (const voice of voices) {
    const option = document.createElement('option');
    option.value = voice.name;
    option.textContent = describe(voice);
    select.appendChild(option);
  }
  // Prefer a previously chosen voice, else a default, else the first.
  const restore = voices.find((v) => v.name === previous) ?? voices.find((v) => v.default) ?? voices[0];
  select.value = restore.name;
  select.disabled = false;
  if (els.speak) els.speak.disabled = false;
  setText(els.count, `${voices.length} ${voices.length === 1 ? 'voice' : 'voices'}`);
  updateStatus('Ready.');
}

function selectedVoice(): SpeechSynthesisVoice | null {
  const name = els.voice?.value;
  return voices.find((v) => v.name === name) ?? voices[0] ?? null;
}

function updateStatus(prefix: string): void {
  const voice = selectedVoice();
  const rate = Number(els.rate?.value ?? 1);
  if (!voice) {
    setStatus(els.status, prefix, 'idle');
    return;
  }
  setStatus(els.status, `${prefix} ${voice.name} (${voice.lang}) · rate ${rate.toFixed(2)}×`, 'ok');
}

function speak(): void {
  if (!supported) return;
  const text = els.text?.value.trim() ?? '';
  if (!text) {
    setStatus(els.status, 'Enter some text to speak.', 'warn');
    return;
  }
  const voice = selectedVoice();
  if (!voice) {
    setStatus(els.status, 'No voice available to speak with.', 'warn');
    return;
  }
  // A fresh utterance - cancelling avoids overlapping speech from a previous run.
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.rate = Number(els.rate?.value ?? 1);
  utterance.pitch = Number(els.pitch?.value ?? 1);
  utterance.volume = Number(els.volume?.value ?? 1);
  utterance.onstart = () => {
    if (els.speak) els.speak.setAttribute('aria-pressed', 'true');
    if (els.pause) els.pause.disabled = false;
    if (els.resume) els.resume.disabled = true;
    if (els.stop) els.stop.disabled = false;
    updateStatus('Speaking with');
  };
  utterance.onend = () => {
    if (els.speak) els.speak.setAttribute('aria-pressed', 'false');
    if (els.pause) els.pause.disabled = true;
    if (els.resume) els.resume.disabled = true;
    if (els.stop) els.stop.disabled = true;
    updateStatus('Finished.');
  };
  utterance.onerror = (event) => {
    if (els.speak) els.speak.setAttribute('aria-pressed', 'false');
    if (els.pause) els.pause.disabled = true;
    if (els.resume) els.resume.disabled = true;
    if (els.stop) els.stop.disabled = true;
    setStatus(els.status, `Speech error: ${event.error || 'unknown'}.`, 'error');
  };
  window.speechSynthesis.speak(utterance);
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

if (!supported) {
  if (els.unsupported) els.unsupported.hidden = false;
  if (els.voice) els.voice.disabled = true;
  [els.speak, els.pause, els.resume, els.stop].forEach((button) => {
    if (button) button.disabled = true;
  });
  setText(els.count, 'unsupported');
  setStatus(els.status, 'Web Speech API unavailable in this browser.', 'error');
} else {
  populate();
  // Some browsers populate the list only after the event fires.
  if (typeof window.speechSynthesis.addEventListener === 'function') {
    window.speechSynthesis.addEventListener('voiceschanged', populate);
  } else {
    (window.speechSynthesis as unknown as { onvoiceschanged: (() => void) | null }).onvoiceschanged = populate;
  }
  // A late retry covers engines that neither fire the event nor fill promptly.
  window.setTimeout(populate, 600);

  on(els.speak, 'click', speak);
  on(els.pause, 'click', () => {
    if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
      window.speechSynthesis.pause();
      if (els.pause) els.pause.disabled = true;
      if (els.resume) els.resume.disabled = false;
      updateStatus('Paused:');
    }
  });
  on(els.resume, 'click', () => {
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      if (els.pause) els.pause.disabled = false;
      if (els.resume) els.resume.disabled = true;
      updateStatus('Resumed:');
    }
  });
  on(els.stop, 'click', () => {
    window.speechSynthesis.cancel();
    if (els.speak) els.speak.setAttribute('aria-pressed', 'false');
    if (els.pause) els.pause.disabled = true;
    if (els.resume) els.resume.disabled = true;
    if (els.stop) els.stop.disabled = true;
    updateStatus('Stopped.');
  });

  on(els.voice, 'change', () => updateStatus('Selected'));

  const updateReadouts = () => {
    setText(els.rateOut, `${Number(els.rate?.value ?? 1).toFixed(2)}×`);
    setText(els.pitchOut, `${Number(els.pitch?.value ?? 1).toFixed(2)}`);
    setText(els.volumeOut, `${Math.round(Number(els.volume?.value ?? 1) * 100)}%`);
  };
  [els.rate, els.pitch, els.volume].forEach((input) => {
    if (!input) return;
    bindSliderFill(input);
    on(input, 'input', updateReadouts);
  });
  updateReadouts();

  on(document, 'keydown', (event) => {
    if (event.key === 'Escape' && window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      if (els.speak) els.speak.setAttribute('aria-pressed', 'false');
      setStatus(els.status, 'Stopped.', 'idle');
    }
  });

  window.addEventListener('pagehide', () => window.speechSynthesis.cancel());

  // "Stop all" in the header cancels speech as well as Web Audio.
  document.addEventListener('sg:stop-all', () => {
    window.speechSynthesis.cancel();
    if (els.speak) els.speak.setAttribute('aria-pressed', 'false');
    setStatus(els.status, 'Stopped.', 'idle');
  });
}
