import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { runCritic } from "../src/index.js";
import { CHANGE, NOW, forgeChangeRoot } from "./helpers.js";

/**
 * A lens answer that doesn't read (a model left a value with ": " unquoted) goes back to the
 * lens once in the same round, with why, before the lens counts as failed: a format slip
 * shouldn't throw a good review away. Seen with Claude Code on a real metarepo.
 */
const SLIP = `findings:
  - rule: x
    kind: issue
    summary: The stamp has no source: no clock step sets it
`;

async function root(): Promise<string> {
  const r = await forgeChangeRoot();
  const agents = join(r, "org-pack/agents");
  for (const f of await readdir(agents)) if (f.endsWith("-critic.yaml")) await rm(join(agents, f));
  return r;
}

describe("a lens answer that doesn't read", () => {
  it("is handed back once with the reason, and the second answer is the review", async () => {
    const prompts: string[] = [];
    const rt = new MockRuntime(
      (req: AiRequest) => {
        prompts.push(req.pack.prompt);
        return req.pack.prompt.includes("could not be read") ? "findings: []\n" : SLIP;
      },
      { now: () => new Date(NOW) },
    );
    const r = await runCritic(await root(), CHANGE, { now: NOW, runtime: rt });
    const ran = r.lenses.filter((l) => l.state !== "skipped");
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.map((l) => l.state)).toEqual(ran.map(() => "ran"));
    expect(prompts).toHaveLength(ran.length * 2);
    const again = prompts.filter((p) => p.includes("could not be read"));
    expect(again).toHaveLength(ran.length);
    // The earlier answer rides along as data for the lens to rewrite, not as an instruction.
    expect(again[0]).toContain("The stamp has no source: no clock step sets it");
  });

  it("still fails the lens when the second answer doesn't read either", async () => {
    const rt = new MockRuntime(() => SLIP, { now: () => new Date(NOW) });
    const r = await runCritic(await root(), CHANGE, { now: NOW, runtime: rt });
    const ran = r.lenses.filter((l) => l.state !== "skipped");
    expect(ran.every((l) => l.state === "failed" && /not YAML|YAML/.test(l.reason ?? ""))).toBe(
      true,
    );
  });
});
