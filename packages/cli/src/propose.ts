import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  catalogDirOf,
  changesRelOf,
  decisionsRelOf,
  factsDirOf,
  mapDirOf,
  specsDirOf,
  stateDirOf,
  loadOrgPack,
  orgPackDirOf,
  questionsDirOf,
  type ManualStep,
} from "@maycombhq/core";
import type { Output } from "./commands.js";
import { createAdapters, fileStepStore, type GitHost } from "@maycombhq/adapters";
import { gitHandoffPublisher, mergeChangeText, type HandoffPublisher } from "@maycombhq/changes";
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
  "owner-answers",
  "baseline",
  "initiatives",
  "outcomes",
  "work",
  "service-desk",
  "upgrade",
] as const;
export type ProposeScope = (typeof PROPOSE_SCOPES)[number];

const TITLES: Record<ProposeScope, string> = {
  answers: "Answers to the map's questions",
  corrections: "Corrections to the map",
  audit: "A sample audit's answers",
  "org-pack": "Org pack and settings",
  "owner-answers": "Owners' answers to the knowledge gaps",
  baseline: "Accept the catalog as the baseline",
  initiatives: "Initiatives and commitments",
  outcomes: "Outcomes measured after release",
  work: "Changes made in the Atticus app",
  "service-desk": "Service-desk request fields",
  upgrade: "Upgrade this metarepo",
};

const rel = (root: string, dir: string) => relative(root, dir).split("\\").join("/");

/** The folders a kind of work owns, relative to the metarepo (git pathspecs). */
export function scopeDirs(root: string, scope: ProposeScope): string[] {
  const facts = rel(root, factsDirOf(root));
  const catalog = rel(root, catalogDirOf(root));
  const map = rel(root, mapDirOf(root));
  const specs = rel(root, specsDirOf(root));
  // Ninth UX walk: a batch of decisions' record (ADR 0181), which Undo reads, goes with the
  // answers and corrections it names, or another clone can't undo the batch.
  const decisions = decisionsRelOf(root);
  switch (scope) {
    // Round 36: the fields filled in the app are each open change's snow.md, nothing else of
    // the change (its other files are its stages' and its hand-off's).
    case "service-desk":
      return [`:(glob)${changesRelOf(root)}/*/snow.md`];
    // An answer also writes in the org pack (a repo type's skill file, a host in the manifest,
    // an outside system in a profile): its PR carries those too (review round 35).
    // UX re-walk: Apply (verify --write) also writes the repo's map and specs: they go too.
    case "answers":
      return [
        rel(root, questionsDirOf(root)),
        facts,
        catalog,
        rel(root, orgPackDirOf(root)),
        map,
        specs,
        decisions,
      ];
    case "corrections":
      return [facts, catalog, map, specs, decisions];
    // An audit is its repo's audit file, not every repo's facts.
    case "audit":
      return [`${facts}/*.audit.yaml`];
    // Everything the app's work writes, for the one Propose on Home (UX re-walk).
    case "work":
      return [
        rel(root, questionsDirOf(root)),
        facts,
        catalog,
        rel(root, orgPackDirOf(root)),
        map,
        specs,
        decisions,
        rel(root, initiativesDirOf(root)),
        `${changesRelOf(root)}/*/review/outcomes.yaml`,
        `${changesRelOf(root)}/*/snow.md`,
        // Ninth UX walk: a person's corrections of a stage's drafts, and who drafted each file
        // (ADR 0181), saved in the app; they ride the stage's hand-off too.
        `${changesRelOf(root)}/*/stage/corrections.yaml`,
        `${changesRelOf(root)}/*/stage/drafted.yaml`,
        // ADR 0188: what a person drew on a change's diagram (its target flows), proposed from
        // the Change diagram; it rides the stage's hand-off too.
        `${changesRelOf(root)}/*/target-flows`,
        // ADR 0188: the knowledge a person confirmed or excluded on Change › Knowledge.
        `${changesRelOf(root)}/*/knowledge.yaml`,
      ];
    case "org-pack":
      return [rel(root, orgPackDirOf(root))];
    // UX review (2026-11-08): an owner's answer to a knowledge gap is a curated record.
    case "owner-answers":
      return [`${catalog}/curated/ownerquestion`];
    // Accepting the baseline writes catalog/baseline.yaml, over the catalog it accepts.
    case "baseline":
      return [catalog];
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
    // Beta.27 review: what `atticus upgrade` changed (the org pack's files, the facts and the
    // catalog a step brings up to date) and its stamp, for the upgrade panel's Propose.
    case "upgrade":
      return [...scopeDirs(root, "work"), ".atticus/metarepo.yaml"];
  }
}

