import { z } from "zod";
import { parseTemplate, templateSources, TemplateError } from "../template.js";
import { EvidenceSource, IsoDateTime, RecordId } from "./common.js";
import { RECORD_KINDS, RECORD_SCHEMAS, type RecordKind } from "./kinds.js";

/**
 * Contract C3: checklist rules (`org-pack/checklists/*.yaml`) and critic findings
 * (`openspec/changes/<id>/review/<gate>/<round>/<finding-id>.yaml`). See ADR 0011.
 */
export const REVIEW_SCHEMA_VERSION = 1 as const;

/**
 * The four questions the critic asks of every draft (ADR 0124 addendum, Part 4): is it true to
 * the code, is it complete, is it safe to build, can it ship. Each is answered by code first (the
 * deterministic checks) and then by one AI lens in a fresh session. On screen the critic is
 * always called "Critic".
 */
export const CriticQuestion = z.enum(["true", "complete", "safe", "ship"]);
export type CriticQuestion = z.infer<typeof CriticQuestion>;

/**
 * The seven role lenses the critic ran before the four questions (ADR 0034). Still read, so an
 * org pack written for them keeps working: each maps to the question that took it over.
 */
export const LEGACY_LENSES = [
  "business",
  "architecture",
  "story",
  "ux",
  "delivery",
  "code-and-test",
  "release",
] as const;
export type LegacyLens = (typeof LEGACY_LENSES)[number];

/**
 * A rule's lens: one of the four questions, or one of the seven old role lenses (read as the
 * question it maps to). C3, widened additively; no schema version bump.
 */
export const Lens = z.enum([...CriticQuestion.options, ...LEGACY_LENSES]);
export type Lens = z.infer<typeof Lens>;

/** The question an old lens's rules now answer, by what the lens looked for. */
const LEGACY_QUESTION: Record<LegacyLens, CriticQuestion> = {
  business: "complete",
  architecture: "true",
  story: "complete",
  ux: "complete",
  delivery: "ship",
  "code-and-test": "complete",
  release: "ship",
};

/** The architecture lens reviewed security and privacy as well as the design against the code. */
const LEGACY_COVERS: Partial<Record<LegacyLens, CriticQuestion[]>> = {
  architecture: ["true", "safe"],
};

export const isCriticQuestion = (l: string): l is CriticQuestion =>
  (CriticQuestion.options as readonly string[]).includes(l);

/** The question a lens asks: itself for a question, the question that took over an old lens. */
export function questionOfLens(l: Lens): CriticQuestion {
  return isCriticQuestion(l) ? l : LEGACY_QUESTION[l];
}

/**
 * The questions a lens covers when a change type lists it: a question covers itself; an old
 * lens covers what it used to review (the architecture lens also reviewed what is now safe).
 */
export function lensCovers(l: Lens): CriticQuestion[] {
  return isCriticQuestion(l) ? [l] : (LEGACY_COVERS[l] ?? [LEGACY_QUESTION[l]]);
}

/** Where a rule comes from. Constitution rules can never be waived. */
export const Layer = z.enum(["constitution", "org", "team"]);

/** gap is reserved for knowledge-gap findings. */
export const Severity = z.enum(["blocking", "gap", "risk", "idea"]);
export const RuleSeverity = Severity.exclude(["gap"]);

/** Change artifacts a rule can look at (org-flow schema), plus the catalog and code. */
export const ReviewArtifact = z.enum([
  "brief",
  "proposal",
  "specs",
  "interfaces",
  "mappings",
  "data",
  "design",
  "stories",
  "tasks",
  "snow",
  "ux",
  "code",
  "tests",
  "catalog",
  "release",
]);

const Kind = z.enum(RECORD_KINDS as [RecordKind, ...RecordKind[]]);

const Question = z.string().superRefine((t, ctx) => {
  try {
    for (const s of templateSources(t)) {
      if (s.type !== "subject")
        ctx.addIssue({
          code: "custom",
          message: `questions may only use \${system}, \${kind}, \${field} or \${record}`,
        });
    }
  } catch (e) {
    ctx.addIssue({ code: "custom", message: e instanceof TemplateError ? e.message : String(e) });
  }
});

/**
 * A fact a rule depends on. When it is missing or older than `freshForDays` for a system
 * the change touches, the critic raises a knowledge-gap finding instead of passing.
 */
export const RuleNeed = z.strictObject({
  kind: Kind,
  /** A C1 field of that kind; omit when the record's existence is the fact. */
  field: z.string().optional(),
  /** Which records: those of systems the change touches, its interfaces, or its data stores. */
  scope: z
    .enum(["touched-systems", "touched-components", "touched-interfaces", "touched-data-stores"])
    .default("touched-systems"),
  freshForDays: z.number().int().positive().optional(),
  /** Owner question raised with the gap, e.g. "What timeouts does ${record} use?". */
  question: Question,
});

