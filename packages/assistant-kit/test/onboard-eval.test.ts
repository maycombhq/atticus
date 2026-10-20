import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockRuntime } from "@maycombhq/ai";
import { evalOnboarding, formatEval, loadEvalCases } from "../src/index.js";

const EVAL = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/onboard-eval");
const NOW = new Date("2026-10-20T12:00:00Z");

describe("the onboarding evaluation (ADR 0059)", () => {
  it("scores a draft by what it reads from the repo, and a reference-quality draft is exact", async () => {
    const cases = await loadEvalCases(EVAL);
    expect(cases.map((c) => c.name)).toEqual([
      "apigee",
      "apim",
      "argocd",
      "aws-apigw",
      "harbor-kit",
      "harness",
      "house-gateway",
      "house-http",
      "kong",
      "tekton",
      "tf-topics",
    ]);
    const refOf = new Map(cases.map((c) => [`eval-${c.name}`, readFileSync(c.reference, "utf8")]));
    const runtime = new MockRuntime(
      (req) => {
        const name = /Name it `(eval-[a-z0-9-]+)`/.exec(req.pack.prompt)![1]!;
        return refOf.get(name)!.replace(/^name: .*$/m, `name: ${name}`);
      },
      { now: () => NOW },
    );
    const results = await evalOnboarding(cases, { runtime, now: NOW });
    expect(results.map((r) => [r.case, r.status, r.precision, r.recall, r.expected > 0])).toEqual(
      cases.map((c) => [c.name, "drafted", 1, 1, true]),
    );
    expect(formatEval(results).at(-1)).toBe(
      "11 of 11 cases read exactly what the reference reads.",
    );
  }, 300_000);

  it("marks down a draft that reads less than the reference", async () => {
    const [kong] = (await loadEvalCases(EVAL)).filter((c) => c.name === "kong");
    const partial = readFileSync(kong!.reference, "utf8")
      .replace(/^name: .*$/m, "name: eval-kong")
      // Only each route's first path: the second path of a route is missed.
      .replace(
        'jsonPath: "$.services[*].routes[*].paths[*]"',
        'jsonPath: "$.services[*].routes[*].paths[0]"',
      )
      .replace(/ {6}- kind: GatewayRoute\n {8}id: kong-orders-public-orders-v1\n(?: {8}.*\n)*/, "");
    const [r] = await evalOnboarding([kong!], {
      runtime: new MockRuntime(() => partial, { now: () => NOW }),
      now: NOW,
    });
    expect([r!.status, r!.matched, r!.expected, r!.precision]).toEqual(["drafted", 2, 3, 1]);
    expect(r!.missing).toEqual([
      'GatewayRoute basepath="/ledger-v1" target="http://ledger.tide.internal:8080/api"',
    ]);
  }, 300_000);

  it("grades a framework draft by what it adds to the repos that use it (ADR 0066)", async () => {
    const [harbor] = (await loadEvalCases(EVAL)).filter((c) => c.name === "harbor-kit");
    expect(harbor!.kind).toBe("framework");
    const answer = readFileSync(join(EVAL, "harbor-kit/assistant-reply.yaml"), "utf8").replace(
      /^name: .*$/m,
      "name: eval-harbor-kit",
    );
    const [exact] = await evalOnboarding([harbor!], {
      runtime: new MockRuntime(() => answer, { now: () => NOW }),
      now: NOW,
    });
    expect([exact!.status, exact!.precision, exact!.recall, exact!.expected]).toEqual([
      "drafted",
      1,
      1,
      7,
    ]);
    // Without the shared-library step, the pipelines read as before: recall drops, precision doesn't.
    const noStep = answer.replace(/pipeline:\n(?: {2}.*\n)+/, "");
    const [partial] = await evalOnboarding([harbor!], {
      runtime: new MockRuntime(() => noStep, { now: () => NOW }),
      now: NOW,
    });
    expect([partial!.status, partial!.matched, partial!.expected, partial!.precision]).toEqual([
      "drafted",
      5,
      7,
      1,
    ]);
    expect(partial!.missing.map((m) => m.split(" ").slice(0, 2).join(" "))).toEqual([
      "harbor-billing: QualityAsset",
      "harbor-orders: QualityAsset",
    ]);
  }, 300_000);
});
