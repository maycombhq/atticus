import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact } from "@maycombhq/core";
import {
  classify,
  readAsyncApiSpecs,
  readAvroSpecs,
  readContractSpecs,
  readJsonSchemaSpecs,
  readProtoSpecs,
  readRepoSpecs,
  scanInputs,
} from "../src/index.js";

/**
 * The specs the contract check reads (plan item F7, ADR 0164): a .proto's messages with their
 * field numbers, an Avro record, a JSON Schema, an AsyncAPI message on its channel, and an
 * OpenAPI document's operations, tied to the repo's own entries or taken as a consumer's copy.
 * Intake takes a .proto or an .avsc for an outside topic as a Schema of its system. Invented
 * names throughout.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const LINK = join(HERE, "..", "..", "..", "fixtures", "link-estate");

const PROTO = `syntax = "proto3";

package forge.cards.v1;

/* A card was blocked.
   Published on forge.cards.blocked. */
message CardBlocked {
  string card_id = 1; // the card
  repeated string reasons = 2;
  map<string, string> labels = 3;
  Actor by = 4;
  message Actor {
    string user_id = 1;
  }
  oneof when {
    int64 at_millis = 5;
    string at_text = 6;
  }
  reserved 7;
}

enum Reason { REASON_UNSPECIFIED = 0; LOST = 1; }
`;

describe("readProtoSpecs", () => {
  it("reads each message, nested ones too, with types, labels and field numbers", () => {
    const [outer, inner] = readProtoSpecs("cards.proto", PROTO);
    expect(outer).toMatchObject({
      kind: "message",
      format: "protobuf",
      role: "schema",
      line: 7,
      name: "forge.cards.v1.CardBlocked",
    });
    expect(outer!.fields.map((f) => [f.name, f.type, f.number, f.required, f.at])).toEqual([
      ["card_id", "string", 1, false, "cards.proto:8"],
      ["reasons", "repeated string", 2, false, "cards.proto:9"],
      ["labels", "map<string,string>", 3, false, "cards.proto:10"],
      ["by", "Actor", 4, false, "cards.proto:11"],
      ["at_millis", "int64", 5, false, "cards.proto:16"],
      ["at_text", "string", 6, false, "cards.proto:17"],
    ]);
    expect(inner).toMatchObject({ name: "forge.cards.v1.CardBlocked.Actor", line: 12 });
    expect(inner!.fields.map((f) => f.name)).toEqual(["user_id"]);
  });

  it("takes proto2's required as required", () => {
    const [m] = readProtoSpecs(
      "x.proto",
      'syntax = "proto2";\nmessage M {\n  required string id = 1;\n  optional string note = 2;\n}\n',
    );
    expect(m!.fields.map((f) => [f.name, f.required])).toEqual([
      ["id", true],
      ["note", false],
    ]);
  });
});

describe("readAvroSpecs, readJsonSchemaSpecs and readAsyncApiSpecs", () => {
  it("reads an Avro record: a field is required unless it may be null or has a default", () => {
    const text = `{
  "type": "record",
  "namespace": "forge.ledger",
  "name": "LedgerPosted",
  "fields": [
    { "name": "entryId", "type": "string" },
    { "name": "amount", "type": "long" },
    { "name": "memo", "type": ["null", "string"], "default": null },
    { "name": "tags", "type": { "type": "array", "items": "string" }, "default": [] }
  ]
}
`;
    const [r] = readAvroSpecs("schemas/ledger.avsc", text);
    expect(r).toMatchObject({ format: "avro", name: "forge.ledger.LedgerPosted", line: 4 });
    expect(r!.fields.map((f) => [f.name, f.type, f.required, f.at])).toEqual([
      ["entryId", "string", true, "schemas/ledger.avsc:6"],
      ["amount", "long", true, "schemas/ledger.avsc:7"],
      ["memo", "string", false, "schemas/ledger.avsc:8"],
      ["tags", "repeated string", false, "schemas/ledger.avsc:9"],
    ]);
  });

  it("reads a JSON Schema's properties, nested, with its required list", () => {
    const text = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "LimitChanged",
  "type": "object",
  "required": ["accountId"],
  "properties": {
    "accountId": { "type": "string" },
    "limit": { "type": "object", "properties": { "amount": { "type": "number" } } }
  }
}
`;
    const [s] = readJsonSchemaSpecs("limit.schema.json", text);
    expect(s).toMatchObject({ format: "json-schema", name: "LimitChanged" });
    expect(s!.fields.map((f) => [f.name, f.type, f.required])).toEqual([
      ["accountId", "string", true],
      ["limit", "object", false],
      ["limit.amount", "number", false],
    ]);
  });

  it("reads an AsyncAPI message with the channel it travels on", () => {
    const text = `asyncapi: 2.6.0
info: { title: Forge Cards events, version: 1.0.0 }
channels:
  forge.cards.blocked:
    publish:
      message:
        $ref: '#/components/messages/CardBlocked'
components:
  messages:
    CardBlocked:
      name: CardBlocked
      payload:
        type: object
        required: [cardId]
        properties:
          cardId: { type: string }
`;
    const [m] = readAsyncApiSpecs("cards-asyncapi.yaml", text);
    expect(m).toMatchObject({
      format: "asyncapi",
      topic: "forge.cards.blocked",
      name: "CardBlocked",
      fields: [{ name: "cardId", type: "string", required: true, at: "cards-asyncapi.yaml:16" }],
    });
    expect(readContractSpecs("cards-asyncapi.yaml", text)).toHaveLength(1);
  });
});

