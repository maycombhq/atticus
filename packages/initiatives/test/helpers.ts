import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "fixtures");
export const NW = join(FIXTURES, "northwind-v3");
export const FORGE = join(HERE, "../../../fixtures/forge");
export const ID = "northwind-pay-v3-migration";

export const read = (p: string) => readFile(p, "utf8");
export const expectedYaml = <T>(f: string): T =>
  parse(readFileSync(join(NW, "expected", f), "utf8")) as T;

/**
 * A metarepo for the golden initiative: the Forge org pack, the Forge expected catalog as
 * generated records, Forge's inputs (the closed-request export lives there), and this
 * package's hand-written parties and owner question as curated records.
 */
export async function forgeRoot(o: { parties?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-initiatives-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  const rows = parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[];
  for (const r of rows) {
    const p = parseRecord({ schemaVersion: 2, status: "current", ...r });
    if (!p.ok) throw new Error(`bad fixture record ${String(r.id)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FORGE, "inputs"), join(root, "inputs"), { recursive: true });
  if (o.parties !== false)
    await cp(join(NW, "curated"), join(root, "catalog/curated"), { recursive: true });
  await mkdir(join(root, "openspec/changes"), { recursive: true });
  return root;
}
