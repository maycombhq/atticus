import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Fact, parseFactsLines } from "@maycombhq/core";
import { planPromote, promotedFactId, promotedStates, writePromote } from "../src/index.js";

/**
 * Promote to assert (ADR 0195 point 3, ticket CS3): what the readers found becomes a person's
 * fact in the facts file's own shape (the contract of ADR 0124, unchanged), citing the reader's
 * line at the reader's commit. Only what one fact says whole is promoted; anything else is
 * refused with why. Files only: the golden Forge slots, no checkout, no network.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const SLOTS = join(FORGE, "slots");
const COMMIT = "a".repeat(40);
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

async function forge(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-promote-"));
  made.push(root);
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(SLOTS, "readers"), join(root, "catalog/sources/readers"), { recursive: true });
  await cp(join(SLOTS, "facts"), join(root, "catalog/sources/facts"), { recursive: true });
  return root;
}

const lineOf = (text: string) => async () => text;

describe("planPromote: the reader's record as one person's fact", () => {
  it("an Endpoint is an entry on the reader's code line, valid in the facts file's schema", async () => {
    const root = await forge();
    const key = "Endpoint|GET /accounts/{}/balance";
    const text =
      '  @ForgeEndpoint(method = "GET", path = "/accounts/{id}/balance", auth = "oauth2")';
    const p = await planPromote(root, "forge-ledger", key, { lineOf: lineOf(text) });
    expect(p).toMatchObject({
      can: true,
      fact: promotedFactId(key),
      factKind: "entry",
      factsFile: "facts/forge-ledger.jsonl",
      fromSnapshot: true,
      cite: {
        // The code line, not the OpenAPI file's that says the same.
        file: "src/main/java/forge/ledger/LedgerEndpoints.java",
        line: 8,
        value: "/accounts/{id}/balance",
        commit: COMMIT,
        text,
      },
    });
    const fact = Fact.parse(JSON.parse(p.line!));
    expect(fact).toMatchObject({
      kind: "entry",
      id: promotedFactId(key),
      by: "person",
      verified: "none",
      commit: COMMIT,
      entryType: "rest",
      method: "GET",
      path: "/accounts/{id}/balance",
      component: "ledger-api",
      cite: { quote: text.trim() },
    });
    // Planning writes nothing.
    expect(existsSync(join(root, "facts"))).toBe(false);
    // The file starts from the snapshot verify kept, with the fact at its end.
    const snapshot = await readFile(join(SLOTS, "facts/forge-ledger.jsonl"), "utf8");
    expect(p.next).toBe(`${snapshot}${p.line}\n`);
    expect(await writePromote(root, p)).toBe(true);
    const written = parseFactsLines(await readFile(join(root, "facts/forge-ledger.jsonl"), "utf8"));
    expect(written.bad).toEqual([]);
    expect(written.facts.map((f) => f.id)).toContain(promotedFactId(key));
    // Again: the same fact is there, nothing to write.
    const again = await planPromote(root, "forge-ledger", key, { lineOf: lineOf(text) });
    expect(again).toMatchObject({ can: true, already: true });
    expect(again.fromSnapshot).toBeUndefined();
    expect(await writePromote(root, again)).toBe(false);
    expect((await promotedStates(root, "forge-ledger", [key])).get(key)).toMatchObject({
      state: "written",
      line: 8,
    });
  });

  it("a Column is a field of the facts' own store fact for its table", async () => {
    const root = await forge();
    const p = await planPromote(root, "forge-ledger", "Column|account.account_number");
    expect(p.can, p.why).toBe(true);
    expect(JSON.parse(p.line!)).toMatchObject({
      kind: "field",
      owner: "s-account-read",
      side: "column",
      name: "account_number",
      type: "varchar(34)",
      required: true,
      cite: { file: "src/main/resources/db/migration/V1__create_account.sql", line: 3 },
    });
    // No line text without the checkout at the reader's commit: no quote is made up.
    expect(JSON.parse(p.line!).cite.quote).toBeUndefined();
  });

  it("an event the readers left unresolved: a publish is a call, a subscribe an entry", async () => {
    const root = await forge();
    const pub = await planPromote(
      root,
      "forge-ledger",
      "Unresolved|ledger-api.publish.transfers.completed",
    );
    expect(JSON.parse(pub.line!)).toMatchObject({
      kind: "call",
      callType: "event-topic",
      path: "transfers.completed",
      sync: "async",
      component: "ledger-api",
    });
    const sub = await planPromote(
      root,
      "forge-ledger",
      "Unresolved|ledger-api.subscribe.payments.initiated",
    );
    expect(JSON.parse(sub.line!)).toMatchObject({
      kind: "entry",
      entryType: "event-topic",
      path: "payments.initiated",
    });
  });

  it("refuses, with why, what isn't one fact, isn't found by the readers only, or isn't compared", async () => {
    const root = await forge();
    const idx = await planPromote(root, "forge-ledger", "IndexConstraint|ledger-db.account.pk");
    expect(idx).toMatchObject({ can: false });
    expect(idx.why).toMatch(/a IndexConstraint isn't one fact/);
    const agree = await planPromote(root, "forge-ledger", "Endpoint|GET /nowhere");
    expect(agree.why).toMatch(/isn't an item the readers found/);
    const other = await planPromote(root, "forge-gateway", "Endpoint|GET /x");
    expect(other.why).toMatch(/isn't compared \(no-facts\)/);
    expect(existsSync(join(root, "facts"))).toBe(false);
  });

  it("a fact of that id with another claim already there is refused, and left as it is", async () => {
    const root = await forge();
    const key = "Endpoint|POST /transfers";
    const p = await planPromote(root, "forge-ledger", key);
    await mkdir(join(root, "facts"), { recursive: true });
    const other = { ...JSON.parse(p.line!), path: "/elsewhere" };
    const file = join(root, "facts/forge-ledger.jsonl");
    await writeFile(file, `${JSON.stringify(other)}\n`);
    const again = await planPromote(root, "forge-ledger", key);
    expect(again.can).toBe(false);
    expect(again.why).toMatch(
      /has a fact person-endpoint-[0-9a-f]{12} already, with another claim/,
    );
    expect(await readFile(file, "utf8")).toBe(`${JSON.stringify(other)}\n`);
  });

  it("says where a promoted fact stands: verified on its line, or rejected with why", async () => {
    const root = await forge();
    const key = "Endpoint|POST /transfers";
    const id = promotedFactId(key);
    expect(id).toBe(promotedFactId(key));
    expect(id).toMatch(/^person-endpoint-[0-9a-f]{12}$/);
    const p = await planPromote(root, "forge-ledger", key);
    await mkdir(join(root, "facts"), { recursive: true });
    await writeFile(
      join(root, "facts/forge-ledger.jsonl"),
      `${JSON.stringify({ ...JSON.parse(p.line!), verified: "line" })}\n`,
    );
    expect((await promotedStates(root, "forge-ledger", [key])).get(key)?.state).toBe("verified");
    await writeFile(join(root, "facts/forge-ledger.jsonl"), "");
    await writeFile(
      join(root, "facts/forge-ledger.rejected.jsonl"),
      `${JSON.stringify({ code: "value-not-on-line", message: "/transfers isn't on line 11", fact: JSON.parse(p.line!) })}\n`,
    );
    expect((await promotedStates(root, "forge-ledger", [key])).get(key)).toMatchObject({
      state: "rejected",
      message: "value-not-on-line: /transfers isn't on line 11",
    });
    expect((await promotedStates(root, "forge-ledger", ["Endpoint|GET /x"])).size).toBe(0);
  });
});
