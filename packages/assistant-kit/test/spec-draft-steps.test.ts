import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { DEFAULT_SPEC_TEMPLATE, parseRecord, type CatalogRecord } from "@maycombhq/core";
import { fsRepo } from "@maycombhq/sdk";
import { draftSpec } from "../src/spec-draft.js";

/**
 * ADR 0089, measured with the mock runtime: answers shaped like the live petclinic draft
 * (coarse) and like the hand-checked reference in bench/flows/petclinic.yaml (fine), on the
 * invented forge-shop-ui; and a flow with no UI at all, on forge-payments.
 */

const SPECS = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/specs");
const NOW = new Date("2026-10-21T12:00:00Z");
const records = (): CatalogRecord[] =>
  ["catalog.yaml", "catalog-ui-api.yaml"].flatMap((f) =>
    (parse(readFileSync(join(SPECS, f), "utf8")) as unknown[]).map((r) => {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      return p.record;
    }),
  );
const answer = (f: string) => readFileSync(join(SPECS, "answers", f), "utf8");

async function draft(repoId: string, reply: string) {
  const prompts: string[] = [];
  const runtime = new MockRuntime(
    (req: AiRequest) => {
      prompts.push(req.pack.prompt);
      return reply;
    },
    { now: () => NOW },
  );
  const r = await draftSpec(fsRepo(repoId, join(SPECS, "repos", repoId), "0".repeat(40)), {
    repoId,
    runtime,
    records: records(),
    template: DEFAULT_SPEC_TEMPLATE,
    maxAttempts: 1,
    now: NOW,
  });
  return { r, prompts };
}

describe("atticus spec draft asks for the steps a person draws (ADR 0089)", () => {
  it("tells the assistant where UI and API flows start and end, every validation layer and every transform", async () => {
    const { prompts } = await draft("forge-shop-ui", answer("forge-shop-ui.fine.yaml"));
    const p = prompts[0]!;
    expect(p).toContain("starts at the person's action in the component or template");
    expect(p).toContain("navigates, refreshes, shows the result or shows an error");
    expect(p).toContain("Its trigger.caller names who calls and the route in");
    expect(p).toContain("leave caller out and ask a person");
    expect(p).toContain("Every validation layer is its own validate step");
    expect(p).toContain("A transform step wherever data crosses types");
    expect(p).toContain("usually 4 to 15");
  });

  it("keeps a coarse UI draft but reports where it starts and ends", async () => {
    const { r } = await draft("forge-shop-ui", answer("forge-shop-ui.coarse.yaml"));
    expect(r.flows.map((f) => f.id)).toEqual(["forge-shop-ui.place-order"]);
    expect(r.advisory.map((a) => a.rule)).toEqual(["ui-start-not-action", "ui-end-missing"]);
  });

  it("reports nothing on a fine UI draft", async () => {
    const { r } = await draft("forge-shop-ui", answer("forge-shop-ui.fine.yaml"));
    expect(r.status).toBe("drafted");
    expect(r.advisory).toEqual([]);
    expect(r.flows[0]!.steps.map((s) => s.kind)).toEqual([
      "validate",
      "transform",
      "call-out",
      "respond",
    ]);
  });

  it("keeps an API-started flow on its first attempt, then: 404 and all, with its caller and no UI asked for", async () => {
    const { r } = await draft("forge-payments", answer("forge-payments.yaml"));
    expect(r.status).toBe("drafted");
    expect(r.attempts).toHaveLength(1);
    expect(r.failed).toEqual([]);
    expect(r.advisory).toEqual([]);
    const f = r.flows[0]!;
    expect(f.errors[0]!.then).toBe("404");
    expect(f.trigger.caller).toEqual({
      who: "Northwind Pay",
      via: "the external API gateway, route northwind-settlements (POST /partners/northwind/settlements)",
      evidence: [{ source: "code", repo: "forge-payments", path: "gateway/routes.yaml", line: 4 }],
    });
    expect(f.steps.map((s) => s.kind)).toEqual([
      "entry",
      "validate",
      "lookup",
      "transform",
      "call-out",
      "call-out",
      "transform",
      "validate",
      "write",
      "respond",
    ]);
  });

  it("reports a coarse API draft's unknown caller and its field from nowhere, and no UI rule", async () => {
    const { r } = await draft("forge-payments", answer("forge-payments.coarse.yaml"));
    expect(r.advisory.map((a) => a.rule)).toEqual(["caller-unknown", "field-from-nowhere"]);
  });

  it("doesn't report the caller as unknown when the same answer asks a person who calls", async () => {
    const asks = `${answer("forge-payments.coarse.yaml")}
questions:
  - question: Who calls POST /payments/settlements, and through which gateway?
    evidence: ["src/main/java/forge/payments/SettlementController.java:11"]
`;
    const { r } = await draft("forge-payments", asks);
    expect(r.advisory.map((a) => a.rule)).toEqual(["field-from-nowhere"]);
    expect(r.questions).toHaveLength(1);
  });
});
