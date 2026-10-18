import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ReplayRuntime } from "@maycombhq/ai";
import { Procedure, ServiceRequestTemplate } from "@maycombhq/core";
import { draftTemplates, workingDays } from "../src/index.js";
import { FIXTURES, FORGE, NOW, forgeChangeRoot, read } from "./helpers.js";

/** The Forge metarepo with its inputs beside the org pack, and the wiki folder pointed at them. */
async function forgeRoot(o: { withoutFirewall?: boolean } = {}) {
  const root = await forgeChangeRoot({ inputs: true });
  await writeFile(
    join(root, "org-pack/sources.yaml"),
    "schemaVersion: 1\nwikis:\n  - { id: forge-wiki, type: markdown-folder, location: ../inputs/wiki, owner: team-platform }\n",
  );
  if (o.withoutFirewall) await rm(join(root, "org-pack/process/snow/firewall-rule.yaml"));
  return root;
}

const replay = () =>
  ReplayRuntime.fromDir(join(FIXTURES, "recordings"), { now: () => new Date(NOW) });

const fixtureTemplate = async () =>
  ServiceRequestTemplate.parse(
    parse(await read(join(FORGE, "metarepo/org-pack/process/snow/firewall-rule.yaml"))),
  );

describe("templates learned from knowledge (golden)", () => {
  it("drafts the Forge firewall-rule template from the how-to page and past tickets", async () => {
    const root = await forgeRoot({ withoutFirewall: true });
    const before = await readdir(join(root, "org-pack/process/snow"));
    const r = await draftTemplates(root, { runtime: await replay(), now: new Date(NOW) });
    expect(r.problems).toEqual([]);
    expect(r.sources).toEqual({
      howTos: ["inputs/wiki/snow-firewall-request.md"],
      tickets: ["inputs/tickets/closed-service-requests.json"],
      workItems: ["inputs/tickets/ado-stories.json"],
    });
    const text = await read(join(root, "proposals/templates/process/snow/firewall-rule.yaml"));
    const drafted = ServiceRequestTemplate.parse(parse(text));
    const want = await fixtureTemplate();
    expect(drafted.fields).toEqual(want.fields);
    expect(drafted.approvers).toEqual(want.approvers);
    expect(drafted.leadTimeDays).toBe(10);
    expect(drafted).toEqual(want);
    // Every value cites where it came from.
    for (const line of text
      .split("\n")
      .filter((l) => /^(name|requestType|approvers|leadTimeDays| {2}- )/.test(l)))
      expect(line).toMatch(/#.*(inputs\/|SR-)/);
    expect(text).toContain(
      '  - { name: Source app, required: true, from: "${record}" }  # inputs/wiki/snow-firewall-request.md:3; inputs/tickets/closed-service-requests.json (2 of 2 requests filled source); every value of source is a catalog component (ledger-api, reports-job)',
    );
    expect(text).toContain(
      "leadTimeDays: 10  # inputs/wiki/snow-firewall-request.md:4; inputs/tickets/closed-service-requests.json (median 9.5 working days over 2 requests, rounded up)",
    );
    expect(text).toContain("# A network firewall rule opens a connection");
    // A procedure for the same request, off for every executor until a person allows one.
    const proc = Procedure.parse(
      parse(await read(join(root, "proposals/templates/process/procedures/firewall-rule.yaml"))),
    );
    expect(proc).toMatchObject({
      id: "firewall-rule",
      template: "firewall-rule",
      status: "draft",
      executors: { allowed: [] },
    });
    expect(proc.steps.map((s) => [s.id, s.kind, s.writes])).toEqual([
      ["submit-request", "submit-request", true],
      ["report-state", "report-request-state", false],
    ]);
    expect(proc.steps[0]!.inputs).toMatchObject({
      required: ["sourceApp", "destinationHost", "port", "protocol", "businessJustification"],
    });
    expect(proc.steps[0]!.instructions).toBe(
      'Raise a "Network firewall rule" request in the service desk with the source app, destination host, port, protocol and business justification, then submit it.',
    );
    // A proposal, never the org pack itself.
    expect(await readdir(join(root, "org-pack/process/snow"))).toEqual(before);
    expect(r.files).toEqual([
      "proposals/templates/process/snow/firewall-rule.yaml",
      "proposals/templates/process/procedures/firewall-rule.yaml",
      "proposals/templates/process/work-items/story.yaml",
      "proposals/templates/SUMMARY.md",
    ]);
    expect(r.workItems).toEqual([
      {
        type: "story",
        items: 2,
        alwaysFilled: { value: ["title"], sources: ["inputs/tickets/ado-stories.json"] },
        states: { value: [], sources: ["inputs/tickets/ado-stories.json"] },
      },
    ]);
    expect(await read(join(root, "proposals/templates/SUMMARY.md"))).toContain(
      "| Approvers | network team | inputs/wiki/snow-firewall-request.md:3; inputs/tickets/closed-service-requests.json (network team approved 2 of 2) |",
    );
  });

  it("finds the org pack's templates in agreement with the knowledge, and proposes nothing for them", async () => {
    const root = await forgeRoot();
    const r = await draftTemplates(root, { runtime: await replay(), now: new Date(NOW) });
    expect(r.templates.map((t) => [t.id, t.existing])).toEqual([
      ["firewall-rule", "matches"],
      ["gateway-route", "matches"],
    ]);
    expect(r.triage).toEqual([]);
    expect(r.files).not.toContain("proposals/templates/process/snow/firewall-rule.yaml");
    // Past gateway requests are too few to say the 5-day lead time is wrong.
    expect(r.templates[1]!.leadTimeDays.value).toBe(3);
  });

  it("turns knowledge that disagrees with a template into a triage item", async () => {
    const root = await forgeRoot();
    const page = join(root, "inputs/wiki/snow-firewall-request.md");
    await writeFile(
      page,
      (await read(page)).replace("business justification,", "business justification, expiry date,"),
    );
    const r = await draftTemplates(root, { now: new Date(NOW) });
    expect(r.templates[0]).toMatchObject({ id: "firewall-rule", existing: "differs" });
    expect(r.triage).toEqual([
      {
        id: "template.firewall-rule.field.expiry-date",
        template: "firewall-rule",
        summary:
          "Expiry date is asked for in the organisation's knowledge but org-pack/process/snow/firewall-rule.yaml doesn't have it.",
        evidence: ["inputs/wiki/snow-firewall-request.md:3"],
        options: ["Add Expiry date to the template", "Dismiss: the template is right"],
      },
    ]);
    expect(parse(await read(join(root, "proposals/templates/triage.yaml"))).items).toHaveLength(1);
    await expect(
      readFile(join(root, "proposals/templates/process/snow/firewall-rule.yaml"), "utf8"),
    ).resolves.toContain("Expiry date");
  });

  it("reads how-to documents uploaded to inputs/ too, and says what it couldn't learn", async () => {
    const root = await forgeRoot();
    await mkdir(join(root, "inputs/inbox"), { recursive: true });
    await writeFile(
      join(root, "inputs/inbox/certificates.md"),
      '# How to request a certificate\n\nRaise a "TLS certificate" request. Fields: common name, environment, requester (optional), approver (security team).\nTypical lead time: 3 working days.\n',
    );
    const r = await draftTemplates(root, { now: new Date(NOW) });
    expect(r.sources.howTos).toEqual([
      "inputs/wiki/snow-firewall-request.md",
      "inputs/inbox/certificates.md",
    ]);
    const cert = r.templates.find((t) => t.id === "certificate")!;
    expect(cert.fields.map((f) => [f.name, f.required, f.sources])).toEqual([
      ["Common name", true, ["inputs/inbox/certificates.md:3"]],
      ["Environment", true, ["inputs/inbox/certificates.md:3"]],
      ["Requester", false, ["inputs/inbox/certificates.md:3"]],
    ]);
    expect(cert.approvers.value).toEqual(["security team"]);
    expect(cert.leadTimeDays).toEqual({ value: 3, sources: ["inputs/inbox/certificates.md:4"] });
    expect(cert.notes).toEqual([
      "No trigger could be read from past requests and the catalog: add one by hand.",
    ]);
    expect(cert.problems).toEqual(["triggers: Too small: expected array to have >=1 items"]);
    expect(await read(join(root, "proposals/templates/process/snow/certificate.yaml"))).toContain(
      "triggers: []  # none found: add one",
    );
  });

  it("counts working days from open to close", () => {
    expect(workingDays("2026-03-02", "2026-03-16")).toBe(10);
    expect(workingDays("2026-04-06", "2026-04-17")).toBe(9);
    expect(workingDays("2026-02-10", "2026-02-13")).toBe(3);
  });
});
