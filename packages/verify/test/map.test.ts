import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { deserializeRecord, type CatalogRecord, type FlowRecord } from "@maycombhq/core";
import {
  codeLinkerFor,
  openApiOf,
  renderMap,
  trustOf,
  type MapQuestion,
  type MapTrust,
  type RenderMapInput,
} from "../src/index.js";

/**
 * The map a developer reviews in a PR (ADR 0124, A3b): rendered from the repo's projected C1
 * records, never from the facts. The golden files under fixtures/map/ are what
 * `atticus verify forge-ledger --write` writes for the fixture metarepo (packages/cli's
 * map-render test checks that end to end); UPDATE_GOLDEN=1 rewrites them after a review.
 */

const MAP = join(__dirname, "fixtures", "map");
const EXPECTED = join(MAP, "expected", "forge-ledger");

const stream = (file: string): CatalogRecord[] =>
  readFileSync(file, "utf8")
    .split(/^---\n/m)
    .filter((d) => d.trim())
    .map((d) => {
      const r = deserializeRecord(d);
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      return r.record;
    });

const input = (): RenderMapInput => {
  const records = stream(join(MAP, "forge-ledger.catalog.yaml"));
  const specs = join(MAP, "specs", "forge-ledger");
  const flows = readdirSync(specs)
    .filter((n) => n.endsWith(".yaml") && n !== "spec.yaml")
    .sort()
    .flatMap((n) => stream(join(specs, n))) as FlowRecord[];
  // The verifier's trust numbers and the open questions, as the end-to-end run wrote them.
  const given = JSON.parse(readFileSync(join(MAP, "inputs.json"), "utf8")) as {
    trust: MapTrust;
    questions: MapQuestion[];
  };
  return {
    repo: "forge-ledger",
    records,
    flows,
    trust: given.trust,
    questions: given.questions,
    paths: { map: "map/forge-ledger", questions: "questions", specs: "specs/forge-ledger" },
    codeLink: codeLinkerFor({ url: "https://git.forge.example/forge/forge-ledger.git" }),
  };
};

function golden(files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(EXPECTED, ...rel.split("/"));
    if (process.env.UPDATE_GOLDEN === "1") {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    expect(existsSync(path), `${rel} has a golden file`).toBe(true);
    expect(text, rel).toBe(readFileSync(path, "utf8"));
  }
  const all: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }))
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else all.push(`${rel}${e.name}`);
  };
  walk(EXPECTED, "");
  expect(Object.keys(files).sort()).toEqual(all.sort());
}

