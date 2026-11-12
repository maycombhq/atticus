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
  /** API 3.9.0 (ADR 0188): what the app offers next, Sync the repos with no base clone here. */
  next?: { step: "sync"; repos: string[] };
  /** API 3.11.0: a batch write's files written all the same (a 500 names them; most none). */
  written?: { repo: string; file: string }[];
  /** API 3.12.0: which refusal of its status it is (a send's 409: being-sent, already-sent). */
  code?: string;
}

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
  }
}

/**
 * The session token: the one read again after the server restarted (renewToken), else the one
 * the page came with in <meta name="atticus-token">.
 */
let renewed: { token: string; pageKey?: string } | undefined;
export function token(): string {
  if (renewed) return renewed.token;
  if (typeof document === "undefined") return "";
  return document.querySelector<HTMLMetaElement>('meta[name="atticus-token"]')?.content ?? "";
}
/** The page key read with a renewed token (confirm.ts's pageKey), if one was. */
export const renewedPageKey = (): string | undefined => renewed?.pageKey;
/** Tests: the token the page holds now. */
export function setSessionToken(t: string): void {
  renewed = { token: t };
}

/** The words the server refuses a call with when its session token isn't this start's. */
export const TOKEN_REFUSED = "Missing or wrong session token";

const unescapeAttr = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** The session token and page key the app's page carries (its meta tags only), if any. */
export function tokenOfPage(html: string): { token?: string; pageKey?: string } {
  const meta = (name: string) => {
    const m = new RegExp(`<meta name="${name}" content="([^"]*)"\\s*/?>`).exec(html);
    const v = m ? unescapeAttr(m[1]!) : "";
    return v || undefined;
  };
  const token = meta("atticus-token");
  const pageKey = meta("atticus-page-key");
  return { ...(token ? { token } : {}), ...(token && pageKey ? { pageKey } : {}) };
}

/**
 * Beta.27 review (blocker): whether the page holds a session token the server refused and no
 * new one could be read; the app then says once that it restarted, with Reload. Heard with
 * onSession: "renewed" when a new token was read, "stale" when none could be.
 */
let stale = false;
export const sessionStale = (): boolean => stale;
/**
 * Beta.27 re-review: the metarepo the page has shown (the `root` of its first /api/health
 * answer), and whether the server that answers now serves another one (`moved`: `atticus ui`
 * started again in another folder at the same address). A page that moved takes no new token:
 * it says so once, with Reload, and sends nothing more.
 */
let pageRoot: string | undefined;
let moved = false;
export const sessionMoved = (): boolean => moved;
/** Whether the server read again after a restart is the one the page started with. */
let sameServer: "same" | "other" | "unknown" = "unknown";
/** Tests: forget the metarepo the page has shown. */
export function forgetPageRoot(): void {
  pageRoot = undefined;
  moved = false;
  sameServer = "unknown";
}
/**
 * The metarepo a /api/health answer names, as one key: its `rootKey` (the server's real path of
 * it, compared exactly), else its `root` (an older server).
 */
const healthRootOf = (body: unknown): string | undefined => {
  const b = body && typeof body === "object" ? (body as { root?: unknown; rootKey?: unknown }) : {};
  const k = b.rootKey;
  if (typeof k === "string" && k) return k;
  const r = b.root;
  return typeof r === "string" && r ? r : undefined;
};
const sessionEvents = new EventTarget();
export function onSession(f: (state: "renewed" | "stale") => void): () => void {
  const on = (e: Event) => f((e as CustomEvent<"renewed" | "stale">).detail);
  sessionEvents.addEventListener("session", on);
  return () => sessionEvents.removeEventListener("session", on);
}
const tellSession = (state: "renewed" | "stale") => {
  stale = state === "stale";
  sessionEvents.dispatchEvent(new CustomEvent("session", { detail: state }));
};

let renewing: Promise<boolean> | undefined;
/**
 * After `atticus ui` restarted, the server has a new session token and refuses the page's (401).
 * The page reads it again the way it first got it: from the app's own page, which only a page
 * of this server can read (other sites can't read a cross-origin answer, and the Host check
 * stops DNS rebinding). Never from a URL, never logged. One read at a time, however many calls
 * were refused; true when a new token was read.
 */
