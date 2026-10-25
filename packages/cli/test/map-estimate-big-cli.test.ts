import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ScanSettings } from "@maycombhq/core";
import type { StepFact } from "../src/commands.js";
import { mapCommand } from "../src/map-commands.js";

/**
 * atticus map <repo> --estimate on a big repo (ADR 0124 addendum A-big): it proposes the folders
 * of data to leave out, with a ready exclude: block it never writes, and the parts to read a repo
 * bigger than one session in. The repo is the Forge ledger with invented research tables, a
 * translation bundle and three more modules beside it. No model, no network.
 */

const fixtures = join(__dirname, "..", "..", "verify", "test", "fixtures");
const REPO = "forge-ledger";
const COMMIT = "0123abc";

function adoptedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-map-big-"));
  cpSync(join(fixtures, "repo"), root, { recursive: true });
  mkdirSync(join(root, ".atticus", "org-pack"), { recursive: true });
  return root;
}
const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const rows = (n: number, line: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => line(i)).join("\n") + "\n";

/** The ledger, plus research tables, a translation bundle, and modules past one session. */
function bigRepo(): string {
  const root = adoptedRepo();
  for (let y = 0; y < 12; y++)
    write(
      root,
      `research/tables/rates-${1990 + y}.json`,
      rows(1_500, (i) => `  { "day": ${i}, "rate": ${(i % 97) / 10} },`),
    );
  write(
    root,
    "web/src/i18n/ui.ml.json",
    rows(5_000, (i) => `  "label${i}": "text ${i}",`),
  );
  for (const m of ["accounts", "payments", "reports", "statements"])
    for (let c = 0; c < 10; c++)
      write(
        root,
        `${m}/src/main/java/forge/${m}/Part${c}.java`,
        `package forge.${m};\n\npublic class Part${c} {\n${rows(400, (i) => `  private final int value${i} = ${i}; // ${m}`)}}\n`,
      );
  return root;
}
const io = () => {
  const out: string[] = [];
  return {
    out,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(`ERR ${l}`),
      report: (_f: StepFact) => {},
    },
  };
};

describe("atticus map <repo> --estimate on a big repo (A-big)", () => {
  it("proposes leaving out the research tables, with tokens before and after, and writes nothing", async () => {
    const root = bigRepo();
    const o = io();
    expect(await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, o.io)).toBe(0);
    const text = o.out.join("\n");
    expect(text).toMatch(/Folders that look like data, documentation or vendored code/);
    expect(text).toMatch(/ {2}research\/\*\* \(about \d+ tokens, 12 files\): data, not code/);
    expect(text).toContain(".atticus/org-pack/scan/forge-ledger.yaml");
    expect(text).toMatch(/With them left out: about \d+ tokens \(now \d+\)/);
    // the block is ready to paste, and the scan settings schema takes it
    const block = text.slice(text.indexOf("exclude:\n"), text.indexOf("\nWith them left out"));
    const parsed = ScanSettings.safeParse({ schemaVersion: 1, repo: REPO, ...parse(block) });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.exclude.map((e) => e.path)).toEqual(["research/**"]);
    // a person accepts it in a pull request: Atticus never writes it
    expect(existsSync(join(root, ".atticus", "org-pack", "scan", `${REPO}.yaml`))).toBe(false);
    // the translation bundle isn't counted at all
    expect(text).not.toContain("i18n");
  });

  it("says to read it in parts when it is more than one session holds, and proposes them", async () => {
    const root = bigRepo();
    const o = io();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, o.io);
    const text = o.out.join("\n");
    expect(text).toMatch(
      /more than one session reads \(150000 tokens\): read it in [2-9] parts, one per session or sub-agent/,
    );
    expect(text).toMatch(/ {2}part 1 \(about \d+ tokens, \d+ files\): accounts\/\*\*, /);
    // the parts are of the read with the exclusions accepted: no part reads the research tables
    expect(text).not.toMatch(/part \d+ .*research/);
  });

  it("gives the proposals and the parts as JSON", async () => {
    const root = bigRepo();
    const j = io();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT, json: true }, j.io);
    const r = JSON.parse(j.out.join("\n"));
    expect(r.proposals.exclude.map((e: { path: string }) => e.path)).toEqual(["research/**"]);
    expect(r.proposals.after).toBeLessThan(r.proposals.before);
    expect(r.parts.session).toBe(150_000);
    expect(r.parts.parts.length).toBeGreaterThan(1);
    for (const p of r.parts.parts) expect(p.tokens).toBeLessThanOrEqual(150_000);
  });

  it("takes a bigger model's limit as a bigger session", async () => {
    const root = bigRepo();
    const j = io();
    await mapCommand(
      root,
      REPO,
      { estimate: true, commit: COMMIT, json: true, maxTokens: 1_000_000 },
      j.io,
    );
    const r = JSON.parse(j.out.join("\n"));
    expect(r.parts).toEqual({ session: 750_000, parts: [] });
  });

  it("proposes nothing and no parts for a small repo of code", async () => {
    const root = adoptedRepo();
    const o = io();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, o.io);
    const text = o.out.join("\n");
    expect(text).not.toContain("Folders that look like data");
    expect(text).not.toContain("in parts");
  });
});
