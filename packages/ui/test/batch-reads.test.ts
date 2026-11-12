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

  // Beta.27 re-review: 500 repos in one address passed the server's 16 KB head (431, all failed).
  it("500 long repo names go in calls of at most 100 repos and 8 KB of address each", async () => {
    const { repoFacts, FACTS_BATCH, URL_BUDGET } = await import("../src/api/batch.js");
    expect(FACTS_BATCH).toBe(100);
    const long = Array.from({ length: 500 }, (_, i) => `forge-${"settlement".repeat(9)}-${i}`);
    const got = await Promise.all(long.map((r) => repoFacts(r)));
    expect(got.map((v) => v.repo)).toEqual(long);
    expect(sent.length).toBeGreaterThan(5);
    for (const u of sent) {
      const q = new URL(u, "http://127.0.0.1");
      expect(q.searchParams.getAll("repo").length).toBeLessThanOrEqual(100);
      expect(q.search.length).toBeLessThanOrEqual(URL_BUDGET + 1);
    }
    // Every repo asked once, in order.
    expect(sent.flatMap((u) => new URL(u, "http://127.0.0.1").searchParams.getAll("repo"))).toEqual(
      long,
    );
  });

  it("splits keys by count and by the address they take", async () => {
    const { partsOf } = await import("../src/api/batch.js");
    const len = (k: string) => k.length;
    expect(partsOf(["aa", "bb", "cc"], 2, len, 100)).toEqual([["aa", "bb"], ["cc"]]);
    expect(partsOf(["aaaa", "bbbb", "cc"], 10, len, 6)).toEqual([["aaaa"], ["bbbb", "cc"]]);
    // One key past the budget still goes, alone.
    expect(partsOf(["a".repeat(20), "b"], 10, len, 6)).toEqual([["a".repeat(20)], ["b"]]);
  });

  it("a story deleted meanwhile is its own problem; the other stories still read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        sent.push(url);
        const u = new URL(url, "http://127.0.0.1");
        const asked = u.searchParams.getAll("file");
        const files = asked
          .filter((f) => !f.includes("gone"))
          .map((file) => ({
            file,
            artifact: "stories",
            path: file,
            content: `# ${file}\n`,
            sha256: "x",
          }));
        const problems = Object.fromEntries(
          asked
            .filter((f) => f.includes("gone"))
            .map((f) => [f, { status: 404, title: "Not found", detail: `${f} isn't there.` }]),
        );
        return new Response(JSON.stringify({ files, problems }), { status: 200 });
      }),
    );
    const { artifactFile } = await import("../src/api/batch.js");
    const { artifactUrl } = await import("../src/screens/Changes.js");
    const read = (f: string) =>
      artifactFile<{ content: string }>(artifactUrl("add-transfer-limit", "stories", f));
    const [a, gone, b] = await Promise.allSettled([
      read("stories/s1-cap.md"),
      read("stories/s2-gone.md"),
      read("stories/s3-limit.md"),
    ]);
    expect(sent).toHaveLength(1);
    expect(a).toMatchObject({ status: "fulfilled", value: { content: "# stories/s1-cap.md\n" } });
    expect(b).toMatchObject({ status: "fulfilled", value: { content: "# stories/s3-limit.md\n" } });
    expect(gone.status).toBe("rejected");
    expect(String((gone as PromiseRejectedResult).reason)).toMatch(/isn't there/);
  });

  // Beta.27 re-review: a screen that stays (one signal for all its reads) kept a listener per read.
  it("an asker's read that is answered leaves nothing listening on its signal", async () => {
    const { repoFacts, artifactFile } = await import("../src/api/batch.js");
    const { artifactUrl } = await import("../src/screens/Changes.js");
    const screen = new AbortController();
    const live = new Set<unknown>();
    const add = screen.signal.addEventListener.bind(screen.signal);
    const remove = screen.signal.removeEventListener.bind(screen.signal);
    vi.spyOn(screen.signal, "addEventListener").mockImplementation((t, f, o) => {
      live.add(f);
      add(t, f, o);
    });
    vi.spyOn(screen.signal, "removeEventListener").mockImplementation((t, f, o) => {
      live.delete(f);
      remove(t, f, o);
    });
    for (let round = 0; round < 3; round++) {
      await Promise.all(repos(5).map((r) => repoFacts(r, screen.signal)));
      await artifactFile(
        artifactUrl("add-transfer-limit", "stories", "stories/s1.md"),
        screen.signal,
      );
      await expect(repoFacts("northwind-pay", screen.signal)).rejects.toThrow();
    }
    expect(sent.length).toBeGreaterThan(0);
    expect(live.size).toBe(0);
  });

  it("an asker whose screen went is dropped; the call stops once every asker has gone", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push(url);
        signals.push(init?.signal ?? undefined);
        // Answers only once it is stopped.
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          ),
        );
      }),
    );
    const { artifactFile } = await import("../src/api/batch.js");
    const { artifactUrl } = await import("../src/screens/Changes.js");
    const one = new AbortController();
    const two = new AbortController();
    const p1 = artifactFile(
      artifactUrl("add-transfer-limit", "stories", "stories/s1.md"),
      one.signal,
    );
    const p2 = artifactFile(
      artifactUrl("add-transfer-limit", "stories", "stories/s2.md"),
      two.signal,
    );
    one.abort();
    await expect(p1).rejects.toMatchObject({ name: "AbortError" });
    // Gone before the call was sent: only the other file is asked for.
    await new Promise((r) => setTimeout(r, 5));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("s2.md");
    expect(sent[0]).not.toContain("s1.md");
    two.abort();
    await expect(p2).rejects.toMatchObject({ name: "AbortError" });
    // Every asker gone: the call itself was stopped.
    expect(signals[0]?.aborted).toBe(true);
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
