import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord, type CatalogRecord } from "@maycombhq/core";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "fixtures");
export const FORGE = join(HERE, "../../../fixtures/forge");
export const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
export const CHANGE = "add-transfer-limit";
export const SCANNED_AT = "2026-10-20T09:00:00Z";

export function record(r: Record<string, unknown>): CatalogRecord {
  const p = parseRecord({ schemaVersion: 2, status: "current", ...r });
  if (!p.ok) throw new Error(`${String(r.id)}: ${JSON.stringify(p.issues)}`);
  return p.record;
}

export const forgeRecords = (): CatalogRecord[] =>
  (parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<string, unknown>[]).map(
    record,
  );

/** Where metarepo() put the copy of a Forge repo (tests may change its files). */
export const repoDir = (root: string, repo: string) => join(root, "..", "repos", repo);

/**
 * A metarepo laid out like fixtures/forge (metarepo/ beside repos/, so the Forge dialect's
 * own tests find their fixture): the Forge org pack, the Forge expected catalog as
 * catalog/generated files, copies of the Forge repos, and optionally the add-transfer-limit
 * change from the M3 exit fixture at the given state.
 */
export async function metarepo(
  o: { change?: string; records?: CatalogRecord[]; ciYaml?: string } = {},
): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "atticus-ci-"));
  const root = join(base, "metarepo");
  await cp(join(FORGE, "repos"), join(base, "repos"), { recursive: true });
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  if (o.ciYaml) {
    await mkdir(join(root, "org-pack/process"), { recursive: true });
    await writeFile(join(root, "org-pack/process/ci.yaml"), o.ciYaml);
  }
  for (const r of o.records ?? forgeRecords()) {
    const f = join(root, "catalog/generated", recordPath(r));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(r));
  }
  if (o.change) {
    const dir = join(root, "openspec/changes", CHANGE);
    await cp(join(FORGE_CHANGE, "openspec/changes", CHANGE), dir, { recursive: true });
    const p = join(dir, "change.yaml");
    await writeFile(p, atState(readFileSync(p, "utf8"), o.change));
  }
  return root;
}

const PATH = ["plan", "build", "qa", "release-ready", "released"];

/** The fixture's change.yaml (at plan) moved on to a later state, with its history. */
export function atState(text: string, state: string): string {
  const steps = PATH.slice(0, PATH.indexOf(state) + 1);
  if (steps.length < 2) return text;
  const entries = steps
    .slice(1)
    .map(
      (to, i) =>
        `  - from: ${steps[i]}\n    to: ${to}\n    at: 2026-10-2${i}T10:00:00Z\n    by: tia\n    reason: Moved on for the test`,
    )
    .join("\n");
  return text
    .replace(/^state: plan$/m, `state: ${state}`)
    .replace(/( {4}reason: Approve design merged\n)/, `$1${entries}\n`);
}

export async function put(dir: string, rel: string, text: string): Promise<void> {
  const f = join(dir, rel);
  await mkdir(dirname(f), { recursive: true });
  await writeFile(f, text);
}
