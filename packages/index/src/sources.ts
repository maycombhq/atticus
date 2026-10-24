import { readdir, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { parse } from "yaml";
import { gapNameOf } from "./gaps.js";
import {
  changesDirOf,
  deserializeRecord,
  knowledgeDirOf,
  knowledgeKindOf,
  layoutOf,
  orgPackDirOf,
  parseRecord,
  Question,
  questionsDirOf,
  recordReferences,
  serializeRecord,
  specsDirOf,
  toCanonicalYaml,
  type CatalogRecord,
} from "@maycombhq/core";

/**
 * What the index reads (ADR 0107 point 1), one file at a time: each file gives its own nodes,
 * names and links, so an update re-reads only the files that changed. A link records how it
 * was made (`how`): a record's field, a change's placement, a need's item, or a name or alias
 * matched exactly (the mentions, worked out over every node once the names are known).
 */

/** Where a file comes from. */
export type SourceKind =
  | "catalog"
  | "knowledge"
  | "review"
  | "flow"
  | "change"
  | "question"
  | "wiki"
  | "profile"
  | "document";

export interface SourceFile {
  /** Root-relative, forward slashes. */
  path: string;
  source: SourceKind;
  size: number;
  mtimeMs: number;
}

/** A node of the graph: a catalog record, a knowledge item, a flow or one of its steps, a change... */
export interface NodeRow {
  /** grp:kind:id, unique. */
  key: string;
  kind: string;
  id: string;
  /** catalog, knowledge, flow, change, question, wiki, org-pack. */
  grp: string;
  name: string;
  file: string;
  /** Confirmed: a verified record, a flow whose every step a check or person confirmed. */
  verified: boolean;
  /** One line about it. */
  line: string;
  /** In full, with its citations. */
  detail: string;
  /** Searchable text: other names, ids and prose. */
  names: string;
  ids: string;
  body: string;
  /** Whether its text is read for the names it mentions. */
  mentions: boolean;
  json?: string;
}

/** A name a node goes by: its id, its name, an alias. Lower case, spaces folded. */
export interface NameRow {
  name: string;
  id: string;
  kind: string;
  /** id, name:<where>, alias:<where>, endpoint. */
  how: string;
}

/** A typed link. `to` is an id (by: id) or a name (by: name, resolved through the names). */
export interface LinkRow {
  from: string;
  to: string;
  by: "id" | "name";
  type: string;
  how: string;
}

export interface ReviewRow {
  item: string;
  verdict: string;
  by: string;
  at: string;
}

export interface FileRead {
  nodes: NodeRow[];
  names: NameRow[];
  links: LinkRow[];
  record?: CatalogRecord;
  review?: ReviewRow;
  problem?: string;
}

const toPosix = (p: string) => p.split(sep).join("/");
const rel = (root: string, abs: string) => toPosix(relative(root, abs));
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A name as the index compares it: lower case, runs of space folded, curly quotes plain. */
export const foldName = (s: string) =>
  s.replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();

/** "get /a/{id}/" → "get /a/{}": the way an endpoint is named in a flow's step or a brief. */
export function endpointName(method: string, path: string): string {
  const p = path
    .replace(/\?.*$/, "")
    .replace(/\{[^}]*\}/g, "{}")
    .replace(/(.)\/$/, "$1");
  return `${method.toLowerCase()} ${p.toLowerCase()}`;
}

async function walk(
  dir: string,
  test: (name: string) => boolean,
  out: string[],
  skipDirs: Set<string> = new Set(),
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!skipDirs.has(e.name)) await walk(full, test, out, skipDirs);
    } else if (test(e.name)) out.push(full);
  }
}

const YAML = (n: string) => /\.ya?ml$/.test(n);

/** The catalog folders the index reads, relative to the metarepo. */
export const CATALOG_DIRS = ["catalog/generated", "catalog/curated"];

