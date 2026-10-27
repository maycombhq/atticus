import { z } from "zod";
import { RecordId } from "./common.js";
import { RECORD_KINDS, type RecordKind } from "./kinds.js";
import { Lens } from "./review.js";
import { MANUAL_SYSTEMS } from "./executors.js";

/**
 * Contract C6: org-pack schemas. Everything about how an organisation, platform or team
 * works is a file in org-pack/, validated against these schemas and changed through PRs.
 * Every file is optional: built-in defaults apply until a team writes its own. See ADR 0012.
 */
export const ORGPACK_SCHEMA_VERSION = 1 as const;
const V = z.literal(ORGPACK_SCHEMA_VERSION);
const Semver = z.string().regex(/^\d+\.\d+\.\d+$/, "semver");
const Kind = z.enum(RECORD_KINDS as [RecordKind, ...RecordKind[]]);
const Ids = z.array(RecordId);

function unique<T>(items: T[], key: (t: T) => string, ctx: z.RefinementCtx, path: string) {
  const seen = new Set<string>();
  items.forEach((t, i) => {
    const k = key(t);
    if (seen.has(k)) ctx.addIssue({ code: "custom", path: [path, i], message: `duplicate ${k}` });
    seen.add(k);
  });
}

// ------------------------------------------------------------------ pack.yaml

export const PackManifest = z.strictObject({
  schemaVersion: V,
  name: RecordId,
  version: Semver,
  /** The one named owner after hand-over, normally the platform lead. */
  owner: z.string().min(1),
  /** How often the pack itself must be reviewed. */
  reviewWindowDays: z.number().int().positive().default(90),
  /** Days after which a record of this kind counts as stale and its owner is nudged. */
  freshness: z.partialRecord(Kind, z.number().int().positive()).default({}),
  /** Data classification levels, lowest first. */
  classification: z.array(RecordId).default(["public", "internal", "confidential", "restricted"]),
});
export type PackManifest = z.infer<typeof PackManifest>;

// ------------------------------------------------------------------ roles.yaml

/**
 * roles.yaml is deprecated (ADR 0073): Atticus has no roles, views or in-app approvals. The
 * person is the metarepo's Git user and a gate is approved when its hand-off PR merges. A pack
 * that still has roles.yaml loads and validates as before; nothing reads it. The role ids stay
 * because change-types.yaml and gates.yaml still name them (also no longer read for approvals).
 */
export const CORE_ROLES = [
  "product-owner",
  "business-analyst",
  "architect",
  "team-lead",
  "developer",
  "qa",
  "delivery-lead",
  "platform-lead",
  "designer",
] as const;
export const OPTIONAL_ROLES = [
  "process-owner",
  "data-architect",
  "sre",
  "security-reviewer",
] as const;
export const BUILT_IN_ROLES = [...CORE_ROLES, ...OPTIONAL_ROLES] as const;

/** Deprecated with roles.yaml (ADR 0073): these actions are metarepo files or adapter writes now. */
export const NonGitAction = z.enum([
  "release-go-no-go",
  "waiver",
  "snow-submission",
  "org-pack-change",
  "catalog-assert",
]);

export const Approver = z
  .strictObject({
    roles: Ids.default([]),
    groups: z.array(z.string().min(1)).default([]),
    people: z.array(z.string().min(1)).default([]),
  })
  .refine(
    (a) => a.roles.length + a.groups.length + a.people.length > 0,
    "name at least one role, group or person",
  );

export const Roles = z
  .strictObject({
    schemaVersion: V,
    /** Extra roles; each is based on a built-in role's view. */
    custom: z
      .array(
        z.strictObject({ id: RecordId, name: z.string().min(1), basedOn: z.enum(BUILT_IN_ROLES) }),
      )
      .default([]),
    /** Optional roles this organisation uses. Core roles are always on. */
    enabledOptional: z.array(z.enum(OPTIONAL_ROLES)).default([]),
    /** Directory or work-tracker groups mapped to a default view. */
    mappings: z.array(z.strictObject({ group: z.string().min(1), role: RecordId })).default([]),
    approvals: z.partialRecord(NonGitAction, Approver).default({}),
    /** Pairs of things one person may not both do on the same change. */
    separation: z
      .array(
        z.strictObject({
          actions: z.tuple([z.string().min(1), z.string().min(1)]),
          reason: z.string().min(1),
        }),
      )
      .default([]),
  })
  .superRefine((r, ctx) => {
    const known = new Set<string>([...BUILT_IN_ROLES, ...r.custom.map((c) => c.id)]);
    unique(r.custom, (c) => c.id, ctx, "custom");
    r.custom.forEach((c, i) => {
      if ((BUILT_IN_ROLES as readonly string[]).includes(c.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["custom", i, "id"],
          message: `${c.id} is a built-in role`,
        });
      }
    });
    r.mappings.forEach((m, i) => {
      if (!known.has(m.role))
        ctx.addIssue({
          code: "custom",
          path: ["mappings", i, "role"],
          message: `unknown role ${m.role}`,
        });
    });
    for (const [action, a] of Object.entries(r.approvals)) {
      for (const role of a?.roles ?? []) {
        if (!known.has(role))
          ctx.addIssue({
            code: "custom",
            path: ["approvals", action],
            message: `unknown role ${role}`,
          });
      }
    }
  });
export type Roles = z.infer<typeof Roles>;

// ------------------------------------------------------------------ change-types.yaml

export const PHASES = ["define", "design", "plan", "build", "qa", "release"] as const;
export const Phase = z.enum(PHASES);
/** The phases a change is planned in, before it is built (ADR 0113). */
const PRE_BUILD: readonly string[] = ["define", "design", "plan"];
/** Artifacts of the org-flow schema plus Atticus's own change files. */
export const ChangeArtifact = z.enum([
  "brief",
  "proposal",
  "specs",
  "interfaces",
  "mappings",
  "data",
  "design",
  "ux",
  "stories",
  "tasks",
  "snow",
]);

