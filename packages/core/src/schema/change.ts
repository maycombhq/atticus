import { z } from "zod";
import { IsoDateTime, RecordId } from "./common.js";
import { ChangeArtifact, Phase } from "./orgpack.js";

/**
 * A change's state file: `openspec/changes/<change-id>/change.yaml` in the metarepo.
 *
 * OpenSpec knows a change's artifacts but not who owns it, which phase it is in, which
 * hand-off PRs it went through or who approved them, so Atticus keeps that here, beside
 * the artifacts, archived with the change. The file is canonical YAML written by
 * `@maycombhq/changes`; people read it but change it only through Atticus, because every
 * transition is checked (artifacts, blocking findings, approvals) and recorded in `history`.
 *
 * A contract file (see the change-lifecycle ADR). Changing it needs an ADR and a version bump
 * with a migration, like every other contract. Version 2 (ADR 0210 part 7) adds the open items a
 * hand-off showed and a transition went ahead with; a version 1 file reads as it is (the migration
 * is the number only), and a file is written at 2 only once it carries one, so a change without
 * any stays at 1 and an older Atticus keeps reading it.
 */
export const CHANGE_SCHEMA_VERSION = 2 as const;

/** The version a change's file is written at: 2 once it carries open items, else as it was. */
export function changeSchemaVersionFor(c: {
  schemaVersion: 1 | 2;
  history: readonly { openItems?: unknown }[];
  handoffs: readonly { openItems?: unknown }[];
}): 1 | 2 {
  const v2 =
    c.history.some((h) => h.openItems !== undefined) ||
    c.handoffs.some((h) => h.openItems !== undefined);
  return v2 ? 2 : c.schemaVersion;
}

/**
 * Where a change is. The phase states share their phase's name, except release, whose
 * state is `release-ready` (waiting for go/no-go). `returned` means the product owner has
 * it back; `post-release-review` is for types that release first (emergency fixes) and
 * run the skipped lenses afterwards.
 */
export const LIFECYCLE_STATES = [
  "draft",
  "define",
  "design",
  "plan",
  "build",
  "qa",
  "release-ready",
  "released",
  "post-release-review",
  "returned",
  "archived",
] as const;
export const LifecycleState = z.enum(LIFECYCLE_STATES);
export type LifecycleState = z.infer<typeof LifecycleState>;

/** A person's handle on the Git host or directory, with or without a leading "@". */
const Handle = z
  .string()
  .min(1)
  .max(100)
  .regex(/^@?[A-Za-z0-9][A-Za-z0-9._/-]*$/, "a handle such as pat or @forge/architects");

export const ChangeHistoryEntry = z.strictObject({
  from: LifecycleState,
  to: LifecycleState,
  at: IsoDateTime,
  by: Handle,
  /** The hand-off PR whose merge or closing made this transition. */
  pr: z.number().int().positive().optional(),
  reason: z.string().min(1).optional(),
  /**
   * ADR 0210 part 7 (optional, additive): the open items the transition went ahead with (a
   * hand-off's merge, an archive), each as its words, so they outlive the PR.
   */
  openItems: z.array(z.string().min(1)).optional(),
});
export type ChangeHistoryEntry = z.infer<typeof ChangeHistoryEntry>;

export const HandoffState = z.enum(["open", "changes-requested", "merged", "closed"]);

