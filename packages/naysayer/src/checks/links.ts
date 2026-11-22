import { z } from "zod";
import {
  callsOfQuestion,
  hostOfQuestion,
  HOSTS_STEP,
  isLinkQuestion,
  JOINED_BY_AI,
  listQuestions,
  questionsRelOf,
  repoReadOf,
  type FactOf,
  type JoinGuessFlag,
} from "@maycombhq/core";
import { looksLikeRepoId, parseCodeTable } from "@maycombhq/changes";
import { docOf, normalizePath } from "../artifacts.js";
import type { Doc } from "../doc.js";
import type { CriticContext, EstateReads } from "../context.js";
import {
  lineEvidence,
  questionOwner,
  recordEvidence,
  sentence,
  type DeterministicCheckDef,
  type Evidence,
  type Hit,
} from "../hits.js";
import { calls, rowLocator, type Call } from "./interfaces.js";

/**
 * A change that rests on a map error says so (ADR 0140, P4), so a map error never becomes a
 * design error: a link the join guessed (an Interface `inferred` and flagged with one of core's
 * `JOIN_GUESS_FLAGS`: `joined-by-path`, `-label`, `-platform-setting`, `-folder-name` or
 * `joined-despite-conflict` or `joined-by-service-name`), a link question still open about a call the change plans, or a repo whose
 * read is stale or incomplete. It says only what the files show: a link a person, a name, a repo
 * or a host made says nothing. A repo not read into facts (nobody read it, or only the built-in
 * readers mapped it, ADR 0074) is said only where the change has work in it (a `## <repo>` of
 * tasks.md, a row of design.md's In the code) and a manifest lists it (the persona check of
 * beta.30); elsewhere it is left to the checks that ask about what the catalog doesn't know.
 */

const IFACES = "interfaces.md";

/** The join's guesses (core's JOIN_GUESS_FLAGS), in words. */
const GUESSES: Record<JoinGuessFlag, string> = {
  "joined-by-path": "by path",
  "joined-by-label": "by a host's first label",
  "joined-by-platform-setting": "by a platform-wide setting nobody set for it",
  "joined-by-folder-name": "by the folder name of the setting that gives its host",
  "joined-despite-conflict": "by a host or base path an open conflict disputes",
  "joined-by-service-name":
    "by a Kubernetes Service's short name, from a namespace not shown to be its",
};
const guessOf = (f: string): f is JoinGuessFlag => Object.hasOwn(GUESSES, f);

/**
 * The persona check of beta.30: the repos the change has work in, by its own files: each
 * `## <repo>` heading of tasks.md and each row of design.md's In the code, with the first line
 * that names it.
 */
