// Build a Forge metarepo for looking at the app: org pack, expected catalog, the seeded change.
import { readFileSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
const [, , out, fixtures] = process.argv;
await cp(join(fixtures, "forge/metarepo"), out, { recursive: true });
await cp(join(fixtures, "forge-change/openspec"), join(out, "openspec"), { recursive: true });
await cp(join(fixtures, "forge/inputs"), join(out, "inputs"), { recursive: true });
for (const r of parse(readFileSync(join(fixtures, "forge/expected/scan.yaml"), "utf8"))) {
  const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
  if (!p.ok) continue;
  const f = join(out, "catalog/generated", recordPath(p.record));
  await mkdir(dirname(f), { recursive: true });
  await writeFile(f, serializeRecord(p.record));
}
console.log("ok", out);