/** Every file the index reads, sorted by path. */
export async function listSources(root: string): Promise<SourceFile[]> {
  const found: { abs: string; source: SourceKind }[] = [];
  const add = (source: SourceKind) => (files: string[]) =>
    found.push(...files.map((abs) => ({ abs, source })));
  // The catalog folder follows sources.yaml layout (catalog/ unless the org pack says otherwise).
  const catalog = layoutOf(root).catalog;
  for (const d of CATALOG_DIRS) {
    const files: string[] = [];
    await walk(join(root, ...d.replace(/^catalog\//, `${catalog}/`).split("/")), YAML, files);
    add("catalog")(files);
  }
  const kdir = knowledgeDirOf(root);
  {
    const files: string[] = [];
    await walk(join(kdir, "items"), YAML, files);
    add("knowledge")(files);
  }
  {
    const files: string[] = [];
    await walk(join(kdir, "reviews"), YAML, files);
    add("review")(files);
  }
  {
    // specs/<repo>/<flow id>.yaml; the header and the critic's findings aren't flows, and nor
    // is a file at the top of specs/ (estate.yaml: the estate pass's joins, ADR 0085).
    const files: string[] = [];
    await walk(
      specsDirOf(root),
      (n) => YAML(n) && n !== "spec.yaml" && n !== "findings.yaml",
      files,
    );
    add("flow")(files.filter((f) => dirname(f) !== specsDirOf(root)));
  }
  {
    // A change folder's own files: what it is, its brief and proposal, its placement, needs and target flows.
    const dir = changesDirOf(root);
    const ids = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory() && d.name !== "archive")
      .map((d) => d.name);
    for (const id of ids) {
      const files: string[] = [];
      for (const f of ["change.yaml", "brief.md", "proposal.md", "feature.yaml", "needs.yaml"])
        files.push(join(dir, id, f));
      await walk(join(dir, id, "target-flows"), YAML, files);
      // ADR 0113: what was read from the files attached to the change.
      await walk(join(dir, id, "inputs", "read"), (n) => n.endsWith(".md"), files);
      const exist: string[] = [];
      for (const f of files) if (await stat(f).catch(() => undefined)) exist.push(f);
      add("change")(exist);
    }
  }
  {
    const files: string[] = [];
    await walk(questionsDirOf(root), YAML, files);
    add("question")(files);
  }
  {
    // The newest snapshot of each wiki source: knowledge/snapshots/<source>/<date>/.
    const sdir = join(kdir, "snapshots");
    const sources = (await readdir(sdir, { withFileTypes: true }).catch(() => [])).filter((d) =>
      d.isDirectory(),
    );
    for (const s of sources) {
      const dates = (await readdir(join(sdir, s.name), { withFileTypes: true }).catch(() => []))
        .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
        .map((d) => d.name)
        .sort();
      const newest = dates.at(-1);
      if (!newest) continue;
      const files: string[] = [];
      await walk(join(sdir, s.name, newest), (n) => /\.(md|markdown)$/i.test(n), files);
      add("wiki")(files);
    }
  }
  {
    const files: string[] = [];
    await walk(join(orgPackDirOf(root), "profiles"), (n) => n === "profile.yaml", files);
    add("profile")(files);
  }
  {
    // ADR 0116: the documents dropped into inputs/ that the document ingestor reads.
    const files: string[] = [];
    await walk(join(root, "inputs"), (n) => DOCUMENT_EXTENSIONS.test(n), files);
    add("document")(files);
  }
  const out: SourceFile[] = [];
  const seen = new Set<string>();
  for (const f of found) {
    const path = rel(root, f.abs);
    if (seen.has(path)) continue;
    seen.add(path);
    const s = await stat(f.abs).catch(() => undefined);
    if (!s) continue;
    out.push({ path, source: f.source, size: s.size, mtimeMs: Math.floor(s.mtimeMs) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A short label for a record: its name or title, else what it is about, else its id. */
export function labelOf(r: Record<string, unknown>): string {
  for (const f of ["name", "title", "term", "pathOrTopic", "key", "raw"])
    if (typeof r[f] === "string" && r[f]) return r[f] as string;
  if (r.kind === "Interface")
    return `${String(r.from)} → ${String(r.to)}${r.method ? ` ${String(r.method)}` : ""} ${String(r.normalizedPath ?? "")}`.trim();
  return String(r.id);
}

/** The strings in a value, for search: every leaf but citations and hashes. */
function prose(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || out.length > 400) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) prose(x, out, depth + 1);
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v))
      if (!["evidence", "sha256", "hash", "schemaVersion", "status", "confidence"].includes(k))
        prose(x, out, depth + 1);
  return out;
}

/** "a-b.c" → "a b c": ids as words, for the ids column. */
const idWords = (id: string) => `${id} ${id.replace(/[^A-Za-z0-9]+/g, " ")}`;

/** Where a record says it was read: the first citation, path:line. */
function cites(r: Record<string, unknown>): string | undefined {
  for (const e of arr(r.evidence) as Record<string, unknown>[]) {
    const p = str(e.path);
    if (p)
      return `${e.repo ? `${String(e.repo)}/` : ""}${p}${typeof e.line === "number" ? `:${e.line}` : ""}`;
  }
  const q = r.quote as Record<string, unknown> | undefined;
  if (q && str(q.page))
    return `${String(q.source)}/${String(q.page)}${q.section ? `#${String(q.section)}` : ""}`;
  return undefined;
}

const NAMED_KINDS = new Set(["System", "Component", "Party", "Product", "DataStore", "Capability"]);

function recordLine(r: Record<string, unknown>, label: string): string {
  const k = String(r.kind);
  const id = String(r.id);
  let s: string;
  if (k === "System")
    s = `system ${id} "${label}"${str(r.boundary) ? ` (${String(r.boundary)})` : ""}${str(r.owner) ? `, owner ${String(r.owner)}` : ""}`;
  else if (k === "Component")
    s = `component ${id}: system ${str(r.system) ?? "?"}${str(r.repo) ? `, repo ${String(r.repo)}` : ""}${str(r.type) ? `, ${String(r.type)}` : ""}`;
  else if (k === "Endpoint")
    s = `endpoint ${id}: ${str(r.component) ?? "?"} serves ${str(r.method) ?? ""} ${str(r.pathOrTopic) ?? ""}`;
  else if (k === "Interface")
    s = `interface ${id}: ${String(r.from)} calls ${String(r.to)}${str(r.method) ? ` ${String(r.method)}` : ""} ${str(r.normalizedPath) ?? ""}${str(r.via) ? ` via ${String(r.via)}` : ""}`;
  else {
    const kk = knowledgeKindOf(r as { kind: string });
    if (kk)
      s = `${kk} ${id} "${label}"${str(r.appliesWhen) ? `: applies when ${String(r.appliesWhen)}` : ""}`;
    else s = `${k.toLowerCase()} ${id}${label !== id ? ` "${label}"` : ""}`;
  }
  const c = cites(r);
  return `${s.replace(/ {2,}/g, " ").trim()}${c ? ` [${c}]` : ""}`;
}

/** A catalog record or knowledge item: its node, names and links. */
function recordNode(
  r: CatalogRecord,
  file: string,
  grp: "catalog" | "knowledge",
): Omit<FileRead, "record"> {
  const x = r as unknown as Record<string, unknown>;
  const label = labelOf(x);
  const key = `${grp}:${r.kind}:${r.id}`;
  const names: NameRow[] = [{ name: foldName(r.id), id: r.id, kind: r.kind, how: "id" }];
  const aliases = arr(x.aliases).filter((a): a is string => typeof a === "string");
  if (label !== r.id && (NAMED_KINDS.has(r.kind) || grp === "knowledge"))
    names.push({ name: foldName(label), id: r.id, kind: r.kind, how: `name:${grp}` });
  for (const a of aliases)
    names.push({ name: foldName(a), id: r.id, kind: r.kind, how: `alias:${grp}` });
  if (r.kind === "Endpoint" && str(x.method) && str(x.pathOrTopic))
    names.push({
      name: endpointName(String(x.method), String(x.pathOrTopic)),
      id: r.id,
      kind: r.kind,
      how: "endpoint",
    });
  const links: LinkRow[] = [];
  for (const ref of recordReferences(r))
    links.push({ from: key, to: ref.id, by: "id", type: "ref", how: `field:${ref.field}` });
  // ADR 0116: a glossary term is known by its term, and defines the columns and fields it lists.
  if (r.kind === "GlossaryTerm") {
    if (str(x.term) && foldName(String(x.term)) !== foldName(r.id))
      names.push({ name: foldName(String(x.term)), id: r.id, kind: r.kind, how: `name:${grp}` });
    for (const f of arr(x.fields))
      if (typeof f === "string")
        links.push({ from: key, to: f, by: "id", type: "defines", how: "field:fields" });
  }
  // A curated alias: a name people use for a catalog id.
  // A curated alias: a name people use for a catalog id, or a list of them.
  if (r.kind === "CuratedDecision" && x.action === "alias")
    for (const v of typeof x.value === "string" ? [x.value] : arr(x.value))
      if (typeof v === "string" && v.trim())
        names.push({ name: foldName(v), id: String(x.target), kind: "", how: "alias:curated" });
  if (grp === "knowledge") {
    // What an item says it is about, by its own fields.
    for (const s of arr(x.systems))
      if (typeof s === "string")
        links.push({ from: key, to: s, by: "id", type: "names", how: "field:systems" });
    const l = x.links as Record<string, unknown> | undefined;
    if (l)
      for (const f of ["systems", "interfaces"])
        for (const s of arr(l[f]))
          if (typeof s === "string")
            links.push({ from: key, to: s, by: "id", type: "names", how: `field:links.${f}` });
    // The wiki section it was read from.
    const quotes = [x.quote, ...arr(x.alsoOn)] as (Record<string, unknown> | undefined)[];
    quotes.forEach((q, i) => {
      if (q && str(q.source) && str(q.page))
        links.push({
          from: key,
          to: sectionId(String(q.source), pageFile(String(q.page)), str(q.section) ?? ""),
          by: "id",
          type: "quotes",
          how: i === 0 ? "field:quote" : "field:alsoOn",
        });
    });
  }
  const body = prose(x)
    .filter((s) => s !== r.id && s !== label)
    .join("\n")
    .slice(0, 6000);
  return {
    nodes: [
      {
        key,
        kind: r.kind,
        id: r.id,
        grp,
        name: label,
        file,
        verified: r.confidence === "verified",
        line: recordLine(x, label),
        detail: serializeRecord(r),
        names: [label, ...aliases].join("\n"),
        ids: idWords(r.id),
        body,
        mentions: grp === "knowledge",
        json: JSON.stringify(r),
      },
    ],
    names,
    links,
  };
}

const pageFile = (page: string) => (/\.(md|markdown)$/i.test(page) ? page : `${page}.md`);
/** A wiki section's id: <source>/<page>#<heading>. */
export const sectionId = (source: string, page: string, heading: string) =>
  `${source}/${page}#${heading}`;

function flowNodes(text: string, file: string): FileRead {
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    return { nodes: [], names: [], links: [], problem: (e as Error).message.split("\n")[0]! };
  }
  const r = parseRecord(data);
  if (!r.ok)
    return {
      nodes: [],
      names: [],
      links: [],
      problem: r.issues.map((i) => `${i.path || "(top)"}: ${i.message}`).join("; "),
    };
  if (r.record.kind !== "Flow")
    return { nodes: [], names: [], links: [], problem: `is a ${r.record.kind}, not a Flow` };
  const f = r.record;
  const key = `flow:Flow:${f.id}`;
  const nodes: NodeRow[] = [];
  const links: LinkRow[] = [
    { from: key, to: f.component, by: "id", type: "ref", how: "field:component" },
  ];
  if (f.trigger.ref)
    links.push({ from: key, to: f.trigger.ref, by: "id", type: "ref", how: "field:trigger.ref" });
  if (f.trigger.caller?.ref)
    links.push({
      from: key,
      to: f.trigger.caller.ref,
      by: "id",
      type: "ref",
      how: "field:trigger.caller.ref",
    });
  const stepLines: string[] = [];
  f.steps.forEach((s, i) => {
    const n = i + 1;
    const skey = `flow:FlowStep:${f.id}#${n}`;
    const out: LinkRow[] = [{ from: skey, to: f.id, by: "id", type: "step-of", how: "flow step" }];
    const add = (to: string, how: string, by: "id" | "name" = "id") => {
      out.push({ from: skey, to, by, type: "calls", how: `step ${n} ${how}` });
      links.push({ from: key, to, by, type: "calls", how: `step ${n} ${how}` });
    };
    for (const ref of s.refs) add(ref, "field:refs");
    if (s.to) {
      add(s.to.component, "field:to.component");
      const m = /^\s*([A-Za-z]+)\s+(\/\S*)/.exec(s.to.entry);
      if (m) add(endpointName(m[1]!, m[2]!), "field:to.entry", "name");
      else add(s.to.entry, "field:to.entry");
    }
    if (s.store) add(s.store.table, "field:store.table");
    const fields = [
      ...(s.data?.sends ?? []),
      ...(s.data?.returns ?? []),
      ...(s.data?.reads ?? []),
      ...(s.store?.columns ?? []),
    ];
    const where = s.to ? ` → ${s.to.component} ${s.to.entry}` : s.store ? ` ${s.store.table}` : "";
    const line = `${n} ${s.kind}${where}${fields.length ? ` [${[...new Set(fields)].join(", ")}]` : ""}`;
    stepLines.push(line);
    const c = s.evidence[0];
    nodes.push({
      key: skey,
      kind: "FlowStep",
      id: `${f.id}#${n}`,
      grp: "flow",
      name: s.what,
      file,
      verified: !!s.confirmedBy,
      line: `step ${f.id}#${n} ${s.kind}: ${s.what}${where}${c?.path ? ` [${c.repo ? `${c.repo}/` : ""}${c.path}${c.line ? `:${c.line}` : ""}]` : ""}`,
      detail: `Step ${n} of flow ${f.id} (${file}):\n${toCanonicalYaml(s, ["kind", "what"])}`,
      names: "",
      ids: idWords(`${f.id}#${n}`),
      body: [s.what, ...fields].join("\n"),
      mentions: false,
    });
    links.push(...out);
  });
  const allConfirmed = f.steps.every((s) => !!s.confirmedBy);
  nodes.unshift({
    key,
    kind: "Flow",
    id: f.id,
    grp: "flow",
    name: f.name,
    file,
    verified: allConfirmed,
    line: `flow ${f.id} (component ${f.component}) "${f.name}": ${f.trigger.kind} ${f.trigger.what}. Steps: ${stepLines.join("; ")} [${file}]`,
    detail: serializeRecord(f as unknown as CatalogRecord),
    names: f.name,
    ids: idWords(f.id),
    body: [
      f.trigger.what,
      ...f.steps.map((s) => s.what),
      ...f.errors.map((e) => `${e.when} ${e.then}`),
    ].join("\n"),
    mentions: false,
    json: JSON.stringify(f),
  });
  return {
    nodes,
    names: [
      { name: foldName(f.id), id: f.id, kind: "Flow", how: "id" },
      { name: foldName(f.name), id: f.id, kind: "Flow", how: "name:flow" },
    ],
    links,
  };
}

function changeNodes(path: string, text: string): FileRead {
  // <changes>/<id>/<file>
  const parts = path.split("/");
  const fileName = parts.slice(-1)[0]!;
  const inTargets = parts.at(-2) === "target-flows";
  const inInputs = parts.at(-2) === "read" && parts.at(-3) === "inputs";
  const change = inTargets ? parts.at(-3)! : inInputs ? parts.at(-4)! : parts.at(-2)!;
  const ckey = `change:Change:${change}`;
  const out: FileRead = { nodes: [], names: [], links: [] };
  if (inInputs) {
    // ADR 0113: a file attached to the change, as intake read it (each line cited); data only.
    const input = `inputs/${fileName.replace(/\.md$/, "")}`;
    const id = `${change}/${input}`;
    const key = `change:ChangeDoc:${id}`;
    out.links.push({ from: key, to: change, by: "id", type: "part-of", how: input });
    out.nodes.push({
      key,
      kind: "ChangeDoc",
      id,
      grp: "change",
      name: input,
      file: path,
      verified: false,
      line: `${input} attached to change ${change} [${path}]`,
      detail: `${path}:\n${text}`,
      names: input,
      ids: idWords(id),
      body: text.slice(0, 20000),
      mentions: true,
    });
    return out;
  }
  const data = (): Record<string, unknown> | undefined => {
    try {
      const d = parse(text) as unknown;
      return d && typeof d === "object" ? (d as Record<string, unknown>) : undefined;
    } catch (e) {
      out.problem = (e as Error).message.split("\n")[0]!;
      return undefined;
    }
  };
  if (inTargets) {
    const d = data();
    if (d && str(d.flow))
      out.links.push({
        from: ckey,
        to: String(d.flow),
        by: "id",
        type: "touches",
        how: "target flow",
      });
    return out;
  }
  if (fileName === "change.yaml") {
    const d = data();
    if (!d) return out;
    const title = str(d.title) ?? change;
    for (const s of arr(d.systems))
      if (typeof s === "string")
        out.links.push({
          from: ckey,
          to: s,
          by: "id",
          type: "touches",
          how: "change.yaml systems",
        });
    const t = (d.touches ?? {}) as Record<string, unknown>;
    for (const f of ["interfaces", "tables", "dataStores", "records", "repos"])
      for (const v of arr(t[f])) {
        const id = typeof v === "string" ? v : str((v as Record<string, unknown>)?.id);
        if (id)
          out.links.push({
            from: ckey,
            to: id,
            by: "id",
            type: "touches",
            how: `change.yaml touches.${f}`,
          });
      }
    out.nodes.push({
      key: ckey,
      kind: "Change",
      id: change,
      grp: "change",
      name: title,
      file: path,
      verified: false,
      line: `change ${change} "${title}"${str(d.state) ? ` (${String(d.state)})` : ""} [${path}]`,
      detail: `Change ${change} "${title}" (${path}): state ${str(d.state) ?? "?"}; systems ${arr(d.systems).join(", ") || "none named"}.`,
      names: title,
      ids: idWords(change),
      body: [title, str(d.type) ?? ""].join("\n"),
      mentions: false,
    });
    out.names.push({ name: foldName(change), id: change, kind: "Change", how: "id" });
    return out;
  }
  if (fileName === "feature.yaml") {
    const d = data();
    if (!d) return out;
    for (const f of arr(d.flows)) {
      const id = str((f as Record<string, unknown>)?.id);
      if (id)
        out.links.push({ from: ckey, to: id, by: "id", type: "touches", how: "placement flows" });
    }
    for (const f of arr(d.features)) {
      const id = str((f as Record<string, unknown>)?.id);
      if (id)
        out.links.push({
          from: ckey,
          to: id,
          by: "id",
          type: "touches",
          how: "placement features",
        });
    }
    return out;
  }
  if (fileName === "needs.yaml") {
    const d = data();
    if (!d) return out;
    for (const n of arr(d.needs) as Record<string, unknown>[]) {
      const item = str(n.item);
      const target = str(n.for) ?? "change";
      if (!item) continue;
      const id = `${change}:${item}:${target}`;
      const key = `change:Need:${id}`;
      out.links.push(
        { from: key, to: item, by: "id", type: "needs", how: "needs.yaml item" },
        { from: key, to: change, by: "id", type: "part-of", how: "needs.yaml" },
      );
      const flow = /^flow:(.+)$/.exec(target)?.[1];
      if (flow)
        out.links.push({ from: key, to: flow, by: "id", type: "for", how: "needs.yaml for" });
      const title = str(n.title) ?? item;
      out.nodes.push({
        key,
        kind: "Need",
        id,
        grp: "change",
        name: title,
        file: path,
        verified: false,
        line: `need ${item} for ${target} of ${change}: ${title} (${str(n.status) ?? "open"}) [${path}]`,
        detail: `Need ${item} for ${target} of change ${change} (${path}): ${title}. Why: ${str(n.why) ?? ""}. Status: ${str(n.status) ?? "open"}.`,
        names: title,
        ids: idWords(id),
        body: [str(n.why) ?? "", str((n.because as Record<string, unknown>)?.quote) ?? ""].join(
          "\n",
        ),
        mentions: false,
      });
    }
    return out;
  }
  // brief.md, proposal.md: the change's words, read for the names they use.
  const id = `${change}/${fileName}`;
  const key = `change:ChangeDoc:${id}`;
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? id;
  out.links.push({ from: key, to: change, by: "id", type: "part-of", how: fileName });
  out.nodes.push({
    key,
    kind: "ChangeDoc",
    id,
    grp: "change",
    name: title,
    file: path,
    verified: false,
    line: `${fileName} of change ${change}: ${title} [${path}]`,
    detail: `${path}:\n${text}`,
    names: title,
    ids: idWords(id),
    body: text.slice(0, 20000),
    mentions: true,
  });
  return out;
}

function questionNodes(path: string, text: string): FileRead {
  let q: Question;
  try {
    const r = Question.safeParse(parse(text));
    if (!r.success)
      return {
        nodes: [],
        names: [],
        links: [],
        problem: r.error.issues[0]?.message ?? "not a question",
      };
    q = r.data;
  } catch (e) {
    return { nodes: [], names: [], links: [], problem: (e as Error).message.split("\n")[0]! };
  }
  // Only an answered question is knowledge: a person's answer, with who and when.
  if (q.state !== "answered" || !q.answer) return { nodes: [], names: [], links: [] };
  const a = q.answer;
  const picked = a.option !== undefined ? q.options[a.option - 1] : undefined;
  const answer = picked ? `${picked.label}: ${picked.means}` : (a.text ?? "");
  const key = `question:Question:${q.id}`;
  const gap = gapNameOf(q);
  return {
    nodes: [
      {
        key,
        kind: "Question",
        id: q.id,
        grp: "question",
        name: q.question,
        file: path,
        verified: false,
        line: `answered question ${q.id}: ${q.question} Answer: ${answer} (${a.by}, ${a.at}) [${path}]`,
        detail: `Question ${q.id} (${path}), asked by ${q.askedBy.step} about repo ${q.repo}: ${q.question}\nAnswer, by ${a.by} at ${a.at}: ${answer}\nEvidence: ${q.evidence.join(", ")}`,
        names: "",
        ids: q.id,
        body: [q.question, answer].join("\n"),
        mentions: true,
      },
    ],
    // An answered gap (ADR 0107 point 5): the name it was about is known from now on, by this answer.
    names: gap ? [{ name: foldName(gap), id: q.id, kind: "Question", how: "answered gap" }] : [],
    links: [{ from: key, to: q.repo, by: "id", type: "about", how: "question repo" }],
  };
}

function wikiNodes(root: string, path: string, text: string): FileRead {
  // <knowledge>/snapshots/<source>/<date>/<page>
  const k = rel(root, knowledgeDirOf(root));
  const rest = path.slice(k.length + "/snapshots/".length).split("/");
  const source = rest[0]!;
  const date = rest[1]!;
  const page = rest.slice(2).join("/");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections: { heading: string; level: number; line: number; text: string[] }[] = [
    { heading: "", level: 0, line: 1, text: [] },
  ];
  lines.forEach((l, i) => {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) sections.push({ heading: m[2]!, level: m[1]!.length, line: i + 1, text: [] });
    else sections.at(-1)!.text.push(l);
  });
  const out: FileRead = { nodes: [], names: [], links: [] };
  const used = new Set<string>();
  // ADR 0116: a section is named by its heading path (page title › parent › heading).
  const stack: string[] = [];
  for (const s of sections) {
    if (s.level > 0) {
      stack.length = s.level - 1;
      while (stack.length < s.level - 1) stack.push("");
      stack.push(s.heading);
    }
    const path_ = stack.filter(Boolean).join(" › ");
    const paras: { line: number; text: string }[] = [];
    let at = s.level > 0 ? s.line + 1 : 1;
    let cur: { line: number; text: string[] } | undefined;
    for (const l of s.text) {
      if (l.trim()) (cur ??= { line: at, text: [] }).text.push(l);
      else if (cur) {
        paras.push({ line: cur.line, text: cur.text.join("\n") });
        cur = undefined;
      }
      at++;
    }
    if (cur) paras.push({ line: cur.line, text: cur.text.join("\n") });
    if (!paras.length) continue;
    const id = sectionId(source, page, s.heading);
    if (used.has(id)) continue;
    used.add(id);
    const parts = partsOf(paras);
    parts.forEach((p, i) => {
      const pid = i === 0 ? id : `${id}#${i + 1}`;
      const line = i === 0 ? s.line : p.line;
      const of = parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : "";
      const name = path_ || page;
      out.nodes.push({
        key: `wiki:WikiSection:${pid}`,
        kind: "WikiSection",
        id: pid,
        grp: "wiki",
        name,
        file: path,
        verified: false,
        line: `wiki ${source}/${page}${path_ ? ` § ${path_}` : ""}${of} (snapshot ${date}) [${path}:${line}]`,
        detail: `${source}/${page}${path_ ? ` › ${path_}` : ""}${of}, snapshot ${date} (${path}:${line}):\n${p.text}`,
        names: path_,
        ids: idWords(page),
        body: p.text,
        mentions: true,
      });
      if (i > 0)
        out.links.push({
          from: `wiki:WikiSection:${pid}`,
          to: id,
          by: "id",
          type: "part-of",
          how: `part ${i + 1}`,
        });
    });
  }
  return out;
}

