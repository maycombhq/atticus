import { describe, expect, it } from "vitest";
import { readHops, type ChangeFiles } from "../src/artifacts.js";
import { interfaceEndsInCatalog } from "../src/checks/interfaces.js";
import type { CriticContext } from "../src/context.js";
import { parseDoc } from "../src/doc.js";
import { plannedInChange, plannedText } from "../src/planned.js";

/**
 * ADR 0189: a component the change's own diagram draws as new is planned in this change, not
 * "not in the catalog"; the architect draws the future before the repos exist. On the invented
 * Forge estate.
 */

const IFACES = `# Interfaces

| Interface id | Caller | Callee | Pattern | Operation | Contract | Status |
| --- | --- | --- | --- | --- | --- | --- |
| new | forge-orders | forge-scheduler | S.GW.SOR | POST /reminders | none | planned-new |
| new | forge-orders | forge-nowhere | S.GW.SOR | POST /x | none | planned-new |
`;

const NEW_BOX = `schemaVersion: 2
flow: forge-scheduler.run-reminders
repo: forge-scheduler
change: new
name: Run reminders
trigger: { kind: job, what: Every hour }
why: Drawn on the canvas by priya.
runsOn: { component: forge-scheduler }
steps: []
`;

const RETIRED = `schemaVersion: 2
flow: forge-legacy.export
repo: forge-legacy
change: remove
why: "Retires forge-legacy: replaced (drawn on the canvas by priya, stroke abcd1234)"
steps: []
`;

function files(): ChangeFiles {
  return {
    dir: "/x",
    docs: new Map([["interfaces.md", parseDoc("interfaces.md", IFACES)]]),
    flows: [
      parseDoc("target-flows/forge-scheduler.run-reminders.yaml", NEW_BOX),
      parseDoc("target-flows/forge-legacy.export.yaml", RETIRED),
    ],
  } as ChangeFiles;
}

const known = (id: string) => ["forge-orders", "forge-legacy"].includes(id);

describe("the components a change plans, for the critic", () => {
  it("are read off its target flows: a new box, and a component retired", () => {
    const p = plannedInChange(files(), known);
    expect([...p]).toEqual([
      ["forge-scheduler", "new"],
      ["forge-legacy", "retire"],
    ]);
    expect(plannedText(p)).toContain("- forge-scheduler: new in this change");
  });

  it("an end the change plans isn't 'not in the catalog'; one nothing plans still is", () => {
    const f = files();
    const ctx = {
      files: f,
      hops: readHops(f),
      isKnown: known,
      planned: plannedInChange(f, known),
    } as unknown as CriticContext;
    const r = interfaceEndsInCatalog.run(ctx, {}, {} as never);
    const said = (r as { hits: { summary: string }[] }).hits.map((h) => h.summary);
    expect(said).toEqual(["The callee forge-nowhere of POST /x is not in the catalog."]);
  });
});
