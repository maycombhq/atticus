import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AdapterError,
  mergeBlockers,
  requireApproval,
  type Approval,
  type GitHost,
} from "@maycombhq/adapters";
import {
  changesRelOf,
  handoffBranch,
  type ChangeHandoff,
  type ChangeLifecycle,
  type LifecycleState,
} from "@maycombhq/core";
import type { OpenSpec } from "@maycombhq/openspec-adapter";
import { evaluateApprovals, holders } from "./approvals.js";
import { assess, liveHandoff, type Assessment } from "./assess.js";
import { ownersFor } from "./codeowners.js";
import { loadChangeContext, type ChangeContext } from "./context.js";
import { ChangeError, type Reason } from "./errors.js";
import {
  artifactFiles,
  handoffName,
  phaseArtifacts,
  phaseGates,
  phaseState,
  sha256,
} from "./lifecycle.js";
import type { HandoffPublisher } from "./publish.js";
import { changeFolder, changeStore } from "./store.js";
import type { Artifact, PhaseId } from "./types.js";

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const strip = (h: string) => (h.startsWith("@") ? h.slice(1) : h);

interface HostOptions {
  gitHost: GitHost;
  /** The metarepo on the Git host; defaults to runtime.yaml gitHost settings `metarepo`. */
  repo?: string;
  now?: string;
}

function metarepo(ctx: ChangeContext, repo?: string): string {
  const fromRuntime = ctx.orgPack.runtime.adapters.gitHost?.settings.metarepo;
  const r = repo ?? (typeof fromRuntime === "string" ? fromRuntime : undefined);
  if (!r)
    throw new ChangeError(
      "invalid",
      "Say which repo on the Git host is the metarepo: pass --repo, or set metarepo under adapters.gitHost.settings in runtime.yaml.",
    );
  return r;
}

async function load(root: string, id: string) {
  const ctx = await loadChangeContext(root);
  const change = await changeStore(root)
    .read(id)
    .catch((e: Error) => {
      throw new ChangeError("not-found", e.message);
    });
  return { ctx, change };
}

async function walkReview(dir: string, gate: string): Promise<string[]> {
  const out: string[] = [];
  const base = join(dir, "review", gate);
  let rounds: string[];
  try {
    rounds = (await readdir(base))
      .filter((r) => /^\d+$/.test(r))
      .sort((a, b) => Number(a) - Number(b));
  } catch {
    return [];
  }
  for (const r of rounds) {
    try {
      for (const f of (await readdir(join(base, r))).filter((x) => /\.ya?ml$/.test(x)).sort())
        out.push(`review/${gate}/${r}/${f}`);
    } catch {
      // not a folder
    }
  }
  return out;
}

/**
 * The files a phase's hand-off PR carries, relative to the change folder: the phase's
 * artifacts that exist (brief.md with the first phase), tasks.md and repos.yaml with
 * Build, and the gate's review files. change.yaml always rides along but isn't listed.
 */
async function handoffFiles(
  ctx: ChangeContext,
  a: Assessment,
  phase: PhaseId,
): Promise<{ files: string[]; artifacts: Artifact[] }> {
  const dir = changeFolder(ctx.root, a.change.id);
  const artifacts: Artifact[] = [];
  const files = new Set<string>();
  for (const art of phaseArtifacts(ctx, a.type, phase)) {
    const f = await artifactFiles(dir, art);
    if (f.length === 0) continue;
    artifacts.push(art);
    for (const x of f) files.add(x);
  }
  if (phase === "build") {
    for (const extra of ["tasks.md", "repos.yaml"]) {
      try {
        await readFile(join(dir, extra));
        files.add(extra);
      } catch {
        // not there
      }
    }
  }
  for (const gate of phaseGates(ctx, phase))
    for (const f of await walkReview(dir, gate)) files.add(f);
  return { files: [...files].sort(), artifacts };
}

function prBody(
  a: Assessment,
  phase: PhaseId,
  next: LifecycleState,
  /** The hand-off's files, relative to the metarepo root. */
  paths: string[],
  reviewers: string[],
): string {
  const c = a.change;
  const lines = [
    `## Hand-off: ${handoffName(a.type, phase)}`,
    "",
    `Change ${c.id} (${c.title}), type ${c.type}, moves from ${phase} to ${next} when this pull request merges.`,
    "",
    "Approving this pull request approves the hand-off. Atticus merges it once the required approvals are in.",
    "",
    "### Files",
    "",
    ...(paths.length ? paths.map((f) => `- ${f}`) : ["- None"]),
    "",
    "### Required approvals",
    "",
    ...(a.required.length
      ? a.required.map((r) => `- ${r.label}`)
      : ["- None beyond the Git host's own rules"]),
    "",
    "### Reviewers",
    "",
    ...(reviewers.length ? reviewers.map((r) => `- @${r}`) : ["- None"]),
    "",
    "### Risk",
    "",
    `${a.risk.level} (${a.risk.score})`,
    "",
    ...a.risk.factors.map((f) => `- ${f.detail}: +${f.points}`),
    "",
    "### Privacy",
    "",
    a.privacy.touched
      ? `Touches personal data (${a.privacy.records.map((r) => r.id).join(", ")}); ${a.privacy.role} approves at ${a.privacy.phase}.`
      : "No personal data touched.",
  ];
  return lines.join("\n") + "\n";
}

