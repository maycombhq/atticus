import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/main.js";

/**
 * `atticus openspec <args...>` (ADR 0006 addendum 2026-10-26): `openspec` isn't on PATH — it is
 * vendored inside the installed package — so a person runs it through Atticus. The bundled script
 * is replaced here with one that prints the arguments it was given (ATTICUS_OPENSPEC_BIN, the
 * switch the weekly compatibility job uses), so the test asserts the pass-through without running
 * OpenSpec. No network.
 */

let bin: string;
let was: string | undefined;

const run = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
};

/** A metarepo with the changes given, and nothing else OpenSpec would read. */
async function metarepo(changes: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-openspec-run-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await mkdir(join(root, "openspec", "changes", "archive"), { recursive: true });
  for (const c of changes) await mkdir(join(root, "openspec", "changes", c), { recursive: true });
  return root;
}

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "atticus-openspec-bin-"));
  bin = join(dir, "fake-openspec.mjs");
  await writeFile(
    bin,
    [
      "const args = process.argv.slice(2);",
      "console.log(JSON.stringify({ args, cwd: process.cwd() }));",
      'if (args.includes("boom")) { console.error("openspec said no"); process.exit(3); }',
      "",
    ].join("\n"),
    "utf8",
  );
  was = process.env.ATTICUS_OPENSPEC_BIN;
  process.env.ATTICUS_OPENSPEC_BIN = bin;
});
afterEach(() => {
  if (was === undefined) delete process.env.ATTICUS_OPENSPEC_BIN;
  else process.env.ATTICUS_OPENSPEC_BIN = was;
});

describe("atticus openspec <args...>", () => {
  it("runs the bundled OpenSpec in the metarepo with the arguments as they are", async () => {
    const root = await metarepo(["add-transfer-limit", "bulk-orders"]);
    const r = await run(["openspec", "list", "--specs", "--json", "--root", root]);
    expect(r.code).toBe(0);
    const printed = JSON.parse(r.out.at(-1)!) as { args: string[]; cwd: string };
    // Atticus's own --root is not passed on; everything else is.
    expect(printed.args).toEqual(["list", "--specs", "--json"]);
    expect(printed.cwd).toBe(root);
  });

  it("gives OpenSpec's own exit code and messages back", async () => {
    const root = await metarepo(["add-transfer-limit"]);
    const r = await run(["openspec", "validate", "boom", "--root", root]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("openspec said no");
  });

  it("defaults --change to the only change open, and says it did", async () => {
    const root = await metarepo(["add-transfer-limit"]);
    const r = await run(["openspec", "status", "--root", root]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe(
      "Only one change is open, so: openspec status --change add-transfer-limit",
    );
    expect((JSON.parse(r.out.at(-1)!) as { args: string[] }).args).toEqual([
      "status",
      "--change",
      "add-transfer-limit",
    ]);
  });

  it("asks which change when more than one is open, and never overrides a given one", async () => {
    const root = await metarepo(["add-transfer-limit", "bulk-orders"]);
    const many = await run(["openspec", "status", "--root", root]);
    expect(many.out[0]).toBe(
      "2 changes are open (add-transfer-limit, bulk-orders); add --change <id> to name one.",
    );
    expect((JSON.parse(many.out.at(-1)!) as { args: string[] }).args).toEqual(["status"]);
    const given = await run(["openspec", "status", "--change", "bulk-orders", "--root", root]);
    expect(given.out[0]).not.toMatch(/^Only one change/);
    expect((JSON.parse(given.out.at(-1)!) as { args: string[] }).args).toEqual([
      "status",
      "--change",
      "bulk-orders",
    ]);
  });

  it("fills in the change for instructions apply too", async () => {
    const root = await metarepo(["add-transfer-limit"]);
    const r = await run(["openspec", "instructions", "apply", "--root", root]);
    expect((JSON.parse(r.out.at(-1)!) as { args: string[] }).args).toEqual([
      "instructions",
      "apply",
      "--change",
      "add-transfer-limit",
    ]);
  });

  it("says how to use it when given nothing", async () => {
    const root = await metarepo([]);
    const r = await run(["openspec", "--root", root]);
    expect(r.code).toBe(2);
    expect(r.err[0]).toMatch(/^Usage: atticus openspec <openspec arguments>/);
  });
});
