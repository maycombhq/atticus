import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";

/** ADR 0106: a knowledge scan in batches that fit one prompt of the model (--batch-tokens). */
describe("atticus knowledge scan --batch-tokens", () => {
  it("takes the room for pages in one prompt, a whole number of 500 or more", async () => {
    const root = await mkdtemp(`${tmpdir()}/atticus-batch-`);
    const err: string[] = [];
    const run = (n: string) =>
      main(
        ["knowledge", "scan", "--batch-tokens", n, "--root", root],
        { out: () => undefined, err: (l) => err.push(l) },
        { quiet: true },
      );
    expect(await run("10")).toBe(2);
    expect(err[0]).toBe(
      "--batch-tokens is a whole number of 500 or more: the room for pages in one prompt.",
    );
    expect(await run("lots")).toBe(2);
  });
});
