import { readFileSync } from "node:fs";
import { cp, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, type CatalogRecord, type FlowRecord } from "@maycombhq/core";
import { scanEstate } from "@maycombhq/scanner";
import {
  conform,
  readConformDeltas,
  readTaskSteps,
  type ConformDelta,
  type ConformInput,
  type ConformResult,
} from "../src/index.js";

/**
 * ADR 0114: does the code do what the design says? The real scanner reads forge-ledger before
 * and after its tasks; the check compares the records with the transfer limit's target flows.
 * The expected result is hand-written (fixtures/conform/expected).
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const FORGE = join(FIXTURES, "forge");
const CONFORM = join(FIXTURES, "conform");
const T = 300_000;

let afterBasis: ConformInput["basis"];

async function scan(
  dir: string,
  keep?: (b: ConformInput["basis"]) => void,
): Promise<CatalogRecord[]> {
  const s = await scanEstate({
    root: await mkdtemp(join(tmpdir(), "atticus-conform-scan-")),
    orgPack: join(FORGE, "metarepo/org-pack"),
    repos: ["forge-ledger"],
    repoDir: () => dir,
    repoState: async () => ({ commit: "a".repeat(40), dirty: false }),
    cache: null,
    scannedAt: "2026-10-23T09:00:00Z",
    inputsDir: join(FORGE, "inputs"),
  });
  expect(s.problems).toEqual([]);
  keep?.(s.basis?.["forge-ledger"]);
  return s.records;
}

async function files(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await files(dir, p)));
    else out.push(p);
  }
  return out.sort();
}

const today = (): FlowRecord => {
  const p = parseRecord(
    parse(
      readFileSync(join(CONFORM, "specs/forge-ledger/ledger-api.create-transfer.yaml"), "utf8"),
    ),
  );
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  return p.record as FlowRecord;
};

/** The result in the golden file's shape. */
const compact = (r: ConformResult) => ({
  items: r.items.map((i) => ({
    status: i.status,
    check: i.check,
    ...(i.flow ? { flow: i.flow } : {}),
    ...(i.item !== undefined ? { item: i.item } : {}),
    ...(i.task ? { task: i.task } : {}),
    what: i.what,
    ...(i.record ? { record: i.record } : {}),
    at: i.at
      .map((c) => `${c.repo ? `${c.repo}:` : ""}${c.path}${c.line ? `:${c.line}` : ""}`)
      .join(", "),
  })),
  unchecked: r.unchecked.map((u) => ({
    flow: u.flow,
    ...(u.item !== undefined ? { item: u.item } : {}),
    kind: u.kind,
  })),
});

let input: ConformInput;

beforeAll(async () => {
  const after = await mkdtemp(join(tmpdir(), "atticus-conform-after-"));
  await cp(join(FORGE, "repos/forge-ledger"), after, { recursive: true });
  await cp(join(CONFORM, "after/forge-ledger"), after, { recursive: true });
  const change = await mkdtemp(join(tmpdir(), "atticus-conform-change-"));
  await cp(join(CONFORM, "target-flows"), join(change, "target-flows"), { recursive: true });
  await cp(join(CONFORM, "stories"), join(change, "stories"), { recursive: true });
  const read = await readConformDeltas(change);
  expect(read.problems).toEqual([]);
  const flow = today();
  const deltas: ConformDelta[] = read.deltas.map((d) =>
    d.delta.flow === flow.id ? { ...d, today: flow } : d,
  );
  input = {
    repo: "forge-ledger",
    deltas,
    tasks: await readTaskSteps(change),
    before: await scan(join(FORGE, "repos/forge-ledger")),
    after: await scan(after, (b) => (afterBasis = b)),
    files: await files(after),
  };
}, T);

