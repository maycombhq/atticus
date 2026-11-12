import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseRecord, type CatalogRecord } from "@maycombhq/core";
import {
  compareReadersWithFacts,
  crossCheckKey,
  crossCheckValue,
  dismissalsAfter,
  normalisedPath,
  parseDismissals,
  readCrossCheck,
  serializeDismissals,
} from "../src/index.js";

/**
 * The readers' cross-check (ADR 0195 point 3, ticket CS3): a repo's readers slot against its
 * facts' projection, matched by id then by the kind's key, never fuzzily; dismissals hold until
 * the readers' value changes. The golden is the Forge estate's (fixtures/forge/slots), so the
 * view the app shows is the one reviewed here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const SLOTS = join(FORGE, "slots");
const GOLDEN = join(FORGE, "expected/crosscheck.json");
const update = process.env.UPDATE_GOLDEN === "1";
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

const ev = (path: string, line: number) => ({
  repo: "forge-ledger",
  path,
  line,
  commit: "aaaaaaa",
  source: "code" as const,
  extractor: "spring@1.0.0",
  scannedAt: "2026-10-18T09:00:00Z",
});

function rec(r: Record<string, unknown>): CatalogRecord {
  const p = parseRecord({ schemaVersion: 5, status: "current", confidence: "verified", ...r });
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  return p.record;
}

const endpoint = (id: string, method: string, path: string, line = 10) =>
  rec({
    kind: "Endpoint",
    id,
    component: "ledger-api",
    endpointType: "rest",
    method,
    pathOrTopic: path,
    evidence: [ev("src/main/java/forge/ledger/AccountController.java", line)],
  });
const setting = (id: string, key: string, value: string) =>
  rec({
    kind: "Setting",
    id,
    component: "ledger-api",
    settingKind: "timeout",
    key,
    valueOrRef: value,
    evidence: [ev("src/main/resources/application.yml", 7)],
  });

describe("the kind's key and value (point 3)", () => {
  it("normalises a path's parameters whatever their names", () => {
    expect(normalisedPath("/accounts/{accountId}/statement")).toBe("/accounts/{}/statement");
    expect(normalisedPath("/accounts/:id/")).toBe("/accounts/{}");
  });
  it("keys an Endpoint by its method and path and a Setting by its key", () => {
    expect(crossCheckKey(endpoint("e1", "GET", "/accounts/{accountId}/statement"))).toBe(
      "Endpoint|GET /accounts/{}/statement",
    );
    expect(crossCheckKey(setting("s1", "ledger.fx.timeout-ms", "2500"))).toBe(
      "Setting|ledger.fx.timeout-ms",
    );
    expect(crossCheckValue(setting("s1", "ledger.fx.timeout-ms", "2500"))).toBe("2500");
    expect(crossCheckValue(endpoint("e1", "GET", "/a/{id}"))).toEqual({
      method: "GET",
      path: "/a/{id}",
    });
  });
});

describe("compareReadersWithFacts", () => {
  const readers = [
    endpoint("ep-a", "GET", "/accounts/{accountId}"),
    endpoint("ep-readers-id", "GET", "/accounts/{accountId}/statement", 31),
    endpoint("ep-only", "DELETE", "/accounts/{accountId}", 44),
    setting("ledger-api.fx-timeout", "ledger.fx.timeout-ms", "2500"),
  ];
  const facts = [
    endpoint("ep-a", "GET", "/accounts/{accountId}"),
    // Another id, the same key: matched by key, not reported twice.
    endpoint("ep-facts-id", "GET", "/accounts/{id}/statement", 31),
    setting("ledger-api.fx-timeout", "ledger.fx.timeout-ms", "3000"),
    endpoint("ep-facts-only", "POST", "/accounts", 12),
  ];

  it("lists readers found, disagreements and facts only, and counts what agrees", () => {
    const c = compareReadersWithFacts(readers, facts);
    expect(c.counts).toEqual({
      agree: 1,
      readersOnly: 1,
      factsOnly: 1,
      disagree: 2,
      dismissed: 0,
    });
    expect(c.items.map((i) => [i.state, i.key])).toEqual([
      ["readers-only", "Endpoint|DELETE /accounts/{}"],
      ["disagree", "Endpoint|GET /accounts/{}/statement"],
      ["disagree", "Setting|ledger.fx.timeout-ms"],
      ["facts-only", "Endpoint|POST /accounts"],
    ]);
    const s = c.items.find((i) => i.kind === "Setting")!;
    expect(s.fields).toEqual([{ field: "valueOrRef", readers: "2500", facts: "3000" }]);
    expect(s.readers!.cites).toEqual([
      { file: "src/main/resources/application.yml", line: 7, commit: "aaaaaaa" },
    ]);
    const only = c.items.find((i) => i.state === "readers-only")!;
    expect(only.readers!.cites[0]).toMatchObject({ line: 44 });
  });

  it("keeps a dismissed item dismissed until the readers' value changes", () => {
    const d = dismissalsAfter(undefined, "Setting|ledger.fx.timeout-ms", { readers: "2500" });
    const once = compareReadersWithFacts(readers, facts, d);
    expect(once.counts.dismissed).toBe(1);
    expect(once.counts.disagree).toBe(1);
    expect(once.items.find((i) => i.kind === "Setting")!.dismissed).toBe(true);
    // The readers read 2600 at the next scan: listed again.
    const moved = [
      ...readers.slice(0, 3),
      setting("ledger-api.fx-timeout", "ledger.fx.timeout-ms", "2600"),
    ];
    const again = compareReadersWithFacts(moved, facts, d);
    expect(again.counts.dismissed).toBe(0);
    expect(again.items.find((i) => i.kind === "Setting")!.dismissed).toBeUndefined();
    // Taken back: listed as before.
    const undone = dismissalsAfter(d, "Setting|ledger.fx.timeout-ms", { undo: true });
    expect(undone.dismissed).toEqual([]);
  });

  it("says a thing the readers found twice (code and its OpenAPI file) once, citing both", () => {
    const twice = [
      endpoint("ledger-api.get-balance", "GET", "/accounts/{id}/balance", 8),
      rec({
        ...(endpoint("ledger-api.get.e9564c7142", "GET", "/accounts/{id}/balance") as object),
        evidence: [{ ...ev("api/ledger-openapi.yaml", 6), source: "spec" }],
      }),
    ];
    const c = compareReadersWithFacts(twice, []);
    expect(c.items).toHaveLength(1);
    expect(c.items[0]!.readers!.cites.map((x) => `${x.file}:${x.line}`)).toEqual([
      "api/ledger-openapi.yaml:6",
      "src/main/java/forge/ledger/AccountController.java:8",
    ]);
    expect(c.counts.readersOnly).toBe(1);
  });

  it("is the same whatever order the records come in", () => {
    const a = compareReadersWithFacts(readers, facts);
    const b = compareReadersWithFacts([...readers].reverse(), [...facts].reverse());
    expect(b).toEqual(a);
  });

  it("writes the dismissals file canonically, and reads it back", () => {
    const d = dismissalsAfter(
      dismissalsAfter(undefined, "Setting|ledger.fx.timeout-ms", { readers: "2500" }),
      "Endpoint|GET /accounts/{}/statement",
      { readers: { method: "GET", path: "/accounts/{accountId}/statement" } },
    );
    const text = serializeDismissals(d);
    expect(text).toBe(readFileSync(join(SLOTS, "crosscheck/forge-ledger.crosscheck.yaml"), "utf8"));
    const p = parseDismissals(text);
    expect(p.ok && serializeDismissals(p.slot)).toBe(text);
  });
});

/** A metarepo of the Forge org pack and golden slots: readers for every repo, facts for one. */
async function forge(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-crosscheck-"));
  made.push(root);
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(SLOTS, "readers"), join(root, "catalog/sources/readers"), { recursive: true });
  await cp(join(SLOTS, "facts"), join(root, "catalog/sources/facts"), { recursive: true });
  await mkdir(join(root, "facts"), { recursive: true });
  await cp(
    join(SLOTS, "crosscheck/forge-ledger.crosscheck.yaml"),
    join(root, "facts/forge-ledger.crosscheck.yaml"),
  );
  return root;
}

