import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { openDb } from "../src/db.js";
import { GAP_STEP, gapNameOf, gapQuestion, openIndex, type CatalogIndex } from "../src/index.js";
import { CONTEXT, contextRoot, STAGES } from "./helpers.js";

interface ExpectedLink {
  from: string;
  to?: string;
  type?: string;
  how?: string;
}

function allLinks(ix: CatalogIndex): Required<ExpectedLink>[] {
  const keys = (ix.db.prepare("SELECT key FROM nodes ORDER BY key").all() as { key: string }[]).map(
    (r) => r.key,
  );
  return keys.flatMap((k) =>
    ix
      .links(k)
      .filter((l) => l.dir === "out")
      .map((l) => ({ from: k, to: l.id, type: l.type, how: l.how })),
  );
}

const counts = (ix: CatalogIndex) =>
  Object.fromEntries(
    (
      ix.db.prepare("SELECT kind, count(*) AS n FROM nodes GROUP BY kind ORDER BY kind").all() as {
        kind: string;
        n: number;
      }[]
    ).map((r) => [r.kind, r.n]),
  );

describe("the graph in the index (ADR 0107 point 1)", () => {
  it("reads flows from the repos' spec folders only: specs/estate.yaml is the estate's joins, not a flow", async () => {
    const root = await contextRoot();
    await writeFile(
      join(root, "specs/estate.yaml"),
      "schemaVersion: 1\njoins: []\nunmatched: []\n",
    );
    const ix = await openIndex(root);
    expect(ix.problems).toEqual([]);
    ix.close();
  });

  it("holds knowledge, flows, changes, answered questions and wiki sections, linked as expected", async () => {
    const root = await contextRoot();
    const expected = parse(readFileSync(join(CONTEXT, "expected/graph.yaml"), "utf8")) as {
      nodes: Record<string, number>;
      links: Required<ExpectedLink>[];
      absent: ExpectedLink[];
    };
    const ix = await openIndex(root);
    expect(ix.problems).toEqual([]);
    expect(counts(ix)).toEqual(Object.fromEntries(Object.entries(expected.nodes).sort()));
    const links = allLinks(ix);
    for (const l of expected.links) expect(links, JSON.stringify(l)).toContainEqual(l);
    for (const a of expected.absent) {
      const hit = links.filter(
        (l) =>
          l.from === a.from &&
          (a.to === undefined || l.to === a.to) &&
          (a.type === undefined || l.type === a.type),
      );
      expect(hit, JSON.stringify(a)).toEqual([]);
      if (!a.type)
        expect(ix.db.prepare("SELECT key FROM nodes WHERE key = ?").get(a.from)).toBeUndefined();
    }
    // The catalog is as before.
    expect(ix.query("kind:endpoint").total).toBe(4);
    expect(ix.systemOf("Endpoint", "forge-orders.post-orders")).toBe("forge");
    ix.close();
  });

  it("re-reads only the files that changed, drops a removed file's rows, and rematches names when they change", async () => {
    const root = await contextRoot();
    const a = await openIndex(root);
    expect(a.rebuilt).toBe(true);
    const v1 = a.version;
    a.close();

    const b = await openIndex(root);
    expect(b.rebuilt).toBe(false);
    expect(b.update?.changed).toEqual([]);
    expect(b.version).toBe(v1);
    b.close();

    // One knowledge item changes: only it is read again, and its links follow.
    const item = join(root, "knowledge/items/decision/card-tokens-only.yaml");
    const text = await readFile(item, "utf8");
    await writeFile(
      item,
      text.replace("Only card tokens go to NWP", "Only card tokens go to the Forge Shop vendor"),
    );
    const c = await openIndex(root);
    expect(c.update?.changed).toEqual(["knowledge/items/decision/card-tokens-only.yaml"]);
    expect(c.update?.rematched).toBe(false);
    const decision = c.links("knowledge:Decision:card-tokens-only").filter((l) => l.dir === "out");
    expect(decision.map((l) => `${l.id} ${l.how}`)).toContain("forge mention alias:org-pack");
    expect(c.version).not.toBe(v1);
    c.close();

    // A removed file's rows and links go.
    await rm(join(root, "openspec/changes/add-fraud-check/needs.yaml"));
    const d = await openIndex(root);
    expect(d.update?.removed).toEqual(["openspec/changes/add-fraud-check/needs.yaml"]);
    expect(d.nodes("add-fraud-check:vendor-onboarding:flow:forge-orders.place-order")).toEqual([]);
    expect(
      d.db.prepare("SELECT count(*) AS n FROM links WHERE file LIKE '%needs.yaml'").get(),
    ).toEqual({ n: 0 });
    d.close();

    // A new alias in the org pack: every node's mentions are matched again.
    const profile = join(root, "org-pack/profiles/forge/profile.yaml");
    await writeFile(
      profile,
      (await readFile(profile, "utf8")).replace("aliases: [NWP]", "aliases: [NWP, Messaging team]"),
    );
    const e = await openIndex(root);
    expect(e.update?.changed).toEqual(["org-pack/profiles/forge/profile.yaml"]);
    expect(e.update?.rematched).toBe(true);
    expect(
      e
        .links("knowledge:ProcessDefinition:broker-topic-request")
        .map((l) => `${l.dir} ${l.id} ${l.how}`),
    ).toContain("out northwind-pay mention alias:org-pack");
    e.close();
  });

  it("gives the same version and the same rows for the same files, however it got there", async () => {
    const root = await contextRoot();
    (await openIndex(root)).close();
    const f = join(root, "knowledge/items/decision/card-tokens-only.yaml");
    const was = await readFile(f, "utf8");
    await writeFile(f, was.replace("NWP", "Northwind Pay"));
    (await openIndex(root)).close();
    await writeFile(f, was);
    const step = await openIndex(root);
    const fresh = await openIndex(root, { rebuild: true, file: join(root, ".index/fresh.sqlite") });
    expect(step.version).toBe(fresh.version);
    expect(allLinks(step)).toEqual(allLinks(fresh));
    expect(counts(step)).toEqual(counts(fresh));
    step.close();
    fresh.close();
  });

  it("rebuilds an index of an older version once", async () => {
    const root = await contextRoot();
    const file = join(root, ".index/catalog.sqlite");
    await mkdir(dirname(file), { recursive: true });
    const old = openDb(file);
    old.exec(
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('version', '1'); CREATE TABLE records (kind TEXT, id TEXT);",
    );
    old.close();
    const a = await openIndex(root);
    expect(a.rebuilt).toBe(true);
    expect(a.query("kind:system").total).toBe(2);
    a.close();
    const b = await openIndex(root);
    expect(b.rebuilt).toBe(false);
    b.close();
  });
});

