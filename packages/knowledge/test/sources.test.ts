import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRecord, type OrgPack } from "@maycombhq/core";
import { syncSources, wikiApiAdapter, type WikiApi } from "../src/index.js";
import { FORGE, FORGE_ROOT, forgePack, forgeRecords, HERE, record } from "./helpers.js";

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A small invented estate for the fixture wiki: the Hub and the Contoso Ledger vendor. */
const HUB_RECORDS = [
  record({
    kind: "System",
    id: "hub",
    confidence: "verified",
    name: "Hub",
    boundary: "product",
    owner: "team-hub",
    repos: ["hub-repo"],
    evidence: [{ source: "config", repo: "hub-repo", path: "hub.yaml" }],
  }),
  record({
    kind: "Component",
    id: "hub-api",
    confidence: "verified",
    system: "hub",
    repo: "hub-repo",
    type: "service",
    evidence: [
      { source: "config", repo: "hub-repo", path: "hub.yaml", scannedAt: "2026-02-01T00:00:00Z" },
    ],
  }),
];
const HUB_SYSTEMS = [
  {
    id: "hub",
    name: "Hub",
    boundary: "product" as const,
    owner: "team-hub",
    aliases: [],
    tags: [],
  },
  {
    id: "contoso-ledger",
    name: "Contoso Ledger",
    boundary: "vendor" as const,
    aliases: [],
    tags: [],
  },
];

async function hubPack(wikis: OrgPack["sources"]["wikis"]): Promise<OrgPack> {
  const op = await forgePack();
  return {
    ...op,
    sources: { ...op.sources, wikis },
    profiles: [{ platform: "hub", profile: { ...op.profiles[0]!.profile!, systems: HUB_SYSTEMS } }],
  };
}

const FIXTURES = join(HERE, "fixtures");
const NOW = "2026-10-18T00:00:00Z";

describe("syncSources on the Forge wiki (markdown-folder)", () => {
  it("reads every page with title, sections, owner, hash and a SourceDocument record", async () => {
    const res = await syncSources({
      root: FORGE_ROOT,
      orgPack: await forgePack(),
      records: forgeRecords(),
      now: NOW,
    });
    expect(res.problems).toEqual([]);
    expect(res.skipped).toEqual([]);
    expect(res.classificationLimit).toBe("internal");
    expect(
      res.pages.map((p) => ({
        source: p.source,
        path: p.path,
        title: p.title,
        owner: p.owner,
        classification: p.classification,
        systems: p.systems,
        freshness: p.freshness,
        headings: p.sections.map((s) => s.heading),
      })),
    ).toEqual([
      {
        source: "forge-wiki",
        path: "../inputs/wiki/integration-patterns.md",
        title: "Integration patterns",
        owner: undefined,
        classification: "internal",
        systems: [],
        freshness: "unknown",
        headings: ["Integration patterns"],
      },
      {
        source: "forge-wiki",
        path: "../inputs/wiki/ledger-solution-spec.md",
        title: "Ledger Platform: solution spec",
        owner: "Ledger team (ledger-team@forge.example)",
        classification: "internal",
        systems: ["ledger", "northwind-pay", "portal", "reports"],
        freshness: "unknown",
        headings: ["Ledger Platform: solution spec"],
      },
      {
        source: "forge-wiki",
        path: "../inputs/wiki/snow-firewall-request.md",
        title: "How to request a firewall rule",
        owner: undefined,
        classification: "internal",
        systems: [],
        freshness: "unknown",
        headings: ["How to request a firewall rule"],
      },
    ]);
    expect(res.pages.map((p) => p.hash)).toEqual(
      ["integration-patterns", "ledger-solution-spec", "snow-firewall-request"].map((n) =>
        sha(join(FORGE, "inputs/wiki", `${n}.md`)),
      ),
    );

    expect(res.documents.map((d) => [d.id, d.path, d.docType, d.author])).toEqual([
      [
        "doc.forge-wiki.integration-patterns",
        "../inputs/wiki/integration-patterns.md",
        "wiki-page",
        undefined,
      ],
      [
        "doc.forge-wiki.ledger-solution-spec",
        "../inputs/wiki/ledger-solution-spec.md",
        "wiki-page",
        "Ledger team (ledger-team@forge.example)",
      ],
      [
        "doc.forge-wiki.snow-firewall-request",
        "../inputs/wiki/snow-firewall-request.md",
        "wiki-page",
        undefined,
      ],
    ]);
    for (const d of res.documents) {
      expect(parseRecord(d).ok).toBe(true);
      expect(d.evidence).toEqual([{ source: "document", path: d.path }]);
      expect(d.hash).toBe(res.pages.find((p) => p.path === d.path)!.hash);
    }
  });
});

