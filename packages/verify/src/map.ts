import { posix } from "node:path";
import {
  toCanonicalYaml,
  type CatalogRecord,
  type FlowRecord,
  type RecordOf,
} from "@maycombhq/core";
import { flowSequenceView, toMermaid } from "@maycombhq/diagrams";

/**
 * The map of one repo (ADR 0124, A3b): what a developer reviews in a PR, rendered from the
 * repo's projected C1 records (never from the facts directly), so anything that reads the
 * catalog and the map agree. Three kinds of file, under `map/<repo>/` (`.atticus/map/<repo>/`
 * when adopted):
 *
 * - `map.md`: a trust line from the verifier's report, then what the repo serves (by
 *   component), what it calls (by target), what it stores (tables, who reads and writes, the
 *   columns), where it runs, the config that names other systems, its flows and contracts, and
 *   the open questions about it. Every line of a fact links to its file and line.
 * - `flows/<flow>.md`: each flow's steps in order, with what, refs, fields and the cited line,
 *   its error paths, and a Mermaid sequence diagram (ADR 0092's lanes).
 * - `contracts/<component>.openapi.yaml`: OpenAPI 3.1 for the component's REST entries, bodies
 *   from the Schema records. Events are listed in map.md (no AsyncAPI is written).
 *
 * Pure and deterministic: the same records, flows, report and questions give the same bytes,
 * whatever order they come in.
 */

/** The verifier's report, as the trust line says it. */
export interface MapTrust {
  accepted: number;
  rejected: number;
  /** read / (read + reviewed + unknown). */
  ratio: number;
  unknown: number;
  /** Files the reader read and found no fact in (ADR 0124 addendum A-read); left out when none. */
  reviewed?: number;
  commit?: string;
}

/** An open question about the repo (ADR 0078). */
export interface MapQuestion {
  id: string;
  question: string;
  /** path:line, as the question cites them. */
  evidence: string[];
}

/**
 * Where a line of the repo's code is, as a link from a file of the map. `from` is the map file's
 * path relative to the metarepo root, for a relative link.
 */
export type CodeLink = (
  path: string,
  line: number | undefined,
  commit: string | undefined,
  from: string,
) => string;

export interface RenderMapInput {
  repo: string;
  /** The catalog (catalog/generated), or at least the repo's records and what they name. */
  records: readonly CatalogRecord[];
  /** The repo's flows (specs/<repo>/). */
  flows: readonly FlowRecord[];
  trust?: MapTrust;
  /** What the repo is, as the manifest says (ADR 0128); left out when nothing says. */
  about?: { text: string; trust: "suggested" | "verified"; by?: string };
  /**
   * What the repo is built on, from its framework facts (ADR 0124 addendum A-framework), with
   * the frameworks whose patterns the facts show none of. Read from the facts, not the catalog:
   * no C1 record holds a framework. Left out when the facts name none.
   */
  frameworks?: {
    built: readonly { name: string; version?: string; component?: string; cite: Ev }[];
    gaps?: readonly { framework: string; question: string }[];
  };
  /** The open questions about the repo. */
  questions?: readonly MapQuestion[];
  /** Folders relative to the metarepo root: the map's (`map/<repo>`), questions/ and the repo's specs. */
  paths: { map: string; questions: string; specs: string };
  codeLink: CodeLink;
}

type Rec<K extends CatalogRecord["kind"]> = RecordOf<K>;
type Ev = { repo?: string; path?: string; line?: number; commit?: string; side?: string };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const HEADER = (repo: string, what: string) =>
  `<!-- Rendered by atticus map render ${repo} from ${what} (ADR 0124). Don't edit: correct the facts and run atticus verify ${repo} --write. -->`;

/**
 * The trust line's numbers from `<repo>.verify.yaml` (the verifier's report, parsed), or
 * undefined when it isn't one.
 */
