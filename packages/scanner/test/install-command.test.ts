import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEWER_ATTICUS_COMMAND, newerAtticusWords } from "../src/index.js";

/** Beta.30: the refusal's words and its `command` are one constant, so they can't drift apart. */
describe("the command that upgrades Atticus, in the build's refusal", () => {
  it("is the one the refusal's words give", () => {
    const words = newerAtticusWords([
      {
        path: "catalog/sources/build.json",
        name: "build.json",
        field: "version",
        version: 3,
        reads: 2,
      },
    ]);
    expect(words).toContain(`upgrade Atticus (${NEWER_ATTICUS_COMMAND})`);
    expect(words.match(/npm i(nstall)? -g/g)).toHaveLength(1);
  });

  it("is written once in the scanner's sources", async () => {
    const lines: string[] = [];
    for (const f of ["slots.ts", "build.ts"])
      for (const l of (await readFile(join(__dirname, "..", "src", f), "utf8")).split("\n"))
        if (/npm i(nstall)? -g @maycombhq\/atticus/.test(l)) lines.push(`${f}: ${l.trim()}`);
    // ADR 0202 point 7: and once more for the exact version a newer build.json names.
    expect(lines).toEqual([
      'slots.ts: export const NEWER_ATTICUS_COMMAND = "npm i -g @maycombhq/atticus@beta";',
      "slots.ts: return v ? `npm install -g @maycombhq/atticus@${toInstall(v)}` : NEWER_ATTICUS_COMMAND;",
    ]);
  });
});
