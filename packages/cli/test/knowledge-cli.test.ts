import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import {
  coverageCommand,
  patternsScan,
  questionsCommand,
  sourcesAdd,
  sourcesSync,
} from "../src/knowledge-commands.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

/**
 * A copy of the Forge layout: <tmp>/metarepo (org pack and the expected catalog as files) and
 * <tmp>/inputs/wiki, which sources.yaml names as ../../inputs/wiki from the org-pack folder.
 */
async function forgeRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "atticus-cli-know-"));
  const root = join(base, "metarepo");
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FORGE, "inputs/wiki"), join(base, "inputs/wiki"), { recursive: true });
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  return root;
}

describe("atticus sources add", () => {
  it("validates a folder and prints the sources.yaml lines to add, without touching the org pack", async () => {
    const root = await forgeRoot();
    const before = readFileSync(join(root, "org-pack/sources.yaml"), "utf8");
    await mkdir(join(root, "docs/runbooks"), { recursive: true });
    const c = capture();
    expect(await sourcesAdd(root, "markdown-folder", "docs/runbooks", c.io)).toBe(0);
    expect(c.out).toEqual([
      "Add this under wikis: in org-pack/sources.yaml through a pull request (or run this again with --save):",
      '  - { id: runbooks, type: markdown-folder, location: "../docs/runbooks" }',
    ]);
    expect(readFileSync(join(root, "org-pack/sources.yaml"), "utf8")).toBe(before);
  });

  it("refuses a missing folder, a wiki already listed, a bad URL and an unknown kind", async () => {
    const root = await forgeRoot();
    const missing = capture();
    expect(await sourcesAdd(root, "markdown-folder", "no/such/folder", missing.io)).toBe(1);
    expect(missing.err.join("\n")).toMatch(/Can't find the folder no\/such\/folder/);

    const dup = capture();
    expect(await sourcesAdd(root, "markdown-folder", "../inputs/wiki", dup.io)).toBe(1);
    expect(dup.err.join("\n")).toMatch(/already in sources\.yaml as forge-wiki/);

    const url = capture();
    expect(await sourcesAdd(root, "confluence", "not a url", url.io)).toBe(1);
    expect(url.err.join("\n")).toMatch(/A confluence wiki needs an https:\/\/ address/);

    const kind = capture();
    expect(await sourcesAdd(root, "notion", "x", kind.io)).toBe(2);
    expect(kind.err.join("\n")).toMatch(/Unknown wiki type notion/);
  });

  it("accepts an API wiki address and names it after the host", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(
      await sourcesAdd(root, "confluence", "https://wiki.example.test/spaces/ARCH", c.io),
    ).toBe(0);
    expect(c.out[1]).toBe(
      '  - { id: wiki-example-test, type: confluence, location: "https://wiki.example.test/spaces/ARCH" }',
    );
  });
});

describe("atticus sources sync", () => {
  it("reads the wiki, shows the conflicts with code and the facts waiting for an owner, and exits 1", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await sourcesSync(root, c.io, {})).toBe(1);
    const text = c.out.join("\n");
    expect(text).toMatch(/forge-wiki: 3 pages read, 0 skipped/);
    expect(text).toMatch(/2 conflicts with code \(code wins; each goes to triage\):/);
    expect(text).toMatch(
      /\.\.\/inputs\/wiki\/ledger-solution-spec\.md:6 "Payments to Northwind Pay go out through the gateway": interface if-e7344c9455608119 is via direct/,
    );
    expect(text).toMatch(/2 facts only the wiki states, waiting for an owner to confirm:/);
    expect(text).toMatch(
      /ledger: SLO 99\.9% monthly availability \(\.\.\/inputs\/wiki\/ledger-solution-spec\.md:9\)/,
    );
    // Read-only: nothing was written to the wiki or the catalog.
    expect((await readdir(join(root, "..", "inputs/wiki"))).sort()).toEqual([
      "integration-patterns.md",
      "ledger-solution-spec.md",
      "snow-firewall-request.md",
    ]);
  });

  it("prints JSON", async () => {
    const root = await forgeRoot();
    const c = capture();
    await sourcesSync(root, c.io, { json: true });
    const res = JSON.parse(c.out.join("\n")) as {
      pages: { path: string }[];
      documents: { id: string }[];
      documentConflicts: unknown[];
      documentOnlyFacts: unknown[];
    };
    expect(res.pages).toHaveLength(3);
    expect(res.documents.map((d) => d.id)).toContain("doc.forge-wiki.ledger-solution-spec");
    expect(res.documentConflicts).toHaveLength(2);
    expect(res.documentOnlyFacts).toHaveLength(2);
  });

  it("exits 2 when no wiki is configured", async () => {
    const root = await forgeRoot();
    await writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 1\n");
    const c = capture();
    expect(await sourcesSync(root, c.io, {})).toBe(2);
    expect(c.err.join("\n")).toMatch(/No wikis in org-pack\/sources\.yaml/);
  });
});

