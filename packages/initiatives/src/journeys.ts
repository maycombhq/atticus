import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { Initiative, orgPackDirOf, RecordId } from "@maycombhq/core";

/**
 * Guided journeys: the six kinds of initiative the plan names (new feature, new integration,
 * vendor API change, design change, migration, retiring a system), each a template of phases
 * and steps. A step is a change milestone (the change's design approved, built, released), a
 * commitment another party makes (a vendor's spec, a team's confirmation), a service-desk
 * request (a firewall rule, a gateway proxy) or an internal task. Lead times come from the
 * parties (`Party.typicalLeadTimes`), past requests and request templates (see leadtimes.ts),
 * with the step's `days` as the last resort.
 *
 * The built-in templates are data. An organisation replaces one by putting a file with the
 * same id at `org-pack/process/journeys/<id>.yaml` (rule 7: extension over edits). C6 has no
 * schema for these yet; this module's `JourneyTemplate` is the candidate.
 */

export const JOURNEYS = Initiative.shape.journey.options;
export type JourneyId = (typeof JOURNEYS)[number];

/** Who a step's commitment is with. */
export const PartyRole = z.union([
  z.enum([
    /** The vendor party whose systems include the target. */
    "vendor",
    /** The party whose systems include the target (vendor or internal). */
    "target-owner",
    /** The party of each system that calls the target (one item per caller). */
    "caller-owners",
    /** The party of each system the target calls. */
    "callee-owners",
    /** The platform team's party. */
    "platform",
    /** For a request: the party that approves the request type (template `approvers`). */
    "approver",
  ]),
  z.string().regex(/^party:[a-z0-9][a-z0-9._-]*$/, "a role or party:<id>"),
]);
export type PartyRole = z.infer<typeof PartyRole>;

export const JourneyStep = z.strictObject({
  id: RecordId,
  /** What has to happen; {initiative}, {target}, {targetName}, {system} and {systemName} are filled in. */
  what: z.string().min(1),
  kind: z.enum(["change", "commitment", "request", "task"]),
  /** For commitments and requests: who it is with. */
  party: PartyRole.optional(),
  /** Key in the party's typicalLeadTimes (commitments; requests use the template id). */
  leadTimeKey: z.string().min(1).optional(),
  /** For requests: the service-desk request template (org-pack/process/snow/<id>.yaml). */
  template: RecordId.optional(),
  /** One item, or one per caller, callee, the target, or the systems named for the initiative. */
  per: z.enum(["once", "callers", "callees", "target", "systems"]).default("once"),
  /** For change steps: the state the change must reach. */
  milestone: z.enum(["design", "build", "release-ready", "released"]).optional(),
  /** For change steps: the change type the change is created with. */
  changeType: RecordId.default("feature"),
  /** For tasks: the role that does it. */
  owner: RecordId.optional(),
  /** Working days the step takes when nothing better is known. */
  days: z.number().int().min(0).default(5),
  /** Steps that must finish first. */
  after: z.array(RecordId).default([]),
});
export type JourneyStep = z.infer<typeof JourneyStep>;

export const JourneyTemplate = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: Initiative.shape.journey,
    name: z.string().min(1),
    /** The outcome an initiative of this kind is for, in one sentence. */
    outcome: z.string().min(1),
    phases: z
      .array(
        z.strictObject({
          id: RecordId,
          name: z.string().min(1),
          steps: z.array(JourneyStep).min(1),
        }),
      )
      .min(1),
  })
  .superRefine((t, ctx) => {
    const steps = t.phases.flatMap((p) => p.steps);
    const ids = new Set<string>();
    for (const s of steps) {
      if (ids.has(s.id))
        ctx.addIssue({ code: "custom", path: ["phases"], message: `step ${s.id} appears twice` });
      ids.add(s.id);
      if (s.kind === "change" && !s.milestone)
        ctx.addIssue({
          code: "custom",
          path: ["phases"],
          message: `change step ${s.id} needs a milestone`,
        });
      if (s.kind === "request" && !s.template)
        ctx.addIssue({
          code: "custom",
          path: ["phases"],
          message: `request step ${s.id} needs a template`,
        });
      if ((s.kind === "commitment" || s.kind === "request") && !s.party)
        ctx.addIssue({ code: "custom", path: ["phases"], message: `step ${s.id} needs a party` });
    }
    for (const s of steps)
      for (const a of s.after)
        if (!ids.has(a))
          ctx.addIssue({
            code: "custom",
            path: ["phases"],
            message: `step ${s.id} comes after ${a}, which doesn't exist`,
          });
    // no cycles
    const state = new Map<string, number>();
    const byId = new Map(steps.map((s) => [s.id, s]));
    const visit = (id: string): boolean => {
      if (state.get(id) === 1) return false;
      if (state.get(id) === 2) return true;
      state.set(id, 1);
      for (const a of byId.get(id)?.after ?? []) if (!visit(a)) return false;
      state.set(id, 2);
      return true;
    };
    for (const s of steps)
      if (!visit(s.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["phases"],
          message: `the steps go round in a circle at ${s.id}`,
        });
        break;
      }
  });
