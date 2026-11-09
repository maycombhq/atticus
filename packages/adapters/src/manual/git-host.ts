import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { orgPackDirOf, type ManualStep } from "@maycombhq/core";
import { AdapterError, type Approval } from "../common.js";
import {
  mergeBlockers,
  type GitHost,
  type PrState,
  type PullRequest,
  type RepoInfo,
} from "../git-host.js";
import { ManualBase, type ManualOptions } from "./base.js";
import { recordStep, shortHash } from "./steps.js";

/** The change a branch belongs to: handoff/<change>/<phase> or task/<change>/<task>. */
export function changeOfBranch(branch: string): string | undefined {
  const m = /^(?:handoff|task|change)\/([a-z0-9][a-z0-9._-]*)(?:\/|$)/.exec(branch);
  return m?.[1];
}

/** The number Atticus gave the PR when its step was made: the steps of one PR share it. */
const localOf = (open: ManualStep): number => Number(open.inputs.number);

/** The number the person recorded on the open step, when they have. */
function recordedOf(open: ManualStep): number | undefined {
  const n = open.state === "done" ? Number(open.recorded?.values.number) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** How a step names the PR: by the number the person recorded, else by its branch. */
const prName = (open: ManualStep): string => {
  const n = recordedOf(open);
  return n ? `PR #${n}` : `the PR from ${String(open.inputs.head)}`;
};

/** A PR step's readable id stem: what it does and the PR's branch (one PR per branch and repo). */
const prSlug = (verb: string, open: ManualStep) => `${verb}-pr-${String(open.inputs.head)}`;

/**
 * The Git host when Atticus can't reach it (ADR 0032 point 4). Opening a PR becomes a step: the
 * branch is prepared, the title and description are ready to paste, and the person records the
 * PR's link and number. What only the host knows (who approved, whether checks pass, whether it
 * merged) is asked of a person with a report step, so separation of duties is checked on what
 * is recorded. Merging is a step too, created only after Atticus has checked the approvals.
 * Until the person records the real number, the PR has a local number Atticus uses; once they
 * have, the PR goes by the recorded number and link, and the local one still finds it.
 *
 * Seventh UX walk (tasks and manual steps): each PR's steps are named by its branch (a hand-off's
 * or a task's), never by a number a person may not have recorded yet; the reviews step also
 * records whether the PR merged, so a PR merged on the host needs no Merge step; a task's PR
 * whose reviews were recorded without its merge is asked about again; and a reviews step still
 * open when the PR reads merged or closed is skipped, saying why.
 */
export class ManualGitHost extends ManualBase implements GitHost {
  constructor(opts: ManualOptions) {
    super("git-host", "git-host", opts);
  }

  /**
   * Review round 48: the repo's own default branch, not one for every repo. A per-repo setting
   * (`defaultBranch.<repo>`) first, then the repo's `defaultBranch` in the repos manifest (ADR
   * 0123: the baseline the PRs build on), then the adapter's `defaultBranch` setting, else main.
   * Its protected branches (`protectedBranches.<repo>`, else `protectedBranches`) always include
   * the default branch.
   */
  async getRepo(repo: string): Promise<RepoInfo> {
    this.journal.push({ method: "getRepo" });
    const defaultBranch =
      this.setting(`defaultBranch.${repo}`) ??
      (await this.manifestDefault(repo)) ??
      this.setting("defaultBranch") ??
      "main";
    const listed =
      this.settingList(`protectedBranches.${repo}`) ?? this.settingList("protectedBranches") ?? [];
    return {
      repo,
      defaultBranch,
      protectedBranches: listed.includes(defaultBranch) ? listed : [...listed, defaultBranch],
    };
  }

  /** The defaultBranch a repos manifest of the metarepo's org pack gives the repo, when one does. */
  private async manifestDefault(repo: string): Promise<string | undefined> {
    if (!this.opts.root) return undefined;
    const profiles = join(orgPackDirOf(this.opts.root), "profiles");
    const names = await readdir(profiles, { withFileTypes: true }).then(
      (d) =>
        d
          .filter((x) => x.isDirectory())
          .map((x) => x.name)
          .sort(),
      () => [] as string[],
    );
    for (const name of names) {
      const text = await readFile(join(profiles, name, "repos.manifest.yaml"), "utf8").catch(
        () => undefined,
      );
      if (text === undefined) continue;
      let doc: unknown;
      try {
        doc = parse(text);
      } catch {
        continue;
      }
      const repos = (doc as { repos?: unknown } | null)?.repos;
      if (!Array.isArray(repos)) continue;
      const entry = (repos as unknown[]).find(
        (r) => (r as { id?: unknown } | null)?.id === repo,
      ) as { defaultBranch?: unknown } | undefined;
      if (!entry) continue;
      return typeof entry.defaultBranch === "string" && entry.defaultBranch.trim()
        ? entry.defaultBranch.trim()
        : undefined;
    }
    return undefined;
  }

  private async prSteps(repo?: string): Promise<ManualStep[]> {
    return (await this.opts.store.list({ system: "git-host", action: "open-pull-request" })).filter(
      (s) => !repo || s.inputs.repo === repo,
    );
  }

  /** The steps of one PR, by the number Atticus gave it (which never changes). */
  private async related(open: ManualStep, action: string): Promise<ManualStep[]> {
    const repo = String(open.inputs.repo);
    const number = localOf(open);
    return (await this.opts.store.list({ system: "git-host", action })).filter(
      (s) => s.inputs.repo === repo && s.inputs.number === number,
    );
  }

  /**
   * Review round 44: the number the PR goes by. The recorded one, unless it is the number Atticus
   * gave another PR in the repo, or one recorded for another PR too: then the number Atticus gave
   * it, so no number a caller holds ever names two PRs (new numbers skip recorded ones).
   */
  private async numberOf(open: ManualStep): Promise<number> {
    const local = localOf(open);
    const rec = recordedOf(open);
    if (rec === undefined || rec === local) return local;
    const others = (await this.prSteps(String(open.inputs.repo))).filter((s) => s.id !== open.id);
    return others.some((s) => localOf(s) === rec || recordedOf(s) === rec) ? local : rec;
  }

  private async toPr(open: ManualStep): Promise<PullRequest> {
    const repo = String(open.inputs.repo);
    const number = localOf(open);
    const rec = open.state === "done" ? open.recorded?.values : undefined;
    const reports = (await this.related(open, "report-pull-request"))
      .filter((s) => s.state === "done")
      .sort((a, b) => (a.recorded!.at < b.recorded!.at ? -1 : 1));
    // Merged on the host, as a person recorded it: on its Merge step, or on a reviews step.
    const merged =
      (await this.related(open, "merge-pull-request")).some((s) => s.state === "done") ||
      reports.some((s) => s.recorded?.values.merged === true);
    const last = reports.at(-1)?.recorded?.values;
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    const reviews: PullRequest["reviews"] = [
      ...list(last?.approvers).map((by) => ({ by, state: "approved" as const })),
      ...list(last?.changesRequestedBy).map((by) => ({ by, state: "changes-requested" as const })),
    ];
    const closed = (await this.related(open, "close-pull-request")).some((s) => s.state === "done");
    let state: PrState = open.state === "done" ? (open.inputs.draft ? "draft" : "open") : "draft";
    if (open.state === "skipped" || closed) state = "closed";
    if (merged) state = "merged";
    return {
      repo,
      number: await this.numberOf(open),
      url: typeof rec?.url === "string" ? rec.url : `manual://git-host/${repo}/pull/${number}`,
      title: String(open.inputs.title ?? ""),
      body: open.fields.find((f) => f.name === "Description")?.value ?? "",
      head: String(open.inputs.head),
      base: String(open.inputs.base),
      state,
      reviews,
      checks:
        last?.checksPassing === undefined
          ? []
          : [{ name: "reported by a person", status: last.checksPassing ? "passed" : "failed" }],
      requiredReviewers: [],
    };
  }

  /**
   * The PR by the number Atticus gave it (which a caller may have kept from before the person
   * recorded the real one, and which no other PR in the repo has), else by the recorded number
   * it goes by (numberOf). Review round 44: a recorded number equal to another PR's own number
   * finds that other PR, never this one, so a caller can't be handed another change's PR.
   */
  private async find(repo: string, number: number): Promise<ManualStep> {
    const all = await this.prSteps(repo);
    const local = all.find((x) => localOf(x) === number);
    if (local) return local;
    for (const x of all) if ((await this.numberOf(x)) === number) return x;
    if (all.filter((x) => recordedOf(x) === number).length > 1)
      throw new AdapterError(
        this.name,
        "conflict",
        `#${number} was recorded for more than one pull request in ${repo}: correct the number on the step of the one it isn't (atticus todo), or use the number Atticus gave it`,
      );
    return this.notFound(`PR ${repo}#${number}`, "no manual step opened it");
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequest> {
    this.journal.push({ method: "getPullRequest" });
    const open = await this.find(repo, number);
    const pr = await this.toPr(open);
    await this.settle(open, pr);
    return pr;
  }

  /**
   * Keeps a PR's steps in step with what was recorded: a reviews step still open on a PR that
   * reads merged or closed is skipped, saying why; a task's PR open on the host, with its reviews
   * recorded but not its merge, gets a step to record that it merged (a task's PR has no gate to
   * make a Merge step; a hand-off's gets one when it syncs). Steps only: nothing is sent.
   */
  private async settle(open: ManualStep, pr: PullRequest): Promise<void> {
    const waiting = (await this.related(open, "report-pull-request")).filter(
      (s) => s.state === "open",
    );
    if (pr.state === "merged" || pr.state === "closed") {
      for (const s of waiting)
        await recordStep(this.opts.store, s.id, {
          by: "atticus",
          at: this.now(),
          skip: true,
          note: `${prName(open)} is ${pr.state} on the Git host: nothing left to record.`,
        });
      // App-only audit: a comment never posted is moot once the PR is merged or closed.
      for (const s of (await this.related(open, "comment-pull-request")).filter(
        (x) => x.state === "open",
      ))
        await recordStep(this.opts.store, s.id, {
          by: "atticus",
          at: this.now(),
          skip: true,
          note: `${prName(open)} is ${pr.state} on the Git host: nothing left to post.`,
        });
      return;
    }
    if (pr.state !== "open" || waiting.length > 0) return;
    if (!String(open.inputs.head).startsWith("task/")) return;
    if ((await this.related(open, "merge-pull-request")).some((s) => s.state === "open")) return;
    await this.askForReviews(open, open.change);
  }

  async listPullRequests(repo: string, q: { head?: string; state?: PrState }) {
    this.journal.push({ method: "listPullRequests" });
    const out: PullRequest[] = [];
    for (const s of await this.prSteps(repo)) {
      const pr = await this.toPr(s);
      if ((!q.head || pr.head === q.head) && (!q.state || pr.state === q.state)) out.push(pr);
    }
    return out;
  }

  /** A report step for the PR's reviews and checks, unless one is still open. */
  private async askForReviews(open: ManualStep, change?: string): Promise<void> {
    const repo = String(open.inputs.repo);
    const number = localOf(open);
    const reports = await this.related(open, "report-pull-request");
    if (reports.some((s) => s.state === "open")) return;
    // Its reviews recorded already and the PR still open: asked about again for its merge.
    const again = reports.some((s) => s.state === "done") && recordedOf(open) !== undefined;
    await this.step("report", {
      slug: prSlug("report", open),
      action: "report-pull-request",
      key: `git-host|report|${repo}|${number}|${reports.length}`,
      title: again
        ? `Record that ${prName(open)} (${open.inputs.title}) merged, or its reviews again`
        : `Record the reviews and checks on ${prName(open)} (${open.inputs.title}), and whether it merged`,
      where: `Git host: ${repo}, the pull request opened for step ${open.id}`,
      ...(change ? { change } : {}),
      inputs: { repo, number },
      fields: [
        { name: "Repository", value: repo },
        { name: "From branch", value: String(open.inputs.head) },
      ],
      instructions: [
        "Once reviewers have acted, record who approved, who asked for changes and whether the checks pass.",
        "Name people by their handle on the Git host. Only what is recorded here counts for approval.",
        "Once it is merged on the Git host, record Merged on the Git host: yes here, and Atticus reads it as merged.",
      ],
      result: [
        { name: "approvers", label: "Approved by", format: "handles", required: false },
        {
          name: "changesRequestedBy",
          label: "Changes requested by",
          format: "handles",
          required: false,
        },
        { name: "checksPassing", label: "All checks pass", format: "yes-no", required: true },
        { name: "merged", label: "Merged on the Git host", format: "yes-no", required: false },
      ],
      dependsOn: [open.id],
    });
  }

  async createPullRequest(
    input: {
      repo: string;
      head: string;
      base: string;
      title: string;
      body: string;
      draft?: boolean;
    },
    approval: Approval,
  ): Promise<PullRequest> {
    const a = this.approve(approval);
    const info = await this.getRepo(input.repo);
    if (info.protectedBranches.includes(input.head))
      throw new AdapterError(
        this.name,
        "invalid",
        `${input.head} is protected and can't be a PR's source branch`,
      );
    const existing = await this.prSteps(input.repo);
    for (const s of existing) {
      if (s.inputs.head !== input.head) continue;
      const pr = await this.toPr(s);
      if (pr.state === "open" || pr.state === "draft")
        throw new AdapterError(
          this.name,
          "conflict",
          `an open PR from ${input.head} already exists`,
        );
    }
    // Never a number a person recorded for another PR, so the two can't be taken for each other.
    const number = existing.reduce((n, s) => Math.max(n, localOf(s), recordedOf(s) ?? 0), 0) + 1;
    const change = this.opts.change ?? changeOfBranch(input.head);
    const proc = this.procedureFor("open-pull-request");
    const open = await this.step(
      "createPullRequest",
      {
        slug: `open-pr-${input.head}`,
        action: "open-pull-request",
        key: `git-host|pr|${input.repo}|${input.head}|${number}`,
        // Ninth UX walk: the release PRs of three repos had one title on Home; the repo tells them apart.
        title: `Open a pull request in ${input.repo} from ${input.head} into ${input.base}`,
        where: `Git host: ${input.repo}, new pull request`,
        ...(change ? { change } : {}),
        ...(proc ?? {}),
        inputs: {
          repo: input.repo,
          number,
          head: input.head,
          base: input.base,
          title: input.title,
          ...(input.draft ? { draft: true } : {}),
        },
        fields: [
          { name: "Repository", value: input.repo },
          { name: "From branch", value: input.head },
          { name: "Into branch", value: input.base },
          { name: "Title", value: input.title },
          { name: "Description", value: input.body },
          ...(input.draft ? [{ name: "Draft", value: "yes" }] : []),
        ],
        instructions: [
          `Make sure ${input.head} is on the Git host (Atticus pushes it when it can reach the remote; otherwise push it yourself).`,
          `Open a pull request from ${input.head} into ${input.base} with the title and description below.`,
          "Record the pull request's link and number here.",
        ],
        result: [
          { name: "url", label: "Pull request link", format: "url", required: true },
          { name: "number", label: "Pull request number", format: "integer", required: true },
        ],
      },
      a,
    );
    await this.askForReviews(open, change);
    return this.toPr(open);
  }

  async comment(repo: string, number: number, body: string, approval: Approval): Promise<void> {
    const a = this.approve(approval);
    const open = await this.find(repo, number);
    const change = open.change;
    await this.step(
      "comment",
      {
        slug: prSlug("comment", open),
        action: "comment-pull-request",
        key: `git-host|comment|${repo}|${localOf(open)}|${shortHash(body)}`,
        title: `Post a comment on ${prName(open)} (${open.inputs.title})`,
        where: `Git host: ${repo}, the pull request opened for step ${open.id}`,
        ...(change ? { change } : {}),
        inputs: { repo, number: localOf(open) },
        fields: [{ name: "Comment", value: body }],
        instructions: ["Post the comment below on the pull request."],
        dependsOn: [open.id],
      },
      a,
    );
    // A comment means the PR was updated or returned: reviews must be reported again.
    if ((await this.toPr(open)).state !== "merged") await this.askForReviews(open, change);
  }

  /**
   * Closing is a step for a person (once per PR); the PR reads closed when they have done
   * it, so until then it is returned as it is.
   */
  async closePullRequest(repo: string, number: number, approval: Approval): Promise<PullRequest> {
    const a = this.approve(approval);
    const open = await this.find(repo, number);
    const pr = await this.toPr(open);
    if (pr.state === "merged")
      throw new AdapterError(this.name, "conflict", `PR ${number} is merged and can't be closed`);
    if (pr.state === "closed") return pr;
    await this.step(
      "closePullRequest",
      {
        slug: prSlug("close", open),
        action: "close-pull-request",
        key: `git-host|close|${repo}|${localOf(open)}`,
        title: `Close ${prName(open)} (${open.inputs.title}) without merging`,
        where: `Git host: ${repo}, ${pr.url}`,
        ...(open.change ? { change: open.change } : {}),
        inputs: { repo, number: localOf(open) },
        fields: [{ name: "Pull request", value: pr.url }],
        instructions: [
          "The change went back to the product owner: close the pull request on the Git host without merging it, then mark this step done.",
        ],
        dependsOn: [open.id],
      },
      a,
    );
    return this.toPr(open);
  }

  async merge(repo: string, number: number, approval: Approval): Promise<PullRequest> {
    const a = this.approve(approval);
    const open = await this.find(repo, number);
    const pr = await this.toPr(open);
    if (pr.state === "merged") return pr;
    const blockers = mergeBlockers(pr);
    if (blockers.length > 0)
      throw new AdapterError(this.name, "conflict", `can't merge: ${blockers.join("; ")}`);
    // Eighth UX walk: anyone may type who approved on a manual host, so who recorded it is said.
    const recorder = (await this.related(open, "report-pull-request"))
      .filter((s) => s.state === "done" && s.recorded)
      .sort((a, b) => (a.recorded!.at < b.recorded!.at ? -1 : 1))
      .at(-1)?.recorded?.by;
    const approvedBy = pr.reviews
      .filter((r) => r.state === "approved")
      .map((r) => r.by)
      .join(", ");
    const step = await this.step(
      "merge",
      {
        slug: prSlug("merge", open),
        action: "merge-pull-request",
        key: `git-host|merge|${repo}|${localOf(open)}`,
        title: `Merge ${prName(open)} (${open.inputs.title}) on the Git host`,
        where: `Git host: ${repo}, ${pr.url}`,
        ...(open.change ? { change: open.change } : {}),
        inputs: { repo, number: localOf(open) },
        fields: [
          { name: "Pull request", value: pr.url },
          {
            name: "Approved by",
            value: approvedBy && recorder ? `${approvedBy} (recorded by ${recorder})` : approvedBy,
          },
        ],
        instructions: [
          "Atticus checked the recorded approvals and checks: the pull request may merge.",
          "Merge it on the Git host, then mark this step done.",
        ],
        result: [{ name: "mergedBy", label: "Merged by", format: "handles", required: false }],
        dependsOn: [open.id],
      },
      a,
    );
    throw new AdapterError(
      this.name,
      "unavailable",
      `a person merges ${prName(open)} on the Git host: do step ${step.id} (atticus todo), then sync again`,
      false,
    );
  }
}
