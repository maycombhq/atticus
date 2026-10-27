import { cp, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sourcesSync } from "../src/knowledge-commands.js";
import { sourcesEstimate, standardsCli } from "../src/wikis-commands.js";

/**
 * atticus sources estimate and atticus standards propose|accept (ADR 0132), on the invented
 * Forge shop's 12 sources (fixtures/many-wikis).
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/many-wikis");

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-wikis-cli-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await cp(join(FIX, "org-pack/sources.yaml"), join(root, "org-pack/sources.yaml"));
  await cp(join(FIX, "sources"), join(root, "wikis"), { recursive: true });
  return root;
}

describe("atticus sources estimate", () => {
  it("says to sync first, then counts each source's pages, tokens and model calls", async () => {
    const root = await estate();
    const before = io();
    expect(await sourcesEstimate(root, {}, before.io)).toBe(2);
    expect(before.err).toEqual([
      "There is no snapshot yet. Run atticus sources sync first: the estimate reads the snapshots.",
    ]);
    const s = io();
    expect(await sourcesSync(root, s.io, { now: "2026-10-20T08:00:00Z" })).toBeLessThan(2);
    expect(s.out.join("\n")).toMatch(/12 pages new or changed copied/);
    const e = io();
    expect(await sourcesEstimate(root, { batchTokens: 1500 }, e.io)).toBe(0);
    expect(e.out[0]).toMatch(
      /^A knowledge scan would read 32 pages of 32 pages, about [\d,]+ tokens, in \d+ model calls/,
    );
    expect(e.out.join("\n")).toMatch(/ {2}ea-standards: 12 pages to read of 12/);
    expect(e.out.join("\n")).toMatch(/premium request/);
    const one = io();
    expect(await sourcesEstimate(root, { source: "nope" }, one.io)).toBe(2);
    expect(one.err).toEqual(["There is no source nope in org-pack/sources.yaml."]);
  });
});

describe("atticus standards", () => {
  it("proposes nothing until a person confirms a standard, and says how to accept", async () => {
    const root = await estate();
    await sourcesSync(root, io().io, { now: "2026-10-20T08:00:00Z" });
    const p = io();
    expect(await standardsCli(root, "propose", {}, p.io)).toBe(0);
    expect(p.out[0]).toBe("No rule of a confirmed standard waits to be accepted.");
    expect(await readFile(join(root, "proposals/checklists/standards.yaml"), "utf8")).toMatch(
      /proposals: \[\]/,
    );
    const a = io();
    expect(await standardsCli(root, "accept", {}, a.io)).toBe(0);
    expect(a.out[0]).toBe("Added no check to org-pack/checklists/standards.yaml; 0 left proposed.");
    const bad = io();
    expect(await standardsCli(root, "enforce", {}, bad.io)).toBe(2);
  });
});
