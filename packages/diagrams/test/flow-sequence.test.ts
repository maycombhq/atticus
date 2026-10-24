import { describe, expect, it } from "vitest";
import { parseRecord, type RecordOf } from "@maycombhq/core";
import { flowSequenceView, toMermaid } from "../src/index.js";

/** A flow as a sequence diagram (ADR 0092's lanes), for the map's flows/ pages (ADR 0124, A3b). */

const ev = (path: string, line: number) => [{ source: "code", repo: "forge-ledger", path, line }];
const flow = (): RecordOf<"Flow"> => {
  const p = parseRecord({
    kind: "Flow",
    schemaVersion: 2,
    id: "ledger-api.post-a-ledger-entry",
    component: "ledger-api",
    name: "Post a ledger entry",
    trigger: {
      kind: "endpoint",
      ref: "ledger-api.post-entry",
      what: "POST /accounts/{accountId}/entries",
      evidence: ev("EntryController.java", 22),
    },
    steps: [
      {
        kind: "validate",
        what: "the amount is present; and positive",
        refs: [],
        evidence: ev("EntryRequest.java", 7),
      },
      {
        kind: "call-out",
        what: "fetch the FX rate",
        refs: ["if-1"],
        to: { component: "northwind-fx", entry: "GET /v1/rates/{pair}" },
        evidence: ev("FxClient.java", 31),
      },
      {
        kind: "write",
        what: "insert the entry",
        refs: ["ledger-db.entry"],
        store: { table: "ledger-db.entry", columns: ["id", "amount"] },
        evidence: ev("EntryRepository.java", 8),
      },
      {
        kind: "publish",
        what: "tell the world",
        refs: [],
        to: { component: "unresolved.c-x", entry: "forge.ledger.posted" },
        evidence: ev("Events.java", 3),
      },
      { kind: "respond", what: "return 201", refs: [], evidence: ev("EntryController.java", 30) },
    ],
    errors: [],
    template: "facts@1",
  });
  if (!p.ok || p.record.kind !== "Flow") throw new Error(JSON.stringify(p));
  return p.record;
};

describe("flowSequenceView: a flow as lanes and rows (ADR 0092)", () => {
  it("draws the caller, the flow's component, then each component, table and topic in the order reached", () => {
    const v = flowSequenceView(flow(), {
      source: "specs/forge-ledger/ledger-api.post-a-ledger-entry.yaml",
    });
    expect(v.participants.map((p) => p.id)).toEqual([
      "caller",
      "ledger-api",
      "northwind-fx",
      "ledger-db.entry",
      "forge.ledger.posted",
    ]);
    expect(v.participants[0]!.label).toBe("Caller not known");
  });

  it("renders to the same Mermaid every time, one numbered row per step", () => {
    const text = toMermaid(flowSequenceView(flow(), { source: "specs/forge-ledger/x.yaml" }));
    expect(text).toBe(
      [
        "%% Post a ledger entry. Rendered by Atticus from specs/forge-ledger/x.yaml.",
        "sequenceDiagram",
        "  participant caller as Caller not known",
        "  participant ledger_api as ledger-api",
        "  participant northwind_fx as northwind-fx",
        "  participant ledger_db_entry as ledger-db.entry",
        "  participant forge_ledger_posted as forge.ledger.posted",
        "  caller->>ledger_api: POST /accounts/{accountId}/entries",
        "  Note over ledger_api: 1. validate: the amount is present#59; and positive",
        "  ledger_api->>northwind_fx: 2. call-out: GET /v1/rates/{pair}",
        "  ledger_api->>ledger_db_entry: 3. write: insert the entry (id, amount)",
        "  ledger_api-)forge_ledger_posted: 4. publish: forge.ledger.posted",
        "  ledger_api-->>caller: 5. respond: return 201",
        "",
      ].join("\n"),
    );
  });
});
