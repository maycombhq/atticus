import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assess,
  changeStore,
  checkFindings,
  loadChangeContext,
  nothingToRelease,
} from "@maycombhq/changes";
import {
  catalogDirOf,
  factsDirOf,
  orgPackDirOf,
  parseFacts,
  type ChangeRepo,
} from "@maycombhq/core";
import { reviewedGates } from "@maycombhq/naysayer";
import { readCatalog } from "@maycombhq/scanner";
import { baseClonePath, createGit, readChangeRepos, type GitRunner } from "@maycombhq/workspace";
import { loadCiConfig } from "./config.js";
import { DriftError, repoDrift, type DriftReport } from "./drift.js";

/**
 * The archive gate (the plan's OpenSpec archive gate), run in the metarepo before a change
 * is archived: the change must be released (or through its post-release review), with no
 * open blocking finding or knowledge gap on any gate it was reviewed at (built-in gates such
 * as drift and trace included), every repo's release PR merged (ADR 0184) and its build passed,
 * and the catalog of what shipped.
 *
 * What shipped is decided by the facts (ADR 0074): each repo's facts (`facts/<repo>.jsonl`, the
 * ones `atticus verify` kept) must be read at the merged commit, the commit the repo's clone is at
 * once synced (or the one its pipeline's drift report scanned), and the catalog must be written
 * from them. A repo whose facts are of another commit needs reading again; that is the blocker,
 * never drift. The built-in readers (`repoDrift` on the clone, or the pipelines' `atticus ci
 * drift --json` reports) are a cross-check only: what they see differently is a note.
 * Deterministic: files only, plus git and the readers on local clones.
 */

export interface GateBlocker {
  code:
    | "wrong-state"
    | "finding"
    | "build-failed"
    | "build-running"
    | "build-not-run"
    | "pr-open"
    /** ADR 0184: no release PR from the change branch into the default branch. */
    | "pr-missing"
    /** The clone is still where the change started though its release PR merged. */
    | "not-synced"
    /** The repo's facts aren't of the merged commit: read it again. */
    | "needs-reading"
    /** The facts are of the merged commit, but the catalog isn't written from them. */
    | "catalog-stale"
    | "drift"
    | "drift-error";
  message: string;
}

export interface ArchiveGateResult {
  change: string;
  state: string;
  pass: boolean;
  blockers: GateBlocker[];
  notes: string[];
  drift: DriftReport[];
}

export interface ArchiveGateOptions {
  /** Drift reports from the repos' pipelines (`atticus ci drift --json` files); each one's commit is its repo's merged commit. */
  driftReports?: string[];
  /** Where a repo's clone of its default branch is; default its base clone (never the change's worktree, which stops at the change branch). */
  repoDir?: (repo: string) => string | undefined;
  /** The merged commit (tests); default the drift report's, else the clone's HEAD read with git. */
  commit?: string;
  git?: GitRunner;
}

const short = (c: string) => c.slice(0, 12);
const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * ADR 0074: whether a repo's facts are of the merged commit and the catalog is written from them;
 * a blocker when not, saying the in-app step that puts it right.
 */
async function factsAtMerge(
  root: string,
  r: ChangeRepo,
  merged: string,
  catalog: () => Promise<{ evidence: { repo?: string; commit?: string }[] }[]>,
): Promise<GateBlocker | undefined> {
  const where = `${short(merged)}, the commit its release merged into ${r.base}`;
  const readAgain = `read it again (Map › Trust › Freshness: Read again, or atticus map ${r.id}), then atticus verify ${r.id} --write, so the catalog says what shipped.`;
  const text = await readFile(join(factsDirOf(root), `${r.id}.jsonl`), "utf8").catch(() => "");
  const parsed = text.trim() ? parseFacts(text) : undefined;
  const facts = parsed?.ok ? parsed.facts : [];
  if (!facts.length)
    return {
      code: "needs-reading",
      message: `${r.id}: no facts were read at ${where}: ${readAgain}`,
    };
  const other = [...new Set(facts.map((f) => f.commit))].filter((c) => !sameCommit(c, merged));
  if (other.length)
    return {
      code: "needs-reading",
      message: `${r.id}: its facts were read at ${other.map(short).join(", ")}, not at ${where}: ${readAgain}`,
    };
  const stale = (await catalog()).filter((x) =>
    x.evidence.some((e) => e.repo === r.id && e.commit && !sameCommit(e.commit, merged)),
  ).length;
  if (stale)
    return {
      code: "catalog-stale",
      message: `${r.id}: its facts are of the merged commit ${short(merged)}, but ${plural(stale, "catalog record")} still ${stale === 1 ? "cites" : "cite"} another commit: write them into the catalog (atticus verify ${r.id} --write, or Apply on the Map).`,
    };
  return undefined;
}

