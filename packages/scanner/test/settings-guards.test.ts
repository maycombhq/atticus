import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ScanSettings } from "@maycombhq/core";
import { fsRepo, type RepoHandle } from "@maycombhq/sdk";
import { checkScanSettings } from "../src/index.js";

/**
 * ADR 0111: guards on scan settings. An exclude can't drop the repo's own code unless the line it
 * cites is a build or config file that leaves that folder out itself; a prefix is the value on its
 * cited line, not any path near it.
 */

const FILES: Record<string, string> = {
  "pom.xml":
    "<project>\n  <build><excludes><exclude>legacy/**</exclude></excludes></build>\n  <build><excludes><exclude>src/**</exclude></excludes></build>\n</project>\n",
  "src/main/java/forge/ledger/LedgerController.java":
    "@RestController\nclass LedgerController {}\n",
  "src/main/java/forge/ledger/Entry.java": "record Entry(String id) {}\n",
  "src/main/java/forge/ledger/Posting.java": "record Posting(String id) {}\n",
  "src/main/resources/application.properties":
    "server.port=8080\nserver.servlet.context-path=/ledger-api\napi.url=https://ledger.forge.internal/ledger/v2\nbase=${LEDGER_BASE:/ledger}\n",
  "legacy/Old.java": "class Old {}\n",
  "legacy/Older.java": "class Older {}\n",
  "samples/Demo.java": "// a sample\nclass Demo {}\n",
  "README.md": "# Ledger\n\nThe samples folder holds demos.\n",
};

let repo: RepoHandle;
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "atticus-guards-"));
  for (const [f, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(dir, f)), { recursive: true });
    await writeFile(join(dir, f), text);
  }
  repo = fsRepo("forge-ledger", dir, "a".repeat(40));
});

const settings = (s: Record<string, unknown>) =>
  ScanSettings.parse({ schemaVersion: 1, repo: "forge-ledger", ...s });
const excl = (path: string, at: string) => settings({ exclude: [{ path, why: "x", at }] });
const prefix = (p: string, value: string, at = "src/main/resources/application.properties:2") =>
  settings({ prefixes: [{ paths: ["src/**"], prefix: p, why: "x", at, value }] });

describe("an exclude's guards", () => {
  it("keeps a folder whose cited file is in it, or whose cited line names it", async () => {
    expect(
      (await checkScanSettings(excl("samples/**", "samples/Demo.java:1"), repo)).problems,
    ).toEqual([]);
    expect((await checkScanSettings(excl("samples/**", "README.md:3"), repo)).problems).toEqual([]);
  });

  it("refuses a folder its cited line doesn't name and the cited file isn't in", async () => {
    const c = await checkScanSettings(excl("samples/**", "README.md:1"), repo);
    expect(c.problems).toEqual([
      "exclude.0: README.md:1 isn't in samples/** and doesn't name it, so samples/** is still read",
    ]);
    expect(c.exclude).toEqual([]);
  });

  it("refuses an exclude that drops the repo's main source folder", async () => {
    const c = await checkScanSettings(
      excl("src/**", "src/main/java/forge/ledger/Entry.java:1"),
      repo,
    );
    expect(c.problems).toEqual([
      "exclude.0: src/** leaves out src/, where most of the repo's code is (3 of 6 code files), so it is still read; only a build or config file that leaves it out itself can say so",
    ]);
  });

  it("refuses an exclude that drops more than half the repo's code", async () => {
    const c = await checkScanSettings(excl("**/*.java", "samples/Demo.java:1"), repo);
    expect(c.problems).toEqual([
      "exclude.0: **/*.java leaves out 6 of the repo's 6 code files, so it is still read; only a build or config file that leaves it out itself can say so",
    ]);
  });

  it("takes an exclude a build file's cited line leaves out itself, even the main folder", async () => {
    expect((await checkScanSettings(excl("legacy/**", "pom.xml:2"), repo)).problems).toEqual([]);
    expect((await checkScanSettings(excl("src/**", "pom.xml:3"), repo)).problems).toEqual([]);
    // A build file's line that names another folder doesn't speak for src/.
    expect((await checkScanSettings(excl("src/**", "pom.xml:2"), repo)).problems[0]).toMatch(
      /pom\.xml:2 isn't in src\/\*\* and doesn't name it/,
    );
  });
});

describe("a prefix's guard", () => {
  it("is the value on its line, with a slash in front and none at the end", async () => {
    expect((await checkScanSettings(prefix("/ledger-api", "/ledger-api"), repo)).problems).toEqual(
      [],
    );
    expect((await checkScanSettings(prefix("/ledger-api/", "ledger-api"), repo)).problems).toEqual(
      [],
    );
  });

  it("is a URL's path, or a placeholder's default, when the line gives those", async () => {
    expect(
      (
        await checkScanSettings(
          prefix(
            "/ledger/v2",
            "https://ledger.forge.internal/ledger/v2",
            "src/main/resources/application.properties:3",
          ),
          repo,
        )
      ).problems,
    ).toEqual([]);
    expect(
      (
        await checkScanSettings(
          prefix(
            "/ledger",
            "${LEDGER_BASE:/ledger}",
            "src/main/resources/application.properties:4",
          ),
          repo,
        )
      ).problems,
    ).toEqual([]);
  });

  it("refuses a prefix that isn't the value its line says", async () => {
    const c = await checkScanSettings(prefix("/v2", "/ledger-api"), repo);
    expect(c.problems).toEqual([
      "prefixes.0: the prefix /v2 isn't the value /ledger-api written at src/main/resources/application.properties:2, so it isn't applied",
    ]);
    expect(c.prefixes).toEqual([]);
  });
});
