import { z } from "zod";
import { RecordId } from "./common.js";
import { RECORD_KINDS, type RecordKind } from "./kinds.js";

/**
 * A scanner plugin (ADR 0080, C6): org-pack/plugins/<id>/plugin.yaml. When a rule file can't
 * say how to read an organisation's code, the AI writes a plugin in plain JavaScript, as a
 * reviewed change with golden tests (plugins/<id>/test/<case>/repo/ and expected.yaml). The
 * scanner loads it only when the entry file's sha256 matches the pin and its tests pass, and
 * runs it sandboxed: files only through the repo handle, no network, no processes, limits.
 */

export const SCANNER_PLUGIN_SCHEMA_VERSION = 1 as const;

/** The entry file: a .js or .mjs file inside the plugin's folder. */
const EntryFile = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !/^[a-zA-Z]:/.test(p) &&
      !p.split("/").includes("..") &&
      !p.includes("\\") &&
      /\.m?js$/.test(p),
    "a .js or .mjs file inside the plugin's folder, with forward slashes",
  );

export const ScannerPlugin = z.strictObject({
  schemaVersion: z.literal(SCANNER_PLUGIN_SCHEMA_VERSION),
  /** The plugin id; the folder is named after it. Its records' extractor is `plugin-<id>`. */
  id: RecordId,
  /** Semver; part of the scan cache key and of every record's evidence. */
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/i, "a semver version, e.g. 1.0.0"),
  description: z.string().min(1),
  /** The record kinds it may emit; any other kind fails the run. */
  emits: z
    .array(z.string().refine((k) => RECORD_KINDS.includes(k as RecordKind), "a C1 record kind"))
    .min(1),
  /** Where it runs: repos of these types ("*" for any), or repos that use these dialects. */
  appliesTo: z
    .strictObject({
      repoTypes: z.array(z.string().min(1)).default([]),
      dialects: z.array(z.string().min(1)).default([]),
    })
    .refine(
      (a) => a.repoTypes.length + a.dialects.length > 0,
      "name at least one repo type or dialect",
    ),
  /** The plain JavaScript ES module whose default export is an Extractor (C4). */
  entry: EntryFile,
  /** The entry file's sha256, written by `atticus plugin pin`; a changed file isn't loaded. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "a sha256 in lowercase hex; run atticus plugin pin")
    .optional(),
  /** The run is stopped after this time, and when its heap passes this size. */
  limits: z
    .strictObject({
      timeoutMs: z.number().int().min(100).max(600_000).default(10_000),
      memoryMb: z.number().int().min(16).max(2048).default(64),
    })
    .default({ timeoutMs: 10_000, memoryMb: 64 }),
  /** Off: the plugin stays in the pack and isn't run. */
  enabled: z.boolean().default(true),
});
export type ScannerPlugin = z.infer<typeof ScannerPlugin>;

/** A plugin's golden test: plugins/<id>/test/<case>/expected.yaml (records matched by id). */
export const PluginExpected = z.strictObject({
  /** What the scan context says about the test repo; the repo is named after the case folder. */
  context: z
    .strictObject({
      component: RecordId.optional(),
      system: RecordId.optional(),
      repoType: z.string().min(1).optional(),
      dialects: z.array(z.string().min(1)).default([]),
    })
    .optional(),
  /** Records the plugin must produce; each listed field must equal the produced one. */
  expect: z.array(z.looseObject({ kind: z.string(), id: z.string() })).default([]),
  /** Record ids it must not produce. */
  absent: z.array(z.string()).default([]),
  /** Only the expected records: anything else the plugin produces fails the test. Default true. */
  exact: z.boolean().default(true),
});
export type PluginExpected = z.infer<typeof PluginExpected>;
