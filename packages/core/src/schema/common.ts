import { z } from "zod";
import { SCHEMA_VERSION } from "./version.js";

/** Current catalog schema version (defined in ./version.js, which loads no schema). */
export { SCHEMA_VERSION };

/** Every catalog schema version a reader accepts, oldest first. */
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2, 3, 4, 5] as const;

/**
 * A record's schema version. Version-1 to -4 files differ from version 5 only in this number
 * (nothing they hold changed meaning: version 4, ADR 0164, only added `protobuf` to a Schema's
 * formats; version 5, ADR 0181, only added the evidence source `ai` and its `run`), so they are
 * read as they are and come back as version 5 in memory; writers always write the current
 * version, and `migrateCatalog` rewrites old files. The type stays `1 | 2 | 3 | 4 | 5` so code
 * that builds older records in memory keeps compiling until it is updated.
 */
export const SchemaVersion = z
  .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)], {
    error: "schemaVersion must be 1, 2, 3, 4 or 5 (older files are read as version 5)",
  })
  .overwrite((): 1 | 2 | 3 | 4 | 5 => SCHEMA_VERSION);

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
  /** Version 5 (ADR 0181): the AI decided it (a pairing or an answer), with `run`; never a person. */
  "ai",
]);

/**
 * The evidence sources a dialect (C2) or a finding (C3) may name: every source but `ai` (ADR 0181),
 * which only Atticus writes, for a link the AI decided. C2 and C3 are unchanged by it.
 */
export const RuleEvidenceSource = EvidenceSource.exclude(["ai"]);

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
  /** For manual evidence: who stated it; for ai evidence, the runtime that decided it. */
  by: z.string().optional(),
  /** Version 5 (ADR 0181): for ai evidence, the run that decided it. */
  run: z.string().min(1).optional(),
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
