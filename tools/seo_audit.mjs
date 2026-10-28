/**
 * SEO / metadata / structured-data audit of the built site.
 *
 *   npm run build && node tools/seo_audit.mjs
 *
 * Checks per page: title length and shape, meta description length, canonical,
 * Open Graph and Twitter tags (including that og:image actually exists on disk),
 * heading structure, JSON-LD validity and required properties, em dashes in
 * user-facing copy, plus site-wide robots.txt, sitemap and internal linking.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Em dash, built from its code point so a scripted search and replace can never alter it. */
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

const dist = 'dist';
const failures = [];
const warnings = [];
const pageReports = [];

if (!existsSync(dist)) {
  console.error('dist/ not found. Run `npm run build` first.');
  process.exit(1);
}

function walk(dir, prefix = '') {
  const routes = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry === 'dev' && prefix === '') continue;
    if (existsSync(join(full, 'index.html'))) routes.push(`${prefix}/${entry}`);
    routes.push(...walk(full, `${prefix}/${entry}`));
  }
  return routes;
}

const routes = existsSync(join(dist, 'index.html')) ? ['/', ...walk(dist)] : walk(dist);
const titles = new Map();
const descriptions = new Map();
const canonicals = new Map();
const allInternalLinks = new Set();
const schemaTypes = new Map();

/** Registry entries, for cross-checking that every tool is reachable. */
const registry = readFileSync('src/data/tools.ts', 'utf8');
const registeredRoutes = [...registry.matchAll(/href:\s*'([^']+)'/g)]
  .map((m) => m[1])
  .filter((href) => href.startsWith('/'));

