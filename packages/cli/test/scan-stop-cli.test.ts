import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Extractor } from "@maycombhq/sdk";

/**
 * ADR 0195 (CS2) lifts beta.26's all-or-nothing stop: a scan writes the readers slot of each
 * repo it read in full and builds the catalog from every slot; a repo not cloned, a clone that
 * can't be read, a failed reader run or a repo --repos left out keeps its last good read, and the
 * scan says which and why (exit 1 for the problem). A scan that read no repo in full still writes
 * nothing (the stop, kept as a guard), and a build with no record from code over a catalog with
 * some is refused. Invented Forge estate (CLAUDE.md rule 3).
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
const { diffCatalogs, readCatalog, scanEstate, readersSlotPath } =
  await import("@maycombhq/scanner");

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
const sources = (root: string) => join(root, "catalog", "sources");

/** The record files whose evidence names only this repo: what its last good read keeps. */
const own = (root: string, repo: string) =>
  Object.fromEntries(
    Object.entries(files(generated(root))).filter(
      ([, t]) =>
        t.includes(`repo: ${repo}\n`) &&
        !/repo: (?!REPO)\S+\n/.test(t.replaceAll(`repo: ${repo}\n`, "repo: REPO\n")),
    ),
  );

interface Source {
  repo: string;
  source: string;
  slot: string;
  reason?: string;
  detail?: string;
}

