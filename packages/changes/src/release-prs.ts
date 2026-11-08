import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  AdapterError,
  requireApproval,
  type Approval,
  type GitHost,
  type PullRequest,
} from "@maycombhq/adapters";
import {
  changeBranch,
  orgPackDirOf,
  toCanonicalYaml,
  type ChangeRepo,
  type LifecycleState,
} from "@maycombhq/core";
import { createGit, readChangeRepos, writeChangeRepos, type GitRunner } from "@maycombhq/workspace";
import { ChangeError, type Reason } from "./errors.js";
import { changeFolder, changeStore } from "./store.js";

/**
 * The release PRs (ADR 0184): one PR per code repo from `change/<id>` into the repo's default
 * branch, so what the task PRs merged into the change branch reaches the code that ships.
 *
 * Task PRs merge `task/<change>/<task>` into `change/<change>` (ADR 0036); this is the step after
 * them. It is raised in the release phase, before go/no-go, so the go/no-go decision is over the
 * PRs that will ship. The person's click (`--approve`) is the approval. Atticus pushes nothing to
 * the default branch: the change branch is on the host once task PRs merged into it, and when it
 * isn't, only the change branch is pushed, never forced. A person merges each PR on the host;
 * Sync records it. A manual Git host turns each PR into a step that records the real link.
 */

/** The states the release PRs may be raised in: once the build is done, and after release. */
export const RELEASE_PR_STATES: readonly LifecycleState[] = [
  "qa",
  "release-ready",
  "released",
  "post-release-review",
];

export type ReleasePrOutcome =
  /** The PR was opened now (or its manual step written). */
  | "raised"
  /** A PR was already open or merged; it is kept as it is. */
  | "kept"
  /** The rules refused it: not the change branch, a protected branch. Nothing was sent. */
  | "refused"
  /** The change branch has no commits beyond the default branch: nothing to release. */
  | "nothing"
  /** The push or the host failed; raise it again once that is fixed. */
  | "failed";

export interface ReleasePrRow {
  repo: string;
  outcome: ReleasePrOutcome;
  message: string;
  pr?: NonNullable<ChangeRepo["pr"]>;
}

export interface ReleasePrsResult {
  change: string;
  rows: ReleasePrRow[];
}

