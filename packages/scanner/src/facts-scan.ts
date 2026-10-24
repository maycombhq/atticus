import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  factsDirOf,
  factsRelOf,
  listQuestions,
  normalizePath,
  parseFacts,
  type CatalogRecord,
  type OrgPack,
} from "@maycombhq/core";
import { factsRecords, targetsFromAnswers } from "./facts-catalog.js";

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
): Promise<{ records?: CatalogRecord[]; note?: string }> {
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
  const { newRecords } = factsRecords({ repo, facts, op, targets });

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
    note: `${repo}: read from its facts (${facts.length}, ${rel})${said ? `; its readers found ${said} the facts don't have (a cross-check: read those lines again, or a reader misreads them)` : "; its readers agree"}.`,
  };
}