export interface HandoffOptions extends HostOptions {
  /** Who raises the hand-off. Recorded as the author of the phase's artifacts unless `authors` says otherwise. */
  by: string;
  /** The person's approval for opening the PR (and pushing its branch). */
  approval: Approval;
  /** The branch the PR targets; defaults to the metarepo's default branch. */
  base?: string;
  authors?: Partial<Record<Artifact, string[]>>;
  /** Pushes the hand-off branch with the phase's files. Without one, the branch must already be there. */
  publisher?: HandoffPublisher;
}

/**
 * Raise a phase's hand-off: check the phase is ready (artifacts, findings, privacy role),
 * open the PR `handoff/<change-id>/<phase>` → main with the phase's files, name the
 * reviewers (CODEOWNERS of those files and holders of the required roles) and record it in
 * change.yaml. If the phase's PR is still open (changes were requested), the same PR is
 * updated instead. A returned change is resubmitted from its first phase.
 */
export async function handoff(
  root: string,
  id: string,
  opts: HandoffOptions,
): Promise<ChangeHandoff> {
  requireApproval("changes", opts.approval);
  const { ctx, change } = await load(root, id);
  const repo = metarepo(ctx, opts.repo);
  const now = opts.now ?? nowIso();
  const by = strip(opts.by);
  const a = await assess(ctx, change);
  const phase = a.phase;
  if (!phase)
    throw new ChangeError(
      "refused",
      `${id} is ${change.state}; there is nothing to hand off.`,
      a.reasons,
    );
  if (a.blockers.length > 0)
    throw new ChangeError(
      "refused",
      `${id} isn't ready for "${handoffName(a.type, phase)}".`,
      a.blockers,
    );

  const { files, artifacts } = await handoffFiles(ctx, a, phase);
  const dir = changeFolder(root, id);
  const hashed = await Promise.all(
    files.map(async (path) => ({ path, sha256: sha256(await readFile(join(dir, path))) })),
  );
  const authors = { ...change.authors };
  for (const art of artifacts) {
    const people = (opts.authors?.[art] ?? [by]).map(strip);
    authors[art] = [...new Set([...(authors[art] ?? []), ...people])];
  }
  const branch = handoffBranch(id, phase);
  const rel = changesRelOf(root);
  const metaFiles = [...files.map((f) => `${rel}/${id}/${f}`), `${rel}/${id}/change.yaml`];
  const reviewers = [
    ...new Set([
      ...files.flatMap((f) => ownersFor(ctx.codeowners, `${rel}/${id}/${f}`)),
      ...a.required.flatMap((r) => r.roles.flatMap((role) => holders(change, role))),
    ]),
  ]
    .filter((p) => p !== by)
    .sort();

  const live = change.state === "returned" ? undefined : liveHandoff(change);
  if (live && live.phase === phase) {
    const pr = await opts.gitHost.getPullRequest(repo, live.pr.number);
    if (pr.state === "open" || pr.state === "draft") {
      await opts.publisher?.publish({
        root,
        branch,
        base: pr.base,
        files: metaFiles,
        message: `${handoffName(a.type, phase)}: update`,
        approval: opts.approval,
      });
      await opts.gitHost.comment(
        repo,
        live.pr.number,
        `${by} updated the hand-off for another review.`,
        opts.approval,
      );
      const updated: ChangeHandoff = {
        ...live,
        state: "open",
        updatedAt: now,
        reviewers,
        artifacts: hashed,
        approvals: [],
      };
      await changeStore(root).write({
        ...change,
        authors,
        handoffs: change.handoffs.map((h) => (h === live ? updated : h)),
      });
      return updated;
    }
    if (pr.state === "merged")
      throw new ChangeError(
        "refused",
        `PR #${pr.number} is already merged on the Git host; sync the change instead.`,
      );
    // Closed on the host: record that and open a new PR.
    live.state = "closed";
    live.updatedAt = now;
  }

  const base = opts.base ?? (await opts.gitHost.getRepo(repo)).defaultBranch;
  const next = a.next!;
  await opts.publisher?.publish({
    root,
    branch,
    base,
    files: metaFiles,
    message: `${handoffName(a.type, phase)}: ${change.title}`,
    approval: opts.approval,
  });
  const pr = await opts.gitHost.createPullRequest(
    {
      repo,
      head: branch,
      base,
      title: `${change.title}: ${handoffName(a.type, phase)}`,
      body: prBody(
        a,
        phase,
        change.state === "returned" ? nextAfterResubmit(a, phase) : next,
        files.map((f) => `${rel}/${id}/${f}`),
        reviewers,
      ),
    },
    opts.approval,
  );
  const h: ChangeHandoff = {
    phase,
    branch,
    pr: { number: pr.number, url: pr.url },
    state: "open",
    by,
    openedAt: now,
    reviewers,
    approvals: [],
    artifacts: hashed,
  };
  const history = [...change.history];
  let state = change.state;
  if (change.state === "returned") {
    history.push({ from: "returned", to: phaseState(phase), at: now, by, reason: "Resubmitted" });
    state = phaseState(phase);
  }
  await changeStore(root).write({
    ...change,
    state,
    authors,
    history,
    handoffs: [...change.handoffs, h],
  });
  return h;
}

