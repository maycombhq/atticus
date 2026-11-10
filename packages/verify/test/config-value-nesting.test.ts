import { describe, expect, it } from "vitest";
import { Fact } from "@maycombhq/core";
import { verifyFacts, type FileSource } from "../src/index.js";

/**
 * Beta.24 review: a config fact's `value` is what its line sets, and its dotted key is where the
 * line sits: a YAML key under the parents the key names, a properties key that ends with it, a
 * deploy tool's token whose XPath and value are in one token object of the bundle's config.json.
 * The join puts the value into the catalog, so an unchecked one would be an invented setting.
 */

const C = "c7c0001";
const Y = "src/main/resources/application.yml";
const P = "src/main/resources/application.properties";
const J = "config.json";
const FILES: Record<string, string> = {
  [Y]: [
    "forge-remote:", // 1
    "  uris:", // 2
    "    createWallet: /v1/wallets", // 3
    "other:", // 4
    "  deleteWallet: /v1/purge", // 5
    "containers:", // 6
    "  - name: app", // 7
    "    livenessProbe:", // 8
    "      httpGet:", // 9
    "        path: '/health'", // 10
  ].join("\n"),
  [P]: ["other.deleteWallet=/v1/purge", "forge-remote.uris.createWallet = /v1/wallets"].join("\n"),
  [J]: [
    "{", // 1
    '  "configurations": [', // 2
    "    {", // 3
    '      "name": "prod",', // 4
    '      "targets": [', // 5
    "        {", // 6
    '          "name": "TE-Northwind.xml",', // 7
    '          "tokens": [', // 8
    "            {", // 9
    '              "xpath": "/TargetEndpoint/HTTPTargetConnection/URL",', // 10
    '              "value": "https://api.northwind.example/v1"', // 11
    "            },", // 12
    "            {", // 13
    '              "xpath": "/TargetEndpoint/HTTPTargetConnection/Path",', // 14
    '              "value": "/v2"', // 15
    "            }", // 16
    "          ]", // 17
    "        }", // 18
    "      ]", // 19
    "    }", // 20
    "  ]", // 21
    "}", // 22
  ].join("\n"),
  "apiproxy/targets/TE-Northwind.xml": '<TargetEndpoint name="TE-Northwind"/>',
  "other/config.json": [
    '{ "xpath": "/TargetEndpoint/HTTPTargetConnection/URL", "value": "https://x.example" }',
  ].join("\n"),
};
const source: FileSource = { list: () => Object.keys(FILES), read: (p) => FILES[p] };
const cfg = (
  id: string,
  key: string,
  value: string,
  file: string,
  line: number,
  extra: Record<string, unknown> = {},
) =>
  Fact.parse({
    kind: "config",
    id,
    repo: "forge-wallets",
    commit: C,
    key,
    value,
    cite: {
      file,
      line,
      value: key.split(/[./]/).pop(),
      quote: FILES[file]!.split("\n")[line - 1],
      ...extra,
    },
    verified: "line",
    by: "assistant",
    conf: "declared",
  });
const run = async (f: Fact) => {
  const r = await verifyFacts({ facts: [f], source, commit: C });
  return r.rejected.map((x) => x.code);
};

describe("a config fact's value and nesting are checked on its line", () => {
  it("keeps a YAML key under its parents with the value its line sets", async () => {
    expect(
      await run(cfg("config.ok", "forge-remote.uris.createWallet", "/v1/wallets", Y, 3)),
    ).toEqual([]);
    expect(await run(cfg("config.k8s", "livenessProbe.httpGet.path", "/health", Y, 10))).toEqual(
      [],
    );
    expect(await run(cfg("config.short", "createWallet", "/v1/wallets", Y, 3))).toEqual([]);
  });

  it("rejects a value its line doesn't set (s1 C)", async () => {
    expect(await run(cfg("config.c", "forge-remote.uris.createWallet", "/v9/steal", Y, 3))).toEqual(
      ["claim-not-on-line"],
    );
  });

  it("rejects a key under the wrong parent (s1 D)", async () => {
    expect(await run(cfg("config.d", "forge-remote.uris.deleteWallet", "/v1/purge", Y, 5))).toEqual(
      ["claim-not-on-line"],
    );
  });

  it("checks a properties key ends with the fact's key", async () => {
    expect(await run(cfg("config.p-ok", "uris.createWallet", "/v1/wallets", P, 2))).toEqual([]);
    expect(
      await run(cfg("config.p-bad", "forge-remote.uris.deleteWallet", "/v1/purge", P, 1)),
    ).toEqual(["claim-not-on-line"]);
  });

  it("keeps a deploy tool's token whose XPath and value share a token object", async () => {
    expect(
      await run(
        cfg(
          "config.tok",
          "/TargetEndpoint/HTTPTargetConnection/URL",
          "https://api.northwind.example/v1",
          J,
          10,
        ),
      ),
    ).toEqual([]);
  });

  it("rejects a token value from another token object, or a config.json of no bundle", async () => {
    expect(
      await run(cfg("config.tok-other", "/TargetEndpoint/HTTPTargetConnection/URL", "/v2", J, 10)),
    ).toEqual(["claim-not-on-line"]);
    expect(
      await run(
        cfg(
          "config.tok-invented",
          "/TargetEndpoint/HTTPTargetConnection/URL",
          "https://evil.example",
          J,
          10,
        ),
      ),
    ).toEqual(["claim-not-on-line"]);
    expect(
      await run(
        cfg(
          "config.tok-nested",
          "/TargetEndpoint/HTTPTargetConnection/URL",
          "https://x.example",
          "other/config.json",
          1,
        ),
      ),
    ).toEqual(["claim-not-on-line"]);
  });
});
