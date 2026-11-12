import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  BUSY_EVENT,
  isPathRead,
  readingPath,
  rememberAnswer,
  requestsInFlight,
  useFileChanges,
  useLastAnswer,
  type LiveEvent,
} from "../../api/client.js";

/**
 * The Explorer's reads (beta.26). Each is a GET the app already makes (Home's /api/changes and
 * /api/questions?state=open, the map's estate view), so the server answers from what it keeps.
 * The side panel is on every page, Home included, and Home's first load is measured
 * (packages/cli/test/home-speed.test.ts), so a section reads nothing until it is open, and a
 * section open when the panel first shows waits until the page's own requests are answered
 * (the loading bar's count back at nought for a moment). A section a person opens reads at once.
 * An answer is kept for the page's life: the panel shown again shows it at once and reads it
 * again behind it (a section open from the start once the page is quiet, as on its first read),
 * so a count changed elsewhere doesn't stay stale until a file event (review, beta.26); file
 * events read it again. Each answer is told to the shell's counts too (the activity bar's badge
 * and the status bar, useLastAnswer), as a page's own read of the path is.
 */

export type Lazy<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; error: string; notYet?: boolean }
  | { state: "ready"; data: T };

const kept = new Map<string, unknown>();
/**
 * Beta.27 review: one GET of a path at a time, whoever asks (an Explorer section, each count the
 * shell shows, a page's answer read again): a second ask while one is under way gets its answer.
 * Beta.27's first cut read /api/trust once for the status bar and once for the Explorer on every
 * burst of file events.
 */
const inFlight = new Map<string, Promise<unknown>>();
/** Until when a path's answer is fresh: read again just now by its page (readAnswerAgain). */
const freshUntil = new Map<string, number>();
/**
 * How long an answer read again after a page's own write stays fresh: the file events that write
 * makes come within this (FILE_QUIET_MS after the server's watcher), and read nothing again.
 */
export const FRESH_MS = 1500;

/** Forget every kept answer (tests, and a server that came back). */
export const forgetExplorerAnswers = () => {
  kept.clear();
  inFlight.clear();
  freshUntil.clear();
};

/** GET `path` once, shared with every ask while it is under way; the answer is kept and told. */
export function sharedRead<T>(path: string): Promise<T> {
  const under = inFlight.get(path);
  if (under) return under as Promise<T>;
  const p = api<T>(path).then((data) => {
    kept.set(path, data);
    rememberAnswer(path, data);
    return data;
  });
  inFlight.set(path, p);
  const done = () => {
    if (inFlight.get(path) === p) inFlight.delete(path);
  };
  p.then(done, done);
  return p;
}

/** How long the page must be quiet before a deferred read goes, and the longest it waits. */
export const QUIET_MS = 300;
export const LONGEST_MS = 5000;

/**
 * Runs `go` once no request is in flight for `QUIET_MS` (or after `LONGEST_MS` whatever happens).
 * Returns a cancel.
 */
export function whenQuiet(go: () => void, quietMs = QUIET_MS, longestMs = LONGEST_MS): () => void {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    if (done) return;
    done = true;
    stop();
    go();
  };
  const arm = (n: number) => {
    clearTimeout(timer);
    timer = n === 0 ? setTimeout(fire, quietMs) : undefined;
  };
  const on = (e: Event) => arm(Number((e as CustomEvent<number>).detail) || 0);
  const cap = setTimeout(fire, longestMs);
  const stop = () => {
    clearTimeout(timer);
    clearTimeout(cap);
    if (typeof removeEventListener === "function") removeEventListener(BUSY_EVENT, on);
  };
  if (typeof addEventListener === "function") addEventListener(BUSY_EVENT, on);
  arm(requestsInFlight());
  return () => {
    done = true;
    stop();
  };
}

/**
 * A GET read only while `want`; `defer` (a section open from the start) waits for the page to
 * be quiet first. `reload()` reads again a path that was read.
 */
