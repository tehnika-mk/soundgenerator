/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Node 22+ ships a global WebSocket, so a full browser automation dependency is
 * not needed for the checks this project runs: launch a headless browser with
 * --remote-debugging-port, attach to a target, drive Input/Page/Runtime.
 *
 * Used by tools/browser_qa.mjs and tools/audio_tests.mjs.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WINDOWS_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const OTHER_CANDIDATES = [
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

export function findBrowser() {
  if (process.env.SG_BROWSER && existsSync(process.env.SG_BROWSER)) return process.env.SG_BROWSER;
  const candidates = process.platform === 'win32' ? WINDOWS_CANDIDATES : OTHER_CANDIDATES;
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `No Chromium-based browser found. Set SG_BROWSER to an executable path.\nTried:\n${candidates.join('\n')}`,
    );
  }
  return found;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Browser {
  constructor({ port = 9333, headless = true, extraArgs = [] } = {}) {
    this.port = port;
    this.headless = headless;
    this.extraArgs = extraArgs;
    this.process = null;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.userDataDir = null;
  }

  async launch() {
    const exe = findBrowser();
    this.userDataDir = mkdtempSync(join(tmpdir(), 'sg-qa-'));
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--window-size=1440,1000',
      ...(this.headless ? ['--headless=new', '--disable-gpu'] : []),
      ...this.extraArgs,
      'about:blank',
    ];
    this.process = spawn(exe, args, { stdio: 'ignore' });
    this.process.unref?.();

    const deadline = Date.now() + 30_000;
    let version = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        if (response.ok) {
          version = await response.json();
          break;
        }
      } catch {
        /* not up yet */
      }
      await sleep(200);
    }
    if (!version) throw new Error('Browser did not expose a debugging port in time.');

    this.socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => this.#onMessage(event));
    return this;
  }

  #onMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? '')})`));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      const handlers = this.handlers.get(message.method);
      if (handlers) for (const handler of handlers) handler(message.params, message.sessionId);
      const wildcard = this.handlers.get('*');
      if (wildcard) for (const handler of wildcard) handler(message, message.sessionId);
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  /** True when the browser still answers on the debugging socket. */
  async isAlive() {
    try {
      await Promise.race([
        this.send('Browser.getVersion', {}),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /** Restart the browser after a crash and return a fresh connection. */
  async relaunch() {
    await this.close();
    this.process = null;
    this.socket = null;
    this.nextId = 1;
    this.pending.clear();
    this.handlers.clear();
    await this.launch();
    return this;
  }

  async newPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Log.enable', {}, sessionId);
    await this.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
    const page = new Page(this, sessionId, targetId);
    if (url !== 'about:blank') await page.goto(url);
    return page;
  }

  async close() {
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    if (this.process) {
      this.process.kill();
      await sleep(300);
    }
    if (this.userDataDir) {
      try {
        rmSync(this.userDataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

export class Page {
  constructor(browser, sessionId, targetId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.consoleErrors = [];
    this.pageErrors = [];
    this.failedRequests = [];
    this.loaded = false;

    browser.on('Runtime.consoleAPICalled', (params, session) => {
      if (session !== this.sessionId) return;
      if (params.type === 'error') {
        this.consoleErrors.push((params.args ?? []).map((a) => a.value ?? a.description ?? a.unserializableValue ?? '').join(' '));
      }
    });
    browser.on('Runtime.exceptionThrown', (params, session) => {
      if (session !== this.sessionId) return;
      const details = params.exceptionDetails;
      this.pageErrors.push(details?.exception?.description ?? details?.text ?? 'unknown exception');
    });
    browser.on('Log.entryAdded', (params, session) => {
      if (session !== this.sessionId) return;
      if (params.entry.level === 'error') this.consoleErrors.push(params.entry.text);
    });
    browser.on('Page.loadEventFired', (_params, session) => {
      if (session === this.sessionId) this.loaded = true;
    });
  }

  async goto(url, { waitMs = 600 } = {}) {
    this.loaded = false;
    await this.browser.send('Page.navigate', { url }, this.sessionId);
    const deadline = Date.now() + 20_000;
    while (!this.loaded && Date.now() < deadline) await sleep(80);
    await sleep(waitMs);
    return this;
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.browser.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise, userGesture: true },
      this.sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  /** Trusted click at the centre of an element (CDP mouse events count as user input). */
  async clickSelector(selector) {
    return this.#pointerAction(selector, 'click', 0);
  }

  /**
   * Activate a control the way a keyboard user would: focus it, then send a
   * trusted Enter key press. Coordinates are avoided on purpose - a reflow
   * between measuring and clicking (very common on narrow viewports) silently
   * sends the click to whatever moved under the cursor.
   */
  async activateSelector(selector) {
    const focused = await this.evaluate(`(() => {
      document.documentElement.style.scrollBehavior = 'auto';
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      el.focus({ preventScroll: true });
      return document.activeElement === el;
    })()`);
    if (!focused) return this.clickSelector(selector);

    for (const type of ['rawKeyDown', 'char', 'keyUp']) {
      await this.browser.send(
        'Input.dispatchKeyEvent',
        {
          type,
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: type === 'char' ? '\r' : undefined,
        },
        this.sessionId,
      );
    }
    return true;
  }

  /** Press, hold for `holdMs`, release - for momentary (press-and-hold) controls. */
  async holdSelector(selector, holdMs = 400) {
    return this.#pointerAction(selector, 'hold', holdMs);
  }

  /**
   * Scroll the element into view, verify it is actually the thing at the target
   * point (the site uses smooth scrolling, which otherwise races the click),
   * then dispatch trusted mouse events.
   */
  async #pointerAction(selector, mode, holdMs) {
    const prepared = await this.evaluate(`(() => {
      document.documentElement.style.scrollBehavior = 'auto';
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return true;
    })()`);
    if (!prepared) return false;
    await sleep(180);

    const point = JSON.parse(
      await this.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'null';
        const r = el.getBoundingClientRect();
        const x = Math.min(Math.max(r.left + r.width / 2, 2), window.innerWidth - 2);
        const y = Math.min(Math.max(r.top + r.height / 2, 2), window.innerHeight - 2);
        const hit = document.elementFromPoint(x, y);
        return JSON.stringify({ x, y, hits: !!(hit && (hit === el || el.contains(hit) || hit.contains(el))), tag: hit ? hit.tagName : 'none' });
      })()`),
    );
    if (point.hits === false) return false;

    await this.browser.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 },
      this.sessionId,
    );
    if (mode === 'hold') {
      await sleep(holdMs);
      await this.browser.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 },
        this.sessionId,
      );
      return true;
    }
    await this.browser.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 },
      this.sessionId,
    );
    return true;
  }

  /**
   * Press a momentary control, sample the output *while it is held*, then
   * release. Press-and-hold controls (piano keys, DTMF pads, tuning strings)
   * stop the sound on pointerup, so measuring after the release always reads
   * silence.
   */
  async pressAndSample(selector, holdMs = 700, intervalMs = 70) {
    const prepared = await this.evaluate(`(() => {
      document.documentElement.style.scrollBehavior = 'auto';
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return true;
    })()`);
    if (!prepared) return { ok: false, maxLevel: 0, maxPeak: 0, voices: 0 };
    await sleep(180);

    const point = JSON.parse(
      await this.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'null';
        const r = el.getBoundingClientRect();
        const x = Math.min(Math.max(r.left + r.width / 2, 2), window.innerWidth - 2);
        const y = Math.min(Math.max(r.top + r.height / 2, 2), window.innerHeight - 2);
        const hit = document.elementFromPoint(x, y);
        return JSON.stringify({ x, y, hits: !!(hit && (hit === el || el.contains(hit) || hit.contains(el))) });
      })()`),
    );
    if (!point.hits) return { ok: false, maxLevel: 0, maxPeak: 0, voices: 0 };

    await this.browser.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 },
      this.sessionId,
    );
    const sample = await this.sampleOutput(holdMs, intervalMs);
    await this.browser.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 },
      this.sessionId,
    );
    return { ok: true, ...sample };
  }

  /**
   * Watch the live output for `durationMs` and return the highest level and peak
   * seen. Transient sounds (metronome clicks, pips, alarm pulses) only exist for
   * tens of milliseconds, so a single reading proves nothing.
   */
  async sampleOutput(durationMs = 2500, intervalMs = 70) {
    let maxLevel = 0;
    let maxPeak = 0;
    let voices = 0;
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      const sample = await this.evaluate(`(() => {
        if (!window.__sg) return null;
        return JSON.stringify({ level: window.__sg.level(), peak: window.__sg.peak(), voices: window.__sg.voices(), state: window.__sg.contextState() });
      })()`);
      if (sample) {
        const parsed = JSON.parse(sample);
        maxLevel = Math.max(maxLevel, parsed.level ?? 0);
        maxPeak = Math.max(maxPeak, parsed.peak ?? 0);
        voices = Math.max(voices, parsed.voices ?? 0);
      }
      await sleep(intervalMs);
    }
    return { maxLevel, maxPeak, voices };
  }

  async screenshot(path) {
    const { data } = await this.browser.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, Buffer.from(data, 'base64'));
  }

  async resize(width, height, mobile = false) {
    await this.browser.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile },
      this.sessionId,
    );
    await sleep(200);
  }

  async close() {
    try {
      await this.browser.send('Target.closeTarget', { targetId: this.targetId });
    } catch {
      /* ignore */
    }
  }
}

export { sleep };