describe("syncSources on a folder with dates and classifications", () => {
  const wiki = [{ id: "hub-wiki", type: "markdown-folder" as const, location: "wiki", spaces: [] }];

  it("skips pages above the classification limit, and finds stale pages by age and by newer code", async () => {
    const res = await syncSources({
      root: FIXTURES,
      orgPackDir: FIXTURES,
      orgPack: await hubPack(wiki),
      records: HUB_RECORDS,
      now: NOW,
    });
    expect(res.problems).toEqual([]);
    expect(res.skipped).toEqual([
      {
        source: "hub-wiki",
        path: "wiki/confidential.md",
        reason: "confidential is above the limit (internal)",
      },
      {
        source: "hub-wiki",
        path: "wiki/odd-class.md",
        reason: "unknown classification top-secret",
      },
      {
        source: "hub-wiki",
        path: "wiki/secret/keys.md",
        reason: "restricted is above the limit (internal)",
      },
    ]);
    expect(
      res.pages.map((p) => ({
        path: p.path,
        date: p.date,
        owner: p.owner,
        systems: p.systems,
        freshness: p.freshness,
        stale: p.stale,
      })),
    ).toEqual([
      {
        path: "wiki/guides/how-to.md",
        date: "2026-09-30",
        owner: "team-hub",
        systems: [],
        freshness: "fresh",
        stale: [],
      },
      {
        path: "wiki/old-runbook.md",
        date: "2024-05-01",
        owner: undefined,
        systems: ["hub"],
        freshness: "stale",
        stale: [
          { reason: "too-old", days: 900, maxDays: 365 },
          { reason: "code-newer", system: "hub", codeAt: "2026-02-01T00:00:00Z" },
        ],
      },
      {
        path: "wiki/overview.md",
        date: "2026-01-10",
        owner: "team-hub",
        systems: ["contoso-ledger", "hub"],
        freshness: "stale",
        stale: [{ reason: "code-newer", system: "hub", codeAt: "2026-02-01T00:00:00Z" }],
      },
      {
        path: "wiki/undated.md",
        date: undefined,
        owner: undefined,
        systems: [],
        freshness: "unknown",
        stale: [],
      },
    ]);
    expect(res.documents.find((d) => d.path === "wiki/overview.md")).toMatchObject({
      date: "2026-01-10",
      author: "team-hub",
    });
  });

  it("takes a higher classification limit as a parameter, and the age limit from pack freshness", async () => {
    const op = await hubPack(wiki);
    const res = await syncSources({
      root: FIXTURES,
      orgPackDir: FIXTURES,
      orgPack: { ...op, pack: { ...op.pack!, freshness: { SourceDocument: 30 } } },
      maxClassification: "confidential",
      now: NOW,
    });
    expect(res.classificationLimit).toBe("confidential");
    expect(res.skipped.map((s) => s.path)).toEqual(["wiki/odd-class.md", "wiki/secret/keys.md"]);
    expect(res.pages.map((p) => p.path)).toContain("wiki/confidential.md");
    expect(res.pages.find((p) => p.path === "wiki/overview.md")!.stale).toEqual([
      { reason: "too-old", days: 281, maxDays: 30 },
    ]);
    // Without a clock no page is aged.
    const noClock = await syncSources({ root: FIXTURES, orgPackDir: FIXTURES, orgPack: op });
    expect(noClock.pages.find((p) => p.path === "wiki/old-runbook.md")!.stale).toEqual([]);
  });

  it("reads an ado-wiki Git clone as a folder, and reports a missing folder or adapter", async () => {
    const res = await syncSources({
      root: FIXTURES,
      orgPackDir: FIXTURES,
      orgPack: await hubPack([
        { id: "clone", type: "ado-wiki", location: "wiki/guides", spaces: [] },
        { id: "gone", type: "markdown-folder", location: "no-such-folder", spaces: [] },
        { id: "conf", type: "confluence", location: "https://wiki.example.test", spaces: ["ARCH"] },
      ]),
    });
    expect(res.pages.map((p) => [p.source, p.path])).toEqual([["clone", "wiki/guides/how-to.md"]]);
    expect(res.problems).toEqual([
      { source: "gone", message: "Can't read the wiki folder no-such-folder." },
      {
        source: "conf",
        message: "No adapter for the confluence wiki conf, so its pages were not read.",
      },
    ]);
  });
});

