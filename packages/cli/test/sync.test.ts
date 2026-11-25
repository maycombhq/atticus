import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import {
  parseFacts,
  proveRecipe,
  ReadingRulesFile,
  runRecipe,
  type Fact,
  type RecipeFile,
} from "@maycombhq/core";
import { main } from "../src/main.js";
import { syncCommand, syncHooks } from "../src/sync-command.js";

/**
 * ADR 0210 part 8: `atticus sync` reads what changed (recipe, then model), verifies, writes once,
 * pairs and says what is open. On the invented `fixtures/gateway-shape` modules, each a clone with
 * its own commits; the model is a mock that records every prompt (rule 5).
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-shape");
const LEDGER = "forge-ledger-module";
const WALLETS = "forge-wallets-module";
const COMMIT = "5d6e7f8";
const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const filesOf = (dir: string): RecipeFile[] => {
  const out: RecipeFile[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: relative(dir, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") });
    }
  };
  walk(dir);
  return out;
};
const handFacts = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
/** The fixture's recipes, active with their proofs on the two modules. */
function activeRules(): string {
  const path = join(FIX, "org-pack", "reading-rules", "types", "integration-module.yaml");
  const file = ReadingRulesFile.parse(parse(readFileSync(path, "utf8")));
  const repos = [WALLETS, LEDGER].map((repo) => ({
    repo,
    files: filesOf(join(FIX, "repos", repo)),
  }));
  const rules = file.rules.map((r) => {
    const reads = repos.map((x) => ({
      ...x,
      facts:
        r.extract?.fact === "entry"
          ? handFacts(x.repo)
          : runRecipe(r, x.files, { repo: x.repo, commit: COMMIT }).facts,
    }));
    const proof = proveRecipe(r, reads).proof!;
    return {
      ...r,
      status: "active",
      learned: { corrections: [], by: "recipe", at: "2026-11-24T10:00:00.000Z", proof },
    };
  });
  return stringify({ ...file, rules });
}
const git = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=forge", "-c", "user.email=forge@example.com", ...a], {
    cwd: dir,
    stdio: "pipe",
  });
/** A Forge metarepo with both modules cloned under workspace/, each at its first commit. */
function metarepo(): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-sync-"));
  temps.push(root);
  write(root, "org-pack/pack.yaml", "schemaVersion: 1\nname: forge\n");
  write(
    root,
    "org-pack/profiles/forge/repos.manifest.yaml",
    [
      "schemaVersion: 2",
      "platform: forge",
      "repos:",
      ...[LEDGER, WALLETS].map(
        (id) =>
          `  - { id: ${id}, url: https://git.example.com/forge/${id}.git, type: integration-module, owner: team-payments }`,
      ),
      "",
    ].join("\n"),
  );
  write(root, "org-pack/reading-rules/types/integration-module.yaml", activeRules());
  for (const repo of [LEDGER, WALLETS]) {
    const dir = join(root, "workspace", repo);
    cpSync(join(FIX, "repos", repo), dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
  }
  return root;
}
/** The catalog's files and their text, to tell whether a run wrote any. */
const catalogOf = (root: string): Record<string, string> => {
  const dir = join(root, "catalog", "generated");
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    filesOf(dir).map((f) => [f.path, `${f.text}|${statSync(join(dir, f.path)).mtimeMs}`]),
  );
};
async function sync(root: string, o: { json?: boolean; ai?: boolean } = {}) {
  const prompts: AiRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const runtime = new MockRuntime((r) => (prompts.push(r), ""));
  const code = await syncCommand(
    root,
    { ...(o.json ? { json: true } : {}), maxTokens: 200_000 },
    io,
    o.ai === false ? {} : { runtime },
  );
  return { code, prompts, out: out.join("\n"), err: err.join("\n") };
}

