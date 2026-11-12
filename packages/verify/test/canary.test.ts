import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canaryClaimText, parseFacts, type Fact } from "@maycombhq/core";
import {
  CANARY_SECRET_PREFIX,
  canaryHoldsSecret,
  canaryNeverCopied,
  dirSource,
  memorySource,
  planCanary,
  verifyFacts,
  type FileSource,
} from "../src/index.js";

/**
 * Canaries (plan item Z2, ADR 0196): the plan for a scratch copy, from the copy's files, the
 * repo's verified facts and a seed alone. One invented Forge repo per stack the templates cover:
 * Spring on Java (`forge-portal-bff`), Node on TypeScript (`forge-portal-ui`), Python
 * (`forge-appraise`). `fixtures/canaries/expected/<repo>.s1.json` is each plan, checked by hand.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const REPOS: Record<string, string> = {
  // the Forge BFF with its build file's libraries and its @SpringBootApplication class
  "forge-portal-bff": join(FIX, "canaries/repos/forge-portal-bff"),
  "forge-portal-ui": join(FIX, "forge/repos/forge-portal-ui"),
  "forge-appraise": join(FIX, "reachable/forge-appraise"),
};
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "canaries/facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};

/** The copy as the plan leaves it: the source's files, with the plan's writes over them. */
function planted(src: FileSource, writes: Record<string, string>): FileSource {
  return {
    list: () => [...new Set([...src.list(), ...Object.keys(writes)])].sort(),
    read: (p) => writes[p] ?? src.read(p),
  };
}

