import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  AgentDefinition,
  Procedure,
  ServiceRequestTemplate,
  loadOrgPack,
  toCanonicalYaml,
  type CatalogRecord,
  type OrgPack,
  type RecordOf,
  orgPackDirOf,
} from "@maycombhq/core";
import {
  buildContextPack,
  toRunSummary,
  type AiRuntime,
  type Run,
  type SourceInput,
} from "@maycombhq/ai";
import { writeFileAtomic } from "@maycombhq/changes";
import { readDocument } from "@maycombhq/ingestors";
import {
  readServiceRequestExports,
  readWorkItemExports,
  type ExportedServiceRequest,
  type ExportedWorkItem,
} from "@maycombhq/intake";
import { syncSources } from "@maycombhq/knowledge";
import { readCatalog } from "@maycombhq/scanner";
import type { RunSummary } from "@maycombhq/core";
import { sentenceCase, slug } from "./words.js";

/**
 * Request templates and procedures learned from the organisation's own knowledge (ADRs 0032
 * point 5 and 0033 point 1). Sources: how-to pages in the wikis sources.yaml lists, documents
 * uploaded to inputs/, and exports of past tickets. The structured parts are read
 * deterministically (the field list on a page, the fields every past request filled, the
 * group that always approved, the median working days from open to close, the route past
 * requests' calls take in the catalog); only the prose (what the request is for, how to do
 * each step) is written by an AI agent outside any scan. Every value cites where it came from.
 *
 * The result is a proposal: files under `proposals/templates/` and a SUMMARY.md, never written
 * into the org pack. A template the org pack already has is compared; evidence that disagrees
 * with it (a new field on the page, another approval group, a different lead time across past
 * requests) becomes a triage item for a person.
 */

export const PROPOSALS_DIR = "proposals/templates";

type Template = z.infer<typeof ServiceRequestTemplate>;

interface Line {
  n: number;
  text: string;
}

/** A how-to source: a wiki page or an uploaded document, as lines with numbers. */
export interface HowTo {
  path: string;
  title: string;
  lines: Line[];
  kind: "wiki" | "upload";
  /** False when the lines are text extracted from a binary document: cite the file only. */
  lineRefs: boolean;
}

export interface Cited<T> {
  value: T;
  sources: string[];
}

export interface DraftField {
  name: string;
  required: boolean;
  from?: string;
  sources: string[];
}

export interface TemplateDraft {
  id: string;
  name: Cited<string>;
  requestType: Cited<string>;
  fields: DraftField[];
  approvers: Cited<string[]>;
  leadTimeDays: Cited<number>;
  triggers: Cited<Template["triggers"]>;
  /** Past requests of this type that were read. */
  tickets: string[];
  summary?: string;
  /** The template, valid against C6, or undefined with the problems. */
  template?: Template;
  problems: string[];
  /** Compared with the org pack's template of the same id. */
  existing: "none" | "matches" | "differs";
  notes: string[];
}

export interface TemplateTriage {
  id: string;
  template: string;
  summary: string;
  evidence: string[];
  options: string[];
}

export interface WorkItemTemplateDraft {
  type: string;
  items: number;
  alwaysFilled: Cited<string[]>;
  states: Cited<string[]>;
}

export interface DraftTemplatesResult {
  templates: TemplateDraft[];
  procedures: Procedure[];
  workItems: WorkItemTemplateDraft[];
  triage: TemplateTriage[];
  /** Metarepo-relative files written. */
  files: string[];
  sources: { howTos: string[]; tickets: string[]; workItems: string[] };
  run?: RunSummary;
  problems: string[];
}

// ------------------------------------------------------------------ reading how-to sources

const HOW_TO_TITLE =
  /^how to\s+(?:request|raise|ask for|get|open|submit|create|file)\s+(?:an?\s+|the\s+)?(.+?)\s*$/i;

const ref = (h: HowTo, n: number) => (h.lineRefs ? `${h.path}:${n}` : h.path);

function linesOf(text: string): Line[] {
  return text.split(/\r?\n/).map((t, i) => ({ n: i + 1, text: t }));
}

export function isHowTo(h: Pick<HowTo, "title" | "lines">): boolean {
  return HOW_TO_TITLE.test(h.title) || h.lines.some((l) => /\bfields?\s*:/i.test(l.text));
}

/** The quoted request type in "Raise a "X" request", or the title's object. */
function requestTypeOf(h: HowTo): Cited<string> | undefined {
  for (const l of h.lines) {
    const m =
      /\b(?:raise|open|submit|create|file|request)\s+(?:an?\s+|the\s+)?["“]([^"”]+)["”]/i.exec(
        l.text,
      );
    if (m) return { value: m[1]!.trim(), sources: [ref(h, l.n)] };
  }
  const t = HOW_TO_TITLE.exec(h.title);
  return t ? { value: sentenceCase(t[1]!), sources: [ref(h, 1)] } : undefined;
}

