import { hasSecretShape, maskSecretShapes } from "@maycombhq/core";
import type { StageIssue } from "./loop.js";
import type { Estate } from "./estate.js";
import type { DeltaStep, FlowDelta } from "./schema.js";

/**
 * ADR 0207 part 4: a planned topic carries its schema and settings. Each publish step to a topic
 * this change adds may say what the topic is under `topic`; these are its checks, with no model,
 * run wherever the target flows are checked (the architecture stage, the fast path, and again on
 * file), and design.md's "Topics this change adds".
 */

type Topic = NonNullable<DeltaStep["topic"]>;
interface Publish {
  flow: string;
  repo: string;
  n: number;
  step: DeltaStep;
  entry: string;
  hub: string;
}

/** Each step that publishes to a topic this change adds. */
function publishes(deltas: FlowDelta[]): Publish[] {
  return deltas.flatMap((d) =>
    d.steps.flatMap((s, i) =>
      s.op !== "remove" && s.kind === "publish" && s.to?.new
        ? [
            {
              flow: d.flow,
              repo: d.repo,
              n: i + 1,
              step: s,
              entry: s.to.entry,
              hub: s.to.component,
            },
          ]
        : [],
    ),
  );
}

/** The flows this change adds that listen to the topic, each with the fields its entry reads. */
const listeners = (deltas: FlowDelta[], topic: string) =>
  deltas
    .filter(
      (d) => d.change === "new" && d.trigger?.kind === "listener" && d.trigger.entry === topic,
    )
    .map((d) => ({
      d,
      reads: d.steps.filter((s) => s.kind === "entry").flatMap((s) => s.fields?.reads ?? []),
    }));

/** Whether the map has the topic: a record of that id, or an Endpoint that names it. */
const mapHasTopic = (e: Pick<Estate, "records" | "byId">, topic: string) =>
  e.byId.has(topic) ||
  (e.records as unknown as { kind: string; pathOrTopic?: unknown }[]).some(
    (r) => r.kind === "Endpoint" && r.pathOrTopic === topic,
  );

const same = (a: Topic, b: Topic) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const sorted = (x: unknown): unknown =>
  x && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(
        Object.entries(x)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, sorted(v)]),
      )
    : x;

