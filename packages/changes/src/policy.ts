import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ChangeArtifact, Phase, RecordId } from "@maycombhq/core";

/**
 * The change policy: how Atticus turns the org pack into lifecycle rules where C6 has no
 * field for it yet. It lives at `org-pack/process/change-policy.yaml`; every section is
 * optional and a section a team writes replaces the built-in one, field by field.
 *
 * - `artifactPhases`: the phase in which each artifact is written and handed off.
 * - `privacy`: which catalog classifications count as personal, and the phase whose hand-off
 *   PR says so.
 * - `risk`: weights for the deterministic risk score and the score at which a change becomes
 *   medium or high risk.
 * - `stages`: the stage path (ADR 0087): each stage, the phase it serves, the loop state it
 *   keeps, the command that runs it, the files it writes and the type's artifacts it writes. A
 *   change whose folder holds any stage's loop state is on the stage path: each phase is due
 *   what its stage writes and its stage's loop done, not the change-draft artifacts.
 *
 * Deprecated (ADR 0073), still validated and not read: `privacy.role`, `risk.approvals` and
 * `selfApproval`. A gate is approved when its hand-off PR merges; the Git host decides who may
 * approve, and the person who raised a PR is never its only approver.
 */
export const CHANGE_POLICY_FILE = "process/change-policy.yaml";

const Ids = z.array(RecordId);

const DEFAULT_ARTIFACT_PHASES = {
  brief: "define",
  proposal: "define",
  specs: "define",
  interfaces: "design",
  mappings: "design",
  data: "design",
  design: "design",
  ux: "design",
  stories: "plan",
  tasks: "plan",
  snow: "plan",
} as const satisfies Record<z.infer<typeof ChangeArtifact>, z.infer<typeof Phase>>;

/** One stage of the stage path (ADR 0087). */
export const StageStep = z.strictObject({
  stage: RecordId,
  phase: Phase,
  /** The stage's loop state, relative to the change folder (ADR 0087, `stage/<stage>.yaml`). */
  loop: z.string().min(1),
  /** The command that runs it; `<change>` stands for the change's id. */
  command: z.string().min(1),
  /** Files it writes, relative to the change folder; a folder ends in "/". They ride with the hand-off. */
  writes: z.array(z.string().min(1)).default([]),
  /** The change type's artifacts of the phase that this stage writes: on the stage path, only these are due. */
  artifacts: z.array(ChangeArtifact).default([]),
});
export type StageStep = z.infer<typeof StageStep>;

const DEFAULT_STAGES: StageStep[] = [
  {
    stage: "feature",
    phase: "define",
    loop: "stage/feature.yaml",
    command: "atticus change feature <change>",
    writes: ["feature.yaml", "feature.md", "design/"],
    artifacts: [],
  },
  {
    stage: "architecture",
    phase: "design",
    loop: "stage/architecture.yaml",
    command: "atticus change architecture <change>",
    writes: ["target-flows/"],
    artifacts: ["design", "data"],
  },
  {
    stage: "stories",
    phase: "plan",
    loop: "stage/stories.yaml",
    command: "atticus plan stories <change>",
    writes: ["requests.md", "stage/stories-answer.yaml"],
    artifacts: ["stories", "tasks"],
  },
];

const Privacy = z.strictObject({
  role: RecordId.default("privacy-officer"),
  classifications: z
    .array(z.string().min(1))
    .default(["personal", "pii", "sensitive-personal", "special-category"]),
  /** The first of these phases the change type has; a type with none uses its last phase. */
  phases: z.array(Phase).min(1).default(["design"]),
});