describe("readRepoSpecs", () => {
  const facts = (repo: string): Fact[] => {
    const p = parseFacts(readFileSync(join(LINK, "facts", `${repo}.jsonl`), "utf8"));
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.facts;
  };

  it("ties a gateway's published spec to the route its operation is", async () => {
    const f = await readRepoSpecs(join(LINK, "contracts", "repos", "forge-proxy-accounts-v1"), {
      repo: "forge-proxy-accounts-v1",
      commit: "b2b0002",
      facts: facts("forge-proxy-accounts-v1"),
    });
    expect(f.specs.map((s) => [s.kind, s.role, s.file, s.line, s.method, s.path, s.entry])).toEqual(
      [
        [
          "operation",
          "own",
          "openapi/forge-accounts-v1.yaml",
          9,
          "GET",
          "/forge/accounts/v1/accounts/{id}",
          "entry.get.forge-accounts-v1-accounts-id",
        ],
      ],
    );
    expect(f.specs[0]!.errors).toEqual([
      { status: "401", at: "openapi/forge-accounts-v1.yaml:40" },
      { status: "404", at: "openapi/forge-accounts-v1.yaml:42" },
    ]);
  });

  it("takes an operation none of the repo's entries serves as a consumer's copy, and a .proto as a schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-specs-"));
    await cp(join(LINK, "contracts", "repos", "forge-proxy-accounts-v1"), dir, { recursive: true });
    await cp(join(LINK, "contracts", "repos", "forge-payments"), dir, { recursive: true });
    const f = await readRepoSpecs(dir, { repo: "forge-cards", facts: [] });
    expect(f.specs.map((s) => [s.kind, s.role, s.format, s.name ?? s.path])).toEqual([
      ["operation", "consumer", "openapi", "/forge/accounts/v1/accounts/{id}"],
      ["message", "schema", "protobuf", "forge.payments.v1.PaymentSettled"],
    ]);
    const refused: string[] = [];
    expect(
      (
        await readRepoSpecs(dir, {
          repo: "forge-cards",
          facts: [],
          denyHashes: new Set(["x"]),
          onRefused: (n) => refused.push(n),
        })
      ).specs,
    ).toHaveLength(2);
  });
});

describe("readRepoSpecs from the files of a commit (review item 13)", () => {
  it("reads only the files the tree lists, never what else lies in the folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-specs-tree-"));
    // In the folder, not in the commit: an untracked copy, never a spec of the repo.
    await mkdir(join(dir, "proto"), { recursive: true });
    await writeFile(join(dir, "proto", "scratch.proto"), PROTO);
    const files = new Map([
      ["proto/blocked.proto", PROTO],
      ["node_modules/forge-x/blocked.proto", PROTO],
      [".hidden/blocked.proto", PROTO],
      ["README.md", "# not a spec"],
      ["proto/huge.proto", PROTO + " ".repeat(1024 * 1024)],
    ]);
    const asked: string[] = [];
    const f = await readRepoSpecs(dir, {
      repo: "forge-cards",
      facts: [],
      tree: {
        files: async () =>
          [...files.keys()].map((path) => ({ path, size: files.get(path)!.length })),
        read: async (p) => {
          asked.push(p);
          return files.get(p);
        },
      },
    });
    expect([...new Set(f.specs.map((s) => s.file))]).toEqual(["proto/blocked.proto"]);
    expect(asked).toEqual(["proto/blocked.proto"]);
  });
});

describe("intake takes a .proto or an .avsc for an outside topic", () => {
  it("classifies them by name and by content", () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(classify("settlement.proto", bytes(PROTO)).classification).toBe("protobuf");
    expect(classify("settlement.txt", bytes(PROTO)).classification).toBe("protobuf");
    expect(
      classify("refund.avsc", bytes('{"type":"record","name":"R","fields":[]}')).classification,
    ).toBe("avro");
  });

  it("reads each message as a Schema of the system the file names, format protobuf", async () => {
    const MIXED = join(HERE, "fixtures", "mixed");
    const root = await mkdtemp(join(tmpdir(), "atticus-intake-proto-"));
    await cp(join(MIXED, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
    await mkdir(join(root, "inputs", "partner-specs"), { recursive: true });
    await writeFile(
      join(root, "inputs", "partner-specs", "northwind-pay-settlement.proto"),
      'syntax = "proto3";\npackage northwind.v1;\nmessage Settlement {\n  string settlement_id = 1;\n  int64 amount_minor = 2;\n}\n',
    );
    const res = await scanInputs({ root });
    expect(res.documents.map((d) => [d.path, d.classification, d.status, d.systems])).toEqual([
      [
        "inputs/partner-specs/northwind-pay-settlement.proto",
        "protobuf",
        "read",
        ["northwind-pay"],
      ],
    ]);
    expect(res.records.map((r) => [r.kind, r.id, (r as { format?: string }).format])).toEqual([
      ["Schema", "schema.northwind-v1-settlement", "protobuf"],
      ["SourceDocument", "doc.northwind-pay-settlement", undefined],
    ]);
  });
});
