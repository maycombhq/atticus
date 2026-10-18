import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The app's side of the local API (ADR 0015). The server puts the session token in the page's
 * <meta name="atticus-token">; every call sends it back. Errors are RFC 9457 problems.
 */

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path: string; message: string }[];
  needs?: { role: string; names: string[] };
}

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
  }
}

export function token(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="atticus-token"]')?.content ?? "";
}

export async function api<T>(
  path: string,
  o: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const r = await fetch(path, {
    method: o.method ?? "GET",
    headers: {
      "X-Atticus-Token": token(),
      ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const text = await r.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;
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
  { state: "loading" } | { state: "error"; error: string } | { state: "ready"; data: T };

/** Load a GET call; reload() runs it again (after a live event, say). */
export function useApi<T>(path: string | undefined): Loaded<T> & { reload: () => void } {
  const [s, set] = useState<Loaded<T>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!path) return;
    const ctl = new AbortController();
    api<T>(path, { signal: ctl.signal }).then(
      (data) => set({ state: "ready", data }),
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        set({ state: "error", error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => ctl.abort();
  }, [path, tick]);
  return { ...s, reload };
}

export type LiveEvent = { type: string } & Record<string, unknown>;

/** Live events on /api/events; reconnects with a backoff while the page is open. */
export function useLiveEvents(onEvent: (e: LiveEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
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
