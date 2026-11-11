import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Extractor } from "@maycombhq/sdk";

/**
 * Beta.26 safety stop (atticus scan, Set up › Scans): a scan replaces the whole of
 * catalog/generated, so it writes only when it has read every production repo in full. A repo
 * not cloned, a clone that can't be read, a failed reader run or a repo --repos left out writes
 * nothing, names each repo and why, and exits 1; so does a scan that found no records where the
 * catalog has some. A scan that read everything writes exactly what it did before. Invented
 * Forge estate (CLAUDE.md rule 3).
 */

// A reader that fails on one repo, for the failed-run case: the scanner's own extractors option,
// passed through scanEstate as the app or a plugin set would (the runner marks the run failed).
const failing = vi.hoisted(() => ({ on: undefined as string | undefined }));
vi.mock("@maycombhq/scanner", async (orig) => {
  const real = await orig<typeof import("@maycombhq/scanner")>();
  const boom: Extractor = {
    id: "northwind-reader",
    version: "1.0.0",
    claims: ["**/*"],
    // eslint-disable-next-line require-yield
    async *scan(repo) {
      if (repo.name === failing.on) throw new Error("the reader stopped on a file it can't parse");
    },
  };
  return {
    ...real,
    scanEstate: (o: Parameters<typeof real.scanEstate>[0]) =>
      real.scanEstate(failing.on ? { ...o, extractors: [...(o.extractors ?? []), boom] } : o),
  };
});

const { main } = await import("../src/main.js");
const { scanRefusal } = await import("../src/scan-commands.js");
const { diffCatalogs, readCatalog, scanEstate } = await import("@maycombhq/scanner");

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const T = 180_000;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

function git(cwd: string, ...args: string[]) {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, stdio: "pipe" },
  );
}

/** The temporary metarepos made here, removed when the file is done. */
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

