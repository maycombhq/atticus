import { z } from "zod";
import { IsoDateTime, RecordId } from "./common.js";
import { QuestionDraft, QuestionId } from "./question.js";
import { ScanSettings } from "./scan-settings.js";

/**
 * The AI verify step of a scan (ADR 0082): the assistant reads the repo, compares it with what
 * the last scan recorded, and lists what the scan missed, what it has wrong and what it
 * confirms. Every item cites the file and line it read, and each carries a fix: scan settings
 * when they can express it, a question for a person when the code can't settle it, or a change
 * to a reader. The answer is checked against the code; what passes is kept in a proposal,
 * proposals/scan/<repo>.yaml, that a person accepts.
 */

export const SCAN_VERIFY_SCHEMA_VERSION = 1 as const;

/** What kind of fact an item is about, in the words of the bench (ADR 0074). */
export const VerifyFactKind = z.enum(["entry-point", "call", "table", "deployment", "other"]);
export type VerifyFactKind = z.infer<typeof VerifyFactKind>;

/** Where the assistant read it: path:line. */
const At = z.string().regex(/^[^\s:]+:\d+$/, "at must be path:line");

/** Scan settings entries (ADR 0075, 0076), without the file's header. */
export const VerifySettings = ScanSettings.pick({ exclude: true, prefixes: true, clients: true });
export type VerifySettings = z.infer<typeof VerifySettings>;

/** How to put an item right: exactly one of settings, a question, or a reader change. */
export const VerifyFix = z.union([
  z.strictObject({ settings: VerifySettings }),
  z.strictObject({ question: QuestionDraft }),
  /** What a built-in reader or a scanner plugin must read differently, in plain words. */
  z.strictObject({ reader: z.string().trim().min(1) }),
]);
export type VerifyFix = z.infer<typeof VerifyFix>;

const Cited = {
  /** The file and line the assistant read. */
  at: At,
  /** Text exactly as written on that line; the citation check looks for it there. */
  says: z.string().min(1),
  why: z.string().trim().min(1),
  fix: VerifyFix,
};

/** Something in the code the scan didn't record. */
export const VerifyMissed = z.strictObject({
  kind: VerifyFactKind,
  /** The HTTP method, for an entry point or a call. */
  method: z
    .string()
    .regex(/^[A-Z]+$/, "an HTTP method in capitals")
    .optional(),
  /** What the scan should have recorded: the full path or topic, the table, the platform. */
  name: z.string().trim().min(1),
  ...Cited,
});
export type VerifyMissed = z.infer<typeof VerifyMissed>;

/** A record the scan has that the code doesn't support. */
export const VerifyWrong = z.strictObject({
  /** The catalog record's id. */
  record: RecordId,
  ...Cited,
});
export type VerifyWrong = z.infer<typeof VerifyWrong>;

/** The assistant's answer, as it writes it. */
export const VerifyAnswer = z.strictObject({
  missed: z.array(VerifyMissed).default([]),
  wrong: z.array(VerifyWrong).default([]),
  /** Records the assistant read in the code and agrees with. */
  confirmed: z.array(RecordId).default([]),
});
export type VerifyAnswer = z.infer<typeof VerifyAnswer>;

/** A record the assistant confirmed, pinned to the line its evidence cites. */
export const VerifiedRecord = z.strictObject({
  record: RecordId,
  /** The record's first evidence: path, or path:line. */
  at: z.string().min(1),
  /** The first 12 hex of the SHA-256 of that line's text (trimmed), when there is a line. */
  line: z
    .string()
    .regex(/^[0-9a-f]{12}$/)
    .optional(),
});
export type VerifiedRecord = z.infer<typeof VerifiedRecord>;

/** proposals/scan/<repo>.yaml: what a verify run found and proposes, for a person to accept. */
export const ScanVerifyProposal = z.strictObject({
  schemaVersion: z.literal(SCAN_VERIFY_SCHEMA_VERSION),
  repo: RecordId,
  /** The AI run of the latest verify. */
  run: z.string().min(1).optional(),
  at: IsoDateTime,
  /** Settings entries to merge into org-pack/scan/<repo>.yaml on accept, from every run. */
  settings: VerifySettings,
  /** The latest run's items, each checked against the code. */
  missed: z.array(VerifyMissed).default([]),
  wrong: z
    .array(
      VerifyWrong.extend({
        /** The record as the scan had it, for scoring: its kind, method and name. */
        kind: VerifyFactKind,
        method: z.string().optional(),
        name: z.string().min(1),
      }),
    )
    .default([]),
  /** Records the assistant agreed with; a later scan raises their confidence (ADR 0082). */
  verified: z.array(VerifiedRecord).default([]),
  /** Questions the run raised or found still open, in questions/. */
  questions: z.array(QuestionId).default([]),
  /** When a person last accepted the settings, and how many entries went in. */
  accepted: z
    .strictObject({ at: IsoDateTime, by: z.string().min(1), entries: z.number().int() })
    .optional(),
});
export type ScanVerifyProposal = z.infer<typeof ScanVerifyProposal>;
