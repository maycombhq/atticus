import type { Api } from "@maycombhq/core";
import { api, ApiError } from "./client.js";

/**
 * Beta.27 review: reads a page asks many of at once, one call for them all (local API 3.12.0).
 * The Map read each repo's facts with a call of its own (65 calls on a large estate), and the
 * Stories tab each story's file. Keys asked in one moment (a page's parts mounting together, a
 * burst of file events) go in one call, at most `max` keys a call; each asker gets its own key's
 * answer or problem, as the one-key call gives it. Beta.27 re-review: and at most `budget`
 * characters of the keys' `cost` (their part of the call's address): 500 long repo names in one
 * address passed the server's 16 KB limit for a request's head, and every one failed (431).
 */
export function batcher<V>(
  many: (keys: string[], signal?: AbortSignal) => Promise<Map<string, V | ApiError>>,
  max: number,
  cost: (key: string) => number = () => 0,
  budget = URL_BUDGET,
): (key: string, signal?: AbortSignal) => Promise<V> {
  type Waiter = { resolve: (v: V) => void; reject: (e: unknown) => void; signal?: AbortSignal };
  let waiting: Map<string, Waiter[]> | undefined;
  const flush = (batch: Map<string, Waiter[]>) => {
    // Asked and dropped already (its screen left): not sent.
    for (const [k, ws] of batch) if (ws.every((w) => w.signal?.aborted)) batch.delete(k);
    for (const part of partsOf([...batch.keys()], max, cost, budget)) {
      // Beta.27 re-review: the call stops once every asker in it has gone (each its signal).
      const waiters = part.flatMap((k) => batch.get(k) ?? []);
      const stop = new AbortController();
      const signals = waiters.map((w) => w.signal);
      let unwatch = () => {};
      if (signals.every((x) => x)) {
        const check = () => {
          if (signals.every((x) => x!.aborted)) stop.abort();
        };
        for (const x of signals) x!.addEventListener("abort", check, { once: true });
        // Beta.27 re-review: the call answered, nothing of it listens on its askers' signals.
        unwatch = () => {
          for (const x of signals) x!.removeEventListener("abort", check);
        };
      }
      many(part, stop.signal)
        .finally(unwatch)
        .then(
          (got) => {
            for (const k of part) {
              const v = got.get(k);
              for (const w of batch.get(k) ?? []) {
                if (v === undefined)
                  w.reject(
                    new ApiError({ type: "about:blank", title: "Not answered", status: 500 }),
                  );
                else if (v instanceof ApiError) w.reject(v);
                else w.resolve(v);
              }
            }
          },
          (e: unknown) => {
            for (const w of waiters) w.reject(e);
          },
        );
    }
  };
  return (key, signal) =>
    new Promise<V>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      if (!waiting) {
        const batch = new Map<string, Waiter[]>();
        waiting = batch;
        // A moment for the rest of this moment's asks (each part's effect) to join.
        setTimeout(() => {
          waiting = undefined;
          flush(batch);
        }, 0);
      }
      // An asker that goes is answered at once (its own abort); the others still get theirs.
      // Beta.27 re-review: answered, it stops listening (a screen's one signal served every read).
      const onAbort = () => reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => signal?.removeEventListener("abort", onAbort);
      const ws = waiting.get(key) ?? [];
      ws.push({
        resolve: (v) => {
          done();
          resolve(v);
        },
        reject: (e) => {
          done();
          reject(e);
        },
        ...(signal ? { signal } : {}),
      });
      waiting.set(key, ws);
    });
}

/**
 * The characters of an address a batched read's keys may take: well under the server's 16 KB
 * for a request's whole head (its other headers, the session token, come with it).
 */
export const URL_BUDGET = 8 * 1024;

