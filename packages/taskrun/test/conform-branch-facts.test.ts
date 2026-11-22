import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { factsDirOf, parseFacts, stateDirOf } from "@maycombhq/core";
import { sourcesDirOf, writeFactsSlot } from "@maycombhq/scanner";
import { conformChange } from "../src/index.js";
import { CHANGE, git, sh, speckitRoot, worktree } from "./helpers.js";

/**
 * ADR 0206 as built, end to end with no scan injected: the branch's facts, written by the
 * assistant to `conform/facts/<repo>.jsonl` in the change folder, are verified against a detached
 * checkout of the branch's commit (a fact whose host or value isn't on its line is refused), cover
 * the files they cite (a fact of the snapshot citing such a file gives way to them), leave unread
 * what they don't cover, are read for the branch's commit only (never verified at the base), and
 * are never written to the catalog, the facts files or a snapshot; the checkout is removed and
 * nothing is left under .index/conform. Real git on local folders; no network. The Forge names
 * are invented.
 */

const T = 300_000;
const CHANGES = `openspec/changes/${CHANGE}`;

const OPERATIONS = `schemaVersion: 1
change: ${CHANGE}
operations:
  - id: deploy-anvil
    kind: deployment
    repos: [forge-ledger]
    what: Deploy the ledger on Anvil.
    sets: { platform: anvil, env: prod }
  - id: route-anvil
    kind: route
    repos: [forge-ledger]
    what: Serve the ledger at its Anvil host.
    sets: { host: ledger.anvil.forge.example }
  - id: retry
    kind: config
    repos: [forge-ledger]
    what: Keep five retries on Anvil.
    sets: { key: ledger.retry.max, env: prod }
  - id: northwind
    kind: config
    repos: [forge-ledger]
    what: Keep the Northwind address.
    sets: { key: northwind.url }
`;

const ANVIL = [
  "kind: Service",
  "name: ledger-anvil",
  "platform: anvil",
  "env: prod",
  "host: ledger.anvil.forge.example",
  "",
].join("\n");

/**
 * The branch's facts the assistant wrote: two true, two that lie about their line. `exposes`
 * for a repo whose facts serve nothing (nobody read it before): the verifier asks a deployment's
 * host there to name what it reaches.
 */
const branchFacts = (commit: string, exposes = false) =>
  [
    {
      repo: "forge-ledger",
      commit,
      conf: "declared",
      kind: "deploy",
      id: "d-1",
      env: "prod",
      platform: "anvil",
      resourceName: "ledger-anvil",
      host: "ledger.anvil.forge.example",
      ...(exposes ? { exposes: "ledger-api" } : {}),
      cite: {
        file: "deploy/anvil.yaml",
        line: 2,
        value: "ledger-anvil",
        quote: "name: ledger-anvil",
        with: [
          { file: "deploy/anvil.yaml", line: 3, value: "anvil" },
          { file: "deploy/anvil.yaml", line: 4, value: "prod" },
          { file: "deploy/anvil.yaml", line: 5, value: "ledger.anvil.forge.example" },
        ],
      },
    },
    // Lies: its host is on no line it cites.
    {
      repo: "forge-ledger",
      commit,
      conf: "declared",
      kind: "deploy",
      id: "d-2",
      env: "prod",
      platform: "anvil",
      resourceName: "ledger-anvil",
      host: "orders.anvil.forge.example",
      ...(exposes ? { exposes: "ledger-api" } : {}),
      cite: {
        file: "deploy/anvil.yaml",
        line: 2,
        value: "ledger-anvil",
        quote: "name: ledger-anvil",
      },
    },
    // Lies: its line sets 5.
    {
      repo: "forge-ledger",
      commit,
      conf: "declared",
      kind: "config",
      id: "k-9",
      settingKind: "retry",
      key: "ledger.retry.max",
      env: "prod",
      value: "9",
      cite: {
        file: "deploy/values-prod.yaml",
        line: 1,
        value: "ledger.retry.max",
        quote: "ledger.retry.max: 5",
      },
    },
    // Read again on the branch: it gives way to the snapshot's fact citing the same file.
    {
      repo: "forge-ledger",
      commit,
      conf: "declared",
      kind: "config",
      id: "k-b",
      settingKind: "config",
      key: "northwind.url",
      value: "https://api.northwind.example",
      cite: {
        file: "src/main/resources/application.yml",
        line: 2,
        value: "url",
        quote: "  url: https://api.northwind.example",
      },
    },
  ]
    .map((f) => JSON.stringify(f))
    .join("\n") + "\n";

