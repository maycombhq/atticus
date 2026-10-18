import { z } from "zod";
import { RECORD_KINDS, RECORD_SCHEMAS, type RecordKind } from "./schema/kinds.js";
import { ChangeRepos, RepoManifest } from "./schema/workspace.js";
import { Dialect } from "./schema/dialect.js";
import { ChecklistPack, Finding } from "./schema/review.js";

/**
 * JSON Schema for every record kind, generated from the zod source of truth, for editors,
 * other tools and org-pack validation outside TypeScript.
 */
export function catalogJsonSchemas(): Record<RecordKind, object> {
  const out = {} as Record<RecordKind, object>;
  for (const kind of RECORD_KINDS) {
    const schema = z.toJSONSchema(RECORD_SCHEMAS[kind], { io: "input", unrepresentable: "any" });
    out[kind] = {
      $id: `https://maycombhq.github.io/atticus/schema/catalog/v1/${kind}.json`,
      title: kind,
      ...schema,
    };
  }
  return out;
}

/** JSON Schema for the workspace files: repos.manifest.yaml and a change's repos.yaml. */
export function workspaceJsonSchemas(): Record<"RepoManifest" | "ChangeRepos", object> {
  const gen = (name: string, schema: z.ZodType) => ({
    $id: `https://maycombhq.github.io/atticus/schema/workspace/v1/${name}.json`,
    title: name,
    ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
  });
  return {
    RepoManifest: gen("RepoManifest", RepoManifest),
    ChangeRepos: gen("ChangeRepos", ChangeRepos),
  };
}

/** JSON Schema for the dialect rule file (C2) and checklist packs and findings (C3). */
export function rulesJsonSchemas(): Record<"Dialect" | "ChecklistPack" | "Finding", object> {
  const gen = (name: string, schema: z.ZodType) => ({
    $id: `https://maycombhq.github.io/atticus/schema/rules/v1/${name}.json`,
    title: name,
    ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
  });
  return {
    Dialect: gen("Dialect", Dialect),
    ChecklistPack: gen("ChecklistPack", ChecklistPack),
    Finding: gen("Finding", Finding),
  };
}
