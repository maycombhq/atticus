import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodePluginFiles, metarepoCommands } from "../src/index.js";

/**
 * One set of slash commands everywhere (ADR 0119 item 3): what `atticus assistant-files` writes
 * is what the app lists, what the Claude Code plugin's README lists, what the guide names and what
 * IntelliJ tells a person to type. A command added to the list fails this test until every
 * surface has it; a surface naming a command that doesn't exist fails it too.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");
const names = new Set(metarepoCommands().map((c) => `/${c.name}`));
const mentioned = (text: string) => new Set(text.match(/\/atticus-[a-z][a-z-]*[a-z]/g) ?? []);
const sorted = (s: Iterable<string>) => [...s].sort();

describe("one set of slash commands on every surface", () => {
  it("the app's list of commands has every one, and no other", () => {
    const copy = read("packages/ui/src/copy.ts");
    const listed = new Set([...copy.matchAll(/name: "(\/atticus-[a-z-]+)"/g)].map((m) => m[1]!));
    expect(sorted(listed)).toEqual(sorted(names));
  });

  it("the Claude Code plugin's README lists every one", () => {
    const readme = claudeCodePluginFiles("0.0.0").find((f) => f.path === "README.md")!.content;
    for (const n of names) expect(readme, n).toContain(`\`${n}\``);
  });

  it("the guide for each kind of work names only commands that exist, and every step", () => {
    const roles = mentioned(read("docs/guide/roles.md"));
    expect(sorted([...roles].filter((n) => !names.has(n)))).toEqual([]);
    for (const n of ["/atticus-next", "/atticus-feature", "/atticus-small", "/atticus-stories"])
      expect(roles, n).toContain(n);
  });

  it("IntelliJ tells a person to type only commands that exist, and the right one per step", () => {
    const kt = read("packages/intellij/src/main/kotlin/com/maycombhq/atticus/core/Commands.kt");
    expect(sorted([...mentioned(kt)].filter((n) => !names.has(n)))).toEqual([]);
    const slash = new Map(
      [...kt.matchAll(/"([a-z]+ [a-z]+)" to "(\/atticus-[a-z-]+)"/g)].map((m) => [m[1]!, m[2]!]),
    );
    expect(slash.get("change draft")).toBe("/atticus-draft");
    expect(slash.get("knowledge ask")).toBe("/atticus-knowledge-ask");
    expect(slash.get("plan stories")).toBe("/atticus-stories");
  });
});