function fieldsOf(h: HowTo): { fields: DraftField[]; approvers: Cited<string[]> | undefined } {
  const fields: DraftField[] = [];
  let approvers: Cited<string[]> | undefined;
  for (const l of h.lines) {
    const m = /(?:^|[.!?]\s+|^\s*[-*]\s*)fields?\s*:\s*(.+?)\.?\s*$/i.exec(l.text);
    if (!m) continue;
    const at = ref(h, l.n);
    for (const raw of m[1]!
      .split(/,(?![^(]*\))/)
      .map((x) => x.trim())
      .filter(Boolean)) {
      const ap = /^approv(?:er|al)s?(?:\s+group)?\s*\(([^)]+)\)$/i.exec(raw);
      if (ap) {
        approvers = {
          value: ap[1]!
            .split(/\s*(?:,|\bor\b|\band\b)\s*/)
            .map(normGroup)
            .filter(Boolean),
          sources: [at],
        };
        continue;
      }
      const optional = /\(optional\)/i.test(raw);
      const name = sentenceCase(raw.replace(/\((?:optional|required)\)/i, "").trim());
      if (name && !fields.some((f) => f.name.toLowerCase() === name.toLowerCase()))
        fields.push({ name, required: !optional, sources: [at] });
    }
  }
  return { fields, approvers };
}

function leadTimeOf(h: HowTo): (Cited<number> & { unit: string }) | undefined {
  for (const l of h.lines) {
    const m =
      /lead time\s*(?:is|:)?\s*(?:about\s+)?(\d+(?:\.\d+)?)\s*(working days|business days|days|weeks)/i.exec(
        l.text,
      );
    if (m) {
      const n = Number(m[1]);
      const unit = m[2]!.toLowerCase();
      return {
        value: unit === "weeks" ? n * 5 : n,
        unit: unit === "weeks" ? "working days" : unit,
        sources: [ref(h, l.n)],
      };
    }
  }
  return undefined;
}

