import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact } from "@maycombhq/core";
import {
  declarationKey,
  dirSource,
  fileKinds,
  frameworkFacts,
  frameworkGaps,
  frameworkOf,
  frameworkTopics,
  frameworkTopicsOfType,
  frameworksToLearn,
  readingRank,
  verifyFacts,
  FRAMEWORKS,
} from "../src/index.js";

/**
 * What a repo is built on (ADR 0124 addendum A-framework), on the invented `fixtures/frameworks/`:
 * nine repos, one framework fact each (two where a module or a second framework earns one), read
 * by hand. The verifier checks the declaration on the cited line, the name that declaration
 * means and the version where it is written; the gaps and the frameworks to learn come off the
 * kept facts alone.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "frameworks");
const COMMIT = "4f1d2a9c8b7e6f5a4d3c2b1a0978563412fedcba";
const REPOS = [
  "forge-admin-web",
  "forge-audit",
  "forge-cards-api",
  "forge-ledger-api",
  "forge-notify",
  "forge-portal-web",
  "forge-rates",
  "forge-reconcile",
  "forge-statements",
];

const facts = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const run = (repo: string, fs: Fact[] = facts(repo)) =>
  verifyFacts({ facts: fs, source: dirSource(join(FIX, "repos", repo)), commit: COMMIT });
const edit = (repo: string, id: string, f: (x: Fact) => Record<string, unknown>) =>
  facts(repo).map((x) => (x.id === id ? ({ ...x, ...f(x) } as Fact) : x));

describe("the hand-written framework facts of nine repos verify", () => {
  it.each(REPOS)("%s: every fact kept", async (repo) => {
    const r = await run(repo);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(facts(repo).length);
  });

  it("reads the name, the version and the module each build file declares", async () => {
    const r = await run("forge-ledger-api");
    expect(frameworkFacts(r.accepted).map((f) => [f.name, f.version, f.component])).toEqual([
      ["forge-web-starter", "2.8.1", "ledger-web"],
      ["spring-boot", "3.3.4", undefined],
    ]);
  });

  it("checks a version held in a property, cited as a part of the claim", async () => {
    // forge-rates: quarkus-bom on line 14, the property's value 3.15.1 on line 8, in cite.with.
    expect((await run("forge-rates")).rejected).toEqual([]);
    const bad = edit("forge-rates", "fw.quarkus", () => ({ version: "9.9.9" }));
    const r = await run("forge-rates", bad);
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["fw.quarkus", "claim-not-on-line"],
    ]);
    expect(r.rejected[0]!.message).toContain("version");
  });

  it("rejects a version no line writes, and keeps a framework that claims none", async () => {
    const wrong = edit("forge-statements", "fw.asp-net", () => ({ version: "net9.0" }));
    expect((await run("forge-statements", wrong)).rejected.map((x) => x.code)).toEqual([
      "claim-not-on-line",
    ]);
    const none = edit("forge-statements", "fw.asp-net", (x) => {
      const { version: _v, ...rest } = x as Record<string, unknown>;
      return rest;
    });
    expect((await run("forge-statements", none)).rejected).toEqual([]);
  });

  it("rejects a name the declaration on the cited line doesn't mean", async () => {
    const r = await run(
      "forge-notify",
      edit("forge-notify", "fw.express", () => ({ name: "nest" })),
    );
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([["fw.express", "framework-name"]]);
    expect(r.rejected[0]!.message).toContain("which is express");
  });

  it("rejects an invented name on a declaration nobody here knows", async () => {
    const r = await run(
      "forge-cards-api",
      edit("forge-cards-api", "fw.forge-card-starter", () => ({ name: "spring-boot" })),
    );
    expect(r.rejected.map((x) => x.code)).toEqual(["framework-name"]);
    expect(r.rejected[0]!.message).toContain("forge-card-starter");
  });

  it("rejects a declaration the cited line doesn't write", async () => {
    const r = await run(
      "forge-audit",
      edit("forge-audit", "fw.rails", (x) => ({
        cite: { ...(x as { cite: object }).cite, line: 1, quote: undefined },
      })),
    );
    expect(r.rejected.map((x) => x.code)).toEqual(["claim-not-on-line"]);
  });

  it("a changed line a version is cited on invalidates the fact that rests on it", async () => {
    const r = await run("forge-ledger-api", [
      ...facts("forge-ledger-api").map((f) =>
        f.id === "fw.forge-web-starter" ? ({ ...f, commit: "0000111" } as Fact) : f,
      ),
    ]);
    expect(
      r.rejected.map((x) => [x.fact.id, x.code]).filter(([id]) => id === "fw.forge-web-starter"),
    ).toEqual([["fw.forge-web-starter", "wrong-commit"]]);
  });
});

describe("a framework whose patterns the facts show none of is a question", () => {
  it("names the Spring Boot repo with no REST entry", async () => {
    const r = await run("forge-cards-api");
    expect(r.frameworkGaps.map((g) => [g.framework, g.expected])).toEqual([
      ["spring-boot", "rest"],
    ]);
    expect(r.frameworkGaps[0]!.question).toContain("no REST entry");
    expect(r.frameworkGaps[0]!.cite).toBe("pom.xml:6");
  });

  it("names Sidekiq with no batch job, and leaves Rails alone", async () => {
    const r = await run("forge-audit");
    expect(r.frameworkGaps.map((g) => g.framework)).toEqual(["sidekiq"]);
  });

  it.each(["forge-ledger-api", "forge-notify", "forge-portal-web", "forge-admin-web"])(
    "%s shows its framework's patterns, so nothing is raised",
    async (repo) => {
      expect((await run(repo)).frameworkGaps).toEqual([]);
    },
  );

  it("says nothing about a house framework: nothing here knows its patterns", () => {
    const only = facts("forge-cards-api").filter((f) => f.id !== "fw.spring-boot");
    expect(frameworkGaps(only)).toEqual([]);
  });

  it("says nothing about a repo nobody has read: no fact but the frameworks", () => {
    expect(frameworkGaps(facts("forge-cards-api").filter((f) => f.kind === "framework"))).toEqual(
      [],
    );
  });
});

describe("a house framework nothing can read is learned, not guessed at", () => {
  it("offers the command for the one Atticus doesn't know", async () => {
    const learn = frameworksToLearn((await run("forge-cards-api")).accepted);
    expect(learn.map((l) => [l.framework, l.command])).toEqual([
      ["forge-card-starter", "atticus frameworks learn forge-card-starter --from forge-cards-api"],
    ]);
  });

  it("offers nothing for a framework the org pack already teaches, by name or artifact", () => {
    const fs = facts("forge-ledger-api");
    expect(frameworksToLearn(fs, ["forge-web-starter"])).toEqual([]);
    expect(frameworksToLearn(fs, ["com.forge.platform:forge-web-starter:2.8.1"])).toEqual([]);
    expect(frameworksToLearn(fs, ["something-else"]).map((l) => l.framework)).toEqual([
      "forge-web-starter",
    ]);
  });

  it("offers nothing for a framework Atticus reads itself", () => {
    expect(frameworksToLearn(facts("forge-reconcile"))).toEqual([]);
  });

  it("offers nothing for @SpringBootApplication, which is Spring Boot itself", () => {
    const f = {
      kind: "framework",
      id: "fw.sba",
      repo: "forge-ledger-api",
      commit: COMMIT,
      name: "@springbootapplication",
      cite: {
        file: "src/main/java/forge/ledger/App.java",
        line: 5,
        value: "@SpringBootApplication",
        quote: "@SpringBootApplication",
      },
    } as Fact;
    expect(frameworksToLearn([f])).toEqual([]);
  });

  it("offers nothing for an Apigee proxy or shared flow, which map reads as a gateway", () => {
    const fw = (id: string, name: string, file: string, value: string, quote: string): Fact =>
      ({
        kind: "framework",
        id,
        repo: "forge-gateway",
        commit: COMMIT,
        name,
        cite: { file, line: 2, value, quote },
      }) as Fact;
    const apigee = [
      fw(
        "fw.apiproxy",
        "apiproxy",
        "apiproxy/ledger-v1.xml",
        "APIProxy",
        '<APIProxy name="ledger-v1">',
      ),
      fw(
        "fw.sf-verify-token",
        "sf-verify-token",
        "sharedflows/sf-verify-token/sharedflowbundle/sf-verify-token.xml",
        "SharedFlowBundle",
        '<SharedFlowBundle name="sf-verify-token">',
      ),
      fw(
        "fw.sf-spike",
        "sf-spike-arrest",
        "src/main/apigee/sharedflows/sf-spike-arrest.xml",
        "SharedFlowBundle",
        '<SharedFlowBundle revision="1" name="sf-spike-arrest">',
      ),
    ];
    const house = fw(
      "fw.forge-card-starter",
      "forge-card-starter",
      "pom.xml",
      "forge-card-starter",
      "<artifactId>forge-card-starter</artifactId>",
    );
    expect(frameworksToLearn([...apigee, house]).map((l) => l.framework)).toEqual([
      "forge-card-starter",
    ]);
  });
});

describe("what a declaration means", () => {
  it.each([
    ["spring-boot-starter-parent", "spring-boot"],
    ["spring-boot-starter-web", "spring-boot"],
    ["org.springframework.boot:spring-boot-starter-data-jpa", "spring-boot"],
    ["Microsoft.NET.Sdk.Web", "asp.net"],
    ["Microsoft.AspNetCore.Mvc.NewtonsoftJson", "asp.net"],
    ["@angular/core", "angular"],
    ["django==5.1.1", "django"],
    ["rails", "rails"],
    ["io.quarkus:quarkus-rest", "quarkus"],
    ["laravel/framework", "laravel"],
  ])("%s is %s", (declared, name) => {
    expect(frameworkOf(declared)?.name).toBe(name);
  });

  it("knows nothing of a house artifact", () => {
    expect(frameworkOf("com.forge.platform:forge-card-starter")).toBeUndefined();
    expect(declarationKey("com.forge.platform:forge-card-starter")).toBe("forge-card-starter");
  });
});

describe("the rules a repo's frameworks turn on", () => {
  it("is undefined when no fact says, so every framework's rules go in", () => {
    expect(
      frameworkTopics(facts("forge-notify").filter((f) => f.kind !== "framework")),
    ).toBeUndefined();
  });

  it.each([
    ["forge-ledger-api", ["spring", "house"]],
    ["forge-statements", ["aspnet"]],
    ["forge-portal-web", ["angular"]],
    ["forge-admin-web", ["react"]],
    ["forge-audit", ["rails"]],
    ["forge-reconcile", ["django"]],
    ["forge-rates", ["quarkus"]],
  ])("%s turns on %s", (repo, expected) => {
    expect(frameworkTopics(facts(repo))).toEqual(
      FRAMEWORKS.filter((f) => (expected as string[]).includes(f)),
    );
  });

  it("a framework nobody knows turns on the house rule and nothing else", () => {
    expect(frameworkTopics(facts("forge-cards-api"))).toEqual(["spring", "house"]);
  });

  it("falls back to the repo's type in the manifest, which is a hint and not a fact", () => {
    expect(frameworkTopicsOfType("spring-boot")).toEqual(["spring"]);
    expect(frameworkTopicsOfType("dotnet")).toEqual(["aspnet"]);
    expect(frameworkTopicsOfType("frontend")).toEqual(["angular", "react", "vue", "next"]);
    expect(frameworkTopicsOfType("gateway")).toEqual([]);
    expect(frameworkTopicsOfType(undefined)).toEqual([]);
  });
});

describe("a Gemfile, a requirements file and a composer.json are build files", () => {
  it.each(["Gemfile", "requirements.txt", "requirements-dev.txt", "composer.json", "api.gemspec"])(
    "%s is read first, with the other build files",
    (path) => {
      expect(readingRank(path)).toBe(0);
      expect(fileKinds(path)).toEqual(["deploy", "config"]);
    },
  );
});
