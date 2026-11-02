import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { rulesLacking } from "@maycombhq/assistant-files";
import { citedFiles, factsDirOf, factsFileOf, factsRelOf, parseFacts } from "@maycombhq/core";
import { dirSource, rereadPlan, sameCommit } from "@maycombhq/verify";
import { loadRepos, type GitRunner } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { carryOf, checkoutOf, excludesOf } from "./facts-files.js";
import { loadReadPlan } from "./map-parts.js";
import { isMetarepo, notMetarepo } from "./metarepo-guard.js";
import { headFromFiles } from "./ui-api-trust.js";

/**
 * The estate's freshness (plan item P5, ADR 0141): for every repo at once, whether its clone has
 * moved past the commit its facts were read at, and what reading it again costs: the files
 * changed that the facts cite, the facts to read again, the facts carried as they are, and the
 * command to run. It is the per-repo re-read plan (`rereadPlan`, ADR 0124 addendum
 * A-incremental: what `atticus map <repo> --estimate` and `atticus verify` work out) taken over
 * the whole estate. Local clones only: the checkout's HEAD is read from its `.git` files and the
 * changes with `git diff --name-status` between two commits it already has. Nothing is fetched,
 * nothing is written, no model is called.
 */

export const FRESH_STATES = [
  /** Facts cite files that changed, or source files changed: read again. */
  "stale",
  /** The clone doesn't have the commit the facts were read at: they can't be compared. */
  "unknown-commit",
  /** The clone moved, but nothing the facts cite changed and no source file did: carry them. */
  "moved",
  /**
   * ADR 0167: the facts are of the clone's commit, but the read lacked rule sets added since
   * (or recorded none, before 2.0.0-beta.12): a top-up reads the files those sets apply to.
   */
  "rules-changed",
  /** No clone to compare with. */
  "no-checkout",
  /** The facts are of the commit the clone is at. */
  "fresh",
  /** No facts yet: the repo isn't read. */
  "not-read",
] as const;
export type FreshState = (typeof FRESH_STATES)[number];

export interface FreshRepo {
  repo: string;
  state: FreshState;
  /** `facts/<repo>.jsonl`, relative to the root. */
  factsFile: string;
  /** How many facts the file holds. */
  facts: number;
  /** The commits the facts were read at, oldest name first (most facts share one). */
  factsCommits: string[];
  /** The commit the clone is at, when there is a clone. */
  head?: string;
  /** Facts already of the clone's commit. */
  current: number;
  /** Facts whose every cited file is unchanged: kept and carried by atticus verify. */
  carried: number;
  /** Facts citing a file that changed (or of a commit the clone lacks): read again. */
  reread: number;
  /** Files the facts cite that changed since (edited, renamed or deleted). */
  citedChanged: number;
  /** Every file changed since the facts' commits. */
  changed: number;
  /** The source files a re-read opens (changed and readable, in reading order). */
  toRead: number;
  /** The commits the clone doesn't have. */
  unknown: string[];
  /** ADR 0167: the rule sets the read lacks (`rules-changed`). */
  rulesLacking?: string[];
  /** The command to run, absent when the facts are fresh. */
  command?: string;
  /** The assistant's slash command for it, when one does it. */
  slash?: string;
}

export interface FreshView {
  factsDir: string;
  repos: FreshRepo[];
  problems: { file: string; message: string }[];
}

const RANK: Record<FreshState, number> = Object.fromEntries(
  FRESH_STATES.map((s, i) => [s, i]),
) as Record<FreshState, number>;

/** Most stale first: by state, then facts to read again, files cited that changed, files to read. */
export function freshOrder(a: FreshRepo, b: FreshRepo): number {
  return (
    RANK[a.state] - RANK[b.state] ||
    b.reread - a.reread ||
    b.citedChanged - a.citedChanged ||
    b.toRead - a.toRead ||
    b.changed - a.changed ||
    (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0)
  );
}

/** Runs `f` over `xs`, at most `n` at a time, keeping their order. */
async function pool<T, R>(xs: readonly T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(xs.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < xs.length; i = next++) out[i] = await f(xs[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, worker));
  return out;
}

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0]!;

