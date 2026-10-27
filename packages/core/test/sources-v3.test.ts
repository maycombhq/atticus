import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  migrateSourcesText,
  pageStanding,
  SOURCE_AUTHORITIES,
  Sources,
  SOURCES_SCHEMA_VERSION,
  authorityRank,
  platformsMatch,
} from "../src/index.js";

/**
 * sources.yaml version 3 (ADR 0132): how much a source's word counts (authority, with per-page
 * overrides), where it applies (appliesTo), whether a restricted page may be read, a review age,
 * a cap on the pages a scan reads, and two export folder types. Fixture: the 12-source Forge shop.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/many-wikis");
const fixture = () => parse(readFileSync(join(FIX, "org-pack/sources.yaml"), "utf8"));
const issues = (x: unknown) => {
  const r = Sources.safeParse(x);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("sources.yaml version 3", () => {
  it("reads the 12-source estate", () => {
    const r = Sources.parse(fixture());
    expect(SOURCES_SCHEMA_VERSION).toBe(3);
    expect(r.wikis).toHaveLength(12);
    const by = new Map(r.wikis.map((w) => [w.id, w]));
    expect(by.get("ea-standards")).toMatchObject({
      type: "confluence-export",
      authority: "standard",
      byPage: [{ match: ["Drafts/**", "Meeting-notes/**"], authority: "reference" }],
      reviewMonths: 18,
    });
    expect(by.get("gcp-platform")?.appliesTo).toEqual({ platforms: ["gcp"], newComponents: true });
    expect(by.get("payments-team")?.type).toBe("sharepoint-export");
    expect(by.get("identity-team")?.appliesTo).toBeUndefined();
    expect(SOURCE_AUTHORITIES).toEqual(["standard", "platform", "framework", "team", "reference"]);
  });

  it("refuses the version 3 fields and types in a version 2 file, and says to upgrade", () => {
    const v2 = (w: Record<string, unknown>) => ({
      schemaVersion: 2,
      wikis: [{ id: "w", type: "markdown-folder", location: "x", ...w }],
    });
    expect(issues(v2({ authority: "standard" }))).toEqual([
      "wikis.0.authority: authority needs schemaVersion 3: run atticus upgrade",
    ]);
    expect(issues(v2({ appliesTo: { platforms: ["gcp"] } }))).toEqual([
      "wikis.0.appliesTo: appliesTo needs schemaVersion 3: run atticus upgrade",
    ]);
    expect(issues(v2({ type: "confluence-export" }))).toEqual([
      "wikis.0.type: confluence-export needs schemaVersion 3: run atticus upgrade",
    ]);
    // Version 2's own fields still read at 2.
    expect(issues(v2({ include: ["docs/**"] }))).toEqual([]);
  });

  it("refuses an unknown authority, an empty scope and a page override that changes nothing", () => {
    const v3 = (w: Record<string, unknown>) => ({
      schemaVersion: 3,
      wikis: [{ id: "w", type: "markdown-folder", location: "x", ...w }],
    });
    expect(issues(v3({ authority: "gospel" })).join("\n")).toMatch(/authority/);
    expect(issues(v3({ appliesTo: {} })).join("\n")).toMatch(
      /appliesTo names nothing: leave it out to apply everywhere/,
    );
    expect(issues(v3({ byPage: [{ match: ["a/**"] }] })).join("\n")).toMatch(
      /a byPage entry sets authority or status/,
    );
    expect(issues(v3({ maxPages: 0 })).join("\n")).toMatch(/maxPages/);
  });
});

describe("a page's standing: source default, page override, then the page's own status", () => {
  const ea = Sources.parse(fixture()).wikis.find((w) => w.id === "ea-standards")!;
  it("takes the source's authority, and a page override by pattern", () => {
    expect(pageStanding(ea, "Standards/Idempotency-Keys.md", {})).toMatchObject({
      authority: "standard",
      status: "current",
    });
    expect(pageStanding(ea, "Drafts/Idempotency-Keys-v2-DRAFT.md", {})).toMatchObject({
      authority: "reference",
      by: "byPage Drafts/**",
    });
  });

  it("reads a page's status from its labels, front matter and a banner, and archives by override", () => {
    const team = { id: "t", authority: "team" as const };
    expect(pageStanding(team, "a.md", { labels: ["deprecated"] }).status).toBe("deprecated");
    expect(pageStanding(team, "a.md", { status: "Superseded" }).status).toBe("superseded");
    expect(
      pageStanding(team, "a.md", { text: "# A\n\n> **Deprecated:** superseded by B.\n" }).status,
    ).toBe("deprecated");
    expect(
      pageStanding(team, "a.md", { text: "# A\n\nThis page is superseded by [B](b.md).\n" }).status,
    ).toBe("superseded");
    // A page that only mentions the word deep in its text is current.
    expect(
      pageStanding(team, "a.md", {
        text: "# A\n\n## History\n\nThe old API was deprecated in 2024.\n",
      }).status,
    ).toBe("current");
    expect(
      pageStanding(
        { ...team, byPage: [{ match: ["old/**"], status: "archived" as const }] },
        "old/a.md",
        {},
      ).status,
    ).toBe("archived");
    expect(pageStanding(team, "a.md", { spaceStatus: "archived" }).status).toBe("archived");
  });

  it("marks a standard nobody reviewed within its review months as may be out of date", () => {
    expect(
      pageStanding(ea, "Standards/Idempotency-Keys.md", { updated: "2023-01-10" }, "2026-10-20"),
    ).toMatchObject({ authority: "standard", outOfDate: { since: "2023-01-10", months: 18 } });
    expect(
      pageStanding(ea, "Standards/Logging-Standard.md", { updated: "2026-08-04" }, "2026-10-20")
        .outOfDate,
    ).toBeUndefined();
  });

  it("orders authorities, a source without one ranking as a team's", () => {
    expect(authorityRank("standard")).toBeLessThan(authorityRank("platform"));
    expect(authorityRank("framework")).toBeLessThan(authorityRank("team"));
    expect(authorityRank(undefined)).toBe(authorityRank("team"));
    expect(authorityRank("reference")).toBeGreaterThan(authorityRank("team"));
  });

  it("matches a cloud against the platforms it runs", () => {
    expect(platformsMatch(["gcp"], ["cloud-run"])).toBe("cloud-run");
    expect(platformsMatch(["gcp"], ["openshift"])).toBeUndefined();
    expect(platformsMatch(["OpenShift"], ["openshift"])).toBe("openshift");
    expect(platformsMatch(["cloud-run"], ["gcp"])).toBe("gcp");
  });
});

describe("migrating sources.yaml", () => {
  it("moves version 1 to 2 and version 2 to 3, changing nothing but the number", () => {
    const v1 =
      "# where things are\nschemaVersion: 1\nwikis:\n  - { id: w, type: markdown-folder, location: x }\n";
    expect(migrateSourcesText(v1, { from: 1, to: 2 })).toEqual({
      text: v1.replace("schemaVersion: 1", "schemaVersion: 2"),
      changed: true,
    });
    const v2 = v1.replace("schemaVersion: 1", "schemaVersion: 2");
    expect(migrateSourcesText(v2, { from: 1, to: 2 }).changed).toBe(false);
    expect(migrateSourcesText(v2, { from: 2, to: 3 })).toEqual({
      text: v1.replace("schemaVersion: 1", "schemaVersion: 3"),
      changed: true,
    });
    expect(migrateSourcesText(v2).text).toMatch(/^schemaVersion: 3$/m);
    expect(migrateSourcesText(v1).text).toMatch(/^schemaVersion: 3$/m);
  });
});
