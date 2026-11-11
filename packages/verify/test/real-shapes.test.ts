import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact, type FactOf } from "@maycombhq/core";
import {
  buildCoordinatesProblem,
  buildUnrecorded,
  dirSource,
  gradleDependencyOn,
  gradleGroupOn,
  gradleNameOn,
  isPomFile,
  liveSecretsIn,
  pomCoordinates,
  verifyFacts,
} from "../src/index.js";
import { configLineProblem, propertiesKeyAt, yamlPathAt } from "../src/settings-path.js";

/**
 * The real-shapes corpus (`fixtures/real-shapes/`): invented Forge repos that keep the quirks of
 * public open-source builds, gateways and settings files byte for byte (a `<project>` start tag
 * over several lines, CRLF, a UTF-8 BOM, CDATA, Spring's Gradle `dependencyManagement`, Kotlin DSL
 * and a version catalog, Apigee's `config.json` tokens, Kubernetes manifests). Its README lists
 * each shape and the public project it mirrors. Every expectation here is what a correct reader
 * gives; where today's code gives something else the test is `it.fails`, with the bug in one line,
 * so the suite stays green and the fix flips it.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "real-shapes");
const REPOS = ["forge-ledger", "forge-rates", "forge-wallets", "forge-edge", "forge-bridge"];
/** A file's raw text, BOM and line ends as written. */
const raw = (repo: string, file: string) => readFileSync(join(FIX, "repos", repo, file), "utf8");
/** A file's lines as the verifier reads them (BOM off, CRLF made LF). */
const lines = (repo: string, file: string) =>
  raw(repo, file)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
/** A file's lines split on LF only: a CRLF file's lines keep their `\r`, a BOM stays on line 1. */
const rawLines = (repo: string, file: string) => raw(repo, file).split("\n");
const linesIn = (repo: string) => (file: string) => {
  try {
    return lines(repo, file);
  } catch {
    return undefined;
  }
};
const facts = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const fact = <K extends Fact["kind"]>(repo: string, id: string) =>
  facts(repo).find((f) => f.id === id) as FactOf<K>;
const verify = (repo: string) => {
  const fs = facts(repo);
  return verifyFacts({
    facts: fs,
    source: dirSource(join(FIX, "repos", repo)),
    commit: fs[0]!.commit,
  });
};
const deps = (pom: ReturnType<typeof pomCoordinates>) =>
  pom.dependencies.map((d) =>
    [
      d.group?.value,
      d.artifact?.value,
      d.artifact?.line,
      d.scope?.value ?? "",
      d.managed ? "managed" : d.plugin ? "plugin" : "",
    ].join(" "),
  );

describe("the corpus", () => {
  it("has a facts file per repo, and its byte quirks survive a checkout", () => {
    expect(REPOS.map((r) => facts(r)[0]!.repo)).toEqual(REPOS);
    expect(raw("forge-ledger", "ledger-api/pom.xml")).toContain("\r\n");
    expect(raw("forge-rates", "rates-service/src/main/resources/application.properties")).toContain(
      "\r\n",
    );
    expect(raw("forge-bridge", "src/main/resources/OSGI-INF/blueprint/routes.xml")).toContain(
      "\r\n",
    );
    expect(raw("forge-ledger", "ledger-service/pom.xml").startsWith("\uFEFF")).toBe(true);
  });
});

