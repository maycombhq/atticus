import { staleCite, type Fact, type FileChange, type StaleCite } from "@maycombhq/core";
import { globToRegExp } from "@maycombhq/sdk";
import { readingOrder } from "./batches.js";
import type { FileSource } from "./source.js";
import { changesFor, isSourceFile, sameCommit, type CarryChanges } from "./verify.js";

/**
 * A re-read (ADR 0124 addendum A-incremental): the checkout moved since the facts were read, and
 * a changed file invalidates only what cites it. `carry` holds, for each earlier commit the facts
 * name, the files changed from it to the commit being read (`changesSince` in
 * @maycombhq/workspace). A fact whose every cited file is unchanged is carried (atticus verify
 * checks its lines at the new commit and rewrites its commit); a fact citing a changed file is
 * read again; the changed source files are what the read opens.
 */

export interface RereadPlan {
  /** The commit being read. */
  commit: string;
  /** The earlier commits the facts name that could be compared, with how many files changed. */
  from: { commit: string; changed: number }[];
  /** Facts already of `commit`. */
  current: number;
  /** Facts of an earlier commit whose every cited file is unchanged: kept, carried by verify. */
  carried: number;
  /** Facts citing a file that changed: read again, then rewrite or drop each. */
  reread: (StaleCite & { id: string; kind: Fact["kind"]; from: string })[];
  /**
   * The source files to read at `commit`: every file edited, added or renamed since (a deleted
   * one has nothing to read), in reading order; `facts` counts the facts to rewrite citing it.
   */
  files: { path: string; status: FileChange["status"]; facts: number }[];
  /** Earlier commits the clone can't compare (not in it): their facts are read again whole. */
  unknown: string[];
}

export function rereadPlan(o: {
  facts: readonly Fact[];
  commit: string;
  carry: CarryChanges;
  source: FileSource;
  exclude?: readonly string[];
}): RereadPlan {
  let current = 0;
  let carried = 0;
  const reread: RereadPlan["reread"] = [];
  const unknown = new Set<string>();
  const used = new Map<string, readonly FileChange[]>();
  for (const f of [...o.facts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (sameCommit(f.commit, o.commit)) {
      current++;
      continue;
    }
    const changes = changesFor(o.carry, f.commit);
    if (!changes) {
      unknown.add(f.commit);
      continue;
    }
    used.set(f.commit, changes);
    const s = staleCite(f, changes);
    if (s) reread.push({ id: f.id, kind: f.kind, from: f.commit, ...s });
    else carried++;
  }
  const excludeRes = (o.exclude ?? []).map(globToRegExp);
  const status = new Map<string, FileChange["status"]>();
  for (const changes of used.values())
    for (const c of changes) if (c.status !== "deleted") status.set(c.path, c.status);
  const readable = [...status.keys()].filter((p) => {
    const text = o.source.read(p);
    if (text === undefined || !text.trim()) return false;
    if (!isSourceFile(p, text.split(/\r?\n/, 1)[0] ?? "")) return false;
    return !excludeRes.some((re) => re.test(p));
  });
  const files = readingOrder(readable).map((path) => ({
    path,
    status: status.get(path)!,
    facts: reread.filter((r) => (r.to ?? r.file) === path).length,
  }));
  return {
    commit: o.commit,
    from: [...used.entries()]
      .map(([commit, changes]) => ({ commit, changed: changes.length }))
      .sort((a, b) => (a.commit < b.commit ? -1 : 1)),
    current,
    carried,
    reread,
    files,
    unknown: [...unknown].sort(),
  };
}

/** A source that lists only these files (a re-read's batches), reading through to the checkout. */
export function onlyFiles(source: FileSource, paths: readonly string[]): FileSource {
  const keep = new Set(paths);
  return { list: () => source.list().filter((p) => keep.has(p)), read: (p) => source.read(p) };
}
