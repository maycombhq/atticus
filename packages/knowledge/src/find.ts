import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
  KNOWLEDGE_KINDS,
  KNOWLEDGE_RECORD_KIND,
  knowledgeDirOf,
  knowledgeKindOf,
  parseRecord,
  recordPath,
  serializeRecord,
  writeFileAtomic,
  type KnowledgeKind,
} from "@maycombhq/core";
import type { AiRuntime } from "@maycombhq/ai";
import type { OrgPack } from "@maycombhq/core";
import { scanKnowledge, type FailedItem, type KnowledgeRecord } from "./knowledge-scan.js";
import { reviewItem, writeReview } from "./reviews.js";
import type { Snapshot } from "./snapshot.js";

/**
 * Searching the wikis (ADR 0101). A developer looks for a term or phrase across every snapshot:
 * a plain search finds the pages and sections that mention it (no AI); the assistant reads only
 * those pages, told what the person is looking for and which items are already known, and
 * proposes items about it, each quote checked as a scan checks them. The result is kept in
 * `knowledge/finds/<slug>.yaml`; the developer keeps a candidate as the kind they choose, and
 * it becomes a knowledge item they verified, flagged `found:<slug>`, which a rescan keeps while
 * its quote is still on its page.
 */

export const FINDS_DIR = "finds";

export interface PageMatch {
  source: string;
  page: string;
  section: string;
  line: number;
  excerpt: string;
}

const fold = (s: string) =>
  s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
const STOP = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "for",
  "and",
  "or",
  "in",
  "on",
  "how",
  "do",
  "i",
]);
const words = (s: string) =>
  fold(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w));

/**
 * The sections that mention a phrase: one with the phrase on a line, or every word of it
 * somewhere in the section. One match per section, at its first line that has it.
 */
export function searchPages(snapshots: Snapshot[], phrase: string): PageMatch[] {
  const want = fold(phrase);
  const ws = words(phrase);
  if (!want) return [];
  const out: PageMatch[] = [];
  for (const s of snapshots)
    for (const p of s.pages) {
      const lines = (p.text ?? "").split(/\r?\n/);
      let section = "";
      let start = 0;
      const flush = (end: number) => {
        const body = lines.slice(start, end);
        const hit = body.findIndex((l) => fold(l).includes(want));
        const all = ws.length > 1 && ws.every((w) => words(body.join(" ")).includes(w));
        if (hit < 0 && !all) return;
        const at = hit >= 0 ? hit : body.findIndex((l) => words(l).includes(ws[0]!));
        out.push({
          source: s.manifest.source,
          page: p.pagePath,
          section,
          line: start + at + 1,
          excerpt: body[at]!.trim().slice(0, 200),
        });
      };
      lines.forEach((l, i) => {
        const h = /^#{1,6}\s+(.*)$/.exec(l);
        if (h && i > start) {
          flush(i);
          start = i;
        }
        if (h) section = h[1]!.trim();
      });
      flush(lines.length);
    }
  return out;
}

export interface FindCandidate {
  record: KnowledgeRecord;
  /** The item it already is, when it is one. */
  known?: string;
  kept?: { by: string; at: string; as: KnowledgeKind };
}

export interface FindResult {
  status: "found" | "nothing" | "waiting" | "failed";
  phrase: string;
  runId?: string;
  matches: PageMatch[];
  candidates: FindCandidate[];
  failed: FailedItem[];
  problems: string[];
}

/** Search, then have the assistant read the pages that mention it. */
export async function findKnowledge(
  snapshots: Snapshot[],
  phrase: string,
  o: {
    runtime: AiRuntime;
    items: KnowledgeRecord[];
    orgPack?: Pick<OrgPack, "agents" | "runtime" | "pack">;
    now?: Date;
    resume?: string;
    maxAttempts?: number;
  },
): Promise<FindResult> {
  const matches = searchPages(snapshots, phrase);
  const base: FindResult = {
    status: "nothing",
    phrase,
    matches,
    candidates: [],
    failed: [],
    problems: [],
  };
  if (!matches.length) return base;
  const pages = new Set(matches.map((m) => `${m.source}/${m.page}`));
  const read = snapshots
    .map((s) => ({
      ...s,
      pages: s.pages.filter((p) => pages.has(`${s.manifest.source}/${p.pagePath}`)),
    }))
    .filter((s) => s.pages.length);
  const known = o.items.filter((i) => i.quote && pages.has(`${i.quote.source}/${i.quote.page}`));
  const r = await scanKnowledge(read, {
    runtime: o.runtime,
    ...(o.orgPack ? { orgPack: o.orgPack } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.resume ? { resume: o.resume } : {}),
    ...(o.maxAttempts ? { maxAttempts: o.maxAttempts } : {}),
    focus: { phrase, known },
  });
  const ids = new Set(o.items.map((i) => i.id));
  return {
    ...base,
    status: r.status === "scanned" ? "found" : r.status,
    ...(r.runId ? { runId: r.runId } : {}),
    candidates: r.items.map((record) => ({
      record,
      ...(ids.has(record.id) ? { known: record.id } : {}),
    })),
    failed: r.failed,
    problems: r.status === "failed" ? (r.attempts.at(-1)?.problems ?? []) : [],
  };
}

const FindFile = z.object({
  schemaVersion: z.literal(1),
  phrase: z.string(),
  at: z.string(),
  matches: z.array(z.unknown()).default([]),
  candidates: z
    .array(
      z.object({
        record: z.unknown(),
        known: z.string().optional(),
        kept: z.object({ by: z.string(), at: z.string(), as: z.enum(KNOWLEDGE_KINDS) }).optional(),
      }),
    )
    .default([]),
});

