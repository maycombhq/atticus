import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkCodeTable, pairsOf, parseCodeTable, specNamesNotInRows } from "../src/code-table.js";

/**
 * ADR 0206 point 4: a quick change's design.md says what the code will have, in one table under
 * "## In the code". Read deterministically, and refused at the plan hand-off when it doesn't
 * read, with its line and what to fix. No I/O here: the caller gives the files' text.
 */

const QUICK = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/conform-quick");
const DESIGN = readFileSync(join(QUICK, "change/design.md"), "utf8");
const TASKS = readFileSync(join(QUICK, "change/tasks.md"), "utf8");
const SPEC = readFileSync(join(QUICK, "change/specs/refund-receipts/spec.md"), "utf8");
const SPECS = [{ path: "specs/refund-receipts/spec.md", text: SPEC }];
const MAP = new Set(["forge-refunds", "forge-ledger", "forge.refunds.settled"]);
const ctx = (o: { tasks?: string; planned?: string[] } = {}) => ({
  tasks: o.tasks ?? TASKS,
  specs: SPECS,
  has: (id: string) => MAP.has(id),
  planned: o.planned ?? ["forge.receipts.issued"],
});
const HEAD = [
  "## In the code",
  "",
  "| Repo | Task | Has | What | Spec |",
  "| --- | --- | --- | --- | --- |",
];
const withRows = (...rows: string[]) => ["# Design", "", ...HEAD, ...rows, ""].join("\n");
const messages = (text: string, o?: Parameters<typeof ctx>[0]) =>
  checkCodeTable(parseCodeTable(text), ctx(o)).map((r) => `${r.line}: ${r.message}`);

