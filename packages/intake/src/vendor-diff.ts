import { normalizePath } from "@maycombhq/core";
import { slug } from "./types.js";
import type { VendorField, VendorOperation, VendorSpec } from "./vendor-ops.js";

/**
 * Two versions of a vendor's spec compared (ADR 0130): the operations added, removed and moved,
 * and for each operation in both, what changed in its auth, its scopes and its request and
 * response fields (added, removed, renamed, required-ness, type, enum values). Each change says
 * plainly whether it breaks a caller, by fixed rules (no model call), and cites both versions
 * where both have it. A spec is the vendor's word about its own system: this compares what it
 * says, nothing more.
 *
 * The rules, from a caller's side:
 * - an operation removed, or moved to another method or path (same operationId), breaks;
 *   one added doesn't;
 * - a request field removed or renamed breaks (what the caller sends is lost); a response field
 *   removed or renamed breaks (what the caller reads is gone);
 * - a request field added breaks when required, not when optional; a response field added doesn't;
 * - a request field made required breaks, made optional doesn't; a response field made optional
 *   breaks, made always-there doesn't; a field whose required-ness nobody states is never compared;
 * - a type changed breaks;
 * - enum values: a request field that no longer takes a value breaks, one that takes a new value
 *   doesn't; a response field that may return a new value breaks, one that no longer returns one
 *   doesn't;
 * - auth changed breaks; a scope the token now needs breaks, one it no longer needs doesn't.
 *
 * A rename is a field removed and one added in the same operation, side, place and parent, of the
 * same type, when exactly one of each: deterministic, and said as a rename so a person checks it.
 */

export type VendorChangeKind =
  | "operation-removed"
  | "operation-moved"
  | "operation-added"
  | "auth"
  | "scopes"
  | "field-removed"
  | "field-renamed"
  | "field-added"
  | "field-required"
  | "field-type"
  | "field-enum";

const KIND_ORDER: VendorChangeKind[] = [
  "operation-removed",
  "operation-moved",
  "operation-added",
  "auth",
  "scopes",
  "field-removed",
  "field-renamed",
  "field-added",
  "field-required",
  "field-type",
  "field-enum",
];

export interface VendorChangeEnd {
  value: string;
  /** spec path:line. */
  cite: string;
}

