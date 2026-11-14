import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseFacts, serializeFacts, withSignal } from "@maycombhq/core";
import type { Extractor } from "@maycombhq/sdk";

/**
 * ADR 0195, ticket CS1: the slot writers, beside the catalog as it is written today. A scan
 * writes catalog/sources/readers/<repo>.json for each repo it read in full; `verify <repo>
 * --write` writes catalog/sources/facts/<repo>.jsonl and its meta only when it succeeds. A run
 * that didn't observe a repo (not cloned, outside --repos, a reader throws, a timeout, a refused
 * plugin, a cancel) leaves its slot byte for byte as it was, the scan never writes a facts slot,
 * and catalog/generated is exactly what it was before slots. Invented Forge estate (rule 3).
 */

// A reader that fails on one repo, or cancels the scan when it reaches one (the app's Stop).
const steer = vi.hoisted(() => ({
  failOn: undefined as string | undefined,
  cancelOn: undefined as string | undefined,
  abort: undefined as (() => void) | undefined,
}));
vi.mock("@maycombhq/scanner", async (orig) => {
  const real = await orig<typeof import("@maycombhq/scanner")>();
  const reader: Extractor = {
    id: "northwind-reader",
    version: "1.0.0",
    claims: ["**/*"],
    // eslint-disable-next-line require-yield
    async *scan(repo) {
      if (repo.name === steer.failOn)
        throw new Error("the reader stopped on a file it can't parse");
      if (repo.name === steer.cancelOn) steer.abort?.();
    },
  };
  return {
    ...real,
    scanEstate: (o: Parameters<typeof real.scanEstate>[0]) =>
      real.scanEstate(
        steer.failOn || steer.cancelOn
          ? { ...o, extractors: [...(o.extractors ?? []), reader] }
          : o,
      ),
  };
});

const { main } = await import("../src/main.js");
const { verifyCommand } = await import("../src/verify-commands.js");
const { parseFactsSlotMeta, parseReadersSlot, scanEstate, writeCatalog } =
  await import("@maycombhq/scanner");

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const PLUGINS = join(HERE, "../../../fixtures/scanner-plugins");
const VERIFY = join(HERE, "../../verify/test/fixtures");
const T = 240_000;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
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
  )
    .toString()
    .trim();
}

const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

