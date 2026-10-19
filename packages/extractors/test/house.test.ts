import { describe, expect, it } from "vitest";
import { FrameworkModel } from "@maycombhq/core";
import { memoryRepo, scanRepo } from "@maycombhq/sdk";
import { houseExtractor } from "../src/index.js";

const SHA = "b".repeat(40);
const person = { kind: "person" as const };

/** One model for a house platform client that teams use from Python, C# and Go alike. */
const kit = FrameworkModel.parse({
  schemaVersion: 1,
  name: "bank-kit",
  packages: ["bankkit", "Bank.Kit", "example.com/bank/kit"],
  calls: [
    {
      function: "call",
      receiver: "client",
      service: { arg: 0 },
      httpMethod: { arg: 1 },
      path: { arg: 2 },
      source: person,
    },
    {
      function: "Send",
      service: { arg: 0 },
      httpMethod: { arg: 1 },
      path: { arg: 2 },
      language: "csharp",
      source: person,
    },
    {
      function: "Publish",
      kind: "event-publish",
      path: { arg: 0 },
      language: "go",
      source: person,
    },
  ],
  routes: [
    {
      function: "route",
      receiver: "app",
      httpMethod: { arg: 0 },
      path: { arg: 1 },
      language: "python",
      source: { kind: "code" },
    },
  ],
  services: {
    ledger: { value: "https://ledger.bank.internal", source: person },
    cards: { value: "https://cards.bank.internal", source: person },
  },
});

describe("house frameworks in any language (ADR 0055)", () => {
  it("reads the same model's calls and routes in Python, C# and Go, and only in files that use it", async () => {
    const repo = memoryRepo("x", SHA, {
      "app/entries.py": `from bankkit import client, app

@app.route("POST", "/entries")
def add(): pass

def post_entry(e):
    return client.call("ledger", "POST", "/entries/" + e.id)
`,
      "src/Cards.cs": `using Bank.Kit;
class Cards { void Get(string id) { _api.Send("cards", "GET", $"/cards/{id}"); } }`,
      "events/publish.go": `package events
import kit "example.com/bank/kit"
func Issued() { kit.Publish("cards.issued") }`,
      // Not a user of the framework: a call with the same name is not one of its calls.
      "other/unrelated.py": `def f(): client.call("ledger", "POST", "/nope")`,
    });
    const s = await scanRepo({
      repo,
      extractors: [houseExtractor],
      repoInfo: { component: "x" },
      frameworks: [kit],
    });
    const lines = s.records
      .map((r) => {
        const x = r as unknown as {
          unresolvedKind?: string;
          raw?: string;
          method?: string;
          pathOrTopic?: string;
          confidence: string;
        };
        return r.kind === "Endpoint"
          ? `endpoint ${x.method} ${x.pathOrTopic} ${x.confidence}`
          : `${x.unresolvedKind} ${x.raw}`;
      })
      .sort();
    expect(lines).toEqual([
      "endpoint POST /entries verified",
      "event-publish cards.issued",
      "http-call GET https://cards.bank.internal/cards/{id}",
      "http-call POST https://ledger.bank.internal/entries/{id}",
    ]);
  });
});