describe("a pom as public projects write it", () => {
  it("reads a module pom with a BOM and its start tag on one line (spring-petclinic's)", () => {
    // read raw: the BOM is still on line 1, as a reader handed undecoded text would see it
    const pom = pomCoordinates(rawLines("forge-ledger", "ledger-service/pom.xml"));
    expect(pom.group).toBeUndefined();
    expect(pom.artifact).toEqual({ value: "ledger-service", line: 11 });
    expect(pom.parentGroup).toEqual({ value: "forge.ledger", line: 6 });
    expect(pom.parentArtifact).toEqual({ value: "forge-ledger-parent", line: 7 });
    expect(pom.parentVersion).toEqual({ value: "1.2.0", line: 8 });
    // the exclusion's coordinates are no dependency; the Boot plugin has no dependencies
    expect(deps(pom)).toEqual([
      "org.springframework.boot spring-boot-starter-web 18  ",
      "${project.groupId} ledger-api 28  ",
      "forge.rates rates-core 32  ",
      "com.northwind.pay northwind-pay-client 37  ",
      "org.postgresql postgresql 41 runtime ",
      "org.springframework.boot spring-boot-starter-test 46 test ",
    ]);
  });

  it("reads the dependencies of a CRLF pom whose start tag spans two lines", () => {
    expect(deps(pomCoordinates(rawLines("forge-ledger", "ledger-api/pom.xml")))).toEqual([
      "jakarta.validation jakarta.validation-api 19  ",
      "com.fasterxml.jackson.core jackson-annotations 23  ",
    ]);
  });

  it(
    "reads the project's coordinates when its start tag spans three lines (a parent pom)",
    () => {
      const pom = pomCoordinates(lines("forge-ledger", "pom.xml"));
      expect(pom.group).toEqual({ value: "forge.ledger", line: 22 });
      expect(pom.artifact).toEqual({ value: "forge-ledger-parent", line: 23 });
      expect(pom.version).toEqual({ value: "1.2.0", line: 24 });
      expect(pom.parentGroup).toEqual({ value: "org.springframework.boot", line: 16 });
      expect(pom.parentArtifact).toEqual({ value: "spring-boot-starter-parent", line: 17 });
    },
  );

  it("reads a CRLF module pom whose start tag spans two lines (gs-multi-module's)", () => {
    const pom = pomCoordinates(rawLines("forge-ledger", "ledger-api/pom.xml"));
    expect(pom.artifact).toEqual({ value: "ledger-api", line: 12 });
    expect(pom.parentGroup).toEqual({ value: "forge.ledger", line: 6 });
    expect(pom.parentArtifact).toEqual({ value: "forge-ledger-parent", line: 5 });
  });

  it("reads a gateway bundle's pom (apigee-deploy-maven-plugin's sample)", () => {
    const pom = pomCoordinates(lines("forge-edge", "src/gateway/forge-ledger-v1/pom.xml"));
    expect(pom.group).toEqual({ value: "forge.edge", line: 15 });
    expect(pom.artifact).toEqual({ value: "forge-ledger-v1", line: 16 });
    expect(pom.parentArtifact).toEqual({ value: "parent-pom", line: 8 });
  });

  it("reads a pom whose start tag ends on a line of its own", () => {
    const pom = pomCoordinates(lines("forge-bridge", "pom.xml"));
    expect(pom.group).toEqual({ value: "forge.bridge", line: 8 });
    expect(pom.artifact).toEqual({ value: "forge-bridge", line: 9 });
    expect(deps(pom)).toEqual([
      "org.apache.camel.springboot camel-servlet-starter 16  ",
      "org.apache.camel.springboot camel-http-starter 20  ",
      "forge.ledger ledger-api 24  ",
    ]);
  });

  it(
    "leaves what a CDATA section holds out, keeping managed, profile and plugin entries apart",
    () => {
      expect(deps(pomCoordinates(lines("forge-ledger", "pom.xml")))).toEqual([
        "org.apache.camel.springboot camel-spring-boot-bom 48 import managed",
        "${project.groupId} ledger-api 55  managed",
        "com.northwind.pay northwind-pay-client 60  managed",
        "org.testcontainers junit-jupiter 72 test ",
        "com.puppycrawl.tools checkstyle 89  plugin",
      ]);
    },
  );

  it("takes a parent pom a <relativePath> names (shared-pom.xml) for a pom", () => {
    expect(isPomFile("src/gateway/shared-pom.xml")).toBe(true);
  });
});

