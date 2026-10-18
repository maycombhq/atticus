import { cp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ReplayRuntime } from "@maycombhq/ai";
import { critic } from "@maycombhq/cli/dist/critic-commands.js";
import { Finding } from "@maycombhq/core";
import {
  atticus,
  CHANGE,
  changeDir,
  FORGE_CHANGE,
  forgeEstate,
  removeTop,
  T,
  writeExpectedCatalog,
  type Estate,
} from "./helpers.js";

/**
 * M3 exit: "the critic catches every seeded blocking issue, including data-design, runtime and
 * knowledge gaps, and at least 90% of seeded gaps". Measured on the hand-written fixture change
 * fixtures/forge-change at the plan gate, round 1, against expected/findings.yaml, exactly as
 * that file defines a match. Run through the CLI.
 */

interface Seeded {
  id: string;
  kind: "issue" | "knowledge-gap";
  severity: string;
  layer: "deterministic" | "ai";
  rule: string;
  artifact?: string;
  line?: number;
  record?: string;
}

const NOW = "2026-10-20T09:00:00Z";

async function expectedFindings() {
  return parse(await readFile(join(FORGE_CHANGE, "expected/findings.yaml"), "utf8")) as {
    gate: string;
    seeded: Seeded[];
    alsoExpected: Seeded[];
  };
}

function matches(e: Seeded, x: Finding): boolean {
  if (x.rule !== e.rule || x.severity !== e.severity || x.kind !== e.kind) return false;
  if (e.artifact && x.artifact !== e.artifact) return false;
  if (e.line && x.locator.line !== e.line) return false;
  if (e.record && x.locator.record !== e.record && !x.evidence.some((v) => v.record === e.record))
    return false;
  return true;
}

/** The critic's findings for a gate and round, read back from the C3 files it wrote. */
async function roundFindings(root: string, gate: string, round: number): Promise<Finding[]> {
  const dir = join(changeDir(root), "review", gate, String(round));
  const out: Finding[] = [];
  for (const f of (await readdir(dir)).filter((n) => n.endsWith(".yaml")).sort())
    out.push(Finding.parse(parse(await readFile(join(dir, f), "utf8"))));
  return out;
}

/** The Forge estate with the seeded fixture change at the plan phase, on the expected catalog. */
async function seededEstate(): Promise<Estate> {
  const e = await forgeEstate();
  await writeExpectedCatalog(e.root);
  await cp(join(FORGE_CHANGE, "openspec/changes", CHANGE), changeDir(e.root), {
    recursive: true,
  });
  return e;
}

interface Score {
  blocking: { caught: string[]; missed: string[] };
  gaps: { caught: string[]; missed: string[] };
}

function score(seeded: Seeded[], found: Finding[]): Score {
  const split = (list: Seeded[]) => ({
    caught: list.filter((s) => found.some((f) => matches(s, f))).map((s) => s.id),
    missed: list.filter((s) => !found.some((f) => matches(s, f))).map((s) => s.id),
  });
  return {
    blocking: split(seeded.filter((s) => s.severity === "blocking")),
    gaps: split(seeded.filter((s) => s.kind === "knowledge-gap")),
  };
}

const rate = (s: { caught: string[]; missed: string[] }) =>
  s.caught.length / (s.caught.length + s.missed.length);

const made: Estate[] = [];
afterAll(async () => {
  for (const e of made) await removeTop(e);
});

