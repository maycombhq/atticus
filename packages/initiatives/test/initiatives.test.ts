import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { deserializeRecord, ManualStep } from "@maycombhq/core";
import {
  addWorkingDays,
  BUILT_IN_JOURNEYS,
  initiativeStatus,
  JourneyTemplate,
  loadJourneys,
  newInitiative,
  parseLeadTime,
  planJourney,
  readPlan,
  readView,
  recordCommitment,
  recordPlanItem,
  requestFromTeam,
  subtractWorkingDays,
  systemCard,
  workingDays,
  type InitiativeStatus,
  type PlanFile,
} from "../src/index.js";
import { expectedYaml, forgeRoot, ID, NW, read } from "./helpers.js";

const at = (s: string) => new Date(s);

async function startGolden(root: string) {
  await newInitiative(root, {
    title: "Northwind Pay v3 migration",
    journey: "vendor-api-change",
    by: "pat",
    targetRelease: "2027-03-01",
  });
  return planJourney(root, ID, {
    target: "northwind-pay",
    by: "pat",
    now: at("2026-12-14T09:00:00Z"),
  });
}

describe("working days", () => {
  it("counts Monday to Friday, forwards and backwards", () => {
    expect(addWorkingDays("2027-01-04", 5)).toBe("2027-01-11");
    expect(subtractWorkingDays("2027-02-25", 15)).toBe("2027-02-04");
    expect(subtractWorkingDays("2027-01-11", 15)).toBe("2026-12-21");
    expect(workingDays("2027-02-19", "2027-03-01")).toBe(6);
    expect(workingDays("2027-03-01", "2027-02-19")).toBe(-6);
    expect(workingDays("2026-03-02", "2026-03-16")).toBe(10);
  });

  it("reads lead times as the parties write them", () => {
    expect(parseLeadTime("10d")).toBe(10);
    expect(parseLeadTime("3w")).toBe(15);
    expect(parseLeadTime("2 weeks")).toBe(10);
    expect(parseLeadTime("4")).toBe(4);
    expect(parseLeadTime("7 working days")).toBe(7);
    expect(parseLeadTime("soon")).toBeUndefined();
  });
});

describe("journeys", () => {
  it("has the six journeys of C1, each valid and ending in one release step", () => {
    expect(BUILT_IN_JOURNEYS.map((j) => j.id)).toEqual([
      "new-feature",
      "new-integration",
      "vendor-api-change",
      "design-change",
      "migration",
      "retire-system",
    ]);
    for (const j of BUILT_IN_JOURNEYS) {
      const steps = j.phases.flatMap((p) => p.steps);
      const sinks = steps.filter((s) => !steps.some((t) => t.after.includes(s.id)));
      expect({ journey: j.id, sinks: sinks.map((s) => s.id) }).toEqual({
        journey: j.id,
        sinks: ["release"],
      });
    }
  });

  it("refuses a template whose steps go round in a circle or name missing steps", () => {
    const bad = JourneyTemplate.safeParse({
      schemaVersion: 1,
      id: "migration",
      name: "x",
      outcome: "x",
      phases: [
        {
          id: "p",
          name: "p",
          steps: [
            { id: "a", what: "a", kind: "task", after: ["b"] },
            { id: "b", what: "b", kind: "task", after: ["a", "c"] },
            { id: "r", what: "r", kind: "request", after: [] },
          ],
        },
      ],
    });
    expect(bad.success).toBe(false);
    const messages = bad.error!.issues.map((i) => i.message);
    expect(messages).toContain("step b comes after c, which doesn't exist");
    expect(messages).toContain("request step r needs a template");
    expect(messages.some((m) => m.startsWith("the steps go round in a circle"))).toBe(true);
  });

  it("takes an organisation's own journey from the org pack instead of the built-in one", async () => {
    const root = await forgeRoot();
    await mkdir(join(root, "org-pack/process/journeys"), { recursive: true });
    await writeFile(
      join(root, "org-pack/process/journeys/migration.yaml"),
      [
        "schemaVersion: 1",
        "id: migration",
        "name: Our migration",
        "outcome: Move it.",
        "phases:",
        "  - id: all",
        "    name: All",
        "    steps:",
        '      - { id: release, what: "Move {targetName}", kind: task, days: 3 }',
      ].join("\n"),
    );
    await writeFile(
      join(root, "org-pack/process/journeys/broken.yaml"),
      "schemaVersion: 1\nid: nope\n",
    );
    const { journeys, problems } = await loadJourneys(root);
    expect(journeys.get("migration")).toMatchObject({
      name: "Our migration",
      source: "org-pack/process/journeys/migration.yaml",
    });
    expect(journeys.get("new-feature")!.source).toBe("built-in");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^process\/journeys\/broken\.yaml: /);
  });
});

