import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManifestRepo } from "@maycombhq/core";
import {
  createWorkspace,
  inPlaceDir,
  inPlacePath,
  isInPlace,
  type GitRunner,
} from "../src/index.js";

/**
 * A manifest url of `.` or `./<path>` names a repo already in place under the metarepo root
 * (an adopted repo, or a folder of clones). There is nothing to clone or update, so sync
 * skips it without running git and without touching the root's .gitignore.
 */
describe("workspace sync and in-place repos", () => {
  it("skips urls . and ./x without running git or writing anything", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-in-place-"));
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      throw new Error("git must not run for an in-place repo");
    };
    const repo = (id: string, url: string) =>
      ManifestRepo.parse({ id, url, type: "service", owner: "team" });
    const r = await createWorkspace(root, git).sync([
      repo("notes-service", "."),
      repo("notes-ui", "./ui"),
    ]);
    expect(r).toEqual([
      { id: "notes-service", action: "skipped", reason: "in place at ., nothing to clone" },
      { id: "notes-ui", action: "skipped", reason: "in place at ./ui, nothing to clone" },
    ]);
    expect(calls).toEqual([]);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
    expect(existsSync(join(root, "workspace"))).toBe(false);
  });

  it("skips a url written the Windows way, .\\x or .\\\\x, the same", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-in-place-"));
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      throw new Error("git must not run for an in-place repo");
    };
    const repo = (id: string, url: string) =>
      ManifestRepo.parse({ id, url, type: "service", owner: "team" });
    const r = await createWorkspace(root, git).sync([
      repo("forge-ledger", ".\\forge-ledger"),
      repo("forge-vault", ".\\\\forge-vault"),
      repo("forge-notes", ".\\"),
    ]);
    expect(r.map((x) => x.action)).toEqual(["skipped", "skipped", "skipped"]);
    expect(calls).toEqual([]);
    expect(existsSync(join(root, "workspace"))).toBe(false);
  });
});

describe("inPlacePath and inPlaceDir: one rule for every in-place check", () => {
  it("reads ., ./x and .\\x (and .\\\\x) as in place, as a / path under the root", () => {
    expect(inPlacePath(".")).toBe(".");
    expect(inPlacePath("./")).toBe(".");
    expect(inPlacePath(".\\")).toBe(".");
    expect(inPlacePath("./forge-ledger")).toBe("forge-ledger");
    expect(inPlacePath(".\\forge-ledger")).toBe("forge-ledger");
    expect(inPlacePath(".\\\\forge-ledger\\")).toBe("forge-ledger");
    expect(inPlacePath(".\\apps\\forge-web")).toBe("apps/forge-web");
    expect(inPlacePath("./apps//forge-web/")).toBe("apps/forge-web");
    for (const u of [".", "./x", ".\\x", ".\\\\x"]) expect(isInPlace(u)).toBe(true);
  });

  it("leaves clone urls alone, and a path that climbs out of the root has no folder", () => {
    for (const u of ["https://git.example.com/forge/forge-ledger.git", "git@host:forge/x", "x"]) {
      expect(isInPlace(u)).toBe(false);
      expect(inPlacePath(u)).toBeUndefined();
    }
    expect(inPlacePath("./../elsewhere")).toBeUndefined();
    expect(inPlacePath(".\\..\\elsewhere")).toBeUndefined();
  });

  it("gives the folder a scan reads, joined with the platform's separator", () => {
    const root = join(tmpdir(), "forge-meta");
    expect(inPlaceDir(root, ".")).toBe(root);
    expect(inPlaceDir(root, ".\\forge-ledger")).toBe(join(root, "forge-ledger"));
    expect(inPlaceDir(root, "./apps/forge-web")).toBe(join(root, "apps", "forge-web"));
    expect(inPlaceDir(root, "https://git.example.com/forge/forge-ledger.git")).toBeUndefined();
  });
});
