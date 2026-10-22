import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DEFAULT_SPEC_TEMPLATE,
  parseRecord,
  SpecTemplate,
  type CatalogRecord,
  type FlowRecord,
} from "@maycombhq/core";
import { fsRepo } from "@maycombhq/sdk";
import { checkSpec, lineNamesUiWord } from "../src/spec-check.js";

/**
 * ADR 0089: the critic asks for the steps a person draws. A UI flow starts at the person's
 * action and ends with what the screen does next; an entry point's flow names its caller; a
 * field used without an origin points at a missing transform.
 */

const SPECS = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/specs");
const records = (): CatalogRecord[] =>
  ["catalog.yaml", "catalog-ui-api.yaml"].flatMap((f) =>
    (parse(readFileSync(join(SPECS, f), "utf8")) as unknown[]).map((r) => {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      return p.record;
    }),
  );

type At = string | string[];
const evidence = (repo: string, a: At | undefined) =>
  (a === undefined ? [] : Array.isArray(a) ? a : [a]).map((s) => {
    const cut = s.lastIndexOf(":");
    return { source: "code", repo, path: s.slice(0, cut), line: Number(s.slice(cut + 1)) };
  });

/** The flows of an answer file, as the drafter turns them into records. */
function flowsOf(answer: string, repo: string): FlowRecord[] {
  type Cited = { at: At } & Record<string, unknown>;
  const doc = parse(readFileSync(join(SPECS, "answers", answer), "utf8")) as {
    flows: {
      id: string;
      component: string;
      name: string;
      family?: string[];
      trigger: Cited & { caller?: { who: string; via?: string; at?: At } };
      steps: Cited[];
      errors?: Cited[];
    }[];
  };
  return doc.flows.map((f) => {
    const { at, caller, ...trigger } = f.trigger;
    const r = parseRecord({
      kind: "Flow",
      schemaVersion: 1,
      id: `${f.component}.${f.id}`,
      component: f.component,
      name: f.name,
      template: "default@1",
      family: f.family ?? [],
      trigger: {
        ...trigger,
        evidence: evidence(repo, at),
        ...(caller
          ? {
              caller: {
                who: caller.who,
                ...(caller.via ? { via: caller.via } : {}),
                evidence: evidence(repo, caller.at),
              },
            }
          : {}),
      },
      steps: f.steps.map(({ at: a, ...s }) => ({
        ...s,
        evidence: evidence(repo, a),
      })),
      errors: (f.errors ?? []).map(({ at: a, ...e }) => ({
        ...e,
        evidence: evidence(repo, a),
      })),
    });
    if (!r.ok || r.record.kind !== "Flow") throw new Error(JSON.stringify(r));
    return r.record;
  });
}

const check = (repo: string, answer: string, o: { questions?: { evidence: string[] }[] } = {}) =>
  checkSpec({
    repo: fsRepo(repo, join(SPECS, "repos", repo), "0".repeat(40)),
    repoId: repo,
    flows: flowsOf(answer, repo),
    records: records(),
    template: DEFAULT_SPEC_TEMPLATE,
    ...o,
  });
const rules = (r: Awaited<ReturnType<typeof check>>) => r.findings.map((f) => f.rule);

describe("the critic on a UI flow (ADR 0089)", () => {
  it("flags a coarse draft that starts at the service and ends at the call", async () => {
    const r = await check("forge-shop-ui", "forge-shop-ui.coarse.yaml");
    expect(r.findings.map((f) => [f.rule, f.evidence, f.message])).toEqual([
      [
        "ui-start-not-action",
        "src/app/orders/order.service.ts:16",
        "forge-shop-ui.place-order starts at src/app/orders/order.service.ts:16, where the call to the server is made, not at the person's action: start it at the button or form in the component or template, with a validate step for the form's own checks and a transform where the form's value becomes what is sent",
      ],
      [
        "ui-end-missing",
        "src/app/orders/order.service.ts:18",
        "forge-shop-ui.place-order ends at the call in step 2 and what goes back from it, not at what the screen does after the response: add a last step citing the line that navigates, refreshes, shows the result or shows an error",
      ],
    ]);
  });

  it("passes a fine draft that starts at the form and ends with the navigation", async () => {
    const r = await check("forge-shop-ui", "forge-shop-ui.fine.yaml");
    expect(r.findings).toEqual([]);
  });

  it("reads a page or action word where a word or a camelCase part starts, as the template lists", () => {
    const w = DEFAULT_SPEC_TEMPLATE.ui.actionWords;
    expect(lineNamesUiWord('<form (ngSubmit)="onSubmit(f.value)">', w)).toBe(true);
    expect(lineNamesUiWord("<Button onClick={save}>", w)).toBe(true);
    expect(lineNamesUiWord("const transformed = transform(x);", w)).toBe(false);
    expect(lineNamesUiWord("addOrder(order: Order): Observable<Order> {", w)).toBe(false);
  });

  it("uses an org pack's own UI words", async () => {
    const own = SpecTemplate.parse({
      ...DEFAULT_SPEC_TEMPLATE,
      repoType: "forge-ui",
      ui: { actionWords: ["addorder"], endWords: ["http"] },
    });
    const r = await checkSpec({
      repo: fsRepo("forge-shop-ui", join(SPECS, "repos", "forge-shop-ui"), "0".repeat(40)),
      repoId: "forge-shop-ui",
      flows: flowsOf("forge-shop-ui.coarse.yaml", "forge-shop-ui"),
      records: records(),
      template: own,
    });
    expect(r.findings).toEqual([]);
  });
});

