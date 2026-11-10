import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { changesRelOf } from "@maycombhq/core";
import { changeFolder } from "@maycombhq/changes";
import {
  applyStroke,
  endpointKey,
  loadEstate,
  planSketchWrite,
  readDeltas,
  TARGET_DIR,
  writeSketch,
  type Estate,
  type FlowDelta,
  Stroke as StrokeSchema,
  type Stroke,
} from "@maycombhq/planner";
import { parse as parseYaml } from "yaml";
import { labelText, readDrawio, type DiagramEdge, type Legend } from "@maycombhq/reconcile";
import { targetFlowsOf } from "./change-map.js";
import type { Output } from "./commands.js";
import { withFileLock } from "./file-lock.js";

/**
 * ADR 0179: a change drawn elsewhere first. `atticus change sketch <change> --from <file>` reads
 * a draw.io export or a Mermaid flowchart and turns each line into a stroke (the same strokes
 * the canvas draws): a line between two boxes marked new, or not on today's map, is a call (or
 * a topic when its label names one); a line marked retired is the matching step of today's flow
 * taken out. A box the catalog doesn't know is a new API's side only: a stroke can't start from
 * it, because a new flow needs a name and a trigger the picture can't give, so it is reported
 * and the person draws it in the app. Shows what it would draw; writes with --save.
 */

export interface SketchLine {
  /** Labels of the boxes, as drawn. */
  from: string;
  to: string;
  label: string;
  method?: string;
  path?: string;
  topic?: string;
  legend?: Legend;
  at: string;
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** The parts of a line's text: METHOD /path, a topic, or just words. */
export function lineParts(text: string): Pick<SketchLine, "method" | "path" | "topic"> {
  const toks = text.trim().split(/\s+/).filter(Boolean);
  if (toks.length >= 2 && METHODS.has(toks[0]!.toUpperCase()) && toks[1]!.startsWith("/"))
    return { method: toks[0]!.toUpperCase(), path: toks[1]! };
  if (toks.length === 1 && /^[A-Za-z0-9][\w.-]*\.[\w.-]+$/.test(toks[0]!))
    return { topic: toks[0]! };
  return {};
}

/** A Mermaid flowchart's boxes and lines: `A[Label]`, `A -->|text| B`, `A -- text --> B`, `A ==> B`. */
export function readMermaidSketch(text: string): { lines: SketchLine[]; problems: string[] } {
  const labels = new Map<string, string>();
  const lines: SketchLine[] = [];
  const problems: string[] = [];
  const legendOf = (s: string): { legend?: Legend; text: string } => {
    const m =
      /^\s*[[(]\s*(new|modify|modified|changed|retire|retired|removed)\s*[\])]\s*(.*)$/i.exec(s);
    if (!m) return { text: s.trim() };
    const w = m[1]!.toLowerCase();
    return {
      legend: w.startsWith("new")
        ? "new"
        : w.startsWith("ret") || w === "removed"
          ? "retire"
          : "modify",
      text: m[2]!.trim(),
    };
  };
  const node = (tok: string): string => {
    const m =
      /^([A-Za-z0-9_.-]+)(?:\[\s*"?([^\]"]*)"?\s*\]|\(+\s*"?([^)"]*)"?\s*\)+|\{+\s*"?([^}"]*)"?\s*\}+|>\s*"?([^\]"]*)"?\s*\])?$/.exec(
        tok.trim(),
      );
    if (!m) return tok.trim();
    const label = (m[2] ?? m[3] ?? m[4] ?? m[5])?.trim();
    if (label) labels.set(m[1]!, label);
    return m[1]!;
  };
  const rows = text.split(/\r?\n/);
  rows.forEach((raw, i) => {
    const row = raw.replace(/%%.*$/, "").trim();
    if (
      !row ||
      /^(flowchart|graph)\b/i.test(row) ||
      /^(subgraph|end|classDef|class|style|direction)\b/i.test(row)
    )
      return;
    if (/<\s*[-=.]/.test(row)) {
      problems.push(`line ${i + 1}: a two-way line: draw one line each way: ${row}`);
      return;
    }
    // A -->|text| B  ·  A -- text --> B  ·  A --> B  ·  A ==>|text| B  ·  A -.->|text| B
    const m =
      /^(.+?)\s*(?:--+|==+|-\.+-?)\s*(?:\|([^|]*)\||"?([^">=-]*?)"?\s*(?:--+|==+|\.-+))?\s*>\s*(?:\|([^|]*)\|)?\s*(.+)$/.exec(
        row,
      );
    if (!m) {
      // A box on its own: A[Label].
      if (/^[A-Za-z0-9_.-]+\s*[[({]/.test(row)) node(row);
      else problems.push(`line ${i + 1}: not a box or a line: ${row}`);
      return;
    }
    // One line, two boxes: a chain (A --> B --> C) or a fan (A & B --> C) is said, not guessed.
    if (/-->|==>|\.->|&/.test(m[1]!) || /-->|==>|\.->|&/.test(m[5]!)) {
      problems.push(`line ${i + 1}: one line between two boxes at a time (no chains or &): ${row}`);
      return;
    }
    const from = node(m[1]!);
    const to = node(m[5]!);
    const { legend, text: label } = legendOf(
      (m[2] ?? m[3] ?? m[4] ?? "").trim().replace(/^"(.*)"$/, "$1"),
    );
    lines.push({
      from: labels.get(from) ?? from,
      to: labels.get(to) ?? to,
      label,
      ...lineParts(label),
      ...(legend ? { legend } : {}),
      at: `line ${i + 1}`,
    });
  });
  // Labels seen after a line was read name its boxes too.
  for (const l of lines) {
    l.from = labels.get(l.from) ?? l.from;
    l.to = labels.get(l.to) ?? l.to;
  }
  return { lines, problems };
}