describe("planCanary", () => {
  for (const [repo, dir] of Object.entries(REPOS)) {
    it(`${repo}: the same seed plans the same, as checked by hand`, async () => {
      const facts = factsOf(repo);
      // The fixture's facts are all verified against the repo itself.
      const v = await verifyFacts({ facts, source: dirSource(dir) });
      expect(v.rejected.map((r) => `${r.fact.id} ${r.message}`)).toEqual([]);

      const a = planCanary({ source: dirSource(dir), facts, seed: "s1" });
      const b = planCanary({ source: dirSource(dir), facts: [...facts].reverse(), seed: "s1" });
      expect(b).toEqual(a);
      const expected = JSON.parse(
        readFileSync(join(FIX, "canaries/expected", `${repo}.s1.json`), "utf8"),
      ) as { stacks: string[]; planted: unknown[]; skipped: unknown[]; removed: unknown[] };
      expect({
        stacks: a.stacks,
        planted: a.planted,
        skipped: a.skipped,
        removed: a.removed,
      }).toEqual(expected);

      // Another seed draws other names (and, where there is a choice, other lines).
      const c = planCanary({ source: dirSource(dir), facts, seed: "s2" });
      expect(c.planted.map((p) => p.needle)).not.toEqual(a.planted.map((p) => p.needle));
    });
  }

  it("each planted line holds its claim, and no fact of the repo uses a planted word", () => {
    for (const [repo, dir] of Object.entries(REPOS)) {
      const facts = factsOf(repo);
      const plan = planCanary({ source: dirSource(dir), facts, seed: "s1" });
      const copy = planted(dirSource(dir), plan.writes);
      // a browser app (forge-portal-ui) gets a call only: no route, no topics, no process.env
      expect(plan.planted.length).toBeGreaterThanOrEqual(repo === "forge-portal-ui" ? 1 : 2);
      for (const p of plan.planted) {
        const line = copy.read(p.file)!.split("\n")[p.line - 1]!;
        const words = p.needle.split("-").filter((w) => !["updated", "viewed", "url"].includes(w));
        for (const w of words) expect(line.toLowerCase(), `${repo} ${p.id}`).toContain(w);
        expect(facts.some((f) => canaryClaimText(f).includes(words[0]!))).toBe(false);
      }
    }
  });

  it("comments out each removed line in place; the verifier refuses a claim cited on it", async () => {
    const dir = REPOS["forge-portal-bff"]!;
    const facts = factsOf("forge-portal-bff");
    const plan = planCanary({ source: dirSource(dir), facts, seed: "s1" });
    expect(plan.removed).toHaveLength(3);
    expect(new Set(plan.removed.map((r) => r.kind)).size).toBe(3);
    const copy = planted(dirSource(dir), plan.writes);
    for (const r of plan.removed) {
      const before = dirSource(dir).read(r.file)!.split("\n");
      const after = copy.read(r.file)!.split("\n");
      expect(after[r.line - 1]!.trim()).toMatch(/^(\/\/|#) /);
      expect(after[r.line - 1]!.replace(/(\/\/|#) /, "")).toBe(before[r.line - 1]);
      // every other line where it was: the line numbers of the file don't move
      expect(after.slice(0, r.line - 1)).toEqual(before.slice(0, r.line - 1));
    }
    // The old facts, cited on the commented lines, are caught (Flagged, not silent): what a
    // canary scores as passed is a claim the verifier kept, cited on a live line elsewhere.
    const removedFacts = facts.filter((f) => plan.removed.some((r) => r.fact === f.id));
    const v = await verifyFacts({ facts: removedFacts, source: copy });
    expect(v.accepted).toEqual([]);
    expect(v.rejected.map((r) => r.code)).toEqual([
      "claim-in-comment",
      "claim-in-comment",
      "claim-in-comment",
    ]);
  });

  it("takes out only as many lines as asked, and none it can't comment alone", () => {
    const dir = REPOS["forge-portal-bff"]!;
    const facts = factsOf("forge-portal-bff");
    expect(
      planCanary({ source: dirSource(dir), facts, seed: "s1", removals: 1 }).removed,
    ).toHaveLength(1);
    expect(planCanary({ source: dirSource(dir), facts, seed: "s1", removals: 0 }).removed).toEqual(
      [],
    );
    // a person's own fact, or one not verified, is never taken out
    const mine = facts.map((f) => ({ ...f, by: "person" as const }));
    expect(planCanary({ source: dirSource(dir), facts: mine, seed: "s1" }).removed).toEqual([]);
    const unchecked = facts.map((f) => ({ ...f, verified: "none" as const }));
    expect(planCanary({ source: dirSource(dir), facts: unchecked, seed: "s1" }).removed).toEqual(
      [],
    );
  });

  it("plants nothing in a repo of no stack it has a template for", () => {
    const src: FileSource = {
      list: () => ["main.go", "go.mod"],
      read: (p) => (p === "main.go" ? "package main\n" : "module forge\n"),
    };
    const plan = planCanary({ source: src, facts: [], seed: "s1" });
    expect(plan).toEqual({ stacks: [], planted: [], removed: [], skipped: [], writes: {} });
  });
});

/** What a plan plants, by stack and item, and what it skips, by item. */
const items = (plan: ReturnType<typeof planCanary>) => ({
  planted: plan.planted.map((p) => `${p.stack} ${p.what}`),
  skipped: plan.skipped.map((x) => `${x.stack} ${x.what}`),
});

describe("planCanary plants only what the repo can serve (review of ADR 0196)", () => {
  const app = [
    "package forge.ledger;",
    "",
    "import org.springframework.boot.autoconfigure.SpringBootApplication;",
    "",
    "@SpringBootApplication",
    "public class LedgerApplication {}",
    "",
  ].join("\n");
  const controller = [
    "package forge.ledger.web.accounts;",
    "",
    "import org.springframework.web.bind.annotation.*;",
    "",
    "@RestController",
    "public class AccountsController {}",
    "",
  ].join("\n");
  const pom = (deps: string[]) =>
    `<project><dependencies>${deps.map((d) => `<dependency><artifactId>${d}</artifactId></dependency>`).join("")}</dependencies></project>\n`;

  it("Spring: beside the @SpringBootApplication class, in its package, whatever file is drawn", () => {
    for (const seed of ["s1", "s2", "s3", "s4"]) {
      const plan = planCanary({
        source: memorySource({
          "pom.xml": pom(["spring-boot-starter-web", "spring-kafka"]),
          "src/main/java/forge/ledger/LedgerApplication.java": app,
          "src/main/java/forge/ledger/web/accounts/AccountsController.java": controller,
        }),
        facts: [],
        seed,
      });
      // no application config file: the key is the new class's @Value, its first line
      expect(items(plan).planted).toEqual([
        "spring config",
        "spring entry",
        "spring call",
        "spring topic-in",
        "spring topic-out",
      ]);
      for (const p of plan.planted)
        expect(p.file).toMatch(/^src\/main\/java\/forge\/ledger\/[A-Z]\w+\.java$/);
      for (const [path, text] of Object.entries(plan.writes))
        expect(text.split("\n")[0], path).toBe("package forge.ledger;");
    }
  });

  it("Spring: no Kafka client declared, no topics; no web library, no route or call", () => {
    const files = {
      "src/main/java/forge/ledger/LedgerApplication.java": app,
      "src/main/resources/application.yml": "server:\n  port: 8080\n",
    };
    const noKafka = planCanary({
      source: memorySource({ ...files, "pom.xml": pom(["spring-boot-starter-web"]) }),
      facts: [],
      seed: "s1",
    });
    expect(items(noKafka)).toEqual({
      planted: ["spring entry", "spring call", "spring config"],
      skipped: ["spring topic-in", "spring topic-out"],
    });
    expect(Object.keys(noKafka.writes).some((p) => /Events\.java$/.test(p))).toBe(false);
    const noWeb = planCanary({
      source: memorySource({
        ...files,
        "build.gradle":
          "dependencies { implementation 'org.springframework.kafka:spring-kafka' }\n",
      }),
      facts: [],
      seed: "s1",
    });
    expect(items(noWeb)).toEqual({
      planted: ["spring topic-in", "spring topic-out", "spring config"],
      skipped: ["spring entry", "spring call"],
    });
    expect(noWeb.skipped[0]!.reason).toMatch(/spring-web/);
  });

  it("Spring: with no @SpringBootApplication class, no new class (no scan would find it)", () => {
    const plan = planCanary({
      source: memorySource({
        "pom.xml": pom(["spring-boot-starter-web", "spring-kafka"]),
        "src/main/java/forge/ledger/web/accounts/AccountsController.java": controller,
        "src/main/resources/application.properties": "server.port=8080\n",
      }),
      facts: [],
      seed: "s1",
    });
    expect(items(plan).planted).toEqual(["spring config"]);
    expect(plan.skipped.map((x) => x.reason)).toEqual(
      Array(4).fill("no @SpringBootApplication class, so no scan would find a new class"),
    );
  });

  it("Node: a browser app gets no route, and no topics without kafkajs; a server gets both on its app", () => {
    const browser = planCanary({
      source: memorySource({
        "package.json": JSON.stringify({
          dependencies: { react: "18.3.1", "react-router": "6.0.0" },
        }),
        // a Router() that isn't express's is no app to serve on
        "src/routes.ts":
          'import { Router } from "react-router";\nexport const router = Router();\n',
      }),
      facts: [],
      seed: "s1",
    });
    // second review of ADR 0196: a browser has no process.env, so no config, and its call is to
    // a path of its own origin
    expect(items(browser)).toEqual({
      planted: ["node call"],
      skipped: ["node config", "node entry", "node topic-in", "node topic-out"],
    });
    expect(Object.values(browser.writes).join("\n")).not.toMatch(
      /express|\.get\(|kafkajs|process\.env/,
    );
    const server = planCanary({
      source: memorySource({
        "package.json": JSON.stringify({ dependencies: { express: "4.21.0", kafkajs: "2.2.4" } }),
        "src/app.js":
          'const express = require("express");\nconst app = express();\nmodule.exports = app;\n',
      }),
      facts: [],
      seed: "s1",
    });
    expect(items(server)).toEqual({
      planted: ["node config", "node entry", "node call", "node topic-out", "node topic-in"],
      skipped: [],
    });
    expect(server.writes["src/app.js"]).toContain('const { Kafka } = require("kafkajs");');
    // nothing planted would crash if it ran: no client made at load, a connect before each send
    // and subscribe, the route's failures answered, the consumer's start caught
    const js = server.writes["src/app.js"]!;
    expect(js).toMatch(/= \(\) => new Kafka\(/);
    expect(js.indexOf(".connect();")).toBeLessThan(js.indexOf(".send("));
    expect(js.lastIndexOf("await consumer.connect();")).toBeLessThan(js.indexOf(".subscribe("));
    expect(js).toContain("res.status(502).end();");
    expect(js).toMatch(/^\w+\(\)\.catch\(\(\) => undefined\);$/m);
    expect(js).not.toMatch(/^void /m);
  });

  // Second review of ADR 0196, the reviewer's probes: what a repo can serve, read per module.
  const springApp = (pkg: string) =>
    `package ${pkg};\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n@SpringBootApplication\npublic class App {}\n`;

  it("Spring: a Gradle version catalog's aliases and buildSrc's convention plugins count", () => {
    const catalog = planCanary({
      source: memorySource({
        "settings.gradle.kts": 'include("app")',
        "gradle/libs.versions.toml":
          '[versions]\nboot = "3.3.0"\n[libraries]\nboot-web = { module = "org.springframework.boot:spring-boot-starter-web", version.ref = "boot" }\nspring_kafka = { group = "org.springframework.kafka", name = "spring-kafka" }\n',
        "app/build.gradle.kts":
          "dependencies {\n  implementation(libs.boot.web)\n  implementation(libs.spring.kafka)\n}\n",
        "app/src/main/java/forge/ledger/App.java": springApp("forge.ledger"),
      }),
      facts: [],
      seed: "s1",
    });
    expect(items(catalog).skipped).toEqual([]);
    const conventions = planCanary({
      source: memorySource({
        "buildSrc/src/main/kotlin/forge-web-conventions.gradle.kts":
          'dependencies { implementation("org.springframework.boot:spring-boot-starter-web") }',
        "build.gradle.kts": 'plugins { id("forge-web-conventions") }',
        "src/main/java/forge/ledger/App.java": springApp("forge.ledger"),
      }),
      facts: [],
      seed: "s1",
    });
    expect(items(conventions).planted).toContain("spring entry");
    // a convention plugin nothing applies declares nothing
    const unapplied = planCanary({
      source: memorySource({
        "buildSrc/src/main/kotlin/forge-web-conventions.gradle.kts":
          'dependencies { implementation("org.springframework.boot:spring-boot-starter-web") }',
        "build.gradle.kts": "plugins { java }",
        "src/main/java/forge/ledger/App.java": springApp("forge.ledger"),
      }),
      facts: [],
      seed: "s1",
    });
    expect(items(unapplied).skipped).toContain("spring entry");
  });

  it("Spring: the app's own module's build, not another module's; Cloud Stream's Kafka binder counts", () => {
    const multi = planCanary({
      source: memorySource({
        "pom.xml": "<modules><module>app</module><module>lib</module></modules>",
        "app/pom.xml": pom(["spring-boot-starter"]),
        "lib/pom.xml": pom(["spring-boot-starter-web"]),
        "app/src/main/java/forge/ledger/App.java": springApp("forge.ledger"),
        "lib/src/main/resources/application.yml": "server:\n  port: 8080\n",
      }),
      facts: [],
      seed: "s1",
    });
    expect(items(multi)).toEqual({
      planted: [],
      skipped: [
        "spring entry",
        "spring call",
        "spring topic-in",
        "spring topic-out",
        "spring config",
      ],
    });
    const binder = planCanary({
      source: memorySource({
        "pom.xml": pom(["spring-boot-starter-web", "spring-cloud-stream-binder-kafka"]),
        "src/main/java/forge/ledger/App.java": springApp("forge.ledger"),
      }),
      facts: [],
      seed: "s1",
    });
    expect(items(binder).planted).toEqual(
      expect.arrayContaining(["spring topic-in", "spring topic-out"]),
    );
    // the key is read with a default, so an app whose config doesn't set it still starts
    expect(Object.values(binder.writes).join("\n")).toMatch(/@Value\("\$\{[a-z.-]+:\}"\)/);
  });

  it("Node: a typed app, a router with options, and only what the app's own package declares", () => {
    const typed = planCanary({
      source: memorySource({
        "package.json": '{"private":true}',
        "pnpm-workspace.yaml": "packages: ['apps/*']",
        "apps/api/package.json": '{"dependencies":{"express":"^4"}}',
        "apps/api/src/app.ts":
          'import express, { Express } from "express";\nconst app: Express = express();\napp.get("/x", (req, res) => res.send(""));\nexport default app;\n',
        "apps/web/package.json": '{"dependencies":{"react":"^18","kafkajs":"^2"}}',
        "apps/web/src/main.tsx": 'import React from "react";\n',
      }),
      facts: [],
      seed: "s1",
    });
    expect(items(typed).planted).toEqual(["node config", "node entry", "node call"]);
    expect(typed.writes["apps/api/src/app.ts"]).toMatch(/^app\.get\("\/[a-z]+-[a-z]+\/:id"/m);
    const router = planCanary({
      source: memorySource({
        "package.json": '{"dependencies":{"express":"^4"}}',
        "src/routes.js":
          'const express = require("express");\nconst router = express.Router({ mergeParams: true });\nrouter.get("/x", h);\nmodule.exports = router;\n',
      }),
      facts: [],
      seed: "s1",
    });
    expect(items(router).planted).toContain("node entry");
    expect(router.writes["src/routes.js"]).toMatch(/^router\.get\(/m);
  });

  it("Python: a requirements folder, requirements.in, Poetry and a typed app; a factory's app isn't one", () => {
    const folder = planCanary({
      source: memorySource({
        "requirements/base.txt": "flask==3.0\nrequests==2.31\n",
        "app/__init__.py":
          "from flask import Flask\nfrom app.views import bp\n\ndef create_app():\n    app = Flask(__name__)\n    app.register_blueprint(bp)\n    return app\n",
        "app/views.py": "from flask import Blueprint\nbp = Blueprint('v', __name__)\n",
      }),
      facts: [],
      seed: "s1",
    });
    expect(items(folder).planted).toEqual(["python config", "python entry", "python call"]);
    expect(folder.writes["app/views.py"]).toMatch(/^@bp\.get\("\/[a-z]+-[a-z]+\/<item_id>"\)/m);
    // a factory's app with no blueprint registered: no route, said why
    const factory = planCanary({
      source: memorySource({
        "requirements.txt": "flask==3.0\n",
        "app/__init__.py":
          "from flask import Flask\n\ndef create_app():\n    app = Flask(__name__)\n    return app\n",
        "app/views.py": "from flask import Blueprint\nbp = Blueprint('v', __name__)\n",
      }),
      facts: [],
      seed: "s1",
    });
    expect(items(factory).skipped).toContain("python entry");
    expect(factory.skipped.find((s) => s.what === "entry")!.reason).toMatch(/factory/);
    const poetry = planCanary({
      source: memorySource({
        "pyproject.toml":
          '[tool.poetry.dependencies]\npython = "^3.11"\nfastapi = {extras = ["standard"], version = "^0.110"}\nhttpx = "^0.27"\nkafka-python = "^2.0"\n',
        "src/svc/main.py": "from fastapi import FastAPI\napp: FastAPI = FastAPI()\n",
      }),
      facts: [],
      seed: "s1",
    });
    expect(items(poetry).planted).toEqual([
      "python config",
      "python entry",
      "python call",
      "python topic-out",
      "python topic-in",
    ]);
    // no Kafka client made at import, where it would fail with no broker: only where it is used
    const py = poetry.writes["src/svc/main.py"]!;
    expect(py).not.toMatch(/^\w+ = Kafka(Producer|Consumer)\(/m);
    expect(py).toMatch(/^def \w+\(\):\n {4}return KafkaProducer\(\)$/m);
    const pipTools = planCanary({
      source: memorySource({
        "requirements.in": "fastapi\n",
        "main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
      }),
      facts: [],
      seed: "s1",
    });
    expect(items(pipTools).planted).toContain("python entry");
  });

  it("Python: the HTTP client the build declares, a Flask route in Flask's words, no topics without kafka-python", () => {
    const plan = planCanary({
      source: memorySource({
        "requirements.txt": "flask==3.0.3\nrequests==2.32.3\n",
        "app.py": "from flask import Flask\n\napp = Flask(__name__)\n",
      }),
      facts: [],
      seed: "s1",
    });
    expect(items(plan)).toEqual({
      planted: ["python config", "python entry", "python call"],
      skipped: ["python topic-in", "python topic-out"],
    });
    const text = plan.writes["app.py"]!;
    expect(text).toMatch(/@app\.get\("\/[a-z]+-[a-z]+\/<item_id>"\)/);
    expect(text).toContain("import requests");
    expect(text).not.toContain("httpx");
    // no web framework declared: the app isn't one to serve on; no client: no call
    const bare = planCanary({
      source: memorySource({
        "pyproject.toml": '[project]\nname = "x"\n',
        "app.py": "from flask import Flask\n\napp = Flask(__name__)\n",
      }),
      facts: [],
      seed: "s1",
    });
    expect(items(bare)).toEqual({
      planted: ["python config"],
      skipped: ["python entry", "python call", "python topic-in", "python topic-out"],
    });
  });
});

describe("canaryNeverCopied", () => {
  it("leaves out credentials, env files, secrets, keys and state by any name", () => {
    for (const p of [
      ".env",
      ".env.prod",
      "prod.env",
      "deploy/staging.env",
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".git-credentials",
      "kubeconfig",
      "ops/kubeconfig.yaml",
      ".kube/config",
      ".docker/config.json",
      "secrets.yaml",
      "config/secret.yml",
      "src/main/resources/application-secrets.yml",
      "service-account.json",
      "gcp/service-account-ledger.json",
      "infra/terraform.tfvars",
      "infra/prod.tfvars.json",
      "infra/terraform.tfstate",
      "infra/terraform.tfstate.backup",
      ".htpasswd",
      "deploy/key.p8",
      "certs/client.p12",
      "certs/client.pfx",
      "vault.kdbx",
      "app.keystore",
      "keystore.jks",
      "server.key",
      "server.pem",
      "id_rsa",
      ".ssh/id_ed25519.pub",
      ".aws/credentials",
      "credentials.json",
      "secrets/db.txt",
      ".npmrc::$DATA",
      // second review of ADR 0196: the rest of them, and their backups
      ".envrc",
      ".env.local",
      "config/.env.production",
      ".pgpass",
      ".my.cnf",
      ".s3cfg",
      ".boto",
      ".vault-token",
      ".dockercfg",
      ".yarnrc",
      ".terraformrc",
      "credentials.tfrc.json",
      "local.settings.json",
      "secrets.json",
      "appsettings.Secrets.json",
      "src/Forge.Api/appsettings.Development.secrets.json",
      "auth.json",
      "sa-key.json",
      "deploy/forge-sa-key-prod.json",
      "gcp-key.json",
      "firebase-adminsdk-abc12.json",
      "client_secret_123.apps.googleusercontent.com.json",
      "host.keytab",
      "priv.asc",
      "signing.gpg",
      "prod.ovpn",
      "id_rsa.ppk",
      "wallet.dat",
      "settings-security.xml",
      ".config/gh/hosts.yml",
      ".cargo/credentials",
      ".gradle/gradle.properties",
      ".ssh/config",
      ".netrc.bak",
      ".git-credentials.old",
      "secrets.yaml.orig",
      "server.key~",
    ])
      expect(canaryNeverCopied(p), p).toBe(true);
    for (const p of [
      "src/main/resources/application.yml",
      "package.json",
      "src/env.ts",
      "docs/secrets-handling.md",
      "infra/main.tf",
      "src/main/java/forge/ledger/KeyStoreLoader.java",
      "pom.xml",
      "gradle.properties",
      "src/main/resources/application.yml.bak",
      "appsettings.json",
      "docs/keys.md",
    ])
      expect(canaryNeverCopied(p), p).toBe(false);
  });

  it("knows a secret by what a file's start holds, whatever it is named", () => {
    // built at run time: no literal key or token in the repo
    const dash = "-".repeat(5);
    for (const t of [
      `${dash}BEGIN RSA PRIVATE KEY${dash}\nMIIE...`,
      `${dash}BEGIN OPENSSH PRIVATE KEY${dash}`,
      `${dash}BEGIN PGP PRIVATE KEY BLOCK${dash}`,
      "[default]\naws_secret_access_key = x\n",
      '{"type": "service_account", "private_key": "x"}',
      ["//registry.forge.example/:_auth", "Token=x"].join(""),
    ])
      expect(canaryHoldsSecret(t), t).toBe(true);
    for (const t of [
      "server:\n  port: 8080\n",
      "const privateKey = loadKey();",
      "# how to set aws credentials: see docs",
    ])
      expect(canaryHoldsSecret(t), t).toBe(false);
    expect(CANARY_SECRET_PREFIX).toBe(64 * 1024);
  });
});
