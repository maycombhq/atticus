import { describe, expect, it } from "vitest";
import { memoryRepo } from "@maycombhq/sdk";
import { houseDependencies } from "../src/index.js";

const SHA = "e".repeat(40);

describe("house dependencies: which house artifacts a repo builds on (ADR 0054)", () => {
  it("reads Maven poms (every module, ${property} versions) and Gradle builds, filtered by group", async () => {
    const repo = memoryRepo("cards", SHA, {
      "pom.xml": `<project>
  <groupId>tide.cards</groupId>
  <artifactId>cards-parent</artifactId>
  <properties><tide.platform.version>3.2.0</tide.platform.version></properties>
  <dependencies>
    <dependency>
      <groupId>tide.platform</groupId>
      <artifactId>tide-web-starter</artifactId>
      <version>\${tide.platform.version}</version>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
</project>`,
      "cards-batch/pom.xml": `<project>
  <parent><groupId>tide.cards</groupId><artifactId>cards-parent</artifactId></parent>
  <artifactId>cards-batch</artifactId>
  <dependencies>
    <dependency><groupId>tide.platform.data</groupId><artifactId>tide-jdbc</artifactId><version>1.4.1</version></dependency>
  </dependencies>
</project>`,
      "cards-ui-api/build.gradle.kts": `dependencies {
  implementation("tide.platform:tide-web-starter:3.1.0")
  implementation("com.example:other:1.0")
}`,
    });
    expect(await houseDependencies(repo, ["tide.platform"])).toEqual([
      {
        group: "tide.platform",
        artifact: "tide-web-starter",
        version: "3.1.0",
        path: "cards-ui-api/build.gradle.kts",
      },
      { group: "tide.platform", artifact: "tide-web-starter", version: "3.2.0", path: "pom.xml" },
      {
        group: "tide.platform.data",
        artifact: "tide-jdbc",
        version: "1.4.1",
        path: "cards-batch/pom.xml",
      },
    ]);
  });

  it("reads the house npm packages package.json files depend on, by scope or name", async () => {
    const repo = memoryRepo("web", "0".repeat(40), {
      "package.json": JSON.stringify({
        dependencies: { "@tide/lantern": "^4.1.0", react: "18.3.1" },
        devDependencies: { "@tide/lint-rules": "2.0.0", "@other/x": "1.0.0" },
      }),
      "node_modules/@tide/lantern/package.json": JSON.stringify({
        dependencies: { "@tide/y": "1" },
      }),
      "apps/admin/package.json": JSON.stringify({ dependencies: { "tide-kit": "~1.2.0" } }),
    });
    expect(await houseDependencies(repo, ["@tide", "tide-kit"])).toEqual([
      {
        group: "@tide",
        artifact: "lantern",
        version: "^4.1.0",
        path: "package.json",
        ecosystem: "npm",
      },
      {
        group: "@tide",
        artifact: "lint-rules",
        version: "2.0.0",
        path: "package.json",
        ecosystem: "npm",
      },
      {
        group: "tide-kit",
        artifact: "tide-kit",
        version: "~1.2.0",
        path: "apps/admin/package.json",
        ecosystem: "npm",
      },
    ]);
  });
});