export function renewToken(): Promise<boolean> {
  renewing ??= (async () => {
    const before = token();
    try {
      const r = await fetch("/", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "text/html" },
      });
      if (!r.ok) return false;
      const got = tokenOfPage(await r.text());
      if (!got.token || got.token === before) return false;
      // Beta.27 re-review: the server that answers now, asked with the new token which metarepo
      // it serves: another one (the app started again elsewhere) gets nothing of this page's.
      sameServer = await serverIdentity(got.token);
      if (sameServer === "other") {
        moved = true;
        tellSession("stale");
        return false;
      }
      renewed = { token: got.token, ...(got.pageKey ? { pageKey: got.pageKey } : {}) };
      setMeta("atticus-token", got.token);
      if (got.pageKey) setMeta("atticus-page-key", got.pageKey);
      tellSession("renewed");
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    renewing = undefined;
  });
  return renewing;
}

/** Whether the server answering with `t` serves the metarepo the page has shown. */
async function serverIdentity(t: string): Promise<"same" | "other" | "unknown"> {
  if (pageRoot === undefined) return "unknown";
  try {
    const r = await fetch("/api/health", {
      method: "GET",
      cache: "no-store",
      headers: { "X-Atticus-Token": t },
    });
    if (!r.ok) return "unknown";
    const root = healthRootOf(parseBody(await r.text(), r.status));
    if (root === undefined) return "unknown";
    return root === pageRoot ? "same" : "other";
  } catch {
    return "unknown";
  }
}

function setMeta(name: string, content: string): void {
  if (typeof document === "undefined") return;
  const m = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (m) m.content = content;
}

/**
 * A call sent with `sentWith` was refused for its token: true when it can be sent again, as the
 * token was read again meanwhile or is now; false (and the app says it restarted) otherwise.
 * Beta.27 re-review: a read (`write` false) goes again on a new token; a write only when the
 * server read again is confirmed to serve the metarepo the page started with ("not-sent"
 * otherwise: nothing is sent, the person does it again); a server serving another metarepo gets
 * nothing at all (the page says so, with Reload).
 */
export async function retryAfterRefusal(
  sentWith: string,
  write = false,
): Promise<boolean | "not-sent"> {
  if (moved) return false;
  const renewedNow = token() !== sentWith || (await renewToken());
  if (!renewedNow) {
    if (!stale) tellSession("stale");
    return false;
  }
  if (!write) return true;
  return sameServer === "same" ? true : "not-sent";
}

const refusedForToken = (status: number, body: unknown) =>
  status === 401 &&
  !!body &&
  typeof body === "object" &&
  (body as { title?: unknown }).title === TOKEN_REFUSED;

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

/**
 * Beta.27 review: `f` runs when the server answers again after it didn't (what the page shows
 * outside a screen, the Explorer's sections, reads again then; a screen is drawn anew).
 */