export const ChangeType = z
  .strictObject({
    id: RecordId,
    name: z.string().min(1),
    description: z.string().optional(),
    phases: z.array(Phase).min(1),
    artifacts: z.array(ChangeArtifact).min(1),
    lenses: z.array(Lens).default([]),
    /**
     * Deprecated (ADR 0073): approvals per phase, by role. Still validated; not read. A gate is
     * approved when its hand-off PR merges, and the Git host decides who may approve.
     */
    approvals: z.partialRecord(Phase, Ids.min(1)).default({}),
    /** Emergency fixes: build and release first, then run the skipped lenses. */
    postReleaseReview: z.boolean().default(false),
    /**
     * ADR 0113 (version 2): small takes the fast path, one AI step from brief to tasks. Left
     * out, the type is standard: the feature, architecture and stories stages, each in turn.
     */
    size: z.enum(["standard", "small"]).optional(),
    /**
     * ADR 0113 (version 2): a standard type whose brief says "Size: small" takes the fast path.
     * Left out: false; a brief's size is read only on a type that allows it.
     */
    smallWhenBriefSays: z.boolean().optional(),
    /**
     * ADR 0113 (version 2): the gate from gates.yaml whose critic reviews the fast path's step.
     * Left out: the first gate of the type's last phase before build, else of its first phase.
     */
    fastGate: RecordId.optional(),
  })
  .superRefine((t, ctx) => {
    if (t.size === "small" && t.phases.filter((p) => PRE_BUILD.includes(p)).length > 1)
      ctx.addIssue({
        code: "custom",
        path: ["phases"],
        message:
          "a small type has at most one phase before build (define, design or plan), so its plan is one hand-off",
      });
    const order = t.phases.map((p) => PHASES.indexOf(p));
    if (order.some((v, i) => i > 0 && v <= order[i - 1]!)) {
      ctx.addIssue({
        code: "custom",
        path: ["phases"],
        message: `phases go in this order: ${PHASES.join(", ")}`,
      });
    }
    if (!t.artifacts.includes("proposal"))
      ctx.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "every change type needs a proposal",
      });
    if (t.phases.includes("build") && !t.artifacts.includes("tasks")) {
      ctx.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "a type with a build phase needs tasks",
      });
    }
    for (const p of Object.keys(t.approvals)) {
      if (!t.phases.includes(p as (typeof PHASES)[number])) {
        ctx.addIssue({
          code: "custom",
          path: ["approvals", p],
          message: `approval for ${p}, which this type doesn't use`,
        });
      }
    }
  });
export type ChangeType = z.infer<typeof ChangeType>;

/**
 * change-types.yaml's own schema version (ADR 0113). Version 2 adds a type's size, whether a
 * brief may say it is small, and the fast path's gate. Version 1 files still read, every type
 * standard; `atticus upgrade` moves them to version 2 (`change-types-v2`), changing nothing else.
 */
export const CHANGE_TYPES_SCHEMA_VERSION = 2 as const;

const V2_FIELDS = ["size", "smallWhenBriefSays", "fastGate"] as const;

export const ChangeTypes = z
  .strictObject({
    schemaVersion: z.union([V, z.literal(CHANGE_TYPES_SCHEMA_VERSION)]),
    types: z.array(ChangeType).min(1),
  })
  .superRefine((c, ctx) => {
    unique(c.types, (t) => t.id, ctx, "types");
    if (c.schemaVersion === 1)
      c.types.forEach((t, i) => {
        for (const f of V2_FIELDS)
          if (t[f] !== undefined)
            ctx.addIssue({
              code: "custom",
              path: ["types", i, f],
              message: `${f} needs schemaVersion 2 (ADR 0113): run atticus upgrade`,
            });
      });
  });

/**
 * The size a brief states (ADR 0113): a line "Size: small" or "Size: standard" (bold, quoted or
 * in a list is fine), or `size:` in its front matter. Comments are left out, so a template's
 * own hint never counts. Undefined when the brief says nothing.
 */
export function briefSize(brief: string): "small" | "standard" | undefined {
  const text = brief.replace(/<!--[\s\S]*?-->/g, "");
  const m = /^[\s>*-]*\**size\**\s*:\s*\**\s*(small|standard)\b\**\s*$/im.exec(text);
  return m ? (m[1]!.toLowerCase() as "small" | "standard") : undefined;
}

/**
 * Whether a change of this type, with this brief, takes the fast path (ADR 0113), and why: its
 * type is small (unless its brief says standard), or its brief says small and the type allows
 * that. A brief can always ask for the full path; it can ask for the fast one only where the
 * org pack lets it.
 */
export function fastPathOf(
  type: { size?: "standard" | "small" | undefined; smallWhenBriefSays?: boolean | undefined },
  brief = "",
): { fast: boolean; why: "type" | "brief" | "brief-standard" | "brief-not-allowed" | "standard" } {
  const said = briefSize(brief);
  if (type.size === "small")
    return said === "standard"
      ? { fast: false, why: "brief-standard" }
      : { fast: true, why: "type" };
  if (said === "small")
    return type.smallWhenBriefSays
      ? { fast: true, why: "brief" }
      : { fast: false, why: "brief-not-allowed" };
  return { fast: false, why: "standard" };
}

/**
 * The gate whose critic reviews the fast path's step (ADR 0113): the type's fastGate, else the
 * first gate of its last phase before build, else of its first phase. Undefined when gates.yaml
 * has no gate on that phase.
 */
export function fastGateOf(
  type: { phases: readonly string[]; fastGate?: string | undefined },
  gates: { gates: { id: string; phase: string }[] },
): string | undefined {
  if (type.fastGate) return type.fastGate;
  const before = type.phases.filter((p) => PRE_BUILD.includes(p));
  const phase = before.at(-1) ?? type.phases[0];
  return gates.gates.find((g) => g.phase === phase)?.id;
}

// ------------------------------------------------------------------ gates.yaml

export const Gate = z.strictObject({
  id: RecordId,
  phase: Phase,
  /**
   * Deprecated (ADR 0073), with minApprovals: roles that once had to approve the hand-off PR.
   * Still validated; not read. The Git host's own rules (branch protection, CODEOWNERS) decide.
   */
  approvers: Ids.min(1),
  minApprovals: z.number().int().positive().default(1),
  /** Checklist packs run at this gate. */
  checklists: Ids.default([]),
  /** Measurable checks that must pass: openspec-validate, tests-pass, coverage, and so on. */
  checks: z
    .array(
      z.strictObject({ check: RecordId, params: z.record(z.string(), z.unknown()).default({}) }),
    )
    .default([]),
  /**
   * Critic rounds at this gate before a person decides: a number, or "unlimited". Left out, it
   * is unlimited in a version 2 file (ADR 0087) and two in a version 1 file (as before).
   */
  maxAuthorRounds: z.union([z.number().int().min(0), z.literal("unlimited")]).optional(),
});

/**
 * gates.yaml's own schema version (ADR 0087). Version 2 makes a gate with no maxAuthorRounds
 * unlimited (plan principle 4: loops end by the fingerprint rule, not by a count). Version 1
 * files still read, with their old default of two rounds; `atticus upgrade` migrates them.
 */
export const GATES_SCHEMA_VERSION = 2 as const;

export const Gates = z
  .strictObject({
    schemaVersion: z.union([V, z.literal(GATES_SCHEMA_VERSION)]),
    gates: z.array(Gate).min(1),
  })
  .superRefine((g, ctx) => unique(g.gates, (x) => x.id, ctx, "gates"));

