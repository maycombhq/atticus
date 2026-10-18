import { join } from "node:path";
import { loadOrgPack, type CatalogRecord, type ChangeType, type OrgPack } from "@maycombhq/core";
import { readCatalog } from "@maycombhq/scanner";
import { ChangeError } from "./errors.js";
import { loadChangePolicy, type ChangePolicy } from "./policy.js";
import { loadTemplates, type ChangeTemplate } from "./templates.js";
import { readCodeowners, type CodeownersRule } from "./codeowners.js";

/**
 * Everything the lifecycle reads from the metarepo, loaded once per operation: the org pack
 * (change types, gates, roles, test strategy), the change policy and templates, the
 * catalog and CODEOWNERS. Reading never fails for content; problems are collected.
 */
export interface ChangeContext {
  root: string;
  orgPack: OrgPack;
  policy: ChangePolicy;
  templates: ChangeTemplate[];
  records: CatalogRecord[];
  codeowners: CodeownersRule[];
  /** Problems found while loading, as "<file>: <message>" lines. */
  problems: string[];
}

export async function loadChangeContext(root: string): Promise<ChangeContext> {
  const orgPackDir = join(root, "org-pack");
  const orgPack = await loadOrgPack(orgPackDir);
  const policy = await loadChangePolicy(orgPackDir);
  const templates = await loadTemplates(orgPackDir);
  const catalog = await readCatalog(join(root, orgPack.sources.layout.catalog, "generated"));
  return {
    root,
    orgPack,
    policy: policy.policy,
    templates: templates.templates,
    records: catalog.records,
    codeowners: await readCodeowners(root),
    problems: [
      ...orgPack.problems.map(
        (p) => `org-pack/${p.file}: ${p.path ? `${p.path}: ` : ""}${p.message}`,
      ),
      ...policy.problems.map((p) => `org-pack/${p.file}: ${p.message}`),
      ...templates.problems.map((p) => `org-pack/${p.file}: ${p.message}`),
      ...catalog.problems.map((p) => `catalog ${p.file}: ${p.message}`),
    ],
  };
}

export function changeTypeOf(ctx: ChangeContext, type: string): ChangeType {
  const t = ctx.orgPack.changeTypes.types.find((x) => x.id === type);
  if (!t) {
    const known = ctx.orgPack.changeTypes.types.map((x) => x.id).join(", ");
    throw new ChangeError("invalid", `Unknown change type ${type}. Use one of: ${known}.`);
  }
  return t;
}
