// A frozen copy of beta.28.5's profile.yaml schema (packages/core/src/schema/orgpack.ts at f60e805f),
// to test what an older Atticus does with a version-3 profile (ADR 0204, Migration). Not edited.
/* eslint-disable */
import { z } from "zod";
import { RecordId } from "../../src/schema/common.js";
export const ORGPACK_SCHEMA_VERSION = 1 as const;
const V = z.literal(ORGPACK_SCHEMA_VERSION);
const Ids = z.array(RecordId);

function unique<T>(items: T[], key: (t: T) => string, ctx: z.RefinementCtx, path: string) {
  const seen = new Set<string>();
  items.forEach((t, i) => {
    const k = key(t);
    if (seen.has(k)) ctx.addIssue({ code: "custom", path: [path, i], message: `duplicate ${k}` });
    seen.add(k);
  });
}

export const DeclaredCall = z
  .strictObject({
    /** What identifies the caller at the gateway, as the route's files would name it. */
    as: z.enum(["app", "product", "client-id", "subject"]).optional(),
    name: z.string().min(1).optional(),
    /** The route: its handler (`proxy/flow`) or `METHOD /path` as the gateway serves it. */
    route: z.string().min(1).optional(),
  })
  .refine((c) => (c.as === undefined) === (c.name === undefined), {
    message: "a caller's identity is `as` and `name` together",
  })
  .refine((c) => c.name !== undefined || c.route !== undefined, {
    message: "a declared call names the identity the gateway knows the caller by, or the route",
  });
export type DeclaredCall = z.infer<typeof DeclaredCall>;

/**
 * profile.yaml's version. 2 (ADR 0162 amendment, review item 15) adds a system's `topics`. A
 * version-1 profile reads as it is and stays valid, so `atticus upgrade` moves nothing; a profile
 * that names topics is at 2 (`migrateProfileText`, the number only), as `addProfileSystem` writes
 * it when an answer puts a topic there.
 */
export const PROFILE_SCHEMA_VERSION = 2 as const;

export const Profile = z
  .strictObject({
    schemaVersion: z.union([V, z.literal(PROFILE_SCHEMA_VERSION)]),
    platform: RecordId,
    name: z.string().min(1),
    systems: z
      .array(
        z.strictObject({
          id: RecordId,
          name: z.string().min(1),
          boundary: z.enum(["product", "internal", "vendor"]),
          owner: z.string().optional(),
          /** Other names people and diagrams use for this system. */
          aliases: z.array(z.string().min(1)).default([]),
          /**
           * ADR 0162 amendment (version 2): the topics and queues this system owns, as the code
           * names them (`harbor.audit.events`). A publish to one, or a listener on one, that no
           * repo of the estate serves the other side of lands on this system, marked declared.
           * Kept apart from `aliases`: a topic is never a host or a name the system is known by.
           */
          topics: z.array(z.string().min(1)).optional(),
          /** Free labels copied to the System record; `saas` marks a SaaS vendor (ADR 0040). */
          tags: z.array(z.string().min(1)).default([]),
          /**
           * The gateway routes this system calls, for a system whose repo is never scanned (ADR
           * 0124 addendum A-callers): a person's word, marked as such wherever it shows and never
           * over a fact from code. Each names the consumer identity a route's own files name
           * (`as` and `name`: the developer app, API product, client id or certificate subject),
           * the route itself (`route`: its handler `proxy/flow`, or `METHOD /path` as the gateway
           * serves it), or both. Additive and optional.
           */
          calls: z.array(DeclaredCall).optional(),
        }),
      )
      .default([]),
    environments: Ids.default(["dev", "test", "prod"]),
    /** How diagram markers map to catalog status. */
    legend: z
      .strictObject({
        new: z.array(z.string().min(1)).default(["New"]),
        modify: z.array(z.string().min(1)).default(["Modify"]),
        retire: z.array(z.string().min(1)).default(["Retire"]),
      })
      .default({ new: ["New"], modify: ["Modify"], retire: ["Retire"] }),
    /** Gate ids from gates.yaml that are mandatory on this platform. */
    gates: Ids.default([]),
  })
  .superRefine((p, ctx) => {
    unique(p.systems, (s) => s.id, ctx, "systems");
    const owned = new Map<string, string>();
    p.systems.forEach((s, i) => {
      if (s.topics?.length && p.schemaVersion < PROFILE_SCHEMA_VERSION)
        ctx.addIssue({
          code: "custom",
          path: ["systems", i, "topics"],
          message:
            "topics needs schemaVersion 2 (ADR 0162): set schemaVersion: 2, nothing else changes",
        });
      for (const t of s.topics ?? []) {
        const other = owned.get(t);
        if (other && other !== s.id)
          ctx.addIssue({
            code: "custom",
            path: ["systems", i, "topics"],
            message: `"${t}" is already owned by ${other}`,
          });
        owned.set(t, s.id);
      }
    });
    const alias = new Map<string, string>();
    p.systems.forEach((s, i) => {
      for (const a of [s.name, ...s.aliases]) {
        const k = a.toLowerCase();
        const other = alias.get(k);
        if (other && other !== s.id) {
          ctx.addIssue({
            code: "custom",
            path: ["systems", i, "aliases"],
            message: `"${a}" already names ${other}`,
          });
        }
        alias.set(k, s.id);
      }
    });
  });
export type Profile = z.infer<typeof Profile>;
