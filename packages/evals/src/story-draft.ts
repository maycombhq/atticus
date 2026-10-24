import {
  DEFAULT_DONE,
  storyColumns,
  type DeltaStory,
  type DeltaTask,
  type RequestTask,
  type StoriesAnswer,
  type StoryCriterion,
  type StoryWords,
} from "@maycombhq/planner";
import type { BenchStory } from "./story-bench.js";

/**
 * A change's drafted stories, in the stories stage's own format, as one `BenchStory` draft
 * (B-stories-bench), so `atticus bench stories --change` scores what Atticus writes against the
 * reference story a person wrote. A conversion, not a rewrite: every line comes from the story
 * writer's answer or from what the stage works out from the target flows and the map (the
 * entry, today's flow, the tasks and their evidence, the columns a step adds), the way the story
 * files render it.
 *
 * - A bench story is one capability across repos; a change has a story per repo and flow. All of
 *   the change's stories go into the one draft, in their order; the statement is the first's.
 * - Each task is a changed step: its repo, what it does, the story's entry, and today's code from
 *   its evidence (an added step goes in after the step it follows, so the last line it cites;
 *   any other step, the first).
 * - Each criterion splits into given, when and then; its checks are its fields; its entry, when
 *   it names none, is the story's. An error criterion is an error case on each field it checks
 *   (or on none when it checks none), its `when` the criterion's given clause.
 * - The interface field's validation has no place in the bench format and is left out.
 * - A column with no nullable said is written nullable, and the notes say so.
 */

export interface StoriesToBench {
  /** The reference story the draft answers (bench/stories/<story>.yaml). */
  story: string;
  /** The change the stories are of, for the notes. */
  change: string;
  title: string;
  stories: DeltaStory[];
  answer: StoriesAnswer;
  /** The definition of done the story files carry; default Atticus's own items. */
  done?: string[];
  /** The requests the change's stories wait for, as the definition of done names them. */
  requests?: Pick<RequestTask, "id" | "title" | "flow">[];
}

const NOT_SAID = "not said";
const bare = (s: string) => s.trim().replace(/[.\s]+$/, "");

/** "Given x, when y, then z" in its parts; a criterion written otherwise is all then. */
export function splitCriterion(text: string): { given: string; when: string; then: string } {
  const m = /^\s*given\s+([\s\S]+?),?\s+when\s+([\s\S]+?),?\s+then\s+([\s\S]+?)\s*$/i.exec(text);
  if (!m) return { given: NOT_SAID, when: NOT_SAID, then: bare(text) };
  return { given: bare(m[1]!), when: bare(m[2]!), then: bare(m[3]!) };
}