/** A part of a long section is about this many characters (≈ 400 tokens), cut at paragraphs. */
export const PART_CHARS = 1600;

/**
 * A section's paragraphs as parts (ADR 0116): a section over PART_CHARS is cut at paragraph
 * boundaries, each part starting at its first paragraph's line, so a citation stays exact. A
 * paragraph longer than a part is a part of its own, never cut inside.
 */
export function partsOf(paras: { line: number; text: string }[]): { line: number; text: string }[] {
  const parts: { line: number; text: string }[] = [];
  for (const p of paras) {
    const last = parts.at(-1);
    if (last && last.text.length + 2 + p.text.length <= PART_CHARS)
      last.text = `${last.text}\n\n${p.text}`;
    else parts.push({ line: p.line, text: p.text });
  }
  return parts;
}

/** The document formats the index reads from inputs/ (ADR 0116), by extension. */
export const DOCUMENT_EXTENSIONS = /\.(docx|pptx|xlsx|pdf|md|markdown|html?|txt)$/i;

/**
 * An ingested document (ADR 0116): a file under inputs/ that the document ingestor reads, one
 * node per section (group document), named by its heading path and cited by file and section,
 * page or line, cut into parts like a wiki section. Screened first with the ingested-content
 * defences: a document that hides instructions is kept out, as intake keeps it out of every AI
 * step, until a person decides. Read lazily: the ingestors load only when there is a document.
 */
