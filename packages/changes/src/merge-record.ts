import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import {
  ChangeLifecycle,
  type ChangeHandoff,
  type ChangeHistoryEntry,
  type ChangeLifecycleInput,
  type LifecycleState,
} from "@maycombhq/core";
import { serializeChange } from "./store.js";

/**
 * Ninth UX walk: a change's change.yaml merged by its fields, three ways (what this copy last had,
 * this copy's, and what merged). After a hand-off merges, Sync here and the hand-off branch's copy
 * both edit the record (the state, the hand-off entries, the history), so a text merge of it
 * clashes though nothing disagrees. The record is Atticus's own, so it is merged as data:
 *
 * - history and hand-offs are a union (history by transition and time, hand-offs by phase and
 *   PR); a hand-off both sides have keeps its further state (merged over closed over open), as
 *   the Git host was last read; the state is where the merged history ends, so the later lifecycle state wins
 *   unless this copy recorded a newer transition;
 * - who wrote each artifact is a union;
 * - a field a person edits (the title, the owners role by role, the systems, what it touches) takes
 *   the side that changed it, and is refused, naming the field, only when both changed it
 *   differently (or, with no base, when the two sides disagree).
 */
export type RecordMerge = { ok: true; value: ChangeLifecycle } | { ok: false; field: string };

const HANDOFF_RANK: Record<ChangeHandoff["state"], number> = {
  open: 0,
  "changes-requested": 1,
  closed: 2,
  merged: 3,
};

class Clash extends Error {
  constructor(readonly field: string) {
    super(field);
  }
}

/** A field changed on one side takes that side; changed the same way, either; else a clash. */
function three<T>(field: string, base: { has: boolean; value: T }, ours: T, theirs: T): T {
  if (isDeepStrictEqual(ours, theirs)) return ours;
  if (base.has) {
    if (isDeepStrictEqual(ours, base.value)) return theirs;
    if (isDeepStrictEqual(theirs, base.value)) return ours;
  }
  throw new Clash(field);
}

/** A union of two lists by key, ours first, each key once (ours' entry unless `pick` says). */
function union<T>(ours: T[], theirs: T[], key: (x: T) => string, pick?: (a: T, b: T) => T): T[] {
  const out = new Map<string, T>();
  for (const x of ours) if (!out.has(key(x))) out.set(key(x), x);
  for (const x of theirs) {
    const k = key(x);
    const had = out.get(k);
    out.set(k, had === undefined ? x : pick ? pick(had, x) : had);
  }
  return [...out.values()];
}

const startsWith = <T>(a: T[], b: T[]) =>
  b.length <= a.length && b.every((x, i) => isDeepStrictEqual(x, a[i]));

function mergeHistory(ours: ChangeHistoryEntry[], theirs: ChangeHistoryEntry[]) {
  if (startsWith(ours, theirs)) return ours;
  if (startsWith(theirs, ours)) return theirs;
  const all = union(ours, theirs, (h) => `${h.from}>${h.to}@${h.at}`);
  // Stable: entries at the same time keep the order they were in.
  const merged = all
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (a.h.at < b.h.at ? -1 : a.h.at > b.h.at ? 1 : a.i - b.i))
    .map((x) => x.h);
  let at: LifecycleState = "draft";
  for (const h of merged) {
    if (h.from !== at) throw new Clash("history");
    at = h.to;
  }
  return merged;
}

function mergeHandoff(a: ChangeHandoff, b: ChangeHandoff): ChangeHandoff {
  if (isDeepStrictEqual(a, b)) return a;
  const when = (h: ChangeHandoff) => h.updatedAt ?? h.openedAt;
  const ra = HANDOFF_RANK[a.state];
  const rb = HANDOFF_RANK[b.state];
  const top = rb > ra || (rb === ra && when(b) > when(a)) ? b : a;
  // Its approvals are as the Git host was last read, so the further entry's read stands (an
  // approval dismissed since is gone from it); the reviewers asked are everyone either asked.
  return { ...top, reviewers: [...new Set([...a.reviewers, ...b.reviewers])] };
}

