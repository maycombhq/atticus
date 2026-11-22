import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { main } from "../src/main.js";
import { TOPIC, UNREAD_REPO, withoutCodeTable } from "./archetypes-changes.js";
import { seedForgeField, type ForgeField } from "./forge-field.js";

/**
 * ADR 0206 part B, 2: a quick change has no target flows, so its map, impact and estimate are
 * read from design.md's "## In the code", and before it is written from tasks.md's repos, each
 * saying what it is drawn from. On the field-shaped estate (fixtures/forge-field) and its quick
 * change, publish-settled-refunds: forge-svc-01 publishes to the topic, forge-audit (nobody read
 * it) listens. Invented Forge names only; no network.
 */

const T = 300_000;
const ID = "publish-settled-refunds";
const PUBLISHER = "forge-svc-01";
let dir: string;
let e: ForgeField & { root: string };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "b30-quick-views-"));
  e = await seedForgeField(dir);
}, T);
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    [...args, "--root", e.root],
    {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    },
    { quiet: true },
  );
  return { code, out, err };
}
const json = async <X>(args: string[]) => {
  const r = await run([...args, "--json"]);
  expect(r.code, r.err.join("\n")).toBe(0);
  return JSON.parse(r.out.join("\n")) as X;
};
const designFile = () => join(e.root, "openspec/changes", ID, "design.md");

describe("a quick change's map, impact and estimate, from design.md's In the code (ADR 0206)", () => {
  it(
    "the map draws the rows: the publisher to the topic, the topic to its new listener",
    async () => {
      const m = await json<Api.ChangeMapT & { from?: string; rows?: number }>([
        "change",
        "map",
        ID,
      ]);
      expect(m).toMatchObject({ flows: 0, from: "design", rows: 2 });
      expect(m.source).toBe(`openspec/changes/${ID}/design.md`);
      const label = (id: string) => m.nodes.find((n) => n.id === id)?.label ?? "";
      const lines = m.edges.map((x) => [label(x.from), label(x.to), x.label, x.async] as const);
      expect(
        lines.some(
          ([f, t, l, a]) =>
            f.includes(PUBLISHER) && t.includes(TOPIC) && String(l).endsWith(TOPIC) && a,
        ),
      ).toBe(true);
      expect(lines.some(([f, t]) => f.includes(TOPIC) && t.includes(UNREAD_REPO))).toBe(true);
      expect(m.edges).toHaveLength(2);
      // A repo the manifest lists is no new part, read or not; only what the change plans is.
      expect(m.nodes.find((n) => n.id === UNREAD_REPO)?.legend).not.toBe("new");
      const r = await run(["change", "map", ID]);
      expect(r.code).toBe(0);
      expect(r.err).toContain(
        `Drawn from design.md's In the code (2 rows), not from target flows: ${ID} is a quick change.`,
      );
      expect(r.out.join("\n")).toContain("flowchart");
    },
    T,
  );

  it(
    "impact lists who receives what the rows name, under reaches, never as breaks",
    async () => {
      const i = await json<
        Api.ChangeImpactT & {
          from?: string;
          reaches?: { line: number; has: string; name: string; receivers: { id: string }[] }[];
        }
      >(["change", "impact", ID]);
      expect(i).toMatchObject({ flows: 0, from: "design", breaks: 0, mayBreak: 0 });
      expect(i.items).toEqual([]);
      expect(i.reaches!.map((x) => [x.has, x.name])).toEqual([
        ["publishes", TOPIC],
        ["listens", TOPIC],
      ]);
      // The same receivers ask names for the topic's consumers.
      const asked = await json<{ receivers: { id: string }[] }>(["ask", `who consumes ${TOPIC}`]);
      const ids = (xs: { id: string }[]) => [...new Set(xs.map((x) => x.id))].sort();
      expect(ids(i.reaches![0]!.receivers)).toEqual(ids(asked.receivers));
      expect(ids(asked.receivers).length).toBeGreaterThan(0);
      const r = await run(["change", "impact", ID]);
      expect(r.out[0]).toBe(
        `${ID}: a quick change says what its code will have, not which fields change, so Atticus can't tell what breaks; here is who each part it names reaches. Each owner confirms.`,
      );
    },
    T,
  );

  it(
    "the estimate has a unit a row, classed by what it has, citing design.md",
    async () => {
      const x = await json<Api.ChangeEstimateT>(["change", "estimate", ID]);
      expect(x.units.map((u) => [u.repo, u.flow, u.class, (u as { from?: string }).from])).toEqual([
        [PUBLISHER, "e2", "quick/publishes", "design"],
        [UNREAD_REPO, "e1", "quick/listens", "design"],
      ]);
      expect(x.units[0]!.source).toBe(`openspec/changes/${ID}/design.md`);
      expect(x.source).toBe(`openspec/changes/${ID}/design.md`);
    },
    T,
  );

  it(
    "before the table is written: tasks.md's repos are drawn and sized, and impact says what it needs",
    async () => {
      const text = await readFile(designFile(), "utf8");
      await writeFile(designFile(), withoutCodeTable(text));
      try {
        const m = await json<Api.ChangeMapT & { from?: string }>(["change", "map", ID]);
        expect(m.from).toBe("tasks");
        expect(m.edges).toEqual([]);
        expect(m.nodes.map((n) => n.label).join(" ")).toContain(UNREAD_REPO);
        expect(m.problems).toContain(
          "design.md doesn't say what the code will have yet, so no line is drawn: its ## In the code does.",
        );
        const x = await json<Api.ChangeEstimateT>(["change", "estimate", ID]);
        expect(x.units.map((u) => [u.repo, u.flow, u.class])).toEqual([
          [PUBLISHER, "e2", "quick/task"],
          [UNREAD_REPO, "e1", "quick/task"],
        ]);
        const r = await run(["change", "impact", ID]);
        expect(r.code).toBe(0);
        expect(r.out[0]).toBe(
          `${ID}'s impact is read from design.md's ## In the code, which it doesn't have yet: the spec writer writes it (/define-change ${ID}).`,
        );
        // The review of ADR 0206: the check offers the quick path's next step, never a stage.
        const quick = `${ID} is a quick change and its design.md doesn't say what the code will have yet, so there is nothing to check the code against: the spec writer writes its ## In the code (/define-change ${ID}), or a person does; atticus change status ${ID} says whether it reads. Then check again: atticus change conform ${ID}.`;
        const c = await run(["change", "conform", ID]);
        expect(c.code).toBe(1);
        expect(c.err).toContain(quick);
        expect([...c.out, ...c.err].join("\n")).not.toContain("atticus change architecture");
        const latest = await run(["change", "conform", ID, "--latest"]);
        expect(latest.out).toContain(quick);
        expect(latest.out.join("\n")).not.toContain("atticus change architecture");
      } finally {
        await writeFile(designFile(), text);
      }
    },
    T,
  );
});