export function topicIssues(
  deltas: FlowDelta[],
  e: Pick<Estate, "records" | "byId">,
  o: { levels?: string[]; onFile?: boolean } = {},
): StageIssue[] {
  const out: StageIssue[] = [];
  const issue = (rule: string, target: string, message: string, repo: string, blocking = true) =>
    out.push({ rule, target, message, blocking, repo });
  const all = publishes(deltas);
  for (const topic of [...new Set(all.map((p) => p.entry))]) {
    const steps = all.filter((p) => p.entry === topic);
    const defs = steps.filter((p) => p.step.topic);
    const def = defs[0];
    if (!def?.step.topic || (!def.step.topic.fields && !def.step.topic.schemaFile)) {
      const p = def ?? steps[0]!;
      issue(
        "delta.topic-no-schema",
        `${p.flow}#${p.n}:${topic}`,
        `Change ${p.n} to ${p.flow} publishes to ${topic}, a topic this change adds, without saying what it carries: give the step topic: { format, fields: { <field>: <type> } } or a schemaFile, so its publisher and listeners build the same thing.`,
        p.repo,
        false,
      );
    }
    if (!def?.step.topic) continue;
    const t = def.step.topic;
    for (const p of defs.slice(1))
      if (!same(t, p.step.topic!))
        issue(
          "delta.topic-twice",
          `${p.flow}#${p.n}:${topic}`,
          `Change ${p.n} to ${p.flow} defines topic ${topic} differently from change ${def.n} to ${def.flow}: define it once, on one step, and leave topic off the others.`,
          p.repo,
        );
    if (!o.onFile && mapHasTopic(e, topic))
      issue(
        "delta.topic-exists",
        `${def.flow}#${def.n}:${topic}`,
        `Change ${def.n} to ${def.flow}: the map has ${topic}: take topic off, and new: true with it; its fields are the map's.`,
        def.repo,
      );
    const known = Object.keys(t.fields ?? {});
    if (t.fields) {
      for (const p of steps)
        for (const f of (p.step.fields?.sends ?? []).filter((x) => !known.includes(x)))
          issue(
            "delta.topic-fields",
            `${p.flow}#${p.n}:${topic}:${f}`,
            `Change ${p.n} to ${p.flow} sends ${f} on ${topic}, which the topic's fields (${known.join(", ")}) don't have: add it to topic.fields with its type, or leave it out of sends.`,
            p.repo,
          );
      for (const { d, reads } of listeners(deltas, topic))
        for (const f of reads.filter((x) => !known.includes(x)))
          issue(
            "delta.topic-fields",
            `${d.flow}:${topic}:${f}`,
            `${d.flow} listens to ${topic} and reads ${f}, which the topic's fields (${known.join(", ")}) don't have: add it to topic.fields, or read only what the topic carries.`,
            d.repo,
          );
    }
    for (const [f, level] of Object.entries(t.classification ?? {}))
      if (o.levels?.length && !o.levels.includes(level))
        issue(
          "delta.topic-classification",
          `${def.flow}#${def.n}:${topic}:${f}`,
          `Change ${def.n} to ${def.flow} classifies ${topic}'s field ${f} as ${level}, which isn't one of the org pack's levels: ${o.levels.join(", ")}. Write one of those words exactly.`,
          def.repo,
        );
    for (const [k, v] of Object.entries(t.settings ?? {}))
      if (hasSecretShape(String(v)))
        issue(
          "delta.topic-secret",
          `${def.flow}#${def.n}:${topic}:${k}`,
          `Change ${def.n} to ${def.flow}: ${topic}'s setting ${k} holds what looks like a secret. Name where the value is kept (a secret's key), never the value.`,
          def.repo,
        );
  }
  return out;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/**
 * design.md's "Topics this change adds": each topic a publish step adds, with its publisher, its
 * format, key, fields and settings as the step says them, and the flows of this change that
 * listen to it, each with its standing (its repo read into the map, not read, or planned).
 */
export function renderTopics(
  deltas: FlowDelta[],
  e: Pick<Estate, "records" | "manifestRepos">,
): string[] {
  const all = publishes(deltas);
  if (!all.length) return [];
  const read = new Set(
    (e.records as unknown as { kind: string; repo?: unknown }[]).flatMap((r) =>
      r.kind === "Component" && typeof r.repo === "string" ? [r.repo] : [],
    ),
  );
  const standing = (repo: string) =>
    read.has(repo) ? "read" : e.manifestRepos.has(repo) ? "not read" : "planned";
  const lines = [
    "## Topics this change adds",
    "",
    "| Topic | Publisher | Format | Key | Fields | Settings | Listeners |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const topic of [...new Set(all.map((p) => p.entry))]) {
    const p =
      all.find((x) => x.entry === topic && x.step.topic) ?? all.find((x) => x.entry === topic)!;
    const t = p.step.topic;
    const fields = Object.entries(t?.fields ?? {}).map(
      ([f, type]) => `${f}: ${type}${t?.classification?.[f] ? ` (${t.classification[f]})` : ""}`,
    );
    const settings = Object.entries(t?.settings ?? {}).map(
      ([k, v]) => `${k}: ${maskSecretShapes(String(v))}`,
    );
    const heard = listeners(deltas, topic).map(
      ({ d }) => `${d.flow} (${d.repo}, ${standing(d.repo)})`,
    );
    const row = [
      topic,
      `${p.flow} (${p.repo}), on ${p.hub}`,
      t ? `${t.format}${t.schemaFile ? `, in ${t.schemaFile}` : ""}` : "not given",
      t?.key ?? "-",
      fields.join(", ") || "not given",
      settings.join(", ") || "-",
      heard.join(", ") || "none in this change",
    ];
    lines.push(`| ${row.map(cell).join(" | ")} |`);
  }
  return lines;
}
