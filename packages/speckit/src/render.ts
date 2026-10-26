import { stringify } from "yaml";
import { changesRelOf, taskBranch, type RecordOf } from "@maycombhq/core";
import { docOf, sectionMatching } from "@maycombhq/naysayer";
import {
  mappingSections,
  readStory,
  readTaskKnowledge,
  viaOf,
  type TaskContext,
} from "./change.js";

/**
 * What hand-down writes, as pure functions of the task's context: spec.md from the stories
 * and their acceptance criteria, a seeded plan.md, data-model.md and contracts/ from the
 * design, interfaces, mappings and data that concern the repo, and a requirements checklist
 * from the org pack's definition of ready. The structured parts follow the shapes the speckit
 * extractor reads back, so the scan sees exactly what was handed down.
 */

const NC = "NEEDS CLARIFICATION";
const date = (t: TaskContext) => t.change.createdAt.slice(0, 10);

const GWT = /^given\s+(.+?),\s*when\s+(.+?),\s*then\s+(.+)$/i;

export function renderSpec(t: TaskContext): string {
  const stories = t.task.stories.map((s) => readStory(t.files, s)).filter((s) => !!s);
  const out = [
    `# Feature Specification: ${t.task.title}`,
    "",
    `**Feature Branch**: \`${taskBranch(t.change.id, t.task.id)}\``,
    `**Created**: ${date(t)}`,
    "**Status**: Draft",
    `**Input**: Task ${t.task.id} of change ${t.change.id} (${t.change.title})`,
    "",
    `<!-- Handed down by Atticus from ${changesRelOf(t.root)}/${t.change.id}: ${stories.length ? stories.map((s) => s.path).join(", ") : "tasks.md"}. Refine it with /speckit.specify and /speckit.clarify. A question that needs the change's design goes back up, never into this repo alone. -->`,
    "",
    "## User Scenarios & Testing *(mandatory)*",
    "",
  ];
  const frs: string[] = [];
  stories.forEach((s, i) => {
    out.push(`### User Story ${i + 1} - ${s.title} (Priority: P${i + 1})`, "");
    if (s.text.length) out.push(...s.text, "");
    out.push("**Acceptance Scenarios**:", "");
    if (s.criteria.length === 0) out.push(`1. [${NC}: the story has no acceptance criteria]`);
    s.criteria.forEach((c, j) => {
      const m = GWT.exec(c);
      out.push(`${j + 1}. ${m ? `**Given** ${m[1]}, **When** ${m[2]}, **Then** ${m[3]}` : c}`);
      frs.push(`System MUST meet acceptance scenario ${j + 1} of User Story ${i + 1}.`);
    });
    out.push("");
  });
  if (stories.length === 0)
    out.push(
      `### User Story 1 - ${t.task.title} (Priority: P1)`,
      "",
      `[${NC}: the task names no story]`,
      "",
    );
  out.push(
    "### Edge Cases",
    "",
    `- [${NC}: cases the story's acceptance criteria don't cover]`,
    "",
    "## Requirements *(mandatory)*",
    "",
    "### Functional Requirements",
    "",
    ...(frs.length
      ? frs.map((f, i) => `- **FR-${String(i + 1).padStart(3, "0")}**: ${f}`)
      : [`- **FR-001**: [${NC}: no acceptance criteria to trace]`]),
    "",
    "## Success Criteria *(mandatory)*",
    "",
    "### Measurable Outcomes",
    "",
    "- **SC-001**: Every acceptance scenario above passes as an automated test.",
    "",
  );
  return out.join("\n");
}

