import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  appMemory,
  forgetFactsParses,
  parseRecord,
  recordPath,
  serializeRecord,
  settleAfterResult,
} from "@maycombhq/core";
import { buildAndWrite, buildCacheStats } from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { main } from "../src/main.js";
import { extendUiRoutes } from "../src/ui-commands.js";
import { BIG_COMMIT, bigRepoId, writeBigRepo } from "./big-estate.js";
import { makeFieldEstate } from "./field-estate.js";

/**
 * ADR 0205 step 4's proof, the server's (the review of beta.30's slice 10): two Applies and
 * more through the app's route (POST /api/facts/{repo}/apply, in one server that keeps its caches
 * in memory between them) and the same as commands (`atticus verify <repo> --write`, nothing kept
 * between them), with a person's changes between them that each cache in memory must miss: a
 * facts file, the org pack, a curated decision and a record file edited by hand. After every
 * step every file a person or a commit sees is the same bytes, and each step says the same.
 * Invented Forge estate (CLAUDE.md rule 3); no network (rule 5).
 */
const made: string[] = [];
const servers: RunningServer[] = [];
// One clock for both sides: a question's and a decision's times are written into the files.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T09:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const OPTIONS = {
  services: 5,
  gateways: 2,
  entries: 20,
  calls: 14,
  fieldNames: 200,
  legacy: 2,
  questions: 12,
  links: 6,
  suppressed: 4,
  checkouts: 3,
};
const REPO = bigRepoId(1);

/** Every file a person or a commit sees: not this machine's caches, state and clones. */
async function tree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string) => {
    for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (p === ".atticus" || p === ".index" || p === "workspace" || p === ".git") continue;
        await walk(p);
      } else out.set(p, await readFile(join(root, p), "utf8"));
    }
  };
  await walk("");
  return out;
}

/**
 * The repo's clone as a git checkout at a commit both sides make alike (the same files, author
 * and time give the same hash), and its facts file at that commit: the app's Apply checks the
 * facts at the checkout's HEAD, as `verify` without --commit does.
 */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Forge Dev",
  GIT_AUTHOR_EMAIL: "dev@forge.example",
  GIT_COMMITTER_NAME: "Forge Dev",
  GIT_COMMITTER_EMAIL: "dev@forge.example",
  GIT_AUTHOR_DATE: "2026-11-21T09:00:00Z",
  GIT_COMMITTER_DATE: "2026-11-21T09:00:00Z",
};
async function changeRepo(root: string, options: object, r: number, edit: number) {
  await writeBigRepo(root, r, options as never, edit, true, false);
  const dir = join(root, "workspace", bigRepoId(r));
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: dir, env: GIT_ENV, encoding: "utf8" }).trim();
  if (!existsSync(join(dir, ".git"))) git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", `edit ${edit}`);
  const head = git("rev-parse", "HEAD");
  const facts = join(root, "facts", `${bigRepoId(r)}.jsonl`);
  await writeFile(
    facts,
    (await readFile(facts, "utf8")).replaceAll(`"commit":"${BIG_COMMIT}"`, `"commit":"${head}"`),
  );
}

/** The person's changes between two Applies, each to something a cache in memory reads. */
const CHANGES: [string, (root: string, options: object) => Promise<void>][] = [
  // Another repo's facts file (the questions' suggestions read every live facts file).
  ["a facts file", (root, options) => changeRepo(root, options, 2, 5)],
  // The org pack: a repo's owner.
  [
    "the org pack",
    async (root) => {
      const p = join(root, "org-pack/profiles/github/repos.manifest.yaml");
      const text = await readFile(p, "utf8");
      const at = text.indexOf(`id: ${bigRepoId(3)}`);
      const owner = text.indexOf("owner: team-forge", at);
      expect(owner).toBeGreaterThan(at);
      await writeFile(
        p,
        `${text.slice(0, owner)}owner: team-forge-ops${text.slice(owner + "owner: team-forge".length)}`,
      );
    },
  ],
  // A curated decision: one of forge-svc-04's endpoints suppressed.
  [
    "a curated decision",
    async (root) => {
      const dir = join(root, "catalog", "generated", "endpoint");
      const name = (await readdir(dir)).sort().find((n) => n.startsWith(bigRepoId(4)));
      expect(name).toBeDefined();
      const p = parseRecord({
        kind: "CuratedDecision",
        schemaVersion: 2,
        status: "current",
        confidence: "asserted",
        id: `cd-suppress-${name!.replace(/\.yaml$/, "")}`,
        target: name!.replace(/\.yaml$/, ""),
        action: "suppress",
        value: null,
        reason: "A person's decision in the server's test.",
        by: "forge.dev",
        at: "2026-11-21T09:00:00Z",
      });
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      const file = join(root, "catalog", "curated", ...recordPath(p.record).split("/"));
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, serializeRecord(p.record));
    },
  ],
  // A record file edited by hand: the next Apply refuses until the edit is discarded.
  [
    "a hand edit",
    async (root) => {
      const dir = join(root, "catalog", "generated", "endpoint");
      const name = (await readdir(dir)).sort().find((n) => n.startsWith(bigRepoId(3)))!;
      const p = join(dir, name);
      await writeFile(p, `${await readFile(p, "utf8")}# edited by hand\n`);
    },
  ],
];

