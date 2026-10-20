import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import type { AiRuntime } from "@maycombhq/ai";
import { Dialect, type CatalogRecord, type OrgPack } from "@maycombhq/core";
import { dialectExtractor } from "@maycombhq/extractors";
import { fsRepo, scanRepo, type RepoHandle } from "@maycombhq/sdk";
import { draftDialect } from "./onboard.js";

/**
 * The onboarding evaluation (ADR 0059): how well the organisation's assistant drafts dialects
 * for ecosystems it hasn't seen. Each case is a repo and a reference dialect a person wrote;
 * the draft's records from the repo are compared with the reference's, by what they say, not
 * by id (a draft may name records its own way). Deterministic apart from the model.
 */

/** What a record says, for comparing a draft with the reference: its kind and its facts. */
const KEY_FIELDS: Record<string, string[]> = {
  GatewayRoute: ["basepath", "target"],
  Endpoint: ["component", "endpointType", "method", "pathOrTopic"],
  Unresolved: ["unresolvedKind", "raw"],
  Interface: ["from", "to", "method", "normalizedPath"],
  Setting: ["component", "key", "valueOrRef"],
  Table: ["dataStore", "name"],
  Column: ["table", "name"],
};
const IGNORED = new Set(["id", "evidence", "schemaVersion", "status", "confidence"]);

export function recordSignature(r: CatalogRecord): string {
  const x = r as unknown as Record<string, unknown>;
  const fields =
    KEY_FIELDS[r.kind] ??
    Object.keys(x)
      .filter((k) => !IGNORED.has(k) && k !== "kind")
      .sort();
  return `${r.kind} ${fields.map((f) => `${f}=${JSON.stringify(x[f] ?? null)}`).join(" ")}`;
}

export interface EvalCase {
  name: string;
  repo: string;
  reference: string;
}

export interface EvalResult {
  case: string;
  status: "drafted" | "waiting" | "failed";
  attempts: number;
  expected: number;
  drafted: number;
  matched: number;
  /** matched / drafted, and matched / expected: 1 when the draft reads what the reference does. */
  precision: number;
  recall: number;
  missing: string[];
  extra: string[];
  problems: string[];
}

async function recordsOf(d: Dialect, repo: RepoHandle): Promise<CatalogRecord[]> {
  const s = await scanRepo({ repo, extractors: [dialectExtractor(d)], dialects: [d.name] });
  return s.records;
}

/** The cases of an evaluation folder: <case>/case.yaml, paths relative to it. */
export async function loadEvalCases(dir: string): Promise<EvalCase[]> {
  const out: EvalCase[] = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (!e.isDirectory()) continue;
    const file = join(dir, e.name, "case.yaml");
    if (!(await stat(file).catch(() => undefined))) continue;
    const c = parse(await readFile(file, "utf8")) as Partial<EvalCase>;
    if (!c.repo || !c.reference) throw new Error(`${file}: a case names its repo and reference`);
    out.push({
      name: c.name ?? e.name,
      repo: resolve(dirname(file), c.repo),
      reference: resolve(dirname(file), c.reference),
    });
  }
  return out;
}

/** Run the evaluation: draft each case's dialect with the runtime, and score it. */
export async function evalOnboarding(
  cases: EvalCase[],
  o: {
    runtime: AiRuntime;
    orgPack?: Pick<OrgPack, "agents" | "runtime" | "pack">;
    maxAttempts?: number;
    now?: Date;
  },
): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  for (const c of cases) {
    const repo = fsRepo(basename(c.repo), c.repo, "0".repeat(40));
    const reference = Dialect.parse(parse(await readFile(c.reference, "utf8")));
    const want = [...new Set((await recordsOf(reference, repo)).map(recordSignature))].sort();
    const r = await draftDialect(repo, {
      name: `eval-${c.name}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"),
      runtime: o.runtime,
      ...(o.orgPack ? { orgPack: o.orgPack } : {}),
      maxAttempts: o.maxAttempts ?? 3,
      ...(o.now ? { now: o.now } : {}),
    });
    const got = r.dialect
      ? [...new Set((await recordsOf(r.dialect, repo)).map(recordSignature))].sort()
      : [];
    const matched = got.filter((g) => want.includes(g)).length;
    out.push({
      case: c.name,
      status: r.status,
      attempts: r.attempts.length,
      expected: want.length,
      drafted: got.length,
      matched,
      precision: got.length ? matched / got.length : 0,
      recall: want.length ? matched / want.length : 0,
      missing: want.filter((w) => !got.includes(w)),
      extra: got.filter((g) => !want.includes(g)),
      problems: r.status === "drafted" ? [] : (r.attempts.at(-1)?.problems ?? []),
    });
  }
  return out;
}

/** The evaluation as lines for a person. */
export function formatEval(results: EvalResult[]): string[] {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines = results.map(
    (r) =>
      `${r.case}: ${r.status}${r.attempts ? ` in ${r.attempts} attempt${r.attempts === 1 ? "" : "s"}` : ""}, read ${r.matched} of ${r.expected} expected records (precision ${pct(r.precision)}, recall ${pct(r.recall)})${r.extra.length ? `, ${r.extra.length} not in the reference` : ""}`,
  );
  const exact = results.filter(
    (r) => r.status === "drafted" && r.precision === 1 && r.recall === 1,
  ).length;
  lines.push(`${exact} of ${results.length} cases read exactly what the reference reads.`);
  return lines;
}
