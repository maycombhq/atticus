import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";

/**
 * atticus bench facts (ADR 0124 §6): score an assistant's facts file against a bench reference
 * with the readers' matcher. No clone and no network: the facts file and the reference are all
 * it reads.
 */

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

const fact = (f: Record<string, unknown>) =>
  JSON.stringify({ repo: "forge-ledger", commit: COMMIT.slice(0, 7), verified: "line", ...f });

async function bench() {
  const top = await mkdtemp(join(tmpdir(), "atticus-bench-facts-"));
  const dir = join(top, "bench");
  await mkdir(join(dir, "references"), { recursive: true });
  await writeFile(
    join(dir, "repos.yaml"),
    [
      "schemaVersion: 1",
      "repos:",
      "  - id: forge-ledger",
      "    url: https://example.com/forge-ledger",
      `    commit: ${COMMIT}`,
      "    stack: invented Spring service",
      "    batch: 1",
      "  - id: forge-ui",
      "    url: https://example.com/forge-ui",
      `    commit: ${COMMIT}`,
      "    stack: invented front end",
      "    batch: 1",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "references", "forge-ledger.yaml"),
    [
      "repo: forge-ledger",
      `commit: ${COMMIT}`,
      "covers: [serves, stores, fields, config]",
      "serves:",
      '  - { type: rest, method: POST, path: /entries, at: "src/EntryController.java:20" }',
      '  - { type: rest, method: GET, path: "/entries/{id}", at: "src/EntryController.java:30" }',
      "stores:",
      '  - { table: entry, at: "db/V2__create_entry.sql:1" }',
      "fields:",
      '  - { entry: "POST /entries", side: request, name: amount, at: "src/EntryRequest.java:5" }',
      '  - { table: entry, name: amount, at: "db/V2__create_entry.sql:3" }',
      "config:",
      '  - { key: northwind.base-url, at: "src/main/resources/application.yml:4" }',
      "",
    ].join("\n"),
  );
  const facts = [
    fact({
      kind: "entry",
      id: "e1",
      entryType: "rest",
      method: "POST",
      path: "/entries",
      cite: { file: "src/EntryController.java", line: 20, value: "/entries" },
    }),
    fact({
      kind: "store",
      id: "s1",
      store: "ledger",
      name: "entry",
      op: "write",
      cite: { file: "db/V2__create_entry.sql", line: 1, value: "entry" },
    }),
    fact({
      kind: "field",
      id: "f1",
      owner: "e1",
      side: "request",
      name: "amount",
      cite: { file: "src/EntryRequest.java", line: 5, value: "amount" },
    }),
    fact({
      kind: "config",
      id: "k1",
      key: "northwind.base-url",
      value: "https://northwind.example.com",
      cite: { file: "src/main/resources/application.yml", line: 4, value: "base-url" },
    }),
    fact({
      kind: "config",
      id: "k2",
      key: "northwind.timeout",
      value: "5s",
      cite: { file: "src/main/resources/application.yml", line: 5, value: "timeout" },
    }),
  ];
  return { top, dir, cache: join(top, "cache"), facts: facts.join("\n") + "\n" };
}

describe("atticus bench facts", () => {
  it("scores a facts file given with --facts, per kind, and keeps the result", async () => {
    const b = await bench();
    const file = join(b.top, "ledger.jsonl");
    await writeFile(file, b.facts);
    const r = io();
    const args = ["bench", "facts", "forge-ledger", "--bench", b.dir, "--cache", b.cache];
    expect(await main([...args, "--facts", file, "--json"], r.io), r.err.join("\n")).toBe(0);
    const json = JSON.parse(r.out.join("\n"));
    expect(json.repos).toHaveLength(1);
    const s = json.repos[0];
    expect(s.repo).toBe("forge-ledger");
    expect(s.kinds.serves).toMatchObject({ found: 1, missed: ["rest GET /entries/{}"], wrong: [] });
    expect(s.kinds.fields).toMatchObject({ found: 1, missed: ["column entry | amount"] });
    expect(s.kinds.config).toMatchObject({ found: 1, wrong: ["northwind.timeout"] });
    expect(s.base).toMatchObject({ found: 2, missed: 1, wrong: 0 });
    expect(s.total).toMatchObject({ found: 4, missed: 2, wrong: 1 });
    expect(s.facts).toMatchObject({ total: 5, verified: 5 });
    expect(json.total).toMatchObject({ found: 4, missed: 2, wrong: 1 });
    const results = await readdir(join(b.cache, "results"));
    expect(results.some((f) => f.endsWith(".facts.json"))).toBe(true);

    const table = io();
    expect(await main([...args, "--facts", file], table.io)).toBe(0);
    const text = table.out.join("\n");
    expect(text).toMatch(/forge-ledger\s+5\s+4\s+2\s+1\s+80%\s+67%/);
    expect(text).toMatch(/serves\s+1\s+1\s+0\s+100%\s+50%/);
    expect(text).toMatch(/config\s+1\s+0\s+1\s+50%\s+100%/);
  });

  it("reads the facts from the cache when no file is given, and skips repos without facts", async () => {
    const b = await bench();
    await mkdir(join(b.cache, "facts"), { recursive: true });
    await writeFile(join(b.cache, "facts", "forge-ledger.jsonl"), b.facts);
    const r = io();
    expect(
      await main(["bench", "facts", "--bench", b.dir, "--cache", b.cache, "--json"], r.io),
      r.err.join("\n"),
    ).toBe(0);
    const json = JSON.parse(r.out.join("\n"));
    expect(json.repos.map((s: { repo: string }) => s.repo)).toEqual(["forge-ledger"]);
    expect(json.skipped).toEqual(["forge-ui: no reference yet"]);
  });

  it("refuses facts of another commit, unreadable facts, and --facts for several repos", async () => {
    const b = await bench();
    const other = join(b.top, "other.jsonl");
    await writeFile(other, b.facts.replaceAll(`"commit":"0123456"`, `"commit":"fedcba9"`));
    const r = io();
    const args = ["bench", "facts", "forge-ledger", "--bench", b.dir, "--cache", b.cache];
    expect(await main([...args, "--facts", other], r.io)).toBe(2);
    expect(r.err.join("\n")).toMatch(/commit fedcba9/);

    const broken = join(b.top, "broken.jsonl");
    await writeFile(broken, '{"kind":"entry"}\n');
    const r2 = io();
    expect(await main([...args, "--facts", broken], r2.io)).toBe(2);
    expect(r2.err.join("\n")).toMatch(/does not read as facts/);

    const r3 = io();
    const all = ["bench", "facts", "--bench", b.dir, "--cache", b.cache, "--facts", broken];
    expect(await main(all, r3.io)).toBe(2);
    expect(r3.err.join("\n")).toMatch(/--facts names one repo's file/);
    expect(await readFile(broken, "utf8")).toBe('{"kind":"entry"}\n');
  });
});
