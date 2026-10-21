import { z } from "zod";
import { RecordId } from "./common.js";

/**
 * A repo type (ADR 0077, C6): org-pack/repo-types/<id>/type.yaml. What a kind of repo in the
 * organisation looks like (its fingerprint), the scan settings every repo of the kind needs
 * (as patterns, resolved against each repo), and the skills the survey hands the assistant.
 * A new repo is matched against the known types deterministically (atticus repo-type detect),
 * so what was learned on one repo of a type is reused on the next. Distinct from the platform
 * profiles in profiles/<platform>/.
 */

export const REPO_TYPE_SCHEMA_VERSION = 1 as const;

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
const Globs = z.array(RepoGlob).min(1);

/** A regular expression that compiles. Tested one line at a time. */
const Pattern = z
  .string()
  .min(1)
  .max(500)
  .refine((p) => {
    try {
      new RegExp(p);
      return true;
    } catch {
      return false;
    }
  }, "a regular expression that compiles");

/** The build files a dependency is looked for in when a signal doesn't say. */
export const DEFAULT_BUILD_FILES = [
  "**/pom.xml",
  "**/build.gradle",
  "**/build.gradle.kts",
  "**/package.json",
  "**/*.csproj",
  "**/requirements*.txt",
  "**/pyproject.toml",
  "**/go.mod",
];

/** How much a signal counts (1 to 10), and whether the type can match without it. */
const Weighted = { weight: z.number().int().min(1).max(10), required: z.boolean().default(false) };

export const FingerprintSignal = z.discriminatedUnion("kind", [
  /** A build file is present: any file matching one of the globs. */
  z.strictObject({ kind: z.literal("build-file"), globs: Globs, ...Weighted }),
  /**
   * A dependency or house package is named in a build file: a line of a file matching `in`
   * holds one of the names as a whole word (letters, digits and . _ - @ /). A name ending in
   * `*` matches any word that starts with it ("spring-boot*").
   */
  z.strictObject({
    kind: z.literal("dependency"),
    names: z.array(z.string().regex(/^[A-Za-z0-9_.@/-]+\*?$/, "a package name")).min(1),
    in: Globs.default(DEFAULT_BUILD_FILES),
    ...Weighted,
  }),
  /** A framework marker (an annotation, an import): a line of a file matching `in` matches. */
  z.strictObject({ kind: z.literal("marker"), pattern: Pattern, in: Globs, ...Weighted }),
  /** The folder layout: any file matching one of the globs. */
  z.strictObject({ kind: z.literal("layout"), globs: Globs, ...Weighted }),
]);
export type FingerprintSignal = z.infer<typeof FingerprintSignal>;

/**
 * A path prefix every repo of the type sets the same way, as a pattern: read the value from a
 * config key (`key`, in .properties or YAML files) or from the first group of a regular
 * expression (`pattern`), in the first file matching `files`. Resolved against each repo into
 * a cited scan-settings entry (ADR 0075), which the citation check then confirms.
 */
export const PrefixRule = z
  .strictObject({
    files: Globs,
    key: z.string().min(1).optional(),
    pattern: Pattern.optional(),
    paths: Globs,
    why: z.string().min(1),
  })
  .refine((r) => (r.key === undefined) !== (r.pattern === undefined), {
    message: "give either key or pattern, not both",
  });
export type PrefixRule = z.infer<typeof PrefixRule>;

export const SettingsTemplate = z.strictObject({
  /** Folders a repo of this type doesn't need read, when the repo has them. */
  exclude: z.array(z.strictObject({ path: RepoGlob, why: z.string().min(1) })).default([]),
  prefixes: z.array(PrefixRule).default([]),
});
export type SettingsTemplate = z.infer<typeof SettingsTemplate>;

export const RepoType = z.strictObject({
  schemaVersion: z.literal(REPO_TYPE_SCHEMA_VERSION),
  /** The folder name under repo-types/. */
  id: RecordId,
  name: z.string().min(1),
  description: z.string().min(1),
  owner: z.string().min(1).optional(),
  fingerprint: z.array(FingerprintSignal).min(1),
  settings: SettingsTemplate.default({ exclude: [], prefixes: [] }),
  /** Skills the survey hands the assistant for this type, in process/skills/<id>/SKILL.md. */
  skills: z
    .array(
      z
        .string()
        .regex(
          /^process\/skills\/[a-z0-9][a-z0-9._-]*\/SKILL\.md$/,
          "a skill file: process/skills/<id>/SKILL.md",
        ),
    )
    .default([]),
});
export type RepoType = z.infer<typeof RepoType>;
