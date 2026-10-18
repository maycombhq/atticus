import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { interfaceId, loadOrgPack, parseRecord, type CatalogRecord } from "@maycombhq/core";
import { readDrawio, reconcile } from "@maycombhq/reconcile";
import { buildTriage, scanInputs, TriageError } from "../src/index.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const ORG_PACK = join(FORGE, "metarepo/org-pack");
const DIAGRAM = "inputs/diagrams/forge-context.drawio";

const rec = (r: Record<string, unknown>): CatalogRecord => {
  const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
  if (!p.ok) throw new Error(`${String(r.id)}: ${JSON.stringify(p.issues)}`);
  return p.record;
};
const catalog = () =>
  (parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<string, unknown>[]).map(
    rec,
  );

async function forgeTriage(records = catalog(), decisions: CatalogRecord[] = []) {
  const op = await loadOrgPack(ORG_PACK);
  const profile = op.profiles[0]!.profile!;
  const all = [...records, ...decisions];
  const items = reconcile({
    diagram: readDrawio(readFileSync(join(FORGE, DIAGRAM), "utf8"), profile.legend),
    file: DIAGRAM,
    records: all,
    systems: profile.systems,
    patterns: op.patterns,
  }).items;
  const inputs = await scanInputs({
    root: join(FORGE, "metarepo"),
    orgPack: ORG_PACK,
    inputsDir: join(FORGE, "inputs"),
    records: all,
  });
  return buildTriage({
    records,
    inputs,
    reconcileItems: [{ file: DIAGRAM, items }],
    decisions,
  });
}

const dismiss = (id: string, target: string, label = "Dismiss") => ({
  action: "suppress",
  label,
  decision: {
    id: `triage.${id}`,
    target,
    action: "suppress",
    value: { triage: id },
    reason: label === "Dismiss" ? "Dismissed in triage" : label,
  },
});

