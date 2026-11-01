import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createOpenSpec,
  ORG_FLOW,
  setDefaultSchema,
  writeOrgFlowSchema,
} from "@maycombhq/openspec-adapter";
import { readExistingSpecs, specDeltas, type StoriesAnswer } from "@maycombhq/planner";
import { specAccept, specSeed } from "../src/spec-seed-commands.js";

/**
 * V2 (ADR 0146) on a metarepo set up with the pinned OpenSpec (local, no network): `spec seed`
 * proposes the repo's starting spec as the change seed-<repo>, `spec accept` archives it into
 * openspec/specs/, a second seed has nothing to do, and a change's stories then MODIFY the
 * seeded requirement. Flows from fixtures/spec-seed/specs/.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/spec-seed");
const T = 300_000;

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

async function metarepo(openspec = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-spec-seed-"));
  if (openspec) {
    await createOpenSpec({ root }).init();
    await writeOrgFlowSchema(root);
    await setDefaultSchema(root, ORG_FLOW);
  }
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  return root;
}

describe("atticus spec seed and accept", () => {
  it(
    "refuses without OpenSpec, without flows, and without a seed to accept",
    async () => {
      const plain = await metarepo(false);
      const a = io();
      expect(await specSeed(plain, "forge-orders", {}, a.io)).toBe(2);
      expect(a.err.join("\n")).toContain("atticus openspec setup");
      const root = await metarepo();
      const b = io();
      expect(await specSeed(root, "forge-nothing", {}, b.io)).toBe(2);
      expect(b.err.join("\n")).toContain("atticus verify forge-nothing --write");
      const c = io();
      expect(await specAccept(root, "forge-orders", { by: "dana" }, c.io)).toBe(2);
      expect(c.err.join("\n")).toContain("atticus spec seed forge-orders");
    },
    T,
  );

  it(
    "seeds a change a person accepts into openspec/specs; the next change modifies it",
    async () => {
      const root = await metarepo();
      const dir = join(root, "openspec/changes/seed-forge-orders");
      const a = io();
      expect(await specSeed(root, "forge-orders", {}, a.io)).toBe(0);
      expect(a.out[0]).toContain("Wrote openspec/changes/seed-forge-orders/");
      expect(a.out).toContain("Not seeded: forge-orders.old-export (retired).");
      expect(readdirSync(join(dir, "specs")).sort()).toEqual([
        "forge-orders-list-orders",
        "forge-orders-place-order",
      ]);
      // nothing went into openspec/specs before a person accepts it
      expect(existsSync(join(root, "openspec/specs/forge-orders-place-order"))).toBe(false);
      expect(await readFile(join(dir, "specs/forge-orders-place-order/spec.md"), "utf8")).toBe(
        await readFile(join(FIX, "expected/forge-orders-place-order.spec.md"), "utf8"),
      );

      // a person's edit, mark removed, survives a second seed
      const list = join(dir, "specs/forge-orders-list-orders/spec.md");
      const edited = (await readFile(list, "utf8")).split("\n").slice(1).join("\n");
      await writeFile(list, edited);
      const again = io();
      expect(await specSeed(root, "forge-orders", {}, again.io)).toBe(0);
      expect(await readFile(list, "utf8")).toBe(edited);
      expect(again.out.join("\n")).toContain(
        "Kept openspec/changes/seed-forge-orders/specs/forge-orders-list-orders/spec.md",
      );

      const b = io();
      expect(
        await specAccept(
          root,
          "forge-orders",
          { by: "dana", now: new Date("2026-10-31T09:00:00Z") },
          b.io,
        ),
      ).toBe(0);
      expect(b.err).toEqual([]);
      const os = createOpenSpec({ root });
      const specs = await readExistingSpecs(os);
      expect(specs.map((s) => [s.id, s.flow])).toEqual([
        ["forge-orders-list-orders", "forge-orders.list-orders"],
        ["forge-orders-place-order", "forge-orders.place-order"],
      ]);
      const seeded = specs[1]!.requirements[0]!;
      expect(seeded.name).toBe("A client places an order");
      expect(seeded.scenarios.map((s) => s.name)).toEqual([
        "Main path: 201 Created with the saved order",
        "Path: An order for more than 100 units is marked for a person to check",
        "Error: The body fails validation",
        "Error: The stock service refuses the reservation",
      ]);
      const archived = readdirSync(join(root, "openspec/changes/archive"));
      expect(archived.some((d) => d.endsWith("seed-forge-orders"))).toBe(true);
      const proposal = await readFile(
        join(
          root,
          "openspec/changes/archive",
          archived.find((d) => d.endsWith("seed-forge-orders"))!,
          "proposal.md",
        ),
        "utf8",
      );
      expect(proposal).toContain("Accepted by dana on 2026-10-31.");

      // seeded once: nothing left to seed
      const c = io();
      expect(await specSeed(root, "forge-orders", {}, c.io)).toBe(0);
      expect(c.out[0]).toContain("Nothing to seed");

      // the first change on the flow writes MODIFIED against the seed, keeping its scenarios
      const answer = {
        stories: [
          {
            id: "s1",
            title: "Hold big orders",
            asA: "shop owner",
            iWant: "big orders held",
            soThat: "nothing ships unchecked",
            tasks: [
              {
                id: "t1",
                criteria: [
                  {
                    text: "Given an order above 1000, when POST /orders is called, then 202 says it waits",
                    checks: [],
                    outcome: "success",
                  },
                ],
              },
            ],
          },
        ],
      } as unknown as StoriesAnswer;
      const story = {
        id: "s1",
        repo: "forge-orders",
        flow: "forge-orders.place-order",
        name: "A client places an order",
        change: "modify" as const,
        tasks: [{ id: "t1" }],
      } as unknown as Parameters<typeof specDeltas>[1][number];
      const [d] = specDeltas("hold-big-orders", [story], answer, {
        existing: specs,
        multiRepo: true,
      });
      expect([d!.capability, d!.added.length, d!.modified.length]).toEqual([
        "forge-orders-place-order",
        0,
        1,
      ]);
      expect(d!.modified[0]!.scenarios.map((s) => s.name)).toEqual([
        ...seeded.scenarios.map((s) => s.name),
        "202 says it waits",
      ]);
    },
    T,
  );

  it(
    "warns when a change already adds a flow the seed adds (ADR 0156)",
    async () => {
      const root = await metarepo();
      const change = join(root, "openspec/changes/hold-big-orders/specs/forge-orders-place-order");
      await mkdir(change, { recursive: true });
      await cp(join(FIX, "collision/hold-big-orders.spec.md"), join(change, "spec.md"));
      const a = io();
      expect(await specSeed(root, "forge-orders", {}, a.io)).toBe(0);
      expect(a.err.join("\n")).toContain(
        "hold-big-orders's stories add flow forge-orders.place-order (capability forge-orders-place-order) as new, and the open seed seed-forge-orders adds it too",
      );
      const j = io();
      expect(await specSeed(root, "forge-orders", { json: true }, j.io)).toBe(0);
      expect(JSON.parse(j.out.join("\n")).collisions).toEqual([
        {
          change: "hold-big-orders",
          seed: "seed-forge-orders",
          repo: "forge-orders",
          capability: "forge-orders-place-order",
          flow: "forge-orders.place-order",
        },
      ]);
    },
    T,
  );
});
