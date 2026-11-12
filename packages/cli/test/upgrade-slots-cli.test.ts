import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseLegacyJoins, parseReadersSlot } from "@maycombhq/scanner";
import { main } from "../src/main.js";

/**
 * ADR 0195 (CS2): the upgrade of a catalog written before the slots (point 6), and the build's
 * own commands: `atticus catalog build [--check]`, `edits [--curate]`, `undo [<n>]` and `prune`.
 * A beta.26 metarepo is the Forge estate scanned, with `catalog/sources/` taken away: its
 * catalog is a scan's, as beta.26 wrote it. Invented Forge estate (CLAUDE.md rule 3).
 */

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const T = 240_000;

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};
const run = async (args: string[]) => {
  const c = capture();
  const code = await main(args, c.io);
  return { code, out: c.out.join("\n"), err: c.err.join("\n") };
};

const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

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

let template: string | undefined;
/** The Forge estate cloned and scanned once, then copied per test. */
async function scanned(): Promise<string> {
  if (!template) {
    const top = await mkdtemp(join(tmpdir(), "atticus-upgrade-slots-"));
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
    const r = await run(["scan", "--root", root, "--no-drift"]);
    expect(r.code, r.err).toBe(0);
    template = top;
  }
  const copy = await mkdtemp(join(tmpdir(), "atticus-upgrade-slots-copy-"));
  made.push(copy);
  await cp(template, copy, { recursive: true });
  return join(copy, "metarepo");
}

/** A beta.26 metarepo: a scan's catalog, and no catalog/sources/ (and no undo copies). */
async function beta26(): Promise<string> {
  const root = await scanned();
  await rm(join(root, "catalog", "sources"), { recursive: true });
  await rm(join(root, ".index", "build-undo"), { recursive: true, force: true });
  return root;
}

const generated = (root: string) => files(join(root, "catalog", "generated"));
const sources = (root: string) => files(join(root, "catalog", "sources"));

describe("atticus upgrade adopts a catalog from before the slots, shown first (ADR 0195 point 6)", () => {
  it(
    "a beta.26 catalog: every writer refuses until the upgrade, which names the command",
    async () => {
      const root = await beta26();
      const before = generated(root);
      const r = await run(["scan", "--root", root, "--no-drift"]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/was written before beta\.27.*run atticus upgrade/);
      expect(generated(root)).toEqual(before);
      expect(existsSync(join(root, "catalog", "sources"))).toBe(false);
    },
    T,
  );

  it(
    "without --yes writes no byte; with --yes adopts every record into exactly one legacy slot, keeps a copy, and the catalog is byte for byte as it was",
    async () => {
      const root = await beta26();
      const before = generated(root);
      const dry = await run(["upgrade", "--root", root]);
      expect(dry.code, dry.err).toBe(0);
      expect(dry.out).toMatch(/Adopt the catalog into source slots/);
      expect(dry.out).toMatch(/The first build changes nothing/);
      expect(dry.out).toMatch(/atticus upgrade --yes applies this step/);
      expect(existsSync(join(root, "catalog", "sources"))).toBe(false);
      expect(generated(root)).toEqual(before);

      const yes = await run(["upgrade", "--root", root, "--yes"]);
      expect(yes.code, yes.err).toBe(0);
      expect(generated(root)).toEqual(before);
      const s = sources(root);
      const held = new Map<string, number>();
      for (const [p, text] of Object.entries(s)) {
        const slot = p.startsWith("readers/")
          ? parseReadersSlot(text)
          : p === "legacy/joins.json"
            ? parseLegacyJoins(text)
            : undefined;
        if (!slot) continue;
        expect(slot.ok, p).toBe(true);
        if (!slot.ok) continue;
        expect(slot.slot.status).toBe("legacy");
        for (const r of slot.slot.records)
          held.set(`${r.kind}/${r.id}`, (held.get(`${r.kind}/${r.id}`) ?? 0) + 1);
      }
      const records = Object.keys(before).filter((p) => p.endsWith(".yaml"));
      expect(held.size).toBe(records.length);
      expect([...held.values()].every((n) => n === 1)).toBe(true);
      const copy = Object.fromEntries(
        Object.entries(s)
          .filter(([p]) => p.startsWith("legacy/generated-before-upgrade/"))
          .map(([p, t]) => [p.slice("legacy/generated-before-upgrade/".length), t]),
      );
      expect(copy).toEqual(before);
      expect(s["build.json"]).toBeDefined();
      // The build from the adopted slots is the catalog as it is, and a second run does nothing.
      expect((await run(["catalog", "build", "--root", root, "--check"])).code).toBe(0);
      const again = await run(["upgrade", "--root", root, "--yes"]);
      expect(again.code).toBe(0);
      expect(again.out).not.toMatch(/Adopt the catalog/);
      expect(sources(root)).toEqual(s);
      // A scan then replaces each legacy slot with a full read; every cross-repo arrow stays.
      const arrows = Object.keys(before).filter((p) => p.startsWith("interface/"));
      const scan = await run(["scan", "--root", root, "--no-drift", "--json"]);
      const report = JSON.parse(scan.out) as { refused?: { allowRemovals?: number } };
      if (report.refused?.allowRemovals !== undefined)
        expect(
          (
            await run([
              "scan",
              "--root",
              root,
              "--no-drift",
              "--allow-removals",
              String(report.refused.allowRemovals),
            ])
          ).code,
        ).toBe(0);
      for (const a of arrows) expect(generated(root)[a], a).toBeDefined();
      const ledger = parseReadersSlot(sources(root)["readers/forge-ledger.json"]!);
      expect(ledger.ok && ledger.slot.status).toBe("read");
    },
    T,
  );
});

