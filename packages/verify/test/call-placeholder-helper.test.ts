import { describe, expect, it } from "vitest";
import { Fact } from "@maycombhq/core";
import { verifyFacts, type FileSource } from "../src/index.js";

/**
 * Beta.24 review: a call whose path is a setting's placeholder a helper puts together
 * (`${forge-remote.uris.createWallet}` from a `@ConfigurationProperties` prefix, a map field and
 * the name a lookup passes) is kept only when the cited line is code that names the key's last
 * segment, and the rest of the key is a real nesting path proven in one place: a YAML file whose
 * lines nest the parts, a properties line writing the whole key, or the class's
 * `@ConfigurationProperties` prefix and its field. A settings file's own line is never a call.
 */

const C = "c7c0001";
const Y = "src/main/resources/application.yml";
const P = "src/main/resources/application.properties";
const CLIENT = "src/main/java/forge/wallets/Client.java";
const REMOTE = "src/main/java/forge/wallets/Remote.java";
const FILES: Record<string, string> = {
  [Y]: [
    "forge-remote:", // 1
    "  uris:", // 2
    "    createWallet: /v1/wallets", // 3
    "other:", // 4
    "  deleteWallet: /v1/purge", // 5
    "  uris:", // 6
    "    payout: /v1/payouts", // 7
  ].join("\n"),
  [P]: ["# no code calls this", "forge-remote.uris.createWallet=/v1/wallets"].join("\n"),
  [CLIENT]: [
    "class Client {", // 1
    "  int x = 1;", // 2
    '  Object create() { return http.post(remote.url("createWallet")); }', // 3
    '  // Object old() { return http.post(remote.url("createWallet")); }', // 4
    '  Object pay() { return http.post(remote.url("payout")); }', // 5
    '  Object low() { return http.post(remote.url("createwallet")); }', // 6
    "}",
  ].join("\n"),
  [REMOTE]: [
    '@ConfigurationProperties(prefix = "forge-remote")',
    "record Remote(String host, Map<String, String> uris) {}",
  ].join("\n"),
};
const source: FileSource = { list: () => Object.keys(FILES), read: (p) => FILES[p] };

type Part = { file: string; line: number; value: string };
const call = (id: string, path: string, cite: Record<string, unknown>, method = "POST"): Fact =>
  Fact.parse({
    kind: "call",
    id,
    repo: "forge-wallets",
    commit: C,
    callType: "rest",
    method,
    path,
    base: "forge-remote",
    cite,
    verified: "line",
    by: "assistant",
    conf: "declared",
  });
const run = async (f: Fact) => {
  const r = await verifyFacts({ facts: [f], source, commit: C });
  return r.rejected.map((x) => x.code);
};
const at = (line: number, withParts: Part[]) => ({
  file: CLIENT,
  line,
  value: "createWallet",
  quote: FILES[CLIENT]!.split("\n")[line - 1],
  with: withParts,
});
const classParts: Part[] = [
  { file: REMOTE, line: 1, value: "forge-remote" },
  { file: REMOTE, line: 2, value: "uris" },
];
const yamlParts: Part[] = [
  { file: Y, line: 1, value: "forge-remote" },
  { file: Y, line: 2, value: "uris" },
];

describe("a placeholder a helper puts together: what proves it", () => {
  it("keeps the helper's call with the class's prefix and field", async () => {
    expect(
      await run(call("call.ok-class", "${forge-remote.uris.createWallet}", at(3, classParts))),
    ).toEqual([]);
  });

  it("keeps the helper's call with the YAML lines that nest the key", async () => {
    expect(
      await run(call("call.ok-yaml", "${forge-remote.uris.createWallet}", at(3, yamlParts))),
    ).toEqual([]);
  });

  it("keeps the helper's call with the properties line that writes the whole key", async () => {
    const parts = [{ file: P, line: 2, value: "forge-remote.uris.createWallet" }];
    expect(
      await run(call("call.ok-props", "${forge-remote.uris.createWallet}", at(3, parts))),
    ).toEqual([]);
  });

  it("rejects a call cited only on the settings line that defines the key, whatever its method (s4)", async () => {
    const f = call(
      "call.p",
      "${forge-remote.uris.createWallet}",
      {
        file: P,
        line: 2,
        value: "forge-remote.uris.createWallet",
        quote: "forge-remote.uris.createWallet=/v1/wallets",
      },
      "DELETE",
    );
    expect(await run(f)).toEqual(["claim-not-on-line"]);
  });

  it("rejects a call cited on YAML lines, the key under another parent (s1 A)", async () => {
    const f = call("call.a", "${forge-remote.uris.deleteWallet}", {
      file: Y,
      line: 5,
      value: "deleteWallet",
      quote: "  deleteWallet: /v1/purge",
      with: yamlParts,
    });
    expect(await run(f)).toEqual(["claim-not-on-line"]);
  });

  it("rejects a call whose cited line makes no call, every piece a part (s1 B)", async () => {
    const parts = [...yamlParts, { file: Y, line: 3, value: "createWallet" }];
    expect(await run(call("call.b", "${forge-remote.uris.createWallet}", at(2, parts)))).toEqual([
      "claim-not-on-line",
    ]);
  });

  it("rejects an invented key cited on a settings line (s1 E)", async () => {
    const f = call("call.e", "${forge-remote.uris.payout}", {
      file: Y,
      line: 3,
      value: "createWallet",
      quote: "    createWallet: /v1/wallets",
      with: yamlParts,
    });
    expect(await run(f)).toEqual(["claim-not-on-line"]);
  });

  it("rejects a key whose nesting no one file shows: payout is under other.uris, not forge-remote.uris", async () => {
    const parts = [
      { file: Y, line: 1, value: "forge-remote" },
      { file: Y, line: 6, value: "uris" },
    ];
    expect(
      await run(
        call("call.nest", "${forge-remote.uris.payout}", { ...at(5, parts), value: "payout" }),
      ),
    ).toEqual(["claim-not-on-line"]);
  });

  it("rejects a hyphenated segment put together from unrelated lines (s1 F)", async () => {
    const parts = [
      { file: CLIENT, line: 1, value: "Client" },
      { file: Y, line: 1, value: "forge-remote" },
      { file: Y, line: 2, value: "uris" },
    ];
    const f = call("call.f", "${forge-remote.uris.createWallet}", {
      file: Y,
      line: 3,
      value: "createWallet",
      quote: "    createWallet: /v1/wallets",
      with: parts,
    });
    expect(await run(f)).toEqual(["claim-not-on-line"]);
  });

  it("rejects parts spread over two files, neither proving the nesting", async () => {
    const parts = [
      { file: REMOTE, line: 1, value: "forge-remote" },
      { file: Y, line: 6, value: "uris" },
    ];
    expect(
      await run(call("call.split", "${forge-remote.uris.createWallet}", at(3, parts))),
    ).toEqual(["claim-not-on-line"]);
  });

  it("matches the key's last segment in its own case", async () => {
    expect(
      await run(
        call("call.case", "${forge-remote.uris.createWallet}", {
          ...at(6, classParts),
          value: "createwallet",
        }),
      ),
    ).toEqual(["claim-not-on-line"]);
  });

  it("rejects a commented-out helper call (s2)", async () => {
    expect(
      await run(call("call.c", "${forge-remote.uris.createWallet}", at(4, classParts))),
    ).toEqual(["claim-in-comment"]);
  });
});
