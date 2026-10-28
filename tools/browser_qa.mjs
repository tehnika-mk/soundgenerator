/**
 * Headless QA sweep for every page of the built site.
 *
 *   node tools/browser_qa.mjs [--base=http://localhost:4321] [--routes=/a,/b] [--mobile]
 *
 * For each route it checks: document title, exactly one H1, no console or page
 * errors, no "undefined"/"NaN" leaking into visible text, all internal links
 * resolving, and - for pages that make sound - that pressing the primary play
 * control really produces signal (measured through window.__sg) and that
 * "Stop all" returns the output to silence. Screenshots land in qa-artifacts/.
 *
 * Exits non-zero if any hard check fails.
 */

import { Browser, sleep } from './lib/cdp.mjs';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);

const base = (args.base ?? process.env.SG_BASE ?? 'http://localhost:4321').replace(/\/$/, '');
const outDir = 'qa-artifacts';
const mobile = Boolean(args.mobile);

/** Pages whose sound needs user data (a file or a microphone) - audio is not asserted. */
const MANUAL_AUDIO = ['/voice-recorder', '/voice-generator', '/pitch-shifter', '/time-stretcher'];

/**
 * How to make each page sound. `mode: 'hold'` is for momentary controls
 * (instrument strings, DTMF keys) that only sound while pressed.
 */
const AUDIO_TARGETS = {
  '/': { selector: '[data-tg="play"]' },
  '/432hz': { selector: '[data-tg="play"]' },
  '/sweep-generator': { selector: '[data-sweep="play"]' },
  '/multiple-tone-generator': { selector: '[data-voice="play"]' },
  '/noise-generator': { selector: '[data-ng="play"]' },
  '/binaural-beats': { selector: '[data-tg="play"], [data-bb="play"], [data-play]' },
  '/alarm-generator': { selector: '[data-al="play"]' },
  '/metronome': { selector: '[data-play]' },
  '/pips': { selector: '[data-pips="play"]' },
  '/hearing-test': { selector: '[data-ht="play"]' },
  '/dtmf': { selector: '[data-key="5"]', mode: 'hold' },
  '/instrument-tuning': { selector: '[data-strings] button', mode: 'hold' },
  '/subwoofer-test': { selector: '[data-step]' },
};

/** Routes with no audio at all (content pages). */
const NO_AUDIO_ROUTES = ['/about', '/privacy', '/theory', '/sitemap', '/404'];

function discoverRoutes() {
  if (typeof args.routes === 'string') return args.routes.split(',').map((r) => r.trim());
  const routes = ['/'];
  const dist = 'dist';
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      const route = `${prefix}/${entry}`;
      if (entry === 'dev' && prefix === '') continue; // developer harness, noindex
      if (entry === 'og-card' && prefix === '') continue; // social card source, noindex
      let hasIndex = false;
      try {
        hasIndex = readdirSync(full).includes('index.html');
      } catch {
        hasIndex = false;
      }
      if (hasIndex) routes.push(route);
      walk(full, route);
    }
  };
  walk(dist, '');
  // 404 is generated as dist/404.html
  try {
    if (readdirSync(dist).includes('404.html')) routes.push('/404');
  } catch {
    /* no dist yet */
  }
  return routes;
}

const PICK_PLAY = `(() => {
  document.querySelectorAll('[data-qa-play]').forEach((el) => el.removeAttribute('data-qa-play'));
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], a.btn'));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const score = (el) => {
    const text = (el.textContent || '').trim().toLowerCase();
    let value = 0;
    if (el.matches('[data-tg="play"], [data-audio-play], [data-play]')) value += 100;
    if (/^(▶|►)?\\s*play\\b/.test(text)) value += 60;
    else if (/^(start|dial|speak|begin)\\b/.test(text)) value += 30;
    if (/stop|clear|reset|remove|delete|download|save|mute/.test(text)) value -= 70;
    if (el.disabled) value -= 60;
    if (!visible(el)) value -= 100;
    return value;
  };
  let best = null;
  let bestScore = 0;
  for (const el of candidates) {
    const value = score(el);
    if (value > bestScore) {
      bestScore = value;
      best = el;
    }
  }
  if (!best || bestScore < 50) return null;
  best.setAttribute('data-qa-play', '1');
  return (best.textContent || '').trim().slice(0, 40);
})()`;

const browser = new Browser({ port: 9555 });
const results = [];
let exitCode = 0;

