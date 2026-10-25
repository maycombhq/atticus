import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizePath, RecordId } from "@maycombhq/core";
import { docOf, sectionLines, type DataChange, type Hop } from "@maycombhq/naysayer";
import {
  parseStory,
  type ParsedStory,
  type PlanContext,
  type SpecScenario,
} from "@maycombhq/planner";
import { TestgenError } from "./errors.js";

/**
 * A story as test generation reads it: its acceptance criteria split into Given/When/Then
 * steps (each with the spec scenario it traces to), the interfaces and data changes it
 * links to, its repos and its tasks. Stories written by `atticus plan stories` carry these as
 * links; for a hand-written story without links, the hops whose path the story mentions are
 * used, and the result says the links were inferred.
 */

export interface Criterion {
  /** 1-based position in the acceptance criteria. */
  n: number;
  text: string;
  given: string;
  when: string;
  then: string;
  /** The spec scenario it traces to, from its "(file:line)" or by wording. */
  trace?: { file: string; line: number; name: string };
  /** Line of the criterion in the story file. */
  line: number;
}

export interface StoryTask {
  id: string;
  repo: string;
  text: string;
  line: number;
}

export interface StoryContext {
  id: string;
  /** Change-folder-relative path of the story file. */
  path: string;
  parsed: ParsedStory;
  title: string;
  criteria: Criterion[];
  hops: Hop[];
  data: DataChange[];
  repos: string[];
  tasks: StoryTask[];
  /** "links" when the story names its interfaces and records; "inferred" otherwise. */
  linkedBy: "links" | "inferred";
  /** The requirement the story traces to ("file:line"), if any. */
  tracesTo?: string;
}

const GWT =
  /^given\s+(.+?),?\s+when\s+(.+?),?\s+then\s+(.+?)\.?(?:\s*\(([^()]+?):(\d+)\))?\.?\s*$/i;

const content = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9_ ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
const STOP = new Set([
  "the",
  "and",
  "with",
  "that",
  "has",
  "its",
  "for",
  "asks",
  "when",
  "then",
  "given",
  "error",
]);

/** Word overlap of two texts (Jaccard over content words). */
export function overlap(a: string, b: string): number {
  const x = content(a);
  const y = content(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / (x.size + y.size - n);
}

/** The spec scenario a criterion traces to: its own reference, else the closest wording (≥ 0.5). */
export function traceCriterion(
  text: string,
  ref: { file: string; line: number } | undefined,
  scenarios: { file: string; s: SpecScenario }[],
): Criterion["trace"] {
  if (ref) {
    const hit = scenarios.find((x) => x.file === ref.file && x.s.line === ref.line);
    return { file: ref.file, line: ref.line, name: hit?.s.name ?? "" };
  }
  let best: { file: string; s: SpecScenario; score: number } | undefined;
  for (const x of scenarios) {
    const score = overlap(text, `${x.s.when.join(" ")} ${x.s.then.join(" ")}`);
    if (score >= 0.5 && (!best || score > best.score)) best = { ...x, score };
  }
  return best ? { file: best.file, line: best.s.line, name: best.s.name } : undefined;
}

export function splitCriterion(text: string): {
  given: string;
  when: string;
  then: string;
  ref?: { file: string; line: number };
} {
  // B-once: the story file notes the other tasks a criterion accepts after it; not its words.
  text = text.replace(/\s*\(also accepts tasks? [^()]*\)\s*$/i, "");
  const m = GWT.exec(text.trim());
  if (!m) return { given: "", when: "", then: text.trim().replace(/\.$/, "") };
  return {
    given: m[1]!.trim(),
    when: m[2]!.trim(),
    then: m[3]!.trim(),
    ...(m[4] ? { ref: { file: m[4].trim(), line: Number(m[5]) } } : {}),
  };
}

interface LinkedInterface {
  id: string;
  caller: string;
  callee: string;
  operation: string;
  line?: number;
}

const LINK_IF = /^Interface\s+(\S+?):\s*(\S+)\s*→\s*(\S+)\s+(.+?)\s*(?:\(([^)]*)\))?\s*$/;
const LINK_REC = /^Record\s+([a-z0-9][a-z0-9._-]*?)[:.]?(?:\s|$)/;

function links(doc: ParsedStory["doc"]): { interfaces: LinkedInterface[]; records: string[] } {
  const s = doc.sections.find((x) => x.level === 2 && /^links$/i.test(x.heading));
  const interfaces: LinkedInterface[] = [];
  const records: string[] = [];
  if (!s) return { interfaces, records };
  for (const l of sectionLines(doc, s)) {
    const b = /^\s*[-*]\s+(.*)$/.exec(l.text)?.[1]?.trim();
    if (!b) continue;
    const i = LINK_IF.exec(b);
    if (i) {
      const line = /interfaces\.md:(\d+)/.exec(i[5] ?? "")?.[1];
      interfaces.push({
        id: i[1]!.replace(/[()]/g, ""),
        caller: i[2]!,
        callee: i[3]!,
        operation: i[4]!.trim(),
        ...(line ? { line: Number(line) } : {}),
      });
      continue;
    }
    const r = LINK_REC.exec(b);
    if (r) records.push(r[1]!);
  }
  return { interfaces, records };
}

