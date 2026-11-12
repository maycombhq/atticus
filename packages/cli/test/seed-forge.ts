import { cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAndWrite, type BuildAndWrite } from "@maycombhq/scanner";

const SLOTS = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge/slots");

/**
 * ADR 0195 (CS5): a Forge metarepo's catalog as the slots make it. The golden readers slots of
 * fixtures/forge/slots/readers/ are copied to catalog/sources/readers/ and built once, so
 * catalog/generated is the oracle's catalog (fixtures/forge/expected/scan.yaml, which those slots
 * build to) and catalog/sources/build.json agrees with it. A test that runs a writer (a scan,
 * verify --write, the glossary scan, a rename) over the Forge catalog seeds it this way, never by
 * writing catalog/generated from scan.yaml: a catalog no build wrote is one to upgrade first.
 */
export async function seedForgeSlots(root: string): Promise<BuildAndWrite> {
  await cp(join(SLOTS, "readers"), join(root, "catalog", "sources", "readers"), {
    recursive: true,
  });
  const r = await buildAndWrite(root, { command: "seed" });
  if (r.guard.refused) throw new Error(`seed refused: ${r.guard.refused.message}`);
  return r;
}
