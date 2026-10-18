import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { writeChangeRepos } from "@maycombhq/workspace";
import {
  ciArchiveGate,
  ciDrift,
  ciSnippet,
  glossaryAlias,
  glossaryDefine,
  glossaryLink,
  glossaryList,
  glossaryScan,
  testsGenerate,
  traceCommand,
} from "../src/quality-commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FORGE_CHANGE = join(HERE, "../../../fixtures/forge-change");
const TESTGEN = join(HERE, "../../testgen/test/fixtures");
const CHANGE = "add-transfer-limit";
const now = () => new Date("2026-10-21T09:00:00Z");

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

/** Forge laid out as fixtures/forge (metarepo/ beside repos/), with the forge change and its planned stories. */
async function root(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "atticus-quality-cli-"));
  const r = join(base, "metarepo");
  await cp(join(FORGE, "repos"), join(base, "repos"), { recursive: true });
  await cp(join(FORGE, "metarepo/org-pack"), join(r, "org-pack"), { recursive: true });
  await cp(join(FORGE_CHANGE, "org-pack"), join(r, "org-pack"), { recursive: true });
  await writeFile(
    join(r, "org-pack/sources.yaml"),
    "schemaVersion: 1\nwikis:\n  - { id: forge-wiki, type: markdown-folder, location: ../inputs/wiki }\n",
  );
  for (const row of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...row });
    if (!p.ok) throw new Error("bad record");
    const f = join(r, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  const dir = join(r, "openspec/changes", CHANGE);
  await cp(join(FORGE_CHANGE, "openspec/changes", CHANGE), dir, { recursive: true });
  await rm(join(dir, "stories"), { recursive: true });
  await cp(join(TESTGEN, "change"), dir, { recursive: true });
  await cp(join(FORGE, "inputs"), join(r, "inputs"), { recursive: true });
  const wt = join(r, "workspace/.worktrees", CHANGE, "forge-ledger");
  await cp(join(FORGE, "repos/forge-ledger"), wt, { recursive: true });
  await cp(join(TESTGEN, "worktree/forge-ledger"), wt, { recursive: true });
  await writeChangeRepos(r, {
    schemaVersion: 1,
    change: CHANGE,
    repos: [
      {
        id: "forge-ledger",
        branch: `change/${CHANGE}`,
        base: "main",
        worktree: `workspace/.worktrees/${CHANGE}/forge-ledger`,
        build: { status: "not-run" },
      },
    ],
  });
  return r;
}

describe("atticus tests generate and trace", () => {
  it("generates a story's tests and says where they went", async () => {
    const r = await root();
    const c = io();
    expect(await testsGenerate(r, CHANGE, "s2-remaining-limit", {}, c.io, { now })).toBe(0);
    expect(c.out[0]).toBe(
      "Generated 9 test cases for s2-remaining-limit in 6 files: 6 new, 0 updated, 0 unchanged.",
    );
    expect(c.out[1]).toBe("ACTION   REPO              FRAMEWORK           FILE");
    expect(c.out.some((l) => l.endsWith("S2RemainingLimitApiTest.java"))).toBe(true);
    expect(c.out.at(-1)).toBe(
      "Manifest: openspec/changes/add-transfer-limit/tests/s2-remaining-limit/manifest.yaml",
    );
    const again = io();
    expect(
      await testsGenerate(r, CHANGE, "s2-remaining-limit", { json: true }, again.io, { now }),
    ).toBe(0);
    const j = JSON.parse(again.out.join("\n")) as { files: { action: string }[]; names: string };
    expect(new Set(j.files.map((f) => f.action))).toEqual(new Set(["unchanged"]));
    expect(j.names).toBe("fallback");
  });

  it("refuses bad input with exit 2 and an unknown story with exit 1", async () => {
    const r = await root();
    const c = io();
    expect(await testsGenerate(r, CHANGE, undefined, {}, c.io)).toBe(2);
    expect(await testsGenerate(r, CHANGE, "s2-remaining-limit", { framework: "mocha" }, c.io)).toBe(
      2,
    );
    expect(c.err.at(-1)).toMatch(/^There is no test framework mocha/);
    expect(await testsGenerate(r, CHANGE, "s9-nope", {}, c.io)).toBe(1);
    expect(c.err.at(-1)).toMatch(/has no story s9-nope/);
  });

  it("prints the matrix, writes trace findings and exits 1 on blocking gaps", async () => {
    const r = await root();
    for (const s of [
      "s1-daily-transfer-limit",
      "s2-remaining-limit",
      "s3-northwind-pay-velocity-checks",
    ])
      await testsGenerate(r, CHANGE, s, {}, io().io, { now });
    const c = io();
    expect(await traceCommand(r, CHANGE, {}, c.io, { now })).toBe(1);
    expect(c.out[0]).toBe("# Traceability: add-transfer-limit");
    expect(c.out.at(-1)).toBe("Wrote 4 findings to review/trace/1/.");
    const csv = io();
    await traceCommand(r, CHANGE, { csv: true, write: false }, csv.io, { now });
    expect(csv.out[0]).toBe("requirement,scenario,story,criterion,tests,code,records,features");
    const json = io();
    await traceCommand(r, CHANGE, { json: true }, json.io, { now });
    const m = JSON.parse(json.out.join("\n")) as { gaps: unknown[]; round: number };
    expect(m.gaps).toHaveLength(4);
    expect(m.round).toBe(1);
    expect(await traceCommand(r, undefined, {}, io().io)).toBe(2);
  });
});

