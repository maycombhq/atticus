import { describe, expect, it } from "vitest";
import { type Fact } from "@maycombhq/core";
import { memorySource, verifyFacts } from "../src/index.js";

/**
 * The component fact (ADR 0180): what a component is, cited on the line that shows its signal,
 * one of the organisation's types, one per component. An invented Forge experience API.
 */
const source = memorySource({
  "package.json": [
    "{",
    '  "name": "forge-web-xp",',
    '  "dependencies": {',
    '    "@forge/experience-kit": "^3.1.0",',
    '    "express": "^4.19.0"',
    "  }",
    "}",
  ].join("\n"),
  "src/experience/home.ts": [
    'import { route } from "@forge/experience-kit";',
    'route.get("/v1/home", home);',
  ].join("\n"),
});
const fact = (id: string, kind: string, more: Record<string, unknown>): Fact =>
  ({
    id,
    kind,
    repo: "forge-web-xp",
    commit: "abc1234",
    verified: "none",
    by: "assistant",
    conf: "declared",
    ...more,
  }) as Fact;
const entry = fact("e1", "entry", {
  entryType: "rest",
  method: "GET",
  path: "/v1/home",
  cite: { file: "src/experience/home.ts", line: 2, value: "/v1/home" },
});
const typed = (patch: Record<string, unknown> = {}) =>
  fact("c1", "component", {
    type: "forge-experience-api",
    why: "built on the experience kit",
    cite: { file: "package.json", line: 4, value: "@forge/experience-kit" },
    ...patch,
  });
const TYPES = new Set(["service", "spa", "bff", "gateway", "forge-experience-api"]);
const codes = (r: Awaited<ReturnType<typeof verifyFacts>>) =>
  r.rejected.map((x) => [x.fact.id, x.code]);

describe("what a component is", () => {
  it("keeps a type cited on its signal's line, when the type is one of the organisation's", async () => {
    const r = await verifyFacts({
      facts: [entry, typed()],
      source,
      commit: "abc1234",
      componentTypes: TYPES,
    });
    expect(r.rejected).toEqual([]);
  });

  it("rejects a signal its line doesn't write, a type the organisation doesn't have, and a second fact for the same component", async () => {
    const wrongLine = await verifyFacts({
      facts: [
        entry,
        typed({ cite: { file: "src/experience/home.ts", line: 2, value: "@forge/nothing-kit" } }),
      ],
      source,
      commit: "abc1234",
      componentTypes: TYPES,
    });
    expect(codes(wrongLine)).toEqual([["c1", "claim-not-on-line"]]);
    const unknown = await verifyFacts({
      facts: [entry, typed({ type: "widget" })],
      source,
      commit: "abc1234",
      componentTypes: TYPES,
    });
    expect(codes(unknown)).toEqual([["c1", "component-type"]]);
    expect(unknown.rejected[0]!.message).toContain("org-pack/component-types/widget/type.yaml");
    // Without the set, the type isn't checked (a repo adopted in place with no org pack).
    expect(
      (await verifyFacts({ facts: [entry, typed({ type: "widget" })], source, commit: "abc1234" }))
        .rejected,
    ).toEqual([]);
    const twice = await verifyFacts({
      facts: [entry, typed(), { ...typed({ type: "bff" }), id: "c2" } as Fact],
      source,
      commit: "abc1234",
      componentTypes: TYPES,
    });
    expect(codes(twice)).toEqual([["c2", "component-type"]]);
    // A bad first fact doesn't take the good second one down with it; the subject is compared as
    // the projection names it (the repo when component is left out, in id form).
    const firstBad = await verifyFacts({
      facts: [
        entry,
        typed({ type: "widget" }),
        { ...typed({ type: "bff", component: "Forge Web XP" }), id: "c2" } as Fact,
      ],
      source,
      commit: "abc1234",
      componentTypes: TYPES,
    });
    expect(codes(firstBad)).toEqual([["c1", "component-type"]]);
  });
});