describe("renderMap: the map of one repo, from its C1 records", () => {
  it("renders map.md, a page per flow and an OpenAPI contract per component, as the golden files", () => {
    const files = renderMap(input());
    expect(Object.keys(files)).toEqual([
      "contracts/ledger-api.openapi.yaml",
      "flows/ledger-api.post-a-ledger-entry.md",
      "map.md",
    ]);
    golden(files);
  });

  it("gives byte-identical output for the same records in any order", () => {
    const a = renderMap(input());
    const i = input();
    const b = renderMap({
      ...i,
      records: [...i.records].reverse(),
      flows: [...i.flows].reverse(),
      questions: [...(i.questions ?? [])].reverse(),
    });
    expect(b).toEqual(a);
  });

  it("starts map.md with the trust line, and links every fact line to its file and line", () => {
    const md = renderMap(input())["map.md"]!;
    const lines = md.split("\n");
    const trust = lines.find((l) => l.startsWith("**Trust:**"))!;
    expect(trust).toMatch(/17 facts verified on their lines/);
    expect(trust).toMatch(/coverage \d+%/);
    expect(trust).toMatch(/0 rejected/);
    for (const l of lines.filter((x) => /^\s*- `/.test(x)))
      expect(l, l).toMatch(
        /\]\(https:\/\/git\.forge\.example\/forge\/forge-ledger\/blob\/0123abc\/[^)]+#L\d+\)/,
      );
    expect(md).toContain("## Open questions");
    expect(md).toMatch(/\]\(\.\.\/\.\.\/questions\/q-[0-9a-f]{12}\.yaml\)/);
  });

  it("says what the repo is above the trust line, whose words it is, and that the code wins (ADR 0128)", () => {
    const text = "The ledger: every posting and the balances read from them.";
    const said = renderMap({ ...input(), about: { text, trust: "verified", by: "pat" } })[
      "map.md"
    ]!;
    const lines = said.split("\n");
    expect(lines.findIndex((l) => l.startsWith("**What it is"))).toBeLessThan(
      lines.findIndex((l) => l.startsWith("**Trust:**")),
    );
    expect(said).toContain(`**What it is (pat):** ${text}`);
    expect(said).toContain("the facts below are what the code says");
    expect(said).not.toContain("unconfirmed");

    const draft = renderMap({
      ...input(),
      about: { text, trust: "suggested", by: "assistant" },
    })["map.md"]!;
    expect(draft).toContain("unconfirmed draft, assistant");
    expect(draft).toContain("atticus repo describe forge-ledger --accept");

    // Nothing says: the line says so, and how to say it.
    expect(renderMap(input())["map.md"]!).toContain(
      "**What it is:** Nothing says yet: `atticus repo describe forge-ledger`.",
    );
  });

  it("says what the repo is built on, beside what it is (A-framework)", () => {
    const md = renderMap({
      ...input(),
      frameworks: {
        built: [
          {
            name: "spring-boot",
            version: "3.3.4",
            cite: { path: "pom.xml", line: 6, commit: "0123abc" },
          },
          {
            name: "forge-web-starter",
            version: "2.8.1",
            component: "ledger-web",
            cite: { path: "web/pom.xml", line: 17, commit: "0123abc" },
          },
        ],
      },
    })["map.md"]!;
    const lines = md.split("\n");
    expect(lines.findIndex((l) => l.startsWith("**Built on:**"))).toBeLessThan(
      lines.findIndex((l) => l.startsWith("**Trust:**")),
    );
    expect(md).toContain("spring-boot 3.3.4");
    expect(md).toContain("forge-web-starter 2.8.1 (ledger-web)");
    // Each links to the line that declares it, as every other line of the map does.
    expect(md).toContain("[pom.xml:6](");
    expect(md).toContain("[web/pom.xml:17](");
    expect(md).toContain("read from the build files");
    // Nothing says: no line at all, rather than a line saying nothing.
    expect(renderMap(input())["map.md"]!).not.toContain("**Built on:**");
  });

  it("puts a framework whose patterns the facts show none of in the open (A-framework)", () => {
    const md = renderMap({
      ...input(),
      frameworks: {
        built: [{ name: "spring-boot", cite: { path: "pom.xml", line: 6, commit: "0123abc" } }],
        gaps: [
          {
            framework: "spring-boot",
            question: "Were its entry points missed, or does this repo really have none?",
          },
        ],
      },
    })["map.md"]!;
    expect(md).toContain("**Open: spring-boot shows none of its patterns here.**");
    expect(md).toContain("Were its entry points missed");
  });

  it("says what is missing instead of leaving a section blank", () => {
    const md = renderMap({ ...input(), records: [], flows: [], questions: [], trust: undefined })[
      "map.md"
    ]!;
    expect(md).toContain("No verify report yet");
    expect(md).toContain("Nothing read yet.");
    expect(md).toContain("None open.");
  });
});

describe("openApiOf: a component's REST entries as OpenAPI 3.1", () => {
  it("takes request bodies from the Schema records and path parameters from the path", () => {
    const yaml = openApiOf(input(), "ledger-api")!;
    expect(yaml.startsWith("openapi: 3.1.0\n")).toBe(true);
    expect(yaml).toContain("/accounts/{accountId}/entries:");
    expect(yaml).toMatch(/name: accountId\n\s+in: path\n\s+required: true/);
    expect(yaml).toMatch(/amount:\n\s+type: number/);
    expect(openApiOf(input(), "no-such-component")).toBeUndefined();
  });
});

describe("trustOf: the trust line's numbers from the verifier's report", () => {
  it("reads kept, rejected, the coverage ratio and the number of unknown files", () => {
    expect(
      trustOf({
        repo: "forge-ledger",
        commit: "0123abc",
        accepted: 17,
        rejected: 2,
        coverage: { ratio: 0.833, read: 10, unknown: ["a.java", "b.java"], excluded: [] },
      }),
    ).toEqual({ accepted: 17, rejected: 2, ratio: 0.833, unknown: 2, commit: "0123abc" });
    expect(trustOf(null)).toBeUndefined();
    expect(trustOf({ accepted: "x" })).toBeUndefined();
  });

  it("reads the files the reader reviewed with nothing to record, and the trust line says them (A-read)", () => {
    const t = trustOf({
      accepted: 7,
      rejected: 0,
      coverage: { ratio: 0.667, read: 6, reviewed: 3, unknown: [], excluded: [] },
    });
    expect(t).toEqual({ accepted: 7, rejected: 0, ratio: 0.667, unknown: 0, reviewed: 3 });
    const md = renderMap({ ...input(), trust: t })["map.md"]!;
    const line = md.split("\n").find((l) => l.startsWith("**Trust:**"))!;
    expect(line).toMatch(
      /3 files reviewed by the reader with nothing to record \(each with why, in the verify report\)/,
    );
    // None reviewed: the line is as it was.
    expect(renderMap(input())["map.md"]!).not.toMatch(/reviewed by the reader/);
  });
});

describe("codeLinkerFor: where a line of code is", () => {
  it("links a GitHub-style host by commit, Azure DevOps by its query, and a clone by a relative path", () => {
    expect(
      codeLinkerFor({ url: "https://git.forge.example/forge/forge-ledger.git" })(
        "a/B.java",
        3,
        "abc1234",
        "map/forge-ledger/map.md",
      ),
    ).toBe("https://git.forge.example/forge/forge-ledger/blob/abc1234/a/B.java#L3");
    expect(
      codeLinkerFor({ url: "git@git.forge.example:forge/forge-ledger.git" })(
        "a/B.java",
        3,
        "abc1234",
        "map/x/map.md",
      ),
    ).toBe("https://git.forge.example/forge/forge-ledger/blob/abc1234/a/B.java#L3");
    expect(
      codeLinkerFor({ url: "https://dev.azure.com/forge/ledger/_git/forge-ledger" })(
        "a/B.java",
        3,
        "abc1234",
        "map/x/map.md",
      ),
    ).toBe(
      "https://dev.azure.com/forge/ledger/_git/forge-ledger?path=/a/B.java&version=GCabc1234&line=3",
    );
    expect(codeLinkerFor({ dir: "" })("a/B.java", 3, "abc1234", ".atticus/map/x/flows/f.md")).toBe(
      "../../../../a/B.java#L3",
    );
    expect(
      codeLinkerFor({ dir: "workspace/x" })("a/B.java", undefined, undefined, "map/x/map.md"),
    ).toBe("../../workspace/x/a/B.java");
  });
});
