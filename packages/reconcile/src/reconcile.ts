import type { CatalogRecord, IntegrationPattern } from "@maycombhq/core";
import { resolveNames, slug, type NameResolution, type ProfileSystem } from "./aliases.js";
import type { Diagram, DiagramEdge, Legend } from "./drawio.js";

export type ItemType =
  /** A diagram name matched only through the profile; a person should confirm the alias. */
  | "alias-needed"
  /** A diagram box that matches nothing in the catalog and isn't marked as planned. */
  | "unknown-box"
  /** The drawn pattern says one thing (via, sync, boundary), the code another. */
  | "pattern-mismatch"
  /** The drawn pattern differs from the pattern inferred from code. */
  | "pattern-differs"
  /** The label names a pattern code the org pack doesn't have. */
  | "unknown-pattern"
  /** Drawn as a call, but in code the caller reads or writes the callee's database. */
  | "drawn-call-reads-database"
  /** Drawn one way, called the other way in code. */
  | "direction-differs"
  /** Drawn, but the code has no such call. */
  | "diagram-only"
  /** In code, touching boxes on the diagram, but not drawn. */
  | "code-only"
  /** Marked new, modify or retire on the diagram: work for a change. */
  | "planned";

export interface ReconcileItem {
  /** Stable across runs: type plus the diagram cell or record it is about. */
  id: string;
  type: ItemType;
  summary: string;
  diagram?: { file: string; page: string; cell: string; line: number };
  /** Catalog records the item is about. */
  records: string[];
  /** For alias items: the diagram name. */
  name?: string;
  legend?: Legend;
  /** The next step; for curation, the CuratedDecision a person would confirm. */
  suggestion?: {
    text: string;
    action?: "alias" | "assert" | "suppress" | "resolve-conflict" | "classify";
    target?: string;
    value?: unknown;
  };
}

export interface ReconcileInput {
  diagram: Diagram;
  /** The diagram's path, for evidence. */
  file: string;
  records: CatalogRecord[];
  systems: ProfileSystem[];
  patterns: IntegrationPattern[];
}

export interface ReconcileResult {
  items: ReconcileItem[];
  /** Each drawn edge that matched code, with the interfaces it shows. */
  matches: { cell: string; interfaces: string[]; tables?: string[] }[];
  names: NameResolution[];
}

type Iface = Extract<CatalogRecord, { kind: "Interface" }>;
type Table = Extract<CatalogRecord, { kind: "Table" }>;

const VIA: Record<string, string> = {
  gateway: "through the gateway",
  direct: "directly",
  "event-bus": "over the event bus",
  pubsub: "over pub/sub",
  mq: "over a queue",
  sftp: "by file transfer",
  other: "another way",
};
const viaText = (v: string) => VIA[v] ?? `via ${v}`;

const normPath = (p: string) => p.replace(/\{[^}]*\}/g, "{}").replace(/\/+$/, "") || "/";

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length]![b.length]!;
}

