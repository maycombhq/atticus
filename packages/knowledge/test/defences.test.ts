import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRecord, type OrgPack } from "@maycombhq/core";
import { syncSources, wikiApiAdapter, type WikiApi } from "../src/index.js";
import { HERE, forgePack } from "./helpers.js";

const FIXTURES = join(HERE, "fixtures");
const RED_TEAM = join(HERE, "../../ai/test/fixtures/red-team");

async function hubPack(wikis: OrgPack["sources"]["wikis"]): Promise<OrgPack> {
  const op = await forgePack();
  return { ...op, sources: { ...op.sources, wikis } };
}

describe("syncSources screens the pages it reads (ADR 0042)", () => {
  const wiki = [
    { id: "hub-wiki", type: "markdown-folder" as const, location: "wiki-defences", spaces: [] },
  ];
  const sync = async () =>
    syncSources({
      root: FIXTURES,
      orgPackDir: FIXTURES,
      orgPack: await hubPack(wiki),
      now: "2026-10-18T00:00:00Z",
    });

  it("marks a page with a hidden instruction high risk and reports it as a problem", async () => {
    const res = await sync();
    const page = res.pages.find((p) => p.path === "wiki-defences/hub-handover.md")!;
    expect(page.defences).toEqual({
      risk: "high",
      reason: "It hides an instruction (override) from people: hidden text.",
      rules: ["override", "suppress-output", "rule-change"],
    });
    expect(res.problems).toEqual([
      {
        source: "hub-wiki",
        message:
          "wiki-defences/hub-handover.md is held back from every AI step: It hides an instruction (override) from people: hidden text. A person must review the page.",
      },
    ]);
  });

  it("marks visible instruction-like text medium risk, without a problem", async () => {
    const res = await sync();
    expect(res.pages.find((p) => p.path === "wiki-defences/hub-faq.md")!.defences).toEqual({
      risk: "medium",
      reason:
        "Visible instruction-like text (addresses-ai, suppress-output): kept as data and marked.",
      rules: ["addresses-ai", "suppress-output"],
    });
  });

  it("says nothing about a page that only talks about rules", async () => {
    const res = await sync();
    expect(
      res.pages.find((p) => p.path === "wiki-defences/hub-runbook.md")!.defences,
    ).toBeUndefined();
  });

  it("keeps every page and flags the SourceDocument of the flagged ones", async () => {
    const res = await sync();
    expect(res.pages).toHaveLength(3);
    const flags = Object.fromEntries(res.documents.map((d) => [d.path, d.flags]));
    expect(flags).toEqual({
      "wiki-defences/hub-faq.md": ["defences:medium"],
      "wiki-defences/hub-handover.md": ["defences:high"],
      "wiki-defences/hub-runbook.md": undefined,
    });
    for (const d of res.documents) expect(parseRecord(d).ok).toBe(true);
  });

  it("screens pages an API wiki hands over, with a red-team file as the body", async () => {
    const body = readFileSync(join(RED_TEAM, "markdown/wiki-hidden-comment.md"), "utf8");
    const api: WikiApi = {
      async listPages() {
        return [
          {
            id: "7",
            space: "ARCH",
            title: "Ledger",
            version: 1,
            updatedAt: "2026-05-02T10:00:00Z",
            url: "u",
          },
        ];
      },
      async getPage(id) {
        return {
          id,
          space: "ARCH",
          title: "Ledger",
          body,
          version: 1,
          updatedAt: "2026-05-02T10:00:00Z",
          url: "u",
        };
      },
    };
    const res = await syncSources({
      root: FIXTURES,
      orgPack: await hubPack([
        { id: "conf", type: "confluence", location: "https://wiki.example.test", spaces: ["ARCH"] },
      ]),
      adapters: { confluence: wikiApiAdapter(api) },
    });
    expect(res.pages[0]!.defences?.risk).toBe("high");
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]!.source).toBe("conf");
    expect(res.problems[0]!.message).toMatch(/^conf:ARCH\/7 is held back from every AI step/);
  });

  it("leaves the existing Forge wiki alone", async () => {
    const forge = await forgePack();
    const res = await syncSources({
      root: join(HERE, "../../../fixtures/forge/metarepo"),
      orgPack: forge,
    });
    expect(res.problems).toEqual([]);
    expect(res.pages.filter((p) => p.defences)).toEqual([]);
  });
});
