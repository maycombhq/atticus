import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import {
  linksFor,
  loadOrgPack,
  migrateReadingRulesText,
  orgPackDirOf,
  personEditOfTo,
  ReadingRulesFile,
  writeFileIfUnchanged,
  type Api,
  type Fact,
  type FactCorrection,
  type LearnedFrom,
  type OrgPack,
  type ReadingRule,
} from "@maycombhq/core";
import type { Output } from "./commands.js";
import {
  answeredByPerson,
  correctedRepos,
  correctionsOf,
  decideIn,
  deletedBlocks,
  deletedPairs,
  factsOf,
  inAcpSession,
  type DeletedPair,
} from "./ai-decide.js";
import type { AcpStepRunner } from "./copilot-acp-steps.js";
import { checkoutOf } from "./facts-files.js";
import { ruleMatches } from "./reading-rules.js";

/**
 * ADR 0208 (WP-03), Learn from my corrections: one run over every pairing a person made that no
 * proven rule names yet (a corrected AI pairing or a canvas pairing, never a spread's line or the
 * AI's). For each repo type the assistant is handed each correction with its cited lines and adds
 * draft rules to the type's layer (as `atticus rules draft`). Each draft is re-read on every file
 * its globs name in each corrected repo (as `atticus rules try`); the re-read is verified on its
 * lines, put with every other repo's facts, and the estate join run without the corrected calls'
 * pairings and answers. A rule is written active, for those repos only, when the join itself
 * draws each correction it names, no call a person set changes, and no arrow a person deleted
 * could be drawn again; any other stays a draft saying why.
 */

export interface LearnDeps {
  by: string;
  now?: Date;
  runner?: AcpStepRunner;
  signal?: AbortSignal;
}

type Reason = Api.LearnCorrectionsResultT["draft"][number]["reasons"][number];
interface Correction {
  id: string;
  repo: string;
  c: FactCorrection;
}

/** Files one repo's re-read may take; a rule naming more stays a draft (ADR 0208). */
export const MAX_REREAD = 500;
const idOf = (repo: string, c: FactCorrection) => `${repo} ${c.target.file}:${c.target.line}`;
const quiet: Output = { out: () => undefined, err: () => undefined };

/** Why Learn can't run here, or undefined: it runs the assistant unattended (copilot-acp). */
export const learnRefusal = (op: Pick<OrgPack, "runtime">): string | undefined =>
  decideIn(op.runtime).includes("copilot-acp")
    ? undefined
    : "Learn runs the assistant unattended: runtime.yaml must have AI on and allow copilot-acp with Copilot.";

/** A reason in the command line's words (the app says each from its copy file). */
function words(r: Reason): string {
  const w: Record<Reason["kind"], string> = {
    "not-reproduced": `the estate join doesn't draw ${r.about} from the re-read alone`,
    touched: `it changes the call at ${r.about}, which a person set`,
    deleted: `it could draw again the arrow ${r.about}, which a person deleted`,
    "unresolved-delete": `the deleted arrow ${r.about} names an end Atticus can't tie to a repo, so Learn can't show it stays deleted`,
    "no-files": "it names none of the corrected files",
    "too-many-files": `it names more than ${MAX_REREAD} files in ${r.about}`,
    "no-checkout": `there is no checkout of ${r.about} to re-read`,
    rejected: `the verifier rejected the re-read of ${r.about}`,
  };
  return w[r.kind];
}

