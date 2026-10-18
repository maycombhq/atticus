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
 * - `privacy`: the role that approves changes touching personal data, which catalog
 *   classifications count as personal, and the phase whose hand-off needs that approval.
 * - `risk`: weights for the deterministic risk score, the score at which a change becomes
 *   medium or high risk, and extra approvals per risk level and phase.
 * - `selfApproval`: where a person may approve a hand-off of artifacts they wrote. Never
 *   at release: that is a safety rule and the loader refuses it.
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
