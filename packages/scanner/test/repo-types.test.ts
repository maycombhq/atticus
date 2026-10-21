import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { RepoType } from "@maycombhq/core";
import { fsRepo } from "@maycombhq/sdk";
import {
  checkScanSettings,
  draftRepoType,
  matchRepoType,
  resolveSettingsTemplate,
} from "../src/index.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const forge = (id: string) => fsRepo(id, join(FX, "forge", "repos", id), "a".repeat(40));
const typeFile = (id: string) =>
  join(FX, "repo-types", "metarepo", "org-pack", "repo-types", id, "type.yaml");
const load = async (id: string) => RepoType.parse(parse(await readFile(typeFile(id), "utf8")));
const types = async () => [await load("forge-spring-service"), await load("forge-web-ui")];

describe("repo types: matching by fingerprint (ADR 0077)", () => {
  it("matches a Spring service clearly, with the evidence for every signal", async () => {
    const r = await matchRepoType(forge("forge-portal-bff"), await types());
    expect(r.verdict).toBe("clear");
    expect(r.best).toBe("forge-spring-service");
    const m = r.matches[0]!;
    expect(m.score).toBe(1);
    expect(m.signals.map((s) => [s.kind, s.found, s.evidence[0]])).toEqual([
      ["build-file", true, "pom.xml"],
      ["dependency", true, "pom.xml:1"],
      ["marker", true, "src/main/java/forge/portal/BalanceController.java:5"],
      ["layout", true, "src/main/java/forge/portal/AuditPublisher.java"],
      ["layout", true, "src/main/resources/application.yml"],
    ]);
    // The web UI needs a package.json, which the service doesn't have.
    expect(r.matches[1]).toMatchObject({ type: "forge-web-ui", score: 0, ruledOut: true });
  });

  it("matches a web UI clearly, citing the dependency's line", async () => {
    const r = await matchRepoType(forge("forge-portal-ui"), await types());
    expect(r).toMatchObject({ verdict: "clear", best: "forge-web-ui" });
    const m = r.matches[0]!;
    expect(m.score).toBe(0.9);
    expect(m.signals[1]).toMatchObject({ found: true, evidence: ["package.json:1"] });
    expect(m.signals[2]).toMatchObject({ found: true, evidence: ["src/api/balance.ts:3"] });
    expect(m.signals[4]).toMatchObject({ found: false, evidence: [] });
  });

  it("calls a service on the house framework without a build file a partial match", async () => {
    const r = await matchRepoType(forge("forge-ledger"), await types());
    expect(r).toMatchObject({ verdict: "partial", best: "forge-spring-service" });
    expect(r.matches[0]!.score).toBe(0.5);
    expect(r.matches[0]!.signals[2]!.evidence).toEqual([
      "src/main/java/forge/ledger/LedgerEndpoints.java:5",
    ]);
  });

  it("reports none for a repo that matches no type", async () => {
    for (const id of ["forge-infra", "forge-events", "forge-reports-job"]) {
      const r = await matchRepoType(forge(id), await types());
      expect(r.verdict, id).toBe("none");
      expect(r.best, id).toBeUndefined();
    }
  });

  it("reports a tie when two types match about as well", async () => {
    const spring = await load("forge-spring-service");
    const twin = { ...spring, id: "forge-spring-twin", name: "Twin" };
    const r = await matchRepoType(forge("forge-portal-bff"), [spring, twin]);
    expect(r.verdict).toBe("tie");
    expect(r.tied).toEqual(["forge-spring-service", "forge-spring-twin"]);
    expect(r.best).toBeUndefined();
  });
});

