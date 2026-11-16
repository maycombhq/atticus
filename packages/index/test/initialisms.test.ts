import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { openIndex } from "../src/index.js";
import { STAGES } from "./helpers.js";

// beta.28.3: an acronym and the words it stands for find each other, with no word in common and
// no model, once a page of the estate defines the acronym. The knowledge is the task-knowledge
// bench's acronym case: the how-to says only "SSO"; the other item is a shopper's order history.

/** A page of inputs/ that lists the estate's abbreviations. */
const ABBREVIATIONS = [
  "# Abbreviations",
  "",
  "- SSO: single sign-on",
  "- EDW: Enterprise Data Warehouse",
  "- CAB: Change Advisory Board",
  "",
].join("\n");

async function root(
  extra: Record<string, unknown>[] = [],
  o: { abbreviations?: boolean } = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-initialisms-"));
  await mkdir(join(dir, "org-pack"), { recursive: true });
  if (o.abbreviations !== false) {
    await mkdir(join(dir, "inputs"), { recursive: true });
    await writeFile(join(dir, "inputs/abbreviations.md"), ABBREVIATIONS);
  }
  const items = [
    ...(parse(readFileSync(join(STAGES, "sso-acronym/knowledge.yaml"), "utf8")) as unknown[]),
    ...extra,
  ];
  for (const r of items) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(dir, "knowledge/items", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  return dir;
}

/** A how-to that spells the warehouse out and never writes its acronym. */
const WAREHOUSE = {
  kind: "ProcessDefinition",
  schemaVersion: 2,
  id: "warehouse-nightly-load",
  status: "current",
  confidence: "inferred",
  evidence: [
    {
      source: "document",
      path: "knowledge/snapshots/forge-wiki/2026-10-20/warehouse-load.md",
      line: 3,
      side: "document",
    },
  ],
  title: "Send a nightly load to the enterprise data warehouse",
  processKind: "process",
  appliesWhen: "A Forge service's rows are wanted for reporting.",
  inputs: [],
  steps: ["Write the day's rows to the landing bucket.", "Ask the Data team to schedule the load."],
  tags: [],
  quote: {
    source: "forge-wiki",
    page: "warehouse-load.md",
    section: "Steps",
    text: "Write the day's rows to the landing bucket.",
    snapshot: "2026-10-20",
    line: 3,
  },
  urls: [],
};

describe("an acronym and its words (beta.28.3)", () => {
  const STEP =
    "OrderController.place takes the order only from a shopper signed in through single sign-on";
  const KNOWLEDGE = {
    budget: 3000,
    kinds: ["ProcessDefinition", "Pattern"],
    groups: ["knowledge"],
  };

  it("reads the acronyms the estate's pages define, and keeps them with the index", async () => {
    const dir = await root();
    const ix = await openIndex(dir);
    expect(ix.initialisms().entries()).toEqual([
      { acronym: "CAB", phrase: "change advisory board" },
      { acronym: "EDW", phrase: "enterprise data warehouse" },
      { acronym: "SSO", phrase: "single sign on" },
    ]);
    ix.close();
    const again = await openIndex(dir);
    expect(again.initialisms().entries()).toHaveLength(3);
    expect(
      (
        again.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'initialisms:%'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    again.close();
  });

  it("finds the page that says only the acronym for an input that spells it out, and says why", async () => {
    const ix = await openIndex(await root());
    const s = await ix.select({ text: STEP }, KNOWLEDGE);
    expect(s.picked.find((p) => p.id === "sso-login-gate")?.via).toMatch(
      /an acronym and its words #1 \(SSO is "single sign on"\)/,
    );
    ix.close();
  });

  it("finds the page that spells the words out for an input that says only the acronym", async () => {
    const ix = await openIndex(await root([WAREHOUSE]));
    const s = await ix.select({ text: "Which apps publish to the EDW?" }, KNOWLEDGE);
    expect(s.picked.find((p) => p.id === "warehouse-nightly-load")?.via).toMatch(
      /an acronym and its words #1 \(EDW is "enterprise data warehouse"\)/,
    );
    ix.close();
  });

  it("links nothing the estate doesn't define: words that only happen to spell an acronym are not its meaning", async () => {
    const ix = await openIndex(await root([WAREHOUSE], { abbreviations: false }));
    expect(ix.initialisms().size).toBe(0);
    for (const text of [
      STEP,
      "Which apps publish to the EDW?",
      "a step still open on every data warehouse",
    ]) {
      const s = await ix.select({ text }, KNOWLEDGE);
      expect(
        [...s.picked.map((p) => p.via)].some((v) => /acronym/.test(v)),
        text,
      ).toBe(false);
    }
    const s = await ix.select({ text: STEP }, KNOWLEDGE);
    expect([...s.picked, ...s.leftOut].some((p) => p.id === "sso-login-gate")).toBe(false);
    ix.close();
  });

  it("takes a word in small letters for no acronym, and can be turned off (the eval's words mode)", async () => {
    const cab = {
      ...WAREHOUSE,
      id: "taxi-expenses",
      title: "Claim a cab fare",
      steps: ["Keep the cab receipt.", "Send it to Forge Desk."],
    };
    const ix = await openIndex(await root([cab]));
    const s = await ix.select(
      { text: "Who sits on the change advisory board?" },
      { budget: 3000, groups: ["knowledge"] },
    );
    expect(s.picked.some((p) => /acronym/.test(p.via))).toBe(false);
    const off = await ix.select(
      { text: STEP },
      { budget: 3000, groups: ["knowledge"], lexical: { initialisms: false } },
    );
    expect([...off.picked, ...off.leftOut].some((p) => p.id === "sso-login-gate")).toBe(false);
    ix.close();
  });

  it("gives the same selection each time", async () => {
    const dir = await root([WAREHOUSE]);
    const ix = await openIndex(dir);
    const input = { text: "a shopper signed in through single sign-on, sent on to the EDW" };
    const a = await ix.select(input, { budget: 3000, groups: ["knowledge"] });
    ix.close();
    const again = await openIndex(dir, { rebuild: true });
    const b = await again.select(input, { budget: 3000, groups: ["knowledge"] });
    expect(b.picked.map((p) => [p.id, p.score, p.via])).toEqual(
      a.picked.map((p) => [p.id, p.score, p.via]),
    );
    again.close();
  });
});
