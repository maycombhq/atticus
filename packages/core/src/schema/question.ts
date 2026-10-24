import { z } from "zod";
import { IsoDateTime, RecordId } from "./common.js";

/**
 * A question to a person (ADR 0078, C6): questions/<id>.yaml in the metarepo. People's and the
 * AI's words, not generated catalog. A step (atticus scan survey, first) raises one when the
 * code is ambiguous, with options and the file and line it read; a person answers it, the
 * answer is written to the same file, and the step's rerun reads it. An answered question is
 * not asked again.
 */

/**
 * Version 2 (ADR 0117) adds `related` (an earlier question this one may be the same as, or is
 * narrower than) and a draft's `sameAs`. Both are optional, so version-1 files are read as they
 * are and come back as version 2 in memory; writers write version 2.
 */
export const QUESTION_SCHEMA_VERSION = 2 as const;

const QuestionSchemaVersion = z
  .union([z.literal(1), z.literal(QUESTION_SCHEMA_VERSION)])
  .overwrite((): 1 | 2 => QUESTION_SCHEMA_VERSION);

/** A question's id: q- and 12 hex characters of the fingerprint of what it asks about. */
export const QuestionId = z.string().regex(/^q-[0-9a-f]{12}$/, "a question id is q- and 12 hex");

/** Where the question comes from in the repo: path:line. */
export const QuestionEvidence = z.string().regex(/^[^\s:]+:\d+$/, "evidence is path:line");

export const QuestionState = z.enum(["open", "answered", "retired"]);
export type QuestionState = z.infer<typeof QuestionState>;

/** Who an answer is for: this repo only, or every repo of a type. */
export const QuestionScopeLevel = z.enum(["repo", "repo-type"]);
export type QuestionScopeLevel = z.infer<typeof QuestionScopeLevel>;

export const QuestionScope = z.strictObject({
  level: QuestionScopeLevel,
  /** The repo id, or the repo type's id. */
  id: RecordId,
});

export const QuestionOption = z.strictObject({
  /** The option in a few words. */
  label: z.string().trim().min(1),
  /** What picking it means. */
  means: z.string().trim().min(1),
  /** What it would change in the result. */
  changes: z.string().trim().min(1),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

export const QuestionAnswer = z
  .strictObject({
    /** The option picked, counting from 1. */
    option: z.number().int().min(1).optional(),
    /** Or the person's own words. */
    text: z.string().trim().min(1).optional(),
    /** The Git user who answered. */
    by: z.string().min(1),
    at: IsoDateTime,
    /** The scope the person confirmed. */
    scope: QuestionScope,
    /** For a repo-type answer: the type's skill file the answer goes in, relative to the root. */
    skill: z.string().min(1).optional(),
  })
  .refine((a) => (a.option === undefined) !== (a.text === undefined), {
    message: "an answer is one option or the person's own words, not both or neither",
  });
export type QuestionAnswer = z.infer<typeof QuestionAnswer>;

export const Question = z
  .strictObject({
    schemaVersion: QuestionSchemaVersion,
    id: QuestionId,
    askedBy: z.strictObject({
      /** The step that asked, e.g. scan-survey. */
      step: RecordId,
      /** The command that asked, as typed. */
      command: z.string().min(1),
      /** The AI run it came from, when there was one. */
      run: z.string().min(1).optional(),
      at: IsoDateTime,
    }),
    /**
     * Other steps that would have asked the same thing (the same repo, the same evidence line
     * or near-identical words) and wait on this question instead (ADR 0089). Each reads the
     * answer; its rerun is the command to run once it is answered.
     */
    alsoAskedBy: z
      .array(
        z.strictObject({
          step: RecordId,
          command: z.string().min(1),
          run: z.string().min(1).optional(),
          at: IsoDateTime,
          rerun: z.string().min(1),
        }),
      )
      .optional(),
    /** The repo the question is about. */
    repo: RecordId,
    /** The question in plain words. */
    question: z.string().trim().min(1),
    options: z.array(QuestionOption).default([]),
    /** The files and lines the asker read; each one exists at the scanned commit. */
    evidence: z.array(QuestionEvidence).min(1),
    /** The scope the asker proposed. */
    scope: QuestionScope,
    state: QuestionState,
    /** The command to run once it is answered; it reads the answer. */
    rerun: z.string().min(1),
    answer: QuestionAnswer.optional(),
    /**
     * Earlier questions this one was matched against and not merged with (ADR 0117): narrower
     * (it asks part of what the earlier one asks, so the earlier answer is shown beside it) or
     * unsure (the judge couldn't tell, or no judge ran). The person sees both and decides.
     */
    related: z
      .array(
        z.strictObject({
          id: QuestionId,
          verdict: z.enum(["narrower", "unsure"]),
          /** The judgment's key under judgments/same-question/, when one was made. */
          judgment: z
            .string()
            .regex(/^[0-9a-f]{24}$/)
            .optional(),
        }),
      )
      .optional(),
  })
  .superRefine((q, ctx) => {
    if (q.state === "answered" && !q.answer)
      ctx.addIssue({
        code: "custom",
        path: ["answer"],
        message: "an answered question has an answer",
      });
    if (q.state === "open" && q.answer)
      ctx.addIssue({
        code: "custom",
        path: ["state"],
        message: "a question with an answer isn't open",
      });
    if (q.answer?.option !== undefined && q.answer.option > q.options.length)
      ctx.addIssue({
        code: "custom",
        path: ["answer", "option"],
        message: `option ${q.answer.option} isn't one of the ${q.options.length} options`,
      });
  });
export type Question = z.infer<typeof Question>;

/**
 * A question as an AI step raises it, inside its own YAML answer: Atticus adds the id, who
 * asked and the rerun command, and checks every evidence line exists before writing it.
 */
export const QuestionDraft = z
  .strictObject({
    question: z.string().trim().min(1),
    options: z.array(QuestionOption).default([]),
    evidence: z.array(QuestionEvidence).min(1),
    scope: QuestionScopeLevel.default("repo"),
    /** The repo type the answer would apply to, for scope repo-type. */
    repoType: RecordId.optional(),
    /**
     * The step's own reading (ADR 0117): this question is one already on file (same), or asks
     * part of one (narrower), with the words of the earlier question that say so. Atticus checks
     * the id is a question it listed, the words are in it, and that the two name no different
     * ids or fields, before it follows the reading.
     */
    sameAs: z
      .strictObject({
        id: QuestionId,
        verdict: z.enum(["same", "narrower"]),
        quote: z.string().trim().min(1),
      })
      .optional(),
  })
  .refine((d) => d.scope !== "repo-type" || d.repoType !== undefined, {
    path: ["repoType"],
    message: "a repo-type question names the repo type",
  });
export type QuestionDraft = z.infer<typeof QuestionDraft>;