describe("the Northwind Pay v3 migration (golden, vendor-api-change)", () => {
  it("creates the initiative as a curated record and refuses the same id twice", async () => {
    const root = await forgeRoot();
    const r = await newInitiative(root, {
      title: "Northwind Pay v3 migration",
      journey: "vendor-api-change",
      by: "@pat",
      targetRelease: "2027-03-01",
    });
    expect(r.written).toBe(`catalog/curated/initiative/${ID}.yaml`);
    const back = deserializeRecord(await read(join(root, r.written)));
    expect(back.ok && back.record).toMatchObject({
      kind: "Initiative",
      id: ID,
      confidence: "asserted",
      evidence: [{ source: "manual", by: "pat" }],
      journey: "vendor-api-change",
    });
    await expect(
      newInitiative(root, {
        title: "Northwind Pay v3 migration",
        journey: "vendor-api-change",
        by: "pat",
      }),
    ).rejects.toThrow(/already exists/);
    await expect(
      newInitiative(root, { title: "X", journey: "lift-and-shift", by: "pat" }),
    ).rejects.toThrow(/There is no journey lift-and-shift/);
  });

  it("plans back from the release: lead times from parties, past requests and defaults", async () => {
    const root = await forgeRoot();
    const r = await startGolden(root);
    const want = expectedYaml<PlanFile>("plan.yaml");
    expect(r.notes).toEqual([]);
    expect(r.plan.items).toEqual(want.items);
    expect(r.plan).toEqual(want);
    expect(await readPlan(root, ID)).toEqual(want);
    const records = expectedYaml<{
      initiative: unknown;
      commitments: unknown[];
      proposedChanges: unknown[];
    }>("records.yaml");
    expect(r.commitments).toEqual(records.commitments);
    expect(r.initiative).toEqual(records.initiative);
    expect(r.changes).toEqual(records.proposedChanges);
    // The records are on disk as curated files, in canonical form.
    const view = await readView(root);
    expect(view.problems).toEqual([]);
    expect(view.get("Initiative", ID)).toEqual(records.initiative);
    expect(view.all("Commitment")).toEqual(
      [...(records.commitments as { id: string }[])].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
    expect(r.written).toContain(`catalog/curated/commitment/${ID}.firewall-rule.yaml`);
  });

  it("writes nothing on a dry run, and says when a party is missing", async () => {
    const root = await forgeRoot({ parties: false });
    await newInitiative(root, {
      title: "Northwind Pay v3 migration",
      journey: "vendor-api-change",
      by: "pat",
    });
    const r = await planJourney(root, ID, {
      target: "northwind-pay",
      targetRelease: "2027-03-01",
      by: "pat",
      now: at("2026-12-14T09:00:00Z"),
      dryRun: true,
    });
    expect(r.written).toEqual([]);
    expect(await readPlan(root, ID)).toBeUndefined();
    expect(r.commitments).toEqual([]);
    expect(r.notes).toContain(
      "No party for step vendor-spec (vendor): add a Party record to catalog/curated/party/ and plan again.",
    );
    // Without a party the request falls back to the template's own lead time.
    expect(r.plan.items.find((i) => i.key === "gateway-route")!.leadTime).toBe(
      "org-pack/process/snow/gateway-route.yaml leadTimeDays",
    );
  });

  it("sends a system card to the vendor, tracks the reply as a commitment and drafts the message as a manual step", async () => {
    const root = await forgeRoot();
    await startGolden(root);
    const r = await requestFromTeam(root, ID, "party.northwind-pay", {
      by: "pat",
      now: at("2027-01-04T10:00:00Z"),
    });
    expect(r.card).toBe(await read(join(NW, "expected/card-northwind-pay.md")));
    expect(await read(join(root, r.cardPath))).toBe(r.card);
    expect(r.cardPath).toBe(`initiatives/${ID}/requests/northwind-pay.md`);
    expect(r.commitment).toMatchObject({
      id: `${ID}.request.northwind-pay`,
      party: "party.northwind-pay",
      what: "Northwind Pay replies to the system card for northwind-pay",
      owner: "Northwind Pay partner desk",
      neededBy: "2027-01-11",
      blocks: [`${ID}-ledger`],
      commitmentStatus: "open",
    });
    expect(r.notification).toMatchObject({
      channel: "email",
      title: "System card: northwind-pay (reply by 2027-01-11)",
      link: r.cardPath,
      mentions: ["partners@northwind.example"],
    });
    // The manual step is a C4 file a person does and records back.
    const step = ManualStep.parse(parse(await read(join(root, "steps", `${r.step.id}.yaml`))));
    expect(step).toMatchObject({
      system: "notify",
      action: "send-notification",
      state: "open",
      createdBy: "pat",
    });
    expect(step.approval).toMatchObject({ by: "pat", ref: `${ID}.request.northwind-pay` });
    expect(step.fields.find((f) => f.name === "Link")!.value).toBe(r.cardPath);
    const view = await readView(root);
    expect(view.get("Initiative", ID)!.commitments).toContain(`${ID}.request.northwind-pay`);
  });

  it("writes a system card for an internal team from the catalog alone", async () => {
    const root = await forgeRoot();
    const view = await readView(root);
    expect(systemCard(view, ["ledger"])).toBe(await read(join(NW, "expected/card-team-ledger.md")));
    expect(() => systemCard(view, ["nowhere"])).toThrow(/None of nowhere is a system/);
  });

  it("computes the critical path, slipped and at-risk commitments from dates and change states", async () => {
    const root = await forgeRoot();
    await startGolden(root);
    await requestFromTeam(root, ID, "party.northwind-pay", {
      by: "pat",
      now: at("2027-01-04T10:00:00Z"),
    });
    await recordCommitment(root, `${ID}.vendor-sandbox`, { status: "done", by: "ari" });
    await mkdir(join(root, "openspec/changes", `${ID}-ledger`), { recursive: true });
    await cp(
      join(NW, "change/change.yaml"),
      join(root, "openspec/changes", `${ID}-ledger`, "change.yaml"),
    );

    const s = await initiativeStatus(root, ID, { now: at("2027-01-13T12:00:00Z") });
    const want = expectedYaml<
      Pick<
        InitiativeStatus,
        "today" | "status" | "projectedRelease" | "criticalPath" | "changes"
      > & {
        items: Record<string, unknown>[];
        commitments: Record<string, unknown>[];
        whys: Record<string, string>;
      }
    >("status-2027-01-13.yaml");
    expect(s.notes).toEqual([]);
    expect({ today: s.today, status: s.status, projectedRelease: s.projectedRelease }).toEqual({
      today: want.today,
      status: want.status,
      projectedRelease: want.projectedRelease,
    });
    expect(s.criticalPath).toEqual(want.criticalPath);
    expect(
      s.items.map((i) => ({
        key: i.key,
        status: i.status,
        projectedFinish: i.projectedFinish,
        float: i.float,
        critical: i.critical,
      })),
    ).toEqual(want.items);
    expect(s.commitments.map((c) => ({ id: c.id, status: c.status }))).toEqual(want.commitments);
    expect(s.changes).toEqual(want.changes);
    for (const [key, why] of Object.entries(want.whys))
      expect(s.items.find((i) => i.key === key)!.why).toBe(why);
  });

  it("is on track when everything is on plan, and done when every item is done", async () => {
    const root = await forgeRoot();
    await startGolden(root);
    const early = await initiativeStatus(root, ID, { now: at("2026-12-15T09:00:00Z") });
    expect(early.status).toBe("on-track");
    expect(early.projectedRelease).toBe("2027-03-01");
    expect(early.items.every((i) => i.status === "open")).toBe(true);
    // The plan schedules every item as late as it can, so on plan nothing has float: any slip
    // moves the release. The chain shown runs through the first of tied items by key.
    expect(early.items.every((i) => i.float === 0 && i.critical)).toBe(true);
    expect(early.criticalPath).toEqual([
      "vendor-spec",
      "impact",
      "design.ledger",
      "build.ledger",
      "vendor-certification",
      "release",
    ]);

    for (const c of [
      "vendor-spec",
      "vendor-sandbox",
      "gateway-route",
      "firewall-rule",
      "vendor-certification",
    ])
      await recordCommitment(root, `${ID}.${c}`, { status: "done", by: "pat" });
    await recordPlanItem(root, ID, "impact", {
      done: true,
      by: "ari",
      now: at("2027-01-12T09:00:00Z"),
    });
    await recordPlanItem(root, ID, "release", {
      done: true,
      by: "dana",
      now: at("2027-03-01T09:00:00Z"),
    });
    const dir = join(root, "openspec/changes", `${ID}-ledger`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "change.yaml"), QA_CHANGE);
    const done = await initiativeStatus(root, ID, { now: at("2027-03-01T12:00:00Z") });
    expect(done.notes).toEqual([]);
    expect(done.status).toBe("done");
    expect(done.criticalPath).toEqual([]);
  });

  it("explains what it can't do", async () => {
    const root = await forgeRoot();
    await expect(initiativeStatus(root, "nope")).rejects.toThrow("There is no initiative nope.");
    await newInitiative(root, { title: "No plan yet", journey: "new-feature", by: "pat" });
    const s = await initiativeStatus(root, "no-plan-yet", { now: at("2027-01-01T00:00:00Z") });
    expect(s.status).toBe("not-planned");
    expect(s.notes).toEqual(["Initiative no-plan-yet has no plan yet: run initiative plan."]);
    await expect(
      planJourney(root, "no-plan-yet", { by: "pat", targetRelease: "2027-03-01" }),
    ).rejects.toThrow(/Name the system the journey is about/);
    await expect(
      planJourney(root, "no-plan-yet", {
        by: "pat",
        target: "nowhere",
        targetRelease: "2027-03-01",
      }),
    ).rejects.toThrow("nowhere is not a system or component in the catalog.");
    await expect(planJourney(root, "no-plan-yet", { by: "pat", target: "ledger" })).rejects.toThrow(
      /YYYY-MM-DD/,
    );
  });
});