/**
 * Compare a diagram with the catalog. Code wins: a drawn fact never changes a fact read from
 * code; differences become items for a person to resolve. Reads only what it is given.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { diagram, file, records } = input;
  const items: ReconcileItem[] = [];
  const add = (i: Omit<ReconcileItem, "id"> & { key: string }) => {
    const { key, ...rest } = i;
    items.push({ id: `${i.type}.${slug(key)}`, ...rest });
  };
  const place = (cell: string, page: string, line: number) => ({ file, page, cell, line });

  const names = resolveNames(
    [
      ...new Set([
        ...diagram.nodes.map((n) => n.label),
        ...diagram.edges.flatMap((e) => [e.from, e.to]),
      ]),
    ],
    records,
    input.systems,
  );
  const idOf = (name: string) => names.get(name)?.id;

  const components = new Map(records.filter((r) => r.kind === "Component").map((r) => [r.id, r]));
  const systemIds = new Set([
    ...records.filter((r) => r.kind === "System").map((r) => r.id),
    ...input.systems.map((s) => s.id),
  ]);
  const systemOf = (id: string) =>
    (components.get(id) as { system?: string } | undefined)?.system ??
    (systemIds.has(id) ? id : undefined);
  const boundaryOf = (id: string) => {
    const s = records.find((r) => r.kind === "System" && r.id === systemOf(id)) as
      { boundary?: string } | undefined;
    return s?.boundary;
  };
  /** Does a diagram end (component or system id) stand for this catalog end? */
  const same = (drawn: string, end: string) =>
    drawn === end || (systemIds.has(drawn) && !components.has(drawn) && systemOf(end) === drawn);

  const interfaces = records.filter((r): r is Iface => r.kind === "Interface");
  const routes = new Map(
    records
      .filter((r) => r.kind === "GatewayRoute")
      .map((r) => [r.id, (r as { basepath: string }).basepath]),
  );
  const tables = records.filter((r): r is Table => r.kind === "Table");
  const stores = new Map(
    records
      .filter((r) => r.kind === "DataStore")
      .map((r) => [r.id, (r as { ownerComponent?: string }).ownerComponent]),
  );
  const patterns = new Map(input.patterns.map((p) => [p.code, p]));

  // ---- names
  for (const n of diagram.nodes) {
    const res = names.get(n.label)!;
    if (res.how === "profile")
      add({
        key: n.label,
        type: "alias-needed",
        name: n.label,
        summary: `The diagram's "${n.label}" was matched to ${res.id!} through the profile; confirm it so later diagrams match it directly.`,
        diagram: place(n.cell, n.page, n.line),
        records: [res.id!],
        suggestion: {
          text: `Confirm "${n.label}" is ${res.id!}`,
          action: "alias",
          target: res.id!,
          value: n.label,
        },
      });
    else if (
      !res.id &&
      !n.legend &&
      diagram.edges.some((e) => e.from === n.label || e.to === n.label)
    )
      add({
        key: n.label,
        type: "unknown-box",
        name: n.label,
        summary: `The diagram's "${n.label}" matches nothing in the catalog${res.similar.length ? ` (similar: ${res.similar.join(", ")})` : ""}.`,
        diagram: place(n.cell, n.page, n.line),
        records: res.similar,
        suggestion: res.similar.length
          ? {
              text: `If "${n.label}" is ${res.similar[0]!}, record the alias`,
              action: "alias",
              target: res.similar[0]!,
              value: n.label,
            }
          : { text: `Say what "${n.label}" is, or mark it New if it doesn't exist yet` },
      });
  }

  // ---- edges
  const matched = new Set<string>();
  const explainedAccess = new Set<string>();
  const matches: ReconcileResult["matches"] = [];
  const label = (e: DiagramEdge) => `${e.from} → ${e.to}${e.label ? ` (${e.label})` : ""}`;
  for (const e of diagram.edges) {
    const where = place(e.cell, e.page, e.line);
    if (e.pattern && !patterns.has(e.pattern)) {
      const near = [...patterns.keys()]
        .map((c) => ({ c, d: distance(c, e.pattern!) }))
        .sort((a, b) => a.d - b.d)[0];
      add({
        key: e.cell,
        type: "unknown-pattern",
        summary: `Edge ${label(e)} names pattern ${e.pattern}, which the org pack doesn't have.`,
        diagram: where,
        records: [],
        suggestion: {
          text:
            near && near.d <= 2
              ? `Did you mean ${near.c}?`
              : `Use one of: ${[...patterns.keys()].join(", ")}`,
        },
      });
    }
    const from = idOf(e.from);
    const to = idOf(e.to);
    const candidates =
      from && to
        ? interfaces.filter((i) => {
            if (!same(from, i.from) || !same(to, i.to)) return false;
            if (e.topic) return i.sync === "async" && i.normalizedPath === e.topic;
            if (e.path) {
              if (e.method && i.method && e.method !== i.method.toUpperCase()) return false;
              const p = normPath(e.path);
              const base = i.route ? routes.get(i.route) : undefined;
              return (
                p === i.normalizedPath ||
                (base !== undefined && p === normPath(base) + i.normalizedPath)
              );
            }
            return true;
          })
        : [];
    if (candidates.length > 0) {
      for (const i of candidates) matched.add(i.id);
      matches.push({ cell: e.cell, interfaces: candidates.map((i) => i.id).sort() });
      const p = e.pattern ? patterns.get(e.pattern) : undefined;
      for (const i of candidates) {
        if (p) {
          // Strings: Interface.via has values (mesh, webhook; ADR 0040) a C6 pattern can't name yet.
          const via: string[] =
            p.detection.via.length > 0
              ? p.detection.via
              : p.route !== "jdbc" && p.route !== "other"
                ? [p.route]
                : [];
          const diffs: string[] = [];
          if (via.length > 0 && !via.includes(i.via))
            diffs.push(
              `${p.code} goes ${via.map(viaText).join(" or ")}, the code calls ${viaText(i.via)}`,
            );
          const sync =
            p.detection.sync ?? (p.interaction === "data-access" ? undefined : p.interaction);
          if (sync && sync !== i.sync) diffs.push(`${p.code} is ${sync}, the code is ${i.sync}`);
          const tb = p.detection.targetBoundary;
          if (tb && boundaryOf(i.to) && tb !== boundaryOf(i.to))
            diffs.push(`${p.code} targets a ${tb} system, ${i.to} is ${boundaryOf(i.to)!}`);
          if (diffs.length > 0)
            add({
              key: `${e.cell}-${i.id}`,
              type: "pattern-mismatch",
              summary: `Edge ${label(e)}: ${diffs.join("; ")}. The code is what runs; fix the design or the code.`,
              diagram: where,
              records: [i.id],
              suggestion: {
                text: `Redraw the edge to match the code, or plan a change that routes it as ${p.code} says`,
              },
            });
          else if (i.pattern && i.pattern.code !== p.code)
            add({
              key: `${e.cell}-${i.id}`,
              type: "pattern-differs",
              summary: `Edge ${label(e)} is drawn as ${p.code}; the code looks like ${i.pattern.code}.`,
              diagram: where,
              records: [i.id],
              suggestion: {
                text: `Confirm which pattern applies`,
                action: "assert",
                target: i.id,
                value: { pattern: { code: p.code, source: "asserted" } },
              },
            });
        }
        if (e.legend === "modify" || e.legend === "retire")
          add({
            key: `${e.cell}-${i.id}`,
            type: "planned",
            legend: e.legend,
            summary: `Edge ${label(e)} is marked ${e.legend}: add it to a change as planned-${e.legend}.`,
            diagram: where,
            records: [i.id],
            suggestion: { text: `Add ${i.id} to a change as planned-${e.legend}` },
          });
      }
      continue;
    }
    if (e.legend) {
      add({
        key: e.cell,
        type: "planned",
        legend: e.legend,
        summary: `Edge ${label(e)} is marked ${e.legend} and isn't in code yet: it becomes a planned-${e.legend} interface in a change.`,
        diagram: where,
        records: [],
        suggestion: { text: `Add ${label(e)} to a change as a planned-${e.legend} interface` },
      });
      continue;
    }
    if (!from || !to) {
      add({
        key: e.cell,
        type: "diagram-only",
        summary: `Edge ${label(e)} can't be checked: ${!from ? e.from : e.to} isn't in the catalog.`,
        diagram: where,
        records: [],
      });
      continue;
    }
    const owned = tables.filter((t) => {
      const owner = t.ownerComponent ?? stores.get(t.dataStore);
      return (
        owner !== undefined &&
        same(to, owner) &&
        (t.readers.some((c) => same(from, c)) || t.writers.some((c) => same(from, c)))
      );
    });
    if (owned.length > 0 && e.pattern && patterns.get(e.pattern)?.interaction === "data-access") {
      // Drawn as direct data access, and that is what the code does: a match.
      for (const t of owned) explainedAccess.add(`${from}|${t.id}`);
      matches.push({ cell: e.cell, interfaces: [], tables: owned.map((t) => t.id).sort() });
      continue;
    }
    if (owned.length > 0) {
      for (const t of owned) explainedAccess.add(`${from}|${t.id}`);
      const jdbc = input.patterns.find(
        (p) => p.interaction === "data-access" && p.status !== "deprecated",
      );
      add({
        key: e.cell,
        type: "drawn-call-reads-database",
        summary: `Edge ${label(e)} is drawn as a call to ${to}, but in code ${from} ${owned.every((t) => t.readers.some((c) => same(from, c))) ? "reads" : "uses"} ${to}'s database directly (${owned.map((t) => t.id).join(", ")})${jdbc ? `: that is ${jdbc.code}, not ${e.pattern ?? "a call"}` : ""}.`,
        diagram: where,
        records: owned.map((t) => t.id),
        suggestion: {
          text: `Redraw it as ${jdbc?.code ?? "direct database access"}, or plan a change to go through ${to}'s API`,
        },
      });
      continue;
    }
    const reverse = interfaces.filter((i) => same(to, i.from) && same(from, i.to));
    if (reverse.length > 0) {
      add({
        key: e.cell,
        type: "direction-differs",
        summary: `Edge ${label(e)} is drawn from ${from} to ${to}; in code ${to} calls ${from}.`,
        diagram: where,
        records: reverse.map((i) => i.id).sort(),
      });
      continue;
    }
    add({
      key: e.cell,
      type: "diagram-only",
      summary: `Edge ${label(e)} is drawn, but no such call is in the code.`,
      diagram: where,
      records: [],
      suggestion: {
        text: "Remove it from the diagram, mark it New, or point Atticus at the repo that makes the call",
      },
    });
  }

  // ---- code the diagram leaves out
  const onDiagram = new Set([...names.values()].flatMap((n) => (n.id ? [n.id] : [])));
  const touches = (id: string) => [...onDiagram].some((d) => same(d, id));
  for (const i of interfaces
    .filter((x) => !matched.has(x.id) && x.status !== "retired")
    .sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!touches(i.from) && !touches(i.to)) continue;
    const what = i.sync === "async" ? `publishes ${i.normalizedPath} to` : `calls`;
    add({
      key: i.id,
      type: "code-only",
      summary: `In code ${i.from} ${what} ${i.to}${i.sync === "async" ? "" : ` (${i.method ?? ""} ${i.normalizedPath}`.trimEnd() + ")"}${i.confidence === "inferred" ? ", seen at one end only" : ""}; the diagram doesn't show it.`,
      records: [i.id],
      suggestion: {
        text: `Add it to the diagram, or record why it is left out`,
        action: "suppress",
        target: i.id,
        value: { diagram: file },
      },
    });
  }
  for (const t of tables) {
    const owner = t.ownerComponent ?? stores.get(t.dataStore);
    for (const c of [...new Set([...t.readers, ...t.writers])].sort()) {
      if (
        !owner ||
        c === owner ||
        explainedAccess.has(`${c}|${t.id}`) ||
        !touches(c) ||
        !touches(owner)
      )
        continue;
      add({
        key: `${c}-${t.id}`,
        type: "code-only",
        summary: `In code ${c} uses ${owner}'s table ${t.id} directly; the diagram doesn't show it.`,
        records: [t.id, c],
      });
    }
  }
  return { items, matches, names: [...names.values()] };
}