export function useServerBack(f: () => void): void {
  const handler = useRef(f);
  handler.current = f;
  useEffect(() => {
    if (typeof addEventListener !== "function") return;
    const on = (e: Event) => {
      if ((e as CustomEvent<{ up: boolean }>).detail.up) handler.current();
    };
    addEventListener(SERVER_EVENT, on);
    return () => removeEventListener(SERVER_EVENT, on);
  }, []);
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

/**
 * Beta.27 re-review: what the page knows changed, counted: a write it made (as it starts and as
 * it ends) and each file or job event it heard. A read sent before the count moved may answer
 * from before that change.
 */
let changes = 0;
export const noteChange = (): void => {
  changes++;
};

/**
 * Beta.27 review: reads shared by everyone who asks, never stale. Asks in one moment (a page's
 * parts mounting together: Brief read its change three times) share one read, and so do asks
 * while a read is under way when nothing changed since it was sent (noteChange). Beta.27
 * re-review: an ask after a change (a write, a file event), or one that says it must be `after`
 * one (a page reading again what it just wrote), never takes the read under way, whose answer
 * may be from before: it waits for the one read queued after it, however many ask meanwhile. A
 * caller's signal stops its wait; the read is stopped once every caller has stopped waiting.
 */
export function readCoalescer() {
  type Pending = {
    promise: Promise<unknown>;
    ctl: AbortController;
    waiters: number;
    sent: boolean;
    dead: boolean;
    /** The count of changes when it was sent. */
    seq: number;
  };
  const reads = new Map<string, { current?: Pending; next?: Pending }>();
  const make = (
    key: string,
    slot: { current?: Pending; next?: Pending },
    run: (signal: AbortSignal) => Promise<unknown>,
    after?: Promise<unknown>,
  ): Pending => {
    const ctl = new AbortController();
    const p = { ctl, waiters: 0, sent: false, dead: false, seq: changes } as Pending;
    p.promise = (async () => {
      // Sent at once (the other asks of this moment join it, as nothing changed since it was
      // sent); one queued after a read under way waits for that read to end.
      if (after) await after.catch(() => undefined);
      p.sent = true;
      p.seq = changes;
      return run(ctl.signal);
    })();
    const settled = () => {
      if (slot.current === p) {
        slot.current = slot.next;
        slot.next = undefined;
      } else if (slot.next === p) slot.next = undefined;
      if (!slot.current && !slot.next && reads.get(key) === slot) reads.delete(key);
    };
    p.promise.then(settled, settled);
    return p;
  };
  return function read<T>(
    key: string,
    run: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    o: { after?: boolean } = {},
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    let slot = reads.get(key);
    if (!slot) reads.set(key, (slot = {}));
    const live = (p?: Pending) => (p && !p.dead ? p : undefined);
    // A read every caller stopped waiting for is no one's: the one queued after it moves up.
    if (slot.current?.dead) {
      slot.current = live(slot.next);
      slot.next = undefined;
    }
    if (slot.next?.dead) slot.next = undefined;
    let p: Pending;
    const cur = slot.current;
    if (cur && (!cur.sent || (!o.after && cur.seq === changes))) p = cur;
    else if (cur) p = live(slot.next) ?? (slot.next = make(key, slot, run, cur.promise));
    else p = slot.current = make(key, slot, run);
    p.waiters++;
    const mine = p;
    if (!signal) return mine.promise as Promise<T>;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const stop = () => {
        if (done) return;
        done = true;
        reject(new DOMException("Aborted", "AbortError"));
        if (--mine.waiters === 0) {
          mine.dead = true;
          mine.ctl.abort();
        }
      };
      signal.addEventListener("abort", stop, { once: true });
      mine.promise.then(
        (v) => {
          if (done) return;
          done = true;
          signal.removeEventListener("abort", stop);
          resolve(v as T);
        },
        (e: unknown) => {
          if (done) return;
          done = true;
          signal.removeEventListener("abort", stop);
          reject(e);
        },
      );
    });
  };
}

/** The app's GETs, each shared as readCoalescer says. */
const shared = readCoalescer();

/** A call to the local API; every one counts toward the loading bar while it is in flight. */
export async function api<T>(
  path: string,
  o: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    quiet?: boolean;
    /** A GET whose answer must be of a read sent after this ask (readCoalescer's `after`). */
    after?: boolean;
  } = {},
): Promise<T> {
  const write = !!o.method && o.method !== "GET";
  if (!write && o.body === undefined) {
    // Beta.27 re-review: quiet or not is each caller's own: the shared read is counted for none,
    // and each caller who isn't quiet counts toward the loading bar while it waits (a quiet
    // poll's read joined by a person's ask showed no bar; the other way round, a poll's did).
    const read = shared<T>(
      path,
      (signal) => counted<T>(path, { signal, quiet: true }),
      o.signal,
      o.after ? { after: true } : {},
    );
    if (o.quiet) return read;
    busy(1);
    return read.finally(() => busy(-1));
  }
  noteChange();
  try {
    const r = await counted<T>(path, o);
    noteChange();
    if (write) wrote.dispatchEvent(new Event(WROTE));
    return r;
  } catch (e) {
    noteChange();
    // Review of beta.24: a write that failed but wrote some files all the same is heard too.
    if (write && writtenOf(e).length) wrote.dispatchEvent(new Event(WROTE));
    throw e;
  }
}

/**
 * API 3.11.0: the files a failed write wrote all the same (its problem's `written`, each repo's
 * file), so a page reads those again; none for any other error.
 */
export function writtenOf(e: unknown): { repo: string; file: string }[] {
  const w = e instanceof ApiError ? e.problem.written : undefined;
  return Array.isArray(w)
    ? w.filter(
        (x): x is { repo: string; file: string } =>
          !!x && typeof x.repo === "string" && typeof x.file === "string",
      )
    : [];
}

