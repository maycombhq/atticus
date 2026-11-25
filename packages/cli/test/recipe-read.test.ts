import {
  cpSync,
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
  factsDirOf,
  parseFacts,
  proveRecipe,
  ReadingRulesFile,
  runRecipe,
  type Fact,
  type RecipeFile,
} from "@maycombhq/core";
import { execFileSync } from "node:child_process";
import { main } from "../src/main.js";
import { mapAllCommand } from "../src/map-all.js";
import { mapCommand } from "../src/map-commands.js";
import { effectiveRules } from "../src/reading-rules.js";

/**
 * ADR 0210 part 2, "recipe first, model on request": a repo whose type has active recipes is
 * read by them with no model; their facts pass the verifier as a model's do; the model is given
 * only the files no recipe reads. On the invented `fixtures/gateway-shape` modules; the model is
 * a mock that records every prompt (rule 5).
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-shape");
const LEDGER = "forge-ledger-module";
const WALLETS = "forge-wallets-module";
const XML = "src/main/resources/OSGI-INF/blueprint/camel-context.xml";
const COMMIT = "5d6e7f8";
const temps: string[] = [];
const temp = (n: string) => {
  const d = mkdtempSync(join(tmpdir(), `atticus-recipe-${n}-`));
  temps.push(d);
  return d;
};
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

/** The fixture's two recipes, set active with their proofs on the two modules. */
function activeRules(): string {
  const file = ReadingRulesFile.parse(
    parse(
      readFileSync(
        join(FIX, "org-pack", "reading-rules", "types", "integration-module.yaml"),
        "utf8",
      ),
    ),
  );
  const repos = [WALLETS, LEDGER].map((repo) => ({
    repo,
    files: filesOf(join(FIX, "repos", repo)),
  }));
  const rules = file.rules.map((r) => {
    // The entries' proof is against the modules' hand-written facts; the settings' against what
    // the recipe reads (no hand-written settings): either is a proof on two repos.
    const reads = repos.map((x) => ({
      ...x,
      facts:
        r.extract?.fact === "entry"
          ? handFacts(x.repo)
          : runRecipe(r, x.files, { repo: x.repo, commit: COMMIT }).facts,
    }));
    const proof = proveRecipe(r, reads).proof;
    if (!proof) throw new Error(`${r.key} isn't proven`);
    return {
      ...r,
      status: "active",
      learned: { corrections: [], by: "recipe", at: "2026-11-24T10:00:00.000Z", proof },
    };
  });
  return stringify({ ...file, rules });
}

/** A Forge metarepo whose manifest makes the modules (and a third) integration modules. */
function metarepo(): string {
  const root = temp("meta");
  write(root, "org-pack/pack.yaml", "schemaVersion: 1\nname: forge\n");
  write(
    root,
    "org-pack/profiles/forge/repos.manifest.yaml",
    [
      "schemaVersion: 2",
      "platform: forge",
      "repos:",
      ...[LEDGER, WALLETS, "forge-cards-module"].map(
        (id) =>
          `  - { id: ${id}, url: https://git.example.com/forge/${id}.git, type: integration-module, owner: team-payments }`,
      ),
      "",
    ].join("\n"),
  );
  write(root, "org-pack/reading-rules/types/integration-module.yaml", activeRules());
  return root;
}
/** A checkout of the ledger module, changed by `edit`. */
function checkout(edit?: (dir: string) => void): string {
  const dir = temp("repo");
  cpSync(join(FIX, "repos", LEDGER), dir, { recursive: true });
  edit?.(dir);
  return dir;
}
async function read(root: string, dir: string, o: { runtime?: boolean } = {}) {
  const prompts: AiRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const runtime = new MockRuntime((r) => (prompts.push(r), ""));
  const code = await mapCommand(
    root,
    LEDGER,
    { commit: COMMIT, dir, maxTokens: 200_000 },
    io,
    o.runtime === false ? {} : { runtime },
  );
  const text = readFileSync(join(factsDirOf(root), `${LEDGER}.jsonl`), "utf8");
  const facts = parseFacts(text);
  if (!facts.ok) throw new Error(JSON.stringify(facts.issues));
  return { root, code, prompts, out, err, facts: facts.facts };
}
const shape = (f: Fact) => {
  const { verified: _v, ...rest } = f as Fact & { verified?: unknown };
  return JSON.parse(JSON.stringify(rest)) as unknown;
};