describe("design.md's In the code (ADR 0206)", () => {
  it("reads every row of the fixture, with its line, and passes", () => {
    const t = parseCodeTable(DESIGN);
    expect(t.problems).toEqual([]);
    expect(t.rows.map((r) => [r.line, r.repo, r.task, r.has])).toEqual([
      [15, "forge-refunds", "r1", "listens"],
      [16, "forge-refunds", "r1", "table"],
      [17, "forge-refunds", "r1", "column"],
      [18, "forge-refunds", "r1", "migration"],
      [19, "forge-refunds", "r1", "publishes"],
      [20, "forge-refunds", "r2", "serves"],
      [21, "forge-refunds", "r2", "calls"],
      [22, "forge-refunds", undefined, "other"],
      [23, "forge-refunds", "r2", "deployment"],
      [24, "forge-refunds", "r2", "route"],
      [25, "forge-refunds", "r1", "config"],
      [26, "forge-refunds", "r1", "secret"],
      [27, "forge-refunds", "r2", "pipeline"],
      [28, "forge-refunds", undefined, "cut-over"],
    ]);
    // The operation rows read as an operation's sets (pairsOf).
    expect(t.rows.slice(8).map((r) => pairsOf(r.what) ?? r.what)).toEqual([
      { platform: "anvil", env: "prod" },
      { host: "refunds.anvil.forge.example", basePath: "/refunds" },
      { key: "refunds.receipts.keep", env: "prod", value: "7y" },
      { key: "refunds.signing.key", env: "prod" },
      { file: ".anvil/pipeline.yaml" },
      "undo: point the route back at the hosts, which stay up one release",
    ]);
    expect(t.rows[6]!.what).toBe("forge-ledger GET /v1/accounts/{id}");
    expect(t.rows[0]!.spec).toBe("refund-receipts: A settled refund gets a receipt");
    expect(checkCodeTable(t, ctx())).toEqual([]);
  });

  it("a value with a comma reads whole: quoted, in backticks, or plain (v31 gate 0)", () => {
    // Gate 0: `spring.profiles.active` is `postgres,spring-data-jpa`, and no form of it read.
    const want = { key: "spring.profiles.active", env: "prod", value: "postgres,spring-data-jpa" };
    expect(
      pairsOf('key spring.profiles.active, env prod, value "postgres,spring-data-jpa"'),
    ).toEqual(want);
    expect(
      pairsOf("key spring.profiles.active, env prod, value `postgres,spring-data-jpa`"),
    ).toEqual(want);
    expect(pairsOf("key spring.profiles.active, env prod, value postgres,spring-data-jpa")).toEqual(
      want,
    );
    // Plain, a space after the comma is dropped, so it compares with the value as code holds it.
    expect(pairsOf("key hosts, value a.example, b.example")).toEqual({
      key: "hosts",
      value: "a.example,b.example",
    });
    // Quoted, the value is kept as written.
    expect(pairsOf('key hosts, value "a.example, b.example"')).toEqual({
      key: "hosts",
      value: "a.example, b.example",
    });
    // A pair's word after a comma still starts a pair; a quote keeps it in the value.
    expect(pairsOf("key k, value a, env prod")).toEqual({ key: "k", value: "a", env: "prod" });
    expect(pairsOf('key k, value "a, env prod"')).toEqual({ key: "k", value: "a, env prod" });
    expect(pairsOf("receipts are kept, for seven years")).toBeUndefined();
  });

  it("only a value is joined: every other pair, a secret's included, still refuses a stray piece", () => {
    // Review of PR #4: joining any pair let a bare secret ride in an env, and hid mistyped words.
    expect(pairsOf("key ledger.client.key, env prod, s3cr3tValue")).toBeUndefined();
    expect(pairsOf("key ledger.client.key, s3cr3tValue")).toBeUndefined();
    expect(pairsOf("host orders.example, basepath /orders")).toBeUndefined();
    expect(pairsOf("platform anvil, environment prod")).toBeUndefined();
    expect(pairsOf("host a.example, /x")).toBeUndefined();
    expect(pairsOf("platform anvil, prod")).toBeUndefined();
    expect(pairsOf("file .anvil/a.yaml, .anvil/b.yaml")).toBeUndefined();
  });

  it("a quote that isn't closed, or doesn't wrap the whole value, doesn't read", () => {
    expect(pairsOf('key k, value "abc, env prod')).toBeUndefined();
    expect(pairsOf('key k, value "a", "b"')).toBeUndefined();
    expect(pairsOf('key k, value "a",b')).toBeUndefined();
    expect(pairsOf("key k, value `a")).toBeUndefined();
  });

  it("a secret row with a stray piece is refused at the check, as before", () => {
    const design = DESIGN.replace(
      "key refunds.signing.key, env prod",
      "key refunds.signing.key, env prod, s3cr3t",
    );
    expect(design).not.toBe(DESIGN);
    expect(
      checkCodeTable(parseCodeTable(design), ctx())
        .map((p) => p.message)
        .join(" "),
    ).toMatch(/a secret row needs pairs from key, env/);
  });

  it("a config row with a comma in its value passes the check", () => {
    const design = DESIGN.replace(
      "key refunds.receipts.keep, env prod, value 7y",
      "key refunds.receipts.keep, env prod, value 7y,30d",
    );
    expect(design).not.toBe(DESIGN);
    const t = parseCodeTable(design);
    expect(pairsOf(t.rows[10]!.what)).toEqual({
      key: "refunds.receipts.keep",
      env: "prod",
      value: "7y,30d",
    });
    expect(checkCodeTable(t, ctx())).toEqual([]);
  });

  it("CRLF and a UTF-8 mark read the same", () => {
    const crlf = "﻿" + DESIGN.replace(/\n/g, "\r\n");
    expect(parseCodeTable(crlf).rows.map((r) => r.line)).toEqual(
      parseCodeTable(DESIGN).rows.map((r) => r.line),
    );
  });

  it("refuses a design with no table, saying what to add", () => {
    expect(messages("# Design\n\n## Decisions\n\n- One.\n")).toEqual([
      "1: design.md doesn't say what the code will have: add ## In the code with the columns Repo, Task, Has, What, Spec, a row for each thing a repo's code or deployment will have. A repo whose work no scan can see gets a row with Has other.",
    ]);
  });

  it("a table inside a code fence or an HTML comment isn't read", () => {
    const fenced = [
      "# Design",
      "",
      "```",
      ...HEAD,
      "| forge-refunds | r1 | table | `t` | - |",
      "```",
      "",
    ].join("\n");
    expect(parseCodeTable(fenced).rows).toEqual([]);
    const commented = [
      "# Design",
      "",
      "<!--",
      ...HEAD,
      "| forge-refunds | r1 | table | `t` | - |",
      "-->",
      "",
    ].join("\n");
    expect(parseCodeTable(commented).rows).toEqual([]);
    expect(parseCodeTable("a\u0000b").problems[0]).toMatchObject({ line: 1 });
  });

  it("refuses a row it can't be sure of, with its line and what to fix", () => {
    const text = withRows(
      "| forge-nowhere | r1 | table | `t` | - |",
      "| forge-refunds | r9 | table | `t` | - |",
      "| forge-refunds | r1 | builds | `t` | - |",
      "| forge-refunds | r2 | serves | /v1/x | - |",
      "| forge-refunds | r2 | calls | `forge-nobody GET /v1/x` | - |",
      "| forge-refunds | r1 | publishes | `forge.never.heard` | - |",
      "| forge-refunds | r1 | table | `t` | refund-receipts: A requirement nobody wrote |",
      "| forge-refunds | r1 | cut-over | undo: n/a | - |",
      "| forge-refunds | r1 | secret | key ledger.client.key, value x | - |",
      "| forge-refunds | r1 | deployment | platform | - |",
      "| forge-refunds | r1 | table |",
    );
    expect(messages(text)).toEqual([
      "7: design.md:7: Repo names forge-nowhere, which tasks.md doesn't have under a ## heading.",
      "8: design.md:8: Task names r9, which tasks.md doesn't have under ## forge-refunds.",
      '9: design.md:9: Has is "builds", which is none of serves, listens, calls, publishes, table, column, migration, deployment, route, config, secret, pipeline, cut-over, other.',
      "10: design.md:10: a serves row needs METHOD /path, for example GET /v1/refunds/{id}.",
      '11: design.md:11: the row names forge-nobody, which is not in the map and not listed under "## Planned". Name an id the map has (atticus query forge-nobody), or list it under Planned in requirements.md.',
      '12: design.md:12: the row names forge.never.heard, which is not in the map and not listed under "## Planned". Name an id the map has (atticus query forge.never.heard), or list it under Planned in requirements.md.',
      "13: design.md:13: Spec names refund-receipts: A requirement nobody wrote, which specs/ doesn't have as a ### Requirement: under specs/refund-receipts/.",
      "14: design.md:14: a cut-over row needs undo: and one or two sentences that say how it is taken back.",
      "15: design.md:15: a secret row never gives a value: name its key, and keep the value where secrets are kept.",
      "16: design.md:16: a deployment row needs pairs from platform, env, for example platform anvil, env prod.",
      "17: design.md:17: this row has 3 cells, not the five Repo, Task, Has, What, Spec.",
    ]);
  });

  it("refuses a repo of tasks.md with no row", () => {
    const tasks = `${TASKS}\n## forge-ledger\n\n- [ ] l1 Serve the account's name\n`;
    expect(messages(DESIGN, { tasks })).toEqual([
      "1: design.md: forge-ledger has tasks and no row in ## In the code.",
    ]);
  });

  it("nets the map's names in the spec deltas that no row names: a note, never a refusal", () => {
    const t = parseCodeTable(withRows("| forge-refunds | r1 | table | `refund_receipts` | - |"));
    const notes = specNamesNotInRows(
      t,
      SPECS,
      (id) => MAP.has(id) || id === "forge.receipts.issued",
    );
    expect(notes).toEqual([
      "specs/refund-receipts/spec.md:5 names forge.refunds.settled, and no row of ## In the code does, so the code isn't checked for it.",
      "specs/refund-receipts/spec.md:5 names forge.receipts.issued, and no row of ## In the code does, so the code isn't checked for it.",
      "specs/refund-receipts/spec.md:15 names GET /v1/refunds/{id}/receipt, and no row of ## In the code does, so the code isn't checked for it.",
      "specs/refund-receipts/spec.md:15 names forge-ledger, and no row of ## In the code does, so the code isn't checked for it.",
    ]);
    expect(specNamesNotInRows(parseCodeTable(DESIGN), SPECS, (id) => MAP.has(id))).toEqual([]);
  });
});
