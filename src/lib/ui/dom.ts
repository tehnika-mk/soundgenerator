/**
 * Small DOM helpers shared by every tool page. Deliberately tiny - the site
 * ships no client framework, so these keep the per-page scripts readable.
 */

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}

export function qsa<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/** Find an element by its data attribute role, e.g. data-tg="play". */
export function slot<T extends Element = HTMLElement>(
  root: ParentNode,
  name: string,
  attr = 'data-tg',
): T | null {
  return root.querySelector<T>(`[${attr}="${name}"]`);
}

export function slots<T extends Element = HTMLElement>(root: ParentNode, name: string, attr = 'data-tg'): T[] {
  return Array.from(root.querySelectorAll<T>(`[${attr}="${name}"]`));
}

export function on<K extends keyof HTMLElementEventMap>(
  target: EventTarget | null,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): void {
  target?.addEventListener(type, handler as EventListener, options);
}

export function setPressed(el: Element | null, pressed: boolean): void {
  if (!el) return;
  if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', String(pressed));
  else if (el.hasAttribute('aria-checked')) el.setAttribute('aria-checked', String(pressed));
  else el.setAttribute('data-state', pressed ? 'on' : 'off');
}

export function setActive(el: Element | null, active: boolean): void {
  el?.setAttribute('data-state', active ? 'on' : 'off');
}

export function setText(el: Element | null, text: string): void {
  if (el) el.textContent = text;
}

export function toggleClass(el: Element | null, name: string, force?: boolean): void {
  el?.classList.toggle(name, force);
}

/** Keep a range input's filled-track colour in sync with its value. */
export function bindSliderFill(input: HTMLInputElement): void {
  const update = () => {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const value = Number(input.value);
    const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
    input.style.setProperty('--fill', `${pct}%`);
  };
  update();
  input.addEventListener('input', update);
  input.addEventListener('change', update);
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait = 150): (...args: A) => void {
  let timer = 0;
  return (...args: A) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'true');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export type StatusKind = 'idle' | 'ok' | 'warn' | 'error';

/** Update a status line (used for validation and export feedback). */
export function setStatus(el: Element | null, message: string, kind: StatusKind = 'idle'): void {
  if (!el) return;
  el.textContent = message;
  el.setAttribute('data-kind', kind);
  if (kind === 'ok' || kind === 'error') {
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  }
  const host = el.closest<HTMLElement>('[data-status-host]');
  if (host) host.dataset.status = kind;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Read a numeric query-string parameter, with a fallback. */
export function queryNumber(name: string, fallback: number): number {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function queryString(name: string, fallback = ''): string {
  const params = new URLSearchParams(window.location.search);
  return params.get(name) ?? fallback;
}

/** Update a query-string parameter without adding history entries. */
export function setQueryParam(name: string, value: string | number | null): void {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, String(value));
  window.history.replaceState({}, '', url);
}

/** Base64url encode/decode for share links (multiple tone generator presets). */
export function encodeShare(payload: unknown): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeShare<T>(value: string, fallback: T): T {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return fallback;
  }
}

/** Announce something to screen readers without moving focus. */
export function announce(message: string): void {
  let region = document.getElementById('sg-live-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'sg-live-region';
    region.className = 'visually-hidden';
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  region.textContent = '';
  window.setTimeout(() => {
    region!.textContent = message;
  }, 30);
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${ms}`;
}