export function trustOf(report: unknown): MapTrust | undefined {
  const r = report as {
    accepted?: unknown;
    rejected?: unknown;
    commit?: unknown;
    coverage?: { ratio?: unknown; unknown?: unknown; reviewed?: unknown };
  } | null;
  if (!r || typeof r.accepted !== "number" || typeof r.rejected !== "number") return undefined;
  const ratio = typeof r.coverage?.ratio === "number" ? r.coverage.ratio : 0;
  const unknown = Array.isArray(r.coverage?.unknown) ? r.coverage.unknown.length : 0;
  const commit = typeof r.commit === "string" ? r.commit : undefined;
  const reviewed = typeof r.coverage?.reviewed === "number" ? r.coverage.reviewed : 0;
  return {
    accepted: r.accepted,
    rejected: r.rejected,
    ratio,
    unknown,
    ...(reviewed > 0 ? { reviewed } : {}),
    ...(commit ? { commit } : {}),
  };
}

/**
 * A linker for the repo's code: by the clone URL in the manifest (a GitHub- or GitLab-style
 * `/blob/<commit>/<path>#L<line>`, or Azure DevOps' `?path=&version=GC<commit>&line=`), else a
 * path relative to the map file into the folder that holds the code (`dir`, relative to the
 * metarepo root: "" for a repo adopted in place, `workspace/<repo>` for a base clone).
 */
export function codeLinkerFor(o: { url?: string; dir?: string }): CodeLink {
  let web: string | undefined;
  const url = o.url?.trim();
  if (url && /^https?:\/\//i.test(url)) web = url;
  else if (url) {
    const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(url);
    if (scp) web = `https://${scp[1]}/${scp[2]}`;
  }
  if (web) {
    const base = web.replace(/\/+$/, "").replace(/\.git$/, "");
    const ado = /(^https?:\/\/dev\.azure\.com\/)|(\.visualstudio\.com\/)/i.test(base);
    return (path, line, commit) => {
      const p = encodeURI(path);
      if (ado)
        return `${base}?path=/${p}${commit ? `&version=GC${commit}` : ""}${line ? `&line=${line}` : ""}`;
      return `${base}/blob/${commit ?? "HEAD"}/${p}${line ? `#L${line}` : ""}`;
    };
  }
  const dir = (o.dir ?? "").replace(/\/+$/, "");
  return (path, line, _commit, from) => {
    const target = dir ? `${dir}/${path}` : path;
    const rel = posix.relative(posix.dirname(from), target);
    return `${encodeURI(rel)}${line ? `#L${line}` : ""}`;
  };
}

// ---------------------------------------------------------------------------------------------

interface Ctx {
  i: RenderMapInput;
  comps: Set<string>;
  byId: Map<string, CatalogRecord>;
  /** The map file being written, relative to the metarepo root. */
  from: string;
}

/** The first evidence from the repo itself: the line a map line links to. */
function ownEvidence(r: { evidence: readonly unknown[] }, repo: string): Ev | undefined {
  const ev = (r.evidence as Ev[]).filter((e) => e.path && (!e.repo || e.repo === repo));
  return ev[0];
}

function cite(c: Ctx, e: Ev | undefined): string {
  if (!e?.path) return "(no citation)";
  const commit = e.commit ?? c.i.trust?.commit;
  const at = `${e.path}${e.line ? `:${e.line}` : ""}`;
  return `[${at}](${c.i.codeLink(e.path, e.line, commit, c.from)})`;
}

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
const list = (xs: readonly string[]) => xs.join(", ");
const pct = (r: number) => `${Math.round(r * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function records<K extends CatalogRecord["kind"]>(c: Ctx, kind: K): Rec<K>[] {
  return (c.i.records.filter((r) => r.kind === kind) as Rec<K>[]).sort((a, b) => cmp(a.id, b.id));
}

function link(from: string, to: string): string {
  return encodeURI(posix.relative(posix.dirname(from), to));
}

function questionsFor(c: Ctx, e: Ev | undefined): MapQuestion[] {
  if (!e?.path || !e.line) return [];
  const at = `${e.path}:${e.line}`;
  return (c.i.questions ?? []).filter((q) => q.evidence.includes(at));
}

function asked(c: Ctx, e: Ev | undefined): string {
  const qs = questionsFor(c, e).sort((a, b) => cmp(a.id, b.id));
  if (!qs.length) return "";
  return ` Asked: ${qs.map((q) => `[${q.question}](${link(c.from, `${c.i.paths.questions}/${q.id}.yaml`)})`).join("; ")}`;
}

// ---------------------------------------------------------------- map.md sections

function serves(c: Ctx): string[] {
  const eps = records(c, "Endpoint").filter((e) => c.comps.has(e.component));
  if (!eps.length) return ["Nothing read yet."];
  const out: string[] = [];
  for (const comp of [...new Set(eps.map((e) => e.component))].sort(cmp)) {
    out.push(`### ${comp}`, "");
    const mine = eps
      .filter((e) => e.component === comp)
      .sort(
        (a, b) =>
          cmp(a.pathOrTopic, b.pathOrTopic) ||
          cmp(a.method ?? "", b.method ?? "") ||
          cmp(a.id, b.id),
      );
    for (const e of mine) {
      const what = [e.method, e.pathOrTopic].filter(Boolean).join(" ");
      const notes = [e.endpointType, ...(e.auth ? [`auth ${e.auth}`] : [])];
      for (const side of ["request", "response"] as const) {
        const s = c.byId.get(`${e.id}.${side}`);
        if (s?.kind === "Schema" && s.fields.length)
          notes.push(`${side}: ${list(s.fields.map((f) => f.name))}`);
      }
      out.push(`- ${code(what)} (${notes.join("; ")}): ${cite(c, ownEvidence(e, c.i.repo))}`);
    }
    out.push("");
  }
  return out.slice(0, -1);
}

