import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { BUILD_MANIFEST_READS, buildManifestPath } from "@maycombhq/scanner";
import { startServer, type RunningServer } from "@maycombhq/server";
import { canAsk } from "../src/ask.js";
import { main } from "../src/main.js";
import { EXTENSION_NEEDS, standing, STANDING_WORDS } from "../src/standing.js";
import { extendUiRoutes } from "../src/ui-commands.js";
import { VERSION } from "../src/version.js";
import { seedForgeField, stampWith } from "./forge-field.js";

/**
 * ADR 0202 point 8: `atticus status` says where a metarepo stands in one line, with the one
 * command to run; the same line ends every refusal; `--json` is what GET /api/status serves.
 * Invented Forge metarepo (CLAUDE.md rule 3); no network (rule 5).
 */

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge/metarepo");
const T = 240_000;
const made: string[] = [];
const servers: RunningServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
});

async function run(argv: string[], env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const kept = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  try {
    const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out, err };
  } finally {
    for (const [k, v] of Object.entries(kept))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

/** The Forge metarepo, upgraded by this Atticus: stamped, nothing waiting. */
async function upToDate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b30-st-standing-"));
  made.push(root);
  await cp(FORGE, root, { recursive: true });
  const r = await run(["upgrade", "--root", root, "--by", "pat"]);
  expect(r.code, r.err.join("\n")).toBe(0);
  return root;
}
const stampOf = (root: string) => join(root, ".atticus", "metarepo.yaml");
async function stampAt(root: string, atticus: string) {
  const text = await readFile(stampOf(root), "utf8");
  await writeFile(stampOf(root), text.replace(/^atticus: .*$/m, `atticus: ${atticus}`));
}
/** A build.json one version past this Atticus's, naming its Atticus or not. */
const newerManifest = (atticus?: string) =>
  `${JSON.stringify(
    {
      version: BUILD_MANIFEST_READS + 1,
      ...(atticus ? { atticus } : {}),
      buildVersion: "3.0.0",
      sources: {},
      sourceSets: {},
      files: [],
    },
    null,
    2,
  )}\n`;
async function newerCatalog(root: string, atticus?: string) {
  await mkdir(dirname(buildManifestPath(root)), { recursive: true });
  await writeFile(buildManifestPath(root), newerManifest(atticus));
}
const NO_EXT = { [EXTENSION_NEEDS]: undefined };
/** A Git user for one run, whatever the machine's own Git config holds. */
const A_GIT_USER = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "user.name",
  GIT_CONFIG_VALUE_0: "Pat",
  GIT_CONFIG_KEY_1: "user.email",
  GIT_CONFIG_VALUE_1: "pat@example.com",
};