describe("triage of the Forge diagram and inputs", () => {
  it("turns reconcile items into decisions to make, conflicts first", async () => {
    const t = await forgeTriage();
    expect(t.items.map((i) => [i.kind, i.id])).toEqual([
      ["conflict", "drawn-call-reads-database.e5"],
      ["conflict", "pattern-mismatch.e4-if-e7344c9455608119"],
      ["conflict", "unknown-pattern.e5"],
      ["alias-needed", "alias-needed.ledger-platform"],
      ["diagram-gap", "code-only.if-5c55930b735276a9"],
      ["diagram-gap", "code-only.if-f1cd1f189eaa4b7b"],
      ["planned", "planned.e7"],
    ]);
    const byId = new Map(t.items.map((i) => [i.id, i]));
    expect(byId.get("alias-needed.ledger-platform")).toEqual({
      id: "alias-needed.ledger-platform",
      kind: "alias-needed",
      summary:
        'The diagram\'s "Ledger Platform" was matched to ledger-api through the profile; confirm it so later diagrams match it directly.',
      source: {
        path: DIAGRAM,
        line: 9,
        page: "Forge context (as the architect drew it)",
        cell: "ledger",
      },
      records: ["ledger-api"],
      options: [
        {
          action: "alias",
          label: '"Ledger Platform" is ledger-api',
          decision: {
            id: "alias.ledger-platform",
            target: "ledger-api",
            action: "alias",
            value: "Ledger Platform",
            reason: '"Ledger Platform" is ledger-api',
          },
        },
        dismiss("alias-needed.ledger-platform", "ledger-api"),
      ],
    });
    expect(byId.get("pattern-mismatch.e4-if-e7344c9455608119")).toMatchObject({
      records: ["if-e7344c9455608119"],
      source: { path: DIAGRAM, cell: "e4" },
      options: [
        dismiss(
          "pattern-mismatch.e4-if-e7344c9455608119",
          "if-e7344c9455608119",
          "The code is right",
        ),
      ],
      next: "Redraw the edge to match the code, or plan a change that routes it as S.GW.VND says",
    });
    expect(byId.get("unknown-pattern.e5")).toMatchObject({
      records: [],
      options: [dismiss("unknown-pattern.e5", "doc.forge-context", "The code is right")],
      next: "Did you mean S.GW.SOR?",
    });
    expect(byId.get("code-only.if-5c55930b735276a9")!.options).toEqual([
      {
        action: "suppress",
        label: "Add it to the diagram, or record why it is left out",
        decision: {
          id: "triage.code-only.if-5c55930b735276a9",
          target: "if-5c55930b735276a9",
          action: "suppress",
          value: { diagram: DIAGRAM },
          reason: "Add it to the diagram, or record why it is left out",
        },
      },
    ]);
    expect(byId.get("planned.e7")).toMatchObject({
      kind: "planned",
      options: [dismiss("planned.e7", "doc.forge-context", "Not planned any more")],
      next: "Add Portal BFF → Notifications Service (A.EB.PUB notifications.requested) to a change as a planned-new interface",
    });
  });

  it("decides an item into a CuratedDecision, after which the item is gone", async () => {
    const t = await forgeTriage();
    const d = t.decide("alias-needed.ledger-platform", 0, {
      by: "a.architect",
      reason: "The architects' name for the ledger service",
      at: "2026-10-18T11:00:00Z",
    });
    expect(d).toEqual(
      rec({
        kind: "CuratedDecision",
        id: "alias.ledger-platform",
        confidence: "asserted",
        target: "ledger-api",
        action: "alias",
        value: "Ledger Platform",
        reason: "The architects' name for the ledger service",
        by: "a.architect",
        at: "2026-10-18T11:00:00Z",
        evidence: [{ source: "manual", by: "a.architect", path: DIAGRAM, line: 9 }],
      }),
    );
    const dropped = t.decide("code-only.if-f1cd1f189eaa4b7b", 0, {
      by: "a.architect",
      at: "2026-10-18T11:05:00Z",
    });
    expect(dropped.reason).toBe("Add it to the diagram, or record why it is left out");
    const after = await forgeTriage(catalog(), [d, dropped]);
    expect(after.items.map((i) => i.id)).not.toContain("alias-needed.ledger-platform");
    expect(after.items.map((i) => i.id)).not.toContain("code-only.if-f1cd1f189eaa4b7b");
    expect(after.items).toHaveLength(5);
  });

  it("refuses an unknown item or option", async () => {
    const t = await forgeTriage();
    expect(() => t.decide("no-such-item", 0, { by: "x" })).toThrow(TriageError);
    expect(() => t.decide("planned.e7", 5, { by: "x" })).toThrow(/planned\.e7 has 1 option/);
  });

  it("offers each side of a record's open conflict, marking what the code says", async () => {
    const records = catalog().map((r) =>
      r.id === "if-e7344c9455608119"
        ? rec({
            ...(r as unknown as Record<string, unknown>),
            conflicts: [
              {
                field: "via",
                values: ["direct", "gateway"],
                note: "inputs/wiki/ledger-solution-spec.md",
              },
            ],
          })
        : r,
    );
    const t = await forgeTriage(records);
    expect(t.items[0]).toEqual({
      id: "conflict.if-e7344c9455608119-via",
      kind: "conflict",
      summary:
        "if-e7344c9455608119 has two values for via: direct, gateway (inputs/wiki/ledger-solution-spec.md). The code stands until someone decides.",
      source: { path: "inputs/wiki/ledger-solution-spec.md" },
      records: ["if-e7344c9455608119"],
      options: [
        {
          action: "resolve-conflict",
          label: "via is direct (what the code says)",
          decision: {
            id: "triage.conflict.if-e7344c9455608119-via",
            target: "if-e7344c9455608119",
            action: "resolve-conflict",
            value: { via: "direct" },
            reason: "via is direct (what the code says)",
          },
        },
        {
          action: "resolve-conflict",
          label: "via is gateway",
          decision: {
            id: "triage.conflict.if-e7344c9455608119-via",
            target: "if-e7344c9455608119",
            action: "resolve-conflict",
            value: { via: "gateway" },
            reason: "via is gateway",
          },
        },
      ],
    });
  });

  it("asks a person to confirm each edge read from an image", async () => {
    const edge = rec({
      kind: "Interface",
      id: interfaceId("portal-bff", "ledger-api", "GET", "/limits"),
      confidence: "inferred",
      from: "portal-bff",
      to: "ledger-api",
      via: "direct",
      method: "GET",
      normalizedPath: "/limits",
      sync: "sync",
      evidence: [{ source: "diagram", path: "inputs/inbox/whiteboard.jpg" }],
    });
    const t = await forgeTriage([...catalog(), edge]);
    expect(t.items.find((i) => i.kind === "image-edges")).toEqual({
      id: `image-edges.${edge.id}`,
      kind: "image-edges",
      summary: `Interface ${edge.id} (portal-bff → ledger-api) was read from an image; confirm it before it counts.`,
      source: { path: "inputs/inbox/whiteboard.jpg" },
      records: [edge.id],
      options: [
        {
          action: "assert",
          label: "Confirm it",
          decision: {
            id: `triage.image-edges.${edge.id}`,
            target: edge.id,
            action: "assert",
            value: {},
            reason: "Confirm it",
          },
        },
        {
          action: "suppress",
          label: "It's wrong; drop it",
          decision: {
            id: `triage.image-edges.${edge.id}`,
            target: edge.id,
            action: "suppress",
            value: null,
            reason: "It's wrong; drop it",
          },
        },
      ],
    });
  });
});
