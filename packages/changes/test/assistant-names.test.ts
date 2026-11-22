import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assistantActor } from "@maycombhq/core";
import { BUILT_IN_AGENTS } from "../src/index.js";

/**
 * ADR 0203 A.4: every agent Atticus defines is an assistant, never the one who accepts or waives.
 * The ids are read from the code that defines them, not from a list kept by hand: each
 * `AgentDefinition.parse({ id: … })` (a string, or a constant the sources give a string), each
 * exported `…_AGENT` constant, and the Copilot agents Atticus writes (`COPILOT_AGENTS`).
 */

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "../..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function definedAgents(): Map<string, string> {
  const files = readdirSync(PACKAGES)
    .map((p) => join(PACKAGES, p, "src"))
    .filter((d) => statSync(d, { throwIfNoEntry: false })?.isDirectory())
    .flatMap(sources);
  const texts = files.map((f) => ({ f, text: readFileSync(f, "utf8") }));
  // Every string constant of the sources, to resolve `id: SOME_AGENT`.
  const consts = new Map<string, string>();
  for (const { text } of texts)
    for (const m of text.matchAll(/\bconst ([A-Z][A-Z0-9_]*) = "([a-z0-9-]+)"/g))
      consts.set(m[1]!, m[2]!);
  const out = new Map<string, string>();
  for (const { f, text } of texts) {
    const where = f.slice(PACKAGES.length + 1);
    for (const m of text.matchAll(/AgentDefinition\.parse\(\{[\s\S]{0,400}?\n\s*id: ([^,\n]+),/g)) {
      const v = m[1]!.trim();
      const id = /^"([a-z0-9-]+)"$/.exec(v)?.[1] ?? consts.get(v);
      if (id) out.set(id, where);
    }
    for (const m of text.matchAll(/export const [A-Z0-9_]*_AGENT = "([a-z0-9-]+)"/g))
      out.set(m[1]!, where);
  }
  // The Copilot agents Atticus writes for the person's assistant.
  const copilot = readFileSync(join(PACKAGES, "assistant-files/src/copilot-agents.ts"), "utf8");
  const list = copilot.slice(copilot.indexOf("export const COPILOT_AGENTS"));
  for (const m of list.slice(0, list.indexOf("\n];")).matchAll(/\n\s{4}id: "([a-z0-9-]+)"/g))
    out.set(m[1]!, "assistant-files/src/copilot-agents.ts");
  return out;
}

describe("every agent Atticus defines is an assistant (ADR 0203 A.4)", () => {
  const agents = definedAgents();

  it("finds the agents where the code defines them", () => {
    // A floor, so a broken reading can't pass with nothing found.
    for (const id of [
      "feature-placer",
      "task-runner",
      "judge",
      "atticus-stage-drafter",
      "atticus-task-runner",
      "atticus-verifier",
    ])
      expect([...agents.keys()]).toContain(id);
    expect(agents.size).toBeGreaterThan(20);
  });

  it.each([...definedAgents()].sort())("%s (%s) is an assistant", (id) => {
    expect(assistantActor(id, BUILT_IN_AGENTS)).toBe(id);
  });
});