export async function archiveGate(
  root: string,
  changeId: string,
  o: ArchiveGateOptions = {},
): Promise<ArchiveGateResult> {
  const change = await changeStore(root).read(changeId);
  const blockers: GateBlocker[] = [];
  const notes: string[] = [];
  const { config } = await loadCiConfig(orgPackDirOf(root));

  // ---- state
  if (change.state === "post-release-review") {
    const ctx = await loadChangeContext(root);
    const a = await assess(ctx, change);
    for (const r of a.blockers) blockers.push({ code: "finding", message: r.message });
  } else if (change.state !== "released") {
    blockers.push({
      code: "wrong-state",
      message:
        change.state === "archived"
          ? `${change.id} is already archived.`
          : `${change.id} is ${change.state}; a change is archived once it is released (go/no-go merged).`,
    });
  }

  // ---- findings on every gate it was reviewed at
  const gates = await reviewedGates(root, change.id);
  for (const r of await checkFindings(root, change, gates))
    blockers.push({ code: "finding", message: r.message });

  // ---- repos: release PRs merged (ADR 0184), builds passed
  const repos = (await readChangeRepos(root, change.id))?.repos ?? [];
  const mustMerge = config.archive.requireMergedPrs;
  // Final review (git and tasks): an entry is void once the change branch moved past it.
  const nothing = await nothingToRelease(root, change.id, o.git ? { git: o.git } : {});
  for (const r of repos) {
    // The raise found nothing to release here (ADR 0184): no PR, no code shipped, nothing to read.
    if (!r.pr && nothing.has(r.id)) continue;
    if (mustMerge && (!r.pr || r.pr.state === "closed"))
      blockers.push({
        code: "pr-missing",
        message: `${r.id}: ${r.pr ? `release PR #${r.pr.number} was closed without merging` : `no release PR from ${r.branch} into ${r.base} was raised`}, so the code never reached ${r.base}: raise the release PRs (Release › Raise the release PRs, or atticus change release-prs ${change.id} --approve), and merge them on the Git host.`,
      });
    else if (mustMerge && r.pr && r.pr.state !== "merged")
      blockers.push({
        code: "pr-open",
        message: `${r.id}: release PR #${r.pr.number} is ${r.pr.state}; a person merges it on the Git host before archiving.`,
      });
    if (r.build.status === "failed")
      blockers.push({
        code: "build-failed",
        message: `${r.id}: the build failed${r.build.sha ? ` on ${r.build.sha.slice(0, 7)}` : ""}${r.build.log ? ` (log ${r.build.log})` : ""}.`,
      });
    else if (r.build.status === "running")
      blockers.push({ code: "build-running", message: `${r.id}: the build is still running.` });
    else if (r.build.status === "not-run" && r.pr?.state === "merged")
      // Sync records the host's checks on the release PR as its build; a host with none (no CI
      // on the repo) can't be made to report one after the merge, so it is said, not blocked.
      notes.push(
        `${r.id}: the Git host reported no checks on release PR #${r.pr.number}, so no build is recorded for what merged.`,
      );
    else if (r.build.status === "not-run" && r.pr)
      blockers.push({
        code: "build-not-run",
        message: `${r.id}: PR #${r.pr.number} changed code but no build has run.`,
      });
  }

  // ---- what shipped: the facts at the merged commit decide (ADR 0074); readers cross-check
  const drift: DriftReport[] = [];
  for (const f of o.driftReports ?? []) {
    try {
      drift.push(JSON.parse(await readFile(f, "utf8")) as DriftReport);
    } catch (e) {
      blockers.push({
        code: "drift-error",
        message: `Can't read the drift report ${f}: ${(e as Error).message.split("\n")[0]}.`,
      });
    }
  }
  const git = o.git ?? createGit();
  /** Repos whose catalog the readers made (never read by the assistant): their drift blocks. */
  const readersDecide = new Set<string>();
  let records: Awaited<ReturnType<typeof readCatalog>>["records"] | undefined;
  const catalog = async () =>
    (records ??= (await readCatalog(join(catalogDirOf(root), "generated"))).records);
  for (const r of repos) {
    if (!r.pr && nothing.has(r.id)) continue;
    // An unmerged release PR is the blocker already; its facts can't be of a merge yet.
    if (mustMerge && r.pr?.state !== "merged") continue;
    const report = drift.find((d) => d.repo === r.id);
    const dir = o.repoDir?.(r.id) ?? baseClonePath(root, r.id);
    const there = !!dir && existsSync(dir);
    const merged =
      o.commit ??
      (report && !/^0+$/.test(report.scanned.commit) ? report.scanned.commit : undefined) ??
      (there
        ? await git(["rev-parse", "HEAD"], dir)
            .then((x) => x.stdout.trim() || undefined)
            .catch(() => undefined)
        : undefined);
    if (!merged) {
      notes.push(
        `No clone of ${r.id} here to say which commit merged, so its facts weren't compared: sync the workspace (atticus workspace sync), or pass its pipeline's drift report.`,
      );
      continue;
    }
    if (r.pr?.state === "merged" && r.baseSha && sameCommit(merged, r.baseSha)) {
      blockers.push({
        code: "not-synced",
        message: `${r.id}: the clone here is still at ${short(merged)}, where the change started, though release PR #${r.pr.number} merged: sync the workspace (atticus workspace sync), then read the repo again.`,
      });
      continue;
    }
    // A repo the assistant never read (no facts file, no catalog record it wrote) has a catalog
    // the readers made: the readers are what it is compared with, as before ADR 0074.
    const readByAssistant =
      existsSync(join(factsDirOf(root), `${r.id}.jsonl`)) ||
      (await catalog()).some((x) =>
        x.evidence.some((e) => e.repo === r.id && e.by === "assistant"),
      );
    if (readByAssistant) {
      const b = await factsAtMerge(root, r, merged, catalog);
      if (b) blockers.push(b);
    } else if (report) readersDecide.add(r.id);
    // The readers on the clone at the merged commit (never the change's worktree).
    if (!report && there) {
      try {
        drift.push(await repoDrift({ repoDir: dir, catalog: root, repo: r.id, commit: merged }));
        if (!readByAssistant) readersDecide.add(r.id);
      } catch (e) {
        if (!(e instanceof DriftError)) throw e;
        if (readByAssistant)
          notes.push(`Cross-check only: the built-in readers couldn't read ${r.id}: ${e.message}`);
        else blockers.push({ code: "drift-error", message: `${r.id}: ${e.message}` });
      }
    } else if (!report && !readByAssistant)
      notes.push(
        `No clone of ${r.id} here, so its drift wasn't checked; sync the workspace, or pass its pipeline's drift report.`,
      );
  }
  if (!repos.length)
    notes.push("The change has no repos (repos.yaml), so there was no code to check for drift.");
  for (const d of drift) {
    const items = d.items.filter((i) => i.kind !== "planned");
    if (!items.length) continue;
    if (readersDecide.has(d.repo)) {
      blockers.push({
        code: "drift",
        message: `${d.repo}: ${items.length} catalog drift ${items.length === 1 ? "finding" : "findings"} (${items
          .slice(0, 3)
          .map((i) => i.summary.replace(/\.$/, ""))
          .join("; ")}${items.length > 3 ? "; ..." : ""}).`,
      });
      continue;
    }
    notes.push(
      `Cross-check only, not blocking: the built-in readers see ${plural(items.length, "difference")} in ${d.repo} (${items
        .slice(0, 3)
        .map((i) => i.summary.replace(/\.$/, ""))
        .join(
          "; ",
        )}${items.length > 3 ? "; ..." : ""}). The facts read and verified at the merged commit decide (ADR 0074).`,
    );
  }

  const unique = [...new Map(blockers.map((b) => [b.message, b])).values()];
  return {
    change: change.id,
    state: change.state,
    pass: unique.length === 0,
    blockers: unique,
    notes,
    drift,
  };
}
