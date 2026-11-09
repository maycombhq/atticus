import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { GitRunner } from "@maycombhq/workspace";
import { orgPackValidate } from "../src/commands.js";
import { doctorChecks, type DoctorCheck, type DoctorDeps } from "../src/doctor.js";
import { main } from "../src/main.js";
import { idFromUrl } from "../src/repo-commands.js";
import { adoptCommand, initCommand, reposDiscoverCommand } from "../src/setup-commands.js";
import { skillsWriteCommand } from "../src/skills-commands.js";
import { upgradeCommand } from "../src/upgrade.js";

/**
 * Review round 50 (getting started): the documented first steps (init, repos discover, doctor;
 * adopt, upgrade --check) leave nothing to upgrade and say the right next step, and the files
 * Atticus edits keep their line endings.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLONES = join(HERE, "../../adopt/test/fixtures/plain-multi");
const T = 120_000;
const made: string[] = [];
afterAll(async () => {
  while (made.length) await rm(made.pop()!, { recursive: true, force: true });
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

async function temp(name: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "atticus-r50-cli-"));
  made.push(d);
  return join(d, name);
}

const gitWith =
  (config: Record<string, string>): GitRunner =>
  async (args) => {
    if (args[0] === "--version") return { stdout: "git version 2.45.1", stderr: "" };
    if (args[0] === "config" && config[args[2]!] !== undefined)
      return { stdout: `${config[args[2]!]}\n`, stderr: "" };
    throw new Error("exit 1");
  };

const machine: DoctorDeps = {
  env: { PATH: "" },
  platform: "linux",
  nodeVersion: "22.13.1",
  git: gitWith({ "user.name": "Pat", "user.email": "pat@example.com" }),
  openspecVersion: async () => "1.14.0",
  openspecStores: async () => true,
  portFree: async () => true,
  freeBytes: async () => 50 * 1024 ** 3,
  onPath: (p) => p === "code",
  assistantFiles: async () => ({ missing: [], stale: [], edited: [] }),
};
const byId = (checks: DoctorCheck[], id: string) => checks.find((c) => c.id === id)!;

describe("the documented first steps leave nothing to upgrade (round 50, 3)", () => {
  it(
    "init, then repos discover, then doctor: no upgrade step",
    async () => {
      const dir = await temp("forge-meta");
      expect(await initCommand(dir, { name: "forge", platform: "forge", by: "pat" }, io().io)).toBe(
        0,
      );
      expect(await reposDiscoverCommand(dir, { from: CLONES }, io().io)).toBe(0);
      const up = byId(await doctorChecks(dir, machine), "upgrade");
      expect(up.status).toBe("ok");
    },
    T,
  );

  it(
    "adopt, then upgrade --check: up to date, the stamp written, the next step named first",
    async () => {
      const dir = await temp("forge-mono");
      await cp(CLONES, dir, { recursive: true });
      const a = io();
      expect(await adoptCommand(dir, {}, a.io)).toBe(0);
      expect(existsSync(join(dir, ".atticus/metarepo.yaml"))).toBe(true);
      const c = io();
      expect(await upgradeCommand(dir, { check: true }, c.io)).toBe(0);
      expect(c.out[0]).toMatch(/^Up to date for Atticus /);
      // Round 50, 9: adopt writes no slash commands, so the command that does is said before
      // the tier line that names /atticus-map.
      const files = a.out.findIndex((l) => l.includes("atticus assistant-files"));
      const tier = a.out.findIndex((l) => l.startsWith("Your assistant reads a repo at:"));
      expect(files).toBeGreaterThanOrEqual(0);
      expect(files).toBeLessThan(tier);
    },
    T,
  );
});

describe("doctor on a runtime.yaml that isn't YAML (round 50, 4)", () => {
  it(
    "runs to the end and fails the org pack check with the parse error",
    async () => {
      const dir = await temp("forge-meta");
      await initCommand(dir, { name: "forge", platform: "forge", by: "pat" }, io().io);
      await writeFile(
        join(dir, "org-pack/runtime.yaml"),
        "schemaVersion: 1\nassistants: { allowed: [copilot, default: copilot\n",
      );
      const checks = await doctorChecks(dir, machine);
      const op = byId(checks, "org-pack");
      expect(op.status).toBe("fail");
      expect(op.detail).toMatch(/runtime\.yaml: can't read YAML: /);
      expect(byId(checks, "embeddings")).toBeDefined();
    },
    T,
  );
});

describe("repos discover asks for the platform among several (round 50, 6)", () => {
  it(
    "refuses with --platform named, and orgpack validate notes a profile folder with no profile.yaml",
    async () => {
      const dir = await temp("forge-meta");
      await initCommand(dir, { name: "forge", platform: "forge", by: "pat" }, io().io);
      await mkdir(join(dir, "org-pack/profiles/default"), { recursive: true });
      await writeFile(
        join(dir, "org-pack/profiles/default/repos.manifest.yaml"),
        "schemaVersion: 3\nplatform: default\nrepos: []\n",
      );
      const d = io();
      expect(await reposDiscoverCommand(dir, { from: CLONES }, d.io)).toBe(2);
      expect(d.err.join("\n")).toMatch(/2 platform profiles \(default, forge\).*--platform/);
      const v = io();
      expect(await orgPackValidate(join(dir, "org-pack"), v.io)).toBe(0);
      expect(v.err).toContain(
        "Note: profiles/default/ has no profile.yaml, so the default platform names no systems; add one, or remove the folder if it was made by mistake.",
      );
    },
    T,
  );

  it(
    "says which found repo got another id (round 50, 7)",
    async () => {
      const dir = await temp("forge-meta");
      await initCommand(dir, { name: "forge", platform: "forge", by: "pat" }, io().io);
      await writeFile(
        join(dir, "org-pack/profiles/forge/repos.manifest.yaml"),
        "schemaVersion: 3\nplatform: forge\nrepos:\n  - id: orders-api\n    url: https://git.example.com/forge/orders-api.git\n    type: spring-boot\n    owner: team-orders\n",
      );
      const d = io();
      expect(await reposDiscoverCommand(dir, { from: CLONES }, d.io)).toBe(0);
      expect(d.out).toContain(
        "  orders-api is added as orders-api-2: the manifest lists orders-api already, with another clone URL.",
      );
    },
    T,
  );
});

describe("skills write leaves CLAUDE.md alone with nothing to write (round 50, 8)", () => {
  const metarepo = async () => {
    const root = await temp("forge-meta");
    await mkdir(join(root, "org-pack"), { recursive: true });
    await writeFile(join(root, "org-pack/pack.yaml"), "schemaVersion: 1\nname: forge\n");
    return root;
  };

  it("keeps a mixed-ending file with no trailing newline byte for byte", async () => {
    const root = await metarepo();
    const mine = "# Forge metarepo\r\n\nOur own notes.";
    await writeFile(join(root, "CLAUDE.md"), mine);
    const w = io();
    expect(await skillsWriteCommand(root, {}, w.io)).toBe(0);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(mine);
    expect(w.out.join("\n")).not.toContain("wrote CLAUDE.md");
  });

  it("writes the team instructions into a CRLF file in CRLF", async () => {
    const root = await metarepo();
    await mkdir(join(root, "org-pack/instructions"), { recursive: true });
    await writeFile(join(root, "org-pack/instructions/forge-java.md"), "Prefer records.\n");
    await writeFile(join(root, "CLAUDE.md"), "# Forge metarepo\r\n\r\nOur own notes.\r\n");
    expect(await skillsWriteCommand(root, {}, io().io)).toBe(0);
    const text = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(text).toContain("- @org-pack/instructions/forge-java.md\r\n");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    // Written again, nothing is behind.
    const c = io();
    expect(await skillsWriteCommand(root, { check: true }, c.io)).toBe(0);
  });
});

describe("small words (round 50, minor)", () => {
  it("names the plan subcommand asked for in its example", async () => {
    const dir = await temp("forge-meta");
    await initCommand(dir, { name: "forge", platform: "forge", by: "pat" }, io().io);
    const t = io();
    expect(await main(["plan", "snow", "--root", dir], t.io)).toBe(2);
    expect(t.err[0]).toBe(
      "plan snow needs a change id, for example: atticus plan snow add-transfer-limit",
    );
  });

  it("takes the repo id from a browser link before its query", () => {
    expect(
      idFromUrl("https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-ledger?path=/src"),
    ).toBe("forge-ledger");
    expect(idFromUrl("https://git.example.com/forge/forge-cards#readme")).toBe("forge-cards");
    expect(idFromUrl("git@git.example.com:forge/forge-fx.git")).toBe("forge-fx");
  });
});