/** A gate's critic round limit, or undefined when there is none (ADR 0087). */
export function gateRoundLimit(
  gates: { schemaVersion: number; gates: { id: string; maxAuthorRounds?: number | "unlimited" }[] },
  gate: string,
): number | undefined {
  const m = gates.gates.find((g) => g.id === gate)?.maxAuthorRounds;
  if (m === "unlimited") return undefined;
  if (m !== undefined) return Math.max(1, m);
  return gates.schemaVersion === 1 ? 2 : undefined;
}

// ------------------------------------------------------------------ patterns/<code>.yaml

export const PatternCode = z
  .string()
  .regex(/^[A-Z][A-Za-z]*(\.[A-Za-z0-9]+)+$/, "a pattern code such as S.GW.SOR");

export const IntegrationPattern = z.strictObject({
  schemaVersion: V,
  code: PatternCode,
  name: z.string().min(1),
  definition: z.string().min(1),
  interaction: z.enum(["sync", "async", "data-access"]),
  route: z.enum(["gateway", "direct", "event-bus", "pubsub", "sftp", "mq", "jdbc", "other"]),
  targetType: z.enum(["product", "internal", "vendor", "data-store"]),
  controls: z.array(z.string().min(1)).default([]),
  resilience: z
    .strictObject({
      timeoutMs: z.number().int().positive().optional(),
      retries: z.number().int().min(0).optional(),
      circuitBreaker: z.boolean().optional(),
    })
    .default({}),
  technology: z.array(z.string().min(1)).default([]),
  /** How the pattern shows up in the catalog, so extractors can infer it. */
  detection: z
    .strictObject({
      via: z
        .array(z.enum(["gateway", "direct", "event-bus", "pubsub", "sftp", "mq", "other"]))
        .default([]),
      sync: z.enum(["sync", "async"]).optional(),
      targetBoundary: z.enum(["product", "internal", "vendor"]).optional(),
      /** Caller and callee belong to the same system (e.g. a UI and its own BFF). */
      sameSystem: z.boolean().optional(),
      hints: z.array(z.string().min(1)).default([]),
    })
    .default({ via: [], hints: [] }),
  /** Checklist rule ids this pattern adds when chosen. */
  checklist: Ids.default([]),
  source: z.string().min(1),
  version: Semver,
  status: z.enum(["confirmed", "to-review", "deprecated"]),
});
export type IntegrationPattern = z.infer<typeof IntegrationPattern>;

// ------------------------------------------------------------------ sources.yaml

const RelPath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !/^[A-Za-z]:/.test(p) &&
      !p.includes("\\") &&
      !p.split("/").includes(".."),
    "a relative path inside the metarepo",
  );

/** Suggested source kinds (ADR 0083). Tags are free text: an organisation adds its own. */
export const SOURCE_KIND_SUGGESTIONS = [
  "enterprise-architecture",
  "integration-patterns",
  "platform-runbook",
  "security-standard",
  "change-process",
  "framework",
] as const;

/**
 * Tags on a knowledge source (ADR 0083): the kinds of knowledge it holds and the frameworks it
 * is about. The source's owner is its `owner` field. Free text, lowercase slugs.
 */
export const SourceTags = z.strictObject({
  kinds: z.array(RecordId).default([]),
  frameworks: z.array(RecordId).default([]),
});
export type SourceTags = z.infer<typeof SourceTags>;

/**
 * sources.yaml's own schema version. Version 2 (ADR 0127) adds a wiki's `include` and `exclude`
 * globs. Version 3 (ADR 0132) adds what a source's word counts for (`authority`, `byPage`,
 * `reviewMonths`), where it applies (`appliesTo`), `readRestricted`, `maxPages`, and the
 * `confluence-export` and `sharepoint-export` folder types. Version 1 and 2 files still read;
 * `atticus upgrade` moves them up (`sources-v2`, `sources-v3`), changing nothing else.
 */
export const SOURCES_SCHEMA_VERSION = 3 as const;

/**
 * How much a source's word counts (ADR 0132), most first: the organisation's own rules
 * (enterprise architecture, security), a shared platform team's guidance, a framework's own
 * documentation, a team's pages, and reference material (a glossary, notes). A source without
 * one ranks as a team's. Authority decides only between pages on the same topic: never relevance.
 */
export const SOURCE_AUTHORITIES = [
  "standard",
  "platform",
  "framework",
  "team",
  "reference",
] as const;
export type SourceAuthority = (typeof SOURCE_AUTHORITIES)[number];

/** A page's status (ADR 0132): a page that is no longer current ranks below every current one. */
export const PAGE_STATUSES = ["current", "deprecated", "superseded", "archived"] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

/** Where a source applies (ADR 0132): a page attaches to a task whose places fall in it. */
export const SourceScope = z
  .strictObject({
    /** Catalog System ids. */
    systems: z.array(z.string().min(1)).optional(),
    /** Catalog Component ids, or a new component's id as its target flow names it. */
    components: z.array(z.string().min(1)).optional(),
    /** Where it runs: a platform (openshift, cloud-run, kubernetes) or a cloud (gcp, aws, azure). */
    platforms: z.array(z.string().min(1)).optional(),
    /** Repo types from the repos manifests (spring-boot, angular...). */
    repoTypes: z.array(z.string().min(1)).optional(),
    /** Frameworks a repo's facts declare (ADR 0124 addendum A-framework), or a new component's. */
    frameworks: z.array(z.string().min(1)).optional(),
    /** Every task that creates a component the catalog doesn't have yet. */
    newComponents: z.boolean().optional(),
  })
  .refine(
    (s) =>
      s.newComponents === true ||
      [s.systems, s.components, s.platforms, s.repoTypes, s.frameworks].some((l) => l?.length),
    { message: "appliesTo names nothing: leave it out to apply everywhere" },
  );
export type SourceScope = z.infer<typeof SourceScope>;

/**
 * A page path pattern inside a source, "/"-separated: `**` spans folders, `*` stays in one, `?`
 * is one character; a pattern ending in `/`, or with no wildcard, also takes the folder it names.
 */
const PageGlob = z
  .string()
  .min(1)
  .refine((g) => !g.startsWith("/") && !g.split("/").includes(".."), {
    message: "a page pattern is relative to the source: no leading / and no ..",
  });

const SOURCES_V2_FIELDS = ["include", "exclude"] as const;
const SOURCES_V3_FIELDS = [
  "authority",
  "byPage",
  "reviewMonths",
  "appliesTo",
  "readRestricted",
  "maxPages",
] as const;
const SOURCES_V3_TYPES = ["confluence-export", "sharepoint-export"];

