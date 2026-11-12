import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { cmpText, loadOrgPack, type CatalogRecord, type OrgPack } from "@maycombhq/core";
import { factsEstateRecords } from "./build-facts.js";
import { readSlots, type BuildSlots } from "./build.js";
import { targetsFromAnswers } from "./facts-catalog.js";
import { joinAnswerQuestions } from "./join-host-questions.js";
import { productionRepos } from "./merge-input.js";
import { orgPackDirFor } from "./scan.js";
import {
  DISMISSALS_VERSION,
  dismissalsPath,
  factsSlotPaths,
  parseDismissals,
  readersSlotPath,
  serializeDismissals,
  type CrossCheckDismissalsT,
} from "./slots.js";

/**
 * The readers' cross-check (ADR 0195 point 3, ticket CS3). For a repo with a current facts slot
 * and a readers slot of a full read (`status: read`), what the built-in readers found is compared
 * with what the facts project, record by record, and said in three lists: what the readers found
 * that the facts don't have, what both have with a different value, and what only the facts have
 * (a count, for information: the readers are known to miss things). Records are matched by their
 * C1 id, then by the kind's key where ids can differ (an Interface's caller, method and
 * normalised path; an Endpoint's method and path; a Table's name; a Column's `table.column`; a
 * Setting's key). Nothing is matched fuzzily, and nothing here changes the catalog: the facts are
 * the source, the readers slot is kept whole, and a person dismisses an item
 * (`facts/<repo>.crosscheck.yaml`), which is listed again only when the readers' value changes.
 */

export type CrossCheckState = "agree" | "readers-only" | "facts-only" | "disagree";

/** Where a record's value is said: the file and line at the slot's commit. */
export interface CrossCheckCite {
  file: string;
  line?: number;
  commit?: string;
}

export interface CrossCheckSide {
  /** The record's C1 id on this side. */
  id: string;
  /** The kind's value as this side says it (what a dismissal keeps for the readers). */
  value: unknown;
  cites: CrossCheckCite[];
}

export interface CrossCheckItem {
  /** `<Kind>|<the kind's key>`, as a dismissal names it. */
  key: string;
  kind: string;
  state: CrossCheckState;
  readers?: CrossCheckSide;
  facts?: CrossCheckSide;
  /** For a disagreement: each field both sides state, with both values. */
  fields?: { field: string; readers: unknown; facts: unknown }[];
  /** Dismissed at the readers' value it has now. */
  dismissed?: true;
}

export interface CrossCheckCounts {
  agree: number;
  /** Readers found it, the facts don't have it (not dismissed). */
  readersOnly: number;
  /** The facts have it, the readers don't. */
  factsOnly: number;
  /** Both have it, with a different value (not dismissed). */
  disagree: number;
  /** Items dismissed at the readers' value they still have. */
  dismissed: number;
}

/**
 * Why a repo is or isn't compared: `compared`; `no-facts` (no facts slot, so the readers are the
 * source and there is nothing to check them against); `no-readers` (no readers slot yet: scan
 * it); `legacy` (the readers slot is the upgrade's adoption of the old catalog, point 6, so it
 * isn't compared until a scan reads the repo); `unusable` (a slot that doesn't read; `problem`).
 */
export type RepoCrossCheckState = "compared" | "no-facts" | "no-readers" | "legacy" | "unusable";

export interface RepoCrossCheck {
  repo: string;
  state: RepoCrossCheckState;
  readersCommit?: string;
  factsCommit?: string;
  /** The slot files compared, relative to the root. */
  readersSlot?: string;
  factsSlot?: string;
  /** The dismissals file, relative to the root (whether there or not). */
  dismissals: string;
  counts: CrossCheckCounts;
  /** Every item but those that agree, readers-only and disagreements first, then facts-only. */
  items: CrossCheckItem[];
  problem?: string;
}

// ------------------------------------------------------------------ keys and values

/** The fields no comparison reads: identity, provenance and the record's own bookkeeping. */
const IGNORED = new Set([
  "kind",
  "id",
  "schemaVersion",
  "status",
  "confidence",
  "evidence",
  "conflicts",
  "pattern",
]);

/** A path's parameters, whatever their names, as `{}`: `/a/{accountId}` and `/a/{id}` match. */
export const normalisedPath = (p: string): string =>
  p
    .trim()
    .replace(/\{[^}/]*\}|:[A-Za-z_][A-Za-z0-9_]*/g, "{}")
    .replace(/\/+$/, "") || "/";

