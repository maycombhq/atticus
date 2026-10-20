import { describe, expect, it } from "vitest";
import { FrameworkModel } from "@maycombhq/core";
import { runFrameworkTests } from "../src/index.js";

const doc = { kind: "document" as const, ref: "assistant draft" };
const base = {
  schemaVersion: 1,
  name: "lantern",
  packages: ["@tide/lantern"],
  calls: [
    {
      function: "call",
      receiver: "lantern",
      service: { arg: 0 },
      httpMethod: { arg: 1 },
      path: { arg: 2 },
      source: doc,
    },
  ],
  routes: [
    {
      function: "defineRoute",
      httpMethod: { arg: 0, key: "method" },
      path: { arg: 0, key: "path" },
      source: doc,
    },
  ],
  services: { cards: { value: "https://cards.tide.internal", source: doc } },
};
const sample = {
  "src/a.ts": `import { lantern, defineRoute } from "@tide/lantern";
lantern.call("cards", "GET", "/cards/1");
defineRoute({ method: "POST", path: "/limits", handler: h });`,
};

describe("framework model tests: what makes an assistant's draft safe to load", () => {
  it("pass when every expected record comes out and every entry is exercised", async () => {
    const m = FrameworkModel.parse({
      ...base,
      tests: [
        {
          name: "a call and a route",
          files: sample,
          expect: [
            "http-call GET https://cards.tide.internal/cards/1",
            "endpoint POST /limits inferred",
          ],
        },
      ],
    });
    expect(await runFrameworkTests(m)).toEqual([]);
  });

  it("fail on a missing record, and on an entry no test exercises", async () => {
    const m = FrameworkModel.parse({
      ...base,
      routes: [
        ...base.routes,
        {
          function: "mount",
          receiver: "app",
          httpMethod: { value: "GET" },
          path: { arg: 0 },
          source: doc,
        },
      ],
      tests: [
        {
          name: "a call and a route",
          files: sample,
          expect: [
            "http-call GET https://cards.tide.internal/cards/1",
            "endpoint GET /nope inferred",
          ],
        },
      ],
    });
    expect(await runFrameworkTests(m)).toEqual([
      {
        test: "a call and a route",
        message:
          'expected "endpoint GET /nope inferred"; got: endpoint POST /limits inferred, http-call GET https://cards.tide.internal/cards/1',
      },
      { test: "(coverage)", message: "routes mount isn't exercised by any test" },
    ]);
  });

  it("let an endpoint line leave out its confidence, and don't ask tests of what code gave", async () => {
    const m = FrameworkModel.parse({
      ...base,
      routes: [
        ...base.routes,
        {
          function: "mount",
          receiver: "app",
          httpMethod: { value: "GET" },
          path: { arg: 0 },
          source: { kind: "code" },
        },
      ],
      tests: [
        {
          name: "a call and a route",
          files: sample,
          expect: ["http-call GET https://cards.tide.internal/cards/1", "endpoint POST /limits"],
        },
      ],
    });
    expect(await runFrameworkTests(m)).toEqual([]);
  });

  it("fail on a record the test doesn't expect", async () => {
    const m = FrameworkModel.parse({
      ...base,
      tests: [
        {
          name: "a call and a route",
          files: sample,
          expect: ["http-call GET https://cards.tide.internal/cards/1"],
        },
      ],
    });
    expect(await runFrameworkTests(m)).toEqual([
      {
        test: "a call and a route",
        message: `gave "endpoint POST /limits inferred", which the test doesn't expect`,
      },
    ]);
  });
});
