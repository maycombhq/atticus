import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { parseFacts } from "./facts.js";
import { factsDirOf, isAdopted } from "./metarepo.js";
import type { Fact, FactOf } from "./schema/facts.js";
import type { Question } from "./schema/question.js";
import { hostOfQuestion, HOSTS_STEP } from "./host-questions.js";

/**
 * How far a repo's read can be trusted, from its files only (ADR 0140, P4): its facts
 * (`facts/<repo>.jsonl`), the verifier's report beside them (`<repo>.verify.yaml`) and the
 * checkout's HEAD read from its `.git` files (no git runs). The critic reads it so a change that
 * rests on a stale or incomplete read says so; the Map's Trust tab says the same in more detail.
 */

const FULL_SHA = /^[0-9a-f]{40,64}$/;
const text = (p: string) => readFile(p, "utf8").catch(() => undefined);

/**
 * The commit a checkout is at, read from its `.git` files: HEAD, a loose ref or packed-refs,
 * following a worktree's `gitdir:` and `commondir`. Undefined when there is no checkout.
 */
export async function headFromFiles(dir: string): Promise<string | undefined> {
  let git = join(dir, ".git");
  const st = await stat(git).catch(() => undefined);
  if (!st) return undefined;
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec((await text(git)) ?? "");
    if (!m) return undefined;
    git = resolve(dir, m[1]!.trim());
  }
  const common = (await text(join(git, "commondir")))?.trim();
  const commonDir = common ? resolve(git, common) : git;
  const head = ((await text(join(git, "HEAD"))) ?? "").trim();
  if (FULL_SHA.test(head)) return head;
  const ref = /^ref:\s*(refs\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
  if (!ref || ref.split("/").includes("..")) return undefined;
  for (const d of [git, commonDir]) {
    const loose = ((await text(join(d, ...ref.split("/")))) ?? "").trim();
    if (FULL_SHA.test(loose)) return loose;
  }
  for (const line of ((await text(join(commonDir, "packed-refs"))) ?? "").split(/\r?\n/)) {
    const [sha, name] = line.split(" ");
    if (name === ref && sha && FULL_SHA.test(sha)) return sha;
  }
  return undefined;
}

/** Where a repo is checked out: the metarepo's workspace/<repo>, or the repo itself when adopted. */
export const checkoutDirOf = (root: string, repo: string): string =>
  isAdopted(root) ? root : join(root, "workspace", repo);

/**
 * not-read: no facts and no verifier's report (a repo the readers alone mapped, or none);
 * stale: the facts were read at another commit than the checkout is at; incomplete: facts were
 * rejected, some aren't verified, there is no verifier's report, or files went unread; read: none
 * of these.
 */
export type RepoReadState = "not-read" | "stale" | "incomplete" | "read";

