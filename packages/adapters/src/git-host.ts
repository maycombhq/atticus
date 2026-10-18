import { AdapterError, MockBase, requireApproval, type Approval } from "./common.js";

/** GitHub, Azure Repos, GitLab, Bitbucket: pull requests and their reviews and checks. */
export type PrState = "draft" | "open" | "merged" | "closed";

export interface PullRequest {
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  head: string;
  base: string;
  state: PrState;
  reviews: { by: string; state: "approved" | "changes-requested" | "commented" }[];
  checks: { name: string; status: "pending" | "passed" | "failed" }[];
  /** Code owners whose approval the host requires. */
  requiredReviewers: string[];
}

export interface RepoInfo {
  repo: string;
  defaultBranch: string;
  protectedBranches: string[];
}

export interface GitHost {
  getRepo(repo: string): Promise<RepoInfo>;
  getPullRequest(repo: string, number: number): Promise<PullRequest>;
  listPullRequests(repo: string, q: { head?: string; state?: PrState }): Promise<PullRequest[]>;
  createPullRequest(
    input: {
      repo: string;
      head: string;
      base: string;
      title: string;
      body: string;
      draft?: boolean;
    },
    approval: Approval,
  ): Promise<PullRequest>;
  comment(repo: string, number: number, body: string, approval: Approval): Promise<void>;
  /**
   * Merge once the host's required approvals are in (hand-off PRs auto-merge on CODEOWNERS
   * approval). Refused while required reviewers haven't approved, changes are requested, or
   * a check is failing or pending.
   */
  merge(repo: string, number: number, approval: Approval): Promise<PullRequest>;
  /**
   * Close a PR without merging it (Return to PO). Returns the PR as the host now has it: a
   * host where a person closes PRs (the manual host) returns it still open until they do.
   * Optional, so Git host plugins written before it still conform (ADR 0041); callers fall
   * back to a comment asking a person to close the PR.
   */
  closePullRequest?(repo: string, number: number, approval: Approval): Promise<PullRequest>;
}

/** Whether a PR may be merged, and why not. Shared by mocks and real adapters. */
export function mergeBlockers(pr: PullRequest): string[] {
  const out: string[] = [];
  if (pr.state === "merged" || pr.state === "closed") out.push(`the PR is ${pr.state}`);
  if (pr.state === "draft") out.push("the PR is a draft");
  const latest = new Map<string, string>();
  for (const r of pr.reviews) if (r.state !== "commented") latest.set(r.by, r.state);
  if ([...latest.values()].includes("changes-requested")) out.push("changes are requested");
  const missing = pr.requiredReviewers.filter((r) => latest.get(r) !== "approved");
  if (pr.requiredReviewers.length > 0 && missing.length === pr.requiredReviewers.length) {
    out.push(`needs approval from ${pr.requiredReviewers.join(" or ")}`);
  }
  if (pr.requiredReviewers.length === 0 && ![...latest.values()].includes("approved"))
    out.push("needs at least one approval");
  const failing = pr.checks
    .filter((c) => c.status !== "passed")
    .map((c) => `${c.name} ${c.status}`);
  if (failing.length > 0) out.push(`checks not passing: ${failing.join(", ")}`);
  return out;
}

export class MockGitHost extends MockBase implements GitHost {
  private repos = new Map<string, RepoInfo>();
  private prs = new Map<string, PullRequest>();
  private numbers = new Map<string, number>();

  constructor(
    repos: { repo: string; defaultBranch?: string; protectedBranches?: string[] }[] = [],
  ) {
    super("git-host");
    for (const r of repos) {
      const defaultBranch = r.defaultBranch ?? "main";
      this.repos.set(r.repo, {
        repo: r.repo,
        defaultBranch,
        protectedBranches: r.protectedBranches ?? [defaultBranch],
      });
    }
  }

  private key = (repo: string, n: number) => `${repo}#${n}`;

  async getRepo(repo: string) {
    this.call("getRepo", [repo]);
    return { ...(this.repos.get(repo) ?? this.notFound(`repo ${repo}`)) };
  }

