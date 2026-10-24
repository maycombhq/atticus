import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A provider's key in the operating system's credential store (ADR 0121 item 3), so nobody has
 * to set an environment variable or put a key in a file. Each system's own command, so Atticus
 * takes no new dependency:
 *
 * - Windows: the key encrypted with DPAPI for this Windows user (PowerShell's
 *   ConvertFrom-SecureString), in %APPDATA%\atticus\keys\<name>; only this user can read it.
 * - macOS: the login Keychain, through `security -i`.
 * - Linux: the Secret Service, through `secret-tool`.
 *
 * The key goes to the command on stdin, never in a command line, and is never printed or logged.
 * A key is stored under the name runtime.yaml gives as keyEnv.
 */

export interface KeyStore {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  forget(name: string): void;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  o?: { input?: string; env?: Record<string, string> },
) => { code: number; stdout: string };

const realRun: CommandRunner = (cmd, args, o = {}) => {
  const r = spawnSync(cmd, args, {
    input: o.input ?? "",
    env: { ...process.env, ...o.env },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "" };
};

const SERVICE = "atticus";

export function systemKeyStore(
  o: {
    platform?: NodeJS.Platform;
    run?: CommandRunner;
    /** Windows: where the encrypted keys are kept. */
    dir?: string;
    exists?: (path: string) => boolean;
  } = {},
): KeyStore {
  const platform = o.platform ?? process.platform;
  const run = o.run ?? realRun;
  const exists = o.exists ?? existsSync;
  const failed = (what: string) =>
    new Error(`Couldn't ${what} the key in this machine's credential store.`);

  if (platform === "win32") {
    const dir =
      o.dir ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "atticus", "keys");
    const file = (name: string) => join(dir, name);
    const ps = (script: string, name: string, input?: string) =>
      run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        ...(input !== undefined ? { input } : {}),
        env: { ATTICUS_KEY_FILE: file(name) },
      });
    return {
      get(name) {
        if (!exists(file(name))) return undefined;
        const r = ps(
          "$e = Get-Content -LiteralPath $env:ATTICUS_KEY_FILE; $p = $e | ConvertTo-SecureString; " +
            "[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p))",
          name,
        );
        const v = r.stdout.trim();
        return r.code === 0 && v ? v : undefined;
      },
      set(name, value) {
        if (!o.dir) mkdirSync(dir, { recursive: true });
        const r = ps(
          "$s = [Console]::In.ReadToEnd(); " +
            "$e = ConvertTo-SecureString $s -AsPlainText -Force | ConvertFrom-SecureString; " +
            "Set-Content -LiteralPath $env:ATTICUS_KEY_FILE -Value $e",
          name,
          value,
        );
        if (r.code !== 0) throw failed("keep");
      },
      forget(name) {
        if (exists(file(name))) rmSync(file(name), { force: true });
      },
    };
  }

  if (platform === "darwin")
    return {
      get(name) {
        const r = run("security", ["find-generic-password", "-a", SERVICE, "-s", name, "-w"]);
        const v = r.stdout.trim();
        return r.code === 0 && v ? v : undefined;
      },
      set(name, value) {
        // `security -i` reads its command from stdin, so the key is in no command line.
        const quoted = `"${value.replace(/(["\\])/g, "\\$1")}"`;
        const r = run("security", ["-i"], {
          input: `add-generic-password -U -a ${SERVICE} -s ${name} -w ${quoted}\n`,
        });
        if (r.code !== 0) throw failed("keep");
      },
      forget(name) {
        run("security", ["delete-generic-password", "-a", SERVICE, "-s", name]);
      },
    };

  return {
    get(name) {
      const r = run("secret-tool", ["lookup", "service", SERVICE, "key", name]);
      const v = r.stdout.trim();
      return r.code === 0 && v ? v : undefined;
    },
    set(name, value) {
      const r = run(
        "secret-tool",
        ["store", `--label=Atticus ${name}`, "service", SERVICE, "key", name],
        { input: value },
      );
      if (r.code !== 0) throw failed("keep");
    },
    forget(name) {
      run("secret-tool", ["clear", "service", SERVICE, "key", name]);
    },
  };
}

let shared: KeyStore | undefined;
const read = new Map<string, string | undefined>();

/** This machine's store, read once per name in a process. */
export function defaultKeyStore(): KeyStore {
  if (!shared) {
    const s = systemKeyStore();
    shared = {
      get(name) {
        if (!read.has(name)) {
          let v: string | undefined;
          try {
            v = s.get(name);
          } catch {
            v = undefined;
          }
          read.set(name, v);
        }
        return read.get(name);
      },
      set(name, value) {
        s.set(name, value);
        read.set(name, value);
      },
      forget(name) {
        s.forget(name);
        read.delete(name);
      },
    };
  }
  return shared;
}