describe("atticus ci", () => {
  it("drift: a clean repo passes; drift fails, with JSON, JUnit and a summary", async () => {
    const r = await root();
    const repos = join(r, "..", "repos");
    const c = io();
    expect(
      await ciDrift(join(repos, "forge-portal-bff"), { catalog: r }, c.io, {
        commit: "a".repeat(40),
      }),
    ).toBe(0);
    expect(c.out[0]).toBe("## Atticus drift check: forge-portal-bff");
    const work = join(r, "..", "work", "forge-ledger");
    await cp(join(repos, "forge-ledger"), work, { recursive: true });
    await rm(join(work, "src/main/java/forge/ledger/NorthwindClient.java"));
    const out = join(r, "..", "out");
    const d = io();
    expect(
      await ciDrift(
        work,
        {
          catalog: r,
          repo: "forge-ledger",
          json: join(out, "drift.json"),
          junit: join(out, "drift.xml"),
          summary: join(out, "summary.md"),
        },
        d.io,
        { commit: "a".repeat(40) },
      ),
    ).toBe(1);
    expect(d.out[2]).toBe("1 drift finding in forge-ledger.");
    expect(JSON.parse(await readFile(join(out, "drift.json"), "utf8"))).toMatchObject({
      repo: "forge-ledger",
      drift: true,
    });
    expect(await readFile(join(out, "drift.xml"), "utf8")).toContain('type="removed"');
    expect(await readFile(join(out, "summary.md"), "utf8")).toContain(
      "## Atticus drift check: forge-ledger",
    );
    const w = io();
    expect(
      await ciDrift(work, { catalog: r, repo: "forge-ledger", warnOnly: true, json: true }, w.io, {
        commit: "a".repeat(40),
      }),
    ).toBe(0);
    expect(JSON.parse(w.out.join("\n"))).toMatchObject({ mode: "warn", drift: true });
  });

  it("drift: usage and missing folders exit 2", async () => {
    const r = await root();
    const c = io();
    expect(await ciDrift(".", {}, c.io)).toBe(2);
    expect(await ciDrift(join(r, "nope"), { catalog: r }, c.io)).toBe(2);
    expect(c.err.at(-1)).toBe(`There is no folder ${join(r, "nope")} to check.`);
  });

  it("snippet prints or writes a pipeline file, and lists the kinds on a bad one", async () => {
    const c = io();
    expect(await ciSnippet("gitlab", c.io)).toBe(0);
    expect(c.out[0]).toContain("# Generated by Atticus (atticus ci snippet gitlab)");
    const dir = await mkdtemp(join(tmpdir(), "atticus-snippet-"));
    const w = io();
    expect(await ciSnippet("github", w.io, { write: dir })).toBe(0);
    expect(await readFile(join(dir, ".github/workflows/atticus-drift.yml"), "utf8")).toContain(
      "ci drift repo",
    );
    const bad = io();
    expect(await ciSnippet("circle", bad.io)).toBe(2);
    expect(bad.err[0]).toBe(
      "Usage: atticus ci snippet <github|azure|gitlab|jenkins> [--write <repo-dir>]",
    );
  });

  it("archive-gate blocks an unreleased change and can't gate an unknown one", async () => {
    const r = await root();
    const c = io();
    expect(await ciArchiveGate(r, CHANGE, {}, c.io, { commit: "a".repeat(40) })).toBe(1);
    expect(c.out[0]).toBe("add-transfer-limit can't be archived yet (1 blocker):");
    expect(c.out[1]).toBe(
      "- add-transfer-limit is plan; a change is archived once it is released (go/no-go merged).",
    );
    expect(await ciArchiveGate(r, "nope", {}, io().io)).toBe(2);
    expect(await ciArchiveGate(r, undefined, {}, io().io)).toBe(2);
  });
});

describe("atticus glossary", () => {
  it("scans, lists, defines, links and names synonyms", async () => {
    const r = await root();
    const s = io();
    expect(await glossaryScan(r, {}, s.io, { now })).toBe(0);
    expect(s.out[0]).toBe(
      "The glossary has 7 terms; 10 files written and 0 files removed in catalog/generated.",
    );
    const l = io();
    expect(await glossaryList(r, {}, l.io)).toBe(0);
    expect(l.out[0]).toMatch(/^TERM\s+ID\s+FROM\s+FLAGS\s+DEFINITION$/);
    expect(l.out.at(-1)).toBe("7 terms, 0 conflicts.");

    const d = io();
    expect(
      await glossaryDefine(
        r,
        "Transfer",
        "Moving an amount from one account to another.",
        { by: "pat" },
        d.io,
      ),
    ).toBe(0);
    expect(d.out[0]).toBe(
      "Wrote catalog/curated/curateddecision/glossary.define.transfer.yaml: term.transfer is defined and asserted. Commit it so every scan keeps it.",
    );
    const k = io();
    expect(
      await glossaryLink(r, "transfer", "topic.transfers-completed", { by: "pat" }, k.io),
    ).toBe(0);
    expect(await glossaryAlias(r, "account number", ["IBAN"], { by: "bao" }, io().io)).toBe(0);
    const j = io();
    await glossaryList(r, { json: true }, j.io);
    const g = JSON.parse(j.out.join("\n")) as {
      terms: { id: string; confidence: string; definition: string; fields: string[] }[];
      synonyms: Record<string, string[]>;
    };
    expect(g.terms.find((t) => t.id === "term.transfer")).toMatchObject({
      confidence: "asserted",
      definition: "Moving an amount from one account to another.",
      fields: ["topic.transfers-completed"],
    });
    expect(g.synonyms).toEqual({ "term.account-number": ["IBAN"] });
    const bad = io();
    expect(await glossaryLink(r, "nothing", "ledger-db.account", { by: "pat" }, bad.io)).toBe(1);
    expect(bad.err[0]).toBe(
      "There is no term term.nothing. Define it first: atticus glossary define",
    );
    expect(await glossaryDefine(r, "x", "y", {}, io().io)).toBe(2);
  });
});