describe("API wikis through an adapter (mock only, no network)", () => {
  it("lists and reads pages per space and never calls anything else", async () => {
    const calls: string[] = [];
    const api: WikiApi = {
      async listPages(space) {
        calls.push(`listPages ${space}`);
        return [
          {
            id: "42",
            space,
            title: "Hub API overview",
            version: 3,
            updatedAt: "2026-05-02T10:00:00Z",
            url: "https://wiki.example.test/42",
          },
        ];
      },
      async getPage(id) {
        calls.push(`getPage ${id}`);
        return {
          id,
          space: "ARCH",
          title: "Hub API overview",
          body: "# Hub API overview\n\nThe Hub API calls Contoso Ledger directly.\n",
          version: 3,
          updatedAt: "2026-05-02T10:00:00Z",
          url: "https://wiki.example.test/42",
        };
      },
    };
    const res = await syncSources({
      root: FIXTURES,
      orgPack: await hubPack([
        { id: "conf", type: "confluence", location: "https://wiki.example.test", spaces: ["ARCH"] },
      ]),
      records: HUB_RECORDS,
      adapters: { confluence: wikiApiAdapter(api) },
    });
    expect(calls).toEqual(["listPages ARCH", "getPage 42"]);
    expect(res.pages.map((p) => [p.path, p.title, p.date, p.systems])).toEqual([
      ["conf:ARCH/42", "Hub API overview", "2026-05-02", ["contoso-ledger", "hub"]],
    ]);
    expect(res.documents[0]).toMatchObject({ id: "doc.conf.arch-42", version: "3" });
  });
});

describe("an adapter for one source by its id (ADR 0122)", () => {
  it("reads the source with the adapter given for its id, before the one for its type", async () => {
    const res = await syncSources({
      root: FIXTURES,
      orgPack: await hubPack([
        { id: "inputs", type: "markdown-folder", location: "../inputs", spaces: [] },
      ]),
      records: HUB_RECORDS,
      adaptersById: {
        inputs: {
          pages: async () => [
            {
              pagePath: "partner/hub-runbook.pdf",
              path: "inputs/partner/hub-runbook.pdf",
              content: "# Hub runbook\n\nThe Hub API calls Contoso Ledger directly.\n",
            },
          ],
        },
      },
    });
    expect(res.problems).toEqual([]);
    expect(res.pages.map((p) => [p.source, p.path, p.title])).toEqual([
      ["inputs", "inputs/partner/hub-runbook.pdf", "Hub runbook"],
    ]);
  });
});
