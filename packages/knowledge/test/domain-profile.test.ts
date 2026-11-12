import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { domainProfile, DEFAULT_DOMAIN_PROFILE, knowledgeGaps } from "../src/index.js";
import { forgePack, forgeRecords, record } from "./helpers.js";

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

  it("lists a sent gap's question only while the gap is open (beta.27 final round)", async () => {
    // Sent: the question's own record says so (as the send route writes it). Then the gap is
    // filled (an alert watches reports-job): the record stays, the open question doesn't.
    const orgPack = await forgePack();
    const id = "q.unattended-workload-monitored.reports-job";
    const g = knowledgeGaps({ records: forgeRecords(), orgPack }).find((x) => x.question.id === id);
    expect(g).toBeDefined();
    const sent = record({
      ...g!.question,
      confidence: "asserted",
      evidence: [{ source: "manual", by: "pat", scannedAt: "2026-11-09T09:00:00Z" }],
    });
    const asked = "Which alert or dashboard watches reports-job?";
    const open = (records: CatalogRecord[]) =>
      section(domainProfile(records, "reports", { orgPack }), "Open Questions");
    expect(open([...forgeRecords(), sent])).toContain(asked);
    const alert = record({
      kind: "ObservabilityAsset",
      id: "reports-job.failed-alert",
      confidence: "verified",
      component: "reports-job",
      assetKind: "alert",
      name: "reports-job failed",
      evidence: [{ source: "config", repo: "forge-reports-job", path: "alerts.yaml", line: 1 }],
    });
    expect(open([...forgeRecords(), sent, alert])).not.toContain(asked);
    // An answered one is kept (where it was answered), and so is one a person wrote.
    const answered = record({ ...sent, questionState: "answered", answer: "reports-alerts" });
    expect(open([...forgeRecords(), answered, alert])).toContain(asked);
    const own = record({
      kind: "OwnerQuestion",
      id: "oq.reports.retention",
      confidence: "asserted",
      system: "reports",
      owner: "team-reports",
      question: "How long are the daily entries kept?",
      neededFact: "retention of the daily entries",
      channel: "email",
      questionState: "sent",
      evidence: [{ source: "manual", by: "pat" }],
    });
    expect(open([...forgeRecords(), own, alert])).toContain("How long are the daily entries kept?");
  });
});
