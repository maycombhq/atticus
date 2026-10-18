import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  loadOrgPack,
  normalizePath,
  parseRecord,
  type CatalogRecord,
  type OrgPack,
} from "@maycombhq/core";
import { drawioIngestor, readDrawio, resolveNames, type ProfileSystem } from "@maycombhq/reconcile";
import type { Ingestor, ScanContext } from "@maycombhq/sdk";
import { classify, type Classification } from "./classify.js";
import { readAsyncApiSpec, readOpenApiSpec, readPayload, READERS } from "./readers.js";
import {
  boundedId,
  opt,
  slug,
  sortItems,
  type IntakeDocument,
  type IntakeProblem,
  type ScanInputsResult,
  type TriageItem,
} from "./types.js";

/**
 * Intake: everything under inputs/ (partner specs, diagrams, the inbox, ...), with no sorting
 * by people. Each file is classified from its content, deduplicated by sha-256, checked for an
 * older or newer version, linked to systems through the alias table and read where a
 * deterministic reader exists. What intake can't settle goes to triage.
 *
 * Confidence by input: a partner spec is verified for what it says about its own system;
 * diagrams, spreadsheets and other documents are inferred at most; payload samples give a
 * schema (inferred) and their values are discarded. Wiki folders named in sources.yaml are
 * left to the wiki reader. Reads files only: no network, no AI, no clock in any record.
 */

export interface ScanInputsOptions {
  /** The metarepo root. Record paths are relative to it and start with inputs/. */
  root: string;
  /** Org pack folder (default <root>/org-pack) or an org pack already loaded. */
  orgPack?: string | OrgPack;
  /** Where inputs/ is, when it isn't <root>/inputs (the Forge fixture keeps it beside the metarepo). */
  inputsDir?: string;
  /** The catalog so far (generated and curated): for names, decisions and conflicts with code. */
  records?: CatalogRecord[];
  /** Readers for files intake has no built-in reader for. Default: the draw.io ingestor. */
  ingestors?: readonly Ingestor[];
  /** One timestamp for ingestors' scan context. */
  scannedAt?: string;
}

const SPECS: Classification[] = ["openapi", "swagger", "asyncapi"];
const EVIDENCE_SOURCE: Record<Classification, "spec" | "diagram" | "document" | "export"> = {
  openapi: "spec",
  swagger: "spec",
  asyncapi: "spec",
  diagram: "diagram",
  image: "document",
  document: "document",
  spreadsheet: "export",
  "ticket-export": "export",
  payload: "document",
  unknown: "document",
};

interface File {
  abs: string;
  path: string;
  bytes: Uint8Array;
  hash: string;
  stem: string;
  inbox: boolean;
  doc: IntakeDocument;
  data?: unknown;
  family?: string;
}

type Rec = Record<string, unknown> & {
  kind: string;
  id: string;
  confidence: string;
  evidence: Record<string, unknown>[];
};

type ProfileSystemFull = NonNullable<OrgPack["profiles"][number]["profile"]>["systems"][number];

const posix = (p: string) => p.split(sep).join("/");
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

async function walk(dir: string, skip: string[]): Promise<string[]> {
  const out: string[] = [];
  async function go(d: string) {
    if (skip.some((s) => d === s)) return;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) await go(full);
      else if (e.isFile()) out.push(full);
    }
  }
  await go(dir);
  return out;
}

const DATE = /(?:^|[-_ .])((\d{4})-?(\d{2})-?(\d{2}))(?=$|[-_ .])/;
const VERSION = /(?:^|[-_ .])v(\d+(?:[._]\d+)*)(?=$|[-_ .])/i;

