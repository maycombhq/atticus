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
    const quoted = await run(
      "forge-cards-proxy",
      change("forge-cards-proxy", id, { note: "lists every owner team" }),
    );
    expect(codes(quoted)).toEqual([[id, "term-meaning"]]);
    const none = await verifyFacts({
      facts: change("forge-cards-proxy", id, { note: "lists every owner team" }),
      source: dirSource(join(FIX, "repos", "forge-cards-proxy")),
      commit: "ccc3333",
    });
    expect(none.rejected).toEqual([]);
  });

  it("refuses a note quoted by a word or two, which any note would hold (review 10)", async () => {
    const id = "term.cmdb.app000123";
    const r = await run("forge-cards-proxy", change("forge-cards-proxy", id, { note: "a" }));
    expect(codes(r)).toEqual([[id, "term-meaning"]]);
    expect(r.rejected[0]!.message).toContain("at least 4 words");
  });

  it("flags a term whose note was changed or removed since the read, never keeping it (review 10)", async () => {
    // the type's first note, reworded since the facts were written: its key is no longer given
    const reworded = notesFor(
      {
        ...type("forge-apigee-proxy")!,
        notes: [
          "`cmdb` in userAccess.json lists the owner teams of this proxy.",
          ...type("forge-apigee-proxy")!.notes!.slice(1),
        ],
      },
      op.conventions,
    );
    const r = await run("forge-accounts-proxy", factsOf("forge-accounts-proxy"), reworded);
    expect(codes(r)).toEqual([
      ["term.cmdb.app000123", "term-note-stale"],
      ["term.cmdb.app000456", "term-note-stale"],
    ]);
    expect(r.rejected[0]!.message).toContain("changed or removed since the read");
    // reordered, every key still holds
    const reordered = await run(
      "forge-accounts-proxy",
      factsOf("forge-accounts-proxy"),
      [...PROXY_NOTES].reverse(),
    );
    expect(reordered.rejected).toEqual([]);
  });
});

describe("a call's auth and TLS rest on the lines that set them", () => {
  const id = "call.post.northwind-charges";
  it("rejects an auth or a tls with no line", async () => {
    const r = await run("forge-payments", without("forge-payments", id, "tlsCite"));
    expect(codes(r)).toEqual([[id, "security-uncited"]]);
    expect(r.rejected[0]!.message).toContain("claims tls mtls and cites no line");
  });

  const client = "src/main/java/forge/payments/NorthwindClient.java";
  it.each([
    // mTLS on the https URL's line: TLS, but no client certificate there
    ["tls", "mtls", { file: client, line: 7, value: "https" }],
    // TLS on the token's line
    ["tls", "tls", { file: client, line: 8, value: "Bearer" }],
    // none on a line that writes https
    ["tls", "none", { file: client, line: 7, value: "https" }],
    // an OAuth token on the URL's line
    ["auth", "oauth2", { file: client, line: 7, value: "https" }],
    // an API key on the client certificate's line
    ["auth", "api-key", { file: client, line: 11, value: "mtlsContext" }],
  ] as const)(
    "rejects %s %s on a line that writes no such thing (review 5)",
    async (what, claim, at) => {
      const r = await run(
        "forge-payments",
        change("forge-payments", id, { [what]: claim, [`${what}Cite`]: at }),
      );
      expect(codes(r)).toEqual([[id, "security-line-kind"]]);
      expect(r.rejected[0]!.message).toContain(`${what} ${claim}`);
    },
  );

  it("takes mTLS from the client certificate a cited part names (review 5)", async () => {
    const r = await run(
      "forge-payments",
      change("forge-payments", id, { tlsCite: { file: client, line: 4, value: "sslContext" } }),
    );
    expect(codes(r)).toEqual([[id, "security-line-kind"]]);
    expect(r.rejected[0]!.message).toContain("client certificate");
    expect((await run("forge-payments")).rejected).toEqual([]);
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
    "Clients/LanternClient.cs": [
      "var handler = new HttpClientHandler();",
      'handler.ClientCertificates.Add(LoadCertificate("lantern-client.pfx"));',
      'var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.lanternmail.example") };',
      'http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);',
      'await http.PostAsync("/v1/send", body);',
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

  const lantern = {
    ...base,
    kind: "call",
    id: "call.post.lantern-send",
    callType: "rest",
    method: "POST",
    path: "/v1/send",
    to: "lantern-mail",
    tls: "mtls",
    tlsCite: { file: "Clients/LanternClient.cs", line: 2, value: "ClientCertificates" },
    auth: "oauth2",
    authCite: { file: "Clients/LanternClient.cs", line: 4, value: "Bearer" },
    cite: { file: "Clients/LanternClient.cs", line: 5, value: "/v1/send" },
  } as unknown as Fact;

  it("judges a .NET and a Node client's security by the words on their lines (review 5)", async () => {
    const ok = await verifyFacts({ facts: [lantern], source, commit: "ddd4444" });
    expect(ok.rejected).toEqual([]);
    const tidewater = facts.find((f) => f.id === "call.post.tidewater-upload")!;
    for (const [f, at] of [
      // mTLS on the BaseAddress line: https, no client certificate
      [lantern, { tlsCite: { file: "Clients/LanternClient.cs", line: 3, value: "https" } }],
      // mTLS on the fetch line: https and an API key, no certificate
      [tidewater, { tlsCite: { file: "client/tidewater.js", line: 4, value: "https" } }],
      // an API key on the Agent's line
      [tidewater, { authCite: { file: "client/tidewater.js", line: 2, value: "cert" } }],
    ] as const) {
      const r = await verifyFacts({
        facts: [{ ...f, ...at } as Fact],
        source,
        commit: "ddd4444",
      });
      expect(r.rejected.map((x) => x.code)).toEqual(["security-line-kind"]);
    }
  });

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
