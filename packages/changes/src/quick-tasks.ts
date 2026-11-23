import { proseLines, rowIds, type CodeTable, type HasWord } from "./code-table.js";

/**
 * v31 (WP-05): a quick change's tasks, checked at its plan hand-off with the stories stage's
 * completeness rules (`stories.no-criteria`, `stories.no-error-case`, `stories.unknown-entry`),
 * so the quick path's tasks are held to what a story's tasks are. Only a task with no criteria
 * at all blocks; the rest are notes. tasks.md is read as it is: this never changes how a
 * person's tasks.md reads as the stories stage done (`personWrittenPlanning`).
 *
 * A task's criteria are, as the files already say them:
 * - its own: an indented list item under its checkbox line in the one-line form the stories
 *   stage writes in a story (`- Given …, when …, then …`); other sub-items are not criteria;
 * - its spec's: one `#### Scenario:` of a requirement that a row of design.md's `## In the code`
 *   names in its Spec cell for the task. An OpenSpec scenario is a GIVEN/WHEN/THEN criterion the
 *   spec writer already wrote, and the row is the line that ties the task to it. A scenario
 *   vouches for one task only: a task with no criteria of its own takes the first scenario of its
 *   rows' requirements that no earlier task in tasks.md took (v31 review of gate 0, where one
 *   scenario stood for four tasks).
 */

export interface QuickTaskFinding {
  rule:
    | "stories.no-criteria"
    | "stories.no-error-case"
    | "stories.unknown-entry"
    | "stories.spec-criteria";
  task: string;
  blocking: boolean;
  message: string;
}

export interface QuickTaskContext {
  /** tasks.md's text. */
  tasks: string;
  table: CodeTable;
  specs: readonly { path: string; text: string }[];
  has: (id: string) => boolean;
  planned: readonly string[];
}

interface Criterion {
  line: number;
  text: string;
}

export interface QuickTask {
  id: string;
  title: string;
  line: number;
  own: Criterion[];
  /** The scenario it took, when it has no criteria of its own: its requirement, name and lines. */
  took?: Scenario;
  /** The scenarios its rows' requirements have that earlier tasks took, with the task. */
  taken: (Scenario & { by: string })[];
  /** The Spec cells of its rows whose requirement has no scenario. */
  bare: string[];
  has: HasWord[];
}

interface Scenario {
  spec: string;
  scenario: string;
  text: string;
}

const CRITERION = /^\s+[-*]\s+(?!\[[ xX]?\])(?:\*\*)?(given|when)\b(.*)$/i;
const TASK = /^\s*[-*]\s+\[[ xX]?\]\s+(\S+)\s+(.*)$/;

