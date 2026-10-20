import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Dialect } from "@maycombhq/core";
import { memoryRepo, scanRepo } from "@maycombhq/sdk";
import { dialectExtractor, runDialectTests } from "../src/index.js";

const DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/gateways/metarepo/org-pack/dialects",
);
const load = (f: string) => Dialect.parse(parse(readFileSync(join(DIR, f), "utf8")));

describe("dialect rules v3 (ADR 0058)", () => {
  it.each(readdirSync(DIR))("the reference gateway dialect %s passes its own tests", async (f) => {
    expect(await runDialectTests(load(f), DIR)).toEqual([]);
  });

  it("leaves a lookup unknown when two rows give its key different values", async () => {
    const d = Dialect.parse({
      schemaVersion: 1,
      name: "t",
      version: "0.1.0",
      appliesTo: {},
      lookups: {
        hosts: {
          match: { jsonPath: "$[*]", files: ["servers/*.json"] },
          key: "${attr.name}",
          values: { host: "${attr.host}" },
        },
      },
      rules: [
        {
          id: "r",
          description: "A route to a named server.",
          match: { jsonPath: "$.routes[*]", files: ["routes.json"] },
          emit: [
            {
              kind: "GatewayRoute",
              id: "r-${attr.name}",
              fields: {
                proxy: "${attr.name}",
                basepath: "${attr.path}",
                target: "${lookup:hosts(attr.server).host}",
              },
            },
            {
              kind: "Setting",
              id: "s-${attr.name}",
              fields: {
                component: "gw",
                key: "route.${attr.name}",
                valueOrRef: "${attr.path}",
                settingKind: "config",
              },
            },
          ],
          confidence: "verified",
        },
      ],
      tests: [{ name: "t", files: {}, expect: [] }],
    });
    const s = await scanRepo({
      repo: memoryRepo("gw", "0".repeat(40), {
        "servers/a.json":
          '[{"name":"one","host":"one.example"},{"name":"two","host":"two.example"}]',
        "servers/b.json": '[{"name":"two","host":"two-other.example"}]',
        "routes.json":
          '{"routes":[{"name":"a","path":"/a","server":"one"},{"name":"b","path":"/b","server":"two"}]}',
      }),
      extractors: [dialectExtractor(d)],
      dialects: ["t"],
    });
    expect(s.rejected).toEqual([]);
    const got = s.records.map((r) => {
      const x = r as unknown as Record<string, unknown>;
      return `${r.kind} ${r.id} ${String(x.target ?? x.valueOrRef)}`;
    });
    // One match, two records; "two" has two hosts, so its target is left unset.
    expect(got.sort()).toEqual([
      "GatewayRoute r-a one.example",
      "GatewayRoute r-b undefined",
      "Setting s-a /a",
      "Setting s-b /b",
    ]);
  });
});