export async function documentNodes(path: string, bytes: Uint8Array): Promise<FileRead> {
  const out: FileRead = { nodes: [], names: [], links: [] };
  const [{ readDocument }, { screenFile }] = await Promise.all([
    import("@maycombhq/ingestors"),
    import("@maycombhq/intake"),
  ]);
  const screen = screenFile(path, bytes);
  if (screen.problem) return { ...out, problem: screen.problem };
  if (screen.screening && (screen.screening.risk === "medium" || screen.screening.risk === "high"))
    return {
      ...out,
      problem: `kept out of the index: the ingested-content defences found ${screen.screening.risk} risk (${screen.screening.reason})`,
    };
  let read: ReturnType<typeof readDocument>;
  try {
    read = readDocument(path, bytes);
  } catch (e) {
    return { ...out, problem: (e as Error).message };
  }
  const title = read.text.title;
  const stack: string[] = [];
  const used = new Set<string>();
  for (const s of read.text.sections) {
    if (s.level > 0) {
      stack.length = s.level - 1;
      while (stack.length < s.level - 1) stack.push("");
      stack.push(s.heading);
    }
    const heading = s.heading || title;
    const trail = [title, ...stack.filter(Boolean)].filter(
      (h, i, all) => h && all.indexOf(h) === i,
    );
    const name = (s.level > 0 ? trail : [heading]).join(" › ");
    const paras = s.text
      .split(/\n/)
      .map((t, i) => ({ line: (s.line ?? 0) + i + 1, text: t.trim() }))
      .filter((p) => p.text);
    if (!paras.length) continue;
    const id = `${path}#${heading}`;
    if (used.has(id)) continue;
    used.add(id);
    const parts = partsOf(paras);
    parts.forEach((p, i) => {
      const pid = i === 0 ? id : `${id}#${i + 1}`;
      const of = parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : "";
      const where = s.page
        ? `, page ${s.page}`
        : s.line !== undefined
          ? `, line ${i === 0 ? s.line : p.line}`
          : "";
      const cite = `${path} § ${heading}${where}`;
      out.nodes.push({
        key: `document:DocumentSection:${pid}`,
        kind: "DocumentSection",
        id: pid,
        grp: "document",
        name,
        file: path,
        verified: false,
        line: `document ${path} § ${name}${of} [${cite}]`,
        detail: `${path} › ${name}${of} (${cite}):\n${p.text}`,
        names: name,
        ids: idWords(path),
        body: p.text,
        mentions: true,
      });
      if (i > 0)
        out.links.push({
          from: `document:DocumentSection:${pid}`,
          to: id,
          by: "id",
          type: "part-of",
          how: `part ${i + 1}`,
        });
    });
  }
  return out;
}

