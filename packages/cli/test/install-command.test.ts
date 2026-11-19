import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installCommand, VERSION } from "../src/version.js";

/** Beta.30: one install command on the command line, at the exact version. */
describe("the one command that installs Atticus, on the command line", () => {
  it("names the exact version, this Atticus's own unless another is needed", () => {
    expect(installCommand()).toBe(`npm install -g @maycombhq/atticus@${VERSION}`);
    expect(installCommand("2.0.0-beta.31")).toBe("npm install -g @maycombhq/atticus@2.0.0-beta.31");
  });

  it("is written in one place: no other install line in the command line's sources", async () => {
    const src = join(__dirname, "..", "src");
    const lines: string[] = [];
    for (const f of await readdir(src))
      if (f.endsWith(".ts"))
        for (const l of (await readFile(join(src, f), "utf8")).split("\n"))
          if (/npm i(nstall)? -g @maycombhq\/atticus/.test(l)) lines.push(`${f}: ${l.trim()}`);
    expect(lines).toEqual(["version.ts: `npm install -g @maycombhq/atticus@${version}`;"]);
    // A catalog a newer Atticus built: the build's own command (ADR 0197), not a line of ours.
    // ADR 0202 point 7: by its exact version when the newer build.json names its Atticus.
    expect(await readFile(join(src, "next-commands.ts"), "utf8")).toContain(
      "command: s.newerCommand ?? NEWER_ATTICUS_COMMAND,",
    );
  });
});