/** Every file under a folder with its hash, for "nothing written here". */
async function hashes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p, r);
      else
        out[r] = createHash("sha256")
          .update(await readFile(p))
          .digest("hex");
    }
  };
  await walk(dir, "");
  return out;
}

/** The metarepo, the change's operations, a commit on its branch, and the branch's facts. */
async function setup(o: { snapshot?: boolean; facts?: (commit: string) => string } = {}) {
  const { root } = await speckitRoot({ repos: ["forge-ledger"] });
  const base = join(root, "workspace/forge-ledger");
  const main = sh(base, "rev-parse", "HEAD");
  if (o.snapshot) {
    // The snapshot `verify --write` took at the base: an endpoint the ledger serves (so a
    // deployment's host on the branch needs no exposes), and the Northwind address, cited in a
    // file the branch's facts read again.
    const common = { repo: "forge-ledger", commit: main, verified: "line", by: "assistant" };
    const entry = {
      ...common,
      conf: "declared",
      kind: "entry",
      id: "e-0",
      entryType: "rest",
      method: "GET",
      path: "/accounts/{id}/balance",
      cite: {
        file: "src/main/java/forge/ledger/LedgerEndpoints.java",
        line: 8,
        value: "/accounts/{id}/balance",
        quote: '  @ForgeEndpoint(method = "GET", path = "/accounts/{id}/balance", auth = "oauth2")',
      },
    };
    const parsed = parseFacts(
      JSON.stringify(entry) +
        "\n" +
        JSON.stringify({
          repo: "forge-ledger",
          commit: main,
          verified: "line",
          by: "assistant",
          conf: "declared",
          kind: "config",
          id: "k-0",
          settingKind: "config",
          key: "northwind.url",
          value: "https://api.northwind.example",
          cite: {
            file: "src/main/resources/application.yml",
            line: 2,
            value: "url",
            quote: "  url: https://api.northwind.example",
          },
        }) +
        "\n",
    );
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    await writeFactsSlot(root, {
      repo: "forge-ledger",
      commit: main,
      facts: parsed.facts,
      contracts: null,
    });
  }
  await mkdir(join(root, CHANGES, "target-flows"), { recursive: true });
  await writeFile(join(root, CHANGES, "target-flows/_operations.yaml"), OPERATIONS);
  const wt = worktree(root, "forge-ledger");
  await mkdir(join(wt, "deploy"), { recursive: true });
  await writeFile(join(wt, "deploy/anvil.yaml"), ANVIL);
  await writeFile(join(wt, "deploy/values-prod.yaml"), "ledger.retry.max: 5\n");
  sh(wt, "add", "-A");
  sh(wt, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "anvil");
  const commit = sh(wt, "rev-parse", "HEAD");
  await mkdir(join(root, CHANGES, "conform/facts"), { recursive: true });
  await writeFile(
    join(root, CHANGES, "conform/facts/forge-ledger.jsonl"),
    (o.facts ?? ((c: string) => branchFacts(c, !o.snapshot)))(commit),
  );
  return { root, base, main, commit };
}

