import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  ADAPTER_KINDS,
  ADAPTER_TYPES,
  addManifestRepos,
  addPattern,
  DEFAULT_RUNTIME,
  orgPackFileProblems,
  orgPackFileRel,
  readOrgPackFile,
  Runtime,
  RUNTIME_SCHEMA_VERSION,
  setManifestField,
  setRuntimeAdapter,
  SetupEditError,
  writeOrgPackFile,
} from "../src/index.js";

/** ADR 0190: settings and setup in the app, each edit through its schema, previewed first. */

const made: string[] = [];
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

const RUNTIME = [
  "# How AI runs here. Changed through a pull request.",
  "schemaVersion: 4",
  "assistants:",
  "  allowed: [copilot, claude-code] # the two the teams use",
  "  default: copilot",
  "adapters: {}",
  "",
].join("\n");

async function metarepo(o: { runtime?: string; manifest?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-setup-edit-"));
  made.push(root);
  await mkdir(join(root, "org-pack", "profiles", "forge"), { recursive: true });
  await writeFile(join(root, "org-pack", "runtime.yaml"), o.runtime ?? RUNTIME);
  await writeFile(
    join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml"),
    o.manifest ?? "schemaVersion: 3\nplatform: forge\nrepos: []\n",
  );
  return root;
}

const repo = (id: string) => ({
  id,
  url: `https://dev.azure.com/forgeorg/Forge%20Payments/_git/${id}`,
  type: "unknown",
  owner: "unassigned",
});

describe("the default runtime.yaml", () => {
  it("is at the current version, so AI decides needs no upgrade in a new metarepo", () => {
    expect(DEFAULT_RUNTIME.schemaVersion).toBe(RUNTIME_SCHEMA_VERSION);
    expect(Runtime.safeParse({ ...DEFAULT_RUNTIME, decide: { links: "auto" } }).success).toBe(true);
  });
});

describe("the adapter types the app offers", () => {
  it("are each one the Runtime schema takes", () => {
    for (const kind of ADAPTER_KINDS)
      for (const type of ADAPTER_TYPES[kind])
        expect(
          Runtime.safeParse({ ...DEFAULT_RUNTIME, adapters: { [kind]: { type } } }).success,
          `${kind}: ${type}`,
        ).toBe(true);
  });
});

describe("adding many repos to a manifest", () => {
  it("previews the lines, then writes them, in block style", async () => {
    const root = await metarepo();
    const file = join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml");
    const p = await addManifestRepos(root, "forge", [repo("forge-ledger"), repo("forge-cards")], {
      preview: true,
    });
    expect(p.written).toBe(false);
    expect(p.changes.map((c) => c.now).filter(Boolean)).toContain("  - id: forge-cards");
    expect(await readFile(file, "utf8")).toBe("schemaVersion: 3\nplatform: forge\nrepos: []\n");
    const w = await addManifestRepos(root, "forge", [repo("forge-ledger"), repo("forge-cards")]);
    expect(w.written).toBe(true);
    const text = await readFile(file, "utf8");
    expect(text).toContain("repos:\n  - id: forge-ledger\n");
    expect((parse(text) as { repos: unknown[] }).repos).toHaveLength(2);
  });

  it("refuses an id listed already, or twice in the batch, and writes nothing", async () => {
    const root = await metarepo();
    await addManifestRepos(root, "forge", [repo("forge-ledger")]);
    await expect(addManifestRepos(root, "forge", [repo("forge-ledger")])).rejects.toThrow(
      /already lists forge-ledger/,
    );
    await expect(
      addManifestRepos(root, "forge", [repo("forge-cards"), repo("forge-cards")]),
    ).rejects.toThrow(/already lists forge-cards/);
  });

  it("keeps a Windows checkout's line endings and the comments", async () => {
    const root = await metarepo({
      manifest: "# Forge's repos\r\nschemaVersion: 3\r\nplatform: forge\r\nrepos: []\r\n",
    });
    await addManifestRepos(root, "forge", [repo("forge-ledger")]);
    const text = await readFile(
      join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml"),
      "utf8",
    );
    expect(text.startsWith("# Forge's repos\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("sets a repo's type, as Detect the type offers", async () => {
    const root = await metarepo();
    await addManifestRepos(root, "forge", [repo("forge-proto")]);
    const r = await setManifestField(root, "forge-proto", "type", "prototype");
    expect(r.written).toBe(true);
    expect(r.changes).toEqual([{ was: "    type: unknown", now: "    type: prototype" }]);
  });
});

describe("setting an outside system in runtime.yaml", () => {
  it("writes the Git host with the metarepo's id, comments kept, block style", async () => {
    const root = await metarepo();
    const prev = await setRuntimeAdapter(
      root,
      "gitHost",
      { type: "manual", settings: { metarepo: "forge-payments", protectedBranches: ["main"] } },
      { preview: true },
    );
    expect(prev.written).toBe(false);
    expect(prev.changes.some((c) => c.was === "adapters: {}")).toBe(true);
    const w = await setRuntimeAdapter(root, "gitHost", {
      type: "manual",
      settings: { metarepo: "forge-payments", protectedBranches: ["main"] },
    });
    expect(w).toMatchObject({ path: "org-pack/runtime.yaml", written: true });
    const text = await readFile(join(root, "org-pack", "runtime.yaml"), "utf8");
    expect(text).toContain("# How AI runs here.");
    expect(text).toContain("# the two the teams use");
    const rt = Runtime.parse(parse(text));
    expect(rt.adapters.gitHost).toEqual({
      type: "manual",
      settings: { metarepo: "forge-payments", protectedBranches: ["main"] },
    });
  });

  it("writes a type with no settings as the type alone, and takes one out", async () => {
    const root = await metarepo();
    await setRuntimeAdapter(root, "workTracker", { type: "manual", settings: {} });
    let text = await readFile(join(root, "org-pack", "runtime.yaml"), "utf8");
    expect(text).toContain("adapters:\n  workTracker: manual\n");
    await setRuntimeAdapter(root, "workTracker", null);
    text = await readFile(join(root, "org-pack", "runtime.yaml"), "utf8");
    expect(text).not.toContain("workTracker");
  });

  it("refuses a setting named like a secret, and a type the schema doesn't take", async () => {
    const root = await metarepo();
    await expect(
      setRuntimeAdapter(root, "gitHost", { type: "github", settings: { token: "x" } }),
    ).rejects.toThrow(/looks like a secret/);
    await expect(setRuntimeAdapter(root, "gitHost", { type: "svn" })).rejects.toBeInstanceOf(
      SetupEditError,
    );
    expect(await readFile(join(root, "org-pack", "runtime.yaml"), "utf8")).toBe(RUNTIME);
  });
});

describe("the raw editor", () => {
  it("opens only files inside the org pack", () => {
    expect(orgPackFileRel("gates.yaml")).toBe("gates.yaml");
    expect(orgPackFileRel("patterns\\S.GW.SOR.yaml")).toBe("patterns/S.GW.SOR.yaml");
    for (const bad of ["../.git/config", "/etc/passwd", "C:/x.yaml", ".hidden/x.yaml", "a.sh"])
      expect(() => orgPackFileRel(bad), bad).toThrow(SetupEditError);
  });

  it("checks a file with its schema before it writes, onto the file as opened", async () => {
    const root = await metarepo();
    const f = await readOrgPackFile(root, "runtime.yaml");
    expect(f).toMatchObject({ exists: true, checked: true, content: RUNTIME });
    expect(orgPackFileProblems("runtime.yaml", "schemaVersion: 9\n")[0]).toMatch(/runtime.yaml/);
    await expect(
      writeOrgPackFile(root, "runtime.yaml", "schemaVersion: [", { baseSha256: f.sha256 }),
    ).rejects.toThrow(/isn't YAML/);
    const next = RUNTIME.replace("default: copilot", "default: claude-code");
    const p = await writeOrgPackFile(root, "runtime.yaml", next, {
      baseSha256: f.sha256,
      preview: true,
    });
    expect(p.changes).toEqual([{ was: "  default: copilot", now: "  default: claude-code" }]);
    await writeOrgPackFile(root, "runtime.yaml", next, { baseSha256: f.sha256 });
    await expect(
      writeOrgPackFile(root, "runtime.yaml", RUNTIME, { baseSha256: f.sha256 }),
    ).rejects.toThrow(/changed since it was opened/);
  });
});

describe("a new integration pattern", () => {
  const P = {
    code: "S.GW.NWP",
    name: "Synchronous call to Northwind Pay through the gateway",
    definition: "A service calls the Northwind Pay API through the API gateway.",
    interaction: "sync",
    route: "gateway",
    targetType: "vendor",
    controls: ["mTLS", " OAuth client credentials "],
    source: "inputs/wiki/integration-patterns.md",
  };
  it("is its own file, checked with the pattern schema, never over one that is there", async () => {
    const root = await metarepo();
    const p = await addPattern(root, P, { preview: true });
    expect(p).toMatchObject({ path: "org-pack/patterns/S.GW.NWP.yaml", written: false });
    await addPattern(root, P);
    const text = await readFile(join(root, "org-pack", "patterns", "S.GW.NWP.yaml"), "utf8");
    expect(text).toContain("controls:\n  - mTLS\n  - OAuth client credentials\n");
    expect(parse(text)).toMatchObject({ status: "to-review", version: "1.0.0" });
    await expect(addPattern(root, P)).rejects.toThrow(/is there already/);
    await expect(addPattern(root, { ...P, code: "lowercase" })).rejects.toThrow(/pattern code/);
  });
});