describe("conformance on the Forge fixture (ADR 0114)", () => {
  it("cites each step's line in its target-flow file", () => {
    const d = input.deltas.find((x) => x.delta.flow === "ledger-api.create-transfer")!;
    expect(d.stepLines).toEqual([9, 18, 24, 29]);
    const n = input.deltas.find((x) => x.delta.flow === "ledger-api.get-limit")!;
    expect(n.triggerLine).toBe(8);
  });

  it("reads which task builds which step from the stories", () => {
    expect(Object.fromEntries(input.tasks!)).toEqual({
      "ledger-api.create-transfer#1": "1.1",
      "ledger-api.create-transfer#3": "1.2",
      "ledger-api.create-transfer#4": "1.2",
      "ledger-api.create-transfer#2": "1.3",
    });
  });

  it("finds what is built, what is missing, what is still there and what no target flow names (golden)", () => {
    // Eighth UX walk (rule 4): forge-ledger has no facts here, so its records are the readers'
    // and what they don't find is a step a person checks, not a missing finding.
    expect(afterBasis).toEqual({ from: "readers" });
    const want = parse(readFileSync(join(CONFORM, "expected/result.yaml"), "utf8")) as unknown;
    expect(compact(conform({ ...input, basis: afterBasis }))).toEqual(want);
  });

  it("checks only a task's steps, and still reports what nothing names", () => {
    const r = conform({
      ...input,
      scope: [
        { flow: "ledger-api.create-transfer", item: 3 },
        { flow: "ledger-api.create-transfer", item: 4 },
      ],
    });
    expect(r.items.map((i) => [i.status, i.check, i.item ?? i.record])).toEqual([
      ["still-there", "call", 4],
      ["unexpected", "call", "if-e25b9623de50b834"],
      ["unexpected", "table", "ledger-db.limit-override"],
    ]);
    expect(r.unchecked.map((u) => [u.flow, u.item])).toEqual([["ledger-api.create-transfer", 3]]);
  });

  it("never takes a planned record (a Spec Kit plan's) for code", () => {
    const planned = {
      ...input.after.find((r) => r.id === "if-e25b9623de50b834")!,
      id: "if-planned",
      status: "planned-new",
      method: "POST",
      normalizedPath: "/v2/velocity-checks",
    } as CatalogRecord;
    const r = conform({ ...input, after: [...input.after, planned] });
    expect(r.items.find((i) => i.item === 2 && i.flow === "ledger-api.create-transfer")).toEqual(
      expect.objectContaining({ status: "missing", check: "call" }),
    );
    expect(r.items.some((i) => i.record === "if-planned")).toBe(false);
  });

  it("is deterministic: the same records give the same answer", () => {
    expect(conform(input)).toEqual(conform(input));
  });

  it("says nothing is out of scope when nothing changed, and that the design isn't built", () => {
    const r = conform({ ...input, after: input.before, files: [] });
    expect(r.items.filter((i) => i.status === "unexpected")).toEqual([]);
    expect(r.items.filter((i) => i.status === "missing").map((i) => [i.check, i.item])).toEqual([
      ["migration", 1],
      ["column", 1],
      ["call", 2],
      ["trigger", undefined],
      ["column", 2],
    ]);
  });
});

