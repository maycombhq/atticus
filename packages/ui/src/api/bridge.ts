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

/** How an AI step run by the extension ended (ADR 0106): its state, its last lines, its run. */
export interface StepEnd {
  state: string;
  lines: string[];
  runId?: string;
}

export interface Bridge {
  call(path: string, o: { method: string; body?: unknown }): Promise<BridgeReply>;
  /**
   * Ask the extension to run an AI step with Copilot (ADR 0106): its command words and arguments.
   * Each progress line comes to onLine as it comes; the promise ends with the step's end.
   */
  runStep(args: string[], onLine: (line: string) => void): Promise<StepEnd>;
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
  const steps = new Map<number, { onLine: (l: string) => void; done: (e: StepEnd) => void }>();
  const events = new Set<(e: { type: string } & Record<string, unknown>) => void>();
  const navigations: ((hash: string) => void)[] = [];
  on((m) => {
    if (!isMsg(m)) return;
    if (m.type === "api-reply" && typeof m.id === "number") {
      const done = waiting.get(m.id);
      waiting.delete(m.id);
      done?.({ status: Number(m.status), body: m.body });
    } else if (m.type === "run-progress" && typeof m.id === "number") {
      if (typeof m.line === "string") steps.get(m.id)?.onLine(m.line);
    } else if (m.type === "run-end" && typeof m.id === "number") {
      const step = steps.get(m.id);
      steps.delete(m.id);
      step?.done({
        state: typeof m.state === "string" ? m.state : "failed",
        lines: Array.isArray(m.lines)
          ? m.lines.filter((l): l is string => typeof l === "string")
          : [],
        ...(typeof m.runId === "string" ? { runId: m.runId } : {}),
      });
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
    runStep(args, onLine) {
      const id = ++next;
      return new Promise((resolve) => {
        steps.set(id, { onLine, done: resolve });
        post({ type: "run-step", id, args });
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

interface ClickLike {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  composedPath(): unknown[];
}

/**
 * VS Code's panel cancels every click on a `#…` link (it only scrolls to an element with that id),
 * so the app's own links (#/architecture) did nothing there. Inside a panel the app follows a
 * plain click on a link to one of its screens itself, after VS Code's handler has run.
 */
export function linkFollower(go: (hash: string) => void): (e: ClickLike) => void {
  return (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    for (const n of e.composedPath()) {
      const el = n as { tagName?: string; getAttribute?: (a: string) => string | null };
      if (el.tagName?.toLowerCase() !== "a") continue;
      const href = el.getAttribute?.("href");
      if (href && SCREEN_HASH.test(href)) go(href);
      return;
    }
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
  // After VS Code's own click handler on the window, which cancels #… links.
  window.addEventListener(
    "click",
    linkFollower((hash) => {
      if (location.hash !== hash) location.hash = hash;
    }),
  );
  return shared;
}
