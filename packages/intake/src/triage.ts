import { parseRecord, type CatalogRecord, type RecordOf } from "@maycombhq/core";
import type { ReconcileItem } from "@maycombhq/reconcile";
import {
  boundedId,
  opt,
  slug,
  sortItems,
  type ScanInputsResult,
  type TriageItem,
  type TriageKind,
  type TriageOption,
} from "./types.js";

/**
 * Triage: one list of what a person must decide, from intake, reconcile and the catalog.
 * Only what can't be settled automatically: unknown names, aliases to confirm, conflicts with
 * code, edges read from images, versions nobody can order, diagram gaps and planned work.
 * Each option carries the CuratedDecision it would write; deciding writes that decision, and
 * an item a decision already answers is left out. Code always stands until someone decides.
 */

export interface BuildTriageInput {
  /** The catalog (generated records, after merge). */
  records: CatalogRecord[];
  /** What scanInputs returned. */
  inputs?: ScanInputsResult;
  /** Reconcile items per diagram file. */
  reconcileItems?: { file: string; items: ReconcileItem[] }[];
  /** Decisions already made (catalog/curated); other records are ignored. */
  decisions?: CatalogRecord[];
}

export interface DecideOptions {
  by: string;
  reason?: string;
  /** ISO timestamp; default now. */
  at?: string;
}

export interface Triage {
  items: TriageItem[];
  /** The CuratedDecision record for one option of one item, to write under catalog/curated. */
  decide(itemId: string, optionIndex: number, o: DecideOptions): RecordOf<"CuratedDecision">;
}

export class TriageError extends Error {}

const RECONCILE_KIND: Record<ReconcileItem["type"], TriageKind> = {
  "alias-needed": "alias-needed",
  "unknown-box": "unknown-name",
  "pattern-mismatch": "conflict",
  "pattern-differs": "conflict",
  "unknown-pattern": "conflict",
  "drawn-call-reads-database": "conflict",
  "direction-differs": "conflict",
  "diagram-only": "diagram-gap",
  "code-only": "diagram-gap",
  planned: "planned",
};

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|heic)$/i;

type Rec = Record<string, unknown> & {
  kind: string;
  id: string;
  evidence: Record<string, unknown>[];
};

function fromReconcile(
  file: string,
  i: ReconcileItem,
  docIdOf: (path: string) => string,
): TriageItem {
  const kind = RECONCILE_KIND[i.type];
  const subject = i.records[0] ?? docIdOf(i.diagram?.file ?? file);
  const options: TriageOption[] = [];
  const s = i.suggestion;
  if (kind === "unknown-name" && i.name) {
    for (const id of i.records) options.push(opt.alias(i.name, id));
    options.push(opt.dismiss(i.id, docIdOf(i.diagram?.file ?? file)));
  } else if (s?.action === "alias" && i.name && s.target) {
    options.push(opt.alias(i.name, s.target), opt.dismiss(i.id, s.target));
  } else if (s?.action && s.target) {
    options.push(opt.make(i.id, s.action, s.target, s.value ?? null, s.text));
    if (kind === "conflict") options.push(opt.dismiss(i.id, subject, "The code is right"));
  } else if (kind === "planned") {
    options.push(opt.dismiss(i.id, subject, "Not planned any more"));
  } else if (kind === "conflict") {
    options.push(opt.dismiss(i.id, subject, "The code is right"));
  } else {
    options.push(opt.dismiss(i.id, subject));
  }
  const next = s && !s.action ? s.text : undefined;
  return {
    id: i.id,
    kind,
    summary: i.summary,
    source: i.diagram
      ? { path: i.diagram.file, line: i.diagram.line, page: i.diagram.page, cell: i.diagram.cell }
      : { path: file },
    records: i.records,
    options,
    ...(next ? { next } : {}),
  };
}

/** Open `conflicts` entries on records: offer each value, marking the one the code gives. */
function conflictItems(records: Rec[]): TriageItem[] {
  const out: TriageItem[] = [];
  for (const r of records) {
    const conflicts = (Array.isArray(r.conflicts) ? r.conflicts : []) as {
      field: string;
      values: string[];
      note?: string;
    }[];
    const fromCode = r.evidence.some((e) => e.source === "code" || e.source === "config");
    for (const c of conflicts) {
      const itemId = `conflict.${slug(`${r.id}-${c.field}`)}`;
      const notePath = c.note && /^[\w./-]+\.\w+$/.test(c.note) ? c.note : undefined;
      const where = notePath ?? (r.evidence.find((e) => e.source !== "code")?.path as string);
      out.push({
        id: itemId,
        kind: "conflict",
        summary: `${r.id} has two values for ${c.field}: ${c.values.join(", ")}${c.note ? ` (${c.note})` : ""}. The code stands until someone decides.`,
        source: { path: where ?? String(r.evidence[0]?.path ?? "") },
        records: [r.id],
        options: c.values.map((v) =>
          opt.make(
            itemId,
            "resolve-conflict",
            r.id,
            { [c.field]: v },
            `${c.field} is ${v}${fromCode && r[c.field] === v ? " (what the code says)" : ""}`,
          ),
        ),
      });
    }
  }
  return out;
}

