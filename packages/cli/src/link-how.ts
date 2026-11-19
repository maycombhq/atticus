import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  factIdPart,
  factsDirOf,
  HOSTS_STEP,
  joinHostOfQuestion,
  listQuestions,
  parseCorrections,
  TARGETS_STEP_ID,
  type CandidateCall,
  type CandidateHow,
  type Fact,
  type OrgPack,
  type Question,
} from "@maycombhq/core";
import { estateRepos, outsideProfileSystems } from "@maycombhq/scanner";

/**
 * Beta.30 (the owner's field report, "it's connected to the wrong box"): how a call that goes
 * somewhere was decided, with what only the files say: when a person paired it and why, which
 * question a person answered and when, and whether the call's cited line itself names a box (its
 * host, or the target the fact read there). The estate's join says the kind (`howOfJoin`); this
 * reads the corrections, the questions and the manifests beside it. Files only.
 */

export interface CodeNames {
  box: string;
  text: string;
}

type CallFact = Extract<Fact, { kind: "call" }>;

/** The host a call's line writes: its fact's host, else the host of the URL it cites. */
export function writtenHost(f: CallFact): string | undefined {
  const of = (v: string | undefined) => {
    const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([A-Za-z0-9.-]+\.[A-Za-z0-9-]+)(?::\d+)?(?:\/|$)/i.exec(
      (v ?? "").trim(),
    );
    return m?.[1]?.toLowerCase();
  };
  return of(f.host) ?? of(f.cite.value);
}

const labelOf = (q: Question): string | undefined =>
  q.answer?.option !== undefined ? q.options[q.answer.option - 1]?.label : q.answer?.text?.trim();

export interface Decided {
  /** What to add to a candidate call's own account: when, the question, the reason. */
  how(call: CandidateCall): CandidateHow | undefined;
  /** The box the call's cited line names, when it names one. */
  codeNames(call: string): CodeNames | undefined;
}

export async function decidedOf(
  root: string,
  from: string,
  op: OrgPack,
  facts: readonly Fact[],
): Promise<Decided> {
  const calls = new Map(facts.flatMap((f) => (f.kind === "call" ? [[f.id, f] as const] : [])));
  const text = await readFile(join(factsDirOf(root), `${from}.corrections.jsonl`), "utf8").catch(
    () => "",
  );
  // The newest pairing of each call, as the join reads them (the last line wins).
  const paired = new Map<string, { at: string; by: string; reason?: string }>();
  if (text.includes('"link"'))
    for (const c of parseCorrections(text).corrections) {
      if (c.action !== "link") continue;
      const id =
        calls.get(c.fact)?.id ??
        [...calls.values()].find(
          (f) => f.cite.file === c.target.file && f.cite.line === c.target.line,
        )?.id;
      if (id) paired.set(id, { at: c.at, by: c.by, ...(c.reason ? { reason: c.reason } : {}) });
    }
  const answered = (
    await listQuestions(root).catch(() => ({ questions: [] as Question[] }))
  ).questions
    .filter((q) => q.state === "answered" && !!q.answer)
    .sort((a, b) => (a.answer!.at < b.answer!.at ? 1 : a.answer!.at > b.answer!.at ? -1 : 0));
  const repos = estateRepos(op);
  const outside = outsideProfileSystems(op);
  /** The answered question about the host the call writes (a hosts question, or the join's). */
  const hostAnswer = (f: CallFact) => {
    const host = writtenHost(f) ?? f.host?.trim() ?? f.base?.trim();
    if (!host) return undefined;
    return answered.find(
      (q) =>
        (q.askedBy.step === HOSTS_STEP || q.askedBy.step === TARGETS_STEP_ID) &&
        joinHostOfQuestion(q)?.toLowerCase() === host.toLowerCase(),
    );
  };
  /** The answered question about where the call itself goes: one that cites its line. */
  const callAnswer = (f: CallFact) => {
    const at = `${f.cite.file}:${f.cite.line}`;
    const mine = answered.filter((q) => q.repo === from && q.askedBy.step === TARGETS_STEP_ID);
    return mine.find((q) => q.evidence.includes(at)) ?? hostAnswer(f) ?? mine[0];
  };
  // ADR 0181: an answer the AI gave is the AI's, never said to be a person's.
  const said = (q: Question): CandidateHow => {
    const by = q.answer!.by;
    return typeof by === "string"
      ? { by: "answer", who: by, at: q.answer!.at, question: q.id }
      : { by: "ai", who: by.run, at: q.answer!.at, question: q.id };
  };
  const codeNames = (id: string): CodeNames | undefined => {
    const f = calls.get(id);
    if (!f) return undefined;
    if (f.to) {
      const t = factIdPart(f.to);
      const repo = repos.find(
        (r) =>
          factIdPart(r.id) === t ||
          (r.component !== undefined && factIdPart(r.component) === t) ||
          (r.modules ?? []).some((m) => factIdPart(m.component) === t),
      );
      const system = repo ? undefined : outside.find((s) => factIdPart(s.id) === t);
      if (repo || system) return { box: (repo ?? system)!.id, text: f.to };
    }
    const host = writtenHost(f);
    if (!host) return undefined;
    // A host the manifest lists because a person answered a question about it is that answer's.
    const q = hostAnswer(f);
    if (q && labelOf(q) !== undefined) return undefined;
    const repo = repos.find((r) => (r.hosts ?? []).some((h) => h.toLowerCase() === host));
    return repo ? { box: repo.id, text: host } : undefined;
  };
  return {
    codeNames,
    how: (c) => {
      const h = c.how;
      const f = calls.get(c.fact);
      if (!h || !f) return h;
      if (h.by === "paired" || h.by === "ai") {
        const p = paired.get(c.fact);
        return p
          ? { ...h, at: p.at, ...(p.reason && h.by === "paired" ? { reason: p.reason } : {}) }
          : h;
      }
      if (h.by === "answer") {
        const q = callAnswer(f);
        return q ? { ...h, ...said(q) } : h;
      }
      // Joined by its host, and a person's answer is why the manifest lists that host there.
      if (h.by === "address" && !codeNames(c.fact)) {
        const q = hostAnswer(f);
        if (q) return said(q);
      }
      return h;
    },
  };
}

/** Why a pair is refused until the person says why: the call's line names another box. */
export function overridesCodeWords(
  call: { id: string; at: string },
  names: CodeNames,
  to: string,
): string {
  const whose =
    names.text === names.box
      ? `names ${names.box}`
      : `names ${names.text}, which is ${names.box}'s`;
  return `${call.id}'s line (${call.at}) ${whose}: pairing it with ${to} overrides what the code says. To do that, say why (a reason of a few words), and it is kept with your pairing.`;
}