export type JourneyTemplate = z.infer<typeof JourneyTemplate>;

type Input = z.input<typeof JourneyTemplate>;

const BUILT_IN: Input[] = [
  {
    schemaVersion: 1,
    id: "new-feature",
    name: "New feature",
    outcome:
      "Ship a new capability in one system, with the other teams it depends on lined up in time.",
    phases: [
      {
        id: "define",
        name: "Define",
        steps: [
          {
            id: "brief",
            what: "Write and agree the brief for {targetName}",
            kind: "task",
            owner: "product-owner",
            days: 5,
          },
          {
            id: "interfaces-confirmed",
            what: "{systemName} confirms the interfaces {targetName} will use",
            kind: "commitment",
            party: "callee-owners",
            per: "callees",
            leadTimeKey: "system-card",
            days: 5,
            after: ["brief"],
          },
        ],
      },
      {
        id: "design",
        name: "Design",
        steps: [
          {
            id: "design",
            what: "Design approved for {targetName}",
            kind: "change",
            per: "target",
            milestone: "design",
            days: 5,
            after: ["brief"],
          },
        ],
      },
      {
        id: "build",
        name: "Build",
        steps: [
          {
            id: "build",
            what: "{targetName} built and tested",
            kind: "change",
            per: "target",
            milestone: "build",
            days: 10,
            after: ["design", "interfaces-confirmed"],
          },
        ],
      },
      {
        id: "release",
        name: "Release",
        steps: [
          { id: "qa", what: "QA sign-off", kind: "task", owner: "qa", days: 5, after: ["build"] },
          {
            id: "release",
            what: "Go/no-go and release",
            kind: "task",
            owner: "delivery-lead",
            days: 2,
            after: ["qa"],
          },
        ],
      },
    ],
  },
  {
    schemaVersion: 1,
    id: "new-integration",
    name: "New integration",
    outcome:
      "Connect the named systems to a new partner or internal system, with access, network and gateway ready in time.",
    phases: [
      {
        id: "discover",
        name: "Discover",
        steps: [
          {
            id: "partner-spec",
            what: "{targetName} shares its API spec",
            kind: "commitment",
            party: "target-owner",
            leadTimeKey: "api-spec",
            days: 10,
          },
          {
            id: "access",
            what: "{targetName} grants test credentials and sandbox access",
            kind: "commitment",
            party: "target-owner",
            leadTimeKey: "sandbox-access",
            days: 10,
          },
        ],
      },
      {
        id: "design",
        name: "Design",
        steps: [
          {
            id: "design",
            what: "Design approved for the {targetName} integration in {systemName}",
            kind: "change",
            per: "systems",
            milestone: "design",
            days: 5,
            after: ["partner-spec"],
          },
        ],
      },
      {
        id: "build",
        name: "Build",
        steps: [
          {
            id: "gateway-route",
            what: "Gateway proxy for {targetName}",
            kind: "request",
            template: "gateway-route",
            party: "approver",
            days: 5,
            after: ["design"],
          },
          {
            id: "firewall-rule",
            what: "Firewall rule to {targetName}",
            kind: "request",
            template: "firewall-rule",
            party: "approver",
            days: 10,
            after: ["design"],
          },
          {
            id: "build",
            what: "{systemName} built against {targetName}",
            kind: "change",
            per: "systems",
            milestone: "build",
            days: 10,
            after: ["design"],
          },
        ],
      },
      {
        id: "test",
        name: "Test",
        steps: [
          {
            id: "integration-test",
            what: "Joint integration test with {targetName}",
            kind: "commitment",
            party: "target-owner",
            leadTimeKey: "integration-test",
            days: 5,
            after: ["build", "access", "gateway-route", "firewall-rule"],
          },
        ],
      },
      {
        id: "release",
        name: "Release",
        steps: [
          {
            id: "release",
            what: "Go/no-go and release",
            kind: "task",
            owner: "delivery-lead",
            days: 2,
            after: ["integration-test"],
          },
        ],
      },
    ],
  },
  {
    schemaVersion: 1,
    id: "vendor-api-change",
    name: "Vendor API change",
    outcome: "Move every caller to a vendor's new API version before the old one is switched off.",
    phases: [
      {
        id: "discover",
        name: "Discover",
        steps: [
          {
            id: "vendor-spec",
            what: "{targetName} publishes the new API spec and changelog",
            kind: "commitment",
            party: "vendor",
            leadTimeKey: "api-spec",
            days: 10,
          },
          {
            id: "vendor-sandbox",
            what: "{targetName} gives sandbox access to the new API",
            kind: "commitment",
            party: "vendor",
            leadTimeKey: "sandbox-access",
            days: 10,
          },
        ],
      },
      {
        id: "design",
        name: "Design",
        steps: [
          {
            id: "impact",
            what: "Impact of the new {targetName} API on every caller",
            kind: "task",
            owner: "architect",
            days: 3,
            after: ["vendor-spec"],
          },
          {
            id: "design",
            what: "Design approved for moving {systemName} to the new {targetName} API",
            kind: "change",
            per: "callers",
            milestone: "design",
            days: 5,
            after: ["impact"],
          },
        ],
      },
      {
        id: "build",
        name: "Build",
        steps: [
          {
            id: "gateway-route",
            what: "Gateway proxy for the new {targetName} API",
            kind: "request",
            template: "gateway-route",
            party: "approver",
            days: 5,
            after: ["design"],
          },
          {
            id: "firewall-rule",
            what: "Firewall rule to the new {targetName} host",
            kind: "request",
            template: "firewall-rule",
            party: "approver",
            days: 10,
            after: ["design"],
          },
          {
            id: "build",
            what: "{systemName} moved to the new {targetName} API",
            kind: "change",
            per: "callers",
            milestone: "build",
            days: 10,
            after: ["design"],
          },
        ],
      },
      {
        id: "test",
        name: "Test",
        steps: [
          {
            id: "vendor-certification",
            what: "{targetName} certifies the integration in its sandbox",
            kind: "commitment",
            party: "vendor",
            leadTimeKey: "certification",
            days: 10,
            after: ["build", "vendor-sandbox", "gateway-route", "firewall-rule"],
          },
        ],
      },
      {
        id: "release",
        name: "Release",
        steps: [
          {
            id: "release",
            what: "Go/no-go and release",
            kind: "task",
            owner: "delivery-lead",
            days: 2,
            after: ["vendor-certification"],
          },
        ],
      },
    ],
  },
  {
    schemaVersion: 1,
    id: "design-change",
    name: "Design change",
    outcome: "Change how one system works and bring every caller along.",
    phases: [
      {
        id: "design",
        name: "Design",
        steps: [
          {
            id: "design",
            what: "Design approved for {targetName}",
            kind: "change",
            per: "target",
            milestone: "design",
            days: 5,
          },
          {
            id: "caller-impact",
            what: "{systemName} confirms the impact of the {targetName} change",
            kind: "commitment",
            party: "caller-owners",
            per: "callers",
            leadTimeKey: "system-card",
            days: 5,
            after: ["design"],
          },
        ],
      },
      {
        id: "build",
        name: "Build",
        steps: [
          {
            id: "build-target",
            what: "{targetName} built",
            kind: "change",
            per: "target",
            milestone: "build",
            days: 10,
            after: ["design"],
          },
          {
            id: "build-callers",
            what: "{systemName} updated for the {targetName} change",
            kind: "change",
            per: "callers",
            milestone: "build",
            days: 10,
            after: ["caller-impact"],
          },
        ],
      },
      {
        id: "release",
        name: "Release",
        steps: [
          {
            id: "release",
            what: "Go/no-go and release",
            kind: "task",
            owner: "delivery-lead",
            days: 2,
            after: ["build-target", "build-callers"],
          },
        ],
      },
    ],
  },
  {
    schemaVersion: 1,
    id: "migration",
    name: "Migration",
    outcome: "Move a system to a new platform without breaking its callers.",
    phases: [
      {
        id: "prepare",
        name: "Prepare",
        steps: [
          {
            id: "inventory",
            what: "Inventory of {targetName}'s interfaces, data and settings",
            kind: "task",
            owner: "architect",
            days: 5,
          },
          {
            id: "platform-ready",
            what: "The target platform is ready for {targetName}",
            kind: "commitment",
            party: "platform",
            leadTimeKey: "platform-ready",
            days: 15,
          },
        ],
      },
      {
        id: "design",
        name: "Design",
        steps: [
          {
            id: "design",
            what: "Migration design approved for {targetName}",
            kind: "change",
            per: "target",
            milestone: "design",
            days: 5,
            after: ["inventory"],
          },
        ],
      },
      {
        id: "build",
        name: "Build",
        steps: [
          {
            id: "firewall-rule",
            what: "Firewall rules for {targetName} on the new platform",
            kind: "request",
            template: "firewall-rule",
            party: "approver",
            days: 10,
            after: ["design"],
          },
          {
            id: "build",
            what: "{targetName} running on the new platform",
            kind: "change",
            per: "target",
            milestone: "build",
            days: 15,
            after: ["design"],
          },
          {
            id: "cutover-agreed",
            what: "{systemName} agrees the cutover window",
            kind: "commitment",
            party: "caller-owners",
            per: "callers",
            leadTimeKey: "cutover",
            days: 5,
            after: ["build"],
          },
        ],
      },
      {
        id: "release",
        name: "Cutover",
        steps: [
          {
            id: "release",
            what: "Cutover",
            kind: "task",
            owner: "delivery-lead",
            days: 2,
            after: ["platform-ready", "firewall-rule", "cutover-agreed"],
          },
        ],
      },
    ],
  },
  {
    schemaVersion: 1,
    id: "retire-system",
    name: "Retire a system",
    outcome: "Switch a system off after every caller has moved off it and its data is dealt with.",
    phases: [
      {
        id: "notify",
        name: "Notify",
        steps: [
          {
            id: "callers-notified",
            what: "{systemName} agrees to move off {targetName}",
            kind: "commitment",
            party: "caller-owners",
            per: "callers",
            leadTimeKey: "retire",
            days: 20,
          },
          {
            id: "design",
            what: "Retirement design approved for {targetName}",
            kind: "change",
            per: "target",
            milestone: "design",
            days: 5,
          },
        ],
      },
      {
        id: "move",
        name: "Move callers",
        steps: [
          {
            id: "caller-changes",
            what: "{systemName} no longer calls {targetName}",
            kind: "change",
            per: "callers",
            milestone: "released",
            days: 10,
            after: ["design", "callers-notified"],
          },
        ],
      },
      {
        id: "data",
        name: "Data",
        steps: [
          {
            id: "data-retention",
            what: "{targetName}'s data archived or deleted as its retention says",
            kind: "commitment",
            party: "target-owner",
            leadTimeKey: "data-retention",
            days: 10,
            after: ["caller-changes"],
          },
        ],
      },
      {
        id: "release",
        name: "Switch off",
        steps: [
          {
            id: "release",
            what: "Switch {targetName} off",
            kind: "task",
            owner: "platform-lead",
            days: 2,
            after: ["caller-changes", "data-retention"],
          },
        ],
      },
    ],
  },
];