function nextAfterResubmit(a: Assessment, phase: PhaseId): LifecycleState {
  const next = a.type.phases[a.type.phases.indexOf(phase) + 1];
  return next ? phaseState(next) : "released";
}

export interface SyncOptions extends HostOptions {
  /** The approval for the auto-merge. Without it, a ready PR is reported, not merged. */
  approval?: Approval;
}

export interface SyncResult {
  merged: boolean;
  /** True when everything is in place and only the merge approval is missing. */
  ready: boolean;
  state: LifecycleState;
  handoff: ChangeHandoff;
  reasons: Reason[];
}

/**
 * Read the hand-off PR from the Git host and act on it: changes requested → it stays;
 * required roles approved (separation of duties applied) and the host's own rules met →
 * auto-merge, the state advances and history records it. A PR merged by hand on the host
 * advances the change too; a PR closed on the host is recorded as closed.
 */
export async function syncHandoff(
  root: string,
  id: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  const { ctx, change } = await load(root, id);
  const repo = metarepo(ctx, opts.repo);
  const now = opts.now ?? nowIso();
  const live = liveHandoff(change);
  if (!live)
    throw new ChangeError("refused", `${id} has no open hand-off PR to sync.`, [
      { code: "no-handoff", message: `${id} has no open hand-off PR.` },
    ]);
  const a = await assess(ctx, change);
  const pr = await opts.gitHost.getPullRequest(repo, live.pr.number);
  // The host knows the PR best: a link recorded since (manual:// until a person records it).
  const current: ChangeHandoff =
    pr.url !== live.pr.url || pr.number !== live.pr.number
      ? { ...live, pr: { number: pr.number, url: pr.url } }
      : live;
  const store = changeStore(root);
  const save = async (h: ChangeHandoff, extra: Partial<ChangeLifecycle> = {}) => {
    const updated = {
      ...change,
      ...extra,
      handoffs: change.handoffs.map((x) => (x === live ? h : x)),
    };
    await store.write(updated);
    return updated;
  };

  if (pr.state === "closed") {
    const h = { ...current, state: "closed" as const, updatedAt: now };
    await save(h);
    return {
      merged: false,
      ready: false,
      state: change.state,
      handoff: h,
      reasons: [{ code: "pr-closed", message: `PR #${pr.number} was closed on the Git host.` }],
    };
  }

  const latest = new Map<string, string>();
  for (const r of pr.reviews) if (r.state !== "commented") latest.set(strip(r.by), r.state);
  const approvers = [...latest].filter(([, s]) => s === "approved").map(([p]) => p);
  const requested = [...latest]
    .filter(([, s]) => s === "changes-requested")
    .map(([p]) => p)
    .sort();
  const result = evaluateApprovals({
    ctx,
    change,
    type: a.type,
    phase: live.phase,
    requirements: a.required,
    approvers,
    raiser: live.by,
  });
  const approvals = result.counted.map((c) => ({ ...c, at: now }));

  const advance = async (by: string) => {
    const h: ChangeHandoff = { ...current, state: "merged", updatedAt: now, approvals };
    const next = a.next!;
    const history = [
      ...change.history,
      {
        from: change.state,
        to: next,
        at: now,
        by,
        pr: pr.number,
        reason: `${handoffName(a.type, live.phase)} merged`,
      },
    ];
    let state: LifecycleState = next;
    if (next === "released" && a.type.postReleaseReview) {
      history.push({
        from: "released",
        to: "post-release-review",
        at: now,
        by,
        reason: "Released first; the skipped lenses are reviewed now",
      });
      state = "post-release-review";
    }
    await save(h, { state, history });
    return { merged: true, ready: true, state, handoff: h, reasons: [] };
  };

  if (pr.state === "merged") return advance(strip(opts.approval?.by ?? live.by));

  if (requested.length > 0) {
    const h: ChangeHandoff = { ...current, state: "changes-requested", updatedAt: now, approvals };
    await save(h);
    return {
      merged: false,
      ready: false,
      state: change.state,
      handoff: h,
      reasons: requested.map((p) => ({
        code: "changes-requested" as const,
        person: p,
        message: `${p} requested changes on PR #${pr.number}.`,
      })),
    };
  }

  const h: ChangeHandoff = { ...current, state: "open", updatedAt: now, approvals };
  const reasons: Reason[] = [...result.reasons];
  if (reasons.length === 0) {
    // Artifacts or findings may have changed since the hand-off was raised.
    reasons.push(...a.blockers);
  }
  if (reasons.length === 0) {
    const blockers = mergeBlockers(pr);
    if (blockers.length > 0)
      reasons.push({
        code: "host-refused",
        message: `The Git host won't merge PR #${pr.number} yet: ${blockers.join("; ")}.`,
      });
  }
  if (reasons.length > 0 || !opts.approval) {
    await save(h);
    return { merged: false, ready: reasons.length === 0, state: change.state, handoff: h, reasons };
  }
  const approval = requireApproval("changes", opts.approval);
  try {
    await opts.gitHost.merge(repo, pr.number, opts.approval);
  } catch (e) {
    if (!(e instanceof AdapterError)) throw e;
    await save(h);
    return {
      merged: false,
      ready: false,
      state: change.state,
      handoff: h,
      reasons: [{ code: "host-refused", message: `The Git host refused the merge: ${e.message}` }],
    };
  }
  return advance(strip(approval.by));
}