/** Records whose only sources are images: read by an AI ingestor, so a person confirms them. */
function imageItems(records: Rec[]): TriageItem[] {
  return records
    .filter(
      (r) =>
        r.kind !== "SourceDocument" &&
        r.evidence.length > 0 &&
        r.evidence.every(
          (e) =>
            (e.source === "diagram" || e.source === "document") &&
            typeof e.path === "string" &&
            IMAGE.test(e.path),
        ),
    )
    .map((r) => {
      const itemId = `image-edges.${r.id}`;
      const ends = r.kind === "Interface" ? ` (${String(r.from)} → ${String(r.to)})` : "";
      const line = r.evidence[0]!.line as number | undefined;
      return {
        id: itemId,
        kind: "image-edges",
        summary: `${r.kind} ${r.id}${ends} was read from an image; confirm it before it counts.`,
        source: { path: String(r.evidence[0]!.path), ...(line ? { line } : {}) },
        records: [r.id],
        options: [
          opt.make(itemId, "assert", r.id, {}, "Confirm it"),
          opt.make(itemId, "suppress", r.id, null, "It's wrong; drop it"),
        ],
      } satisfies TriageItem;
    });
}

const key = (action: string, target: string, value: unknown) =>
  `${action}|${target}|${JSON.stringify(value ?? null)}`;

export function buildTriage(input: BuildTriageInput): Triage {
  const decisions = (input.decisions ?? []).filter(
    (d): d is RecordOf<"CuratedDecision"> => d.kind === "CuratedDecision" && d.status === "current",
  );
  const decidedIds = new Set(decisions.map((d) => d.id));
  const decidedKeys = new Set(decisions.map((d) => key(d.action, d.target, d.value)));
  const docs = new Map((input.inputs?.documents ?? []).map((d) => [d.path, d.id]));
  const docIdOf = (path: string) =>
    docs.get(path) ??
    boundedId(
      "doc.",
      slug(
        path
          .split("/")
          .pop()!
          .replace(/\.[^.]+$/, ""),
      ),
    );

  const records = input.records as unknown as Rec[];
  const seen = new Set(records.map((r) => `${r.kind}|${r.id}`));
  const inputRecords = ((input.inputs?.records ?? []) as unknown as Rec[]).filter(
    (r) => !seen.has(`${r.kind}|${r.id}`),
  );
  const all: TriageItem[] = [
    ...(input.inputs?.triage ?? []),
    ...(input.reconcileItems ?? []).flatMap((g) =>
      g.items.map((i) => fromReconcile(g.file, i, docIdOf)),
    ),
    ...conflictItems(records),
    ...imageItems([...records, ...inputRecords]),
  ];
  const open = all.filter(
    (i) =>
      !i.options.some(
        (o) =>
          decidedIds.has(o.decision.id) ||
          decidedKeys.has(key(o.decision.action, o.decision.target, o.decision.value)),
      ),
  );
  const items = sortItems(open);

  return {
    items,
    decide(itemId, optionIndex, o) {
      const item = items.find((i) => i.id === itemId);
      if (!item) throw new TriageError(`There is no open triage item ${itemId}.`);
      const option = item.options[optionIndex];
      if (!option)
        throw new TriageError(
          `${itemId} has ${item.options.length} option${item.options.length === 1 ? "" : "s"}; pick 1 to ${item.options.length}.`,
        );
      const d = option.decision;
      const p = parseRecord({
        schemaVersion: 1,
        kind: "CuratedDecision",
        id: d.id,
        status: "current",
        confidence: "asserted",
        evidence: [
          {
            source: "manual",
            by: o.by,
            path: item.source.path,
            ...(item.source.line ? { line: item.source.line } : {}),
          },
        ],
        target: d.target,
        action: d.action,
        value: d.value,
        reason: o.reason?.trim() || d.reason,
        by: o.by,
        at: o.at ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      });
      if (!p.ok)
        throw new TriageError(
          `That decision isn't valid: ${p.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        );
      return p.record as RecordOf<"CuratedDecision">;
    },
  };
}
