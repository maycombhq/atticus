import { isMap, isScalar, LineCounter, parseDocument } from "yaml";
import { interfaceId, normalizePath, RecordId, type CatalogRecord } from "@maycombhq/core";
import { defineExtractor, type RepoHandle, type ScanContext } from "@maycombhq/sdk";
import { componentOf, evidence, restEndpoint } from "../facts.js";
import { get, pairs, parseYamlDoc, scalar, slug, storeFor, topicId } from "../data/common.js";
import { bullets, keyValues, parseMd, plain, section, tablesIn, type MdDoc } from "./markdown.js";

/**
 * The Spec Kit extractor (ADR 0030 point 4). Every scan reads each code repo's Spec Kit
 * features, `specs/<feature>/`, so a developer's edits to a plan are seen at once. Only
 * structure is read, never prose (scans use no AI, ADR 0007):
 *
 * - `contracts/` OpenAPI → planned rest Endpoints; AsyncAPI → planned topics.
 * - `data-model.md` entity sections with a column table or `**name**: type` bullets →
 *   planned Tables and Columns (`(new table)` / `(existing table)` in the heading).
 * - `plan.md`: the "Services this feature calls" table → planned Interfaces; the Technical
 *   Context, project structure and task list go into the feature report (see
 *   `readSpecKitFeatures`), not into records, because no C1 kind holds a stack or a file list.
 * - `tasks.md` checkboxes → one ProcessArtifact per feature (artifactType `change`) with the
 *   progress and links to the feature's planned records.
 *
 * Every record has status planned-*, confidence inferred and evidence on the Spec Kit file
 * and line, so it is never mistaken for a fact read from code. A repo is a Spec Kit repo only
 * when it has a `.specify/` folder; a bare `specs/` folder is left alone.
 */

export const SPECKIT_EXTRACTOR_VERSION = "1.0.0";

export interface SpecKitTask {
  /** Spec Kit task id (T001), when the line has one. */
  id?: string;
  done: boolean;
  line: number;
  /** The task text without the id and the [P] / [US1] markers. */
  text: string;
  /** Repo paths the task names. */
  files: string[];
  /** The user story marker, e.g. US1. */
  story?: string;
  /** Marked [P]: can run in parallel. */
  parallel: boolean;
}

export interface SpecKitFeature {
  /** Folder name under specs/. */
  feature: string;
  /** specs/<feature> */
  dir: string;
  /** Every file of the feature, repo-relative, sorted. */
  files: string[];
  /** plan.md Technical Context, keys lower-cased ("language/version", "storage", ...). */
  stack: Record<string, string>;
  /** Files listed in plan.md's source-code project structure. */
  structure: string[];
  tasks: SpecKitTask[];
  /** The planned records, as the extractor emits them. */
  records: CatalogRecord[];
}

type Status = "planned-new" | "planned-modify" | "planned-retire";
const STATUSES: readonly Status[] = ["planned-new", "planned-modify", "planned-retire"];
const asStatus = (s: string | undefined, fallback: Status = "planned-new"): Status =>
  STATUSES.includes((s ?? "").trim().toLowerCase() as Status)
    ? ((s ?? "").trim().toLowerCase() as Status)
    : fallback;

const VIA = ["gateway", "direct", "event-bus", "pubsub", "sftp", "mq", "other"] as const;
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

const planned = <T extends Record<string, unknown>>(r: T): CatalogRecord =>
  ({ schemaVersion: 1, confidence: "inferred", ...r }) as unknown as CatalogRecord;

const spec = (repo: RepoHandle, path: string, line: number, side: "definition" | "caller") =>
  evidence(repo, { source: "spec", path, line, side });

// ------------------------------------------------------------------ contracts

function openapiEndpoints(
  repo: RepoHandle,
  component: string,
  path: string,
  text: string,
): CatalogRecord[] | undefined {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return undefined;
  const version = String(doc.get("openapi") ?? doc.get("swagger") ?? "");
  if (!/^(3\.|2\.0)/.test(version)) return undefined;
  const base = version.startsWith("2") ? String(doc.get("basePath") ?? "") : "";
  const paths = doc.get("paths");
  const out: CatalogRecord[] = [];
  if (!isMap(paths)) return out;
  for (const pair of paths.items) {
    if (!isScalar(pair.key) || !isMap(pair.value)) continue;
    const p = String(pair.key.value);
    const line = pair.key.range ? lc.linePos(pair.key.range[0]).line : 1;
    for (const op of pair.value.items) {
      const method = isScalar(op.key) ? String(op.key.value).toLowerCase() : "";
      if (!METHODS.includes(method)) continue;
      const status = isMap(op.value)
        ? asStatus(String(op.value.get("x-atticus-status") ?? ""))
        : "planned-new";
      out.push(
        restEndpoint(
          repo,
          component,
          method,
          `${base}${p}`,
          { source: "spec", path, line, side: "definition" },
          { status, confidence: "inferred" },
        ),
      );
    }
  }
  return out;
}