describe("atticus scan keeps each repo's last good read (ADR 0195 point 1, CS2)", () => {
  it(
    "a repo not cloned keeps its readers slot and its records; the others are read and written; said, exit 1",
    async () => {
      const root = await scannedForge();
      const slot = readFileSync(readersSlotPath(root, "forge-ledger"), "utf8");
      const ledger = own(root, "forge-ledger");
      expect(Object.keys(ledger).length).toBeGreaterThan(3);
      await rm(join(root, "workspace", "forge-ledger"), { recursive: true });
      const c = capture();
      expect(await main(["scan", "--root", root, "--no-drift", "--json"], c.io)).toBe(1);
      const report = JSON.parse(c.out.join("\n")) as { written: boolean; sources: Source[] };
      expect(report.written).toBe(true);
      expect(report.sources.find((s) => s.repo === "forge-ledger")).toMatchObject({
        source: "readers",
        slot: "kept-last-good",
        reason: "not-cloned",
      });
      expect(readFileSync(readersSlotPath(root, "forge-ledger"), "utf8")).toBe(slot);
      expect(own(root, "forge-ledger")).toEqual(ledger);
      const t = capture();
      await rm(join(root, "workspace", "forge-events"), { recursive: true, force: true });
      expect(await main(["scan", "--root", root, "--no-drift"], t.io)).toBe(1);
      expect(t.out.join("\n")).toMatch(
        /forge-ledger: its readers slot keeps its last good read \(commit [0-9a-f]{7}\): it isn't cloned here/,
      );
    },
    T,
  );

  it(
    "a clone that can't be read, or a failed reader run, keeps the repo's last good read",
    async () => {
      const root = await scannedForge();
      const events = readFileSync(readersSlotPath(root, "forge-events"), "utf8");
      const bff = readFileSync(readersSlotPath(root, "forge-portal-bff"), "utf8");
      await rm(join(root, "workspace", "forge-events", ".git"), { recursive: true });
      failing.on = "forge-portal-bff";
      try {
        const c = capture();
        expect(await main(["scan", "--root", root, "--no-drift", "--json", "--full"], c.io)).toBe(
          1,
        );
        const report = JSON.parse(c.out.join("\n")) as { sources: Source[]; refused?: unknown };
        expect(report.refused).toBeUndefined();
        const of = (r: string) => report.sources.find((s) => s.repo === r);
        expect(of("forge-events")).toMatchObject({ slot: "kept-last-good", reason: "unreadable" });
        expect(of("forge-portal-bff")).toMatchObject({
          slot: "kept-last-good",
          reason: "run-failed",
          detail: "northwind-reader",
        });
      } finally {
        failing.on = undefined;
      }
      expect(readFileSync(readersSlotPath(root, "forge-events"), "utf8")).toBe(events);
      expect(readFileSync(readersSlotPath(root, "forge-portal-bff"), "utf8")).toBe(bff);
    },
    T,
  );

  it(
    "--repos reads those repos; every other repo keeps its last good read",
    async () => {
      const root = await scannedForge();
      const before = files(sources(root));
      const others = own(root, "forge-portal-ui");
      const c = capture();
      expect(
        await main(
          ["scan", "--root", root, "--no-drift", "--json", "--repos", "forge-ledger"],
          c.io,
        ),
      ).toBe(0);
      const report = JSON.parse(c.out.join("\n")) as { written: boolean; sources: Source[] };
      expect(report.written).toBe(true);
      expect(report.sources.find((s) => s.repo === "forge-portal-ui")).toMatchObject({
        slot: "kept-last-good",
        reason: "not-asked",
      });
      expect(report.sources.find((s) => s.repo === "forge-ledger")?.slot).toBe("unchanged");
      expect(files(sources(root))).toEqual(before);
      expect(own(root, "forge-portal-ui")).toEqual(others);
    },
    T,
  );

  it(
    "a scan that read no repo in full writes nothing: no slot and no build (beta.26's stop, as a guard)",
    async () => {
      const root = await scannedForge();
      const before = { g: files(generated(root)), s: files(sources(root)) };
      for (const id of await readdir(join(root, "workspace")))
        await rm(join(root, "workspace", id), { recursive: true });
      const c = capture();
      expect(await main(["scan", "--root", root, "--no-drift", "--json"], c.io)).toBe(1);
      const report = JSON.parse(c.out.join("\n")) as {
        written: boolean;
        refused: { reasons: string[]; repos: { repo: string; why: string }[]; message: string };
      };
      expect(report.written).toBe(false);
      expect(report.refused.reasons).toEqual(["nothing-read"]);
      expect(report.refused.repos.every((r) => r.why === "not-cloned")).toBe(true);
      expect(report.refused.message).toMatch(/read no repo in full/);
      expect({ g: files(generated(root)), s: files(sources(root)) }).toEqual(before);
    },
    T,
  );

  it(
    "archiving a repo removes its records only once the removals are confirmed with their count",
    async () => {
      const root = await scannedForge();
      const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
      const text = await readFile(manifest, "utf8");
      await writeFile(
        manifest,
        text.replace("  - id: forge-ledger\n", "  - id: forge-ledger\n    archived: true\n"),
      );
      const before = files(generated(root));
      const c = capture();
      expect(await main(["scan", "--root", root, "--no-drift", "--json"], c.io)).toBe(1);
      const report = JSON.parse(c.out.join("\n")) as {
        refused: { reasons: string[]; allowRemovals: number };
      };
      expect(report.refused.reasons).toEqual(["large-removals"]);
      expect(files(generated(root))).toEqual(before);
      const n = report.refused.allowRemovals;
      const wrong = capture();
      expect(
        await main(
          ["scan", "--root", root, "--no-drift", "--allow-removals", String(n + 1)],
          wrong.io,
        ),
      ).toBe(1);
      expect(files(generated(root))).toEqual(before);
      const ok = capture();
      expect(
        await main(["scan", "--root", root, "--no-drift", "--allow-removals", String(n)], ok.io),
        ok.err.join("\n"),
      ).toBe(0);
      expect(ok.out.join("\n")).toMatch(new RegExp(`Removed ${n} records`));
      expect(Object.keys(own(root, "forge-ledger"))).toEqual([]);
      expect(existsSync(readersSlotPath(root, "forge-ledger"))).toBe(true);
    },
    T,
  );

  it(
    "everything cloned and read writes exactly what the scan merges, and a rescan writes nothing new",
    async () => {
      const root = await scannedForge();
      const written = await readCatalog(generated(root));
      expect(written.problems).toEqual([]);
      const scan = await scanEstate({ root, cache: null });
      expect(scan.unread).toEqual([]);
      expect(scan.problems).toEqual([]);
      const d = diffCatalogs(written.records, scan.records);
      expect(d).toEqual({ added: [], removed: [], changed: [], evidenceOnly: [] });
      const before = { g: files(generated(root)), s: files(sources(root)) };
      const c = capture();
      expect(await main(["scan", "--root", root, "--no-drift", "--full"], c.io)).toBe(0);
      expect(c.out.join("\n")).toMatch(/No catalog changes/);
      // The same commits read again, without the cache, write the same bytes (no time in a slot).
      expect({ g: files(generated(root)), s: files(sources(root)) }).toEqual(before);
    },
    T,
  );

  it(
    "a build with no record from any repo's code over a catalog that has some is refused, confirmed or not",
    async () => {
      const root = await scannedForge();
      const before = files(generated(root));
      const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
      const text = await readFile(manifest, "utf8");
      await writeFile(
        manifest,
        text.replace(/^ {2}- id: (.+)$/gm, "  - id: $1\n    archived: true"),
      );
      const j = capture();
      expect(await main(["catalog", "build", "--root", root, "--json"], j.io)).toBe(1);
      const report = JSON.parse(j.out.join("\n")) as {
        refused: { reasons: string[]; allowRemovals: number };
      };
      expect(report.refused.reasons).toContain("empty");
      const again = capture();
      expect(
        await main(
          [
            "catalog",
            "build",
            "--root",
            root,
            "--allow-removals",
            String(report.refused.allowRemovals),
          ],
          again.io,
        ),
      ).toBe(1);
      expect(again.err.join("\n")).toMatch(/no record from any repo's code/);
      expect(files(generated(root))).toEqual(before);
    },
    T,
  );

  it("scanRefusal refuses only a scan that read no repo in full", () => {
    const full = { repo: "a", full: true } as never;
    const none = { repo: "b", full: false, why: "not-cloned" } as never;
    expect(scanRefusal({ unread: [], observations: [] })).toBeUndefined();
    expect(scanRefusal({ unread: [], observations: [full, none] })).toBeUndefined();
    expect(
      scanRefusal({ unread: [{ repo: "b", why: "not-cloned" }], observations: [none] }),
    ).toMatchObject({ reasons: ["nothing-read"], repos: [{ repo: "b", why: "not-cloned" }] });
  });
});