const normGroup = (s: string) => s.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Working days (Mon–Fri) from open to close, not counting the day it opened. */
export function workingDays(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  let n = 0;
  for (let d = new Date(a.getTime() + 86_400_000); d <= b; d = new Date(d.getTime() + 86_400_000)) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** A ticket field key belongs to a template field when it is the field's first word(s). */
function fieldFor(key: string, fields: { name: string }[]): string | undefined {
  const k = norm(key);
  return (
    fields.find((f) => norm(f.name) === k)?.name ??
    fields.find((f) => norm(f.name).startsWith(k) && k.length >= 3)?.name
  );
}

// ------------------------------------------------------------------ drafting

interface Inputs {
  orgPack: OrgPack;
  records: CatalogRecord[];
  howTos: HowTo[];
  tickets: ExportedServiceRequest[];
}

function ticketsFor(id: string, requestType: string, tickets: ExportedServiceRequest[]) {
  const t = slug(requestType);
  return tickets.filter((x) => {
    const s = slug(x.type);
    return s === t || s.includes(id) || t.includes(s);
  });
}

/** The route past requests' calls take, from the catalog: the trigger of the template. */
function triggersFrom(
  records: CatalogRecord[],
  tickets: ExportedServiceRequest[],
  field: string | undefined,
) {
  if (!field) return undefined;
  const vias = new Set<string>();
  const used: string[] = [];
  const interfaces = records.filter((r) => r.kind === "Interface") as RecordOf<"Interface">[];
  for (const t of tickets) {
    const source = String(t.fields[field] ?? "");
    const dest = Object.entries(t.fields)
      .filter(([k]) => k !== field)
      .map(([, v]) => String(v).toLowerCase())
      .join(" ");
    for (const i of interfaces.filter((x) => x.from === source)) {
      const words = i.to.split("-").filter((w) => w.length >= 4);
      if (words.length && words.some((w) => dest.includes(w)) && i.via) {
        vias.add(i.via);
        used.push(`${t.id} → ${i.id} (via ${i.via})`);
      }
    }
  }
  if (vias.size !== 1) return undefined;
  return {
    value: [
      { kind: "Interface" as const, change: "planned-new" as const, where: { via: [...vias][0]! } },
    ],
    sources: used,
  };
}

function draftOne(
  id: string,
  howTo: HowTo | undefined,
  rt: Cited<string>,
  inputs: Inputs,
): TemplateDraft {
  const notes: string[] = [];
  const page = howTo ? fieldsOf(howTo) : { fields: [], approvers: undefined };
  const fields = page.fields.map((f) => ({ ...f, sources: [...f.sources] }));
  const tickets = ticketsFor(id, rt.value, inputs.tickets);
  const ticketRef = (xs: ExportedServiceRequest[]) =>
    [...new Set(xs.map((x) => x.source.path))].join(", ");
  const componentIds = new Set(
    inputs.records.filter((r) => r.kind === "Component").map((r) => r.id),
  );
  // Fields every past request filled.
  const keys = [...new Set(tickets.flatMap((t) => Object.keys(t.fields)))];
  let sourceField: string | undefined;
  for (const k of keys) {
    const filled = tickets.filter((t) => String(t.fields[k] ?? "").trim() !== "");
    const name = fieldFor(k, fields) ?? sentenceCase(k.replace(/[_-]+/g, " "));
    let f = fields.find((x) => x.name === name);
    if (!f) {
      f = { name, required: filled.length === tickets.length, sources: [] };
      fields.push(f);
      if (howTo) notes.push(`${name} is filled in past requests but not on the how-to page.`);
    }
    f.sources.push(
      `${ticketRef(tickets)} (${filled.length} of ${tickets.length} requests filled ${k})`,
    );
    if (filled.length === tickets.length && filled.length > 0) {
      f.required = true;
      if (filled.every((t) => componentIds.has(String(t.fields[k])))) {
        f.from = "${record}";
        f.sources.push(
          `every value of ${k} is a catalog component (${filled.map((t) => t.fields[k]).join(", ")})`,
        );
        sourceField = k;
      }
    }
  }
  // Approvers: the page, corroborated by the group that approved every past request.
  const groups = [
    ...new Set(
      tickets
        .map((t) => t.approvalGroup)
        .filter((g): g is string => !!g)
        .map(normGroup),
    ),
  ];
  let approvers = page.approvers ?? { value: [], sources: [] };
  if (groups.length === 1 && tickets.every((t) => t.approvalGroup)) {
    const g = groups[0]!;
    const src = `${ticketRef(tickets)} (${g} approved ${tickets.length} of ${tickets.length})`;
    if (!approvers.value.length) approvers = { value: [g], sources: [src] };
    else if (approvers.value.includes(g))
      approvers = { value: approvers.value, sources: [...approvers.sources, src] };
    else
      notes.push(
        `The page names ${approvers.value.join(", ")} but past requests were approved by ${g}.`,
      );
  }
  // Lead time: the page, else the median working days of past requests (rounded up).
  const stated = howTo ? leadTimeOf(howTo) : undefined;
  const days = tickets
    .filter((t) => t.opened && t.closed)
    .map((t) => workingDays(t.opened!, t.closed!));
  const med = days.length ? Math.ceil(median(days)) : undefined;
  const medSrc = days.length
    ? `${ticketRef(tickets)} (median ${median(days)} working days over ${days.length} request${days.length > 1 ? "s" : ""}, rounded up)`
    : undefined;
  let leadTimeDays: Cited<number> = { value: 0, sources: [] };
  if (stated) {
    leadTimeDays = { value: stated.value, sources: [...stated.sources] };
    if (med !== undefined && Math.abs(med - stated.value) <= Math.max(1, stated.value * 0.25))
      leadTimeDays.sources.push(medSrc!);
    else if (med !== undefined)
      notes.push(
        `The page says ${stated.value} ${stated.unit}; past requests took a median of ${med} working days.`,
      );
  } else if (med !== undefined) leadTimeDays = { value: med, sources: [medSrc!] };
  else
    notes.push("No lead time on the page and no closed past requests: set leadTimeDays by hand.");
  const triggers = triggersFrom(inputs.records, tickets, sourceField) ?? { value: [], sources: [] };
  if (!triggers.value.length)
    notes.push("No trigger could be read from past requests and the catalog: add one by hand.");

  const draft: TemplateDraft = {
    id,
    name: rt,
    requestType: rt,
    fields,
    approvers,
    leadTimeDays,
    triggers,
    tickets: tickets.map((t) => t.id),
    problems: [],
    existing: "none",
    notes,
  };
  const r = ServiceRequestTemplate.safeParse({
    schemaVersion: 1,
    id,
    name: rt.value,
    requestType: rt.value,
    fields: fields.map((f) => ({
      name: f.name,
      required: f.required,
      ...(f.from ? { from: f.from } : {}),
    })),
    approvers: approvers.value,
    leadTimeDays: leadTimeDays.value,
    triggers: triggers.value,
  });
  if (r.success) draft.template = r.data;
  else
    draft.problems = r.error.issues.map((i) => `${i.path.join(".") || "(template)"}: ${i.message}`);
  return draft;
}

/** Compare a draft with the org pack's template of the same id; disagreements are triage items. */
function compare(
  d: TemplateDraft,
  existing: Template | undefined,
  tickets: number,
): TemplateTriage[] {
  if (!existing) return [];
  const out: TemplateTriage[] = [];
  const names = new Set(existing.fields.map((f) => f.name.toLowerCase()));
  const extra = d.fields.filter((f) => !names.has(f.name.toLowerCase()));
  for (const f of extra)
    out.push({
      id: `template.${d.id}.field.${slug(f.name)}`,
      template: d.id,
      summary: `${f.name} is asked for in the organisation's knowledge but org-pack/process/snow/${d.id}.yaml doesn't have it.`,
      evidence: f.sources,
      options: [`Add ${f.name} to the template`, "Dismiss: the template is right"],
    });
  const draftNames = new Set(d.fields.map((f) => f.name.toLowerCase()));
  if (
    d.fields.length &&
    d.fields.some((f) => f.sources.some((s) => !s.includes("requests filled")))
  )
    for (const f of existing.fields.filter((x) => !draftNames.has(x.name.toLowerCase())))
      out.push({
        id: `template.${d.id}.field-gone.${slug(f.name)}`,
        template: d.id,
        summary: `${f.name} is in the template but no longer on the how-to page.`,
        evidence: d.name.sources,
        options: [`Remove ${f.name} from the template`, "Dismiss: keep it"],
      });
  const ap = d.approvers.value.map(normGroup).sort();
  const ex = existing.approvers.map(normGroup).sort();
  if (ap.length && JSON.stringify(ap) !== JSON.stringify(ex))
    out.push({
      id: `template.${d.id}.approvers`,
      template: d.id,
      summary: `The template's approvers are ${ex.join(", ") || "none"}; the knowledge says ${ap.join(", ")}.`,
      evidence: d.approvers.sources,
      options: ["Change the approvers", "Dismiss: the template is right"],
    });
  const pageSaid = d.leadTimeDays.sources.some((s) => !s.includes("median"));
  if (
    d.leadTimeDays.value &&
    d.leadTimeDays.value !== existing.leadTimeDays &&
    (pageSaid || tickets >= 2)
  )
    out.push({
      id: `template.${d.id}.lead-time`,
      template: d.id,
      summary: `The template says ${existing.leadTimeDays} days; the knowledge says ${d.leadTimeDays.value}.`,
      evidence: d.leadTimeDays.sources,
      options: ["Change the lead time", "Dismiss: the template is right"],
    });
  return out;
}

// ------------------------------------------------------------------ procedures

function procedureFor(
  d: TemplateDraft,
  howTo: HowTo | undefined,
  prose?: string[],
): Procedure | undefined {
  if (!d.template) return undefined;
  const key = (n: string) =>
    n
      .toLowerCase()
      .replace(/[^a-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ""))
      .replace(/^[^a-z]+/, "");
  const inputs = {
    type: "object",
    required: d.fields.filter((f) => f.required).map((f) => key(f.name)),
    properties: Object.fromEntries(
      d.fields.map((f) => [key(f.name), { type: "string", title: f.name }]),
    ),
  };
  const r = Procedure.safeParse({
    schemaVersion: 1,
    id: d.id,
    name: `Raise a ${d.requestType.value} request`,
    system: "service-desk",
    template: d.id,
    steps: [
      {
        id: "submit-request",
        name: `Fill in and submit the ${d.requestType.value} request`,
        kind: "submit-request",
        writes: true,
        inputs,
        outputs: {
          type: "object",
          required: ["requestNumber"],
          properties: { requestNumber: { type: "string" }, url: { type: "string" } },
        },
        instructions:
          prose?.[0] ??
          `Open a new "${d.requestType.value}" request, fill in ${d.fields.map((f) => f.name.toLowerCase()).join(", ")}, and submit it.`,
        evidence: [...d.name.sources, ...d.fields.flatMap((f) => f.sources.slice(0, 1))]
          .filter((s, i, a) => a.indexOf(s) === i)
          .map((s) => {
            const m = /^(\S+?):(\d+)$/.exec(s);
            return m ? { source: m[1]!, line: Number(m[2]) } : { source: s.split(" (")[0]! };
          }),
      },
      {
        id: "report-state",
        name: "Report where the request is",
        kind: "report-request-state",
        writes: false,
        inputs: {
          type: "object",
          required: ["request"],
          properties: { request: { type: "string" } },
        },
        outputs: {
          type: "object",
          required: ["state"],
          properties: {
            state: {
              type: "string",
              enum: ["draft", "submitted", "in-progress", "done", "rejected"],
            },
            closedAt: { type: "string", format: "date" },
          },
        },
        instructions:
          prose?.[1] ??
          `Check the request until ${d.approvers.value.join(" or ") || "its approvers"} decide; it usually takes about ${d.leadTimeDays.value} days.`,
      },
    ],
    source: howTo?.path ?? d.tickets.join(", ") ?? "past requests",
    status: "draft",
  });
  return r.success ? r.data : undefined;
}

// ------------------------------------------------------------------ AI prose

export const TEMPLATE_WRITER = "template-writer";

export function templateWriter(orgPack: OrgPack): AgentDefinition {
  return (
    orgPack.agents.find((a) => a.id === TEMPLATE_WRITER) ??
    AgentDefinition.parse({
      schemaVersion: 1,
      id: TEMPLATE_WRITER,
      role: "platform-lead",
      description:
        "Writes the prose of request templates and procedures drafted from the organisation's how-to pages and past tickets.",
      inputs: ["documents"],
      outputArtifact: "snow",
      tokenBudget: orgPack.runtime.budgets.defaultTokens,
      allowedRuntimes: ["hand-off", "model", "headless-claude-code", "mock", "replay"],
    })
  );
}

const PROSE_FORMAT = `For each template below, write in YAML and nothing else:

templates:
  - id: <the template id, exactly as given>
    summary: <two sentences: what the request is for and when a change needs it>
    steps:
      - <how to fill in and submit the request, one or two sentences>
      - <how to follow it until it is decided, one sentence>

Use only what the material says. Don't add fields, groups or numbers that aren't in it.`;

const ProseOut = z.object({
  templates: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string().min(1),
        steps: z.array(z.string().min(1)).default([]),
      }),
    )
    .default([]),
});

