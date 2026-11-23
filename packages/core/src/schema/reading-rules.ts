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

export const READING_RULES_SCHEMA_VERSION = 2 as const;

/**
 * ADR 0208: what Learn from my corrections writes on a rule it drafted: the corrections it was
 * drafted from (`<repo> <file>:<line>`, each a person's pairing), who ran it and when, and either
 * the proof (the files re-read with it and the corrections the re-read reproduced, with no arrow
 * a person touched changed), which makes the rule active, or why it stays a draft.
 */
export const LearnedFrom = z.strictObject({
  corrections: z.array(z.string().min(1).max(600)).min(1).max(500),
  by: z.string().min(1).max(300),
  at: z.iso.datetime({ offset: true }),
  /** The assistant's run (under .runs/) that drafted it. */
  run: z.string().min(1).optional(),
  proof: z
    .strictObject({
      /** `<repo> <file>`: every file re-read with the rule, and only those. */
      reread: z.array(z.string().min(1)).min(1).max(2000),
      /** The corrections the re-read reproduced by itself, as in `corrections`. */
      reproduced: z.array(z.string().min(1)).min(1).max(500),
    })
    .optional(),
  /** Why it stays a draft: a correction it didn't reproduce, or an arrow a person touched it moved. */
  why: z.string().trim().min(3).max(2000).optional(),
});
export type LearnedFrom = z.infer<typeof LearnedFrom>;

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
  /** ADR 0208 (schema version 2): what Learn from my corrections drafted it from, and its proof. */
  learned: LearnedFrom.optional(),
});
export type ReadingRule = z.infer<typeof ReadingRule>;

export const ReadingRulesOff = z.strictObject({
  /** A rule's key from an earlier layer, or `builtin:<set>` for a built-in rule set. */
  key: z.string().regex(/^(builtin:)?[a-z0-9][a-z0-9-]{0,62}$/),
  reason: z.string().trim().min(3).max(500),
});

export const ReadingRulesFile = z
  .strictObject({
    /** 1, or 2 (ADR 0208) for a file whose rules carry `learned`; a version 1 file reads as it did. */
    schemaVersion: z.union([z.literal(1), z.literal(READING_RULES_SCHEMA_VERSION)]),
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
      if (r.learned && f.schemaVersion < 2)
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "learned"],
          message: "learned needs schemaVersion: 2 (ADR 0208)",
        });
      // ADR 0208: a learned rule is active only with its proof.
      if (r.learned && r.status === "active" && !r.learned.proof)
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "learned"],
          message: "a learned rule is active only with its proof",
        });
    });
  });
export type ReadingRulesFile = z.infer<typeof ReadingRulesFile>;

/**
 * Reading rules 1 → 2 (ADR 0208): the number only, every other line as the person wrote it.
 * Version 2 adds `learned`; a file without it means the same at version 1, so only a file Learn
 * writes to is moved on.
 */
export function migrateReadingRulesText(text: string): { text: string; changed: boolean } {
  const line = /^schemaVersion:[ \t]*1[ \t]*(#.*)?$/m;
  if (!line.test(text)) return { text, changed: false };
  return {
    text: text.replace(line, (_m, c?: string) => `schemaVersion: 2${c ? ` ${c}` : ""}`),
    changed: true,
  };
}
