import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrgPack, notesFor, parseFacts, type Fact } from "@maycombhq/core";
import { dirSource, memorySource, verifyFacts } from "../src/index.js";

/**
 * Term facts and a call's auth and TLS, checked on their lines (ADR 0163), on the invented
 * `fixtures/term-notes/` (an access list as a JSON array, a nested JSON object and YAML) and an
 * inline second stack (a .NET service's appsettings.json and a Node client).
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "term-notes");
const PACK = join(FIX, "org-pack");
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const op = await loadOrgPack(PACK);
const type = (id: string) => op.repoTypes.find((t) => t.id === id);
const PROXY_NOTES = notesFor(type("forge-apigee-proxy"), op.conventions);
const SERVICE_NOTES = notesFor(type("forge-spring-service"), op.conventions);
const run = (
  repo: string,
  facts = factsOf(repo),
  notes = repo.endsWith("-proxy") ? PROXY_NOTES : SERVICE_NOTES,
) => verifyFacts({ facts, source: dirSource(join(FIX, "repos", repo)), commit: "ccc3333", notes });
const codes = (r: Awaited<ReturnType<typeof run>>) => r.rejected.map((x) => [x.fact.id, x.code]);
const change = (repo: string, id: string, patch: Record<string, unknown>) =>
  factsOf(repo).map((f) => (f.id === id ? ({ ...f, ...patch } as Fact) : f));
const without = (repo: string, id: string, key: string) =>
  factsOf(repo).map((f) => {
    if (f.id !== id) return f;
    const copy = { ...f } as Record<string, unknown>;
    delete copy[key];
    return copy as Fact;
  });

describe("term facts rest on their lines", () => {
  it.each([
    "forge-accounts-proxy",
    "forge-cards-proxy",
    "forge-limits-proxy",
    "forge-payments",
    "forge-statements",
    "forge-ledger",
  ])("keeps every fact of %s, each shape of access list included", async (repo) => {
    const r = await run(repo);
    expect(r.rejected).toEqual([]);
  });

  it("rejects a value no line writes", async () => {
    const r = await run(
      "forge-accounts-proxy",
      change("forge-accounts-proxy", "term.cmdb.app000123", {
        value: "APP000124",
        cite: { file: "userAccess.json", line: 4, value: "APP000124" },
      }),
    );
    expect(codes(r)).toEqual([["term.cmdb.app000123", "claim-not-on-line"]]);
  });

  it("rejects a meaning line below the value, or in another file, or one that doesn't write it", async () => {
    const id = "term.cmdb.app000789";
    const below = await run(
      "forge-limits-proxy",
      change("forge-limits-proxy", id, {
        meaning: { file: "userAccess.yaml", line: 3, value: "cmdb" },
        cite: { file: "userAccess.yaml", line: 2, value: "APP000789" },
      }),
    );
    expect(codes(below)).toEqual([[id, "term-meaning"]]);
    const under = await run(
      "forge-accounts-proxy",
      change("forge-accounts-proxy", "term.cmdb.app000123", {
        meaning: { file: "userAccess.json", line: 5, value: "cmdb" },
      }),
    );
    expect(codes(under)).toEqual([["term.cmdb.app000123", "term-meaning"]]);
    expect(under.rejected[0]!.message).toContain("below the value's line 4");
    const elsewhere = await run(
      "forge-limits-proxy",
      change("forge-limits-proxy", id, {
        meaning: { file: "apiproxy/forge-limits.xml", line: 1, value: "APIProxy" },
      }),
    );
    expect(codes(elsewhere)).toEqual([[id, "term-meaning"]]);
    const wrong = await run(
      "forge-limits-proxy",
      change("forge-limits-proxy", id, {
        meaning: { file: "userAccess.yaml", line: 1, value: "owners" },
      }),
    );
    expect(codes(wrong)).toEqual([[id, "claim-not-on-line"]]);
  });

  it("checks the note relied on against the notes given; none given, it isn't checked", async () => {
    const id = "term.cmdb.app000123";
    const r = await run("forge-cards-proxy", change("forge-cards-proxy", id, { note: 9 }));
    expect(codes(r)).toEqual([[id, "term-meaning"]]);
    expect(r.rejected[0]!.message).toContain("notes it was given are 1 to 4");
    const quoted = await run(
      "forge-cards-proxy",
      change("forge-cards-proxy", id, { note: "lists every owner team" }),
    );
    expect(codes(quoted)).toEqual([[id, "term-meaning"]]);
    const none = await verifyFacts({
      facts: change("forge-cards-proxy", id, { note: 9 }),
      source: dirSource(join(FIX, "repos", "forge-cards-proxy")),
      commit: "ccc3333",
    });
    expect(none.rejected).toEqual([]);
  });
});

describe("a call's auth and TLS rest on the lines that set them", () => {
  const id = "call.post.northwind-charges";
  it("rejects an auth or a tls with no line", async () => {
    const r = await run("forge-payments", without("forge-payments", id, "tlsCite"));
    expect(codes(r)).toEqual([[id, "security-uncited"]]);
    expect(r.rejected[0]!.message).toContain("claims tls mtls and cites no line");
  });

  it("rejects one cited on a line that doesn't set it", async () => {
    const r = await run(
      "forge-payments",
      change("forge-payments", id, {
        tlsCite: {
          file: "src/main/java/forge/payments/NorthwindClient.java",
          line: 1,
          value: "sslContext",
        },
      }),
    );
    expect(codes(r)).toEqual([[id, "claim-not-on-line"]]);
  });
});

describe("a second stack, inline: a .NET service's settings and a Node client", () => {
  const source = memorySource({
    "appsettings.json": [
      "{",
      '  "Forge": {',
      '    "Application": { "CmdbId": "APP000321" },',
      '    "AllowedCallers": [',
      '      "APP000123",',
      '      "APP000456"',
      "    ]",
      "  }",
      "}",
    ].join("\n"),
    "client/tidewater.js": [
      "import https from 'node:https';",
      "const agent = new https.Agent({ cert, key });",
      "export const upload = (body) =>",
      "  fetch('https://files.tidewater.example/v2/upload', { agent, method: 'POST', body, headers: { 'x-api-key': process.env.TIDEWATER_KEY } });",
    ].join("\n"),
  });
  const base = {
    repo: "forge-notices",
    commit: "ddd4444",
    verified: "none" as const,
    by: "assistant" as const,
    conf: "declared" as const,
  };
  const facts = [
    {
      ...base,
      kind: "term",
      id: "term.cmdbid.app000321",
      term: "CmdbId",
      value: "APP000321",
      role: "owner",
      cite: { file: "appsettings.json", line: 3, value: "APP000321" },
      meaning: { file: "appsettings.json", line: 3, value: "Application" },
    },
    {
      ...base,
      kind: "term",
      id: "term.allowedcallers.app000123",
      term: "AllowedCallers",
      value: "APP000123",
      role: "consumer",
      cite: { file: "appsettings.json", line: 5, value: "APP000123" },
      meaning: { file: "appsettings.json", line: 4, value: "AllowedCallers" },
    },
    {
      ...base,
      kind: "term",
      id: "term.allowedcallers.app000456",
      term: "AllowedCallers",
      value: "APP000456",
      role: "unknown",
      cite: { file: "appsettings.json", line: 6, value: "APP000456" },
    },
    {
      ...base,
      kind: "call",
      id: "call.post.tidewater-upload",
      callType: "rest",
      method: "POST",
      path: "/v2/upload",
      host: "files.tidewater.example",
      to: "tidewater",
      tls: "mtls",
      tlsCite: { file: "client/tidewater.js", line: 2, value: "cert" },
      auth: "api-key",
      authCite: { file: "client/tidewater.js", line: 4, value: "x-api-key" },
      cite: { file: "client/tidewater.js", line: 4, value: "/v2/upload" },
    },
  ] as unknown as Fact[];

  it("keeps the terms of a nested settings object and a cited key and client certificate", async () => {
    const parsed = parseFacts(facts.map((f) => JSON.stringify(f)).join("\n"));
    expect(parsed.ok).toBe(true);
    const r = await verifyFacts({ facts, source, commit: "ddd4444" });
    expect(r.rejected).toEqual([]);
    expect(r.accepted.map((f) => f.id).sort()).toEqual([
      "call.post.tidewater-upload",
      "term.allowedcallers.app000123",
      "term.allowedcallers.app000456",
      "term.cmdbid.app000321",
    ]);
  });
});
