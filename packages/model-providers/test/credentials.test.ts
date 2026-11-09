import { describe, expect, it } from "vitest";
import {
  keyEnvFromEnvironment,
  readKey,
  systemKeyStore,
  type CommandRunner,
} from "../src/index.js";

/**
 * Keys in the operating system's credential store (ADR 0121 item 3): the system's own command,
 * the key on stdin (never in a command line, a file Atticus writes, or a message), and the
 * environment first.
 */

const KEY = "sk-test-0123456789abcdefghij";

/** A runner that keeps what it was asked and answers like the system's command. */
function fake(answers: Record<string, { code: number; stdout?: string }> = {}) {
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const run: CommandRunner = (cmd, args, o = {}) => {
    calls.push({ cmd, args, ...(o.input !== undefined ? { input: o.input } : {}) });
    const verb = args.find((a) => /^(lookup|store|clear|find-generic-password)$/.test(a)) ?? cmd;
    const a = answers[verb] ?? { code: 0, stdout: "" };
    return { code: a.code, stdout: a.stdout ?? "" };
  };
  return { calls, run };
}

describe("the system key store (ADR 0121)", () => {
  it("on Linux, stores with secret-tool, the key on stdin, and reads it back", () => {
    const f = fake({ lookup: { code: 0, stdout: `${KEY}\n` } });
    const store = systemKeyStore({ platform: "linux", run: f.run });
    store.set("ATTICUS_MODEL_KEY", KEY);
    expect(f.calls[0]).toMatchObject({ cmd: "secret-tool", input: KEY });
    expect(f.calls[0]!.args).toEqual(
      expect.arrayContaining(["store", "service", "atticus", "key", "ATTICUS_MODEL_KEY"]),
    );
    expect(f.calls[0]!.args.join(" ")).not.toContain(KEY);
    expect(store.get("ATTICUS_MODEL_KEY")).toBe(KEY);
  });

  it("on macOS, uses the Keychain through security -i, so the key isn't in a command line", () => {
    const f = fake({ "find-generic-password": { code: 0, stdout: `${KEY}\n` } });
    const store = systemKeyStore({ platform: "darwin", run: f.run });
    store.set("ATTICUS_MODEL_KEY", KEY);
    expect(f.calls[0]).toMatchObject({ cmd: "security", args: ["-i"] });
    expect(f.calls[0]!.input).toContain("add-generic-password");
    expect(store.get("ATTICUS_MODEL_KEY")).toBe(KEY);
  });

  it("on Windows, keeps the key encrypted for this Windows user through PowerShell", () => {
    const f = fake();
    const store = systemKeyStore({
      platform: "win32",
      run: f.run,
      dir: "C:/keys",
      exists: () => false,
    });
    store.set("ATTICUS_MODEL_KEY", KEY);
    expect(f.calls[0]!.cmd).toBe("powershell.exe");
    expect(f.calls[0]!.input).toBe(KEY);
    expect(f.calls[0]!.args.join(" ")).not.toContain(KEY);
    expect(f.calls[0]!.args.join(" ")).toContain("ConvertFrom-SecureString");
  });

  it("says there is none when the store has no key by that name", () => {
    const f = fake({ lookup: { code: 1 } });
    expect(systemKeyStore({ platform: "linux", run: f.run }).get("NOPE")).toBeUndefined();
  });
});

describe("reading a provider's key", () => {
  it("takes the environment first, then the store, and names the variable when neither has it", () => {
    const store = { get: (n: string) => (n === "STORED" ? KEY : undefined), set() {}, forget() {} };
    expect(readKey("anthropic", "ATTICUS_FROM_ENV", { ATTICUS_FROM_ENV: "env-key" }, store)).toBe(
      "env-key",
    );
    expect(readKey("anthropic", "STORED", {}, store)).toBe(KEY);
    expect(() => readKey("anthropic", "MISSING", {}, store)).toThrow(/MISSING/);
    expect(() => readKey("anthropic", "MISSING", {}, store)).toThrow(/atticus secret set MISSING/);
  });

  it("reads from the environment only a variable named for a model's key (review round 48)", () => {
    const store = { get: (n: string) => (n === "MY_KEY" ? KEY : undefined), set() {}, forget() {} };
    const env = {
      GITHUB_TOKEN: "ghp-not-a-model-key",
      AZURE_DEVOPS_EXT_PAT: "pat",
      SYSTEM_ACCESSTOKEN: "pipeline",
      AWS_SECRET_ACCESS_KEY: "aws",
      HOME: "/home/dev",
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
      ATTICUS_MODEL_KEY: "atticus-key",
    };
    for (const name of [
      "GITHUB_TOKEN",
      "AZURE_DEVOPS_EXT_PAT",
      "SYSTEM_ACCESSTOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "HOME",
    ]) {
      expect(keyEnvFromEnvironment(name)).toBe(false);
      expect(() => readKey("openai-compatible", name, env, store)).toThrow(
        /isn't read from the environment/,
      );
    }
    expect(readKey("anthropic", "ANTHROPIC_API_KEY", env, store)).toBe("anthropic-key");
    expect(readKey("openai-compatible", "OPENAI_API_KEY", env, store)).toBe("openai-key");
    expect(readKey("anthropic", "ATTICUS_MODEL_KEY", env, store)).toBe("atticus-key");
    // A name the person kept in this machine's credential store is theirs for the model.
    expect(readKey("anthropic", "MY_KEY", { MY_KEY: "from-env" }, store)).toBe(KEY);
  });
});