for (const route of routes.sort()) {
  const file = route === '/' ? join(dist, 'index.html') : join(dist, route.replace(/^\//, ''), 'index.html');
  const html = readFileSync(file, 'utf8');

  const title = html.match(/<title[^>]*>([^<]*)<\/title>/)?.[1]?.trim() ?? '';
  const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1]?.trim() ?? '';
  const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? '';
  const ogTitle = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? '';
  const ogDescription = html.match(/<meta property="og:description" content="([^"]*)"/)?.[1] ?? '';
  const ogImage = html.match(/<meta property="og:image" content="([^"]*)"/)?.[1] ?? '';
  const ogUrl = html.match(/<meta property="og:url" content="([^"]*)"/)?.[1] ?? '';
  const ogType = html.match(/<meta property="og:type" content="([^"]*)"/)?.[1] ?? '';
  const twitterCard = html.match(/<meta name="twitter:card" content="([^"]*)"/)?.[1] ?? '';
  const robots = html.match(/<meta name="robots" content="([^"]*)"/)?.[1] ?? '';
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  const jsonLdBlocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const noindex = robots.includes('noindex');

  const visibleText = html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&mdash;|&#8212;/g, EM_DASH)
    .replace(/&ndash;|&#8211;/g, EN_DASH)
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

  // ---- title ---------------------------------------------------------
  if (!noindex) {
    if (title.length < 15) failures.push(`${route}: title too short (${title.length})`);
    if (title.length > 65) warnings.push(`${route}: title is ${title.length} chars, may truncate in search results ("${title}")`);
    if (titles.has(title)) failures.push(`${route}: duplicate title, same as ${titles.get(title)}`);
    titles.set(title, route);
    if (!/[|\u00b7]/.test(title) && route !== '/') warnings.push(`${route}: title has no separator ("${title}")`);

    // ---- description -------------------------------------------------
    if (description.length < 70) failures.push(`${route}: meta description too short (${description.length})`);
    if (description.length > 165) warnings.push(`${route}: description is ${description.length} chars, may truncate`);
    if (descriptions.has(description)) failures.push(`${route}: duplicate description, same as ${descriptions.get(description)}`);
    descriptions.set(description, route);

    // ---- canonical ---------------------------------------------------
    if (!canonical.startsWith('https://soundgenerator.app')) failures.push(`${route}: canonical is "${canonical}"`);
    if (canonicals.has(canonical)) failures.push(`${route}: duplicate canonical, same as ${canonicals.get(canonical)}`);
    canonicals.set(canonical, route);

    // ---- open graph --------------------------------------------------
    if (!ogTitle) failures.push(`${route}: missing og:title`);
    if (!ogDescription) failures.push(`${route}: missing og:description`);
    if (!ogType) failures.push(`${route}: missing og:type`);
    if (!ogUrl) failures.push(`${route}: missing og:url`);
    if (!ogImage) failures.push(`${route}: missing og:image`);
    else {
      const imagePath = ogImage.replace(/^https?:\/\/[^/]+/, '');
      if (!existsSync(join(dist, imagePath.replace(/^\//, '')))) {
        failures.push(`${route}: og:image ${imagePath} is not present in the build`);
      }
    }
    if (!twitterCard) failures.push(`${route}: missing twitter:card`);
    if (!/<meta property="og:site_name"/.test(html)) failures.push(`${route}: missing og:site_name`);

    // ---- headings ----------------------------------------------------
    if (h1s.length !== 1) failures.push(`${route}: expected 1 h1, found ${h1s.length}`);

    // ---- structured data ---------------------------------------------
    if (!jsonLdBlocks.length) failures.push(`${route}: no JSON-LD structured data`);
    for (const block of jsonLdBlocks) {
      let parsed;
      try {
        parsed = JSON.parse(block);
      } catch (error) {
        failures.push(`${route}: invalid JSON-LD (${error.message})`);
        continue;
      }
      const type = parsed['@type'] ?? (parsed['@graph'] ? '@graph' : 'unknown');
      if (type !== '@graph') schemaTypes.set(type, (schemaTypes.get(type) ?? 0) + 1);
      if (type === 'WebApplication') {
        for (const key of ['name', 'url', 'description', 'applicationCategory', 'offers']) {
          if (!(key in parsed)) failures.push(`${route}: WebApplication schema missing "${key}"`);
        }
      }
      if (type === 'BreadcrumbList' && !Array.isArray(parsed.itemListElement)) {
        failures.push(`${route}: BreadcrumbList without itemListElement`);
      }
      if (type === 'FAQPage') {
        const entities = parsed.mainEntity;
        if (!Array.isArray(entities) || entities.length < 2) {
          failures.push(`${route}: FAQPage without a mainEntity list`);
        } else if (entities.some((q) => q['@type'] !== 'Question' || !q.name || !q.acceptedAnswer?.text)) {
          failures.push(`${route}: FAQPage has a malformed question entry`);
        }
      }
      if (type === '@graph' || parsed['@graph']) {
        for (const node of parsed['@graph'] ?? []) {
          const nodeType = node['@type'] ?? 'unknown';
          schemaTypes.set(nodeType, (schemaTypes.get(nodeType) ?? 0) + 1);
        }
      }
    }

    // ---- copy hygiene ------------------------------------------------
    const dashAt = visibleText.indexOf(EM_DASH);
    if (dashAt >= 0) {
      failures.push(`${route}: em dash in visible text (${visibleText.slice(Math.max(0, dashAt - 40), dashAt + 20)})`);
    }
    if (title.includes(EM_DASH) || description.includes(EM_DASH)) failures.push(`${route}: em dash in title or description`);
  } else if (!robots.includes('noindex')) {
    warnings.push(`${route}: expected noindex for a non-indexable route`);
  }

  for (const link of [...html.matchAll(/<a[^>]+href="(\/[^"#?]*)/g)].map((m) => m[1])) allInternalLinks.add(link);

  // Build-only artifacts (the XML sitemap, robots.txt) exist in dist but not on
  // the dev server, and they are for crawlers, not readers. Linking one from the
  // page chrome produced a 404 for a real visitor once; this keeps it out.
  const crawlerLinks = [...html.matchAll(/<a[^>]+href="(\/[^"#?]*\.(?:xml|txt))"/g)].map((m) => m[1]);
  if (crawlerLinks.length) failures.push(`${route}: links to a build-only crawler artifact (${crawlerLinks.join(', ')})`);

  pageReports.push({
    route,
    title: title.length,
    description: description.length,
    schema: jsonLdBlocks.length,
    noindex,
  });
}

// ---- source hygiene --------------------------------------------------
// House style: no em dashes anywhere, including comments and tooling. This
// catches a reintroduction in source even when it never reaches the build.
{
  const roots = ['src', 'public', 'tools', 'docs'];
  const extensions = ['.astro', '.ts', '.js', '.mjs', '.css', '.md', '.json', '.txt', '.toml'];
  const offenders = [];
  const scan = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === '.git') continue;
        scan(full);
        continue;
      }
      if (!extensions.includes(full.slice(full.lastIndexOf('.')))) continue;
      if (readFileSync(full, 'utf8').includes(EM_DASH)) offenders.push(full);
    }
  };
  for (const root of roots) if (existsSync(root)) scan(root);
  if (existsSync('README.md') && readFileSync('README.md', 'utf8').includes(EM_DASH)) offenders.push('README.md');
  for (const file of offenders) failures.push(`em dash in source file ${file}`);
}

// ---- site-wide -------------------------------------------------------
if (!existsSync(join(dist, 'robots.txt'))) failures.push('robots.txt missing');
else {
  const robots = readFileSync(join(dist, 'robots.txt'), 'utf8');
  if (!/Sitemap:/i.test(robots)) failures.push('robots.txt has no Sitemap directive');
}

const sitemapPath = join(dist, 'sitemap-0.xml');
if (!existsSync(sitemapPath)) failures.push('sitemap-0.xml missing');
else {
  const sitemap = readFileSync(sitemapPath, 'utf8');
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const route of registeredRoutes) {
    const expected = `https://soundgenerator.app${route}`;
    if (!urls.some((u) => u.replace(/\/$/, '') === expected.replace(/\/$/, ''))) {
      failures.push(`sitemap is missing registered route ${route}`);
    }
  }
  if (urls.some((u) => u.includes('/dev/'))) failures.push('sitemap includes the /dev/ harness');
  if (!sitemap.includes('<lastmod>')) warnings.push('sitemap has no <lastmod> dates');
}

for (const route of registeredRoutes) {
  if (route === '/404') continue;
  if (!allInternalLinks.has(route) && route !== '/') {
    warnings.push(`${route} is not linked from any page`);
  }
}

// ---- report ----------------------------------------------------------
console.log('\n  SEO and metadata audit\n');
console.log('  ROUTE                              TITLE  DESC  SCHEMA');
console.log(`  ${'-'.repeat(58)}`);
for (const report of pageReports) {
  console.log(
    `  ${report.route.padEnd(33)}${String(report.title).padStart(5)}${String(report.description).padStart(6)}${String(report.schema).padStart(8)}${report.noindex ? '  noindex' : ''}`,
  );
}
console.log(`\n  schema types: ${[...schemaTypes.entries()].map(([type, count]) => `${type} x${count}`).join(', ')}`);
console.log(`  ${pageReports.length} page(s), ${failures.length} failure(s), ${warnings.length} warning(s)\n`);
for (const warning of warnings) console.log(`  ~ ${warning}`);
for (const failure of failures) console.log(`  x ${failure}`);
console.log();

process.exit(failures.length ? 1 : 0);
