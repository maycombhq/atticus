import { useCallback, useEffect, useRef, useState } from "react";
import { COPY } from "../copy.js";
import { hostBridge } from "./bridge.js";

/**
 * The app's side of the local API (ADR 0015). The server puts the session token in the page's
 * <meta name="atticus-token">; every call sends it back. Errors are RFC 9457 problems. In a VS Code
 * panel (ADR 0097) the calls go to the extension instead, which holds the token.
 */

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path: string; message: string }[];
  needs?: { role: string; names: string[] };
  /** Nothing to show until a step is done (a scan, say); the detail says which. Not a failure. */
  notYet?: boolean;
}

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
  }
}

export function token(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="atticus-token"]')?.content ?? "";
}

/** The problem when the local server can't be reached at all. */
export function unreachable(inPanel = false): Problem {
  return {
    type: "about:blank",
    title: "Server not answering",
    status: 0,
    detail: inPanel ? COPY.app.offlinePanel : COPY.app.offline,
  };
}

/** Whether the server answers, as the last call found; the app shows one note while it doesn't. */
export const SERVER_EVENT = "atticus:server";
let down = false;
export function serverAnswered(up: boolean): void {
  if (up === !down) return;
  down = !up;
  if (typeof dispatchEvent === "function")
    dispatchEvent(new CustomEvent(SERVER_EVENT, { detail: { up } }));
}

/** An error that only says the server is down: the page-wide note says how to fix it. */
export const isOffline = (error: string) =>
  error === COPY.app.offline || error === COPY.app.offlinePanel;

/** A reply's JSON; a page that isn't JSON (a proxy's error page, say) is a problem in words. */
export function parseBody(text: string, status: number): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError({
      type: "about:blank",
      title: "Not an Atticus answer",
      status,
      detail: COPY.app.notJson(status),
    });
  }
}

/**
 * Seventh UX walk: the problem of an answer that wasn't a success. Atticus's own problems carry
 * a detail or a title and are kept; anything else (a proxy, a body with only `error`, no body)
 * says what the server answered: its status and its words, never a blank.
 */
export function problemOf(body: unknown, status: number, statusText: string): Problem {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  if (str(b.detail) || str(b.title))
    return { ...(b as unknown as Problem), type: str(b.type) ?? "about:blank", status };
  const words = str(b.error) ?? str(b.message) ?? str(statusText) ?? "";
  return {
    type: "about:blank",
    title: str(statusText) ?? "Request failed",
    status,
    detail: COPY.app.serverAnswered(status, words),
  };
}

/** The title the VS Code extension gives a call the local API didn't answer. */
const PANEL_DOWN = "The Atticus app isn't answering";

/** beta.21: the event the loading bar listens to: how many requests are in flight now. */
export const BUSY_EVENT = "atticus:busy";
let inFlight = 0;
/** How many requests are in flight now (the loading bar's first look). */
export const requestsInFlight = (): number => inFlight;
const busy = (by: 1 | -1) => {
  inFlight = Math.max(0, inFlight + by);
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(BUSY_EVENT, { detail: inFlight }));
};

/**
 * Heard after every write the app makes through the local API (any method but GET), so a page
 * that shows what waits to be applied or proposed reads it again without a reload.
 */
export const wrote = new EventTarget();
const WROTE = "atticus:wrote";
export const onWrote = (f: () => void): (() => void) => {
  wrote.addEventListener(WROTE, f);
  return () => wrote.removeEventListener(WROTE, f);
};

/** A call to the local API; every one counts toward the loading bar while it is in flight. */
export async function api<T>(
  path: string,
  o: { method?: string; body?: unknown; signal?: AbortSignal; quiet?: boolean } = {},
): Promise<T> {
  const r = await counted<T>(path, o);
  if (o.method && o.method !== "GET") wrote.dispatchEvent(new Event(WROTE));
  return r;
}

