import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { isMap, isSeq, LineCounter, parseDocument } from "yaml";
import { normalizePath, type CatalogRecord, type FlowRecord } from "@maycombhq/core";
import { TARGET_DIR } from "./stages/architecture.js";
import { FlowDelta, type DeltaStep } from "./stages/schema.js";

/**
 * Does the code do what the design says? (ADR 0114.) The records a scan of a branch's commit
 * gives, compared with what the change's target flows say should be there: every call a step
 * adds is an Interface from the flow's component, every table, column and migration a step
 * names exists, a new flow's endpoint exists, every call a removed step made is gone; and what
 * the branch adds that no target flow names is out of scope. Records and files only, no AI:
 * the same commits and target flows give the same answer.
 */

/** One target-flow file, with where each of its steps is, for citations. */
export interface ConformDelta {
  /** Change-folder-relative, e.g. target-flows/ledger-api.create-transfer.yaml. */
  file: string;
  delta: FlowDelta;
  /** Today's flow from the spec, for a modify or remove delta. */
  today?: FlowRecord;
  /** The line of each step in the file (by position, from 0). */
  stepLines: number[];
  /** The line of the trigger, or of the flow id when it has none. */
  triggerLine: number;
}

export type ConformCheck =
  "call" | "publish" | "table" | "column" | "migration" | "trigger" | "endpoint";

export type ConformStatus = "found" | "missing" | "still-there" | "unexpected";

export interface ConformCite {
  /** artifact: a change file (the target flow); otherwise a file of the repo at the ref. */
  source: "artifact" | "code";
  repo?: string;
  path: string;
  line?: number;
}

export interface ConformItem {
  status: ConformStatus;
  check: ConformCheck;
  /** The target flow and its step (from 1, as the stories number them); none for a scope item. */
  flow?: string;
  item?: number;
  /** The task that builds the step, when the stories say. */
  task?: string;
  /** One plain sentence. */
  what: string;
  /** The catalog record found, still there, or unexpected. */
  record?: string;
  /** In the new code for what is there; in the target flow for what is missing. */
  at: ConformCite[];
}

export interface ConformUnchecked {
  flow: string;
  /** The step, from 1; none for the trigger. */
  item?: number;
  kind: string;
  why: string;
}

export interface ConformInput {
  repo: string;
  /** Every target flow of the change (all repos: a step anywhere can name what this repo adds). */
  deltas: ConformDelta[];
  /** Only these steps (a task's); left out, every step of the repo's target flows. */
  scope?: { flow: string; item: number }[];
  /** Which task builds each step ("<flow>#<item>" → task id), when the stories say. */
  tasks?: Map<string, string>;
  /** The scan at the branch's base, and at its commit. */
  before: CatalogRecord[];
  after: CatalogRecord[];
  /** Repo-relative files at the commit. */
  files: string[];
}

export interface ConformResult {
  items: ConformItem[];
  unchecked: ConformUnchecked[];
}

type Rec = CatalogRecord & Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** "POST /v1/screenings" → method and normalised path; a topic or an id gives none. */
function httpEntry(entry: string): { method: string; path: string } | undefined {
  const m = /^([A-Za-z]+)\s+(\S+)$/.exec(entry.trim());
  return m ? { method: m[1]!.toUpperCase(), path: normalizePath(m[2]!) } : undefined;
}

/** Where a record is in the repo: its evidence that cites a file of the repo. */
function citesIn(r: Rec, repo: string): ConformCite[] {
  return (r.evidence ?? [])
    .filter((e) => e.repo === repo && e.path)
    .map((e) => ({
      source: "code" as const,
      repo,
      path: e.path!,
      ...(e.line ? { line: e.line } : {}),
    }));
}

const key = (r: CatalogRecord) => `${r.kind}/${r.id}`;

