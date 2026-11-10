import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api, Runtime, RUNTIME_SCHEMA_VERSION } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { extendUiRoutes } from "../src/ui-commands.js";
import { upgradeCheck } from "../src/upgrade.js";
import { confirmFor } from "./confirm-helpers.js";

/**
 * ADR 0190: settings and setup in the app. From an empty folder: create the metarepo (init's
 * code), add repos by pasting clone URLs, set the Git host, edit the org pack through forms and
 * the raw editor, each previewed first and written through its schema, and turn AI decides on in
 * a fresh metarepo with nothing to upgrade. Everything is invented (CLAUDE.md rule 3).
 */

let srv: RunningServer;
let root: string;
const opened: string[] = [];

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const pack = (rel: string) => readFile(join(root, "org-pack", rel), "utf8");

beforeAll(async () => {
  root = join(await mkdtemp(join(tmpdir(), "atticus-setup-")), "forge-payments-metarepo");
  await mkdir(root);
  srv = await startServer({
    root,
    port: 0,
    user: "priya.nair",
    watch: false,
    extend: (r, ctx) =>
      extendUiRoutes(r, ctx, {
        openFolder: async (dir) => {
          opened.push(dir);
          return { url: "http://127.0.0.1:4999" };
        },
      }),
  });
}, 60_000);
afterAll(() => srv?.close());

