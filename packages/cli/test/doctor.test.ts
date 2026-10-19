import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { GitRunner } from "@maycombhq/workspace";
import {
  doctorChecks,
  doctorCommand,
  versionAtLeast,
  type DoctorCheck,
  type DoctorDeps,
} from "../src/doctor.js";
import { setupSteps } from "../src/baseline-commands.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
let root: string;

const gitWith =
  (config: Record<string, string>, version = "git version 2.45.1"): GitRunner =>
  async (args) => {
    if (args[0] === "--version") return { stdout: version, stderr: "" };
    if (args[0] === "config" && config[args[2]!] !== undefined)
      return { stdout: `${config[args[2]!]}\n`, stderr: "" };
    throw new Error("exit 1");
  };

const healthy = (o: Partial<DoctorDeps> = {}): DoctorDeps => ({
  env: { PATH: "" },
  platform: "linux",
  nodeVersion: "22.13.1",
  git: gitWith({ "user.name": "Pat", "user.email": "pat@example.com" }),
  openspecVersion: async () => "1.14.0",
  portFree: async () => true,
  freeBytes: async () => 50 * 1024 ** 3,
  onPath: (p) => p === "code",
  ...o,
});

const byId = (checks: DoctorCheck[], id: string) => checks.find((c) => c.id === id)!;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-doctor-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
});

describe("atticus doctor", () => {
  it("compares versions the way people write them", () => {
    expect(versionAtLeast("v22.13.0", "22.13.0")).toBe(true);
    expect(versionAtLeast("22.12.9", "22.13.0")).toBe(false);
    expect(versionAtLeast("2.39.3.windows.1", "2.30.0")).toBe(true);
    expect(versionAtLeast("24.0.0", "22.13.0")).toBe(true);
  });

  it("is ready on a healthy machine, with every check ok", async () => {
    const checks = await doctorChecks(root, healthy());
    expect(checks.filter((c) => c.status !== "ok").map((c) => c.id)).toEqual([]);
    const out: string[] = [];
    expect(
      await doctorCommand(root, {}, { out: (l) => out.push(l), err: () => undefined }, healthy()),
    ).toBe(0);
    expect(out.at(-1)).toBe("Ready: this machine has what Atticus needs.");
  });

  it("fails an old Node, a missing git or an OpenSpec that won't run, each with a fix", async () => {
    const checks = await doctorChecks(
      root,
      healthy({
        nodeVersion: "20.11.0",
        git: async () => {
          throw new Error("ENOENT");
        },
        openspecVersion: async () => undefined,
      }),
    );
    for (const id of ["node", "git", "openspec"]) {
      expect(byId(checks, id).status, id).toBe("fail");
      expect(byId(checks, id).fix, id).toBeTruthy();
    }
    const out: string[] = [];
    const code = await doctorCommand(
      root,
      {},
      { out: (l) => out.push(l), err: () => undefined },
      healthy({ nodeVersion: "20.11.0" }),
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/\[FAIL\] Node\.js: Node 20\.11\.0/);
  });

  it("warns about a proxy without a localhost bypass or a CA, and never prints the proxy's value", async () => {
    const env = { PATH: "", HTTPS_PROXY: "http://pat:s3cret@proxy.example.com:8080" };
    const checks = await doctorChecks(root, healthy({ env }));
    expect(byId(checks, "proxy").status).toBe("warn");
    expect(byId(checks, "tls").status).toBe("warn");
    const out: string[] = [];
    await doctorCommand(
      root,
      { json: true },
      { out: (l) => out.push(l), err: () => undefined },
      healthy({ env }),
    );
    expect(out.join("\n")).not.toMatch(/s3cret|proxy\.example\.com/);
    const bypassed = await doctorChecks(
      root,
      healthy({ env: { ...env, NO_PROXY: "localhost,127.0.0.1,.example.com" } }),
    );
    expect(byId(bypassed, "proxy").status).toBe("ok");
  });

  it("checks that NODE_EXTRA_CA_CERTS points at a PEM certificate", async () => {
    const pem = join(root, "corp-root.pem");
    await writeFile(pem, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
    const bad = join(root, "notes.txt");
    await writeFile(bad, "not a certificate");
    expect(
      byId(await doctorChecks(root, healthy({ env: { NODE_EXTRA_CA_CERTS: pem } })), "tls").status,
    ).toBe("ok");
    expect(
      byId(await doctorChecks(root, healthy({ env: { NODE_EXTRA_CA_CERTS: bad } })), "tls").status,
    ).toBe("fail");
    expect(
      byId(
        await doctorChecks(
          root,
          healthy({ env: { NODE_EXTRA_CA_CERTS: join(root, "missing.pem") } }),
        ),
        "tls",
      ).status,
    ).toBe("fail");
  });

  it("on Windows asks for long paths; warns about a busy port, low disk, no identity and no assistant", async () => {
    const checks = await doctorChecks(
      root,
      healthy({
        platform: "win32",
        git: gitWith({}),
        portFree: async () => false,
        freeBytes: async () => 1024 ** 3,
        onPath: () => false,
      }),
    );
    for (const id of ["git-longpaths", "git-identity", "port", "disk", "assistant", "editor"])
      expect(byId(checks, id).status, id).toBe("warn");
    expect(byId(checks, "disk").status).toBe("warn");
    expect(
      byId(await doctorChecks(root, healthy({ freeBytes: async () => 100 * 1024 ** 2 })), "disk")
        .status,
    ).toBe("fail");
  });

  it("puts the machine first on the setup checklist", async () => {
    const ok = await setupSteps(root, { doctor: await doctorChecks(root, healthy()) });
    expect(ok.steps[0]).toMatchObject({ id: "machine", done: true });
    const bad = await setupSteps(root, {
      doctor: await doctorChecks(root, healthy({ nodeVersion: "18.0.0" })),
    });
    expect(bad.steps[0]).toMatchObject({ id: "machine", done: false });
    expect(bad.steps[0]!.fix).toMatch(/Node 22\.13\.0 or later/);
  });
});