function profileNodes(path: string, text: string): FileRead {
  let d: Record<string, unknown>;
  try {
    d = (parse(text) ?? {}) as Record<string, unknown>;
  } catch (e) {
    return { nodes: [], names: [], links: [], problem: (e as Error).message.split("\n")[0]! };
  }
  const out: FileRead = { nodes: [], names: [], links: [] };
  for (const s of arr(d.systems) as Record<string, unknown>[]) {
    const id = str(s.id);
    if (!id) continue;
    const name = str(s.name) ?? id;
    const aliases = arr(s.aliases).filter((a): a is string => typeof a === "string");
    out.nodes.push({
      key: `org-pack:System:${id}`,
      kind: "System",
      id,
      grp: "org-pack",
      name,
      file: path,
      verified: false,
      line: `system ${id} "${name}"${str(s.boundary) ? ` (${String(s.boundary)})` : ""}${str(s.owner) ? `, owner ${String(s.owner)}` : ""}${aliases.length ? `, also called ${aliases.join(", ")}` : ""} [${path}]`,
      detail: `System ${id} "${name}" in the org pack profile (${path}): boundary ${str(s.boundary) ?? "?"}${str(s.owner) ? `, owner ${String(s.owner)}` : ""}${aliases.length ? `; also called ${aliases.join(", ")}` : ""}.`,
      names: [name, ...aliases].join("\n"),
      ids: idWords(id),
      body: [str(s.boundary) ?? "", str(s.owner) ?? ""].join("\n"),
      mentions: false,
    });
    out.names.push(
      { name: foldName(id), id, kind: "System", how: "id" },
      { name: foldName(name), id, kind: "System", how: "name:org-pack" },
      ...aliases.map((a) => ({ name: foldName(a), id, kind: "System", how: "alias:org-pack" })),
    );
  }
  return out;
}