/** A task's step id: task 1.2 is t1-2. */
const stepId = (t: DeltaTask) => `t${t.id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/** Today's code a task changes, as path:line: the evidence without its repo. */
function stepAt(t: DeltaTask): string | undefined {
  const cited = t.evidence
    .map((e) => (e.startsWith(`${t.repo}:`) ? e.slice(t.repo.length + 1) : e))
    .filter((e) => /^[^\s:]+:\d+$/.test(e));
  return t.op === "add" ? cited.at(-1) : cited[0];
}

/** "a, b and c". */
const andList = (xs: string[]) =>
  xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? "");

/** The story's Context as its file has it: the writer's words, today's flow, its errors, the flow after. */
function contextOf(s: DeltaStory, w: StoryWords | undefined): string {
  const blocks: string[] = [];
  if (w?.context) blocks.push(w.context.trim());
  const started = s.entry ? `, started by ${s.entry}` : "";
  if (s.before?.length)
    blocks.push([`Today, flow ${s.flow} (${s.name})${started}:`, ...s.before].join("\n"));
  if (s.errors?.length)
    blocks.push(["Its error paths today:", ...s.errors.map((e) => `- ${e}`)].join("\n"));
  if (s.after?.length)
    blocks.push(
      [
        s.change === "new"
          ? `The new flow ${s.flow} (${s.name})${started}:`
          : s.change === "remove"
            ? `Once the change is in, flow ${s.flow} is removed:`
            : "Once the change is in:",
        ...s.after,
      ].join("\n"),
    );
  return blocks.join("\n\n");
}

function criteriaOf(s: DeltaStory, t: DeltaTask, cs: StoryCriterion[]): BenchStory["criteria"] {
  const step = stepId(t);
  const at = stepAt(t);
  return cs.map((c, i) => {
    const parts = splitCriterion(c.text);
    const entry = c.entry ?? s.entry;
    const error = (field?: string) => ({
      ...(field ? { field } : {}),
      rule: c.rule ?? "other",
      ...(c.status !== undefined ? { status: c.status } : {}),
      when: parts.given === NOT_SAID ? parts.when : parts.given,
      then: parts.then,
      ...(at ? { at } : {}),
    });
    return {
      id: `${step}-c${i + 1}`,
      step,
      ...parts,
      ...(entry ? { entry } : {}),
      fields: [...c.checks],
      ...(c.validation ? { validation: c.validation } : {}),
      errors:
        c.outcome === "error" ? (c.checks.length ? c.checks.map((f) => error(f)) : [error()]) : [],
      ...(at ? { at } : {}),
    };
  });
}

export function benchStoryFromStories(i: StoriesToBench): BenchStory {
  const pairs = i.stories.map((s) => ({ s, w: i.answer.stories.find((x) => x.id === s.id) }));
  const many = pairs.length > 1;
  const notes: string[] = [];
  const first = pairs.find((p) => p.w)?.w;

  const context = pairs
    .map(({ s, w }) => {
      const c = contextOf(s, w);
      return many ? `Story ${s.id} (${s.repo}):\n${c}`.trim() : c;
    })
    .filter(Boolean)
    .join("\n\n");

  const scopeIn = pairs.flatMap(({ s, w }) => [
    ...s.tasks.map((t) => `Task ${t.id}: ${bare(t.title)}`),
    ...(w?.scope?.in ?? []).map(bare),
  ]);
  const scopeOut = pairs.flatMap(({ s, w }) => {
    const kept = s.change === "modify" && s.kept?.length ? s.kept : [];
    return [
      ...(kept.length
        ? [
            `Step${kept.length === 1 ? "" : "s"} ${andList(kept.map(String))} of flow ${s.flow} ${kept.length === 1 ? "stays as it is" : "stay as they are"}`,
          ]
        : []),
      ...(w?.scope?.out ?? []).map(bare),
    ];
  });

  const steps = pairs.flatMap(({ s }) =>
    s.tasks.map((t) => {
      const at = stepAt(t);
      return {
        id: stepId(t),
        repo: t.repo,
        what: bare(t.what || t.title),
        ...(s.entry ? { entry: s.entry } : {}),
        ...(at ? { at } : {}),
      };
    }),
  );
  const criteria = pairs.flatMap(({ s, w }) =>
    s.tasks.flatMap((t) => criteriaOf(s, t, w?.tasks.find((x) => x.id === t.id)?.criteria ?? [])),
  );

  // ---- interfaces and data: the lists, else none when every story that wrote one says none
  const listedInterfaces = pairs.flatMap(({ s, w }) =>
    Array.isArray(w?.interfaces)
      ? w.interfaces.map((x) => ({
          repo: s.repo,
          entry: x.entry,
          change: x.change,
          breaking: x.breaking,
          ...(x.why ? { why: x.why } : {}),
          fields: x.fields.map((f) => ({
            name: f.name,
            side: f.side,
            type: f.type,
            required: f.required,
            ...(f.default ? { default: f.default } : {}),
            change: f.change,
          })),
        }))
      : [],
  );
  const noneOf = (k: "interfaces" | "data") => {
    const why = pairs.flatMap(({ w }) => {
      const v = w?.[k];
      return v && !Array.isArray(v) ? [v.none] : [];
    });
    return why.length ? { none: why.join("; ") } : undefined;
  };
  const interfaces = listedInterfaces.length ? listedInterfaces : noneOf("interfaces");

  const rows = pairs.flatMap(({ s, w }) =>
    w
      ? storyColumns(s, w).map((r) => {
          if (r.nullable === undefined)
            notes.push(`the nullable of ${r.table}.${r.column} is not said; written nullable`);
          return {
            repo: s.repo,
            table: r.table,
            column: r.column,
            type: r.type ?? NOT_SAID,
            nullable: r.nullable ?? true,
            ...(r.default ? { default: r.default } : {}),
            change: r.change,
            migration: r.migration ?? NOT_SAID,
            classification: r.classification ?? NOT_SAID,
            retention: r.retention ?? NOT_SAID,
          };
        })
      : [],
  );
  const data = rows.length ? rows : noneOf("data");

  // ---- non-functional: each story's words, by repo once there are two
  const nf = (k: "auth" | "audit" | "timeouts" | "performance") => {
    const said = pairs.flatMap(({ s, w }) => {
      const v = w?.nonFunctional?.[k];
      return v ? [many ? `${s.repo}: ${v.trim()}` : v.trim()] : [];
    });
    return said.length ? said.join(" ") : undefined;
  };
  const nonFunctional = Object.fromEntries(
    (["auth", "audit", "timeouts", "performance"] as const).flatMap((k) => {
      const v = nf(k);
      return v ? [[k, v]] : [];
    }),
  );

  const tests = pairs.flatMap(({ s, w }) => [
    ...(w?.tests ?? []).map(bare),
    ...s.tasks.flatMap((t) =>
      (w?.tasks.find((x) => x.id === t.id)?.tests ?? []).map((x) => `Task ${t.id}: ${bare(x)}`),
    ),
  ]);

  // ---- dependencies: what lands first; none when a story says so and nothing does
  const deps = pairs.flatMap(({ s, w }) => {
    const story = (id: string) => {
      const o = i.stories.find((x) => x.id === id);
      return `Story ${id}${o ? ` (${o.repo})` : ""} lands before ${s.id} (${s.repo})`;
    };
    return [
      ...(w?.dependencies?.notes ?? []).map(bare),
      ...[...new Set([...(s.dependsOn ?? []), ...(w?.dependencies?.stories ?? [])])].map(story),
      ...(w?.dependencies?.repos ?? []).map((r) => `The ${r} repo's change lands before ${s.id}`),
    ];
  });
  const saidDeps = pairs.some(({ w }) => w?.dependencies !== undefined);
  const dependencies = deps.length ? deps : saidDeps ? ["none"] : undefined;

  const flows = new Set(i.stories.map((s) => s.flow));
  const waits = (i.requests ?? []).filter((r) => flows.has(r.flow));
  const definitionOfDone = [
    ...(i.done ?? DEFAULT_DONE),
    ...(waits.length
      ? [`A person has raised ${andList(waits.map((r) => `${r.id} ${r.title}`))} (requests.md)`]
      : []),
  ].map(bare);

  return {
    schemaVersion: 1,
    story: i.story,
    title: i.title,
    repos: [...new Set(i.stories.map((s) => s.repo))],
    ...(first ? { statement: { asA: first.asA, iWant: first.iWant, soThat: first.soThat } } : {}),
    ...(context ? { context } : {}),
    scope: { in: scopeIn, out: scopeOut },
    steps,
    criteria,
    ...(interfaces ? { interfaces } : {}),
    ...(data ? { data } : {}),
    ...(Object.keys(nonFunctional).length ? { nonFunctional } : {}),
    ...(tests.length ? { tests } : {}),
    ...(dependencies ? { dependencies } : {}),
    definitionOfDone,
    notes: [
      `Converted from the stories stage of change ${i.change} (${i.stories.length === 1 ? "story" : "stories"} ${i.stories.map((s) => s.id).join(", ")})`,
      ...notes,
      "interface field validations are not part of the bench format.",
    ].join("; "),
  };
}
