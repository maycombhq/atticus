import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
  knowledgeDirOf,
  knowledgeKindOf,
  parseRecord,
  RecordId,
  writeFileAtomic,
} from "@maycombhq/core";
import type { KnowledgeRecord } from "./knowledge-scan.js";

/**
 * People's reviews of what the knowledge scan read (ADR 0101). The scan's items are the AI's,
 * replaced on every scan; a person's verdict is their own file, `knowledge/reviews/<id>.yaml`,
 * committed with the metarepo, so it outlives every rescan:
 *
 * - **verified**: the item is right as read.
 * - **corrected**: right once the fields the person set are used (a CTASK's catalogue item, its
 *   lead time, its inputs or steps). Reading the knowledge gives the corrected item.
 * - **rejected**: wrong; plans and answers leave it out, lists still show it, with the reason.
 *
 * A review keeps a hash of what the item meant when it was checked. When a rescan changes the
 * item (its page changed), the review is stale: its tick waits for a person to check it again.
 * What the page quoted can't be corrected: a quote is checked word for word on its page.
 */

export const REVIEWS_DIR = "reviews";

export const KnowledgeReview = z.strictObject({
  schemaVersion: z.literal(1),
  item: RecordId,
  verdict: z.enum(["verified", "corrected", "rejected"]),
  /** The person, as git names them. */
  by: z.string().min(1),
  at: z.iso.datetime({ offset: true }),
  note: z.string().optional(),
  /** Field → the value to read instead of the scan's (corrected only). */
  corrections: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  /** What the item meant when it was checked (itemMeaning). */
  checked: z.string().regex(/^[0-9a-f]{16}$/),
});
export type KnowledgeReview = z.infer<typeof KnowledgeReview>;

export type ReviewState = "verified" | "corrected" | "rejected" | "stale";

export interface ReviewSummary {
  state: ReviewState;
  /** What the person said last; for a stale review, what they said before the page changed. */
  verdict: KnowledgeReview["verdict"];
  by: string;
  at: string;
  note?: string;
  /** The fields a correction set. */
  corrected?: string[];
}

/** The fields a person may correct, by record kind; the lists take several values. */
const CORRECTABLE: Record<string, Record<string, "text" | "list">> = {
  ProcessDefinition: {
    title: "text",
    appliesWhen: "text",
    leadTime: "text",
    handledBy: "text",
    catalogueItem: "text",
    inputs: "list",
    steps: "list",
    notes: "text",
  },
  Pattern: {
    name: "text",
    definition: "text",
    rules: "list",
    appliesWhen: "text",
    handledBy: "text",
  },
  Decision: { title: "text", appliesWhen: "text", handledBy: "text", reason: "text" },
  Party: {
    name: "text",
    owner: "text",
    responsibilities: "list",
    owns: "list",
    uses: "list",
    contacts: "list",
    channel: "text",
  },
  Product: {
    name: "text",
    description: "text",
    ownedBy: "text",
    usedBy: "list",
    vendor: "text",
    systems: "list",
  },
};
const FIXED = new Set(["quote", "alsoOn", "evidence", "id", "kind", "schemaVersion", "status"]);

/** The fields a person may correct on an item, with whether each takes a list. */
export const correctableFields = (r: { kind: string }): Record<string, "text" | "list"> =>
  CORRECTABLE[r.kind] ?? {};

const kindWord = (r: KnowledgeRecord) => knowledgeKindOf(r) ?? r.kind.toLowerCase();

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  return v;
}

/**
 * What an item means, as a short hash: everything but its evidence and where its quotes were
 * read (the snapshot date and line move when a page is copied again or edited above them).
 */
export function itemMeaning(r: KnowledgeRecord): string {
  const strip = (q: Record<string, unknown> | undefined) =>
    q ? Object.fromEntries(Object.entries(q).filter(([k]) => k !== "snapshot" && k !== "line")) : q;
  const x = { ...(r as unknown as Record<string, unknown>) };
  delete x.evidence;
  x.quote = strip(x.quote as Record<string, unknown> | undefined);
  if (Array.isArray(x.alsoOn)) x.alsoOn = (x.alsoOn as Record<string, unknown>[]).map(strip);
  return createHash("sha256")
    .update(JSON.stringify(canonical(x)))
    .digest("hex")
    .slice(0, 16);
}

