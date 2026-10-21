import { z } from "zod";
import { SCHEMA_VERSION } from "./schema/common.js";
import { RECORD_KINDS, RECORD_SCHEMAS, type RecordKind } from "./schema/kinds.js";
import {
  CatalogBaseline,
  ChangeOutcomes,
  ChangeRepos,
  MetarepoStamp,
  RepoManifest,
} from "./schema/workspace.js";
import { ChangeLifecycle } from "./schema/change.js";
import { Dialect } from "./schema/dialect.js";
import { FrameworkModel } from "./schema/frameworks.js";
import { ScanSettings } from "./schema/scan-settings.js";
import { ScannerPlugin } from "./schema/plugin.js";
import { ChecklistPack, Finding } from "./schema/review.js";
import * as C6 from "./schema/orgpack.js";
import * as C5 from "./schema/ai.js";

/**
 * JSON Schema for every record kind, generated from the zod source of truth, for editors,
 * other tools and org-pack validation outside TypeScript.
 */
export function catalogJsonSchemas(): Record<RecordKind, object> {
  const out = {} as Record<RecordKind, object>;
  for (const kind of RECORD_KINDS) {
    const schema = z.toJSONSchema(RECORD_SCHEMAS[kind], { io: "input", unrepresentable: "any" });
    out[kind] = {
      $id: `https://maycombhq.github.io/atticus/schema/catalog/v${SCHEMA_VERSION}/${kind}.json`,
      title: kind,
      ...schema,
    };
  }
  return out;
}

/**
 * JSON Schema for the workspace files: repos.manifest.yaml, and a change's repos.yaml,
 * change.yaml (its lifecycle state) and review/outcomes.yaml (ADR 0045).
 */
export function workspaceJsonSchemas(): Record<
  | "RepoManifest"
  | "ChangeRepos"
  | "ChangeLifecycle"
  | "ChangeOutcomes"
  | "CatalogBaseline"
  | "MetarepoStamp",
  object
> {
  const gen = (name: string, schema: z.ZodType) => ({
    $id: `https://maycombhq.github.io/atticus/schema/workspace/v1/${name}.json`,
    title: name,
    ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
  });
  return {
    RepoManifest: gen("RepoManifest", RepoManifest),
    ChangeRepos: gen("ChangeRepos", ChangeRepos),
    ChangeLifecycle: gen("ChangeLifecycle", ChangeLifecycle),
    ChangeOutcomes: gen("ChangeOutcomes", ChangeOutcomes),
    CatalogBaseline: gen("CatalogBaseline", CatalogBaseline),
    MetarepoStamp: gen("MetarepoStamp", MetarepoStamp),
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

/** JSON Schema for every org-pack file (C6). */
export function orgPackJsonSchemas(): Record<string, object> {
  const files: Record<string, z.ZodType> = {
    PackManifest: C6.PackManifest,
    Roles: C6.Roles,
    ChangeTypes: C6.ChangeTypes,
    Gates: C6.Gates,
    IntegrationPattern: C6.IntegrationPattern,
    FrameworkModel,
    ScanSettings,
    ScannerPlugin,
    Sources: C6.Sources,
    Runtime: C6.Runtime,
    SkillMeta: C6.SkillMeta,
    ServiceRequestTemplate: C6.ServiceRequestTemplate,
    Procedure: C6.Procedure,
    TestStrategy: C6.TestStrategy,
    Profile: C6.Profile,
    AgentDefinition: C5.AgentDefinition,
  };
  const out: Record<string, object> = {};
  for (const [name, schema] of Object.entries(files)) {
    out[name] = {
      $id: `https://maycombhq.github.io/atticus/schema/orgpack/v1/${name}.json`,
      title: name,
      ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
    };
  }
  return out;
}

/** JSON Schema for the AI runtime's run files (C5). */
export function aiJsonSchemas(): Record<string, object> {
  const files: Record<string, z.ZodType> = {
    ContextPackManifest: C5.ContextPackManifest,
    RunSummary: C5.RunSummary,
    Recording: C5.Recording,
  };
  const out: Record<string, object> = {};
  for (const [name, schema] of Object.entries(files)) {
    out[name] = {
      $id: `https://maycombhq.github.io/atticus/schema/ai/v1/${name}.json`,
      title: name,
      ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
    };
  }
  return out;
}
