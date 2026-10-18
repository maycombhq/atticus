import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FORGE = join(HERE, "../../../fixtures/forge");
export const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
export const FIXTURES = join(HERE, "fixtures");
export const CHANGE = "add-transfer-limit";
export const NOW = "2026-10-20T09:00:00Z";

/**
 * A temporary metarepo for the M3 exit fixture: the Forge org pack with the forge-change
 * additions (critic agents, the Ledger team's pack) laid over it, the Forge expected catalog
 * as catalog files, and the seeded change add-transfer-limit.
 */
export async function forgeChangeRoot(o: { change?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-naysayer-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FORGE_CHANGE, "org-pack"), join(root, "org-pack"), { recursive: true });
  const rows = parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[];
  for (const r of rows) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(`bad fixture record ${String(r.id)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await mkdir(join(root, "openspec/changes"), { recursive: true });
  if (o.change !== false)
    await cp(
      join(FORGE_CHANGE, "openspec/changes", CHANGE),
      join(root, "openspec/changes", CHANGE),
      {
        recursive: true,
      },
    );
  return root;
}

export const changeDir = (root: string, id = CHANGE) => join(root, "openspec/changes", id);

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function write(root: string, rel: string, text: string): Promise<void> {
  const p = join(root, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text);
}