const opKey = (op: string) => {
  const m = /^([A-Za-z]+)\s+(\S+)/.exec(op.trim());
  return m
    ? `${m[1]!.toUpperCase()} ${/^\//.test(m[2]!) ? normalizePath(m[2]!) : m[2]!}`
    : op.trim();
};

const TASK = /^\s*[-*]\s+\[[ xX]?\]\s+(\S+)\s+(.*)$/;

/** The change's tasks for this story, from tasks.md (`## <repo>` sections of checkbox lines). */
function storyTasks(ctx: PlanContext, story: string): StoryTask[] {
  const doc = docOf(ctx.files, "tasks.md");
  if (!doc) return [];
  const out: StoryTask[] = [];
  let repo = "";
  doc.lines.forEach((l, i) => {
    const h = /^##\s+(.+?)\s*$/.exec(l);
    if (h) {
      repo = h[1]!.replace(/[`*]/g, "").trim().split(/\s+/)[0]!.toLowerCase();
      return;
    }
    const m = TASK.exec(l);
    if (!m || !repo || !RecordId.safeParse(m[1]!.toLowerCase()).success) return;
    const stories = [...m[2]!.matchAll(/\bstor(?:y|ies)\s+([a-z0-9][a-z0-9._-]*)/gi)].map((s) =>
      s[1]!.toLowerCase().replace(/[.,)]+$/, ""),
    );
    if (stories.includes(story))
      out.push({ id: m[1]!.toLowerCase(), repo, text: m[2]!, line: i + 1 });
  });
  return out;
}

export async function loadStory(ctx: PlanContext, storyId: string): Promise<StoryContext> {
  if (!RecordId.safeParse(storyId).success)
    throw new TestgenError("invalid", `"${storyId}" is not a story id.`);
  const path = `stories/${storyId}.md`;
  let text: string;
  try {
    text = await readFile(join(ctx.dir, "stories", `${storyId}.md`), "utf8");
  } catch {
    throw new TestgenError(
      "not-found",
      `${ctx.change.id} has no story ${storyId} (no ${path}). Plan the stories first: atticus plan stories ${ctx.change.id}`,
    );
  }
  const parsed = parseStory(path, text);
  const scenarios = ctx.requirements.flatMap((r) => r.scenarios.map((s) => ({ file: r.file, s })));
  const criteriaLines = (() => {
    const s = parsed.doc.sections.find(
      (x) => x.level === 2 && /acceptance criteria/i.test(x.heading),
    );
    return s ? sectionLines(parsed.doc, s).filter((l) => /^\s*[-*]\s+/.test(l.text)) : [];
  })();
  const criteria: Criterion[] = parsed.criteria.map((c, i) => {
    const p = splitCriterion(c);
    const trace = traceCriterion(c, p.ref, scenarios);
    return {
      n: i + 1,
      text: c,
      given: p.given,
      when: p.when,
      then: p.then,
      ...(trace ? { trace } : {}),
      line: criteriaLines[i]?.n ?? 1,
    };
  });

  const l = links(parsed.doc);
  let hops: Hop[] = [];
  let linkedBy: StoryContext["linkedBy"] = "links";
  if (l.interfaces.length) {
    for (const li of l.interfaces) {
      const h =
        (li.line ? ctx.hops.find((x) => x.line === li.line) : undefined) ??
        (li.id !== "new" ? ctx.hops.find((x) => x.id === li.id) : undefined) ??
        ctx.hops.find(
          (x) =>
            x.caller === li.caller &&
            x.callee === li.callee &&
            opKey(x.operation) === opKey(li.operation),
        );
      if (h && !hops.includes(h)) hops.push(h);
    }
  } else {
    linkedBy = "inferred";
    const said = [
      text,
      ...(ctx.requirements.find((r) => parsed.traces?.includes(`${r.file}:${r.line}`))?.text ?? []),
    ].join("\n");
    hops = ctx.hops.filter((h) => {
      const op = h.path ?? h.operation.replace(/^\S+\s+/, "");
      return op && said.includes(op);
    });
  }
  const tasks = storyTasks(ctx, storyId);
  let data = ctx.data.filter((d) => l.records.includes(d.tableId));
  if (!data.length && !l.records.length) {
    const taskText = tasks.map((t) => t.text).join("\n");
    data = ctx.data.filter(
      (d) =>
        (d.migration && taskText.includes(d.migration)) || taskText.includes(`table ${d.table}`),
    );
    if (data.length) linkedBy = "inferred";
  }

  const repos = [
    ...new Set([...parsed.repos.map((r) => r.toLowerCase()), ...tasks.map((t) => t.repo)]),
  ].filter((r) => RecordId.safeParse(r).success);

  return {
    id: storyId,
    path,
    parsed,
    title: parsed.title ?? storyId,
    criteria,
    hops,
    data,
    repos,
    tasks,
    linkedBy,
    ...(parsed.traces ? { tracesTo: /^(\S+:\d+)/.exec(parsed.traces)?.[1] ?? parsed.traces } : {}),
  };
}