describe("a Gradle build as public projects write it", () => {
  const declared = (repo: string, file: string) =>
    lines(repo, file).flatMap((l, i) => {
      const d = gradleDependencyOn(l);
      return d ? [`${i + 1} ${d.configuration} ${d.group}:${d.name} ${d.scope}`] : [];
    });

  it("reads each configuration's scope, a platform, a map notation and a ${} version", () => {
    expect(declared("forge-rates", "rates-core/build.gradle")).toEqual([
      "6 api jakarta.validation:jakarta.validation-api compile",
      "7 compileOnly org.projectlombok:lombok provided",
      "8 annotationProcessor org.projectlombok:lombok provided",
      "9 testImplementation org.junit.jupiter:junit-jupiter test",
    ]);
    const service = declared("forge-rates", "rates-service/build.gradle");
    // `implementation project(':rates-core')` is the multi-project's own module, no coordinates
    expect(service.some((d) => d.startsWith("21 "))).toBe(false);
    expect(service).toContain("23 implementation forge.ledger:ledger-api compile");
    expect(service).toContain("24 implementation forge.platform:forge-platform-bom import");
    expect(service).toContain("25 runtimeOnly org.postgresql:postgresql runtime");
    expect(service).toContain("27 implementation com.northwind.pay:northwind-pay-client compile");
    expect(service).toContain(
      "28 testImplementation org.springframework.boot:spring-boot-starter-test test",
    );
  });

  it("reads Kotlin DSL lines, and leaves a version-catalog alias to the catalog", () => {
    expect(declared("forge-wallets", "wallets-api/build.gradle.kts")).toEqual([
      "10 implementation forge.rates:rates-core compile",
      "12 testImplementation org.springframework.boot:spring-boot-starter-test test",
    ]);
  });

  it("reads the group allprojects sets and the name settings sets, Groovy and Kotlin", () => {
    expect(gradleGroupOn(lines("forge-rates", "build.gradle")[6]!)).toBe("forge.rates");
    expect(gradleGroupOn(lines("forge-wallets", "build.gradle.kts")[6]!)).toBe("forge.wallets");
    expect(gradleNameOn(lines("forge-rates", "settings.gradle")[7]!)).toBe("forge-rates");
    expect(gradleNameOn(lines("forge-wallets", "settings.gradle.kts")[9]!)).toBe("forge-wallets");
  });

  it("takes an integration-test source set's configuration for test scope", () => {
    expect(
      gradleDependencyOn("    integrationTestImplementation 'org.testcontainers:postgresql'")
        ?.scope,
    ).toBe("test");
  });

  it("leaves the dependency-management plugin's BOMs and pinned versions out", () => {
    expect(buildUnrecorded(["build.gradle"], linesIn("forge-rates"), [])).toEqual([]);
  });

  it("leaves a tool's configuration (checkstyle) out of the component's dependencies", () => {
    const got = buildUnrecorded(["rates-service/build.gradle"], linesIn("forge-rates"), []);
    expect(got.map((u) => u.cite)).not.toContain("rates-service/build.gradle:30");
  });

  it("keeps a dependency cited on its version-catalog line, with the alias's line", () => {
    const f = fact<"dependency">("forge-wallets", "dependency.wallets-api.ledger-api");
    expect(buildCoordinatesProblem(f, linesIn("forge-wallets"))).toBeUndefined();
  });

  it("keeps a subproject's artifact cited on the settings line that includes it", () => {
    for (const id of ["artifact.rates-core", "artifact.rates-service"])
      expect(
        buildCoordinatesProblem(fact<"artifact">("forge-rates", id), linesIn("forge-rates")),
        id,
      ).toBeUndefined();
  });

  it("keeps a subproject's artifact cited on the settings line that renames it", () => {
    const f = fact<"artifact">("forge-wallets", "artifact.forge-wallets-api");
    expect(buildCoordinatesProblem(f, linesIn("forge-wallets"))).toBeUndefined();
  });
});