/** A page override of a source's authority or status (ADR 0132), by page pattern; first match wins. */
const PageOverride = z
  .strictObject({
    match: z.array(PageGlob).min(1),
    authority: z.enum(SOURCE_AUTHORITIES).optional(),
    status: z.enum(PAGE_STATUSES).optional(),
  })
  .refine((o) => o.authority !== undefined || o.status !== undefined, {
    message: "a byPage entry sets authority or status",
  });

export const Sources = z
  .strictObject({
    schemaVersion: z.union([V, z.literal(2), z.literal(SOURCES_SCHEMA_VERSION)]),
    /** Adopt in place: where an existing metarepo keeps things. Nothing is moved. */
    layout: z
      .strictObject({
        openspec: RelPath.default("openspec"),
        catalog: RelPath.default("catalog"),
        constitution: RelPath.optional(),
        skills: z.array(RelPath).default([]),
        prompts: z.array(RelPath).default([]),
      })
      .default({ openspec: "openspec", catalog: "catalog", skills: [], prompts: [] }),
    /** Wikis and document stores, always read-only. Facts found there wait for confirmation. */
    wikis: z
      .array(
        z
          .strictObject({
            id: RecordId,
            /** git (ADR 0101): a repository of Markdown pages, such as an Azure DevOps or GitHub wiki, or a docs repo. */
            type: z.enum([
              "confluence",
              "ado-wiki",
              "sharepoint",
              "markdown-folder",
              "git",
              // Version 3 (ADR 0132): a space or site exported to a folder, read with its metadata.
              "confluence-export",
              "sharepoint-export",
            ]),
            location: z.string().min(1),
            spaces: z.array(z.string().min(1)).default([]),
            owner: z.string().optional(),
            /** What the source is about (ADR 0083), to guide the knowledge scan and filter items. */
            tags: SourceTags.optional(),
            /** A git wiki's branch or tag; default its default branch. */
            ref: z.string().min(1).optional(),
            /** The folder of a git wiki its pages are in; default the whole repository. */
            path: RelPath.optional(),
            /** A git wiki is cloned into local state (clone), or kept as a submodule of the metarepo under knowledge/repos/. */
            checkout: z.enum(["clone", "submodule"]).optional(),
            /** Version 2: only the pages matching one of these (default every page). */
            include: z.array(PageGlob).optional(),
            /** Version 2: never the pages matching one of these, even when included. */
            exclude: z.array(PageGlob).optional(),
            /** Version 3: how much the source's word counts; default as a team's. */
            authority: z.enum(SOURCE_AUTHORITIES).optional(),
            /** Version 3: a page's own authority or status, by pattern (first match wins). */
            byPage: z.array(PageOverride).optional(),
            /** Version 3: a standard not updated in this many months may be out of date. */
            reviewMonths: z.number().int().positive().optional(),
            /** Version 3: where the source applies; default everywhere. */
            appliesTo: SourceScope.optional(),
            /**
             * Version 3: the metarepo's audience may read pages under view restrictions. Default
             * false: a restricted page is skipped as above the limit, path and reason only.
             */
            readRestricted: z.boolean().optional(),
            /** Version 3: at most this many pages a knowledge scan reads of it per run. */
            maxPages: z.number().int().positive().optional(),
          })
          .transform((w) => (w.type === "git" ? { ...w, checkout: w.checkout ?? "clone" } : w))
          .superRefine((w, ctx) => {
            if (w.type !== "git")
              for (const k of ["ref", "path", "checkout"] as const)
                if (w[k] !== undefined)
                  ctx.addIssue({
                    code: "custom",
                    path: [k],
                    message: `${k} is for a git wiki; ${w.id} is ${w.type}`,
                  });
            // ADR 0122: inputs is the metarepo's own inputs/ folder, read as a source of its own.
            if (w.id === "inputs")
              ctx.addIssue({
                code: "custom",
                path: ["id"],
                message:
                  "inputs is the metarepo's own inputs/ folder, which Atticus reads as a source by itself: give this wiki another id",
              });
          }),
      )
      .default([]),
    /** Other teams' repos read as they are. */
    absorbed: z
      .array(
        z.strictObject({
          id: RecordId,
          url: z.string().min(1),
          format: z.enum(["openspec", "atticus", "speckit", "plain"]),
          ref: z.string().optional(),
          /** Adopt: a copy you own; link: follow their changes; ignore: keep it out. */
          mode: z.enum(["adopt", "link", "ignore"]).default("link"),
        }),
      )
      .default([]),
  })
  .superRefine((s, ctx) => {
    unique(s.wikis, (w) => w.id, ctx, "wikis");
    unique(s.absorbed, (a) => a.id, ctx, "absorbed");
    s.wikis.forEach((w, i) => {
      if (s.schemaVersion === 1)
        for (const f of SOURCES_V2_FIELDS)
          if (w[f] !== undefined)
            ctx.addIssue({
              code: "custom",
              path: ["wikis", i, f],
              message: `${f} needs schemaVersion 2: run atticus upgrade`,
            });
      if (s.schemaVersion < 3) {
        for (const f of SOURCES_V3_FIELDS)
          if (w[f] !== undefined)
            ctx.addIssue({
              code: "custom",
              path: ["wikis", i, f],
              message: `${f} needs schemaVersion 3: run atticus upgrade`,
            });
        if (SOURCES_V3_TYPES.includes(w.type))
          ctx.addIssue({
            code: "custom",
            path: ["wikis", i, "type"],
            message: `${w.type} needs schemaVersion 3: run atticus upgrade`,
          });
      }
    });
  });

/**
 * Whether a page path inside a source matches a page pattern (sources.yaml `include` and
 * `exclude`): `**` spans folders, `*` stays in one, `?` is one character, and a pattern ending
 * in `/` or with no wildcard also takes everything under the folder it names.
 */
export function pageGlobMatches(glob: string, page: string): boolean {
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  const p = page.replace(/\\/g, "/");
  const folder = g.endsWith("/") ? g.slice(0, -1) : /[*?]/.test(g) ? undefined : g;
  if (folder !== undefined) return p === folder || p.startsWith(`${folder}/`);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(p);
}

/** Whether a source reads a page, by its `include` and `exclude` (sources.yaml version 2). */
export function sourceReadsPage(
  w: { include?: string[] | undefined; exclude?: string[] | undefined },
  page: string,
): boolean {
  if (w.include?.length && !w.include.some((g) => pageGlobMatches(g, page))) return false;
  return !w.exclude?.some((g) => pageGlobMatches(g, page));
}

/** The rank of an authority, 0 the most; a source without one ranks as a team's (ADR 0132). */
export function authorityRank(a: SourceAuthority | undefined): number {
  return SOURCE_AUTHORITIES.indexOf(a ?? "team");
}