const LOOSE_CALLS = new Set(["http-call", "call", "event-publish", "graphql-call", "grpc-call"]);

function targetName(c: Ctx, id: string): string {
  const r = c.byId.get(id);
  if (r?.kind === "System") return `${id} (${r.name}, ${r.boundary})`;
  if (r?.kind === "Component") return `${id} (${r.system}${r.repo ? `, ${r.repo}` : ""})`;
  return id;
}

/**
 * The gateway hops a joined call passes through, in order (ADR 0124 addendum A-gateway2): the
 * GatewayRoute records the Interface cites on its gateway side, matched by the line each rests
 * on. Empty when the catalog has no route for the hop, so the line reads as it did before.
 */
function gatewayHops(c: Ctx, i: Rec<"Interface">): Rec<"GatewayRoute">[] {
  if (i.via !== "gateway") return [];
  const order = (i.evidence as Ev[])
    .filter((e) => e.side === "gateway" && e.path)
    .map((e) => `${e.repo ?? ""}|${e.path}:${e.line}`);
  if (!order.length) return [];
  return records(c, "GatewayRoute")
    .flatMap((r) => {
      const own = (r.evidence as Ev[])[0];
      const at = own?.path ? `${own.repo ?? ""}|${own.path}:${own.line}` : "";
      const n = order.indexOf(at);
      return n < 0 ? [] : [{ r, n }];
    })
    .sort((a, b) => a.n - b.n || cmp(a.r.id, b.r.id))
    .map((x) => x.r);
}

/** One hop as the map says it: the proxy and its base path, what it checks, the scopes it wants. */
function hopText(r: Rec<"GatewayRoute">): string {
  const what = [
    ...(r.policies.length ? [list(r.policies)] : []),
    r.scopes.length ? `scopes ${list(r.scopes)}` : "no scope",
  ];
  return `${r.proxy} ${r.basepath} (${what.join("; ")})`;
}

function calls(c: Ctx): string[] {
  const ifs = records(c, "Interface").filter((i) => c.comps.has(i.from));
  const loose = records(c, "Unresolved").filter(
    (u) => u.owner && c.comps.has(u.owner) && LOOSE_CALLS.has(u.unresolvedKind),
  );
  if (!ifs.length && !loose.length) return ["Nothing read yet."];
  const out: string[] = [];
  for (const to of [...new Set(ifs.map((i) => i.to))].sort(cmp)) {
    out.push(`### ${targetName(c, to)}`, "");
    for (const i of ifs
      .filter((x) => x.to === to)
      .sort((a, b) => cmp(a.normalizedPath ?? "", b.normalizedPath ?? "") || cmp(a.id, b.id))) {
      const what = [i.method, i.normalizedPath].filter(Boolean).join(" ");
      const req = c.byId.get(`${i.id}.request`);
      // A-gateway2: the whole path of the call, each hop with what it checks and the scopes it
      // demands, so a reader sees where a token has to be good enough and where it isn't.
      const hops = gatewayHops(c, i);
      const notes = [
        `from ${i.from}`,
        i.sync,
        hops.length ? `via ${hops.map(hopText).join(" then ")}` : `via ${i.via}`,
        ...(hops.length && i.auth ? [`the caller meets ${i.auth}`] : []),
        ...(i.endpoint ? [`reaches ${i.endpoint}`] : []),
        ...(req?.kind === "Schema" && req.fields.length
          ? [`sends ${list(req.fields.map((f) => f.name))}`]
          : []),
      ];
      const e =
        (i.evidence as Ev[]).find((x) => x.side === "caller" && x.repo === c.i.repo) ??
        ownEvidence(i, c.i.repo);
      out.push(`- ${code(what || i.id)} (${notes.join("; ")}): ${cite(c, e)}`);
    }
    out.push("");
  }
  if (loose.length) {
    out.push("### Not joined yet", "");
    for (const u of loose.sort((a, b) => cmp(a.raw, b.raw) || cmp(a.id, b.id))) {
      const e = ownEvidence(u, c.i.repo);
      out.push(
        `- ${code(u.raw)} (from ${u.owner}; ${u.unresolvedKind}): ${cite(c, e)}.${asked(c, e)}`,
      );
    }
    out.push("");
  }
  return out.slice(0, -1);
}

