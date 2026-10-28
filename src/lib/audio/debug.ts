/**
 * Debug / testing surface.
 *
 * Exposes the engine on `window.__sg` so automated checks (tools/browser_qa.mjs,
 * tools/audio_tests.mjs) can verify that a page really produced signal rather
 * than just asserting that a button exists. Read-only diagnostics plus
 * `stopAll` - nothing here can change the user's settings, so it is safe to
 * ship.
 */

import {
  activeVoiceCount,
  currentLevel,
  currentPeak,
  getContextOrNull,
  getMasterGainValue,
  getMasterPosition,
  getSampleRate,
  stopAllVoices,
} from './engine';

export type SgDebug = {
  ready: boolean;
  contextState: () => string;
  sampleRate: () => number;
  level: () => number;
  peak: () => number;
  voices: () => number;
  masterPosition: () => number;
  masterGain: () => number;
  stopAll: () => void;
};

declare global {
  interface Window {
    __sg?: SgDebug;
  }
}

export function installDebugApi(): void {
  if (typeof window === 'undefined') return;
  window.__sg = {
    ready: true,
    contextState: () => getContextOrNull()?.state ?? 'none',
    sampleRate: () => (getContextOrNull() ? getSampleRate() : 0),
    level: () => currentLevel(),
    peak: () => currentPeak(),
    voices: () => activeVoiceCount(),
    masterPosition: () => getMasterPosition(),
    masterGain: () => getMasterGainValue(),
    stopAll: () => stopAllVoices(),
  };
}