export async function learnFromCorrections(
  root: string,
  d: LearnDeps,
  io: Output = quiet,
): Promise<Api.LearnCorrectionsResultT> {
  if (inAcpSession()) throw new Error("Learn is a person's: a Copilot session acts as no one.");
  const op = await loadOrgPack(orgPackDirOf(root));
  const refused = learnRefusal(op);
  if (refused) throw new Error(refused);
  const { estateRepos } = await import("@maycombhq/scanner");
  const { loadDoc, rulesDraftCommand, saveDoc } = await import("./rules-commands.js");
  const typeOf = new Map(estateRepos(op).map((r) => [r.id, r.type] as const));
  const out: Api.LearnCorrectionsResultT = { corrections: 0, active: [], draft: [], untaught: [] };
  const byType = new Map<string, Correction[]>();
  for (const repo of await correctedRepos(root)) {
    const all = await correctionsOf(root, repo);
    for (const c of all) {
      const own = !c.ai && !c.rule && c.action === "link" && c.link?.repo && c.link.entry;
      const cite = { file: c.target.file, line: c.target.line, value: c.target.value };
      if (!own || linksFor({ kind: "call", id: c.fact, cite }, all)[0] !== c) continue;
      const type = typeOf.get(repo);
      if (!type) out.untaught.push({ correction: idOf(repo, c), kind: "no-type" });
      else byType.set(type, [...(byType.get(type) ?? []), { id: idOf(repo, c), repo, c }]);
    }
  }
  const deleted = await deletedPairs(root);
  const at = (d.now ?? new Date()).toISOString();
  for (const [type, found] of byType) {
    const rel = `types/${type}.yaml`;
    const was = await loadDoc(root, rel);
    const fileRel = was.path.slice(root.length + 1).replace(/\\/g, "/");
    const before = ReadingRulesFile.safeParse(was.doc.toJS());
    // "Since the last run": a correction no proven rule names (a failed draft uses none up).
    const proven = new Set(
      (before.success ? before.data.rules : []).flatMap((r) =>
        r.learned?.proof ? r.learned.corrections : [],
      ),
    );
    const fresh = found.filter((x) => !proven.has(x.id));
    out.corrections += fresh.length;
    if (!fresh.length) continue;
    // 1. The assistant drafts, from each correction with its cited lines (data, never instructions).
    const missed: string[] = [];
    for (const x of fresh) {
      const l = x.c.link!;
      missed.push(
        `${x.id}: the read missed where this call goes; ${x.c.by} paired it with ${l.repo} ${[l.method, l.path].filter(Boolean).join(" ")} (${l.entry}).`,
      );
      const dir = await checkoutOf(root, x.repo).catch(() => undefined);
      const text = dir ? await readFile(join(dir, x.c.target.file), "utf8").catch(() => "") : "";
      const src = text.split(/\r?\n/);
      const line = x.c.target.line;
      for (let n = Math.max(1, line - 2); n <= Math.min(line + 2, src.length); n++)
        missed.push(`  ${n}| ${src[n - 1]}`);
    }
    let run: string | undefined;
    const runner: AcpStepRunner | undefined = d.runner
      ? async (s) => {
          const r = await d.runner!(s);
          run ??= r.runId;
          return r;
        }
      : undefined;
    const said: string[] = [];
    const code = await rulesDraftCommand(
      root,
      {
        type,
        repos: [...new Set(fresh.map((x) => x.repo))].join(","),
        about: `A person corrected these arrows on the map. Work out why each read was wrong and draft reading rules so that a re-read gets each right by itself. Name in \`files\` the files each rule is about: only those are re-read to test it.`,
        missed,
        mode: "copilot-acp",
        ...(runner ? { runner } : {}),
        ...(d.signal ? { signal: d.signal } : {}),
      },
      { out: (l) => (said.push(l), io.out(l)), err: (l) => (said.push(l), io.err(l)) },
    );
    if (code !== 0) throw new Error(said.join(" "));
    const drafted = await loadDoc(root, rel);
    try {
      const had = new Set((before.success ? before.data.rules : []).map((r) => r.key));
      const drafts = ReadingRulesFile.parse(drafted.doc.toJS()).rules.filter(
        (r) => r.status === "draft" && !had.has(r.key),
      );
      const named = new Set<string>();
      const verdicts = new Map<string, LearnedFrom>();
      // 2. Each draft is re-read on the files it names, then checked by the estate join.
      for (const rule of drafts) {
        const mine = fresh.filter((x) => ruleMatches(rule, x.c.target.file));
        for (const x of mine) named.add(x.id);
        const v = mine.length
          ? await proveRule(root, op, rule, mine, deleted, runner, d.signal)
          : { reasons: [{ kind: "no-files" as const }] };
        const why = "reasons" in v ? v.reasons.map(words).join("; ") : "";
        verdicts.set(rule.key, {
          corrections: mine.map((x) => x.id),
          by: d.by,
          at,
          ...(run ? { run } : {}),
          ...("proof" in v ? { proof: v.proof } : { why }),
        });
        if ("proof" in v)
          out.active.push({ key: rule.key, file: fileRel, reproduced: v.proof.reproduced });
        else out.draft.push({ key: rule.key, file: fileRel, reasons: v.reasons, why });
      }
      for (const x of fresh)
        if (!named.has(x.id)) out.untaught.push({ correction: x.id, kind: "not-named" });
      if (!verdicts.size) continue;
      // 3. Written in one change of the layer's file: each draft's verdict, a proven one active.
      const doc = parseDocument(migrateReadingRulesText(drafted.text).text);
      const rules = doc.get("rules");
      for (const item of isSeq(rules) ? rules.items : []) {
        const v = isMap(item) ? verdicts.get(String(item.get("key"))) : undefined;
        if (!v || !isMap(item)) continue;
        item.set("status", v.proof ? "active" : "draft");
        item.set("learned", doc.createNode(v));
      }
      const bad = await saveDoc(drafted.path, doc, drafted.onDisk);
      if (bad) throw new Error(`${fileRel} wouldn't be valid: ${bad}`);
    } catch (e) {
      // A throw or a Stop before the verdicts are written: the drafts go, so a run again
      // doesn't find them twice (only while the file is as the draft left it).
      if (was.onDisk !== undefined)
        await writeFileIfUnchanged(drafted.path, drafted.text, was.onDisk).catch(() => undefined);
      else if ((await readFile(drafted.path, "utf8").catch(() => "")) === drafted.text)
        await rm(drafted.path, { force: true });
      throw e;
    }
  }
  return out;
}

