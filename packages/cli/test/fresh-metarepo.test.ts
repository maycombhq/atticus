import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctorChecks, type DoctorDeps } from "../src/doctor.js";
import { sandboxCreate } from "../src/learn-commands.js";
import { initCommand } from "../src/setup-commands.js";
import { upgradeCommand } from "../src/upgrade.js";

/**
 * A metarepo Atticus has just made is at the current version of every schema, with its slash
 * commands written: the first `atticus doctor` there has no upgrade or slash-command warning.
 * It guards every future schema bump: a new migration whose file init or the sandbox writes at
 * the old version fails here.
 */

const quiet = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

// The machine is mocked; the metarepo checks (upgrade, slash commands) read the real files.
const machine: DoctorDeps = {
  env: { PATH: "" },
  platform: "linux",
  nodeVersion: "22.13.1",
  git: async (args) => {
    if (args[0] === "--version") return { stdout: "git version 2.45.1", stderr: "" };
    throw new Error("exit 1");
  },
  openspecVersion: async () => "1.14.0",
  openspecStores: async () => true,
  portFree: async () => true,
  freeBytes: async () => 50 * 1024 ** 3,
  onPath: () => false,
};

async function expectCurrent(root: string) {
  const up = quiet();
  expect(await upgradeCommand(root, { check: true }, up.io), up.out.join("\n")).toBe(0);
  const checks = await doctorChecks(root, machine);
  const of = (id: string) => checks.find((c) => c.id === id);
  expect(of("upgrade")?.status, of("upgrade")?.detail).toBe("ok");
  expect(of("assistant-files")?.status, of("assistant-files")?.detail).toBe("ok");
}

describe("a fresh metarepo is current", () => {
  it("atticus init writes every file at the current version, slash commands with them", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "atticus-fresh-init-")), "forge-meta");
    const t = quiet();
    expect(await initCommand(dir, { name: "forge", platform: "forge" }, t.io)).toBe(0);
    await expectCurrent(dir);
  }, 120_000);

  it("atticus sandbox create does too, and ends with the cd line to run", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "atticus-fresh-sandbox-")), "practice");
    const t = quiet();
    expect(await sandboxCreate(dir, {}, t.io)).toBe(0);
    expect(t.out.at(-1)).toBe(`cd "${join(dir, "metarepo")}"`);
    await expectCurrent(join(dir, "metarepo"));
  }, 180_000);
});
