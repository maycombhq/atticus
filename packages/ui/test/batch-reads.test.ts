import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Beta.27 review, request fan-out: the Map read each repo's facts with a call of its own (65 on
 * a large estate) and read them all again on any change under facts/; the Stories tab read each
 * story's file with a call of its own. Each is now one call for what the page asks in one moment
 * (local API 3.12.0), and a change to one repo's facts reads that repo only. Request counts, a
 * fake fetch, no network; invented Forge repos.
 */

const sent: string[] = [];
function fakeServer() {
  return vi.fn(async (url: string) => {
    sent.push(url);
    const u = new URL(url, "http://127.0.0.1");
    if (u.pathname === "/api/facts") {
      const facts: Record<string, unknown> = {};
      const problems: Record<string, unknown> = {};
      for (const r of u.searchParams.getAll("repo"))
        if (r.startsWith("forge-")) facts[r] = { repo: r, facts: [] };
        else problems[r] = { status: 404, title: "Not found", detail: `No repo ${r}.` };
      return new Response(JSON.stringify({ facts, problems }), { status: 200 });
    }
    if (u.pathname.endsWith("/files")) {
      const files = u.searchParams.getAll("file").map((file) => ({
        file,
        artifact: "stories",
        path: `openspec/changes/add-transfer-limit/${file}`,
        content: `# ${file}\n`,
        sha256: "x",
      }));
      return new Response(JSON.stringify({ files }), { status: 200 });
    }
    return new Response(JSON.stringify({ alone: u.pathname }), { status: 200 });
  });
}

const repos = (n: number) => Array.from({ length: n }, (_, i) => `forge-${i}`);

describe("reads a page asks many of at once", () => {
  beforeEach(() => {
    vi.resetModules();
    sent.length = 0;
    vi.stubGlobal("fetch", fakeServer());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("the Map: 65 repos' facts in one call, each repo its own answer or problem", async () => {
    const { repoFacts } = await import("../src/api/batch.js");
    const all = await Promise.all(repos(65).map((r) => repoFacts(r)));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^\/api\/facts\?repo=forge-0&repo=forge-1&/);
    expect(all.map((v) => v.repo)).toEqual(repos(65));
    await expect(repoFacts("northwind-pay")).rejects.toThrow(/No repo northwind-pay/);
  });

  it("more repos than one call takes go in as few calls as they fit", async () => {
    const { repoFacts, FACTS_BATCH } = await import("../src/api/batch.js");
    await Promise.all(repos(FACTS_BATCH + 3).map((r) => repoFacts(r)));
    expect(sent).toHaveLength(2);
  });

  it("the Stories tab: every story's file in one call, as each file's own read gives it", async () => {
    const { artifactFile } = await import("../src/api/batch.js");
    const { artifactUrl } = await import("../src/screens/Changes.js");
    const files = Array.from({ length: 12 }, (_, i) => `stories/s${i}-cap.md`);
    const got = await Promise.all(
      files.map((f) =>
        artifactFile<{ content: string; path: string }>(
          artifactUrl("add-transfer-limit", "stories", f),
        ),
      ),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(
      /^\/api\/changes\/add-transfer-limit\/artifacts\/stories\/files\?file=/,
    );
    expect(got.map((g) => g.content)).toEqual(files.map((f) => `# ${f}\n`));
    // The index (no file) is read alone, as before.
    await artifactFile(artifactUrl("add-transfer-limit", "stories"));
    expect(sent.at(-1)).toBe("/api/changes/add-transfer-limit/artifacts/stories");
  });
});

describe("a change under facts/ reads only the repo it names", () => {
  it("names the repo of a facts file and its companions; the folder itself is every repo", async () => {
    const { factsRepoOf, ALL_REPOS } = await import("../src/app/evidence.js");
    expect(factsRepoOf("facts/forge-ledger.jsonl")).toBe("forge-ledger");
    expect(factsRepoOf("kb/facts/forge-ledger.corrections.jsonl")).toBe("forge-ledger");
    expect(factsRepoOf("facts/forge-portal.questions.jsonl")).toBe("forge-portal");
    expect(factsRepoOf("facts")).toBe(ALL_REPOS);
    expect(factsRepoOf("facts/reports/forge-ledger.yaml")).toBe(ALL_REPOS);
    expect(factsRepoOf("catalog/generated/Service/forge-ledger.yaml")).toBeUndefined();
    expect(factsRepoOf("questions/q-0123456789ab.yaml")).toBeUndefined();
  });
});
