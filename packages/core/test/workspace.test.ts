import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  ChangeOutcomes,
  ChangeRepos,
  RepoManifest,
  changeBranch,
  handoffBranch,
  parseBranch,
  taskBranch,
  toCanonicalYaml,
  workspaceJsonSchemas,
} from "../src/index.js";

const manifest = {
  schemaVersion: 1,
  platform: "forge",
  repos: [
    {
      id: "forge-ledger",
      url: "https://git.example.com/forge/forge-ledger.git",
      type: "forge-service",
      owner: "team-ledger",
      system: "ledger",
    },
    {
      id: "forge-gateway",
      url: "https://git.example.com/forge/forge-gateway.git",
      defaultBranch: "develop",
      type: "gateway",
      owner: "team-platform",
      sparse: ["proxies/ledger-v1"],
    },
  ],
};

describe("repos.manifest.yaml (RepoManifest)", () => {
  it("accepts a manifest and fills defaults", () => {
    const m = RepoManifest.parse(manifest);
    expect(m.repos[0]).toMatchObject({
      defaultBranch: "main",
      extractors: [],
      dialects: [],
      sparse: [],
      archived: false,
    });
    expect(m.repos[1]!.defaultBranch).toBe("develop");
  });

  it("rejects duplicate repo ids", () => {
    const r = RepoManifest.safeParse({
      ...manifest,
      repos: [manifest.repos[0], manifest.repos[0]],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("duplicate repo id forge-ledger");
  });

  it("rejects a password in the URL", () => {
    const r = RepoManifest.safeParse({
      ...manifest,
      repos: [
        { ...manifest.repos[0], url: "https://me:secret@git.example.com/forge/forge-ledger.git" },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("accepts SSH and local URLs", () => {
    for (const url of [
      "git@git.example.com:forge/forge-ledger.git",
      "/srv/git/forge-ledger.git",
      "file:///srv/git/x.git",
    ]) {
      expect(
        RepoManifest.safeParse({ ...manifest, repos: [{ ...manifest.repos[0], url }] }).success,
        url,
      ).toBe(true);
    }
  });

  it("rejects sparse paths that escape the repo or use backslashes", () => {
    for (const p of ["../x", "/etc", "C:/x", "a\\b"]) {
      const r = RepoManifest.safeParse({
        ...manifest,
        repos: [{ ...manifest.repos[1], sparse: [p] }],
      });
      expect(r.success, p).toBe(false);
    }
  });

  it("rejects bad branch names and unknown fields", () => {
    expect(
      RepoManifest.safeParse({
        ...manifest,
        repos: [{ ...manifest.repos[0], defaultBranch: "a..b" }],
      }).success,
    ).toBe(false);
    expect(
      RepoManifest.safeParse({ ...manifest, repos: [{ ...manifest.repos[0], colour: "red" }] })
        .success,
    ).toBe(false);
  });
});

describe("change repos.yaml (ChangeRepos)", () => {
  const repos = {
    schemaVersion: 1,
    change: "add-transfer-limit",
    repos: [
      {
        id: "forge-ledger",
        branch: "change/add-transfer-limit",
        base: "main",
        baseSha: "a1b2c3d",
        worktree: "workspace/.worktrees/add-transfer-limit/forge-ledger",
        pr: { url: "https://git.example.com/forge/forge-ledger/pull/7", number: 7, state: "open" },
      },
    ],
  };

  it("accepts a change's repos file and defaults the build to not-run", () => {
    const c = ChangeRepos.parse(repos);
    expect(c.repos[0]!.build).toEqual({ status: "not-run" });
  });

  it("rejects an absolute or Windows-style worktree path", () => {
    for (const w of ["/home/me/x", "workspace\\.worktrees\\x"]) {
      expect(
        ChangeRepos.safeParse({ ...repos, repos: [{ ...repos.repos[0], worktree: w }] }).success,
        w,
      ).toBe(false);
    }
  });

  it("rejects an unknown PR state", () => {
    const bad = {
      ...repos,
      repos: [{ ...repos.repos[0], pr: { ...repos.repos[0]!.pr, state: "approved" } }],
    };
    expect(ChangeRepos.safeParse(bad).success).toBe(false);
  });

  it("round-trips through canonical YAML byte-for-byte", () => {
    const leading = ["schemaVersion", "change", "id"];
    const once = toCanonicalYaml(ChangeRepos.parse(repos), leading);
    const twice = toCanonicalYaml(ChangeRepos.parse(parse(once)), leading);
    expect(twice).toBe(once);
    expect(once.startsWith("schemaVersion: 1\nchange: add-transfer-limit\n")).toBe(true);
  });
});

describe("branch names", () => {
  it("builds the three kinds", () => {
    expect(changeBranch("add-transfer-limit")).toBe("change/add-transfer-limit");
    expect(taskBranch("add-transfer-limit", "t3")).toBe("task/add-transfer-limit/t3");
    expect(handoffBranch("add-transfer-limit", "design")).toBe("handoff/add-transfer-limit/design");
  });

  it("refuses ids that would make a bad or ambiguous branch", () => {
    for (const bad of ["Add", "a/b", "", "x.lock", "a..b", "a b"]) {
      expect(() => changeBranch(bad), bad).toThrow();
    }
  });

  it("parses Atticus branches and ignores others", () => {
    expect(parseBranch("change/x")).toEqual({ kind: "change", change: "x" });
    expect(parseBranch("task/x/t1")).toEqual({ kind: "task", change: "x", task: "t1" });
    expect(parseBranch("handoff/x/specs")).toEqual({
      kind: "handoff",
      change: "x",
      phase: "specs",
    });
    for (const other of ["main", "change/x/y", "feature/x", "task/x"])
      expect(parseBranch(other), other).toBeUndefined();
  });
});

describe("workspace JSON Schemas", () => {
  it("generates both with stable ids", () => {
    const s = workspaceJsonSchemas() as Record<string, { $id: string }>;
    expect(s.RepoManifest!.$id).toBe(
      "https://maycombhq.github.io/atticus/schema/workspace/v1/RepoManifest.json",
    );
    expect(s.ChangeRepos!.$id).toContain("/workspace/v1/ChangeRepos.json");
    expect(s.ChangeOutcomes!.$id).toContain("/workspace/v1/ChangeOutcomes.json");
  });
});

describe("a change's outcome records (ADR 0045)", () => {
  const value = { value: "0 accepted over a limit", by: "pat", at: "2026-11-30T09:00:00Z" };
  const file = {
    schemaVersion: 1,
    change: "add-transfer-limit",
    measures: [
      {
        id: "no-transfer-over-a-limit-is-accepted",
        measure: "No transfer over a limit is accepted",
        values: [value],
      },
    ],
  };

  it("keeps each measure's values with who and when", () => {
    expect(ChangeOutcomes.parse(file).measures[0]!.values[0]).toEqual(value);
  });

  it("refuses a value without who, a duplicate measure and an empty value", () => {
    const m = file.measures[0]!;
    expect(
      ChangeOutcomes.safeParse({
        ...file,
        measures: [{ ...m, values: [{ value: "1", at: value.at }] }],
      }).success,
    ).toBe(false);
    expect(ChangeOutcomes.safeParse({ ...file, measures: [m, m] }).success).toBe(false);
    expect(
      ChangeOutcomes.safeParse({
        ...file,
        measures: [{ ...m, values: [{ ...value, value: " " }] }],
      }).success,
    ).toBe(false);
  });
});