function stores(c: Ctx): string[] {
  const tables = records(c, "Table").filter(
    (t) =>
      (t.ownerComponent && c.comps.has(t.ownerComponent)) ||
      t.readers.some((x) => c.comps.has(x)) ||
      t.writers.some((x) => c.comps.has(x)),
  );
  if (!tables.length) return ["Nothing read yet."];
  const columns = records(c, "Column");
  const out: string[] = [];
  for (const ds of [...new Set(tables.map((t) => t.dataStore))].sort(cmp)) {
    const store = c.byId.get(ds);
    out.push(`### ${ds}${store?.kind === "DataStore" ? ` (${store.storeType})` : ""}`, "");
    for (const t of tables.filter((x) => x.dataStore === ds)) {
      const how = [
        ...(t.readers.length ? [`read by ${list(t.readers)}`] : []),
        ...(t.writers.length ? [`written by ${list(t.writers)}`] : []),
      ];
      out.push(
        `- ${code(t.name)} (${t.tableKind}${how.length ? `; ${how.join("; ")}` : ""}): ${cite(c, ownEvidence(t, c.i.repo))}`,
      );
      for (const col of columns
        .filter((x) => x.table === t.id)
        .sort((a, b) => cmp(a.name, b.name))) {
        const notes = [
          col.type,
          ...(col.nullable === false ? ["not null"] : []),
          ...(col.classification ? [col.classification] : []),
        ];
        out.push(
          `  - ${code(col.name)} (${notes.join("; ")}): ${cite(c, ownEvidence(col, c.i.repo))}`,
        );
      }
    }
    out.push("");
  }
  return out.slice(0, -1);
}

function deploys(c: Ctx): string[] {
  const ds = records(c, "Deployment").filter((d) => c.comps.has(d.component));
  if (!ds.length) return ["Nothing read yet."];
  return ds.map((d) => {
    const notes = [
      `env ${d.env}`,
      ...(d.replicas !== undefined ? [plural(d.replicas, "replica")] : []),
    ];
    return `- ${code(d.component)} on ${d.platform} (${notes.join("; ")}): ${cite(c, ownEvidence(d, c.i.repo))}`;
  });
}

const NAMES_A_SYSTEM = /^[a-z][a-z0-9+.-]*:\/\//i;

function config(c: Ctx): string[] {
  const ss = records(c, "Setting").filter(
    (s) => c.comps.has(s.component) && (s.target || NAMES_A_SYSTEM.test(s.valueOrRef)),
  );
  if (!ss.length) return ["Nothing read yet."];
  return ss
    .sort((a, b) => cmp(a.key, b.key) || cmp(a.id, b.id))
    .map((s) => {
      const notes = [s.settingKind, `in ${s.component}`, ...(s.target ? [`for ${s.target}`] : [])];
      return `- ${code(`${s.key} = ${s.valueOrRef}`)} (${notes.join("; ")}): ${cite(c, ownEvidence(s, c.i.repo))}`;
    });
}

const flowFile = (f: FlowRecord) => `flows/${f.id}.md`;

