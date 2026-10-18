import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileText, smokeCheck } from "@maycombhq/assistant-files";
import {
  adopt,
  checkZeroInstall,
  referencedPaths,
  resolveMetarepo,
  zeroInstallFiles,
} from "../src/index.js";
import { cleanup, copyFixture } from "./helpers.js";

afterAll(cleanup);

const COMMANDS = [
  "atticus-ask",
  "atticus-critic",
  "atticus-impact",
  "atticus-plan",
  "atticus-release",
  "atticus-snow",
];

describe("zero-install commands in an adopted repo", () => {
  for (const [shape, as] of [
    ["openspec-repo", "catalog-service"],
    ["speckit-repo", "order-export"],
    ["assistant-repo", "pricing-service"],
    ["plain-multi", "shop"],
  ] as const)
    it(`every file a command points at exists after adopt (${shape})`, async () => {
      const dir = await copyFixture(shape, as);
      await adopt(dir);
      const gen = await zeroInstallFiles(dir);
      const paths = gen.files.map((f) => f.path);
      for (const c of COMMANDS) {
        expect(paths).toContain(`.claude/commands/${c}.md`);
        expect(paths).toContain(`.github/prompts/${c}.prompt.md`);
      }
      // Only committed files: read back what was written, as a person who cloned the repo would.
      const written = await Promise.all(
        gen.files.map(async (f) => ({
          path: f.path,
          content: await readFile(join(dir, f.path), "utf8"),
        })),
      );
      expect(await checkZeroInstall(dir, written)).toEqual([]);
      expect(smokeCheck(written)).toEqual([]);
      expect(written.find((f) => f.path === ".claude/commands/atticus-ask.md")!.content).toBe(
        fileText(gen.files.find((f) => f.path === ".claude/commands/atticus-ask.md")!),
      );
      // The org pack is where adopt put it, never a bare org-pack/ that doesn't exist.
      const ask = written.find((f) => f.path === ".claude/commands/atticus-critic.md")!.content;
      expect(ask).toContain("`.atticus/org-pack/checklists/*.yaml`");
      expect(ask).not.toMatch(/(^|[^/])org-pack\/checklists/m);
    });

  it("the check finds a missing file (so a pass means something)", async () => {
    const dir = await copyFixture("openspec-repo", "catalog-service");
    await adopt(dir);
    const gen = await zeroInstallFiles(dir);
    await rm(join(dir, ".atticus/org-pack/gates.yaml"));
    const problems = await checkZeroInstall(
      dir,
      gen.files.map((f) => ({ path: f.path, content: f.content })),
    );
    expect(problems).toEqual([
      { file: ".claude/commands/atticus-release.md", missing: ".atticus/org-pack/gates.yaml" },
      {
        file: ".github/prompts/atticus-release.prompt.md",
        missing: ".atticus/org-pack/gates.yaml",
      },
    ]);
  });

  it("reads paths under the layout and cuts placeholders and globs at their folder", async () => {
    const dir = await copyFixture("speckit-repo", "order-export");
    await adopt(dir);
    const p = await resolveMetarepo(dir);
    expect(
      referencedPaths(
        "Read `.atticus/openspec/changes/<change id>/design.md`, `.atticus/org-pack/process/snow/*.yaml`, `.atticus/catalog/generated/` and `review/` and `/atticus-ask`.",
        p,
      ),
    ).toEqual([
      ".atticus/catalog/generated",
      ".atticus/openspec/changes",
      ".atticus/org-pack/process/snow",
    ]);
  });
});
