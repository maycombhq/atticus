import { readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord, zip } from "@maycombhq/core";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIX = join(HERE, "../../../fixtures");
export const STAGES = join(FIX, "stages");
export const CONTEXT = join(FIX, "context");

async function writeRecords(root: string, dir: string, file: string) {
  for (const r of parse(readFileSync(file, "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, dir, recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
}

export const RETRIEVAL = join(FIX, "retrieval");

async function writeBare(root: string, dir: string, file: string) {
  for (const r of parse(readFileSync(file, "utf8")) as Record<string, unknown>[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(`bad fixture record ${String(r.id)}: ${JSON.stringify(p.issues)}`);
    const f = join(root, dir, recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
}

/** A folder of a document's parts (fixtures keep Office files as XML) as the file's bytes. */
export function zipFolder(dir: string): Buffer {
  const parts: { name: string; data: Uint8Array }[] = [];
  const walkDir = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }))
      if (e.isDirectory()) walkDir(join(d, e.name), `${rel}${e.name}/`);
      else parts.push({ name: `${rel}${e.name}`, data: readFileSync(join(d, e.name)) });
  };
  walkDir(dir, "");
  parts.sort((a, b) => (a.name < b.name ? -1 : 1));
  return zip(parts, new Date(2026, 8, 15, 12, 0, 0));
}

/**
 * The Forge scan with the retrieval fixtures laid over it (ADR 0116): camel-case columns,
 * glossary terms and their curated aliases, the long wiki page and the Word runbook in inputs/.
 * Without the distractors unless asked.
 */
export async function retrievalRoot(o: { distractors?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-retrieval-"));
  await cp(join(FIX, "forge/metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeBare(root, "catalog/generated", join(FIX, "forge/expected/scan.yaml"));
  await writeBare(root, "catalog/generated", join(RETRIEVAL, "catalog-extra.yaml"));
  if (o.distractors)
    await writeBare(root, "catalog/generated", join(RETRIEVAL, "distractors.yaml"));
  await writeBare(root, "catalog/curated", join(RETRIEVAL, "curated.yaml"));
  await cp(join(RETRIEVAL, "knowledge"), join(root, "knowledge"), { recursive: true });
  await mkdir(join(root, "inputs/documents"), { recursive: true });
  await writeFile(
    join(root, "inputs/documents/settlement-runbook.docx"),
    zipFolder(join(RETRIEVAL, "documents/settlement-runbook-docx")),
  );
  return root;
}

/** The stage fixture's metarepo with the context fixture laid over it. */
export async function contextRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-context-"));
  await writeRecords(root, "catalog/generated", join(FIX, "specs/catalog.yaml"));
  await writeRecords(root, "catalog/generated", join(STAGES, "catalog-extra.yaml"));
  await writeRecords(root, "knowledge/items", join(STAGES, "knowledge.yaml"));
  await writeRecords(root, "knowledge/items", join(CONTEXT, "knowledge.yaml"));
  await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(STAGES, "changes"), join(root, "openspec/changes"), { recursive: true });
  await cp(join(CONTEXT, "changes"), join(root, "openspec/changes"), { recursive: true });
  await cp(join(CONTEXT, "org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(CONTEXT, "knowledge"), join(root, "knowledge"), { recursive: true });
  await cp(join(CONTEXT, "questions"), join(root, "questions"), { recursive: true });
  return root;
}