export interface RepoRead {
  repo: string;
  state: RepoReadState;
  /** Why it is stale or incomplete, in words a person reads; empty when it is read. */
  why: string[];
  /** The command that reads it again or checks it. */
  next?: string;
  /** The commit its facts were read at, and the checkout's. */
  commit?: string;
  head?: string;
  /** Its facts, for the questions that cite their lines. */
  facts: Fact[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The read of one repo (see `RepoRead`). Never throws: an unreadable file is a reason. */
export async function repoReadOf(root: string, repo: string): Promise<RepoRead> {
  const dir = factsDirOf(root);
  const raw = await text(join(dir, `${repo}.jsonl`));
  const reportText = await text(join(dir, `${repo}.verify.yaml`));
  if (raw === undefined && reportText === undefined)
    return { repo, state: "not-read", why: [], facts: [] };
  const why: string[] = [];
  let facts: Fact[] = [];
  if (raw !== undefined && raw.trim()) {
    const parsed = parseFacts(raw);
    if (parsed.ok) {
      facts = parsed.facts;
      // Beta.25 (ADR 0192 addendum): a fact of a kind this version doesn't know is a newer
      // Atticus's, left out and said, as the catalog says of a record a newer one wrote.
      const newer = parsed.newer ?? [];
      if (newer.length)
        why.push(
          `${plural(newer.length, "fact")} ${newer.length === 1 ? "is" : "are"} written by a newer Atticus (fact kind ${[...new Set(newer.map((n) => n.kind))].sort().join(", ")}); install it to read ${newer.length === 1 ? "it" : "them"}`,
        );
    } else why.push(`its facts file doesn't read as facts`);
  }
  let report:
    { rejected?: unknown; commit?: unknown; coverage?: { unknown?: unknown } } | null | undefined;
  try {
    report = reportText === undefined ? undefined : (parse(reportText) as typeof report);
  } catch {
    why.push("the verifier's report can't be read");
  }
  const commit =
    (typeof report?.commit === "string" ? report.commit : undefined) ?? facts[0]?.commit;
  const head = await headFromFiles(checkoutDirOf(root, repo));
  const stale =
    !!commit && !!head && !(commit.startsWith(head) || head.startsWith(commit))
      ? [`its facts were read at ${commit.slice(0, 7)} and the checkout is at ${head.slice(0, 7)}`]
      : [];
  if (reportText === undefined) why.push("nobody has run the verifier on its facts");
  const rejected = typeof report?.rejected === "number" ? report.rejected : 0;
  if (rejected > 0) why.push(`the verifier rejected ${plural(rejected, "fact")}`);
  const unverified = facts.filter((f) => f.verified === "none").length;
  if (unverified > 0 && reportText !== undefined)
    why.push(`${plural(unverified, "fact")} ${unverified === 1 ? "isn't" : "aren't"} verified`);
  const unknown = Array.isArray(report?.coverage?.unknown) ? report.coverage.unknown.length : 0;
  if (unknown > 0)
    why.push(`${plural(unknown, "file")} ${unknown === 1 ? "wasn't" : "weren't"} read`);
  const state: RepoReadState = stale.length ? "stale" : why.length ? "incomplete" : "read";
  return {
    repo,
    state,
    why: [...stale, ...why],
    ...(state === "read"
      ? {}
      : {
          next:
            state === "incomplete" && reportText === undefined
              ? `atticus verify ${repo}`
              : `atticus map ${repo}`,
        }),
    ...(commit ? { commit } : {}),
    ...(head ? { head } : {}),
    facts,
  };
}

/**
 * The steps whose questions are about a link (ADR 0140): which repo or system answers a call
 * (`facts-targets`, scanner's TARGETS_STEP; `estate-targets`, the estate join's) and which repo
 * answers on a host (`scan-hosts`). Their answers join calls.
 */
export const LINK_QUESTION_STEPS: ReadonlySet<string> = new Set([
  "facts-targets",
  "estate-targets",
  HOSTS_STEP,
]);

export const isLinkQuestion = (q: Pick<Question, "askedBy">): boolean =>
  LINK_QUESTION_STEPS.has(q.askedBy.step);

/** A call fact's host and port as a hosts question names it. */
const hostOf = (f: FactOf<"call">) => f.host?.toLowerCase();

/**
 * The calls a link question asks about: a targets question's are the call facts of its repo on
 * the lines it cites (one per call, a group's every call, Q1); a hosts question's are every call
 * to its host, in any repo (its evidence cites only the first few). `facts` are the facts by repo.
 */
export function callsOfQuestion(
  q: Pick<Question, "askedBy" | "repo" | "evidence" | "question">,
  facts: ReadonlyMap<string, readonly Fact[]>,
): FactOf<"call">[] {
  if (!isLinkQuestion(q)) return [];
  const calls = (repo: string) =>
    (facts.get(repo) ?? []).filter((f): f is FactOf<"call"> => f.kind === "call");
  const cited = new Set(q.evidence);
  const out = new Map<string, FactOf<"call">>();
  for (const f of calls(q.repo)) if (cited.has(`${f.cite.file}:${f.cite.line}`)) out.set(f.id, f);
  const host = q.askedBy.step === HOSTS_STEP ? hostOfQuestion(q)?.toLowerCase() : undefined;
  if (host)
    for (const [, fs] of facts)
      for (const f of fs)
        if (
          f.kind === "call" &&
          hostOf(f) &&
          (hostOf(f) === host || host.startsWith(`${hostOf(f)}:`))
        )
          out.set(f.id, f);
  return [...out.values()];
}