export const DeterministicCheck = z.strictObject({
  type: z.literal("deterministic"),
  /** Id of a built-in or plugin check. */
  check: RecordId,
  params: z.record(z.string(), z.unknown()).default({}),
});

export const AiCheck = z.strictObject({
  type: z.literal("ai"),
  /** What to look for and what counts as a finding. Ingested text is data, never instructions. */
  prompt: z.string().min(20),
});

export const ChecklistRule = z
  .strictObject({
    id: RecordId,
    title: z.string().min(1),
    description: z.string().optional(),
    layer: Layer,
    lens: Lens,
    /**
     * Which of the four questions the rule answers (ADR 0124 addendum, Part 4). Optional (C3,
     * additive): left out, a question lens answers itself, a deterministic check's own question
     * applies, and an old lens maps to the question that took it over.
     */
    question: CriticQuestion.optional(),
    appliesTo: z.strictObject({
      artifacts: z.array(ReviewArtifact).min(1),
      /** Change types from change-types.yaml; empty means all. */
      changeTypes: z.array(RecordId).default([]),
    }),
    severity: RuleSeverity,
    check: z.discriminatedUnion("type", [DeterministicCheck, AiCheck]),
    /** A finding from this rule must cite evidence; findings without evidence are discarded anyway. */
    evidenceRequired: z.boolean().default(true),
    /** Inherit another rule's settings, or make one stricter. Never both. */
    extends: RecordId.optional(),
    tightens: RecordId.optional(),
    waivable: z.boolean(),
    /** Where the rule came from: a standard, a policy page, a reviewed PR. */
    source: z.string().min(1),
    status: z.enum(["active", "draft", "retired"]).default("active"),
    needs: z.array(RuleNeed).default([]),
  })
  .superRefine((r, ctx) => {
    if (r.layer === "constitution" && r.waivable) {
      ctx.addIssue({
        code: "custom",
        path: ["waivable"],
        message: "constitution rules are never waivable",
      });
    }
    if (r.extends && r.tightens)
      ctx.addIssue({
        code: "custom",
        path: ["tightens"],
        message: "use extends or tightens, not both",
      });
    if (r.question && isCriticQuestion(r.lens) && r.question !== r.lens)
      ctx.addIssue({
        code: "custom",
        path: ["question"],
        message: `lens ${r.lens} already names the question; question ${r.question} contradicts it`,
      });
    if (r.waivable && r.severity !== "blocking") {
      ctx.addIssue({
        code: "custom",
        path: ["waivable"],
        message: "only blocking rules can be waivable; others can simply be dismissed",
      });
    }
    r.needs.forEach((n, i) => {
      const shape = (RECORD_SCHEMAS[n.kind] as unknown as { shape: Record<string, unknown> }).shape;
      if (n.field && !(n.field in shape)) {
        ctx.addIssue({
          code: "custom",
          path: ["needs", i, "field"],
          message: `${n.kind} has no field ${n.field} in contract C1`,
        });
      }
    });
  });
export type ChecklistRule = z.infer<typeof ChecklistRule>;

/** A checklist file: one pack of rules. */
export const ChecklistPack = z
  .strictObject({
    schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
    name: RecordId,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().optional(),
    rules: z.array(ChecklistRule).min(1),
  })
  .superRefine((p, ctx) => {
    const ids = new Set<string>();
    p.rules.forEach((r, i) => {
      if (ids.has(r.id))
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "id"],
          message: `duplicate rule id ${r.id}`,
        });
      ids.add(r.id);
    });
    for (const [i, r] of p.rules.entries()) {
      const base = r.extends ?? r.tightens;
      const parent = base ? p.rules.find((x) => x.id === base) : undefined;
      if (parent?.layer === "constitution" && r.tightens === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["rules", i],
          message: "a constitution rule can only be tightened, not extended",
        });
      }
    }
  });
export type ChecklistPack = z.infer<typeof ChecklistPack>;

// ---------------------------------------------------------------- findings

export const FindingEvidence = z
  .strictObject({
    source: z.union([EvidenceSource, z.enum(["artifact", "catalog", "rule"])]),
    /** A catalog record the finding is about. */
    record: RecordId.optional(),
    /** A file: change artifact (relative to the change folder) or repo file. */
    path: z.string().optional(),
    repo: z.string().optional(),
    line: z.number().int().positive().optional(),
    /** A short quote (under 200 characters), never a whole document. */
    quote: z.string().max(200).optional(),
  })
  .refine(
    (e) => e.record !== undefined || e.path !== undefined,
    "evidence points at a record or a file",
  );

