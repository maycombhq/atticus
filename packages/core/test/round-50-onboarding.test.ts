import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { addManifestRepo, addRolesTeam, Runtime } from "../src/index.js";

/** Review round 50 (getting started): the onboarding fixes that live in core. */

const made: string[] = [];
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

async function metarepo(manifest: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-r50-"));
  made.push(root);
  await mkdir(join(root, "org-pack", "profiles", "forge"), { recursive: true });
  await writeFile(join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml"), manifest);
  return root;
}

const entry = (id: string) => ({
  id,
  url: `https://dev.azure.com/forgeorg/Forge%20Payments/_git/${id}`,
  type: "spring-boot",
  owner: "team-ledger",
});

describe("repo add to the empty manifest init writes (round 50, 5)", () => {
  it("writes one entry per block, not the whole list on one line", async () => {
    const root = await metarepo("schemaVersion: 3\nplatform: forge\nrepos: []\n");
    await addManifestRepo(root, "forge", entry("forge-ledger"));
    await addManifestRepo(root, "forge", entry("forge-cards"));
    const text = await readFile(
      join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml"),
      "utf8",
    );
    // Hand-written: block style, so a second add is a few new lines, never a rewritten one.
    expect(text).toBe(
      [
        "schemaVersion: 3",
        "platform: forge",
        "repos:",
        "  - id: forge-ledger",
        "    url: https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-ledger",
        "    type: spring-boot",
        "    owner: team-ledger",
        "  - id: forge-cards",
        "    url: https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-cards",
        "    type: spring-boot",
        "    owner: team-ledger",
        "",
      ].join("\n"),
    );
  });

  it("adds a team to roles.yaml's empty list in block style too", async () => {
    const root = await metarepo("schemaVersion: 3\nplatform: forge\nrepos: []\n");
    await writeFile(join(root, "org-pack", "roles.yaml"), "schemaVersion: 2\nteams: []\n");
    await addRolesTeam(root, { id: "team-ledger", name: "Ledger" });
    const text = await readFile(join(root, "org-pack", "roles.yaml"), "utf8");
    expect(text).toContain("teams:\n  - id: team-ledger\n    name: Ledger\n");
  });
});

describe("runtime.yaml modes without a default (round 50, 10)", () => {
  const base = { schemaVersion: 3, assistants: { allowed: ["copilot"], default: "copilot" } };

  it("defaults to the first allowed mode, as the admin guide's example writes it", () => {
    const r = Runtime.parse({ ...base, modes: { allowed: ["hand-off", "copilot-acp"] } });
    expect(r.modes).toEqual({ allowed: ["hand-off", "copilot-acp"], default: "hand-off" });
  });

  it("still refuses a default that isn't allowed, and keeps one that is", () => {
    expect(
      Runtime.safeParse({ ...base, modes: { allowed: ["hand-off"], default: "model" } }).success,
    ).toBe(false);
    expect(
      Runtime.parse({ ...base, modes: { allowed: ["hand-off", "model"], default: "model" } }).modes
        .default,
    ).toBe("model");
  });

  it("reads the guide's YAML as written", () => {
    const yaml =
      "schemaVersion: 3\nassistants: { allowed: [copilot], default: copilot }\nmodes: { allowed: [hand-off, copilot-acp] }\n";
    expect(Runtime.safeParse(parse(yaml)).success).toBe(true);
  });
});
