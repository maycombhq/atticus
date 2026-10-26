import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
import { upgradeCommand } from "../src/upgrade.js";

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
  openspecStores: async () => true,
  portFree: async () => true,
  freeBytes: async () => 50 * 1024 ** 3,
  onPath: (p) => p === "code",
  assistantFiles: async () => ({ missing: [], stale: [], edited: [] }),
  ...o,
});

const byId = (checks: DoctorCheck[], id: string) => checks.find((c) => c.id === id)!;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-doctor-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  // Up to date, so the machine checks are the only ones that vary here.
  await upgradeCommand(root, { by: "pat" }, { out: () => undefined, err: () => undefined });
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

  it("says whether OpenSpec has stores (beta): a note when nothing uses them, a warning when the metarepo does (ADR 0126)", async () => {
    const plain = byId(
      await doctorChecks(root, healthy({ openspecStores: async () => false })),
      "openspec-stores",
    );
    expect(plain).toMatchObject({
      label: "OpenSpec stores (beta)",
      status: "ok",
      detail: "the installed OpenSpec has no stores; nothing here uses them",
    });
    const have = byId(
      await doctorChecks(root, healthy({ openspecStores: async () => true })),
      "openspec-stores",
    );
    expect(have).toMatchObject({
      status: "ok",
      detail:
        "OpenSpec 1.14.0 has stores; this metarepo isn't one (optional: atticus upgrade --openspec-store)",
    });

    const store = await mkdtemp(join(tmpdir(), "atticus-doctor-store-"));
    await cp(join(FIXTURES, "forge/metarepo"), store, { recursive: true });
    await upgradeCommand(store, { by: "pat" }, { out: () => undefined, err: () => undefined });
    await mkdir(join(store, ".openspec-store"));
    await writeFile(join(store, ".openspec-store/store.yaml"), "version: 1\nid: forge\n");
    await writeFile(
      join(store, "org-pack/openspec.yaml"),
      "schemaVersion: 1\nstores:\n  - path: ../forge-payments-store\n",
    );
    expect(
      byId(
        await doctorChecks(store, healthy({ openspecStores: async () => true })),
        "openspec-stores",
      ).detail,
    ).toBe(
      "OpenSpec 1.14.0 has stores; this metarepo is the store forge; org-pack/openspec.yaml names 1 store to read",
    );
    const lacking = byId(
      await doctorChecks(store, healthy({ openspecStores: async () => false })),
      "openspec-stores",
    );
    expect(lacking).toMatchObject({
      status: "warn",
      detail:
        "the installed OpenSpec has no stores, but this metarepo is the store forge; org-pack/openspec.yaml names 1 store to read",
    });
    expect(lacking.fix).toMatch(/^Plain OpenSpec can't register this metarepo/);
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

  it("says whether the slash-command files are there and current (ADR 0119)", async () => {
    const missing = await doctorChecks(
      root,
      healthy({
        assistantFiles: async () => ({
          missing: [".github/prompts/atticus-feature.prompt.md"],
          stale: [],
          edited: [],
        }),
      }),
    );
    expect(byId(missing, "assistant-files")).toMatchObject({ status: "warn" });
    expect(byId(missing, "assistant-files").detail).toContain("1 missing");
    expect(byId(missing, "assistant-files").fix).toContain("atticus assistant-files");
    const stale = await doctorChecks(
      root,
      healthy({
        assistantFiles: async () => ({
          missing: [],
          stale: ["a.md", "b.md"],
          edited: ["c.md"],
        }),
      }),
    );
    expect(byId(stale, "assistant-files").detail).toContain("2 out of date");
    expect(byId(stale, "assistant-files").detail).toContain("1 edited by hand");
    expect(byId(await doctorChecks(root, healthy()), "assistant-files").status).toBe("ok");
  });

  it("says how AI steps run here, and whether model mode has a provider and its key, by name only", async () => {
    const handoff = byId(await doctorChecks(root, healthy()), "model");
    expect(handoff).toMatchObject({ status: "ok" });
    expect(handoff.detail).toMatch(/hand off to your assistant/);
    // The Forge pack allows headless Claude Code: said, so nobody thinks only hand-off runs here.
    expect(handoff.detail).toContain("headless Claude Code");
    const own = await mkdtemp(join(tmpdir(), "atticus-doctor-model-"));
    await cp(join(FIXTURES, "forge/metarepo"), own, { recursive: true });
    const rt = (adapter: string) =>
      writeFile(
        join(own, "org-pack/runtime.yaml"),
        [
          "schemaVersion: 1",
          "assistants: { allowed: [copilot], default: copilot }",
          "modes: { allowed: [hand-off, model], default: hand-off }",
          "adapters:",
          adapter,
        ].join("\n"),
      );
    await rt("  gitHost: { type: mock }");
    expect(byId(await doctorChecks(own, healthy()), "model")).toMatchObject({ status: "warn" });
    await rt(
      "  model: { type: anthropic, settings: { model: claude-opus-5-5, keyEnv: ATTICUS_MODEL_KEY } }",
    );
    const unset = byId(await doctorChecks(own, healthy()), "model");
    expect(unset.status).toBe("warn");
    expect(unset.detail).toContain("ATTICUS_MODEL_KEY isn't set");
    const set = byId(
      await doctorChecks(own, healthy({ env: { PATH: "", ATTICUS_MODEL_KEY: "sk-secret-value" } })),
      "model",
    );
    expect(set.status).toBe("ok");
    expect(set.detail).toContain("anthropic");
    expect(JSON.stringify(set)).not.toContain("sk-secret-value");
  });

  it("says at which tier the assistant reads a repo, and how to see what the first read costs (ADR 0124 §4)", async () => {
    const tier = byId(await doctorChecks(root, healthy()), "tier");
    expect(tier.status).toBe("ok");
    expect(tier.label).toBe("First read of a repo");
    // No probe ran here (ADR 0124 addendum A-probe): read off runtime.yaml, and said so.
    expect(tier.detail).toMatch(
      /^agentic \(tier 1\), from runtime\.yaml: Copilot in VS Code agent mode/,
    );
    expect(tier.detail).toContain("atticus map <repo> --handoff --max-tokens");
    expect(tier.detail).toContain("atticus map <repo> --estimate");
    const own = await mkdtemp(join(tmpdir(), "atticus-doctor-tier-"));
    await cp(join(FIXTURES, "forge/metarepo"), own, { recursive: true });
    await writeFile(
      join(own, "org-pack/runtime.yaml"),
      "schemaVersion: 1\nassistants: { allowed: [copilot], default: copilot }\neditors: [intellij]\n",
    );
    expect(byId(await doctorChecks(own, healthy()), "tier").detail).toMatch(
      /^copy-paste \(tier 3\), from runtime\.yaml: .*atticus map <repo> --copy/,
    );
  });

  it("reports the embedding model: off for the test suites, never a failure by default, a warning when runtime.yaml names one it can't use (ADR 0116 addenda)", async () => {
    // The test suites run with ATTICUS_EMBEDDINGS=off (vitest.shared.mjs): a note that says so.
    const env = byId(await doctorChecks(root, healthy()), "embeddings");
    expect(env.status).toBe("ok");
    expect(env.detail).toMatch(
      /^off \(ATTICUS_EMBEDDINGS is off for this process\); the context engine searches by words and names only/,
    );
    const was = process.env.ATTICUS_EMBEDDINGS;
    delete process.env.ATTICUS_EMBEDDINGS;
    try {
      // The default is the model installed with Atticus. A checkout has it only after
      // pnpm model:fetch: either way it is never a failure, and a missing one says so.
      const dflt = byId(await doctorChecks(root, healthy()), "embeddings");
      expect(dflt.status).not.toBe("fail");
      expect(dflt.detail).toMatch(
        /all-minilm-l6-v2@|so the context engine searches by words and names only/,
      );
      const own = await mkdtemp(join(tmpdir(), "atticus-doctor-embed-"));
      await cp(join(FIXTURES, "forge/metarepo"), own, { recursive: true });
      const rt = (model: string) =>
        writeFile(
          join(own, "org-pack/runtime.yaml"),
          [
            "schemaVersion: 1",
            "assistants: { allowed: [copilot], default: copilot }",
            `retrieval: { embeddings: { model: ${model} } }`,
          ].join("\n"),
        );
      await rt("models/none");
      const named = byId(await doctorChecks(own, healthy()), "embeddings");
      expect(named.status).toBe("warn");
      expect(named.detail).toMatch(/so the context engine searches by words and names only/);
      await rt("off");
      const off = byId(await doctorChecks(own, healthy()), "embeddings");
      expect(off).toMatchObject({ status: "ok" });
      expect(off.detail).toMatch(/^off/);
    } finally {
      if (was !== undefined) process.env.ATTICUS_EMBEDDINGS = was;
    }
  });

  it("says the embedding plugin isn't installed, as a note, when the bundle leaves it out (ADR 0124 addendum D-bundle)", async () => {
    const missing = () =>
      Promise.reject(
        Object.assign(new Error("Cannot find package '@maycombhq/embed' imported from doctor.js"), {
          code: "ERR_MODULE_NOT_FOUND",
        }),
      );
    const was = process.env.ATTICUS_EMBEDDINGS;
    delete process.env.ATTICUS_EMBEDDINGS;
    try {
      const dflt = byId(await doctorChecks(root, { ...healthy(), embed: missing }), "embeddings");
      expect(dflt.status).toBe("ok");
      expect(dflt.detail).toMatch(
        /^not installed \(@maycombhq\/embed, an optional plugin\), so the context engine searches by words and names only/,
      );
      expect(dflt.fix).toMatch(/--with-embeddings/);
      // The plugin zip adds it to an installed bundle; npm leaves it out with --omit=optional.
      expect(dflt.fix).toMatch(/embeddings-plugin\.zip/);
      expect(dflt.fix).toMatch(/fetch-model\.mjs/);
      expect(dflt.fix).toMatch(/--omit=optional/);
      // A model runtime.yaml names that can't be used is a warning, as before.
      const own = await mkdtemp(join(tmpdir(), "atticus-doctor-noembed-"));
      await cp(join(FIXTURES, "forge/metarepo"), own, { recursive: true });
      await writeFile(
        join(own, "org-pack/runtime.yaml"),
        [
          "schemaVersion: 1",
          "assistants: { allowed: [copilot], default: copilot }",
          "retrieval: { embeddings: { model: models/minilm } }",
        ].join("\n"),
      );
      expect(
        byId(await doctorChecks(own, { ...healthy(), embed: missing }), "embeddings"),
      ).toMatchObject({
        status: "warn",
      });
      // Turned off, there is nothing to install.
      await writeFile(
        join(own, "org-pack/runtime.yaml"),
        [
          "schemaVersion: 1",
          "assistants: { allowed: [copilot], default: copilot }",
          "retrieval: { embeddings: { model: off } }",
        ].join("\n"),
      );
      const off = byId(await doctorChecks(own, { ...healthy(), embed: missing }), "embeddings");
      expect(off.status).toBe("ok");
      expect(off.detail).toMatch(/^off/);
    } finally {
      if (was !== undefined) process.env.ATTICUS_EMBEDDINGS = was;
    }
  });

  it("says the model installed with Atticus is ready, and its runtime (ADR 0124 addendum D-npm)", async () => {
    // An npm install carries the model's and onnxruntime's bytes: doctor says it is ready.
    const ready = (setting: string) => async () =>
      ({
        embeddingState: async () => ({
          setting,
          configured: setting !== "bundled",
          dir: "/opt/atticus/node_modules/@maycombhq/embed-model",
          id: "all-minilm-l6-v2@759c3cd2b7fe",
          bytes: 90_387_606,
          licence: "Apache-2.0",
        }),
        runtimeAvailable: async () => "native" as const,
      }) as unknown as typeof import("@maycombhq/embed");
    const was = process.env.ATTICUS_EMBEDDINGS;
    delete process.env.ATTICUS_EMBEDDINGS;
    try {
      const npm = byId(
        await doctorChecks(root, { ...healthy(), embed: ready("bundled") }),
        "embeddings",
      );
      expect(npm.status).toBe("ok");
      expect(npm.detail).toBe(
        "ready: all-minilm-l6-v2@759c3cd2b7fe (86 MB, Apache-2.0), installed with Atticus, in /opt/atticus/node_modules/@maycombhq/embed-model; runtime: native",
      );
      const named = byId(
        await doctorChecks(root, { ...healthy(), embed: ready("models/minilm") }),
        "embeddings",
      );
      expect(named.detail).toMatch(
        /^ready: all-minilm-l6-v2@759c3cd2b7fe \(86 MB, Apache-2\.0\), the folder runtime\.yaml names, in /,
      );
    } finally {
      if (was !== undefined) process.env.ATTICUS_EMBEDDINGS = was;
    }
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

describe("facts read (ADR 0124: Atticus 2 reads a repo with the assistant, not a scan)", () => {
  it("says at which commit each repo's facts were read, or that it isn't read yet, and nothing of a scan", async () => {
    const at = await mkdtemp(join(tmpdir(), "atticus-doctor-facts-"));
    await cp(join(FIXTURES, "forge/metarepo"), at, { recursive: true });
    await upgradeCommand(at, { by: "pat" }, { out: () => undefined, err: () => undefined });
    await mkdir(join(at, "facts"), { recursive: true });
    await writeFile(join(at, "facts", "forge-ledger.jsonl"), "");
    await writeFile(
      join(at, "facts", "forge-ledger.verify.yaml"),
      "repo: forge-ledger\ncommit: 0123abcdef0123abcdef0123abcdef0123abcdef\naccepted: 0\n",
    );
    // Read, never verified.
    await writeFile(join(at, "facts", "forge-portal-bff.jsonl"), "");
    const checks = await doctorChecks(at, healthy());
    expect(checks.find((c) => c.id === "last-scan")).toBeUndefined();
    const c = byId(checks, "facts-read");
    expect(c).toMatchObject({ label: "Facts read", status: "ok" });
    expect(c.detail).toBe(
      "forge-ledger at 0123abcdef01; forge-portal-bff read, not verified yet; not read yet: forge-events, forge-gateway, forge-infra, forge-portal-ui, forge-reports-job",
    );
    expect(c.fix).toBe(
      "Read a repo with /atticus-map <repo> in your assistant (or atticus map <repo>), then atticus verify <repo> --write.",
    );
    // A metarepo that never read a repo says so, still ok: the machine is fine.
    expect(byId(await doctorChecks(root, healthy()), "facts-read")).toMatchObject({
      status: "ok",
      detail:
        "not read yet: forge-events, forge-gateway, forge-infra, forge-ledger, forge-portal-bff, forge-portal-ui, forge-reports-job",
    });
  });
});

describe("default branches (ADR 0123)", () => {
  it("warns when a repo is read from another branch than its remote's default, offline", async () => {
    const at = await mkdtemp(join(tmpdir(), "atticus-doctor-branches-"));
    await cp(join(FIXTURES, "forge/metarepo"), at, { recursive: true });
    await upgradeCommand(at, { by: "pat" }, { out: () => undefined, err: () => undefined });
    await mkdir(join(at, "workspace", "forge-ledger"), { recursive: true });
    const base = gitWith({ "user.name": "Pat", "user.email": "pat@example.com" });
    const git: GitRunner = async (args, cwd) =>
      args[0] === "symbolic-ref" && cwd?.endsWith("forge-ledger")
        ? { stdout: "origin/develop\n", stderr: "" }
        : base(args, cwd);
    const c = byId(await doctorChecks(at, healthy({ git })), "default-branches");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("forge-ledger (manifest main, remote develop)");
    expect(c.fix).toMatch(/defaultBranch/);
    expect(byId(await doctorChecks(root, healthy()), "default-branches").status).toBe("ok");
  });

  it("asks git about every base clone at once, and lists them in the manifest's order", async () => {
    const at = await mkdtemp(join(tmpdir(), "atticus-doctor-branches-"));
    await cp(join(FIXTURES, "forge/metarepo"), at, { recursive: true });
    await upgradeCommand(at, { by: "pat" }, { out: () => undefined, err: () => undefined });
    for (const id of ["forge-ledger", "forge-events", "forge-gateway"])
      await mkdir(join(at, "workspace", id), { recursive: true });
    const base = gitWith({ "user.name": "Pat", "user.email": "pat@example.com" });
    let running = 0;
    let most = 0;
    const git: GitRunner = async (args, cwd) => {
      if (args[0] !== "symbolic-ref") return base(args, cwd);
      running++;
      most = Math.max(most, running);
      // The first asked answers last: the order must still be the manifest's.
      await new Promise((r) => setTimeout(r, cwd?.endsWith("forge-ledger") ? 60 : 10));
      running--;
      return { stdout: "origin/develop\n", stderr: "" };
    };
    const c = byId(await doctorChecks(at, healthy({ git })), "default-branches");
    expect(most).toBeGreaterThan(1);
    // repos.manifest.yaml lists forge-ledger, then forge-gateway, then forge-events.
    expect([...c.detail.matchAll(/(forge-[a-z-]+) \(manifest/g)].map((m) => m[1])).toEqual([
      "forge-ledger",
      "forge-gateway",
      "forge-events",
    ]);
  });
});