/** The Forge fixture, each repo committed as a base clone, scanned once so the catalog has records. */
async function scannedForge(): Promise<string> {
  const top = await mkdtemp(join(tmpdir(), "atticus-scan-stop-"));
  made.push(top);
  await cp(FORGE, top, { recursive: true });
  const root = join(top, "metarepo");
  for (const id of await readdir(join(top, "repos"))) {
    const dir = join(root, "workspace", id);
    await cp(join(top, "repos", id), dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
  }
  const c = capture();
  expect(await main(["scan", "--root", root, "--no-drift"], c.io), c.err.join("\n")).toBe(0);
  return root;
}

/** Every file under a folder, by its path, with its bytes: what "nothing written" is checked on. */
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const generated = (root: string) => join(root, "catalog", "generated");

interface Refused {
  repos: { repo: string; why: string; message: string; runs?: { extractor: string }[] }[];
  empty?: { before: number };
  message: string;
}

describe("atticus scan writes nothing unless every production repo was read in full (beta.26)", () => {
  it(
    "a repo not cloned: nothing written, the repo named with how to clone it, exit 1",
    async () => {
      const root = await scannedForge();
      const before = files(generated(root));
      expect(Object.keys(before).length).toBeGreaterThan(20);
      await rm(join(root, "workspace", "forge-ledger"), { recursive: true });
      const c = capture();
      expect(await main(["scan", "--root", root, "--no-drift"], c.io)).toBe(1);
      expect(files(generated(root))).toEqual(before);
      const said = c.err.join("\n");
      expect(said).toMatch(/Nothing written: catalog\/generated is as it was/);
      expect(said).toMatch(/forge-ledger: not cloned here; clone it with atticus workspace sync/);
      expect(c.out.join("\n")).not.toMatch(/^- /m);
    },
    T,
  );

  it(
    "--json says it under refused, machine-readable, and written is false",
    async () => {
      const root = await scannedForge();
      const before = files(generated(root));
      await rm(join(root, "workspace", "forge-ledger"), { recursive: true });
      const c = capture();
      expect(await main(["scan", "--root", root, "--no-drift", "--json"], c.io)).toBe(1);
      const report = JSON.parse(c.out.join("\n")) as {
        written: boolean;
        files: unknown;
        refused: Refused;
        diff: { removed: unknown[] };
      };
      expect(report.written).toBe(false);
      expect(report.files).toBeNull();
      expect(report.refused.repos).toEqual([
        {
          repo: "forge-ledger",
          why: "not-cloned",
          message: "not cloned here; clone it with atticus workspace sync",
        },
      ]);
      expect(report.refused.message).toMatch(/Nothing written/);
      // Nothing changed, so the report shows no change.
      expect(report.diff.removed).toEqual([]);
      expect(files(generated(root))).toEqual(before);
    },
    T,
  );

  it(
    "a clone that can't be read: nothing written, said with what reading it said",
    async () => {
      const root = await scannedForge();
      const before = files(generated(root));
      await rm(join(root, "workspace", "forge-events", ".git"), { recursive: true });
      const c = capture();
      expect(await main(["scan", "--root", root, "--no-drift", "--json"], c.io)).toBe(1);
      const report = JSON.parse(c.out.join("\n")) as { refused: Refused };
      expect(report.refused.repos.map((r) => [r.repo, r.why])).toEqual([
        ["forge-events", "unreadable"],
      ]);
      expect(report.refused.repos[0]!.message).toMatch(
        /^its clone can't be read \(.+\); clone it again with atticus workspace sync$/,
      );
      expect(files(generated(root))).toEqual(before);
    },
    T,
  );

  it(
    "a failed reader run: nothing written, the extractor named",
    async () => {
      const root = await scannedForge();
      const before = files(generated(root));
      failing.on = "forge-portal-bff";
      try {
        const c = capture();
        expect(await main(["scan", "--root", root, "--no-drift", "--full"], c.io)).toBe(1);
        expect(files(generated(root))).toEqual(before);
        expect(c.err.join("\n")).toMatch(
          /forge-portal-bff: the run of northwind-reader failed \(the reader stopped on a file it can't parse\)/,
        );
        const j = capture();
        expect(await main(["scan", "--root", root, "--no-drift", "--json"], j.io)).toBe(1);
        const report = JSON.parse(j.out.join("\n")) as { refused: Refused };
        expect(report.refused.repos).toMatchObject([
          {
            repo: "forge-portal-bff",
            why: "run-failed",
            runs: [{ extractor: "northwind-reader" }],
          },
        ]);
      } finally {
        failing.on = undefined;
      }
      expect(files(generated(root))).toEqual(before);
    },
    T,
  );

  it(
    "--repos never writes the shared catalog: it says a scan of some repos would replace it",
    async () => {
      const root = await scannedForge();
      const before = files(generated(root));
      const c = capture();
      expect(
        await main(["scan", "--root", root, "--no-drift", "--repos", "forge-ledger"], c.io),
      ).toBe(1);
      expect(files(generated(root))).toEqual(before);
      const said = c.err.join("\n");
      expect(said).toMatch(/left out by --repos/);
      expect(said).toMatch(/forge-portal-ui/);
      expect(said).toMatch(
        /a scan of only some repos would replace the catalog with them alone, so it isn't written/,
      );
      expect(said).toMatch(/atticus verify <repo> --write/);
      const j = capture();
      expect(
        await main(
          ["scan", "--root", root, "--no-drift", "--json", "--repos", "forge-ledger,forge-events"],
          j.io,
        ),
      ).toBe(1);
      const report = JSON.parse(j.out.join("\n")) as { refused: Refused };
      expect(report.refused.repos.every((r) => r.why === "not-asked")).toBe(true);
      expect(report.refused.repos.map((r) => r.repo)).not.toContain("forge-ledger");
      expect(report.refused.repos.length).toBe(5);
    },
    T,
  );

  it(
    "an archived repo or a prototype never holds a scan back",
    async () => {
      const root = await scannedForge();
      const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
      const text = await readFile(manifest, "utf8");
      await writeFile(
        manifest,
        text.replace("  - id: forge-ledger\n", "  - id: forge-ledger\n    archived: true\n"),
      );
      await rm(join(root, "workspace", "forge-ledger"), { recursive: true });
      const c = capture();
      expect(await main(["scan", "--root", root, "--no-drift"], c.io), c.err.join("\n")).toBe(0);
      expect(c.out.join("\n")).toMatch(/catalog\/generated: \d+ written/);
    },
    T,
  );

  it(
    "everything cloned and read writes exactly what the scan merges, as before",
    async () => {
      const root = await scannedForge();
      const written = await readCatalog(generated(root));
      expect(written.problems).toEqual([]);
      const scan = await scanEstate({ root, cache: null });
      expect(scan.unread).toEqual([]);
      expect(scan.problems).toEqual([]);
      // Field for field (evidence differs only by when each scan ran).
      const d = diffCatalogs(written.records, scan.records);
      expect({ ...d, evidenceOnly: [] }).toEqual({
        added: [],
        removed: [],
        changed: [],
        evidenceOnly: [],
      });
      expect(written.records.length).toBe(scan.records.length);
      // A rescan of an unchanged estate writes nothing new.
      const c = capture();
      expect(await main(["scan", "--root", root, "--no-drift"], c.io)).toBe(0);
      expect(c.out.join("\n")).toMatch(/No catalog changes/);
    },
    T,
  );

  it(
    "a scan that found no records in code where the catalog has some writes nothing",
    async () => {
      const root = await scannedForge();
      const before = files(generated(root));
      const fromCode = (await readCatalog(generated(root))).records.filter((r) =>
        r.evidence.some((e) => !!e.repo),
      ).length;
      expect(fromCode).toBeGreaterThan(20);
      // Every repo archived: nothing is left to read, and only the profile's systems are found.
      const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
      const text = await readFile(manifest, "utf8");
      await writeFile(
        manifest,
        text.replace(/^ {2}- id: (.+)$/gm, "  - id: $1\n    archived: true"),
      );
      const j = capture();
      expect(await main(["scan", "--root", root, "--no-drift", "--json"], j.io)).toBe(1);
      const report = JSON.parse(j.out.join("\n")) as { refused: Refused; written: boolean };
      expect(report.written).toBe(false);
      expect(report.refused.repos).toEqual([]);
      expect(report.refused.empty?.before).toBe(fromCode);
      expect(report.refused.message).toMatch(/found no records in any repo's code/);
      expect(files(generated(root))).toEqual(before);
    },
    T,
  );

  it("refuses a scan of zero records over a catalog that has some, and allows one over none", () => {
    expect(scanRefusal({ unread: [], records: [] }, [])).toBeUndefined();
    const had = [
      {
        kind: "Component",
        id: "ledger-api",
        evidence: [{ repo: "forge-ledger", path: "pom.xml" }],
      },
    ] as unknown as Parameters<typeof scanRefusal>[1];
    expect(scanRefusal({ unread: [], records: [] }, had)).toMatchObject({
      repos: [],
      empty: { before: 1 },
    });
    expect(scanRefusal({ unread: [], records: [...had] }, had)).toBeUndefined();
  });
});
