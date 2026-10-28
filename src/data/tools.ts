/**
 * Single source of truth for the tool catalogue: navigation, page metadata,
 * sitemap and the home-page index all read from this file.
 *
 * `tagline` is short UI copy for cards and tooltips. `meta` is the search and
 * social description for the page: unique, 110 to 155 characters, written to
 * stand on its own in a result list.
 */

export type ToolCategory =
  | 'Generators'
  | 'Music & tuning'
  | 'Hearing & speakers'
  | 'Signals & telecom'
  | 'Voice & files'
  | 'Reference';

export type Tool = {
  slug: string;
  href: string;
  /** Full page title (rendered as the H1 and in <title>). */
  title: string;
  /** Short label for navigation. */
  nav: string;
  /** One-line description used on cards and in nav tooltips. */
  tagline: string;
  /** Meta description for search engines and social previews. */
  meta: string;
  category: ToolCategory;
  /** Extra keywords for the meta keywords tag. */
  keywords: string[];
  /** Set for content-only pages (no interactive tool). */
  content?: boolean;
};

export const CATEGORY_ORDER: ToolCategory[] = [
  'Generators',
  'Music & tuning',
  'Hearing & speakers',
  'Signals & telecom',
  'Voice & files',
  'Reference',
];

export const TOOLS: Tool[] = [
  {
    slug: 'index',
    href: '/',
    title: 'Online Tone Generator',
    nav: 'Tone generator',
    tagline: 'Pure sine, square, sawtooth and triangle tones from 1 Hz to 20 kHz, with precise frequency entry and WAV export.',
    meta: 'Free online tone generator. Play any frequency from 1 Hz to 20 kHz as a sine, square, sawtooth or triangle wave, and save it as a WAV file.',
    category: 'Generators',
    keywords: ['tone generator', 'sine wave', 'frequency generator', '440 hz', 'signal generator'],
  },
  {
    slug: 'multiple-tone-generator',
    href: '/multiple-tone-generator',
    title: 'Multiple Tone Generator',
    nav: 'Multiple tones',
    tagline: 'Run up to eight independent oscillators with per-voice frequency, waveform, level and stereo pan.',
    meta: 'Play up to eight tones at once. Set the frequency, waveform, level and stereo pan of every voice, then share the whole setup as a link.',
    category: 'Generators',
    keywords: ['multiple tone generator', 'chord generator', 'harmonics', 'beat frequencies'],
  },
  {
    slug: 'sweep-generator',
    href: '/sweep-generator',
    title: 'Frequency Sweep Generator',
    nav: 'Sweep generator',
    tagline: 'Linear or logarithmic sweeps between any two frequencies, with start/end levels and optional hold.',
    meta: 'Generate linear or logarithmic frequency sweeps between any two frequencies, with start and end levels, a hold option and a WAV download.',
    category: 'Generators',
    keywords: ['sweep generator', 'chirp', 'log sweep', 'rise and fall', 'frequency ramp'],
  },
  {
    slug: 'noise-generator',
    href: '/noise-generator',
    title: 'Noise Generator',
    nav: 'Noise generator',
    tagline: 'White, pink and brown noise with band shaping - for masking, calibrating and testing.',
    meta: 'White, pink and brown noise with low-pass and high-pass shaping. Use it for masking, speaker testing and room measurements, and export a WAV.',
    category: 'Generators',
    keywords: ['white noise', 'pink noise', 'brown noise', 'noise generator', 'sound masking'],
  },
  {
    slug: 'alarm-generator',
    href: '/alarm-generator',
    title: 'Alarm Generator',
    nav: 'Alarm generator',
    tagline: 'Beeps, double beeps, sirens, warble tones and pulse trains at any tempo - or continuous.',
    meta: 'Build beeps, double beeps, sirens, warble tones and pulse trains at any rate, preview the pattern on a timeline and export it as a WAV file.',
    category: 'Generators',
    keywords: ['alarm generator', 'alarm tone', 'siren', 'beep generator'],
  },
  {
    slug: 'binaural-beats',
    href: '/binaural-beats',
    title: 'Binaural Beat Generator',
    nav: 'Binaural beats',
    tagline: 'Two detuned carriers, one per ear. Delta through gamma with exact beat frequencies.',
    meta: 'Two carriers, one per ear, with beat frequencies from delta to gamma. Headphones are required. Includes the stereo maths and a stereo WAV export.',
    category: 'Music & tuning',
    keywords: ['binaural beats', 'delta theta alpha beta gamma', 'brainwave', 'stereo beat'],
  },
  {
    slug: 'instrument-tuning',
    href: '/instrument-tuning',
    title: 'Instrument Tuning Tones',
    nav: 'Instrument tuning',
    tagline: 'Reference pitches for guitar, bass, ukulele, violin, cello, mandolin, banjo and viola.',
    meta: 'Reference tuning tones for guitar, bass, ukulele, violin, cello, mandolin, banjo and viola, at A4 = 440, 432, 435 or 415 Hz. WAV export per string.',
    category: 'Music & tuning',
    keywords: ['guitar tuner', 'tuning tones', 'EADGBE', 'ukulele tuning', 'violin tuning'],
  },
  {
    slug: 'metronome',
    href: '/metronome',
    title: 'Online Metronome',
    nav: 'Metronome',
    tagline: 'Accurate metronome from 20 to 300 BPM with time signatures, accents and tap tempo.',
    meta: 'An accurate online metronome from 20 to 300 BPM with time signatures, accents, subdivisions, a count-in and tap tempo. Nothing to install.',
    category: 'Music & tuning',
    keywords: ['metronome', 'bpm', 'tempo', 'tap tempo', 'time signature'],
  },
  {
    slug: '432hz',
    href: '/432hz',
    title: '432 Hz Frequency Generator',
    nav: '432 Hz',
    tagline: 'Play and compare 432 Hz against 440, 435 and 415 Hz reference pitch - by note or by hertz.',
    meta: 'Play and compare 432 Hz with the 440, 435 and 415 Hz reference pitches. The equal temperament maths, the history of A4 and an honest look at the claims.',
    category: 'Music & tuning',
    keywords: ['432 hz', '440 hz', 'alternative tuning', 'verdi tuning', 'reference pitch'],
  },
  {
    slug: 'hearing-test',
    href: '/hearing-test',
    title: 'Online Hearing Test',
    nav: 'Hearing test',
    tagline: 'Step through audiometric frequencies from 125 Hz to 20 kHz and log what you can hear.',
    meta: 'Step through audiometric frequencies from 125 Hz to 20 kHz, log what you hear and export the results. An informal check, not a medical test.',
    category: 'Hearing & speakers',
    keywords: ['hearing test', 'frequency range test', 'age hearing test', 'audiometry'],
  },
  {
    slug: 'subwoofer-test',
    href: '/subwoofer-test',
    title: 'Subwoofer Test Tones',
    nav: 'Subwoofer test',
    tagline: 'Low-frequency test signals from 16 Hz up, plus sweep tools for finding room and driver limits.',
    meta: 'Low frequency test tones from 16 Hz, a continuous 16 to 120 Hz sweep for finding rattles, and a level-matched 20, 40 and 80 Hz comparison.',
    category: 'Hearing & speakers',
    keywords: ['subwoofer test', 'bass test tone', 'low frequency', 'speaker test'],
  },
  {
    slug: 'dtmf',
    href: '/dtmf',
    title: 'DTMF Signal Generator',
    nav: 'DTMF tones',
    tagline: 'The full telephone keypad, A–D columns, dial tones, busy tones and SIT patterns.',
    meta: 'The full telephone keypad with A to D column tones, dial tones, busy signals and SIT patterns, plus a sequence dialler and WAV export.',
    category: 'Signals & telecom',
    keywords: ['dtmf', 'touch tone', 'telephone keypad', 'dial tone', 'call tone'],
  },
  {
    slug: 'pips',
    href: '/pips',
    title: 'The Pips Time Signal',
    nav: 'The pips',
    tagline: 'The six 1000 Hz BBC-style pips, with an optional countdown to the next hour.',
    meta: 'The six 1000 Hz time signal pips with a countdown to the next hour, an optional 1 kHz reference tone and a WAV download of the sequence.',
    category: 'Signals & telecom',
    keywords: ['the pips', 'time signal', 'bbc pips', '1000 hz', 'time pips'],
  },
  {
    slug: 'voice-generator',
    href: '/voice-generator',
    title: 'Voice Generator',
    nav: 'Voice generator',
    tagline: 'Type anything and hear it spoken by the voices installed on your device - free and offline.',
    meta: 'Type anything and hear it spoken by the voices installed on your device. Adjust rate, pitch and volume. Nothing is uploaded or stored.',
    category: 'Voice & files',
    keywords: ['text to speech', 'voice generator', 'speech synthesis', 'tts'],
  },
  {
    slug: 'voice-recorder',
    href: '/voice-recorder',
    title: 'Voice Recorder',
    nav: 'Voice recorder',
    tagline: 'Record from your microphone, watch the live waveform and download the take as a WAV file.',
    meta: 'Record from your microphone, watch the live level waveform, keep multiple takes and download a genuine 16-bit WAV. Everything stays on your device.',
    category: 'Voice & files',
    keywords: ['voice recorder', 'microphone recorder', 'record audio online', 'wav recorder'],
  },
  {
    slug: 'pitch-shifter',
    href: '/pitch-shifter',
    title: 'Pitch Shifter',
    nav: 'Pitch shifter',
    tagline: 'Shift any audio file by semitones, with or without tempo correction, then export the result.',
    meta: 'Shift any audio file from 24 semitones down to 24 semitones up, with or without tempo correction, preview it live and export a 16-bit WAV.',
    category: 'Voice & files',
    keywords: ['pitch shifter', 'semitones', 'transpose audio', 'change pitch'],
  },
  {
    slug: 'time-stretcher',
    href: '/time-stretcher',
    title: 'Time Stretcher',
    nav: 'Time stretcher',
    tagline: 'Change the tempo of a recording without changing its pitch - slow it down to practise.',
    meta: 'Change the tempo of any audio file from 0.25x to 4x while keeping the pitch, loop a section and export a 16-bit WAV. It all runs in your browser.',
    category: 'Voice & files',
    keywords: ['time stretcher', 'change tempo', 'slow down audio', 'practice speed'],
  },
  {
    slug: 'theory',
    href: '/theory',
    title: 'Acoustic Theory',
    nav: 'Acoustic theory',
    tagline: 'The maths behind the tones: sine waves, harmonics, decibels, wavelengths and sample rates.',
    meta: 'How sound works: sine waves, harmonics, decibels, sampling, equal temperament, room modes and hearing safety, with a wavelength calculator.',
    category: 'Reference',
    keywords: ['acoustics', 'sine wave', 'harmonics', 'decibel', 'sound theory'],
    content: true,
  },
  {
    slug: 'about',
    href: '/about',
    title: 'About Sound Generator',
    nav: 'About',
    tagline: 'What this site is, how it works, and how to use it without damaging your hearing.',
    meta: 'What soundgenerator.app is, how the tools work, what they can and cannot tell you, and why nothing you play or record leaves your device.',
    category: 'Reference',
    keywords: ['about', 'sound generator'],
    content: true,
  },
  {
    slug: 'privacy',
    href: '/privacy',
    title: 'Privacy Policy',
    nav: 'Privacy',
    tagline: 'Everything runs in your browser: no accounts, no uploads, no audio leaves your device.',
    meta: 'No accounts, no cookies, no analytics and no uploads. What the site stores locally in your browser, and how to clear it. Plain and specific.',
    category: 'Reference',
    keywords: ['privacy policy'],
    content: true,
  },
];

export const SITE = {
  name: 'Sound Generator',
  domain: 'soundgenerator.app',
  url: 'https://soundgenerator.app',
  tagline: 'Precision tone, sweep and test-signal generators that run entirely in your browser.',
  description:
    'Free online tone generator and audio test tools: pure sine, square, sawtooth and triangle tones, frequency sweeps, white/pink/brown noise, binaural beats, DTMF, tuning tones and hearing tests. No downloads, no accounts, no uploads.',
  email: 'hello@tehnika.mk',
  /** Footer credit. */
  credit: { label: 'Developed by Tehnika.mk - Digital Agency', href: 'https://tehnika.mk' },
  /** Google Analytics measurement ID. Loaded in production builds only. */
  gaId: 'G-FK8YJ3XSX7',
} as const;

export function toolByHref(href: string): Tool | undefined {
  return TOOLS.find((tool) => tool.href === href);
}

export function toolsByCategory(category: ToolCategory): Tool[] {
  return TOOLS.filter((tool) => tool.category === category);
}

export const PRIMARY_TOOLS = TOOLS.filter((tool) => !tool.content);