describe("conformance rules on small records (ADR 0114)", () => {
  const ev = (path: string, line: number) => [
    { source: "code" as const, repo: "forge-orders", path, line },
  ];
  const rec = (r: Record<string, unknown>) =>
    ({ schemaVersion: 2, status: "current", confidence: "verified", ...r }) as CatalogRecord;
  const component = rec({
    kind: "Component",
    id: "forge-orders",
    system: "forge",
    repo: "forge-orders",
    type: "service",
    evidence: ev("pom.xml", 1),
  });
  const delta = (steps: unknown[], o: Record<string, unknown> = {}): ConformDelta => ({
    file: "target-flows/forge-orders.place-order.yaml",
    delta: {
      schemaVersion: 1,
      flow: "forge-orders.place-order",
      repo: "forge-orders",
      change: "modify",
      why: "Orders are screened.",
      steps,
      ...o,
    } as ConformDelta["delta"],
    stepLines: steps.map((_, i) => 10 + i * 5),
    triggerLine: 4,
  });

  it("a publish to a topic is found as a publish not yet joined to its listener", () => {
    const r = conform({
      repo: "forge-orders",
      deltas: [
        delta([
          {
            op: "add",
            after: 1,
            kind: "publish",
            what: "The order is announced",
            to: { component: "forge-stock", entry: "orders.placed", new: false },
          },
        ]),
      ],
      before: [component],
      after: [
        component,
        rec({
          kind: "Unresolved",
          id: "forge-orders.publish.orders.placed",
          unresolvedKind: "event-publish",
          raw: "orders.placed",
          owner: "forge-orders",
          evidence: ev("src/Events.java", 7),
        }),
      ],
      files: [],
    });
    expect(r.items).toEqual([
      expect.objectContaining({
        status: "found",
        check: "publish",
        record: "forge-orders.publish.orders.placed",
        at: [{ source: "code", repo: "forge-orders", path: "src/Events.java", line: 7 }],
      }),
    ]);
  });

  it("a new table and its migration must exist; an unnamed column and endpoint are out of scope", () => {
    const table = rec({
      kind: "Table",
      id: "orders-db.screenings",
      dataStore: "orders-db",
      name: "screenings",
      tableKind: "table",
      evidence: ev("db/V5__screenings.sql", 1),
    });
    // The scan reads the table's columns (it has one): a column the design names is checked.
    const id = rec({
      kind: "Column",
      id: "orders-db.screenings.id",
      table: "orders-db.screenings",
      name: "id",
      type: "bigint",
      evidence: ev("db/V5__screenings.sql", 2),
    });
    const r = conform({
      repo: "forge-orders",
      deltas: [
        delta([
          {
            op: "add",
            after: 1,
            kind: "write",
            what: "The screen is stored",
            store: {
              table: "orders-db.screenings",
              columns: ["verdict"],
              new: true,
              migration: "V5__screenings.sql",
            },
          },
        ]),
      ],
      before: [component],
      after: [
        component,
        table,
        id,
        rec({
          kind: "Column",
          id: "orders-db.orders.notes",
          table: "orders-db.orders",
          name: "notes",
          type: "text",
          evidence: ev("db/V6__notes.sql", 1),
        }),
        rec({
          kind: "Endpoint",
          id: "forge-orders.delete-all",
          component: "forge-orders",
          endpointType: "rest",
          method: "DELETE",
          pathOrTopic: "/orders",
          evidence: ev("src/OrderController.java", 30),
        }),
      ],
      files: ["db/V6__notes.sql"],
    });
    expect(r.items.map((i) => [i.status, i.check, i.record ?? i.at[0]?.line])).toEqual([
      ["missing", "migration", 10],
      ["found", "table", "orders-db.screenings"],
      ["missing", "column", 10],
      ["unexpected", "endpoint", "forge-orders.delete-all"],
      ["unexpected", "column", "orders-db.orders.notes"],
      ["unexpected", "column", "orders-db.screenings.id"],
    ]);
  });

  it("finds a migration the design names with its folder (M7)", () => {
    const r = conform({
      repo: "forge-orders",
      deltas: [
        delta([
          {
            op: "change",
            step: 1,
            kind: "write",
            what: "The verdict is kept",
            store: {
              table: "orders-db.orders",
              columns: [],
              migration: "db/migration/V5__verdict.sql",
            },
          },
        ]),
      ],
      before: [component],
      after: [component],
      files: ["src/main/resources/db/migration/V5__verdict.sql", "db/migration/V6__other.sql"],
    });
    expect(r.items.filter((i) => i.check === "migration")).toEqual([
      expect.objectContaining({
        status: "found",
        at: [
          {
            source: "code",
            repo: "forge-orders",
            path: "src/main/resources/db/migration/V5__verdict.sql",
            line: 1,
          },
        ],
      }),
    ]);
  });

  it("leaves a table's columns unchecked when neither scan read any column of it (M8)", () => {
    const table = rec({
      kind: "Table",
      id: "orders-db.orders",
      dataStore: "orders-db",
      name: "orders",
      tableKind: "table",
      evidence: ev("src/main/resources/mapper/OrderMapper.xml", 3),
    });
    const r = conform({
      repo: "forge-orders",
      deltas: [
        delta([
          {
            op: "change",
            step: 1,
            kind: "write",
            what: "The verdict is kept",
            store: { table: "orders-db.orders", columns: ["fraud_verdict"] },
          },
        ]),
      ],
      before: [component, table],
      after: [component, table],
      files: [],
    });
    expect(r.items.filter((i) => i.check === "column")).toEqual([]);
    expect(r.unchecked).toEqual([
      expect.objectContaining({
        flow: "forge-orders.place-order",
        item: 1,
        why: "The scans read no column of orders-db.orders (its columns are kept where the reader doesn't look), so fraud_verdict can't be checked here.",
      }),
    ]);
  });

  it("a changed step that goes elsewhere: the new call must be there and today's gone", () => {
    const call = (to: string, path: string, line: number) =>
      rec({
        kind: "Interface",
        id: `if-${to}`,
        from: "forge-orders",
        to,
        via: "direct",
        method: "POST",
        normalizedPath: path,
        sync: "sync",
        evidence: ev("src/Clients.java", line),
      });
    const flow = {
      kind: "Flow",
      schemaVersion: 2,
      id: "forge-orders.place-order",
      status: "current",
      confidence: "inferred",
      component: "forge-orders",
      name: "Place an order",
      family: [],
      evidence: [],
      errors: [],
      trigger: { kind: "endpoint", what: "POST /orders", evidence: ev("src/O.java", 1) },
      steps: [
        { kind: "entry", what: "in", refs: [], evidence: ev("src/O.java", 2) },
        {
          kind: "call-out",
          what: "stock",
          refs: [],
          to: { component: "forge-stock", entry: "POST /stock/reservations" },
          evidence: ev("src/Clients.java", 3),
        },
      ],
    } as unknown as FlowRecord;
    const r = conform({
      repo: "forge-orders",
      deltas: [
        {
          ...delta([
            {
              op: "change",
              step: 2,
              kind: "call-out",
              what: "The warehouse reserves the stock",
              to: { component: "forge-warehouse", entry: "POST /holds", new: true },
            },
          ]),
          today: flow,
        },
      ],
      before: [component, call("forge-stock", "/stock/reservations", 3)],
      after: [component, call("forge-stock", "/stock/reservations", 3)],
      files: [],
    });
    expect(r.items.map((i) => [i.status, i.check, i.what])).toEqual([
      [
        "missing",
        "call",
        "forge-orders makes no call to forge-warehouse POST /holds (item 1 of target-flows/forge-orders.place-order.yaml).",
      ],
      [
        "still-there",
        "call",
        "forge-orders still calls forge-stock POST /stock/reservations, which item 1 of target-flows/forge-orders.place-order.yaml sends elsewhere.",
      ],
    ]);
  });
});