/** Read one file into rows. */
export function readSource(root: string, f: SourceFile, text: string): FileRead {
  switch (f.source) {
    case "catalog": {
      const r = deserializeRecord(text);
      if (!r.ok)
        return {
          nodes: [],
          names: [],
          links: [],
          problem: r.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
        };
      return { ...recordNode(r.record, f.path, "catalog"), record: r.record };
    }
    case "knowledge": {
      const r = deserializeRecord(text);
      if (!r.ok)
        return {
          nodes: [],
          names: [],
          links: [],
          problem: r.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
        };
      if (!knowledgeKindOf(r.record)) return { nodes: [], names: [], links: [] };
      return recordNode(r.record, f.path, "knowledge");
    }
    case "review": {
      try {
        const d = parse(text) as Record<string, unknown>;
        if (!str(d?.item) || !str(d?.verdict))
          return { nodes: [], names: [], links: [], problem: "not a review" };
        return {
          nodes: [],
          names: [],
          links: [],
          review: {
            item: String(d.item),
            verdict: String(d.verdict),
            by: str(d.by) ?? "",
            at: str(d.at) ?? "",
          },
        };
      } catch (e) {
        return { nodes: [], names: [], links: [], problem: (e as Error).message.split("\n")[0]! };
      }
    }
    case "flow":
      return flowNodes(text, f.path);
    case "change":
      return changeNodes(f.path, text);
    case "question":
      return questionNodes(f.path, text);
    case "wiki":
      return wikiNodes(root, f.path, text);
    case "profile":
      return profileNodes(f.path, text);
    case "document":
      // Read from its bytes by documentNodes (store.ts); never as text here.
      return { nodes: [], names: [], links: [] };
  }
}
