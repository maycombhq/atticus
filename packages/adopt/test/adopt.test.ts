import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadOrgPack } from "@maycombhq/core";
import { newChange } from "@maycombhq/changes";
import { runCritic } from "@maycombhq/naysayer";
import { scanEstate, writeCatalog } from "@maycombhq/scanner";
import {
  adopt,
  AdoptError,
  exists,
  hashTree,
  listFiles,
  resolveMetarepo,
  unadopt,
  zeroInstallFiles,
} from "../src/index.js";
import { cleanup, COMMIT, copyFixture, SCANNED_AT } from "./helpers.js";

afterAll(cleanup);

/** The adopt bar: a working setup in under 30 minutes. On these fixtures it is well under. */
const ADOPT_BAR_MS = 30 * 60 * 1000;

const state = async () => ({ commit: COMMIT, dirty: false });

describe("adopt in place", () => {
  it("adopts an OpenSpec repo: layout points at its openspec/, everything else in .atticus/", async () => {
    const dir = await copyFixture("openspec-repo", "catalog-service");
    const before = await hashTree(dir);
    const r = await adopt(dir);
    expect(r.ms).toBeLessThan(ADOPT_BAR_MS / 100);
    expect(r.problems).toEqual([]);
    expect(r.platform).toBe("catalog-service");
    expect(r.detected).toEqual({
      openspec: "openspec",
      prompts: [],
      agents: [],
      skills: [],
      instructions: [],
    });
    expect(r.layout).toEqual({
      openspec: "openspec",
      catalog: ".atticus/catalog",
      skills: [],
      prompts: [],
    });
    // The repo is one spring-boot repo, scanned where it is.
    expect(r.repos.map((x) => [x.entry.id, x.entry.url, x.entry.type])).toEqual([
      ["catalog-service", ".", "spring-boot"],
    ]);
    // Every file written is under .atticus/; no file of the repo changed.
    expect(r.written.every((f) => f.startsWith(".atticus/"))).toBe(true);
    const now = await hashTree(dir, { skipPaths: [".atticus"] });
    expect(now).toEqual(before);
    // Commands resolve the adopted layout through --root.
    const p = await resolveMetarepo(dir);
    expect(p).toMatchObject({
      adopted: true,
      orgPackRel: ".atticus/org-pack",
      stateDir: join(dir, ".atticus"),
      catalogDir: join(dir, ".atticus", "catalog"),
      openspecDir: join(dir, "openspec"),
    });
    const op = await loadOrgPack(p.orgPackDir);
    expect(op.sources.layout).toEqual(r.layout);
    expect(op.profiles[0]?.repos?.repos[0]).toMatchObject({ id: "catalog-service", url: "." });
  });

  it("adopts a Spec Kit repo: constitution and prompts found, OpenSpec made inside .atticus/", async () => {
    const dir = await copyFixture("speckit-repo", "order-export");
    const r = await adopt(dir);
    expect(r.problems).toEqual([]);
    expect(r.detected).toEqual({
      speckit: {
        specify: ".specify",
        specs: "specs",
        constitution: ".specify/memory/constitution.md",
      },
      constitution: ".specify/memory/constitution.md",
      prompts: [".github/prompts"],
      agents: [],
      skills: [],
      instructions: [],
    });
    expect(r.layout).toEqual({
      openspec: ".atticus/openspec",
      catalog: ".atticus/catalog",
      constitution: ".specify/memory/constitution.md",
      skills: [],
      prompts: [".github/prompts"],
    });
    expect(r.repos.map((x) => [x.entry.id, x.entry.type])).toEqual([["order-export", "node"]]);
    expect(await exists(join(dir, ".atticus/openspec/schemas/org-flow/schema.yaml"))).toBe(true);
    expect(await exists(join(dir, "openspec"))).toBe(false);
  });

  it("adopts a repo with assistant prompts, agents and instructions", async () => {
    const dir = await copyFixture("assistant-repo", "pricing-service");
    const r = await adopt(dir);
    expect(r.detected).toEqual({
      prompts: [".github/prompts", ".claude/commands", "prompts"],
      agents: [".github/agents", ".claude/agents", ".github/chatmodes"],
      skills: [],
      instructions: ["CLAUDE.md", ".github/copilot-instructions.md"],
    });
    expect(r.repos.map((x) => [x.entry.id, x.entry.type])).toEqual([["pricing-service", "python"]]);
  });

  it("adopts a plain folder of repos: one in-place entry per repo", async () => {
    const dir = await copyFixture("plain-multi", "shop");
    const r = await adopt(dir);
    expect(r.problems).toEqual([]);
    expect(r.repos.map((x) => x.entry.url)).toEqual([
      "./batch-mainframe",
      "./billing-net",
      "./edge-gateway",
      "./event-topics",
      "./ledger-go",
      "./notify-worker",
      "./orders-api",
      "./platform-infra",
      "./pricing-py",
      "./web-shop",
    ]);
    expect(r.questions.filter((q) => q.field === "owner")).toHaveLength(10);
    const adopted = parse(await readFile(join(dir, ".atticus/adopted.yaml"), "utf8"));
    expect(adopted.platform).toBe("shop");
  });

  it("refuses a repo that is already adopted or already a metarepo", async () => {
    const dir = await copyFixture("openspec-repo", "twice");
    await adopt(dir);
    await expect(adopt(dir)).rejects.toThrow(AdoptError);
    await expect(adopt(await copyFixture("atticus-metarepo"))).rejects.toThrow(
      /already an Atticus metarepo/,
    );
  });
});

