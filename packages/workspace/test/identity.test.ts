import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitUser, toHandle } from "../src/index.js";

/**
 * ADR 0073: the person is the metarepo's Git user. These run real git against a temporary
 * repo with its own config; the global and system config are switched off so the machine's
 * own Git user can't leak in. No network.
 */
async function isolated() {
  const dir = await mkdtemp(join(tmpdir(), "atticus-identity-"));
  const globalFile = join(dir, "empty-global.gitconfig");
  await writeFile(globalFile, "");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalFile,
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: dir,
    USERPROFILE: dir,
  };
  const root = join(dir, "metarepo");
  execFileSync("git", ["init", "-q", root], { env });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env });
  return { root, env, git };
}

describe("gitUser", () => {
  it("reads user.name and user.email from the metarepo's git config", async () => {
    const { root, env, git } = await isolated();
    git("config", "user.name", "Pat Doe");
    git("config", "user.email", "pat.doe@forge.example");
    expect(await gitUser(root, { env })).toEqual({
      handle: "pat.doe",
      name: "Pat Doe",
      email: "pat.doe@forge.example",
      source: "git",
    });
  });

  it("makes a handle from the name when there is no email", async () => {
    const { root, env, git } = await isolated();
    git("config", "user.name", "Ari Lee");
    const u = await gitUser(root, { env });
    expect(u).toMatchObject({ handle: "ari-lee", name: "Ari Lee", source: "git" });
    expect(u.warning).toBeUndefined();
  });

  it("falls back to the OS user, with a warning that says how to set the Git user", async () => {
    const { root, env } = await isolated();
    const u = await gitUser(root, { env, osUser: () => "Sam" });
    expect(u.handle).toBe("sam");
    expect(u.source).toBe("os");
    expect(u.warning).toContain("Git has no user here");
    expect(u.warning).toContain("git config --global user.name");
  });

  it("falls back when git can't run at all", async () => {
    const u = await gitUser("/nowhere", {
      git: async () => {
        throw new Error("git isn't on PATH");
      },
      osUser: () => "kim",
    });
    expect(u).toMatchObject({ handle: "kim", source: "os" });
  });
});

describe("toHandle", () => {
  it("keeps what a handle allows and joins the rest with dashes", () => {
    expect(toHandle("Pat Doe")).toBe("pat-doe");
    expect(toHandle("  @Ari_Lee! ")).toBe("ari_lee");
    expect(toHandle("pat.doe")).toBe("pat.doe");
    expect(toHandle("---")).toBe("");
  });
});