describe("settings files as public projects write them", () => {
  const LEDGER_YML = "ledger-service/src/main/resources/application.yml";
  const VALUES = "deploy/helm/forge-rates/values.yaml";

  it("reads a key's path across Spring profile documents and a Helm chart's list of hosts", () => {
    const yml = lines("forge-ledger", LEDGER_YML);
    expect(yamlPathAt(yml, 13)).toEqual(["server", "servlet", "context-path"]);
    expect(yamlPathAt(yml, 18)).toEqual(["forge", "clients", "rates", "base-url"]);
    // the second document starts again at its own root
    expect(yamlPathAt(yml, 33)).toEqual(["spring", "config", "activate", "on-profile"]);
    expect(yamlPathAt(yml, 37)).toEqual(["forge", "clients", "rates", "base-url"]);
    const values = lines("forge-rates", VALUES);
    // a comment indented under `annotations: {}` sets nothing
    expect(yamlPathAt(values, 22)).toEqual(["ingress", "hosts"]);
    expect(yamlPathAt(values, 23)).toEqual(["ingress", "hosts", "host"]);
    expect(yamlPathAt(values, 25)).toEqual(["ingress", "hosts", "paths", "path"]);
  });

  // known bug: a sequence written at its key's own indentation (`containers:` then `- name:`, as Kubernetes manifests and Spring Cloud Gateway routes do) loses its key from the path
  it.fails("reads a key's path in a list written at its key's indentation (a Deployment)", () => {
    const d = lines("forge-rates", "deploy/k8s/deployment.yaml");
    expect(yamlPathAt(d, 17)).toEqual(["spec", "template", "spec", "containers", "name"]);
    expect(yamlPathAt(d, 20)).toEqual([
      "spec",
      "template",
      "spec",
      "containers",
      "ports",
      "containerPort",
    ]);
    expect(yamlPathAt(d, 24)).toEqual(["spec", "template", "spec", "containers", "env", "value"]);
  });

  it("reads a properties key whatever separates it from its value, CRLF and all", () => {
    const props = rawLines(
      "forge-rates",
      "rates-service/src/main/resources/application.properties",
    );
    expect([2, 3, 4, 5, 6].map((n) => propertiesKeyAt(props, n))).toEqual([
      "spring.application.name",
      "server.port",
      "server.servlet.context-path",
      "forge.ledger.base-url",
      "forge.rates.cache-ttl",
    ]);
    expect(propertiesKeyAt(props, 1)).toBeUndefined();
  });

  const check = (
    repo: string,
    f: { key: string; value?: string; cite: { file: string; line: number } },
  ) => configLineProblem(f, linesIn(repo), () => dirSource(join(FIX, "repos", repo)).list());

  it("checks a config fact's key and value on the line that sets them", () => {
    const P = "rates-service/src/main/resources/application.properties";
    expect(
      check("forge-rates", { key: "server.port", value: "8080", cite: { file: P, line: 3 } }),
    ).toBeUndefined();
    expect(
      check("forge-rates", {
        key: "forge.ledger.base-url",
        value: "http://forge-ledger.ledger.svc.cluster.local:8080/ledger",
        cite: { file: P, line: 5 },
      }),
    ).toBeUndefined();
    expect(
      check("forge-rates", {
        key: "forge.rates.cache-ttl",
        value: "30s",
        cite: { file: P, line: 6 },
      }),
    ).toBeUndefined();
    expect(
      check("forge-rates", { key: "server.port", value: "9090", cite: { file: P, line: 3 } }),
    ).toMatch(/something other than the value claimed/);
    // a key under the second profile document, and one claimed under parents it isn't under
    expect(
      check("forge-ledger", {
        key: "forge.clients.rates.base-url",
        value: "https://rates.forge.example/rates",
        cite: { file: LEDGER_YML, line: 37 },
      }),
    ).toBeUndefined();
    expect(
      check("forge-ledger", {
        key: "spring.clients.rates.base-url",
        cite: { file: LEDGER_YML, line: 37 },
      }),
    ).toMatch(/not spring\.clients\.rates\.base-url/);
    // a quoted YAML value, and a Helm list item's key by its index
    expect(
      check("forge-wallets", {
        key: "forge.gateway.base-url",
        value: "https://api.forge.example",
        cite: { file: "wallets-api/src/main/resources/application.yaml", line: 3 },
      }),
    ).toBeUndefined();
    expect(
      check("forge-rates", {
        key: "ingress.hosts[0].host",
        value: "rates.forge.example",
        cite: { file: VALUES, line: 23 },
      }),
    ).toBeUndefined();
  });

  it("checks a deploy tool's token in either key order, and its environment's value", () => {
    const C = "src/gateway/forge-ledger-v1/config.json";
    const header = "/AssignMessage/Set/Headers/Header[@name='x-forge-env']";
    expect(
      check("forge-edge", { key: header, value: "test", cite: { file: C, line: 10 } }),
    ).toBeUndefined();
    // the prod token writes its value before its xpath
    expect(
      check("forge-edge", { key: header, value: "prod", cite: { file: C, line: 56 } }),
    ).toBeUndefined();
    expect(
      check("forge-edge", { key: header, value: "test", cite: { file: C, line: 56 } }),
    ).toMatch(/sets no such value/);
    expect(
      check("forge-edge", {
        key: "/TargetEndpoint/HTTPTargetConnection/URL",
        value: "https://ledger.forge.example/ledger",
        cite: { file: C, line: 77 },
      }),
    ).toBeUndefined();
  });

  // known bug: a TargetServer writes its host and port as two JSON fields, and a config value is checked on one line only, so `host:port` can't be claimed
  it.fails("keeps a TargetServer's host and port, cited on their two lines", () => {
    const f = fact<"config">("forge-edge", "config.ts-rates");
    expect(configLineProblem(f, linesIn("forge-edge"), () => [])).toBeUndefined();
  });
});