describe("atticus status: the five states, each with one command", () => {
  it(
    "up-to-date: nothing to do, exit 0",
    async () => {
      const root = await upToDate();
      const r = await run(["status", "--root", root], NO_EXT);
      expect(r).toEqual({
        code: 0,
        err: [],
        out: [
          `You are on Atticus ${VERSION}. This metarepo is at ${VERSION} (.atticus/metarepo.yaml), and it has no catalog yet. Nothing to do.`,
        ],
      });
      const j = await run(["status", "--json", "--root", root], NO_EXT);
      expect(j.code).toBe(0);
      expect(JSON.parse(j.out.join("\n"))).toEqual({
        atticus: VERSION,
        state: "up-to-date",
        stamp: VERSION,
        catalog: "none",
        pendingSteps: 0,
        line: r.out[0],
      });
    },
    T,
  );

  it(
    "metarepo-behind: no stamp, an older stamp or a step that waits; Do: atticus upgrade, exit 1",
    async () => {
      const root = await upToDate();
      await stampAt(root, "2.0.0-beta.9");
      const older = await run(["status", "--root", root], NO_EXT);
      expect(older.code).toBe(1);
      expect(older.out).toEqual([
        `You are on Atticus ${VERSION}. This metarepo is at 2.0.0-beta.9 (.atticus/metarepo.yaml), and it has no catalog yet. Do: atticus upgrade`,
      ]);
      await rm(stampOf(root));
      const none = await standing(root, { env: {} });
      expect(none.state).toBe("metarepo-behind");
      expect(none.do).toBe("atticus upgrade");
      expect(none.line).toBe(
        `You are on Atticus ${VERSION}. This metarepo has no stamp yet, and it has no catalog yet. Do: atticus upgrade`,
      );
      expect(none).not.toHaveProperty("stamp");
      // A step that waits (this machine's ignore file is gone) is said under the line.
      const again = await upToDate();
      await rm(join(again, ".atticus", ".gitignore"));
      const waits = await run(["status", "--root", again], NO_EXT);
      expect(waits.code).toBe(1);
      expect(waits.out).toEqual([
        `You are on Atticus ${VERSION}. This metarepo is at ${VERSION} (.atticus/metarepo.yaml), and it has no catalog yet. Do: atticus upgrade`,
        "1 upgrade step waits.",
      ]);
    },
    T,
  );

  it(
    "atticus-behind: a newer or unreadable stamp, or an extension that needs a newer Atticus",
    async () => {
      const root = await upToDate();
      await stampAt(root, "9.1.0");
      const newer = await standing(root, { env: {} });
      expect(newer.state).toBe("atticus-behind");
      expect(newer.line).toBe(
        `You are on Atticus ${VERSION}. This metarepo is at 9.1.0 (.atticus/metarepo.yaml), and it has no catalog yet. Do: npm install -g @maycombhq/atticus@9.1.0`,
      );
      // The newer of the stamp's and the extension's.
      const both = await standing(root, { env: { [EXTENSION_NEEDS]: "9.2.0" } });
      expect(both.do).toBe("npm install -g @maycombhq/atticus@9.2.0");
      expect(both.extensionNeeds).toBe("9.2.0");
      expect(both.line).toContain(
        "and it has no catalog yet. The extension needs 9.2.0. Do: npm install",
      );
      const lower = await standing(root, { env: { [EXTENSION_NEEDS]: "9.0.0" } });
      expect(lower.do).toBe("npm install -g @maycombhq/atticus@9.1.0");
      // A stamp this Atticus can't read, naming no version: @beta.
      await writeFile(stampOf(root), "schemaVersion: 99\nforge: true\n");
      const unread = await standing(root, { env: {} });
      expect(unread.state).toBe("atticus-behind");
      expect(unread.stampUnread).toBe(true);
      expect(unread.line).toBe(
        `You are on Atticus ${VERSION}. This metarepo's stamp is one this Atticus can't read, and it has no catalog yet. Do: npm install -g @maycombhq/atticus@beta`,
      );
      // A name that isn't a version never goes into the command.
      await writeFile(stampOf(root), "schemaVersion: 99\natticus: 9.0.0; rm -rf ~\n");
      expect((await standing(root, { env: {} })).do).toBe("npm install -g @maycombhq/atticus@beta");
      // The extension alone: the metarepo is up to date, the Atticus is behind what it needs.
      const fine = await upToDate();
      const ext = await run(["status", "--root", fine], { [EXTENSION_NEEDS]: "9.3.0" });
      expect(ext.code).toBe(1);
      expect(ext.out).toEqual([
        `You are on Atticus ${VERSION}. This metarepo is at ${VERSION} (.atticus/metarepo.yaml), and it has no catalog yet. The extension needs 9.3.0. Do: npm install -g @maycombhq/atticus@9.3.0`,
      ]);
      // What the extension needs is said, and changes nothing, when this Atticus has it.
      const has = await run(["status", "--root", fine], { [EXTENSION_NEEDS]: "2.0.0-beta.9" });
      expect(has.code).toBe(0);
      expect(has.out[0]).toMatch(/The extension needs 2\.0\.0-beta\.9\. Nothing to do\.$/);
      // A value that isn't a version is not said at all.
      const bad = await run(["status", "--root", fine], { [EXTENSION_NEEDS]: "$(forge)" });
      expect(bad.code).toBe(0);
      expect(bad.out[0]).not.toContain("extension");
    },
    T,
  );

  it(
    "catalog-newer: a build.json a newer Atticus wrote comes first, with its exact version when it names it",
    async () => {
      const root = await upToDate();
      // Even with a newer stamp: the catalog decides first.
      await stampAt(root, "9.1.0");
      await newerCatalog(root);
      const r = await run(["status", "--root", root], NO_EXT);
      expect(r.code).toBe(1);
      expect(r.out).toEqual([
        `You are on Atticus ${VERSION}. This metarepo is at 9.1.0 (.atticus/metarepo.yaml), and its catalog was built by a newer Atticus. Do: npm i -g @maycombhq/atticus@beta`,
      ]);
      await newerCatalog(root, "9.4.0");
      const named = await standing(root, { env: {} });
      expect(named).toMatchObject({
        state: "catalog-newer",
        catalog: "newer",
        catalogBuiltBy: "9.4.0",
        do: "npm install -g @maycombhq/atticus@9.4.0",
      });
      expect(named.line).toBe(
        `You are on Atticus ${VERSION}. This metarepo is at 9.1.0 (.atticus/metarepo.yaml), and its catalog was built by Atticus 9.4.0. Do: npm install -g @maycombhq/atticus@9.4.0`,
      );
      // The refusal over a catalog of 9.0.5, with the stamp at 9.1.0 and the extension needing
      // 9.2.0, defers to the newest: the one command shown is 9.2.0's, in the refusal's words and
      // in the line after it.
      await newerCatalog(root, "9.0.5");
      const deferred = await run(["catalog", "build", "--root", root], {
        [EXTENSION_NEEDS]: "9.2.0",
      });
      expect(deferred.code).toBe(1);
      expect(deferred.err.join("\n")).toContain(
        "built by Atticus 9.0.5 (build.json version 3; this Atticus reads up to 2): install Atticus 9.2.0, the newest one needed here",
      );
      expect(new Set(deferred.err.join("\n").match(/npm install -g [^\s),]+/g))).toEqual(
        new Set(["npm install -g @maycombhq/atticus@9.2.0"]),
      );
      // Three versions behind at once: the newest one needed is named, once, whichever it is.
      await newerCatalog(root, "9.0.5");
      const three = await standing(root, { env: { [EXTENSION_NEEDS]: "9.2.0" } });
      expect(three.state).toBe("catalog-newer");
      expect(three.do).toBe("npm install -g @maycombhq/atticus@9.2.0");
      expect(three.line.match(/npm install/g)).toHaveLength(1);
      await stampAt(root, "9.7.0");
      expect((await standing(root, { env: { [EXTENSION_NEEDS]: "9.2.0" } })).do).toBe(
        "npm install -g @maycombhq/atticus@9.7.0",
      );
    },
    T,
  );

  it("no-metarepo: atticus init, or cd metarepo in a sandbox; exit 1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "b30-st-none-"));
    made.push(dir);
    const r = await run(["status", "--root", dir], NO_EXT);
    expect(r).toEqual({
      code: 1,
      err: [],
      out: [
        `You are on Atticus ${VERSION}. This folder isn't an Atticus metarepo. Do: atticus init . --platform <platform>`,
      ],
    });
    // Inside something else (a repository, say) the folder is the person's to choose.
    const repo = await mkdtemp(join(tmpdir(), "b30-st-none-"));
    made.push(repo);
    await mkdir(join(repo, ".git"));
    expect((await standing(repo, { env: {} })).do).toBe(
      "atticus init <folder> --platform <platform>, in a folder of your choice",
    );
    await mkdir(join(dir, "metarepo", "org-pack"), { recursive: true });
    const sandbox = await standing(dir, { env: {} });
    expect(sandbox.state).toBe("no-metarepo");
    expect(sandbox.line).toBe(
      `You are on Atticus ${VERSION}. This folder isn't an Atticus metarepo. Do: cd metarepo`,
    );
    // Nothing was written into a folder that is no metarepo.
    await expect(readFile(join(dir, ".atticus", "logs", "atticus.log"))).rejects.toThrow();
  });

  it(
    "a catalog this Atticus reads is said so",
    async () => {
      const root = await upToDate();
      const r = await run(["catalog", "build", "--root", root]);
      expect(r.code, r.err.join("\n")).toBe(0);
      const s = await standing(root, { env: {} });
      expect(s.catalog).toBe("read");
      expect(s.line).toContain(STANDING_WORDS.catalogRead);
    },
    T,
  );
});