const atOf = (f: { cite: { file: string; line: number } }) => `${f.cite.file}:${f.cite.line}`;

/**
 * Re-read every file a rule names in each corrected repo, verify the re-read on its lines, and
 * run the estate join with it in place of those files' facts and without the corrected calls'
 * pairings and answers: the proof, or the reasons it stays a draft.
 */
async function proveRule(
  root: string,
  op: OrgPack,
  rule: ReadingRule,
  mine: readonly Correction[],
  deleted: readonly DeletedPair[],
  runner: AcpStepRunner | undefined,
  signal: AbortSignal | undefined,
): Promise<{ proof: NonNullable<LearnedFrom["proof"]> } | { reasons: Reason[] }> {
  const unresolved = deleted.find((x) => !x.from || !x.to);
  if (unresolved) return { reasons: [{ kind: "unresolved-delete", about: unresolved.what }] };
  const { branchFactsAt, estateFacts, estateJoinOf } = await import("@maycombhq/scanner");
  const { listFiles } = await import("./reading-rules-files.js");
  const { rereadWith, tryDiff } = await import("./rules-commands.js");
  const estate = await estateFacts(root, op, "");
  // The join as it is, to tell what the re-read changes in it.
  const before = estateJoinOf(op, estate.repos, estate.targets, estate.pairs, estate.aiTargets);
  const reasons: Reason[] = [];
  const reread: string[] = [];
  const repos = [...new Set(mine.map((x) => x.repo))];
  for (const repo of repos) {
    const dir = await checkoutOf(root, repo).catch(() => undefined);
    if (!dir || !runner) return { reasons: [{ kind: "no-checkout", about: repo }] };
    const files = (await listFiles(dir)).filter((p) => ruleMatches(rule, p));
    if (files.length > MAX_REREAD) return { reasons: [{ kind: "too-many-files", about: repo }] };
    const text = await rereadWith(root, { repo, dir, rule, files, runner, signal });
    const onFile = await factsOf(root, repo);
    const own = new Set(
      mine.filter((x) => x.repo === repo).map((x) => `${x.c.target.file}:${x.c.target.line}`),
    );
    // At the commit the corrected calls were read at: the re-read is of the same files.
    const commit = (onFile.find((f) => own.has(atOf(f))) ?? onFile[0])?.commit ?? "HEAD";
    const v = await branchFactsAt(op, text, { dir, commit, context: onFile, repo });
    if (!v || v.rejected || v.problems.length)
      return { reasons: [{ kind: "rejected", about: repo }] };
    reread.push(...files.map((f) => `${repo} ${f}`));
    const readNow = new Set(files);
    const merged = [...onFile.filter((f) => !readNow.has(f.cite.file)), ...v.facts];
    // The corrected calls, by their ids before and after: their pairings and answers left out.
    const ownIds = [...onFile, ...v.facts].filter((f) => f.kind === "call" && own.has(atOf(f)));
    const slot = estate.repos.find((r) => r.repo === repo);
    if (slot) slot.facts = merged;
    else estate.repos.push({ repo, facts: merged });
    for (const m of [estate.pairs, estate.targets, estate.aiTargets])
      for (const f of ownIds) delete m[repo]?.[f.id];
    // No call a person set changes in the re-read.
    const corrections = await correctionsOf(root, repo);
    const byPerson = await answeredByPerson(root, repo, onFile);
    const diff = tryDiff(
      onFile.filter((f) => readNow.has(f.cite.file)),
      v.facts,
    );
    const moved = new Set([...diff.added, ...diff.changed.map((c) => c.now)].map(atOf));
    const tried = new Set(v.facts.map(atOf));
    for (const f of onFile) {
      if (f.kind !== "call" || !readNow.has(f.cite.file) || own.has(atOf(f))) continue;
      const st = linksFor(f, corrections)[0];
      const set = (st && !st.ai) || personEditOfTo(f, corrections) || byPerson.has(f.id);
      if (set && (moved.has(atOf(f)) || !tried.has(atOf(f))))
        reasons.push({ kind: "touched", about: `${repo} ${atOf(f)}` });
    }
  }
  const join = estateJoinOf(
    op,
    estate.repos as { repo: string; facts: Fact[] }[],
    estate.targets,
    estate.pairs,
    estate.aiTargets,
  );
  // Each correction, drawn by the join itself: its entry, by code (no pairing, answer or guess).
  const reproduced = mine
    .filter((x) =>
      join.joins.some(
        (j) =>
          j.call.repo === x.repo &&
          j.call.at === `${x.c.target.file}:${x.c.target.line}` &&
          j.entry.repo === x.c.link!.repo &&
          j.entry.fact === x.c.link!.entry &&
          j.how !== "answer" &&
          !j.paired &&
          !j.aiAnswer &&
          !j.aiHop &&
          !j.byLabel &&
          !j.guesses?.length,
      ),
    )
    .map((x) => x.id);
  for (const x of mine)
    if (!reproduced.includes(x.id)) reasons.push({ kind: "not-reproduced", about: x.id });
  // Both sides of every re-read repo: no join is new on a pair a person deleted, and no join a
  // person made (a pairing, an answer) onto or from it is lost. The corrected calls aside.
  const reRead = new Set(repos);
  const ownAt = new Set(mine.map((x) => `${x.repo} ${x.c.target.file}:${x.c.target.line}`));
  const keyOf = (j: (typeof before.joins)[number]) =>
    `${j.call.repo} ${j.call.at} ${j.entry.repo} ${j.entry.fact}`;
  const near = (j: (typeof before.joins)[number]) =>
    (reRead.has(j.call.repo) || reRead.has(j.entry.repo)) &&
    !ownAt.has(`${j.call.repo} ${j.call.at}`);
  const had = new Set(before.joins.map(keyOf));
  const now = new Set(join.joins.map(keyOf));
  for (const j of join.joins.filter((x) => near(x) && !had.has(keyOf(x)))) {
    const hit = deleted.find((x) => x.from === j.call.repo && x.to === j.entry.repo);
    if (hit) reasons.push({ kind: "deleted", about: hit.what });
  }
  for (const j of before.joins.filter(near))
    if (((j.paired && !j.paired.ai) || (j.how === "answer" && !j.aiAnswer)) && !now.has(keyOf(j)))
      reasons.push({ kind: "touched", about: `${j.call.repo} ${j.call.at}` });
  const seen = new Set<string>();
  reasons.splice(
    0,
    reasons.length,
    ...reasons.filter((r) => !seen.has(JSON.stringify(r)) && !!seen.add(JSON.stringify(r))),
  );
  if (reasons.length) return { reasons };
  return { proof: { repos, reread, reproduced } };
}

