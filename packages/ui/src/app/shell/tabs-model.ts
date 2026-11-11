import { COPY } from "../../copy.js";
import { changeOf, screenOf } from "../screens.js";

/**
 * ADR 0194: the IDE layout's tabs, as data. The address (#/...) stays the page shown, so deep
 * links and Back and Forward work as before: the model only follows it. Opening a page opens its
 * tab or focuses the one already open; a change's pages share one tab, named by the change (its
 * stages move within it); every other page has a tab of its own, which remembers its last
 * address (an arrow picked, a search asked). Home is always the first tab and can't be closed.
 * At most MAX_TABS are open: opening one more closes the one used longest ago (never Home, never
 * the one shown). The tabs and the one shown are kept per browser (localStorage), and come back
 * on a reload.
 */

export interface Tab {
  key: string;
  /** The tab's last address: where it opens again. */
  hash: string;
  /** When it was last shown, as a counter: the one with the least closes first at the cap. */
  used: number;
}

export interface TabsState {
  tabs: Tab[];
  active: string;
}

export const HOME_KEY = "home";
export const HOME_HASH = "#/home";
export const MAX_TABS = 12;
export const TABS_KEY = "atticus.shell.tabs";

/** Only the app's own pages are kept: #/<screen>[/<id>][?query]. */
const PAGE_HASH = /^#\/[a-z][a-z0-9-]*(\/[^?\s]*)?(\?[^\s]*)?$/;

/** The tab a page opens in: a change's pages share the change's; other pages their screen's. */
export function tabKeyOf(hash: string): string {
  const s = screenOf(hash);
  const change = s.section === "Change" ? changeOf(hash) : undefined;
  return change ? `change:${change}` : s.id;
}

/** A tab's name and its tooltip: the change for a change's tab, else the page. */
export function tabLabel(t: Tab): { label: string; title: string } {
  const page = screenOf(t.hash).label;
  if (!t.key.startsWith("change:")) return { label: page, title: page };
  const change = t.key.slice("change:".length);
  return { label: change, title: COPY.ide.tabTitle(change, page) };
}

const homeTab = (used = 0): Tab => ({ key: HOME_KEY, hash: HOME_HASH, used });

export const initialTabs = (): TabsState => ({ tabs: [homeTab()], active: HOME_KEY });

const lastUsed = (s: TabsState) => s.tabs.reduce((n, t) => Math.max(n, t.used), 0);

/** Close the least recently used tabs past the cap: never Home, never the one shown. */
function capped(s: TabsState): TabsState {
  let tabs = s.tabs;
  while (tabs.length > MAX_TABS) {
    const old = tabs
      .filter((t) => t.key !== HOME_KEY && t.key !== s.active)
      .sort((a, b) => a.used - b.used)[0];
    if (!old) break;
    tabs = tabs.filter((t) => t !== old);
  }
  return tabs === s.tabs ? s : { ...s, tabs };
}

/** The address moved to a page: open its tab, or focus it and keep the address in it. */
export function openTab(s: TabsState, hash: string): TabsState {
  const key = tabKeyOf(hash);
  // Home is one page: an old address of it, or one the app doesn't know, opens it as #/home.
  const h = key === HOME_KEY || !PAGE_HASH.test(hash) ? HOME_HASH : hash;
  const at = s.tabs.find((t) => t.key === key);
  if (at && at.hash === h && s.active === key) return s;
  const used = lastUsed(s) + 1;
  const tab: Tab = { key, hash: h, used };
  const tabs = at ? s.tabs.map((t) => (t.key === key ? tab : t)) : [...s.tabs, tab];
  return capped({ tabs, active: key });
}

/**
 * Close a tab. Closing the one shown moves to its right neighbour, else its left: `go` is that
 * tab's address, for the caller to put in the address bar (which shows it).
 */
export function closeTab(s: TabsState, key: string): { state: TabsState; go?: string } {
  const i = s.tabs.findIndex((t) => t.key === key);
  if (key === HOME_KEY || i < 0) return { state: s };
  const tabs = s.tabs.filter((t) => t.key !== key);
  if (s.active !== key) return { state: { ...s, tabs } };
  const next = tabs[i] ?? tabs[i - 1] ?? homeTab();
  return { state: { tabs, active: next.key }, go: next.hash };
}

/** Move a tab one place left or right; Home stays first. */
export function moveTab(s: TabsState, key: string, by: -1 | 1): TabsState {
  const i = s.tabs.findIndex((t) => t.key === key);
  const j = i + by;
  if (key === HOME_KEY || i < 0 || j < 1 || j >= s.tabs.length) return s;
  const tabs = [...s.tabs];
  [tabs[i], tabs[j]] = [tabs[j]!, tabs[i]!];
  return { ...s, tabs };
}

type Store = Pick<Storage, "getItem" | "setItem">;

function browserStore(): Store | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The tabs this browser kept, or undefined when there are none or they can't be read. Only the
 * app's own addresses come back, each keyed again from its address, Home first, within the cap.
 */
export function readTabs(store: Store | undefined = browserStore()): TabsState | undefined {
  let raw: unknown;
  try {
    const v = store?.getItem(TABS_KEY);
    if (!v) return undefined;
    raw = JSON.parse(v);
  } catch {
    return undefined;
  }
  const o = raw as { tabs?: unknown; active?: unknown } | null;
  if (!o || !Array.isArray(o.tabs)) return undefined;
  const tabs: Tab[] = [homeTab()];
  let used = 0;
  for (const t of o.tabs as { hash?: unknown }[]) {
    const hash = typeof t?.hash === "string" ? t.hash : "";
    if (!PAGE_HASH.test(hash)) continue;
    const key = tabKeyOf(hash);
    if (key === HOME_KEY || tabs.some((x) => x.key === key)) continue;
    tabs.push({ key, hash, used: ++used });
  }
  const savedActive = typeof o.active === "string" ? o.active : HOME_KEY;
  const active = tabs.some((t) => t.key === savedActive) ? savedActive : HOME_KEY;
  // The one shown is the most recent.
  const s = { tabs: tabs.map((t) => (t.key === active ? { ...t, used: used + 1 } : t)), active };
  return capped(s);
}

export function saveTabs(s: TabsState, store: Store | undefined = browserStore()): void {
  try {
    store?.setItem(
      TABS_KEY,
      JSON.stringify({ active: s.active, tabs: s.tabs.map((t) => ({ key: t.key, hash: t.hash })) }),
    );
  } catch {
    // Storage blocked: the tabs last until the page reloads.
  }
}

/**
 * The tabs on loading the app: those kept, then the address's page (a deep link, or the page
 * shown when the app reloaded). With no address, the tab that was shown.
 */
export function restoreTabs(saved: TabsState | undefined, hash: string): TabsState {
  const s = saved ?? initialTabs();
  if (!hash || hash === "#" || hash === "#/") return s;
  return openTab(s, hash);
}

/** The address of the tab shown, for an app opened with no address. */
export const activeHash = (s: TabsState): string =>
  s.tabs.find((t) => t.key === s.active)?.hash ?? HOME_HASH;

/**
 * The address the app starts on (review, beta.26): the one it was given, or, with none, the
 * kept tab that was shown. Picked before the first render, so Home doesn't mount and then give
 * way. Home's empty address stays empty.
 */
export function startHash(hash: string, store: Store | undefined = browserStore()): string {
  if (hash && hash !== "#" && hash !== "#/") return hash;
  const h = activeHash(readTabs(store) ?? initialTabs());
  return h === HOME_HASH ? hash : h;
}