async function writeTemplateProse(
  runtime: AiRuntime,
  orgPack: OrgPack,
  drafts: TemplateDraft[],
  howTos: HowTo[],
  now: Date,
) {
  const agent = templateWriter(orgPack);
  const plan = drafts
    .map(
      (d) =>
        `- id: ${d.id}\n  requestType: ${d.requestType.value}\n  fields: [${d.fields.map((f) => f.name).join(", ")}]\n  approvers: [${d.approvers.value.join(", ")}]\n  leadTimeDays: ${d.leadTimeDays.value}`,
    )
    .join("\n");
  const sources: SourceInput[] = [
    {
      id: "instructions",
      kind: "instruction",
      origin: "atticus",
      text: `# Template writer\n\nYou write the prose of service-desk request templates Atticus drafted from the organisation's knowledge.\n\n${PROSE_FORMAT}`,
      classification: "public",
      trusted: true,
    },
    {
      id: "drafts",
      kind: "artifact",
      origin: "atticus templates draft (deterministic)",
      text: plan,
      classification: "internal",
      priority: 100,
    },
    ...howTos.map((h) => ({
      id: h.path,
      kind: "document" as const,
      origin: h.path,
      text: h.lines.map((l) => l.text).join("\n"),
      classification: "internal",
      priority: 50,
    })),
  ];
  const levels = orgPack.pack?.classification ?? [
    "public",
    "internal",
    "confidential",
    "restricted",
  ];
  const pack = buildContextPack({
    change: "org-pack",
    agent: agent.id,
    budget: agent.tokenBudget,
    sources,
    levels,
    maxClassification: levels.includes("internal") ? "internal" : levels[0]!,
    now,
  });
  const prepared = await runtime.prepare({
    change: TEMPLATE_PROSE_CHANGE,
    agent,
    pack,
    outputPath: TEMPLATE_PROSE_OUTPUT,
  });
  const run = await runtime.run(prepared.runId);
  return { ...readTemplateProse(run, drafts), promptSha256: pack.manifest.promptSha256 };
}

