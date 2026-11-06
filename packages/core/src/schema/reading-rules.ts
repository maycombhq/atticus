import { z } from "zod";

/**
 * G4 (ADR 0176): reading rules the organisation owns, in the org pack, in layers: `org.yaml` for
 * every repo, `types/<type>.yaml` for every repo of a type, `repos/<repo>.yaml` for one repo, and
 * `imported/<team>/<type>.yaml`, a pinned copy of another product team's type rules. Each rule
 * adds to what Atticus's built-in rules tell a reader; a later layer may switch an earlier one off
 * for its scope (a built-in rule set by `builtin:<set>`), saying why. A person or Copilot writes
 * them; every change is reviewed like code. They never change the facts file's format or the
 * verifier: every fact still cites its line.
 */

export const READING_RULES_SCHEMA_VERSION = 1 as const;

export const ReadingRule = z.strictObject({
  /** Names the rule in its layer and the ones after it: a change re-reads only what it matches. */
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  /** draft: proposed (by Copilot or a person), not given to readers until a person sets it active. */
  status: z.enum(["active", "draft"]).default("active"),
  /** The rule, in words a person and Copilot both read. */
  rule: z.string().trim().min(10).max(2000),
  /** The files it is about, as globs in the repo (`src/main/java/**\/*Client.java`); none: every file a read reads. */
  files: z.array(z.string().min(1)).optional(),
  /** A cited line the rule is about (`path:line`), so a reviewer can check it. */
  example: z
    .string()
    .regex(/^[^\s:](?:[^:\n]*[^\s:])?:\d+$/)
    .optional(),
  /** Where it came from: a person, or drafted by Copilot and kept by a person. */
  by: z.string().min(1).max(300).optional(),
});
export type ReadingRule = z.infer<typeof ReadingRule>;

export const ReadingRulesOff = z.strictObject({
  /** A rule's key from an earlier layer, or `builtin:<set>` for a built-in rule set. */
  key: z.string().regex(/^(builtin:)?[a-z0-9][a-z0-9-]{0,62}$/),
  reason: z.string().trim().min(3).max(500),
});

export const ReadingRulesFile = z
  .strictObject({
    schemaVersion: z.literal(READING_RULES_SCHEMA_VERSION),
    /** For an imported copy: where it came from and at which version. */
    source: z
      .strictObject({ from: z.string().min(1), at: z.string().min(1), team: z.string().min(1) })
      .optional(),
    rules: z.array(ReadingRule).default([]),
    off: z.array(ReadingRulesOff).default([]),
  })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    f.rules.forEach((r, i) => {
      if (seen.has(r.key))
        ctx.addIssue({ code: "custom", path: ["rules", i, "key"], message: `${r.key} is twice` });
      seen.add(r.key);
    });
  });
export type ReadingRulesFile = z.infer<typeof ReadingRulesFile>;