export interface VendorChange {
  /** Stable: kind, method and path, and side and field for a field's change. */
  id: string;
  kind: VendorChangeKind;
  severity: "breaking" | "additive";
  /** The operation as the newer version has it (the older one's, when it is gone). */
  operation: { method: string; path: string; operationId?: string };
  /** Its Endpoint id in each version that has it. */
  endpoints: { older?: string; newer?: string };
  side?: "request" | "response";
  /** The field as the older version names it (the newer one's, when it is new). */
  field?: string;
  before?: VendorChangeEnd;
  after?: VendorChangeEnd;
  /** One sentence: what changed and what it means for a caller. */
  says: string;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const opKey = (o: VendorOperation) => `${o.method} ${normalizePath(o.fullPath)}`;
const opName = (o: VendorOperation) => `${o.method} ${o.path}`;
const list = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
const orList = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`;

/** Compare an older and a newer version of one vendor's spec. */
export function diffVendorSpecs(older: VendorSpec, newer: VendorSpec): VendorChange[] {
  const out: VendorChange[] = [];
  const newerVersion = newer.version ?? newer.path;
  const olds = new Map(older.operations.map((o) => [opKey(o), o]));
  const news = new Map(newer.operations.map((o) => [opKey(o), o]));
  const pairs: [VendorOperation, VendorOperation][] = [];
  for (const [k, o] of olds) {
    const n = news.get(k);
    if (n) pairs.push([o, n]);
  }
  const goneOld = [...olds].filter(([k]) => !news.has(k)).map(([, o]) => o);
  const newNew = [...news].filter(([k]) => !olds.has(k)).map(([, o]) => o);
  // The same operationId on both sides, once each: moved, not removed and added.
  const once = (ops: VendorOperation[], id: string) => ops.filter((o) => o.operationId === id);
  const moved = new Set<VendorOperation>();
  for (const o of goneOld) {
    if (!o.operationId) continue;
    const a = once(goneOld, o.operationId);
    const b = once(newNew, o.operationId);
    if (a.length !== 1 || b.length !== 1) continue;
    const n = b[0]!;
    moved.add(o).add(n);
    pairs.push([o, n]);
    out.push({
      id: changeId("operation-moved", o),
      kind: "operation-moved",
      severity: "breaking",
      operation: opOf(n),
      endpoints: { older: o.id, newer: n.id },
      before: { value: opName(o), cite: o.cite },
      after: { value: opName(n), cite: n.cite },
      says: `${o.operationId} moved from ${opName(o)} to ${opName(n)}; a call to the old one will fail.`,
    });
  }
  for (const o of goneOld)
    if (!moved.has(o))
      out.push({
        id: changeId("operation-removed", o),
        kind: "operation-removed",
        severity: "breaking",
        operation: opOf(o),
        endpoints: { older: o.id },
        before: { value: opName(o), cite: o.cite },
        says: `${opName(o)} is gone in ${newerVersion}; a call to it will fail.`,
      });
  for (const n of newNew)
    if (!moved.has(n))
      out.push({
        id: changeId("operation-added", n),
        kind: "operation-added",
        severity: "additive",
        operation: opOf(n),
        endpoints: { newer: n.id },
        after: { value: opName(n), cite: n.cite },
        says: `${opName(n)} is new in ${newerVersion}; no caller has to change.`,
      });
  for (const [o, n] of pairs) out.push(...operationChanges(o, n));
  return out.sort(
    (a, b) =>
      cmp(a.severity === "breaking" ? "0" : "1", b.severity === "breaking" ? "0" : "1") ||
      cmp(a.operation.path, b.operation.path) ||
      cmp(a.operation.method, b.operation.method) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      cmp(a.side ?? "", b.side ?? "") ||
      cmp(a.field ?? "", b.field ?? ""),
  );
}

const opOf = (o: VendorOperation) => ({
  method: o.method,
  path: o.path,
  ...(o.operationId ? { operationId: o.operationId } : {}),
});

function changeId(kind: VendorChangeKind, o: VendorOperation, side?: string, field?: string) {
  const op = slug(`${o.method} ${o.path}`);
  return [kind, op, ...(side && field ? [side, slug(field)] : [])].join(".");
}

function operationChanges(o: VendorOperation, n: VendorOperation): VendorChange[] {
  const out: VendorChange[] = [];
  const at = opName(n);
  const base = (kind: VendorChangeKind, side?: "request" | "response", field?: string) => ({
    id: changeId(kind, n, side, field),
    kind,
    operation: opOf(n),
    endpoints: { older: o.id, newer: n.id },
    ...(side ? { side } : {}),
    ...(field ? { field } : {}),
  });
  const authOf = (x: VendorOperation) => x.auth ?? "none";
  if (authOf(o) !== authOf(n))
    out.push({
      ...base("auth"),
      severity: "breaking",
      before: { value: authOf(o), cite: o.cite },
      after: { value: authOf(n), cite: n.cite },
      says: `${at}: auth was ${authOf(o)} and is now ${authOf(n)}; every caller must change how it signs in.`,
    });
  else {
    const added = n.scopes.filter((s) => !o.scopes.includes(s));
    const dropped = o.scopes.filter((s) => !n.scopes.includes(s));
    if (added.length || dropped.length)
      out.push({
        ...base("scopes"),
        severity: added.length ? "breaking" : "additive",
        before: { value: o.scopes.join(" ") || "none", cite: o.cite },
        after: { value: n.scopes.join(" ") || "none", cite: n.cite },
        says: added.length
          ? `${at}: a caller's token now needs ${list(added)} as well.`
          : `${at}: a caller's token no longer needs ${list(dropped)}.`,
      });
  }
  for (const side of ["request", "response"] as const)
    out.push(...fieldChanges(o[side], n[side], side, at, base));
  return out;
}

type Base = (
  kind: VendorChangeKind,
  side?: "request" | "response",
  field?: string,
) => Omit<VendorChange, "severity" | "says">;

