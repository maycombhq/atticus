import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { openIndex } from "../src/index.js";
import { STAGES } from "./helpers.js";

// beta.28.3: an acronym and the words it stands for find each other, with no word in common, no
// glossary alias and no model. The knowledge is the task-knowledge bench's acronym case: the
// how-to says only "SSO"; the other item is about a shopper's order history.

async function root(extra: Record<string, unknown>[] = []): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-initialisms-"));
  await mkdir(join(dir, "org-pack"), { recursive: true });
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
  it("finds the page that says only the acronym for an input that spells it out, and says why", async () => {
    const ix = await openIndex(await root());
    const s = await ix.select(
      {
        text: "OrderController.place takes the order only from a shopper signed in through single sign-on",
      },
      { budget: 3000, kinds: ["ProcessDefinition", "Pattern"], groups: ["knowledge"] },
    );
    const hit = [...s.picked, ...s.leftOut.map((l) => ({ ...l, via: "" }))].find(
      (p) => p.id === "sso-login-gate",
    );
    expect(hit, "the SSO how-to is a candidate").toBeDefined();
    expect(s.picked.find((p) => p.id === "sso-login-gate")?.via).toMatch(
      /an acronym and its words #1 \(SSO is "single sign-on"\)/,
    );
    ix.close();
  });

  it("finds the page that spells the words out for an input that says only the acronym", async () => {
    const ix = await openIndex(await root([WAREHOUSE]));
    const s = await ix.select(
      { text: "Which apps publish to the EDW?" },
      { budget: 3000, kinds: ["ProcessDefinition", "Pattern"], groups: ["knowledge"] },
    );
    expect(s.picked.find((p) => p.id === "warehouse-nightly-load")?.via).toMatch(
      /an acronym and its words #1 \(EDW is "enterprise data warehouse"\)/,
    );
    ix.close();
  });

  it("ranks nothing more when no acronym is spelled out, and can be turned off (the eval's words mode)", async () => {
    const ix = await openIndex(await root());
    const plain = await ix.select(
      { text: "how long a shopper's order history is kept" },
      { budget: 3000, groups: ["knowledge"] },
    );
    expect(plain.picked.some((p) => /acronym/.test(p.via))).toBe(false);
    const off = await ix.select(
      { text: "a shopper signed in through single sign-on" },
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
