import { hostBridge } from "../../api/bridge.js";
import { inEditor } from "../theme.js";

/**
 * ADR 0194: whether the app is in an editor's panel, where the IDE layout leaves out its title,
 * activity and status bars. VS Code's panel says so itself (its bridge, its theme's classes on
 * the body); IntelliJ's tool window has neither, so it loads the app with `?host=intellij` before
 * the hash (Metarepo.panelUrl). The mark is kept for the session (sessionStorage, else for the
 * page's life), so an address without it, reached from inside the panel, still knows.
 */

export const HOST_KEY = "atticus.panel.host";
export const PANEL_HOSTS = ["intellij"] as const;
export type PanelHost = (typeof PANEL_HOSTS)[number];

type Store = Pick<Storage, "getItem" | "setItem">;

function sessionStore(): Store | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

const isHost = (v: unknown): v is PanelHost =>
  typeof v === "string" && (PANEL_HOSTS as readonly string[]).includes(v);

/** What a store that refuses would have kept, for this page's life. */
const session = new WeakMap<object, PanelHost>();
const NO_STORE = {};

/** The editor whose panel shows the app (from the address, else the session), or undefined. */
export function panelHost(
  search: string | undefined,
  store: Store | undefined = sessionStore(),
): PanelHost | undefined {
  let given: string | null;
  try {
    given = new URLSearchParams(search ?? "").get("host");
  } catch {
    given = null;
  }
  if (isHost(given)) {
    session.set(store ?? NO_STORE, given);
    try {
      store?.setItem(HOST_KEY, given);
    } catch {
      // Storage blocked: kept for the page's life.
    }
    return given;
  }
  try {
    const kept = store?.getItem(HOST_KEY);
    if (isHost(kept)) return kept;
  } catch {
    // Storage blocked: what this page saw.
  }
  return session.get(store ?? NO_STORE);
}

/** Whether the app is in an editor's panel: VS Code's or IntelliJ's. */
export function inEditorPanel(): boolean {
  if (hostBridge()) return true;
  if (typeof document !== "undefined" && document.body && inEditor()) return true;
  return !!panelHost(globalThis.location?.search);
}
