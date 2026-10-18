import type { z } from "zod";
import type { ChangeRepos, RecordOf, TestType } from "@maycombhq/core";
import { hopRoutes, type DataChange, type Hop } from "@maycombhq/naysayer";
import type { PlanContext } from "@maycombhq/planner";
import { generate, type JsonSchema } from "@maycombhq/stubs";
import { endpointFor, findOperation, type SpecOperation } from "./spec.js";
import type { StoryContext } from "./story.js";
import { languageOf, nodeRunner, repoPlace, type Language, type RepoPlace } from "./targets.js";
import { slug } from "./words.js";

/**
 * The framework-neutral test model of one story: every test case the story needs, decided
 * deterministically from its acceptance criteria, the change's interfaces and data changes,
 * the callee specs and the catalog, filtered by the change's test strategy. Generators turn
 * it into files; AI only names scenarios, test cases and test data.
 */

export type StrategyKind = z.infer<typeof TestType>;
export type CaseType = "acceptance" | "api" | "contract" | "data" | "event";

interface Base {
  id: string;
  /** Deterministic title; `name` starts as the title and may be reworded by the test writer. */
  title: string;
  name: string;
}

export interface AcceptanceCase extends Base {
  type: "acceptance";
  criterion: number;
  given: string;
  when: string;
  then: string;
  text: string;
  trace?: { file: string; line: number; name: string };
  tags: string[];
}

export interface ApiCase extends Base {
  type: "api";
  kind: "happy" | "negative" | "error" | "auth";
  component: string;
  method: string;
  path: string;
  operationId?: string;
  interfaceId?: string;
  endpoint?: string;
  request: {
    pathParams: Record<string, unknown>;
    query: Record<string, unknown>;
    body?: unknown;
    auth: "valid" | "none" | "no-scope";
    scope?: string;
    authType?: string;
  };
  expect: { status: string; body?: unknown; fields: string[] };
  why: string;
  /** The acceptance case this one checks at the API. */
  scenario?: string;
  /** The test data (request body) and its name. */
  data?: { id: string; name: string };
}

export interface ContractCase extends Base {
  type: "contract";
  role: "consumer" | "provider";
  consumer: string;
  provider: string;
  interfaceId?: string;
  status: string;
  method?: string;
  path?: string;
  topic?: string;
  /** The path the consumer calls (through the gateway route when there is one). */
  consumerPath?: string;
  request: { fields: string[]; example?: unknown };
  response: { status?: string; fields: string[]; example?: unknown };
  /** Error answers the consumer must handle (from the design's notes and mappings). */
  errors: { status: string; code?: string }[];
  checks: string[];
  gaps: string[];
  spec?: string;
}

export interface DataCase extends Base {
  type: "data";
  kind: "column" | "table" | "migration";
  store: string;
  table: string;
  tableId: string;
  column?: string;
  columnType?: string;
  notNull?: boolean;
  default?: string;
  columns?: { name: string; type: string }[];
  migration?: string;
  checks: string[];
}

export interface EventCase extends Base {
  type: "event";
  role: "publisher" | "subscriber";
  topic: string;
  publisher: string;
  subscriber: string;
  interfaceId?: string;
  fields: string[];
  checks: string[];
}

export type TestCase = AcceptanceCase | ApiCase | ContractCase | DataCase | EventCase;

export interface RepoTests {
  repo: string;
  component?: string;
  language?: Language;
  runner?: "vitest" | "jest";
  place: RepoPlace;
  /** The repo that gets the story's acceptance feature. */
  primary: boolean;
  cases: TestCase[];
}

export interface TestModel {
  change: string;
  story: {
    id: string;
    path: string;
    title: string;
    asA?: string;
    iWant?: string;
    soThat?: string;
    tracesTo?: string;
  };
  strategy: { required: StrategyKind[]; row?: string; note?: string };
  kinds: { type: CaseType; generated: boolean; why: string }[];
  repos: RepoTests[];
  /** Contract cases whose side has no repo here (a vendor's provider checks): kept in the model. */
  elsewhere: ContractCase[];
  linkedBy: "links" | "inferred";
  notes: string[];
  gaps: string[];
}

