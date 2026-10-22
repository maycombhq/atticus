import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ADR 0096: what the extension offers in VS Code (package.json) and what its code registers agree,
 * so no menu item or palette entry does nothing and no command is unreachable.
 */

// Vitest runs in the package folder.
const HERE = join(process.cwd(), "test");
const pkg = JSON.parse(readFileSync(join(HERE, "../package.json"), "utf8")) as {
  contributes: {
    commands: { command: string }[];
    menus: Record<string, { command: string }[]>;
    views: Record<string, { id: string }[]>;
  };
};
const src = readdirSync(join(HERE, "../src"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(join(HERE, "../src", f), "utf8"))
  .join("\n");

describe("the extension's manifest and its code", () => {
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  const registered = new Set(
    [
      ...src.matchAll(/reg\(\s*"(atticus\.[A-Za-z]+)"/g),
      ...src.matchAll(/\["(atticus\.[A-Za-z]+)", "/g),
    ].map((m) => m[1]!),
  );
  // The step commands are registered in a loop over STEP_COMMANDS.
  for (const s of ["survey", "verify", "spec", "feature", "architecture", "stories"])
    registered.add(`atticus.${s}`);

  it("registers every command it declares", () => {
    expect([...declared].filter((c) => !registered.has(c))).toEqual([]);
  });

  it("declares every command a menu offers", () => {
    const inMenus = Object.values(pkg.contributes.menus).flatMap((m) => m.map((x) => x.command));
    expect(inMenus.filter((c) => !declared.has(c))).toEqual([]);
  });

  it("draws every view it declares", () => {
    const views = pkg.contributes.views.atticus!.map((v) => v.id);
    expect(
      views.filter((v) => !src.includes(`"${v}"`) && !src.includes(`\`atticus.\${name}\``)),
    ).toEqual([]);
  });
});
