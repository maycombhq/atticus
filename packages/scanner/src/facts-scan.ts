import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  factsDirOf,
  pairsFromCorrections,
  parseCorrections,
  keptParse,
  parseFacts,
  type PersonPair,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import { targetsFromAnswers } from "./facts-catalog.js";
import { productionRepos } from "./merge-input.js";
import { joinAnswerQuestions } from "./join-host-questions.js";

/**
 * What a repo's records at a commit rest on (eighth UX walk, rule 4): the assistant's verified
 * facts, or the built-in readers. `unread` lists the source files changed since the facts were
 * read (edited, added or renamed to) that no fact covers yet: only facts with nothing unread
 * can say something is not in the code; elsewhere the records say only what is there.
 */
export type FactBasis = { from: "facts"; unread: string[] } | { from: "readers" };

/*
 * ADR 0195 (CS2): `factsForScan`, the scan's own use of the live facts files (with its carry of
 * facts of an earlier commit), is gone. A repo's facts reach the catalog only from its facts
 * snapshot, which only a successful `atticus verify <repo> --write` takes; the build projects
 * every snapshot at once (build-facts.ts).
 */

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