/**
 * ADR 0193: a strokes file, YAML or JSON: a list of strokes, or `strokes: [ ... ]`, each the
 * stroke the canvas draws (checked against the Stroke schema). Applied in the file's order.
 */
export function readStrokesFile(
  text: string,
  name: string,
): { strokes: { stroke: Stroke; at: string }[]; problems: string[] } {
  let doc: unknown;
  try {
    doc = /\.json$/i.test(name) ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    return {
      strokes: [],
      problems: [`${name} doesn't read: ${(e as Error).message.split("\n")[0]}`],
    };
  }
  const list = Array.isArray(doc)
    ? doc
    : doc && typeof doc === "object" && Array.isArray((doc as { strokes?: unknown }).strokes)
      ? (doc as { strokes: unknown[] }).strokes
      : undefined;
  if (!list)
    return {
      strokes: [],
      problems: [`${name} has no strokes: write a list of strokes, or strokes: [ ... ].`],
    };
  const strokes: { stroke: Stroke; at: string }[] = [];
  const problems: string[] = [];
  list.forEach((raw, i) => {
    const s = StrokeSchema.safeParse(raw);
    if (s.success) strokes.push({ stroke: s.data, at: `stroke ${i + 1}` });
    else
      problems.push(
        `stroke ${i + 1}: isn't a stroke Atticus draws: ${s.error.issues
          .map((x) => `${x.path.join(".") || "kind"}: ${x.message}`)
          .join("; ")}`,
      );
  });
  return { strokes, problems };
}

