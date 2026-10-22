import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { KNOWLEDGE_KINDS, knowledgeKindOf, loadOrgPack, type OrgPack } from "@maycombhq/core";
import type { AiRuntime } from "@maycombhq/ai";
import {
  askKnowledge,
  checkQuote,
  itemTitle,
  readKnowledge,
  readSnapshot,
  scanKnowledge,
  syncSources,
  termsOf,
  writeKnowledge,
  writeSnapshots,
  type AskResult,
  type Injection,
  type KnowledgeConflict,
  type KnowledgeRecord,
  type SupersededPage,
} from "@maycombhq/knowledge";

/**
 * The knowledge bench (revamp plan 4.3, Phase 3 exit): an invented wiki and a reference a
 * person wrote of what a correct knowledge scan extracts. `scoreKnowledge` scores a scan and
 * the answers to the reference's questions; `runKnowledgeBench` runs the scan and the
 * questions on the corpus and scores them.
 *
 * Items match by kind and meaning: the same kind, and titles or applies-when that share most
 * of their words (Dice similarity of their word sets, stop words dropped and plurals folded,
 * at least 0.5 for titles or 0.6 for applies-when), or the same decision code (AD-15). Each
 * reference item matches at most one extracted item, best match first. The answer's prose is
 * not judged here (that needs a person or an AI judge); its cited items are.
 */

const QuoteRef = z.object({ page: z.string(), section: z.string().optional(), quote: z.string() });
const RefItem = z.looseObject({
  kind: z.enum(KNOWLEDGE_KINDS),
  id: z.string(),
  title: z.string(),
  applies_when: z.string().default(""),
  lead_time: z.string().optional(),
  handled_by: z.string().optional(),
  source: QuoteRef,
  also_on: z
    .union([QuoteRef, z.array(QuoteRef)])
    .optional()
    .transform((a) => (a === undefined ? [] : Array.isArray(a) ? a : [a])),
});
const KnowledgeReferenceSchema = z.object({
  corpus: z.string(),
  snapshot: z.string().optional(),
  items: z.array(RefItem),
  conflicts: z
    .array(z.object({ about: z.string(), pages: z.array(z.string()), says: z.array(z.string()) }))
    .default([]),
  superseded: z
    .array(z.object({ old: z.string(), new: z.string(), quote: z.string() }))
    .default([]),
  injections: z.array(z.object({ page: z.string(), quote: z.string() })).default([]),
  questions: z
    .array(z.object({ ask: z.string(), answer: z.string(), items: z.array(z.string()) }))
    .default([]),
});
export type KnowledgeReference = z.infer<typeof KnowledgeReferenceSchema>;