export const ChangeHandoff = z.strictObject({
  phase: Phase,
  /** Always handoff/<change-id>/<phase>; recorded so a renamed convention stays readable. */
  branch: z.string().min(1),
  pr: z.strictObject({ number: z.number().int().positive(), url: z.url() }),
  state: HandoffState,
  /** Who raised the hand-off. */
  by: Handle,
  openedAt: IsoDateTime,
  updatedAt: IsoDateTime.optional(),
  /** People asked to review: CODEOWNERS of the phase's files. */
  reviewers: z.array(Handle).default([]),
  /**
   * Approving reviews on the PR, as last read from the Git host. `roles` is deprecated (ADR
   * 0073): approvals no longer fill roles, so new entries leave it out; older files keep theirs.
   */
  approvals: z
    .array(z.strictObject({ by: Handle, roles: z.array(RecordId).optional(), at: IsoDateTime }))
    .default([]),
  /** The files the PR carries, relative to the change folder, with their sha256 at hand-off. */
  artifacts: z
    .array(z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
    .default([]),
  /**
   * ADR 0210 part 7 (optional, additive): the open items the PR last showed (its body, or the
   * comment Atticus posted), and how many reviews it had then: only an approval after them
   * approves the hand-off with them.
   */
  openItems: z
    .strictObject({
      items: z.array(z.string().min(1)),
      afterReview: z.number().int().min(0),
    })
    .optional(),
});
export type ChangeHandoff = z.infer<typeof ChangeHandoff>;

/** Catalog records and repos the change declares it touches, beyond what its artifacts say. */
export const ChangeTouches = z.strictObject({
  interfaces: z
    .array(
      z.strictObject({
        id: RecordId,
        status: z.enum(["planned-new", "planned-modify", "planned-retire"]),
      }),
    )
    .default([]),
  dataStores: z.array(RecordId).default([]),
  tables: z.array(RecordId).default([]),
  /** Any other catalog record ids (columns, endpoints, settings). */
  records: z.array(RecordId).default([]),
  repos: z.array(RecordId).default([]),
});
export type ChangeTouches = z.infer<typeof ChangeTouches>;

export const ChangeLifecycle = z
  .strictObject({
    schemaVersion: z.union([z.literal(1), z.literal(CHANGE_SCHEMA_VERSION)]),
    id: RecordId,
    title: z.string().min(1).max(200),
    /** A change type id from change-types.yaml. */
    type: RecordId,
    /** The change template the brief started from. */
    template: RecordId.optional(),
    state: LifecycleState,
    /** Who is on this change, by what they do, e.g. architect: [ari]. Words, not permissions (ADR 0073). */
    owners: z.record(RecordId, z.array(Handle).min(1)).default({}),
    /** Catalog System ids the change touches. */
    systems: z.array(RecordId).default([]),
    touches: ChangeTouches.default({
      interfaces: [],
      dataStores: [],
      tables: [],
      records: [],
      repos: [],
    }),
    /** Who wrote each artifact. */
    authors: z.partialRecord(ChangeArtifact, z.array(Handle).min(1)).default({}),
    createdAt: IsoDateTime,
    createdBy: Handle,
    history: z.array(ChangeHistoryEntry).default([]),
    handoffs: z.array(ChangeHandoff).default([]),
  })
  .superRefine((c, ctx) => {
    const add = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    // ADR 0210 part 7: open items are version 2's.
    if (c.schemaVersion < 2) {
      c.history.forEach((h, i) => {
        if (h.openItems !== undefined)
          add(["history", i, "openItems"], "openItems needs schemaVersion 2 (ADR 0210)");
      });
      c.handoffs.forEach((h, i) => {
        if (h.openItems !== undefined)
          add(["handoffs", i, "openItems"], "openItems needs schemaVersion 2 (ADR 0210)");
      });
    }
    let at: LifecycleState = "draft";
    c.history.forEach((h, i) => {
      if (h.from !== at) add(["history", i, "from"], `history goes from ${at}, not ${h.from}`);
      at = h.to;
    });
    if (at !== c.state) add(["state"], `history ends at ${at} but state is ${c.state}`);
    let live = 0;
    c.handoffs.forEach((h, i) => {
      const want = `handoff/${c.id}/${h.phase}`;
      if (h.branch !== want) add(["handoffs", i, "branch"], `the branch is ${want}`);
      if (h.state === "open" || h.state === "changes-requested") live++;
    });
    if (live > 1) add(["handoffs"], "only one hand-off can be open at a time");
  });
export type ChangeLifecycle = z.infer<typeof ChangeLifecycle>;
export type ChangeLifecycleInput = z.input<typeof ChangeLifecycle>;
