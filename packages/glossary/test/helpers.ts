import { readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  loadOrgPack,
  parseRecord,
  recordPath,
  serializeRecord,
  type CatalogRecord,
  type EvidenceT,
  type OrgPack,
} from "@maycombhq/core";
import { readPage, type KnowledgePage } from "@maycombhq/knowledge";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "fixtures");
export const FORGE = join(HERE, "../../../fixtures/forge");

export function record(r: Record<string, unknown>): CatalogRecord {
  const p = parseRecord({ schemaVersion: 2, status: "current", ...r });
  if (!p.ok) throw new Error(`${String(r.id)}: ${JSON.stringify(p.issues)}`);
  return p.record;
}

const rows = (file: string) => parse(readFileSync(file, "utf8")) as Record<string, unknown>[];

export const forgeRecords = (): CatalogRecord[] =>
  rows(join(FORGE, "expected/scan.yaml")).map(record);
export const extraRecords = (): CatalogRecord[] =>
  rows(join(FIXTURES, "extra-records.yaml")).map(record);
export const decisions = (): CatalogRecord[] => rows(join(FIXTURES, "decisions.yaml")).map(record);

export const forgePack = (): Promise<OrgPack> => loadOrgPack(join(FORGE, "metarepo/org-pack"));

/** Pages as the knowledge sources hand them over, with paths as in a metarepo's inputs/wiki. */
export function pagesFrom(dir: string): KnowledgePage[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) =>
      readPage({
        source: "forge-wiki",
        path: `inputs/wiki/${f}`,
        pagePath: f,
        content: readFileSync(join(dir, f), "utf8"),
      }),
    );
}
export const forgePages = () => pagesFrom(join(FORGE, "inputs/wiki"));
export const fixturePages = () => pagesFrom(join(FIXTURES, "wiki"));

export const ev = (e: EvidenceT) =>
  e.source === "manual"
    ? `manual:${e.by ?? ""}`
    : `${e.repo ? `${e.repo}/` : ""}${e.path ?? ""}${e.line ? `:${e.line}` : ""}`;

/**
 * A temporary metarepo: the Forge org pack (its wiki pointed at inputs/wiki), the Forge
 * catalog (plus `extra`) as catalog/generated files, and the Forge wiki pages (plus `pages`).
 */
export async function metarepo(
  o: { extra?: CatalogRecord[]; pages?: boolean; decisions?: CatalogRecord[] } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-glossary-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack/sources.yaml"),
    "schemaVersion: 1\nwikis:\n  - { id: forge-wiki, type: markdown-folder, location: ../inputs/wiki, owner: team-platform }\n",
  );
  await cp(join(FORGE, "inputs/wiki"), join(root, "inputs/wiki"), { recursive: true });
  if (o.pages) await cp(join(FIXTURES, "wiki"), join(root, "inputs/wiki"), { recursive: true });
  for (const [dir, list] of [
    ["generated", [...forgeRecords(), ...(o.extra ?? [])]],
    ["curated", o.decisions ?? []],
  ] as const) {
    for (const r of list) {
      const f = join(root, "catalog", dir, recordPath(r));
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, serializeRecord(r));
    }
  }
  return root;
}
