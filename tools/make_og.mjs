/**
 * Render the social preview image.
 *
 *   npm run build && npm run og
 *
 * Loads /og-card from the preview server, screenshots it at 1200x630 and writes
 * public/og.png (and dist/og.png if a build exists). Re-run after changing the
 * card so the Open Graph image never goes stale or missing.
 */

import { Browser } from './lib/cdp.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);

const base = (args.base ?? process.env.SG_BASE ?? 'http://localhost:4322').replace(/\/$/, '');
const out = 'public/og.png';
const browser = new Browser({ port: 9666 });

function pngSize(buffer) {
  // PNG IHDR: width and height are big-endian uint32 at offsets 16 and 20.
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

try {
  await browser.launch();
  const page = await browser.newPage();
  await page.resize(1200, 630, false);
  await page.goto(`${base}/og-card`, { waitMs: 700 });

  const { data } = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, page.sessionId);
  const buffer = Buffer.from(data, 'base64');
  const size = pngSize(buffer);

  if (size.width !== 1200 || size.height !== 630) {
    throw new Error(`unexpected image size ${size.width}x${size.height}, expected 1200x630`);
  }

  writeFileSync(out, buffer);
  let copied = '';
  if (existsSync('dist')) {
    writeFileSync('dist/og.png', buffer);
    copied = ' (also written to dist/og.png)';
  }

  await page.close();
  console.log(`\n  Wrote ${out}: ${size.width}x${size.height}, ${(buffer.length / 1024).toFixed(0)} KB${copied}\n`);
} catch (error) {
  console.error(`\n  Could not render the social card: ${error.message}`);
  console.error('  Is a server running? npm run dev, or npm run build && npm run preview\n');
  process.exitCode = 1;
} finally {
  await browser.close();
}

// Sanity check: the file we just wrote must be a real PNG.
try {
  const check = readFileSync(out);
  const signature = check.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') throw new Error('not a PNG');
  console.log(`  Verified ${out} signature and dimensions.\n`);
} catch (error) {
  console.error(`  ${out} is not a valid PNG: ${error.message}`);
  process.exitCode = 1;
}
