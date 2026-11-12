import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  conventionsOf,
  effectiveComponentTypes,
  factsDirOf,
  pairsFromCorrections,
  parseCorrections,
  keptParse,
  parseFacts,
  stackHelpersOff,
  type PersonPair,
  type Fact,
  type FileChange,
  type OrgPack,
} from "@maycombhq/core";
import { dirSource, rereadPlan, sameCommit, verifyFacts } from "@maycombhq/verify";
import { changedFiles, changesSince, createGit, type GitRunner } from "@maycombhq/workspace";
import type { FactsSlotRead } from "./build.js";
import {
  readFactsSlot,
  serializeFactsSlotMeta,
  serializeFactsSnapshot,
  sha256Of,
} from "./slots.js";
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
 * A repo's facts snapshot as it stands at another commit, for a check that writes nothing (the
 * code-against-design check, ADR 0114, on a task branch; scan option `carryFacts`). The catalog
 * keeps the snapshot as verify took it (ADR 0195 point 2); a check of the code at a later commit
 * can't let facts citing a file changed since speak for it. So the snapshot's facts are carried
 * to `at.commit` in memory as `atticus verify` carries them (a changed file invalidates only the
 * facts that cite it, the others' lines checked again in the checkout), and `unread` lists the
 * source files changed since that no fact covers now. A snapshot whose commit isn't an ancestor
 * of `at.commit` (verify ran on another branch) is compared from the two commits' merge base:
 * a fact citing a file changed on either side since is left out (the review of beta.27). No slot
 * (the readers stand in) when the two commits can't be compared here or no fact is left.
 * Undefined when there is nothing to carry: no snapshot, one that isn't current, or one of this
 * very commit. `exclude` is the repo's scan settings' excluded paths (globs): a file the scan
 * doesn't read is never listed unread.
 */
export async function factsSlotAt(
  root: string,
  op: OrgPack,
  repo: string,
  at: { dir: string; commit: string; git?: GitRunner; exclude?: readonly string[] },
): Promise<{ slot?: FactsSlotRead; unread: string[] } | undefined> {
  const snap = await readFactsSlot(root, repo);
  if (!snap?.ok || sameCommit(snap.meta.commit, at.commit)) return undefined;
  let diff =
    snap.meta.commit === "unknown"
      ? undefined
      : await changesSince(at.dir, [snap.meta.commit], at.commit, at.git).catch(() => undefined);
  if (diff?.missing.length)
    diff = await sinceMergeBase(at.dir, snap.meta.commit, at.commit, at.git);
  if (!diff || diff.missing.length) return { unread: [] };
  const exclude = at.exclude ?? [];
  const off = stackHelpersOff();
  const conventions = conventionsOf(op);
  const report = await verifyFacts({
    facts: snap.facts,
    source: dirSource(at.dir),
    ...(off.has("derived-names") ? { derivedNames: false } : {}),
    ...(off.has("readers") ? { readers: false } : {}),
    commit: at.commit,
    carry: diff.changes,
    conventions,
    ...(exclude.length ? { exclude } : {}),
    // ADR 0180: a type taken out of the organisation's set after a read is flagged here too.
    componentTypes: new Set(effectiveComponentTypes(op.componentTypes).map((t) => t.id)),
  });
  if (!report.accepted.length) return { unread: [] };
  const unread = rereadPlan({
    facts: snap.facts,
    commit: at.commit,
    carry: diff.changes,
    source: dirSource(at.dir),
    conventions,
    ...(exclude.length ? { exclude } : {}),
  }).files.map((f) => f.path);
  const text = serializeFactsSnapshot(report.accepted);
  const meta = { ...snap.meta, commit: at.commit, factsHash: sha256Of(text) };
  return {
    slot: {
      ok: true,
      meta,
      facts: report.accepted,
      sha: meta.factsHash,
      metaSha: sha256Of(serializeFactsSlotMeta(meta)),
    },
    unread,
  };
}

/**
 * The files to treat as changed from `from` to `to` when `from` isn't an ancestor of `to` (the
 * review of beta.27): every file changed on either side since their merge base, said as it stands
 * at `to` (a file only the `from` side added is gone at `to`, one it deleted is back), so a fact
 * citing any of them is read again, never carried. Undefined when git can't find a merge base
 * here (a commit the clone doesn't have): the readers stand in, as before.
 */
async function sinceMergeBase(
  dir: string,
  from: string,
  to: string,
  git?: GitRunner,
): Promise<{ changes: Record<string, FileChange[]>; missing: string[] } | undefined> {
  try {
    const run = git ?? createGit({ timeoutMs: 60_000 });
    const base = (await run(["merge-base", from, to], dir)).stdout.trim();
    if (!/^[0-9a-f]{7,64}$/.test(base)) return undefined;
    const [theirs, ours] = await Promise.all([
      changedFiles(dir, base, from, git),
      changedFiles(dir, base, to, git),
    ]);
    return { changes: { [from]: changesOfBothSides(theirs, ours) }, missing: [] };
  } catch {
    return undefined;
  }
}

/**
 * The changes of both sides since a merge base, each as it stands on `ours`' side. Nothing is
 * deduplicated by path: a path both sides touched is stale whichever side's change is read
 * (review of beta.27: an ours-side rename onto a path theirs added hid theirs' change), and an
 * ours-side rename's new path counts as edited too, since the snapshot's file there, if any, is
 * not the one ours renamed into it.
 */
export function changesOfBothSides(
  theirs: readonly FileChange[],
  ours: readonly FileChange[],
): FileChange[] {
  const link = (c: FileChange) => (c.gitlink ? { gitlink: true as const } : {});
  const out: FileChange[] = [...ours];
  for (const c of ours)
    if (c.status === "renamed") out.push({ status: "modified", path: c.path, ...link(c) });
  for (const c of theirs) {
    if (c.status === "added" || c.status === "copied")
      out.push({ status: "deleted", path: c.path, ...link(c) });
    else if (c.status === "deleted") out.push({ status: "added", path: c.path, ...link(c) });
    else if (c.status === "renamed") {
      out.push({ status: "deleted", path: c.path, ...link(c) });
      if (c.from) out.push({ status: "added", path: c.from, ...link(c) });
    } else out.push({ status: "modified", path: c.path, ...link(c) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
  return text ? pairsOfText(text, facts) : {};
}

/**
 * A repo's pairings from its corrections file's text (the build's, from its inputs: a command's
 * corrections not written yet, ADR 0195 point 2, read as the file will be).
 */
export function pairsOfText(text: string, facts: readonly Fact[]): Record<string, PersonPair> {
  // Round 48: a person's "none" (an unlink) is read too, so an AI answer doesn't join the call.
  if (!/"(?:un)?link"/.test(text)) return {};
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