describe("search (ADR 0107 point 2)", () => {
  it("ranks names and ids above prose, and filters by kind", async () => {
    const ix = await openIndex(await contextRoot());
    const flows = ix.search("reserve stock", { kinds: ["Flow"] });
    expect(flows[0]?.id).toBe("forge-stock.reserve-stock");
    // "firewall" is the item's name and the section's heading; a page that only mentions it ranks below.
    const fw = ix.search("firewall", { limit: 5 });
    expect(
      fw
        .slice(0, 2)
        .map((h) => h.id)
        .sort(),
    ).toEqual([
      "firewall-rule-request",
      "forge-wiki/service-desk-catalogue.md#Network firewall rule",
    ]);
    expect(
      ix.search("firewall", { kinds: ["WikiSection"] }).every((h) => h.kind === "WikiSection"),
    ).toBe(true);
    expect(ix.search("the and of")).toEqual([]);
    ix.close();
  });
});

interface SelectCase {
  name: string;
  input: { file?: string; text?: string };
  kinds: string[];
  budget: number;
  must: string[];
  never: string[];
  /** id → ids that must rank above it, when it is picked. */
  below?: Record<string, string[]>;
  unknown: string[];
}

describe("selectContext (ADR 0107 point 3)", () => {
  const cases = parse(readFileSync(join(CONTEXT, "expected/select.yaml"), "utf8")) as SelectCase[];
  for (const c of cases)
    it(`picks the expected context: ${c.name}`, async () => {
      const ix = await openIndex(await contextRoot());
      const text = c.input.file
        ? readFileSync(join(CONTEXT, "expected", c.input.file), "utf8")
        : c.input.text!;
      const title = /^#\s+(.+)$/m.exec(text)?.[1];
      const s = ix.selectContext(
        { text, ...(title ? { title } : {}) },
        { budget: c.budget, kinds: c.kinds },
      );
      const ids = s.picked.map((p) => p.id);
      for (const m of c.must) expect(ids, m).toContain(m);
      for (const n of c.never) expect(ids, n).not.toContain(n);
      for (const [low, highs] of Object.entries(c.below ?? {}))
        if (ids.includes(low))
          for (const h of highs)
            expect(ids.indexOf(h), `${h} above ${low}`).toBeLessThan(ids.indexOf(low));
      expect(s.unknown).toEqual(c.unknown);
      expect(s.picked.every((p) => c.kinds.includes(p.kind))).toBe(true);
      expect(s.tokens).toBeLessThanOrEqual(c.budget);
      ix.close();
    });

  it("is deterministic and cached by the input's hash and the index's version", async () => {
    const root = await contextRoot();
    const brief = readFileSync(join(STAGES, "changes/add-fraud-check/brief.md"), "utf8");
    const a = await openIndex(root);
    const one = a.selectContext(
      { text: brief, title: "Screen orders for fraud" },
      { budget: 3000 },
    );
    const two = a.selectContext(
      { text: brief, title: "Screen orders for fraud" },
      { budget: 3000 },
    );
    expect(one.cached).toBe(false);
    expect(two.cached).toBe(true);
    expect({ ...two, cached: false }).toEqual(one);
    a.close();
    // Another index built from the same files selects the same.
    const b = await openIndex(root, { rebuild: true, file: join(root, ".index/other.sqlite") });
    const three = b.selectContext(
      { text: brief, title: "Screen orders for fraud" },
      { budget: 3000 },
    );
    expect(three.picked).toEqual(one.picked);
    expect(three.sources).toEqual(one.sources);
    b.close();
  });

  it("fits the budget: full detail for the top, one line for the next, and lists what it left out", async () => {
    const ix = await openIndex(await contextRoot());
    const brief = readFileSync(join(STAGES, "changes/add-fraud-check/brief.md"), "utf8");
    const s = ix.selectContext({ text: brief }, { budget: 700 });
    expect(s.tokens).toBeLessThanOrEqual(700);
    const levels = s.picked.map((p) => p.level);
    expect(levels[0]).toBe("full");
    expect(levels).toContain("line");
    // Full first, then lines: never a full one after a line.
    expect(levels.indexOf("line")).toBeGreaterThan(levels.lastIndexOf("full"));
    expect(s.leftOut.length).toBeGreaterThan(0);
    for (const scores of [s.picked.map((p) => p.score), s.leftOut.map((l) => l.score)])
      expect(scores).toEqual([...scores].sort((x, y) => y - x));
    // Ready for buildContextPack: unique ids, priorities falling, the lines last.
    expect(new Set(s.sources.map((x) => x.id)).size).toBe(s.sources.length);
    const pr = s.sources.map((x) => x.priority);
    expect(pr).toEqual([...pr].sort((x, y) => y - x));
    expect(s.sources.at(-1)!.id).toBe("ctx-lines");
    // Every source names where it was read: a fact keeps its provenance.
    for (const x of s.sources.filter((x) => x.id !== "ctx-lines"))
      expect(x.origin).toMatch(/\.(ya?ml|md)$/);
    ix.close();
  });

  it("leaves out an item a person rejected, and what the step excludes", async () => {
    const root = await contextRoot();
    await writeFile(
      join(root, "knowledge/reviews/fraud-screen.yaml"),
      "schemaVersion: 1\nitem: fraud-screen\nverdict: rejected\nby: pat\nat: 2026-10-03T09:00:00Z\nnote: Not the product we use.\nchecked: 0123456789abcdef\n",
    );
    const ix = await openIndex(root);
    const brief = readFileSync(join(STAGES, "changes/add-fraud-check/brief.md"), "utf8");
    const s = ix.selectContext(
      { text: brief },
      {
        budget: 4000,
        exclude: ["card-tokens-only"],
        kinds: ["Product", "Decision", "ProcessDefinition"],
      },
    );
    const ids = s.picked.map((p) => p.id);
    expect(ids).not.toContain("fraud-screen");
    expect(ids).not.toContain("card-tokens-only");
    expect(ids).toContain("vendor-onboarding");
    ix.close();
  });

  it("updates after one changed file by reading only that file, and selects", async () => {
    const root = await contextRoot();
    (await openIndex(root)).close();
    const f = join(root, "knowledge/items/decision/card-tokens-only.yaml");
    const text = await readFile(f, "utf8");
    await writeFile(f, text.replace("never leaves the shop", "never leaves the Forge shop"));
    let t = performance.now();
    const ix = await openIndex(root);
    const updateMs = performance.now() - t;
    expect(ix.update?.changed).toHaveLength(1);
    const brief = readFileSync(join(STAGES, "changes/add-fraud-check/brief.md"), "utf8");
    t = performance.now();
    ix.selectContext({ text: brief, title: "Screen orders for fraud" }, { budget: 4000 });
    const selectMs = performance.now() - t;
    t = performance.now();
    ix.selectContext({ text: brief, title: "Screen orders for fraud" }, { budget: 4000 });
    const cachedMs = performance.now() - t;
    ix.close();
    console.log(
      `context engine timings: update after one file ${updateMs.toFixed(1)} ms, select ${selectMs.toFixed(1)} ms, cached select ${cachedMs.toFixed(1)} ms`,
    );
    // Times are reported, not asserted: a runner busy with every package's tests at once took
    // over a second for what takes 27 ms alone. What is asserted is the work: one file re-read.
  });
});