const fetched: string[] = [];
beforeEach(() => {
  fetched.length = 0;
  vi.stubGlobal("fetch", (u: unknown) => {
    fetched.push(String(u));
    return Promise.reject(new Error("no network in tests"));
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("the branch's facts, verified at its commit (ADR 0206 as built)", () => {
  it(
    "verifies them in a detached checkout of the branch's commit, refuses the ones that lie, and writes nothing to the catalog",
    async () => {
      const { root, base, commit } = await setup();
      const catalog = await hashes(join(root, "catalog"));
      const facts = await hashes(factsDirOf(root));
      const state = await hashes(join(sourcesDirOf(root), "facts"));
      const run = await conformChange(root, CHANGE, {
        repo: "forge-ledger",
        git,
        now: "2026-11-22T09:00:00Z",
      });
      const r = run.results[0]!;
      expect(r.commit).toBe(commit);
      const by = (op: string) => r.claims!.find((c) => c.from.operation === op)!;
      expect(by("deploy-anvil").outcome).toBe("present");
      expect(by("deploy-anvil").why).toBe("Written on the cited lines: platform anvil, env prod.");
      expect(by("deploy-anvil").at).toEqual([
        { source: "code", repo: "forge-ledger", path: "deploy/anvil.yaml", line: 2 },
      ]);
      expect(by("route-anvil").outcome).toBe("present");
      expect(by("route-anvil").fact).toBe("d-1");
      // The lying facts are said and never used.
      const refused = r.problems.filter((p) => p.startsWith("conform/facts/forge-ledger.jsonl"));
      expect(refused.map((p) => p.split(":")[1]!.trim())).toEqual(["d-2", "k-9"]);
      expect(JSON.stringify(r.claims)).not.toContain("orders.anvil.forge.example");
      // The checkout is gone and nothing is left under .index/conform.
      expect(sh(base, "worktree", "list", "--porcelain")).not.toContain("detached");
      expect(
        await readdir(join(stateDirOf(root), ".index", "conform")).catch(() => [] as string[]),
      ).toEqual([]);
      // Never the catalog, the facts files or a snapshot.
      expect(await hashes(join(root, "catalog"))).toEqual(catalog);
      expect(await hashes(factsDirOf(root))).toEqual(facts);
      expect(await hashes(join(sourcesDirOf(root), "facts"))).toEqual(state);
      expect(existsSync(join(factsDirOf(root), "forge-ledger.jsonl"))).toBe(false);
      expect(fetched).toEqual([]);
    },
    T,
  );

  it(
    "a repo nobody read stays unread where its branch facts don't reach: what they don't cover couldn't be confirmed, never missing",
    async () => {
      const { root } = await setup();
      const r = (
        await conformChange(root, CHANGE, {
          repo: "forge-ledger",
          git,
          now: "2026-11-22T09:00:00Z",
        })
      ).results[0]!;
      const retry = r.claims!.find((c) => c.from.operation === "retry")!;
      // values-prod.yaml:1 sets it; the only fact citing it was refused, so no fact covers it.
      expect(retry.outcome).toBe("unconfirmed");
      expect(retry.what).toContain("deploy/values-prod.yaml");
      expect(r.claims!.filter((c) => c.outcome === "missing")).toEqual([]);
    },
    T,
  );

  it(
    "with a snapshot at the base: the branch's facts take the place of its facts citing the files they cover, and unread loses those files",
    async () => {
      const { root } = await setup({ snapshot: true });
      const r = (
        await conformChange(root, CHANGE, {
          repo: "forge-ledger",
          git,
          now: "2026-11-22T09:00:00Z",
        })
      ).results[0]!;
      const by = (op: string) => r.claims!.find((c) => c.from.operation === op)!;
      expect(by("northwind").outcome).toBe("present");
      expect(by("northwind").fact).toBe("k-b");
      expect(by("deploy-anvil").outcome).toBe("present");
      // deploy/anvil.yaml is covered; deploy/values-prod.yaml, whose fact was refused, isn't.
      const retry = by("retry");
      expect(retry.outcome).toBe("unconfirmed");
      expect(retry.what).toBe(
        "Atticus couldn't confirm that forge-ledger sets ledger.retry.max in prod: no fact covers deploy/values-prod.yaml, which changed since forge-ledger was read.",
      );
    },
    T,
  );

  it(
    "reads the branch's facts for the branch's commit only, never verifying them at the base",
    async () => {
      const { root } = await setup({ snapshot: true });
      const r = (
        await conformChange(root, CHANGE, {
          repo: "forge-ledger",
          git,
          now: "2026-11-22T09:00:00Z",
        })
      ).results[0]!;
      expect(r.problems.filter((p) => /, not at /.test(p))).toEqual([]);
      expect(
        r.problems.filter((p) => p.startsWith("conform/facts/forge-ledger.jsonl")),
      ).toHaveLength(2);
    },
    T,
  );
});