/** One repo's freshness. */
async function freshOf(
  root: string,
  repo: string,
  o: { git?: GitRunner },
  problems: FreshView["problems"],
): Promise<FreshRepo> {
  const factsFile = `${factsRelOf(root)}/${repo}.jsonl`;
  const base = {
    repo,
    factsFile,
    facts: 0,
    factsCommits: [] as string[],
    current: 0,
    carried: 0,
    reread: 0,
    citedChanged: 0,
    changed: 0,
    toRead: 0,
    unknown: [] as string[],
  };
  const read = { command: `atticus map ${repo}`, slash: `/atticus-map ${repo}` };
  const text = await readFile(join(factsDirOf(root), `${repo}.jsonl`), "utf8").catch(
    () => undefined,
  );
  if (text === undefined || !text.trim()) return { ...base, state: "not-read", ...read };
  const parsed = parseFacts(text);
  if (!parsed.ok) {
    problems.push({
      file: factsFile,
      message: `doesn't read as facts: ${parsed.issues[0]?.message ?? "invalid"}`,
    });
    return { ...base, state: "not-read", ...read };
  }
  const facts = parsed.facts;
  const commits = [...new Set(facts.map((f) => f.commit))].sort();
  const counted = { ...base, facts: facts.length, factsCommits: commits };
  const dir = await checkoutOf(root, repo).catch(() => undefined);
  const head = dir ? await headFromFiles(dir) : undefined;
  if (!dir || !head) return { ...counted, state: "no-checkout", command: "atticus workspace sync" };
  const at = { ...counted, head };
  if (facts.every((f) => sameCommit(f.commit, head))) {
    // ADR 0167: fresh by commit; read under the rules there are now, or topped up for them.
    const lacking = rulesLacking((await loadReadPlan(root, repo).catch(() => undefined))?.rules);
    return lacking.length
      ? {
          ...at,
          state: "rules-changed",
          current: facts.length,
          rulesLacking: lacking,
          command: `atticus map ${repo} --rules`,
          slash: `/atticus-map ${repo} --rules`,
        }
      : { ...at, state: "fresh", current: facts.length };
  }
  let carry;
  try {
    carry = await carryOf(dir, facts, head, o.git);
  } catch (e) {
    problems.push({
      file: factsFile,
      message: `git couldn't compare the commits: ${firstLine(e)}`,
    });
    return { ...at, state: "unknown-commit", unknown: commits, reread: facts.length, ...read };
  }
  const plan = rereadPlan({
    facts,
    commit: head,
    carry: carry.carry,
    source: dirSource(dir),
    exclude: await excludesOf(root, repo),
  });
  // A fact of a commit the clone lacks is read again whole, as `atticus map` does.
  const unknown = [...new Set([...plan.unknown, ...carry.missing])].sort();
  const lost = facts.filter((f) => unknown.some((c) => sameCommit(c, f.commit))).length;
  // The files the facts (of a commit the clone has) cite that changed since.
  const changedPaths = new Set<string>();
  for (const cs of Object.values(carry.carry))
    for (const c of cs) {
      changedPaths.add(c.path);
      if (c.from) changedPaths.add(c.from);
    }
  const cited = new Set<string>();
  for (const f of facts) {
    if (sameCommit(f.commit, head) || unknown.some((c) => sameCommit(c, f.commit))) continue;
    for (const p of citedFiles(f)) if (changedPaths.has(p)) cited.add(p);
  }
  const changed = new Set(Object.values(carry.carry).flatMap((cs) => cs.map((c) => c.path))).size;
  const out = {
    ...at,
    current: plan.current,
    carried: plan.carried,
    reread: plan.reread.length + lost,
    citedChanged: cited.size,
    changed,
    toRead: plan.files.length,
    unknown,
  };
  if (unknown.length) return { ...out, state: "unknown-commit", command: "atticus workspace sync" };
  if (!out.reread && !out.toRead)
    return { ...out, state: "moved", command: `atticus verify ${repo} --write` };
  return { ...out, state: "stale", ...read };
}

/**
 * Every repo's freshness, most stale first: the manifests' repos and any repo the facts folder
 * names that no manifest lists. Clones are compared a few at a time.
 */
export async function estateFreshness(
  root: string,
  o: { git?: GitRunner; repos?: readonly string[] } = {},
): Promise<FreshView> {
  const problems: FreshView["problems"] = [];
  const ids: string[] = [];
  try {
    for (const r of await loadRepos(root)) if (!r.archived) ids.push(r.id);
  } catch (e) {
    problems.push({ file: "org-pack/profiles", message: firstLine(e) });
  }
  for (const n of (await readdir(factsDirOf(root)).catch(() => [] as string[])).sort()) {
    const of = factsFileOf(n);
    if (of?.facts && !ids.includes(of.repo)) ids.push(of.repo);
  }
  const want = o.repos ? ids.filter((id) => o.repos!.includes(id)) : ids;
  const repos = await pool(want, 4, (id) => freshOf(root, id, o, problems));
  return { factsDir: factsRelOf(root), repos: repos.sort(freshOrder), problems };
}

