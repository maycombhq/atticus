import { describe, expect, it } from "vitest";
import { domainProfile, DEFAULT_DOMAIN_PROFILE } from "../src/index.js";
import { forgeRecords } from "./helpers.js";

const section = (md: string, heading: string) => {
  const i = md.indexOf(`## ${heading}\n`);
  if (i < 0) return "";
  const j = md.indexOf("\n## ", i + 3);
  return md.slice(i, j < 0 ? undefined : j);
};

describe("domainProfile", () => {
  const md = domainProfile(forgeRecords(), "ledger", {
    scannedAt: "2026-10-20T09:00:00Z",
  });

  it("fills what the code proves: repos, interfaces, data and related domains, each with evidence", () => {
    // Hand-written from the Forge expected catalog.
    expect(md).toMatch(/^# Ledger\n/);
    expect(section(md, "Systems and Repositories")).toMatch(
      /\| ledger-api \| forge-ledger \|.*\| forge-ledger:forge\.yaml:2 \|/,
    );
    const ifs = section(md, "Interfaces");
    expect(ifs).toMatch(/\| POST \/transfers \| API \| ledger-api \| portal-bff \|/);
    const data = section(md, "Data and Records");
    expect(data).toMatch(/\| ledger-db\.account \| ledger-api \| Unknown \| Unknown \|/);
    const related = section(md, "Related Domains");
    expect(related).toContain("| portal |");
    expect(related).toContain("| reports |");
  });

  it("says Unknown for what code can't tell, and asks who knows", () => {
    expect(section(md, "Controls and Obligations")).toContain("Unknown");
    const qs = section(md, "Open Questions");
    expect(qs).toMatch(/Who is the business owner of Ledger\?/);
    expect(qs).toMatch(/retention/i);
  });

  it("keeps an evidence register of every claim, with where it came from and how sure it is", () => {
    const reg = section(md, "Evidence Register");
    expect(reg).toMatch(
      /\| ledger-api serves POST \/transfers \| forge-ledger:[^|]+ \| 2026-10-20 \| 2026-10-20 \| confirmed \|/,
    );
    // Every row has a source and a confidence.
    for (const row of reg.split("\n").filter((l) => /^\| (?!Claim|---)/.test(l)))
      expect(row).toMatch(/\| (confirmed|partial|inferred) \|$/);
  });

  it("follows the organisation's own template, keeping its words and filling its placeholders", () => {
    const own =
      "# {{name}}\n\nOur intro.\n\n## Interfaces\n\n{{interfaces}}\n\n## Mine\n\nKept as written.\n";
    const out = domainProfile(forgeRecords(), "ledger", {
      template: own,
      scannedAt: "2026-10-20T09:00:00Z",
    });
    expect(out).toMatch(/^# Ledger\n\nOur intro\./);
    expect(out).toContain("POST /transfers");
    expect(out).toContain("## Mine\n\nKept as written.");
    expect(DEFAULT_DOMAIN_PROFILE).toContain("{{interfaces}}");
  });

  it("is the same for the same catalog, and refuses a system it doesn't know", () => {
    expect(
      domainProfile(forgeRecords().reverse(), "ledger", { scannedAt: "2026-10-20T09:00:00Z" }),
    ).toBe(md);
    expect(() => domainProfile(forgeRecords(), "nope", {})).toThrow(/No system "nope"/);
  });
});
