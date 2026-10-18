import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLessons } from "@maycombhq/learn";
import {
  initiativeCommitment,
  initiativeNew,
  initiativePlan,
  initiativeStatus,
  requestFromTeam,
} from "../src/initiative-commands.js";
import { sandboxCreate } from "../src/learn-commands.js";
import { main } from "../src/main.js";

const NOW = new Date("2026-12-14T09:00:00Z");
const T = 120_000;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

/** A scanned practice sandbox with the team-lead lesson's parties written in. */
async function scannedRoot(): Promise<string> {
  const c = capture();
  const dir = join(await mkdtemp(join(tmpdir(), "atticus-initiative-cli-")), "sandbox");
  expect(await sandboxCreate(dir, { json: true }, c.io, { now: NOW })).toBe(0);
  const root = (JSON.parse(c.out.join("\n")) as { root: string }).root;
  expect(await main(["scan", "--root", root], capture().io)).toBe(0);
  const team = (await loadLessons()).lessons.find((l) => l.id === "team-lead-initiative")!;
  for (const f of team.steps[0]!.solution!.files) {
    const p = join(root, ...f.path.split("/"));
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, f.content, "utf8");
  }
  return root;
}

describe("atticus initiative", () => {
  it(
    "plans, reports and records an initiative through its commands",
    async () => {
      const root = await scannedRoot();
      let c = capture();
      expect(
        await initiativeNew(
          root,
          { title: "Northwind Pay v3 migration", journey: "vendor-api-change", by: "tia" },
          c.io,
        ),
      ).toBe(0);
      expect(c.out).toEqual([
        "Started northwind-pay-v3-migration (vendor-api-change). Wrote catalog/curated/initiative/northwind-pay-v3-migration.yaml.",
        "Plan it: atticus initiative plan northwind-pay-v3-migration --target <system> --release YYYY-MM-DD --by tia",
      ]);
      c = capture();
      expect(
        await initiativePlan(
          root,
          "northwind-pay-v3-migration",
          { target: "northwind-pay", by: "tia" },
          c.io,
          { now: NOW },
        ),
      ).toBe(2);
      expect(c.err).toEqual(["Give the target release as YYYY-MM-DD (--release)."]);
      c = capture();
      expect(
        await initiativePlan(
          root,
          "northwind-pay-v3-migration",
          { target: "northwind-pay", release: "2027-03-01", by: "tia" },
          c.io,
          { now: NOW },
        ),
      ).toBe(0);
      expect(c.out[0]).toBe(
        "Northwind Pay v3 migration: 9 items from northwind-pay back to 2027-03-01 (vendor-api-change journey, built-in).",
      );
      expect(c.out).toContain(
        '  atticus change new "Northwind Pay v3 migration: Ledger" --type feature --id northwind-pay-v3-migration-ledger --system ledger --by tia',
      );
      c = capture();
      expect(
        await initiativeStatus(root, "northwind-pay-v3-migration", {}, c.io, { now: NOW }),
      ).toBe(0);
      expect(c.out[0]).toBe(
        "Northwind Pay v3 migration (vendor-api-change): on-track; target 2027-03-01, projected 2027-03-01.",
      );
      c = capture();
      expect(
        await initiativeStatus(root, "northwind-pay-v3-migration", {}, c.io, {
          now: new Date("2027-01-13T09:00:00Z"),
        }),
      ).toBe(1);
      expect(c.out[0]).toMatch(/: at-risk; target 2027-03-01, projected 2027-03-24\.$/);
      expect(c.out).toContain("Commitments slipped or at risk:");
      c = capture();
      expect(
        await initiativeCommitment(
          root,
          "northwind-pay-v3-migration.vendor-spec",
          "done",
          { by: "tia" },
          c.io,
        ),
      ).toBe(0);
      expect(
        await initiativeCommitment(
          root,
          "northwind-pay-v3-migration.vendor-spec",
          "finished",
          { by: "tia" },
          c.io,
        ),
      ).toBe(2);
      c = capture();
      expect(
        await requestFromTeam(
          root,
          "northwind-pay-v3-migration",
          "party.nobody",
          { by: "tia" },
          c.io,
          { now: NOW },
        ),
      ).toBe(1);
      expect(c.err).toEqual(["There is no party party.nobody."]);
      expect(await initiativeNew(root, { title: "x" }, c.io)).toBe(2);
      expect(await initiativeStatus(root, undefined, {}, c.io)).toBe(2);
    },
    T,
  );
});