export function conform(input: ConformInput): ConformResult {
  const { repo } = input;
  // What the code has: a planned record (a Spec Kit plan's, ADR 0030) is the design, not code.
  const code = (rs: CatalogRecord[]) =>
    (rs as Rec[]).filter((r) => !String(r.status ?? "current").startsWith("planned"));
  const after = code(input.after);
  const before = code(input.before);
  const beforeKeys = new Set(before.map(key));
  const byId = new Map<string, Rec>();
  for (const r of [...before, ...after]) byId.set(r.id, r);
  const systemOf = (id: string) => str(byId.get(id)?.system);
  const components = new Set(
    [...before, ...after].filter((r) => r.kind === "Component" && r.repo === repo).map((r) => r.id),
  );
  for (const d of input.deltas) if (d.delta.repo === repo) components.add(componentOf(d));
  const mine = (records: Rec[]) => records.filter((r) => citesIn(r, repo).length > 0);
  const interfaces = (records: Rec[]) =>
    records.filter((r) => r.kind === "Interface" && components.has(str(r.from) ?? ""));
  const publishes = (records: Rec[]) =>
    records.filter(
      (r) =>
        r.kind === "Unresolved" &&
        r.unresolvedKind === "event-publish" &&
        components.has(str(r.owner) ?? ""),
    );

  /** The calls (Interfaces, or a publish not yet joined to its listener) a step's `to` names. */
  const callsTo = (records: Rec[], from: string, to: { component: string; entry: string }) => {
    const http = httpEntry(to.entry);
    const endpoint = byId.get(to.entry);
    const reaches = (r: Rec) => {
      const t = str(r.to) ?? "";
      return (
        t === to.component ||
        systemOf(t) === to.component ||
        t === systemOf(to.component) ||
        str(byId.get(str(r.endpoint) ?? "")?.component) === to.component
      );
    };
    const out = records.filter((r) => {
      if (r.kind !== "Interface" || r.from !== from) return false;
      if (endpoint?.kind === "Endpoint") return r.endpoint === to.entry;
      if (http)
        return (
          str(r.method)?.toUpperCase() === http.method &&
          normalizePath(str(r.normalizedPath) ?? "") === http.path &&
          reaches(r)
        );
      // A topic: the call's path is the topic, wherever it goes.
      return str(r.normalizedPath) === to.entry.trim();
    });
    if (!http && endpoint?.kind !== "Endpoint")
      out.push(
        ...records.filter(
          (r) =>
            r.kind === "Unresolved" &&
            r.unresolvedKind === "event-publish" &&
            r.owner === from &&
            r.raw === to.entry.trim(),
        ),
      );
    return out;
  };

  /** Endpoints of the repo's components a trigger or another repo's call names. */
  const endpointsFor = (records: Rec[], component: string, entry: string) => {
    const http = httpEntry(entry);
    return records.filter((r) => {
      if (r.kind !== "Endpoint") return false;
      if (r.id === entry) return true;
      if (str(r.component) !== component) return false;
      if (http)
        return (
          str(r.method)?.toUpperCase() === http.method &&
          normalizePath(str(r.normalizedPath) ?? str(r.pathOrTopic) ?? "") === http.path
        );
      return str(r.pathOrTopic) === entry.trim();
    });
  };
  const columnOf = (records: Rec[], table: string, name: string) =>
    records.find((r) => r.kind === "Column" && r.table === table && r.name === name);
  const tableOf = (records: Rec[], table: string) =>
    records.find((r) => r.kind === "Table" && r.id === table);

  // What the target flows name, over every step of the change: anything named isn't out of scope.
  const named = new Set<string>();
  for (const d of input.deltas) {
    const from = componentOf(d);
    if (d.delta.change === "new" && d.delta.trigger) {
      const entry = d.delta.trigger.entry ?? d.delta.trigger.what;
      for (const r of endpointsFor(after, from, entry)) named.add(key(r));
    }
    for (const s of d.delta.steps) {
      if (s.op === "remove") continue;
      if (s.to) {
        for (const r of callsTo(after, from, s.to)) named.add(key(r));
        // A call to this repo's component names the endpoint it reaches.
        for (const r of endpointsFor(after, s.to.component, s.to.entry)) named.add(key(r));
      }
      if (s.store) {
        named.add(`Table/${s.store.table}`);
        for (const c of s.store.columns) {
          const col = columnOf(after, s.store.table, c);
          if (col) named.add(key(col));
        }
      }
    }
  }

  const inScope = (d: ConformDelta, item: number) =>
    d.delta.repo === repo &&
    (!input.scope || input.scope.some((s) => s.flow === d.delta.flow && s.item === item));
  const flowInScope = (d: ConformDelta) =>
    d.delta.repo === repo && (!input.scope || input.scope.some((s) => s.flow === d.delta.flow));

  const items: ConformItem[] = [];
  const unchecked: ConformUnchecked[] = [];
  const designed = (d: ConformDelta, line: number): ConformCite[] => [
    { source: "artifact", path: d.file, line },
  ];

  for (const d of input.deltas) {
    if (!flowInScope(d)) continue;
    const from = componentOf(d);
    const flow = d.delta.flow;
    const where = (item: number) => `item ${item} of ${d.file}`;
    const taskOf = (item: number) => input.tasks?.get(`${flow}#${item}`);
    const push = (i: Omit<ConformItem, "flow">) => {
      const task = i.item !== undefined ? taskOf(i.item) : undefined;
      items.push({ ...i, flow, ...(task ? { task } : {}) });
    };

    // A new flow's trigger, when the scope covers the flow's entry.
    const entryInScope =
      !input.scope || d.delta.steps.some((s, i) => s.kind === "entry" && inScope(d, i + 1));
    if (d.delta.change === "new" && entryInScope) {
      const t = d.delta.trigger;
      const entry = t?.entry ?? t?.what ?? "";
      if (t && (t.kind === "endpoint" || t.kind === "listener") && (httpEntry(entry) || t.entry)) {
        const found = endpointsFor(after, from, entry)[0];
        push(
          found
            ? {
                status: "found",
                check: "trigger",
                what: `${from} serves ${entry}, the trigger of ${flow}.`,
                record: found.id,
                at: citesIn(found, repo),
              }
            : {
                status: "missing",
                check: "trigger",
                what: `${from} serves no ${entry}, the trigger of new flow ${flow} (${d.file}).`,
                at: designed(d, d.triggerLine),
              },
        );
      } else
        unchecked.push({
          flow,
          kind: t?.kind ?? "trigger",
          why: t
            ? `A ${t.kind} trigger names no endpoint or topic the scan can find.`
            : "The new flow names no trigger.",
        });
    }

    // A removed flow: its trigger's endpoint and its calls go.
    if (d.delta.change === "remove" && d.today && !input.scope) {
      const ref = d.today.trigger.ref;
      const ep = ref ? after.find((r) => r.kind === "Endpoint" && r.id === ref) : undefined;
      if (ep)
        push({
          status: "still-there",
          check: "trigger",
          what: `${from} still serves ${ref}, the trigger of ${flow}, which ${d.file} removes.`,
          record: ep.id,
          at: citesIn(ep, repo),
        });
      d.today.steps.forEach((s, i) => {
        if (s.to) stillThere(d, i + 1, s.to, undefined, "removes");
      });
    }

    d.delta.steps.forEach((s, i) => {
      const item = i + 1;
      if (!inScope(d, item)) return;
      const line = d.stepLines[i] ?? d.triggerLine;
      const old = s.step ? d.today?.steps[s.step - 1] : undefined;
      const kind = s.kind ?? old?.kind ?? "step";
      let checked = false;
      if (s.op === "remove") {
        if (old?.to) {
          stillThere(d, item, old.to, line, "removes");
          checked = true;
        }
      } else {
        if (s.to) {
          checked = true;
          const found = callsTo(after, from, s.to)[0];
          const publish = kind === "publish";
          const verb = publish ? "publishes to" : "calls";
          push(
            found
              ? {
                  status: "found",
                  check: publish ? "publish" : "call",
                  item,
                  what: `${from} ${verb} ${s.to.component} ${s.to.entry}.`,
                  record: found.id,
                  at: citesIn(found, repo),
                }
              : {
                  status: "missing",
                  check: publish ? "publish" : "call",
                  item,
                  what: `${from} makes no ${publish ? "publish to" : "call to"} ${s.to.component} ${s.to.entry} (${where(item)}).`,
                  at: designed(d, line),
                },
          );
          // A changed step that goes elsewhere: today's call goes, unless another step keeps it.
          if (
            s.op === "change" &&
            old?.to &&
            (old.to.component !== s.to.component || old.to.entry !== s.to.entry)
          )
            stillThere(d, item, old.to, line, "sends elsewhere");
        }
        if (s.store) {
          storeChecks(d, item, s, line);
          checked = true;
        }
      }
      if (!checked)
        unchecked.push({
          flow,
          item,
          kind,
          why: NOT_CHECKABLE,
        });
    });

    function stillThere(
      d: ConformDelta,
      item: number,
      to: { component: string; entry: string },
      line: number | undefined,
      verb: "removes" | "sends elsewhere",
    ) {
      // Another step of the change that still makes the same call keeps it.
      const kept = input.deltas.some((o) =>
        o.delta.steps.some(
          (x) =>
            x.op !== "remove" &&
            componentOf(o) === from &&
            x.to?.component === to.component &&
            x.to.entry === to.entry,
        ),
      );
      if (kept) return;
      const left = callsTo(after, from, to)[0];
      push(
        left
          ? {
              status: "still-there",
              check: "call",
              item,
              what: `${from} still calls ${to.component} ${to.entry}, which ${d.delta.change === "remove" ? `${d.file} removes with its flow` : `${where(item)} ${verb}`}.`,
              record: left.id,
              at: citesIn(left, repo),
            }
          : {
              status: "found",
              check: "call",
              item,
              what: `${from} no longer calls ${to.component} ${to.entry}.`,
              at: line ? designed(d, line) : [{ source: "artifact", path: d.file }],
            },
      );
    }

    /** A store's migration, new table and columns; a table not in the repo's records is said. */
    function storeChecks(d: ConformDelta, item: number, s: DeltaStep, line: number): void {
      const st = s.store!;
      if (st.migration) {
        const file = input.files.find((f) => posix.basename(f) === st.migration);
        push(
          file
            ? {
                status: "found",
                check: "migration",
                item,
                what: `The migration ${st.migration} is in the repo.`,
                at: [{ source: "code", repo, path: file, line: 1 }],
              }
            : {
                status: "missing",
                check: "migration",
                item,
                what: `There is no migration ${st.migration} for ${st.table} (${where(item)}).`,
                at: designed(d, line),
              },
        );
      }
      const table = tableOf(after, st.table);
      if (st.new || table) {
        if (st.new)
          push(
            table
              ? {
                  status: "found",
                  check: "table",
                  item,
                  what: `The table ${st.table} exists.`,
                  record: table.id,
                  at: citesIn(table, repo),
                }
              : {
                  status: "missing",
                  check: "table",
                  item,
                  what: `There is no table ${st.table} (${where(item)}).`,
                  at: designed(d, line),
                },
          );
        for (const c of st.columns) {
          const col = columnOf(after, st.table, c);
          push(
            col
              ? {
                  status: "found",
                  check: "column",
                  item,
                  what: `${st.table} has the column ${c}.`,
                  record: col.id,
                  at: citesIn(col, repo),
                }
              : {
                  status: "missing",
                  check: "column",
                  item,
                  what: `${st.table} has no column ${c} (${where(item)}).`,
                  at: designed(d, line),
                },
          );
        }
      } else if (!st.migration)
        unchecked.push({
          flow: d.delta.flow,
          item,
          kind: s.kind ?? "step",
          why: `${st.table} isn't in ${repo}'s records, so its columns can't be checked here.`,
        });
    }
  }

  // Scope: what the branch adds that no target flow names. A table no step names covers its columns.
  const added = (r: Rec) => !beforeKeys.has(key(r)) && !named.has(key(r));
  const scope: ConformItem[] = [];
  const unexpectedTables = new Set<string>();
  for (const r of mine(after)) {
    if (!added(r)) continue;
    if (r.kind === "Table") {
      unexpectedTables.add(r.id);
      scope.push({
        status: "unexpected",
        check: "table",
        what: `The code adds the table ${r.id}, which no target flow names.`,
        record: r.id,
        at: citesIn(r, repo),
      });
    }
  }
  for (const r of mine(after)) {
    if (!added(r)) continue;
    if (r.kind === "Column" && !unexpectedTables.has(str(r.table) ?? ""))
      scope.push({
        status: "unexpected",
        check: "column",
        what: `The code adds the column ${str(r.name)} to ${str(r.table)}, which no target flow names.`,
        record: r.id,
        at: citesIn(r, repo),
      });
    else if (r.kind === "Endpoint" && components.has(str(r.component) ?? ""))
      scope.push({
        status: "unexpected",
        check: "endpoint",
        what: `${str(r.component)} serves ${[str(r.method), str(r.pathOrTopic)].filter(Boolean).join(" ")}, which no target flow names.`,
        record: r.id,
        at: citesIn(r, repo),
      });
  }
  for (const r of [...interfaces(mine(after)), ...publishes(mine(after))]) {
    if (!added(r)) continue;
    const publish = r.kind === "Unresolved";
    scope.push({
      status: "unexpected",
      check: publish ? "publish" : "call",
      what: publish
        ? `${str(r.owner)} publishes to ${str(r.raw)}, which no target flow names.`
        : `${str(r.from)} calls ${str(r.to)} ${[str(r.method), str(r.normalizedPath)].filter(Boolean).join(" ")}, which no target flow names.`,
      record: r.id,
      at: citesIn(r, repo),
    });
  }
  const order: ConformCheck[] = ["call", "publish", "endpoint", "table", "column"];
  scope.sort(
    (a, b) =>
      order.indexOf(a.check) - order.indexOf(b.check) ||
      (a.record ?? "").localeCompare(b.record ?? ""),
  );
  // The caller's side of a call: the first citation in the repo is where the code makes it.
  for (const s of scope) s.at = s.at.slice(0, 1);
  for (const i of items) if (i.status !== "missing") i.at = i.at.slice(0, 1);
  return { items: [...items, ...scope], unchecked };
}

