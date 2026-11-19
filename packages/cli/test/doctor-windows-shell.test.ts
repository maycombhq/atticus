import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { doctorChecks, type DoctorCheck, type DoctorDeps } from "../src/doctor.js";
import { upgradeCommand } from "../src/upgrade.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
/**
 * Beta.30: on Windows the first `atticus` after `npm install -g` fails for two reasons that
 * doctor now names: PowerShell won't run atticus.ps1 (its execution policy), or npm's global
 * folder isn't on PATH. Tested here on any machine: the platform and what the two commands
 * print are passed in, and nothing is run.
 */
let root: string;
const NPM = "C:\\Users\\pat\\AppData\\Roaming\\npm";

const machine = (
  o: Partial<DoctorDeps> & { policy?: string | undefined; prefix?: string | undefined },
  asked: string[] = [],
): DoctorDeps => ({
  env: { PATH: `C:\\Windows\\system32;C:\\Program Files\\nodejs;${NPM}` },
  platform: "win32",
  nodeVersion: "22.13.1",
  git: async (args) => ({
    stdout: args[0] === "--version" ? "git version 2.47.0.windows.1\n" : "true\n",
    stderr: "",
  }),
  openspecVersion: async () => "1.14.0",
  openspecStores: async () => true,
  portFree: async () => true,
  freeBytes: async () => 50 * 1024 ** 3,
  onPath: () => true,
  assistantFiles: async () => ({ missing: [], stale: [], edited: [] }),
  keys: { get: () => undefined, set: () => undefined, forget: () => undefined },
  commandOutput: async (program, args) => {
    asked.push([program, ...args].join(" "));
    if (program === "powershell") return "policy" in o ? o.policy : "RemoteSigned\r\n";
    if (program === "npm") return "prefix" in o ? o.prefix : `${NPM}\r\n`;
    return undefined;
  },
  ...o,
});

const byId = (checks: DoctorCheck[], id: string) => checks.find((c) => c.id === id);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-doctor-win-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  await upgradeCommand(root, { by: "pat" }, { out: () => undefined, err: () => undefined });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("atticus doctor on Windows: PowerShell and npm's global folder", () => {
  it("is ok when PowerShell runs local scripts and npm's folder is on PATH, asking each once", async () => {
    const asked: string[] = [];
    const checks = await doctorChecks(root, machine({}, asked));
    expect(byId(checks, "powershell-policy")).toMatchObject({
      status: "ok",
      detail: "PowerShell's execution policy is RemoteSigned: it runs atticus.ps1",
    });
    expect(byId(checks, "npm-path")).toMatchObject({
      status: "ok",
      detail: `npm's global folder (${NPM}) is on PATH`,
    });
    expect(asked).toEqual([
      "powershell -NoProfile -NonInteractive -Command Get-ExecutionPolicy",
      "npm config get prefix",
    ]);
  });

  it.each(["Restricted", "AllSigned", "restricted"])(
    "warns when the policy is %s: atticus.ps1 is blocked; use atticus.cmd or set the policy for this user",
    async (policy) => {
      const c = byId(
        await doctorChecks(root, machine({ policy: `${policy}\r\n` })),
        "powershell-policy",
      )!;
      expect(c.status).toBe("warn");
      expect(c.detail).toMatch(
        /^PowerShell's execution policy is (Restricted|AllSigned): it won't run atticus\.ps1/,
      );
      expect(c.fix).toContain("atticus.cmd");
      expect(c.fix).toContain("Set-ExecutionPolicy -Scope CurrentUser RemoteSigned");
    },
  );

  it.each(["Unrestricted", "Bypass", "RemoteSigned"])("is ok when the policy is %s", async (p) => {
    const checks = await doctorChecks(root, machine({ policy: `${p}\n` }));
    expect(byId(checks, "powershell-policy")?.status).toBe("ok");
  });

  it("warns when npm's global folder isn't on PATH, naming the folder", async () => {
    const c = byId(
      await doctorChecks(
        root,
        machine({ env: { PATH: "C:\\Windows\\system32;C:\\Program Files\\nodejs" } }),
      ),
      "npm-path",
    )!;
    expect(c.status).toBe("warn");
    expect(c.detail).toBe(`npm's global folder (${NPM}) isn't on PATH`);
    expect(c.fix).toContain(NPM);
    expect(c.fix).toContain("new terminal");
  });

  it("finds the folder on PATH whatever its case, quotes, slashes or trailing slash, and under Path", async () => {
    for (const entry of [
      "c:\\users\\pat\\appdata\\roaming\\npm",
      `"${NPM}\\"`,
      "C:/Users/pat/AppData/Roaming/npm/",
    ]) {
      const checks = await doctorChecks(
        root,
        machine({ env: { Path: `C:\\Windows\\system32; ${entry} ;C:\\Tools` } }),
      );
      expect(byId(checks, "npm-path")?.status, entry).toBe("ok");
    }
    // A folder that only begins the same isn't it.
    const near = await doctorChecks(root, machine({ env: { PATH: `${NPM}-old;C:\\Windows` } }));
    expect(byId(near, "npm-path")?.status).toBe("warn");
  });

  it("claims nothing when PowerShell or npm didn't answer (an offline bundle needs neither)", async () => {
    const checks = await doctorChecks(root, machine({ policy: undefined, prefix: undefined }));
    expect(byId(checks, "powershell-policy")).toBeUndefined();
    expect(byId(checks, "npm-path")).toBeUndefined();
    const odd = await doctorChecks(
      root,
      machine({ policy: "'Get-ExecutionPolicy' is not\n", prefix: "  \n" }),
    );
    expect(byId(odd, "powershell-policy")).toBeUndefined();
    expect(byId(odd, "npm-path")).toBeUndefined();
  });

  it("asks neither anywhere but Windows", async () => {
    const asked: string[] = [];
    const checks = await doctorChecks(
      root,
      machine({ platform: "linux", env: { PATH: "" } }, asked),
    );
    expect(byId(checks, "powershell-policy")).toBeUndefined();
    expect(byId(checks, "npm-path")).toBeUndefined();
    expect(asked).toEqual([]);
  });
});
