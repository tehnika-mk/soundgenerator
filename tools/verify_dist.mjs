/**
 * Post-build static verification.
 *
 *   npm run build && node tools/verify_dist.mjs
 *
 * Checks the shipped HTML rather than the source: routes that should exist, SEO
 * essentials per page, no external scripts or insecure URLs, no leaked
 * placeholders, and that the sitemap matches the built routes. No browser
 * required, so it can run in CI before deployment.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
const failures = [];
const warnings = [];
const notes = [];
const pages = [];

if (!existsSync(dist)) {
  console.error('dist/ not found - run `npm run build` first.');
  process.exit(1);
}

/** Expected routes: derived from the tool registry so a missing page is caught. */
function registryRoutes() {
  const source = readFileSync('src/data/tools.ts', 'utf8');
  const hrefs = [...source.matchAll(/href:\s*'([^']+)'/g)].map((match) => match[1]);
  // Site paths only: the registry also holds the external footer credit URL.
  return [...new Set(hrefs.filter((href) => href.startsWith('/')))];
}

function walk(dir, prefix = '') {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory() && entry !== 'dev' && entry !== 'og-card') {
      if (existsSync(join(full, 'index.html'))) pages.push(prefix + '/' + entry);
      walk(full, prefix + '/' + entry);
    }
  }
}

walk(dist);
if (existsSync(join(dist, 'index.html'))) pages.unshift('/');

// ---- required routes -------------------------------------------------
for (const route of registryRoutes()) {
  const target = route === '/' ? join(dist, 'index.html') : join(dist, route.replace(/^\//, ''), 'index.html');
  if (!existsSync(target)) failures.push(`missing page for registered route ${route}`);
}

// ---- required assets -------------------------------------------------
for (const asset of ['robots.txt', 'favicon.svg', 'site.webmanifest', 'sitemap-index.xml']) {
  if (!existsSync(join(dist, asset))) failures.push(`missing ${asset}`);
}
if (!existsSync(join(dist, '404.html'))) failures.push('missing 404.html (the not-found page)');
if (!existsSync(join(dist, 'worklets', 'wsola-processor.js'))) {
  warnings.push('dist/worklets/wsola-processor.js missing - pitch shifter and time stretcher will fall back or fail');
}

// ---- sitemap ---------------------------------------------------------
let sitemap = '';
try {
  sitemap = readFileSync(join(dist, 'sitemap-0.xml'), 'utf8');
} catch {
  warnings.push('dist/sitemap-0.xml not found - cannot cross-check routes');
}

// ---- per page --------------------------------------------------------
const pageReports = [];
for (const route of pages.slice().sort()) {
  const file = route === '/' ? join(dist, 'index.html') : join(dist, route.replace(/^\//, ''), 'index.html');
  const html = readFileSync(file, 'utf8');
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

  const title = html.match(/<title[^>]*>([^<]*)<\/title>/)?.[1]?.trim() ?? '';
  const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1]?.trim() ?? '';
  const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? '';
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((match) => match[1].replace(/<[^>]+>/g, '').trim());
  const lang = html.match(/<html[^>]*lang="([^"]*)"/)?.[1] ?? '';
  const externalScripts = [...html.matchAll(/<script[^>]+src="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  const externalStyles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  const insecure = [...html.matchAll(/(?:src|href)="(http:\/\/[^"]+)"/g)].map((m) => m[1]);

  if (title.length < 10) failures.push(`${route}: title missing or too short ("${title}")`);
  if (description.length < 30) failures.push(`${route}: meta description missing or too short`);
  if (h1s.length !== 1) failures.push(`${route}: expected exactly one h1, found ${h1s.length}`);
  if (lang !== 'en') failures.push(`${route}: html lang is "${lang}"`);
  if (!canonical.startsWith('https://soundgenerator.app')) failures.push(`${route}: canonical is "${canonical}"`);
  // Google Analytics is the one permitted third-party script (disclosed in the privacy policy).
  const unexpectedScripts = externalScripts.filter((src) => !/^https:\/\/(www\.)?googletagmanager\.com\//.test(src));
  if (unexpectedScripts.length) failures.push(`${route}: external scripts ${unexpectedScripts.join(', ')}`);
  if (externalScripts.length && !unexpectedScripts.length) notes.push(`${route}: analytics script only`);
  if (externalStyles.length) failures.push(`${route}: external stylesheets ${externalStyles.join(', ')}`);
  if (insecure.length) warnings.push(`${route}: insecure http(s) reference ${insecure[0]}`);
  if (/\bundefined\b/.test(text)) failures.push(`${route}: rendered text contains "undefined"`);
  if (/NaN/.test(text)) warnings.push(`${route}: rendered text contains "NaN"`);
  if (route !== '/404' && sitemap && !sitemap.includes(`soundgenerator.app${route === '/' ? '/' : route}`)) {
    warnings.push(`${route}: not present in the sitemap`);
  }

  const size = Buffer.byteLength(html) / 1024;
  pageReports.push({ route, size });
}

// ---- report ----------------------------------------------------------
console.log('\n  Static build verification\n');
for (const report of pageReports) {
  console.log(`  ✓ ${report.route.padEnd(34)} ${report.size.toFixed(1)} KB html`);
}
console.log(`\n  ${pageReports.length} page(s), ${failures.length} failure(s), ${warnings.length} warning(s)\n`);
for (const note of new Set(notes)) console.log(`  i ${note}`);
for (const warning of warnings) console.log(`  ~ ${warning}`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
console.log();

process.exit(failures.length ? 1 : 0);