/**
 * Review of beta.23 (API 3.9.0): a write whose work outlasts one request (a task run's Done
 * builds and commits; a live work-tracker sync), asked of the server as a job (`job: true`). The
 * server answers at once with the job's id; this follows the job, so an editor panel, which
 * hears no live events, still learns when it ended, and the Console shows the work meanwhile.
 * Resolves with the answer the call gives without `job`; a refusal throws its problem as before.
 * A server that answers the call itself (an older one) is answered as it is.
 */
export async function callAsJob<T>(
  path: string,
  body: Record<string, unknown> = {},
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  const r = await api<unknown>(path, { method: "POST", body: { ...body, job: true } });
  const jobId = r && typeof r === "object" ? (r as { jobId?: unknown }).jobId : undefined;
  if (typeof jobId !== "string") return r as T;
  for (;;) {
    const j = await api<{
      state: string;
      errors?: string[];
      result?: { answer?: unknown; problem?: Problem; lines?: string[] };
    }>(`/api/jobs/${encodeURIComponent(jobId)}`, { quiet: true });
    if (j.state !== "running" && j.state !== "queued") {
      if (j.state === "done" && j.result && "answer" in j.result) {
        wrote.dispatchEvent(new Event(WROTE));
        return j.result.answer as T;
      }
      const p = j.result?.problem;
      if (p) throw new ApiError(problemOf(p, typeof p.status === "number" ? p.status : 422, ""));
      const words = (j.result?.lines?.length ? j.result.lines : (j.errors ?? [])).join(" ");
      throw new ApiError({
        type: "about:blank",
        title: COPY.app.jobEnded(j.state, ""),
        status: 500,
        detail: COPY.app.jobEnded(j.state, words),
      });
    }
    await wait(700);
  }
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
  again = false,
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
  const sentWith = token();
  try {
    r = await fetch(path, {
      method: o.method ?? "GET",
      headers: {
        "X-Atticus-Token": sentWith,
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
  // Beta.27 re-review: the metarepo the page shows, as the server first said it.
  if (r.ok && pageRoot === undefined && path === "/api/health" && !moved)
    pageRoot = healthRootOf(body);
  // Beta.27 review: the server restarted with a new token. Nothing was done (the token is checked
  // before anything else), so the call goes again, once, with the token read again: a read at
  // once, a write only to the same metarepo's server (beta.27 re-review).
  if (refusedForToken(r.status, body) && !again && !o.signal?.aborted) {
    const write = !!o.method && o.method !== "GET" && o.method !== "HEAD";
    const go = await retryAfterRefusal(sentWith, write);
    if (go === true) return call<T>(path, o, true);
    if (go === "not-sent")
      throw new ApiError({
        type: "about:blank",
        title: COPY.app.notResentTitle,
        status: 409,
        detail: COPY.app.notResent,
      });
  } else if (r.ok && stale && !moved && token() === sentWith) tellSession("renewed");
  if (!r.ok) throw new ApiError(problemOf(body, r.status, r.statusText));
  return body as T;
}

/**
 * ADR 0194: the last answer to a few GET calls a page made, kept for the IDE layout's badges and
 * status bar (open questions, repos), so the shell shows counts the app already loaded and never
 * asks the server for them (Home's requests stay the same). Only the paths something watches are
 * kept, one answer each.
 */
const watched = new Map<string, Set<(v: unknown) => void>>();
const answers = new Map<string, unknown>();

function remember(path: string, data: unknown): void {
  const fns = watched.get(path);
  if (!fns) return;
  answers.set(path, data);
  for (const f of fns) f(data);
}

/** The last answer the app had to a GET call, as pages load it; never a request of its own. */
export function useLastAnswer<T>(path: string): T | undefined {
  const [v, set] = useState<T | undefined>(() => answers.get(path) as T | undefined);
  useEffect(() => {
    const f = (d: unknown) => set(d as T);
    const fns = watched.get(path) ?? new Set();
    fns.add(f);
    watched.set(path, fns);
    if (answers.has(path)) set(answers.get(path) as T);
    return () => {
      fns.delete(f);
    };
  }, [path]);
  return v;
}

/** What a call answered, as useApi records it: the Explorer's reads tell it too (and tests). */
export const rememberAnswer = remember;

/**
 * Beta.27 review: the GET paths something on the page reads and reads again on file events
 * itself (a mounted useApi, an Explorer section), by how many read each. A count the shell
 * shows from the last answer (useKnownAnswer) reads it again only when nothing else does.
 */
const reading = new Map<string, number>();
export function readingPath(path: string): () => void {
  reading.set(path, (reading.get(path) ?? 0) + 1);
  return () => {
    const n = (reading.get(path) ?? 1) - 1;
    if (n > 0) reading.set(path, n);
    else reading.delete(path);
  };
}
/** Whether a mounted read follows `path` (see readingPath). */
export const isPathRead = (path: string): boolean => (reading.get(path) ?? 0) > 0;

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
  o: {
    view?: string;
    /**
     * Beta.27 review: how the path is read, when not alone (a batched read, api/batch.ts: one
     * call for every story the page shows). A function that stays the same between renders.
     */
    load?: (path: string, signal: AbortSignal) => Promise<T>;
  } = {},
): Loaded<T> & { reload: () => void; refreshing: boolean; at?: number } {
  const load = o.load;
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
  useEffect(() => (path ? readingPath(path) : undefined), [path]);
  useEffect(() => {
    if (!path) return;
    const ctl = new AbortController();
    if (answered.current) setRefreshing(true);
    (load ? load(path, ctl.signal) : api<T>(path, { signal: ctl.signal }))
      .then(
        (data) => {
          if (ctl.signal.aborted) return;
          set({ state: "ready", data }, view!);
          remember(path, data);
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
  }, [path, tick, load]);
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
export function useFileChanges(
  on: (events: LiveEvent[]) => void,
  quietMs = FILE_QUIET_MS,
  o: {
    /**
     * Beta.23 review: a job's end (`job.done`) is heard too. A job may write where no page
     * follows files (a Sync clones into workspace/, which isn't watched), and the page that
     * shows its result must read it again.
     */
    jobs?: boolean;
  } = {},
): void {
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
  const jobs = !!o.jobs;
  useLiveEvents((e) => {
    if (!isFileChange(e) && !(jobs && e.type === "job.done")) return;
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
 * folders when many files change), the index rebuilt, or an event that names no path. The
 * server says which (`catalog` on each file.changed, local API 3.9.0), by the folders the org
 * pack's layout names; the folder names are only the guess for a server that doesn't.
 */
export const catalogMayHaveChanged = (events: LiveEvent[]): boolean =>
  events.some((e) => {
    if (e.type === "index.rebuilt") return true;
    if (e.type !== "file.changed") return false;
    if (typeof e.catalog === "boolean") return e.catalog;
    const p = typeof e.path === "string" ? e.path.replace(/^\.\//, "") : "";
    return !p || !p.includes("/") || /(^|\/)(catalog|org-pack)(\/|$)/.test(p);
  });

/**
 * Beta.27 review: whether a burst can change what a read of the files under `folder` answers: a
 * file the pattern matches, a top folder (the watcher names top folders when many files change,
 * and a metarepo's own top files such as its manifest), or an event that names no path.
 */
export const filesMayHaveChanged = (events: LiveEvent[], folder: RegExp): boolean =>
  events.some((e) => {
    if (e.type !== "file.changed") return false;
    const p = typeof e.path === "string" ? e.path.replace(/^\.\//, "") : "";
    return !p || !p.includes("/") || folder.test(p);
  });

/** A job as GET /api/jobs/{jobId} gives it. */
export interface JobView {
  id: string;
  state: string;
  progress: { done: number; total: number; message: string };
  errors: string[];
  result?: Record<string, unknown>;
}

/** How often a job a page started is asked after (review of beta.23). */
export const JOB_POLL_MS = 1500;

/**
 * Review of beta.23: a job a page started, followed by asking, not only by its job.progress and
 * job.done events: an editor panel hears none of them, so a page that waited on job.done stayed
 * "working" for good. `onJob` hears the job each time; the asking stops once it has ended, on
 * stop(), or after an ask that failed (`onError` hears why).
 */
export function pollJob(
  jobId: string,
  onJob: (j: JobView) => void,
  o: {
    wait?: (ms: number) => Promise<void>;
    everyMs?: number;
    onError?: (e: unknown) => void;
  } = {},
): { stop(): void; finished: Promise<void> } {
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let stopped = false;
  const finished = (async () => {
    while (!stopped) {
      let j: JobView;
      try {
        j = await api<JobView>(`/api/jobs/${encodeURIComponent(jobId)}`, { quiet: true });
      } catch (e) {
        if (!stopped) o.onError?.(e);
        return;
      }
      if (stopped) return;
      onJob(j);
      if (j.state !== "running" && j.state !== "queued") return;
      await wait(o.everyMs ?? JOB_POLL_MS);
    }
  })();
  return {
    stop: () => {
      stopped = true;
    },
    finished,
  };
}

/** pollJob while the page shows a job: `jobId` undefined stops it. */
export function useJobPoll(
  jobId: string | undefined,
  onJob: (j: JobView) => void,
  onError?: (e: unknown) => void,
): void {
  const handler = useRef({ onJob, onError });
  handler.current = { onJob, onError };
  useEffect(() => {
    if (!jobId) return;
    const p = pollJob(jobId, (j) => handler.current.onJob(j), {
      onError: (e) => handler.current.onError?.(e),
    });
    return () => p.stop();
  }, [jobId]);
}

/** How long the page's socket stays open after its last listener went (a page drawn anew). */
export const LIVE_LINGER_MS = 2000;
/** The first wait before the socket is opened again, doubled to LIVE_WAIT_MAX_MS. */
export const LIVE_WAIT_MS = 500;
export const LIVE_WAIT_MAX_MS = 10_000;

/**
 * Beta.27 review: the page's one socket to /api/events. Each part of the page that follows live
 * events (forty-odd of them) used to open its own: 11 to 15 sockets a page. Now the first
 * listener opens it, every event goes to every listener, and it closes a moment after the last
 * one goes. A socket that closes is opened again with a backoff; one refused before it opened
 * (the server restarted with a new token) reads the token again first.
 */
const live = {
  listeners: new Set<(e: LiveEvent) => void>(),
  ws: undefined as WebSocket | undefined,
  wait: LIVE_WAIT_MS,
  retry: undefined as ReturnType<typeof setTimeout> | undefined,
  linger: undefined as ReturnType<typeof setTimeout> | undefined,
};

/** A file or a job that changed: a read sent before it may be stale (noteChange). */
function heardChange(e: LiveEvent): void {
  if (isFileChange(e) || e.type === "job.done") noteChange();
}

function openLive(): void {
  if (live.ws || !live.listeners.size) return;
  const url = new URL("/api/events", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token());
  const ws = new WebSocket(url);
  live.ws = ws;
  let opened = false;
  ws.onmessage = (m) => {
    let e: LiveEvent;
    try {
      e = JSON.parse(String(m.data)) as LiveEvent;
    } catch {
      return; // not an event; ignore
    }
    heardChange(e);
    for (const f of [...live.listeners]) {
      try {
        f(e);
      } catch {
        // one listener's failure is its own
      }
    }
  };
  ws.onopen = () => {
    opened = true;
    live.wait = LIVE_WAIT_MS;
  };
  ws.onclose = () => {
    if (live.ws !== ws) return;
    live.ws = undefined;
    if (!live.listeners.size) return;
    const wait = live.wait;
    live.wait = Math.min(live.wait * 2, LIVE_WAIT_MAX_MS);
    live.retry = setTimeout(() => {
      live.retry = undefined;
      // Refused before it opened: perhaps a new token; read it (once) before trying again.
      if (opened) openLive();
      else void renewToken().finally(openLive);
    }, wait);
  };
}

function closeLive(): void {
  clearTimeout(live.retry);
  live.retry = undefined;
  const ws = live.ws;
  live.ws = undefined;
  live.wait = LIVE_WAIT_MS;
  ws?.close();
}

/** Follow the page's live events; the returned function stops. */
export function subscribeLive(f: (e: LiveEvent) => void): () => void {
  live.listeners.add(f);
  clearTimeout(live.linger);
  live.linger = undefined;
  openLive();
  return () => {
    if (!live.listeners.delete(f) || live.listeners.size) return;
    clearTimeout(live.linger);
    live.linger = setTimeout(() => {
      live.linger = undefined;
      if (!live.listeners.size) closeLive();
    }, LIVE_LINGER_MS);
  };
}

/** Live events on /api/events, through the page's one socket (subscribeLive). */
export function useLiveEvents(onEvent: (e: LiveEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    // In a VS Code panel the extension sends the events (ADR 0097).
    const bridge = hostBridge();
    if (bridge)
      return bridge.onEvent((e) => {
        heardChange(e);
        handler.current(e);
      });
    return subscribeLive((e) => handler.current(e));
  }, []);
}
