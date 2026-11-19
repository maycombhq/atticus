import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { main } from "../src/main.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ask-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  for (const r of parse(readFileSync(join(FIXTURES, "forge/expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) continue;
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
});

const run = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...args, "--root", root], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

describe("atticus ask", () => {
  it("shows how it read the question and the query, then the answer", async () => {
    const r = await run(["ask", "who calls ledger-api?"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Query: kind:interface to:ledger-api");
    expect(r.out).toMatch(/portal-bff/);
  });

  it("walks impact when the question asks what breaks", async () => {
    const r = await run(["ask", "what breaks if ledger-api changes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Query: impact ledger-api");
  });

  it("names a topic's consumers as impact does (ADR 0201: the trial's question got none)", async () => {
    const r = await run(["ask", "who consumes the topic transfers.completed?"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "Read as: who receives topic.transfers-completed: the receivers first, then what a change reaches past them.",
    );
    expect(r.out).toContain("Query: impact topic.transfers-completed");
    expect(r.out).toContain("topic.transfers-completed is received by 1 component:");
    type Walk = { kind: string; id: string }[];
    const components = (a: Walk) =>
      a
        .filter((x) => x.kind === "Component")
        .map((x) => x.id)
        .sort();
    const asked = JSON.parse(
      (await run(["ask", "who consumes the topic transfers.completed?", "--json"])).out,
    ) as { receivers: Walk; affected: Walk; further: Walk };
    const walked = JSON.parse(
      (await run(["impact", "topic.transfers-completed", "--json"])).out,
    ) as {
      affected: Walk;
    };
    // Every component the walk names is in the answer (ADR 0201), the receivers apart from what
    // lies past them (the b30 proof run: a receiver's own callers read as receivers).
    expect(components([...asked.affected, ...asked.further])).toEqual(components(walked.affected));
    expect(asked.receivers.map((x) => x.id)).toEqual(["reports-job"]);
  });

  it("keeps how it read the question in --json, as readAs and query", async () => {
    const r = await run(["ask", "who calls ledger-api?", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { readAs: string; query: string; total: number };
    expect(j.readAs).toBe("Read as: the interfaces whose callee is ledger-api.");
    expect(j.query).toBe("kind:interface to:ledger-api");
    expect(j.total).toBeGreaterThan(0);
  });

  it("says a name the map lacks is not in the map, and never lists every interface", async () => {
    const r = await run(["ask", "who calls forge-portal?"]);
    expect(r.code).toBe(0);
    // Which of the three it is follows the sentence (ADR 0201 addendum, 2026-11-19).
    expect(r.out).toContain(
      "forge-portal is not in the map: planned or not read. Neither: no manifest lists forge-portal and no open change plans it. Did you mean forge-portal-ui?",
    );
    expect(r.out).toContain("0 records");
    expect(r.out).not.toMatch(/portal-bff|ledger-api/);
    const j = JSON.parse((await run(["ask", "who calls forge-portal?", "--json"])).out) as {
      readAs: string;
      total: number;
    };
    expect(j.total).toBe(0);
    expect(j.readAs).toMatch(
      /forge-portal is not in the map: planned or not read\. Neither: .* Did you mean forge-portal-ui\?$/,
    );
  });

  it('says what is wrong, never "planned or not read", where the map can\'t be read (review)', async () => {
    const at = async (dir: string, ...args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(["ask", "who calls forge-portal?", ...args, "--root", dir], {
        out: (l) => out.push(l),
        err: (l) => err.push(l),
      });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    // A folder that is no metarepo.
    const bare = await mkdtemp(join(tmpdir(), "atticus-ask-bare-"));
    // A metarepo with no catalog yet.
    const empty = await mkdtemp(join(tmpdir(), "atticus-ask-empty-"));
    await cp(join(FIXTURES, "forge/metarepo"), empty, { recursive: true });
    // The Forge catalog with one record file that doesn't read.
    const broken = await mkdtemp(join(tmpdir(), "atticus-ask-broken-"));
    await cp(root, broken, { recursive: true });
    await writeFile(
      join(broken, "catalog/generated/component/quillfeather.yaml"),
      "kind: Component\nid: [oops\n",
    );
    for (const [dir, why] of [
      [bare, /is not a metarepo/],
      [empty, /The map holds no records/],
      [broken, /couldn't be read whole[\s\S]*quillfeather\.yaml/],
    ] as const)
      for (const json of [[], ["--json"]]) {
        const r = await at(dir, ...json);
        expect(r.code, `${String(why)} ${json.join("")}`).toBe(1);
        expect(r.err).toMatch(why);
        expect(r.out + r.err).not.toMatch(/planned or not read/);
        expect(r.out).not.toMatch(/0 records|"total"/);
      }
    // Read whole, the same question is answered: the name is planned or not read.
    expect((await run(["ask", "who calls forge-portal?"])).code).toBe(0);
  }, 120_000);

  it("needs a question", async () => {
    expect((await run(["ask"])).code).toBe(2);
  });
});

describe("atticus ask: every reading the base had is kept (ADR 0201, review of b30/tools)", () => {
  /**
   * Each question with the query it was read as on origin/release/b30 (b2febfd6), generated by
   * running that commit's translate on this fixture. None may move.
   */
  const BASE: [string, string][] = [
    ["who calls ledger-api?", "kind:interface to:ledger-api"],
    ["what calls the gateway", "kind:interface via:gateway"],
    ["which interfaces use the gateway", "kind:interface via:gateway"],
    ["which interfaces use the event bus", "kind:interface via:event-bus"],
    ["who uses pii", "kind:column classification:personal*"],
    ["what breaks if ledger-api changes", "impact ledger-api"],
    ["what is affected by a change to ledger-db.entry", "impact ledger-db.entry"],
    ["what does portal-bff call?", "kind:interface from:portal-bff"],
    ["who reads the ledger-db.entry table", "refby:ledger-db.entry kind:component"],
    ["who writes ledger-db.entry", "refby:ledger-db.entry kind:component"],
    ["who owns ledger-api", "ledger-api"],
    ["list the tables in ledger", "kind:table system:ledger"],
    ["personal data in ledger", "kind:column system:ledger classification:personal*"],
    ["show gateway interfaces without a pattern", "kind:interface via:gateway missing:pattern"],
    ["interfaces seen at one end", "kind:interface confidence:inferred -flags:joined-by-person"],
    ["what calls are inferred?", "kind:interface confidence:inferred"],
    ["which calls go through the gateway", "kind:interface via:gateway"],
    ["list the topics", "kind:topic"],
    ["show all endpoints", "kind:endpoint"],
    ["daily transfer limit", "daily transfer limit"],
    ["who calls audit-svc", "kind:interface to:audit-svc"],
    ["which services use ledger-db", "kind:interface to:ledger-db"],
    ["who uses the event bus", "uses event bus"],
    ["what uses events", "uses events"],
    ["which components are in portal", "kind:component system:portal"],
    ["who consumes ledger-api", "kind:interface to:ledger-api"],
    ["what calls northwind-pay", "kind:interface to:northwind-pay"],
    ["who uses forge-portal", "uses forge-portal"],
    ["what breaks if transfers.completed changes", "breaks transfers.completed changes"],
    ["list interfaces for transfers.completed", "kind:interface"],
    ["who reads entry", "refby:ledger-db.entry kind:component"],
    ["what depends on audit-svc", "impact audit-svc"],
    ["who calls the ledger", "kind:interface to:ledger"],
    ["which interfaces use ledger-api", "kind:interface to:ledger-api"],
    ["which interfaces use quillfeather", "kind:interface"],
  ];
  /** The only readings that changed: the consumer and caller cases the ADR fixes, with the base's. */
  const FIXED: [string, string, string][] = [
    ["who calls forge-portal?", "kind:interface", "kind:interface to:forge-portal"],
    // The b30 proof run: a name the map lacks was a word search that found nothing.
    [
      "who consumes the topic forge.orders.shipped?",
      "consumes topic forge.orders.shipped",
      "kind:endpoint pathOrTopic:forge.orders.shipped",
    ],
    [
      "who publishes forge.orders.shipped?",
      "publishes forge.orders.shipped",
      "kind:endpoint pathOrTopic:forge.orders.shipped",
    ],
    ["what does forge-portal call?", "forge-portal call", "kind:interface from:forge-portal"],
    // An entry's callers are the interfaces that name it; a topic's publishers the same.
    [
      "who calls ledger-api.post-transfer?",
      "kind:interface to:ledger-api.post-transfer",
      "kind:interface endpoint:ledger-api.post-transfer",
    ],
    [
      "who publishes transfers.completed?",
      "publishes transfers.completed",
      "kind:interface endpoint:topic.transfers-completed",
    ],
    [
      "who consumes topic.transfers-completed?",
      "kind:interface to:topic.transfers-completed",
      "impact topic.transfers-completed",
    ],
    [
      "who consumes the topic transfers.completed?",
      "consumes topic transfers.completed",
      "impact topic.transfers-completed",
    ],
    [
      "who subscribes to topic.transfers-completed",
      "topic.transfers-completed",
      "impact topic.transfers-completed",
    ],
    [
      "who listens to transfers.completed",
      "listens transfers.completed",
      "impact topic.transfers-completed",
    ],
  ];
  const queryOf = async (q: string) => /^Query: (.*)$/m.exec((await run(["ask", q])).out)?.[1];

  it("keeps the base's reading of each", async () => {
    for (const [q, query] of BASE) expect(await queryOf(q), q).toBe(query);
  }, 120_000);

  it("changes only the consumer and caller cases", async () => {
    for (const [q, was, now] of FIXED) {
      expect(now, q).not.toBe(was);
      expect(await queryOf(q), q).toBe(now);
    }
  }, 60_000);
});

describe("atticus guide and atticus site build", () => {
  it("prints a system's guide, and refuses a system the catalog doesn't have", async () => {
    const r = await run(["guide", "ledger"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("# Ledger (ledger)");
    expect(r.out).toContain("## Who it talks to");
    expect((await run(["guide", "atlantis"])).code).toBe(1);
    expect((await run(["guide"])).code).toBe(2);
  });

  it("writes the static site", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-site-cli-"));
    const r = await run(["site", "build", dir, "--title", "Forge catalog"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/5 systems/);
    expect(await readFile(join(dir, "index.html"), "utf8")).toContain("Forge catalog");
  });
});