/** The Ledger change after QA started: past both of its milestones. */
const QA_CHANGE = `schemaVersion: 1
id: ${ID}-ledger
title: "Northwind Pay v3 migration: Ledger"
type: feature
state: qa
createdAt: 2026-12-15T09:00:00Z
createdBy: pat
history:
  - { from: draft, to: define, at: 2026-12-15T09:00:00Z, by: pat }
  - { from: define, to: design, at: 2027-01-08T15:00:00Z, by: pat }
  - { from: design, to: plan, at: 2027-01-20T09:00:00Z, by: ari }
  - { from: plan, to: build, at: 2027-01-21T09:00:00Z, by: tia }
  - { from: build, to: qa, at: 2027-02-03T09:00:00Z, by: dev }
`;

describe("every journey plans on Forge", () => {
  const cases: { journey: string; target: string; systems?: string[]; skipped?: string }[] = [
    { journey: "new-feature", target: "portal" },
    { journey: "new-integration", target: "northwind-pay", systems: ["ledger"] },
    { journey: "design-change", target: "ledger" },
    { journey: "migration", target: "reports" },
    { journey: "retire-system", target: "audit" },
  ];
  for (const c of cases)
    it(`${c.journey} on ${c.target}`, async () => {
      const root = await forgeRoot();
      await newInitiative(root, {
        title: `Try ${c.journey}`,
        journey: c.journey,
        by: "pat",
        targetRelease: "2027-06-01",
      });
      const r = await planJourney(root, `try-${c.journey}`, {
        target: c.target,
        ...(c.systems ? { systems: c.systems } : {}),
        by: "pat",
        now: at("2027-01-04T09:00:00Z"),
      });
      const release = r.plan.items.find((i) => i.step === "release")!;
      expect(release.due).toBe("2027-06-01");
      // every item is due no later than every item after it starts
      for (const i of r.plan.items)
        for (const a of i.after)
          expect(r.plan.items.find((x) => x.key === a)!.due <= i.start).toBe(true);
      const s = await initiativeStatus(root, `try-${c.journey}`, {
        now: at("2027-01-04T09:00:00Z"),
      });
      expect(s.status).toBe("on-track");
      expect(s.criticalPath.at(-1)).toBe("release");
    });

  it("leaves out per-caller steps when nothing calls the target, and links around them", async () => {
    const root = await forgeRoot();
    await newInitiative(root, {
      title: "Retire portal",
      journey: "retire-system",
      by: "pat",
      targetRelease: "2027-06-01",
    });
    // nothing outside Portal calls it (portal-ui calls portal-bff, inside the same system)
    const r = await planJourney(root, "retire-portal", {
      target: "portal",
      by: "pat",
      now: at("2027-01-04T09:00:00Z"),
    });
    expect(r.notes).toEqual([
      "Step callers-notified is per caller and Portal has none: left out.",
      "Step caller-changes is per caller and Portal has none: left out.",
    ]);
    expect(r.plan.items.map((i) => [i.key, i.after, i.party ?? null])).toEqual([
      ["design.portal", [], null],
      ["data-retention", ["design.portal"], "party.team-portal"],
      ["release", ["design.portal", "data-retention"], null],
    ]);
  });
});
