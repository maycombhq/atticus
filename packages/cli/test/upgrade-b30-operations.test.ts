import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { MockRuntime } from "@maycombhq/ai";
import { Api, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { changeFolder } from "@maycombhq/changes";
import { orgFlowVersionOf } from "@maycombhq/openspec-adapter";
import { EXPAND_AGENT, OPERATIONS_FILE } from "@maycombhq/planner";
import { main } from "../src/main.js";
import { stageCli } from "../src/stage-commands.js";
import { upgradeCheck, upgradeCommand } from "../src/upgrade.js";

/**
 * ADR 0203, Migration: org-flow goes from 2 to 3 through the upgrade step that is there, and an
 * existing change needs no rewrite. A metarepo as 2.0.0-beta.28.5 left it, with org-flow 2 (the
 * folder that version generated, kept in fixtures/upgrade-b30/org-flow-v2) and two changes done
 * through stories: screen-order-consent, whose files an earlier Atticus wrote (its stories.md and
 * requests.md are a person's, so its stories stage is not run again here), and add-fraud-check,
 * taken through the three stages before the stamp with the hand-written answers of
 * fixtures/stages/corrections (a change of flows only: none of ADR 0203's keys). After `atticus
 * upgrade` org-flow is 3, every file of both changes is byte for byte the same, each stage reads
 * as done with no model call, `change status` says what it said, and a second run changes nothing.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const STAGES = join(FIXTURES, "stages");
const B285 = "2.0.0-beta.28.5";
const B30 = "2.0.0-beta.30";
const OLDER = "screen-order-consent";
const STAGED = "add-fraud-check";
const NOW = new Date("2026-11-18T09:00:00Z");
const ALL_STAGES = [
  ["change", "feature"],
  ["change", "architecture"],
  ["plan", "stories"],
];
const ORG_FLOW = "openspec/schemas/org-flow";
const T = 300_000;

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
    cwd,
    encoding: "utf8",
  });
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

/** A model that answers each stage's drafter in turn with `answers`, and says who drafted. */
function assistant(answers: string[] = []) {
  const drafts: string[] = [];
  const runtime = new MockRuntime(
    (req) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT)
        return "terms: [fraud screen, place order, reserve stock]\nnames:\n  - { name: Northwind Pay, id: northwind-pay, quote: screened by Northwind Pay }\n";
      drafts.push(req.agent.id);
      return answers[drafts.length - 1] ?? "";
    },
    { now: () => NOW },
  );
  return { runtime, drafts };
}

/** Run the stages of a change, each expected to end done. */
async function runStages(root: string, change: string, stages: string[][], answers?: string[]) {
  const a = assistant(answers);
  for (const args of stages) {
    const c = io();
    const code = await stageCli(root, [...args, change], { json: true }, c.io, {
      runtime: a.runtime,
      now: NOW,
    });
    const what = `${args.join(" ")} ${change}: ${c.err.join(" ")}`;
    expect((JSON.parse(c.out.join("\n") || "{}") as { state?: string }).state, what).toBe("done");
    expect(code, what).toBe(0);
  }
  return a.drafts;
}

async function b285Metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b30-ops-upgrade-"));
  roots.push(root);
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  for (const [f, to] of [
    ["specs/catalog.yaml", "catalog/generated"],
    ["stages/catalog-extra.yaml", "catalog/generated"],
    ["stages/footprint/catalog.yaml", "catalog/generated"],
    ["stages/knowledge.yaml", "knowledge/items"],
  ])
    for (const r of parse(await readFile(join(FIXTURES, f!), "utf8")) as unknown[]) {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
      const file = join(root, to!, recordPath(p.record));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, serializeRecord(p.record));
    }
  await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(STAGES, "footprint", OLDER), join(root, "openspec/changes", OLDER), {
    recursive: true,
  });
  await cp(join(STAGES, "changes", STAGED), join(root, "openspec/changes", STAGED), {
    recursive: true,
  });
  const answers = await Promise.all(
    ["feature", "architecture", "stories"].map((n) =>
      readFile(join(STAGES, "corrections/answers", `${n}.yaml`), "utf8"),
    ),
  );
  expect(await runStages(root, STAGED, ALL_STAGES, answers)).toHaveLength(3);
  await writeFile(join(root, "openspec/config.yaml"), "schema: org-flow\n");
  await writeFile(join(root, ".gitignore"), "/workspace/\n/.atticus/*\n!/.atticus/metarepo.yaml\n");
  await mkdir(join(root, ".atticus"), { recursive: true });
  // Bring it to what beta.28.5's steps wrote and stamp it as that version did; then org-flow as
  // that version generated it, and the stamp without the steps beta.30 adds.
  expect(await upgradeCommand(root, { by: "pat" }, io().io, B285)).toBe(0);
  await rm(join(root, ORG_FLOW), { recursive: true, force: true });
  await cp(join(FIXTURES, "upgrade-b30/org-flow-v2"), join(root, ORG_FLOW), { recursive: true });
  const stampFile = join(root, ".atticus/metarepo.yaml");
  const stamp = parse(await readFile(stampFile, "utf8")) as { migrations: string[] };
  stamp.migrations = stamp.migrations.filter(
    (m) => !["change-types-quick", "starter-personas"].includes(m),
  );
  await writeFile(stampFile, stringify(stamp));
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "as beta.28.5 left it");
  return root;
}