describe("the critic on a flow an external system starts (ADR 0089)", () => {
  it("passes a complete API-started flow, with its caller and gateway, and never asks for a UI", async () => {
    const r = await check("forge-payments", "forge-payments.yaml");
    expect(r.findings).toEqual([]);
    expect(r.flows[0]!.trigger.caller).toMatchObject({ who: "Northwind Pay" });
    expect(r.flows[0]!.errors[0]!.then).toBe("404");
    expect(r.flows[0]!.steps.filter((s) => s.confirmedBy === "check").map((s) => s.kind)).toEqual([
      "entry",
      "lookup",
      "call-out",
      "call-out",
      "write",
    ]);
  });

  it("says who calls is unknown and points a field from nowhere at a missing transform", async () => {
    const r = await check("forge-payments", "forge-payments.coarse.yaml");
    expect(rules(r)).toEqual(["caller-unknown", "field-from-nowhere"]);
    expect(r.findings[0]!.message).toBe(
      "forge-payments.settle: nothing says who calls POST /payments/settlements or how the call arrives (through a gateway, or direct); name them in trigger.caller where the code or config says so, else ask a person",
    );
    expect(r.findings[1]!.message).toBe(
      "forge-payments.settle step 3 (call-out) uses accountId, which no earlier step or the trigger names; where it comes from another field (a form value, a request, a DTO, an entity), add a transform step before it that maps one to the other in data.from and data.to",
    );
  });

  it("doesn't say the caller is unknown once a question about the trigger is on file", async () => {
    const r = await check("forge-payments", "forge-payments.coarse.yaml", {
      questions: [{ evidence: ["src/main/java/forge/payments/SettlementController.java:11"] }],
    });
    expect(rules(r)).toEqual(["field-from-nowhere"]);
  });

  it("names the caller the catalog's interfaces show, so the next draft writes it and no person is asked", async () => {
    const call = parseRecord({
      kind: "Interface",
      schemaVersion: 2,
      id: "if-ac88cbc62e928d02",
      status: "current",
      confidence: "verified",
      evidence: [
        {
          source: "code",
          repo: "forge-shop-ui",
          path: "src/app/orders/order.service.ts",
          line: 18,
        },
      ],
      from: "forge-shop-ui",
      to: "forge-payments",
      endpoint: "forge-payments.post-payments-settlements",
      method: "POST",
      normalizedPath: "/payments/settlements",
      direction: "outbound",
      sync: "sync",
      via: "direct",
    });
    if (!call.ok) throw new Error(JSON.stringify(call.issues));
    const r = await checkSpec({
      repo: fsRepo("forge-payments", join(SPECS, "repos", "forge-payments"), "0".repeat(40)),
      repoId: "forge-payments",
      flows: flowsOf("forge-payments.coarse.yaml", "forge-payments"),
      records: [...records(), call.record],
      template: DEFAULT_SPEC_TEMPLATE,
      // Even with a question on file, the catalog's caller is named.
      questions: [{ evidence: ["src/main/java/forge/payments/SettlementController.java:11"] }],
    });
    const f = r.findings.find((x) => x.rule === "caller-unknown")!;
    expect(f.message).toBe(
      "forge-payments.settle: trigger.caller is missing, and the catalog has forge-shop-ui (if-ac88cbc62e928d02, direct) calling POST /payments/settlements: name the caller and its route in, in trigger.caller",
    );
    expect(f.callers).toEqual(["forge-shop-ui (if-ac88cbc62e928d02, direct)"]);
  });

  it("checks the caller's citation and catalog id", async () => {
    const [f] = flowsOf("forge-payments.yaml", "forge-payments");
    const r = await checkSpec({
      repo: fsRepo("forge-payments", join(SPECS, "repos", "forge-payments"), "0".repeat(40)),
      repoId: "forge-payments",
      flows: [
        {
          ...f!,
          trigger: {
            ...f!.trigger,
            caller: {
              who: "Northwind Pay",
              ref: "northwind-pay",
              evidence: [
                { source: "code", repo: "forge-payments", path: "gateway/routes.yaml", line: 40 },
              ],
            },
          },
        },
      ],
      records: records(),
      template: DEFAULT_SPEC_TEMPLATE,
    });
    expect(rules(r)).toEqual(["line-missing", "ref-unknown"]);
  });
});

describe("the critic on a loop or retry (ADR 0095)", () => {
  /** forge-payments' settle flow, with a retry of the ledger call (step 5) added at its end. */
  const withRetry = (repeats?: { from: number; to: number }) => {
    const [f] = flowsOf("forge-payments.yaml", "forge-payments");
    const at = f!.steps[4]!.evidence;
    return {
      ...f!,
      steps: [
        ...f!.steps,
        {
          kind: "retry" as const,
          what: "The ledger call is made again once when it times out",
          refs: [],
          evidence: at,
          ...(repeats ? { repeats } : {}),
        },
      ],
    };
  };
  const run = (flow: FlowRecord) =>
    checkSpec({
      repo: fsRepo("forge-payments", join(SPECS, "repos", "forge-payments"), "0".repeat(40)),
      repoId: "forge-payments",
      flows: [flow],
      records: records(),
      template: DEFAULT_SPEC_TEMPLATE,
    });

  it("asks a loop or retry which steps it repeats", async () => {
    const r = await run(withRetry());
    expect(r.findings.map((f) => [f.rule, f.message])).toEqual([
      [
        "template-requires",
        "forge-payments.settle step 11 (retry): the template default@1 asks a retry for repeats",
      ],
    ]);
  });

  it("passes a retry that names the steps it repeats", async () => {
    expect((await run(withRetry({ from: 5, to: 5 }))).findings).toEqual([]);
  });
});
