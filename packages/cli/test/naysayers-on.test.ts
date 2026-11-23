import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { personaLenses } from "@maycombhq/naysayer";
import { initCommand } from "../src/setup-commands.js";
import { starterPersonasStep } from "../src/upgrade.js";

/**
 * v31 (WP-06): a new metarepo has the application architect's and the security naysayers on at
 * the design gate (`gates: [design]` in the starter files), and no other. An organisation turns
 * one off by deleting the line, or rewrites it: neither `atticus init` run again nor the
 * starter-personas upgrade step ever writes over a naysayer file that is there.
 */

const T = 60_000;
const quiet = { out: () => undefined, err: () => undefined };
const ON = ["application-architect-naysayer", "security-naysayer"];
const dirs: string[] = [];

async function newMetarepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "b31-naysayers-"));
  dirs.push(dir);
  const root = join(dir, "forge");
  expect(await initCommand(root, { name: "forge", platform: "github", owner: "pat" }, quiet)).toBe(
    0,
  );
  return root;
}

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("the architect and security naysayers are on at the design gate in a new metarepo", () => {
  it(
    "init writes them with gates: [design]; every other naysayer runs at no gate",
    async () => {
      const root = await newMetarepo();
      const lenses = await personaLenses(root, 1000);
      expect(lenses.length).toBeGreaterThan(ON.length);
      expect(lenses.filter((l) => l.gates.length).map((l) => [l.name, l.gates])).toEqual(
        ON.map((n) => [n, ["design"]]),
      );
    },
    T,
  );

  it(
    "an organisation's edited naysayer is never written over, by init again or by the upgrade",
    async () => {
      const root = await newMetarepo();
      const agents = join(root, "org-pack", "agents");
      const architect = join(agents, `${ON[0]}.md`);
      const security = join(agents, `${ON[1]}.md`);
      // One turned off (its line deleted), one rewritten by the organisation.
      const off = (await readFile(architect, "utf8")).replace(
        /\n# Runs at the design[^\n]*\ngates: \[design\]\n/,
        "\n",
      );
      expect(off).not.toContain("gates:");
      await writeFile(architect, off);
      const mine =
        "---\nname: security-naysayer\nowns: Security\ngates: [plan]\n---\n\nForge's own security questions.\n";
      await writeFile(security, mine);
      // A starter file the organisation deleted, for the upgrade step to have something to write.
      await rm(join(agents, "qa-naysayer.md"));

      // init again over the metarepo: whatever it says, it writes over nothing.
      await initCommand(root, { name: "forge", platform: "github", owner: "pat" }, quiet);
      expect(await readFile(architect, "utf8")).toBe(off);
      expect(await readFile(security, "utf8")).toBe(mine);

      // The upgrade step, as for an org pack made before it (the stamp doesn't name it yet).
      const stampFile = join(root, ".atticus", "metarepo.yaml");
      const stamp = parse(await readFile(stampFile, "utf8")) as { migrations: string[] };
      stamp.migrations = stamp.migrations.filter((m) => m !== "starter-personas");
      await writeFile(stampFile, stringify(stamp));
      const step = starterPersonasStep();
      const pending = await step.pending(root);
      expect(pending).not.toContain(`org-pack/agents/${ON[0]}.md`);
      expect(pending).not.toContain(`org-pack/agents/${ON[1]}.md`);
      expect(await step.apply(root)).toEqual(pending);
      expect(existsSync(join(agents, "qa-naysayer.md"))).toBe(
        pending.includes("org-pack/agents/qa-naysayer.md"),
      );
      expect(await readFile(architect, "utf8")).toBe(off);
      expect(await readFile(security, "utf8")).toBe(mine);

      // The organisation's choice is what runs.
      const lenses = await personaLenses(root, 1000);
      expect(lenses.filter((l) => l.gates.length).map((l) => [l.name, l.gates])).toEqual([
        [ON[1], ["plan"]],
      ]);
    },
    T,
  );
});
