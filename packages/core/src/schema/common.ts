import { z } from "zod";

/**
 * Current catalog schema version. Bumping it requires an ADR and a migration.
 * Version 2 (ADR 0031) added the Capability kind and changed no existing field.
 * Version 3 (ADR 0125) added `required` on a Schema field, optional, and changed no other field.
 */
export const SCHEMA_VERSION = 3 as const;

/** Every catalog schema version a reader accepts, oldest first. */
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2, 3] as const;

/**
 * A record's schema version. Version-1 and version-2 files differ from version 3 only in this
 * number (nothing they hold changed meaning), so they are read as they are and come back as
 * version 3 in memory; writers always write the current version, and `migrateCatalog` rewrites
 * old files. The type stays `1 | 2 | 3` so code that builds older records in memory keeps
 * compiling until it is updated.
 */
export const SchemaVersion = z
  .union([z.literal(1), z.literal(2), z.literal(3)], {
    error: "schemaVersion must be 1, 2 or 3 (older files are read as version 3)",
  })
  .overwrite((): 1 | 2 | 3 => SCHEMA_VERSION);

/**
 * Stable record id. Lowercase slug, safe as a file name on Linux, macOS and Windows
 * (no ":" or "/"), so every record can live in its own file named by its id.
 */
export const RecordId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "ids are lowercase slugs: a-z, 0-9, '.', '_' and '-'");

/** A reference to another record by id. */
export const Ref = RecordId;

export const Status = z.enum([
  "current",
  "planned-new",
  "planned-modify",
  "planned-retire",
  "retired",
]);

/**
 * verified: read directly from code, config or a published spec (an interface needs both ends seen).
 * inferred: one end only, a diagram, a document or a rule.
 * asserted: stated or confirmed by a person. Documents are never "asserted".
 */
export const Confidence = z.enum(["verified", "inferred", "asserted"]);

export const EvidenceSource = z.enum([
  "code",
  "config",
  "spec",
  "gateway",
  "event-config",
  "infrastructure",
  "pipeline",
  "migration",
  "diagram",
  "document",
  "export",
  "manual",
]);

export const Evidence = z.strictObject({
  source: EvidenceSource,
  repo: z.string().optional(),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  scannedAt: z.iso.datetime({ offset: true }).optional(),
  /** "name@version" of the extractor that produced this evidence. */
  extractor: z.string().optional(),
  /** "name@version" of the dialect applied, if any. */
  dialect: z.string().optional(),
  side: z.enum(["caller", "callee", "gateway", "definition", "document"]).optional(),
  /** For manual evidence: who stated it. */
  by: z.string().optional(),
});

export const IsoDate = z.iso.date();
export const IsoDateTime = z.iso.datetime({ offset: true });

/** Fields every record carries. `kind` is added per record type. */
export const commonFields = {
  schemaVersion: SchemaVersion,
  id: RecordId,
  status: Status,
  confidence: Confidence,
  evidence: z.array(Evidence).min(1, "every record needs at least one piece of evidence"),
  flags: z.array(z.string()).optional(),
};

export type EvidenceT = z.infer<typeof Evidence>;