export interface RaiseReleasePrsOptions {
  gitHost: GitHost;
  /** The person's approval to push the change branch (when the host lacks it) and open the PRs. */
  approval: Approval;
  now?: string;
  git?: GitRunner;
  /** The Git host's remote in each worktree; default origin. */
  remote?: string;
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * `release-prs.yaml` in the change folder: the repos the raise found nothing to release in (the
 * change branch had no commits beyond the default branch, and the host didn't have it), so go/no-go
 * and the archive don't wait for a PR that can't exist. Written by the person's raise; a later
 * raise that opens a PR for the repo takes it off.
 */
export const RELEASE_PRS_FILE = "release-prs.yaml";
const NothingFile = z.strictObject({
  schemaVersion: z.literal(1),
  nothingToRelease: z.array(
    z.strictObject({
      repo: z.string().min(1),
      /** The change branch's commit when it was found to hold nothing beyond the default branch. */
      commit: z
        .string()
        .regex(/^[0-9a-f]{7,64}$/)
        .optional(),
      at: z.string().min(1),
      by: z.string().min(1),
    }),
  ),
});
type NothingFile = z.infer<typeof NothingFile>;

async function readNothing(root: string, id: string): Promise<NothingFile["nothingToRelease"]> {
  const text = await readFile(join(changeFolder(root, id), RELEASE_PRS_FILE), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return [];
  try {
    const r = NothingFile.safeParse(parse(text));
    return r.success ? r.data.nothingToRelease : [];
  } catch {
    return [];
  }
}

/** The repos of a change found to have nothing to release (ADR 0184). */
export async function nothingToRelease(root: string, id: string): Promise<Set<string>> {
  return new Set((await readNothing(root, id)).map((x) => x.repo));
}
const firstLine = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).split("\n")[0]!.replace(/\.$/, "");

const prOf = (pr: PullRequest, now: string): NonNullable<ChangeRepo["pr"]> => ({
  url: pr.url,
  number: pr.number,
  state: pr.state,
  updatedAt: now,
});

const live = (pr: ChangeRepo["pr"]) =>
  !!pr && (pr.state === "open" || pr.state === "draft" || pr.state === "merged");

function releaseBody(id: string, title: string, branch: string, base: string): string {
  return [
    `Release of change ${id} (${title}): merges ${branch}, with the task PRs merged into it, into ${base}.`,
    "",
    "The go/no-go hand-off is decided over this PR. A person reviews and merges it on the Git host; Atticus never pushes to or merges into the default branch, and never deploys.",
  ].join("\n");
}

/**
 * On the person's approval, open one PR per repo of the change from `change/<id>` into the repo's
 * default branch and record it in the change's repos.yaml. A repo whose release PR is open or
 * merged is kept; one closed on the host is raised again. A repo whose branch isn't the change
 * branch, or whose change branch is protected or is the default branch, is refused.
 */
export async function raiseReleasePrs(
  root: string,
  id: string,
  o: RaiseReleasePrsOptions,
): Promise<ReleasePrsResult> {
  requireApproval("changes", o.approval);
  const change = await changeStore(root).read(id);
  if (!RELEASE_PR_STATES.includes(change.state))
    throw new ChangeError(
      "refused",
      `${id} is ${change.state}; the release PRs are raised once the build is done (in QA or at go/no-go), so go/no-go is decided over the PRs that will ship.`,
    );
  const cr = await readChangeRepos(root, id);
  if (!cr?.repos.length)
    throw new ChangeError(
      "refused",
      `${id} has no code repos (repos.yaml), so there is no release PR to raise: open its workspace first (atticus workspace open ${id} <repo>).`,
    );
  const now = o.now ?? nowIso();
  const git = o.git ?? createGit();
  const remote = o.remote ?? "origin";
  const expected = changeBranch(id);
  const rows: ReleasePrRow[] = [];
  let changed = false;
  const repos = cr.repos.map((r) => ({ ...r }));
  const before = await readNothing(root, id);
  const nothing = new Map(before.map((x) => [x.repo, x]));

  for (const r of repos) {
    // Looked at again: a PR raised now takes the repo off the nothing-to-release list.
    if (!live(r.pr)) nothing.delete(r.id);
    if (live(r.pr)) {
      rows.push({
        repo: r.id,
        outcome: "kept",
        pr: r.pr!,
        message: `${r.id}: release PR #${r.pr!.number} is already ${r.pr!.state} (${r.pr!.url}).`,
      });
      continue;
    }
    if (r.branch !== expected) {
      rows.push({
        repo: r.id,
        outcome: "refused",
        message: `${r.id}: its branch is ${r.branch}, not ${expected}; Atticus raises a release PR only from the change branch.`,
      });
      continue;
    }
    let base: string;
    try {
      const info = await o.gitHost.getRepo(r.id);
      base = info.defaultBranch;
      if (info.protectedBranches.includes(r.branch)) {
        rows.push({
          repo: r.id,
          outcome: "refused",
          message: `${r.id}: ${r.branch} is protected; Atticus never pushes to or raises a PR from a protected branch.`,
        });
        continue;
      }
      if (r.branch === base) {
        rows.push({
          repo: r.id,
          outcome: "refused",
          message: `${r.id}: ${r.branch} is the default branch; a release PR goes from the change branch into it.`,
        });
        continue;
      }
    } catch (e) {
      if (!(e instanceof AdapterError)) throw e;
      rows.push({
        repo: r.id,
        outcome: "failed",
        message: `${r.id}: the Git host didn't answer (${firstLine(e)}); raise the release PRs again once it does.`,
      });
      continue;
    }

    // The change branch reaches the host by the task PRs merged into it. Only when the host
    // hasn't got it is this worktree's copy pushed: by name, without +, so never forced, and
    // never the default branch.
    const notes: string[] = [];
    const dir = join(root, r.worktree);
    if (existsSync(dir)) {
      const onHost = await git(["ls-remote", "--heads", remote, `refs/heads/${r.branch}`], dir)
        .then((x) => (x.stdout.trim() ? "yes" : "no"))
        .catch((e: unknown) => {
          notes.push(
            `Atticus couldn't reach ${remote} (${firstLine(e)}): push ${r.branch} yourself if the host lacks it.`,
          );
          return "unknown";
        });
      if (onHost === "no") {
        const from = r.baseSha ?? `${remote}/${base}`;
        const ahead = await git(["rev-list", "--count", `${from}..refs/heads/${r.branch}`], dir)
          .then((x) => Number(x.stdout.trim()) || 0)
          .catch(() => -1);
        if (ahead === 0) {
          const head = await git(["rev-parse", `refs/heads/${r.branch}`], dir)
            .then((x) => x.stdout.trim())
            .catch(() => "");
          nothing.set(r.id, {
            repo: r.id,
            ...(/^[0-9a-f]{7,64}$/.test(head) ? { commit: head } : {}),
            at: now,
            by: o.approval.by,
          });
          rows.push({
            repo: r.id,
            outcome: "nothing",
            message: `${r.id}: ${r.branch} has no commits beyond ${base} and isn't on the Git host: there is nothing to release from it, so go/no-go doesn't wait for a PR.`,
          });
          continue;
        }
        try {
          await git(["push", "-q", remote, `refs/heads/${r.branch}:refs/heads/${r.branch}`], dir);
          notes.push(`Pushed ${r.branch}, which the Git host didn't have.`);
        } catch (e) {
          rows.push({
            repo: r.id,
            outcome: "failed",
            message: `${r.id}: ${r.branch} isn't on the Git host and couldn't be pushed (${firstLine(e)}): push it yourself, then raise the release PRs again.`,
          });
          continue;
        }
      }
    }

    try {
      const pr = await o.gitHost.createPullRequest(
        {
          repo: r.id,
          head: r.branch,
          base,
          title: `${change.title} (release of ${id})`,
          body: releaseBody(id, change.title, r.branch, base),
        },
        o.approval,
      );
      r.pr = prOf(pr, now);
      changed = true;
      rows.push({
        repo: r.id,
        outcome: "raised",
        pr: r.pr,
        message: [
          pr.url.startsWith("manual:")
            ? `${r.id}: the release PR is a step for you (Home › Manual steps): open it on the Git host from ${r.branch} into ${base}, then record its link.`
            : `${r.id}: release PR #${pr.number} from ${r.branch} into ${base} is open: ${pr.url}`,
          ...notes,
        ].join(" "),
      });
    } catch (e) {
      if (!(e instanceof AdapterError)) throw e;
      // One already open from the change branch (raised on the host by hand): record it.
      if (e.code === "conflict") {
        const open = (await o.gitHost.listPullRequests(r.id, { head: r.branch }).catch(() => []))
          .filter((p) => p.base === base && (p.state === "open" || p.state === "draft"))
          .at(0);
        if (open) {
          r.pr = prOf(open, now);
          changed = true;
          rows.push({
            repo: r.id,
            outcome: "kept",
            pr: r.pr,
            message: `${r.id}: release PR #${open.number} was already open on the Git host; recorded it (${open.url}).`,
          });
          continue;
        }
      }
      rows.push({
        repo: r.id,
        outcome: "failed",
        message: `${r.id}: the release PR wasn't raised (${firstLine(e)}); fix that and raise the release PRs again.`,
      });
    }
  }
  if (changed) await writeChangeRepos(root, { ...cr, repos });
  const after = [...nothing.values()].sort((a, b) => (a.repo < b.repo ? -1 : 1));
  if (JSON.stringify(after) !== JSON.stringify(before))
    await writeFile(
      join(changeFolder(root, id), RELEASE_PRS_FILE),
      toCanonicalYaml(NothingFile.parse({ schemaVersion: 1, nothingToRelease: after })),
      "utf8",
    );
  return { change: id, rows };
}

/**
 * Read each recorded release PR from the Git host and record its state (merged, closed, a link a
 * person recorded on a manual step) and, when the host reports checks, the build they say.
 */
export async function syncReleasePrs(
  root: string,
  id: string,
  o: { gitHost: GitHost; now?: string },
): Promise<ReleasePrsResult> {
  const cr = await readChangeRepos(root, id);
  const rows: ReleasePrRow[] = [];
  if (!cr) return { change: id, rows };
  const now = o.now ?? nowIso();
  let changed = false;
  const repos = cr.repos.map((r) => ({ ...r }));
  for (const r of repos) {
    if (!r.pr) continue;
    let pr: PullRequest;
    try {
      pr = await o.gitHost.getPullRequest(r.id, r.pr.number);
      // Round 44: only the change branch's own PR counts (a manual host's recorded number may
      // be another PR's): by its head, or else the one PR from the change branch.
      if (pr.head !== r.branch) {
        const mine = await o.gitHost.listPullRequests(r.id, { head: r.branch });
        const own =
          mine.find((x) => x.url === r.pr!.url) ?? (mine.length === 1 ? mine[0] : undefined);
        if (!own) {
          rows.push({
            repo: r.id,
            outcome: "failed",
            pr: r.pr,
            message: `${r.id}: PR #${r.pr.number} on the Git host is from ${pr.head}, not ${r.branch}: check the release PR's number on the Git host (on a manual host, on its step), then sync again.`,
          });
          continue;
        }
        pr = own;
      }
    } catch (e) {
      if (!(e instanceof AdapterError)) throw e;
      rows.push({
        repo: r.id,
        outcome: "failed",
        pr: r.pr,
        message: `${r.id}: release PR #${r.pr.number} couldn't be read (${firstLine(e)}).`,
      });
      continue;
    }
    const build = buildOf(pr);
    if (pr.state !== r.pr.state || pr.url !== r.pr.url || pr.number !== r.pr.number) {
      r.pr = prOf(pr, now);
      changed = true;
    }
    if (build && build !== r.build.status) {
      r.build = { ...r.build, status: build, at: now };
      changed = true;
    }
    rows.push({
      repo: r.id,
      outcome: "kept",
      pr: r.pr,
      message: `${r.id}: release PR #${r.pr.number} is ${r.pr.state}${build ? `, checks ${build}` : ""} (${r.pr.url}).`,
    });
  }
  if (changed) await writeChangeRepos(root, { ...cr, repos });
  return { change: id, rows };
}

/** The build the host's checks on a PR say, or undefined when it reports none. */
function buildOf(pr: PullRequest): "passed" | "failed" | "running" | undefined {
  if (!pr.checks.length) return undefined;
  if (pr.checks.some((c) => c.status === "failed")) return "failed";
  if (pr.checks.some((c) => c.status === "pending")) return "running";
  return "passed";
}

/**
 * `archive.requireMergedPrs` in the org pack's `process/ci.yaml` (packages/ci reads the whole
 * file; this reads the one setting the go/no-go needs). Default true.
 */
export async function requireMergedPrs(root: string): Promise<boolean> {
  const text = await readFile(join(orgPackDirOf(root), "process", "ci.yaml"), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return true;
  try {
    const v = (parse(text) as { archive?: { requireMergedPrs?: unknown } } | null)?.archive
      ?.requireMergedPrs;
    return v !== false;
  } catch {
    return true;
  }
}

/**
 * What stops go/no-go on the release PRs: each repo the change touched needs its release PR, and
 * (unless the org pack says `archive.requireMergedPrs: false`) merged, so go/no-go is over what
 * reached the default branch. No repos.yaml: no code repo, nothing to stop.
 */
export async function releasePrReasons(root: string, id: string): Promise<Reason[]> {
  const cr = await readChangeRepos(root, id).catch(() => undefined);
  if (!cr?.repos.length) return [];
  const merged = await requireMergedPrs(root);
  const nothing = await nothingToRelease(root, id);
  const out: Reason[] = [];
  for (const r of cr.repos) {
    if (!r.pr && nothing.has(r.id)) continue;
    if (!r.pr || r.pr.state === "closed")
      out.push({
        code: "release-pr-missing",
        message: `${r.id}: no release PR from ${r.branch} into its default branch${r.pr ? ` (PR #${r.pr.number} was closed)` : ""}: raise the release PRs (Release › Raise the release PRs, or atticus change release-prs ${id} --approve).`,
      });
    else if (merged && r.pr.state !== "merged")
      out.push({
        code: "release-pr-not-merged",
        message: `${r.id}: release PR #${r.pr.number} is ${r.pr.state}: a person merges it on the Git host (${r.pr.url}), then Sync records it.`,
      });
  }
  return out;
}