function flowsList(c: Ctx): string[] {
  if (!c.i.flows.length) return ["Nothing read yet."];
  return sortedFlows(c.i.flows).map((f) => {
    const notes = [
      `starts at ${code(f.trigger.what)}`,
      plural(f.steps.length, "step"),
      plural(f.errors.length, "error path"),
    ];
    return `- [${f.name}](${flowFile(f)}) (${notes.join("; ")}): ${cite(c, (f.trigger.evidence as Ev[])[0])}`;
  });
}

function contracts(c: Ctx, files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [rel] of Object.entries(files).filter(([k]) => k.startsWith("contracts/"))) {
    const comp = rel.slice("contracts/".length, -".openapi.yaml".length);
    const n = restEndpoints(c, comp).length;
    out.push(
      `- [${rel.slice("contracts/".length)}](${rel}): OpenAPI 3.1, ${plural(n, "REST entry", "REST entries")} of ${comp}`,
    );
  }
  const events = records(c, "Endpoint").filter(
    (e) =>
      c.comps.has(e.component) &&
      (e.endpointType === "event-topic" || e.endpointType === "mq-queue"),
  );
  const publishes = records(c, "Interface").filter(
    (i) => c.comps.has(i.from) && i.sync === "async",
  );
  if (events.length || publishes.length) {
    out.push("", "Events (listed here; no AsyncAPI file is written):", "");
    for (const e of events)
      out.push(
        `- ${code(e.pathOrTopic)} (${e.endpointType}, listened to by ${e.component}): ${cite(c, ownEvidence(e, c.i.repo))}`,
      );
    for (const i of publishes)
      out.push(
        `- ${code(i.normalizedPath ?? i.id)} (published by ${i.from} to ${i.to}): ${cite(c, ownEvidence(i, c.i.repo))}`,
      );
  }
  return out.length ? out : ["Nothing read yet."];
}

function openQuestions(c: Ctx): string[] {
  const qs = [...(c.i.questions ?? [])].sort(
    (a, b) => cmp(a.question, b.question) || cmp(a.id, b.id),
  );
  if (!qs.length) return ["None open."];
  return qs.map(
    (q) =>
      `- [${q.question}](${link(c.from, `${c.i.paths.questions}/${q.id}.yaml`)}): cites ${list(q.evidence.map((e) => code(e)))}`,
  );
}

/**
 * What the repo is, in a person's words (ADR 0128), above the trust line: said to be a note, and
 * marked unconfirmed when it is a draft the assistant wrote and nobody has confirmed.
 */
function aboutLine(a: RenderMapInput["about"], repo: string): string[] {
  if (!a) return [`**What it is:** Nothing says yet: \`atticus repo describe ${repo}\`.`, ""];
  const who = a.by ? `, ${a.by}` : "";
  return [
    a.trust === "suggested"
      ? `**What it is (unconfirmed draft${who}):** ${a.text} — drafted from the code and waiting for a person: \`atticus repo describe ${repo} --accept\`.`
      : `**What it is${who ? ` (${a.by})` : ""}:** ${a.text}`,
    "",
    "A person's note from the manifest, not read from the code: where the two disagree, the facts below are what the code says.",
    "",
  ];
}

/**
 * What the repo is built on (ADR 0124 addendum A-framework), beside what it is: each framework
 * with its version as declared and a link to the build file's line, and, where the facts show
 * none of a framework's patterns, the question that raises.
 */
function builtOnLine(c: Ctx): string[] {
  const f = c.i.frameworks;
  if (!f?.built.length) return [];
  const one = (b: NonNullable<RenderMapInput["frameworks"]>["built"][number]) =>
    `${b.name}${b.version ? ` ${b.version}` : ""}${b.component ? ` (${b.component})` : ""} ${cite(c, b.cite)}`;
  return [
    `**Built on:** ${f.built.map(one).join(", ")} — read from the build files, each on the line that declares it.`,
    "",
    ...(f.gaps?.length
      ? [
          ...f.gaps.map(
            (g) => `**Open: ${g.framework} shows none of its patterns here.** ${g.question}`,
          ),
          "",
        ]
      : []),
  ];
}