describe("removal leaves the repo byte-identical", () => {
  it("adopt, scan, a critic run on a change, then unadopt: every file as it was", async () => {
    const dir = await copyFixture("openspec-repo", "catalog-service");
    const before = await hashTree(dir);

    await adopt(dir);
    // A scan with defaults: the org pack, cache and inputs resolve inside .atticus/.
    const scan = await scanEstate({ root: dir, repoState: state, scannedAt: SCANNED_AT });
    expect(scan.problems).toEqual([]);
    expect(scan.stats.repos).toBe(1);
    expect(scan.records.some((x) => x.kind === "Component" && x.id === "catalog-service")).toBe(
      true,
    );
    expect(
      scan.records.some(
        (x) => x.kind === "Endpoint" && x.evidence.some((e) => e.path?.startsWith(".atticus")),
      ),
    ).toBe(false);
    const p = await resolveMetarepo(dir);
    await writeCatalog(join(p.catalogDir, "generated"), scan.records);
    expect(await exists(join(dir, ".atticus/.index/scan-cache"))).toBe(true);

    // Track the repo's existing OpenSpec change in Atticus and run the critic on it.
    await newChange(dir, {
      id: "add-product-notes",
      title: "Add product notes",
      type: "feature",
      by: "pat",
      now: SCANNED_AT,
    });
    const critic = await runCritic(dir, "add-product-notes", { now: SCANNED_AT });
    expect(critic.gate).toBe("define");
    const review = (await listFiles(dir)).filter((f) => f.includes("/review/"));
    expect(review.length).toBeGreaterThan(0);

    const res = await unadopt(dir);
    expect(res.hadSnapshot).toBe(true);
    expect(res.changed).toEqual([]);
    expect(res.keptNew).toEqual([]);
    expect(res.removed).toContain(".atticus/");
    expect(res.removed).toContain("openspec/changes/add-product-notes/change.yaml");
    expect(res.removed).toContain("openspec/changes/add-product-notes/brief.md");
    expect(await hashTree(dir)).toEqual(before);
  });

  it("also takes out generated assistant files and Atticus's section in files that existed", async () => {
    const dir = await copyFixture("assistant-repo", "pricing-service");
    const before = await hashTree(dir);
    await adopt(dir);
    const gen = await zeroInstallFiles(dir);
    expect(gen.results.find((x) => x.path === "CLAUDE.md")?.action).toBe("updated");
    expect(gen.results.find((x) => x.path === ".claude/commands/atticus-ask.md")?.action).toBe(
      "created",
    );
    // A file the team adds after adoption is theirs: kept, and listed.
    await writeFile(join(dir, "NOTES.md"), "team notes\n", "utf8");
    const res = await unadopt(dir);
    expect(res.restored.sort()).toEqual([".github/copilot-instructions.md", "CLAUDE.md"]);
    expect(res.removed).toContain(".claude/commands/atticus-ask.md");
    expect(res.keptNew).toEqual(["NOTES.md"]);
    const after = await hashTree(dir);
    delete after["NOTES.md"];
    expect(after).toEqual(before);
  });

  it("refuses a repo that isn't adopted", async () => {
    await expect(unadopt(await copyFixture("plain-multi"))).rejects.toThrow(/isn't adopted/);
  });
});