/**
 * The platforms each cloud runs (ADR 0132), so a source scoped to a cloud applies to a component
 * that runs on one of its platforms, and one scoped to a platform to a component placed on its
 * cloud. Lower case; an organisation names any other platform as it is.
 */
export const CLOUD_PLATFORMS: Record<string, readonly string[]> = {
  gcp: [
    "cloud-run",
    "gke",
    "cloud-functions",
    "app-engine",
    "compute-engine",
    "dataflow",
    "pubsub",
  ],
  aws: ["lambda", "ecs", "eks", "fargate", "ec2", "elastic-beanstalk", "sqs", "sns"],
  azure: ["aks", "app-service", "azure-functions", "container-apps", "service-bus"],
};

const low = (s: string) => s.trim().toLowerCase();

/** Whether a scope's platform or cloud takes in a task's: the same, or a cloud and one of its platforms. */
const takesIn = (scope: string, place: string) => {
  const e = low(scope);
  const p = low(place);
  return e === p || !!CLOUD_PLATFORMS[e]?.includes(p) || !!CLOUD_PLATFORMS[p]?.includes(e);
};

/**
 * The first of a task's platforms a scope's platforms take in, a cloud standing for its platforms
 * and a platform for its cloud; undefined when none is.
 */
export function platformsMatch(
  scope: readonly string[],
  places: readonly string[],
): string | undefined {
  return places.find((p) => scope.some((e) => takesIn(e, p)));
}

/** What the page says of itself, for its standing: from front matter, an export's metadata, its text. */
export interface PageSignals {
  labels?: readonly string[];
  /** A status the page or its export states (Confluence status, a SharePoint column). */
  status?: string;
  /** The space or site is archived. */
  spaceStatus?: string;
  /** When it was last reviewed or updated, YYYY-MM-DD. */
  updated?: string;
  /** The page's text, for a banner near its top. */
  text?: string;
}

/** A page's authority and status, and why, as its source, its overrides and the page itself say. */
export interface PageStanding {
  authority: SourceAuthority;
  status: PageStatus;
  /** What set the authority or status when it isn't the source's own: "byPage Drafts/**", "label deprecated". */
  by?: string;
  /** A standard not reviewed within the source's reviewMonths: shown as "may be out of date". */
  outOfDate?: { since: string; months: number };
}

const STATUS_WORDS: [RegExp, PageStatus][] = [
  [/^(deprecated|obsolete|retired|outdated)$/, "deprecated"],
  [/^(superseded|replaced)$/, "superseded"],
  [/^(archived|archive)$/, "archived"],
];
const statusOfWord = (w: string | undefined): PageStatus | undefined => {
  const x = (w ?? "").trim().toLowerCase();
  return STATUS_WORDS.find(([re]) => re.test(x))?.[1];
};

