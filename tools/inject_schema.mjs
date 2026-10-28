/**
 * FAQPage structured data, generated from the FAQ markup that is actually on the page.
 *
 *   node tools/inject_schema.mjs
 *
 * Runs automatically after `astro build`. Generating the schema from the rendered
 * `details/summary` blocks guarantees the structured data always matches the
 * visible answer, which is what search engines require (hand-written schema
 * drifts the moment someone edits the copy). Idempotent: any previously injected
 * block is replaced.
 *
 * Note on expectations: FAQ rich results are only shown for a narrow set of
 * authoritative sites, so this is for entity clarity rather than guaranteed
 * SERP furniture.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
if (!existsSync(dist)) {
  console.error('dist/ not found. Run `npm run build` first.');
  process.exit(1);
}

const SKIP_DIRS = new Set(['dev', 'og-card', '_astro', 'worklets']);
const MARKER = 'data-schema="faq"';

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '-')
    .replace(/&ndash;/g, '-')
    .replace(/&hellip;/g, '...');
}

function clean(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Pull question/answer pairs out of the rendered FAQ section. */
function extractFaqs(html) {
  const faqs = [];
  const faqBlocks = html.match(/<div class="faq"[^>]*>[\s\S]*?<\/div>/g) ?? [];
  for (const block of faqBlocks) {
    const details = block.match(/<details[^>]*>[\s\S]*?<\/details>/g) ?? [];
    for (const item of details) {
      const question = clean(item.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] ?? '');
      const answer = clean(item.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '');
      if (question.length > 8 && answer.length > 30) faqs.push({ question, answer });
    }
  }
  return faqs;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (SKIP_DIRS.has(entry) && dir === dist) continue;
    if (existsSync(join(full, 'index.html'))) out.push(full);
    walk(full, out);
  }
  return out;
}

const pages = [dist, ...walk(dist)];
let injected = 0;
let totalQuestions = 0;
const report = [];

for (const dir of pages) {
  const file = join(dir, 'index.html');
  if (!existsSync(file)) continue;
  let html = readFileSync(file, 'utf8');

  // Drop any block we injected on a previous run.
  html = html.replace(new RegExp(`<script type="application/ld\\+json" ${MARKER}>[\\s\\S]*?</script>\\n?`, 'g'), '');

  const faqs = extractFaqs(html);
  if (faqs.length < 2) continue;

  const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? '';
  const payload = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    ...(canonical ? { '@id': `${canonical}#faq` } : {}),
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  };

  const block = `<script type="application/ld+json" ${MARKER}>${JSON.stringify(payload)}</script>\n`;
  html = html.replace('</head>', `${block}</head>`);
  writeFileSync(file, html);

  injected += 1;
  totalQuestions += faqs.length;
  report.push({ page: `/${dir.replace(/\\/g, '/').replace(/^dist\/?/, '')}`.replace(/\/$/, '/'), questions: faqs.length });
}

console.log(`\n  FAQ structured data: ${totalQuestions} questions across ${injected} page(s)`);
for (const item of report) console.log(`  ${item.page.padEnd(32)} ${item.questions} questions`);
console.log();