describe("the build's own commands (ADR 0195 points 2, 4 and 7)", () => {
  it(
    "catalog build --check says whether catalog/generated is what the slots build, and writes nothing",
    async () => {
      const root = await scanned();
      expect((await run(["catalog", "build", "--root", root, "--check"])).code).toBe(0);
      const [kind] = readdirSync(join(root, "catalog", "generated"));
      const [file] = readdirSync(join(root, "catalog", "generated", kind!));
      await appendFile(join(root, "catalog", "generated", kind!, file!), "# edited by hand\n");
      const before = generated(root);
      const c = await run(["catalog", "build", "--root", root, "--check"]);
      expect(c.code).toBe(1);
      expect(c.out).toMatch(/isn't what the slots and inputs build/);
      expect(generated(root)).toEqual(before);
    },
    T,
  );

  it(
    "a hand edit is listed; catalog edits --curate makes it a decision the next build keeps, its bytes in the undo copy",
    async () => {
      const root = await scanned();
      const dir = join(root, "catalog", "generated", "endpoint");
      const [file] = readdirSync(dir).sort();
      const path = join(dir, file!);
      const text = readFileSync(path, "utf8");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, text.replace(/^auth: .*$/m, "") + "auth: mtls\n");
      const list = await run(["catalog", "edits", "--root", root]);
      expect(list.code).toBe(1);
      expect(list.out).toContain(`changed: catalog/generated/endpoint/${file}`);
      const curate = await run(["catalog", "edits", "--curate", "--root", root, "--by", "pat"]);
      expect(curate.code, curate.err).toBe(0);
      expect(curate.out).toMatch(/Wrote catalog\/curated\/curateddecision\/cd-edit-assert-/);
      const build = await run(["catalog", "build", "--root", root]);
      expect(build.code, build.err).toBe(0);
      const now = readFileSync(path, "utf8");
      expect(now).toMatch(/^auth: mtls$/m);
      expect(now).toMatch(/confidence: asserted/);
      // The next scan keeps the edit's effect.
      expect((await run(["scan", "--root", root, "--no-drift"])).code).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(now);
    },
    T,
  );

  it(
    "catalog undo lists the builds kept and takes back the latest only with --yes; it can be undone",
    async () => {
      const root = await scanned();
      const before = { g: generated(root), s: sources(root) };
      const ws = join(root, "workspace", "forge-ledger");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(ws, "NOTES.md"), "moved on\n");
      git(ws, "add", "-A");
      git(ws, "commit", "-q", "-m", "moved on");
      expect((await run(["scan", "--root", root, "--no-drift"])).code).toBe(0);
      const after = { g: generated(root), s: sources(root) };
      expect(after.s).not.toEqual(before.s);
      const list = await run(["catalog", "undo", "--root", root]);
      expect(list.code).toBe(0);
      expect(list.out).toMatch(/1: atticus scan/);
      expect({ g: generated(root), s: sources(root) }).toEqual(after);
      expect((await run(["catalog", "undo", "--root", root, "--yes"])).code).toBe(0);
      expect({ g: generated(root), s: sources(root) }).toEqual(before);
      expect((await run(["catalog", "undo", "--root", root, "--yes"])).code).toBe(0);
      expect({ g: generated(root), s: sources(root) }).toEqual(after);
    },
    T,
  );

  it(
    "catalog prune lists a removed repo's slot and removes only it, and only with --yes",
    async () => {
      const root = await scanned();
      const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
      const text = readFileSync(manifest, "utf8");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        manifest,
        text.replace("  - id: forge-infra\n", "  - id: forge-infra\n    archived: true\n"),
      );
      const list = await run(["catalog", "prune", "--root", root]);
      expect(list.code).toBe(0);
      expect(list.out).toMatch(
        /catalog\/sources\/readers\/forge-infra\.json \(forge-infra is archived\)/,
      );
      expect(existsSync(join(root, "catalog/sources/readers/forge-infra.json"))).toBe(true);
      const yes = await run(["catalog", "prune", "--root", root, "--yes"]);
      expect(yes.code).toBe(0);
      expect(existsSync(join(root, "catalog/sources/readers/forge-infra.json"))).toBe(false);
      expect(existsSync(join(root, "catalog/sources/readers/forge-ledger.json"))).toBe(true);
      expect((await run(["catalog", "undo", "--root", root, "--yes"])).code).toBe(0);
      expect(existsSync(join(root, "catalog/sources/readers/forge-infra.json"))).toBe(true);
    },
    T,
  );
});
