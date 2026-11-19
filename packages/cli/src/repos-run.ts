import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  addManifestRepos,
  factsDirOf,
  loadOrgPack,
  manifestFiles,
  orgPackDirOf,
  type Api,
} from "@maycombhq/core";
import { estateRepos, factsSlotPaths } from "@maycombhq/scanner";
import { badRequest } from "@maycombhq/server";
import type { Output } from "./commands.js";
import { copilotAcpAllowed } from "./copilot-acp-steps.js";

/**
 * ADR 0204 decision 4: new repos in one go, as one job of four parts, each the code that is
 * there: Add (`addManifestRepos`), Sync (the workspace sync, for these repos), Read (the
 * assistant: one unattended run where runtime.yaml allows it, else a pause with the command to
 * paste; the built-in readers are never used in its place, hard rule 4) and Apply (`verify
 * --write` for these repos, in name order). The parts are worked out from disk (listed, cloned,
 * facts on file, applied), so the same request picks up where a Stop left it. Stop is heard
 * between parts and between repos; what is done stays done. Nothing here commits or pushes.
 */

type Part = Api.ReposRunPartT["part"];
type State = Api.ReposRunPartT["state"];
const WORDS: Record<Part, string> = {
  add: "adding",
  sync: "syncing",
  read: "reading",
  apply: "applying",
};

/** Test hooks: each part's work (a mock git, a mock assistant), and the clock. */
export const reposRunHooks: {
  sync?: (root: string, repos: string[], io: Output, signal?: AbortSignal) => Promise<number>;
  read?: (root: string, repos: string[], io: Output, signal?: AbortSignal) => Promise<number>;
  /** Whether the app may start the assistant here (runtime.yaml), when a test says. */
  canRead?: boolean;
  apply?: (
    root: string,
    repos: string[],
    io: Output,
    onRepo: (repo: string, code: number) => void,
  ) => Promise<number>;
  clock?: () => number;
} = {};

/** Where each repo stands on disk: in a manifest, cloned, read (facts on file), applied (a slot). */
async function standing(root: string, ids: readonly string[]) {
  const op = await loadOrgPack(orgPackDirOf(root));
  const listed = new Set(estateRepos(op).map((r) => r.id));
  const { repoFor } = await import("./repo-for.js");
  const out = new Map<
    string,
    { listed: boolean; cloned: boolean; read: boolean; applied: boolean }
  >();
  for (const id of ids) {
    const clone = listed.has(id) ? await repoFor(root, id).catch(() => undefined) : undefined;
    out.set(id, {
      listed: listed.has(id),
      cloned: !!clone?.dir && existsSync(join(clone.dir, ".git")),
      read: existsSync(join(factsDirOf(root), `${id}.jsonl`)),
      applied: existsSync(factsSlotPaths(root, id).facts),
    });
  }
  return { op, out };
}

/** The words of the progress line: "Part 3 of 4: reading forge-ledger (2 of 5). About 6 min left." */
export function partWords(
  part: Part,
  repo: string,
  i: number,
  n: number,
  left: string | undefined,
): string {
  const k = (["add", "sync", "read", "apply"] as const).indexOf(part) + 1;
  return `Part ${k} of 4: ${WORDS[part]} ${repo} (${i} of ${n}). ${left ? `${left[0]!.toUpperCase()}${left.slice(1)} left.` : "No estimate yet."}`;
}

