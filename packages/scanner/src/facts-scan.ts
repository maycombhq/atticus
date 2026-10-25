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
import { factsRecords, targetsFromAnswers } from "./facts-catalog.js";
import { estateRepos } from "./merge-input.js";

/**
 * A scan's use of a repo's verified facts (ADR 0124 §3): when the assistant has read a repo and
 * the verifier kept its facts, the scan takes them over the built-in readers' records, and the
 * readers become a cross-check, said as a note (what they found that the facts don't have).
 * Facts of another commit, or not yet verified, are not used: the readers stand in, and the note
 * says what to run.
 */
export async function factsForScan(
  root: string,
  op: OrgPack,
  repo: string,
  commit: string | undefined,
  readerRecords: readonly CatalogRecord[],
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
  const facts = parsed.facts;
  const stale = commit
    ? facts.find((f) => !commit.startsWith(f.commit) && !f.commit.startsWith(commit))
    : undefined;
  if (stale)
    return {
      note: `${repo}: its facts are of commit ${stale.commit.slice(0, 7)}, the checkout is at ${commit!.slice(0, 7)}; its readers' records are used until it is read again (/atticus-map ${repo}, then atticus verify ${repo} --write).`,
    };
  const unverified = facts.filter((f) => f.verified === "none").length;
  if (unverified)
    return {
      note: `${repo}: ${unverified} of its facts aren't verified yet; its readers' records are used. Run atticus verify ${repo}.`,
    };
  const questions = (await listQuestions(root, { repo }).catch(() => ({ questions: [] })))
    .questions;
  const targets = targetsFromAnswers(repo, facts, questions);
  const { newRecords, facts: used } = factsRecords({ repo, facts, op, targets });

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
    note: `${repo}: read from its facts (${facts.length}, ${rel})${said ? `; its readers found ${said} the facts don't have (a cross-check: read those lines again, or a reader misreads them)` : "; its readers agree"}.`,
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
