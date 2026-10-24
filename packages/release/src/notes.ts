import { tableWith, docOf } from "@maycombhq/naysayer";
import type { ReleaseContext } from "./context.js";
import { BREAKING_SPEC, type Judged } from "@maycombhq/ai";
import { breakingItem, judgedFor } from "./judged.js";
import { buildModel, opOf, sectionOf, sentences } from "./model.js";

/**
 * Release notes, from the brief and proposal (what changes, for whom), interfaces.md (API
 * changes, breaking or not), data.md (data changes) and waived findings (known limitations).
 * Every line is the change folder's words; whether an API change breaks callers is a judgment
 * (ADR 0117 addendum), settled by the catalog's change kind, a judgment on file or the judge,
 * else shown as "check" for a person. Two audiences: business (why, what, who, what is
 * left out) and technical (adds API and data changes).
 */

export type Audience = "business" | "technical";
export const AUDIENCES: readonly Audience[] = ["business", "technical"];

export interface ApiChange {
  operation: string;
  caller: string;
  callee: string;
  change: string;
  breaking: "yes" | "no" | "check";
  why: string;
  /**
   * Who settled it: the catalog's change kind (new, retired), a model's or a person's judgment
   * on file, or no one yet ("check" for a person).
   */
  judgedBy: "catalog" | "model" | "person" | "not judged";
  source: string;
}

export interface DataChangeNote {
  table: string;
  change: string;
  migration?: string;
  source: string;
}

export interface Limitation {
  summary: string;
  reason?: string;
  by?: string;
  at?: string;
  source: string;
}

export interface NotesSection {
  heading: string;
  items: string[];
  source?: string;
  /** Said when the section has nothing to show. */
  empty?: string;
}

export interface ReleaseNotes {
  change: string;
  title: string;
  audience: Audience;
  today: string;
  sections: NotesSection[];
  api: ApiChange[];
  data: DataChangeNote[];
  limitations: Limitation[];
  markdown: string;
}

