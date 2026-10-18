import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadOrgPack, parseRecord, type CatalogRecord } from "@maycombhq/core";
import { readDrawio, reconcile, resolveNames, type ReconcileItem } from "../src/index.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const DIAGRAM = "inputs/diagrams/forge-context.drawio";
const inputs = parse(readFileSync(join(FORGE, "expected/inputs.yaml"), "utf8")) as {
  aliases: Record<string, string | null>;
};
const seeded = parse(readFileSync(join(FORGE, "expected/discrepancies.yaml"), "utf8")) as {
  id: string;
  found_by: string;
  refs: string[];
}[];

function catalog(): CatalogRecord[] {
  return (
    parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<string, unknown>[]
  ).map((r) => {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    return p.record;
  });
}

async function run(extra: CatalogRecord[] = []) {
  const op = await loadOrgPack(join(FORGE, "metarepo/org-pack"));
  const profile = op.profiles[0]!.profile!;
  return reconcile({
    diagram: readDrawio(readFileSync(join(FORGE, DIAGRAM), "utf8"), profile.legend),
    file: DIAGRAM,
    records: [...catalog(), ...extra],
    systems: profile.systems,
    patterns: op.patterns,
  });
}

/** Which reconcile item stands for each seeded discrepancy. */
const SEEDED: Record<string, (i: ReconcileItem) => boolean> = {
  "d01-vendor-direct": (i) =>
    i.type === "pattern-mismatch" &&
    i.diagram?.cell === "e4" &&
    i.records.includes("if-e7344c9455608119") &&
    /gateway/.test(i.summary) &&
    /direct/.test(i.summary),
  "d02-reports-reads-db": (i) =>
    i.type === "drawn-call-reads-database" &&
    i.diagram?.cell === "e5" &&
    i.records.includes("ledger-db.entry") &&
    /D\.JDBC/.test(i.summary),
  "d03-undocumented-audit": (i) => i.type === "code-only" && i.records[0] === "if-5c55930b735276a9",
  "d04-undocumented-transfers-event": (i) =>
    i.type === "code-only" && i.records[0] === "if-f1cd1f189eaa4b7b",
  "d05-planned-notifications": (i) =>
    i.type === "planned" && i.diagram?.cell === "e7" && i.legend === "new",
  "d06-name-mismatch": (i) =>
    i.type === "alias-needed" && i.records[0] === "ledger-api" && i.name === "Ledger Platform",
};

describe("aliases", () => {
  it("resolve every diagram name as expected/inputs.yaml says", async () => {
    const op = await loadOrgPack(join(FORGE, "metarepo/org-pack"));
    const names = Object.keys(inputs.aliases);
    const got = resolveNames(names, catalog(), op.profiles[0]!.profile!.systems);
    for (const n of names) expect(got.get(n)?.id ?? null, n).toBe(inputs.aliases[n]);
    expect(got.get("Ledger Platform")!.how).toBe("profile");
    expect(got.get("Portal BFF")!.how).toBe("exact");
    expect(got.get("Notifications Service")!.similar).toEqual([]);
  });
});

describe("reconcile the Forge diagram with the catalog (M1 exit)", () => {
  it("reports every seeded reconcile discrepancy, d01–d06", async () => {
    const r = await run();
    for (const d of seeded.filter((x) => x.found_by === "reconcile")) {
      const hits = r.items.filter(SEEDED[d.id]!);
      expect(
        hits,
        `${d.id}: ${JSON.stringify(
          r.items.map((i) => [i.type, i.summary]),
          null,
          1,
        )}`,
      ).toHaveLength(1);
    }
  });

  it("reports nothing else but the unknown pattern code, with the likely intended code", async () => {
    const r = await run();
    const others = r.items.filter((i) => !Object.values(SEEDED).some((f) => f(i)));
    expect(others.map((i) => [i.type, i.diagram?.cell])).toEqual([["unknown-pattern", "e5"]]);
    expect(others[0]!.suggestion).toMatchObject({ text: expect.stringContaining("S.GW.SOR") });
  });

  it("matches the drawn edges to the interfaces they show", async () => {
    const r = await run();
    expect(r.matches).toEqual([
      { cell: "e1", interfaces: ["if-f5c8b4b06d75284f"] },
      { cell: "e2", interfaces: ["if-75b5e8d8aa780837"] },
      { cell: "e3", interfaces: ["if-d99f508a2ac9b6e0"] },
      { cell: "e4", interfaces: ["if-e7344c9455608119"] },
      { cell: "e6", interfaces: ["if-32d38aecd11b86b1"] },
    ]);
  });

  it("gives every item a stable id, the diagram place and a suggested next step", async () => {
    const r = await run();
    expect(new Set(r.items.map((i) => i.id)).size).toBe(r.items.length);
    const alias = r.items.find((i) => i.type === "alias-needed")!;
    expect(alias.id).toBe("alias-needed.ledger-platform");
    expect(alias.diagram).toMatchObject({ file: DIAGRAM, cell: "ledger", line: 9 });
    expect(alias.suggestion).toMatchObject({
      action: "alias",
      target: "ledger-api",
      value: "Ledger Platform",
    });
    expect((await run()).items).toEqual(r.items);
  });

  it("stops asking for an alias once a person has confirmed it", async () => {
    const decision = parseRecord({
      schemaVersion: 1,
      kind: "CuratedDecision",
      id: "alias.ledger-platform",
      status: "current",
      confidence: "asserted",
      target: "ledger-api",
      action: "alias",
      value: "Ledger Platform",
      reason: "The architects' name for the ledger service",
      by: "a.architect",
      at: "2026-10-18T09:00:00Z",
    });
    if (!decision.ok) throw new Error(JSON.stringify(decision.issues));
    const r = await run([decision.record]);
    expect(r.items.some((i) => i.type === "alias-needed")).toBe(false);
    expect(r.matches.map((m) => m.cell)).toEqual(["e1", "e2", "e3", "e4", "e6"]);
  });
});
