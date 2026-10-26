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
    // with no scan settings yet, the whole file is printed, ready to save as it is: the scan
    // settings schema takes it with nothing added
    expect(text).toMatch(/a person saves this as .*scan\/forge-ledger\.yaml in a pull request/);
    const block = text.slice(
      text.indexOf("schemaVersion: 1\n"),
      text.indexOf("\nWith them left out"),
    );
    const parsed = ScanSettings.safeParse(parse(block));
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
    // A-ledger: each part says whether it is read; none is, on a first estimate.
    expect(text).toMatch(/ {2}part 1 \(to read, about \d+ tokens, \d+ files\): accounts\/\*\*, /);
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

  it("plans the parts over the source left with the proposals out, and says so", async () => {
    const root = bigRepo();
    const o = io();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, o.io);
    expect(o.out.join("\n")).toMatch(
      /The parts below are planned over what is left with the 1 proposed folder left out \(\d+ source files, about \d+ tokens\); no part reads a proposed folder\./,
    );
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

/**
 * What a real repo still had after A-big (A-big2): a third-party Python library cloned into
 * REFERENCES/ beside reference texts, and a library's Java source copied into jar/ with its
 * LICENSE and README. The ledger's modules are in its root pom; the Northwind libraries aren't.
 */
function vendoredRepo(): string {
  const root = adoptedRepo();
  const modules = ["accounts", "payments", "reports", "statements"];
  write(
    root,
    "pom.xml",
    `<project>\n  <modules>\n${modules.map((m) => `    <module>${m}</module>`).join("\n")}\n  </modules>\n</project>\n`,
  );
  for (const m of modules) {
    write(root, `${m}/pom.xml`, "<project/>\n");
    for (let c = 0; c < 10; c++)
      write(
        root,
        `${m}/src/main/java/forge/${m}/Part${c}.java`,
        `package forge.${m};\n\npublic class Part${c} {\n${rows(400, (i) => `  private final int value${i} = ${i}; // ${m}`)}}\n`,
      );
  }
  const quill = "REFERENCES/northwind-quill";
  write(root, `${quill}/LICENSE`, "BSD 3-Clause License\n");
  write(root, `${quill}/setup.py`, "from setuptools import setup\n\nsetup(name='nwquill')\n");
  write(root, `${quill}/pyproject.toml`, "[project]\nname = 'nwquill'\n");
  write(root, `${quill}/docs/index.md`, "# nwquill\n");
  write(root, `${quill}/src/nwquill/__init__.py`, "");
  for (let c = 0; c < 20; c++)
    write(
      root,
      `${quill}/src/nwquill/part${c}.py`,
      rows(400, (i) => `def rule_${i}(text):  # quill rule ${c}\n    return text`),
    );
  for (let c = 0; c < 5; c++)
    write(
      root,
      `REFERENCES/chapter${c}.html`,
      `<html><body>\n${rows(300, (i) => `<p>Paragraph ${i} of the Northwind reference, chapter ${c}.</p>`)}</body></html>\n`,
    );
  write(
    root,
    "REFERENCES/notes.txt",
    rows(200, (i) => `note ${i}`),
  );
  write(root, "jar/LICENSE", "Apache License 2.0\n");
  write(root, "jar/README.md", "# Northwind codec\n");
  for (let c = 0; c < 6; c++)
    write(
      root,
      `jar/org/northwind/codec/Codec${c}.java`,
      `package org.northwind.codec;\n\npublic class Codec${c} {\n${rows(400, (i) => `  static final int FRAME_${i} = ${i}; // codec`)}}\n`,
    );
  return root;
}

describe("atticus map <repo> --estimate: vendored projects and text corpora (A-big2)", () => {
  it("proposes the reference folder and the copied library, each with why and its file", async () => {
    const root = vendoredRepo();
    const o = io();
    expect(await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, o.io)).toBe(0);
    const text = o.out.join("\n");
    expect(text).toMatch(
      / {2}REFERENCES\/\*\* \(about \d+ tokens, \d+ files\): documents, not code: 5 \.html files; with 1 vendored project: REFERENCES\/northwind-quill, a project of its own \(LICENSE, pyproject\.toml, setup\.py\) that the repo's build doesn't include as a module/,
    );
    expect(text).toMatch(
      / {2}jar\/\*\* \(about \d+ tokens, 6 files\): its own LICENSE and no build file, and its packages \(org\.northwind\) aren't the repo's own/,
    );
    const block = text.slice(text.indexOf("exclude:\n"), text.indexOf("\nWith them left out"));
    const parsed = ScanSettings.safeParse({ schemaVersion: 1, repo: REPO, ...parse(block) });
    expect(parsed.data?.exclude.map((e) => [e.path, e.at])).toEqual([
      ["REFERENCES/**", "REFERENCES/northwind-quill/LICENSE:1"],
      ["jar/**", "jar/LICENSE:1"],
    ]);
  });

  it("reads the rest in parts of product code only, and says the proposals are left out", async () => {
    const root = vendoredRepo();
    const o = io();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, o.io);
    const text = o.out.join("\n");
    expect(text).toMatch(
      /The parts below are planned over what is left with the 2 proposed folders left out \(\d+ source files, about \d+ tokens\); no part reads a proposed folder\./,
    );
    const parts = o.out.filter((l) => /^ {2}part \d+ /.test(l));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p).not.toMatch(/REFERENCES|jar|nwquill/);
    const j = io();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT, json: true }, j.io);
    const r = JSON.parse(j.out.join("\n"));
    const paths = r.parts.parts.flatMap((p: { paths: string[] }) => p.paths);
    expect(paths.some((p: string) => /REFERENCES|jar/.test(p))).toBe(false);
  });
});
