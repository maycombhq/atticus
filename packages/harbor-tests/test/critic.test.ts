import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { runCritic, type CriticFinding, type CriticResult } from "@maycombhq/naysayer";
import { expectedFile, expectedRows, HARBOR, ORG_PACK, type Discrepancy } from "./harbor.js";

/**
 * Stage: the critic's deterministic layer (layer 1, no AI) on a seeded Harbor change,
 * fixtures/harbor/change/openspec/changes/add-gift-cards, at the plan gate. It must raise
 * every seeded critic discrepancy (h17-h21), and no blocking issue beyond them.
 */

const CHANGE = "add-gift-cards";
const NOW = "2026-10-20T09:00:00Z";
const seeded = expectedFile<Discrepancy[]>("discrepancies.yaml").filter(
  (d) => d.found_by === "critic",
);

/**
 * A temporary metarepo: the Harbor org pack, the expected catalog as catalog files and the
 * change. Records using ADR 0040 values C1 on this main can't hold yet are left out of the
 * catalog files (none of them is touched by the change); they join once the schema has them.
 */
async function harborChangeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-harbor-critic-"));
  await cp(ORG_PACK, join(root, "org-pack"), { recursive: true });
  for (const r of expectedRows()) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) continue;
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(
    join(HARBOR, "change/openspec/changes", CHANGE),
    join(root, "openspec/changes", CHANGE),
    {
      recursive: true,
    },
  );
  return root;
}

let result: Promise<CriticResult> | undefined;
const critic = () =>
  (result ??= harborChangeRoot().then((root) => runCritic(root, CHANGE, { now: NOW })));

const summary = (f: CriticFinding) =>
  `${f.finding.severity} ${f.finding.rule} ${f.finding.artifact}${f.finding.locator.line ? `:${f.finding.locator.line}` : ""} ${f.finding.summary}`;

/** The findings that stand for each seeded critic discrepancy. */
const SEEDED: Record<string, (f: CriticFinding) => boolean> = {
  "h17-pattern-typo-in-change": (f) =>
    f.finding.artifact === "interfaces.md" &&
    /names pattern HB\.SYNC\.MSH, which is not in the pattern registry \(did you mean HB\.SYNC\.MESH\?\)/.test(
      f.finding.summary,
    ),
  "h18-unlabelled-hop": (f) =>
    f.finding.artifact === "interfaces.md" &&
    /The hop cart-reminder → orders-svc \(GET \/carts\/abandoned\) names no integration pattern/.test(
      f.finding.summary,
    ),
  "h19-vendor-direct-in-change": (f) =>
    f.finding.rule === "vendor-calls-through-egress" &&
    f.finding.summary ===
      "Interface if-a4ccfcea11eeebf0 (payments-svc → tidewater-payments) goes direct in the code, but HB.VND.EGRESS requires the gateway.",
  "h20-unknown-vendor-operation": (f) =>
    f.finding.kind === "knowledge-gap" &&
    f.finding.rule === "vendor-operation-in-spec" &&
    f.finding.summary ===
      "Tidewater Payments's published spec has no POST /v1/gift-cards/{code}/redeem.",
  "h21-story-without-acceptance-criteria": (f) =>
    f.finding.rule === "constitution.story-acceptance-criteria" &&
    f.finding.artifact === "stories/s2-gift-cards.md",
};

describe("the critic's deterministic layer on the Harbor change add-gift-cards", () => {
  it("runs at the plan gate with no problems and no AI", async () => {
    const r = await critic();
    expect([r.gate, r.round]).toEqual(["plan", 1]);
    expect(r.problems).toEqual([]);
    expect(r.refused).toEqual([]);
    expect(r.findings.every((f) => f.layer === "deterministic")).toBe(true);
  });

  it("raises every seeded critic discrepancy (h17-h21)", async () => {
    const r = await critic();
    expect(seeded.map((d) => d.id).sort()).toEqual(Object.keys(SEEDED).sort());
    for (const d of seeded)
      expect(
        r.findings.filter(SEEDED[d.id]!),
        `${d.id}\n${r.findings.map(summary).join("\n")}`,
      ).toHaveLength(1);
  });

  it("raises no blocking issue beyond the seeded ones", async () => {
    const r = await critic();
    const others = r.findings.filter(
      (f) =>
        f.finding.kind === "issue" &&
        f.finding.severity === "blocking" &&
        !Object.values(SEEDED).some((m) => m(f)),
    );
    expect(others.map(summary)).toEqual([]);
  });

  it("also asks about cart-reminder's missing alert, the scheduled half of h11", async () => {
    const r = await critic();
    expect(
      r.findings
        .filter((f) => f.finding.rule === "consumers-monitored")
        .map((f) => [f.finding.kind, f.finding.locator.record]),
    ).toEqual([["knowledge-gap", "cart-reminder"]]);
  });
});