describe("M3 exit: the critic on the seeded fixture change (plan gate, round 1)", () => {
  let ex: Awaited<ReturnType<typeof expectedFindings>>;
  beforeAll(async () => {
    ex = await expectedFindings();
  });

  it(
    "atticus critic catches every seeded problem the deterministic layer owns: 12 blocking (data design, runtime, architecture, stories, service desk) and 11 knowledge gaps",
    async () => {
      const e = await seededEstate();
      made.push(e);
      const r = await atticus(e.root, "critic", CHANGE, "--gate", "plan");
      expect(r.code).toBe(1);
      expect(r.out[0]).toMatch(/^Critic round 1 of 2 at the plan gate for add-transfer-limit: /);
      const found = await roundFindings(e.root, "plan", 1);
      const det = ex.seeded.filter((s) => s.layer === "deterministic");
      const s = score(det, found);
      expect(s.blocking.missed).toEqual([]);
      expect(s.gaps.missed).toEqual([]);
      expect(s.blocking.caught).toHaveLength(12);
      expect(s.gaps.caught).toHaveLength(11);
      // The three kinds the exit names: data design, runtime, knowledge gaps.
      expect(s.blocking.caught).toEqual(
        expect.arrayContaining([
          "b06-table-without-migration",
          "b07-personal-column-unclassified",
          "b08-table-without-retention",
          "b04-vendor-call-no-timeout",
          "b05-risk-call-no-timeout",
        ]),
      );
      // Every finding cites evidence.
      for (const f of found) expect(f.evidence.length).toBeGreaterThan(0);
    },
    T,
  );

  it(
    "critic-ai-wiring: atticus critic --mode replay runs the AI lenses, so the CLI alone catches 14 of 14 blocking and 13 of 13 gaps",
    async () => {
      const e = await seededEstate();
      made.push(e);
      const env = { ...process.env };
      process.env.ATTICUS_RUNTIME = "replay";
      process.env.ATTICUS_REPLAY_DIR = join(FORGE_CHANGE, "recordings");
      try {
        const r = await atticus(e.root, "critic", CHANGE, "--gate", "plan", "--mode", "replay");
        expect(r.text).not.toMatch(/no AI runtime was given/);
        const s = score(ex.seeded, await roundFindings(e.root, "plan", 1));
        expect(s.blocking.missed).toEqual([]);
        expect(rate(s.gaps)).toBeGreaterThanOrEqual(0.9);
      } finally {
        process.env = env;
      }
    },
    T,
  );

  it(
    "with the recorded-replay runtime the critic command catches 14 of 14 seeded blocking issues and 13 of 13 seeded gaps (100%), each in the layer the fixture names, and nothing unlisted",
    async () => {
      const e = await seededEstate();
      made.push(e);
      const out: string[] = [];
      const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
      const runtime = await ReplayRuntime.fromDir(join(FORGE_CHANGE, "recordings"), {
        now: () => new Date(NOW),
      });
      expect(
        await critic(e.root, CHANGE, { gate: "plan", json: true }, io, { runtime, now: NOW }),
      ).toBe(1);
      const res = JSON.parse(out.join("\n")) as {
        round: number;
        open: { blocking: number; gaps: number };
        findings: { id: string; layer: string }[];
        lenses: { lens: string; state: string }[];
      };
      expect(res.round).toBe(1);
      expect(res.open).toMatchObject({ blocking: 14, gaps: 13 });
      expect(res.lenses.filter((l) => l.state === "failed")).toEqual([]);
      const found = await roundFindings(e.root, "plan", 1);
      const s = score(ex.seeded, found);
      expect(s.blocking.missed).toEqual([]);
      expect(s.blocking.caught).toHaveLength(14);
      expect(s.gaps.missed).toEqual([]);
      expect(rate(s.gaps)).toBe(1);
      // Each seeded problem was caught by the layer the fixture names.
      const layerOf = new Map(res.findings.map((f) => [f.id, f.layer]));
      for (const x of [...ex.seeded, ...ex.alsoExpected]) {
        const f = found.find((y) => matches(x, y));
        expect(f, x.id).toBeDefined();
        expect({ id: x.id, layer: layerOf.get(f!.id) }).toEqual({ id: x.id, layer: x.layer });
      }
      const listed = [...ex.seeded, ...ex.alsoExpected];
      expect(found.filter((f) => !listed.some((x) => matches(x, f))).map((f) => f.summary)).toEqual(
        [],
      );
    },
    T,
  );
});
