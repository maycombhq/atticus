import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPTIONS } from "@maycombhq/ai/cli-options";
import { switchValues } from "../src/flags.js";
import { main } from "../src/main.js";
import { initCommand } from "../src/setup-commands.js";

/**
 * Review round 47 (command line): every option is read with its own type before anything is
 * routed, so an option's value is never a command word (nor a command word an option's value),
 * and a switch written `--flag=true` or `--flag=false` means what it says.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ADOPT_FIXTURES = join(HERE, "../../adopt/test/fixtures");
const FIXTURES = join(HERE, "../../../fixtures");
const made: string[] = [];
afterAll(async () => {
  while (made.length) await rm(made.pop()!, { recursive: true, force: true });
});

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-r47-"));
  made.push(root);
  await initCommand(root, { name: "forge", platform: "forge" }, { out: () => {}, err: () => {} });
});

const run = async (args: string[], env: Record<string, string> = {}) => {
  const was = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const out: string[] = [];
  const err: string[] = [];
  try {
    const code = await main(
      args,
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      { quiet: true },
    );
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    for (const [k, v] of Object.entries(was))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
};

const SESSION = { ATTICUS_ACP_SESSION: "1" };

describe("a person's decision behind an option and its value, in a Copilot session", () => {
  it.each([
    ["questions", "--option", "1", "answer", "q1"],
    ["questions", "--text", "hi", "answer", "q1"],
    ["questions", "--state", "open", "sheet", "--apply", "f.csv"],
    ["verify", "--write", "audit", "forge-api", "--answers", "a.yaml"],
    ["questions", "--option", "1", "correct", "q1"],
    ["questions", "--text", "x", "owner", "q1"],
    // `--draft=false` is no draft: only a person sets a rule active.
    [
      "rules",
      "add",
      "--org-wide",
      "--key",
      "k1",
      "--rule",
      "Always cite the line",
      "--draft=false",
    ],
  ])("refuses %s …", async (...args) => {
    const r = await run([...args, "--root", root], SESSION);
    expect(r.code).toBe(2);
    expect(r.err).toContain(
      "This runs inside a Copilot session that Atticus started, so it is refused",
    );
  });

  it("still lets a session list the open questions", async () => {
    for (const args of [
      ["questions", "list", "--state", "open", "--json"],
      ["questions", "--state", "open", "list", "--json"],
    ]) {
      const r = await run([...args, "--root", root], SESSION);
      expect(r.err).not.toContain("so it is refused");
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({ questions: [] });
    }
  });
});

describe("a command after an option and its value", () => {
  it("is the command run, not a word nobody knows", async () => {
    for (const args of [
      ["questions", "--option", "1", "correct", "q1"],
      ["questions", "--text", "x", "owner", "q1"],
    ]) {
      const r = await run([...args, "--root", root]);
      expect(r.err).not.toMatch(/isn't a command/);
      expect(r.err).toMatch(/q1/);
    }
  });

  it("reads critic's --resume as the switch it is, so --gate keeps its value", async () => {
    const meta = await mkdtemp(join(tmpdir(), "atticus-r47-critic-"));
    made.push(meta);
    await initCommand(meta, { name: "forge", platform: "forge" }, { out: () => {}, err: () => {} });
    await cp(join(FIXTURES, "stages/changes"), join(meta, "openspec/changes"), {
      recursive: true,
    });
    const r = await run([
      "critic",
      "add-fraud-check",
      "--resume",
      "--gate",
      "design",
      "--root",
      meta,
    ]);
    expect(r.out).toContain("No AI lens of the design gate is waiting for your assistant.");
  });

  it("still gives ci snippet's --write its folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-r47-snippet-"));
    made.push(dir);
    const r = await run(["ci", "snippet", "github", "--write", dir]);
    expect(r.code).toBe(0);
    expect(await readFile(join(dir, ".github/workflows/atticus-drift.yml"), "utf8")).toContain(
      "ci drift",
    );
  });
});

describe("a switch written --flag=true or --flag=false", () => {
  it("is the switch, or no switch; anything else is refused", () => {
    expect(switchValues(["repos", "discover", "x", "--dry-run=true"], OPTIONS)).toEqual({
      argv: ["repos", "discover", "x", "--dry-run"],
    });
    expect(switchValues(["x", "--approve=TRUE", "--json=False"], OPTIONS)).toEqual({
      argv: ["x", "--approve"],
    });
    // An option that takes a value keeps it; after -- nothing is an option.
    expect(switchValues(["x", "--root=true", "--", "--json=no"], OPTIONS)).toEqual({
      argv: ["x", "--root=true", "--", "--json=no"],
    });
    const bad = switchValues(["x", "--dry-run=yes"], OPTIONS);
    expect(bad).toEqual({
      error:
        "--dry-run is a switch: give it alone (--dry-run), or as --dry-run=true or --dry-run=false, not --dry-run=yes. Nothing was run.",
    });
  });

  it("makes --dry-run=true a dry run: repos discover writes no manifest", async () => {
    const meta = await mkdtemp(join(tmpdir(), "atticus-r47-discover-"));
    made.push(meta);
    await initCommand(meta, { name: "shop", platform: "shop" }, { out: () => {}, err: () => {} });
    const manifest = join(meta, "org-pack/profiles/shop/repos.manifest.yaml");
    const before = await readFile(manifest, "utf8").catch(() => undefined);
    const r = await run([
      "repos",
      "discover",
      join(ADOPT_FIXTURES, "plain-multi"),
      "--dry-run=true",
      "--root",
      meta,
    ]);
    expect(r.code).toBe(0);
    expect(await readFile(manifest, "utf8").catch(() => undefined)).toBe(before);
  });

  it("refuses --json=maybe with exit 2, running nothing", async () => {
    const r = await run(["commands", "--json=maybe"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--json is a switch");
    expect(r.out).toBe("");
    const t = await run(["commands", "--json=true"]);
    expect(() => JSON.parse(t.out)).not.toThrow();
    const f = await run(["commands", "--json=false"]);
    expect(f.out).toMatch(/^Set up and keep healthy:/);
  });
});
