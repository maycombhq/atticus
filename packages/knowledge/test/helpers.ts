import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadOrgPack, parseRecord, type CatalogRecord, type OrgPack } from "@maycombhq/core";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FORGE = join(HERE, "../../../fixtures/forge");
/** The Forge metarepo root: org-pack/ lives here; the wiki is at ../inputs/wiki. */
export const FORGE_ROOT = join(FORGE, "metarepo");

/** The expected Forge catalog (hand-written), parsed the way packages/index tests do. */
export function forgeRecords(): CatalogRecord[] {
  const rows = parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[];
  return rows.map((r) => record({ status: "current", ...r }));
}

export function record(r: Record<string, unknown>): CatalogRecord {
  const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
  if (!p.ok) throw new Error(`${String(r.id)}: ${JSON.stringify(p.issues)}`);
  return p.record;
}

export async function forgePack(): Promise<OrgPack> {
  const op = await loadOrgPack(join(FORGE_ROOT, "org-pack"));
  if (op.problems.length) throw new Error(JSON.stringify(op.problems));
  return op;
}

export const forgeExpected = <T>(file: string): T =>
  parse(readFileSync(join(FORGE, "expected", file), "utf8")) as T;

export const forgeSystems = (op: OrgPack) => op.profiles.flatMap((p) => p.profile?.systems ?? []);
