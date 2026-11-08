import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_READ_RULES, dirSource, notReadForSkipped } from "../src/index.js";

/**
 * Review round 25B: a package of the product's own named like build output (a hexagonal
 * adapter/out/, a card bin/ lookup, a Node CLI's bin/) is read; real build output still isn't.
 */
function repo(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-src-"));
  for (const f of files) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), "x\n");
  }
  return root;
}

describe("which folders a repo's read walks", () => {
  it("walks out/, bin/ and vendor/ below src/ and where no build makes them", () => {
    const root = repo([
      "pom.xml",
      "src/main/java/com/forge/adapter/out/persistence/AccountRepo.java",
      "src/main/java/com/forge/adapter/in/web/Web.java",
      "src/main/java/com/forge/cards/bin/BinLookup.java",
      "src/main/java/com/forge/integration/vendor/NorthwindClient.java",
      "target/classes/com/forge/Web.class",
      "build/libs/app.jar",
      "tools/cli/package.json",
      "tools/cli/bin/cli.js",
      "dotnet/Forge.Api.csproj",
      "dotnet/bin/Debug/Forge.Api.dll",
      "dotnet/obj/project.assets.json",
      "go/go.mod",
      "go/vendor/github.com/x/y.go",
      "web/node_modules/left-pad/index.js",
    ]);
    expect(dirSource(root).list()).toEqual([
      "dotnet/Forge.Api.csproj",
      "go/go.mod",
      "pom.xml",
      "src/main/java/com/forge/adapter/in/web/Web.java",
      "src/main/java/com/forge/adapter/out/persistence/AccountRepo.java",
      "src/main/java/com/forge/cards/bin/BinLookup.java",
      "src/main/java/com/forge/integration/vendor/NorthwindClient.java",
      "tools/cli/bin/cli.js",
      "tools/cli/package.json",
    ]);
  });

  it("counts a build-output name below src/ as the product's own in the skipped-lines check", () => {
    expect(
      notReadForSkipped("src/main/java/com/forge/adapter/out/Client.java", DEFAULT_READ_RULES),
    ).toBe(false);
    expect(notReadForSkipped("build/generated/Client.java", DEFAULT_READ_RULES)).toBe(true);
    expect(notReadForSkipped("src/main/generated/Client.java", DEFAULT_READ_RULES)).toBe(true);
  });
});