export function useLazyApi<T>(
  path: string,
  want: boolean,
  defer: boolean,
  /** Beta.27 review: counted as a read that follows its path (readingPath); not the shell's own. */
  o: { counted?: boolean } = {},
): Lazy<T> & { reload: () => void } {
  const counted = o.counted ?? true;
  useEffect(() => (want && counted ? readingPath(path) : undefined), [path, want, counted]);
  const [s, set] = useState<Lazy<T>>(() =>
    kept.has(path) ? { state: "ready", data: kept.get(path) as T } : { state: "idle" },
  );
  const [tick, setTick] = useState(0);
  const deferRef = useRef(defer);
  deferRef.current = defer;
  const asked = useRef(false);
  const reload = useCallback(() => {
    if (asked.current) setTick((t) => t + 1);
  }, []);
  useEffect(() => {
    if (!want) return;
    const cached = tick === 0 && kept.has(path);
    if (cached) {
      asked.current = true;
      set({ state: "ready", data: kept.get(path) as T });
    }
    let live = true;
    // A read again keeps what is shown until the answer comes.
    set((o) => (o.state === "ready" ? o : { state: "loading" }));
    const go = () => {
      asked.current = true;
      // Beta.27 review: shared with every other ask of the path under way (sharedRead).
      sharedRead<T>(path).then(
        (data) => {
          if (live) set({ state: "ready", data });
        },
        (e: unknown) => {
          // A read behind a kept answer that fails keeps the answer shown.
          if (!live || cached) return;
          set({
            state: "error",
            error: e instanceof Error ? e.message : String(e),
            ...(e instanceof ApiError && e.problem.notYet ? { notYet: true } : {}),
          });
        },
      );
    };
    const cancel = tick === 0 && deferRef.current ? whenQuiet(go) : (go(), () => undefined);
    return () => {
      live = false;
      cancel();
    };
  }, [path, want, tick]);
  return { ...s, reload };
}

/**
 * Beta.27: an answer the shell shows a count from (the badge, the status bar), on every page and
 * not only on the pages that load it: the last answer a page (or the Explorer) had to the path,
 * else one read of its own once the page is quiet (as a section open from the start reads), so a
 * page that loads the path itself (Home loads /api/trust) is never asked twice. Nothing while
 * `want` is false (an editor's panel has no status bar).
 */
export function useKnownAnswer<T>(
  path: string,
  want = true,
  /**
   * Beta.27 review: whether a burst of file events can change what the path answers
   * (repo-counts.ts's manifestMayHaveChanged, question-counts.ts's); any burst by default.
   */
  relevant: (events: LiveEvent[]) => boolean = () => true,
): T | undefined {
  const last = useLastAnswer<T>(path);
  // Beta.27 review: file events that can change the answer read it again (beta.27's first cut
  // never did, so a count shown from an earlier page's answer stayed stale), unless a read on the
  // page follows the path itself (isPathRead: its answer comes here too) or the page read it again
  // just now (readAnswerAgain, FRESH_MS). Every count shown from the path shares one read
  // (sharedRead), so a burst asks the path once.
  const [stale, setStale] = useState(0);
  const own = useLazyApi<T>(path, want && (last === undefined || stale > 0), true, {
    counted: false,
  });
  const reload = own.reload;
  useFileChanges((events) => {
    if (!want || isPathRead(path) || !relevant(events)) return;
    if (Date.now() < (freshUntil.get(path) ?? 0)) return;
    setStale((n) => n + 1);
    reload();
  });
  return last ?? (own.state === "ready" ? own.data : undefined);
}

/**
 * Beta.27 review: read `path` again now and tell every count shown from it (useLastAnswer), as a
 * page does after it changed what the path answers (Questions, after an answer, scoped to a
 * change, where its own read is another path). Never throws: a failed read keeps the last answer.
 */
export function readAnswerAgain(path: string): Promise<void> {
  // Beta.27 review: the file events the answer's write makes read nothing again (freshUntil).
  freshUntil.set(path, Date.now() + FRESH_MS);
  return sharedRead<unknown>(path).then(
    () => undefined,
    () => undefined,
  );
}