function asyncapiTopics(
  repo: RepoHandle,
  component: string,
  path: string,
  text: string,
): CatalogRecord[] | undefined {
  const parsed = parseYamlDoc(text);
  if (!parsed) return undefined;
  const { root, lc } = parsed;
  const version = scalar(get(root, "asyncapi", lc)?.value);
  if (!version || !/^[23]\./.test(version)) return undefined;
  const topics = new Map<string, { line: number; publishes: boolean }>();
  const channels = pairs(get(root, "channels", lc)?.value, lc);
  if (version.startsWith("2.")) {
    for (const ch of channels) {
      const t = topics.get(ch.key) ?? { line: ch.line, publishes: false };
      // AsyncAPI 2 speaks from the client's side: `subscribe` means this application publishes.
      if (pairs(ch.value, lc).some((o) => o.key === "subscribe")) t.publishes = true;
      topics.set(ch.key, t);
    }
  } else {
    const address = new Map<string, string>();
    for (const ch of channels) {
      const topic = scalar(get(ch.value, "address", lc)?.value) ?? ch.key;
      address.set(ch.key, topic);
      if (!topics.has(topic)) topics.set(topic, { line: ch.line, publishes: false });
    }
    for (const o of pairs(get(root, "operations", lc)?.value, lc)) {
      const ref = scalar(get(get(o.value, "channel", lc)?.value, "$ref", lc)?.value) ?? "";
      const id = /^#\/channels\/(.+)$/.exec(ref)?.[1]?.replace(/~1/g, "/").replace(/~0/g, "~");
      const topic = id !== undefined ? address.get(id) : undefined;
      if (topic && scalar(get(o.value, "action", lc)?.value) === "send")
        topics.get(topic)!.publishes = true;
    }
  }
  return [...topics.entries()].map(([topic, t]) =>
    planned({
      kind: "Endpoint",
      id: topicId(topic),
      status: "planned-new",
      component: t.publishes ? component : "unknown",
      endpointType: "event-topic",
      pathOrTopic: topic,
      schemaRefs: [],
      evidence: [spec(repo, path, t.line, "definition")],
    }),
  );
}

// ------------------------------------------------------------------ data-model.md

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const nullableOf = (s: string): boolean | undefined => {
  const v = s.trim().toLowerCase();
  if (/^(no|false|not null|n)$/.test(v) || /\bnot null\b/.test(v)) return false;
  if (/^(yes|true|null|nullable|y)$/.test(v) || /\bnullable\b/.test(v)) return true;
  return undefined;
};

async function dataModelRecords(
  repo: RepoHandle,
  ctx: ScanContext,
  component: string,
  path: string,
  doc: MdDoc,
): Promise<CatalogRecord[]> {
  const out: CatalogRecord[] = [];
  const top = keyValues(doc).get("data store")?.value;
  let fallback: string | undefined;
  for (const h of doc.headings) {
    if (h.level < 3) continue;
    const m = /^([A-Za-z_][\w.]*)\s*(?:\(([^)]*)\))?$/.exec(plain(h.text));
    if (!m) continue;
    const name = m[1]!;
    const marker = (m[2] ?? "").toLowerCase();
    const status: Status = /existing|changed|modif/.test(marker)
      ? "planned-modify"
      : /retire|drop/.test(marker)
        ? "planned-retire"
        : "planned-new";
    const own = keyValues(doc, h.line + 1, h.end).get("store")?.value;
    const store = slug(plain(own ?? top ?? (fallback ??= await storeFor(repo, ctx))));
    const cols: { name: string; type: string; nullable?: boolean; line: number }[] = [];
    const table = tablesIn(doc, h).find(
      (t) =>
        (t.headers.includes("column") || t.headers.includes("field")) && t.headers.includes("type"),
    );
    if (table) {
      for (const r of table.rows) {
        const col = r.cells.column ?? r.cells.field ?? "";
        if (!/^[A-Za-z_]\w*$/.test(col) || !r.cells.type) continue;
        if (/\b(existing|unchanged)\b/i.test(r.cells.notes ?? "")) continue;
        const nullable = nullableOf(r.cells.nullable ?? "");
        cols.push({
          name: col,
          type: r.cells.type,
          line: r.line,
          ...(nullable !== undefined ? { nullable } : {}),
        });
      }
    } else {
      for (const b of bullets(doc, h.line + 1, h.end)) {
        const bm = /^\*{0,2}([A-Za-z_]\w*)\*{0,2}\s*([:(])\s*(.+?)\s*$/.exec(b.text);
        if (!bm) continue;
        const body = bm[2] === "(" ? bm[3]!.replace(/\)$/, "") : bm[3]!;
        const [type, ...flags] = splitTopLevel(body);
        if (!type || /\b(existing|unchanged)\b/i.test(flags.join(" "))) continue;
        const nullable = flags.length ? nullableOf(flags.join(" ")) : undefined;
        cols.push({
          name: bm[1]!,
          type,
          line: b.line,
          ...(nullable !== undefined ? { nullable } : {}),
        });
      }
    }
    const tid = `${store}.${slug(name)}`;
    out.push(
      planned({
        kind: "Table",
        id: tid,
        status,
        dataStore: store,
        name,
        tableKind: "table",
        ownerComponent: component,
        readers: [],
        writers: [],
        evidence: [spec(repo, path, h.line, "definition")],
      }),
    );
    for (const c of cols)
      out.push(
        planned({
          kind: "Column",
          id: `${tid}.${slug(c.name)}`,
          status: "planned-new",
          table: tid,
          name: c.name,
          type: c.type,
          ...(c.nullable !== undefined ? { nullable: c.nullable } : {}),
          evidence: [spec(repo, path, c.line, "definition")],
        }),
      );
  }
  return out;
}

