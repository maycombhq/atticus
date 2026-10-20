import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockRuntime } from "@maycombhq/ai";
import { fsRepo } from "@maycombhq/sdk";
import { draftDialect, KIT_DIR, surveyForOnboarding } from "../src/index.js";

const GW = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/gateways");
const kong = () => fsRepo("gw-kong", join(GW, "repos/gw-kong"), "0".repeat(40));
const NOW = new Date("2026-10-19T12:00:00Z");
/** The reference Kong dialect, as an assistant would reply with it, under another name. */
const reference = readFileSync(
  join(GW, "metarepo/org-pack/dialects/tide-kong.yaml"),
  "utf8",
).replace("name: tide-kong", "name: kong-gw");

describe("onboarding a repo Atticus can't read (ADR 0059)", () => {
  it("surveys what is read already and the structured files nothing reads", async () => {
    const s = await surveyForOnboarding(kong());
    expect(s.text).toContain("What Atticus already reads here: nothing.");
    expect(s.text).toContain("Structured files nothing reads (1): kong/kong.yml.");
    expect(s.files.map((f) => f.path)).toEqual(["kong/kong.yml"]);
  });

  it("hands what was wrong back to the assistant, and keeps the draft that passes", async () => {
    const prompts: string[] = [];
    const replies = [
      // A first draft whose test expects the wrong path.
      reference.replace("basepath: /orders\n", "basepath: /order\n"),
      "```yaml\n" + reference + "```\n",
    ];
    const runtime = new MockRuntime(
      (req) => {
        prompts.push(req.pack.prompt);
        return replies[prompts.length - 1]!;
      },
      { now: () => NOW },
    );
    const r = await draftDialect(kong(), { name: "kong-gw", runtime, now: NOW });
    expect(r.status).toBe("drafted");
    expect(r.attempts.map((a) => [a.attempt, a.state, a.problems])).toEqual([
      [
        1,
        "failed",
        [
          'test "two paths of one route, each a route to the service": kong-orders-public-orders.basepath: expected "/order", got "/orders"',
        ],
      ],
      [2, "drafted", []],
    ]);
    expect(r.records).toEqual([
      "GatewayRoute kong-ledger-public-ledger",
      "GatewayRoute kong-ledger-public-ledger-v1",
      "GatewayRoute kong-status-status",
    ]);
    expect(r.yaml).toBe(reference.endsWith("\n") ? reference : `${reference}\n`);
    // The first prompt has the kit and the repo; the second also the failed draft and its problems.
    expect(prompts[0]).toContain("# Dialect file reference (contract C2)");
    expect(prompts[0]).toContain("kong/kong.yml");
    expect(prompts[1]).toContain("The draft above failed these checks. Fix every one:");
    expect(prompts[1]).toContain('expected "/order", got "/orders"');
  });

  it("gives up after the last attempt, saying what was still wrong", async () => {
    const runtime = new MockRuntime(() => "name: [not, a, dialect", { now: () => NOW });
    const r = await draftDialect(kong(), { name: "kong-gw", runtime, maxAttempts: 2, now: NOW });
    expect(r.status).toBe("failed");
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[1]!.problems[0]).toMatch(/^not YAML/);
  });

  it("refuses a draft that names another dialect, uses code, or reads nothing in the repo", async () => {
    const wrong = reference
      .replace("name: kong-gw", "name: other")
      .replace(
        'files: ["**/kong.yml", "**/kong.yaml", "**/kong/*.yml", "**/kong/*.yaml"]',
        'files: ["**/nothing.yml"]',
      );
    const r = await draftDialect(kong(), {
      name: "kong-gw",
      runtime: new MockRuntime(() => wrong, { now: () => NOW }),
      maxAttempts: 1,
      now: NOW,
    });
    expect(r.attempts[0]!.problems).toContain("name is other; it must be kong-gw");
    expect(r.attempts[0]!.problems).toContain("on gw-kong, it produces nothing");
  });

  it("ships the reference gateway dialects as the kit's worked examples, unchanged", () => {
    for (const f of ["tide-apigee.yaml", "tide-kong.yaml", "tide-apim.yaml"])
      expect(readFileSync(join(KIT_DIR, "examples", f), "utf8")).toBe(
        readFileSync(join(GW, "metarepo/org-pack/dialects", f), "utf8"),
      );
  });
});
