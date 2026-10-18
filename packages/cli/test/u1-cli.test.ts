import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { conformanceCommand } from "../src/u1-commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const CONF = join(HERE, "../../conformance/test/fixtures");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

describe("atticus conformance", () => {
  it("passes the Forge org pack and says so", async () => {
    const c = capture();
    const code = await conformanceCommand(join(FORGE, "metarepo"), { kind: "org-pack" }, c.io);
    expect(code).toBe(0);
    expect(c.out[0]).toBe(
      `Conformance of ${join(FORGE, "metarepo")} (org-pack) to specification 0.1.0:`,
    );
    expect(c.out).toContain(
      "  ok    orgpack.dialect-tests  Every dialect passes its tests (forge).",
    );
    expect(c.out.at(-1)).toMatch(/^Passed: \d+ checks\.$/);
  });

  it("exits 1 and lists the problems for a broken dialect", async () => {
    const c = capture();
    const code = await conformanceCommand(
      join(CONF, "orgpack-broken/dialects/tags.yaml"),
      { kind: "dialect" },
      c.io,
    );
    expect(code).toBe(1);
    expect(c.out).toEqual([
      `Conformance of ${join(CONF, "orgpack-broken/dialects/tags.yaml")} (dialect) to specification 0.1.0:`,
      "  ok    dialect.schema  Dialect tags 0.1.0 matches C2.",
      "  FAIL  dialect.tests  names the billing service: expected Component invoicing, got billing",
      "Failed: 1 problem, 1 check passed.",
    ]);
  });

  it("prints the report as JSON", async () => {
    const c = capture();
    const code = await conformanceCommand(
      join(CONF, "plugins/no-exports.mjs"),
      { kind: "plugin", json: true },
      c.io,
    );
    expect(code).toBe(1);
    const r = JSON.parse(c.out.join("\n")) as { kind: string; passed: boolean; summary: unknown };
    expect(r).toMatchObject({
      kind: "plugin",
      passed: false,
      summary: { pass: 0, fail: 1, warn: 0 },
    });
  });

  it("exits 2 without a kind it knows", async () => {
    const c = capture();
    expect(await conformanceCommand(".", {}, c.io)).toBe(2);
    expect(await conformanceCommand(".", { kind: "everything" }, c.io)).toBe(2);
    expect(c.err).toEqual([
      "Say what to check with --kind: catalog, org-pack, dialect, plugin, executor.",
      'Say what to check with --kind: catalog, org-pack, dialect, plugin, executor. "everything" isn\'t one of them.',
    ]);
  });
});