  async getPullRequest(repo: string, number: number) {
    this.call("getPullRequest", [repo, number]);
    return structuredClone(
      this.prs.get(this.key(repo, number)) ?? this.notFound(`PR ${repo}#${number}`),
    );
  }

  async listPullRequests(repo: string, q: { head?: string; state?: PrState }) {
    this.call("listPullRequests", [repo, q]);
    return [...this.prs.values()]
      .filter(
        (p) =>
          p.repo === repo && (!q.head || p.head === q.head) && (!q.state || p.state === q.state),
      )
      .map((p) => structuredClone(p));
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
  ) {
    const a = requireApproval(this.name, approval);
    this.call("createPullRequest", [input], a);
    const info = this.repos.get(input.repo) ?? this.notFound(`repo ${input.repo}`);
    if (info.protectedBranches.includes(input.head)) {
      throw new AdapterError(
        this.name,
        "invalid",
        `${input.head} is protected and can't be a PR's source branch`,
      );
    }
    if (
      [...this.prs.values()].some(
        (p) =>
          p.repo === input.repo &&
          p.head === input.head &&
          (p.state === "open" || p.state === "draft"),
      )
    ) {
      throw new AdapterError(this.name, "conflict", `an open PR from ${input.head} already exists`);
    }
    const n = (this.numbers.get(input.repo) ?? 0) + 1;
    this.numbers.set(input.repo, n);
    const pr: PullRequest = {
      repo: input.repo,
      number: n,
      url: `https://git.example.com/${input.repo}/pull/${n}`,
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      state: input.draft ? "draft" : "open",
      reviews: [],
      checks: [],
      requiredReviewers: [],
    };
    this.prs.set(this.key(input.repo, n), pr);
    return structuredClone(pr);
  }

  async comment(repo: string, number: number, body: string, approval: Approval) {
    const a = requireApproval(this.name, approval);
    this.call("comment", [repo, number, body], a);
    if (!this.prs.has(this.key(repo, number))) this.notFound(`PR ${repo}#${number}`);
  }

  async merge(repo: string, number: number, approval: Approval) {
    const a = requireApproval(this.name, approval);
    this.call("merge", [repo, number], a);
    const pr = this.prs.get(this.key(repo, number)) ?? this.notFound(`PR ${repo}#${number}`);
    const blockers = mergeBlockers(pr);
    if (blockers.length > 0)
      throw new AdapterError(this.name, "conflict", `can't merge: ${blockers.join("; ")}`);
    pr.state = "merged";
    return structuredClone(pr);
  }

  async closePullRequest(repo: string, number: number, approval: Approval) {
    const a = requireApproval(this.name, approval);
    this.call("closePullRequest", [repo, number], a);
    const pr = this.prs.get(this.key(repo, number)) ?? this.notFound(`PR ${repo}#${number}`);
    if (pr.state === "merged")
      throw new AdapterError(this.name, "conflict", `PR ${number} is merged and can't be closed`);
    pr.state = "closed";
    return structuredClone(pr);
  }

  /** Test helpers: what reviewers and CI would do on the host. */
  review(
    repo: string,
    number: number,
    by: string,
    state: "approved" | "changes-requested" | "commented",
  ): void {
    (this.prs.get(this.key(repo, number)) ?? this.notFound(`PR ${repo}#${number}`)).reviews.push({
      by,
      state,
    });
  }
  setChecks(repo: string, number: number, checks: PullRequest["checks"]): void {
    (this.prs.get(this.key(repo, number)) ?? this.notFound(`PR ${repo}#${number}`)).checks = checks;
  }
  requireReviewers(repo: string, number: number, reviewers: string[]): void {
    (
      this.prs.get(this.key(repo, number)) ?? this.notFound(`PR ${repo}#${number}`)
    ).requiredReviewers = reviewers;
  }
  markReady(repo: string, number: number): void {
    const pr = this.prs.get(this.key(repo, number)) ?? this.notFound(`PR ${repo}#${number}`);
    if (pr.state === "draft") pr.state = "open";
  }
}