/** A person's verdict on an item, checked; the corrected item comes back with it. */
export function reviewItem(
  item: KnowledgeRecord,
  o: {
    verdict: KnowledgeReview["verdict"];
    by: string;
    at: string;
    note?: string;
    set?: Record<string, string | string[]>;
  },
): { review: KnowledgeReview; item: KnowledgeRecord } | { error: string } {
  const set = o.set ?? {};
  if (o.verdict === "rejected" && !o.note?.trim())
    return { error: "Say why it is wrong (--note): the next person reads it." };
  if (o.verdict === "corrected" && !Object.keys(set).length)
    return { error: 'Say what to correct, for example --set leadTime="3 working days".' };
  if (o.verdict !== "corrected" && Object.keys(set).length)
    return { error: "Only a correction sets fields." };
  const fields = correctableFields(item);
  const corrections: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(set)) {
    if (FIXED.has(k))
      return { error: `${k} can't be corrected: it is what the page says, checked word for word.` };
    const type = fields[k];
    if (!type)
      return {
        error: `A ${kindWord(item)} has no field ${k}. It has: ${Object.keys(fields).join(", ")}.`,
      };
    const value =
      type === "list" ? (Array.isArray(v) ? v : [v]) : Array.isArray(v) ? v.join(", ") : v;
    corrections[k] =
      type === "list"
        ? (value as string[]).map((s) => s.trim()).filter(Boolean)
        : String(value).trim();
  }
  const merged = { ...item, ...corrections } as KnowledgeRecord;
  const parsed = parseRecord(merged);
  if (!parsed.ok)
    return {
      error: `The corrected item isn't valid: ${parsed.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    };
  const review = KnowledgeReview.parse({
    schemaVersion: 1,
    item: item.id,
    verdict: o.verdict,
    by: o.by,
    at: o.at,
    ...(o.note?.trim() ? { note: o.note.trim() } : {}),
    ...(Object.keys(corrections).length ? { corrections } : {}),
    checked: itemMeaning(item),
  });
  return { review, item: parsed.record as KnowledgeRecord };
}

export async function writeReview(root: string, review: KnowledgeReview): Promise<string> {
  const rel = `${REVIEWS_DIR}/${review.item}.yaml`;
  await writeFileAtomic(
    join(knowledgeDirOf(root), ...rel.split("/")),
    `# A person's review of the knowledge item ${review.item} (ADR 0101). Commit it with the metarepo.\n${stringify(KnowledgeReview.parse(review))}`,
  );
  return rel;
}

/** Every review in the metarepo, by item id; unreadable files are reported. */
export async function readReviews(root: string): Promise<{
  reviews: Map<string, KnowledgeReview>;
  problems: { file: string; message: string }[];
}> {
  const dir = join(knowledgeDirOf(root), REVIEWS_DIR);
  const reviews = new Map<string, KnowledgeReview>();
  const problems: { file: string; message: string }[] = [];
  for (const f of (await readdir(dir).catch(() => [] as string[]))
    .filter((x) => /\.ya?ml$/.test(x))
    .sort()) {
    try {
      const r = KnowledgeReview.safeParse(parse(await readFile(join(dir, f), "utf8")));
      if (r.success) reviews.set(r.data.item, r.data);
      else
        problems.push({
          file: `${REVIEWS_DIR}/${f}`,
          message: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        });
    } catch (e) {
      problems.push({ file: `${REVIEWS_DIR}/${f}`, message: (e as Error).message.split("\n")[0]! });
    }
  }
  return { reviews, problems };
}

/** An item as people reviewed it: the corrections applied, and its review's state. */
export function applyReview(
  item: KnowledgeRecord,
  review: KnowledgeReview | undefined,
): { item: KnowledgeRecord; summary?: ReviewSummary } {
  if (!review) return { item };
  const stale = review.checked !== itemMeaning(item);
  const summary: ReviewSummary = {
    state: stale ? "stale" : review.verdict,
    verdict: review.verdict,
    by: review.by,
    at: review.at,
    ...(review.note ? { note: review.note } : {}),
    ...(review.corrections ? { corrected: Object.keys(review.corrections).sort() } : {}),
  };
  if (!review.corrections) return { item, summary };
  const merged = parseRecord({ ...item, ...review.corrections });
  return { item: merged.ok ? (merged.record as KnowledgeRecord) : item, summary };
}