const NEEDS: Record<Exclude<CaseType, "acceptance">, StrategyKind[]> = {
  api: ["integration", "e2e", "regression", "security"],
  contract: ["contract"],
  data: ["data-migration", "integration"],
  event: ["contract", "integration"],
};

// ------------------------------------------------------------------ API cases

type Mutation = { key: string; value: unknown; title: string };

const below = (min: number, integer: boolean) =>
  integer ? min - 1 : min >= 1 ? min - 1 : min > 0 ? 0 : min - 1;

const typeOf = (s: JsonSchema) =>
  (Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type) ??
  (s.properties ? "object" : undefined);

/** One invalid value per constraint of a field's schema, in a fixed order. */
export function mutations(name: string, s: JsonSchema): Mutation[] {
  const out: Mutation[] = [];
  const t = typeOf(s);
  if (s.enum?.length) {
    let v = "INVALID";
    while (s.enum.includes(v)) v += "-1";
    out.push({ key: "enum", value: v, title: `refuses ${name} outside ${s.enum.join(", ")}` });
  } else if (t === "integer" || t === "number")
    out.push({ key: "type", value: "abc", title: `refuses ${name} that is not a number` });
  else if (t === "string")
    out.push({ key: "type", value: 12345, title: `refuses ${name} that is not text` });
  else if (t === "boolean")
    out.push({ key: "type", value: "yes", title: `refuses ${name} that is not true or false` });
  if (typeof s.minimum === "number")
    out.push({
      key: "minimum",
      value: below(s.minimum, t === "integer"),
      title: `refuses ${name} below ${s.minimum}`,
    });
  if (typeof s.exclusiveMinimum === "number")
    out.push({
      key: "exclusive-minimum",
      value: s.exclusiveMinimum,
      title: `refuses ${name} of ${s.exclusiveMinimum}`,
    });
  if (typeof s.maximum === "number")
    out.push({ key: "maximum", value: s.maximum + 1, title: `refuses ${name} above ${s.maximum}` });
  if (typeof s.exclusiveMaximum === "number")
    out.push({
      key: "exclusive-maximum",
      value: s.exclusiveMaximum,
      title: `refuses ${name} of ${s.exclusiveMaximum}`,
    });
  if (typeof s.minLength === "number" && s.minLength > 0)
    out.push({
      key: "min-length",
      value: "x".repeat(s.minLength - 1),
      title: `refuses ${name} shorter than ${s.minLength} characters`,
    });
  if (typeof s.maxLength === "number")
    out.push({
      key: "max-length",
      value: "x".repeat(s.maxLength + 1),
      title: `refuses ${name} longer than ${s.maxLength} characters`,
    });
  if (s.format && ["date", "date-time", "email", "uuid", "uri"].includes(s.format))
    out.push({
      key: "format",
      value: `not-a-${s.format}`,
      title: `refuses ${name} that is not a ${s.format}`,
    });
  return out;
}

const CODE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g;