const lines = (text: string | undefined) =>
  (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const bullets = (text: string | undefined) =>
  lines(text).map((l) => l.replace(/^([-*+]|\d+\.)\s+/, ""));

/** Why an API change breaks callers or not, from its judgment (ADR 0117 addendum). */
function breakingOf(
  change: string,
  said: string,
  j: Judged | undefined,
): { breaking: ApiChange["breaking"]; why: string; judgedBy: ApiChange["judgedBy"] } {
  if (j?.by === "veto")
    return change === "planned-retire"
      ? { breaking: "yes", why: "The operation is retired.", judgedBy: "catalog" }
      : {
          breaking: "no",
          why: "A new operation in this change, so no existing caller breaks.",
          judgedBy: "catalog",
        };
  if (!said)
    return {
      breaking: "check",
      why: "interfaces.md doesn't say what changes for callers.",
      judgedBy: "not judged",
    };
  const by: ApiChange["judgedBy"] = !j
    ? "not judged"
    : j.judgment?.confirmedBy.by === "person"
      ? "person"
      : "model";
  if (j?.verdict === "yes") return { breaking: "yes", why: said, judgedBy: by };
  if (j?.verdict === "no") return { breaking: "no", why: said, judgedBy: by };
  return {
    breaking: "check",
    why: j
      ? `A judge couldn't tell whether callers must change, so a person checks: ${said}`
      : `Not judged: no model was asked whether callers must change, so a person checks: ${said}`,
    judgedBy: by,
  };
}

export async function releaseNotes(
  ctx: ReleaseContext,
  audience: Audience = "business",
): Promise<ReleaseNotes> {
  const m = buildModel(ctx);
  const problem = sectionOf(ctx, "brief.md", /^problem|^why/i);
  const outcome = sectionOf(ctx, "brief.md", /^outcome/i);
  const scope = sectionOf(ctx, "brief.md", /^scope/i);
  const questions = sectionOf(ctx, "brief.md", /open questions/i);
  const whyP = sectionOf(ctx, "proposal.md", /^why/i);
  const what = sectionOf(ctx, "proposal.md", /what changes/i);
  const impact = sectionOf(ctx, "proposal.md", /^impact/i);

  // who it affects: the proposal's systems table, else change.yaml systems
  const systemsTable = tableWith(docOf(ctx.files, "proposal.md"), ["why"]);
  const who: string[] = [];
  let whoSource: string | undefined;
  if (systemsTable) {
    whoSource = `proposal.md:${systemsTable.line}`;
    for (const r of systemsTable.rows) {
      const idCell = Object.entries(r.cells).find(([k]) => /system/.test(k))?.[1] ?? "";
      const id = idCell.split(/\s+/)[0] ?? "";
      if (!id) continue;
      const how = Object.entries(r.cells).find(([k]) => /new|modified|retired/.test(k))?.[1] ?? "";
      who.push(`${m.systemName(id)}${how ? ` (${how})` : ""}: ${r.cells.why || "no reason given"}`);
    }
  } else
    for (const s of ctx.change.systems) {
      who.push(m.systemName(s));
      whoSource = "change.yaml";
    }

  const outOfScope = scope
    ? sentences(scope.lines)
        .map((s) => /out of scope:?\s*(.*)$/i.exec(s.text)?.[1]?.trim())
        .filter((x): x is string => !!x)
        .map((x) => x[0]!.toUpperCase() + x.slice(1).replace(/\.$/, ""))
    : [];

  const planned = m.hops.filter((h) => /^planned-/.test(h.change));
  const saidOf = (h: (typeof planned)[number]) =>
    h.notes.map((n) => n.text.replace(/^\s*[-*]\s+/, "").trim()).join(" ");
  const itemOf = (h: (typeof planned)[number]) =>
    breakingItem(
      { change: h.change, operation: opOf(h), caller: h.caller, callee: h.callee },
      saidOf(h),
    );
  // Only what has words to read, or a change kind that settles it, goes to the judge.
  const judged = await judgedFor(
    ctx,
    BREAKING_SPEC,
    planned
      .filter((h) => saidOf(h) || h.change === "planned-new" || h.change === "planned-retire")
      .map(itemOf),
  );
  const api: ApiChange[] = planned.map((h) => {
    const b = breakingOf(h.change, saidOf(h), judged(itemOf(h)));
    return {
      operation: opOf(h),
      caller: h.caller,
      callee:
        h.calleeBoundary === "vendor" && h.calleeSystem
          ? `${h.callee} (${m.systemName(h.calleeSystem)}, a vendor)`
          : h.callee,
      change: h.change.replace(/^planned-/, ""),
      ...b,
      source: `interfaces.md:${h.line}`,
    };
  });
  const data: DataChangeNote[] = m.data.map((d) => ({
    table: `${d.store}.${d.table}`,
    change: d.change.trim(),
    ...(d.migration ? { migration: d.migration } : {}),
    source: `data.md:${d.line}`,
  }));
  const limitations: Limitation[] = ctx.latest
    .filter((f) => f.finding.state === "waived")
    .map((f) => ({
      summary: f.finding.summary,
      ...(f.finding.resolution?.reason ? { reason: f.finding.resolution.reason } : {}),
      ...(f.finding.resolution ? { by: f.finding.resolution.by, at: f.finding.resolution.at } : {}),
      source: f.path,
    }));

  const sections: NotesSection[] = [];
  const add = (heading: string, items: string[], source: string | undefined, empty: string) =>
    sections.push({
      heading,
      items,
      ...(source ? { source } : {}),
      ...(items.length ? {} : { empty }),
    });
  const why = problem ?? whyP;
  add("Why", lines(why?.text), why?.source, "The brief doesn't say why yet.");
  const changes = what ? bullets(what.text) : lines(outcome?.text);
  add(
    "What changes",
    changes,
    what?.source ?? outcome?.source,
    "Neither the proposal nor the brief says what changes yet.",
  );
  add("Who it affects", who, whoSource, "The proposal names no systems.");
  if (audience === "technical") {
    add(
      "API changes",
      api.map(
        (a) =>
          `${a.operation} (${a.caller} → ${a.callee}): ${a.change}; breaking: ${a.breaking}${a.judgedBy === "not judged" ? " (not judged)" : ""}. ${a.why}`,
      ),
      api.length ? "interfaces.md" : undefined,
      "interfaces.md lists no new or changed interfaces.",
    );
    add(
      "Data changes",
      data.map(
        (d) =>
          `${d.table}: ${d.change}${d.migration ? ` (${d.migration})` : " (no migration named)"}`,
      ),
      data.length ? "data.md" : undefined,
      "data.md lists no data changes.",
    );
    if (impact) add("Impact", lines(impact.text), impact.source, "");
  }
  add(
    "Not included",
    outOfScope,
    outOfScope.length ? scope?.source : undefined,
    "The brief doesn't say what is out of scope.",
  );
  add(
    "Known limitations",
    limitations.map(
      (l) =>
        `${l.summary}${l.reason ? ` Waived${l.by ? ` by ${l.by}` : ""}${l.at ? ` on ${l.at.slice(0, 10)}` : ""}: ${l.reason}` : ""} (${l.source})`,
    ),
    undefined,
    ctx.rounds.length
      ? "No finding is waived."
      : "No critic round has run yet, so no finding is waived.",
  );
  if (audience === "business")
    add(
      "Still open",
      bullets(questions?.text),
      questions?.source,
      "The brief has no open questions.",
    );

  const md: string[] = [
    `# Release notes: ${ctx.change.title}`,
    "",
    `For ${audience} readers. Change \`${ctx.change.id}\`, generated ${ctx.today} from the change folder; every line says where it came from.`,
  ];
  for (const s of sections) {
    md.push("", `## ${s.heading}`, "");
    if (s.heading === "API changes" && api.length) {
      md.push("| Operation | Caller → callee | Change | Breaking | Why | Source |");
      md.push("| --- | --- | --- | --- | --- | --- |");
      for (const a of api)
        md.push(
          `| ${a.operation} | ${a.caller} → ${a.callee} | ${a.change} | ${a.breaking} (${a.judgedBy === "catalog" ? "by its change kind" : a.judgedBy === "not judged" ? "not judged" : a.breaking === "check" ? "a judge couldn't tell" : `judged by a ${a.judgedBy}`}) | ${a.why.replace(/\|/g, "\\|")} | ${a.source} |`,
        );
      continue;
    }
    if (s.heading === "Data changes" && data.length) {
      md.push("| Table | Change | Migration | Source |", "| --- | --- | --- | --- |");
      for (const d of data)
        md.push(
          `| ${d.table} | ${d.change.replace(/\|/g, "\\|")} | ${d.migration ?? "none named"} | ${d.source} |`,
        );
      continue;
    }
    if (!s.items.length) {
      md.push(`_${s.empty}_`);
      continue;
    }
    if (s.heading === "Why" || s.heading === "Impact") md.push(s.items.join(" "));
    else for (const i of s.items) md.push(`- ${i}`);
    if (s.source) md.push("", `Source: ${s.source}`);
  }
  return {
    change: ctx.change.id,
    title: ctx.change.title,
    audience,
    today: ctx.today,
    sections,
    api,
    data,
    limitations,
    markdown: md.join("\n") + "\n",
  };
}