// ------------------------------------------------------------------ plan.md

function planInterfaces(
  repo: RepoHandle,
  ctx: ScanContext,
  component: string,
  path: string,
  doc: MdDoc,
): CatalogRecord[] {
  const s = section(doc, /^services this feature calls$/i);
  if (!s) return [];
  const out: CatalogRecord[] = [];
  for (const t of tablesIn(doc, s)) {
    if (!t.headers.includes("service") || !t.headers.includes("operation")) continue;
    for (const r of t.rows) {
      const to = (r.cells.service ?? "").trim();
      if (!to) continue;
      if (!RecordId.safeParse(to).success) {
        ctx.warn(`${path}:${r.line}: "${to}" is not a service id (lowercase, no spaces)`, path);
        continue;
      }
      const op = (r.cells.operation ?? "").trim();
      const http = /^([A-Za-z]+)\s+(\/\S*)$/.exec(op);
      const event = /^(publish|subscribe|send|receive)\s+(\S+)$/i.exec(op);
      if (!(http && METHODS.includes(http[1]!.toLowerCase())) && !event) {
        ctx.warn(
          `${path}:${r.line}: operation "${op}" is neither "METHOD /path" nor "publish <topic>"`,
          path,
        );
        continue;
      }
      const viaCell = (r.cells.via ?? "").trim().toLowerCase();
      const via = (VIA as readonly string[]).includes(viaCell) ? viaCell : "other";
      const method = http ? http[1]!.toUpperCase() : undefined;
      const target = http ? http[2]! : event![2]!;
      const pattern = (r.cells.pattern ?? "").trim();
      out.push(
        planned({
          kind: "Interface",
          id: interfaceId(component, to, method, target),
          status: asStatus(r.cells.status),
          from: component,
          to,
          via,
          ...(method ? { method } : {}),
          normalizedPath: normalizePath(target),
          sync: event || ["event-bus", "pubsub", "mq"].includes(via) ? "async" : "sync",
          direction: "outbound",
          ...(pattern ? { pattern: { code: pattern, source: "inferred" } } : {}),
          conflicts: [],
          evidence: [spec(repo, path, r.line, "caller")],
        }),
      );
    }
  }
  return out;
}