function fieldChanges(
  olds: VendorField[],
  news: VendorField[],
  side: "request" | "response",
  at: string,
  base: Base,
): VendorChange[] {
  const out: VendorChange[] = [];
  const key = (f: VendorField) => `${f.in}|${f.name}`;
  const byOld = new Map(olds.map((f) => [key(f), f]));
  const byNew = new Map(news.map((f) => [key(f), f]));
  let removed = olds.filter((f) => !byNew.has(key(f)));
  let added = news.filter((f) => !byOld.has(key(f)));
  const req = side === "request";

  // ---- renames: one removed and one added, same place, parent and type
  const parent = (f: VendorField) =>
    `${f.in}|${f.name.includes(".") ? f.name.slice(0, f.name.lastIndexOf(".")) : ""}`;
  const renamed: [VendorField, VendorField][] = [];
  const groups = new Set([...removed, ...added].map(parent));
  for (const g of [...groups].sort()) {
    const r = removed.filter((f) => parent(f) === g);
    const a = added.filter((f) => parent(f) === g);
    if (r.length === 1 && a.length === 1 && r[0]!.type === a[0]!.type) renamed.push([r[0]!, a[0]!]);
  }
  const under = (f: VendorField, p: VendorField) =>
    f.name.startsWith(`${p.name}.`) || f.name.startsWith(`${p.name}[]`);
  for (const [r, a] of renamed) {
    out.push({
      ...base("field-renamed", side, r.name),
      severity: "breaking",
      before: { value: r.name, cite: r.cite },
      after: { value: a.name, cite: a.cite },
      says: `${at}: the ${side} field ${r.name} is now ${a.name}; ${req ? `a caller that still sends ${r.name} no longer sets it` : `a caller that reads ${r.name} gets nothing`}.`,
    });
  }
  removed = removed.filter((f) => !renamed.some(([r]) => r === f));
  added = added.filter((f) => !renamed.some(([, a]) => a === f));
  // A field under one removed or added is said by its parent, not again.
  const topRemoved = removed.filter((f) => !removed.some((p) => p !== f && under(f, p)));
  const topAdded = added.filter((f) => !added.some((p) => p !== f && under(f, p)));

  for (const f of topRemoved)
    out.push({
      ...base("field-removed", side, f.name),
      severity: "breaking",
      before: { value: f.name, cite: f.cite },
      says: req
        ? `${at}: the request field ${f.name} is gone; a caller that sends it may be refused, and what it meant is lost.`
        : `${at}: the response field ${f.name} is gone; a caller that reads it gets nothing.`,
    });
  for (const f of topAdded) {
    const breaks = req && f.required === true;
    out.push({
      ...base("field-added", side, f.name),
      severity: breaks ? "breaking" : "additive",
      after: { value: f.name, cite: f.requiredCite ?? f.cite },
      says: !req
        ? `${at}: the response has a new field ${f.name}; no caller has to change.`
        : breaks
          ? `${at}: the request needs a new field ${f.name}; a caller that doesn't send it is refused.`
          : `${at}: the request takes a new optional field ${f.name}; no caller has to change.`,
    });
  }

  // ---- fields in both
  for (const [k, a] of byOld) {
    const b = byNew.get(k);
    if (!b) continue;
    if (a.required !== undefined && b.required !== undefined && a.required !== b.required) {
      const nowRequired = b.required;
      const breaks = req ? nowRequired : !nowRequired;
      out.push({
        ...base("field-required", side, a.name),
        severity: breaks ? "breaking" : "additive",
        before: { value: a.required ? "required" : "optional", cite: a.requiredCite ?? a.cite },
        after: { value: b.required ? "required" : "optional", cite: b.requiredCite ?? b.cite },
        says: req
          ? nowRequired
            ? `${at}: the request field ${a.name} is now required; a caller that leaves it out is refused.`
            : `${at}: the request field ${a.name} is now optional; no caller has to change.`
          : nowRequired
            ? `${at}: the response field ${a.name} is now always there; no caller has to change.`
            : `${at}: the response field ${a.name} may now be left out; a caller that counts on it must allow for that.`,
      });
    }
    if (a.type && b.type && a.type !== b.type)
      out.push({
        ...base("field-type", side, a.name),
        severity: "breaking",
        before: { value: a.type, cite: a.cite },
        after: { value: b.type, cite: b.cite },
        says: `${at}: the ${side} field ${a.name} was ${a.type} and is now ${b.type}; a caller that ${req ? "sends" : "reads"} it must change.`,
      });
    if (a.enum || b.enum) {
      const was = a.enum ?? [];
      const now = b.enum ?? [];
      const gained = a.enum ? now.filter((v) => !was.includes(v)) : [];
      const lost = b.enum ? was.filter((v) => !now.includes(v)) : [];
      if (!gained.length && !lost.length) continue;
      const breaks = req ? lost.length > 0 : gained.length > 0;
      const words = req
        ? lost.length
          ? `${at}: the request field ${a.name} no longer takes ${list(lost)}${gained.length ? ` and now takes ${list(gained)}` : ""}; a caller that sends a value it no longer takes is refused.`
          : `${at}: the request field ${a.name} now also takes ${list(gained)}; no caller has to change.`
        : gained.length
          ? `${at}: the response field ${a.name} may now be ${orList(gained)}; a caller that reads it must handle the new value${gained.length > 1 ? "s" : ""}.`
          : `${at}: the response field ${a.name} no longer returns ${list(lost)}; no caller has to change.`;
      out.push({
        ...base("field-enum", side, a.name),
        severity: breaks ? "breaking" : "additive",
        before: { value: was.join(", ") || "any", cite: a.cite },
        after: { value: now.join(", ") || "any", cite: b.cite },
        says: words,
      });
    }
  }
  return out;
}