try {
  await browser.launch();
  mkdirSync(outDir, { recursive: true });

  const routes = discoverRoutes();
  console.log(`\n  QA sweep - ${base} - ${routes.length} route(s)${mobile ? ' - mobile viewport' : ''}\n`);

  const internalLinks = new Set();

  for (const route of routes) {
    // Survive a renderer crash: restart the browser rather than failing every
    // remaining route.
    if (!(await browser.isAlive())) {
      console.log(`  ~ browser unresponsive before ${route}, relaunching`);
      await browser.relaunch();
    }
    let page;
    try {
      page = await browser.newPage();
    } catch (error) {
      console.log(`  ~ could not open a page for ${route} (${error.message}), relaunching`);
      await browser.relaunch();
      page = await browser.newPage();
    }
    const failures = [];
    const notes = [];
    try {
      // A narrow viewport, not touch emulation: the site is pointer-driven and
      // touch emulation stops mouse-driven press-and-hold tests from firing.
      if (mobile) await page.resize(390, 844, false);
      await page.goto(`${base}${route}`);
      await sleep(400);

      const info = JSON.parse(
        await page.evaluate(`JSON.stringify({
          title: document.title,
          lang: document.documentElement.lang,
          h1: Array.from(document.querySelectorAll('h1')).map((h) => h.textContent.trim()),
          text: document.body.innerText.slice(0, 40000),
          links: Array.from(document.querySelectorAll('a[href^="/"]')).map((a) => a.getAttribute('href')),
          description: (document.querySelector('meta[name="description"]') || {}).content || '',
          canvases: Array.from(document.querySelectorAll('canvas')).map((c) => c.width + 'x' + c.height),
          headingCount: document.querySelectorAll('h1, h2, h3').length,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          wideElements: Array.from(document.querySelectorAll('body *')).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.right > window.innerWidth + 2 && r.width > 24 && getComputedStyle(el).position !== 'fixed';
          }).slice(0, 4).map((el) => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')),
          unlabeledControls: Array.from(document.querySelectorAll('button, input, select, textarea')).filter((el) => {
            if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
            if (el.id && document.querySelector('label[for="' + el.id + '"]')) return false;
            if (el.closest('label')) return false;
            if (el.tagName === 'BUTTON' && (el.textContent || '').trim()) return false;
            if (el.type === 'hidden') return false;
            return true;
          }).slice(0, 6).map((el) => el.tagName.toLowerCase() + '#' + (el.id || '') + ':' + (el.getAttribute('type') || '')),
          imagesWithoutAlt: Array.from(document.querySelectorAll('img:not([alt])')).length,
          smallTargets: Array.from(document.querySelectorAll('button, a.btn, [role="button"], input[type="range"]')).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.height > 0 && r.height < 26;
          }).length,
        })`),
      );

      if (!info.title || info.title.length < 10) failures.push(`title too short: "${info.title}"`);
      if (info.h1.length !== 1) failures.push(`expected exactly 1 h1, found ${info.h1.length}: ${info.h1.join(' | ')}`);
      if (!info.description || info.description.length < 30) failures.push('meta description missing or too short');
      if (info.lang !== 'en') failures.push(`html lang is "${info.lang}"`);
      if (/\bundefined\b/.test(info.text)) failures.push('visible text contains "undefined"');
      if (info.overflow > 2) failures.push(`horizontal overflow of ${info.overflow}px (${info.wideElements.join(', ')})`);
      if (info.unlabeledControls.length) failures.push(`controls without an accessible name: ${info.unlabeledControls.join(', ')}`);
      if (info.imagesWithoutAlt) failures.push(`${info.imagesWithoutAlt} image(s) without an alt attribute`);
      if (info.smallTargets) notes.push(`${info.smallTargets} interactive element(s) under 26px tall`);
      const nanMatches = info.text.match(/NaN/g) ?? [];
      if (nanMatches.length) notes.push(`${nanMatches.length} "NaN" occurrence(s) in visible text`);

      const blankCanvases = info.canvases.filter((size) => size.startsWith('1x') || size.startsWith('0x'));
      if (blankCanvases.length) notes.push(`${blankCanvases.length} canvas(es) with no measured size`);

      for (const link of info.links) internalLinks.add(link);

      // ---- audio behaviour -------------------------------------------
      const skipAudio = MANUAL_AUDIO.some((prefix) => route.startsWith(prefix)) || NO_AUDIO_ROUTES.includes(route);
      if (skipAudio) {
        if (!NO_AUDIO_ROUTES.includes(route)) notes.push('audio assertion skipped (needs microphone or a user file)');
      } else {
        // Wait for the page script to be live before poking at its controls.
        for (let attempt = 0; attempt < 20; attempt++) {
          const ready = await page.evaluate('!!window.__sg && document.readyState === "complete"');
          if (ready) break;
          await sleep(150);
        }
        await sleep(250);

        const hint = AUDIO_TARGETS[route];
        let selector = hint?.selector ?? null;
        let usedHold = hint?.mode === 'hold';

        if (!selector) {
          const playLabel = await page.evaluate(PICK_PLAY);
          if (playLabel) selector = '[data-qa-play="1"]';
          else notes.push('no play control found to test');
        }

        if (selector) {
          let acted = false;
          let sample = { maxLevel: 0, maxPeak: 0, voices: 0 };
          for (let attempt = 0; attempt < 3 && !acted; attempt++) {
            const exists = await page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
            if (!exists) break;

            if (usedHold) {
              // Momentary control: measure during the press.
              const held = await page.pressAndSample(selector, 900, 70);
              acted = held.ok;
              sample = held;
            } else {
              acted = await page.activateSelector(selector);
              if (acted) sample = await page.sampleOutput(2200, 70);
            }

            if (acted && sample.maxPeak < 0.008 && sample.maxLevel < 0.0015 && attempt < 2) {
              notes.push(`activation of ${selector} produced nothing on attempt ${attempt + 1}, retrying`);
              acted = false;
              await sleep(400);
            }
          }

          if (!acted) {
            failures.push(`could not activate the audio control "${selector}"`);
          } else {
            const state = await page.evaluate('window.__sg ? window.__sg.contextState() : "missing"');
            if (state === 'missing') failures.push('window.__sg debug API missing (Base.astro script did not run)');
            else if (state !== 'running') failures.push(`audio context not running after activation (${state})`);
            else if (sample.maxLevel <= 0.0015 && sample.maxPeak <= 0.01) {
              failures.push(`no signal measured after activating "${selector}" (peak ${sample.maxPeak})`);
            } else {
              notes.push(
                `audio OK via ${selector}${usedHold ? ' (held)' : ''}: level ${sample.maxLevel.toFixed(3)}, peak ${sample.maxPeak.toFixed(3)}, voices ${sample.voices} @ ${state}`,
              );
            }

            const stopped = await page.clickSelector('[data-transport="stop-all"]');
            if (stopped) {
              // Allow a scheduled click or the tail of a fade to finish, then
              // require silence.
              await sleep(500);
              const after = await page.sampleOutput(1200, 80);
              if (after.maxLevel > 0.01 || after.voices > 0) {
                failures.push(`"Stop all" did not silence the page (level ${after.maxLevel}, voices ${after.voices})`);
              } else notes.push('stop-all silenced output');
            }
          }
        }
      }

      await page.screenshot(join(outDir, `page${route === '/' ? '-home' : route.replace(/\//g, '-')}${mobile ? '-mobile' : ''}.png`));

      if (page.pageErrors.length) failures.push(...page.pageErrors.map((error) => `page error: ${error.split('\n')[0]}`));
      const ANALYTICS_NOISE = /googletagmanager|google-analytics|Google Analytics/;
      const consoleErrors = page.consoleErrors.filter(
        // The dev server serves the not-found page with a 404 status; that is the
        // expected response for this route, not a defect.
        (error) => !(route === '/404' && /404 \(Not Found\)/.test(error)),
      ).filter(
        // Analytics may be blocked or unreachable in a test environment; that is
        // not a defect in the page.
        (error) => !ANALYTICS_NOISE.test(error),
      );
      if (consoleErrors.length) failures.push(...consoleErrors.map((error) => `console error: ${error}`));
    } catch (error) {
      failures.push(`harness error: ${error.message}`);
    } finally {
      await page.close();
    }

    results.push({ route, failures, notes });
    const status = failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(`  ${status}  ${route}`);
    for (const note of notes) console.log(`        · ${note}`);
    for (const failure of failures) console.log(`        ! ${failure}`);
    if (failures.length) exitCode = 1;
  }

  // ---- link check ------------------------------------------------------
  const linkResults = [];
  for (const link of [...internalLinks].sort()) {
    if (link.endsWith('.xml') || link.endsWith('.txt')) continue; // generated at build time only
    const url = `${base}${link}`;
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) linkResults.push({ link, status: response.status });
    } catch (error) {
      linkResults.push({ link, status: error.message });
    }
  }
  if (linkResults.length) {
    console.log(`\n  Broken internal links (${linkResults.length}):`);
    for (const item of linkResults) console.log(`    ! ${item.link} → ${item.status}`);
    exitCode = 1;
  } else {
    console.log(`\n  All ${internalLinks.size} internal link(s) resolve.`);
  }

  const failedRoutes = results.filter((r) => r.failures.length);
  console.log(
    `\n  ${results.length - failedRoutes.length}/${results.length} route(s) clean, ${internalLinks.size} link(s) checked.` +
      `\n  Screenshots: ${outDir}/\n`,
  );

  writeFileSync(
    `${outDir}/report${mobile ? '-mobile' : ''}.json`,
    JSON.stringify({ base, mobile, checkedAt: new Date().toISOString(), routes: results, brokenLinks: linkResults }, null, 2),
  );
} catch (error) {
  console.error(`QA sweep failed to run: ${error.message}`);
  exitCode = 1;
} finally {
  await browser.close();
}

process.exit(exitCode);
