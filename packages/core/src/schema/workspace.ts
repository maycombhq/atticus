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
