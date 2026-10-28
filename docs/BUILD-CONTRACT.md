# Build contract - soundgenerator.app

Read this before touching the project. It is the guarantee that ~18 pages written by
different people still look, behave and sound like one product.

## 1. What this project is

- **Astro 7** static site + **Tailwind CSS v4** (`@tailwindcss/vite`), TypeScript, **no client framework**.
- Every sound is synthesised in the browser with the **Web Audio API**. There is no server,
  no upload, no external CDN, no npm dependency for audio.
- Deploy target: static hosting at `https://soundgenerator.app`.
- Project root: `C:\MegaSync\Projects\SoundGenerator`.

## 2. Read these first (the reference implementation)

| File | Why |
| --- | --- |
| `src/pages/index.astro` | Canonical page structure: hero, generator panel, presets, reference table, FAQ, related tools, scoped styles. |
| `src/scripts/home.ts` | Canonical page script: how a page imports shared modules and drives the panel. |
| `src/styles/global.css` | The design system. Every class you need already exists. |
| `src/lib/audio/engine.ts` | AudioContext, master gain, limiter, analyser, voice tracking. |
| `src/lib/audio/voices.ts` | `ToneVoice`, `NoiseVoice`, `SweepVoice`, `playClick`, `playDualTone`. |
| `src/lib/audio/notes.ts` | Note maths, presets, tuning tables, DTMF/PIPS/alarm/binaural data. |
| `src/lib/audio/wav.ts` | Offline render + WAV export (`renderTone`, `renderNoise`, `renderSweep`, `encodeWav`, `downloadBlob`). |
| `src/lib/ui/tone-generator.ts` | Reusable "frequency + play/stop + save" panel controller and `VoicePlayer`. |
| `src/lib/ui/dom.ts` | DOM helpers (`qs`, `on`, `setStatus`, `bindSliderFill`, `clamp`, `encodeShare`, …). |
| `src/lib/audio/scope.ts` | `mountScope(canvas, 'wave' \| 'spectrum')` and `mountScopes(root)` for any `canvas[data-scope]`. |

## 3. Hard rules

1. **Do not edit shared files.** These are frozen:
   `astro.config.mjs`, `package.json`, `src/styles/global.css`, `src/layouts/Base.astro`,
   `src/components/SiteHeader.astro`, `src/components/SiteRail.astro`, `src/components/SiteFooter.astro`,
   `src/data/tools.ts`, and everything in `src/lib/audio/` + `src/lib/ui/`.
   Need a shared change? Add your own module and say so in your report - do not patch these.
2. **Your files only:** `src/pages/<slug>.astro`, `src/scripts/<slug>.ts`, and (if needed)
   `src/lib/tools/<slug>.ts`, `src/components/<Name>.astro`.
3. **No new npm packages. No external scripts, fonts or CDNs.**
4. **Every route you are given is already registered in `src/data/tools.ts`** - read its entry and use that
   `title`, `tagline` and `keywords`. Do not change the registry.
5. **No monetisation**: no ads, no sponsors, no shop, no Ko-fi. The rebuilt site is clean.
6. **`npm run build` must pass.** Do not start a dev server (port 4321 is in use); use
   `cd C:/MegaSync/Projects/SoundGenerator && npm run build` to validate. Do not commit or push.

## 4. Page skeleton

```astro
---
import Base from '../layouts/Base.astro';
import Panel from '../components/Panel.astro';
import { TOOLS } from '../data/tools';

const tool = TOOLS.find((t) => t.href === '/your-slug')!;
---

<Base title={tool.title} description={tool.tagline} tool={tool} keywords={tool.keywords}>
  <div class="hero">
    <div class="hero__text">
      <p class="label label--accent">Category · short qualifier</p>
      <h1>{tool.title}</h1>
      <p class="hero__lead">Two or three sentences: what it does, how to use it in one line.</p>
    </div>
    <div class="hero__aside">
      <div class="notice"><span class="notice__icon" aria-hidden="true">!</span>
        <p class="notice__body">Hearing-safety or usage warning.</p></div>
    </div>
  </div>

  <section class="panel" id="..."> … controls … </section>

  <Panel eyebrow="Reference" title="…"> … table or prose … </Panel>
  <Panel eyebrow="FAQ" title="…"> <div class="faq"> … <details> … </details></div> </Panel>

  <script>
    import '../scripts/your-slug';
  </script>
</Base>
```