interface Said {
  code: number;
  refused?: string[];
}

/** One side's steps: the estate, its cold build, then the Applies with the changes between. */
async function steps(apply: (root: string, confirm?: number) => Promise<Said & { plan?: string }>) {
  const dir = await mkdtemp(join(tmpdir(), "atticus-apply15-server-"));
  made.push(dir);
  const { root, options } = await makeFieldEstate(dir, OPTIONS);
  const cold = await buildAndWrite(root, { command: "atticus catalog build" });
  expect(cold.guard.refused).toBeUndefined();
  const files: Map<string, string>[] = [];
  const said: Said[] = [];
  const step = async (s: Said) => {
    said.push({ code: s.code, ...(s.refused ? { refused: s.refused } : {}) });
    // The caches after the result end before the files are read (a next Apply waits so too).
    await settleAfterResult();
    files.push(await tree(root));
  };
  await changeRepo(root, options, 1, 2);
  await step(await apply(root));
  await changeRepo(root, options, 1, 3);
  await step(await apply(root));
  for (const [, change] of CHANGES) await change(root, options);
  await changeRepo(root, options, 1, 4);
  const refused = await apply(root);
  await step(refused);
  // Confirmed with the count it listed: the hand edit discarded.
  await step(await apply(root, 1));
  await changeRepo(root, options, 1, 6);
  await step(await apply(root));
  return { files, said };
}

describe("one repo's Apply in the app's server and as commands (ADR 0205 step 4)", () => {
  it("gives the same bytes and says the same, with a facts file, the org pack, a curated decision and a hand edit changed between", async () => {
    // The app's side: one server, its memory on, every Apply through its route.
    const fromMemory = buildCacheStats().textsFromMemory;
    let server: RunningServer | undefined;
    let lastPlan: string | undefined;
    const app = await steps(async (root, confirm) => {
      if (!server) {
        server = await startServer({
          root,
          port: 0,
          user: "pat",
          version: "1.0.0",
          extend: (r, ctx) => extendUiRoutes(r, ctx),
        });
        servers.push(server);
      }
      expect(appMemory.on, "the server keeps its caches in memory").toBe(true);
      const s = server;
      const call = async (path: string, method = "GET", body?: unknown) => {
        const r = await fetch(s.url + path, {
          method,
          headers: {
            "X-Atticus-Token": s.token,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        return (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a route's JSON, read loosely
      };
      const started = await call(
        `/api/facts/${REPO}/apply`,
        "POST",
        confirm !== undefined ? { discardEdits: confirm, plan: lastPlan } : {},
      );
      expect(started.jobId, JSON.stringify(started)).toBeDefined();
      for (let n = 0; n < 4000; n++) {
        const j = await call(`/api/jobs/${String(started.jobId)}`);
        if (j.state !== "running" && j.state !== "queued") {
          const refused = j.result?.refused as { reasons?: string[]; plan?: string } | undefined;
          lastPlan = refused?.plan;
          return {
            code: Number(j.result?.code),
            ...(refused?.reasons ? { refused: refused.reasons } : {}),
          };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("the Apply didn't end");
    });
    await server?.close();
    expect(appMemory.on).toBe(false);
    // The server's Applies took the last build's texts from its memory.
    expect(buildCacheStats().textsFromMemory - fromMemory).toBeGreaterThanOrEqual(2);

    // The commands' side: nothing in memory between them.
    forgetFactsParses();
    const was = buildCacheStats().textsFromMemory;
    const cmd = await steps(async (root, confirm) => {
      const lines: string[] = [];
      const code = await main(
        [
          "verify",
          REPO,
          "--write",
          "--json",
          "--root",
          root,
          ...(confirm !== undefined ? ["--discard-edits", String(confirm)] : []),
        ],
        { out: (l) => lines.push(l), err: () => undefined },
      );
      let refused: string[] | undefined;
      try {
        refused = (JSON.parse(lines.join("\n")) as { refused?: { reasons?: string[] } }).refused
          ?.reasons;
      } catch {
        refused = undefined;
      }
      return { code, ...(refused ? { refused } : {}) };
    });
    expect(buildCacheStats().textsFromMemory - was, "nothing kept in memory by a command").toBe(0);

    expect(app.said).toEqual(cmd.said);
    // The steps did what they say: two written, one refused for the hand edit, confirmed, one more.
    expect(app.said.map((s) => s.code)).toEqual([0, 0, 1, 0, 0]);
    expect(app.said[2]!.refused).toContain("hand-edits");
    for (let k = 0; k < app.files.length; k++) {
      const [a, b] = [app.files[k]!, cmd.files[k]!];
      expect([...a.keys()].sort(), `step ${k}: the same files`).toEqual([...b.keys()].sort());
      for (const [p, text] of b)
        if (a.get(p) !== text) expect(`${a.get(p)}`, `step ${k}: ${p}`).toBe(text);
    }
    // And each change was seen: every step changed the catalog from the one before.
    for (let k = 1; k < app.files.length; k++)
      if (k !== 2) expect(app.files[k]).not.toEqual(app.files[k - 1]);
  }, 900_000);
});