/** What the template writer's run is sent as, so a finished hand-off run is recognised. */
export const TEMPLATE_PROSE_CHANGE = "org-pack";
export const TEMPLATE_PROSE_OUTPUT = `${PROPOSALS_DIR}/prose.yaml`;

/** The prose in a template writer's run, for the drafts it was asked about. */
function readTemplateProse(run: Run, drafts: TemplateDraft[]) {
  const prose = new Map<string, { summary: string; steps: string[] }>();
  const problems: string[] = [];
  if (run.output && (run.state === "validated" || run.state === "produced")) {
    try {
      const r = ProseOut.safeParse(parse(run.output));
      if (r.success)
        for (const t of r.data.templates)
          if (drafts.some((d) => d.id === t.id)) prose.set(t.id, t);
          else problems.push("the template writer's answer has no templates list");
    } catch (e) {
      problems.push(
        `the template writer's answer isn't YAML: ${(e as Error).message.split("\n")[0]}`,
      );
    }
  } else if (run.state === "waiting")
    problems.push(
      `the template writer is waiting for your assistant; the drafts have no prose yet. When it is done, run: atticus handoff done ${run.runId}`,
    );
  else problems.push(`the template writer ${run.state}: ${run.errors.join("; ")}`);
  return { prose, problems, run: toRunSummary(run) };
}