const slugOf = (s: string) =>
  fold(s)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "search";

const findsDir = (root: string) => join(knowledgeDirOf(root), FINDS_DIR);

/** Keep a search's result; the same phrase searched again replaces it. Returns its slug. */
export async function saveFind(root: string, r: FindResult, at: string): Promise<string> {
  const slug = slugOf(r.phrase);
  await writeFileAtomic(
    join(findsDir(root), `${slug}.yaml`),
    `# What a search of the wikis found (ADR 0101). atticus knowledge keep <candidate> --find ${slug} keeps one.\n${stringify(
      {
        schemaVersion: 1,
        phrase: r.phrase,
        at,
        matches: r.matches,
        candidates: r.candidates,
      },
      { lineWidth: 0 },
    )}`,
  );
  return slug;
}

export interface SavedFind {
  slug: string;
  phrase: string;
  at: string;
  matches: PageMatch[];
  candidates: FindCandidate[];
}

export async function readFind(root: string, slug: string): Promise<SavedFind | undefined> {
  const text = await readFile(join(findsDir(root), `${slug}.yaml`), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const f = FindFile.safeParse(parse(text));
  if (!f.success) return undefined;
  const candidates: FindCandidate[] = [];
  for (const c of f.data.candidates) {
    const p = parseRecord(c.record);
    if (p.ok)
      candidates.push({
        record: p.record as KnowledgeRecord,
        ...(c.known ? { known: c.known } : {}),
        ...(c.kept ? { kept: c.kept } : {}),
      });
  }
  return {
    slug,
    phrase: f.data.phrase,
    at: f.data.at,
    matches: f.data.matches as PageMatch[],
    candidates,
  };
}

/** The saved searches, newest first. */
export async function readFinds(
  root: string,
): Promise<{ slug: string; phrase: string; at: string; candidates: number; kept: number }[]> {
  const out = [];
  for (const f of (await readdir(findsDir(root)).catch(() => [] as string[])).filter((x) =>
    x.endsWith(".yaml"),
  )) {
    const s = await readFind(root, f.replace(/\.yaml$/, ""));
    if (s)
      out.push({
        slug: s.slug,
        phrase: s.phrase,
        at: s.at,
        candidates: s.candidates.length,
        kept: s.candidates.filter((c) => c.kept).length,
      });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

const KIND_FIELD: Record<string, [string, (k: KnowledgeKind) => string]> = {
  Pattern: ["patternKind", (k) => (k === "standard" ? "standard" : "integration-pattern")],
  ProcessDefinition: ["processKind", (k) => k],
  Decision: ["decisionKind", (k) => k],
  Party: ["partyKind", (k) => (k === "vendor" ? "vendor" : "internal-team")],
  Product: ["productKind", (k) => k],
};

/**
 * Keep a candidate: it becomes a knowledge item the person verified (or corrected, with --set),
 * as the kind they choose among those its record can be.
 */
export async function keepCandidate(
  root: string,
  slug: string,
  id: string,
  o: {
    as?: KnowledgeKind;
    by: string;
    at: string;
    note?: string;
    set?: Record<string, string | string[]>;
  },
): Promise<{ item: KnowledgeRecord; as: KnowledgeKind } | { error: string }> {
  const f = await readFind(root, slug);
  if (!f) return { error: `There is no saved search ${slug}. atticus knowledge finds lists them.` };
  const c = f.candidates.find((x) => x.record.id === id);
  if (!c)
    return {
      error: `The search ${slug} has no candidate ${id}: it has ${f.candidates.map((x) => x.record.id).join(", ")}.`,
    };
  if (c.known)
    return {
      error: `${id} is already a knowledge item: atticus knowledge verify ${id} marks it right.`,
    };
  const current = knowledgeKindOf(c.record)!;
  const as = o.as ?? current;
  const allowed = KNOWLEDGE_KINDS.filter((k) => KNOWLEDGE_RECORD_KIND[k] === c.record.kind);
  if (!allowed.includes(as)) return { error: `${id} can be kept as ${allowed.join(" or ")}.` };
  const [field, value] = KIND_FIELD[c.record.kind]!;
  const flag = `found:${slug}`;
  const parsed = parseRecord({
    ...c.record,
    [field]: value(as),
    flags: [...new Set([...(c.record.flags ?? []), flag])],
  });
  if (!parsed.ok) return { error: parsed.issues.map((i) => `${i.path}: ${i.message}`).join("; ") };
  const item = parsed.record as KnowledgeRecord;
  const r = reviewItem(item, {
    verdict: o.set && Object.keys(o.set).length ? "corrected" : "verified",
    by: o.by,
    at: o.at,
    ...(o.note ? { note: o.note } : {}),
    ...(o.set ? { set: o.set } : {}),
  });
  if ("error" in r) return { error: r.error };
  await writeFileAtomic(
    join(knowledgeDirOf(root), "items", ...recordPath(item).split("/")),
    serializeRecord(item),
  );
  await writeReview(root, r.review);
  c.kept = { by: o.by, at: o.at, as };
  c.record = item;
  await writeFileAtomic(
    join(findsDir(root), `${slug}.yaml`),
    `# What a search of the wikis found (ADR 0101). atticus knowledge keep <candidate> --find ${slug} keeps one.\n${stringify(
      {
        schemaVersion: 1,
        phrase: f.phrase,
        at: f.at,
        matches: f.matches,
        candidates: f.candidates,
      },
      { lineWidth: 0 },
    )}`,
  );
  return { item: r.item, as };
}
