import type { ManualStep } from "@maycombhq/core";
import { AdapterError, type Approval } from "../common.js";
import {
  mergeBlockers,
  type GitHost,
  type PrState,
  type PullRequest,
  type RepoInfo,
} from "../git-host.js";
import { ManualBase, type ManualOptions } from "./base.js";
import { shortHash } from "./steps.js";

/** The change a branch belongs to: handoff/<change>/<phase> or task/<change>/<task>. */
export function changeOfBranch(branch: string): string | undefined {
  const m = /^(?:handoff|task|change)\/([a-z0-9][a-z0-9._-]*)(?:\/|$)/.exec(branch);
  return m?.[1];
}

/**
 * The Git host when Atticus can't reach it (ADR 0032 point 4). Opening a PR becomes a step: the
 * branch is prepared, the title and description are ready to paste, and the person records the
 * PR's link and number. What only the host knows (who approved, whether checks pass, whether it
 * merged) is asked of a person with a report step, so separation of duties is checked on what
 * is recorded. Merging is a step too, created only after Atticus has checked the approvals.
 * Until the person records the real number, the PR has a local number Atticus uses.
 */
export class ManualGitHost extends ManualBase implements GitHost {
  constructor(opts: ManualOptions) {
    super("git-host", "git-host", opts);
  }

  async getRepo(repo: string): Promise<RepoInfo> {
    this.journal.push({ method: "getRepo" });
    const defaultBranch = this.setting("defaultBranch") ?? "main";
    return {
      repo,
      defaultBranch,
      protectedBranches: this.settingList("protectedBranches") ?? [defaultBranch],
    };
  }

  private async prSteps(repo?: string): Promise<ManualStep[]> {
    return (await this.opts.store.list({ system: "git-host", action: "open-pull-request" })).filter(
      (s) => !repo || s.inputs.repo === repo,
    );
  }

  private async related(repo: string, number: number, action: string): Promise<ManualStep[]> {
    return (await this.opts.store.list({ system: "git-host", action })).filter(
      (s) => s.inputs.repo === repo && s.inputs.number === number,
    );
  }

  private async toPr(open: ManualStep): Promise<PullRequest> {
    const repo = String(open.inputs.repo);
    const number = Number(open.inputs.number);
    const rec = open.state === "done" ? open.recorded?.values : undefined;
    const merged = (await this.related(repo, number, "merge-pull-request")).some(
      (s) => s.state === "done",
    );
    const reports = (await this.related(repo, number, "report-pull-request"))
      .filter((s) => s.state === "done")
      .sort((a, b) => (a.recorded!.at < b.recorded!.at ? -1 : 1));
    const last = reports.at(-1)?.recorded?.values;
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    const reviews: PullRequest["reviews"] = [
      ...list(last?.approvers).map((by) => ({ by, state: "approved" as const })),
      ...list(last?.changesRequestedBy).map((by) => ({ by, state: "changes-requested" as const })),
    ];
    let state: PrState = open.state === "done" ? (open.inputs.draft ? "draft" : "open") : "draft";
    if (open.state === "skipped") state = "closed";
    if (merged) state = "merged";
    return {
      repo,
      number,
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

  private async find(repo: string, number: number): Promise<ManualStep> {
    const s = (await this.prSteps(repo)).find((x) => x.inputs.number === number);
    return s ?? this.notFound(`PR ${repo}#${number}`, "no manual step opened it");
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequest> {
    this.journal.push({ method: "getPullRequest" });
    return this.toPr(await this.find(repo, number));
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
    const number = Number(open.inputs.number);
    const reports = await this.related(repo, number, "report-pull-request");
    if (reports.some((s) => s.state === "open")) return;
    await this.step("report", {
      slug: `report-pr-${number}`,
      action: "report-pull-request",
      key: `git-host|report|${repo}|${number}|${reports.length}`,
      title: `Record the reviews and checks on PR ${number} (${open.inputs.title})`,
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
    const number = existing.reduce((n, s) => Math.max(n, Number(s.inputs.number)), 0) + 1;
    const change = this.opts.change ?? changeOfBranch(input.head);
    const proc = this.procedureFor("open-pull-request");
    const open = await this.step(
      "createPullRequest",
      {
        slug: `open-pr-${input.head}`,
        action: "open-pull-request",
        key: `git-host|pr|${input.repo}|${input.head}|${number}`,
        title: `Open a pull request from ${input.head} into ${input.base}`,
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
        slug: `comment-pr-${number}`,
        action: "comment-pull-request",
        key: `git-host|comment|${repo}|${number}|${shortHash(body)}`,
        title: `Post a comment on PR ${number} (${open.inputs.title})`,
        where: `Git host: ${repo}, the pull request opened for step ${open.id}`,
        ...(change ? { change } : {}),
        inputs: { repo, number },
        fields: [{ name: "Comment", value: body }],
        instructions: ["Post the comment below on the pull request."],
        dependsOn: [open.id],
      },
      a,
    );
    // A comment means the PR was updated or returned: reviews must be reported again.
    if ((await this.toPr(open)).state !== "merged") await this.askForReviews(open, change);
  }

  async merge(repo: string, number: number, approval: Approval): Promise<PullRequest> {
    const a = this.approve(approval);
    const open = await this.find(repo, number);
    const pr = await this.toPr(open);
    if (pr.state === "merged") return pr;
    const blockers = mergeBlockers(pr);
    if (blockers.length > 0)
      throw new AdapterError(this.name, "conflict", `can't merge: ${blockers.join("; ")}`);
    const step = await this.step(
      "merge",
      {
        slug: `merge-pr-${number}`,
        action: "merge-pull-request",
        key: `git-host|merge|${repo}|${number}`,
        title: `Merge PR ${number} (${open.inputs.title}) on the Git host`,
        where: `Git host: ${repo}, ${pr.url}`,
        ...(open.change ? { change: open.change } : {}),
        inputs: { repo, number },
        fields: [
          { name: "Pull request", value: pr.url },
          {
            name: "Approved by",
            value: pr.reviews
              .filter((r) => r.state === "approved")
              .map((r) => r.by)
              .join(", "),
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
      `a person merges PR ${number} on the Git host: do step ${step.id} (atticus todo), then sync again`,
      false,
    );
  }
}
