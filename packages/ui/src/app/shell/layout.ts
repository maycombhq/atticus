import { useEffect, useState } from "react";

/**
 * ADR 0194: which layout the app uses, chosen per browser (Settings › Layout, or Ctrl+K's
 * "Switch to the classic layout"): the IDE layout, the default from beta.26, or the classic one
 * (the menu on the left, one page at a time), kept for this release as a safety net. With no
 * storage (a private window, blocked site data) it is the default. Also kept here: the side
 * panel's width and whether it is hidden, and whether the bottom panel is open.
 */

export type Layout = "ide" | "classic";
export const LAYOUTS: readonly Layout[] = ["ide", "classic"];
export const LAYOUT_KEY = "atticus.layout";
export const SIDE_KEY = "atticus.shell.side";
export const BOTTOM_KEY = "atticus.shell.bottom";
/** Heard by every part showing the layout when it changes (the Settings form, Ctrl+K). */
export const LAYOUT_EVENT = "atticus:layout";

export const SIDE_MIN = 180;
export const SIDE_MAX = 480;
export const SIDE_DEFAULT = 260;

type Store = Pick<Storage, "getItem" | "setItem">;

function browserStore(): Store | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function read(key: string, store: Store | undefined): string | undefined {
  try {
    return store?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, v: string, store: Store | undefined): void {
  try {
    store?.setItem(key, v);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}

export function readLayout(store: Store | undefined = browserStore()): Layout {
  const v = read(LAYOUT_KEY, store);
  return v === "classic" ? "classic" : "ide";
}

/** Save the layout and tell every part showing it. */
export function saveLayout(l: Layout, store: Store | undefined = browserStore()): void {
  write(LAYOUT_KEY, l, store);
  try {
    globalThis.dispatchEvent?.(new CustomEvent(LAYOUT_EVENT, { detail: l }));
  } catch {
    // No window (a test): nothing to tell.
  }
}

/** The layout and a setter that saves it; follows a change made elsewhere on the page. */
export function useLayout(): [Layout, (l: Layout) => void] {
  const [layout, set] = useState<Layout>(() => readLayout());
  useEffect(() => {
    const on = (e: Event) => set((e as CustomEvent<Layout>).detail);
    addEventListener(LAYOUT_EVENT, on);
    return () => removeEventListener(LAYOUT_EVENT, on);
  }, []);
  return [layout, saveLayout];
}

export interface SidePrefs {
  width: number;
  hidden: boolean;
}

export const clampSide = (w: number): number =>
  Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, Number.isFinite(w) ? w : SIDE_DEFAULT)));

export function readSide(store: Store | undefined = browserStore()): SidePrefs {
  const v = read(SIDE_KEY, store);
  try {
    const o = v ? (JSON.parse(v) as { width?: unknown; hidden?: unknown }) : {};
    return {
      width: clampSide(typeof o.width === "number" ? o.width : SIDE_DEFAULT),
      hidden: o.hidden === true,
    };
  } catch {
    return { width: SIDE_DEFAULT, hidden: false };
  }
}

export function saveSide(p: SidePrefs, store: Store | undefined = browserStore()): void {
  write(SIDE_KEY, JSON.stringify({ width: clampSide(p.width), hidden: p.hidden }), store);
}

/** Whether the bottom panel is open: undefined until the viewer chose. */
export function readBottom(store: Store | undefined = browserStore()): boolean | undefined {
  const v = read(BOTTOM_KEY, store);
  return v === "open" ? true : v === "closed" ? false : undefined;
}

export function saveBottom(open: boolean, store: Store | undefined = browserStore()): void {
  write(BOTTOM_KEY, open ? "open" : "closed", store);
}