describe("readCrossCheck on the Forge slots", () => {
  it("compares the repo with facts and says why every other repo isn't compared (golden)", async () => {
    const root = await forge();
    const got = await readCrossCheck(root);
    const text = JSON.stringify(got, null, 2) + "\n";
    if (update || !existsSync(GOLDEN)) await writeFile(GOLDEN, text);
    expect(text).toBe(await readFile(GOLDEN, "utf8"));
    const ledger = got.repos.find((r) => r.repo === "forge-ledger")!;
    expect(ledger.state).toBe("compared");
    expect(ledger.factsCommit).toBe("0123abc");
    for (const r of got.repos.filter((x) => x.repo !== "forge-ledger"))
      expect(r.state).toBe("no-facts");
    // It reads files only: the slots are as they were.
    expect(await readFile(join(root, "facts/forge-ledger.crosscheck.yaml"), "utf8")).toBe(
      readFileSync(join(SLOTS, "crosscheck/forge-ledger.crosscheck.yaml"), "utf8"),
    );
  });

  it("says no readers slot yet, and a legacy slot isn't compared", async () => {
    const root = await forge();
    await rm(join(root, "catalog/sources/readers/forge-ledger.json"));
    expect((await readCrossCheck(root, { repo: "forge-ledger" })).repos[0]!.state).toBe(
      "no-readers",
    );
    const legacy = JSON.parse(
      readFileSync(join(SLOTS, "readers/forge-ledger.json"), "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      join(root, "catalog/sources/readers/forge-ledger.json"),
      JSON.stringify({ ...legacy, status: "legacy", settings: null, extractors: [] }, null, 2) +
        "\n",
    );
    const r = (await readCrossCheck(root, { repo: "forge-ledger" })).repos[0]!;
    expect(r.state === "legacy" || r.state === "unusable").toBe(true);
  });
});
