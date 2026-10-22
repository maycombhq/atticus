/**
 * The app inside a VS Code panel (ADR 0097), loaded from the extension's own files rather than
 * from the local server. There is no server on the page's origin there, so every API call goes
 * to the extension as a message, which calls the local API and sends the answer back; live events
 * and "go to this view" come as messages too. The page never holds the session token.
 */

export interface BridgeReply {
  status: number;
  body: unknown;
}

export interface Bridge {
  call(path: string, o: { method: string; body?: unknown }): Promise<BridgeReply>;
  onEvent(f: (e: { type: string } & Record<string, unknown>) => void): () => void;
  onNavigate(f: (hash: string) => void): void;
}

/** Only the app's own screens: #/<screen>[/<id>][?query]. */
const SCREEN_HASH = /^#\/[a-z][a-z0-9-]*(\/[^?\s]*)?(\?[^\s]*)?$/;

type Msg = Record<string, unknown>;
const isMsg = (m: unknown): m is Msg => typeof m === "object" && m !== null;

export function makeBridge(post: (m: Msg) => void, on: (f: (m: unknown) => void) => void): Bridge {
  let next = 0;
  const waiting = new Map<number, (r: BridgeReply) => void>();
  const events = new Set<(e: { type: string } & Record<string, unknown>) => void>();
  const navigations: ((hash: string) => void)[] = [];
  on((m) => {
    if (!isMsg(m)) return;
    if (m.type === "api-reply" && typeof m.id === "number") {
      const done = waiting.get(m.id);
      waiting.delete(m.id);
      done?.({ status: Number(m.status), body: m.body });
    } else if (m.type === "event" && isMsg(m.event) && typeof m.event.type === "string") {
      for (const f of events) f(m.event as { type: string } & Record<string, unknown>);
    } else if (m.type === "navigate" && typeof m.hash === "string" && SCREEN_HASH.test(m.hash)) {
      for (const f of navigations) f(m.hash);
    }
  });
  return {
    call(path, o) {
      const id = ++next;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        post({
          type: "api",
          id,
          method: o.method,
          path,
          ...(o.body !== undefined ? { body: o.body } : {}),
        });
      });
    },
    onEvent(f) {
      events.add(f);
      return () => events.delete(f);
    },
    onNavigate(f) {
      navigations.push(f);
    },
  };
}

interface VsCodeApi {
  postMessage(m: unknown): void;
}

let shared: Bridge | undefined | null;

/** The bridge when the page runs in a VS Code panel, else none (the page talks to its server). */
export function hostBridge(): Bridge | undefined {
  if (shared !== undefined) return shared ?? undefined;
  const acquire = (globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi;
  if (typeof acquire !== "function" || typeof window === "undefined") {
    shared = null;
    return undefined;
  }
  const vscode = acquire();
  shared = makeBridge(
    (m) => vscode.postMessage(m),
    (f) => window.addEventListener("message", (e) => f(e.data)),
  );
  shared.onNavigate((hash) => {
    if (location.hash !== hash) location.hash = hash;
  });
  return shared;
}
