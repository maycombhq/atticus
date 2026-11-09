import { describe, expect, it } from "vitest";
import { mergeCatalog, parseFacts, projectFacts, type Fact } from "../src/index.js";

/**
 * Review round 49 (end to end): a back end for a front end's application.yml has two settings
 * whose keys end the same (`gateway.url` on line 2, `audit.url` on line 4). A reader that wrote
 * only the last part (`url`) for each made two facts of one key and env, which projected to one
 * Setting: the gateway's URL was lost in the merge. Each now keeps a Setting of its own, its id
 * given a short hash of its file and line (stable), and the clash is still reported.
 */
const facts = (lines: object[]): Fact[] => {
  const r = parseFacts(lines.map((l) => JSON.stringify(l)).join("\n"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues, null, 2));
  return r.facts;
};
const setting = (id: string, key: string, line: number, value: string) => ({
  kind: "config",
  id,
  repo: "forge-portal-bff",
  commit: "abcdef1",
  settingKind: "config",
  key,
  value,
  cite: { file: "src/main/resources/application.yml", line, value, quote: `  url: ${value}` },
});

describe("two settings of one key and env that say different things", () => {
  const short = () =>
    facts([
      setting("config.gateway-url", "url", 2, "https://gateway.forge.internal"),
      setting("config.audit-url", "url", 4, "https://audit.forge.internal"),
    ]);

  it("keeps both, each with a stable id of its own", () => {
    const r = projectFacts(short());
    const a = r.ids["config.gateway-url"]!;
    const b = r.ids["config.audit-url"]!;
    expect(a).toMatch(/^forge-portal-bff\.url-[0-9a-f]{8}$/);
    expect(b).toMatch(/^forge-portal-bff\.url-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(projectFacts([...short()].reverse()).ids).toEqual(r.ids);
    const merged = mergeCatalog({ records: r.records, systems: [], repos: [] });
    expect(
      merged.records
        .filter((x) => x.kind === "Setting")
        .map((x) => (x as { valueOrRef: string }).valueOrRef)
        .sort(),
    ).toEqual(["https://audit.forge.internal", "https://gateway.forge.internal"]);
  });

  it("still reports the clash, naming both facts", () => {
    const r = projectFacts(short());
    expect(r.issues).toEqual([
      {
        factId: "config.audit-url",
        code: "duplicate-record",
        message:
          "Setting forge-portal-bff.url is made by config.audit-url, config.gateway-url, which say different things; each keeps a Setting of its own, its id given its line's hash: write each key's full path to tell them apart",
      },
    ]);
  });

  it("leaves full dotted keys, and the same value seen twice, as they were", () => {
    const r = projectFacts(
      facts([
        setting("config.gateway-url", "gateway.url", 2, "https://gateway.forge.internal"),
        setting("config.audit-url", "audit.url", 4, "https://audit.forge.internal"),
        setting("config.timeout-a", "timeout", 6, "5s"),
        setting("config.timeout-b", "timeout", 6, "5s"),
      ]),
    );
    expect(r.ids["config.gateway-url"]).toBe("forge-portal-bff.gateway.url");
    expect(r.ids["config.audit-url"]).toBe("forge-portal-bff.audit.url");
    expect(r.ids["config.timeout-a"]).toBe("forge-portal-bff.timeout");
    expect(r.ids["config.timeout-b"]).toBe("forge-portal-bff.timeout");
    expect(r.issues).toEqual([]);
  });
});
