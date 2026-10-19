import { describe, expect, it } from "vitest";
import { memoryRepo } from "@maycombhq/sdk";
import { flattenYaml, repoConfig, repoConfigFor, resolvePlaceholders } from "../src/index.js";

const SHA = "f".repeat(40);
const v = (m: Map<string, { value: string }>, k: string) => m.get(k)?.value;

describe("configuration read the way Spring reads it", () => {
  it("reads every YAML document; one activated by a profile belongs to that profile", () => {
    const flat = flattenYaml(
      `payments:
  url: https://base
---
spring:
  config:
    activate:
      on-profile: dev
payments:
  url: https://dev
`,
      "application.yml",
    );
    // The base document's keys; the dev document doesn't override them.
    expect(flat.get("payments.url")?.value).toBe("https://base");
  });

  it("base config wins; a key only in profiles takes prod's value, not whichever sorts first", async () => {
    const repo = memoryRepo("x", SHA, {
      "src/main/resources/application.yml": "server:\n  port: 8080\n",
      "src/main/resources/application-dev.yml": "payments:\n  url: https://pay-dev.internal\n",
      "src/main/resources/application-prod.yml": "payments:\n  url: https://pay.internal\n",
      "src/main/resources/application-uat.yml":
        "payments:\n  url: https://pay-uat.internal\n  extra: uat-only\n",
    });
    const c = await repoConfig(repo);
    expect(v(c, "server.port")).toBe("8080");
    expect(v(c, "payments.url")).toBe("https://pay.internal");
    expect(v(c, "payments.extra")).toBe("uat-only");
  });

  it("resolves placeholders inside placeholders and chains of them", () => {
    const config = new Map(
      Object.entries({
        host: "pay.internal",
        base: "https://${host}",
        "payments.url": "${base}/v2",
        b: "from-b",
      }).map(([k, value]) => [k, { value, line: 1, file: "application.yml" }]),
    );
    expect(resolvePlaceholders("${payments.url}/payments", config)).toBe(
      "https://pay.internal/v2/payments",
    );
    expect(resolvePlaceholders("${a:${b:fallback}}", config)).toBe("from-b");
    expect(resolvePlaceholders("${a:${c:fallback}}", config)).toBe("fallback");
    expect(resolvePlaceholders("${unknown}/x", config)).toBe("${unknown}/x");
  });

  it("gives each module its own config first, then the repo's", async () => {
    const repo = memoryRepo("x", SHA, {
      "src/main/resources/application.yml":
        "shared:\n  key: root\npayments:\n  url: https://root\n",
      "cards-api/src/main/resources/application.yml": "payments:\n  url: https://from-cards-api\n",
      "cards-batch/src/main/resources/application.yml":
        "payments:\n  url: https://from-cards-batch\n",
    });
    const forFile = await repoConfigFor(repo);
    const api = forFile("cards-api/src/main/java/a/Client.java");
    expect(v(api, "payments.url")).toBe("https://from-cards-api");
    expect(v(api, "shared.key")).toBe("root");
    expect(v(forFile("cards-batch/src/main/java/b/Job.java"), "payments.url")).toBe(
      "https://from-cards-batch",
    );
    expect(v(forFile("src/main/java/c/Root.java"), "payments.url")).toBe("https://root");
  });
});
