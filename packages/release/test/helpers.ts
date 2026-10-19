import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "fixtures");
export const EXPECTED = join(FIXTURES, "expected");
export const FORGE = join(HERE, "../../../fixtures/forge");
export const CHANGE = join(
  HERE,
  "../../../fixtures/forge-change/openspec/changes/add-transfer-limit",
);
export const ID = "add-transfer-limit";
/** A Wednesday. */
export const NOW = "2026-10-21T09:00:00Z";

export const changeDir = (root: string) => join(root, "openspec/changes", ID);

/**
 * A metarepo: the Forge org pack, the Forge expected catalog as generated records, and the
 * seeded change add-transfer-limit at plan. `released` lays the released/ overlay over the
 * change folder; `initiative` adds the daily-limits initiative and its plan.
 */
export async function forgeRoot(
  o: { released?: boolean; initiative?: boolean; inputs?: boolean } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-release-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 2, status: "current", ...r });
    if (!p.ok) throw new Error(`bad fixture record ${String(r.id)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(CHANGE, changeDir(root), { recursive: true });
  if (o.released) await cp(join(FIXTURES, "released"), changeDir(root), { recursive: true });
  if (o.initiative) await cp(join(FIXTURES, "initiative"), root, { recursive: true });
  if (o.inputs) await cp(join(FORGE, "inputs"), join(root, "inputs"), { recursive: true });
  return root;
}

/** Move the change on to a later state, with history entries that keep change.yaml valid. */
export async function moveTo(root: string, states: string[], at = "2026-10-20T15:00:00Z") {
  const file = join(changeDir(root), "change.yaml");
  const c = parse(await readFile(file, "utf8")) as {
    state: string;
    history: { from: string; to: string; at: string; by: string; reason?: string }[];
  };
  for (const s of states) {
    c.history.push({ from: c.state, to: s, at, by: "dana", reason: `Moved to ${s} for the test` });
    c.state = s;
  }
  await writeFile(file, stringify(c));
}

export const expected = (f: string) => readFileSync(join(EXPECTED, f), "utf8");