describe("every refusal ends with the same line, on standard error (ADR 0202 point 8)", () => {
  it(
    "a catalog a newer Atticus built: build, scan, verify --write, edits, undo, upgrade and a guarded writer",
    async () => {
      const root = await upToDate();
      await newerCatalog(root, "9.4.0");
      const line = (await standing(root, { quick: true, env: {} })).line;
      expect(line).toContain("Do: npm install -g @maycombhq/atticus@9.4.0");
      for (const argv of [
        ["catalog", "build"],
        ["scan"],
        ["verify", "forge-ledger", "--write"],
        ["catalog", "edits", "--curate"],
        ["catalog", "undo"],
        ["upgrade"],
        ["questions", "answer", "q-1", "--option", "a"],
      ]) {
        const r = await run([...argv, "--root", root], NO_EXT);
        expect(r.code, argv.join(" ")).toBe(1);
        expect(r.err.at(-1), argv.join(" ")).toBe(line);
        // Said once, and the refusal's own words name the exact version too.
        expect(r.err.filter((l) => l === line)).toHaveLength(1);
        expect(r.err.join("\n")).toContain(
          "built by Atticus 9.4.0 (build.json version 3; this Atticus reads up to 2): install it (npm install -g @maycombhq/atticus@9.4.0)",
        );
      }
      // --json carries it as the refusal's `standing`, and the exact command in `newer`.
      const j = await run(["catalog", "build", "--json", "--root", root], NO_EXT);
      const refused = (JSON.parse(j.out.join("\n")) as { refused: Record<string, unknown> })
        .refused;
      expect(refused.standing).toBe(line);
      expect(refused.newer).toMatchObject([{ name: "build.json", atticus: "9.4.0" }]);
      expect(j.err.at(-1)).toBe(line);
    },
    T,
  );

  it(
    "a metarepo a newer Atticus upgraded: atticus upgrade refuses, then says what to install",
    async () => {
      const root = await upToDate();
      await stampAt(root, "9.1.0");
      // A person with a Git user, as on a developer's machine: on a runner with none, the note
      // that the OS user stands in comes first (ADR 0073), and isn't what this test is about.
      const r = await run(["upgrade", "--root", root], { ...NO_EXT, ...A_GIT_USER });
      expect(r.code).toBe(1);
      expect(r.err).toEqual([
        `This metarepo was upgraded by Atticus 9.1.0; this is ${VERSION}. Install 9.1.0 or later before working in it, so nothing it wrote is lost.`,
        `You are on Atticus ${VERSION}. This metarepo is at 9.1.0 (.atticus/metarepo.yaml), and it has no catalog yet. Do: npm install -g @maycombhq/atticus@9.1.0`,
      ]);
      const j = await run(["upgrade", "--json", "--root", root], NO_EXT);
      expect((JSON.parse(j.out.join("\n")) as { standing: string }).standing).toBe(r.err[1]);
    },
    T,
  );

  it(
    "a build refused over hand edits ends with it, and a command that doesn't refuse never says it",
    async () => {
      const root = await upToDate();
      expect((await run(["catalog", "build", "--root", root])).code).toBe(0);
      const ok = await run(["catalog", "build", "--root", root], NO_EXT);
      expect(ok.err.join("\n")).not.toContain("You are on Atticus");
      await writeFile(join(root, "catalog", "generated", "forge-hand.yaml"), "kind: System\n");
      const r = await run(["catalog", "build", "--root", root], NO_EXT);
      expect(r.code).toBe(1);
      expect(r.err.join("\n")).toContain("--discard-edits 1");
      // Everything is up to date: the refusal's own words are the way on, and nothing is
      // added after them ("…Nothing to do." under "discard them" read as a contradiction).
      expect(r.err.join("\n")).not.toContain("You are on Atticus");
      expect(r.err.at(-1)).toMatch(/--discard-edits 1/);
      const j = await run(["catalog", "build", "--json", "--root", root], NO_EXT);
      expect(
        (JSON.parse(j.out.join("\n")) as { refused: Record<string, unknown> }).refused,
      ).not.toHaveProperty("standing");
      // Behind, the same refusal does end with it.
      await stampAt(root, "2.0.0-beta.9");
      const behind = await run(["catalog", "build", "--root", root], NO_EXT);
      expect(behind.err.at(-1)).toBe(
        `You are on Atticus ${VERSION}. This metarepo is at 2.0.0-beta.9 (.atticus/metarepo.yaml), and this Atticus reads its catalog. Do: atticus upgrade`,
      );
    },
    T,
  );
});