describe("atticus sync (ADR 0210 part 8)", () => {
  it("reads only the repo whose commit changed, writes once, pairs and says what is open", async () => {
    const root = metarepo();
    const first = await sync(root);
    expect(first.code, first.err).toBe(0);
    expect(first.out).toContain(`Read: ${LEDGER} (by recipe), ${WALLETS} (by recipe).`);
    expect(Object.keys(catalogOf(root)).length).toBeGreaterThan(0);
    const dir = join(root, "workspace", LEDGER);
    write(
      dir,
      "deploy/prod.yaml",
      "service: forge-ledger-module\nhost: ledger2.prod.forge.example\nport: 8443\n",
    );
    git(dir, "commit", "-qam", "move the host");
    const before = catalogOf(root);
    const r = await sync(root);
    expect(r.code, r.err).toBe(0);
    expect(r.prompts).toEqual([]);
    expect(r.out).toContain(`Read: ${LEDGER} (by recipe).`);
    expect(r.out).not.toContain(WALLETS);
    expect(catalogOf(root)).not.toEqual(before);
    expect(r.out).toMatch(/^Written to the catalog once/m);
    expect(r.out).toMatch(/^Loose calls: none\.$/m);
    expect(r.out).toMatch(/^Rejected: none\.$/m);
    expect(r.out).toMatch(/^Next: /m);
    expect(r.out.match(/^Next: /gm)).toHaveLength(1);
  });

  it("after the write, Learn is given the repo types this sync read, and nothing when none", async () => {
    const root = metarepo();
    const told: string[][] = [];
    syncHooks.learn = async (_root, types) => void told.push(types);
    try {
      await sync(root);
      await sync(root);
    } finally {
      delete syncHooks.learn;
    }
    expect(told).toEqual([["integration-module"]]);
  });

  it("a second sync with nothing changed sends no prompt and writes nothing", async () => {
    const root = metarepo();
    expect((await sync(root)).code).toBe(0);
    const before = catalogOf(root);
    const r = await sync(root);
    expect(r.code).toBe(0);
    expect(r.prompts).toEqual([]);
    expect(r.out).toMatch(/^Up to date: every repo's facts are at its clone's commit\./);
    expect(catalogOf(root)).toEqual(before);
  });

  it("with AI off reads by recipe only, and what the model would read waits; nothing fails", async () => {
    const root = metarepo();
    const dir = join(root, "workspace", LEDGER);
    write(
      dir,
      "src/main/java/forge/ledger/LedgerAudit.java",
      'package forge.ledger;\n\npublic class LedgerAudit {\n  static final String TOPIC = "forge.ledger.audit";\n}\n',
    );
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "audit");
    const r = await sync(root, { ai: false });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`Waiting for the model (AI is off here): ${LEDGER}.`);
    expect(Object.keys(catalogOf(root)).length).toBeGreaterThan(0);
  });

  it("with AI on, the model reads what the recipes left, in map --all's read", async () => {
    const root = metarepo();
    const dir = join(root, "workspace", LEDGER);
    write(dir, "src/main/java/forge/ledger/LedgerAudit.java", "package forge.ledger;\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "audit");
    const r = await sync(root);
    expect(r.prompts.length).toBeGreaterThan(0);
    expect(r.out).toContain(`Read: ${LEDGER} (by model), ${WALLETS} (by recipe).`);
    expect(r.err).toContain("Read by recipe 3 files, by the model 1 file.");
  });

  it("--json says the same for CI", async () => {
    const root = metarepo();
    const out: string[] = [];
    const code = await main(
      ["sync", "--json", "--root", root],
      { out: (l) => out.push(l), err: () => undefined },
      { quiet: true },
    );
    expect(code).toBe(0);
    const j = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual(
      [
        "loose",
        "next",
        "open",
        "read",
        "rejected",
        "removed",
        "upToDate",
        "waiting",
        "written",
      ].sort(),
    );
    expect(j.read).toEqual([
      { repo: LEDGER, by: "recipe" },
      { repo: WALLETS, by: "recipe" },
    ]);
    expect(j).toMatchObject({ upToDate: false, written: true, loose: [], rejected: [] });
  });

  it("is the first command on help's first page; the other map commands are off it and still run", async () => {
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
    expect(await main(["help"], io, { quiet: true })).toBe(0);
    const firsts = out
      .join("\n")
      .split("\n")
      .map((l) => /^ {2}atticus ([a-z][a-z-]*)/.exec(l)?.[1])
      .filter(Boolean);
    expect(firsts[0]).toBe("sync");
    for (const off of ["map", "verify", "join"]) expect(firsts).not.toContain(off);
    out.length = 0;
    expect(await main(["help", "map"], io, { quiet: true })).toBe(0);
    expect(out.join("\n")).toContain("atticus map --all");
  });
});
