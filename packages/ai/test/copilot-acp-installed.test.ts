import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  commandLineOf,
  installedInsteadOfNpx,
  programOnPath,
  startProblemOf,
} from "../src/copilot-acp.js";

/**
 * beta.32, the owner's machine: runtime.yaml kept the default line, `npx --yes
 * @github/copilot-language-server --stdio`, with the server installed. npx asked npm about the
 * package through the proxy on every start, and one morning that took the start past its limit.
 * When the line runs that package through npx and the server is installed, the installed one runs.
 */
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

async function binWith(names: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "acp-installed-"));
  made.push(dir);
  for (const n of names) {
    await writeFile(join(dir, n), "#!/bin/sh\n");
    await chmod(join(dir, n), 0o755);
  }
  return dir;
}

const DEFAULT = "npx --yes @github/copilot-language-server --stdio";

describe("the installed Copilot server in place of npx (beta.32)", () => {
  // POSIX paths and PATH (the Windows test below runs on every host).
  const posix = it.skipIf(process.platform === "win32");

  posix(
    "the default line runs the installed server, with the words after the package",
    async () => {
      const bin = await binWith(["copilot-language-server"]);
      const got = installedInsteadOfNpx(
        commandLineOf(DEFAULT),
        { PATH: `/nowhere:${bin}` },
        "linux",
      );
      expect(got).toEqual({
        command: join(bin, "copilot-language-server"),
        args: ["--stdio", "--acp"],
      });
    },
  );

  it("on Windows, the server's .cmd on Path (any case of the name)", async () => {
    const bin = await binWith(["copilot-language-server.cmd"]);
    const got = installedInsteadOfNpx(
      commandLineOf(DEFAULT),
      { Path: `${bin};C:\\nowhere` },
      "win32",
    );
    expect(got.command).toBe(join(bin, "copilot-language-server.cmd"));
    expect(got.args).toEqual(["--stdio", "--acp"]);
  });

  it("as written when the server isn't installed, a version is pinned, or it's another package or program", async () => {
    const bin = await binWith(["copilot-language-server"]);
    const env = { PATH: bin };
    const same = (line: string, e: Record<string, string | undefined> = env) =>
      expect(installedInsteadOfNpx(commandLineOf(line), e, "linux")).toEqual(commandLineOf(line));
    same(DEFAULT, { PATH: "/nowhere" });
    same(DEFAULT, {});
    same("npx --yes @github/copilot-language-server@1.300.0 --stdio");
    same("npx --registry https://npm.example.test @github/copilot-language-server");
    same("npx --yes some-other-server --stdio");
    same("copilot-language-server --stdio");
    same(`${join(bin, "copilot-language-server")} --stdio`);
  });

  posix("npx without --yes, or with -y, is the default too", async () => {
    const bin = await binWith(["copilot-language-server"]);
    for (const line of [
      "npx @github/copilot-language-server",
      "npx -y @github/copilot-language-server --stdio",
      "npx.cmd --yes @github/copilot-language-server",
    ])
      expect(installedInsteadOfNpx(commandLineOf(line), { PATH: bin }, "linux").command).toBe(
        join(bin, "copilot-language-server"),
      );
  });

  it("a folder named as the program isn't the program", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-installed-dir-"));
    made.push(dir);
    await mkdir(join(dir, "copilot-language-server"));
    expect(programOnPath("copilot-language-server", { PATH: dir }, "linux")).toBeUndefined();
  });

  it("a start that fails after the swap says the installed server ran, and how to update it or pin npx", () => {
    const p = startProblemOf({
      line: DEFAULT,
      command: "/usr/local/bin/copilot-language-server",
      args: ["--stdio", "--acp"],
      stderr: "error: unknown option '--acp'",
      failure: { kind: "exited", exit: { code: 1, signal: null } },
    });
    expect(p.advice).toContain(
      "Atticus ran the installed server (/usr/local/bin/copilot-language-server) in place of runtime.yaml's npx line",
    );
    expect(p.advice).toContain("npm i -g @github/copilot-language-server");
    // Without the swap, nothing of it.
    const plain = startProblemOf({
      line: DEFAULT,
      command: "npx",
      args: ["--yes", "@github/copilot-language-server", "--stdio", "--acp"],
      stderr: "",
      failure: { kind: "timeout", ms: 60_000 },
    });
    expect(plain.advice).not.toContain("installed server");
  });

  it("on POSIX a file without the execute bit isn't the program; a quoted Windows Path entry is read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-installed-noexec-"));
    made.push(dir);
    await writeFile(join(dir, "copilot-language-server"), "not a program\n");
    await chmod(join(dir, "copilot-language-server"), 0o644);
    if (process.platform !== "win32")
      expect(programOnPath("copilot-language-server", { PATH: dir }, "linux")).toBeUndefined();
    const bin = await binWith(["copilot-language-server.cmd"]);
    expect(programOnPath("copilot-language-server", { Path: `"${bin}"` }, "win32")).toBe(
      join(bin, "copilot-language-server.cmd"),
    );
  });
});