function mergeHandoffs(ours: ChangeHandoff[], theirs: ChangeHandoff[]) {
  const all = union(ours, theirs, (h) => `${h.phase}#${h.pr.number}`, mergeHandoff);
  return all
    .map((h, i) => ({ h, i }))
    .sort((a, b) =>
      a.h.openedAt < b.h.openedAt ? -1 : a.h.openedAt > b.h.openedAt ? 1 : a.i - b.i,
    )
    .map((x) => x.h);
}

/** Two keyed objects merged key by key (an absent key is undefined), each key three ways. */
function byKey<V>(
  field: string,
  base: Record<string, V> | undefined,
  ours: Record<string, V>,
  theirs: Record<string, V>,
): Record<string, V> {
  const out: Record<string, V> = {};
  for (const k of [...new Set([...Object.keys(ours), ...Object.keys(theirs)])]) {
    const v = three(
      `${field}.${k}`,
      { has: base !== undefined, value: base?.[k] },
      ours[k],
      theirs[k],
    );
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Merge a change's record three ways by its fields; `base` undefined when this copy had none. */
export function mergeChangeRecords(
  base: ChangeLifecycleInput | undefined,
  ours: ChangeLifecycleInput,
  theirs: ChangeLifecycleInput,
): RecordMerge {
  const b = base === undefined ? undefined : ChangeLifecycle.parse(base);
  const o = ChangeLifecycle.parse(ours);
  const t = ChangeLifecycle.parse(theirs);
  const has = b !== undefined;
  const at = <K extends keyof ChangeLifecycle>(k: K) => ({ has, value: b?.[k] });
  try {
    const history = mergeHistory(o.history, t.history);
    const authors: ChangeLifecycle["authors"] = {};
    for (const k of [...new Set([...Object.keys(o.authors), ...Object.keys(t.authors)])]) {
      const key = k as keyof ChangeLifecycle["authors"];
      authors[key] = [...new Set([...(o.authors[key] ?? []), ...(t.authors[key] ?? [])])];
    }
    const template = three("template", at("template"), o.template, t.template);
    const value = {
      schemaVersion: o.schemaVersion,
      id: three("id", at("id"), o.id, t.id),
      title: three("title", at("title"), o.title, t.title),
      type: three("type", at("type"), o.type, t.type),
      ...(template !== undefined ? { template } : {}),
      state: history.length ? history.at(-1)!.to : three("state", at("state"), o.state, t.state),
      owners: byKey("owners", b?.owners, o.owners, t.owners),
      systems: three("systems", at("systems"), o.systems, t.systems),
      touches: byKey(
        "touches",
        b?.touches as Record<string, unknown> | undefined,
        o.touches as Record<string, unknown>,
        t.touches as Record<string, unknown>,
      ) as ChangeLifecycle["touches"],
      authors,
      createdAt: three("createdAt", at("createdAt"), o.createdAt, t.createdAt),
      createdBy: three("createdBy", at("createdBy"), o.createdBy, t.createdBy),
      history,
      handoffs: mergeHandoffs(o.handoffs, t.handoffs),
    };
    const r = ChangeLifecycle.safeParse(value);
    if (!r.success)
      return { ok: false, field: r.error.issues[0]?.path.map(String).join(".") || "record" };
    return { ok: true, value: r.data };
  } catch (e) {
    if (e instanceof Clash) return { ok: false, field: e.field };
    throw e;
  }
}

/** A change record's text read as one, or undefined when it isn't one (not YAML, not valid). */
function readRecord(text: string): ChangeLifecycle | undefined {
  try {
    const r = ChangeLifecycle.safeParse(parse(text));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The three texts of a change's record merged by its fields, as canonical YAML. Undefined when a
 * side isn't a change record Atticus can read (the caller merges the text instead); an empty base
 * is a record this copy didn't have.
 */
export function mergeChangeText(
  baseText: string,
  oursText: string,
  theirsText: string,
): { ok: true; text: string } | { ok: false; field: string } | undefined {
  const ours = readRecord(oursText);
  const theirs = readRecord(theirsText);
  const base = baseText.trim() ? readRecord(baseText) : undefined;
  if (!ours || !theirs || (baseText.trim() && !base)) return undefined;
  const r = mergeChangeRecords(base, ours, theirs);
  return r.ok ? { ok: true, text: serializeChange(r.value) } : r;
}