describe("set up from the app (ADR 0190)", () => {
  it("offers to create the metarepo in a folder that isn't one", async () => {
    expect((await call("GET", "/api/health")).body.metarepo).toBe(false);
    const v = Api.SetupMetarepoView.parse((await call("GET", "/api/setup/metarepo")).body);
    expect(v).toMatchObject({
      metarepo: false,
      folder: "forge-payments-metarepo",
      suggested: { name: "forge-payments-metarepo", platform: "forge-payments" },
    });
    // A step that needs a metarepo says so, never a 500.
    expect((await call("GET", "/api/setup/adapters")).status).toBe(409);
  });

  it("opens another folder's app, and refuses a path that isn't a folder", async () => {
    const r = await call("POST", "/api/setup/open", { path: root });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ url: "http://127.0.0.1:4999", root, metarepo: false });
    expect(opened).toEqual([root]);
    expect((await call("POST", "/api/setup/open", { path: join(root, "nope") })).status).toBe(404);
    expect((await call("POST", "/api/setup/open", { path: "relative/folder" })).status).toBe(400);
  });

  it("creates the metarepo with init's code: current runtime.yaml, a manual Git host", async () => {
    const r = await call("POST", "/api/setup/metarepo", {
      name: "forge-payments",
      platform: "forge",
      owner: "priya.nair",
      metarepo: "forge-metarepo",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((r.body.lines as string[]).join("\n")).toMatch(/Created the forge-payments metarepo/);
    expect((await call("GET", "/api/health")).body.metarepo).toBe(true);
    const rt = Runtime.parse(parse(await pack("runtime.yaml")));
    expect(rt.schemaVersion).toBe(RUNTIME_SCHEMA_VERSION);
    expect(rt.adapters.gitHost).toEqual({
      type: "manual",
      settings: { metarepo: "forge-metarepo" },
    });
    // Up to date: the upgrade check and the app agree there is nothing to run.
    expect((await upgradeCheck(root)).pending).toEqual([]);
    expect((await call("POST", "/api/setup/metarepo", { name: "x", platform: "x" })).status).toBe(
      409,
    );
  }, 60_000);

  it("turns AI decides on in the fresh metarepo, with no upgrade step", async () => {
    const r = await call("PUT", "/api/settings/ai", {
      decide: { links: "auto", questions: "propose", minPrecision: 0.9 },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(parse(await pack("runtime.yaml"))).toMatchObject({
      schemaVersion: 4,
      decide: { links: "auto" },
    });
    expect((await upgradeCheck(root)).pending).toEqual([]);
  });

  it("reads pasted clone URLs: normalised, a duplicate once, a taken id made -2", async () => {
    const r = await call("POST", "/api/setup/repos/plan", {
      urls: [
        "https://priya:s3cret@dev.azure.com/forgeorg/Forge%20Payments/_git/forge-ledger?path=/src",
        "<https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-cards>",
        "https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-ledger",
        "git@ssh.dev.azure.com:v3/forgeorg/Forge%20Payments/forge-gateway",
        "https://git.northwind.example/partners/forge-cards.git",
      ].join("\n"),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const plan = Api.ReposPlanView.parse(r.body);
    expect(plan.platform).toBe("forge");
    expect(plan.repos.map((x) => [x.id, x.url])).toEqual([
      ["forge-ledger", "https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-ledger"],
      ["forge-cards", "https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-cards"],
      ["forge-gateway", "git@ssh.dev.azure.com:v3/forgeorg/Forge%20Payments/forge-gateway"],
      ["forge-cards-2", "https://git.northwind.example/partners/forge-cards.git"],
    ]);
    expect(plan.repos[0]!.given).toMatch(/s3cret/);
    expect(plan.repos[3]!.renamed).toEqual({
      from: "forge-cards",
      why: "another repo here is forge-cards too",
    });
  });

  it("previews the manifest's lines, then writes the repos ticked, with descriptions", async () => {
    const repos = [
      {
        id: "forge-ledger",
        url: "https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-ledger",
        description: "The ledger every Forge payment posts to.",
      },
      {
        id: "forge-cards",
        url: "https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-cards",
      },
      {
        id: "forge-gateway",
        url: "git@ssh.dev.azure.com:v3/forgeorg/Forge%20Payments/forge-gateway",
      },
    ];
    const before = await pack("profiles/forge/repos.manifest.yaml");
    const p = Api.FileEditView.parse(
      (await call("POST", "/api/setup/repos", { repos, preview: true })).body,
    );
    expect(p).toMatchObject({
      path: "org-pack/profiles/forge/repos.manifest.yaml",
      written: false,
    });
    expect(p.changes.some((c) => c.now === "  - id: forge-gateway")).toBe(true);
    expect(await pack("profiles/forge/repos.manifest.yaml")).toBe(before);
    const w = await call("POST", "/api/setup/repos", { repos });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(w.body.note).toMatch(/propose it for review/);
    const m = parse(await pack("profiles/forge/repos.manifest.yaml")) as {
      repos: { id: string; owner: string; type: string; description?: { by: string } }[];
    };
    expect(m.repos.map((x) => x.id)).toEqual(["forge-ledger", "forge-cards", "forge-gateway"]);
    expect(m.repos[0]).toMatchObject({ owner: "unassigned", type: "unknown" });
    expect(m.repos[0]!.description).toMatchObject({ by: "priya.nair", trust: "verified" });
    // Pasted again: listed already, left out; a second add of a listed id is refused.
    const again = Api.ReposPlanView.parse(
      (
        await call("POST", "/api/setup/repos/plan", {
          urls: "https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-ledger.git",
        })
      ).body,
    );
    expect(again.repos).toEqual([]);
    expect(again.listed[0]!.id).toBe("forge-ledger");
    expect((await call("POST", "/api/setup/repos", { repos: [repos[0]] })).status).toBe(422);
  });

  it("discovers a folder of clones with repos discover's code, listed ones left out", async () => {
    const clones = await mkdtemp(join(tmpdir(), "atticus-clones-"));
    const clone = async (name: string, url: string) => {
      await mkdir(join(clones, name, ".git"), { recursive: true });
      await writeFile(join(clones, name, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(clones, name, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
      await writeFile(join(clones, name, "package.json"), '{ "name": "x" }\n');
    };
    await clone(
      "forge-ledger",
      "https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-ledger",
    );
    await clone("forge-notes", "https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-notes");
    const plan = Api.ReposPlanView.parse(
      (await call("POST", "/api/setup/repos/plan", { dir: clones })).body,
    );
    expect(plan.repos.map((x) => x.id)).toEqual(["forge-notes"]);
    expect(plan.repos[0]).toMatchObject({ defaultBranch: "main" });
    expect(plan.listed.map((x) => x.id)).toEqual(["forge-ledger"]);
    expect((await call("POST", "/api/setup/repos/plan", { dir: join(clones, "no") })).status).toBe(
      404,
    );
  });

  it("detects a cloned repo's type from its files and sets it in the manifest", async () => {
    expect((await call("POST", "/api/repos/forge-cards/type/detect")).status).toBe(409);
    const clone = join(root, "workspace", "forge-cards");
    await mkdir(clone, { recursive: true });
    await writeFile(
      join(clone, "pom.xml"),
      "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>\n",
    );
    const d = Api.RepoTypeDetectView.parse(
      (await call("POST", "/api/repos/forge-cards/type/detect")).body,
    );
    expect(d).toMatchObject({ repo: "forge-cards", from: "files", type: "spring-boot" });
    const p = await call("PUT", "/api/repos/forge-cards/type", { type: d.type, preview: true });
    expect(p.body.changes).toEqual([{ was: "    type: unknown", now: "    type: spring-boot" }]);
    expect((await call("PUT", "/api/repos/forge-cards/type", { type: d.type })).body.written).toBe(
      true,
    );
    expect((await call("POST", "/api/repos/nope/type/detect")).status).toBe(404);
  });

  it("sets the Git host and the work tracker, never with a secret", async () => {
    const a = Api.AdaptersView.parse((await call("GET", "/api/setup/adapters")).body);
    const git = a.kinds.find((k) => k.kind === "gitHost")!;
    expect(git.types).toEqual(["manual", "github", "azure-repos", "gitlab", "bitbucket"]);
    expect(git.current).toEqual({ type: "manual", settings: { metarepo: "forge-metarepo" } });
    const w = await call("PUT", "/api/setup/adapters/gitHost", {
      value: {
        type: "manual",
        settings: { metarepo: "forge-payments-metarepo", protectedBranches: ["main", "release"] },
      },
    });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(Runtime.parse(parse(await pack("runtime.yaml"))).adapters.gitHost?.settings).toEqual({
      metarepo: "forge-payments-metarepo",
      protectedBranches: ["main", "release"],
    });
    const t = await call("PUT", "/api/setup/adapters/workTracker", {
      value: { type: "manual", settings: { project: "Forge Payments" } },
    });
    expect(t.status).toBe(200);
    expect(await pack("runtime.yaml")).toContain("project: Forge Payments");
    const named = await call("PUT", "/api/setup/adapters/gitHost", {
      value: { type: "github", settings: { tokenEnv: "GITHUB_TOKEN" } },
    });
    expect(named.status).toBe(422);
    expect(JSON.stringify(named.body)).toMatch(/looks like a secret/);
    const value = await call("PUT", "/api/setup/adapters/gitHost", {
      value: { type: "github", settings: { metarepo: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } },
    });
    expect(value.status).toBe(422);
    expect(await pack("runtime.yaml")).not.toContain("ghp_");
    expect((await call("PUT", "/api/setup/adapters/ftp", { value: null })).status).toBe(404);
  });

  it("edits any org-pack file in the raw editor, checked with its schema", async () => {
    const f = Api.OrgPackFileView.parse(
      (await call("GET", "/api/setup/file?path=gates.yaml")).body,
    );
    expect(f).toMatchObject({ path: "org-pack/gates.yaml", exists: true, checked: true });
    const bad = await call("PUT", "/api/setup/file", {
      path: "gates.yaml",
      content: "schemaVersion: 1\ngates: nope\n",
      baseSha256: f.sha256,
    });
    expect(bad.status).toBe(422);
    const next = `# Our gates, reviewed by the platform team.\n${f.content}`;
    const p = await call("PUT", "/api/setup/file", {
      path: "gates.yaml",
      content: next,
      baseSha256: f.sha256,
      preview: true,
    });
    expect(p.body).toMatchObject({ written: false });
    const w = await call("PUT", "/api/setup/file", {
      path: "gates.yaml",
      content: next,
      baseSha256: f.sha256,
    });
    expect(w.body).toMatchObject({ written: true });
    expect((await call("GET", "/api/setup/file?path=../.git/config")).status).toBe(422);
  });

  it("asks the person before the raw editor moves where the model's key goes", async () => {
    const f = Api.OrgPackFileView.parse(
      (await call("GET", "/api/setup/file?path=runtime.yaml")).body,
    );
    const content = f.content.replace(
      /^adapters:\n/m,
      "adapters:\n  model:\n    type: openai-compatible\n    settings: { baseUrl: https://models.northwind.example/v1, keyEnv: ATTICUS_MODEL_KEY }\n",
    );
    const p = await call("PUT", "/api/setup/file", {
      path: "runtime.yaml",
      content,
      baseSha256: f.sha256,
      preview: true,
    });
    expect(p.body).toMatchObject({ written: false, confirm: "ai-model" });
    const no = await call("PUT", "/api/setup/file", {
      path: "runtime.yaml",
      content,
      baseSha256: f.sha256,
    });
    expect(no.status).toBe(403);
    const yes = await call("PUT", "/api/setup/file", {
      path: "runtime.yaml",
      content,
      baseSha256: f.sha256,
      confirmation: await confirmFor(srv, "ai-model", "model"),
    });
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
  });

  it("adds an integration pattern and a wiki through their forms", async () => {
    const pattern = {
      code: "S.GW.NWP",
      name: "Synchronous call to Northwind Pay through the gateway",
      definition: "A service calls the Northwind Pay API through the API gateway.",
      interaction: "sync",
      route: "gateway",
      targetType: "vendor",
      controls: ["mTLS"],
      source: "inputs/wiki/integration-patterns.md",
    };
    expect((await call("POST", "/api/setup/patterns", pattern)).status).toBe(200);
    expect(await pack("patterns/S.GW.NWP.yaml")).toContain("code: S.GW.NWP");
    expect((await call("POST", "/api/setup/patterns", pattern)).status).toBe(409);
    await mkdir(join(root, "docs-wiki"), { recursive: true });
    const p = await call("POST", "/api/setup/sources", {
      type: "markdown-folder",
      location: "docs-wiki",
      preview: true,
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect((p.body.changes as { now: string }[])[0]!.now).toMatch(/id: docs-wiki/);
    expect(await pack("sources.yaml")).not.toContain("docs-wiki");
    const w = await call("POST", "/api/setup/sources", {
      type: "markdown-folder",
      location: "docs-wiki",
    });
    expect(w.status).toBe(200);
    expect(await pack("sources.yaml")).toContain("id: docs-wiki");
    expect((await call("POST", "/api/setup/sources", { type: "ftp", location: "x" })).status).toBe(
      422,
    );
  });

  it("never writes a wiki's address with a user name or token in it", async () => {
    const before = await pack("sources.yaml");
    for (const location of [
      "https://oauth2:glpat-abcdefghijklmnopqrst@git.forge.example/forge/wiki.git",
      "https://glpat-abcdefghijklmnopqrst@git.forge.example/forge/wiki.git",
      "https://forge-bot@git.forge.example/forge/wiki.git",
    ]) {
      const r = await call("POST", "/api/setup/sources", { type: "git", location });
      expect(r.status, location).toBe(422);
      expect(JSON.stringify(r.body)).toMatch(/credential helper/);
    }
    expect(await pack("sources.yaml")).toBe(before);
    // A setting's value like it is refused too.
    const a = await call("PUT", "/api/setup/adapters/gitHost", {
      value: { type: "manual", settings: { apiBase: "https://forge-bot@git.forge.example/api" } },
    });
    expect(a.status).toBe(422);
  });

  it("refuses a write from an adapter form read before another edit", async () => {
    const a = Api.AdaptersView.parse((await call("GET", "/api/setup/adapters")).body);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    const value = { type: "manual", settings: { project: "Forge Cards" } };
    const ok = await call("PUT", "/api/setup/adapters/workTracker", {
      value,
      baseSha256: a.sha256,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const stale = await call("PUT", "/api/setup/adapters/workTracker", {
      value: { type: "manual", settings: { project: "Forge Old" } },
      baseSha256: a.sha256,
    });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toMatch(/changed since/);
    expect(await pack("runtime.yaml")).toContain("project: Forge Cards");
  });

  it("checks runtime.yaml in the raw editor whatever the case of its name", async () => {
    const f = Api.OrgPackFileView.parse(
      (await call("GET", "/api/setup/file?path=runtime.yaml")).body,
    );
    const r = await call("PUT", "/api/setup/file", {
      path: "Runtime.yaml",
      content:
        "schemaVersion: 99\nadapters:\n  gitHost:\n    type: github\n    settings:\n      metarepo: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
      baseSha256: f.sha256,
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toMatch(/open runtime\.yaml/);
    expect(await pack("runtime.yaml")).toBe(f.content);
    expect(
      (await call("GET", "/api/setup/file?path=Profiles/forge/repos.manifest.yaml")).status,
    ).toBe(422);
  });

  it("saves a fix over a runtime.yaml that doesn't parse; content that doesn't read is 422", async () => {
    const good = await pack("runtime.yaml");
    await writeFile(join(root, "org-pack", "runtime.yaml"), "schemaVersion: [4\n");
    const f = Api.OrgPackFileView.parse(
      (await call("GET", "/api/setup/file?path=runtime.yaml")).body,
    );
    const empty = await call("PUT", "/api/setup/file", {
      path: "runtime.yaml",
      content: good.replace(/^adapters:\n/m, "adapters:\n  wiki:\n"),
      baseSha256: f.sha256,
    });
    expect(empty.status, JSON.stringify(empty.body)).toBe(422);
    // Nothing to compare the model's address with, so the person confirms where it goes.
    const p = await call("PUT", "/api/setup/file", {
      path: "runtime.yaml",
      content: good,
      baseSha256: f.sha256,
      preview: true,
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ confirm: "ai-model" });
    const fix = await call("PUT", "/api/setup/file", {
      path: "runtime.yaml",
      content: good,
      baseSha256: f.sha256,
      confirmation: await confirmFor(srv, "ai-model", "model"),
    });
    expect(fix.status, JSON.stringify(fix.body)).toBe(200);
    expect(await pack("runtime.yaml")).toBe(good);
  });

  it("asks which platform a folder's repos are for when there are several", async () => {
    await mkdir(join(root, "org-pack", "profiles", "northwind"), { recursive: true });
    await writeFile(
      join(root, "org-pack", "profiles", "northwind", "repos.manifest.yaml"),
      "schemaVersion: 3\nplatform: northwind\nrepos: []\n",
    );
    const clones = await mkdtemp(join(tmpdir(), "atticus-clones-"));
    await mkdir(join(clones, "nw-fees", ".git"), { recursive: true });
    await writeFile(join(clones, "nw-fees", ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(clones, "nw-fees", "package.json"), '{ "name": "x" }\n');
    const r = await call("POST", "/api/setup/repos/plan", { dir: clones });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const ask = Api.ReposPlanView.parse(r.body);
    expect(ask.platforms).toEqual(["forge", "northwind"]);
    expect(ask.platform).toBeUndefined();
    expect(ask.repos).toEqual([]);
    const plan = Api.ReposPlanView.parse(
      (await call("POST", "/api/setup/repos/plan", { dir: clones, platform: "northwind" })).body,
    );
    expect(plan).toMatchObject({ platform: "northwind" });
    expect(plan.repos.map((x) => x.id)).toEqual(["nw-fees"]);
  });

  it("refuses a raw manifest edit listing a repo id another profile lists", async () => {
    const rel = "profiles/northwind/repos.manifest.yaml";
    const f = Api.OrgPackFileView.parse((await call("GET", `/api/setup/file?path=${rel}`)).body);
    const r = await call("PUT", "/api/setup/file", {
      path: rel,
      content:
        "schemaVersion: 3\nplatform: northwind\nrepos:\n  - id: forge-ledger\n    url: https://git.northwind.example/nw/forge-ledger.git\n    type: unknown\n    owner: unassigned\n",
      baseSha256: f.sha256,
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toMatch(/already lists forge-ledger/);
  });
});
