import { useEffect, useState } from "react";

/**
 * Pinned pages (the IDE shell's Explorer, beta.26): the pages a person keeps at hand, by their
 * hash route, in the order pinned, per viewer (this browser, or this editor's panel), as the
 * menu keeps More pages open. Nothing is shared or written to a file. `PINS_EVENT` is heard by
 * every part of the shell that shows them when one pins or unpins.
 *
 * (The map's pinned boxes, app/layout/pinned.ts, are where a person put a box on the canvas,
 * kept in the metarepo: a different thing.)
 */

export const PINS_KEY = "atticus.explorer.pinned";
export const PINS_EVENT = "atticus:pins";
const MAX = 50;

type Store = Pick<Storage, "getItem" | "setItem">;

function browserStore(): Store | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Only the app's own addresses: `#/` and a page, never a script or another site. */
const isHash = (v: unknown): v is string =>
  typeof v === "string" && /^#\/[A-Za-z0-9-]/.test(v) && v.length < 400;

/** What a pinned address is kept as: Home's empty address is Home's. */
export const pinHash = (hash: string): string => (/^#?\/?$/.test(hash) ? "#/home" : hash);

/** The pinned pages; none where storage refuses or holds something else. */
export function readPins(store: Store | undefined = browserStore()): string[] {
  let v: unknown;
  try {
    v = JSON.parse(store?.getItem(PINS_KEY) ?? "[]");
  } catch {
    return [];
  }
  return Array.isArray(v) ? [...new Set(v.filter(isHash))].slice(0, MAX) : [];
}

/** The pins of this page's life, per store: what shows when the store refuses to keep them. */
const session = new WeakMap<object, string[]>();
const NO_STORE = {};
/** Stores that refused the last write (full, say): their pins are behind this page's. */
const behind = new WeakSet<object>();

function savePins(pins: string[], store: Store | undefined): void {
  session.set(store ?? NO_STORE, pins);
  try {
    store?.setItem(PINS_KEY, JSON.stringify(pins));
    if (store) behind.delete(store);
  } catch {
    // Storage blocked or full: the pins last until the page reloads.
    if (store) behind.add(store);
  }
  if (typeof dispatchEvent === "function") dispatchEvent(new CustomEvent(PINS_EVENT));
}

/** Pins the page, or unpins it if it is pinned; the pins after. */
export function togglePin(hash: string, store: Store | undefined = browserStore()): string[] {
  const h = pinHash(hash);
  const now = readPinsOr(store);
  const next = now.includes(h) ? now.filter((x) => x !== h) : [...now, h].slice(-MAX);
  savePins(next, store);
  return next;
}

/**
 * Storage's pins, or this page's when storage refuses to be read or refused the last write (a
 * full store reads its old pins: the new one would vanish), so a pin still shows until reload.
 */
export function readPinsOr(store: Store | undefined): string[] {
  let works = !!store && !behind.has(store);
  try {
    store?.getItem(PINS_KEY);
  } catch {
    works = false;
  }
  return works && store ? readPins(store) : (session.get(store ?? NO_STORE) ?? []);
}

/** The pinned pages, kept up to date as any part of the shell pins or unpins. */
export function usePins(): string[] {
  const [pins, set] = useState<string[]>(() => readPinsOr(browserStore()));
  useEffect(() => {
    const on = () => set(readPinsOr(browserStore()));
    addEventListener(PINS_EVENT, on);
    addEventListener("storage", on);
    return () => {
      removeEventListener(PINS_EVENT, on);
      removeEventListener("storage", on);
    };
  }, []);
  return pins;
}