const lastSegment = (ref: string): string => ref.split(".").pop() ?? ref;

type Rec = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The kind's key (point 3): what two records of the same thing share when their ids differ. */
export function crossCheckKey(r: CatalogRecord): string {
  const x = r as unknown as Rec;
  switch (r.kind) {
    case "Interface":
      return `Interface|${str(x.from)} ${`${str(x.method)} ${normalisedPath(str(x.normalizedPath))}`.trim()}`;
    case "Endpoint":
      return `Endpoint|${`${str(x.method)} ${normalisedPath(str(x.normalizedPath) || str(x.pathOrTopic))}`.trim()}`;
    case "Table":
      return `Table|${str(x.name)}`;
    case "Column":
      return `Column|${lastSegment(str(x.table))}.${str(x.name)}`;
    case "Setting":
      return `Setting|${str(x.key)}`;
    default:
      return `${r.kind}|${r.id}`;
  }
}

const scalar = (v: unknown) =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * The kind's value: what the cross-check compares, and what a dismissal keeps of the readers'
 * side. A Setting's value is its value; an Endpoint's its method and path; an Interface's its
 * caller, callee, method, path and how it travels; a Table's its store, name and kind; a
 * Column's its type and whether it is nullable; any other kind's, its scalar fields.
 */
export function crossCheckValue(r: CatalogRecord): unknown {
  const x = r as unknown as Rec;
  const pick = (keys: string[]) =>
    Object.fromEntries(keys.filter((k) => x[k] !== undefined).map((k) => [k, x[k]]));
  switch (r.kind) {
    case "Setting":
      return x.valueOrRef ?? null;
    case "Endpoint": {
      const v: Rec = {};
      if (x.method !== undefined) v.method = x.method;
      v.path = x.pathOrTopic;
      return v;
    }
    case "Interface": {
      const v: Rec = pick(["from", "to", "method"]);
      v.path = x.normalizedPath;
      if (x.via !== undefined) v.via = x.via;
      return v;
    }
    case "Table":
      return pick(["dataStore", "name", "tableKind"]);
    case "Column":
      return pick(["type", "nullable"]);
    default:
      return Object.fromEntries(
        Object.keys(x)
          .filter((k) => !IGNORED.has(k) && scalar(x[k]))
          .sort(cmpText)
          .map((k) => [k, x[k]]),
      );
  }
}

/** One canonical text of a value (keys sorted), so two equal values compare equal. */
export function canonicalValue(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x as Rec)
              .sort(cmpText)
              .map((k) => [k, sort((x as Rec)[k])]),
          )
        : x;
  return JSON.stringify(sort(v) ?? null);
}

/** The fields both values state with a different value (a scalar value is one field). */
function differences(
  kind: string,
  a: unknown,
  b: unknown,
): { field: string; readers: unknown; facts: unknown }[] {
  if (!a || typeof a !== "object" || !b || typeof b !== "object") {
    if (a === null || a === undefined || b === null || b === undefined) return [];
    return canonicalValue(a) === canonicalValue(b)
      ? []
      : [{ field: kind === "Setting" ? "valueOrRef" : "value", readers: a, facts: b }];
  }
  const out: { field: string; readers: unknown; facts: unknown }[] = [];
  const ra = a as Rec;
  const rb = b as Rec;
  for (const k of Object.keys(ra).sort(cmpText)) {
    if (ra[k] === undefined || rb[k] === undefined) continue;
    if (canonicalValue(ra[k]) !== canonicalValue(rb[k]))
      out.push({ field: k, readers: ra[k], facts: rb[k] });
  }
  return out;
}

