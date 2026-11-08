import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  catalogDirOf,
  changesRelOf,
  factsDirOf,
  loadOrgPack,
  orgPackDirOf,
  questionsDirOf,
} from "@maycombhq/core";
import type { Output } from "./commands.js";
import { createAdapters, fileStepStore, type GitHost } from "@maycombhq/adapters";
import { gitHandoffPublisher, type HandoffPublisher } from "@maycombhq/changes";
import { initiativesDirOf } from "@maycombhq/initiatives";
import { createGit, type GitRunner } from "@maycombhq/workspace";

/**
 * ADR 0183: Propose for review. The metarepo files a kind of work changed, committed onto a
 * branch (without touching the person's working tree, index or checked-out branch), pushed, and
 * opened as a PR, after the person's yes. A human approves and merges on the Git host.
 */
export const PROPOSE_SCOPES = [
  "answers",
  "corrections",
  "audit",
  "org-pack",
  "initiatives",
  "outcomes",
] as const;
export type ProposeScope = (typeof PROPOSE_SCOPES)[number];

const TITLES: Record<ProposeScope, string> = {
  answers: "Answers to the map's questions",
  corrections: "Corrections to the map",
  audit: "A sample audit's answers",
  "org-pack": "Org pack and settings",
  initiatives: "Initiatives and commitments",
  outcomes: "Outcomes measured after release",
};

const rel = (root: string, dir: string) => relative(root, dir).split("\\").join("/");

/** The folders a kind of work owns, relative to the metarepo. */
export function scopeDirs(root: string, scope: ProposeScope): string[] {
  const facts = rel(root, factsDirOf(root));
  const catalog = rel(root, catalogDirOf(root));
  switch (scope) {
    // An answer also writes in the org pack (a repo type's skill file, a host in the manifest,
    // an outside system in a profile): its PR carries those too (review round 35).
    case "answers":
      return [rel(root, questionsDirOf(root)), facts, catalog, rel(root, orgPackDirOf(root))];
    case "corrections":
      return [facts, catalog];
    case "audit":
      return [facts];
    case "org-pack":
      return [rel(root, orgPackDirOf(root))];
    // UX review: an initiative's curated records (the initiative, its commitments and the
    // parties its plan names) and its folder (the plan, the notes, the system cards); not the
    // rest of the curated catalog (a triage decision is its own review).
    case "initiatives":
      return [
        ...["initiative", "commitment", "party"].map((k) => `${catalog}/curated/${k}`),
        rel(root, initiativesDirOf(root)),
      ];
    // UX review: an outcome recorded after release is the change's review/outcomes.yaml, open
    // or archived (a pathspec's * crosses folders); nothing else of the change.
    case "outcomes":
      return [`${changesRelOf(root)}/*/review/outcomes.yaml`];
  }
}

export interface ProposePlan {
  scope: ProposeScope;
  /** A rename's old path is `from`: proposing the new one records the old one's removal. */
  files: { path: string; status: string; from?: string }[];
  branch: string;
  title: string;
}

/** What Propose for review would commit: the changed files under the scope's folders. */
export async function proposePlan(
  root: string,
  scope: ProposeScope,
  o: { git?: GitRunner; now?: Date; by?: string } = {},
): Promise<ProposePlan> {
  const git = o.git ?? createGit();
  const dirs = scopeDirs(root, scope).filter((d) => d && !d.startsWith(".."));
  const out = (
    await git(
      [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        ...dirs,
      ],
      root,
    )
  ).stdout;
  const files: { path: string; status: string; from?: string }[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    const status = e.slice(0, 2).trim() || "M";
    // A rename's old path follows it (with -z): kept as `from`, so its removal goes too.
    if (status.startsWith("R")) files.push({ path: e.slice(3), status, from: parts[++i]! });
    else files.push({ path: e.slice(3), status });
  }
  // Review round 35: each proposal its own branch (a second one the same day isn't added to
  // the first's PR).
  const stamp = (o.now ?? new Date()).toISOString();
  const day = `${stamp.slice(0, 10)}-${stamp.slice(11, 19).replace(/:/g, "")}`;
  const who = (o.by ?? "someone")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return {
    scope,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    branch: `propose/${scope}/${day}-${who || "someone"}`,
    title: TITLES[scope],
  };
}

