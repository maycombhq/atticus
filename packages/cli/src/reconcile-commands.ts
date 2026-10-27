import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  loadOrgPack,
  parseRecord,
  recordPath,
  serializeRecord,
  orgPackDirOf,
} from "@maycombhq/core";
import { readDiagram } from "@maycombhq/ingestors";
import { reconcile, type ReconcileResult } from "@maycombhq/reconcile";
import { readCatalog } from "@maycombhq/scanner";
import type { Output } from "./commands.js";

const DEFAULT_DIR = "inputs/diagrams";

async function findDiagrams(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.(drawio|drawio\.xml|vsdx|mmd|mermaid|csv)$/i.test(e.name)) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

/**
 * atticus reconcile [diagram...]: compare each diagram with the catalog. Exit 0 when they
 * agree, 1 when there are items to resolve, 2 when there is nothing to read.
 */
export async function reconcileCommand(
  root: string,
  files: string[],
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const paths =
    files.length > 0
      ? files.map((f) => resolve(root, f))
      : await findDiagrams(join(root, ...DEFAULT_DIR.split("/")));
  if (paths.length === 0) {
    io.err(
      `No diagrams to reconcile: name one, or put diagrams (.drawio, .vsdx, Lucid .csv, .mmd) under ${DEFAULT_DIR}/`,
    );
    return 2;
  }
  const texts: { file: string; bytes: Uint8Array }[] = [];
  for (const p of paths) {
    try {
      texts.push({ file: relative(root, p).split(sep).join("/"), bytes: await readFile(p) });
    } catch {
      io.err(`Can't read ${p}`);
      return 2;
    }
  }
  const op = await loadOrgPack(join(orgPackDirOf(root)));
  const profile = op.profiles[0]?.profile;
  const catalogDir = join(root, op.sources.layout.catalog);
  const generated = await readCatalog(join(catalogDir, "generated"), { cacheRoot: root });
  const curated = await readCatalog(join(catalogDir, "curated"), { cacheRoot: root });
  for (const p of [...generated.problems, ...curated.problems])
    io.err(`catalog ${p.file}: ${p.message}`);
  const records = [...generated.records, ...curated.records];
  if (generated.records.length === 0)
    io.err("The catalog is empty: run atticus scan first, or every edge will be diagram-only.");

  const results: (ReconcileResult & {
    file: string;
    edges: number;
    problems: { cell: string; message: string }[];
  })[] = [];
  for (const t of texts) {
    const diagram = readDiagram(t.file, t.bytes, profile?.legend);
    if (!diagram) {
      io.err(
        `${t.file}: not a diagram Atticus can read (draw.io, Visio .vsdx, Lucid CSV, Mermaid)`,
      );
      continue;
    }
    const r = reconcile({
      diagram,
      file: t.file,
      records,
      systems: profile?.systems ?? [],
      patterns: op.patterns,
    });
    results.push({ file: t.file, edges: diagram.edges.length, problems: diagram.problems, ...r });
  }
  if (o.json)
    io.out(
      JSON.stringify(
        {
          diagrams: results.map(({ file, edges, matches, items, names, problems }) => ({
            file,
            edges,
            matches,
            items,
            names,
            problems,
          })),
        },
        null,
        2,
      ),
    );
  else
    for (const r of results) {
      io.out(
        `${r.file}: ${r.edges} edges, ${r.matches.length} matched to code, ${r.items.length} item${r.items.length === 1 ? "" : "s"}`,
      );
      for (const p of r.problems) io.out(`  ! cell ${p.cell}: ${p.message}`);
      for (const i of r.items) {
        io.out(`  ${i.type} ${i.diagram ? `[${i.diagram.cell}] ` : ""}${i.summary}`);
        if (i.suggestion) io.out(`    → ${i.suggestion.text}`);
      }
    }
  return results.some((r) => r.items.length > 0) ? 1 : 0;
}

/**
 * atticus alias "<name>" <id>: record that a name people use (in diagrams, documents) means
 * this catalog record. Written as a CuratedDecision in catalog/curated; a person runs it, so
 * it is the human approval the alias needs.
 */
export async function aliasCommand(
  root: string,
  name: string,
  target: string,
  o: { by?: string; reason?: string },
  io: Output,
): Promise<number> {
  const op = await loadOrgPack(join(orgPackDirOf(root)));
  const catalogDir = join(root, op.sources.layout.catalog);
  const generated = await readCatalog(join(catalogDir, "generated"), { cacheRoot: root });
  const systems = op.profiles.flatMap((p) => p.profile?.systems ?? []).map((s) => s.id);
  if (!generated.records.some((r) => r.id === target) && !systems.includes(target)) {
    io.err(
      `${target} isn't in the catalog. Find the id with: atticus query "${name.split(" ")[0]}"`,
    );
    return 1;
  }
  const slugName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const p = parseRecord({
    schemaVersion: 1,
    kind: "CuratedDecision",
    id: `alias.${slugName}`,
    status: "current",
    confidence: "asserted",
    target,
    action: "alias",
    value: name,
    reason: o.reason ?? `"${name}" is ${target}`,
    by: o.by ?? userInfo().username,
    at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  if (!p.ok) {
    io.err(p.issues.map((i) => `${i.path}: ${i.message}`).join("\n"));
    return 1;
  }
  const rel = `${op.sources.layout.catalog}/curated/${recordPath(p.record)}`;
  const full = join(root, ...rel.split("/"));
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, serializeRecord(p.record), "utf8");
  io.out(`Wrote ${rel}: "${name}" is ${target}. Commit it so everyone's reconcile uses it.`);
  return 0;
}