function citesOf(r: CatalogRecord): CrossCheckCite[] {
  const seen = new Set<string>();
  const out: CrossCheckCite[] = [];
  for (const e of r.evidence) {
    if (!e.path) continue;
    const k = `${e.path}:${e.line ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      file: e.path,
      ...(typeof e.line === "number" ? { line: e.line } : {}),
      ...(e.commit ? { commit: e.commit } : {}),
    });
  }
  return out.sort((x, y) => cmpText(x.file, y.file) || (x.line ?? 0) - (y.line ?? 0));
}

/** Every line a group of records cites, once each, in file and line order. */
function mergedCites(group: readonly CatalogRecord[]): CrossCheckCite[] {
  const seen = new Set<string>();
  const out: CrossCheckCite[] = [];
  for (const c of group.flatMap(citesOf)) {
    const k = `${c.file}:${c.line ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out.sort((x, y) => cmpText(x.file, y.file) || (x.line ?? 0) - (y.line ?? 0));
}

const side = (r: CatalogRecord): CrossCheckSide => ({
  id: r.id,
  value: crossCheckValue(r),
  cites: citesOf(r),
});

/** Is this item dismissed at the readers' value it has now? */
function isDismissed(d: CrossCheckDismissalsT | undefined, key: string, readers: unknown): boolean {
  const at = d?.dismissed.find((x) => x.key === key);
  return !!at && canonicalValue(at.readers) === canonicalValue(readers);
}

const ORDER: Record<CrossCheckState, number> = {
  "readers-only": 0,
  disagree: 1,
  "facts-only": 2,
  agree: 3,
};

/**
 * Compare a repo's readers records with its facts' projection (point 3). Pure: the same records
 * and dismissals give the same items, in kind, key and state order.
 */
export function compareReadersWithFacts(
  readers: readonly CatalogRecord[],
  facts: readonly CatalogRecord[],
  dismissals?: CrossCheckDismissalsT,
): { items: CrossCheckItem[]; counts: CrossCheckCounts } {
  const byId = new Map<string, CatalogRecord>();
  const byKey = new Map<string, CatalogRecord>();
  for (const f of facts) {
    byId.set(`${f.kind}/${f.id}`, f);
    const k = crossCheckKey(f);
    if (!byKey.has(k)) byKey.set(k, f);
  }
  const used = new Set<CatalogRecord>();
  const all: CrossCheckItem[] = [];
  const counts: CrossCheckCounts = {
    agree: 0,
    readersOnly: 0,
    factsOnly: 0,
    disagree: 0,
    dismissed: 0,
  };
  // The readers may say one thing twice before the merge (a controller and the OpenAPI file
  // beside it): one item per key, citing every line.
  const groups = new Map<string, CatalogRecord[]>();
  for (const r of [...readers].sort((a, b) => cmpText(a.kind, b.kind) || cmpText(a.id, b.id))) {
    const key = crossCheckKey(r);
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  for (const [key, group] of [...groups].sort((a, b) => cmpText(a[0], b[0]))) {
    let f: CatalogRecord | undefined;
    let r = group[0]!;
    for (const m of group) {
      const byIdMatch = byId.get(`${m.kind}/${m.id}`);
      if (byIdMatch && !used.has(byIdMatch)) {
        f = byIdMatch;
        r = m;
        break;
      }
    }
    if (!f) {
      const k = byKey.get(key);
      if (k && !used.has(k)) f = k;
    }
    const rs = { ...side(r), cites: mergedCites(group) };
    if (!f) {
      const dismissed = isDismissed(dismissals, key, rs.value);
      all.push({
        key,
        kind: r.kind,
        state: "readers-only",
        readers: rs,
        ...(dismissed ? { dismissed: true as const } : {}),
      });
      if (dismissed) counts.dismissed++;
      else counts.readersOnly++;
      continue;
    }
    used.add(f);
    const fs = side(f);
    const fields = differences(r.kind, rs.value, fs.value);
    if (!fields.length) {
      counts.agree++;
      continue;
    }
    const dismissed = isDismissed(dismissals, key, rs.value);
    all.push({
      key,
      kind: r.kind,
      state: "disagree",
      readers: rs,
      facts: fs,
      fields,
      ...(dismissed ? { dismissed: true as const } : {}),
    });
    if (dismissed) counts.dismissed++;
    else counts.disagree++;
  }
  for (const f of facts) {
    if (used.has(f)) continue;
    counts.factsOnly++;
    all.push({ key: crossCheckKey(f), kind: f.kind, state: "facts-only", facts: side(f) });
  }
  all.sort(
    (a, b) => ORDER[a.state] - ORDER[b.state] || cmpText(a.kind, b.kind) || cmpText(a.key, b.key),
  );
  return { items: all, counts };
}

// ------------------------------------------------------------------ dismissals

/** The dismissals with one item dismissed at the readers' value given, or taken back. */
export function dismissalsAfter(
  d: CrossCheckDismissalsT | undefined,
  key: string,
  o: { readers: unknown } | { undo: true },
): CrossCheckDismissalsT {
  const rest = (d?.dismissed ?? []).filter((x) => x.key !== key);
  return {
    version: DISMISSALS_VERSION,
    dismissed:
      "undo" in o ? rest : [...rest, { key, readers: o.readers === undefined ? null : o.readers }],
  };
}

/** A repo's dismissals file, read: none, the file, or why it doesn't read. */
export async function readDismissals(
  root: string,
  repo: string,
): Promise<{ dismissals?: CrossCheckDismissalsT; text?: string; problem?: string }> {
  const text = await readFile(dismissalsPath(root, repo), "utf8").catch(() => undefined);
  if (text === undefined) return {};
  const p = parseDismissals(text);
  return p.ok
    ? { dismissals: p.slot, text }
    : { text, problem: `doesn't read (${p.issues[0]?.message ?? "invalid"})` };
}

export { serializeDismissals as serializeCrossCheckDismissals };

// ------------------------------------------------------------------ the estate's cross-check

const posix = (p: string) => p.split(sep).join("/");
const EMPTY: CrossCheckCounts = {
  agree: 0,
  readersOnly: 0,
  factsOnly: 0,
  disagree: 0,
  dismissed: 0,
};

/**
 * Every production repo's cross-check, from the slots on disk (or the ones given), the org pack
 * and the answers that name where calls go. Reads files only; runs nothing and writes nothing.
 */
export async function readCrossCheck(
  root: string,
  o: { repo?: string; op?: OrgPack; slots?: BuildSlots } = {},
): Promise<{ repos: RepoCrossCheck[]; problems: { file: string; message: string }[] }> {
  const op = o.op ?? (await loadOrgPack((await orgPackDirFor(root)).dir));
  const slots = o.slots ?? (await readSlots(root));
  const questions = await joinAnswerQuestions(root);
  const problems: { file: string; message: string }[] = [];
  const out: RepoCrossCheck[] = [];
  for (const r of productionRepos(op)) {
    if (o.repo !== undefined && r.id !== o.repo) continue;
    const dismissalsRel = posix(relative(root, dismissalsPath(root, r.id)));
    const readersRel = posix(relative(root, readersSlotPath(root, r.id)));
    const base = { repo: r.id, dismissals: dismissalsRel, counts: { ...EMPTY }, items: [] };
    const f = slots.facts.get(r.id);
    const x = slots.readers.get(r.id);
    const xr = x && "slot" in x ? x : undefined;
    if (f && !f.ok) {
      out.push({ ...base, state: "unusable", problem: `its facts snapshot ${f.problem}` });
      continue;
    }
    if (x && !xr) {
      out.push({
        ...base,
        state: "unusable",
        readersSlot: readersRel,
        problem: `its readers slot ${(x as { problem: string }).problem}`,
      });
      continue;
    }
    if (!f) {
      out.push({
        ...base,
        state: "no-facts",
        ...(xr ? { readersSlot: readersRel, readersCommit: xr.slot.commit } : {}),
      });
      continue;
    }
    const factsRel = posix(relative(root, factsSlotPaths(root, r.id).facts));
    if (!xr) {
      out.push({ ...base, state: "no-readers", factsSlot: factsRel, factsCommit: f.meta.commit });
      continue;
    }
    if (xr.slot.status === "legacy") {
      out.push({
        ...base,
        state: "legacy",
        readersSlot: readersRel,
        readersCommit: xr.slot.commit,
        factsSlot: factsRel,
        factsCommit: f.meta.commit,
      });
      continue;
    }
    const d = await readDismissals(root, r.id);
    if (d.problem) problems.push({ file: dismissalsRel, message: d.problem });
    const targets = targetsFromAnswers(r.id, f.facts, questions, { repoType: r.type });
    const projected = factsEstateRecords(op, [{ repo: r.id, facts: f.facts, targets }]);
    const facts = projected.per.get(r.id)?.newRecords ?? [];
    const c = compareReadersWithFacts(xr.slot.records, facts, d.dismissals);
    out.push({
      ...base,
      state: "compared",
      readersSlot: readersRel,
      readersCommit: xr.slot.commit,
      factsSlot: factsRel,
      factsCommit: f.meta.commit,
      counts: c.counts,
      items: c.items,
    });
  }
  return { repos: out, problems };
}
