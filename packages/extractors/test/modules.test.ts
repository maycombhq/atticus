import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fsRepo, memoryRepo, scanRepo } from "@maycombhq/sdk";
import { BUILT_IN_EXTRACTORS, detectModules } from "../src/index.js";

const MESSY = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/messy");
const SHA = "e".repeat(40);
const accounts = () => fsRepo("tide-accounts", join(MESSY, "repos/tide-accounts"), SHA);

describe("one component per deployable module (ADR 0057)", () => {
  it("finds each Spring Boot app in a multi-module repo, named after its application", async () => {
    expect(await detectModules(accounts())).toEqual([
      { path: "accounts-api", component: "accounts-api" },
      { path: "accounts-jobs", component: "accounts-jobs" },
    ]);
  });

  it("leaves a repo with one app as one component", async () => {
    const one = memoryRepo("one", SHA, {
      "pom.xml": "<project><modules><module>app</module><module>lib</module></modules></project>",
      "app/pom.xml": "<project/>",
      "app/src/main/java/a/App.java": "@SpringBootApplication public class App {}",
      "lib/pom.xml": "<project/>",
    });
    expect(await detectModules(one)).toEqual([]);
  });

  it("names a module by its folder when its config doesn't name the app", async () => {
    const two = memoryRepo("two", SHA, {
      "a/build.gradle": "",
      "a/src/main/java/A.java": "@SpringBootApplication class A {}",
      "b/build.gradle.kts": "",
      "b/src/main/kotlin/B.kt": "@SpringBootApplication class B",
      "b/src/main/resources/application.properties": "spring.application.name=bee",
    });
    expect(await detectModules(two)).toEqual([
      { path: "a", component: "a" },
      { path: "b", component: "bee" },
    ]);
  });

  it("gives each fact the component of the module its file is in, and a Component per module", async () => {
    const repo = accounts();
    const modules = await detectModules(repo);
    const s = await scanRepo({
      repo,
      extractors: BUILT_IN_EXTRACTORS,
      repoInfo: { system: "accounts", repoType: "spring-boot", modules },
    });
    const of = (kind: string) =>
      s.records
        .filter((r) => r.kind === kind)
        .map((r) => {
          const x = r as unknown as Record<string, string>;
          return kind === "Component"
            ? r.id
            : kind === "Endpoint"
              ? `${x.component} ${x.method} ${x.pathOrTopic}`
              : `${x.owner} ${x.unresolvedKind} ${x.raw}`;
        })
        .sort();
    expect(of("Component")).toEqual(["accounts-api", "accounts-jobs", "tide-accounts"]);
    expect(of("Endpoint")).toEqual(["accounts-api GET /accounts/{id}"]);
    expect(of("Unresolved")).toEqual([
      "accounts-jobs http-call GET http://accounts-api/accounts/{id}",
    ]);
  });
});

describe("what each module builds on (ADR 0068)", () => {
  it("records the sibling modules a module's pom or package.json depends on, as uses", async () => {
    const pom = (id: string, deps: string[] = [], managed: string[] = []) =>
      `<project><groupId>io.tide</groupId><artifactId>${id}</artifactId>${
        managed.length
          ? `<dependencyManagement><dependencies>${managed
              .map(
                (d) =>
                  `<dependency><groupId>io.tide</groupId><artifactId>${d}</artifactId></dependency>`,
              )
              .join("")}</dependencies></dependencyManagement>`
          : ""
      }<dependencies>${deps
        .map(
          (d) => `<dependency><groupId>io.tide</groupId><artifactId>${d}</artifactId></dependency>`,
        )
        .join(
          "",
        )}<dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId></dependency></dependencies></project>`;
    const repo = memoryRepo("tide-ledger", SHA, {
      // The parent only manages versions: that isn't using anything.
      "pom.xml": pom("ledger-parent", [], ["ledger-core", "ledger-rules"]),
      "ledger-api/pom.xml": pom("ledger-api", ["ledger-core", "ledger-rules"]),
      "ledger-rules/pom.xml": pom("ledger-rules", ["ledger-core"]),
      "ledger-core/pom.xml": pom("ledger-core"),
      "ledger-web/package.json": JSON.stringify({
        name: "@tide/ledger-web",
        dependencies: { "@tide/ui-kit": "workspace:*", react: "18.3.1" },
      }),
      "ui-kit/package.json": JSON.stringify({ name: "@tide/ui-kit" }),
    });
    const modules = ["ledger-api", "ledger-core", "ledger-rules", "ledger-web", "ui-kit"].map(
      (m) => ({ path: m, component: m }),
    );
    const s = await scanRepo({
      repo,
      extractors: BUILT_IN_EXTRACTORS,
      repoInfo: { system: "ledger", repoType: "spring-boot", modules },
    });
    const uses = Object.fromEntries(
      s.records
        .filter((r) => r.kind === "Component")
        .map((r) => [r.id, (r as unknown as { uses?: string[] }).uses]),
    );
    // Hand-written: only dependencies on another module of this repo, sorted; none is left out.
    expect(uses).toEqual({
      "tide-ledger": undefined,
      "ledger-api": ["ledger-core", "ledger-rules"],
      "ledger-core": undefined,
      "ledger-rules": ["ledger-core"],
      "ledger-web": ["ui-kit"],
      "ui-kit": undefined,
    });
    expect(s.rejected).toEqual([]);
    // Each module's type is its own build file's, not the repo's: the React app is a UI.
    const types = Object.fromEntries(
      s.records
        .filter((r) => r.kind === "Component")
        .map((r) => [r.id, (r as unknown as { type: string }).type]),
    );
    expect(types).toEqual({
      "tide-ledger": "spring-boot",
      "ledger-api": "java",
      "ledger-core": "java",
      "ledger-rules": "java",
      "ledger-web": "frontend",
      "ui-kit": "node",
    });
  });
});