/** The files a fenced tree under "Source Code" lists, rebuilt into repo paths. */
function structureOf(doc: MdDoc): string[] {
  const s = section(doc, /^source code/i);
  if (!s) return [];
  const out = new Set<string>();
  for (const f of doc.fences.filter((x) => x.line > s.line && x.line <= s.end)) {
    const stack: string[] = [];
    for (const { text } of f.body) {
      const clean = text.replace(/\s+#.*$/, "").trimEnd();
      const at = clean.search(/[^\s│├└─|`'-]/);
      if (at < 0) continue;
      const name = clean.slice(at).trim();
      const depth = Math.floor(at / 4);
      stack.length = depth;
      if (name.endsWith("/")) stack[depth] = name.slice(0, -1);
      else if (/\.[\w]+$/.test(name)) out.add([...stack.slice(0, depth), name].join("/"));
    }
  }
  return [...out].sort();
}

// ------------------------------------------------------------------ tasks.md

const FILE = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+/g;

function readTasks(doc: MdDoc): SpecKitTask[] {
  const out: SpecKitTask[] = [];
  doc.lines.forEach((l, i) => {
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(l);
    if (!m) return;
    let rest = m[2]!.trim();
    const id = /^(T\d+)\b\s*/.exec(rest);
    if (id) rest = rest.slice(id[0].length);
    let parallel = false;
    let story: string | undefined;
    for (;;) {
      const mk = /^\[([^\]]+)\]\s*/.exec(rest);
      if (!mk) break;
      if (/^p$/i.test(mk[1]!)) parallel = true;
      else if (/^US\d+$/i.test(mk[1]!)) story = mk[1]!.toUpperCase();
      rest = rest.slice(mk[0].length);
    }
    out.push({
      ...(id ? { id: id[1]! } : {}),
      done: m[1] !== " ",
      line: i + 1,
      text: rest,
      files: [...new Set([...rest.matchAll(FILE)].map((f) => f[0].replace(/[.,;:]+$/, "")))],
      story,
      parallel,
    });
  });
  return out;
}

// ------------------------------------------------------------------ features

const FEATURE_FILE = /^specs\/([^/]+)\/(.+)$/;

/**
 * Read every Spec Kit feature of a repo: the planned records plus the report that holds what
 * C1 can't (stack, project structure, tasks with the files they touch). The extractor emits
 * the records; hand-up and the drift check use the report.
 */
export async function readSpecKitFeatures(
  repo: RepoHandle,
  ctx: ScanContext,
): Promise<SpecKitFeature[]> {
  let specify = false;
  for await (const _ of repo.listFiles([".specify/**"])) {
    specify = true;
    break;
  }
  if (!specify) return [];
  const component = componentOf(repo, ctx);
  const byFeature = new Map<string, string[]>();
  for await (const p of repo.listFiles(["specs/*/**"])) {
    const m = FEATURE_FILE.exec(p);
    if (m) byFeature.set(m[1]!, [...(byFeature.get(m[1]!) ?? []), p]);
  }
  const features: SpecKitFeature[] = [];
  for (const [feature, files] of [...byFeature.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const dir = `specs/${feature}`;
    const records: CatalogRecord[] = [];
    const sorted = [...files].sort();
    const read = async (rel: string) =>
      sorted.includes(`${dir}/${rel}`) ? repo.readText(`${dir}/${rel}`) : undefined;

    for (const p of sorted.filter((x) => x.startsWith(`${dir}/contracts/`))) {
      if (!/\.(ya?ml|json)$/i.test(p)) continue;
      const text = await repo.readText(p);
      const got =
        openapiEndpoints(repo, component, p, text) ?? asyncapiTopics(repo, component, p, text);
      if (got) records.push(...got);
      else ctx.warn(`could not read ${p} as an OpenAPI or AsyncAPI contract`, p);
    }

    const dm = await read("data-model.md");
    if (dm !== undefined)
      records.push(
        ...(await dataModelRecords(repo, ctx, component, `${dir}/data-model.md`, parseMd(dm))),
      );

    const planText = await read("plan.md");
    const plan = planText !== undefined ? parseMd(planText) : undefined;
    let stack: Record<string, string> = {};
    let structure: string[] = [];
    if (plan) {
      records.push(...planInterfaces(repo, ctx, component, `${dir}/plan.md`, plan));
      const tc = section(plan, /^technical context$/i);
      if (tc)
        stack = Object.fromEntries(
          [...keyValues(plan, tc.line + 1, tc.end)].map(([k, v]) => [k, v.value]),
        );
      structure = structureOf(plan);
    }

    const tasksText = await read("tasks.md");
    const tasks = tasksText !== undefined ? readTasks(parseMd(tasksText)) : [];

    // One record per id: the first wins (a topic named in two contracts, say).
    const unique = new Map<string, CatalogRecord>();
    for (const r of records)
      if (!unique.has(`${r.kind}/${r.id}`)) unique.set(`${r.kind}/${r.id}`, r);
    const kept = [...unique.values()];
    const anchor =
      tasksText !== undefined ? "tasks.md" : planText !== undefined ? "plan.md" : undefined;
    if (anchor) {
      const done = tasks.filter((t) => t.done).length;
      kept.push(
        planned({
          kind: "ProcessArtifact",
          id: `speckit.${slug(repo.name)}.${slug(feature)}`,
          status: "planned-new",
          artifactType: "change",
          ref: `${repo.name}:${dir}`,
          processStatus: tasks.length ? `${done} of ${tasks.length} tasks done` : "no tasks yet",
          linkedRecords: [...new Set(kept.map((r) => r.id))].sort(),
          evidence: [spec(repo, `${dir}/${anchor}`, 1, "definition")],
        }),
      );
    }
    features.push({ feature, dir, files: sorted, stack, structure, tasks, records: kept });
  }
  return features;
}

export const speckitExtractor = defineExtractor({
  id: "speckit",
  version: SPECKIT_EXTRACTOR_VERSION,
  claims: ["specs/*/**", ".specify/**"],
  async *scan(repo, ctx) {
    const seen = new Set<string>();
    for (const f of await readSpecKitFeatures(repo, ctx))
      for (const r of f.records) {
        // Two features planning the same table: the first (by folder name) is kept.
        const k = `${r.kind}/${r.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        yield r;
      }
  },
});