describe("gaps (ADR 0107 point 5)", () => {
  const brief = `# Score orders with Quillfeather Risk\n\nSend each new order to Quillfeather Risk before stock is reserved.\n`;

  it("a gap a person answered is known from then on, by that answer, with who and when", async () => {
    const root = await contextRoot();
    const before = await openIndex(root);
    expect(before.selectContext({ text: brief }, { budget: 3000 }).unknown).toEqual([
      "Quillfeather Risk",
    ]);
    before.close();
    await writeFile(
      join(root, "questions/q-a1b2c3d4e5f6.yaml"),
      stringify({
        schemaVersion: 1,
        id: "q-a1b2c3d4e5f6",
        askedBy: {
          step: GAP_STEP,
          command: "atticus change feature score-orders",
          at: "2026-10-23T09:00:00Z",
        },
        repo: "score-orders",
        question: gapQuestion("Quillfeather Risk"),
        options: [],
        evidence: ["openspec/changes/score-orders/brief.md:1"],
        scope: { level: "repo", id: "score-orders" },
        state: "answered",
        rerun: "atticus change feature score-orders",
        answer: {
          text: "A risk-scoring vendor the payments team is trialling; not onboarded yet.",
          by: "sam",
          at: "2026-10-23T10:00:00Z",
          scope: { level: "repo", id: "score-orders" },
        },
      }),
    );
    const ix = await openIndex(root);
    const s = ix.selectContext({ text: brief }, { budget: 3000 });
    expect(s.unknown).toEqual([]);
    const q = s.picked.find((p) => p.id === "q-a1b2c3d4e5f6");
    expect(q?.via).toBe("named in the input");
    const [node] = ix.nodes("q-a1b2c3d4e5f6");
    expect(node?.detail).toMatch(/Answer, by sam at 2026-10-23T10:00:00Z: A risk-scoring vendor/);
    expect(
      gapNameOf({ askedBy: { step: GAP_STEP }, question: gapQuestion("Quillfeather Risk") }),
    ).toBe("Quillfeather Risk");
    expect(
      gapNameOf({ askedBy: { step: "change-feature" }, question: gapQuestion("X") }),
    ).toBeUndefined();
    ix.close();
  });
});
