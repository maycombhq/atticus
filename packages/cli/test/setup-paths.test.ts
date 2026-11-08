import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";

/**
 * Seventh UX walk (setup): what needed a file edit now has a person's click in the app, writing
 * the file the CLI or a person writes, so the change rides Propose. A repo's build command in its
 * manifest (Repos), and who looks after the org pack in pack.yaml (Set up). Invented Forge names.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const MANIFEST = ["org-pack", "profiles", "forge", "repos.manifest.yaml"];

let root: string;
let srv: { url: string; token: string; close: () => void };

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const manifest = () => readFile(join(root, ...MANIFEST), "utf8");

beforeAll(async () => {
  const { startServer } = await import("@maycombhq/server");
  const { uiRepoRoutes } = await import("../src/ui-api-repos.js");
  root = join(await mkdtemp(join(tmpdir(), "atticus-setup-paths-")), "metarepo");
  await cp(join(FIXTURES, "scan-settings/metarepo"), root, { recursive: true });
  await rm(join(root, "org-pack", "scan"), { recursive: true, force: true });
  await writeFile(
    join(root, ...MANIFEST),
    [
      "schemaVersion: 1",
      "platform: forge",
      "# The notes service; its build is added from the app.",
      "repos:",
      "  - id: forge-notes",
      "    url: https://git.forge.example/forge/forge-notes.git",
      "    type: spring-boot",
      "    owner: team-notes",
      "    component: notes-svc",
      "",
    ].join("\n"),
  );
  srv = await startServer({
    root,
    port: 0,
    user: "priya.nair",
    watch: false,
    extend: (r, ctx) => uiRepoRoutes(r, ctx),
  });
});
afterAll(() => srv?.close());

describe("a repo's build command, set on Repos", () => {
  it("writes build to the manifest, keeps its comments, and the list shows it", async () => {
    const before = Api.RepoBranchesList.parse((await call("GET", "/api/repos/branches")).body);
    expect(before.repos[0]!.build).toBeUndefined();
    const set = await call("PUT", "/api/repos/forge-notes/build", {
      build: "  ./gradlew test  ",
      was: "",
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      file: "org-pack/profiles/forge/repos.manifest.yaml",
      build: "./gradlew test",
    });
    expect(String(set.body.note)).toMatch(/propose it for review/);
    const text = await manifest();
    expect(text).toContain("build: ./gradlew test");
    expect(text).toContain("# The notes service; its build is added from the app.");
    const after = Api.RepoBranchesList.parse((await call("GET", "/api/repos/branches")).body);
    expect(after.repos[0]!.build).toBe("./gradlew test");
  });

  it("refuses a form opened before the manifest changed, two lines, and an unknown repo", async () => {
    const stale = await call("PUT", "/api/repos/forge-notes/build", {
      build: "mvn verify",
      was: "",
    });
    expect(stale.status).toBe(409);
    expect(await manifest()).not.toContain("mvn verify");
    const lines = await call("PUT", "/api/repos/forge-notes/build", {
      build: "npm ci\nnpm test",
    });
    expect(lines.status).toBe(400);
    expect(JSON.stringify(lines.body)).toMatch(/one line/);
    expect((await call("PUT", "/api/repos/forge-nothing/build", { build: "x" })).status).toBe(404);
  });

  it("clears it with an empty command", async () => {
    const r = await call("PUT", "/api/repos/forge-notes/build", {
      build: "",
      was: "./gradlew test",
    });
    expect(r.status).toBe(200);
    expect(r.body.build).toBeUndefined();
    expect(await manifest()).not.toContain("build:");
  });
});

describe("who looks after the org pack, set on Set up", () => {
  it("writes pack.yaml's owner, as atticus orgpack owner does, and nothing else", async () => {
    const r = await call("PUT", "/api/orgpack/owner", {
      owner: "priya.nair",
      was: "team-platform",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ file: "org-pack/pack.yaml", owner: "priya.nair" });
    const pack = await readFile(join(root, "org-pack", "pack.yaml"), "utf8");
    expect(pack).toContain("owner: priya.nair");
    expect(pack).toContain("# The scan-settings fixture's org pack");
  });

  it("refuses a handle that isn't one, and a form opened before the owner changed", async () => {
    expect((await call("PUT", "/api/orgpack/owner", { owner: "Priya Nair" })).status).toBe(400);
    const stale = await call("PUT", "/api/orgpack/owner", { owner: "dana", was: "team-platform" });
    expect(stale.status).toBe(409);
    expect(await readFile(join(root, "org-pack", "pack.yaml"), "utf8")).toContain(
      "owner: priya.nair",
    );
  });
});
