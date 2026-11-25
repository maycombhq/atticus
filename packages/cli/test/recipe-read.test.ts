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
  loadOrgPack,
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
import { effectiveRules, typeRecipes } from "../src/reading-rules.js";

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
function metarepo(o: { walletsType?: string; layer?: string; rules?: string } = {}): string {
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
          `  - { id: ${id}, url: https://git.example.com/forge/${id}.git, type: ${id === WALLETS ? (o.walletsType ?? "integration-module") : "integration-module"}, owner: team-payments }`,
      ),
      "",
    ].join("\n"),
  );
  write(
    root,
    `org-pack/reading-rules/${o.layer ?? "types/integration-module.yaml"}`,
    o.rules ?? activeRules(),
  );
  return root;
}
/** A checkout of the ledger module, changed by `edit`. */
function checkout(edit?: (dir: string) => void): string {
  const dir = temp("repo");
  cpSync(join(FIX, "repos", LEDGER), dir, { recursive: true });
  edit?.(dir);
  return dir;
}
/** Facts on file before the read: the ledger module's hand-written entries, and more. */
const onFile = (root: string, more: object[] = []) =>
  write(
    root,
    `facts/${LEDGER}.jsonl`,
    [
      ...readFileSync(join(FIX, "facts", `${LEDGER}.jsonl`), "utf8")
        .trim()
        .split("\n"),
      ...more.map((f) => JSON.stringify(f)),
    ].join("\n") + "\n",
  );
const BEANS = "src/main/resources/OSGI-INF/blueprint/beans.xml";

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
  return {
    root,
    code,
    prompts,
    out,
    err,
    facts: facts.facts,
    said: prompts.map((p) => p.pack.prompt).join("\n"),
  };
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

describe("a recipe's proof holds for what was proven (review of item 7)", () => {
  const draftedWhy = async (root: string) => {
    const e = await effectiveRules(root, LEDGER, { dir: checkout() });
    return {
      drafts: e.drafts.map((r) => r.key).sort(),
      problems: e.problems.join("\n"),
    };
  };
  it("a recipe edited after its proof is a draft again, and that is said", async () => {
    const edited = activeRules().replace("optional:\n        - uri", "optional: []");
    expect(edited).not.toBe(activeRules());
    const r = await draftedWhy(metarepo({ rules: edited }));
    expect(r.drafts).toEqual(["blueprint-rest-entries"]);
    expect(r.problems).toMatch(/blueprint-rest-entries .*changed since its proof/);
  });
  it("the app's view lists each recipe, proven or a draft and why", async () => {
    const edited = activeRules().replace("optional:\n        - uri", "optional: []");
    const root = metarepo({ rules: edited });
    const op = await loadOrgPack(join(root, "org-pack"));
    expect(
      (await typeRecipes(root, op)).map((r) => [r.key, r.fact, r.proven, r.why ?? ""]),
    ).toEqual([
      ["blueprint-rest-entries", "entry", false, "has changed since its proof"],
      ["deploy-settings", "config", true, ""],
    ]);
  });

  it("a proof on a repo of another type proves nothing for this one", async () => {
    const r = await draftedWhy(metarepo({ walletsType: "gateway-proxy" }));
    expect(r.drafts).toEqual(["blueprint-rest-entries", "deploy-settings"]);
    expect(r.problems).toMatch(/forge-wallets-module, which isn't of type integration-module/);
  });
  it("a recipe reads type-wide only from its type's layer", async () => {
    const r = await draftedWhy(metarepo({ layer: "org.yaml" }));
    expect(r.drafts).toEqual(["blueprint-rest-entries", "deploy-settings"]);
    expect(r.problems).toMatch(/reads only from reading-rules\/types\/<type>\.yaml/);
  });
});

describe("what the model is still given (review of item 7)", () => {
  it("a file a recipe names but writes nothing from goes to the model", async () => {
    const r = await read(
      metarepo(),
      checkout((d) =>
        write(d, BEANS, '<blueprint>\n  <bean id="audit" class="forge.Audit"/>\n</blueprint>\n'),
      ),
    );
    expect(r.out[0]).toBe("Read by recipe 3 files, by the model 1 file.");
    expect(r.said).toContain('<bean id="audit"');
  });

  it("a route file whose last read had calls goes to the model whole, and the recipe writes nothing there", async () => {
    const root = metarepo();
    onFile(root, [
      {
        kind: "call",
        id: "call.direct.ledger-account",
        repo: LEDGER,
        commit: COMMIT,
        callType: "rest",
        method: "GET",
        path: "direct:getLedgerAccount",
        cite: {
          file: XML,
          line: 7,
          value: "direct:getLedgerAccount",
          quote: '<to uri="direct:getLedgerAccount"/>',
        },
        verified: "line",
        by: "assistant",
        conf: "declared",
      },
    ]);
    const r = await read(root, checkout());
    expect(r.out[0]).toBe("Read by recipe 2 files, by the model 1 file.");
    expect(r.said).toContain('<rest path="/accounts">');
    expect(r.facts.filter((f) => f.kind === "entry" && f.by === "reader")).toEqual([]);
  });

  it("a repo the model read before gets one entry a line, the recipe's", async () => {
    const root = metarepo();
    onFile(root);
    const r = await read(root, checkout());
    expect(r.prompts).toEqual([]);
    const entries = r.facts.filter((f) => f.kind === "entry");
    expect(entries.map((f) => `${f.cite.line} ${f.by}`).sort()).toEqual([
      "14 reader",
      "6 reader",
      "9 reader",
    ]);
  });

  it("a recipe whose key is renamed replaces its facts, leaving none under the old key", async () => {
    const root = metarepo();
    const dir = checkout();
    await read(root, dir);
    const file = join(root, "org-pack/reading-rules/types/integration-module.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("key: blueprint-rest-entries", "key: camel-rest"),
    );
    const r = await read(root, dir);
    const entries = r.facts.filter((f) => f.kind === "entry");
    expect(entries).toHaveLength(3);
    expect(entries.every((f) => f.id.startsWith("entry.camel-rest."))).toBe(true);
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
