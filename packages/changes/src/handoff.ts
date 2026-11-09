import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AdapterError,
  mergeBlockers,
  requireApproval,
  type Approval,
  type GitHost,
  type PullRequest,
} from "@maycombhq/adapters";
import {
  changesRelOf,
  handoffBranch,
  listQuestions,
  nextOwnersOf,
  PHASES,
  questionsRelOf,
  type ChangeHandoff,
  type ChangeLifecycle,
  type LifecycleState,
} from "@maycombhq/core";
import { archiveRefuses, blockingIssues, type OpenSpec } from "@maycombhq/openspec-adapter";
import { prApprovers } from "./approvals.js";
import { assess, liveHandoff, type Assessment } from "./assess.js";
import { ownersFor } from "./codeowners.js";
import { loadChangeContext, type ChangeContext } from "./context.js";
import { ChangeError, type Reason } from "./errors.js";
import {
  phaseStage,
  stageFiles,
  artifactFiles,
  handoffName,
  phaseArtifacts,
  phaseGates,
  phaseState,
  sha256,
} from "./lifecycle.js";
import type { GitRunner } from "@maycombhq/workspace";
import { captureHandoff, type DraftCapture } from "./drafted.js";
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

/** The files of the drafted/merged pairs kept in a change folder (H1), relative to it. */
async function keptPairFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(join(dir, "stage"), { withFileTypes: true });
  } catch {
    return out;
  }
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(join(dir, ...rel.split("/")), { withFileTypes: true }).catch(
      () => [],
    )) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  };
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".capture.yaml")) out.push(`stage/${e.name}`);
    else if (e.isDirectory() && /\.(drafted|merged)$/.test(e.name)) await walk(`stage/${e.name}`);
  }
  return out.sort();
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
  // On the stage path, the files the phase's stage wrote and its loop state (ADR 0087). Ninth UX
  // walk: an earlier phase's stage's too, so a stage run after its phase's hand-off merged (the
  // feature stage after Define's) reaches the metarepo with the next one; one already merged and
  // unchanged adds nothing to the PR's diff.
  const at = PHASES.indexOf(phase);
  for (const step of ctx.policy.stages.filter((s) => PHASES.indexOf(s.phase) <= at)) {
    if (await phaseStage(ctx, a.change, step.phase))
      for (const f of await stageFiles(dir, step)) files.add(f);
  }
  // Ninth UX walk: the change's own records of its drafts (ADR 0181: a person's corrections, who
  // drafted each file) ride with every hand-off, as they cover every stage.
  const present = async (f: string) =>
    readFile(join(dir, ...f.split("/"))).then(
      () => true,
      () => false,
    );
  // Review round 50: the stories' and tasks' numbers too, so every clone numbers them alike.
  for (const own of ["stage/corrections.yaml", "stage/drafted.yaml", "stage/stories-numbers.yaml"])
    if (await present(own)) files.add(own);
  if (phase === "build") {
    for (const extra of ["tasks.md", "repos.yaml"]) if (await present(extra)) files.add(extra);
    // Ninth UX walk: each task's report (tasks/<task>/report.md), not its run records.
    for (const t of await readdir(join(dir, "tasks"), { withFileTypes: true }).catch(() => []))
      if (t.isDirectory() && (await present(`tasks/${t.name}/report.md`)))
        files.add(`tasks/${t.name}/report.md`);
  }
  for (const gate of phaseGates(ctx, phase))
    for (const f of await walkReview(dir, gate)) files.add(f);
  // H1: the drafted/merged pairs kept from earlier phases ride along, so they reach the metarepo by a PR.
  for (const f of await keptPairFiles(dir)) files.add(f);
  return { files: [...files].sort(), artifacts };
}

/**
 * Seventh UX walk: the change's own answered questions, metarepo-relative. The decisions a
 * person makes on a change (filed under the change id: its repo or its scope is the change) live
 * in the metarepo's questions/ folder, outside the change folder; every hand-off carries all of
 * them, so they reach the metarepo by the change's PR. One already merged and unchanged adds
 * nothing to the PR's diff, so carrying all of them each time is the simple rule that never
 * leaves one behind. Open and retired ones don't ride.
 */
/** Whether a command is a step of the change `id` (the change's id as one of its words). */
export function namesChange(command: string | undefined, id: string): boolean {
  const w = (command ?? "").trim().split(/\s+/);
  if (w[0] !== "atticus") return false;
  const changeStep = w[1] === "change" || w[1] === "plan" || w[1] === "critic";
  return changeStep && w.slice(2).includes(id);
}