describe("repo types: the settings template on one repo", () => {
  it("resolves the context path and the folder to leave out, cited so the check confirms them", async () => {
    const notes = fsRepo(
      "forge-notes",
      join(FX, "scan-settings", "repos", "forge-notes"),
      "a".repeat(40),
    );
    const s = await resolveSettingsTemplate(
      await load("forge-spring-service"),
      notes,
      "forge-notes",
    );
    expect(s).toEqual({
      schemaVersion: 1,
      repo: "forge-notes",
      exclude: [{ path: "docs/**", why: "a generated API playground", at: "docs/playground.js:1" }],
      prefixes: [
        {
          paths: ["src/main/java/**", "src/main/kotlin/**"],
          prefix: "/notes-api",
          why: "server.servlet.context-path",
          at: "src/main/resources/application.properties:3",
          value: "/notes-api",
        },
      ],
      clients: [],
    });
    expect((await checkScanSettings(s, notes)).problems).toEqual([]);
  });

  it("reads a nested YAML key and a pattern's first group; a repo without them gets nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-repo-type-"));
    await mkdir(join(dir, "src", "main", "resources"), { recursive: true });
    await writeFile(
      join(dir, "src", "main", "resources", "application.yml"),
      "spring:\n  application:\n    name: x\nserver:\n  servlet:\n    context-path: /ledger/\n",
    );
    await writeFile(join(dir, "main.ts"), 'const app = create();\napp.setGlobalPrefix("v2");\n');
    const t = RepoType.parse({
      schemaVersion: 1,
      id: "t",
      name: "T",
      description: "d",
      fingerprint: [{ kind: "layout", globs: ["**/*"], weight: 1 }],
      settings: {
        prefixes: [
          {
            key: "server.servlet.context-path",
            files: ["src/main/resources/application*.yml"],
            paths: ["src/**"],
            why: "context path",
          },
          {
            pattern: "setGlobalPrefix\\([\"']([^\"']+)",
            files: ["main.ts"],
            paths: ["src/**"],
            why: "global prefix",
          },
        ],
      },
    });
    const repo = fsRepo("t", dir, "a".repeat(40));
    const s = await resolveSettingsTemplate(t, repo, "t");
    expect(s.prefixes.map((p) => [p.prefix, p.at, p.value])).toEqual([
      ["/ledger", "src/main/resources/application.yml:6", "/ledger/"],
      ["/v2", "main.ts:2", "v2"],
    ]);
    expect((await checkScanSettings(s, repo)).problems).toEqual([]);
    const none = await resolveSettingsTemplate(t, forge("forge-portal-ui"), "forge-portal-ui");
    expect(none.prefixes).toEqual([]);
  });
});

describe("repo types: drafting a type from a repo", () => {
  it("drafts a valid type from the repo's build file, dependencies, markers and layout, which the repo then matches", async () => {
    const bff = forge("forge-portal-bff");
    const t = (await draftRepoType(bff, "forge-bff"))!;
    expect(RepoType.parse(t)).toEqual(t);
    expect(t.fingerprint).toContainEqual(
      expect.objectContaining({ kind: "build-file", globs: ["pom.xml"] }),
    );
    expect(t.fingerprint).toContainEqual(
      expect.objectContaining({ kind: "dependency", names: ["spring-boot-starter-parent"] }),
    );
    expect(t.fingerprint).toContainEqual(
      expect.objectContaining({ kind: "marker", pattern: "@RestController\\b" }),
    );
    expect(t.fingerprint).toContainEqual(
      expect.objectContaining({ kind: "layout", globs: ["src/main/java/**"] }),
    );
    expect(t.settings.prefixes.map((p) => p.key)).toEqual(["server.servlet.context-path"]);
    const r = await matchRepoType(bff, [t]);
    expect(r).toMatchObject({ verdict: "clear", best: "forge-bff" });
    expect(r.matches[0]!.score).toBe(1);

    const ui = (await draftRepoType(forge("forge-portal-ui"), "forge-ui"))!;
    expect(ui.fingerprint).toContainEqual(
      expect.objectContaining({ kind: "dependency", names: ["react"], in: ["package.json"] }),
    );
    expect((await matchRepoType(forge("forge-portal-ui"), [ui])).verdict).toBe("clear");
    expect((await matchRepoType(bff, [ui])).verdict).toBe("none");
    expect(await draftRepoType(forge("forge-events"), "x")).toBeUndefined();
  });
});