/** Every file of both changes, with the sha-256 of its bytes. */
async function bytesOf(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const change of [OLDER, STAGED]) {
    const dir = changeFolder(root, change);
    for (const f of ((await readdir(dir, { recursive: true })) as string[]).sort()) {
      const data = await readFile(join(dir, f)).catch(() => undefined);
      if (data)
        out[`${change}/${f.replace(/\\/g, "/")}`] = createHash("sha256").update(data).digest("hex");
    }
  }
  return out;
}

const changedPaths = (root: string) =>
  git(root, "status", "--porcelain=v1", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3))
    .filter((f) => !f.startsWith(".atticus/"));

async function status(root: string): Promise<string[]> {
  const c = io();
  for (const change of [OLDER, STAGED])
    expect(await main(["change", "status", change, "--root", root], c.io, { quiet: true })).toBe(0);
  return c.out;
}

describe("atticus upgrade to beta.30: org-flow 3, and a change done through stories (ADR 0203)", () => {
  it(
    "moves org-flow to 3 and leaves every file of the change byte for byte the same",
    async () => {
      const root = await b285Metarepo();
      expect(await orgFlowVersionOf(root)).toBe(2);
      const before = await bytesOf(root);
      const said = await status(root);
      // Both changes are in beta.28.5's shape: no operations file, and none of the new keys.
      expect(Object.keys(before)).toContain(`${OLDER}/stage/stories.yaml`);
      expect(Object.keys(before)).toContain(`${STAGED}/stage/stories.yaml`);
      expect(Object.keys(before).filter((f) => f.endsWith(OPERATIONS_FILE))).toEqual([]);
      for (const change of [OLDER, STAGED]) {
        const dir = changeFolder(root, change);
        expect(await readFile(join(dir, "feature.yaml"), "utf8")).not.toMatch(
          /^(operations|outside):/m,
        );
        expect(await readFile(join(dir, "tasks.md"), "utf8")).not.toContain("(after ");
      }

      const check = await upgradeCheck(root, B30);
      expect(check.pending.find((p) => p.id === "org-flow-v2")?.files).toEqual([
        `${ORG_FLOW}/schema.yaml`,
      ]);
      expect(await upgradeCommand(root, { by: "pat" }, io().io, B30)).toBe(0);

      expect(await orgFlowVersionOf(root)).toBe(3);
      expect(await readFile(join(root, ORG_FLOW, "templates/design.md"), "utf8")).toContain(
        "## Operations",
      );
      expect(await bytesOf(root)).toEqual(before);
      expect(changedPaths(root).filter((f) => f.startsWith("openspec/changes/"))).toEqual([]);
      expect(await status(root)).toEqual(said);

      // Each stage reads as done, and no drafter is asked for anything.
      expect(await runStages(root, STAGED, ALL_STAGES)).toEqual([]);
      expect(await runStages(root, OLDER, ALL_STAGES.slice(0, 2))).toEqual([]);
      // A stage run again records the knowledge its context held (knowledge.yaml, as before this
      // release); nothing else of either change moves.
      const stable = (b: Record<string, string>) =>
        Object.fromEntries(Object.entries(b).filter(([f]) => !f.endsWith("/knowledge.yaml")));
      expect(stable(await bytesOf(root))).toEqual(stable(before));
      expect(await status(root)).toEqual(said);
      const upgraded = await bytesOf(root);

      // A second run has nothing to do and changes nothing.
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "upgraded to beta.30");
      expect((await upgradeCheck(root, B30)).pending).toEqual([]);
      expect(await upgradeCommand(root, { by: "pat" }, io().io, B30)).toBe(0);
      expect(changedPaths(root)).toEqual([]);
      expect(await bytesOf(root)).toEqual(upgraded);
    },
    T,
  );
});

/** Every file of the metarepo but git's own, with the sha-256 of its bytes. */
async function everyFile(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of ((await readdir(root, { recursive: true })) as string[]).sort()) {
    const rel = f.replace(/\\/g, "/");
    if (rel === ".git" || rel.startsWith(".git/")) continue;
    const data = await readFile(join(root, f)).catch(() => undefined);
    if (data) out.set(rel, createHash("sha256").update(data).digest("hex"));
  }
  return out;
}

/**
 * ADR 0206, Migration: a stored conformance check as beta.28.5 wrote it (no claims) reads as it
 * did, after the upgrade too: `--latest` prints what beta.28.5 itself printed for it (its output,
 * kept in fixtures/upgrade-b30/conform-28.5.latest.txt, made by the CLI built from the tag
 * v2.0.0-beta.28.5 on this metarepo), and every file the upgrade isn't meant to write (all but
 * the files its steps name, the folder of each, its stamp, its backup and its record) is byte for
 * byte the same; and
 * a result this release writes, with claims, still
 * parses with beta.28.5's shape of ConformRepoResult (a copy, kept here as that version had it:
 * a plain object, so an older reader drops the keys it doesn't know).
 */