export interface ProposePlan {
  scope: ProposeScope;
  /** A rename's old path is `from`: proposing the new one records the old one's removal. */
  files: { path: string; status: string; from?: string; proposed?: string }[];
  branch: string;
  title: string;
}

/**
 * Round 37: what was pushed, by path and content, so a file already in an open proposal shows
 * as that (`proposed`: its PR or branch) and isn't offered again. Kept on this machine only.
 */
// Round 38: in .index, which Git ignores (a normal metarepo's state folder is its root).
const proposedFile = (root: string) => join(stateDirOf(root), ".index", "proposed.json");
type Proposed = Record<string, { blob: string; where: string; branch?: string }>;
async function readProposed(root: string): Promise<Proposed> {
  try {
    return JSON.parse(await readFile(proposedFile(root), "utf8")) as Proposed;
  } catch {
    return {};
  }
}

/** A shared lock's file, or one moved aside as stale (core's withSharedFileLock). */
const LOCK_FILE = /\.lock(\.[^/]+\.stale)?$/;

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
  const files: { path: string; status: string; from?: string; proposed?: string }[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    const status = e.slice(0, 2).trim() || "M";
    // A rename's old path follows it (with -z): kept as `from`, so its removal goes too.
    if (status.startsWith("R")) files.push({ path: e.slice(3), status, from: parts[++i]! });
    // Review of beta.23: a write's lock left by a crash (`<file>.lock`, `<file>.lock.<id>.stale`)
    // is this machine's, never a file to propose.
    else if (!LOCK_FILE.test(e.slice(3))) files.push({ path: e.slice(3), status });
  }
  const was = await readProposed(root);
  // beta.23: one git call per proposal branch and one for every file's content, not two per
  // file (Home asks this on every load; after proposing a few hundred answers it started a
  // thousand git processes, seconds each on Windows).
  const asked = files.filter((f) => was[f.path]);
  const branches = [...new Set(asked.map((f) => was[f.path]!.branch).filter((b) => !!b))];
  const live = new Set<string>();
  await Promise.all(
    branches.map((b) =>
      git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b!}`], root).then(
        () => live.add(b!),
        () => undefined,
      ),
    ),
  );
  // A branch the remote no longer has (merged and deleted, or closed: Bring in prunes) is no
  // proposal any more.
  const still = asked.filter((f) => {
    const b = was[f.path]!.branch;
    return !b || live.has(b);
  });
  const there = still.filter((f) => existsSync(join(root, f.path)));
  const blobs = new Map<string, string>();
  // In slices, so a command line stays well under Windows' limit.
  for (let i = 0; i < there.length; i += 200) {
    const part = there.slice(i, i + 200);
    const out = await git(["hash-object", "--", ...part.map((f) => f.path)], root).then(
      (r) => r.stdout.split(/\r?\n/).map((l) => l.trim()),
      () => [] as string[],
    );
    part.forEach((f, j) => blobs.set(f.path, out[j] ?? ""));
  }
  for (const f of still) {
    const p = was[f.path]!;
    if ((blobs.get(f.path) ?? "") === p.blob) f.proposed = p.where;
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
    // Review of beta.23: a branch the Git host doesn't have can't be reviewed: no PR is opened
    // (on a manual host no step is recorded to open one), nothing is marked proposed, and the
    // job fails with the reason, so the person fixes it and proposes again.
    io.err(
      `The branch ${plan.branch} wasn't pushed (${(e as Error).message.split("\n")[0]}), so nothing was proposed: fix that (your access to the Git host, say), then propose for review again.`,
    );
    return 1;
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
  // Round 37: remember what went, as its content, so it isn't offered again until it changes.
  try {
    const was = await readProposed(root);
    const where = pr.url.startsWith("manual:") ? plan.branch : pr.url;
    const g2 = o.git ?? createGit();
    for (const f of files) {
      const blob = existsSync(join(root, f))
        ? (await g2(["hash-object", "--", f], root)).stdout.trim()
        : "";
      was[f] = { blob, where, branch: plan.branch };
    }
    await mkdir(dirname(proposedFile(root)), { recursive: true });
    await writeFile(proposedFile(root), JSON.stringify(was, null, 2) + "\n", "utf8");
  } catch {
    // Only a hint for the next list: the PR is open either way.
  }
  // A manual Git host records a step: the person opens the PR and records its link (ADR 0032).
  io.out(
    pr.url.startsWith("manual:")
      ? `The PR is a step for you on Home: open it on the Git host from ${plan.branch} and record its link.`
      : `PR #${pr.number} is open for review: ${pr.url}`,
  );
  io.out("When it merges, Bring in what merged updates your copy of the metarepo.");
  return 0;
}