function apiCases(
  hop: Hop,
  op: SpecOperation | undefined,
  endpoint: RecordOf<"Endpoint"> | undefined,
  acceptance: AcceptanceCase[],
): { cases: ApiCase[]; notes: string[] } {
  const notes: string[] = [];
  const method = hop.method!;
  const path = op?.route.path ?? hop.path!;
  const base = `api.${slug(`${method} ${path}`)}`;
  const common = {
    component: hop.callee,
    method,
    path,
    ...(op?.route.operationId ? { operationId: op.route.operationId } : {}),
    ...(/^if-/.test(hop.id) ? { interfaceId: hop.id } : {}),
    ...(endpoint ? { endpoint: endpoint.id } : {}),
  };
  const pathParams: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  for (const p of op?.route.params ?? []) {
    const v = p.schema ? generate(p.schema) : "1";
    if (p.in === "path") pathParams[p.name] = v;
    else if (p.in === "query" && p.required) query[p.name] = v;
  }
  for (const m of path.matchAll(/\{([^}]+)\}/g))
    if (!(m[1]! in pathParams)) pathParams[m[1]!] = "1";
  const authType =
    op?.security[0]?.type ??
    (endpoint?.auth && endpoint.auth !== "none" ? endpoint.auth : undefined);
  const req = (o: Partial<ApiCase["request"]> = {}): ApiCase["request"] => ({
    pathParams,
    query,
    ...(op?.requestExample !== undefined ? { body: op.requestExample } : {}),
    auth: authType ? "valid" : "none",
    ...(authType ? { authType } : {}),
    ...o,
  });
  const cases: ApiCase[] = [];
  const data =
    op?.requestExample !== undefined
      ? { id: `data.${slug(`${method} ${path}`)}`, name: "" }
      : undefined;
  const statuses = new Set((op?.route.responses ?? []).map((r) => r.status));
  const bad = statuses.has("400")
    ? "400"
    : statuses.has("422") && !op?.route.responses.find((r) => r.status === "422")?.body
      ? "422"
      : "4XX";
  const ok = op?.route.responses.find((r) => /^2/.test(r.status));
  const okStatus = op ? String(op.route.status) : method === "POST" ? "201" : "200";

  cases.push({
    type: "api",
    id: `${base}.happy`,
    kind: "happy",
    title: `${method} ${path} accepts a valid request`,
    name: "",
    ...common,
    request: req(),
    expect: {
      status: okStatus,
      ...(ok?.body !== undefined && ok.example !== "none" ? { body: ok.body } : {}),
      fields: op?.responseFields ?? [],
    },
    why: op
      ? `The spec (${op.source}) answers ${okStatus} for a valid request.`
      : "The design calls this operation; no spec was found.",
    ...(data ? { data } : {}),
  });
  if (!op)
    notes.push(
      `No spec has ${method} ${hop.path} for ${hop.callee}: only the happy path was generated.`,
    );

  // Negative cases from the request schema's constraints, then from path parameters.
  const schema = op?.route.body?.schema;
  const example = op?.requestExample;
  if (schema?.properties && example && typeof example === "object" && !Array.isArray(example)) {
    for (const f of schema.required ?? []) {
      const body = { ...(example as Record<string, unknown>) };
      delete body[f];
      cases.push({
        type: "api",
        id: `${base}.missing-${slug(f)}`,
        kind: "negative",
        title: `${method} ${path} refuses a request without ${f}`,
        name: "",
        ...common,
        request: req({ body }),
        expect: { status: bad, fields: [] },
        why: `${f} is required by the spec.`,
      });
    }
    for (const [f, s] of Object.entries(schema.properties)) {
      if (s.readOnly) continue;
      for (const m of mutations(f, s))
        cases.push({
          type: "api",
          id: `${base}.${slug(f)}-${m.key}`,
          kind: "negative",
          title: `${method} ${path} ${m.title}`,
          name: "",
          ...common,
          request: req({ body: { ...(example as Record<string, unknown>), [f]: m.value } }),
          expect: { status: bad, fields: [] },
          why: `The spec constrains ${f} (${m.key.replace(/-/g, " ")}).`,
        });
    }
  }
  for (const p of op?.route.params ?? []) {
    if (p.in !== "path" || !p.schema) continue;
    for (const m of mutations(p.name, p.schema))
      cases.push({
        type: "api",
        id: `${base}.${slug(p.name)}-${m.key}`,
        kind: "negative",
        title: `${method} ${path} ${m.title.replace("refuses ", "refuses a path ")}`,
        name: "",
        ...common,
        request: req({ pathParams: { ...pathParams, [p.name]: m.value } }),
        expect: { status: bad, fields: [] },
        why: `The spec constrains the path parameter ${p.name} (${m.key.replace(/-/g, " ")}).`,
      });
  }

  // Documented error answers, linked to the criterion that names their code.
  for (const r of op?.route.responses ?? []) {
    if (!/^[45]\d\d$/.test(r.status) || ["400", "401", "403"].includes(r.status)) continue;
    const said = `${r.description ?? ""} ${JSON.stringify(r.body ?? "")}`;
    const codes = [...new Set(said.match(CODE) ?? [])];
    const scenario = acceptance.find(
      (a) => codes.some((c) => a.then.includes(c)) || new RegExp(`\\b${r.status}\\b`).test(a.then),
    );
    cases.push({
      type: "api",
      id: `${base}.status-${r.status}`,
      kind: "error",
      title: `${method} ${path} answers ${r.status}${r.description ? `: ${r.description}` : ""}`,
      name: "",
      ...common,
      request: req(),
      expect: { status: r.status, ...(r.body !== undefined ? { body: r.body } : {}), fields: [] },
      why: `The spec documents ${r.status}${r.description ? `: ${r.description}` : ""}. The request needs data in that state${scenario ? ` (${scenario.trace?.name || `criterion ${scenario.criterion}`})` : ""}.`,
      ...(scenario ? { scenario: scenario.id } : {}),
      ...(data ? { data } : {}),
    });
  }

  // Auth: no credentials, and a token without each required scope.
  if (authType) {
    cases.push({
      type: "api",
      id: `${base}.no-credentials`,
      kind: "auth",
      title: `${method} ${path} refuses a request without credentials`,
      name: "",
      ...common,
      request: req({ auth: "none" }),
      expect: { status: "401", fields: [] },
      why: `The operation needs ${authType} credentials.`,
    });
    for (const s of op?.security ?? [])
      for (const scope of s.scopes)
        cases.push({
          type: "api",
          id: `${base}.no-scope-${slug(scope)}`,
          kind: "auth",
          title: `${method} ${path} refuses a token without scope ${scope}`,
          name: "",
          ...common,
          request: req({ auth: "no-scope", scope }),
          expect: { status: "403", fields: [] },
          why: `The spec asks for scope ${scope}.`,
        });
  }
  return { cases, notes };
}