/** Commits, pushes and opens the PR for exactly the files the person saw. */
export async function proposeForReview(
  root: string,
  o: {
    scope: ProposeScope;
    by: string;
    files: string[];
    title?: string;
    /** The branch the person was shown (GET's plan); a new one is made when it isn't one of ours. */
    branch?: string;
    git?: GitRunner;
    gitHost?: GitHost;
    publisher?: HandoffPublisher;
    now?: Date;
  },
  io: Output,
): Promise<number> {
  const plan = await proposePlan(root, o.scope, {
    ...(o.git ? { git: o.git } : {}),
    ...(o.now ? { now: o.now } : {}),
    by: o.by,
  });
  if (o.branch && new RegExp(`^propose/${o.scope}/[0-9a-z-]+$`).test(o.branch))
    plan.branch = o.branch;
  const seen = new Map(plan.files.map((f) => [f.path, f] as const));
  const picked = o.files.filter((f) => seen.has(f));
  const files = [
    ...new Set(picked.flatMap((f) => [f, ...(seen.get(f)!.from ? [seen.get(f)!.from!] : [])])),
  ];
  if (!picked.length) {
    io.err("Nothing to propose: none of those files has a change now. Look at the list again.");
    return 2;
  }
  const op = await loadOrgPack(orgPackDirOf(root));
  const gitHost =
    o.gitHost ??
    createAdapters(op.runtime, {}, { store: fileStepStore(root), root, procedures: op.procedures })
      .gitHost;
  if (!gitHost) {
    io.err("No Git host is configured. Set adapters.gitHost in org-pack/runtime.yaml.");
    return 1;
  }
  const repo = op.runtime.adapters.gitHost?.settings.metarepo;
  if (typeof repo !== "string") {
    io.err(
      "Say which repo on the Git host is the metarepo: set metarepo under adapters.gitHost.settings in runtime.yaml.",
    );
    return 1;
  }
  const at = (o.now ?? new Date()).toISOString();
  const approval = { by: o.by, at, ref: plan.branch };
  const base = (await gitHost.getRepo(repo)).defaultBranch;
  const title = o.title?.trim() || plan.title;
  const publisher = o.publisher ?? gitHandoffPublisher();
  try {
    await publisher.publish({ root, branch: plan.branch, base, files, message: title, approval });
    io.out(`Pushed ${files.length} file${files.length === 1 ? "" : "s"} to ${plan.branch}.`);
  } catch (e) {
    io.out(
      `The branch ${plan.branch} wasn't pushed (${(e as Error).message.split("\n")[0]}): push it yourself before the PR is opened.`,
    );
  }
  // A host's refusal (an open PR from this branch, a branch it can't see) is said, with what was
  // already done, never a 500 (review round 35).
  let pr: { number: number; url: string };
  try {
    pr = await gitHost.createPullRequest(
      {
        repo,
        head: plan.branch,
        base,
        title,
        body: [
          `${title}, proposed from the Atticus app by ${o.by}.`,
          "",
          "Files:",
          ...files.map((f) => `- ${f}`),
          "",
          "A person reviews and merges this PR; Atticus never merges.",
        ].join("\n"),
      },
      approval,
    );
  } catch (e) {
    io.err(`The PR wasn't opened: ${(e as Error).message.split("\n")[0]}`);
    return 1;
  }
  io.out(`PR #${pr.number} is open for review: ${pr.url}`);
  io.out("When it merges, Bring in what merged updates your copy of the metarepo.");
  return 0;
}

/**
 * Review round 35: after a proposal (or a hand-off) merges, the person's copy still has the same
 * edits uncommitted, so `git pull` refuses. Each changed file whose content is already what the
 * upstream branch has is put back (tracked) or set aside (new), then the branch fast-forwards.
 * Files with edits the upstream doesn't have are left as they are and named.
 */
export async function bringInMerged(
  root: string,
  io: Output,
  o: { git?: GitRunner } = {},
): Promise<number> {
  const git = o.git ?? createGit();
  const run = async (args: string[]) => (await git(args, root)).stdout;
  const up = (
    await run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => "")
  ).trim();
  if (!up) {
    io.err("This branch follows no remote branch, so there is nothing to bring in.");
    return 2;
  }
  const remote = up.split("/")[0]!;
  await run(["fetch", "--quiet", remote]);
  const status = await run([
    "-c",
    "core.quotePath=false",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const parts = status.split("\0");
  const kept: string[] = [];
  let tidied = 0;
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    const st = e.slice(0, 2);
    const path = e.slice(3);
    if (st.startsWith("R")) {
      i++;
      kept.push(path);
      continue;
    }
    const theirs = (
      await run(["rev-parse", "--verify", "--quiet", `${up}:${path}`]).catch(() => "")
    ).trim();
    const mine = existsSync(join(root, path))
      ? (await run(["hash-object", "--", path]).catch(() => "")).trim()
      : "";
    if (!theirs || theirs !== mine) {
      kept.push(path);
      continue;
    }
    if (st === "??") await rm(join(root, path), { force: true });
    else await run(["checkout", "HEAD", "--", path]);
    tidied++;
  }
  try {
    await run(["merge", "--ff-only", "--quiet", up]);
  } catch (e) {
    io.err(
      `Your copy couldn't be brought up to ${up}: ${(e as Error).message.split("\n")[0]}${kept.length ? `. Your own edits stay: ${kept.join(", ")}` : ""}`,
    );
    return 1;
  }
  io.out(
    `Brought in what merged on ${up}${tidied ? ` (${tidied} file${tidied === 1 ? "" : "s"} were already the same)` : ""}.`,
  );
  if (kept.length) io.out(`Your own edits stay as they were: ${kept.join(", ")}.`);
  return 0;
}