function trustLine(t: MapTrust | undefined, repo: string): string {
  if (!t) return `**Trust:** No verify report yet: run \`atticus verify ${repo}\`.`;
  return `**Trust:** ${plural(t.accepted, "fact")} verified on their lines; coverage ${pct(t.ratio)} of source files (${plural(t.unknown, "unknown file")}: cited by no fact and opened through no Atticus tool)${t.reviewed ? `; ${plural(t.reviewed, "file")} reviewed by the reader with nothing to record (each with why, in the verify report)` : ""}; ${t.rejected} rejected.${t.commit ? ` Commit ${t.commit}.` : ""}`;
}

// ---------------------------------------------------------------- flows/<flow>.md

const sortedFlows = (fs: readonly FlowRecord[]) => [...fs].sort((a, b) => cmp(a.id, b.id));

const CONFIRMED: Record<string, string> = {
  check: "Confirmed by the line check",
  ai: "Confirmed by the assistant's check",
  person: "Confirmed by a person",
};

function flowPage(c: Ctx, f: FlowRecord): string {
  const spec = `${c.i.paths.specs}/${f.id}.yaml`;
  const out = [
    `# ${f.name}`,
    "",
    HEADER(c.i.repo, spec),
    "",
    `- Component: ${f.component}`,
    `- Starts at: ${f.trigger.kind} ${code(f.trigger.what)}${f.trigger.ref ? ` (${code(f.trigger.ref)})` : ""}: ${cite(c, (f.trigger.evidence as Ev[])[0])}`,
    `- Spec: [${posix.basename(spec)}](${link(c.from, spec)})`,
    "",
    "## Steps",
    "",
  ];
  f.steps.forEach((s, n) => {
    const head =
      s.to && (s.kind === "call-out" || s.kind === "publish")
        ? ` to ${s.to.component} ${code(s.to.entry)}`
        : s.store
          ? ` ${code(s.store.table)}`
          : "";
    out.push(`${n + 1}. **${s.kind}**${head}: ${s.what}. ${cite(c, (s.evidence as Ev[])[0])}`);
    const fields: string[] = [];
    const d = s.data;
    if (d)
      for (const k of ["sends", "returns", "reads", "checks", "from", "to"] as const) {
        const names = d[k] ?? [];
        if (names.length) fields.push(`${k} ${list(names)}`);
      }
    if (s.store?.columns.length) fields.push(`columns ${list(s.store.columns)}`);
    if (fields.length) out.push(`   - Fields: ${fields.join("; ")}`);
    if (s.refs.length) out.push(`   - Refs: ${list(s.refs.map(code))}`);
    out.push(`   - ${s.confirmedBy ? CONFIRMED[s.confirmedBy] : "Not confirmed yet"}`);
  });
  out.push("", "## Errors", "");
  if (!f.errors.length) out.push("None read.");
  for (const e of f.errors)
    out.push(`- When ${e.when}: ${e.then}. ${cite(c, (e.evidence as Ev[])[0])}`);
  out.push(
    "",
    "## Sequence",
    "",
    "```mermaid",
    toMermaid(flowSequenceView(f, { source: spec })).trimEnd(),
    "```",
    "",
  );
  return out.join("\n");
}

// ---------------------------------------------------------------- contracts

function restEndpoints(c: Ctx, comp: string): Rec<"Endpoint">[] {
  return records(c, "Endpoint").filter((e) => e.component === comp && e.endpointType === "rest");
}

const OPENAPI_KEYS = [
  "openapi",
  "info",
  "title",
  "version",
  "description",
  "paths",
  "operationId",
  "summary",
  "parameters",
  "name",
  "in",
  "required",
  "requestBody",
  "responses",
  "content",
  "schema",
  "type",
  "properties",
  "items",
];