function workRepos(ctx: CriticContext): Map<string, { doc: Doc; line: number }> {
  const out = new Map<string, { doc: Doc; line: number }>();
  const tasks = docOf(ctx.files, "tasks.md");
  let fence = false;
  tasks?.lines.forEach((l, i) => {
    if (/^\s{0,3}(```|~~~)/.test(l)) fence = !fence;
    if (fence) return;
    const h = /^##\s+`?([a-z0-9][a-z0-9._-]*)`?\s*$/.exec(l);
    if (h && looksLikeRepoId(h[1]!) && !out.has(h[1]!)) out.set(h[1]!, { doc: tasks, line: i + 1 });
  });
  const design = docOf(ctx.files, "design.md");
  if (design)
    for (const r of parseCodeTable(design.raw).rows)
      if (r.repo && !out.has(r.repo)) out.set(r.repo, { doc: design, line: r.line });
  return out;
}

/** The repos a manifest lists (read or not): only those can be read into the map. */
const listedRepos = (ctx: CriticContext) =>
  new Set(ctx.lifecycle.orgPack.profiles.flatMap((p) => p.repos?.repos.map((r) => r.id) ?? []));

/** The repos a change's calls start or end in, and the ones it names: what its design rests on. */
function reposOf(ctx: CriticContext): string[] {
  const out = new Set<string>(ctx.footprint.repos);
  for (const r of workRepos(ctx).keys()) out.add(r);
  for (const c of calls(ctx))
    for (const id of [c.caller, c.callee]) {
      const repo = ctx.get("Component", id)?.repo;
      if (repo) out.add(repo);
    }
  return [...out].sort();
}

/**
 * Load what the check reads (files only): the read of each repo the change rests on, and the open
 * link questions about those repos with the calls each asks about.
 */
export async function loadEstateReads(root: string, ctx: CriticContext): Promise<EstateReads> {
  const reads = new Map<string, Awaited<ReturnType<typeof repoReadOf>>>();
  for (const r of reposOf(ctx)) reads.set(r, await repoReadOf(root, r));
  const facts = new Map([...reads].map(([k, v]) => [k, v.facts] as const));
  const open = await listQuestions(root, { state: "open" }).then(
    (l) => l.questions,
    () => [],
  );
  return {
    reads,
    questions: open
      .filter((q) => isLinkQuestion(q) && reads.has(q.repo))
      .map((q) => ({
        question: q,
        calls: callsOfQuestion(q, facts),
        file: `${questionsRelOf(root)}/${q.id}.yaml`,
      })),
  };
}

const pathOf = (p: string) => normalizePath(p.split(/[?#]/)[0]!.trim()).toLowerCase();

/** Whether a call fact is the call the change plans: its line is the Interface's, or its method and path are the hop's. */
function sameCall(f: FactOf<"call">, c: Call): boolean {
  if (
    c.record?.evidence.some(
      (e) => e.repo === f.repo && e.path === f.cite.file && e.line === f.cite.line,
    )
  )
    return true;
  const path = c.hop?.path ?? c.record?.normalizedPath;
  const method = c.hop?.method ?? c.record?.method;
  if (!path) return false;
  if (method && f.method && method.toUpperCase() !== f.method.toUpperCase()) return false;
  return pathOf(path) === pathOf(f.path);
}

/** Where a call shows: its row in interfaces.md, or the catalog interface it is. */
function placeOf(
  ctx: CriticContext,
  c: Call,
): Pick<Hit, "artifact" | "locator"> & { evidence: Evidence[] } {
  const ifaces = docOf(ctx.files, IFACES);
  if (c.hop && ifaces)
    return {
      artifact: IFACES,
      locator: rowLocator(ifaces, c.hop.line),
      evidence: [lineEvidence(ifaces, c.hop.line)],
    };
  return {
    artifact: "catalog",
    locator: { record: c.record?.id ?? c.caller },
    evidence: c.record ? [recordEvidence(c.record.id)] : [],
  };
}

const plainWhat = (step: string, q: { question: string }) =>
  step === HOSTS_STEP
    ? `which repo answers on ${hostOfQuestion(q) ?? "its host"}`
    : "which repo or system answers it";

export const changeLinksKnown: DeterministicCheckDef = {
  id: "change-links-known",
  question: "true",
  description:
    "Every call the change plans rests on a link read from code: not one the join guessed (by path, by a host's first label, by a platform-wide setting or a setting's folder name, or despite an open conflict), not one a link question still asks about, and not in a repo whose read is stale or incomplete. And every repo a manifest lists that the change has work in (a ## <repo> of tasks.md, a row of design.md's In the code) was read into facts: one nobody read, or that only the built-in readers mapped, is said with the way to read it.",
  params: z.strictObject({}),
  run(ctx) {
    const hits: Hit[] = [];
    const all = calls(ctx);
    for (const c of all) {
      const rec = c.record;
      const place = placeOf(ctx, c);
      // A link the join guessed.
      const flag = rec?.confidence === "inferred" ? rec.flags?.find(guessOf) : undefined;
      if (rec && flag)
        hits.push({
          kind: "knowledge-gap",
          ...place,
          summary: sentence(
            `The change rests on a guessed link: the map joined ${c.caller} to ${c.callee} (${c.operation}) ${GUESSES[flag]}, not from code that names ${c.callee}.`,
          ),
          why: `Nobody named ${c.callee} as the target of this call: the join found it ${GUESSES[flag]} (the Interface is inferred, flagged ${flag}). If the guess is wrong, the design is built on a call that goes somewhere else.`,
          fix: {
            text: `Confirm the target: name it on the call (the call's target in its facts, or Map › Why is this linked? › This link is wrong), then atticus verify ${ctx.get("Component", c.caller)?.repo ?? c.caller} --write.`,
          },
          evidence: [
            ...place.evidence.filter((e) => e.source !== "catalog"),
            recordEvidence(rec.id),
          ],
          question: {
            text: `Does ${c.caller}'s ${c.operation} go to ${c.callee}? The map joined them ${GUESSES[flag]}: nothing in ${c.caller}'s code names ${c.callee}.`,
            owner: questionOwner(ctx, c.caller),
          },
          subject: c.caller,
          key: `link-guess|${rec.id}`,
        });
      // ADR 0181: a link the AI decided (a pairing or a target answer, applied from its run) is
      // the AI's, never a person's word: the design may rest on it once a person confirms it.
      if (rec && !flag && rec.flags?.includes(JOINED_BY_AI)) {
        const run = rec.evidence.find((e) => e.source === "ai")?.run;
        hits.push({
          kind: "knowledge-gap",
          ...place,
          summary: sentence(
            `The change rests on a link the AI decided: ${c.caller} to ${c.callee} (${c.operation}), detected by AI${run ? ` (run ${run})` : ""} and not confirmed by a person.`,
          ),
          why: `The AI paired this call with ${c.callee}, and Atticus applied it because its lines checked and its shape agreed; nobody has said it is right. If it is wrong, the design is built on a call that goes somewhere else.`,
          fix: {
            text: `Confirm or correct it: atticus questions decisions lists it; atticus questions correct (or Correct on the "Detected by AI" chip) makes it a person's word, then atticus verify ${ctx.get("Component", c.caller)?.repo ?? c.caller} --write.`,
          },
          evidence: [
            ...place.evidence.filter((e) => e.source !== "catalog"),
            recordEvidence(rec.id),
          ],
          question: {
            text: `Does ${c.caller}'s ${c.operation} go to ${c.callee}? The AI decided so; nobody has confirmed it.`,
            owner: questionOwner(ctx, c.caller),
          },
          subject: c.caller,
          key: `link-ai|${rec.id}`,
        });
      }
      // A link question still open about this call.
      const repo = ctx.get("Component", c.caller)?.repo;
      for (const q of ctx.estate?.questions ?? []) {
        if (!repo || q.question.repo !== repo || !q.calls.some((f) => sameCall(f, c))) continue;
        const id = q.question.id;
        hits.push({
          kind: "knowledge-gap",
          ...place,
          summary: sentence(
            `The call from ${c.caller} to ${c.callee} (${c.operation}) rests on an open question, ${id}: ${plainWhat(q.question.askedBy.step, q.question)}.`,
          ),
          why: `The map doesn't know yet where this call goes: ${id} asks "${q.question.question}" and nobody has answered. Until it is answered, the link the design draws is a guess.`,
          fix: {
            text: `Answer it: atticus questions answer ${id} --option <n> (or on the app's Questions page), then ${q.question.rerun}.`,
          },
          evidence: [
            ...place.evidence,
            ...(rec && place.artifact !== "catalog" ? [recordEvidence(rec.id)] : []),
            { source: "manual", path: q.file },
          ],
          question: { text: q.question.question, owner: questionOwner(ctx, c.caller) },
          subject: c.caller,
          key: `link-question|${id}|${c.hop?.line ?? rec?.id}`,
        });
      }
    }
    // The persona check of beta.30: a repo a manifest lists that wasn't read into facts, which the
    // change's tasks.md or In the code names: a risk, with the way on, once per repo.
    const work = workRepos(ctx);
    const listed = listedRepos(ctx);
    for (const [repo, r] of ctx.estate?.reads ?? []) {
      const at = work.get(repo);
      if (r.state !== "not-read" || !at || !listed.has(repo)) continue;
      // ADR 0074: a repo the built-in readers alone mapped is not read either; said apart.
      const readers = ctx.records.some((x) => x.kind === "Component" && x.repo === repo);
      hits.push({
        kind: "issue",
        artifact: at.doc.path,
        locator: rowLocator(at.doc, at.line),
        summary: sentence(
          readers
            ? `The change has work in ${repo}, which only the built-in readers mapped: it wasn't read into facts, so what the change says of ${repo} isn't checked against its code.`
            : `The change has work in ${repo}, which nobody has read into the map, so what it says of ${repo} can't be checked against its code.`,
        ),
        why: readers
          ? `${repo} has no verified facts: what the map shows of it is the built-in readers' cross-check, which is never the path to accuracy, so what the change plans there, and what calls it or what it calls, isn't confirmed from its code.`
          : `${repo} has no verified facts, so the map knows nothing of its code: what the change plans there, and what calls it or what it calls, rests on the change's words alone.`,
        fix: {
          text: readers
            ? `The map has only the built-in readers' view of ${repo}: read it with /atticus-map ${repo}, then atticus verify ${repo} --write, and run the critic again.`
            : `Read it into the map before its tasks run: /atticus-map ${repo}, then atticus verify ${repo} --write, and run the critic again.`,
        },
        evidence: [lineEvidence(at.doc, at.line)],
        subject: repo,
        key: `not-read|${repo}`,
      });
    }
    // A repo whose read is stale or incomplete: once per repo.
    for (const [repo, r] of ctx.estate?.reads ?? []) {
      if (r.state !== "stale" && r.state !== "incomplete") continue;
      const c = all.find((x) =>
        [x.caller, x.callee].some((id) => ctx.get("Component", id)?.repo === repo),
      );
      const component = ctx.records.find((x) => x.kind === "Component" && x.repo === repo);
      const place = c
        ? placeOf(ctx, c)
        : {
            artifact: "catalog",
            locator: { record: component?.id ?? repo },
            evidence: [] as Evidence[],
          };
      const evidence = [...place.evidence, ...(component ? [recordEvidence(component.id)] : [])];
      if (!evidence.length) continue;
      hits.push({
        kind: "issue",
        ...place,
        summary: sentence(
          `The change rests on ${repo}, whose read is ${r.state}: ${r.why.join("; ")}.`,
        ),
        why: `What the catalog says of ${repo} comes from ${r.state === "stale" ? "an older commit than its checkout" : "a read that is not whole"}, so a link or entry the design relies on may have moved or be missing.`,
        fix: {
          text: `Read it again before relying on it: ${r.next ?? `atticus map ${repo}`}${r.next?.startsWith("atticus map") ? `, then atticus verify ${repo} --write` : ""}, and run the critic again.`,
        },
        evidence,
        key: `read|${repo}`,
      });
    }
    return { hits, subjects: [] };
  },
};