/** Each requirement's scenarios (name and lines), by `<capability>: <requirement>`, folded. */
function scenariosOf(
  specs: QuickTaskContext["specs"],
): Map<string, { name: string; text: string }[]> {
  const out = new Map<string, { name: string; text: string }[]>();
  for (const s of specs) {
    const cap = /^specs\/([^/]+)\//.exec(s.path.replace(/\\/g, "/"))?.[1];
    if (!cap) continue;
    let list: { name: string; text: string }[] | undefined;
    for (const l of proseLines(s.text)) {
      const r = /^###\s+Requirement:\s*(.+?)\s*$/i.exec(l);
      const sc = /^####\s+Scenario:\s*(.+?)\s*$/i.exec(l);
      if (r) out.set(`${cap}: ${r[1]}`.toLowerCase(), (list = []));
      else if (/^#{1,3}\s/.test(l)) list = undefined;
      else if (sc && list) list.push({ name: sc[1]!, text: l });
      else if (list?.length && l.trim()) list[list.length - 1]!.text += `\n${l}`;
    }
  }
  return out;
}

/** Each task of tasks.md under a `## <repo>` heading, with the criteria it has. */
export function quickTaskCriteria(c: QuickTaskContext): QuickTask[] {
  const scenarios = scenariosOf(c.specs);
  const out: QuickTask[] = [];
  let repo = false;
  // The task a criterion line attaches to: the task line just above, or a sub-item of it.
  let open: QuickTask | undefined;
  const specsOf = new Map<QuickTask, string[]>();
  proseLines(c.tasks).forEach((l, i) => {
    if (!l.trim()) return;
    if (/^#{1,6}\s/.test(l)) {
      if (/^#{1,2}\s/.test(l)) repo = /^##\s+\S/.test(l);
      open = undefined;
      return;
    }
    const t = repo ? TASK.exec(l) : null;
    if (t) {
      const id = t[1]!.toLowerCase();
      const rows = c.table.rows.filter((r) => r.task?.toLowerCase() === id);
      const specs = [...new Set(rows.flatMap((r) => (r.spec ? [r.spec] : [])))];
      open = {
        id,
        title: t[2]!.replace(/(\s*\((?:after|story|stories)\b[^)]*\))+\s*$/i, "").trim(),
        line: i + 1,
        own: [],
        taken: [],
        bare: specs.filter((s) => !scenarios.get(s.toLowerCase())?.length),
        has: [...new Set(rows.map((r) => r.has as HasWord))],
      };
      specsOf.set(open, specs);
      out.push(open);
      return;
    }
    if (!open || !/^\s+[-*]\s/.test(l)) {
      open = undefined;
      return;
    }
    const m = CRITERION.exec(l);
    if (m && /\bthen\b/i.test(m[2]!)) open.own.push({ line: i + 1, text: l.trim() });
  });
  // A scenario vouches for one task: claimed in tasks.md's order by a task with none of its own.
  const claimed = new Map<string, string>();
  for (const t of out) {
    if (t.own.length) continue;
    for (const spec of specsOf.get(t) ?? [])
      for (const s of scenarios.get(spec.toLowerCase()) ?? []) {
        const key = `${spec.toLowerCase()}\n${s.name.toLowerCase()}`;
        const by = claimed.get(key);
        if (by) t.taken.push({ spec, scenario: s.name, text: s.text, by });
        else if (!t.took) {
          t.took = { spec, scenario: s.name, text: s.text };
          claimed.set(key, t.id);
        }
      }
    if (t.took) t.taken = [];
  }
  return out;
}

/** What a row says the task does that needs an error case (the stories stage's NEEDS_ERROR_CASE). */
const NEEDS: [HasWord[], string, string][] = [
  [["serves"], "takes requests", "the request is refused, and what the caller sees"],
  [["calls"], "calls another system", "the call fails or times out, and what the caller sees"],
  [["publishes"], "publishes", "the publish fails, and what happens to what was sent"],
  [["table", "column", "migration"], "writes data", "the write fails, and what the caller sees"],
];

/** A criterion or scenario that says what happens when something goes wrong. */
const ERROR_WORDS =
  /\b(fail(s|ed|ure)?|errors?|reject(s|ed)?|refuse[sd]?|times? out|timeout|invalid|denied|unavailable|not found)\b/i;
/** A status code said as one: after status, HTTP or code, or before its reason's words. */
const STATUS =
  /\b(?:status|http|code)\s*[45]\d\d\b|\b[45]\d\d\s+(?:bad|unauthori[sz]ed|forbidden|not|conflict|gone|unprocessable|too|internal|service|gateway)\b/i;

/** Whether a criterion or scenario says what happens when something goes wrong. */
export const saysFailure = (text: string): boolean => ERROR_WORDS.test(text) || STATUS.test(text);

const METHOD_PATH = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s,;)`]*)/g;
const TOPIC = /`([a-z][a-z0-9-]*(?:\.[a-z0-9_-]+){2,})`/g;

export function checkQuickTasks(c: QuickTaskContext): QuickTaskFinding[] {
  const out: QuickTaskFinding[] = [];
  const named = new Set(c.table.rows.flatMap((r) => [...rowIds(r), r.what]));
  const known = (x: string) => c.has(x) || c.planned.includes(x) || named.has(x);
  const tasks = quickTaskCriteria(c);
  for (const t of tasks) {
    const at = `tasks.md:${t.line}: task ${t.id} (${t.title})`;
    if (!t.own.length && !t.took) {
      const taken = t.taken.map(
        (x) =>
          `${x.spec} has the scenario "${x.scenario}", and task ${x.by} took it: a scenario vouches for one task; add one for ${t.id}`,
      );
      const why = [...t.bare.map((b) => `${b} has none`), ...taken].join("; ");
      out.push({
        rule: "stories.no-criteria",
        task: t.id,
        blocking: true,
        message: `${at} has no acceptance criteria. Add one under its line, indented: "- Given …, when …, then …". Or name, in its row of design.md's ## In the code, a requirement of its spec delta that has a #### Scenario:${why ? ` (${why})` : ""}.`,
      });
      continue;
    }
    for (const k of t.own) {
      const entries = [
        ...[...k.text.matchAll(METHOD_PATH)].map((m) => `${m[1]} ${m[2]!.replace(/[.:]+$/, "")}`),
        ...[...k.text.matchAll(TOPIC)].map((m) => m[1]!),
      ];
      for (const e of new Set(entries))
        if (!known(e) && !known(e.replace(/^\S+\s+/, "")))
          out.push({
            rule: "stories.unknown-entry",
            task: t.id,
            blocking: false,
            message: `tasks.md:${k.line}: a criterion of task ${t.id} names ${e}, which neither the map, requirements.md's Planned nor a row of design.md's ## In the code has.`,
          });
    }
    const need = NEEDS.find(([has]) => has.some((h) => t.has.includes(h)));
    if (need && ![...t.own.map((k) => k.text), t.took?.text ?? ""].some(saysFailure))
      out.push({
        rule: "stories.no-error-case",
        task: t.id,
        blocking: false,
        message: `${at} ${need[1]}, but no criterion says what happens when that fails: add one (${need[2]}).`,
      });
  }
  const took = tasks.filter((t) => t.took);
  if (took.length)
    out.push({
      rule: "stories.spec-criteria",
      task: took[0]!.id,
      blocking: false,
      message: `Criteria from the spec deltas' scenarios, one task each in tasks.md's order: ${took.map((t) => `${t.id} "${t.took!.scenario}" (${t.took!.spec})`).join(", ")}.`,
    });
  return out;
}
