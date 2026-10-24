import { describe, expect, it } from "vitest";
import { readKey, systemKeyStore, type CommandRunner } from "../src/index.js";

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
    expect(readKey("anthropic", "FROM_ENV", { FROM_ENV: "env-key" }, store)).toBe("env-key");
    expect(readKey("anthropic", "STORED", {}, store)).toBe(KEY);
    expect(() => readKey("anthropic", "MISSING", {}, store)).toThrow(/MISSING/);
    expect(() => readKey("anthropic", "MISSING", {}, store)).toThrow(/atticus secret set MISSING/);
  });
});