describe("the refusals that had no line, and what the log keeps", () => {
  it(
    "catalog edits over a catalog not upgraded ends with it; the log names the command only",
    async () => {
      const root = await upToDate();
      await cp(join(FORGE, "..", "slots", "readers"), join(root, "catalog/sources/readers"), {
        recursive: true,
      });
      expect((await run(["catalog", "build", "--root", root])).code).toBe(0);
      // A catalog from before the slots: the build's files, with catalog/sources taken away.
      await rm(join(root, "catalog", "sources"), { recursive: true });
      await rm(join(root, ".index", "build-undo"), { recursive: true, force: true });
      const line = `You are on Atticus ${VERSION}. This metarepo is at ${VERSION} (.atticus/metarepo.yaml), and this Atticus reads its catalog. Do: atticus upgrade`;
      for (const argv of [
        ["catalog", "edits"],
        ["catalog", "edits", "--curate"],
      ]) {
        const r = await run([...argv, "--root", root], NO_EXT);
        expect(r.code, argv.join(" ")).toBe(1);
        expect(r.err.join("\n")).toContain("Nothing to curate");
        expect(r.err.at(-1), argv.join(" ")).toBe(line);
      }
      const j = await run(["catalog", "edits", "--json", "--root", root], NO_EXT);
      expect(
        (JSON.parse(j.out.join("\n")) as { refused: { standing: string } }).refused.standing,
      ).toBe(line);
      // The log: the command's words, never the folder given after --root.
      await run(["status", "--root", root], NO_EXT);
      await run(["doctor", "--counts", "--root", root], NO_EXT);
      const log = (await readFile(join(root, ".atticus", "logs", "atticus.log"), "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { command?: string });
      const commands = new Set(log.map((l) => l.command));
      expect(commands.has("status")).toBe(true);
      expect(commands.has("doctor")).toBe(true);
      expect(commands.has("catalog edits")).toBe(true);
      for (const c of commands) expect(c ?? "", c).not.toContain(root);
    },
    T,
  );

  it("a new metarepo's README under catalog/ is no catalog, and no step waits on it", async () => {
    const root = await upToDate();
    await mkdir(join(root, "catalog", "generated"), { recursive: true });
    await writeFile(join(root, "catalog", "generated", "README.md"), "# The catalog\n");
    const s = await standing(root, { env: {} });
    expect(s).toMatchObject({ state: "up-to-date", catalog: "none", pendingSteps: 0 });
  });
});

describe("GET /api/status is atticus status --json", () => {
  it(
    "serves the same view",
    async () => {
      const root = await upToDate();
      await stampAt(root, "2.0.0-beta.9");
      const server = await startServer({
        root,
        port: 0,
        user: "pat",
        version: "1.0.0",
        extend: (r, ctx) => extendUiRoutes(r, ctx),
      });
      servers.push(server);
      const kept = process.env[EXTENSION_NEEDS];
      delete process.env[EXTENSION_NEEDS];
      try {
        const res = await fetch(`${server.url}/api/status`, {
          headers: { "X-Atticus-Token": server.token },
        });
        expect(res.status).toBe(200);
        const j = await run(["status", "--json", "--root", root]);
        expect(await res.json()).toEqual(JSON.parse(j.out.join("\n")));
      } finally {
        if (kept !== undefined) process.env[EXTENSION_NEEDS] = kept;
      }
    },
    T,
  );
});

describe("when the command line may ask (ADR 0202 point 9)", () => {
  const tty = { stdinTTY: true, stdoutTTY: true, argv: ["upgrade"], env: {} };
  it("only at a terminal on both ends, without --json and without CI", () => {
    expect(canAsk(tty)).toBe(true);
    expect(canAsk({ ...tty, stdinTTY: false })).toBe(false);
    expect(canAsk({ ...tty, stdoutTTY: undefined })).toBe(false);
    expect(canAsk({ ...tty, argv: ["upgrade", "--json"] })).toBe(false);
    expect(canAsk({ ...tty, argv: ["upgrade", "--json=true"] })).toBe(false);
    expect(canAsk({ ...tty, env: { CI: "true" } })).toBe(false);
    expect(canAsk({ ...tty, env: { CI: "" } })).toBe(true);
  });
  it("never in an assistant's session, nor when the app or an editor started the command", () => {
    for (const env of [
      { ATTICUS_ACP_SESSION: "1" },
      { CURSOR_AGENT: "1" },
      { CLAUDECODE: "1" },
      { GEMINI_CLI: "1" },
      { ATTICUS_ASSISTANT: "forge-bot" },
      { ATTICUS_STARTED_BY: "vscode" },
      { ATTICUS_STARTED_BY: "intellij" },
    ])
      expect(canAsk({ ...tty, env }), JSON.stringify(env)).toBe(false);
    // A person's own terminal, also the one inside an editor, is asked.
    expect(canAsk({ ...tty, env: { ATTICUS_STARTED_BY: "terminal" } })).toBe(true);
    expect(canAsk({ ...tty, env: { TERM_PROGRAM: "vscode", CURSOR_AGENT: "0" } })).toBe(true);
  });
});

// Beta.30 (slice 9): the field-shaped estate (fixtures/forge-field), as a person seeds it: its
// stamp, its slots, a legacy slot, repos nobody cloned. Its status is one line, nothing to do.
describe("atticus status on the field-shaped estate", () => {
  it(
    "says it is up to date and reads its catalog, in one line, and serves the same as JSON",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "b30-fd-standing-"));
      made.push(dir);
      // Seeded as this Atticus upgrades it: the stamp is this Atticus's, whatever wrote the fixture.
      const e = await seedForgeField(dir);
      const r = await run(["status", "--root", e.root], NO_EXT);
      expect(r).toEqual({
        code: 0,
        err: [],
        out: [
          `You are on Atticus ${VERSION}. This metarepo is at ${VERSION} (.atticus/metarepo.yaml), and this Atticus reads its catalog. Nothing to do.`,
        ],
      });
      const j = await run(["status", "--json", "--root", e.root], NO_EXT);
      expect(JSON.parse(j.out.join("\n"))).toMatchObject({
        atticus: VERSION,
        state: "up-to-date",
        stamp: VERSION,
        line: r.out[0],
      });
      // An older stamp (a fixture written by an Atticus before a release): one line, upgrade.
      await stampWith(e.root, "2.0.0-beta.9");
      const older = await run(["status", "--root", e.root], NO_EXT);
      expect(older.code).toBe(1);
      expect(older.out).toEqual([
        `You are on Atticus ${VERSION}. This metarepo is at 2.0.0-beta.9 (.atticus/metarepo.yaml), and this Atticus reads its catalog. Do: atticus upgrade`,
      ]);
    },
    T,
  );
});
