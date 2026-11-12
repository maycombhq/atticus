import type { Api } from "@maycombhq/core";
import { api, ApiError } from "./client.js";

/**
 * Beta.27 review: reads a page asks many of at once, one call for them all (local API 3.12.0).
 * The Map read each repo's facts with a call of its own (65 calls on a large estate), and the
 * Stories tab each story's file. Keys asked in one moment (a page's parts mounting together, a
 * burst of file events) go in one call, at most `max` keys a call; each asker gets its own key's
 * answer or problem, as the one-key call gives it.
 */
export function batcher<V>(
  many: (keys: string[]) => Promise<Map<string, V | ApiError>>,
  max: number,
): (key: string) => Promise<V> {
  let waiting: Map<string, { resolve: (v: V) => void; reject: (e: unknown) => void }[]> | undefined;
  const flush = (batch: typeof waiting & object) => {
    const keys = [...batch.keys()];
    for (let i = 0; i < keys.length; i += max) {
      const part = keys.slice(i, i + max);
      many(part).then(
        (got) => {
          for (const k of part) {
            const v = got.get(k);
            for (const w of batch.get(k) ?? []) {
              if (v === undefined)
                w.reject(new ApiError({ type: "about:blank", title: "Not answered", status: 500 }));
              else if (v instanceof ApiError) w.reject(v);
              else w.resolve(v);
            }
          }
        },
        (e: unknown) => {
          for (const k of part) for (const w of batch.get(k) ?? []) w.reject(e);
        },
      );
    }
  };
  return (key) =>
    new Promise<V>((resolve, reject) => {
      if (!waiting) {
        const batch = new Map<
          string,
          { resolve: (v: V) => void; reject: (e: unknown) => void }[]
        >();
        waiting = batch;
        // A moment for the rest of this moment's asks (each part's effect) to join.
        setTimeout(() => {
          waiting = undefined;
          flush(batch);
        }, 0);
      }
      const ws = waiting.get(key) ?? [];
      ws.push({ resolve, reject });
      waiting.set(key, ws);
    });
}

const problemError = (p: { status: number; title: string; detail?: string }) =>
  new ApiError({
    type: "about:blank",
    title: p.title,
    status: p.status,
    ...(p.detail ? { detail: p.detail } : {}),
  });

/** The most repos one GET /api/facts gives (the server's FACTS_BATCH_MAX). */
export const FACTS_BATCH = 500;

/** A repo's facts, read with the other repos asked in the same moment: GET /api/facts?repo=…. */
export const repoFacts: (repo: string) => Promise<Api.RepoFactsViewT> = batcher(async (repos) => {
  const q = repos.map((r) => `repo=${encodeURIComponent(r)}`).join("&");
  const got = await api<Api.RepoFactsBatchT>(`/api/facts?${q}`);
  const out = new Map<string, Api.RepoFactsViewT | ApiError>();
  for (const r of repos) {
    const v = got.facts?.[r];
    const p = got.problems?.[r];
    if (v) out.set(r, v);
    else if (p) out.set(r, problemError(p));
  }
  return out;
}, FACTS_BATCH);

/** The most files one GET …/artifacts/{artifact}/files gives (the server's ARTIFACT_FILES_MAX). */
export const FILES_BATCH = 200;

type FileAnswer = { artifact: string; path: string; content: string; sha256: string };
const fileBatchers = new Map<string, (file: string) => Promise<FileAnswer>>();

/**
 * One file of a many-file artifact (a story), read with the other files of that artifact asked
 * in the same moment: GET /api/changes/{id}/artifacts/{artifact}/files?file=…&file=….
 * `path` is the one-file read's address (artifactUrl with `file`); any other path is read alone.
 */
export function artifactFile<T>(path: string, signal?: AbortSignal): Promise<T> {
  const m = /^(\/api\/changes\/[^/?]+\/artifacts\/[^/?]+)\?file=([^&]+)$/.exec(path);
  if (!m) return api<T>(path, signal ? { signal } : {});
  const base = m[1]!;
  let b = fileBatchers.get(base);
  if (!b) {
    b = batcher(async (files) => {
      const q = files.map((f) => `file=${encodeURIComponent(f)}`).join("&");
      const got = await api<{ files: (FileAnswer & { file: string })[] }>(`${base}/files?${q}`);
      const out = new Map<string, FileAnswer | ApiError>();
      for (const f of got.files ?? []) {
        const { file, ...rest } = f;
        out.set(file, rest);
      }
      return out;
    }, FILES_BATCH);
    fileBatchers.set(base, b);
  }
  return b(decodeURIComponent(m[2]!)) as Promise<T>;
}
