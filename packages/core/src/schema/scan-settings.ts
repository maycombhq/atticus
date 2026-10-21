import { z } from "zod";
import { RecordId } from "./common.js";

/**
 * Scan settings for one repo (ADR 0075, C6): org-pack/scan/<repo>.yaml. Facts about the repo a
 * built-in reader can't know in general, each citing the file and line it comes from: folders
 * that aren't the product, and path prefixes in front of its HTTP entry points. Drafted by the
 * AI (atticus scan survey), checked against the code, reviewed like any org-pack change.
 */

export const SCAN_SETTINGS_SCHEMA_VERSION = 1 as const;

/** A repo-relative glob with forward slashes; never absolute, never leaving the repo. */
const RepoGlob = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !/^[a-zA-Z]:/.test(p) &&
      !p.split("/").includes("..") &&
      !p.includes("\\"),
    "a path inside the repo, with forward slashes",
  );

/** Where the fact is in the repo: path:line. */
const At = z.string().regex(/^[^\s:]+:\d+$/, "at must be path:line");

export const ScanSettings = z.strictObject({
  schemaVersion: z.literal(SCAN_SETTINGS_SCHEMA_VERSION),
  /** The repo id, as in the repo manifest; the file is named after it. */
  repo: RecordId,
  /** Folders the scan doesn't read: generated sites, vendored code, samples. */
  exclude: z.array(z.strictObject({ path: RepoGlob, why: z.string().min(1), at: At })).default([]),
  /**
   * Paths put in front of every HTTP entry point whose source file matches `paths`, in the
   * order listed: a context path from config, then a global prefix from start-up code.
   */
  prefixes: z
    .array(
      z.strictObject({
        paths: z.array(RepoGlob).min(1),
        prefix: z.string().regex(/^\/[^\s?#]*$/, "a path starting with /"),
        why: z.string().min(1),
        at: At,
        /** The value as written at `at`; the citation check looks for it on that line. */
        value: z.string().min(1),
      }),
    )
    .default([]),
});
export type ScanSettings = z.infer<typeof ScanSettings>;
