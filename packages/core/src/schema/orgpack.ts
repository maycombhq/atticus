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
  })
  .superRefine((t, ctx) => {
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

export const ChangeTypes = z
  .strictObject({ schemaVersion: V, types: z.array(ChangeType).min(1) })
  .superRefine((c, ctx) => unique(c.types, (t) => t.id, ctx, "types"));

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

export const Sources = z
  .strictObject({
    schemaVersion: V,
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
            type: z.enum(["confluence", "ado-wiki", "sharepoint", "markdown-folder", "git"]),
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
  });

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

export const Runtime = z.strictObject({
  schemaVersion: V,
  assistants: z
    .strictObject({
      allowed: z.array(z.enum(["copilot", "claude-code"])).min(1),
      default: z.enum(["copilot", "claude-code"]),
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
      model: adapter(
        ["anthropic", "openai-compatible", "azure-openai", "bedrock", "vertex"] as const,
        {
          manual: false,
        },
      ).optional(),
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
export type Runtime = z.infer<typeof Runtime>;

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