/**
 * Review rounds 35-36: after a proposal (or a hand-off) merges, the person's copy still has the
 * same edits uncommitted, so `git pull` refuses. Everything is decided before anything is
 * touched: a branch with its own commits, or an edit of the person's that the incoming commits
 * also change, refuses with nothing done. Then each changed file whose content is already what
 * the upstream branch has is put back (or, new, set aside), and the branch fast-forwards. If the
 * fast-forward still fails, every file put back gets the upstream's content again.
 */
/** The remote branch this branch could follow: the same name on origin (or the only remote). */
async function upstreamOffer(
  run: (args: string[]) => Promise<string>,
): Promise<{ branch: string; upstream: string } | undefined> {
  const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
  if (!branch || branch === "HEAD") return undefined;
  const remotes = (await run(["remote"]).catch(() => ""))
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const remote = remotes.includes("origin")
    ? "origin"
    : remotes.length === 1
      ? remotes[0]
      : undefined;
  if (!remote) return undefined;
  const there = (
    await run(["ls-remote", "--heads", remote, `refs/heads/${branch}`]).catch(() => "")
  ).trim();
  return there ? { branch, upstream: `${remote}/${branch}` } : undefined;
}

/**
 * App-only audit: Set the upstream. The branch checked out follows `<remote>/<branch>`, the same
 * name on a remote this copy has (fetched first): a local setting of this copy, nothing is sent.
 * Refused for any other branch or remote.
 */
export async function setUpstream(
  root: string,
  upstream: string,
  io: Output,
  o: { git?: GitRunner } = {},
): Promise<number> {
  const git = o.git ?? createGit();
  const run = async (args: string[]) => (await git(args, root)).stdout;
  const offer = await upstreamOffer(run);
  if (!offer || offer.upstream !== upstream) {
    const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
    io.err(
      offer
        ? `Only ${offer.upstream} can be ${offer.branch}'s upstream here (the same branch on the remote); ${upstream} isn't.`
        : `Only ${branch || "this branch"}'s own branch on a remote can be its upstream, and no remote here has it.`,
    );
    return 1;
  }
  const [remote] = upstream.split("/");
  try {
    await run([
      "fetch",
      "--quiet",
      remote!,
      `+refs/heads/${offer.branch}:refs/remotes/${upstream}`,
    ]);
    await run(["branch", "--quiet", `--set-upstream-to=${upstream}`, offer.branch]);
  } catch (e) {
    io.err(`The upstream wasn't set: ${(e as Error).message.split("\n")[0]}`);
    return 1;
  }
  io.out(`${offer.branch} follows ${upstream} now. Bring in what merged brings in its changes.`);
  return 0;
}