export function parseKnowledgeReference(text: string): KnowledgeReference {
  const r = KnowledgeReferenceSchema.safeParse(parse(text));
  if (!r.success)
    throw new Error(
      `the knowledge reference isn't valid: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return r.data;
}

const base = (p: string) => p.split("/").pop() ?? p;
const set = (s: string) => new Set(termsOf(s.replace(/\(ad-\d+\)/gi, " ")));
function dice(a: string, b: string): number {
  const x = set(a);
  const y = set(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const t of x) if (y.has(t)) n++;
  return (2 * n) / (x.size + y.size);
}
const code = (s: string) => /\bAD-(\d+)\b/i.exec(s)?.[1];

export interface KnowledgeRun {
  items: KnowledgeRecord[];
  conflicts: KnowledgeConflict[];
  superseded: SupersededPage[];
  injections: Injection[];
  /** Answers to the reference's questions, in its order. */
  answers?: { question: string; status: "answered" | "refused"; cites: string[] }[];
}

export interface KnowledgeScore {
  items: {
    found: number;
    missed: number;
    wrong: number;
    precision: number;
    recall: number;
    byKind: Record<string, { found: number; missed: number; wrong: number }>;
    matched: { ref: string; got: string; quote: boolean }[];
    missedIds: string[];
    wrongIds: string[];
  };
  quotes: { correct: number; of: number; wrongIds: string[] };
  conflicts: { flagged: number; of: number; missed: string[] };
  superseded: { flagged: number; of: number; missed: string[]; itemsFromOldPages: string[] };
  injections: { flagged: number; of: number; followed: string[] };
  questions: {
    correct: number;
    of: number;
    results: {
      ask: string;
      expected: string[];
      cited: string[];
      missing: string[];
      refused: boolean;
      correct: boolean;
    }[];
  };
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
function repeats(text: string, of: string): boolean {
  const w = words(text);
  const grams = new Set<string>();
  for (let i = 0; i + 5 <= w.length; i++) grams.add(w.slice(i, i + 5).join(" "));
  const o = words(of);
  for (let i = 0; i + 5 <= o.length; i++) if (grams.has(o.slice(i, i + 5).join(" "))) return true;
  return false;
}

function itemWords(r: KnowledgeRecord): string {
  const parts = [
    itemTitle(r),
    "appliesWhen" in r ? (r.appliesWhen ?? "") : "",
    "handledBy" in r ? (r.handledBy ?? "") : "",
  ];
  if (r.kind === "Pattern") parts.push(...r.rules);
  if (r.kind === "ProcessDefinition") parts.push(r.leadTime ?? "", ...r.inputs, ...r.steps);
  return parts.join(". ");
}

/**
 * Score a scan (and, when given, its answers) against the reference. `pageText` returns a
 * corpus page by its file name, so quotes are checked again here, against the corpus itself.
 */
export function scoreKnowledge(
  ref: KnowledgeReference,
  run: KnowledgeRun,
  pageText: (page: string) => string | undefined,
): KnowledgeScore {
  // Candidate pairs, best first.
  const pairs: { r: number; g: number; s: number }[] = [];
  ref.items.forEach((ri, r) =>
    run.items.forEach((gi, g) => {
      if (knowledgeKindOf(gi) !== ri.kind) return;
      const t = dice(ri.title, itemTitle(gi));
      const a = dice(ri.applies_when, "appliesWhen" in gi ? (gi.appliesWhen ?? "") : "");
      const sameCode = !!code(ri.title) && code(ri.title) === code(itemTitle(gi));
      if (t < 0.5 && a < 0.6 && !sameCode) return;
      const samePlace =
        !!gi.quote &&
        base(gi.quote.page) === base(ri.source.page) &&
        (gi.quote.section ?? "").toLowerCase() === (ri.source.section ?? "").toLowerCase();
      pairs.push({ r, g, s: Math.max(t, a) + (sameCode ? 1 : 0) + (samePlace ? 0.25 : 0) });
    }),
  );
  pairs.sort((x, y) => y.s - x.s || x.r - y.r || x.g - y.g);
  const refOf = new Map<number, number>();
  const gotOf = new Map<number, number>();
  for (const p of pairs) {
    if (refOf.has(p.r) || gotOf.has(p.g)) continue;
    refOf.set(p.r, p.g);
    gotOf.set(p.g, p.r);
  }
  const idMap = new Map<string, string>();
  for (const [r, g] of refOf) idMap.set(run.items[g]!.id, ref.items[r]!.id);

  const byKind: KnowledgeScore["items"]["byKind"] = {};
  for (const k of KNOWLEDGE_KINDS) byKind[k] = { found: 0, missed: 0, wrong: 0 };
  const matched: KnowledgeScore["items"]["matched"] = [];
  const quoteWrong: string[] = [];
  ref.items.forEach((ri, r) => {
    const g = refOf.get(r);
    if (g === undefined) {
      byKind[ri.kind]!.missed++;
      return;
    }
    byKind[ri.kind]!.found++;
    const gi = run.items[g]!;
    const pages = [ri.source.page, ...ri.also_on.map((a) => a.page)].map(base);
    const text = gi.quote ? pageText(base(gi.quote.page)) : undefined;
    const ok =
      !!gi.quote &&
      pages.includes(base(gi.quote.page)) &&
      text !== undefined &&
      checkQuote(text, gi.quote.text, gi.quote.section).ok;
    if (!ok) quoteWrong.push(ri.id);
    matched.push({ ref: ri.id, got: gi.id, quote: ok });
  });
  const wrongIds = run.items.filter((_, g) => !gotOf.has(g)).map((gi) => gi.id);
  for (const gi of run.items.filter((_, g) => !gotOf.has(g))) {
    const k = knowledgeKindOf(gi);
    if (k) byKind[k]!.wrong++;
  }
  const found = refOf.size;
  const missedIds = ref.items.filter((_, r) => !refOf.has(r)).map((ri) => ri.id);

  const conflictsMissed = ref.conflicts
    .filter((c) => {
      const want = c.pages.map(base);
      return !run.conflicts.some((x) => {
        const got = x.pages.map((p) => base(p.page));
        return want.every((w) => got.includes(w));
      });
    })
    .map((c) => c.about);

  const supMissed = ref.superseded
    .filter(
      (s) =>
        !run.superseded.some(
          (x) => base(x.old.page) === base(s.old) && base(x.new.page) === base(s.new),
        ),
    )
    .map((s) => s.old);
  const oldPages = new Set(ref.superseded.map((s) => base(s.old)));
  const fromOld = run.items
    .filter((i) => i.quote && oldPages.has(base(i.quote.page)))
    .map((i) => i.id);

  const injFlagged = ref.injections.filter((inj) =>
    run.injections.some((x) => base(x.page) === base(inj.page)),
  ).length;
  const followed = run.items
    .filter((i) => ref.injections.some((inj) => repeats(itemWords(i), inj.quote)))
    .map((i) => i.id);

  const results = ref.questions.map((q, k) => {
    const a = run.answers?.[k];
    const cited = [...new Set((a?.cites ?? []).map((c) => idMap.get(c) ?? `(${c})`))];
    const missing = q.items.filter((i) => !cited.includes(i));
    const refused = !a || a.status === "refused";
    return {
      ask: q.ask,
      expected: q.items,
      cited,
      missing,
      refused,
      correct: !refused && missing.length === 0,
    };
  });

  return {
    items: {
      found,
      missed: missedIds.length,
      wrong: wrongIds.length,
      precision: found / Math.max(1, found + wrongIds.length),
      recall: found / Math.max(1, ref.items.length),
      byKind,
      matched,
      missedIds,
      wrongIds,
    },
    quotes: {
      correct: matched.filter((m) => m.quote).length,
      of: matched.length,
      wrongIds: quoteWrong,
    },
    conflicts: {
      flagged: ref.conflicts.length - conflictsMissed.length,
      of: ref.conflicts.length,
      missed: conflictsMissed,
    },
    superseded: {
      flagged: ref.superseded.length - supMissed.length,
      of: ref.superseded.length,
      missed: supMissed,
      itemsFromOldPages: fromOld,
    },
    injections: { flagged: injFlagged, of: ref.injections.length, followed },
    questions: { correct: results.filter((r) => r.correct).length, of: results.length, results },
  };
}

// ------------------------------------------------------------------ running it

export interface KnowledgeBenchOptions {
  /** The knowledge bench folder: reference.yaml and the corpus folder it names. */
  bench: string;
  /** A metarepo folder the bench owns: its org pack, snapshot, items and runs go here. */
  work: string;
  runtime: AiRuntime;
  now?: Date;
  /** Continue a hand-off: the scan's run, or the questions' run. */
  resumeScan?: string;
  resumeAsk?: string;
}

export type KnowledgeBenchResult =
  | { status: "waiting"; step: "scan" | "ask"; runId: string }
  | {
      status: "scored";
      score: KnowledgeScore;
      scanProblems: string[];
      ask: AskResult;
    };

/** The bench's metarepo: one source, the corpus, tagged with every kind. */
export async function prepareKnowledgeBench(
  bench: string,
  work: string,
): Promise<KnowledgeReference> {
  const ref = parseKnowledgeReference(await readFile(join(bench, "reference.yaml"), "utf8"));
  await mkdir(join(work, "org-pack"), { recursive: true });
  const corpus = resolve(bench, ref.corpus).split("\\").join("/");
  await writeFile(
    join(work, "org-pack", "sources.yaml"),
    [
      "schemaVersion: 1",
      "wikis:",
      `  - id: ${ref.corpus}`,
      "    type: markdown-folder",
      `    location: ${JSON.stringify(corpus)}`,
      "    owner: Enterprise Architecture",
      "    tags:",
      `      kinds: [${KNOWLEDGE_SOURCE_KINDS.join(", ")}]`,
      "      frameworks: [anvil, kiln]",
      "",
    ].join("\n"),
    "utf8",
  );
  return ref;
}

const KNOWLEDGE_SOURCE_KINDS = [
  "enterprise-architecture",
  "integration-patterns",
  "platform-runbook",
  "security-standard",
  "change-process",
  "framework",
];

/** Snapshot the corpus, scan it, ask the questions, and score the lot. */
export async function runKnowledgeBench(o: KnowledgeBenchOptions): Promise<KnowledgeBenchResult> {
  const now = o.now ?? new Date();
  const at = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const ref = parseKnowledgeReference(await readFile(join(o.bench, "reference.yaml"), "utf8"));
  const op: OrgPack = await loadOrgPack(join(o.work, "org-pack"));
  const corpusDir = resolve(o.bench, ref.corpus);
  const pageText = (p: string) => {
    try {
      return readFileSync(join(corpusDir, p), "utf8");
    } catch {
      return undefined;
    }
  };
  let scanProblems: string[] = [];
  if (!o.resumeAsk) {
    if (!o.resumeScan) {
      const sync = await syncSources({
        root: o.work,
        orgPack: op,
        orgPackDir: join(o.work, "org-pack"),
        now: at,
      });
      await writeSnapshots({ root: o.work, orgPack: op, sync, takenAt: at });
    }
    const snap = await readSnapshot(o.work, ref.corpus);
    if (!snap) throw new Error(`no snapshot of ${ref.corpus} in ${o.work}`);
    const scan = await scanKnowledge([snap], {
      runtime: o.runtime,
      orgPack: op,
      now,
      ...(o.resumeScan ? { resume: o.resumeScan } : {}),
    });
    if (scan.status === "waiting") return { status: "waiting", step: "scan", runId: scan.runId! };
    await writeKnowledge(o.work, scan, at);
    scanProblems = scan.attempts.at(-1)?.problems ?? [];
  }
  const k = await readKnowledge(o.work);
  const ask = await askKnowledge(
    ref.questions.map((q) => q.ask),
    {
      items: k.items,
      conflicts: k.report?.conflicts ?? [],
      runtime: o.runtime,
      orgPack: op,
      now,
      ...(o.resumeAsk ? { resume: o.resumeAsk } : {}),
    },
  );
  if (ask.status === "waiting") return { status: "waiting", step: "ask", runId: ask.runId! };
  const texts = new Map<string, string | undefined>();
  const score = scoreKnowledge(
    ref,
    {
      items: k.items,
      conflicts: k.report?.conflicts ?? [],
      superseded: k.report?.superseded ?? [],
      injections: k.report?.injections ?? [],
      answers: ask.answers,
    },
    (p) => {
      if (!texts.has(p)) texts.set(p, pageText(p));
      return texts.get(p);
    },
  );
  return { status: "scored", score, scanProblems, ask };
}
