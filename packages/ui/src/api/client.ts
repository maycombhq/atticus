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

/** The title the VS Code extension gives a call the local API didn't answer. */
const PANEL_DOWN = "The Atticus app isn't answering";

export async function api<T>(
  path: string,
  o: { method?: string; body?: unknown; signal?: AbortSignal } = {},
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
    if (r.status < 200 || r.status >= 300) {
      const p = (r.body as Problem | undefined) ?? {
        type: "about:blank",
        title: "Request failed",
        status: r.status,
      };
      throw new ApiError(p);
    }
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
  if (!r.ok) {
    const p = (body as Problem | undefined) ?? {
      type: "about:blank",
      title: r.statusText || "Request failed",
      status: r.status,
    };
    throw new ApiError(p);
  }
  return body as T;
}

export type Loaded<T> =
  | { state: "loading" }
  | { state: "error"; error: string; notYet?: boolean }
  | { state: "ready"; data: T };

/**
 * Load a GET call; reload() runs it again (after a live event, say). A reload keeps what is
 * shown until the answer comes; `refreshing` says one is under way, and `at` when the last
 * answer came, so a "Check again" button can say what it did.
 */
export function useApi<T>(
  path: string | undefined,
): Loaded<T> & { reload: () => void; refreshing: boolean; at?: number } {
  const [s, set] = useState<Loaded<T>>({ state: "loading" });
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
        (data) => set({ state: "ready", data }),
        (e: unknown) => {
          if (ctl.signal.aborted) return;
          set({
            state: "error",
            error: e instanceof Error ? e.message : String(e),
            ...(e instanceof ApiError && e.problem.notYet ? { notYet: true } : {}),
          });
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
  return { ...s, reload, refreshing, ...(at !== undefined ? { at } : {}) };
}

export type LiveEvent = { type: string } & Record<string, unknown>;

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
