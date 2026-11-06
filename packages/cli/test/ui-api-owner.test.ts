import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiOwnerRoutes } from "../src/ui-api-owner.js";

/**
 * G2 (ADR 0174): a repo's owner and system, set from its box. The manifest is edited in place,
 * its comments kept; a preview writes nothing; a team no team file names is added to roles.yaml
 * for review. On the invented Forge estate of fixtures/prototype-compare. Files only.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FX = join(HERE, "../../../fixtures/prototype-compare");

let srv: RunningServer;
let root: string;
const manifest = () => join(root, "org-pack/profiles/forge/repos.manifest.yaml");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-owner-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  await cp(join(FX, "org-pack/profiles/forge"), join(root, "org-pack/profiles/forge"), {
    recursive: true,
  });
  await writeFile(
    join(root, "org-pack/roles.yaml"),
    [
      "schemaVersion: 2",
      "teams:",
      "  - { id: team-shop, name: Shop team }",
      "  - { id: team-billing, name: Billing team }",
      "  - { id: team-platform, name: Platform team }",
      "",
    ].join("\n"),
  );
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    extend: (r, ctx) => uiOwnerRoutes(r, ctx),
  });
});
afterAll(() => srv?.close());

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe("a repo's owner and system (ADR 0174, G2)", () => {
  it("gives the owner and system, with the teams and systems to pick from", async () => {
    const v = Api.RepoOwnerView.parse((await call("GET", "/api/repos/forge-billing/owner")).body);
    expect(v).toMatchObject({
      repo: "forge-billing",
      owner: "team-billing",
      system: "billing",
      file: "org-pack/profiles/forge/repos.manifest.yaml",
    });
    expect(v.teams.map((t) => t.id)).toEqual(["team-shop", "team-billing", "team-platform"]);
    expect((await call("GET", "/api/repos/nope/owner")).status).toBe(404);
  });

  it("previews the change as lines, writes it on the yes, and keeps the file's comments", async () => {
    const before = await readFile(manifest(), "utf8");
    const p = Api.SetRepoOwnerResult.parse(
      (
        await call("PUT", "/api/repos/forge-billing/owner", {
          owner: "team-platform",
          preview: true,
        })
      ).body,
    );
    expect(p.written).toBe(false);
    expect(p.files[0]!.changes).toEqual([
      { was: "    owner: team-billing", now: "    owner: team-platform" },
    ]);
    expect(await readFile(manifest(), "utf8")).toBe(before);
    const w = Api.SetRepoOwnerResult.parse(
      (await call("PUT", "/api/repos/forge-billing/owner", { owner: "team-platform" })).body,
    );
    expect(w).toMatchObject({ written: true, verify: "atticus verify --all --write" });
    const after = await readFile(manifest(), "utf8");
    expect(after).toContain("# The repos of the prototype-compare fixture");
    const repos = (parse(after) as { repos: { id: string; owner: string }[] }).repos;
    expect(repos.find((r) => r.id === "forge-billing")?.owner).toBe("team-platform");
  });

  it("adds a team no team file names, for review, and makes it the owner", async () => {
    const w = Api.SetRepoOwnerResult.parse(
      (
        await call("PUT", "/api/repos/forge-shop-bff/owner", {
          addTeam: { id: "team-loyalty", name: "Loyalty team" },
        })
      ).body,
    );
    expect(w.files.map((f) => f.file)).toEqual([
      "org-pack/roles.yaml",
      "org-pack/profiles/forge/repos.manifest.yaml",
    ]);
    const roles = parse(await readFile(join(root, "org-pack/roles.yaml"), "utf8")) as {
      teams: { id: string }[];
    };
    expect(roles.teams.map((t) => t.id)).toContain("team-loyalty");
  });

  it("refuses an owner no team names, a system no profile has, and a team id that isn't one", async () => {
    expect(
      (await call("PUT", "/api/repos/forge-billing/owner", { owner: "team-nobody" })).status,
    ).toBe(400);
    expect(
      (await call("PUT", "/api/repos/forge-billing/owner", { system: "nowhere" })).status,
    ).toBe(400);
    expect(
      (
        await call("PUT", "/api/repos/forge-billing/owner", {
          addTeam: { id: "Team X", name: "X" },
        })
      ).status,
    ).toBe(400);
    expect((await call("PUT", "/api/repos/forge-billing/owner", {})).status).toBe(400);
  });
});
