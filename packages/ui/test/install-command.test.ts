import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COPY, installCommand, NEWER_ATTICUS_COMMAND } from "../src/copy";

/** Beta.30: one install command in the app's words, at the exact version where it is known. */
describe("the one command that installs Atticus, in the app's words", () => {
  it("names the exact version", () => {
    expect(installCommand("2.0.0-beta.30")).toBe("npm install -g @maycombhq/atticus@2.0.0-beta.30");
  });

  it("gives it where a newer Atticus upgraded the metarepo, at that Atticus's version", () => {
    const words = COPY.upgrade.newer("2.0.0-beta.30", "2.0.0-beta.28.5");
    expect(words).toContain("A newer Atticus (2.0.0-beta.30) upgraded this metarepo");
    expect(words).toContain(installCommand("2.0.0-beta.30"));
    expect(words).not.toMatch(/@latest|@beta\b(?!\.)/);
  });

  it("says the Local API's own command where only the catalog's format says a newer Atticus built it", () => {
    // The version isn't recorded there; `command` of a newer-atticus refusal is this (ADR 0197).
    expect(NEWER_ATTICUS_COMMAND).toBe("npm i -g @maycombhq/atticus@beta");
    expect(COPY.upgrade.newerCatalog).toContain(NEWER_ATTICUS_COMMAND);
  });

  it("is written in one place each: no other install line in the copy file", async () => {
    const text = await readFile(join(__dirname, "..", "src", "copy.ts"), "utf8");
    const lines = text.split("\n").filter((l) => /npm i(nstall)? -g @maycombhq\/atticus/.test(l));
    expect(lines.map((l) => l.trim())).toEqual([
      "export const installCommand = (version: string) => `npm install -g @maycombhq/atticus@${version}`;",
      'export const NEWER_ATTICUS_COMMAND = "npm i -g @maycombhq/atticus@beta";',
    ]);
  });
});