export const BUILT_IN_JOURNEYS: readonly JourneyTemplate[] = BUILT_IN.map((j) =>
  JourneyTemplate.parse(j),
);

export interface LoadedJourneys {
  journeys: Map<JourneyId, JourneyTemplate & { source: string }>;
  problems: string[];
}

/** The built-in journeys, with any the org pack replaces at process/journeys/<id>.yaml. */
export async function loadJourneys(root: string): Promise<LoadedJourneys> {
  const journeys = new Map<JourneyId, JourneyTemplate & { source: string }>(
    BUILT_IN_JOURNEYS.map((j) => [j.id, { ...j, source: "built-in" }]),
  );
  const problems: string[] = [];
  const dir = join(orgPackDirOf(root), "process", "journeys");
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => /\.ya?ml$/.test(n)).sort();
  } catch {
    // no overrides
  }
  for (const n of names) {
    const rel = `process/journeys/${n}`;
    try {
      const r = JourneyTemplate.safeParse(parse(await readFile(join(dir, n), "utf8")));
      if (!r.success) {
        problems.push(
          `${rel}: ${r.error.issues.map((i) => `${i.path.join(".") || "(file)"} ${i.message}`).join("; ")}`,
        );
        continue;
      }
      journeys.set(r.data.id, { ...r.data, source: `org-pack/${rel}` });
    } catch (e) {
      problems.push(`${rel}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return { journeys, problems };
}

/** The steps of a journey in template order. */
export const stepsOf = (j: JourneyTemplate) =>
  j.phases.flatMap((p) => p.steps.map((s) => ({ ...s, phase: p.id })));