describe("only facts that cover the commit say something is missing (eighth UX walk, rule 4)", () => {
  // fixtures/conform-gateway: the gateway proxy's new LockCard flow and its forward to the card
  // vault. The records are what a scan of the task branch gave when no fact covered the changed
  // proxy file: the proxy's component, and nothing for the new code.
  const GATEWAY = join(FIXTURES, "conform-gateway/change");
  const proxy = {
    kind: "Component",
    schemaVersion: 2,
    id: "proxy-core-v1",
    status: "current",
    confidence: "verified",
    system: "platform",
    repo: "forge-proxy-core-v1",
    type: "gateway",
    evidence: [
      { source: "code", repo: "forge-proxy-core-v1", path: "apiproxy/forge-core-v1.xml", line: 1 },
    ],
  } as unknown as CatalogRecord;
  const check = async (basis: ConformInput["basis"]) => {
    const { deltas, problems } = await readConformDeltas(GATEWAY);
    expect(problems).toEqual([]);
    return conform({
      repo: "forge-proxy-core-v1",
      deltas,
      tasks: await readTaskSteps(GATEWAY),
      scope: [
        { flow: "proxy-core-v1.lock-card", item: 1 },
        { flow: "proxy-core-v1.lock-card", item: 2 },
      ],
      before: [proxy],
      after: [proxy],
      files: ["apiproxy/proxies/default.xml"],
      ...(basis ? { basis } : {}),
    });
  };
  const READ_AGAIN =
    "/atticus-map forge-proxy-core-v1, then atticus verify forge-proxy-core-v1 --write";

  it("a changed file no fact covers: the trigger and the forward couldn't be confirmed, never missing", async () => {
    const r = await check({ from: "facts", unread: ["apiproxy/proxies/default.xml"] });
    expect(r.items).toEqual([]);
    expect(r.unchecked.map((u) => [u.item ?? 0, u.kind, u.why])).toEqual([
      [
        0,
        "endpoint",
        `No fact covers what changed in apiproxy/proxies/default.xml since forge-proxy-core-v1 was read, so Atticus couldn't confirm that proxy-core-v1 serves PUT /forge/core/v1/cards/{id}/lock, the trigger of proxy-core-v1.lock-card from the code; check it by hand, or read those files again (${READ_AGAIN}) and check the code again.`,
      ],
      [
        1,
        "entry",
        "A step of this kind names no call, table, column or migration a scan records; a person or a test checks it.",
      ],
      [
        2,
        "call-out",
        `No fact covers what changed in apiproxy/proxies/default.xml since forge-proxy-core-v1 was read, so Atticus couldn't confirm that proxy-core-v1 calls card-vault PUT /cards/{id}/lock from the code; check it by hand, or read those files again (${READ_AGAIN}) and check the code again.`,
      ],
    ]);
  });

  it("the readers alone are a cross-check, so what they don't see couldn't be confirmed", async () => {
    const r = await check({ from: "readers" });
    expect(r.items).toEqual([]);
    expect(
      r.unchecked.filter((u) => /couldn't confirm/.test(u.why)).map((u) => u.item ?? 0),
    ).toEqual([0, 2]);
    expect(r.unchecked[0]!.why).toMatch(
      /^forge-proxy-core-v1 hasn't been read into facts at this commit, and the built-in readers alone are only a cross-check/,
    );
  });

  it("facts that cover the commit decide: what they lack is missing", async () => {
    const r = await check({ from: "facts", unread: [] });
    expect(r.items.map((i) => [i.status, i.check, i.item ?? 0])).toEqual([
      ["missing", "trigger", 0],
      ["missing", "call", 2],
    ]);
  });

  it("a table and columns the readers don't see are one note; a migration file is still checked from git", () => {
    const r = conform({
      repo: "forge-orders",
      deltas: [
        {
          file: "target-flows/forge-orders.place-order.yaml",
          delta: {
            schemaVersion: 1,
            flow: "forge-orders.place-order",
            repo: "forge-orders",
            change: "modify",
            why: "Orders are screened.",
            steps: [
              {
                op: "add",
                after: 1,
                kind: "write",
                what: "The screen is stored",
                store: {
                  table: "orders-db.screenings",
                  columns: ["verdict"],
                  new: true,
                  migration: "V5__screenings.sql",
                },
              },
            ],
          } as ConformDelta["delta"],
          stepLines: [10],
          triggerLine: 4,
        },
      ],
      before: [],
      after: [],
      files: [],
      basis: { from: "readers" },
    });
    expect(r.items.map((i) => [i.status, i.check])).toEqual([["missing", "migration"]]);
    expect(r.unchecked.map((u) => u.why)).toEqual([
      "forge-orders hasn't been read into facts at this commit, and the built-in readers alone are only a cross-check, so Atticus couldn't confirm that the code has the table orders-db.screenings, orders-db.screenings.verdict from the code; check it by hand, or read the repo (/atticus-map forge-orders, then atticus verify forge-orders --write) and check the code again.",
    ]);
  });
});