const Risk = z.strictObject({
  typeWeights: z
    .record(RecordId, z.number().int().min(0))
    .default({ "emergency-fix": 3, feature: 2, integration: 2 }),
  defaultTypeWeight: z.number().int().min(0).default(1),
  weights: z
    .strictObject({
      /** Per system touched beyond the first. */
      extraSystem: z.number().int().min(0).default(1),
      dataStore: z.number().int().min(0).default(2),
      /** Once, when any touched system is a vendor. */
      vendor: z.number().int().min(0).default(3),
      interfaceModify: z.number().int().min(0).default(1),
      interfaceRetire: z.number().int().min(0).default(2),
    })
    .default({ extraSystem: 1, dataStore: 2, vendor: 3, interfaceModify: 1, interfaceRetire: 2 }),
  /** Lowest score of each level; below medium is low. */
  levels: z
    .strictObject({
      medium: z.number().int().min(1).default(4),
      high: z.number().int().min(1).default(7),
    })
    .refine((l) => l.high > l.medium, "high must be above medium")
    .default({ medium: 4, high: 7 }),
  /** Extra approver roles by risk level and phase. */
  approvals: z
    .partialRecord(z.enum(["low", "medium", "high"]), z.partialRecord(Phase, Ids.min(1)))
    .default({ high: { release: ["architect"] } }),
});

const SelfApproval = z
  .strictObject({
    /** Change types this applies to; empty means all. */
    types: Ids.default([]),
    phases: z.array(Phase).min(1),
    roles: Ids.min(1),
  })
  .superRefine((s, ctx) => {
    if (s.phases.includes("release"))
      ctx.addIssue({
        code: "custom",
        path: ["phases"],
        message: "nobody may approve their own change at release",
      });
  });

export const ChangePolicy = z.strictObject({
  schemaVersion: z.literal(1),
  artifactPhases: z
    .partialRecord(ChangeArtifact, Phase)
    .default({})
    .transform((p) => ({ ...DEFAULT_ARTIFACT_PHASES, ...p })),
  privacy: Privacy.default({
    role: "privacy-officer",
    classifications: ["personal", "pii", "sensitive-personal", "special-category"],
    phases: ["design"],
  }),
  risk: Risk.default(() => Risk.parse({})),
  /** The stage path (ADR 0087); a team's list replaces the built-in one. */
  stages: z
    .array(StageStep)
    .default(() => DEFAULT_STAGES.map((x) => ({ ...x })))
    .refine((xs) => new Set(xs.map((x) => x.phase)).size === xs.length, "one stage per phase"),
  /**
   * At most this many questions go to a person when a stage stops (ADR 0117 addendum, U3); the
   * rest wait and are asked once those are answered. Optional and additive (still version 1).
   */
  questionsPerStop: z.number().int().min(1).default(5),
  /** By default the product owner may approve the Define hand-off of their own brief. */
  selfApproval: z
    .array(SelfApproval)
    .default([{ types: [], phases: ["define"], roles: ["product-owner"] }]),
});
export type ChangePolicy = z.infer<typeof ChangePolicy>;

export const DEFAULT_CHANGE_POLICY: ChangePolicy = ChangePolicy.parse({ schemaVersion: 1 });

/**
 * Read the org pack's change policy. Never throws for content: problems come back with the
 * file, and a broken file falls back to the built-in policy as a whole, so a typo can't
 * quietly loosen a rule.
 */
export async function loadChangePolicy(
  orgPackDir: string,
): Promise<{ policy: ChangePolicy; problems: { file: string; message: string }[] }> {
  let text: string;
  try {
    text = await readFile(join(orgPackDir, CHANGE_POLICY_FILE), "utf8");
  } catch {
    return { policy: DEFAULT_CHANGE_POLICY, problems: [] };
  }
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    return {
      policy: DEFAULT_CHANGE_POLICY,
      problems: [{ file: CHANGE_POLICY_FILE, message: `can't read YAML: ${(e as Error).message}` }],
    };
  }
  const r = ChangePolicy.safeParse(data);
  if (r.success) return { policy: r.data, problems: [] };
  return {
    policy: DEFAULT_CHANGE_POLICY,
    problems: r.error.issues.map((i) => ({
      file: CHANGE_POLICY_FILE,
      message: `${i.path.map(String).join(".") || "(file)"}: ${i.message}`,
    })),
  };
}

/** The stage path of a change policy: its stages in phase order (ADR 0087). */
export function stagePathOf(policy: ChangePolicy): StageStep[] {
  return policy.stages;
}