async function changeQuestionFiles(root: string, id: string): Promise<string[]> {
  const { questions } = await listQuestions(root, { state: "answered" });
  const rel = questionsRelOf(root);
  // Round 44: a question is this change's when the step that asked it, or the one its answer
  // runs again, is a step of this change (`atticus change <step> <id>`, `atticus plan <step>
  // <id>`, `atticus critic <id>`): never by its repo field alone, which a repo's own map
  // question shares when a change's id is a repo's, and which a stage files under the repo a
  // question is about.
  return questions
    .filter((q) => namesChange(q.askedBy.command, id) || namesChange(q.rerun, id))
    .map((q) => `${rel}/${q.id}.yaml`)
    .sort();
}

/** ADR 0191: " (architect)" after a reviewer the change names as the next role's owner. */
function nextRoleOf(c: ChangeLifecycle, phase: PhaseId, person: string): string {
  const n = nextOwnersOf(phase, c.owners);
  return n?.people.includes(person) ? ` (${n.role.replace(/-/g, " ")})` : "";
}

/** The next role in words, for a hand-off that names none. */
const nextRoleName = (phase: PhaseId): string =>
  (nextOwnersOf(phase, {})?.role ?? "reviewer").replace(/-/g, " ");

function prBody(
  a: Assessment,
  phase: PhaseId,
  next: LifecycleState,
  /** The hand-off's files, relative to the metarepo root. */
  paths: string[],
  reviewers: string[],
  review?: string,
): string {
  const c = a.change;
  const lines = [
    `## Hand-off: ${handoffName(a.type, phase)}`,
    "",
    `Change ${c.id} (${c.title}), type ${c.type}, moves from ${phase} to ${next} when this pull request merges.`,
    "",
    "Merging this pull request approves the hand-off. The Git host's own rules (branch protection, CODEOWNERS) decide who may approve it.",
    "",
    "### Files",
    "",
    ...(paths.length ? paths.map((f) => `- ${f}`) : ["- None"]),
    "",
    "### Reviewers",
    "",
    ...(reviewers.length
      ? reviewers.map((r) => `- @${r}${nextRoleOf(c, phase, r)}`)
      : [`- None: name the ${nextRoleName(phase)} under the change's owners`]),
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
      ? `Touches personal data (${a.privacy.records.map((r) => r.id).join(", ")}); review it with the ${a.privacy.phase} hand-off.`
      : "No personal data touched.",
    ...(review?.trim() ? ["", review.trim()] : []),
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
  /**
   * Markdown the PR body ends with (WP7.4): what the change does, its estimate and its open
   * findings, so an approver reads one page. The caller composes it.
   */
  review?: string;
  /** The metarepo's OpenSpec: the plan hand-off runs `openspec validate --strict` first. */
  openspec?: OpenSpec;
}

/**
 * Raise a phase's hand-off: check the phase is ready (artifacts, findings, critic rounds),
 * open the PR `handoff/<change-id>/<phase>` → main with the phase's files, name the
 * reviewers (CODEOWNERS of those files) and record it in
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
  // ADR 0006 addendum: the stories' hand-off (the plan phase, whose files hold the specs) passes
  // OpenSpec's own validation first.
  if (opts.openspec && phase === "plan") await requireValid(opts.openspec, id);

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
  const questionFiles = await changeQuestionFiles(root, id);
  const metaFiles = [
    ...files.map((f) => `${rel}/${id}/${f}`),
    `${rel}/${id}/change.yaml`,
    ...questionFiles,
  ];
  // ADR 0191: the next role's owners on the change review it (define → the architect, design →
  // the business analyst, plan → the tech lead), beside CODEOWNERS of the phase's files.
  const reviewers = [
    ...new Set([
      ...files.flatMap((f) => ownersFor(ctx.codeowners, `${rel}/${id}/${f}`)),
      ...(nextOwnersOf(phase, change.owners)?.people ?? []),
    ]),
  ]
    .filter((p) => p !== by)
    .sort();

  const live = change.state === "returned" ? undefined : liveHandoff(change);
  if (live && live.phase === phase) {
    const pr = await handoffPr(opts.gitHost, repo, id, live);
    if (pr.state === "open" || pr.state === "draft") {
      const published = await opts.publisher?.publish({
        root,
        branch,
        base: pr.base,
        files: metaFiles,
        message: `${handoffName(a.type, phase)}: update`,
        approval: opts.approval,
      });
      // Review round 48: a re-run that moved nothing (the branch as it was, or with no publisher
      // the same files) asks for no other review.
      const unchanged = published
        ? published.changed === false
        : sameArtifacts(hashed, live.artifacts);
      if (!unchanged)
        await opts.gitHost.comment(
          repo,
          pr.number,
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

  // Review round 48: a resubmit after Return to PO, whose PR a person closes on a host that
  // can't (the manual host, a host with no closePullRequest), waits until it is closed there:
  // publishing first would put the new files on the PR still open.
  if (change.state === "returned") {
    const open = (await opts.gitHost.listPullRequests(repo, { head: branch })).find(
      (p) => p.state === "open" || p.state === "draft",
    );
    if (open) {
      const message = `PR #${open.number} from ${branch} is still open on the Git host (${open.url}): close it there first (the return asked for that), then resubmit the change.`;
      throw new ChangeError("refused", message, [{ code: "host-refused", message }]);
    }
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
  let pr: PullRequest;
  try {
    pr = await opts.gitHost.createPullRequest(
      {
        repo,
        head: branch,
        base,
        title: `${change.title}: ${handoffName(a.type, phase)}`,
        body: prBody(
          a,
          phase,
          change.state === "returned" ? nextAfterResubmit(a, phase) : next,
          [...files.map((f) => `${rel}/${id}/${f}`), ...questionFiles],
          reviewers,
          opts.review,
        ),
      },
      opts.approval,
    );
  } catch (e) {
    // Review round 48: the PR the host opened when its answer didn't reach Atticus (a timeout)
    // is the one open from the hand-off branch into the base: recorded, as release PRs are.
    if (!(e instanceof AdapterError) || e.code !== "conflict") throw e;
    const open = (await opts.gitHost.listPullRequests(repo, { head: branch }).catch(() => []))
      .filter((p) => p.base === base && (p.state === "open" || p.state === "draft"))
      .at(0);
    if (!open) throw e;
    pr = open;
  }
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

/** Whether a re-run hands off the same files as the hand-off already open. */
function sameArtifacts(a: ChangeHandoff["artifacts"], b: ChangeHandoff["artifacts"]): boolean {
  const key = (xs: ChangeHandoff["artifacts"]) =>
    JSON.stringify([...xs].map((x) => `${x.path} ${x.sha256}`).sort());
  return key(a) === key(b);
}

function nextAfterResubmit(a: Assessment, phase: PhaseId): LifecycleState {
  const next = a.type.phases[a.type.phases.indexOf(phase) + 1];
  return next ? phaseState(next) : "released";
}

export interface SyncOptions extends HostOptions {
  /** The approval for the auto-merge. Without it, a ready PR is reported, not merged. */
  approval?: Approval;
  /** Git for keeping the drafted files beside the merged ones (H1); the git on PATH by default. */
  git?: GitRunner;
  /** The Git host's remote in the clone; default origin. */
  remote?: string;
}

export interface SyncResult {
  merged: boolean;
  /** True when everything is in place and only the merge approval is missing. */
  ready: boolean;
  state: LifecycleState;
  handoff: ChangeHandoff;
  reasons: Reason[];
  /**
   * H1: on a merge, what Atticus drafted kept beside what merged (`stage/<stage>.capture.yaml`).
   * Absent when the metarepo isn't a git clone or the hand-off drafted nothing.
   */
  capture?: DraftCapture;
}

/**
 * Review round 44: the hand-off's own PR. Read by the number the hand-off holds; a PR from
 * another branch (a manual host's recorded number equal to another PR's, a number a person got
 * wrong) is never used: the hand-off's PR is looked up by its branch instead, and without one
 * the sync is refused, so another change's merge can't move this change's gate.
 */
async function handoffPr(
  gitHost: GitHost,
  repo: string,
  id: string,
  live: ChangeHandoff,
): Promise<PullRequest> {
  const branch = handoffBranch(id, live.phase);
  const pr = await gitHost.getPullRequest(repo, live.pr.number);
  if (pr.head === branch) return pr;
  const mine = await gitHost.listPullRequests(repo, { head: branch });
  const own = mine.find((x) => x.url === live.pr.url) ?? (mine.length === 1 ? mine[0] : undefined);
  if (own) return own;
  const message = `PR #${live.pr.number} on the Git host is from ${pr.head}, not ${branch}, and no PR from ${branch} was found: Atticus uses only the hand-off's own PR. Check the PR's number on the Git host (on a manual host, on its step: atticus todo), then sync again.`;
  throw new ChangeError("refused", message, [{ code: "host-refused", message }]);
}

/**
 * Read the hand-off PR from the Git host and act on it (ADR 0073: the PR is the approval).
 * Merged on the host → the gate is approved, the state advances and history records it.
 * Changes requested → it stays. Approved by someone other than the person who raised it,
 * with the host's own rules met → ready: with the person's approval Atticus merges it,
 * without it the PR is reported ready. A PR closed on the host is recorded as closed.
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
  const pr = await handoffPr(opts.gitHost, repo, id, live);
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
  const counted = prApprovers(live, approvers);
  const approvals = counted.map((by) => ({ by, at: now }));

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
    const saved = await save(h, { state, history });
    // H1: keep the draft beside what merged, from the clone's git; never fails the sync.
    const kept = await captureHandoff({
      ctx,
      change: saved,
      type: a.type,
      handoff: h,
      base: pr.base,
      now,
      ...(opts.git ? { git: opts.git } : {}),
      ...(opts.remote ? { remote: opts.remote } : {}),
    }).catch(() => undefined);
    return {
      merged: true,
      ready: true,
      state,
      handoff: h,
      reasons: [],
      ...(kept ? { capture: kept.capture } : {}),
    };
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
  const reasons: Reason[] = [];
  if (counted.length === 0)
    reasons.push(
      approvers.length > 0
        ? {
            code: "self-approval",
            person: strip(live.by),
            message: `PR #${pr.number} is approved only by ${strip(live.by)}, who raised it; it needs someone else's approval.`,
          }
        : {
            code: "approval-missing",
            message: `PR #${pr.number} isn't approved yet: ask a reviewer on the Git host (${pr.url}).`,
          },
    );
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
 * `openspec validate <change> --strict` as a gate (ADR 0006 addendum, 2026-10-25): before the
 * stories' hand-off and before archive. Each error or warning is a reason the step is refused.
 */
export async function requireValid(openspec: OpenSpec, id: string): Promise<void> {
  const r = await openspec.validate({ item: id, type: "change", strict: true });
  const item = r.items[0];
  // App-only audit: a delta OpenSpec's archive would refuse is only INFO to validate, so a change
  // passed every gate and failed at the archive. It is refused here, with what to do.
  const issues = item ? blockingIssues(item.issues) : [];
  if (!item || (item.valid && issues.length === 0)) return;
  throw new ChangeError(
    "refused",
    `${id} doesn't pass openspec validate --strict.`,
    issues.map((i) => ({
      code: "openspec-invalid",
      message: `${i.path}: ${i.message}${archiveRefuses(i) ? ` ${ADDED_ONLY}` : ""}`,
    })),
  );
}

/** What to do about a delta OpenSpec's archive would refuse: a new spec's requirements are ADDED. */
const ADDED_ONLY =
  "A spec that openspec/specs doesn't have yet takes \"## ADDED Requirements\" only: change the delta's MODIFIED (or RENAMED, REMOVED) heading to ADDED, or run the stage that wrote it again.";

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
  // ADR 0006 addendum: OpenSpec's own gate before its archive merges the specs.
  if (opts.openspec) await requireValid(opts.openspec, id);
  const now = opts.now ?? nowIso();
  const updated: ChangeLifecycle = {
    ...change,
    state: "archived",
    history: [
      ...change.history,
      { from: change.state, to: "archived", at: now, by: strip(opts.by), reason: "Archived" },
    ],
  };
  // App-only audit: all or nothing. change.yaml says archived before OpenSpec moves the folder (so
  // the archived copy says so); if OpenSpec refuses, the change is put back as it was and its
  // words are said, never a bare failure with the state archived and the folder unmoved.
  await changeStore(root).write(updated);
  if (opts.openspec)
    try {
      await opts.openspec.archive(id);
    } catch (e) {
      await changeStore(root).write(change);
      const words = (e instanceof Error ? e.message : String(e)).trim();
      throw new ChangeError(
        "refused",
        `OpenSpec refused to archive ${id}, so nothing was archived.`,
        [
          {
            code: "openspec-invalid",
            message: `${words.replace(/\.?$/, ".")}${/target spec does not exist|only ADDED/i.test(words) ? ` ${ADDED_ONLY}` : " Fix what it says, then archive again (atticus openspec validate " + id + " --strict says more)."}`,
          },
        ],
      );
    }
  return updated;
}
