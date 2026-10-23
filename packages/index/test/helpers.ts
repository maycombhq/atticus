import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";

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
