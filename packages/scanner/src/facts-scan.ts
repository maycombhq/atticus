import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  conventionsOf,
  effectiveComponentTypes,
  factsDirOf,
  factsRelOf,
  normalizePath,
  pairsFromCorrections,
  parseCorrections,
  keptParse,
  parseFacts,
  type CatalogRecord,
  type PersonPair,
  type Fact,
  type OrgPack,
  stackHelpersOff,
  cmpText,
} from "@maycombhq/core";
import { dirSource, rereadPlan, sameCommit, verifyFacts } from "@maycombhq/verify";
import { changesSince, type GitRunner } from "@maycombhq/workspace";
import { componentRenames, factsRecords, targetsFromAnswers } from "./facts-catalog.js";
import { estateRepos, productionRepos } from "./merge-input.js";
import { joinAnswerQuestions } from "./join-host-questions.js";

/**
 * What a repo's records at a commit rest on (eighth UX walk, rule 4): the assistant's verified
 * facts, or the built-in readers. `unread` lists the source files changed since the facts were
 * read (edited, added or renamed to) that no fact covers yet: only facts with nothing unread
 * can say something is not in the code; elsewhere the records say only what is there.
 */
export type FactBasis = { from: "facts"; unread: string[] } | { from: "readers" };

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
  /** What the records rest on; none when the readers stand in. */
  basis?: FactBasis;
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
  let unread: string[] = [];
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
    const off = stackHelpersOff();
    const report = await verifyFacts({
      facts,
      source: dirSource(at.dir!),
      ...(off.has("derived-names") ? { derivedNames: false } : {}),
      ...(off.has("readers") ? { readers: false } : {}),
      commit: commit!,
      carry: diff.changes,
      conventions: conventionsOf(op),
      // ADR 0180: a type taken out of the organisation's set after a read is flagged here too.
      componentTypes: new Set(effectiveComponentTypes(op.componentTypes).map((t) => t.id)),
    });
    const from = [...new Set(older.map((f) => f.commit.slice(0, 7)))].join(", ");
    if (!report.accepted.length)
      return {
        note: `${repo}: every one of its facts (of commit ${from}) cites a file changed since, or names a fact that does; its readers' records are used until it is read again (/atticus-map ${repo}, then atticus verify ${repo} --write).`,
      };
    // The source files changed since the read: no fact covers what they now say.
    unread = rereadPlan({
      facts,
      commit: commit!,
      carry: diff.changes,
      source: dirSource(at.dir!),
      conventions: conventionsOf(op),
    }).files.map((f) => f.path);
    facts = report.accepted;
    const left = report.rejected.length;
    carriedSaid = `; ${report.carried.length} carried from commit ${from} to ${commit!.slice(0, 7)} (the files they cite are unchanged, their lines checked again)${left ? `, ${left} left out until read again (they cite a file changed since, or name a fact that does: /atticus-map ${repo}, then atticus verify ${repo} --write)` : ""}`;
  }
  // ADR 0153 (Q2): every repo's targets questions, since an answer's rule reaches the repos its
  // scope allows.
  // Beta.24 review: the hosts questions too, whose Ignore leaves the calls on their host.
  const questions = await joinAnswerQuestions(root);
  const targets = targetsFromAnswers(repo, facts, questions, {
    repoType: estateRepos(op).find((r) => r.id === repo)?.type,
  });
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
    .sort((a, b) => cmpText(a[0], b[0]))
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  return {
    records: newRecords,
    facts: used,
    targets,
    basis: { from: "facts", unread },
    note: `${repo}: read from its facts (${facts.length}, ${rel}${carriedSaid})${said ? `; its readers found ${said} the facts don't have (a cross-check: read those lines again, or a reader misreads them)` : "; its readers agree"}.`,
  };
}

/**
 * G1 (ADR 0174): a repo's pairings from its corrections file (`<repo>.corrections.jsonl`), met
 * to its calls as any correction is; none when the file isn't there or has none. Round 48: a
 * call a person said reaches none is kept as `none`, for the join (`pairsFromCorrections`).
 */
export async function pairsOfRepo(
  root: string,
  repo: string,
  facts: readonly Fact[],
): Promise<Record<string, PersonPair>> {
  const text = await readFile(join(factsDirOf(root), `${repo}.corrections.jsonl`), "utf8").catch(
    () => undefined,
  );
  // Round 48: a person's "none" (an unlink) is read too, so an AI answer doesn't join the call.
  if (!text || !/"(?:un)?link"/.test(text)) return {};
  return pairsFromCorrections(facts, parseCorrections(text).corrections, { declined: true });
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
  /** G1 (ADR 0174): the pairings people made on the canvas, by repo and call fact id. */
  pairs: Record<string, Record<string, PersonPair>>;
  notes: string[];
  /** The repos left out as not all verified yet (G1: the Connect panel says verify them first). */
  unverified: string[];
  /** ADR 0181: of the targets, those the AI answered, by repo and call fact id, with the run. */
  aiTargets: Record<string, Record<string, { runtime: string; run: string }>>;
}> {
  const repos: { repo: string; facts: Fact[] }[] = [];
  const targets: Record<string, Record<string, string>> = {};
  const aiTargets: Record<string, Record<string, { runtime: string; run: string }>> = {};
  const pairs: Record<string, Record<string, PersonPair>> = {};
  const notes: string[] = [];
  const unverified: string[] = [];
  // Beta.24 review: the hosts questions too, whose Ignore leaves the calls on their host.
  const questions = await joinAnswerQuestions(root);
  // A prototype's facts are never part of the estate join (ADR 0133).
  for (const r of productionRepos(op)) {
    if (r.id === except) continue;
    // beta.23: each repo's facts parsed once and kept until the file changes (the app works the
    // estate join out again after every answer; a copy, as the join may change what it reads).
    const parsed = await keptParse(
      join(factsDirOf(root), `${r.id}.jsonl`),
      "facts",
      (t) => (t.trim() ? parseFacts(t) : null),
      { copy: true },
    ).catch(() => undefined);
    if (!parsed) continue;
    if (!parsed.ok) {
      notes.push(`${r.id}: its facts don't read, so the estate join leaves them out.`);
      continue;
    }
    if (parsed.facts.some((f) => f.verified === "none")) {
      unverified.push(r.id);
      notes.push(
        `${r.id}: some of its facts aren't verified yet, so the estate join leaves them out (atticus verify ${r.id}).`,
      );
      continue;
    }
    repos.push({ repo: r.id, facts: parsed.facts });
    const ai: Record<string, { runtime: string; run: string }> = {};
    const named = targetsFromAnswers(r.id, parsed.facts, questions, { repoType: r.type, ai });
    if (Object.keys(named).length) targets[r.id] = named;
    if (Object.keys(ai).length) aiTargets[r.id] = ai;
    const paired = await pairsOfRepo(root, r.id, parsed.facts);
    if (Object.keys(paired).length) pairs[r.id] = paired;
  }
  return { repos, targets, pairs, notes, unverified, aiTargets };
}