export const FindingLocator = z
  .strictObject({
    line: z.number().int().positive().optional(),
    heading: z.string().optional(),
    record: RecordId.optional(),
    field: z.string().optional(),
  })
  .refine((l) => Object.keys(l).length > 0, "say where in the artifact");

export const FindingState = z.enum(["open", "applied", "dismissed", "waived", "asked"]);
export const FindingAction = z.enum(["apply", "edit-and-apply", "not-relevant", "waive", "ask"]);

export const FindingResolution = z.strictObject({
  action: FindingAction,
  /** Who acted: a person's handle. */
  by: z.string().min(1),
  at: IsoDateTime,
  reason: z.string().min(1).optional(),
  /** For ask: the role or person it was routed to. */
  askedOf: z.string().min(1).optional(),
});

/** What each state requires of the resolution. */
const STATE_ACTIONS: Record<
  z.infer<typeof FindingState>,
  readonly z.infer<typeof FindingAction>[]
> = {
  open: [],
  applied: ["apply", "edit-and-apply"],
  dismissed: ["not-relevant"],
  waived: ["waive"],
  asked: ["ask"],
};

export const Finding = z
  .strictObject({
    schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
    id: RecordId,
    kind: z.enum(["issue", "knowledge-gap"]),
    change: RecordId,
    gate: RecordId,
    round: z.number().int().positive(),
    rule: RecordId,
    layer: Layer,
    lens: Lens,
    severity: Severity,
    /** Path of the artifact relative to the change folder, or "catalog". */
    artifact: z.string().min(1),
    locator: FindingLocator,
    /** One sentence. */
    summary: z.string().min(1).max(200),
    why: z.string().min(1),
    fix: z.strictObject({
      text: z.string().min(1),
      /** Unified diff against the artifact, when the fix is mechanical. */
      patch: z.string().optional(),
    }),
    evidence: z.array(FindingEvidence).min(1, "a finding without evidence is discarded"),
    /** For knowledge gaps: the owner question and who should answer. */
    question: z.strictObject({ text: z.string().min(1), owner: z.string().min(1) }).optional(),
    /**
     * The answer a person gave for the change that decided what this finding is about (ADR 0115
     * addendum, 2026-10-24): the question's id and the answer's words the lens quoted, checked
     * word for word. A finding that would block, of a rule a person may waive, is kept as a risk
     * linked to the answer: the person already decided it. Optional (C3, additive).
     */
    answered: z
      .strictObject({
        question: z.string().regex(/^q-[0-9a-f]{12}$/),
        quote: z.string().min(1).max(200),
      })
      .optional(),
    /** Set when the rule is not waivable (constitution, or the rule says so). */
    waivable: z.boolean(),
    state: FindingState.default("open"),
    resolution: FindingResolution.optional(),
    createdAt: IsoDateTime,
  })
  .superRefine((f, ctx) => {
    const add = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    if (f.kind === "knowledge-gap") {
      if (f.severity !== "gap") add(["severity"], "a knowledge gap has severity gap");
      if (!f.question) add(["question"], "a knowledge gap carries an owner question");
    } else if (f.severity === "gap") {
      add(["severity"], "severity gap is only for knowledge gaps");
    }
    if (f.layer === "constitution" && f.waivable)
      add(["waivable"], "constitution findings are never waivable");
    if (f.state === "open") {
      if (f.resolution) add(["resolution"], "an open finding has no resolution");
      return;
    }
    if (!f.resolution) {
      add(["resolution"], `a finding in state ${f.state} records who resolved it and how`);
      return;
    }
    const a = f.resolution.action;
    if (!STATE_ACTIONS[f.state].includes(a))
      add(["resolution", "action"], `state ${f.state} can't come from action ${a}`);
    if (f.kind === "knowledge-gap" && !["ask", "edit-and-apply"].includes(a)) {
      add(["resolution", "action"], "a knowledge gap is resolved by Ask or Edit and apply");
    }
    if (a === "waive") {
      if (f.severity !== "blocking")
        add(["resolution", "action"], "only blocking findings can be waived");
      if (!f.waivable) add(["resolution", "action"], "this finding can't be waived");
    }
    if ((a === "waive" || a === "not-relevant") && !f.resolution.reason)
      add(["resolution", "reason"], `${a} needs a reason`);
    if (a === "ask" && !f.resolution.askedOf)
      add(["resolution", "askedOf"], "ask needs who it was routed to");
  });
export type Finding = z.infer<typeof Finding>;

/** Where a finding's file lives inside the change folder. */
export function findingPath(f: Pick<Finding, "gate" | "round" | "id">): string {
  return `review/${f.gate}/${f.round}/${f.id}.yaml`;
}

/** True if text parses as a template (re-exported for org-pack tooling). */
export function isValidTemplate(t: string): boolean {
  try {
    parseTemplate(t);
    return true;
  } catch {
    return false;
  }
}
