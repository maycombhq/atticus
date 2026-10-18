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
 * A contract file at version 1 (see the change-lifecycle ADR). Changing it needs an ADR and
 * a version bump with a migration, like every other contract.
 */
export const CHANGE_SCHEMA_VERSION = 1 as const;

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
  /** People asked to review: CODEOWNERS of the phase's files and holders of the required roles. */
  reviewers: z.array(Handle).default([]),
  /** Approvals that counted, as last read from the PR, with the role each one filled. */
  approvals: z
    .array(z.strictObject({ by: Handle, roles: z.array(RecordId).min(1), at: IsoDateTime }))
    .default([]),
  /** The files the PR carries, relative to the change folder, with their sha256 at hand-off. */
  artifacts: z
    .array(z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
    .default([]),
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
    schemaVersion: z.literal(CHANGE_SCHEMA_VERSION),
    id: RecordId,
    title: z.string().min(1).max(200),
    /** A change type id from change-types.yaml. */
    type: RecordId,
    /** The change template the brief started from. */
    template: RecordId.optional(),
    state: LifecycleState,
    /** People by role on this change, e.g. architect: [ari]. Approval rights come from here and CODEOWNERS. */
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
    /** Who wrote each artifact, for separation of duties. */
    authors: z.partialRecord(ChangeArtifact, z.array(Handle).min(1)).default({}),
    createdAt: IsoDateTime,
    createdBy: Handle,
    history: z.array(ChangeHistoryEntry).default([]),
    handoffs: z.array(ChangeHandoff).default([]),
  })
  .superRefine((c, ctx) => {
    const add = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
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
