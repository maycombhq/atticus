import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  interfaceId,
  loadOrgPack,
  serializeRecord,
  type CatalogRecord,
  type DeclaredLink,
  type OrgPack,
} from "@maycombhq/core";
import { declaredArrowRecords, DECLARED_LINK } from "../src/index.js";

/**
 * ADR 0204 1.5, 1.7 and 1.8: a declared arrow is one asserted Interface flagged `declared-link`,
 * with one `manual` evidence; made again from the profile each build and gone with its item; not
 * drawn while a real call goes the same way between the same two boxes (a pairing counts); drawn
 * again when the call goes; a call the other way retires nothing; an end that is gone is reported.
 */

const PACK = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/link-estate/org-pack",
);
const AT = "2026-11-18T10:02:00Z";
const arrow = (more: Partial<DeclaredLink> = {}): DeclaredLink => ({
  from: { repo: "forge-proxy-accounts-v1" },
  to: { repo: "forge-portal-bff" },
  why: "The proxy's target is set at deploy time; the platform team confirmed it.",
  by: "Ada Example",
  at: AT,
  ...more,
});
const withLinks = (op: OrgPack, links: DeclaredLink[]): OrgPack => ({
  ...op,
  profiles: op.profiles.map((p) =>
    p.platform === "forge" && p.profile
      ? { ...p, profile: { ...p.profile, schemaVersion: 3, links } }
      : p,
  ),
});
const ev = [{ source: "code" as const, repo: "x", path: "a.java", line: 1 }];
const component = (id: string, repo: string): CatalogRecord =>
  ({
    kind: "Component",
    schemaVersion: 2,
    id,
    status: "current",
    confidence: "verified",
    repo,
    evidence: ev,
  }) as unknown as CatalogRecord;
const call = (from: string, to: string, flags: string[] = []): CatalogRecord =>
  ({
    kind: "Interface",
    schemaVersion: 2,
    id: interfaceId(from, to, "GET", "/x"),
    status: "current",
    confidence: "verified",
    from,
    to,
    via: "direct",
    method: "GET",
    normalizedPath: "/x",
    sync: "sync",
    direction: "outbound",
    conflicts: [],
    ...(flags.length ? { flags } : {}),
    evidence: ev,
  }) as unknown as CatalogRecord;
const system = (id: string): CatalogRecord =>
  ({
    kind: "System",
    schemaVersion: 2,
    id,
    status: "current",
    confidence: "asserted",
    evidence: ev,
  }) as unknown as CatalogRecord;
const BOXES = [
  component("proxy-accounts-v1", "forge-proxy-accounts-v1"),
  component("portal-bff", "forge-portal-bff"),
  system("harbor-audit"),
];

describe("declared arrows in the build (ADR 0204)", () => {
  it("makes one asserted Interface with the fields of 1.5 and one manual evidence", async () => {
    const op = withLinks(await loadOrgPack(PACK), [arrow()]);
    const b = declaredArrowRecords(op, BOXES);
    expect(b.records).toEqual([
      {
        kind: "Interface",
        schemaVersion: 2,
        id: interfaceId("proxy-accounts-v1", "portal-bff", undefined, "/**"),
        status: "current",
        confidence: "asserted",
        from: "proxy-accounts-v1",
        to: "portal-bff",
        via: "other",
        normalizedPath: "/**",
        sync: "sync",
        direction: "outbound",
        conflicts: [],
        flags: [DECLARED_LINK],
        evidence: [{ source: "manual", path: "profiles/forge/profile.yaml", by: "Ada Example" }],
      },
    ]);
    // It reads as a C1 record, and is never verified.
    expect(() => serializeRecord(b.records[0]!)).not.toThrow();
    // Planned: not built yet.
    const planned = declaredArrowRecords(withLinks(op, [arrow({ planned: true })]), BOXES);
    expect(planned.records[0]).toMatchObject({ status: "planned-new" });
    // Gone when the item is.
    expect(declaredArrowRecords(withLinks(op, []), BOXES).records).toEqual([]);
  });

  it("is not drawn while a real call goes the same way, and drawn again when it goes", async () => {
    const op = withLinks(await loadOrgPack(PACK), [arrow()]);
    const real = call("proxy-accounts-v1", "portal-bff");
    const b = declaredArrowRecords(op, [...BOXES, real]);
    expect(b.records).toEqual([]);
    expect(b.superseded).toEqual([
      {
        from: "repo:forge-proxy-accounts-v1",
        to: "repo:forge-portal-bff",
        by: "Ada Example",
        at: AT,
        calls: 1,
      },
    ]);
    // A person's pairing is a real call; a declared caller is not; the other way retires nothing.
    expect(
      declaredArrowRecords(op, [
        ...BOXES,
        call("proxy-accounts-v1", "portal-bff", ["joined-by-person"]),
      ]).superseded,
    ).toHaveLength(1);
    for (const other of [
      call("proxy-accounts-v1", "portal-bff", ["declared-caller"]),
      call("portal-bff", "proxy-accounts-v1"),
    ])
      expect(declaredArrowRecords(op, [...BOXES, other]).records).toHaveLength(1);
    // The call goes away again: drawn again.
    expect(declaredArrowRecords(op, BOXES).records).toHaveLength(1);
  });

  it("reports an end that is no longer here, and one with no box yet, and keeps both", async () => {
    const op = withLinks(await loadOrgPack(PACK), [
      arrow({ to: { repo: "forge-gone-svc" } }),
      arrow({ to: { system: "harbor-audit" } }),
      arrow({ from: { system: "lantern-mail" } }),
    ]);
    const b = declaredArrowRecords(op, BOXES);
    expect(b.orphaned).toEqual([
      {
        from: "repo:forge-proxy-accounts-v1",
        to: "repo:forge-gone-svc",
        missing: "forge-gone-svc",
        why: "gone",
      },
      {
        from: "system:lantern-mail",
        to: "repo:forge-portal-bff",
        missing: "lantern-mail",
        why: "not-drawn",
      },
    ]);
    expect(b.records.map((r) => (r as { to: string }).to)).toEqual(["harbor-audit"]);
  });

  it("builds the same records for the same profile and records", async () => {
    const op = withLinks(await loadOrgPack(PACK), [
      arrow(),
      arrow({ to: { system: "harbor-audit" } }),
    ]);
    const a = declaredArrowRecords(op, BOXES);
    const b = declaredArrowRecords(op, [...BOXES].reverse());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
