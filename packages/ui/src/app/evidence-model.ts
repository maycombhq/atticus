import type { Api } from "@maycombhq/core";

/**
 * The Map's evidence (ADR 0124 addendum D-app, F3), apart from React: the facts on a line of a
 * repo, the open questions that read it, and what a record's evidence lacks. Pure functions of
 * GET /api/facts/{repo}, so tests check every case.
 */

export type FactsView = Api.RepoFactsViewT;
export type FactCite = Api.FactCiteViewT;
export interface Spot {
  file: string;
  line: number;
  value: string;
  quote?: string;
}
/** A fact on a line: the fact's own citation, or one of a flow's steps. */
export interface Hit {
  fact: FactCite;
  spot: Spot;
  step?: string;
}

/** "path:line" as its file and line; undefined when it names no line. */
export function splitAt(at: string): { file: string; line: number } | undefined {
  const m = /^(.+):(\d+)$/.exec(at.trim());
  return m ? { file: m[1]!, line: Number(m[2]) } : undefined;
}

/** The facts that rest on one line of the repo. */
export function hitsAt(v: FactsView, file: string, line: number): Hit[] {
  const out: Hit[] = [];
  for (const f of v.facts) {
    if (f.cite.file === file && f.cite.line === line) out.push({ fact: f, spot: f.cite });
    for (const s of f.steps ?? [])
      if (s.file === file && s.line === line) out.push({ fact: f, spot: s, step: s.what });
  }
  return out;
}

/** The open questions that read one line. */
export const questionsAt = (v: FactsView, file: string, line: number) =>
  v.questions.filter((q) => q.evidence.includes(`${file}:${line}`));

/** A correction on file that atticus verify hasn't applied yet. */
export const pending = (f: FactCite) =>
  !!f.correction && (f.correction.action === "wrong" || f.by !== "person");

export type GapKind = "unverified" | "question" | "corrected";

/**
 * What the evidence on some lines of one repo lacks: no kept fact checked from code on any of
 * them (a built-in reader's record, or a read nobody verified), an open question on one, a
 * correction waiting for atticus verify. Nothing until the repo's facts are loaded.
 */
export function evidenceGaps(
  v: FactsView | undefined,
  cites: readonly { file: string; line: number }[],
): GapKind[] {
  if (!v || !cites.length) return [];
  const hits = cites.flatMap((c) => hitsAt(v, c.file, c.line));
  const gaps: GapKind[] = [];
  if (!hits.some((h) => h.fact.verified !== "none")) gaps.push("unverified");
  if (cites.some((c) => questionsAt(v, c.file, c.line).length)) gaps.push("question");
  if (hits.some((h) => pending(h.fact))) gaps.push("corrected");
  return gaps;
}

/**
 * The gaps of a canvas box or link, or a contract: its evidence's lines in each repo, looked up
 * in that repo's facts. Unproven when no repo whose facts are loaded has a verified fact on any
 * of its lines; with `bare`, also when it cites nothing at all.
 */
export function gapsOfEvidence(
  evidence: readonly { repo?: string | undefined; at?: string; path?: string; line?: number }[],
  of: (repo: string) => FactsView | undefined,
  o: { bare?: boolean } = {},
): GapKind[] {
  const byRepo = new Map<string, { file: string; line: number }[]>();
  for (const e of evidence) {
    if (!e.repo) continue;
    const at = e.at ? splitAt(e.at) : e.path && e.line ? { file: e.path, line: e.line } : undefined;
    if (!at) continue;
    byRepo.set(e.repo, [...(byRepo.get(e.repo) ?? []), at]);
  }
  if (!byRepo.size) return o.bare && evidence.length === 0 ? ["unverified"] : [];
  const out = new Set<GapKind>();
  let known = 0;
  let unproven = 0;
  for (const [repo, cites] of byRepo) {
    const v = of(repo);
    if (!v) continue;
    known++;
    const g = evidenceGaps(v, cites);
    if (g.includes("unverified")) unproven++;
    for (const x of g) if (x !== "unverified") out.add(x);
  }
  if (known > 0 && unproven === known) out.add("unverified");
  return [...out].sort();
}

/** The repos a list of evidence is in, once each, in order. */
export const reposOf = (evidence: readonly { repo?: string | undefined }[]): string[] => [
  ...new Set(evidence.map((e) => e.repo).filter((x): x is string => !!x)),
];