`hero`, `notice__body`, `faq` styles are defined in `index.astro`; if you need them, copy the small
scoped `<style>` block into your page (Astro scopes styles per component - duplicated rules are fine and
intentional). Shared look-and-feel classes come from `global.css`: `panel`, `panel__head`, `panel__body`,
`btn`, `btn--primary`, `btn--ghost`, `btn--sm`, `input`, `input--readout`, `label`, `mono`, `mono`,
`segmented`, `segmented__item`, `slider`, `stat-grid`, `stat`, `badge`, `badge--signal`, `notice`,
`card`, `card-grid`, `table-tech`, `kbd`, `led`, `readout`, `prose-tech`, `scope`, `scope--wave`,
`scope--spec`, `scope__tag`, `keys`, `key`.

## 5. Audio rules

- Call `ensureContext()` **inside a user-gesture handler** (click/keydown) before creating any voice.
- Create voices with the helpers so they register for the global "Stop all" button and page-hide cleanup:
  `new ToneVoice({ frequency, waveform })`, `new NoiseVoice({ color })`, `new SweepVoice({...})`,
  `playClick(...)`, `playDualTone(a, b, duration)`.
- Keep a reference to the active voice and stop it before starting another - one sound at a time unless the
  tool is explicitly polyphonic (multiple tone generator). Reuse `VoicePlayer` from `lib/ui/tone-generator.ts`
  when you just need "one tone on/off with live retuning".
- Never set a raw oscillator gain above ~0.6; the master bus already scales, and the limiter is a safety net,
  not a mixing tool.
- Downloads: render offline with `renderTone` / `renderNoise` / `renderSweep` then `encodeWav` + `downloadBlob`.
  Never fabricate a file or claim a download that didn't happen.
- Live displays: add `<canvas data-scope="wave"></canvas>` (or `"spectrum"`, optional `data-peak="true"`)
  inside `.scope` and call `mountScopes(root)` from your page script - or use `initToneGenerator`, which
  mounts them for you.
- Show measured facts, not decoration: sample rate, frequency in Hz, levels in dB, durations.

## 6. UI/UX rules

- Technical, calm, precise. Monospace (`class="mono"`) for every number, unit, code and label.
- One primary action per panel; secondary actions are `btn--ghost`/`btn--sm`.
- Status lines: `<p class="status mono" data-tg="status" role="status" aria-live="polite">` and update via
  `setStatus(el, text, 'ok' | 'warn' | 'error' | 'idle')`.
- Toggles use `aria-pressed`; groups use `role="group"` + `aria-labelledby`; every input has a real `<label>`
  (visually hidden if the design calls for it).
- Support keyboard: arrows/Enter/Space where they make sense; `Escape` always stops sound.
- Responsive from 360 px up. Verify your CSS has no fixed widths that break narrow screens.
- Copy: short declarative sentences, no hype, no exclamation marks, no "simply". Explain the physics or the
  use case instead of selling. Include measured numbers where useful.

## 7. Verification you must run

```bash
cd C:/MegaSync/Projects/SoundGenerator
npm run build     # must pass with no errors
```

Then re-read your own page for: unique H1, no `undefined`/`NaN` in rendered markup, all `data-*` hooks your
script expects actually exist in the markup, and no duplicated element IDs on the page.

## 8. Report format

Finish with: files created (paths), one line per feature implemented, anything you could not do,
and any shared-file change you would need.