describe("atticus patterns scan", () => {
  it("finds the five pattern codes and agrees with the org pack", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await patternsScan(root, c.io, {})).toBe(0);
    expect(c.out).toEqual([
      "../inputs/wiki/integration-patterns.md: S.GW.SOR, S.GW.VND, S.DIR.BFF, A.EB.PUB, D.JDBC",
      "The org pack matches the wiki: 5 patterns.",
    ]);
  });

  it("reports a pattern the org pack lacks, and exits 1", async () => {
    const root = await forgeRoot();
    const page = join(root, "..", "inputs/wiki/integration-patterns.md");
    await writeFile(
      page,
      `${readFileSync(page, "utf8")}| F.SFTP.VND | File transfer over SFTP to a vendor | async | PGP-encrypted files |\n`,
    );
    const c = capture();
    expect(await patternsScan(root, c.io, { json: true })).toBe(1);
    const res = JSON.parse(c.out.join("\n")) as { diff: { new: { code: string }[] } };
    expect(res.diff.new.map((d) => d.code)).toEqual(["F.SFTP.VND"]);
  });
});

describe("atticus coverage and atticus questions", () => {
  it("shows coverage per system and area", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await coverageCommand(root, c.io, {})).toBe(0);
    const text = c.out.join("\n");
    expect(text).toMatch(/ledger\s+4\s+1\s+2\s+1/);
    expect(text).toMatch(/obligations\s+0\s+1\s+4/);

    const j = capture();
    await coverageCommand(root, j.io, { json: true });
    const res = JSON.parse(j.out.join("\n")) as {
      api: { systems: { system: string; known: number }[] };
    };
    expect(res.api.systems.find((s) => s.system === "ledger")!.known).toBe(4);
  });

  it("lists the owner questions for the knowledge gaps (d09-d11), and exits 1", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await questionsCommand(root, c.io, {})).toBe(1);
    const text = c.out.join("\n");
    expect(text).toMatch(
      /q\.call-resilience-known\.if-e7344c9455608119 → team-ledger \(ado, sent\)/,
    );
    expect(text).toMatch(/q\.unattended-workload-monitored\.reports-job → team-reports/);
    expect(text).toMatch(/q\.component-source-known\.audit-svc → team-platform/);
    expect(text).toMatch(
      /3 open questions\. Unanswered questions stay unknowns; nothing is guessed\./,
    );

    const j = capture();
    await questionsCommand(root, j.io, { json: true });
    const res = JSON.parse(j.out.join("\n")) as { questions: { kind: string }[] };
    expect(res.questions.map((q) => q.kind)).toEqual([
      "OwnerQuestion",
      "OwnerQuestion",
      "OwnerQuestion",
    ]);
  });
});

describe("knowledge commands through main", () => {
  it("answers usage errors and unknown subcommands with exit 2", async () => {
    const { main } = await import("../src/main.js");
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    expect(await main(["sources", "add"], io)).toBe(2);
    expect(err.join("\n")).toMatch(/sources add needs a type and a location/);
    expect(await main(["--help"], io)).toBe(0);
    expect(out.join("\n")).toMatch(/atticus patterns scan/);
  });
});