/** Each repo of a fixture committed as a base clone under workspace/. */
async function clones(reposDir: string, root: string): Promise<void> {
  for (const id of await readdir(reposDir)) {
    const dir = join(root, "workspace", id);
    await cp(join(reposDir, id), dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
  }
}

/** A change committed to a clone, so a read of it would give another slot. */
function commitChange(root: string, repo: string): void {
  const dir = join(root, "workspace", repo);
  writeFileSync(join(dir, "NOTES.md"), "moved on\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "moved on");
}

/** Every file under a folder, by its path, with its bytes. */
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split("\\").join("/")] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const generated = (root: string) => join(root, "catalog", "generated");
const sources = (root: string) => join(root, "catalog", "sources");

let forgeTemplate: string | undefined;
/** The Forge fixture with every repo a base clone, scanned once; a fresh copy each time. */
async function scannedForge(): Promise<string> {
  if (!forgeTemplate) {
    const top = await temp("atticus-slots-forge-");
    await cp(FORGE, top, { recursive: true });
    const root = join(top, "metarepo");
    await clones(join(top, "repos"), root);
    const c = capture();
    expect(await main(["scan", "--root", root, "--no-drift"], c.io), c.err.join("\n")).toBe(0);
    forgeTemplate = top;
  }
  // The whole fixture: the Forge dialect's own tests read ../repos/ beside the metarepo.
  const copy = await temp("atticus-slots-copy-");
  await cp(forgeTemplate, copy, { recursive: true });
  return join(copy, "metarepo");
}

interface ScanJson {
  written: boolean;
  sources: {
    repo: string;
    source: string;
    slot: string;
    commit?: string;
    reason?: string;
    factsStale?: {
      commit: string;
      head: string;
      files: { path: string; facts: string[] }[];
      command: string;
    };
  }[];
}

describe("a scan writes the readers slot of each repo it read in full (ADR 0195 point 1)", () => {
  it(
    "one canonical file per repo at its commit; a rescan of an unchanged estate leaves every byte",
    async () => {
      const root = await scannedForge();
      const slots = files(sources(root));
      const repos = (await readdir(join(FORGE, "repos"))).sort();
      // CS2: the build's manifest beside the slots.
      expect(Object.keys(slots).sort()).toEqual([
        "build.json",
        ...repos.map((r) => `readers/${r}.json`),
      ]);
      for (const r of repos) {
        const p = parseReadersSlot(slots[`readers/${r}.json`]!);
        expect(p.ok).toBe(true);
        if (!p.ok) continue;
        expect(p.slot.commit).toBe(git(join(root, "workspace", r), "rev-parse", "HEAD"));
        expect(p.slot.status).toBe("read");
      }
      // The scan never writes a facts slot.
      expect(existsSync(join(sources(root), "facts"))).toBe(false);
      const c = capture();
      expect(await main(["scan", "--root", root, "--no-drift"], c.io), c.err.join("\n")).toBe(0);
      expect(files(sources(root))).toEqual(slots);
      expect(c.out).toContain(`catalog/sources/readers: 0 written, ${repos.length} unchanged`);
      const j = capture();
      expect(await main(["scan", "--root", root, "--no-drift", "--json"], j.io)).toBe(0);
      const report = JSON.parse(j.out.join("\n")) as ScanJson;
      expect(report.sources.map((s) => [s.repo, s.source, s.slot]).sort()).toEqual(
        repos.map((r) => [r, "readers", "unchanged"]),
      );
    },
    T,
  );

  it(
    "catalog/generated is byte for byte what the scan wrote before slots: the merge, written",
    async () => {
      const root = await scannedForge();
      // The same scan, written the way beta.26 wrote it (from the scan cache, so the same stamps).
      const scan = await scanEstate({ root });
      expect(scan.unread).toEqual([]);
      expect(scan.problems).toEqual([]);
      const asToday = join(await temp("atticus-slots-today-"), "generated");
      await writeCatalog(asToday, scan.records);
      expect(files(generated(root))).toEqual(files(asToday));
      // Slots are never read by this phase's scan: a broken one changes nothing in the catalog.
      await writeFile(join(sources(root), "readers", "forge-ledger.json"), "{ not a slot");
      const c = capture();
      expect(await main(["scan", "--root", root, "--no-drift"], c.io)).toBe(0);
      expect(files(generated(root))).toEqual(files(asToday));
      // And the broken slot is replaced by the full read.
      expect(
        parseReadersSlot(readFileSync(join(sources(root), "readers", "forge-ledger.json"), "utf8"))
          .ok,
      ).toBe(true);
    },
    T,
  );

  it(
    "--dry-run writes no slot",
    async () => {
      const root = await scannedForge();
      const before = files(sources(root));
      commitChange(root, "forge-ledger");
      const c = capture();
      expect(await main(["scan", "--root", root, "--no-drift", "--dry-run"], c.io)).toBe(0);
      expect(files(sources(root))).toEqual(before);
    },
    T,
  );
});

describe("a run that didn't observe a repo leaves its slot byte for byte (ADR 0195 point 1, CS1)", () => {
  it(
    "not cloned",
    async () => {
      const root = await scannedForge();
      const before = files(sources(root));
      commitChange(root, "forge-events");
      await rm(join(root, "workspace", "forge-ledger"), { recursive: true });
      const c = capture();
      expect(await main(["scan", "--root", root, "--no-drift"], c.io)).toBe(1);
      // CS2: the repo not cloned keeps its slot byte for byte; the repo read in full is written.
      const after = files(sources(root));
      expect(after["readers/forge-ledger.json"]).toBe(before["readers/forge-ledger.json"]);
      expect(after["readers/forge-events.json"]).not.toBe(before["readers/forge-events.json"]);
    },
    T,
  );

  it(
    "outside --repos",
    async () => {
      const root = await scannedForge();
      const before = files(sources(root));
      commitChange(root, "forge-ledger");
      commitChange(root, "forge-events");
      const c = capture();
      expect(
        await main(["scan", "--root", root, "--no-drift", "--repos", "forge-ledger"], c.io),
      ).toBe(0);
      // CS2: the repo outside --repos keeps its slot byte for byte; the one asked is written.
      const after = files(sources(root));
      expect(after["readers/forge-events.json"]).toBe(before["readers/forge-events.json"]);
      expect(after["readers/forge-ledger.json"]).not.toBe(before["readers/forge-ledger.json"]);
    },
    T,
  );

  it(
    "a reader throws",
    async () => {
      const root = await scannedForge();
      const before = files(sources(root));
      commitChange(root, "forge-portal-bff");
      commitChange(root, "forge-ledger");
      steer.failOn = "forge-portal-bff";
      try {
        const c = capture();
        expect(await main(["scan", "--root", root, "--no-drift"], c.io)).toBe(1);
      } finally {
        steer.failOn = undefined;
      }
      // CS2: the repo whose reader threw keeps its slot; the other repo read in full is written.
      const after = files(sources(root));
      expect(after["readers/forge-portal-bff.json"]).toBe(before["readers/forge-portal-bff.json"]);
      expect(after["readers/forge-ledger.json"]).not.toBe(before["readers/forge-ledger.json"]);
    },
    T,
  );

  it(
    "a cancel",
    async () => {
      const root = await scannedForge();
      const before = files(sources(root));
      const catalog = files(generated(root));
      for (const r of ["forge-events", "forge-ledger", "forge-portal-ui"]) commitChange(root, r);
      const ctl = new AbortController();
      steer.cancelOn = "forge-ledger";
      steer.abort = () => ctl.abort();
      try {
        const c = capture();
        const ended = await withSignal(ctl.signal, () =>
          main(["scan", "--root", root, "--no-drift"], c.io),
        ).catch((e: Error) => e);
        expect(ended).not.toBe(0);
      } finally {
        steer.cancelOn = undefined;
        steer.abort = undefined;
      }
      expect(files(sources(root))).toEqual(before);
      expect(files(generated(root))).toEqual(catalog);
    },
    T,
  );

  it(
    "a scan that read nothing writes no file",
    async () => {
      const top = await temp("atticus-slots-none-");
      await cp(FORGE, top, { recursive: true });
      const root = join(top, "metarepo");
      await clones(join(top, "repos"), root);
      const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
      const text = await readFile(manifest, "utf8");
      await writeFile(
        manifest,
        text.replace(/^ {2}- id: (.+)$/gm, "  - id: $1\n    archived: true"),
      );
      const c = capture();
      await main(["scan", "--root", root, "--no-drift"], c.io);
      expect(existsSync(sources(root))).toBe(false);
      // Over existing slots too.
      const scanned = await scannedForge();
      const before = files(sources(scanned));
      const m2 = join(scanned, "org-pack/profiles/forge/repos.manifest.yaml");
      await writeFile(
        m2,
        (await readFile(m2, "utf8")).replace(
          /^ {2}- id: (.+)$/gm,
          "  - id: $1\n    archived: true",
        ),
      );
      expect(await main(["scan", "--root", scanned, "--no-drift"], capture().io)).toBe(1);
      expect(files(sources(scanned))).toEqual(before);
    },
    T,
  );
});

describe("a plugin that times out or is refused leaves the slots of the repos it applies to (ADR 0195 point 1)", () => {
  async function pluginMetarepo(): Promise<string> {
    const root = await temp("atticus-slots-plugins-");
    await cp(join(PLUGINS, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
    await clones(join(PLUGINS, "repos"), root);
    for (const id of [
      "forge-reads-outside",
      "forge-writes-file",
      "forge-opens-socket",
      "forge-spawns",
      "forge-hogs-memory",
    ])
      await rm(join(root, "org-pack", "plugins", id), { recursive: true, force: true });
    return root;
  }

  it(
    "a timeout: the repo it applies to keeps its last good read, the others are written",
    async () => {
      const root = await pluginMetarepo();
      const loops = join(root, "org-pack", "plugins", "forge-loops");
      const kept = join(root, "loops-aside");
      await cp(loops, kept, { recursive: true });
      await rm(loops, { recursive: true });
      const c = capture();
      expect(await main(["scan", "--root", root, "--no-drift"], c.io), c.err.join("\n")).toBe(0);
      const before = files(sources(root));
      expect(Object.keys(before).sort()).toEqual([
        "build.json",
        "readers/forge-anvil-notes.json",
        "readers/forge-notes-ui.json",
      ]);
      commitChange(root, "forge-anvil-notes");
      commitChange(root, "forge-notes-ui");
      await cp(kept, loops, { recursive: true });
      const t = capture();
      expect(await main(["scan", "--root", root, "--no-drift"], t.io)).toBe(1);
      expect(t.err.join("\n")).toMatch(/stopped after 1000 ms, its time limit/);
      // CS2: the repo the plugin timed out on keeps its slot; the other repo is written.
      const after = files(sources(root));
      expect(after["readers/forge-anvil-notes.json"]).toBe(
        before["readers/forge-anvil-notes.json"],
      );
      expect(after["readers/forge-notes-ui.json"]).not.toBe(before["readers/forge-notes-ui.json"]);
    },
    T,
  );

  it(
    "a refused plugin (changed since its pin): its repo keeps its last good read, the others are written",
    async () => {
      const root = await pluginMetarepo();
      await rm(join(root, "org-pack", "plugins", "forge-loops"), { recursive: true });
      expect(await main(["scan", "--root", root, "--no-drift"], capture().io)).toBe(0);
      const before = files(sources(root));
      commitChange(root, "forge-anvil-notes");
      commitChange(root, "forge-notes-ui");
      const entry = join(root, "org-pack", "plugins", "forge-anvil-routes", "index.js");
      await writeFile(entry, (await readFile(entry, "utf8")) + "\n// an unreviewed edit\n");
      const j = capture();
      // The catalog is written as today (the problem makes the exit 1).
      expect(await main(["scan", "--root", root, "--no-drift", "--json"], j.io)).toBe(1);
      const report = JSON.parse(j.out.join("\n")) as ScanJson;
      expect(report.written).toBe(true);
      const after = files(sources(root));
      expect(after["readers/forge-anvil-notes.json"]).toBe(
        before["readers/forge-anvil-notes.json"],
      );
      expect(after["readers/forge-notes-ui.json"]).not.toBe(before["readers/forge-notes-ui.json"]);
      const anvil = report.sources.find((s) => s.repo === "forge-anvil-notes")!;
      expect(anvil).toMatchObject({ slot: "kept-last-good", reason: "plugin-refused" });
      expect(anvil.commit).toBe(
        (
          parseReadersSlot(before["readers/forge-anvil-notes.json"]!) as {
            slot: { commit: string };
          }
        ).slot.commit,
      );
      expect(report.sources.find((s) => s.repo === "forge-notes-ui")!.slot).toBe("written");
      // Said in words too.
      const w = capture();
      await main(["scan", "--root", root, "--no-drift"], w.io);
      expect(w.out.join("\n")).toMatch(
        /forge-anvil-notes: its readers slot keeps its last good read \(commit [0-9a-f]{7}\): a plugin that applies to it isn't used \(forge-anvil-routes\)/,
      );
    },
    T,
  );
});

/** The two-repo verify metarepo (packages/verify/test/fixtures), the ledger's facts in place. */
async function verifyMetarepo(o: { git?: boolean; facts?: string } = {}): Promise<{
  root: string;
  dir: string;
  commit: string;
}> {
  const root = await temp("atticus-slots-verify-");
  await cp(join(VERIFY, "metarepo", "org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(VERIFY, "metarepo", "catalog"), join(root, "catalog"), { recursive: true });
  const dir = join(root, "workspace", "forge-ledger");
  await cp(join(VERIFY, "repo"), dir, { recursive: true });
  let commit = "0123abc";
  if (o.git) {
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
    commit = git(dir, "rev-parse", "HEAD");
  }
  await mkdir(join(root, "facts"), { recursive: true });
  const facts = o.facts ?? readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8");
  await writeFile(join(root, "facts", "forge-ledger.jsonl"), facts.replaceAll("0123abc", commit));
  return { root, dir, commit };
}

const snapshot = (root: string) => files(join(sources(root), "facts"));

describe("verify --write writes the facts snapshot only when it succeeds (ADR 0195 point 1)", () => {
  it(
    "the kept facts as verify writes them, and a meta that projects them without the clone",
    async () => {
      const { root, dir } = await verifyMetarepo();
      const c = capture();
      const write = () =>
        verifyCommand(root, "forge-ledger", { commit: "0123abc", dir, write: true }, c.io);
      expect(await write(), c.err.join("\n")).toBe(0);
      const s = snapshot(root);
      expect(Object.keys(s).sort()).toEqual(["forge-ledger.jsonl", "forge-ledger.meta.json"]);
      const live = parseFacts(readFileSync(join(root, "facts", "forge-ledger.jsonl"), "utf8"));
      expect(live.ok).toBe(true);
      if (!live.ok) return;
      expect(s["forge-ledger.jsonl"]).toBe(serializeFacts(live.facts));
      const meta = parseFactsSlotMeta(s["forge-ledger.meta.json"]!);
      expect(meta.ok).toBe(true);
      if (!meta.ok) return;
      expect(meta.slot).toMatchObject({
        slotVersion: 1,
        kind: "facts",
        repo: "forge-ledger",
        commit: "0123abc",
        factsSchemaVersion: 5,
        factsHash: createHash("sha256").update(s["forge-ledger.jsonl"]!).digest("hex"),
      });
      expect(c.out.join("\n")).toMatch(
        /Facts snapshot: catalog\/sources\/facts\/forge-ledger\.jsonl written \(\d+ facts at 0123abc\)/,
      );
      // Writing the same facts again changes no byte.
      expect(await write()).toBe(0);
      expect(snapshot(root)).toEqual(s);
    },
    T,
  );

  it(
    "the meta says readComplete when verify's own verdict is that the read is complete, and not for a read in parts",
    async () => {
      // Beta.27.2, the review (ADR 0195 addendum "a legacy join its caller's facts place
      // elsewhere"): what lets the build retire an adopted arrow that cites no caller line.
      const { root, dir } = await verifyMetarepo();
      const meta = () => {
        const m = parseFactsSlotMeta(snapshot(root)["forge-ledger.meta.json"]!);
        if (!m.ok) throw new Error(JSON.stringify(m.issues));
        return m.slot;
      };
      const write = async () => {
        const c = capture();
        expect(
          await verifyCommand(root, "forge-ledger", { commit: "0123abc", dir, write: true }, c.io),
          c.err.join("\n"),
        ).toBe(0);
        return c.out.join("\n");
      };
      // The fixture's read leaves a file unknown: a read in parts, said by leaving the field out.
      expect(await write()).toMatch(/^Next: read the 1 unknown files/m);
      expect(meta().readComplete).toBeUndefined();
      // That file reviewed with nothing to record: the read is complete, and the meta says so.
      const unknown = /unknown:\n((?: {4}- .+\n)+)/.exec(
        readFileSync(join(root, "facts", "forge-ledger.verify.yaml"), "utf8"),
      );
      expect(unknown).not.toBeNull();
      const files = unknown![1]!.split("\n").flatMap((l) => (l.trim() ? [l.trim().slice(2)] : []));
      await writeFile(
        join(root, "facts", "forge-ledger.reviewed.jsonl"),
        files.map((path) => JSON.stringify({ path, why: "Nothing to record." })).join("\n") + "\n",
      );
      expect(await write()).toMatch(/^The read is complete: every source file is read/m);
      expect(meta().readComplete).toBe(true);
      // A source file no fact cites and nothing reviewed: the read is in parts again.
      await writeFile(
        join(dir, "src/main/java/forge/ledger/Unread.java"),
        "package forge.ledger;\n\npublic class Unread {}\n",
      );
      expect(await write()).toMatch(/^Next: read the 1 unknown files/m);
      expect(meta().readComplete).toBeUndefined();
      expect(Object.keys(JSON.parse(snapshot(root)["forge-ledger.meta.json"]!))).not.toContain(
        "readComplete",
      );
    },
    T,
  );

  it(
    "a refused --write, and a check without --write, leave the snapshot byte for byte",
    async () => {
      const { root, dir } = await verifyMetarepo();
      expect(
        await verifyCommand(
          root,
          "forge-ledger",
          { commit: "0123abc", dir, write: true },
          capture().io,
        ),
      ).toBe(0);
      const s = snapshot(root);
      const catalog = files(generated(root));
      // The live file gains facts that are rejected. A --write that takes only a whole read
      // (`whole`, map --all's) refuses, in words and in --json; beta.28.1's --write writes the
      // rest (exit 3), the rejected facts never in the snapshot.
      await writeFile(
        join(root, "facts", "forge-ledger.jsonl"),
        readFileSync(join(root, "facts", "forge-ledger.jsonl"), "utf8") +
          readFileSync(join(VERIFY, "redteam.facts.jsonl"), "utf8"),
      );
      for (const json of [false, true]) {
        const c = capture();
        expect(
          await verifyCommand(
            root,
            "forge-ledger",
            { commit: "0123abc", dir, write: true, whole: true, ...(json ? { json: true } : {}) },
            c.io,
          ),
        ).toBe(1);
        expect(snapshot(root)).toEqual(s);
        expect(files(generated(root))).toEqual(catalog);
      }
      const redteam = readFileSync(join(VERIFY, "redteam.facts.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => (JSON.parse(l) as { id: string }).id);
      // The hunt of beta.28.1 (F1): with a fact read at another commit, the write is refused
      // whole, the snapshot as it was; without it, the rest is written (exit 3).
      expect(
        await verifyCommand(
          root,
          "forge-ledger",
          { commit: "0123abc", dir, write: true },
          capture().io,
        ),
      ).toBe(1);
      expect(snapshot(root)).toEqual(s);
      await writeFile(
        join(root, "facts", "forge-ledger.jsonl"),
        (await readFile(join(root, "facts", "forge-ledger.jsonl"), "utf8"))
          .split("\n")
          .filter((l) => !l.includes('"id":"rt-wrong-commit"'))
          .join("\n"),
      );
      expect(
        await verifyCommand(
          root,
          "forge-ledger",
          { commit: "0123abc", dir, write: true },
          capture().io,
        ),
      ).toBe(3);
      const held = snapshot(root)["forge-ledger.jsonl"]!;
      for (const id of redteam) expect(held).not.toContain(`"id":"${id}"`);
      // A live edit checked without --write: the snapshot stays until --write succeeds.
      await writeFile(
        join(root, "facts", "forge-ledger.jsonl"),
        readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8")
          .split("\n")
          .slice(1)
          .join("\n"),
      );
      await verifyCommand(root, "forge-ledger", { commit: "0123abc", dir }, capture().io);
      expect(readFileSync(join(root, "facts", "forge-ledger.jsonl"), "utf8")).not.toBe(
        s["forge-ledger.jsonl"],
      );
      expect(snapshot(root)).toEqual(s);
    },
    T,
  );

  it(
    "a scan over a repo whose cited files changed leaves the snapshot and names the verify command",
    async () => {
      const { root, dir, commit } = await verifyMetarepo({ git: true });
      expect(await verifyCommand(root, "forge-ledger", { dir, write: true }, capture().io)).toBe(0);
      const s = snapshot(root);
      expect(parseFactsSlotMeta(s["forge-ledger.meta.json"]!)).toMatchObject({
        ok: true,
        slot: { commit },
      });
      const cited = join(dir, "src/main/java/forge/ledger/AccountController.java");
      await writeFile(cited, (await readFile(cited, "utf8")) + "\n// moved on\n");
      git(dir, "commit", "-q", "-am", "moved on");
      const head = git(dir, "rev-parse", "HEAD");
      const c = capture();
      await main(["scan", "--root", root, "--no-drift"], c.io);
      expect(snapshot(root)).toEqual(s);
      const said = c.out.join("\n");
      expect(said).toMatch(
        new RegExp(
          `forge-ledger: its facts snapshot \\(catalog/sources/facts/forge-ledger\\.jsonl, commit ${commit.slice(0, 7)}\\) is stale at ${head.slice(0, 7)}: \\d+ facts? cites? files changed since`,
        ),
      );
      expect(said).toMatch(/src\/main\/java\/forge\/ledger\/AccountController\.java/);
      expect(said).toMatch(/e-get-account/);
      expect(said).toMatch(/refresh it: atticus verify forge-ledger --write/);
      const j = capture();
      await main(["scan", "--root", root, "--no-drift", "--json"], j.io);
      const report = JSON.parse(j.out.join("\n")) as ScanJson;
      const stale = report.sources.find((x) => x.repo === "forge-ledger")!.factsStale!;
      expect(stale).toMatchObject({ commit, head, command: "atticus verify forge-ledger --write" });
      expect(stale.files.map((f) => f.path)).toContain(
        "src/main/java/forge/ledger/AccountController.java",
      );
      expect(stale.files.flatMap((f) => f.facts)).toContain("e-get-account");
      expect(snapshot(root)).toEqual(s);
    },
    T,
  );
});