/** Keys in order, in parts of at most `max` keys and `budget` characters of their cost each. */
export function partsOf(
  keys: readonly string[],
  max: number,
  cost: (key: string) => number,
  budget: number,
): string[][] {
  const parts: string[][] = [];
  let part: string[] = [];
  let used = 0;
  for (const k of keys) {
    const c = cost(k);
    // A key alone past the budget still goes, alone (the server says what it makes of it).
    if (part.length && (part.length >= max || used + c > budget)) {
      parts.push(part);
      part = [];
      used = 0;
    }
    part.push(k);
    used += c;
  }
  if (part.length) parts.push(part);
  return parts;
}

/** A key's part of a batched read's address: `name=<key, encoded>&`. */
const param = (name: string) => (key: string) => name.length + 2 + encodeURIComponent(key).length;

const problemError = (p: { status: number; title: string; detail?: string }) =>
  new ApiError({
    type: "about:blank",
    title: p.title,
    status: p.status,
    ...(p.detail ? { detail: p.detail } : {}),
  });

/**
 * The most repos one GET /api/facts gives (the server's FACTS_BATCH_MAX). Beta.27 re-review: 100
 * (was 500), and fewer when their names would make the address longer than URL_BUDGET.
 */
export const FACTS_BATCH = 100;

/** A repo's facts, read with the other repos asked in the same moment: GET /api/facts?repo=…. */
export const repoFacts: (repo: string, signal?: AbortSignal) => Promise<Api.RepoFactsViewT> =
  batcher(
    async (repos, signal) => {
      const q = repos.map((r) => `repo=${encodeURIComponent(r)}`).join("&");
      const got = await api<Api.RepoFactsBatchT>(`/api/facts?${q}`, signal ? { signal } : {});
      const out = new Map<string, Api.RepoFactsViewT | ApiError>();
      for (const r of repos) {
        const v = got.facts?.[r];
        const p = got.problems?.[r];
        if (v) out.set(r, v);
        else if (p) out.set(r, problemError(p));
      }
      return out;
    },
    FACTS_BATCH,
    param("repo"),
  );

/**
 * The most files one GET …/artifacts/{artifact}/files gives (the server's ARTIFACT_FILES_MAX),
 * fewer when their paths would make the address longer than URL_BUDGET.
 */
export const FILES_BATCH = 200;

type FileAnswer = { artifact: string; path: string; content: string; sha256: string };
const fileBatchers = new Map<string, (file: string, signal?: AbortSignal) => Promise<FileAnswer>>();

/**
 * One file of a many-file artifact (a story), read with the other files of that artifact asked
 * in the same moment: GET /api/changes/{id}/artifacts/{artifact}/files?file=…&file=….
 * `path` is the one-file read's address (artifactUrl with `file`); any other path is read alone.
 * Beta.27 re-review: a file the server couldn't read (deleted meanwhile) is that file's problem
 * (`problems`), the others still answered; `signal` drops this asker (the call stops once every
 * asker in it has gone).
 */
export function artifactFile<T>(path: string, signal?: AbortSignal): Promise<T> {
  const m = /^(\/api\/changes\/[^/?]+\/artifacts\/[^/?]+)\?file=([^&]+)$/.exec(path);
  if (!m) return api<T>(path, signal ? { signal } : {});
  const base = m[1]!;
  let b = fileBatchers.get(base);
  if (!b) {
    b = batcher(
      async (files, sig) => {
        const q = files.map((f) => `file=${encodeURIComponent(f)}`).join("&");
        const got = await api<Api.ArtifactFilesT>(`${base}/files?${q}`, sig ? { signal: sig } : {});
        const out = new Map<string, FileAnswer | ApiError>();
        for (const f of got.files ?? []) {
          const { file, ...rest } = f;
          out.set(file, rest);
        }
        for (const [file, p] of Object.entries(got.problems ?? {})) out.set(file, problemError(p));
        return out;
      },
      FILES_BATCH,
      param("file"),
    );
    fileBatchers.set(base, b);
  }
  return b(decodeURIComponent(m[2]!), signal) as Promise<T>;
}
