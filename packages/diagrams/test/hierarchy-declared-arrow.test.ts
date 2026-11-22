import { describe, expect, it } from "vitest";
import { interfaceId, parseRecord, type CatalogRecord } from "@maycombhq/core";
import { buildEstate, nodeView } from "../src/index.js";

/**
 * ADR 0204 B.1 at the system level (review nit): a declared arrow merged into an edge between two
 * systems that the code links already is not counted as a call there, nor listed among its calls;
 * the code's calls are what that edge says. Between two systems with no code link it is the
 * edge, "declared by <name>". Opening the systems still shows it between its own two boxes.
 */

const rec = (r: Record<string, unknown>): CatalogRecord => {
  const p = parseRecord({ schemaVersion: 2, status: "current", confidence: "verified", ...r });
  if (!p.ok) throw new Error(`${String(r.id)}: ${JSON.stringify(p.issues)}`);
  return p.record;
};
const component = (id: string, repo: string, system: string) =>
  rec({
    kind: "Component",
    id,
    repo,
    system,
    type: "service",
    evidence: [{ source: "code", repo, path: "pom.xml", line: 1 }],
  });
const call = (from: string, to: string, repo: string) =>
  rec({
    kind: "Interface",
    id: interfaceId(from, to, "GET", "/balances"),
    from,
    to,
    via: "direct",
    sync: "sync",
    method: "GET",
    normalizedPath: "/balances",
    direction: "outbound",
    conflicts: [],
    flags: ["joined-by-path"],
    evidence: [{ source: "code", repo, path: "src/Balances.java", line: 7, side: "caller" }],
  });
const declared = (from: string, to: string) =>
  rec({
    kind: "Interface",
    id: interfaceId(from, to, undefined, "/**"),
    confidence: "asserted",
    from,
    to,
    via: "other",
    sync: "sync",
    normalizedPath: "/**",
    direction: "outbound",
    conflicts: [],
    flags: ["declared-link"],
    evidence: [{ source: "manual", path: "profiles/forge/profile.yaml", by: "Ada Example" }],
  });
const records = (): CatalogRecord[] => [
  component("ledger-api", "forge-ledger", "ledger"),
  component("statements-api", "forge-statements", "ledger"),
  component("wallets-api", "forge-wallets", "wallets"),
  component("wallets-batch", "forge-wallets-batch", "wallets"),
  component("cards-api", "forge-cards", "cards"),
  // ledger → wallets: one call in the code, and a declared arrow between two other boxes.
  call("ledger-api", "wallets-api", "forge-ledger"),
  declared("statements-api", "wallets-batch"),
  // cards → ledger: only a declared arrow.
  declared("cards-api", "ledger-api"),
];
const edgeOf = (v: Awaited<ReturnType<typeof nodeView>>, from: string, to: string) =>
  v.edges.find((e) => e.from === from && e.to === to && e.type === "calls");

describe("a declared arrow at the system level (ADR 0204 B.1)", () => {
  const est = buildEstate(records());

  it("is not counted beside the code's calls between the same two systems", () => {
    const v = nodeView(est, "estate", { lens: "architecture" });
    const e = edgeOf(v, "system:ledger", "system:wallets")!;
    expect(e.count).toBe(1);
    expect(e.joins?.map((j) => j.interface)).toEqual([
      interfaceId("ledger-api", "wallets-api", "GET", "/balances"),
    ]);
    expect(e.joins?.some((j) => j.declaredBy)).toBe(false);
    expect(e.evidence.some((x) => x.source === "manual")).toBe(false);
  });

  it("is the edge where the code links the two systems by nothing else", () => {
    const v = nodeView(est, "estate", { lens: "architecture" });
    const e = edgeOf(v, "system:cards", "system:ledger")!;
    expect(e.count).toBe(1);
    expect(e.joins?.map((j) => j.declaredBy)).toEqual(["Ada Example"]);
  });

  it("is still drawn between its own two boxes when the systems are opened", () => {
    const v = nodeView(est, "system:ledger", { lens: "architecture", depth: 2 });
    const e = v.edges.find((x) => x.from === "component:statements-api" && x.type === "calls");
    expect(e).toMatchObject({ count: 1 });
    expect(e?.joins?.map((j) => j.declaredBy)).toEqual(["Ada Example"]);
  });
});
