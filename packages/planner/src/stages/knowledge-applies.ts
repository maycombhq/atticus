import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { changeFolder } from "@maycombhq/changes";
import { changesRelOf, toCanonicalYaml } from "@maycombhq/core";
import type { ContextReport } from "../engine.js";

/**
 * The knowledge that applies to a change, listed (ADR 0124, Part 5). Every stage's context
 * selection already finds the wiki sections, documents, patterns, standards, decisions,
 * processes, vendors and terms that bear on a change (ADR 0083, 0107, 0116); this keeps the
 * list a person sees: `knowledge.yaml` in the change folder, each item with why it was picked,
 * the stages that used it and a status a person sets (confirmed or excluded), and the
 * near-misses the selection left out for room, so a person can promote one. An excluded item is
 * kept out of every later stage's selection.
 */

/** Index kinds that are knowledge (not code facts). */
export const KNOWLEDGE_INDEX_KINDS = [
  "Pattern",
  "Decision",
  "ProcessDefinition",
  "Party",
  "Product",
  "GlossaryTerm",
  "SourceDocument",
  "WikiSection",
  "DocumentSection",
] as const;

const isKnowledge = (kind: string) => (KNOWLEDGE_INDEX_KINDS as readonly string[]).includes(kind);

export const KnowledgeStatus = z.enum(["suggested", "confirmed", "excluded"]);
export type KnowledgeStatus = z.infer<typeof KnowledgeStatus>;

export const KnowledgeApplies = z.strictObject({
  schemaVersion: z.literal(1),
  change: z.string().min(1),
  items: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        kind: z.string().min(1),
        status: KnowledgeStatus,
        /** The stages whose selection picked it, in the order they did. */
        stages: z.array(z.string()),
        /** Its best score in any stage. */
        score: z.number(),
        /** Why it was picked: named in the input, a search hit, or the link it was reached by. */
        why: z.string().optional(),
        /** Where it lives, when the index knows the file. */
        file: z.string().optional(),
      }),
    )
    .default([]),
  /** Knowledge the selection left out for room, by stage: a person may confirm one. */
  nearMisses: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        kind: z.string().min(1),
        score: z.number(),
        stage: z.string(),
      }),
    )
    .default([]),
});
export type KnowledgeApplies = z.infer<typeof KnowledgeApplies>;

const FILE = "knowledge.yaml";
const pathOf = (root: string, change: string) => join(changeFolder(root, change), FILE);

export async function readKnowledgeApplies(
  root: string,
  change: string,
): Promise<KnowledgeApplies | undefined> {
  const text = await readFile(pathOf(root, change), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const r = KnowledgeApplies.safeParse(parse(text));
  return r.success ? r.data : undefined;
}

async function write(root: string, doc: KnowledgeApplies): Promise<void> {
  const order = { confirmed: 0, suggested: 1, excluded: 2 } as const;
  const items = [...doc.items].sort(
    (a, b) => order[a.status] - order[b.status] || b.score - a.score || a.id.localeCompare(b.id),
  );
  const nearMisses = [...doc.nearMisses].sort(
    (a, b) => a.stage.localeCompare(b.stage) || b.score - a.score || a.id.localeCompare(b.id),
  );
  await mkdir(changeFolder(root, doc.change), { recursive: true });
  await writeFile(
    pathOf(root, doc.change),
    toCanonicalYaml({ ...doc, items, nearMisses }, ["schemaVersion", "change"]),
    "utf8",
  );
}

/**
 * Record what a stage's selection picked and left out. Nothing is written for a stage that sent
 * the whole lists (no selection to report). A person's status is never overwritten.
 */
export async function recordKnowledge(
  root: string,
  change: string,
  stage: string,
  report: ContextReport | undefined,
): Promise<void> {
  if (!report?.engine) return;
  const picked = report.picked.filter((p) => isKnowledge(p.kind));
  const left = report.leftOut.filter((l) => isKnowledge(l.kind));
  const before = await readKnowledgeApplies(root, change);
  if (!before && !picked.length && !left.length) return;
  const doc: KnowledgeApplies = before ?? { schemaVersion: 1, change, items: [], nearMisses: [] };
  const byId = new Map(doc.items.map((i) => [i.id, i] as const));
  for (const p of picked) {
    const cur = byId.get(p.id);
    if (cur) {
      if (!cur.stages.includes(stage)) cur.stages.push(stage);
      cur.score = Math.max(cur.score, p.score);
      if (!cur.why && p.via) cur.why = p.via;
      if (!cur.file && p.file) cur.file = p.file;
    } else
      byId.set(p.id, {
        id: p.id,
        kind: p.kind,
        status: "suggested",
        stages: [stage],
        score: p.score,
        ...(p.via ? { why: p.via } : {}),
        ...(p.file ? { file: p.file } : {}),
      });
  }
  doc.items = [...byId.values()];
  doc.nearMisses = [
    ...doc.nearMisses.filter((n) => n.stage !== stage),
    ...left
      .filter((l) => !byId.has(l.id))
      .map((l) => ({ id: l.id, kind: l.kind, score: l.score, stage })),
  ];
  await write(root, doc);
}

/** A person confirms or excludes an item (or a near-miss, which becomes an item). */
export async function setKnowledgeStatus(
  root: string,
  change: string,
  id: string,
  status: KnowledgeStatus,
): Promise<KnowledgeApplies> {
  const doc = await readKnowledgeApplies(root, change);
  const rel = `${changesRelOf(root)}/${change}/${FILE}`;
  if (!doc) throw new Error(`${rel} doesn't exist yet: run a stage of ${change} first.`);
  const item = doc.items.find((i) => i.id === id);
  if (item) item.status = status;
  else {
    const near = doc.nearMisses.find((n) => n.id === id);
    if (!near) throw new Error(`${id} is not in ${rel}: name an item or a near-miss it lists.`);
    doc.items.push({ id, kind: near.kind, status, stages: [], score: near.score, why: "a person" });
    doc.nearMisses = doc.nearMisses.filter((n) => n.id !== id);
  }
  await write(root, doc);
  return doc;
}

/** Ids a person excluded: kept out of every later stage's selection. */
export async function excludedKnowledge(root: string, change: string): Promise<string[]> {
  const doc = await readKnowledgeApplies(root, change);
  return (doc?.items ?? [])
    .filter((i) => i.status === "excluded")
    .map((i) => i.id)
    .sort();
}

/** The list for a hand-off PR or the app: what applies, and what nearly did. */
export function knowledgeAppliesMarkdown(doc: KnowledgeApplies): string {
  const shown = doc.items.filter((i) => i.status !== "excluded");
  const lines = ["### Applies to this change", ""];
  if (!shown.length) lines.push("Nothing in the org's knowledge was picked for this change.");
  for (const i of shown) {
    const why = [i.status, i.stages.join(", "), i.why].filter(Boolean).join("; ");
    lines.push(`- ${i.kind} ${i.id} (${why})${i.file ? `: ${i.file}` : ""}`);
  }
  const excluded = doc.items.filter((i) => i.status === "excluded");
  if (excluded.length)
    lines.push("", `Excluded by a person: ${excluded.map((i) => i.id).join(", ")}.`);
  if (doc.nearMisses.length)
    lines.push(
      "",
      `Near-misses (left out for room; confirm one with atticus change knowledge ${doc.change} --confirm <id>): ${doc.nearMisses
        .slice(0, 15)
        .map((n) => n.id)
        .join(
          ", ",
        )}${doc.nearMisses.length > 15 ? ` and ${doc.nearMisses.length - 15} more` : ""}.`,
    );
  return lines.join("\n") + "\n";
}