/** atticus rules learn: Learn from my corrections, in a terminal; `--json` prints the result. */
export async function rulesLearnCommand(
  root: string,
  o: { json?: boolean; runner?: AcpStepRunner; by?: string },
  io: Output,
): Promise<number> {
  const op = await loadOrgPack(orgPackDirOf(root));
  const refused = learnRefusal(op);
  if (refused) {
    io.err(`${refused} Else draft by hand: atticus rules draft --type <t>.`);
    return 2;
  }
  const { acpStepRunner } = await import("./copilot-acp-steps.js");
  const { gitUser } = await import("@maycombhq/workspace");
  let r: Api.LearnCorrectionsResultT;
  try {
    const d = {
      by: o.by ?? (await gitUser(root)).handle,
      runner: o.runner ?? (await acpStepRunner(root, { op })),
    };
    r = await learnFromCorrections(root, d, io);
    const { learnRecipes } = await import("./learn-recipes.js");
    await learnRecipes(root, d, o.json ? { out: io.err, err: io.err } : io);
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
  if (o.json) {
    io.out(JSON.stringify(r, null, 2));
    return 0;
  }
  if (!r.corrections) {
    io.out("No correction since the last run: nothing was asked and nothing written.");
    return 0;
  }
  io.out(`${r.corrections} correction${r.corrections === 1 ? "" : "s"} since the last run.`);
  for (const a of r.active)
    io.out(`  active  ${a.key} (${a.file}): the join draws ${a.reproduced.join(", ")} by itself`);
  for (const x of r.draft) io.out(`  draft   ${x.key} (${x.file}): ${x.why}`);
  for (const u of r.untaught)
    io.out(
      `  not learned  ${u.correction}: ${u.kind === "no-type" ? "its repo has no type" : "no drafted rule names its file"}`,
    );
  io.out(
    "Review the rules file in a pull request; atticus rules list shows what each repo is given.",
  );
  return 0;
}

/**
 * ADR 0208: what refuses a repo's write (verify --write and Apply) while an active learned rule
 * names files of it, each line naming the place and the two ways on, or nothing:
 * - a person's correction the read no longer meets, in a file the rule names;
 * - a join of the read, with this repo at either end, on a pair a person deleted, whose
 *   Interface the delete doesn't suppress (a new path), and whose line here the rule names.
 * Where no learned rule applies, both are as before (corrections.stale, the build's suppress).
 */
export async function staleUnderLearned(
  root: string,
  repo: string,
  dir: string,
  report: {
    accepted: readonly Fact[];
    corrections: { stale: readonly { correction: FactCorrection; why: string }[] };
  },
): Promise<string[]> {
  const { effectiveRules } = await import("./reading-rules.js");
  const rules = (await effectiveRules(root, repo, { dir })).rules.filter((r) => r.learned?.proof);
  if (!rules.length) return [];
  const ruleAt = (at: string) => rules.find((r) => ruleMatches(r, at.replace(/:\d+$/, "")));
  const { isAiBy, listQuestions, TARGETS_STEP_ID } = await import("@maycombhq/core");
  const calls = new Set(report.accepted.filter((f) => f.kind === "call").map(atOf));
  const gone = report.corrections.stale
    .filter((s) => s.why === "none" && !s.correction.ai)
    .map((s) => ({
      at: `${s.correction.target.file}:${s.correction.target.line}`,
      what: `${s.correction.by}'s ${s.correction.action === "unlink" ? "none" : s.correction.action === "link" ? "pairing" : "correction"}`,
    }));
  for (const q of (await listQuestions(root, { repo, step: TARGETS_STEP_ID })).questions)
    if (q.state === "answered" && q.answer && !isAiBy(q.answer.by))
      for (const e of q.evidence.filter((x) => !calls.has(x)))
        gone.push({ at: e, what: `${q.answer.by}'s answer to ${q.id}` });
  const out = gone.flatMap(({ at, what }) => {
    const rule = ruleAt(at);
    return rule
      ? [
          `${repo}: ${what} at ${at} meets no call in this read, and the learned rule ${rule.key} names that file, so the read may be the rule's doing. Nothing was written. Either turn the rule off for ${repo} (atticus rules off ${rule.key} --repo ${repo} --reason "..."), or answer the call again on the map (pair it, or say none), then verify again.`,
        ]
      : [];
  });
  // A deleted pair drawn again through a new path: the join with this read in place.
  const deleted = await deletedPairs(root);
  if (!deleted.length) return out;
  const { estateFacts, estateJoinOf } = await import("@maycombhq/scanner");
  const op = await loadOrgPack(orgPackDirOf(root));
  const estate = await estateFacts(root, op, repo);
  estate.repos.push({ repo, facts: [...report.accepted] });
  const join = estateJoinOf(op, estate.repos, estate.targets, estate.pairs, estate.aiTargets);
  for (const j of join.joins) {
    const here = j.call.repo === repo ? j.call.at : j.entry.repo === repo ? j.entry.at : undefined;
    const rule = here ? ruleAt(here) : undefined;
    const hit = rule ? deletedBlocks(deleted, j.call.repo, j.entry.repo) : undefined;
    if (hit && !hit.interfaces.includes(j.interface))
      out.push(
        `${repo}: this read joins ${j.call.repo} ${j.call.at} to ${j.entry.repo} ${j.entry.at}, drawing again the arrow ${hit.what} that ${hit.by} deleted, and the learned rule ${rule!.key} names ${here}. Nothing was written. Either turn the rule off for ${repo} (atticus rules off ${rule!.key} --repo ${repo} --reason "..."), or delete the arrow again on the map (or answer the call there), then verify again.`,
      );
  }
  return out;
}
