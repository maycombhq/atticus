import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  factsDirOf,
  factsRelOf,
  listQuestions,
  normalizePath,
  parseFacts,
  type CatalogRecord,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import { dirSource, sameCommit, verifyFacts } from "@maycombhq/verify";
import { changesSince, type GitRunner } from "@maycombhq/workspace";
import { componentRenames, factsRecords, targetsFromAnswers } from "./facts-catalog.js";
import { estateRepos } from "./merge-input.js";

/**
 * A scan's use of a repo's verified facts (ADR 0124 §3): when the assistant has read a repo and
 * the verifier kept its facts, the scan takes them over the built-in readers' records, and the
 * readers become a cross-check, said as a note (what they found that the facts don't have).
 * Facts not yet verified are not used: the readers stand in, and the note says what to run.
 *
 * Facts of an earlier commit (the checkout moved since the read) are carried to this one where
 * every file they cite is unchanged since, with their lines checked again in the checkout, as
 * `atticus verify` carries them (ADR 0124 addendum A-incremental); the facts citing a changed
 * file, and those naming one, are left out until the repo is read again, and the note says how
 * many of each. Only when the two commits can't be compared (no checkout, or a clone without
 * the facts' commit) do the readers stand in.
 */
export async function factsForScan(
  root: string,
  op: OrgPack,
  repo: string,
  commit: string | undefined,
  readerRecords: readonly CatalogRecord[],
  /** The checkout (to compare commits and check carried lines in) and the git runner to use. */
  at: { dir?: string; git?: GitRunner } = {},
): Promise<{
  records?: CatalogRecord[];
  note?: string;
  /** The facts used (with the manifest's component), and the targets people named, for the estate join. */
  facts?: Fact[];
  targets?: Record<string, string>;
}> {
  const rel = `${factsRelOf(root)}/${repo}.jsonl`;
  const text = await readFile(join(factsDirOf(root), `${repo}.jsonl`), "utf8").catch(
    () => undefined,
  );
  if (text === undefined || text.trim() === "") return {};
  const parsed = parseFacts(text);
  if (!parsed.ok)
    return {
      note: `${repo}: ${rel} doesn't read as facts (${parsed.issues[0]?.message ?? "invalid"}); its readers' records are used. Run atticus verify ${repo}.`,
    };
  let facts = parsed.facts;
  const unverified = facts.filter((f) => f.verified === "none").length;
  if (unverified)
    return {
      note: `${repo}: ${unverified} of its facts aren't verified yet; its readers' records are used. Run atticus verify ${repo}.`,
    };
  const older = commit ? facts.filter((f) => !sameCommit(f.commit, commit)) : [];
  let carriedSaid = "";
  if (older.length) {
    const diff = at.dir
      ? await changesSince(
          at.dir,
          older.map((f) => f.commit),
          commit!,
          at.git,
        )
      : undefined;
    if (!diff || diff.missing.length)
      return {
        note: `${repo}: its facts are of commit ${(diff?.missing[0] ?? older[0]!.commit).slice(0, 7)}, the checkout is at ${commit!.slice(0, 7)}, and the two can't be compared here; its readers' records are used until it is read again (/atticus-map ${repo}, then atticus verify ${repo} --write).`,
      };
    // A changed file invalidates only what cites it: the rest are carried, their lines checked.
    const report = await verifyFacts({
      facts,
      source: dirSource(at.dir!),
      commit: commit!,
      carry: diff.changes,
    });
    const from = [...new Set(older.map((f) => f.commit.slice(0, 7)))].join(", ");
    if (!report.accepted.length)
      return {
        note: `${repo}: every one of its facts (of commit ${from}) cites a file changed since, or names a fact that does; its readers' records are used until it is read again (/atticus-map ${repo}, then atticus verify ${repo} --write).`,
      };
    facts = report.accepted;
    const left = report.rejected.length;
    carriedSaid = `; ${report.carried.length} carried from commit ${from} to ${commit!.slice(0, 7)} (the files they cite are unchanged, their lines checked again)${left ? `, ${left} left out until read again (they cite a file changed since, or name a fact that does: /atticus-map ${repo}, then atticus verify ${repo} --write)` : ""}`;
  }
  const questions = (await listQuestions(root, { repo }).catch(() => ({ questions: [] })))
    .questions;
  const targets = targetsFromAnswers(repo, facts, questions);
  // B-fixes, problem 1: a component another repo's facts have too gets an estate-unique id,
  // as verify --write gives it.
  const others = (await estateFacts(root, op, repo)).repos;
  const renames = componentRenames([{ repo, facts }, ...others], op);
  const { newRecords, facts: used } = factsRecords({ repo, facts, op, targets, renames });

  // The cross-check: what the readers found that the facts don't have, by what each names.
  const keyOf = (r: CatalogRecord): string | undefined => {
    const x = r as unknown as Record<string, unknown>;
    if (r.kind === "Endpoint")
      return `${String(x.method ?? "").toUpperCase()} ${normalizePath(String(x.pathOrTopic))}`;
    if (r.kind === "Interface")
      return `${String(x.method ?? "").toUpperCase()} ${String(x.normalizedPath)}`;
    if (r.kind === "Table") return String(x.name).toLowerCase();
    if (r.kind === "Column")
      return `${String(x.table).split(".").pop()}.${String(x.name)}`.toLowerCase();
    if (r.kind === "Setting") return String(x.key);
    return undefined;
  };
  const have = new Set(newRecords.map((r) => `${r.kind}|${keyOf(r)}`));
  const extra = new Map<string, number>();
  for (const r of readerRecords) {
    const k = keyOf(r);
    if (k === undefined || have.has(`${r.kind}|${k}`)) continue;
    extra.set(r.kind, (extra.get(r.kind) ?? 0) + 1);
  }
  const said = [...extra.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  return {
    records: newRecords,
    facts: used,
    targets,
    note: `${repo}: read from its facts (${facts.length}, ${rel}${carriedSaid})${said ? `; its readers found ${said} the facts don't have (a cross-check: read those lines again, or a reader misreads them)` : "; its readers agree"}.`,
  };
}

/**
 * The other repos' facts the estate join reads when a repo is written (ADR 0124, C-join): each
 * repo of the manifests with a facts/<repo>.jsonl that reads and is all verified, and the
 * targets people named for its calls. A facts file that doesn't read, or isn't verified yet, is
 * left out and said, so the join never rests on an unchecked line.
 */
export async function estateFacts(
  root: string,
  op: OrgPack,
  except: string,
): Promise<{
  repos: { repo: string; facts: Fact[] }[];
  targets: Record<string, Record<string, string>>;
  notes: string[];
}> {
  const repos: { repo: string; facts: Fact[] }[] = [];
  const targets: Record<string, Record<string, string>> = {};
  const notes: string[] = [];
  for (const r of estateRepos(op)) {
    if (r.id === except) continue;
    const text = await readFile(join(factsDirOf(root), `${r.id}.jsonl`), "utf8").catch(
      () => undefined,
    );
    if (text === undefined || text.trim() === "") continue;
    const parsed = parseFacts(text);
    if (!parsed.ok) {
      notes.push(`${r.id}: its facts don't read, so the estate join leaves them out.`);
      continue;
    }
    if (parsed.facts.some((f) => f.verified === "none")) {
      notes.push(
        `${r.id}: some of its facts aren't verified yet, so the estate join leaves them out (atticus verify ${r.id}).`,
      );
      continue;
    }
    repos.push({ repo: r.id, facts: parsed.facts });
    const questions = (await listQuestions(root, { repo: r.id }).catch(() => ({ questions: [] })))
      .questions;
    const named = targetsFromAnswers(r.id, parsed.facts, questions);
    if (Object.keys(named).length) targets[r.id] = named;
  }
  return { repos, targets, notes };
}
