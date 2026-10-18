import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assess, changeStore, checkFindings, loadChangeContext } from "@maycombhq/changes";
import { orgPackDirOf } from "@maycombhq/core";
import { reviewedGates } from "@maycombhq/naysayer";
import { baseClonePath, readChangeRepos } from "@maycombhq/workspace";
import { loadCiConfig } from "./config.js";
import { DriftError, repoDrift, type DriftReport } from "./drift.js";

/**
 * The archive gate (the plan's OpenSpec archive gate), run in the metarepo before a change
 * is archived: the change must be released (or through its post-release review), with no
 * open blocking finding or knowledge gap on any gate it was reviewed at (built-in gates such
 * as drift and trace included), every repo's PR merged and its build passed, and no catalog
 * drift in its repos beyond what the approved design plans. Drift comes from reports the
 * pipelines produced (`atticus ci drift --json`), else from checking each repo's checkout
 * here. Deterministic: files only, plus the scan of local checkouts.
 */

export interface GateBlocker {
  code:
    | "wrong-state"
    | "finding"
    | "build-failed"
    | "build-running"
    | "build-not-run"
    | "pr-open"
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
  /** Drift reports from the repos' pipelines (`atticus ci drift --json` files). */
  driftReports?: string[];
  /** Where a repo's checkout is; default its change worktree, else its base clone. */
  repoDir?: (repo: string) => string | undefined;
  /** Commit to record for local drift checks (tests); default read with git. */
  commit?: string;
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

  // ---- repos: PRs merged, builds passed
  const repos = (await readChangeRepos(root, change.id))?.repos ?? [];
  for (const r of repos) {
    if (
      r.pr &&
      config.archive.requireMergedPrs &&
      r.pr.state !== "merged" &&
      r.pr.state !== "closed"
    )
      blockers.push({
        code: "pr-open",
        message: `${r.id}: PR #${r.pr.number} is ${r.pr.state}; merge it before archiving.`,
      });
    if (r.build.status === "failed")
      blockers.push({
        code: "build-failed",
        message: `${r.id}: the build failed${r.build.sha ? ` on ${r.build.sha.slice(0, 7)}` : ""}${r.build.log ? ` (log ${r.build.log})` : ""}.`,
      });
    else if (r.build.status === "running")
      blockers.push({ code: "build-running", message: `${r.id}: the build is still running.` });
    else if (r.build.status === "not-run" && r.pr)
      blockers.push({
        code: "build-not-run",
        message: `${r.id}: PR #${r.pr.number} changed code but no build has run.`,
      });
  }

  // ---- catalog drift
  const drift: DriftReport[] = [];
  if (o.driftReports?.length) {
    for (const f of o.driftReports) {
      try {
        drift.push(JSON.parse(await readFile(f, "utf8")) as DriftReport);
      } catch (e) {
        blockers.push({
          code: "drift-error",
          message: `Can't read the drift report ${f}: ${(e as Error).message.split("\n")[0]}.`,
        });
      }
    }
  } else {
    for (const r of repos) {
      const dir =
        o.repoDir?.(r.id) ??
        [join(root, r.worktree), baseClonePath(root, r.id)].find((d) => existsSync(d));
      if (!dir || !existsSync(dir)) {
        notes.push(
          `No checkout of ${r.id} here, so its drift wasn't checked; pass its pipeline's drift report.`,
        );
        continue;
      }
      try {
        drift.push(
          await repoDrift({
            repoDir: dir,
            catalog: root,
            repo: r.id,
            ...(o.commit ? { commit: o.commit } : {}),
          }),
        );
      } catch (e) {
        if (!(e instanceof DriftError)) throw e;
        blockers.push({ code: "drift-error", message: `${r.id}: ${e.message}` });
      }
    }
    if (!repos.length)
      notes.push("The change has no repos (repos.yaml), so there was no code to check for drift.");
  }
  for (const d of drift) {
    const items = d.items.filter((i) => i.kind !== "planned");
    if (!items.length) continue;
    blockers.push({
      code: "drift",
      message: `${d.repo}: ${items.length} catalog drift ${items.length === 1 ? "finding" : "findings"} (${items
        .slice(0, 3)
        .map((i) => i.summary.replace(/\.$/, ""))
        .join("; ")}${items.length > 3 ? "; ..." : ""}).`,
    });
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