const isHttp = (h: { method?: string }) =>
  !!h.method && ["GET", "PUT", "POST", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(h.method);
const topicOf = (operation: string) =>
  /^(publish|subscribe|send|receive)\s+(\S+)/i.exec(operation.trim());

export function repoHops(t: TaskContext) {
  return {
    calls: t.hops.filter((h) => h.caller === t.component),
    serves: t.hops.filter((h) => h.callee === t.component && isHttp(h)),
  };
}

/** Data rows of the change for stores this repo's component owns. */
export function repoData(t: TaskContext) {
  const owned = new Set(
    t.ctx.records
      .filter(
        (r) =>
          r.kind === "DataStore" && (r as RecordOf<"DataStore">).ownerComponent === t.component,
      )
      .map((r) => r.id),
  );
  const tableOwner = (id: string) =>
    (t.ctx.records.find((r) => r.kind === "Table" && r.id === id) as RecordOf<"Table"> | undefined)
      ?.ownerComponent;
  return t.data.filter((d) => owned.has(d.store) || tableOwner(d.tableId) === t.component);
}

export function contractFile(t: TaskContext): string {
  return `contracts/${t.component}.yaml`;
}

export function renderPlan(t: TaskContext): string {
  const { calls, serves } = repoHops(t);
  const data = repoData(t);
  const stores = [...new Set(data.map((d) => d.store))];
  const owned = t.ctx.records.filter(
    (r) => r.kind === "DataStore" && (r as RecordOf<"DataStore">).ownerComponent === t.component,
  ) as RecordOf<"DataStore">[];
  const storage = [...new Set([...owned.map((s) => s.id), ...stores])].sort().map((id) => {
    const s = owned.find((x) => x.id === id);
    return s?.storeType ? `${id} (${s.storeType})` : id;
  });
  const platforms = [
    ...new Set(
      t.ctx.records
        .filter(
          (r) => r.kind === "Deployment" && (r as RecordOf<"Deployment">).component === t.component,
        )
        .map((r) => (r as RecordOf<"Deployment">).platform),
    ),
  ].sort();
  const design = docOf(t.files, "design.md");
  const approach = sectionMatching(design, /^approach$/i);
  const summary =
    design && approach
      ? design.rawLines.slice(approach.line, approach.end).join("\n").trim()
      : `[${NC}: the change's design.md has no Approach section]`;
  const status = (s: string) => (/^planned-(new|modify|retire)$/.test(s) ? s : "planned-new");
  const mapping = mappingSections(docOf(t.files, "mappings.md")).filter((m) =>
    [...calls, ...serves].some((h) => h.method === m.method && h.path === m.path),
  );
  const feature = `specs/${t.task.id}`;
  const out = [
    `# Implementation Plan: ${t.task.title}`,
    "",
    `**Branch**: \`${taskBranch(t.change.id, t.task.id)}\` | **Date**: ${date(t)} | **Spec**: [spec.md](./spec.md)`,
    `**Input**: Feature specification from \`${feature}/spec.md\``,
    "",
    `<!-- Seeded by Atticus from the approved design of change ${t.change.id} for ${t.repo.id} (component ${t.component}). The services table, data-model.md and contracts/ are the design: Atticus reads them on every scan and reports drift, so amend the design through the change instead of here. -->`,
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Technical Context",
    "",
    `**Language/Version**: ${NC}`,
    `**Primary Dependencies**: ${NC}`,
    `**Storage**: ${storage.length ? storage.join(", ") : "N/A"}`,
    `**Testing**: ${NC}`,
    `**Target Platform**: ${platforms.length ? platforms.join(", ") : NC}`,
    "**Project Type**: single",
    `**Performance Goals**: ${NC}`,
    `**Constraints**: ${NC}`,
    "",
    "### Services this feature calls",
    "",
    "| Service | Operation | Via | Pattern | Status |",
    "| --- | --- | --- | --- | --- |",
    ...calls.map((h) => {
      const via = viaOf(t.patterns, h.pattern) ?? (topicOf(h.operation) ? "event-bus" : "other");
      return `| ${h.callee} | ${h.operation.trim()} | ${via} | ${h.pattern} | ${status(h.status)} |`;
    }),
    "",
  ];
  if (serves.length)
    out.push(
      "### Operations this feature serves",
      "",
      "| Operation | Caller | Pattern | Status | Contract |",
      "| --- | --- | --- | --- | --- |",
      ...serves.map(
        (h) =>
          `| ${h.method} ${h.path} | ${h.caller} | ${h.pattern} | ${status(h.status)} | ${contractFile(t)} |`,
      ),
      "",
    );
  if (mapping.length)
    out.push(
      "### Field mappings",
      "",
      ...mapping.flatMap((m) => [`#### ${m.method} ${m.path}`, "", ...m.lines, ""]),
    );
  // B-task-knowledge: the organisation's pages that apply to this task, as its story lists them.
  const knowledge = readTaskKnowledge(t.files, t.task.stories, t.task.id);
  if (knowledge.length)
    out.push(
      "### Knowledge that applies",
      "",
      `<!-- From the task's story in change ${t.change.id}: the organisation's pages (wikis and documents) that apply to this task, quoted as data. Where pages disagree, a person or the code decides; ask rather than pick. -->`,
      "",
      ...knowledge,
      "",
    );
  out.push(
    "## Constitution Check",
    "",
    `[${NC}: check each principle of \`.specify/memory/constitution.md\`, generated from the org pack]`,
    "",
    "## Project Structure",
    "",
    "### Documentation (this feature)",
    "",
    "```text",
    `${feature}/`,
    "├── plan.md",
    ...(data.length ? ["├── data-model.md"] : []),
    ...(serves.length || calls.some((h) => topicOf(h.operation)) ? ["├── contracts/"] : []),
    "└── tasks.md",
    "```",
    "",
    "### Source Code (repository root)",
    "",
    "```text",
    `[${NC}: the files this feature adds or changes]`,
    "```",
    "",
    "## Open questions",
    "",
    "- None yet. Anything that needs the change's design goes here; it goes back up as an owner question.",
    "",
  );
  return out.join("\n");
}

export function renderDataModel(t: TaskContext): string | undefined {
  const data = repoData(t);
  if (data.length === 0) return undefined;
  const stores = [...new Set(data.map((d) => d.store))].sort();
  const tables = new Map<string, { name: string; store: string; isNew: boolean; rows: string[] }>();
  for (const d of data) {
    const name = d.table.includes(".") ? d.table.split(".").pop()! : d.table;
    const e = tables.get(d.tableId) ?? { name, store: d.store, isNew: false, rows: [] };
    e.isNew ||= d.newTable;
    for (const c of d.newColumns) {
      let type = c.type;
      const notNull = /\bnot null\b/i.test(type) || (!d.newTable && /\bnot null\b/i.test(d.change));
      type = type
        .replace(/\s*\bnot null\b.*$/i, "")
        .replace(/\s*\bdefault\b.*$/i, "")
        .trim();
      const notes = d.newTable ? "" : `${d.change.trim()}${d.migration ? ` (${d.migration})` : ""}`;
      e.rows.push(`| ${c.name} | ${type} | ${notNull ? "no" : ""} | ${notes} |`);
    }
    tables.set(d.tableId, e);
  }
  const out = [
    `# Data Model: ${t.task.title}`,
    "",
    ...(stores.length === 1 ? [`**Data store**: ${stores[0]}`, ""] : []),
    `<!-- Seeded by Atticus from data.md of change ${t.change.id}. Keep the headings and tables in this shape: Atticus reads them on every scan. -->`,
    "",
    "## Entities",
    "",
  ];
  for (const e of tables.values()) {
    out.push(`### ${e.name} (${e.isNew ? "new" : "existing"} table)`, "");
    if (stores.length > 1) out.push(`**Store**: ${e.store}`, "");
    out.push("| Column | Type | Nullable | Notes |", "| --- | --- | --- | --- |", ...e.rows, "");
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

export function renderOpenApi(t: TaskContext): string | undefined {
  const { serves } = repoHops(t);
  if (serves.length === 0) return undefined;
  const paths: Record<string, Record<string, unknown>> = {};
  for (const h of serves) {
    const params = [...h.path!.matchAll(/\{([^}]+)\}/g)].map((m) => ({
      name: m[1]!,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    const op = {
      operationId: `${h.method!.toLowerCase()}-${h
        .path!.replace(/[{}]/g, "")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase()}`,
      summary: `Called by ${h.caller}${h.pattern ? ` (${h.pattern})` : ""}`,
      "x-atticus-status": /^planned-(new|modify|retire)$/.test(h.status) ? h.status : "planned-new",
      ...(h.pattern ? { "x-atticus-pattern": h.pattern } : {}),
      ...(params.length ? { parameters: params } : {}),
      responses: { default: { description: "See the change's mappings.md" } },
    };
    (paths[h.path!] ??= {})[h.method!.toLowerCase()] = op;
  }
  return stringify(
    {
      openapi: "3.0.3",
      info: {
        title: `${t.component}, as planned by change ${t.change.id}`,
        version: "0.0.0",
        description:
          "Seeded by Atticus from interfaces.md. Fill in schemas while planning; keep the paths and methods, or amend the design.",
      },
      paths,
    },
    { lineWidth: 0 },
  );
}

export function renderAsyncApi(t: TaskContext): string | undefined {
  const topics = repoHops(t)
    .calls.map((h) => ({ h, m: topicOf(h.operation) }))
    .filter((x) => !!x.m);
  if (topics.length === 0) return undefined;
  const channels: Record<string, unknown> = {};
  const operations: Record<string, unknown> = {};
  for (const { h, m } of topics) {
    const key = m![2]!.replace(/[^A-Za-z0-9]+/g, "-");
    channels[key] = { address: m![2]! };
    const send = /^(publish|send)$/i.test(m![1]!);
    operations[`${send ? "send" : "receive"}-${key}`] = {
      action: send ? "send" : "receive",
      channel: { $ref: `#/channels/${key}` },
      summary: `${send ? "Published for" : "Read from"} ${h.callee}${h.pattern ? ` (${h.pattern})` : ""}`,
    };
  }
  return stringify(
    {
      asyncapi: "3.0.0",
      info: {
        title: `${t.component} events, as planned by change ${t.change.id}`,
        version: "0.0.0",
      },
      channels,
      operations,
    },
    { lineWidth: 0 },
  );
}

export function renderChecklist(t: TaskContext): string {
  const dor = t.ctx.orgPack.testStrategy.definitionOfReady;
  return [
    `# Specification Quality Checklist: ${t.task.title}`,
    "",
    "**Purpose**: Check spec.md is ready before planning, against the org pack's definition of ready",
    "**Feature**: [spec.md](../spec.md)",
    "",
    "## Definition of ready",
    "",
    ...(dor.length
      ? dor.map((d, i) => `- [ ] CHK${String(i + 1).padStart(3, "0")} ${d}`)
      : ["- [ ] CHK001 Every acceptance criterion is testable"]),
    "",
  ].join("\n");
}

/**
 * A seeded tasks.md in Spec Kit's shape, so the task prompt, three-way drift and the hand-up
 * review have the repo's task list from the start: one implementation task, then a test task
 * per acceptance criterion. /speckit.tasks refines it; hand-down never overwrites an edited one.
 */
export function renderTasks(t: TaskContext): string {
  const stories = t.task.stories.map((s) => readStory(t.files, s)).filter((s) => !!s);
  const lines = [
    `# Tasks: ${t.task.title}`,
    "",
    `**Input**: spec.md and plan.md in this folder (task ${t.task.id} of change ${t.change.id})`,
    "",
    "<!-- Seeded by Atticus at hand-down. Refine it with /speckit.tasks; tick each box as you finish it. -->",
    "",
    "## Implementation",
    "",
    `- [ ] T001 ${t.task.title}`,
    "",
    "## Tests",
    "",
  ];
  let n = 2;
  for (const s of stories)
    for (const c of s.criteria)
      lines.push(
        `- [ ] T${String(n++).padStart(3, "0")} [${s.id}] Test: ${c.replace(/\s+/g, " ").trim()}`,
      );
  if (n === 2)
    lines.push(`- [ ] T002 Test the behaviour spec.md describes [${NC}: no acceptance criteria]`);
  lines.push("");
  return lines.join("\n");
}

/** The plain task file for repos on the Atticus build engine. */
export function renderAtticusTask(t: TaskContext): string {
  const spec = renderSpec(t).split("\n");
  const plan = renderPlan(t).split("\n");
  const from = (lines: string[], heading: string) => {
    const i = lines.indexOf(heading);
    if (i < 0) return [];
    const end = lines.findIndex((l, j) => j > i && /^## /.test(l));
    return lines.slice(i + 1, end < 0 ? undefined : end);
  };
  return [
    `# Task ${t.task.id}: ${t.task.title}`,
    "",
    `Change ${t.change.id} (${t.change.title}), branch \`${taskBranch(t.change.id, t.task.id)}\`. Handed down by Atticus; amend the design through the change, not here.`,
    "",
    "## Stories and acceptance criteria",
    ...from(spec, "## User Scenarios & Testing *(mandatory)*"),
    "## Design for this repo",
    ...from(plan, "## Summary"),
    ...from(plan, "## Technical Context"),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n*$/, "\n");
}