// ------------------------------------------------------------------ writing the proposal

const q = (s: string) =>
  /^[\w .,/()-]+$/.test(s) && !/^[\d-]/.test(s) && !/: /.test(s) ? s : JSON.stringify(s);
const cite = (xs: string[]) => (xs.length ? `  # ${xs.join("; ")}` : "");

/** The draft template as YAML, each value with its source as a comment. */
export function templateYaml(d: TemplateDraft): string {
  const lines = [
    `# Drafted by atticus templates draft from the organisation's knowledge. A proposal: review it, then copy it to org-pack/process/snow/${d.id}.yaml in a pull request.`,
    ...(d.summary ? d.summary.split("\n").map((l) => `# ${l}`) : []),
    "schemaVersion: 1",
    `id: ${d.id}`,
    `name: ${q(d.name.value)}${cite(d.name.sources)}`,
    `requestType: ${q(d.requestType.value)}${cite(d.requestType.sources)}`,
    "fields:",
    ...d.fields.map(
      (f) =>
        `  - { name: ${q(f.name)}, required: ${f.required}${f.from ? `, from: ${JSON.stringify(f.from)}` : ""} }${cite(f.sources)}`,
    ),
    `approvers: [${d.approvers.value.map(q).join(", ")}]${cite(d.approvers.sources)}`,
    `leadTimeDays: ${d.leadTimeDays.value}${cite(d.leadTimeDays.sources)}`,
    d.triggers.value.length ? "triggers:" : "triggers: []  # none found: add one",
    ...d.triggers.value.map(
      (t) =>
        `  - { kind: ${t.kind}, change: ${t.change}${
          Object.keys(t.where).length
            ? `, where: { ${Object.entries(t.where)
                .map(([k, v]) => `${k}: ${v}`)
                .join(", ")} }`
            : ""
        } }${cite(d.triggers.sources)}`,
    ),
  ];
  return lines.join("\n") + "\n";
}