export async function bringInMerged(
  root: string,
  io: Output,
  o: { git?: GitRunner; now?: Date } = {},
): Promise<number> {
  const git = o.git ?? createGit();
  const run = async (args: string[]) => (await git(args, root)).stdout;
  const first = (e: unknown) => (e as Error).message.split("\n")[0];
  const up = (
    await run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => "")
  ).trim();
  if (!up) {
    // App-only audit: when the remote has this branch, say so and how to follow it.
    const fix = await upstreamOffer(run);
    io.err(
      fix
        ? `This branch ${fix.branch} follows no remote branch, and ${fix.upstream} is there: Set the upstream to ${fix.upstream}, then Bring in what merged again.`
        : "This branch follows no remote branch, so there is nothing to bring in.",
    );
    return 2;
  }
  try {
    // --prune: a proposal's branch deleted after its merge stops being marked as proposed.
    await run(["fetch", "--quiet", "--prune", up.split("/")[0]!]);
  } catch (e) {
    io.err(`The remote couldn't be reached, so nothing was changed: ${first(e)}`);
    return 1;
  }
  const ancestor = await run(["merge-base", "--is-ancestor", "HEAD", up]).then(
    () => true,
    () => false,
  );
  if (!ancestor) {
    io.err(
      `Your branch has commits ${up} doesn't, so nothing was changed. Push them in a pull request, or ask someone who uses git to bring the two together.`,
    );
    return 1;
  }
  const incoming = new Set(
    (await run(["-c", "core.quotePath=false", "diff", "--name-only", "-z", "HEAD", up]))
      .split("\0")
      .filter(Boolean),
  );
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
  const tidy: { path: string; inHead: boolean; staged: boolean }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    const st = e.slice(0, 2);
    const path = e.slice(3);
    if (st.startsWith("R")) {
      kept.push(path, parts[++i]!);
      continue;
    }
    const theirs = (
      await run(["rev-parse", "--verify", "--quiet", `${up}:${path}`]).catch(() => "")
    ).trim();
    const mine = existsSync(join(root, path))
      ? (await run(["hash-object", "--", path]).catch(() => "")).trim()
      : "";
    // UX re-walk: a file deleted here and in what merged is the same edit (an answer that joins a
    // call removes its Unresolved record): put back here, so the fast-forward removes it.
    const bothGone = !theirs && !mine && st.includes("D");
    if (!bothGone && (!theirs || theirs !== mine)) {
      kept.push(path);
      continue;
    }
    const inHead = await run(["cat-file", "-e", `HEAD:${path}`]).then(
      () => true,
      () => false,
    );
    tidy.push({ path, inHead, staged: st[0] !== " " && st[0] !== "?" });
  }
  // Fifth UX walk: a change's change.yaml is Atticus's own record (Sync writes the gate's newer
  // state into it after the hand-off merged): it is set aside, the merge goes ahead, and the
  // newer local record is written back over the merged one.
  const own = new RegExp(
    `^${changesRelOf(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^/]+/change\\.yaml$`,
  );
  // Round 41: a record deleted here is no edit to merge: it is a clash like any other file.
  const ownClash = kept.filter((k) => incoming.has(k) && own.test(k) && existsSync(join(root, k)));
  const clash = kept.filter((k) => incoming.has(k) && !ownClash.includes(k));
  if (clash.length) {
    io.err(
      `What merged also changes files you edited, so nothing was changed: ${clash.join(", ")}. Propose your edits for review, or ask someone who uses git to bring them together.`,
    );
    return 1;
  }
  const done: string[] = [];
  const putBack = async () => {
    for (const p of done)
      await run(["checkout", up, "--", p])
        .then(() => run(["reset", "-q", "--", p]))
        .catch(() => undefined);
  };
  // Round 40: the change's record is merged three ways (what this copy had at HEAD, Sync's
  // newer state here, and what merged), so a reviewer's edit on the hand-off branch is kept too.
  // A change both sides made to the same lines is refused, with nothing done.
  const held = new Map<string, string>();
  /** Round 41: the person's own text of each record, put back if the copy can't be brought up. */
  const original = new Map<string, string>();
  const tmp = await mkdtemp(join(tmpdir(), "atticus-bring-in-"));
  try {
    for (const k of ownClash) {
      const at = async (rev: string) =>
        (await run(["show", `${rev}:${k}`]).catch(() => "")) as string;
      const base = join(tmp, "base");
      const ours = join(tmp, "ours");
      const theirs = join(tmp, "theirs");
      // The base is what this copy last had of it: HEAD's, or (a change made here and first pushed
      // by its hand-off) the hand-off branch's, here or as the remote keeps it. Round 41: never
      // what merged, which would drop a reviewer's edit; with no base, only the same text merges.
      const inHead = await run(["cat-file", "-e", `HEAD:${k}`]).then(
        () => true,
        () => false,
      );
      const id = k.split("/").at(-2)!;
      const newest = async (prefix: string) =>
        (
          await run([
            "for-each-ref",
            "--sort=-committerdate",
            "--count=1",
            "--format=%(refname)",
            prefix,
          ]).catch(() => "")
        ).trim() || undefined;
      // Final review (git and tasks): the local hand-off ref is what this copy published. The
      // remote's branch can carry a reviewer's commits on top, so its tip is never the base: only
      // its first commit after it left this copy's HEAD (Atticus's published commit), or none.
      const publishedOnRemote = async (ref: string) => {
        const fork = (await run(["merge-base", "HEAD", ref]).catch(() => "")).trim();
        if (!fork) return undefined;
        const after = (
          await run(["rev-list", "--first-parent", "--reverse", `${fork}..${ref}`]).catch(() => "")
        ).trim();
        return after.split("\n")[0] || undefined;
      };
      let handoff: string | undefined;
      if (!inHead) {
        handoff = await newest(`refs/heads/handoff/${id}/`);
        if (!handoff) {
          const remote = await newest(`refs/remotes/origin/handoff/${id}/`);
          if (remote) handoff = await publishedOnRemote(remote);
        }
      }
      const baseText = inHead ? await at("HEAD") : handoff ? await at(handoff) : "";
      const mine = await readFile(join(root, k), "utf8");
      original.set(k, mine);
      const theirsText = await at(up);
      // Ninth UX walk: the record is merged by its fields (Sync's state and hand-off entries
      // here, the hand-off branch's copy upstream), refused only when both sides changed the same
      // field differently. A file that isn't a record Atticus can read is merged as text.
      const fields = mergeChangeText(baseText, mine, theirsText);
      if (fields && !fields.ok) {
        io.err(
          `What merged also changes ${fields.field} in ${k} where your copy changed it differently, so nothing was changed. Propose your edits for review, or ask someone who uses git to bring them together.`,
        );
        return 1;
      }
      if (fields) {
        held.set(k, fields.text);
        continue;
      }
      await writeFile(base, baseText, "utf8");
      await writeFile(ours, mine, "utf8");
      await writeFile(theirs, theirsText, "utf8");
      const merged = await git(["merge-file", "-p", ours, base, theirs], root).then(
        (r) => ({ ok: true, text: r.stdout }),
        () => ({ ok: false, text: "" }),
      );
      if (!merged.ok) {
        io.err(
          `What merged also changes ${k} where your copy changed it, so nothing was changed. Propose your edits for review, or ask someone who uses git to bring them together.`,
        );
        return 1;
      }
      held.set(k, merged.text);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  // Sixth UX walk: what this copy keeps of its own, in short. A change's record that was merged
  // is said as such, not as an edit left out, and a long list names a few and counts the rest.
  const ownEdits = kept.filter((k) => !held.has(k));
  const editsText = (list: string[]) =>
    list.length > 5
      ? `${list.slice(0, 5).join(", ")} and ${list.length - 5} more`
      : list.join(", ");
  const restoreHeld = async () => {
    for (const [k, text] of held) await writeFile(join(root, k), text, "utf8");
  };
  try {
    for (const k of ownClash) {
      const inHead = await run(["cat-file", "-e", `HEAD:${k}`]).then(
        () => true,
        () => false,
      );
      if (inHead) await run(["checkout", "HEAD", "--", k]);
      else {
        // Round 41: a new record the person staged is unstaged too, or the fast-forward refuses.
        await run(["rm", "--cached", "--quiet", "--ignore-unmatch", "--", k]);
        await rm(join(root, k), { force: true });
      }
    }
    for (const t of tidy) {
      if (t.inHead) await run(["checkout", "HEAD", "--", t.path]);
      else {
        if (t.staged) await run(["rm", "--cached", "--quiet", "--", t.path]);
        await rm(join(root, t.path), { force: true });
      }
      done.push(t.path);
    }
    await run(["merge", "--ff-only", "--quiet", up]);
    await restoreHeld();
  } catch (e) {
    await putBack();
    for (const [k, text] of original) await writeFile(join(root, k), text, "utf8");
    io.err(
      `Your copy couldn't be brought up to ${up}: ${first(e)}. Your files are as they were${kept.length ? `, and your own edits stay: ${editsText(kept)}` : ""}.`,
    );
    return 1;
  }
  const closed = await closeMergedSteps(root, up, run, o.now);
  const sayClosed = () => {
    if (closed.length)
      io.out(
        `Closed the manual steps of ${closed.length === 1 ? "a pull request" : `${closed.length} pull requests`} that merged (merged, seen by Bring in): ${closed.join(", ")}.`,
      );
  };
  if (!incoming.size && !done.length) {
    io.out(`Nothing new has merged on ${up} yet: your copy is up to date with it.`);
    if (kept.length) io.out(`Your own edits stay as they were: ${editsText(kept)}.`);
    sayClosed();
    return 0;
  }
  io.out(
    `Brought in what merged on ${up}${done.length ? ` (${done.length === 1 ? "1 file was" : `${done.length} files were`} already the same)` : ""}.`,
  );
  if (held.size)
    io.out(
      `Merged with your copy's newer state: ${[...held.keys()].join(", ")} (Sync's state and the reviewer's edits are both kept).`,
    );
  if (ownEdits.length) io.out(`Your own edits stay as they were: ${editsText(ownEdits)}.`);
  sayClosed();
  return 0;
}

/**
 * Ninth UX walk: on a manual Git host, the steps of a pull request into the metarepo (a hand-off's
 * or a proposal's) stayed open after Bring in had brought its merge in. A PR whose branch tip is
 * now in the upstream branch, merged in (not on its first-parent line, where a branch with no
 * commits of its own would be), has merged: its open steps are closed with the note "merged, seen
 * by Bring in", so Sync reads the PR as merged. Who approved, which only a person can say, is
 * left out; the PR keeps the number and link Atticus gave it. Returns the PRs' branches.
 */
async function closeMergedSteps(
  root: string,
  up: string,
  run: (args: string[]) => Promise<string>,
  now?: Date,
): Promise<string[]> {
  let repo: unknown;
  try {
    repo = (await loadOrgPack(orgPackDirOf(root))).runtime.adapters.gitHost?.settings.metarepo;
  } catch {
    return [];
  }
  if (typeof repo !== "string") return [];
  const store = fileStepStore(root);
  const steps = await store.list({ system: "git-host" }).catch(() => [] as ManualStep[]);
  const opens = steps.filter(
    (s) =>
      s.action === "open-pull-request" &&
      s.state !== "skipped" &&
      s.inputs.repo === repo &&
      typeof s.inputs.head === "string",
  );
  if (!opens.length) return [];
  const mainLine = new Set(
    (await run(["rev-list", "--first-parent", up]).catch(() => "")).split("\n").filter(Boolean),
  );
  const remote = up.split("/")[0]!;
  const at = (now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  type Values = NonNullable<ManualStep["recorded"]>["values"];
  const close = (s: ManualStep, values: Values) =>
    store.save({
      ...s,
      state: "done",
      recorded: {
        at,
        by: "atticus",
        values,
        via: "person",
        evidence: [],
        note: "merged, seen by Bring in",
      },
    });
  const out: string[] = [];
  for (const open of opens) {
    const number = open.inputs.number;
    const related = steps.filter(
      (s) =>
        s.state === "open" &&
        s.inputs.repo === repo &&
        s.inputs.number === number &&
        (s.action === "report-pull-request" || s.action === "merge-pull-request"),
    );
    if (open.state !== "open" && !related.length) continue;
    const head = String(open.inputs.head);
    let tip = "";
    for (const ref of [`refs/remotes/${remote}/${head}`, `refs/heads/${head}`]) {
      tip = (
        await run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "")
      ).trim();
      if (tip) break;
    }
    if (!tip || mainLine.has(tip)) continue;
    const merged = await run(["merge-base", "--is-ancestor", tip, up]).then(
      () => true,
      () => false,
    );
    if (!merged) continue;
    if (open.state === "open")
      await close(open, {
        number: Number(number),
        url: `manual://git-host/${repo}/pull/${String(number)}`,
      });
    // The host merged it, so its rules (required checks among them) let it.
    for (const s of related)
      await close(
        s,
        s.action === "report-pull-request" ? { merged: true, checksPassing: true } : {},
      );
    out.push(head);
  }
  return out;
}