const short = (c: string) => c.slice(0, 12);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The facts' commit in words: the one commit, or the oldest and how many more. */
export const factsCommitWords = (r: Pick<FreshRepo, "factsCommits">) =>
  r.factsCommits.length === 0
    ? "-"
    : r.factsCommits.length === 1
      ? short(r.factsCommits[0]!)
      : `${short(r.factsCommits[0]!)} +${r.factsCommits.length - 1}`;

/** Why a repo is in its state, in a sentence. */
export function freshWhy(r: FreshRepo): string {
  switch (r.state) {
    case "stale":
      return `${plural(r.reread, "fact")} to read again (${plural(r.citedChanged, "file")} they cite changed), ${r.carried} carried as they are; ${plural(r.toRead, "source file")} to read.`;
    case "unknown-commit":
      return `The clone doesn't have ${r.unknown.map(short).join(", ")}, the commit the facts were read at: sync it, or read the repo again whole.`;
    case "moved":
      return `The clone moved, but nothing the facts cite changed and no source file did: verify carries all ${plural(r.carried + r.current, "fact")}.`;
    case "rules-changed":
      return `Its facts are of the clone's commit, but it was read before these reading rules: ${(r.rulesLacking ?? []).join(", ")}. A top-up reads only the files they apply to.`;
    case "no-checkout":
      return "No clone to compare the facts with.";
    case "fresh":
      return "The facts are of the commit the clone is at.";
    default:
      return "Not read yet.";
  }
}

/** atticus estate fresh [--json]: every repo's freshness, most stale first. */
export async function estateFresh(
  root: string,
  o: { json?: boolean; all?: boolean; git?: GitRunner },
  io: Output,
): Promise<number> {
  if (!isMetarepo(root)) {
    io.err(notMetarepo(root));
    return 2;
  }
  const v = await estateFreshness(root, o.git ? { git: o.git } : {});
  if (o.json) {
    io.out(JSON.stringify(v, null, 2));
    return 0;
  }
  for (const p of v.problems) io.err(`Couldn't read ${p.file}: ${p.message}`);
  const read = v.repos.filter((r) => r.state !== "not-read");
  if (!read.length) {
    io.out(
      v.repos.length
        ? `No repo is read yet, so none can be stale: atticus next says which to read first.`
        : "No repo is listed yet: atticus next says how to start.",
    );
    return 0;
  }
  const stale = read.filter((r) => r.state !== "fresh");
  const moved = stale.filter((r) => r.state !== "rules-changed");
  const rules = stale.length - moved.length;
  const facts = moved.reduce((n, r) => n + r.reread, 0);
  if (moved.length || !rules)
    io.out(
      moved.length
        ? `${plural(moved.length, "repo")} of ${read.length} read ${moved.length === 1 ? "has" : "have"} moved past ${moved.length === 1 ? "its" : "their"} facts' commit: ${plural(facts, "fact")} to read again. Most stale first:`
        : `All ${plural(read.length, "repo")} read are fresh: each one's facts are of the commit its clone is at.`,
    );
  // ADR 0167: fresh by commit, read before reading rules added since.
  if (rules)
    io.out(
      `${plural(rules, "repo")} of ${read.length} read ${rules === 1 ? "was" : "were"} read before reading rules added since: atticus map --all --stale tops ${rules === 1 ? "it" : "them"} up, reading only the files the new rules apply to.`,
    );
  const shown = o.all ? read : stale;
  if (shown.length) {
    const rows = shown.map((r) => [
      r.repo,
      r.state,
      factsCommitWords(r),
      r.head ? short(r.head) : "-",
      String(r.citedChanged),
      String(r.reread),
      r.command ?? "",
    ]);
    const head = ["repo", "state", "facts at", "clone at", "cited changed", "to read again", "run"];
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((x) => x[i]!.length)));
    const line = (cells: string[]) =>
      cells
        .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(w[i]!)))
        .join("  ")
        .trimEnd();
    io.out(line(head));
    for (const r of rows) io.out(line(r));
    for (const r of shown.filter((x) => x.state !== "fresh")) io.out(`  ${r.repo}: ${freshWhy(r)}`);
  }
  const fresh = read.length - stale.length;
  if (fresh && !o.all && stale.length)
    io.out(`${plural(fresh, "repo")} fresh (--all lists them too).`);
  const unread = v.repos.length - read.length;
  if (unread)
    io.out(`${plural(unread, "repo")} not read yet: atticus next says which to read first.`);
  return 0;
}