/** A field type as the code names it, as a JSON Schema type for OpenAPI. */
function jsonType(t: string | undefined): Record<string, unknown> {
  const x = (t ?? "").toLowerCase().replace(/\(.*$/, "").trim();
  if (/^(int|integer|long|short|bigint|smallint|int32|int64|byte)$/.test(x))
    return { type: "integer" };
  if (/^(decimal|numeric|number|double|float|real|bigdecimal|money)$/.test(x))
    return { type: "number" };
  if (/^(bool|boolean)$/.test(x)) return { type: "boolean" };
  if (/(\[\]$)|^(list|array|set)\b/.test(x)) return { type: "array", items: {} };
  if (!x || /^(string|str|text|varchar|char|uuid|date|datetime|timestamp|instant)$/.test(x))
    return { type: "string" };
  return { type: "string", "x-atticus-type": t };
}

function bodyOf(s: CatalogRecord | undefined): Record<string, unknown> | undefined {
  if (s?.kind !== "Schema" || !s.fields.length) return undefined;
  const properties: Record<string, unknown> = {};
  for (const f of [...s.fields].sort((a, b) => cmp(a.name, b.name)))
    properties[f.name] = {
      ...jsonType(f.type),
      ...(f.classification ? { "x-atticus-classification": f.classification } : {}),
    };
  return { content: { "application/json": { schema: { type: "object", properties } } } };
}

/** OpenAPI 3.1 for a component's REST entries, or undefined when it has none. */
export function openApiOf(i: RenderMapInput, comp: string): string | undefined {
  const c = ctxOf(i, "");
  const eps = restEndpoints(c, comp);
  if (!eps.length) return undefined;
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of eps) {
    const params = [...e.pathOrTopic.matchAll(/\{([^}]+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    const req = bodyOf(c.byId.get(`${e.id}.request`));
    const res = bodyOf(c.byId.get(`${e.id}.response`));
    const ev = ownEvidence(e, i.repo);
    (paths[e.pathOrTopic] ??= {})[(e.method ?? "get").toLowerCase()] = {
      operationId: e.id,
      ...(params.length ? { parameters: params } : {}),
      ...(req ? { requestBody: { required: true, ...req } } : {}),
      responses: res
        ? { "200": { description: "What the code returns", ...res } }
        : { default: { description: "The response isn't read yet." } },
      ...(e.auth ? { "x-atticus-auth": e.auth } : {}),
      ...(ev?.path ? { "x-atticus-evidence": `${ev.path}${ev.line ? `:${ev.line}` : ""}` } : {}),
    };
  }
  const commit = eps.map((e) => ownEvidence(e, i.repo)?.commit).find(Boolean) ?? i.trust?.commit;
  const doc = {
    openapi: "3.1.0",
    info: {
      title: comp,
      version: commit ?? "unversioned",
      description: `The REST entries of ${comp} as ${i.repo}'s code shows them${commit ? ` at ${commit}` : ""}, from the assistant's verified facts (ADR 0124). Rendered by atticus map render ${i.repo}; don't edit.`,
    },
    paths,
  };
  return toCanonicalYaml(doc, OPENAPI_KEYS);
}

// ---------------------------------------------------------------- the whole map

function ctxOf(i: RenderMapInput, file: string): Ctx {
  const comps = new Set(
    i.records
      .filter((r): r is Rec<"Component"> => r.kind === "Component" && r.repo === i.repo)
      .map((r) => r.id),
  );
  for (const f of i.flows) comps.add(f.component);
  return {
    i,
    comps,
    byId: new Map(i.records.map((r) => [r.id, r] as const)),
    from: `${i.paths.map}/${file}`,
  };
}

/** Every file of the repo's map, by path relative to `map/<repo>/`, in path order. */
export function renderMap(i: RenderMapInput): Record<string, string> {
  const files: Record<string, string> = {};
  const base = ctxOf(i, "map.md");
  for (const comp of [...base.comps].sort(cmp)) {
    const yaml = openApiOf(i, comp);
    if (yaml) files[`contracts/${comp}.openapi.yaml`] = yaml;
  }
  for (const f of sortedFlows(i.flows)) files[flowFile(f)] = flowPage(ctxOf(i, flowFile(f)), f);
  const section = (title: string, body: string[]) => [`## ${title}`, "", ...body, ""];
  files["map.md"] = [
    `# The map of ${i.repo}`,
    "",
    HEADER(i.repo, "the catalog and its specs"),
    "",
    ...aboutLine(i.about, i.repo),
    ...builtOnLine(base),
    trustLine(i.trust, i.repo),
    "",
    ...section("What it serves", serves(base)),
    ...section("What it calls", calls(base)),
    ...section("What it stores", stores(base)),
    ...section("Where it runs", deploys(base)),
    ...section("Config that names other systems", config(base)),
    ...section("Flows", flowsList(base)),
    ...section("Contracts", contracts(base, files)),
    ...section("Open questions", openQuestions(base)),
  ].join("\n");
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => cmp(a, b)));
}
