import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canaryClaimText, parseFacts, type Fact } from "@maycombhq/core";
import {
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
      expect(plan.planted.length).toBeGreaterThanOrEqual(2);
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
    expect(items(browser)).toEqual({
      planted: ["node config", "node call"],
      skipped: ["node entry", "node topic-in", "node topic-out"],
    });
    expect(Object.values(browser.writes).join("\n")).not.toMatch(/express|\.get\(|kafkajs/);
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
    ])
      expect(canaryNeverCopied(p), p).toBe(false);
  });
});