function summaryMd(r: Omit<DraftTemplatesResult, "files">, at: string): string {
  const lines = [
    "# Proposed org-pack changes: request templates and procedures",
    "",
    `Drafted by \`atticus templates draft\` on ${at} from ${r.sources.howTos.length} how-to source${r.sources.howTos.length === 1 ? "" : "s"}, ${r.sources.tickets.length} ticket export${r.sources.tickets.length === 1 ? "" : "s"} and ${r.sources.workItems.length} work-item export${r.sources.workItems.length === 1 ? "" : "s"}. Nothing here is used until a person reviews it and copies it into the org pack through a pull request.`,
    "",
  ];
  for (const d of r.templates) {
    lines.push(`## ${d.requestType.value} (${d.id})`, "");
    if (d.summary) lines.push(d.summary, "");
    lines.push(
      d.existing === "matches"
        ? `The org pack already has this template and the knowledge agrees with it.`
        : d.existing === "differs"
          ? `The org pack has this template; the knowledge disagrees with it (see Needs a decision).`
          : `New: process/snow/${d.id}.yaml and process/procedures/${d.id}.yaml.`,
      "",
      "| Value | Drafted | Sources |",
      "| --- | --- | --- |",
      ...d.fields.map(
        (f) =>
          `| Field ${f.name} | ${f.required ? "required" : "optional"}${f.from ? `, from ${f.from}` : ""} | ${f.sources.join("; ")} |`,
      ),
      `| Approvers | ${d.approvers.value.join(", ")} | ${d.approvers.sources.join("; ")} |`,
      `| Lead time | ${d.leadTimeDays.value} days | ${d.leadTimeDays.sources.join("; ")} |`,
      `| Triggers | ${
        d.triggers.value
          .map(
            (t) =>
              `${t.kind} ${t.change}${
                Object.keys(t.where).length
                  ? ` where ${Object.entries(t.where)
                      .map(([k, v]) => `${k} ${v}`)
                      .join(", ")}`
                  : ""
              }`,
          )
          .join("; ") || "none"
      } | ${d.triggers.sources.join("; ")} |`,
      "",
    );
    for (const n of [...d.notes, ...d.problems]) lines.push(`- ${n}`);
    if (d.notes.length || d.problems.length) lines.push("");
  }
  if (r.workItems.length) {
    lines.push("## Work-item templates", "");
    for (const w of r.workItems)
      lines.push(
        `- ${w.type}: ${w.items} past items; always filled: ${w.alwaysFilled.value.join(", ") || "nothing"} (${w.alwaysFilled.sources.join("; ")})`,
      );
    lines.push("");
  }
  if (r.triage.length) {
    lines.push("## Needs a decision", "");
    for (const t of r.triage)
      lines.push(
        `- ${t.summary} Evidence: ${t.evidence.join("; ")}. Options: ${t.options.join(" / ")}.`,
      );
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

// ------------------------------------------------------------------ entry point

async function uploads(root: string, inputsDir: string, skip: string[]): Promise<HowTo[]> {
  const out: HowTo[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (skip.some((s) => full === s || full.startsWith(`${s}${sep}`))) continue;
      if (e.isDirectory()) await walk(full);
      else if (/\.(md|markdown|html?|txt|docx|pdf)$/i.test(e.name)) {
        try {
          const bytes = new Uint8Array(await readFile(full));
          const doc = readDocument(e.name, bytes);
          // Plain-text formats keep their own lines, so citations point at the file's lines.
          const plain = /\.(md|markdown|txt)$/i.test(e.name);
          const text = plain
            ? new TextDecoder().decode(bytes)
            : doc.text.sections
                .map((s) => [s.heading ? `# ${s.heading}` : "", s.text].filter(Boolean).join("\n"))
                .join("\n");
          out.push({
            path: relative(root, full).split(sep).join("/"),
            title: doc.text.title,
            lines: linesOf(text),
            kind: "upload",
            lineRefs: plain,
          });
        } catch {
          // not a document Atticus reads
        }
      }
    }
  }
  await walk(inputsDir);
  return out;
}

/**
 * Draft request templates (and their procedures) from how-to pages, uploads and past tickets,
 * and work-item templates from past work items, as a proposal under proposals/templates/.
 */
export async function draftTemplates(
  root: string,
  o: {
    runtime?: AiRuntime;
    now?: Date;
    inputsDir?: string;
    /**
     * A template writer run finished in hand-off mode (`atticus handoff done`): its answer is
     * the prose, so the draft is written again with it instead of asking anyone.
     */
    finished?: Run;
  } = {},
): Promise<DraftTemplatesResult> {
  const orgPackDir = join(orgPackDirOf(root));
  const orgPack = await loadOrgPack(orgPackDir);
  const records = (await readCatalog(join(root, orgPack.sources.layout.catalog, "generated")))
    .records;
  const now = o.now ?? new Date();
  const problems: string[] = [];
  const inputsDir = o.inputsDir ?? join(root, "inputs");

  const wiki = await syncSources({ root, orgPack, orgPackDir, records });
  for (const p of wiki.problems) problems.push(`${p.source}: ${p.message}`);
  const wikiHowTos: HowTo[] = [];
  const wikiDirs: string[] = [];
  for (const s of orgPack.sources.wikis)
    if (s.type === "markdown-folder") wikiDirs.push(join(orgPackDir, s.location));
  for (const p of wiki.pages) {
    const text = await readFile(join(root, p.path), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    wikiHowTos.push({
      path: p.path,
      title: p.title,
      lines: linesOf(text),
      kind: "wiki",
      lineRefs: true,
    });
  }
  const uploaded = await uploads(
    root,
    inputsDir,
    wikiDirs.map((d) => join(d)),
  );
  const howTos = [...wikiHowTos, ...uploaded].filter(isHowTo);
  const exports = await readServiceRequestExports({ root, inputsDir });
  const items = await readWorkItemExports({ root, inputsDir });
  const inputs: Inputs = { orgPack, records, howTos, tickets: exports.requests };

  // One template per how-to page, then per ticket type no page or template covers.
  const drafts: TemplateDraft[] = [];
  const used = new Set<string>();
  for (const h of howTos) {
    const rt = requestTypeOf(h);
    if (!rt) continue;
    const t = HOW_TO_TITLE.exec(h.title);
    const id = slug(t ? t[1]! : rt.value);
    if (drafts.some((d) => d.id === id)) continue;
    const d = draftOne(id, h, rt, inputs);
    drafts.push(d);
    for (const x of d.tickets) used.add(x);
  }
  for (const t of orgPack.serviceRequests) {
    if (drafts.some((d) => d.id === t.id)) continue;
    const tickets = ticketsFor(t.id, t.requestType, exports.requests).filter(
      (x) => !used.has(x.id),
    );
    if (!tickets.length) continue;
    // Evidence about an existing template from past requests alone: compare, don't redraft.
    const d = draftOne(
      t.id,
      undefined,
      { value: t.requestType, sources: [`org-pack/process/snow/${t.id}.yaml`] },
      { ...inputs, tickets },
    );
    d.fields = d.fields.map((f) => ({ ...f, name: fieldFor(f.name, t.fields) ?? f.name }));
    drafts.push(d);
    for (const x of d.tickets) used.add(x);
  }
  for (const type of [
    ...new Set(exports.requests.filter((r) => !used.has(r.id)).map((r) => r.type)),
  ]) {
    const d = draftOne(
      slug(type),
      undefined,
      { value: sentenceCase(type.replace(/[-_]+/g, " ")), sources: exports.files },
      inputs,
    );
    drafts.push(d);
  }

  // Compare with the org pack.
  const triage: TemplateTriage[] = [];
  for (const d of drafts) {
    const existing = orgPack.serviceRequests.find((t) => t.id === d.id);
    if (!existing) continue;
    const found = compare(d, existing, d.tickets.length);
    d.existing = found.length ? "differs" : "matches";
    triage.push(...found);
  }

  // Prose.
  let run: RunSummary | undefined;
  const prose = new Map<string, { summary: string; steps: string[] }>();
  if (o.finished && drafts.length) {
    const r = readTemplateProse(o.finished, drafts);
    for (const [k, v] of r.prose) prose.set(k, v);
    problems.push(...r.problems);
    run = r.run;
  } else if (o.runtime && drafts.length) {
    const r = await writeTemplateProse(o.runtime, orgPack, drafts, howTos, now);
    for (const [k, v] of r.prose) prose.set(k, v);
    problems.push(...r.problems);
    run = r.run;
  }
  for (const d of drafts) {
    const p = prose.get(d.id);
    if (p) d.summary = p.summary;
  }
  const procedures = drafts
    .filter((d) => d.existing !== "matches" || !orgPack.procedures.some((p) => p.id === d.id))
    .map((d) =>
      procedureFor(
        d,
        howTos.find((h) => d.name.sources.some((s) => s.startsWith(h.path))),
        prose.get(d.id)?.steps,
      ),
    )
    .filter((p): p is Procedure => !!p);

  // Work-item templates: what every past item of a type had.
  const workItems: WorkItemTemplateDraft[] = [];
  const byType = new Map<string, ExportedWorkItem[]>();
  for (const i of items.items) byType.set(i.type, [...(byType.get(i.type) ?? []), i]);
  for (const [type, list] of [...byType].sort()) {
    const has = (k: keyof ExportedWorkItem) =>
      list.every(
        (i) =>
          i[k] !== undefined &&
          i[k] !== "" &&
          !(Array.isArray(i[k]) && !(i[k] as unknown[]).length),
      );
    workItems.push({
      type,
      items: list.length,
      alwaysFilled: {
        value: (["title", "description", "state", "parent", "tags"] as const).filter(has),
        sources: [...new Set(list.map((i) => i.source.path))],
      },
      states: {
        value: [...new Set(list.map((i) => i.state).filter((s): s is string => !!s))],
        sources: [...new Set(list.map((i) => i.source.path))],
      },
    });
  }

  // Write the proposal.
  const files: string[] = [];
  const write = async (rel: string, text: string) => {
    await writeFileAtomic(join(root, PROPOSALS_DIR, rel), text);
    files.push(`${PROPOSALS_DIR}/${rel}`);
  };
  for (const d of drafts)
    if (d.existing !== "matches") await write(`process/snow/${d.id}.yaml`, templateYaml(d));
  for (const p of procedures)
    await write(
      `process/procedures/${p.id}.yaml`,
      `# Drafted by atticus templates draft. A proposal: review it, then copy it to org-pack/process/procedures/${p.id}.yaml. No executor may run it until executors.allowed names one.\n` +
        toCanonicalYaml(p, [
          "schemaVersion",
          "id",
          "name",
          "description",
          "system",
          "template",
          "steps",
          "kind",
          "writes",
        ]),
    );
  for (const w of workItems)
    await write(
      `process/work-items/${w.type}.yaml`,
      `# Drafted by atticus templates draft from past work items (${w.alwaysFilled.sources.join(", ")}). No C6 schema holds work-item templates yet.\n` +
        `type: ${w.type}\nitems: ${w.items}\nalwaysFilled: [${w.alwaysFilled.value.join(", ")}]\nstates: [${w.states.value.map(q).join(", ")}]\n`,
    );
  if (triage.length)
    await write(
      "triage.yaml",
      toCanonicalYaml({ items: triage }, ["items", "id", "template", "summary"]),
    );
  const result = {
    templates: drafts,
    procedures,
    workItems,
    triage,
    sources: { howTos: howTos.map((h) => h.path), tickets: exports.files, workItems: items.files },
    ...(run ? { run } : {}),
    problems,
  };
  await write("SUMMARY.md", summaryMd(result, now.toISOString().slice(0, 10)));
  return { ...result, files };
}