async function counted<T>(
  path: string,
  o: { method?: string; body?: unknown; signal?: AbortSignal; quiet?: boolean },
): Promise<T> {
  // ADR 0173: a check the page makes on its own every few seconds (a run's progress) doesn't
  // flash the loading bar; everything a person waits on does.
  if (o.quiet) return call<T>(path, o);
  busy(1);
  try {
    return await call<T>(path, o);
  } finally {
    busy(-1);
  }
}

async function call<T>(
  path: string,
  o: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const bridge = hostBridge();
  if (bridge) {
    const r = await bridge.call(path, {
      method: o.method ?? "GET",
      ...(o.body !== undefined ? { body: o.body } : {}),
    });
    if (o.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    // The extension answers 503 when the local API it started doesn't (ADR 0097).
    if (r.status === 503 && (r.body as Problem | undefined)?.title === PANEL_DOWN) {
      serverAnswered(false);
      throw new ApiError(unreachable(true));
    }
    serverAnswered(true);
    if (r.status < 200 || r.status >= 300)
      // The answer's own status, whatever the body says (a body may leave it out).
      throw new ApiError(problemOf(r.body, r.status, ""));
    return r.body as T;
  }
  let r: Response;
  let text: string;
  try {
    r = await fetch(path, {
      method: o.method ?? "GET",
      headers: {
        "X-Atticus-Token": token(),
        ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    });
    text = await r.text();
  } catch (e) {
    // The server stopped or the network refused: say so in words, not "Failed to fetch".
    if (o.signal?.aborted) throw e;
    serverAnswered(false);
    throw new ApiError(unreachable());
  }
  serverAnswered(true);
  const body = parseBody(text, r.status);
  if (!r.ok) throw new ApiError(problemOf(body, r.status, r.statusText));
  return body as T;
}

export type Loaded<T> =
  | { state: "loading" }
  /** `status`: the HTTP status when the server answered (404: the thing isn't there). */
  | { state: "error"; error: string; notYet?: boolean; status?: number }
  | { state: "ready"; data: T };

/**
 * Load a GET call; reload() runs it again (after a live event, say). A reload keeps what is
 * shown until the answer comes; `refreshing` says one is under way, and `at` when the last
 * answer came, so a "Check again" button can say what it did.
 */
export function useApi<T>(
  path: string | undefined,
  /**
   * `view`: what the answer is of, when the path changes only to ask again (a fresh check,
   * `?fresh=1&n=2`): the last answer stays shown while the new one comes, as a reload's does.
   */
  o: { view?: string } = {},
): Loaded<T> & { reload: () => void; refreshing: boolean; at?: number } {
  const view = path === undefined ? undefined : (o.view ?? path);
  // What was loaded, and for which path: a new path shows loading, never the last path's answer
  // as if it were this one's (box X's candidates under box Y, change A's detail under B).
  const [held, hold] = useState<{ s: Loaded<T>; for?: string }>({ s: { state: "loading" } });
  const set = (v: Loaded<T>, forPath: string) => hold({ s: v, for: forPath });
  const [tick, setTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [at, setAt] = useState<number | undefined>();
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const answered = useRef(false);
  useEffect(() => {
    if (!path) return;
    const ctl = new AbortController();
    if (answered.current) setRefreshing(true);
    api<T>(path, { signal: ctl.signal })
      .then(
        (data) => {
          if (!ctl.signal.aborted) set({ state: "ready", data }, view!);
        },
        (e: unknown) => {
          if (ctl.signal.aborted) return;
          set(
            {
              state: "error",
              error: e instanceof Error ? e.message : String(e),
              ...(e instanceof ApiError && e.problem.notYet ? { notYet: true } : {}),
              ...(e instanceof ApiError && e.problem.status ? { status: e.problem.status } : {}),
            },
            view!,
          );
        },
      )
      .finally(() => {
        if (ctl.signal.aborted) return;
        answered.current = true;
        setRefreshing(false);
        setAt(Date.now());
      });
    return () => ctl.abort();
  }, [path, tick]);
  // A reload of the same path keeps what is shown; another path (or none) is loading.
  const s: Loaded<T> = held.for === view && view !== undefined ? held.s : { state: "loading" };
  return { ...s, reload, refreshing, ...(at !== undefined ? { at } : {}) };
}

export type LiveEvent = { type: string } & Record<string, unknown>;

/** A file or a model run changed: what an assistant, the CLI or another screen wrote. */
export const isFileChange = (e: LiveEvent): boolean =>
  e.type === "file.changed" || e.type === "run.changed" || e.type === "index.rebuilt";

/**
 * Read these views again when files change (ADR 0119), so a screen follows what an assistant
 * or the CLI writes without a reload. Views not loaded yet are left alone.
 */
export function useReloadOnFiles(...views: ({ reload(): void } | undefined)[]): void {
  const current = useRef(views);
  current.current = views;
  useFileChanges(() => {
    for (const v of current.current) v?.reload();
  });
}

/** How long a burst of file events is let settle before a screen reads again. */
export const FILE_QUIET_MS = 250;

/**
 * beta.23 ("Home loads fast"): the file events of a burst, heard once. A scan, a verify or an
 * assistant writes many files; the server sends each as an event (up to fifty at once), and a
 * screen that read everything again for each sent the server hundreds of requests. `on` gets the
 * burst's events after a quiet moment (and at least every two seconds while they keep coming).
 */
export function useFileChanges(on: (events: LiveEvent[]) => void, quietMs = FILE_QUIET_MS): void {
  const handler = useRef(on);
  handler.current = on;
  const burst = useRef<{
    events: LiveEvent[];
    timer?: ReturnType<typeof setTimeout>;
    first: number;
  }>({ events: [], first: 0 });
  useEffect(
    () => () => {
      clearTimeout(burst.current.timer);
    },
    [],
  );
  useLiveEvents((e) => {
    if (!isFileChange(e)) return;
    const b = burst.current;
    const now = Date.now();
    if (!b.events.length) b.first = now;
    b.events.push(e);
    clearTimeout(b.timer);
    const flush = () => {
      const events = b.events;
      b.events = [];
      b.timer = undefined;
      if (events.length) handler.current(events);
    };
    b.timer = setTimeout(flush, now - b.first > 2000 ? 0 : quietMs);
  });
}

/**
 * Whether a burst can change what the catalog says (its records, so the counts, the graph and
 * the map): a file under a catalog folder or the org pack, a top folder (the watcher names top
 * folders when many files change), the index rebuilt, or an event that names no path.
 */
export const catalogMayHaveChanged = (events: LiveEvent[]): boolean =>
  events.some((e) => {
    if (e.type === "index.rebuilt") return true;
    if (e.type !== "file.changed") return false;
    const p = typeof e.path === "string" ? e.path.replace(/^\.\//, "") : "";
    return !p || !p.includes("/") || /(^|\/)(catalog|org-pack)(\/|$)/.test(p);
  });

/** Live events on /api/events; reconnects with a backoff while the page is open. */
export function useLiveEvents(onEvent: (e: LiveEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    // In a VS Code panel the extension sends the events (ADR 0097).
    const bridge = hostBridge();
    if (bridge) return bridge.onEvent((e) => handler.current(e));
    let ws: WebSocket | undefined;
    let stop = false;
    let wait = 500;
    const open = () => {
      if (stop) return;
      const url = new URL("/api/events", location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("token", token());
      ws = new WebSocket(url);
      ws.onmessage = (m) => {
        try {
          handler.current(JSON.parse(String(m.data)) as LiveEvent);
        } catch {
          // not an event; ignore
        }
      };
      ws.onopen = () => {
        wait = 500;
      };
      ws.onclose = () => {
        if (stop) return;
        setTimeout(open, wait);
        wait = Math.min(wait * 2, 10_000);
      };
    };
    open();
    return () => {
      stop = true;
      ws?.close();
    };
  }, []);
}
