import { z } from "zod";
import { IsoDateTime, RecordId } from "./common.js";
import { BasePath, HostPattern } from "./workspace.js";

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
/**
 * Version 3 (ADR 0153) adds two optional fields to an answer: `match`, the rule a target or host
 * answer covers (a host pattern or a path prefix, Q2), and `proposal`, the assistant's proposal a
 * person accepted as their answer (Q5). Version-1 and version-2 files read as before.
 */
/**
 * Version 4 (ADR 0162) adds `reopened`: a targets answer the code later disagreed with (the repo
 * it named was read, and no route of it serves the call), so the question is open again, with
 * why and the answer it had. Optional; version-1 to version-3 files read as before and come back
 * as version 4 in memory.
 */
export const QUESTION_SCHEMA_VERSION = 4 as const;

const QuestionSchemaVersion = z
  .union([z.literal(1), z.literal(2), z.literal(3), z.literal(QUESTION_SCHEMA_VERSION)])
  .overwrite((): 1 | 2 | 3 | 4 => QUESTION_SCHEMA_VERSION);

/** A question's id: q- and 12 hex characters of the fingerprint of what it asks about. */
export const QuestionId = z.string().regex(/^q-[0-9a-f]{12}$/, "a question id is q- and 12 hex");

/** Where the question comes from in the repo: path:line. */
// beta.18: a path may hold spaces (a spec file named with a date after a space), never a colon.
export const QuestionEvidence = z
  .string()
  .regex(/^[^\s:](?:[^:\n]*[^\s:])?:\d+$/, "evidence is path:line");

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

/**
 * The rule an answer covers (ADR 0153, Q2): a host pattern as a manifest takes it
 * (`*.payments.forge.internal`, `*` for any part of a label) or a path prefix
 * (`/forge/limits/**`, or `/forge/limits`: the path and everything under it). One answer then
 * covers every call that matches, found now or later, in each repo the answer's scope allows.
 */
export const AnswerMatch = z
  .string()
  .trim()
  .min(1)
  .refine(
    (m) =>
      m === "/**" ||
      (m.startsWith("/")
        ? BasePath.safeParse(m.replace(/\/\*\*$/, "")).success
        : HostPattern.safeParse(m).success),
    "a match is a host pattern (*.payments.forge.internal), a path prefix (/forge/limits/**), or /** for every path",
  );

/** Whether a match is a path prefix (else it is a host pattern). */
export const isPathMatch = (m: string): boolean => m.startsWith("/");

/** A line a proposal rests on (ADR 0144): the repo (the question's own when left out), file, line, quote. */
export const QuestionProposalCite = z.strictObject({
  /** The repo the file is in; the question's own when left out. */
  repo: z.string().trim().min(1).optional(),
  file: z.string().trim().min(1),
  line: z.number().int().min(1),
  /** The words on that line the proposal rests on. */
  quote: z.string().trim().min(1),
});

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
    /**
     * ADR 0153 (Q2): the rule the answer covers, for a target or hosts question: every call that
     * matches, in each repo the scope allows, reads this answer.
     */
    match: AnswerMatch.optional(),
    /**
     * ADR 0153 (Q5): the answer was the assistant's proposal, confirmed by the person in `by`:
     * which assistant proposed it, when, and the lines it cited (each checked when accepted).
     */
    proposal: z
      .strictObject({
        by: z.string().trim().min(1),
        at: IsoDateTime,
        cites: z.array(QuestionProposalCite).min(1),
      })
      .optional(),
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
     * Why an open question was retired, and the questions that ask it now (ADR 0117 addendum,
     * V0). Optional and additive: nothing reads a retired question's answer.
     */
    retired: z
      .strictObject({
        at: IsoDateTime,
        why: z.string().trim().min(1),
        replacedBy: z.array(QuestionId).optional(),
      })
      .optional(),
    /**
     * ADR 0162 (F8): the question was answered, and the code read since disagrees with the answer
     * (the repo it named has no route that serves the call), so it is open again: when, why, and
     * the answer it had. Kept when it is answered again, as the last time it reopened.
     */
    reopened: z
      .strictObject({
        at: IsoDateTime,
        why: z.string().trim().min(1),
        answer: QuestionAnswer,
      })
      .optional(),
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
     * ids or fields, before it follows the reading. `answered` (ADR 0117 addendum, 2026-10-24):
     * a person's answer on file already decides this question; the quote is the words of that
     * answer that decide it, and the question is not asked again.
     */
    sameAs: z
      .strictObject({
        id: QuestionId,
        verdict: z.enum(["same", "narrower", "answered"]),
        quote: z.string().trim().min(1),
      })
      .optional(),
  })
  .refine((d) => d.scope !== "repo-type" || d.repoType !== undefined, {
    path: ["repoType"],
    message: "a repo-type question names the repo type",
  });
export type QuestionDraft = z.infer<typeof QuestionDraft>;
