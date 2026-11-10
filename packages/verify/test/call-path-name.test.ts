import { describe, expect, it } from "vitest";
import { Fact } from "@maycombhq/core";
import { pathIsAName, verifyFacts, type FileSource } from "../src/index.js";

/**
 * ADR 0172: a REST or SOAP call's `path` is a path, never the name of the variable, field or
 * method that holds it. A reader that records `refundPath` is sent back to follow it to the
 * literal, or to the setting's placeholder (`${forge.uris.refund}`) with the line that sets it.
 */

const FILES: Record<string, string> = {
  "src/main/java/forge/transfers/RefundClient.java": [
    "package forge.transfers;",
    "",
    "class RefundClient {",
    '  @Value("${forge-remote.uris.refund}")',
    "  private String refundPath;",
    "",
    "  Object refund(Object body) {",
    "    return retryer.exchange(postUri(refundPath), HttpMethod.POST, body);",
    "  }",
    "}",
  ].join("\n"),
};
const source: FileSource = { list: () => Object.keys(FILES), read: (p) => FILES[p] };
const C = "c7c0001";
const call = (path: string, cite: Record<string, unknown> = {}): Fact =>
  Fact.parse({
    kind: "call",
    id: "call.post.refund",
    repo: "forge-transfers",
    commit: C,
    callType: "rest",
    method: "POST",
    path,
    base: "forge-remote",
    cite: {
      file: "src/main/java/forge/transfers/RefundClient.java",
      line: 8,
      value: "refundPath",
      quote: "    return retryer.exchange(postUri(refundPath), HttpMethod.POST, body);",
      ...cite,
    },
    verified: "line",
    by: "assistant",
    conf: "declared",
  });
const run = (f: Fact) => verifyFacts({ facts: [f], source, commit: C });

describe("a call's path written as the name of what holds it (ADR 0172)", () => {
  it("tells a name from a path", () => {
    for (const p of ["refundPath", "requestTransferRefundPath", "download_uri", "refundUri()"])
      expect(pathIsAName(p), p).toBe(true);
    for (const p of ["/refunds", "${forge-remote.uris.refund}", "ping", "health", "Refunds/Post"])
      expect(pathIsAName(p), p).toBe(false);
  });

  it("rejects the variable's name, saying how to read it", async () => {
    const r = await run(call("refundPath"));
    expect(r.rejected.map((x) => x.code)).toEqual(["call-path-is-a-name"]);
    expect(r.rejected[0]!.message).toContain("${forge.uris.refund}");
  });

  it("keeps the setting's placeholder, cited where the field is set", async () => {
    const r = await run(
      call("${forge-remote.uris.refund}", {
        line: 4,
        value: "${forge-remote.uris.refund}",
        quote: '  @Value("${forge-remote.uris.refund}")',
        with: [
          {
            file: "src/main/java/forge/transfers/RefundClient.java",
            line: 8,
            value: "refundPath",
          },
        ],
      }),
    );
    expect(r.rejected).toEqual([]);
  });
});

describe("a setting's placeholder a helper puts together", () => {
  const files: Record<string, string> = {
    "src/main/java/forge/wallets/Client.java": [
      "class Client {",
      '  Object create() { return http.post(remote.url("createWallet")); }',
      "}",
    ].join("\n"),
    "src/main/java/forge/wallets/Remote.java": [
      '@ConfigurationProperties(prefix = "forge-remote")',
      "record Remote(String host, Map<String, String> uris) {}",
    ].join("\n"),
  };
  const src: FileSource = { list: () => Object.keys(files), read: (p) => files[p] };
  const parts = [
    { file: "src/main/java/forge/wallets/Remote.java", line: 1, value: "forge-remote" },
    { file: "src/main/java/forge/wallets/Remote.java", line: 2, value: "uris" },
  ];
  const at = (withParts: typeof parts) =>
    call("${forge-remote.uris.createWallet}", {
      file: "src/main/java/forge/wallets/Client.java",
      line: 2,
      value: "createWallet",
      quote: '  Object create() { return http.post(remote.url("createWallet")); }',
      with: withParts,
    });

  it("keeps it when every part of the key is written on the cited line or a part", async () => {
    const r = await verifyFacts({ facts: [at(parts)], source: src, commit: C });
    expect(r.rejected).toEqual([]);
  });

  it("rejects it when a part of the key is written nowhere cited", async () => {
    const r = await verifyFacts({ facts: [at(parts.slice(0, 1))], source: src, commit: C });
    expect(r.rejected.map((x) => x.code)).toEqual(["claim-not-on-line"]);
  });
});
