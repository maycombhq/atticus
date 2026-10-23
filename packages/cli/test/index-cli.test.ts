import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { main } from "../src/main.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

async function forgeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-cli-index-"));
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  return root;
}

describe("atticus query", () => {
  it("prints matching records as a table, or JSON", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await main(["query", "kind:interface via:gateway", "--root", root], c.io)).toBe(0);
    expect(c.out[0]).toMatch(/^KIND\s+ID\s+NAME\s+STATUS\s+CONFIDENCE\s+SYSTEM$/);
    expect(c.out.filter((l) => l.startsWith("Interface"))).toHaveLength(2);
    expect(c.out.at(-1)).toBe("2 records");

    const j = capture();
    expect(await main(["query", "kind:table", "--root", root, "--json"], j.io)).toBe(0);
    const res = JSON.parse(j.out.join("\n")) as { total: number; records: { id: string }[] };
    expect(res.total).toBe(2);
    expect(res.records.map((r) => r.id)).toEqual(["ledger-db.account", "ledger-db.entry"]);
  });

  it("searches everything the index holds by words with --search, names and ids first (ADR 0107)", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await main(["query", "Northwind Pay", "--search", "--root", root], c.io)).toBe(0);
    expect(c.out[0]).toMatch(/^KIND\s+ID\s+NAME\s+FILE$/);
    expect(c.out[1]).toMatch(/^System\s+northwind-pay\s+Northwind Pay\s/);
    expect(c.out.at(-1)).toMatch(/^\d+ hits, best first$/);

    const j = capture();
    expect(
      await main(
        ["query", "ledger", "--search", "--kind", "System", "--json", "--root", root],
        j.io,
      ),
    ).toBe(0);
    const res = JSON.parse(j.out.join("\n")) as {
      hits: { kind: string; id: string; file: string }[];
    };
    expect(res.hits.map((h) => h.id)).toEqual(["ledger"]);
    expect(res.hits[0]!.file).toBe("catalog/generated/system/ledger.yaml");

    const none = capture();
    expect(await main(["query", "zebra", "--search", "--root", root], none.io)).toBe(0);
    expect(none.out).toEqual(["Nothing in the index matches those words."]);
  });

  it("says when there are more records than the limit", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await main(["query", "kind:column", "--limit", "3", "--root", root], c.io)).toBe(0);
    expect(c.out.at(-1)).toBe("3 of 7 records (use --limit to see more)");
  });

  it("exits 2 with the reason for a bad query", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await main(["query", "kind:nope", "--root", root], c.io)).toBe(2);
    expect(c.err.join("\n")).toMatch(/Unknown kind "nope"/);
    expect(await main(["query", "--root", root], capture().io)).toBe(2);
  });
});

describe("atticus impact", () => {
  it("lists what a change reaches, with owners and open questions", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await main(["impact", "audit-svc", "--depth", "2", "--root", root], c.io)).toBe(0);
    const text = c.out.join("\n");
    expect(text).toMatch(/Changing audit-svc reaches 2 records/);
    expect(text).toMatch(
      /Component\s+portal-bff\s+team-portal\s+calls audit-svc \(POST \/audit\/events\)/,
    );
    expect(text).toMatch(/Open questions:\n {2}- Only one end of this call was seen/);

    const j = capture();
    expect(
      await main(["impact", "ledger-db.entry", "--depth", "1", "--json", "--root", root], j.io),
    ).toBe(0);
    expect(
      (JSON.parse(j.out.join("\n")) as { affected: { id: string }[] }).affected.map((a) => a.id),
    ).toEqual(["ledger-api", "reports-job"]);
  });

  it("exits 1 for an id that isn't in the catalog, 2 without one", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await main(["impact", "nope", "--root", root], c.io)).toBe(1);
    expect(c.err.join("\n")).toMatch(/No record with id "nope"/);
    expect(await main(["impact", "--root", root], capture().io)).toBe(2);
  });
});

describe("atticus index rebuild", () => {
  it("rebuilds the index and reports what it holds", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await main(["index", "rebuild", "--root", root], c.io)).toBe(0);
    expect(c.out.join("\n")).toMatch(/Indexed 46 records/);
  });
});