const B285_CONFORM_RESULT = z.object({
  schemaVersion: z.literal(1),
  change: z.string(),
  repo: z.string(),
  ref: z.string(),
  commit: z.string(),
  base: z.string(),
  task: z.string().optional(),
  checkedAt: z.string(),
  counts: z.object({
    found: z.number().int(),
    missing: z.number().int(),
    stillThere: z.number().int(),
    unexpected: z.number().int(),
  }),
  items: z.array(
    z.object({
      status: z.enum(["found", "missing", "still-there", "unexpected"]),
      check: z.enum(["call", "publish", "table", "column", "migration", "trigger", "endpoint"]),
      flow: z.string().optional(),
      item: z.number().int().positive().optional(),
      task: z.string().optional(),
      what: z.string(),
      record: z.string().optional(),
      at: z.array(
        z.object({
          source: z.enum(["artifact", "code"]),
          repo: z.string().optional(),
          path: z.string(),
          line: z.number().int().positive().optional(),
        }),
      ),
    }),
  ),
  unchecked: z.array(
    z.object({
      flow: z.string(),
      item: z.number().int().positive().optional(),
      kind: z.string(),
      why: z.string(),
    }),
  ),
  problems: z.array(z.string()),
});

describe("a stored conformance check from beta.28.5 (ADR 0206)", () => {
  it(
    "reads as it did after the upgrade, byte for byte, and a result with claims parses with beta.28.5's shape",
    async () => {
      const root = await b285Metarepo();
      const file = join(changeFolder(root, STAGED), "conform/forge-ledger.yaml");
      await mkdir(dirname(file), { recursive: true });
      await cp(join(FIXTURES, "upgrade-b30/conform-28.5.yaml"), file);
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "a conformance check as beta.28.5 kept it");
      const latest = async () => {
        const c = io();
        expect(
          await main(["change", "conform", STAGED, "--latest", "--root", root], c.io, {
            quiet: true,
          }),
        ).toBe(0);
        return c.out;
      };
      // What beta.28.5 printed for it, line for line.
      const b285 = (await readFile(join(FIXTURES, "upgrade-b30/conform-28.5.latest.txt"), "utf8"))
        .split("\n")
        .filter(Boolean);
      const said = await latest();
      expect(said).toEqual(b285);
      const before = await bytesOf(root);
      const every = await everyFile(root);
      const meant = new Set((await upgradeCheck(root, B30)).pending.flatMap((p) => p.files));
      expect(meant.size).toBeGreaterThan(0);
      expect(await upgradeCommand(root, { by: "pat" }, io().io, B30)).toBe(0);
      expect(await bytesOf(root)).toEqual(before);
      const now = await everyFile(root);
      // What the upgrade is meant to write: the files its steps name (org-flow's step names the
      // schema and writes its folder, the templates beside it), its stamp (.atticus/metarepo.yaml),
      // the backup it takes first (.atticus/backups/) and its record of what ran.
      const folders = [...meant].map((f) => f.slice(0, f.lastIndexOf("/") + 1));
      const own = (f: string) =>
        f === ".index/upgraded.json" ||
        f === ".atticus/metarepo.yaml" ||
        f.startsWith(".atticus/backups/") ||
        // A read's parse cache, which any command reading the catalog keeps (core's
        // record-cache.ts, out of Git), written by the reads around the upgrade, not by it.
        f.startsWith(".atticus/cache/") ||
        meant.has(f);
      const moved = [...new Set([...every.keys(), ...now.keys()])].filter(
        (f) => every.get(f) !== now.get(f),
      );
      expect(
        moved.filter((f) => !own(f) && !folders.some((d) => f.startsWith(d))),
        JSON.stringify(moved),
      ).toEqual([]);
      // And it did write what it is meant to.
      expect(moved).toContain(`${ORG_FLOW}/schema.yaml`);
      expect(changedPaths(root).filter((f) => f.includes("/conform/"))).toEqual([]);
      expect(await latest()).toEqual(b285);

      const stored = parse(await readFile(file, "utf8")) as Record<string, unknown>;
      const newer = {
        ...stored,
        counts: {
          ...(stored.counts as object),
          claims: { present: 1, differs: 0, missing: 0, notCheckable: 0, unconfirmed: 0 },
        },
        claims: [
          {
            outcome: "present",
            check: "deployment",
            repo: "forge-ledger",
            from: { file: "target-flows/_operations.yaml", line: 8, operation: "deploy-anvil" },
            expected: "platform anvil, env prod",
            what: "forge-ledger runs on anvil in prod.",
            at: [{ source: "code", repo: "forge-ledger", path: "deploy/anvil.yaml", line: 3 }],
            next: "Nothing: the line is cited for the reviewer.",
          },
        ],
      };
      expect(Api.ConformRepoResult.safeParse(newer).success).toBe(true);
      const old = B285_CONFORM_RESULT.safeParse(newer);
      expect(old.success).toBe(true);
      expect(old.data).not.toHaveProperty("claims");
    },
    T,
  );
});