describe("live secrets in settings files as public projects write them", () => {
  const secrets = (repo: string, file: string) =>
    liveSecretsIn(file, lines(repo, file)).map((s) => `${s.line} ${s.key}`);

  it("says the line and key of each, never a reference, a placeholder or a store name", () => {
    expect(secrets("forge-ledger", "ledger-service/src/main/resources/application.yml")).toEqual([
      "22 client-secret",
    ]);
    // a deploy tool's token is said by its xpath; a KVM entry by its name
    expect(secrets("forge-edge", "src/gateway/forge-ledger-v1/config.json")).toEqual([
      "20 /BasicAuthentication/Password",
    ]);
    expect(secrets("forge-edge", "resources/edge/env/test/kvms.json")).toEqual([
      "10 ledger.backend.password",
    ]);
    // key store and trust store names, an empty password and "changeme" are no secrets
    expect(secrets("forge-edge", "resources/edge/env/test/targetServers.json")).toEqual([]);
    expect(secrets("forge-rates", "deploy/helm/forge-rates/values.yaml")).toEqual([]);
    expect(secrets("forge-bridge", "src/main/resources/application.properties")).toEqual([]);
    const out = JSON.stringify(
      liveSecretsIn(
        "application.yml",
        lines("forge-ledger", "ledger-service/src/main/resources/application.yml"),
      ),
    );
    expect(out).not.toContain("nw-live");
  });

  // known bug: XML_NAMED wants `name="…"` before `value="…"`, so a blueprint property written value-first is read past
  it.fails("finds a blueprint property's password whichever attribute comes first", () => {
    expect(secrets("forge-bridge", "src/main/resources/OSGI-INF/blueprint/routes.xml")).toEqual([
      "13 ledger.password",
      "14 statements.password",
    ]);
  });

  // known bug: a YAML `- name: X` / `value: v` pair (a container's env) is read as the key `value`, so the secret its name says is read past
  it.fails("finds a container env variable's secret by the name above its value", () => {
    expect(secrets("forge-rates", "deploy/k8s/deployment.yaml")).toEqual([
      "31 NORTHWIND_CLIENT_SECRET",
    ]);
  });
});

/**
 * Every fact in `facts/` is what a careful reader writes for these files, so a correct verifier
 * keeps all of them. The ones a known bug rejects are listed with it; the rest must be kept now.
 */
const KNOWN: Record<string, Record<string, string>> = {
  "forge-edge": {
    "call.ledger.target":
      "a target whose whole URL a deploy token replaces has path /, which no line writes",
    "config.ts-rates": "a TargetServer's host and port are two JSON lines; a value is read on one",
  },
};