const NOT_CHECKABLE =
  "A step of this kind names no call, table, column or migration a scan records; a person or a test checks it.";

function componentOf(d: ConformDelta): string {
  return d.today?.component ?? d.delta.flow.split(".")[0]!;
}

// ------------------------------------------------------------------ reading the change

/** The change's target flows with the line of each step, for citations. */
export async function readConformDeltas(
  changeDir: string,
): Promise<{ deltas: Omit<ConformDelta, "today">[]; problems: string[] }> {
  const deltas: Omit<ConformDelta, "today">[] = [];
  const problems: string[] = [];
  const names = (await readdir(join(changeDir, TARGET_DIR)).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".yaml"))
    .sort();
  for (const f of names) {
    const file = `${TARGET_DIR}/${f}`;
    try {
      const text = await readFile(join(changeDir, TARGET_DIR, f), "utf8");
      const lines = new LineCounter();
      const doc = parseDocument(text, { lineCounter: lines });
      const r = FlowDelta.safeParse(doc.toJS());
      if (!r.success) {
        problems.push(
          `${file}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
        continue;
      }
      const lineOf = (node: unknown) => {
        const range = (node as { range?: [number, number, number] } | undefined)?.range;
        return range ? lines.linePos(range[0]).line : 1;
      };
      const steps = doc.get("steps", true);
      const stepLines = isSeq(steps) ? steps.items.map(lineOf) : [];
      const root = doc.contents;
      const trigger = isMap(root) ? root.items.find((p) => String(p.key) === "trigger") : undefined;
      const flowKey = isMap(root) ? root.items.find((p) => String(p.key) === "flow") : undefined;
      deltas.push({
        file,
        delta: r.data,
        stepLines,
        triggerLine: lineOf((trigger ?? flowKey)?.key),
      });
    } catch (e) {
      problems.push(`${file}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return { deltas, problems };
}

/**
 * Which task builds which target-flow step, from the stories the stories stage writes
 * (`### Task <id>: ...` then `- Step: <op> (<kind>), item <n> of target-flows/<flow>.yaml`).
 * Keys are "<flow>#<item>".
 */
export async function readTaskSteps(changeDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const dir = join(changeDir, "stories");
  for (const f of (await readdir(dir).catch(() => [] as string[])).sort()) {
    if (!f.endsWith(".md")) continue;
    const text = await readFile(join(dir, f), "utf8").catch(() => "");
    let task: string | undefined;
    for (const line of text.split(/\r?\n/)) {
      const t = /^###\s+Task\s+(\S+?):/.exec(line);
      if (t) {
        task = t[1]!.toLowerCase();
        continue;
      }
      if (/^#{1,3}\s/.test(line)) task = undefined;
      const s = /^-\s+Step:.*\bitem\s+(\d+)\s+of\s+target-flows\/(\S+?)\.yaml/.exec(line);
      if (s && task && !out.has(`${s[2]}#${s[1]}`)) out.set(`${s[2]}#${s[1]}`, task);
    }
  }
  return out;
}
