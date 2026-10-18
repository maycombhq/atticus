import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handDown } from "../src/index.js";
import { CHANGE, git, read, speckitRoot, worktree } from "./helpers.js";

/**
 * A repo that already has its own Spec Kit constitution keeps it: hand-down merges Atticus's
 * rules into a clearly marked section (and only ever rewrites that section), or refuses with
 * a clear message when the file can't take a section, changing nothing.
 */

const T = 120_000;
const PATH = ".specify/memory/constitution.md";
const TEAM = `# Ledger Team Constitution

## Core Principles

### I. Small pull requests
Every pull request changes one thing.

## Governance

The ledger team amends this file by pull request.
`;

async function withTeamConstitution(text: string) {
  const { root } = await speckitRoot();
  const wt = worktree(root, "forge-ledger");
  await mkdir(join(wt, ".specify/memory"), { recursive: true });
  await writeFile(join(wt, PATH), text, "utf8");
  return { root, wt };
}

describe("hand-down and a team's own constitution", () => {
  it(
    "merges Atticus's rules into a marked section and never replaces the team's text",
    async () => {
      const { root, wt } = await withTeamConstitution(TEAM);
      const r = await handDown(root, CHANGE, "1.2", { git });
      expect(r.written).toContain(PATH);
      const text = await read(join(wt, PATH));
      // The team's text is untouched, first, and Atticus's section follows it.
      expect(text.startsWith(TEAM)).toBe(true);
      const after = text.slice(TEAM.length).split("\n");
      expect(after[1]).toMatch(
        /^<!-- atticus:begin generated from org-pack checklists and the Atticus constitution; atticus-sha256: [0-9a-f]{64} -->$/,
      );
      expect(after[2]).toBe("## Atticus Rules");
      expect(text).toContain("\n### Core Principles\n");
      expect(text).toContain("\n#### I. Every interface names an approved integration pattern\n");
      expect(text).toContain("\n### Team Rules (team-ledger)\n");
      expect(text).toContain("Everything outside this section is the team's own");
      expect(text.trimEnd().endsWith("<!-- atticus:end -->")).toBe(true);
      // Only one H1: the team's.
      expect(text.split("\n").filter((l) => l.startsWith("# "))).toEqual([
        "# Ledger Team Constitution",
      ]);

      // Again: nothing changes. With force: still only the section is Atticus's.
      const again = await handDown(root, CHANGE, "1.2", { git });
      expect(again.unchanged).toContain(PATH);
      await handDown(root, CHANGE, "1.2", { git, force: true });
      expect(await read(join(wt, PATH))).toBe(text);
    },
    T,
  );

  it(
    "refuses, changing nothing, when the team's file has broken Atticus markers",
    async () => {
      const broken = `${TEAM}\n<!-- atticus:begin generated from somewhere; atticus-sha256: ${"0".repeat(64)} -->\nOld rules with no end marker.\n`;
      const { root, wt } = await withTeamConstitution(broken);
      const r = await handDown(root, CHANGE, "1.2", { git, force: true });
      expect(await read(join(wt, PATH))).toBe(broken);
      expect(r.kept).toContain(PATH);
      expect(r.written).not.toContain(PATH);
      expect(r.problems).toContain(
        ".specify/memory/constitution.md is the team's own constitution and its Atticus section markers are broken (a begin marker without an end marker), so Atticus can't merge its rules into it. Fix or remove the markers, then hand down again.",
      );
    },
    T,
  );
});
