import { z } from "zod";
import { RecordId } from "./common.js";

/**
 * Repo and change-workspace files.
 *
 * - `org-pack/profiles/<platform>/repos.manifest.yaml` lists every repo of a platform
 *   (part of contract C6, org-pack schemas).
 * - `openspec/changes/<change-id>/repos.yaml` records, for one change, the branch,
 *   worktree, PR and build of each repo the change touches. OpenSpec does not track a
 *   change across repos, so this file is Atticus's own.
 *
 * See ADR 0009.
 */
export const WORKSPACE_SCHEMA_VERSION = 1 as const;

/** A Git branch name segment Atticus generates: no slashes, safe on every platform. */
const BranchSegment = RecordId;

const GitRef = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (s) =>
      !/[\s~^:?*[\\]/.test(s) &&
      !s.includes("..") &&
      !s.startsWith("/") &&
      !s.endsWith("/") &&
      !s.endsWith(".lock") &&
      !s.includes("@{"),
    "not a valid Git branch name",
  );

const RelativePosixPath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !/^[A-Za-z]:/.test(p) &&
      !p.includes("\\") &&
      !p.split("/").includes(".."),
    "a relative path inside the repo, written with forward slashes",
  );

export const ManifestRepo = z.strictObject({
  /** Repo id; also the base clone's folder name under workspace/. */
  id: RecordId,
  /** Clone URL. Credentials never go here; Git's credential manager supplies them. */
  url: z
    .string()
    .min(1)
    .refine(
      (u) => !/^[a-z][a-z0-9+.-]*:\/\/[^/@]+:[^/@]*@/i.test(u),
      "remove the password from the URL",
    ),
  defaultBranch: GitRef.default("main"),
  /** Repo type from the platform profile, e.g. spring-boot, gateway, infra. Maps to build commands. */
  type: RecordId,
  /** Owning team id (roles.yaml). */
  owner: RecordId,
  /** The component this repo builds, when its id differs from the repo id (ADR 0016). */
  component: RecordId.optional(),
  /** The catalog System this repo belongs to, when one repo maps to one system. */
  system: RecordId.optional(),
  /** Extractor ids to run on this repo; empty means the profile's defaults for the type. */
  extractors: z.array(RecordId).default([]),
  /** Dialect ids to run on this repo. */
  dialects: z.array(RecordId).default([]),
  /** Partial clone: only these paths are checked out. Empty means the whole repo. */
  sparse: z.array(RelativePosixPath).default([]),
  /** Build or test command overriding the profile's command for this repo type. */
  build: z.string().min(1).optional(),
  /** Archived repos stay listed for history but are not cloned or scanned. */
  archived: z.boolean().default(false),
});
export type ManifestRepo = z.infer<typeof ManifestRepo>;

export const RepoManifest = z
  .strictObject({
    schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
    platform: RecordId,
    repos: z.array(ManifestRepo),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.repos.forEach((r, i) => {
      if (seen.has(r.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["repos", i, "id"],
          message: `duplicate repo id ${r.id}`,
        });
      }
      seen.add(r.id);
    });
  });
export type RepoManifest = z.infer<typeof RepoManifest>;

export const PullRequestState = z.enum(["draft", "open", "merged", "closed"]);

export const ChangeRepoPr = z.strictObject({
  url: z.url(),
  number: z.number().int().positive(),
  state: PullRequestState,
  updatedAt: z.iso.datetime({ offset: true }).optional(),
});

export const BuildStatus = z.enum(["not-run", "running", "passed", "failed"]);

export const ChangeRepoBuild = z.strictObject({
  status: BuildStatus,
  command: z.string().min(1).optional(),
  /** Commit the build ran on. */
  sha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  at: z.iso.datetime({ offset: true }).optional(),
  /** Path of the build log under .runs/<change-id>/, relative to the metarepo. */
  log: RelativePosixPath.optional(),
});

export const ChangeRepo = z.strictObject({
  id: RecordId,
  /** Always change/<change-id>; recorded so a renamed convention stays readable. */
  branch: GitRef,
  /** Branch the change branch was cut from. */
  base: GitRef,
  /** Commit of base when the worktree was created. */
  baseSha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  /** Worktree folder relative to the metarepo, e.g. workspace/.worktrees/<change-id>/<repo>. */
  worktree: RelativePosixPath,
  pr: ChangeRepoPr.optional(),
  build: ChangeRepoBuild.default({ status: "not-run" }),
});
export type ChangeRepo = z.infer<typeof ChangeRepo>;

export const ChangeRepos = z
  .strictObject({
    schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
    change: BranchSegment,
    repos: z.array(ChangeRepo),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.repos.forEach((r, i) => {
      if (seen.has(r.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["repos", i, "id"],
          message: `duplicate repo id ${r.id}`,
        });
      }
      seen.add(r.id);
    });
  });
export type ChangeRepos = z.infer<typeof ChangeRepos>;

/**
 * `openspec/changes/<change-id>/review/outcomes.yaml` (ADR 0045): what people measured after
 * release against the brief's success measures. The measures themselves are read from the
 * brief on every view; this file keeps only the values people recorded, each with who and when.
 */
export const OutcomeValue = z.strictObject({
  value: z.string().trim().min(1).max(500),
  /** The person who measured it: a handle. */
  by: z
    .string()
    .min(1)
    .max(100)
    .regex(/^@?[A-Za-z0-9][A-Za-z0-9._/-]*$/, "a handle such as pat"),
  at: z.iso.datetime({ offset: true }),
  note: z.string().trim().min(1).max(1000).optional(),
});
export type OutcomeValue = z.infer<typeof OutcomeValue>;

export const OutcomeMeasure = z.strictObject({
  /** Slug of the measure as the brief words it. */
  id: RecordId,
  /** The measure's words when its first value was recorded. */
  measure: z.string().min(1),
  values: z.array(OutcomeValue).min(1),
});
export type OutcomeMeasure = z.infer<typeof OutcomeMeasure>;

export const ChangeOutcomes = z
  .strictObject({
    schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
    change: BranchSegment,
    measures: z.array(OutcomeMeasure),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.measures.forEach((m, i) => {
      if (seen.has(m.id))
        ctx.addIssue({
          code: "custom",
          path: ["measures", i, "id"],
          message: `duplicate measure ${m.id}`,
        });
      seen.add(m.id);
    });
  });
export type ChangeOutcomes = z.infer<typeof ChangeOutcomes>;

/**
 * catalog/baseline.yaml (ADR 0047): the as-is catalog a person accepted, the point every later
 * scan, document and change is compared with. Written by `atticus baseline`; until it exists,
 * Home shows the setup checklist.
 */
export const CatalogBaseline = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  acceptedBy: z.string().min(1),
  acceptedAt: z.iso.datetime({ offset: true }),
  /** Records per kind at acceptance. */
  kinds: z.record(z.string(), z.number().int().nonnegative()),
  systems: z.array(z.string().min(1)),
  note: z.string().optional(),
});
export type CatalogBaseline = z.infer<typeof CatalogBaseline>;

/**
 * `.atticus/metarepo.yaml` (ADR 0051), committed: which Atticus last upgraded this metarepo and
 * the migrations it has had. An older Atticus refuses to upgrade a metarepo a newer one wrote.
 */
export const MetarepoStamp = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  atticus: z.string().min(1),
  upgradedAt: z.iso.datetime({ offset: true }),
  upgradedBy: z.string().min(1),
  migrations: z.array(z.string().min(1)).default([]),
});
export type MetarepoStamp = z.infer<typeof MetarepoStamp>;
