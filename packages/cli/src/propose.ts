import { relative } from "node:path";
import {
  catalogDirOf,
  factsDirOf,
  loadOrgPack,
  orgPackDirOf,
  questionsDirOf,
} from "@maycombhq/core";
import type { Output } from "./commands.js";
import { createAdapters, fileStepStore, type GitHost } from "@maycombhq/adapters";
import { gitHandoffPublisher, type HandoffPublisher } from "@maycombhq/changes";
import { createGit, type GitRunner } from "@maycombhq/workspace";

/**
 * ADR 0183: Propose for review. The metarepo files a kind of work changed, committed onto a
 * branch (without touching the person's working tree, index or checked-out branch), pushed, and
 * opened as a PR, after the person's yes. A human approves and merges on the Git host.
 */
export const PROPOSE_SCOPES = ["answers", "corrections", "audit", "org-pack"] as const;
export type ProposeScope = (typeof PROPOSE_SCOPES)[number];

const TITLES: Record<ProposeScope, string> = {
  answers: "Answers to the map's questions",
  corrections: "Corrections to the map",
  audit: "A sample audit's answers",
  "org-pack": "Org pack and settings",
};

const rel = (root: string, dir: string) => relative(root, dir).split("\\").join("/");

/** The folders a kind of work owns, relative to the metarepo. */
export function scopeDirs(root: string, scope: ProposeScope): string[] {
  const facts = rel(root, factsDirOf(root));
  const catalog = rel(root, catalogDirOf(root));
  switch (scope) {
    case "answers":
      return [rel(root, questionsDirOf(root)), facts, catalog];
    case "corrections":
      return [facts, catalog];
    case "audit":
      return [facts];
    case "org-pack":
      return [rel(root, orgPackDirOf(root))];
  }
}

export interface ProposePlan {
  scope: ProposeScope;
  files: { path: string; status: string }[];
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
  const files: { path: string; status: string }[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    const status = e.slice(0, 2).trim() || "M";
    files.push({ path: e.slice(3), status });
    if (status.startsWith("R")) i++; // a rename's old path follows; the new one is kept
  }
  const day = (o.now ?? new Date()).toISOString().slice(0, 10);
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
  const seen = new Set(plan.files.map((f) => f.path));
  const files = o.files.filter((f) => seen.has(f));
  if (!files.length) {
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
  const pr = await gitHost.createPullRequest(
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
  io.out(`PR #${pr.number} is open for review: ${pr.url}`);
  return 0;
}