/** Edit distance between two ids, for "did you mean". */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** The nearest component ids to one the map doesn't have: at most three, never a guess applied. */
export function suggestComponents(id: string, components: readonly string[]): string[] {
  const words = new Set(id.split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  return [...new Set(components)]
    .map((c) => {
      const shared = c.split(/[^a-z0-9]+/).filter((w) => words.has(w)).length;
      return {
        c,
        d: distance(id, c) - shared * 2,
        ok: distance(id, c) <= Math.max(3, id.length / 3) || shared > 0,
      };
    })
    .filter((x) => x.ok)
    .sort((x, y) => x.d - y.d || x.c.localeCompare(y.c))
    .slice(0, 3)
    .map((x) => x.c);
}

/** The components of the estate: of today's flows and the catalog's Component records. */
const componentsOf = (estate: Estate) => [
  ...estate.flows.map((f) => f.flow.component),
  ...estate.records.filter((r) => r.kind === "Component").map((r) => r.id),
];

/** A stroke in a line of output: what it draws. */
function describeStroke(s: Stroke): Pick<SketchLine, "from" | "to" | "label"> {
  switch (s.kind) {
    case "absorb":
      return { from: s.component, to: s.into.component, label: "absorb" };
    case "retire":
      return { from: s.component, to: "", label: "retire" };
    case "call":
      return { from: s.from.component, to: s.to.component, label: s.to.entry };
    case "topic":
      return { from: s.from.component, to: s.listener?.component ?? "", label: s.topic };
    case "table":
      return { from: s.from.component, to: s.table, label: s.op };
    case "remove":
      return { from: s.flow, to: "", label: `remove step ${s.step}` };
    case "retarget":
      return { from: s.flow, to: s.to.component, label: s.to.entry };
    case "undo":
      return { from: s.flow, to: "", label: `undo ${s.index}` };
  }
}

/** A drawn or left-out stroke as one line: `absorb a into b`, `a → b POST /x`. */
const strokeText = (l: Pick<SketchLine, "from" | "to" | "label">) =>
  l.label === "absorb"
    ? `absorb ${l.from} into ${l.to}`
    : l.label === "retire"
      ? `retire ${l.from}`
      : `${l.from}${l.to ? ` → ${l.to}` : ""} ${l.label}`;

/** A problem with "did you mean" for each component the stroke names that the map doesn't have. */
function withSuggestions(problem: string, s: Stroke, estate: Estate): string {
  const named = [
    ...(s.kind === "absorb" || s.kind === "retire" ? [s.component] : []),
    ...("from" in s ? [s.from.component] : []),
  ];
  const known = new Set(componentsOf(estate));
  const hints = named
    .filter((c) => !known.has(c) && !estate.ids.has(c))
    .map((c) => ({ c, near: suggestComponents(c, [...known]) }))
    .filter((x) => x.near.length)
    .map(
      (x) => ` Did you mean ${x.near.join(", ")}${x.near.length > 1 ? " (nearest first)" : ""}?`,
    );
  return problem + hints.join("");
}

/** The lines of a draw.io export, through the reconcile reader. */
export function readDrawioSketch(xml: string): { lines: SketchLine[]; problems: string[] } {
  const d = readDrawio(xml);
  const lines = d.edges.map((e: DiagramEdge) => ({
    from: e.from,
    to: e.to,
    label: labelText(e.label),
    ...(e.method ? { method: e.method } : {}),
    ...(e.path ? { path: e.path } : {}),
    ...(e.topic ? { topic: e.topic } : {}),
    ...(e.legend ? { legend: e.legend } : {}),
    at: `${e.page}:${e.line}`,
  }));
  return { lines, problems: d.problems.map((p) => `${p.cell}: ${p.message}`) };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The component a drawn box is: by id, by slug of its label, or by the component's name. */
export function componentOf(
  label: string,
  estate: Pick<Estate, "records" | "ids" | "flows">,
): string | undefined {
  const s = slug(label);
  const known = (id: string) =>
    estate.ids.has(id) || estate.flows.some((f) => f.flow.component === id);
  if (known(label)) return label;
  if (known(s)) return s;
  for (const r of estate.records)
    if (
      r.kind === "Component" &&
      (slug(("name" in r && typeof r.name === "string" ? r.name : "") ?? "") === s ||
        slug(r.id) === s)
    )
      return r.id;
  return undefined;
}

export interface SketchPlan {
  strokes: { stroke: Stroke; line: SketchLine }[];
  skipped: { line: SketchLine; why: string }[];
}

/** Lines into strokes, against today's map: what to draw, and what the picture can't say. */
export function strokesOfLines(
  lines: readonly SketchLine[],
  estate: Estate,
  drawnAlready: readonly FlowDelta[] = [],
): SketchPlan {
  const plan: SketchPlan = { strokes: [], skipped: [] };
  for (const l of lines) {
    const from = componentOf(l.from, estate);
    const to = componentOf(l.to, estate) ?? slug(l.to);
    if (!from) {
      plan.skipped.push({
        line: l,
        why: `${l.from} isn't a component of the catalog: a stroke can't start from it here (a new box needs a flow name and a trigger; draw it in the app).`,
      });
      continue;
    }
    const entry = l.topic ?? (l.method && l.path ? `${l.method} ${l.path}` : l.label);
    if (!entry) {
      plan.skipped.push({
        line: l,
        why: "the line has no label: say the API (METHOD /path) or the topic.",
      });
      continue;
    }
    const todaySteps = estate.flows
      .filter((f) => f.flow.component === from)
      .flatMap((f) =>
        f.flow.steps
          .map((s, i) => ({ flow: f.flow.id, step: i + 1, s }))
          .filter(
            ({ s }) =>
              s.to?.component === to &&
              (s.to.entry === entry ||
                (!!l.path && s.to.entry.replace(/^[A-Z]+\s+/, "") === l.path)),
          ),
      );
    if (l.legend === "retire") {
      if (!todaySteps.length) {
        plan.skipped.push({
          line: l,
          why: `marked retired, but today's map has no step from ${from} to ${to} ${entry}.`,
        });
        continue;
      }
      // Every flow of the component that makes the call loses its step.
      for (const t of todaySteps)
        plan.strokes.push({
          line: l,
          stroke: {
            kind: "remove",
            flow: t.flow,
            step: t.step,
            why: `Removed in the sketch (${l.at}).`,
          },
        });
      continue;
    }
    if (todaySteps.length && l.legend !== "new") {
      plan.skipped.push({ line: l, why: "already on today's map; nothing to draw." });
      continue;
    }
    // Drawn before (a second --save, or on the canvas): the same line isn't drawn twice.
    const drawnBefore = drawnAlready.some(
      (d) =>
        (d.repo === from || d.runsOn?.component === from || d.flow.startsWith(`${from}.`)) &&
        d.steps.some(
          (st) =>
            st.op === "add" &&
            ((l.topic && st.kind === "publish" && st.to?.entry === l.topic) ||
              (!l.topic && st.to?.component === to && st.to.entry === entry)),
        ),
    );
    if (drawnBefore) {
      plan.skipped.push({ line: l, why: "already drawn in this change; nothing to add." });
      continue;
    }
    const isNew =
      !componentOf(l.to, estate) || (!!l.method && !estate.endpoints.has(endpointKey(entry)));
    plan.strokes.push({
      line: l,
      stroke: l.topic
        ? {
            kind: "topic",
            from: { component: from },
            topic: l.topic,
            ...(componentOf(l.to, estate) && to !== from ? { listener: { component: to } } : {}),
            what: `Publishes ${l.topic} (${l.at}).`,
          }
        : {
            kind: "call",
            from: { component: from },
            to: { component: to, entry, new: isNew },
            what: `Calls ${to}'s ${entry} (${l.at}).`,
          },
    });
  }
  return plan;
}

/** atticus change sketch <change> --from <file.drawio|.mmd|strokes.yaml|strokes.json> [--save]. */
export async function changeSketchCommand(
  root: string,
  change: string | undefined,
  o: { from?: string; save?: boolean; json?: boolean; by?: string },
  io: Output,
): Promise<number> {
  if (!change || !o.from) {
    io.err(
      "Usage: atticus change sketch <change> --from <file.drawio|.mmd|strokes.yaml|.json> [--save]",
    );
    return 2;
  }
  const t = await targetFlowsOf(root, change);
  if (!t) {
    io.err(`There is no change ${change}.`);
    return 2;
  }
  const text = await readFile(o.from, "utf8").catch(() => undefined);
  if (text === undefined) {
    io.err(`${o.from} can't be read.`);
    return 2;
  }
  const ext = extname(o.from).toLowerCase();
  const estate = await loadEstate(root, t.records);
  const dir = changeFolder(root, change);
  // ADR 0193: a strokes file is applied as written, in order; a picture is read as lines first.
  const strokesFile = ext === ".yaml" || ext === ".yml" || ext === ".json";
  const sf = strokesFile ? readStrokesFile(text, basename(o.from)) : undefined;
  const read = sf
    ? { lines: [] as SketchLine[], problems: sf.problems }
    : ext === ".drawio" || ext === ".xml" || text.trimStart().startsWith("<")
      ? readDrawioSketch(text)
      : readMermaidSketch(text);
  const plan: SketchPlan = sf
    ? {
        strokes: sf.strokes.map((x) => ({
          stroke: x.stroke,
          line: { ...describeStroke(x.stroke), at: x.at },
        })),
        skipped: [],
      }
    : strokesOfLines(read.lines, estate, (await readDeltas(dir)).deltas);
  const by = `${o.by ?? "a person"} from ${basename(o.from)}`;
  const problems = [...read.problems];
  const drawn: string[] = [];
  await withFileLock(join(dir, TARGET_DIR), async () => {
    const read = await readDeltas(dir);
    if (read.problems.length) {
      problems.push(...read.problems.map((x) => `${x} (fix it before drawing over it)`));
      return;
    }
    let deltas = read.deltas;
    const changed: string[] = [];
    for (const s of plan.strokes) {
      const r = applyStroke(deltas, s.stroke, estate, by);
      if (r.problem) {
        plan.skipped.push({
          line: s.line,
          why: sf ? withSuggestions(r.problem, s.stroke, estate) : r.problem,
        });
        continue;
      }
      deltas = r.deltas;
      changed.push(...r.changed);
      drawn.push(
        sf
          ? `${strokeText(s.line)} (${s.line.at})`
          : `${s.line.from} → ${s.line.to} ${s.line.label} (${s.line.at})`,
      );
    }
    if (o.save && drawn.length)
      await writeSketch(dir, await planSketchWrite(dir, deltas, changed, estate, by));
  });
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          change,
          written: !!o.save && drawn.length > 0,
          drawn,
          skipped: plan.skipped,
          problems: problems,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  for (const d of drawn) io.out(`${o.save ? "Drawn" : "Would draw"}: ${d}`);
  for (const s of plan.skipped)
    io.out(
      sf
        ? `Left out: ${strokeText(s.line)} (${s.line.at}): ${s.why}`
        : `Left out: ${s.line.from} → ${s.line.to} ${s.line.label} (${s.line.at}): ${s.why}`,
    );
  for (const p of problems) io.out(`Didn't read: ${p}`);
  if (!drawn.length) {
    io.out("Nothing to draw from this file.");
    return plan.skipped.length || problems.length ? 1 : 0;
  }
  io.out(
    o.save
      ? `${drawn.length} stroke${drawn.length === 1 ? "" : "s"} written to ${changesRelOf(root)}/${change}/${TARGET_DIR}/; the change diagram shows them, and atticus change architecture ${change} fills in the rest.`
      : `${drawn.length} stroke${drawn.length === 1 ? "" : "s"} to draw; nothing written. Add --save to draw them.`,
  );
  return 0;
}