describe("recipe first (ADR 0210 part 2)", () => {
  it("holds an active recipe for every repo of its type, not only those its proof names", async () => {
    const e = await effectiveRules(metarepo(), "forge-cards-module", { dir: checkout() });
    expect(e.rules.map((r) => r.key).sort()).toEqual(["blueprint-rest-entries", "deploy-settings"]);
    expect(e.drafts).toEqual([]);
  });

  it("reads the gateway-shape module by its recipes alone: the golden facts, no prompt", async () => {
    const r = await read(metarepo(), checkout());
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.prompts).toEqual([]);
    expect(r.out[0]).toBe("Read by recipe 3 files, by the model 0 files.");
    // The entries are the engine's, as its golden file says; each passed the verifier.
    const golden = parse(
      readFileSync(join(FIX, "expected", "recipe-ledger.yaml"), "utf8"),
    ) as Fact[];
    const entries = r.facts.filter((f) => f.kind === "entry");
    const byId = (a: Fact, b: Fact) => (a.id < b.id ? -1 : 1);
    expect(entries.sort(byId).map(shape)).toEqual(golden.sort(byId).map(shape));
    expect(entries.every((f) => f.by === "reader")).toBe(true);
    // The deploy files' settings too, every leaf on its line.
    expect(
      r.facts
        .filter((f) => f.kind === "config")
        .map((f) => `${f.cite.file}:${f.cite.line}`)
        .sort(),
    ).toEqual([
      "deploy/prod.yaml:1",
      "deploy/prod.yaml:2",
      "deploy/prod.yaml:3",
      "deploy/test.yaml:1",
      "deploy/test.yaml:2",
      "deploy/test.yaml:3",
    ]);
  });

  it("with AI off, the recipes still read", async () => {
    const r = await read(metarepo(), checkout(), { runtime: false });
    expect(r.code).toBe(0);
    expect(r.facts.filter((f) => f.kind === "entry")).toHaveLength(3);
  });

  it("sends the model only the files no recipe reads, and plans only those", async () => {
    const r = await read(
      metarepo(),
      checkout((d) =>
        write(
          d,
          "src/main/java/forge/ledger/LedgerAudit.java",
          'package forge.ledger;\n\npublic class LedgerAudit {\n  static final String TOPIC = "forge.ledger.audit";\n}\n',
        ),
      ),
    );
    expect(r.out[0]).toBe("Read by recipe 3 files, by the model 1 file.");
    expect(r.prompts).toHaveLength(1);
    const prompt = r.prompts[0]!.pack.prompt;
    expect(prompt).toContain("LedgerAudit.java");
    expect(prompt).not.toContain("<rest path=");
    expect(prompt).not.toContain("ledger.prod.forge.example");
    // item 6's plan counts the model's part only: one session.
    expect(r.facts.filter((f) => f.kind === "entry")).toHaveLength(3);
  });

  it("rejects a recipe fact the verifier refuses, as it would a model's, and says why", async () => {
    const r = await read(
      metarepo(),
      checkout((d) => {
        const p = join(d, XML);
        const lines = readFileSync(p, "utf8").split("\n");
        // A verb only in a comment: the recipe's pattern matches it, the verifier doesn't take it.
        lines.splice(16, 0, '      <!-- <delete uri="/{statementId}/archive"/> -->');
        writeFileSync(p, lines.join("\n"));
      }),
    );
    expect(r.prompts).toEqual([]);
    expect(r.code).toBe(1);
    expect(r.out.join("\n")).toMatch(/By recipe: 9 facts kept, 1 rejected by the verifier/);
    expect(r.facts.some((f) => f.kind === "entry" && f.method === "DELETE")).toBe(false);
    const rejected = readFileSync(join(factsDirOf(r.root), `${LEDGER}.rejected.jsonl`), "utf8");
    expect(rejected).toContain("/{statementId}/archive");
  });

  it("map --all reads a repo its recipes read whole without a session, and says so", async () => {
    const root = metarepo();
    const dir = join(root, "workspace", LEDGER);
    cpSync(join(FIX, "repos", LEDGER), dir, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=forge", "-c", "user.email=forge@example.com", "commit", "-qm", "init");
    const prompts: AiRequest[] = [];
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
    const runtime = new MockRuntime((r) => (prompts.push(r), ""));
    await mapAllCommand(root, { repos: [LEDGER], mode: "model", maxTokens: 200_000 }, io, {
      runtime,
    });
    expect(prompts).toEqual([]);
    expect(out).toContain(`${LEDGER}: Read by recipe 3 files, by the model 0 files.`);
    expect(out.join("\n")).toMatch(/read by its recipes alone \(3 files\): nothing for the model/);
    const facts = parseFacts(readFileSync(join(factsDirOf(root), `${LEDGER}.jsonl`), "utf8"));
    expect(facts.ok && facts.facts.filter((f) => f.kind === "entry")).toHaveLength(3);
  });
});

describe("the deterministic readers, off by default (ADR 0210 part 6)", () => {
  const said = async (root: string) => {
    const err: string[] = [];
    await main(["dialect", "kit", join(temp("kit"), "kit"), "--root", root], {
      out: () => {},
      err: (l: string) => err.push(l),
    });
    return err;
  };
  it("dialect, frameworks and onboard say the readers are off and how to turn them on", async () => {
    const root = metarepo();
    expect(await said(root)).toContain(
      'The deterministic readers are off (ADR 0210): a repo is read by its recipe or by the model. An org pack turns them on with readers: "on" in conventions.yaml (schemaVersion: 3).',
    );
    write(root, "org-pack/conventions.yaml", 'schemaVersion: 3\nreaders: "on"\n');
    expect((await said(root)).join("\n")).not.toMatch(/readers are off/);
  });
});
