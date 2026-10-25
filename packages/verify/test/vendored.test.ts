import { describe, expect, it } from "vitest";
import { buildModules, packageRoot, vendoredProjects } from "../src/index.js";

/**
 * Projects inside a repo that aren't part of its build (ADR 0124 addendum A-big, follow-up A-big2):
 * a library cloned beside reference texts, or a library's source copied in with its LICENSE. The
 * repo is the invented Forge atlas (packages `forge.atlas`), with Northwind's libraries vendored.
 */

describe("the modules a build includes", () => {
  it("reads Maven's <modules>, profiles too", () => {
    const pom = `<project>
  <modules>
    <module>atlas-api</module>
    <module>./libs/ledger-math/</module>
  </modules>
  <profiles><profile><modules><module>web</module></modules></profile></profiles>
</project>`;
    expect(buildModules("pom.xml", pom)).toEqual(["atlas-api", "libs/ledger-math", "web"]);
    expect(
      buildModules("services/pom.xml", "<modules><module>accounts</module></modules>"),
    ).toEqual(["services/accounts"]);
  });

  it("reads Gradle's include, includeBuild and projectDir, Groovy and Kotlin", () => {
    const groovy = `rootProject.name = 'atlas'
include 'atlas-api', ':libs:ledger-math'
includeBuild 'build-logic'
include(':web')
project(':web').projectDir = file('frontend/web')
`;
    expect(buildModules("settings.gradle", groovy)).toEqual([
      "atlas-api",
      "libs/ledger-math",
      "build-logic",
      "web",
      "frontend/web",
    ]);
    const kts = `include(
    ":atlas-api",
    ":atlas-batch",
)
includeBuild("tools/codegen")
`;
    expect(buildModules("settings.gradle.kts", kts)).toEqual([
      "atlas-api",
      "atlas-batch",
      "tools/codegen",
    ]);
  });

  it("reads npm, yarn and pnpm workspaces, and lerna's packages", () => {
    expect(
      buildModules("package.json", JSON.stringify({ workspaces: ["web", "packages/*"] })),
    ).toEqual(["web", "packages/*"]);
    expect(
      buildModules("package.json", JSON.stringify({ workspaces: { packages: ["apps/**"] } })),
    ).toEqual(["apps/**"]);
    expect(
      buildModules(
        "pnpm-workspace.yaml",
        "packages:\n  - 'web'\n  - \"packages/*\"\n  - '!**/test/**'\n",
      ),
    ).toEqual(["web", "packages/*"]);
    expect(buildModules("lerna.json", JSON.stringify({ packages: ["libs/*"] }))).toEqual([
      "libs/*",
    ]);
    // a package.json with no workspaces, or not JSON, includes nothing
    expect(buildModules("web/package.json", JSON.stringify({ name: "atlas-web" }))).toEqual([]);
    expect(buildModules("package.json", "{ not json")).toEqual([]);
  });

  it("reads Cargo's workspace members and go.work's use", () => {
    expect(
      buildModules("Cargo.toml", '[workspace]\nmembers = ["crates/atlas", "crates/*"]\n'),
    ).toEqual(["crates/atlas", "crates/*"]);
    expect(
      buildModules("go.work", "go 1.22\n\nuse (\n  ./atlas\n  ./tools/gen\n)\nuse ./cli\n"),
    ).toEqual(["atlas", "tools/gen", "cli"]);
  });
});

describe("a code file's package root", () => {
  it("is the first two parts of a Java, Kotlin or C# package", () => {
    expect(packageRoot("a/Codec.java", "// header\npackage org.northwind.codec;\n")).toBe(
      "org.northwind",
    );
    expect(packageRoot("a/Atlas.kt", "package forge.atlas.api\n")).toBe("forge.atlas");
    expect(packageRoot("a/Atlas.cs", "namespace Forge.Atlas.Api;\n")).toBe("forge.atlas");
    expect(packageRoot("a/Atlas.java", "public class Atlas {}\n")).toBeUndefined();
    expect(packageRoot("a/readme.txt", "package org.northwind;\n")).toBeUndefined();
  });
});