describe("the corpus verified end to end", () => {
  for (const repo of REPOS) {
    it(`keeps every fact of ${repo} no known bug touches`, async () => {
      const r = await verify(repo);
      const known = new Set(Object.keys(KNOWN[repo] ?? {}));
      const want = facts(repo)
        .map((f) => f.id)
        .filter((id) => !known.has(id))
        .sort();
      expect(
        r.accepted
          .map((f) => f.id)
          .filter((id) => !known.has(id))
          .sort(),
      ).toEqual(want);
    });
    for (const [id, bug] of Object.entries(KNOWN[repo] ?? {}))
      // known bug: see KNOWN (each fact's one-line reason)
      it.fails(`keeps ${repo}'s ${id} (known bug: ${bug})`, async () => {
        const r = await verify(repo);
        expect(r.rejected.find((x) => x.fact.id === id)).toBeUndefined();
      });
  }

  it("notes the coordinates a read build file writes that no kept fact records", async () => {
    const r = await verify("forge-ledger");
    // the facts record only some dependencies (the Boot starters, the API module's and the parent's
    // own are left out): those are left for the reader, as a note. The parent pom and the API
    // module's are read now that their <project> start tags over lines open (beta.25); the
    // parent's managed entries, its plugin's checkstyle and the CDATA's <dependency> are none.
    expect((r.buildUnrecorded ?? []).map((u) => `${u.cite} ${u.coordinates}`)).toEqual([
      "ledger-api/pom.xml:19 jakarta.validation:jakarta.validation-api",
      "ledger-api/pom.xml:23 com.fasterxml.jackson.core:jackson-annotations",
      "ledger-service/pom.xml:18 org.springframework.boot:spring-boot-starter-web",
      "ledger-service/pom.xml:46 org.springframework.boot:spring-boot-starter-test",
      "pom.xml:72 org.testcontainers:junit-jupiter",
    ]);
  });

  const SECRETS: Record<string, string[]> = {
    "forge-ledger": ["ledger-service/src/main/resources/application.yml:22 client-secret"],
    "forge-rates": ["deploy/k8s/deployment.yaml:31 NORTHWIND_CLIENT_SECRET"],
    "forge-wallets": [],
    "forge-edge": [
      "resources/edge/env/test/kvms.json:10 ledger.backend.password",
      "src/gateway/forge-ledger-v1/config.json:20 /BasicAuthentication/Password",
    ],
    "forge-bridge": [
      "src/main/resources/OSGI-INF/blueprint/routes.xml:13 ledger.password",
      "src/main/resources/OSGI-INF/blueprint/routes.xml:14 statements.password",
    ],
  };
  const secretsOf = async (repo: string) =>
    ((await verify(repo)).secrets ?? []).map((s) => `${s.file}:${s.line} ${s.key}`);
  for (const repo of ["forge-ledger", "forge-wallets"])
    it(`says ${repo}'s live secrets by file, line and key`, async () => {
      expect(await secretsOf(repo)).toEqual(SECRETS[repo]);
    });
  it("says forge-edge's live secret in its bundle's config.json", async () => {
    expect(await secretsOf("forge-edge")).toContain(
      "src/gateway/forge-ledger-v1/config.json:20 /BasicAuthentication/Password",
    );
  });
  // known bug: the scan reads only what the source rules count as source, and the Apigee config plugin's resources/edge/env/<env>/kvms.json isn't, so a KVM entry's password is never said
  it.fails("says forge-edge's live secret in a KVM file of the config plugin", async () => {
    expect(await secretsOf("forge-edge")).toEqual(SECRETS["forge-edge"]);
  });
  // known bug: a container env `- name:`/`value:` pair's secret is read past
  it.fails("says forge-rates' live secret in its Deployment's env", async () => {
    expect(await secretsOf("forge-rates")).toEqual(SECRETS["forge-rates"]);
  });
  // known bug: a blueprint property written value-first is read past
  it.fails("says both of forge-bridge's blueprint passwords", async () => {
    expect(await secretsOf("forge-bridge")).toEqual(SECRETS["forge-bridge"]);
  });
});
