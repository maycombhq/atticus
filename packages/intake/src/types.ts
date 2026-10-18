import { createHash } from "node:crypto";
import type { CatalogRecord } from "@maycombhq/core";
import type { Classification } from "./classify.js";

/** What happened to a file in inputs/. */
export type DocumentStatus =
  /** A reader took facts from it. */
  | "read"
  /** Free text or an image: AI reading, later. Nothing is taken from it yet. */
  | "needs-reading"
  /** A known kind of file that no plugged-in reader handles (yet). */
  | "no-reader"
  /** A partner spec whose system nobody has named yet: its facts wait in triage. */
  | "unresolved"
  /** Byte for byte the same as another file; nothing is taken from it twice. */
  | "duplicate"
  /** An older version of another file; its facts are left out. */
  | "superseded"
  /** The reader threw; see problems. */
  | "failed";

export interface IntakeDocument {
  /** Relative to the metarepo root, always starting with inputs/. */
  path: string;
  /** The SourceDocument record id (none for a duplicate). */
  id?: string;
  classification: Classification;
  status: DocumentStatus;
  /** "name@version" of what read it. */
  reader?: string;
  /** sha-256 of the bytes. */
  hash: string;
  title?: string;
  version?: string;
  date?: string;
  supersededBy?: string;
  duplicateOf?: string;
  /** Systems the file is about, through the alias table. */
  systems: string[];
  /** Names in the file that match nothing in the catalog. */
  unknownNames: string[];
  /** Ids of the records read from it. */
  records: string[];
  /** What the ingested-content defences found, when the risk is medium or high (or a person cleared it). */
  defences?: { risk: "medium" | "high" | "cleared"; reason: string; rules: string[] };
}

export interface IntakeProblem {
  path: string;
  message: string;
}

export type TriageKind =
  /** Ingested text the defences found hidden, encoded or built to steer an AI (ADR 0042): kept out of every AI step until a person decides. */
  | "defences"
  /** Documents and code disagree, or two sources give two values: code stands until decided. */
  | "conflict"
  /** A name that matches nothing: someone says what it is. */
  | "unknown-name"
  /** A name matched only through the profile: someone confirms it. */
  | "alias-needed"
  /** Something read off an image: someone confirms it before it counts. */
  | "image-edges"
  /** Two files look like versions of one document and nothing says which is newer. */
  | "version-unclear"
  /** On the diagram but not in code, or the other way round. */
  | "diagram-gap"
  /** Marked new, modify or retire: work for a change. */
  | "planned"
  /** A work item that looks like what built a feature (ADR 0031): someone confirms the link. */
  | "feature-link";

export const KIND_ORDER: TriageKind[] = [
  "defences",
  "conflict",
  "unknown-name",
  "alias-needed",
  "image-edges",
  "version-unclear",
  "diagram-gap",
  "planned",
  "feature-link",
];

export type DecisionAction = "alias" | "assert" | "suppress" | "resolve-conflict" | "classify";

/** The CuratedDecision a person would confirm, before who and when are known. */
export interface DecisionDraft {
  id: string;
  target: string;
  action: DecisionAction;
  value: unknown;
  reason: string;
}

export interface TriageOption {
  action: DecisionAction;
  label: string;
  decision: DecisionDraft;
}

export interface TriageItem {
  /** Stable across runs: kind plus what it is about. */
  id: string;
  kind: TriageKind;
  summary: string;
  source: { path: string; line?: number; page?: string; cell?: string };
  records: string[];
  options: TriageOption[];
  /** Work that isn't a catalog decision (redraw, plan a change). */
  next?: string;
}

export interface ScanInputsResult {
  records: CatalogRecord[];
  documents: IntakeDocument[];
  triage: TriageItem[];
  problems: IntakeProblem[];
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** A record id from a prefix and free text, kept under the 120-character limit. */
export function boundedId(prefix: string, key: string): string {
  const id = `${prefix}${key}`;
  if (id.length <= 120) return id;
  return `${id.slice(0, 110)}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}

export const sortItems = (items: TriageItem[]) =>
  [...new Map(items.map((i) => [i.id, i])).values()].sort((a, b) =>
    a.kind === b.kind
      ? a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0
      : KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );

/** Option builders, so every item offers decisions in one shape. */
export const opt = {
  alias(name: string, target: string): TriageOption {
    const label = `"${name}" is ${target}`;
    return {
      action: "alias",
      label,
      decision: {
        id: boundedId("alias.", slug(name)),
        target,
        action: "alias",
        value: name,
        reason: label,
      },
    };
  },
  /** Close the item without changing any record (a scoped suppress). */
  dismiss(itemId: string, target: string, label = "Dismiss"): TriageOption {
    return {
      action: "suppress",
      label,
      decision: {
        id: boundedId("triage.", itemId),
        target,
        action: "suppress",
        value: { triage: itemId },
        reason: label === "Dismiss" ? "Dismissed in triage" : label,
      },
    };
  },
  make(itemId: string, action: DecisionAction, target: string, value: unknown, label: string) {
    return {
      action,
      label,
      decision: { id: boundedId("triage.", itemId), target, action, value, reason: label },
    } satisfies TriageOption;
  },
};