/** Version and date tokens in a file name, and the name without them (its family). */
function nameParts(stem: string): { base: string; version?: string; date?: string } {
  let rest = stem;
  let date: string | undefined;
  const d = DATE.exec(rest);
  if (d) {
    const iso = `${d[2]}-${d[3]}-${d[4]}`;
    if (!Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) {
      date = iso;
      rest = rest.replace(d[1]!, "");
    }
  }
  let version: string | undefined;
  const v = VERSION.exec(rest);
  if (v) {
    version = v[1]!.replace(/_/g, ".");
    rest = rest.replace(v[0], "");
  }
  return { base: slug(rest), ...(version ? { version } : {}), ...(date ? { date } : {}) };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/** Which systems a file name mentions, as whole words: "northwind-pay-openapi" → northwind-pay. */
function systemsInName(stem: string, systems: ProfileSystem[]): string[] {
  const s = `-${slug(stem)}-`;
  return systems
    .filter((sys) =>
      [sys.id, sys.name, ...sys.aliases].some((n) => slug(n) && s.includes(`-${slug(n)}-`)),
    )
    .map((sys) => sys.id)
    .sort();
}

export async function scanInputs(o: ScanInputsOptions): Promise<ScanInputsResult> {
  const orgPackDir = typeof o.orgPack === "string" ? o.orgPack : join(o.root, "org-pack");
  const op = typeof o.orgPack === "object" ? o.orgPack : await loadOrgPack(orgPackDir);
  const systems: ProfileSystemFull[] = op.profiles.flatMap((p) => p.profile?.systems ?? []);
  const legend = op.profiles.find((p) => p.profile?.legend)?.profile?.legend;
  const records = o.records ?? [];
  const ingestors = o.ingestors ?? [drawioIngestor];
  const scannedAt = o.scannedAt ?? new Date().toISOString();
  const inputsDir = o.inputsDir ?? join(o.root, "inputs");
  const problems: IntakeProblem[] = [];
  const triage: TriageItem[] = [];
  const authors = new Map<string, string>();

  // Wiki folders have their own reader; leave them out wherever their location points.
  const wikiDirs = op.sources.wikis.flatMap((w) =>
    /^[a-z][a-z0-9+.-]*:\/\//i.test(w.location)
      ? []
      : [resolve(orgPackDir, w.location), resolve(o.root, w.location)],
  );
  const st = await stat(inputsDir).catch(() => undefined);
  const paths = st?.isDirectory() ? await walk(inputsDir, wikiDirs) : [];

  // ---- read, hash and classify
  const files: File[] = [];
  for (const abs of paths) {
    const bytes = new Uint8Array(await readFile(abs));
    const path = `inputs/${posix(relative(inputsDir, abs))}`;
    const name = path.split("/").pop()!;
    const c = classify(name, bytes);
    files.push({
      abs,
      path,
      bytes,
      hash: createHash("sha256").update(bytes).digest("hex"),
      stem: name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name,
      inbox: path.startsWith("inputs/inbox/"),
      ...(c.data !== undefined ? { data: c.data } : {}),
      doc: {
        path,
        classification: c.classification,
        status: "no-reader",
        hash: "",
        ...(c.title ? { title: c.title } : {}),
        ...(c.version ? { version: c.version } : {}),
        systems: [],
        unknownNames: [],
        records: [],
      },
    });
  }
  for (const f of files) f.doc.hash = f.hash;

  // ---- duplicates: the copy outside the inbox (then the first by path) is the one kept
  const canonical = [...files].sort((a, b) =>
    a.inbox === b.inbox ? (a.path < b.path ? -1 : 1) : a.inbox ? 1 : -1,
  );
  const firstByHash = new Map<string, File>();
  const kept: File[] = [];
  for (const f of canonical) {
    const first = firstByHash.get(f.hash);
    if (first) {
      f.doc.status = "duplicate";
      f.doc.duplicateOf = first.path;
      continue;
    }
    firstByHash.set(f.hash, f);
    kept.push(f);
  }

  // ---- ids: doc.<file name>, or with its folders when two files share a name
  const taken = new Set<string>();
  for (const f of kept) {
    const folders = f.path.split("/").slice(1, -1);
    let id = boundedId("doc.", slug(f.stem) || "file");
    if (taken.has(id)) id = boundedId("doc.", slug([...folders, f.stem].join("-")));
    for (let n = 2; taken.has(id); n++) id = boundedId("doc.", `${slug(f.stem)}-${n}`);
    taken.add(id);
    f.doc.id = id;
  }
  const byId = new Map(kept.map((f) => [f.doc.id!, f]));

  // ---- versions: same spec title, or the same file name once version and date are removed
  for (const f of kept) {
    const parts = nameParts(f.stem);
    if (!f.doc.version && parts.version) f.doc.version = parts.version;
    if (parts.date) f.doc.date = parts.date;
    f.family =
      SPECS.includes(f.doc.classification) && f.doc.title
        ? `spec:${slug(f.doc.title)}`
        : `${f.doc.classification}:${parts.base || slug(f.stem)}`;
  }
  const decidedSupersede = new Map<string, string>();
  for (const r of records)
    if (
      r.kind === "CuratedDecision" &&
      r.status === "current" &&
      r.action === "assert" &&
      isObj(r.value) &&
      typeof r.value.supersededBy === "string" &&
      byId.has(r.target) &&
      byId.has(r.value.supersededBy)
    )
      decidedSupersede.set(r.target, r.value.supersededBy);
  const families = new Map<string, File[]>();
  for (const f of kept) families.set(f.family!, [...(families.get(f.family!) ?? []), f]);
  for (const members of families.values()) {
    if (members.length < 2) continue;
    for (const m of members) {
      const by = decidedSupersede.get(m.doc.id!);
      if (by) m.doc.supersededBy = by;
    }
    const heads = members.filter((m) => !m.doc.supersededBy);
    if (heads.length < 2) continue;
    const distinct = (vals: (string | undefined)[], cmp: (a: string, b: string) => number) =>
      vals.every((v) => v !== undefined) &&
      vals.every((v, i) => vals.every((w, j) => i === j || cmp(v!, w!) !== 0));
    const byVersion = distinct(
      heads.map((h) => h.doc.version),
      compareVersions,
    );
    const byDate =
      !byVersion &&
      distinct(
        heads.map((h) => h.doc.date),
        (a, b) => (a < b ? -1 : a > b ? 1 : 0),
      );
    if (byVersion || byDate) {
      const ordered = [...heads].sort((a, b) =>
        byVersion
          ? compareVersions(a.doc.version!, b.doc.version!)
          : a.doc.date! < b.doc.date!
            ? -1
            : 1,
      );
      for (let i = 0; i + 1 < ordered.length; i++)
        ordered[i]!.doc.supersededBy = ordered[i + 1]!.doc.id;
      continue;
    }
    for (const h of heads) {
      const others = heads.filter((x) => x !== h);
      const itemId = `version-unclear.${slug(h.doc.id!)}`;
      triage.push({
        id: itemId,
        kind: "version-unclear",
        summary: `${h.path} looks like another version of ${others.map((x) => x.path).join(" and ")}, and neither says which is newer.`,
        source: { path: h.path },
        records: [h.doc.id!, ...others.map((x) => x.doc.id!)],
        options: [
          ...others.map((x) =>
            opt.make(
              itemId,
              "assert",
              h.doc.id!,
              { supersededBy: x.doc.id },
              `${x.path} replaces it`,
            ),
          ),
          opt.dismiss(itemId, h.doc.id!, "It is the current version"),
        ],
      });
    }
  }
  for (const f of kept) if (f.doc.supersededBy) f.doc.status = "superseded";

  // ---- names → systems
  const components = new Map(
    records
      .filter((r) => r.kind === "Component")
      .map((r) => [r.id, r as unknown as { id: string; system: string }]),
  );
  const systemOf = (id: string) => components.get(id)?.system ?? id;
  const resolveName = (name: string) => resolveNames([name], records, systems).get(name)!;
  /** The component a spec's endpoints belong to: a system with one component is that component. */
  const componentFor = (id: string) => {
    if (components.has(id)) return id;
    const inSys = [...components.values()].filter((c) => c.system === id);
    return inSys.length === 1 ? inSys[0]!.id : id;
  };

  const out: Rec[] = [];
  const systemRecords = new Map<string, Rec>();
  const specOps: { file: File; component: string; system: string; endpoints: Rec[] }[] = [];

  for (const f of kept) {
    const cls = f.doc.classification;
    const current = !f.doc.supersededBy;
    const text = () => new TextDecoder().decode(f.bytes);
    const linked = new Set<string>();
    const unknown = new Set<string>();

    // ---- partner specs
    if (SPECS.includes(cls)) {
      const title = f.doc.title;
      let target: string | undefined;
      if (title) {
        const res = resolveName(title);
        if (res.id) {
          target = res.id;
          if (res.how === "profile" && current) {
            const itemId = `alias-needed.${slug(title)}`;
            triage.push({
              id: itemId,
              kind: "alias-needed",
              summary: `The partner spec's title "${title}" was matched to ${res.id} through the profile; confirm it so later documents match it directly.`,
              source: { path: f.path, ...lineOf(text(), "title") },
              records: [res.id],
              options: [opt.alias(title, res.id), opt.dismiss(itemId, res.id)],
            });
          }
        }
      }
      if (!target) {
        const inName = systemsInName(f.stem, systems);
        if (inName.length === 1) target = inName[0];
      }
      if (!target) {
        const name = title ?? f.stem;
        unknown.add(name);
        f.doc.status = current ? "unresolved" : f.doc.status;
        if (current) {
          const similar = resolveName(name).similar;
          const itemId = `unknown-name.${slug(name)}`;
          triage.push({
            id: itemId,
            kind: "unknown-name",
            summary: `The partner spec's ${title ? "title" : "file name"} "${name}" matches no system${similar.length ? ` (similar: ${similar.join(", ")})` : ""}; its facts wait until someone says which system it is.`,
            source: { path: f.path, ...(title ? lineOf(text(), "title") : {}) },
            records: similar,
            options: [...similar.map((s) => opt.alias(name, s)), opt.dismiss(itemId, f.doc.id!)],
          });
        }
      } else {
        const component = componentFor(target);
        const system = systemOf(component);
        linked.add(system);
        if (current) {
          const read =
            cls === "asyncapi"
              ? readAsyncApiSpec(f.path, text(), component)
              : await readOpenApiSpec(f.path, text(), component, scannedAt);
          const endpoints = read as unknown as Rec[];
          f.doc.status = "read";
          f.doc.reader = cls === "asyncapi" ? READERS.asyncapi : READERS.openapi;
          out.push(...endpoints);
          f.doc.records.push(...endpoints.map((e) => e.id));
          specOps.push({ file: f, component, system, endpoints });
          // A system with no code of its own (a vendor) is verified by its published spec.
          const sys = systems.find((s) => s.id === component);
          if (sys) {
            const ev = { source: "spec", path: f.path, side: "definition" };
            const prev = systemRecords.get(sys.id);
            if (prev) prev.evidence = [...prev.evidence, ev];
            else
              systemRecords.set(sys.id, {
                schemaVersion: 1,
                kind: "System",
                id: sys.id,
                status: "current",
                confidence: "verified",
                name: sys.name,
                boundary: sys.boundary,
                ...(sys.owner ? { owner: sys.owner } : {}),
                repos: [],
                tags: [],
                accessGroup: "everyone",
                evidence: [ev],
              });
            f.doc.records.push(sys.id);
          }
        }
      }
    } else {
      for (const s of systemsInName(f.stem, systems)) linked.add(s);
    }

    // ---- names on a draw.io diagram
    if (cls === "diagram" && f.bytes[0] !== 0x50) {
      try {
        const d = readDrawio(text(), legend);
        for (const n of d.nodes) {
          const res = resolveName(n.label);
          if (res.id) linked.add(systemOf(res.id));
          else if (!n.legend) unknown.add(n.label);
        }
      } catch {
        // not readable as draw.io: the ingestor (if any) reports it
      }
    }

    // ---- payload samples: the schema, never the values
    if (current && cls === "payload" && f.data !== undefined) {
      const schema = readPayload(
        f.path,
        boundedId("payload.", f.doc.id!.slice(4)),
        f.data,
      ) as unknown as Rec;
      out.push(schema);
      f.doc.records.push(schema.id);
      f.doc.status = "read";
      f.doc.reader = READERS.payload;
    }

    // ---- everything else: the plugged-in ingestor that claims the file
    if (current && f.doc.status === "no-reader" && !SPECS.includes(cls)) {
      const head = f.bytes.subarray(0, 4096);
      const scored = ingestors
        .map((ing, i) => ({ ing, i, score: safeSniff(ing, f.path, head) }))
        .filter((x) => x.score >= 0.5)
        .sort((a, b) => b.score - a.score || a.i - b.i);
      const chosen = scored[0]?.ing;
      if (chosen) {
        const reader = `${chosen.id}@${chosen.version}`;
        f.doc.reader = reader;
        const ctx: ScanContext = {
          dialects: [],
          scannedAt,
          warn: (message) => problems.push({ path: f.path, message: `${reader}: ${message}` }),
        };
        const got: Rec[] = [];
        try {
          for await (const r of chosen.ingest(f.path, f.bytes, ctx)) got.push(r as unknown as Rec);
          f.doc.status = "read";
        } catch (e) {
          f.doc.status = "failed";
          problems.push({ path: f.path, message: `${reader} failed: ${(e as Error).message}` });
        }
        if (f.doc.status === "read") {
          for (const r of got) {
            if (r.kind === "SourceDocument") {
              // the ingestor's own document record: keep what it knows about the file
              if (typeof r.version === "string" && !f.doc.version) f.doc.version = r.version;
              if (typeof r.date === "string" && !f.doc.date) f.doc.date = r.date;
              if (typeof r.author === "string") authors.set(f.doc.id!, r.author);
              continue;
            }
            if (!r.evidence?.some((e) => e.path === f.path)) {
              problems.push({
                path: f.path,
                message: `${reader} emitted ${r.kind} ${r.id} without citing the file; left out`,
              });
              continue;
            }
            // Only a published spec is verified; anything read from a document is inferred at most.
            const capped = { ...r, confidence: "inferred" };
            const p = parseRecord(capped);
            if (!p.ok) {
              problems.push({
                path: f.path,
                message: `${reader} emitted an invalid ${r.kind} ${r.id}: ${p.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
              });
              continue;
            }
            out.push(p.record as unknown as Rec);
            f.doc.records.push(r.id);
          }
        }
      } else if (cls === "document" || cls === "image") f.doc.status = "needs-reading";
    }

    f.doc.systems = [...linked].sort();
    f.doc.unknownNames = [...unknown].sort();
    f.doc.records = [...new Set(f.doc.records)].sort();
  }

  // ---- partner specs never overwrite code: disagreements go to triage
  const recs = records as unknown as Rec[];
  const fromCode = (r: Rec) => r.evidence.some((e) => e.source === "code" || e.source === "config");
  for (const { file, component, system, endpoints } of specOps) {
    for (const e of endpoints.filter((x) => x.endpointType === "rest")) {
      const code = recs.find(
        (r) =>
          r.kind === "Endpoint" &&
          r.component === component &&
          String(r.method ?? "").toUpperCase() === e.method &&
          normalizePath(String(r.normalizedPath ?? r.pathOrTopic)) === e.normalizedPath &&
          fromCode(r),
      );
      if (code?.auth && e.auth && code.auth !== e.auth) {
        const itemId = `conflict.${slug(`${e.id}-auth`)}`;
        const line = e.evidence[0]?.line as number | undefined;
        triage.push({
          id: itemId,
          kind: "conflict",
          summary: `The partner spec says ${e.id} uses ${String(e.auth)}; the code says ${String(code.auth)}. The code stands until someone decides.`,
          source: { path: file.path, ...(line ? { line } : {}) },
          records: [code.id],
          options: [
            opt.dismiss(itemId, code.id, "The code is right"),
            opt.make(
              itemId,
              "assert",
              code.id,
              { auth: e.auth },
              `The partner spec is right: auth is ${String(e.auth)}`,
            ),
          ],
        });
      }
    }
    if (!["openapi", "swagger"].includes(file.doc.classification)) continue;
    const ends = new Set([
      component,
      system,
      ...[...components.values()].filter((c) => c.system === system).map((c) => c.id),
    ]);
    for (const i of recs.filter(
      (r) => r.kind === "Interface" && ends.has(String(r.to)) && r.sync === "sync" && r.method,
    )) {
      const has = endpoints.some(
        (e) => e.method === String(i.method).toUpperCase() && e.normalizedPath === i.normalizedPath,
      );
      if (has) continue;
      const itemId = `conflict.${slug(`${i.id}-not-in-spec`)}`;
      triage.push({
        id: itemId,
        kind: "conflict",
        summary: `In code ${String(i.from)} calls ${String(i.method)} ${String(i.normalizedPath)} on ${String(i.to)}, which the partner spec doesn't have.`,
        source: { path: file.path },
        records: [i.id],
        options: [opt.dismiss(itemId, i.id, "The code is right")],
      });
    }
  }

  // ---- one SourceDocument per file kept
  for (const f of kept) {
    const author = authors.get(f.doc.id!);
    out.push({
      schemaVersion: 1,
      kind: "SourceDocument",
      id: f.doc.id!,
      status: "current",
      confidence: "verified",
      path: f.path,
      docType: f.doc.classification,
      ...(f.doc.version ? { version: f.doc.version } : {}),
      ...(author ? { author } : {}),
      ...(f.doc.date ? { date: f.doc.date } : {}),
      hash: f.hash,
      ...(f.doc.supersededBy ? { supersededBy: f.doc.supersededBy } : {}),
      recordsProduced: f.doc.records,
      evidence: [{ source: EVIDENCE_SOURCE[f.doc.classification], path: f.path }],
    });
  }
  out.push(...systemRecords.values());

  const final: CatalogRecord[] = [];
  for (const r of out.sort((a, b) =>
    a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind < b.kind ? -1 : 1,
  )) {
    const p = parseRecord(r);
    if (p.ok) final.push(p.record);
    else
      problems.push({
        path: String(r.path ?? r.evidence?.[0]?.path ?? ""),
        message: `invalid ${r.kind} ${r.id}: ${p.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      });
  }
  return {
    records: final,
    documents: files.map((f) => f.doc).sort((a, b) => (a.path < b.path ? -1 : 1)),
    triage: sortItems(triage),
    problems: problems.sort((a, b) =>
      a.path === b.path ? (a.message < b.message ? -1 : 1) : a.path < b.path ? -1 : 1,
    ),
  };
}

function safeSniff(ing: Ingestor, path: string, head: Uint8Array): number {
  try {
    return ing.sniff(path, head);
  } catch {
    return 0;
  }
}

/** The line of the first `key:` (YAML) or `"key":` (JSON) in a file, for evidence. */
function lineOf(text: string, key: string): { line?: number } {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`(^|[\\s{,])"?${key}"?\\s*:`);
  const i = lines.findIndex((l) => re.test(l));
  return i >= 0 ? { line: i + 1 } : {};
}