export async function reposRun(
  root: string,
  req: Api.ReposRunRequestT,
  o: { by: string; io: Output; signal?: AbortSignal; progress?: (line: string) => void },
): Promise<Api.ReposRunResultT> {
  const ids = [...new Set(req.repos.map((r) => r.id))].sort();
  const clock = reposRunHooks.clock ?? Date.now;
  const began = clock();
  const steps = ids.length * 4;
  let done = 0;
  const say = (part: Part, repo: string, i: number, n: number) => {
    // Time left: the rate so far, once a step has ended; before that, no estimate.
    const left = done ? leftWords(((clock() - began) / done) * (steps - done)) : undefined;
    o.progress?.(partWords(part, repo, i, n, left));
  };
  const stopped = () => o.signal?.aborted === true;
  let handoff: Api.ReposRunResultT["handoff"];
  const parts: Api.ReposRunPartT[] = [];
  const part = (p: Part, rows: Api.ReposRunPartT["repos"]): Api.ReposRunPartT => {
    const states = new Set(rows.map((r) => r.state));
    const state: State = states.has("stopped")
      ? "stopped"
      : states.has("waiting")
        ? "waiting"
        : rows.length && rows.every((r) => r.state === "failed")
          ? "failed"
          : "done";
    const x = { part: p, state, repos: rows };
    parts.push(x);
    return x;
  };
  const rest = (p: Part, repos: readonly string[], state: State) =>
    part(
      p,
      repos.map((repo) => ({ repo, state })),
    );
  let { out } = await standing(root, ids);

  // 1. Add: the repos no manifest lists yet.
  const toAdd = req.repos.filter((r) => !out.get(r.id)!.listed);
  if (toAdd.length) {
    const files = await manifestFiles(root);
    const platform = req.platform ?? (files.length === 1 ? files[0]!.platform : undefined);
    if (!platform) throw badRequest(`There are ${files.length} platforms: say which.`);
    say("add", toAdd[0]!.id, 1, toAdd.length);
    await addManifestRepos(
      root,
      platform,
      toAdd.map((x) => ({
        id: x.id,
        url: x.url,
        type: x.type?.trim() || "unknown",
        owner: x.owner?.trim() || "unassigned",
        ...(x.defaultBranch ? { defaultBranch: x.defaultBranch } : {}),
      })),
    );
    o.io.out(`Added ${toAdd.length} repo${toAdd.length === 1 ? "" : "s"} to the manifest.`);
  }
  part(
    "add",
    ids.map((repo) => ({ repo, state: "done" as const })),
  );
  done += ids.length;
  const { op } = await standing(root, ids).then((x) => ((out = x.out), x));
  const not = (k: "cloned" | "read" | "applied") => ids.filter((id) => !out.get(id)![k]);

  // 2. Sync: the repos not cloned yet, one at a time so Stop is heard between them.
  const toSync = not("cloned");
  if (stopped()) return finish(rest("sync", ids, "stopped"));
  const synced: Api.ReposRunPartT["repos"] = ids
    .filter((id) => !toSync.includes(id))
    .map((repo) => ({ repo, state: "done" }));
  const sync = reposRunHooks.sync ?? defaultSync;
  for (const [i, repo] of toSync.entries()) {
    if (stopped()) {
      synced.push(...toSync.slice(i).map((r) => ({ repo: r, state: "stopped" as const })));
      break;
    }
    say("sync", repo, i + 1, toSync.length);
    const code = await sync(root, [repo], o.io, o.signal);
    synced.push(
      code === 0
        ? { repo, state: "done" }
        : {
            repo,
            state: stopped() ? "stopped" : "failed",
            why: "the clone was refused: see the lines",
          },
    );
    done++;
  }
  if (part("sync", synced).state === "stopped") return finish();
  ({ out } = await standing(root, ids));

  // 3. Read: by the person's assistant (hard rule 4), never the built-in readers.
  const toRead = not("read").filter((id) => out.get(id)!.cloned);
  const read: Api.ReposRunPartT["repos"] = ids
    .filter((id) => !toRead.includes(id))
    .map((repo) =>
      out.get(repo)!.read
        ? { repo, state: "done" as const }
        : { repo, state: "failed" as const, why: "not cloned" },
    );
  if (toRead.length) {
    if (req.read) {
      // "I've read them: continue": a repo with no facts on file is listed and left for later.
      for (const repo of toRead)
        read.push({ repo, state: "failed", why: "no facts on file yet: read it, then Continue" });
    } else if (reposRunHooks.canRead ?? copilotAcpAllowed(op)) {
      if (stopped()) return finish(rest("read", ids, "stopped"));
      say("read", toRead[0]!, 1, toRead.length);
      await (reposRunHooks.read ?? defaultRead)(root, toRead, o.io, o.signal);
      ({ out } = await standing(root, ids));
      for (const repo of toRead)
        read.push(
          out.get(repo)!.read
            ? { repo, state: "done" }
            : {
                repo,
                state: stopped() ? "stopped" : "failed",
                why: "the read ended with no facts on file",
              },
        );
      done += toRead.length;
    } else {
      // The pause: the command to paste, and I've read them: continue.
      handoff = { command: toRead.map((r) => `/atticus-map ${r}`).join("\n") };
      for (const repo of toRead) read.push({ repo, state: "waiting" });
      part("read", read);
      return finish(rest("apply", ids, "waiting"));
    }
  }
  if (part("read", read).state === "stopped") return finish();
  if (stopped()) return finish(rest("apply", ids, "stopped"));

  // 4. Apply: verify --write for the repos read and not applied, in name order.
  ({ out } = await standing(root, ids));
  const toApply = ids.filter((id) => out.get(id)!.read && !out.get(id)!.applied);
  const applied: Api.ReposRunPartT["repos"] = ids
    .filter((id) => !toApply.includes(id))
    .map((repo) =>
      out.get(repo)!.applied
        ? { repo, state: "done" as const }
        : { repo, state: "waiting" as const, why: "not read yet" },
    );
  if (toApply.length) {
    let k = 0;
    say("apply", toApply[0]!, 1, toApply.length);
    await (reposRunHooks.apply ?? defaultApply)(root, toApply, o.io, (repo, code) => {
      applied.push(
        code === 0 || code === 3
          ? { repo, state: "done" }
          : { repo, state: "failed", why: "verify refused it: see the lines" },
      );
      done++;
      k++;
      if (k < toApply.length) say("apply", toApply[k]!, k + 1, toApply.length);
    });
    for (const repo of toApply.filter((r) => !applied.some((x) => x.repo === r)))
      applied.push({ repo, state: stopped() ? "stopped" : "failed" });
  }
  part(
    "apply",
    applied.sort((a, b) => (a.repo < b.repo ? -1 : 1)),
  );
  return finish();

  async function finish(_?: unknown): Promise<Api.ReposRunResultT> {
    const now = await standing(root, ids);
    return {
      parts,
      ...(handoff ? { handoff } : {}),
      done: ids.filter((id) => now.out.get(id)!.applied).length,
      of: ids.length,
    };
  }
}

const leftWords = (ms: number) => {
  if (ms < 45_000) return "under a minute";
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `about ${min} min` : `about ${Math.round(min / 60)} h`;
};

const defaultSync = async (root: string, repos: string[], io: Output, signal?: AbortSignal) => {
  const { workspaceSync } = await import("./workspace-commands.js");
  return workspaceSync(root, repos, io, signal ? { signal } : {});
};
const defaultRead = async (root: string, repos: string[], io: Output, signal?: AbortSignal) => {
  const { mapAllCommand } = await import("./map-all.js");
  return mapAllCommand(root, { repos, mode: "copilot-acp" }, io, signal ? { signal } : {});
};
const defaultApply = async (
  root: string,
  repos: string[],
  io: Output,
  onRepo: (repo: string, code: number) => void,
) => {
  const { verifyAllCommand } = await import("./verify-commands.js");
  return verifyAllCommand(root, { write: true, only: repos, onRepo }, io);
};