// ------------------------------------------------------------------ contract cases

/** Target fields of the mappings.md table for a hop (what the interface carries). */
export function mappedFields(text: string): string[] {
  const rows = text.split("\n").filter((l) => l.trim().startsWith("|"));
  if (rows.length < 2) return [];
  const cells = (l: string) =>
    l
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.replace(/[`*]/g, "").trim());
  const head = cells(rows[0]!).map((h) => h.toLowerCase());
  const ti = head.findIndex((h) => /^target( field)?$/.test(h));
  if (ti < 0) return [];
  return [
    ...new Set(
      rows
        .slice(1)
        .map(cells)
        .filter((c) => !c.every((x) => /^:?-+:?$/.test(x) || x === ""))
        .map((c) => c[ti] ?? "")
        .filter((f) => /^[A-Za-z_][\w.[\]-]*$/.test(f)),
    ),
  ];
}

const topicOf = (op: string) => /^(publish|subscribe|send|receive)\s+(\S+)/i.exec(op.trim());

function contractCases(
  ctx: PlanContext,
  hop: Hop,
  op: SpecOperation | undefined,
  tried: string[],
): ContractCase[] {
  if (!/^planned-(new|modify)$/.test(hop.status)) return [];
  const mapping = ctx.mapping(hop);
  const notes = ctx
    .notes(hop)
    .map((n) => n.text)
    .join("\n");
  const fields = mappedFields(mapping);
  const errors: ContractCase["errors"] = [];
  for (const m of `${notes}\n${mapping}`.matchAll(/HTTP\s+(\d{3})/g)) {
    const around = `${notes}\n${mapping}`;
    const code = (around.match(CODE) ?? [])[0];
    if (!errors.some((e) => e.status === m[1]))
      errors.push({ status: m[1]!, ...(code ? { code } : {}) });
  }
  const t = topicOf(hop.operation);
  const base = `contract.${slug(t ? `${t[1]} ${t[2]}` : `${hop.method} ${hop.path}`)}`;
  const common = {
    status: hop.status,
    ...(/^if-/.test(hop.id) ? { interfaceId: hop.id } : {}),
  };
  if (t) {
    const publish = /^(publish|send)$/i.test(t[1]!);
    const publisher = publish ? hop.caller : hop.callee;
    const subscriber = publish ? hop.callee : hop.caller;
    const shared = {
      ...common,
      consumer: subscriber,
      provider: publisher,
      topic: t[2]!,
      request: { fields },
      response: { fields: [] },
      errors: [],
      gaps: [],
    };
    return [
      {
        type: "contract",
        id: `${base}.subscriber`,
        title: `${subscriber} handles a ${t[2]} message from ${publisher}`,
        name: "",
        role: "consumer",
        ...shared,
        checks: [
          `${subscriber} accepts a message on ${t[2]}`,
          ...(fields.length ? [`it reads ${fields.join(", ")}`] : []),
        ],
      },
      {
        type: "contract",
        id: `${base}.publisher`,
        title: `${publisher} publishes ${t[2]} as ${subscriber} expects`,
        name: "",
        role: "provider",
        ...shared,
        checks: [
          `${publisher} publishes to ${t[2]}`,
          ...(fields.length ? [`the message carries ${fields.join(", ")}`] : []),
        ],
      },
    ];
  }
  if (!hop.method || !hop.path) return [];
  const route = hopRoutes(ctx.files, hop)
    .map((id) => ctx.get("GatewayRoute", id))
    .find((r) => r !== undefined);
  const consumerPath = route ? `${route.basepath.replace(/\/+$/, "")}${hop.path}` : hop.path;
  const gaps: string[] = [];
  const req: string[] = [];
  const res: string[] = [];
  const read = hop.method === "GET" || hop.method === "DELETE" || hop.method === "HEAD";
  for (const f of fields) {
    const top = f.split(/[.[]/)[0]!;
    if (op?.requestFields.includes(top)) req.push(f);
    else if (op?.responseFields.includes(top)) res.push(f);
    else {
      (read ? res : req).push(f);
      if (op)
        gaps.push(
          `The consumer maps ${f}, which ${hop.callee}'s spec (${op.source}) doesn't define.`,
        );
    }
  }
  if (!op)
    gaps.push(
      tried.length
        ? `${tried.join(", ")} ${tried.length === 1 ? "has" : "have"} no ${hop.method} ${hop.path}: the provider's side can't be checked until the spec has it.`
        : `No spec for ${hop.callee} was found (interfaces.md contract: ${hop.contract.trim() || "none"}): the provider's side can't be checked.`,
    );
  const statuses = new Set((op?.route.responses ?? []).map((r) => r.status));
  for (const e of errors)
    if (op && !statuses.has(e.status))
      gaps.push(
        `The design says ${hop.method} ${hop.path} answers ${e.status}, which the spec doesn't document.`,
      );
  const okStatus = op ? String(op.route.status) : undefined;
  const required = op?.route.body?.schema?.required ?? [];
  const shared = {
    ...common,
    consumer: hop.caller,
    provider: hop.callee,
    method: hop.method,
    path: hop.path,
    consumerPath,
    request: {
      fields: req,
      ...(op?.requestExample !== undefined ? { example: op.requestExample } : {}),
    },
    response: {
      ...(okStatus ? { status: okStatus } : {}),
      fields: res,
      ...(op?.route.responses.find((r) => /^2/.test(r.status))?.body !== undefined
        ? { example: op!.route.responses.find((r) => /^2/.test(r.status))!.body }
        : {}),
    },
    errors,
    gaps,
    ...(op ? { spec: op.source } : {}),
  };
  return [
    {
      type: "contract",
      id: `${base}.consumer`,
      title: `${hop.caller} calls ${hop.method} ${consumerPath} as ${hop.callee}'s contract says`,
      name: "",
      role: "consumer",
      ...shared,
      checks: [
        `${hop.caller} sends ${hop.method} ${consumerPath}${req.length ? ` with ${req.join(", ")}` : ""}`,
        ...(res.length ? [`it reads ${res.join(", ")} from the answer`] : []),
        ...errors.map((e) => `it handles ${e.status}${e.code ? ` ${e.code}` : ""}`),
      ],
    },
    {
      type: "contract",
      id: `${base}.provider`,
      title: `${hop.callee} serves ${hop.method} ${hop.path} as ${hop.caller} expects`,
      name: "",
      role: "provider",
      ...shared,
      checks: [
        `${hop.callee} serves ${hop.method} ${hop.path}`,
        ...(required.length ? [`it requires ${required.join(", ")}`] : []),
        ...(okStatus
          ? [`it answers ${okStatus}${res.length ? ` with ${res.join(", ")}` : ""}`]
          : []),
        ...errors.map((e) => `it answers ${e.status}${e.code ? ` with ${e.code}` : ""}`),
      ],
    },
  ];
}

// ------------------------------------------------------------------ data and event cases

function dataCases(d: DataChange): { cases: DataCase[]; gaps: string[] } {
  const common = { store: d.store, table: d.table, tableId: d.tableId };
  const cases: DataCase[] = [];
  const gaps: string[] = [];
  const base = `data.${slug(d.table)}`;
  if (d.newTable) {
    cases.push({
      type: "data",
      id: `${base}.table`,
      title: `table ${d.table} exists with its columns`,
      name: "",
      kind: "table",
      ...common,
      columns: d.newColumns,
      checks: [
        `${d.store} has table ${d.table}`,
        ...d.newColumns.map((c) => `column ${c.name} is ${c.type}`),
      ],
    });
  } else {
    for (const c of d.newColumns) {
      const m = new RegExp(`add column\\s+${c.name}\\s+[\\w(),]+([^,;]*)`, "i").exec(d.change);
      const rest = m?.[1] ?? "";
      const notNull = /\bnot null\b/i.test(rest);
      const def = /\bdefault\s+('[^']*'|\S+)/i.exec(rest)?.[1];
      cases.push({
        type: "data",
        id: `${base}.${slug(c.name)}`,
        title: `column ${d.table}.${c.name} exists as ${c.type}`,
        name: "",
        kind: "column",
        ...common,
        column: c.name,
        columnType: c.type,
        ...(notNull ? { notNull } : {}),
        ...(def ? { default: def } : {}),
        checks: [
          `${d.table}.${c.name} is ${c.type}`,
          ...(notNull ? [`${d.table}.${c.name} is not null`] : []),
          ...(def ? [`existing rows get ${def}`] : []),
        ],
      });
    }
  }
  if (d.migration)
    cases.push({
      type: "data",
      id: `${base}.migration`,
      title: `migration ${d.migration} applies on a copy of ${d.store}`,
      name: "",
      kind: "migration",
      ...common,
      migration: d.migration,
      checks: [
        `${d.migration} applies cleanly on a copy of ${d.store}`,
        `afterwards ${d.newTable ? `table ${d.table} exists` : `${d.newColumns.map((c) => `${d.table}.${c.name}`).join(", ")} exist`}`,
      ],
    });
  else if (d.newTable || d.newColumns.length)
    gaps.push(`data.md names no migration for ${d.table}: the migration test can't be generated.`);
  return { cases, gaps };
}

function eventCases(hop: Hop, fields: string[], firstWhen?: string): EventCase[] {
  const t = topicOf(hop.operation);
  if (!t) return [];
  const publish = /^(publish|send)$/i.test(t[1]!);
  const publisher = publish ? hop.caller : hop.callee;
  const subscriber = publish ? hop.callee : hop.caller;
  const base = `event.${slug(t[2]!)}`;
  const common = {
    topic: t[2]!,
    publisher,
    subscriber,
    fields,
    ...(/^if-/.test(hop.id) ? { interfaceId: hop.id } : {}),
  };
  return [
    {
      type: "event",
      id: `${base}.publish`,
      title: `${publisher} publishes ${t[2]}${firstWhen ? ` when ${firstWhen}` : ""}`,
      name: "",
      role: "publisher",
      ...common,
      checks: [
        `a message is published to ${t[2]}${firstWhen ? ` when ${firstWhen}` : ""}`,
        ...(fields.length ? [`it carries ${fields.join(", ")}`] : []),
      ],
    },
    {
      type: "event",
      id: `${base}.consume`,
      title: `${subscriber} handles ${t[2]}`,
      name: "",
      role: "subscriber",
      ...common,
      checks: [
        `${subscriber} processes a message from ${t[2]} once, even if it is delivered twice`,
      ],
    },
  ];
}

// ------------------------------------------------------------------ the model

export function buildTestModel(
  ctx: PlanContext,
  story: StoryContext,
  changeRepos: ChangeRepos | undefined,
): TestModel {
  const required = ctx.tests.required as StrategyKind[];
  const row = ctx.tests.row ? `${ctx.tests.row.changeType}/${ctx.tests.row.risk}` : undefined;
  const kinds: TestModel["kinds"] = [
    { type: "acceptance", generated: true, why: "Every acceptance criterion gets a scenario." },
  ];
  for (const [type, needs] of Object.entries(NEEDS) as [
    Exclude<CaseType, "acceptance">,
    StrategyKind[],
  ][]) {
    const hit = needs.filter((n) => required.includes(n));
    kinds.push({
      type,
      generated: hit.length > 0,
      why: hit.length
        ? `test-strategy.yaml${row ? ` (${row})` : ""} asks for ${hit.join(", ")}.`
        : `test-strategy.yaml${row ? ` (${row})` : ""} asks for ${required.join(", ") || "nothing"}, not ${needs.join(" or ")}.`,
    });
  }
  const on = (t: CaseType) => kinds.find((k) => k.type === t)!.generated;
  const notes: string[] = [];
  const gaps: string[] = [];
  if (ctx.tests.note) notes.push(ctx.tests.note);
  if (story.linkedBy === "inferred")
    notes.push(
      `${story.id} has no links section: its interfaces and data changes were found by what it mentions.`,
    );

  // Acceptance cases from the criteria.
  const accTags = (["e2e", "regression", "accessibility"] as StrategyKind[]).filter((k) =>
    required.includes(k),
  );
  const acceptance: AcceptanceCase[] = story.criteria.map((c) => ({
    type: "acceptance",
    id: `acceptance.c${c.n}`,
    title: c.trace?.name || `Criterion ${c.n}`,
    name: "",
    criterion: c.n,
    given: c.given,
    when: c.when,
    then: c.then,
    text: c.text,
    ...(c.trace ? { trace: c.trace } : {}),
    tags: accTags,
  }));
  if (!story.criteria.length)
    gaps.push(`${story.id} has no acceptance criteria: no scenario was generated.`);

  // Every repo the story or its hops and data reach, with its place and component.
  const places = new Map<string, RepoPlace>();
  const allRepos = new Set<string>(story.repos);
  for (const h of story.hops)
    for (const c of [h.caller, h.callee]) {
      const r = ctx.repoOf(c);
      if (r) allRepos.add(r);
    }
  const ownerRepo = (d: DataChange) => {
    const s = ctx.get("DataStore", d.store);
    return s?.ownerComponent ? ctx.repoOf(s.ownerComponent) : undefined;
  };
  for (const d of story.data) {
    const r = ownerRepo(d);
    if (r) allRepos.add(r);
  }
  for (const r of allRepos) places.set(r, repoPlace(ctx, story, r, changeRepos));
  const repoCases = new Map<string, TestCase[]>([...allRepos].map((r) => [r, []]));
  const add = (repo: string | undefined, cs: TestCase[]) => {
    if (!repo || !cs.length) return false;
    repoCases.set(repo, [...(repoCases.get(repo) ?? []), ...cs]);
    return true;
  };
  const elsewhere: ContractCase[] = [];

  for (const h of story.hops) {
    const calleeRepo = ctx.repoOf(h.callee);
    const isRest = !!h.method && !!h.path && !topicOf(h.operation);
    const found = isRest ? findOperation(ctx, h, places) : { tried: [] as string[] };
    const op = found.op;
    if (isRest && on("api")) {
      if (calleeRepo) {
        const a = apiCases(h, op, endpointFor(ctx, h), acceptance);
        add(calleeRepo, a.cases);
        notes.push(...a.notes);
      } else
        notes.push(
          `${h.callee} has no repo here, so its ${h.method} ${h.path} gets no API tests; ${h.caller}'s contract tests cover the call.`,
        );
    }
    if (on("contract")) {
      for (const c of contractCases(ctx, h, op, found.tried)) {
        const repo = ctx.repoOf(c.role === "consumer" ? c.consumer : c.provider);
        if (!add(repo, [c])) elsewhere.push(c);
        if (c.role === "provider") gaps.push(...c.gaps);
      }
    }
    if (on("event") && topicOf(h.operation)) {
      const evs = eventCases(h, mappedFields(ctx.mapping(h)), story.criteria[0]?.when);
      for (const e of evs)
        add(ctx.repoOf(e.role === "publisher" ? e.publisher : e.subscriber), [e]);
    }
  }
  if (on("data"))
    for (const d of story.data) {
      const dc = dataCases(d);
      const repo = ownerRepo(d);
      if (!add(repo, dc.cases) && dc.cases.length)
        notes.push(`No repo owns ${d.store}, so the data tests for ${d.table} were not written.`);
      gaps.push(...dc.gaps);
    }

  const primary =
    story.repos.find((r) => places.has(r)) ??
    [...repoCases.keys()].find((r) => repoCases.get(r)!.length);
  if (primary) repoCases.set(primary, [...acceptance, ...(repoCases.get(primary) ?? [])]);
  const repos: RepoTests[] = [];
  for (const [repo, cases] of repoCases) {
    if (!cases.length) continue;
    const place = places.get(repo) ?? { repo, kind: "none" as const };
    const manifest = ctx.lifecycle.orgPack.profiles
      .flatMap((p) => p.repos?.repos ?? [])
      .find((r) => r.id === repo);
    const language = languageOf(place, manifest?.type);
    const component = ctx.componentOfRepo(repo);
    repos.push({
      repo,
      ...(component ? { component } : {}),
      ...(language ? { language } : {}),
      ...(language === "node" ? { runner: nodeRunner(place) } : {}),
      place,
      primary: repo === primary,
      cases,
    });
  }
  if (!primary && acceptance.length)
    repos.push({ repo: "", place: { repo: "", kind: "none" }, primary: true, cases: acceptance });
  return {
    change: ctx.change.id,
    story: {
      id: story.id,
      path: story.path,
      title: story.title,
      ...(story.parsed.who
        ? {
            asA: story.parsed.who.asA,
            iWant: story.parsed.who.iWant,
            soThat: story.parsed.who.soThat,
          }
        : {}),
      ...(story.tracesTo ? { tracesTo: story.tracesTo } : {}),
    },
    strategy: {
      required,
      ...(row ? { row } : {}),
      ...(ctx.tests.note ? { note: ctx.tests.note } : {}),
    },
    kinds,
    repos: repos.sort(
      (a, b) => Number(b.primary) - Number(a.primary) || a.repo.localeCompare(b.repo),
    ),
    elsewhere,
    linkedBy: story.linkedBy,
    notes: [...new Set(notes)],
    gaps: [...new Set(gaps)],
  };
}

/** Every case of the model, in repo order. */
export const allCases = (m: TestModel): TestCase[] => [
  ...m.repos.flatMap((r) => r.cases),
  ...m.elsewhere,
];
