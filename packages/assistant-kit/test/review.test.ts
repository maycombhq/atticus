import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import type { CatalogRecord } from "@maycombhq/core";
import { memoryRepo } from "@maycombhq/sdk";
import { findGaps, reviewRepo } from "../src/index.js";

const GW = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/gateways");
/** The gateway config nothing reads, and code whose call the scan couldn't resolve. */
const kong = () =>
  memoryRepo("gw-kong", "0".repeat(40), {
    "kong/kong.yml": readFileSync(join(GW, "repos/gw-kong/kong/kong.yml"), "utf8"),
    "src/llm.js":
      "export const ask = (q) => fetch(process.env.LLM_URL + '/v1/chat/completions', { method: 'POST', body: q });\n",
  });
const NOW = new Date("2026-10-20T12:00:00Z");
const dialect = readFileSync(join(GW, "metarepo/org-pack/dialects/tide-kong.yaml"), "utf8").replace(
  "name: tide-kong",
  "name: gw-kong-review",
);

/** The catalog after a scan of the repo: one call it couldn't resolve. */
const catalog = [
  {
    schemaVersion: 2,
    kind: "Unresolved",
    id: "gw-kong.http-call.0123456789",
    status: "current",
    confidence: "inferred",
    owner: "gw-kong",
    unresolvedKind: "http-call",
    raw: "POST /v1/chat/completions",
    evidence: [
      {
        repo: "gw-kong",
        commit: "0".repeat(40),
        extractor: "x@1.0.0",
        source: "code",
        path: "src/llm.js",
        line: 1,
      },
    ],
  },
] as unknown as CatalogRecord[];

const answer = (verdicts: { gap: string; verdict: string; why: string }[], withDialect = true) =>
  stringify({ verdicts, ...(withDialect ? { dialect } : {}) });

describe("findGaps (deterministic)", () => {
  it("lists what the scan couldn't read: files nothing reads and calls it couldn't resolve", async () => {
    const gaps = await findGaps(kong(), catalog);
    // Hand-written: the gateway config nobody reads, and the unresolved call.
    expect(gaps.map((g) => `${g.id} ${g.kind} ${g.path}${g.raw ? ` ${g.raw}` : ""}`)).toEqual([
      "g1 unread-file kong/kong.yml",
      "g2 http-call src/llm.js POST /v1/chat/completions",
    ]);
  });
});

describe("reviewRepo", () => {
  it("takes a verdict on every gap and a rule that reads the gaps it says a rule reads, checked", async () => {
    const prompts: string[] = [];
    const replies = [
      // Says a rule reads the unresolved call (it doesn't) and forgets nothing else.
      answer([
        { gap: "g1", verdict: "rule", why: "Kong services and routes" },
        { gap: "g2", verdict: "rule", why: "an LLM call" },
      ]),
      answer([
        { gap: "g1", verdict: "rule", why: "Kong services and routes" },
        {
          gap: "g2",
          verdict: "vendor",
          why: "an LLM provider's chat API; its host comes from the environment",
        },
      ]),
    ];
    const runtime = new MockRuntime(
      (req: AiRequest) => {
        prompts.push(req.pack.prompt);
        return replies[prompts.length - 1]!;
      },
      { now: () => NOW },
    );
    const r = await reviewRepo(kong(), {
      name: "gw-kong-review",
      runtime,
      gaps: await findGaps(kong(), catalog),
      now: NOW,
    });
    expect(r.status).toBe("drafted");
    expect(r.attempts.map((a) => a.problems)).toEqual([
      [
        "g2 is marked rule, but the dialect reads nothing there (POST /v1/chat/completions in src/llm.js)",
      ],
      [],
    ]);
    expect(r.verdicts.map((v) => `${v.gap} ${v.verdict}`)).toEqual(["g1 rule", "g2 vendor"]);
    expect(r.resolved).toEqual(["g1"]);
    expect(r.records.length).toBeGreaterThan(0);
    // The gaps and the code at them went in as data.
    expect(prompts[0]).toContain("g2 http-call");
    expect(prompts[0]).toContain("src/llm.js");
  });

  it("refuses an answer that leaves a gap without a verdict, or invents a verdict", async () => {
    const runtime = new MockRuntime(
      () => answer([{ gap: "g1", verdict: "maybe", why: "?" }], false),
      { now: () => NOW },
    );
    const r = await reviewRepo(kong(), {
      name: "gw-kong-review",
      runtime,
      gaps: await findGaps(kong(), catalog),
      maxAttempts: 1,
      now: NOW,
    });
    expect(r.status).toBe("failed");
    expect(r.attempts[0]!.problems).toEqual([
      'g1: "maybe" isn\'t a verdict; use rule, reader, vendor, ignore or person',
      "g2 has no verdict",
    ]);
  });

  it("needs no dialect when no gap is a rule's", async () => {
    const runtime = new MockRuntime(
      () =>
        answer(
          [
            { gap: "g1", verdict: "person", why: "who runs this gateway?" },
            { gap: "g2", verdict: "ignore", why: "a sample" },
          ],
          false,
        ),
      { now: () => NOW },
    );
    const r = await reviewRepo(kong(), {
      name: "gw-kong-review",
      runtime,
      gaps: await findGaps(kong(), catalog),
      now: NOW,
    });
    expect(r.status).toBe("drafted");
    expect(r.yaml).toBeUndefined();
    expect(r.resolved).toEqual([]);
  });
});

describe("findGaps groups", () => {
  it("makes one gap of a top folder with many unread files, and one of each file's unresolved calls", async () => {
    const { memoryRepo: mem } = await import("@maycombhq/sdk");
    const files: Record<string, string> = { "conf/app.yaml": "a: 1\n" };
    for (const l of ["en", "hi", "ta", "te"]) files[`lang/msgs_${l}.json`] = '{"k": "v"}\n';
    files["lang/legacy/old.xml"] = "<a/>\n";
    const call = (raw: string, line: number) => ({
      schemaVersion: 2,
      kind: "Unresolved",
      id: `r.http-call.${line}`,
      status: "current",
      confidence: "inferred",
      owner: "r",
      unresolvedKind: "http-call",
      raw,
      evidence: [
        {
          repo: "r",
          commit: "0".repeat(40),
          extractor: "x@1.0.0",
          source: "code",
          path: "src/api.js",
          line,
        },
      ],
    });
    const gaps = await findGaps(mem("r", "0".repeat(40), files), [
      call("GET /api/{value}", 9),
      call("POST /api/{value}/game", 4),
    ] as unknown as CatalogRecord[]);
    expect(gaps.map((g) => `${g.id} ${g.kind} ${g.path}${g.raw ? ` ${g.raw}` : ""}`)).toEqual([
      "g1 unread-file conf/app.yaml",
      "g2 unread-files lang/ (5 files: 4 json, 1 xml)",
      "g3 http-call src/api.js POST /api/{value}/game (line 4); GET /api/{value} (line 9)",
    ]);
  });
});

describe("findGaps after a rule is accepted", () => {
  it("counts a file the catalog cites as read, whichever rule read it", async () => {
    const read = {
      schemaVersion: 2,
      kind: "GatewayRoute",
      id: "kong-x",
      status: "current",
      confidence: "verified",
      evidence: [
        {
          repo: "gw-kong",
          commit: "0".repeat(40),
          extractor: "dialect:gw-kong-review@0.1.0",
          source: "config",
          path: "kong/kong.yml",
          line: 4,
        },
      ],
    } as unknown as CatalogRecord;
    const gaps = await findGaps(kong(), [...catalog, read]);
    expect(gaps.map((g) => g.kind)).toEqual(["http-call"]);
  });
});
