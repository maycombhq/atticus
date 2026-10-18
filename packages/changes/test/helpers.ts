import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { MockGitHost, type Approval } from "@maycombhq/adapters";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FORGE = join(HERE, "../../../fixtures/forge");
export const FIXTURES = join(HERE, "fixtures");
export const REPO = "forge/forge-metarepo";

/**
 * A temporary metarepo built from the Forge fixture: the org pack, the expected catalog
 * written as catalog files, and a CODEOWNERS file. `personal` marks catalog columns as
 * personal data (the M2 scan doesn't classify columns; a curated classify decision would).
 */
export async function forgeMetarepo(
  opts: { personal?: string[]; roles?: string } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-changes-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  if (opts.roles !== undefined) await writeFile(join(root, "org-pack/roles.yaml"), opts.roles);
  const rows = parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[];
  for (const r of rows) {
    const extra = opts.personal?.includes(String(r.id)) ? { classification: "personal" } : {};
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r, ...extra });
    if (!p.ok) throw new Error(`bad fixture record ${String(r.id)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await mkdir(join(root, ".github"), { recursive: true });
  await cp(join(FIXTURES, "CODEOWNERS"), join(root, ".github/CODEOWNERS"));
  await mkdir(join(root, "openspec/changes"), { recursive: true });
  return root;
}

/** Copy a fixture phase folder (e.g. add-transfer-limit/define) into the change folder. */
export async function copyPhase(root: string, change: string, fixture: string): Promise<void> {
  await cp(join(FIXTURES, fixture), join(root, "openspec/changes", change), { recursive: true });
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export function host(): MockGitHost {
  return new MockGitHost([{ repo: REPO }]);
}

export function approval(by: string, at: string, ref = "hand-off"): Approval {
  return { by, at, ref };
}

/** Forge roles.yaml plus a privacy-officer custom role. */
export const ROLES_WITH_PRIVACY = `schemaVersion: 1
custom:
  - { id: privacy-officer, name: Privacy officer, basedOn: architect }
enabledOptional: [data-architect, sre]
approvals:
  release-go-no-go: { roles: [delivery-lead] }
  waiver: { roles: [architect] }
separation:
  - actions: ["author:design", "approve:design"]
    reason: The author of a design can't approve it.
`;

export const FEATURE_OWNERS = {
  "product-owner": ["pat"],
  architect: ["ari", "avery"],
  "business-analyst": ["bao"],
  "team-lead": ["tia"],
  developer: ["dev", "dee"],
  qa: ["quinn"],
  "delivery-lead": ["dana"],
  sre: ["sam"],
};