/** A banner near the top of a page: "> **Deprecated:** ...", "This page is superseded by ...". */
function bannerStatus(text: string): PageStatus | undefined {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === "---");
    start = end + 1;
  }
  let seen = 0;
  for (const raw of lines.slice(start)) {
    const l = raw
      .replace(/^[\s>*_#|-]+/, "")
      .replace(/[*_]/g, "")
      .trim();
    if (!l) continue;
    if (++seen > 6) break;
    const m =
      /^(deprecated|obsolete|superseded|archived|retired)\b/i.exec(l) ??
      /^this (?:page|document|standard|runbook) (?:is|has been|was) (deprecated|obsolete|superseded|archived|retired|replaced)\b/i.exec(
        l,
      );
    if (m) return statusOfWord(m[1]!);
  }
  return undefined;
}

const monthsBetween = (from: string, to: string) => {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to.slice(0, 10)}T00:00:00Z`);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
};

/**
 * A page's standing (ADR 0132), in three layers: the source's authority (default a team's); the
 * first `byPage` pattern that matches the page; then what the page says of itself: a status or
 * label (deprecated, superseded, archived), an archived space, or a banner at its top. A
 * standard last updated more than the source's `reviewMonths` before `now` may be out of date.
 */
export function pageStanding(
  w: {
    authority?: SourceAuthority | undefined;
    byPage?:
      | {
          match: string[];
          authority?: SourceAuthority | undefined;
          status?: PageStatus | undefined;
        }[]
      | undefined;
    reviewMonths?: number | undefined;
  },
  page: string,
  signals: PageSignals,
  now?: string,
): PageStanding {
  let authority: SourceAuthority = w.authority ?? "team";
  let status: PageStatus = "current";
  const by: string[] = [];
  const o = w.byPage?.find((x) => x.match.some((g) => pageGlobMatches(g, page)));
  if (o) {
    const hit = o.match.find((g) => pageGlobMatches(g, page))!;
    if (o.authority) authority = o.authority;
    if (o.status) status = o.status;
    by.push(`byPage ${hit}`);
  }
  if (status === "current") {
    const own =
      statusOfWord(signals.status) ??
      signals.labels?.map(statusOfWord).find((x) => x !== undefined) ??
      statusOfWord(signals.spaceStatus) ??
      (signals.text ? bannerStatus(signals.text) : undefined);
    if (own) {
      status = own;
      by.push(
        statusOfWord(signals.status)
          ? `status ${signals.status}`
          : signals.labels?.some((l) => statusOfWord(l))
            ? `label ${signals.labels.find((l) => statusOfWord(l))}`
            : statusOfWord(signals.spaceStatus)
              ? "its space is archived"
              : "a banner at its top",
      );
    }
  }
  const out: PageStanding = { authority, status, ...(by.length ? { by: by.join("; ") } : {}) };
  if (
    authority === "standard" &&
    w.reviewMonths &&
    signals.updated &&
    now &&
    monthsBetween(signals.updated, now) > w.reviewMonths
  )
    out.outOfDate = { since: signals.updated, months: w.reviewMonths };
  return out;
}

// ------------------------------------------------------------------ runtime.yaml

const SECRET_KEY = /(token|password|passwd|secret|api[-_]?key|private[-_]?key|credential)/i;

const AdapterSettings = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
  .superRefine((s, ctx) => {
    for (const k of Object.keys(s)) {
      if (SECRET_KEY.test(k)) {
        ctx.addIssue({
          code: "custom",
          path: [k],
          message: `${k} looks like a secret; secrets come from the credential store, never from the org pack`,
        });
      }
    }
  });

/**
 * An adapter entry. Every external system may also be `manual` (ADR 0032): a person does the
 * step and records the result, which is also the fallback when a configured adapter can't be
 * reached. The model adapter has no manual form: hand-off mode is that.
 */
const adapter = <T extends readonly [string, ...string[]]>(
  types: T,
  o: { manual?: boolean } = {},
) =>
  z.strictObject({
    type: z.enum([...types, "mock", ...(o.manual === false ? [] : ["manual"])] as unknown as [
      string,
      ...string[],
    ]),
    settings: AdapterSettings.default({}),
  });

/** How a code repo runs a task (ADR 0030): Spec Kit inside the repo, or plain Atticus task files. */
export const BuildEngine = z.enum(["speckit", "atticus"]);
export type BuildEngine = z.infer<typeof BuildEngine>;

export const Autonomy = z.enum(["plan-only", "draft", "draft-and-pr"]);

/**
 * runtime.yaml's `retrieval` section (ADR 0116, defaults changed in its addendum):
 * - embeddings.model: `bundled` (the default: the model installed with Atticus as the npm
 *   package @maycombhq/embed-model, all-MiniLM-L6-v2), `off`, or a folder with
 *   `atticus-model.yaml` (relative to the org pack); embeddings.runtime: a folder whose
 *   node_modules holds the onnxruntime packages, when they aren't beside Atticus. Where the model or onnxruntime isn't
 *   installed, the engine searches by words and names and says so. Nothing is ever downloaded.
 * - expansion (on by default): one model call before a step's selection that names what the
 *   input is about and the names it uses (the step's gaps come from it).
 * - rerank (off by default, not measured yet): one call that orders the candidates when they
 *   don't fit.
 */
export const RetrievalSettings = z.strictObject({
  embeddings: z
    .strictObject({
      model: z.string().min(1).default("bundled"),
      runtime: z.string().min(1).optional(),
    })
    .default({ model: "bundled" }),
  expansion: z.boolean().default(true),
  rerank: z.boolean().default(false),
});
export type RetrievalSettings = z.infer<typeof RetrievalSettings>;

/**
 * The effective retrieval settings of a runtime.yaml (ADR 0116): its section with the defaults
 * filled in, or the defaults when there is none. Every reader goes through this.
 */
export function retrievalOf(
  runtime?: { retrieval?: z.input<typeof RetrievalSettings> } | null,
): RetrievalSettings {
  const r = RetrievalSettings.safeParse(runtime?.retrieval ?? {});
  return r.success ? r.data : RetrievalSettings.parse({});
}

/**
 * The assistants Atticus writes slash commands, instructions and skills for (ADR 0121), each in
 * the files that tool reads (@maycombhq/assistant-files). `agents-md` is any tool that reads
 * AGENTS.md: Codex and others.
 */
export const ASSISTANTS = [
  "copilot",
  "claude-code",
  "cursor",
  "gemini-cli",
  "windsurf",
  "agents-md",
] as const;
export const AssistantId = z.enum(ASSISTANTS);
export type AssistantId = z.infer<typeof AssistantId>;

/**
 * The kinds of AI step (C5, ADR 0121 addendum: per-step models). Each request's class is decided
 * in code (`@maycombhq/ai` `stepClassOf`), never by its prompt, and picks the model it runs on:
 * - read: reading repos into facts (atticus map and its fix round) and scan verify;
 * - draft: the feature, architecture and stories drafts, small changes, change and spec drafts,
 *   scan surveys and their questions, dialect and framework drafts, tasks and tests;
 * - critic: the critic's lenses and the hand-up lens;
 * - knowledge: the knowledge scan and find, what a change needs (which items apply) and ask;
 * - quick: everything else that's small: judgments, context expansion and ordering, names,
 *   glossary definitions, ticket text and explanations.
 * Kept here, beside runtime.yaml's `models`, which names a model for each.
 */
export const STEP_CLASSES = ["read", "draft", "critic", "knowledge", "quick"] as const;
export const StepClass = z.enum(STEP_CLASSES);
export type StepClass = z.infer<typeof StepClass>;

/**
 * runtime.yaml's own schema version (ADR 0121 addendum). Version 2 adds a model per kind of step
 * (`models.read`, `draft`, `critic`, `knowledge`, `quick`). A version 1 file still reads, every
 * step on the one model; `atticus upgrade` moves it to version 2 (`runtime-v2`), changing nothing
 * else.
 */
export const RUNTIME_SCHEMA_VERSION = 2 as const;

/**
 * The model for one kind of step: a model of runtime.yaml's provider (model mode, headless
 * Claude Code), or `vendor/family` for a model an editor offers (VS Code's language models, or
 * the one a hand-off text asks for). A bare name in an editor is Copilot's family of that name.
 */
const StepModel = z.string().min(1).regex(/^\S+$/, "a model name or vendor/family, without spaces");

const RuntimeFields = z.strictObject({
  schemaVersion: z.union([V, z.literal(RUNTIME_SCHEMA_VERSION)]),
  assistants: z
    .strictObject({
      allowed: z.array(AssistantId).min(1),
      default: AssistantId,
    })
    .refine((a) => a.allowed.includes(a.default), "the default assistant must be allowed"),
  editors: z
    .array(z.enum(["vscode", "intellij"]))
    .min(1)
    .default(["vscode", "intellij"]),
  /**
   * What AI may do here (ADR 0046). on: every AI step. text-only: no step is given a picture, so
   * pictures go to a person. off: no AI step runs at all; AI lenses are recorded as not run and
   * don't hold a gate, AI buttons become guidance, and people write what agents would draft.
   */
  ai: z.enum(["on", "text-only", "off"]).default("on"),
  /** How AI steps run: hand-off to the assistant, a direct model call, or headless Claude Code. */
  modes: z
    .strictObject({
      allowed: z.array(z.enum(["hand-off", "model", "headless-claude-code"])).min(1),
      default: z.enum(["hand-off", "model", "headless-claude-code"]),
    })
    .refine((m) => m.allowed.includes(m.default), "the default mode must be allowed")
    .default({ allowed: ["hand-off"], default: "hand-off" }),
  models: z
    .strictObject({
      allowed: z.array(z.string().min(1)).default([]),
      /** A recommended model per task type, shown in the assistant's picker hints. */
      recommended: z.record(z.string(), z.string()).default({}),
      /**
       * Version 2 (ADR 0121 addendum): the organisation's model for each kind of step. A step
       * whose kind names none runs on the one model (adapters.model's, or the editor's), as every
       * step did in version 1. A person's editor setting overrides these for them.
       */
      read: StepModel.optional(),
      draft: StepModel.optional(),
      critic: StepModel.optional(),
      knowledge: StepModel.optional(),
      quick: StepModel.optional(),
    })
    .default({ allowed: [], recommended: {} }),
  autonomy: z
    .strictObject({
      default: Autonomy.default("draft"),
      /** The most a run may do in a repo, whatever the person picks. */
      capPerRepo: z.record(RecordId, Autonomy).default({}),
      maxFixRounds: z.number().int().min(0).max(5).default(3),
    })
    .default({ default: "draft", capPerRepo: {}, maxFixRounds: 3 }),
  budgets: z
    .strictObject({
      defaultTokens: z.number().int().positive().default(200_000),
      perAgent: z.record(RecordId, z.number().int().positive()).default({}),
    })
    .default({ defaultTokens: 200_000, perAgent: {} }),
  retention: z
    .strictObject({ runsDays: z.number().int().positive().default(30) })
    .default({ runsDays: 30 }),
  /**
   * The prompt and response history (ADR 0110): what people type to their assistant in a
   * metarepo, kept on their machine under .atticus/history/. On unless this says record: false.
   * Additive and optional, so no schema version bump. Configuration, not a safety rule.
   */
  history: z.strictObject({ record: z.boolean().default(true) }).optional(),
  /**
   * Retrieval by meaning in the context engine (ADR 0116). Additive and optional, so no schema
   * version bump (as history and buildEngine). Read it through `retrievalOf`, so a pack without
   * the section and one with an empty section get the same defaults.
   */
  retrieval: RetrievalSettings.optional(),
  /** Atticus sends no telemetry unless an organisation turns it on here. */
  telemetry: z.strictObject({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  adapters: z
    .strictObject({
      workTracker: adapter(["azure-devops", "jira"] as const).optional(),
      serviceDesk: adapter(["servicenow", "jira-service-management"] as const).optional(),
      gitHost: adapter(["github", "azure-repos", "gitlab", "bitbucket"] as const).optional(),
      wiki: adapter(["confluence", "ado-wiki", "sharepoint"] as const).optional(),
      notify: adapter(["teams", "slack", "email"] as const).optional(),
      design: adapter(["figma"] as const).optional(),
      /**
       * A built-in provider, or (ADR 0121 item 4) the id of a model-provider plugin in
       * org-pack/plugins/model-providers/<id>/. Widening the list keeps every v1 file valid.
       */
      model: z
        .strictObject({
          type: z.union([
            z.enum(["anthropic", "openai-compatible", "azure-openai", "bedrock", "vertex", "mock"]),
            z
              .string()
              .regex(
                /^(?!manual$)[a-z][a-z0-9-]*$/,
                "a built-in provider (anthropic, openai-compatible, azure-openai, bedrock) or the id of a plugin in org-pack/plugins/model-providers/; there is no manual model: hand-off mode is the manual way",
              ),
          ]),
          settings: AdapterSettings.default({}),
        })
        .optional(),
    })
    .default({}),
  /**
   * The build engine for code repos (ADR 0030 point 5): `speckit` (the default when this is
   * left out) or `atticus`, with per-repo overrides. Additive and optional, so no schema
   * version bump. The change level is always OpenSpec.
   */
  buildEngine: z
    .strictObject({
      default: BuildEngine.default("speckit"),
      perRepo: z.record(RecordId, BuildEngine).default({}),
    })
    .optional(),
});

export const Runtime = RuntimeFields.superRefine((r, ctx) => {
  if (r.schemaVersion !== 1) return;
  for (const c of STEP_CLASSES)
    if (r.models[c] !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["models", c],
        message: `models.${c} needs schemaVersion 2 (ADR 0121 addendum): run atticus upgrade`,
      });
});
export type Runtime = z.infer<typeof Runtime>;

/** runtime.yaml's model for each kind of step, those it names (ADR 0121 addendum). */
export function stepModelsOf(
  runtime: Pick<Runtime, "models"> | undefined,
): Partial<Record<StepClass, string>> {
  const out: Partial<Record<StepClass, string>> = {};
  for (const c of STEP_CLASSES) {
    const m = runtime?.models[c];
    if (m) out[c] = m;
  }
  return out;
}

// ------------------------------------------------------------------ process/

/** Front matter of a skill (process/skills/<id>/SKILL.md). The body is the instructions. */
export const SkillMeta = z.strictObject({
  id: RecordId,
  name: z.string().min(1),
  description: z.string().min(1),
  appliesTo: z
    .strictObject({
      repoTypes: Ids.default([]),
      artifacts: z.array(ChangeArtifact).default([]),
      changeTypes: Ids.default([]),
    })
    .default({ repoTypes: [], artifacts: [], changeTypes: [] }),
  owner: z.string().min(1),
  source: z.string().min(1),
  status: z.enum(["active", "draft", "stale", "retired"]).default("active"),
  reviewedAt: z.iso.date().optional(),
});

/** A service-desk request template (process/snow/<id>.yaml). */
export const ServiceRequestTemplate = z
  .strictObject({
    schemaVersion: V,
    id: RecordId,
    name: z.string().min(1),
    requestType: z.string().min(1),
    fields: z
      .array(
        z.strictObject({
          name: z.string().min(1),
          required: z.boolean().default(false),
          /** Template filled from the change and catalog, e.g. "${record}". */
          from: z.string().optional(),
          help: z.string().optional(),
        }),
      )
      .min(1),
    approvers: z.array(z.string().min(1)).default([]),
    leadTimeDays: z.number().min(0),
    /** Catalog changes that need this request. */
    triggers: z
      .array(
        z.strictObject({
          kind: Kind,
          change: z.enum(["planned-new", "planned-modify", "planned-retire"]),
          where: z.record(z.string(), z.string()).default({}),
        }),
      )
      .min(1),
    /** Other templates always raised with this one. */
    alsoNeeds: Ids.default([]),
  })
  .superRefine((t, ctx) => unique(t.fields, (f) => f.name, ctx, "fields"));

// ------------------------------------------------------------------ process/procedures/<id>.yaml

/**
 * A JSON Schema for a step's inputs or outputs. Kept as data; Atticus validates values
 * against it when a person or an executor records them.
 */
const StepSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (s) => s.type === undefined || s.type === "object",
    "a step's inputs and outputs are an object",
  )
  .default({ type: "object" });

/**
 * A procedure (ADR 0033): a named, ordered list of steps in an outside system, each with typed
 * inputs and outputs, whether it writes, and where the knowledge came from. Drafted from the
 * organisation's how-to pages, uploads and past tickets, reviewed by a person, kept here.
 * Additive C6 file kind: no schema version bump. `executors.allowed` is the allowlist: an
 * executor may run this procedure only if it is named here (off by default).
 */
export const Procedure = z
  .strictObject({
    schemaVersion: V,
    id: RecordId,
    name: z.string().min(1),
    description: z.string().optional(),
    system: z.enum([...MANUAL_SYSTEMS, "other"]),
    /** The service-desk template (process/snow) this procedure raises, if any. */
    template: RecordId.optional(),
    steps: z
      .array(
        z.strictObject({
          id: RecordId,
          name: z.string().min(1),
          /** The kind of write or read, matching manual steps' `action` (submit-request, …). */
          kind: RecordId,
          writes: z.boolean(),
          inputs: StepSchema,
          outputs: StepSchema,
          instructions: z.string().optional(),
          evidence: z
            .array(
              z.strictObject({
                source: z.string().min(1),
                line: z.number().int().positive().optional(),
                note: z.string().optional(),
              }),
            )
            .default([]),
        }),
      )
      .min(1),
    executors: z
      .strictObject({
        /** Executors allowed to run this procedure, by name. Empty: none (the default). */
        allowed: Ids.default([]),
        /** Hosts an http executor may be on besides 127.0.0.1. Empty: local only. */
        remoteHosts: z.array(z.string().min(1)).default([]),
      })
      .default({ allowed: [], remoteHosts: [] }),
    /** Where the procedure was drafted from (page, upload or ticket export). */
    source: z.string().min(1),
    status: z.enum(["draft", "active", "retired"]).default("draft"),
    reviewedBy: z.string().optional(),
    reviewedAt: z.iso.date().optional(),
  })
  .superRefine((p, ctx) => unique(p.steps, (s) => s.id, ctx, "steps"));
export type Procedure = z.infer<typeof Procedure>;

// ------------------------------------------------------------------ test-strategy.yaml

export const TestType = z.enum([
  "unit",
  "contract",
  "integration",
  "e2e",
  "regression",
  "performance",
  "security",
  "accessibility",
  "data-migration",
]);

export const TestStrategy = z
  .strictObject({
    schemaVersion: V,
    matrix: z
      .array(
        z.strictObject({
          changeType: RecordId,
          risk: z.enum(["low", "medium", "high"]),
          required: z.array(TestType).min(1),
        }),
      )
      .min(1),
    /** Definition of ready for a story, checked by the story lens. */
    definitionOfReady: z.array(z.string().min(1)).default([]),
  })
  .superRefine((t, ctx) => unique(t.matrix, (m) => `${m.changeType}/${m.risk}`, ctx, "matrix"));

// ------------------------------------------------------------------ estimates.yaml (ADR 0109)

/** A range of ideal developer days: 20%, 50% and 80% of like work took at most this long. */
export const DayRange = z
  .strictObject({
    p20: z.number().positive(),
    p50: z.number().positive(),
    p80: z.number().positive(),
  })
  .refine((d) => d.p20 <= d.p50 && d.p50 <= d.p80, {
    message: "p20, p50 and p80 go up: p20 <= p50 <= p80",
  });

/**
 * The reference ranges an estimate starts from, before past changes calibrate it: per class of
 * work (a target flow's step, `<op>/<kind>` and what it reaches, e.g. add/call-out/vendor/new-entry),
 * the days like work takes. Who agreed the figures is required: a range nobody stands behind is
 * not an estimate.
 */
export const Estimates = z.strictObject({
  schemaVersion: V,
  /** Who agreed these figures, and when (e.g. "the platform team, September 2026"). */
  source: z.string().min(1),
  classes: z
    .array(
      z.strictObject({
        /** A class, or its first segments then `*` (add/call-out/*). The first that matches wins. */
        match: z.string().regex(/^[a-z-]+(\/[a-z-]+)*(\/\*)?$|^\*$/),
        days: DayRange,
        why: z.string().optional(),
      }),
    )
    .min(1),
  /** Working with each repo past the first: builds, reviews and releases to line up. */
  perExtraRepo: DayRange.optional(),
  /** How much each risk widens the upper end (p80), e.g. { unconfirmed-step: 1.15 }. */
  risks: z.record(z.string(), z.number().min(1).max(3)).default({}),
});
export type Estimates = z.infer<typeof Estimates>;

// ------------------------------------------------------------------ openspec.yaml (ADR 0126)

/**
 * What Atticus does with OpenSpec's stores (beta; ADR 0126, an addendum to ADR 0006). A new,
 * optional file: a pack without it reads no store and hand-down adds no reference, as before.
 * Atticus never registers, clones, pulls, pushes or writes into a store.
 */
export const OpenSpecSettings = z
  .strictObject({
    schemaVersion: V,
    /** Existing OpenSpec stores, read read-only beside the metarepo's own changes and specs. */
    stores: z
      .array(
        z.strictObject({
          /** A clone of the store: relative to the metarepo root, absolute, or starting `~/`. */
          path: z.string().min(1),
          /** Shown with what is read from it; default its store.yaml id, else its folder name. */
          label: RecordId.optional(),
        }),
      )
      .default([]),
    /**
     * Hand-down adds this metarepo (its store.yaml id, with its origin as `remote` when it has
     * one) under `references:` in the code repo's existing openspec/config.yaml.
     */
    referenceInRepos: z.boolean().default(false),
  })
  .superRefine((s, ctx) => {
    unique(s.stores, (x) => x.path, ctx, "stores");
    unique(
      s.stores.filter((x) => x.label),
      (x) => x.label!,
      ctx,
      "stores",
    );
  });
export type OpenSpecSettings = z.infer<typeof OpenSpecSettings>;

// ------------------------------------------------------------------ profiles/<platform>/profile.yaml

export const Profile = z
  .strictObject({
    schemaVersion: V,
    platform: RecordId,
    name: z.string().min(1),
    systems: z
      .array(
        z.strictObject({
          id: RecordId,
          name: z.string().min(1),
          boundary: z.enum(["product", "internal", "vendor"]),
          owner: z.string().optional(),
          /** Other names people and diagrams use for this system. */
          aliases: z.array(z.string().min(1)).default([]),
          /** Free labels copied to the System record; `saas` marks a SaaS vendor (ADR 0040). */
          tags: z.array(z.string().min(1)).default([]),
        }),
      )
      .default([]),
    environments: Ids.default(["dev", "test", "prod"]),
    /** How diagram markers map to catalog status. */
    legend: z
      .strictObject({
        new: z.array(z.string().min(1)).default(["New"]),
        modify: z.array(z.string().min(1)).default(["Modify"]),
        retire: z.array(z.string().min(1)).default(["Retire"]),
      })
      .default({ new: ["New"], modify: ["Modify"], retire: ["Retire"] }),
    /** Gate ids from gates.yaml that are mandatory on this platform. */
    gates: Ids.default([]),
  })
  .superRefine((p, ctx) => {
    unique(p.systems, (s) => s.id, ctx, "systems");
    const alias = new Map<string, string>();
    p.systems.forEach((s, i) => {
      for (const a of [s.name, ...s.aliases]) {
        const k = a.toLowerCase();
        const other = alias.get(k);
        if (other && other !== s.id) {
          ctx.addIssue({
            code: "custom",
            path: ["systems", i, "aliases"],
            message: `"${a}" already names ${other}`,
          });
        }
        alias.set(k, s.id);
      }
    });
  });
export type Profile = z.infer<typeof Profile>;
