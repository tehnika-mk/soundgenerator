/**
 * Global transport bar - the master volume, mute, live level meter and
 * "stop all" control that sits in the site header on every page. One place to
 * silence everything is the single most useful safety feature on an audio site.
 *
 * DOM contract:
 *   [data-transport="volume"]         range input, 0-100
 *   [data-transport="volume-readout"] text readout (%, dB)
 *   [data-transport="mute"]           toggle button
 *   [data-transport="stop-all"]       button
 *   [data-transport="meter"]          element whose width % follows the level
 *   [data-transport="clip"]           clip indicator LED
 *   [data-transport="level-value"]    numeric readout, e.g. "-18.4 dB"
 *   [data-transport="rate"]           sample-rate readout, e.g. "44.1 kHz"
 *   [data-transport="state"]          context state readout ("idle", "running")
 */

import { currentLevel, currentPeak, formatDb, getContextOrNull, getCtx, getMasterPosition, getSampleRate, isMuted, positionToGain, setMasterPosition, setMuted, stopAllVoices, subscribe } from '../audio/engine';
import { bindSliderFill, on, qs, setText } from './dom';

export function initGlobalTransport(root: ParentNode = document): () => void {
  const volume = qs<HTMLInputElement>('[data-transport="volume"]', root);
  const volumeReadout = qs('[data-transport="volume-readout"]', root);
  const muteBtn = qs<HTMLButtonElement>('[data-transport="mute"]', root);
  const stopBtn = qs<HTMLButtonElement>('[data-transport="stop-all"]', root);
  const meter = qs<HTMLElement>('[data-transport="meter"]', root);
  const clip = qs<HTMLElement>('[data-transport="clip"]', root);
  const levelValue = qs('[data-transport="level-value"]', root);
  const rate = qs('[data-transport="rate"]', root);
  const state = qs('[data-transport="state"]', root);

  if (volume) {
    volume.value = String(Math.round(getMasterPosition()));
    bindSliderFill(volume);
    on(volume, 'input', () => setMasterPosition(Number(volume.value)));
  }

  const renderVolume = () => {
    const position = getMasterPosition();
    if (volume && document.activeElement !== volume) volume.value = String(Math.round(position));
    if (volume && volume.style) {
      volume.style.setProperty('--fill', `${position}%`);
    }
    const muted = isMuted();
    setText(volumeReadout, muted ? 'muted' : `${Math.round(position)}% · ${formatDb(positionToGain(position))}`);
    if (muteBtn) {
      muteBtn.setAttribute('aria-pressed', String(muted));
      setText(muteBtn, muted ? 'Unmute' : 'Mute');
    }
  };

  renderVolume();
  subscribe(renderVolume);

  on(muteBtn, 'click', () => setMuted(!isMuted()));

  on(stopBtn, 'click', () => {
    stopAllVoices();
    document.dispatchEvent(new CustomEvent('sg:stop-all'));
  });

  // Level meter - inspects the shared context only once it exists, so pages
  // that have not played anything yet do not create an AudioContext early.
  let raf = 0;
  let clipUntil = 0;
  const tick = () => {
    if (!getContextOrNull()) {
      if (state) setText(state, 'idle');
      raf = requestAnimationFrame(tick);
      return;
    }
    const peak = currentPeak();
    const level = currentLevel();
    const now = performance.now();
    if (peak > 0.985) clipUntil = now + 350;
    if (meter) meter.style.width = `${Math.min(100, level * 140).toFixed(1)}%`;
    if (clip) clip.dataset.clip = String(now < clipUntil);
    if (levelValue) setText(levelValue, level < 0.0002 ? ' - ' : formatDb(level, 1));
    if (rate) setText(rate, `${(getSampleRate() / 1000).toFixed(1)} kHz`);
    if (state) setText(state, getCtx().state);
    raf = requestAnimationFrame(tick);
  };

  // Start the meter loop lazily on the first user gesture (audio contexts are
  // not allowed to start before one anyway).
  const startMeter = () => {
    if (!raf) raf = requestAnimationFrame(tick);
  };
  document.addEventListener('pointerdown', startMeter, { once: true });
  document.addEventListener('keydown', startMeter, { once: true });
  startMeter();

  if (rate) setText(rate, ' - ');

  return () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
}