export interface ReturnOptions extends HostOptions {
  by: string;
  reason: string;
  approval: Approval;
}

/**
 * Return to PO: close the hand-off PR (or, where the host can't close PRs, comment on it so
 * a person closes it) and move the change to `returned`.
 */
export async function returnToPo(
  root: string,
  id: string,
  opts: ReturnOptions,
): Promise<{ state: LifecycleState; closedOnHost: boolean; handoff: ChangeHandoff }> {
  const { ctx, change } = await load(root, id);
  const live = liveHandoff(change);
  if (!live)
    throw new ChangeError("refused", `${id} has no open hand-off PR to return.`, [
      { code: "no-handoff", message: `${id} has no open hand-off PR.` },
    ]);
  requireApproval("changes", opts.approval);
  const repo = metarepo(ctx, opts.repo);
  const now = opts.now ?? nowIso();
  const by = strip(opts.by);
  const host = opts.gitHost;
  await host.comment(
    repo,
    live.pr.number,
    `Returned to the product owner by ${by}: ${opts.reason}`,
    opts.approval,
  );
  // C4 closePullRequest (ADR 0041) where the host has it; the comment asks a person otherwise.
  // A host where a person closes PRs (manual) answers with the PR open until they have.
  const closedOnHost = host.closePullRequest
    ? (await host.closePullRequest(repo, live.pr.number, opts.approval)).state === "closed"
    : false;
  const h: ChangeHandoff = { ...live, state: "closed", updatedAt: now };
  await changeStore(root).write({
    ...change,
    state: "returned",
    history: [
      ...change.history,
      {
        from: change.state,
        to: "returned",
        at: now,
        by,
        pr: live.pr.number,
        reason: `Returned to the product owner (${opts.reason})`,
      },
    ],
    handoffs: change.handoffs.map((x) => (x === live ? h : x)),
  });
  return { state: "returned", closedOnHost, handoff: h };
}

/**
 * Archive a released change (or one whose post-release review is clear). With an OpenSpec
 * adapter the change folder is archived by OpenSpec too, after change.yaml is written.
 */
export async function archiveChange(
  root: string,
  id: string,
  opts: { by: string; now?: string; openspec?: OpenSpec },
): Promise<ChangeLifecycle> {
  const { ctx, change } = await load(root, id);
  const a = await assess(ctx, change);
  if (change.state !== "released" && change.state !== "post-release-review")
    throw new ChangeError(
      "refused",
      `${id} is ${change.state}; only a released change can be archived.`,
      [{ code: "wrong-state", message: `${id} is ${change.state}.` }],
    );
  if (a.reasons.length > 0)
    throw new ChangeError("refused", `${id} can't be archived yet.`, a.reasons);
  const now = opts.now ?? nowIso();
  const updated: ChangeLifecycle = {
    ...change,
    state: "archived",
    history: [
      ...change.history,
      { from: change.state, to: "archived", at: now, by: strip(opts.by), reason: "Archived" },
    ],
  };
  await changeStore(root).write(updated);
  if (opts.openspec) await opts.openspec.archive(id);
  return updated;
}
