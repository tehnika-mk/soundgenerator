/**
 * DSP verification: renders every signal type through the production modules and
 * measures the result numerically.
 *
 *   node tools/audio_tests.mjs [--base=http://localhost:4321]
 *
 * Requires a running server (npm run dev, or npm run build && npm run preview).
 * Exits non-zero if any check fails.
 */

import { Browser, sleep } from './lib/cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);

const base = (args.base ?? process.env.SG_BASE ?? 'http://localhost:4321').replace(/\/$/, '');
const outDir = 'qa-artifacts';

function pad(text, width) {
  const value = String(text);
  return value.length >= width ? value.slice(0, width) : value + ' '.repeat(width - value.length);
}

const instance = new Browser({ port: 9444 });

let exitCode = 0;
try {
  await instance.launch();
  const page = await instance.newPage(`${base}/dev/audio-checks`);

  const deadline = Date.now() + 90_000;
  let report = null;
  while (Date.now() < deadline) {
    report = await page.evaluate('window.__audioChecks ? JSON.stringify(window.__audioChecks) : null');
    if (report) {
      const parsed = JSON.parse(report);
      if (parsed.done) break;
    }
    await sleep(500);
  }

  const collected = await page.evaluate('window.__audioChecks ? JSON.stringify(window.__audioChecks) : null');
  const errors = [...page.pageErrors, ...page.consoleErrors];
  await page.close();

  if (!collected) {
    console.error('The audio check page never reported results. Console output:');
    console.error(errors.join('\n') || '(none)');
    exitCode = 1;
  } else {
    const parsed = JSON.parse(collected);
    console.log(`\n  DSP checks - ${base}/dev/audio-checks\n`);
    console.log(`  ${pad('CHECK', 42)}${pad('EXPECTED', 40)}${pad('MEASURED', 34)}RESULT`);
    console.log(`  ${'-'.repeat(124)}`);
    for (const result of parsed.results ?? []) {
      console.log(
        `  ${pad(result.name, 42)}${pad(result.expected, 40)}${pad(result.measured, 34)}${result.pass ? 'PASS' : 'FAIL'}`,
      );
    }
    console.log(`\n  ${parsed.passed}/${parsed.total} passed${parsed.error ? ` - harness error: ${parsed.error}` : ''}`);
    if (errors.length) {
      console.log('\n  Browser errors during the run:');
      for (const error of errors) console.log(` - ${error}`);
    }

    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}/audio-tests.json`, JSON.stringify({ base, checkedAt: new Date().toISOString(), ...parsed, browserErrors: errors }, null, 2));
    console.log(`  Report: ${outDir}/audio-tests.json\n`);
    if (parsed.failed > 0 || parsed.error || errors.length) exitCode = 1;
  }
} catch (error) {
  console.error(`Audio checks failed to run: ${error.message}`);
  exitCode = 1;
} finally {
  await instance.close();
}

process.exit(exitCode);