/** Every file of the Forge atlas with a cloned library and a copied one, and their texts. */
const atlas: Record<string, string> = {
  "pom.xml":
    "<project><modules><module>atlas-api</module><module>libs/ledger-math</module></modules></project>",
  "package.json": JSON.stringify({ private: true, workspaces: ["web"] }),
  LICENSE: "Forge atlas licence",
  "atlas-api/pom.xml": "<project/>",
  "atlas-api/src/main/java/forge/atlas/Atlas.java": "package forge.atlas;\npublic class Atlas {}\n",
  // a module of the build that carries a LICENSE of its own
  "libs/ledger-math/LICENSE": "Apache-2.0",
  "libs/ledger-math/pom.xml": "<project/>",
  "libs/ledger-math/src/main/java/forge/atlas/math/Money.java":
    "package forge.atlas.math;\npublic class Money {}\n",
  // a workspace package with a LICENSE
  "web/LICENSE": "MIT",
  "web/package.json": JSON.stringify({ name: "atlas-web" }),
  "web/src/App.tsx": "export const App = () => null;\n",
  // a library cloned into the reference folder: its own LICENSE and build, in no build's modules
  "REFERENCES/northwind-quill/LICENSE": "BSD-3-Clause",
  "REFERENCES/northwind-quill/setup.py": "from setuptools import setup\nsetup(name='nwquill')\n",
  "REFERENCES/northwind-quill/pyproject.toml": "[project]\nname = 'nwquill'\n",
  "REFERENCES/northwind-quill/src/nwquill/__init__.py": "",
  "REFERENCES/northwind-quill/src/nwquill/parse.py": "def parse(s):\n    return s\n",
  "REFERENCES/northwind-quill/docs/index.md": "# nwquill\n",
  "REFERENCES/reading-list.html": "<html><body>Readings</body></html>\n",
  // a library's source copied in: its LICENSE and README, no build file, another org's packages
  "jar/LICENSE": "Apache-2.0",
  "jar/README.md": "# Northwind codec\n",
  "jar/org/northwind/codec/Codec.java": "package org.northwind.codec;\npublic class Codec {}\n",
  "jar/org/northwind/codec/Frame.java": "package org.northwind.codec;\npublic class Frame {}\n",
  // the repo's own code beside a LICENSE: the same packages as the rest
  "shared/LICENSE": "Forge atlas licence",
  "shared/forge/atlas/shared/Ids.java": "package forge.atlas.shared;\npublic class Ids {}\n",
  // a LICENSE beside files whose packages can't be told
  "scripts/LICENSE": "MIT",
  "scripts/run.sh": "#!/bin/sh\necho run\n",
};
const all = Object.keys(atlas).sort();
const read = (p: string) => atlas[p];

describe("vendored projects (A-big2)", () => {
  it("finds a nested project no build includes, and a copied tree of another org's packages", () => {
    expect(vendoredProjects(all, read)).toEqual([
      {
        dir: "REFERENCES/northwind-quill",
        at: "REFERENCES/northwind-quill/LICENSE:1",
        why: "a project of its own (LICENSE, pyproject.toml, setup.py) that the repo's build doesn't include as a module: vendored third-party code? Check before accepting",
      },
      {
        dir: "jar",
        at: "jar/LICENSE:1",
        why: "its own LICENSE and no build file, and its packages (org.northwind) aren't the repo's own (forge.atlas): a vendored copy of third-party code? Check before accepting",
      },
      {
        dir: "scripts",
        at: "scripts/LICENSE:1",
        why: "its own LICENSE and no build file: a vendored copy of third-party code? Check before accepting",
      },
    ]);
  });

  it("never takes a module of the build, a workspace package or the repo's own packages for vendored", () => {
    const dirs = vendoredProjects(all, read).map((v) => v.dir);
    expect(dirs).not.toContain("libs/ledger-math");
    expect(dirs).not.toContain("web");
    expect(dirs).not.toContain("shared");
  });

  it("takes a Python package's top folder as its package", () => {
    const files: Record<string, string> = {
      "pyproject.toml": "[project]\nname = 'forge-atlas'\n",
      "forge_atlas/__init__.py": "",
      "forge_atlas/api/__init__.py": "",
      "forge_atlas/api/routes.py": "def routes():\n    pass\n",
      "third/LICENSE": "MIT",
      "third/nwquill/__init__.py": "",
      "third/nwquill/parse.py": "def parse(s):\n    return s\n",
      "mine/LICENSE": "MIT",
      "mine/forge_atlas/__init__.py": "",
    };
    expect(
      vendoredProjects(Object.keys(files).sort(), (p) => files[p]).map((v) => [v.dir, v.why]),
    ).toEqual([
      [
        "third",
        "its own LICENSE and no build file, and its packages (nwquill) aren't the repo's own (forge_atlas): a vendored copy of third-party code? Check before accepting",
      ],
    ]);
  });

  it("without the files' text, proposes a copied tree as before and no nested project", () => {
    expect(vendoredProjects(all).map((v) => v.dir)).toEqual(["jar", "scripts", "shared"]);
  });
});
