import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { joinFacts, joinRecords, parseFacts, type Fact, type JoinRepo } from "../src/index.js";

/**
 * J0 follow-up: a Deployment's `env` entry set `valueFrom` a ConfigMap's key is a config fact whose
 * `source` is `configMapKeyRef:<configmap>/<key>`; the join follows it to the ConfigMap's entry
 * (in the same repo or the caller's, matched by the ConfigMap's name) and cites both. A Secret's
 * (`secretKeyRef:`) is followed only to a plain host. Two placeholders in one value are each
 * resolved when each has one value.
 */

const DIR = join(__dirname, "..", "..", "..", "fixtures", "estate-facts", "value-from");
const read = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const callee = (repo: string, component: string, host: string): JoinRepo => ({
  repo,
  component,
  hosts: [host],
  facts: read(repo),
});
const estate = (): JoinRepo[] => [
  { repo: "forge-wallet", component: "wallet-api", facts: read("forge-wallet") },
  { repo: "forge-deploy", facts: read("forge-deploy") },
  callee("forge-payments", "payments-api", "payments.apps.forge.internal"),
  callee("forge-ledger", "ledger-api", "ledger.forge.internal"),
  callee("forge-limits", "limits-api", "limits.apps.forge.internal"),
  callee("forge-risk", "risk-api", "risk.apps.forge.internal"),
  callee("forge-risk-v2", "risk-v2-api", "risk-v2.apps.forge.internal"),
  callee("forge-fraud", "fraud-api", "fraud.apps.forge.internal"),
];
const joinOf = (out: ReturnType<typeof joinFacts>, call: string) =>
  out.joins.filter((j) => j.call.fact === call);

describe("J0: valueFrom and two placeholders in one value", () => {
  const out = joinFacts({ repos: estate() });

  it("follows a configMapKeyRef to the ConfigMap its name names, citing both lines", () => {
    const [j, ...more] = joinOf(out, "c-post-payment");
    expect(more).toEqual([]);
    expect(j).toMatchObject({
      entry: { repo: "forge-payments", fact: "e-post-payments" },
      how: "host",
      tie: { fact: "cfg-payments-url", at: "src/main/resources/application.yml:4" },
      through: [
        { repo: "forge-wallet", fact: "cfg-env-payments-url", at: "openshift/deployment.yaml:24" },
        { repo: "forge-wallet", fact: "cfg-cm-payments-url", at: "openshift/configmap.yaml:7" },
      ],
    });
    expect(j!.inferred).toBeUndefined();
  });

  it("follows one set in the deploy repo to the ConfigMap file named for it", () => {
    const [j, ...more] = joinOf(out, "c-get-balance");
    expect(more).toEqual([]);
    expect(j).toMatchObject({
      entry: { repo: "forge-ledger", fact: "e-get-balance" },
      how: "host",
      through: [
        { repo: "forge-deploy", fact: "cfg-wallet-ledger-url" },
        {
          repo: "forge-deploy",
          fact: "cfg-ledger-config-base",
          at: "apps/wallet-api/ledger-config.yaml:6",
        },
      ],
    });
  });

  it("resolves two placeholders in one value when each has one value", () => {
    const [j] = joinOf(out, "c-get-limit");
    expect(j).toMatchObject({
      entry: { repo: "forge-limits", fact: "e-get-limit" },
      how: "host",
      tie: { fact: "cfg-limits-url" },
      through: [{ fact: "cfg-limits-scheme" }, { fact: "cfg-limits-host" }],
    });
  });

  it("leaves two placeholders unresolved when one of them has two values", () => {
    for (const j of joinOf(out, "c-post-risk-check")) {
      expect(j.how).toBe("path");
      expect(j.through).toBeUndefined();
    }
  });

  it("does not resolve a secretKeyRef to a Secret nobody wrote a value for", () => {
    const [j] = joinOf(out, "c-post-fraud-score");
    expect(j).toMatchObject({ how: "path", inferred: { within: "estate" } });
    expect(j!.through).toBeUndefined();
  });

  it("puts every line followed in the Interface's evidence", () => {
    const records = joinRecords(out, estate());
    const pay = records.find(
      (r) => r.kind === "Interface" && r.from === "wallet-api" && r.to === "payments-api",
    ) as { evidence: { repo: string; path: string; line: number; side?: string }[] };
    expect(pay.evidence.map((e) => `${e.side}:${e.repo}:${e.path}:${e.line}`)).toEqual([
      "caller:forge-wallet:src/main/java/forge/wallet/PaymentsClient.java:21",
      "caller:forge-wallet:src/main/resources/application.yml:4",
      "caller:forge-wallet:openshift/deployment.yaml:24",
      "caller:forge-wallet:openshift/configmap.yaml:7",
      "callee:forge-payments:src/main/java/forge/payments/PaymentsController.java:20",
    ]);
  });

  it("is the same whatever order the repos come in", () => {
    expect(joinFacts({ repos: [...estate()].reverse() })).toEqual(out);
  });
});

describe("J0: a secretKeyRef is followed only to a plain host", () => {
  const fact = (id: string, extra: Record<string, unknown>): Fact =>
    ({
      kind: "config",
      id,
      repo: "forge-wallet",
      commit: "9999aaa",
      cite: { file: "openshift/deployment.yaml", line: 3, value: "x" },
      verified: "line",
      by: "assistant",
      conf: "declared",
      ...extra,
    }) as Fact;
  const run = (secretValue: string) =>
    joinFacts({
      repos: [
        {
          repo: "forge-wallet",
          component: "wallet-api",
          facts: [
            ...read("forge-wallet").filter(
              (f) => f.id !== "cfg-cm-payments-url" && f.id !== "cfg-env-payments-url",
            ),
            fact("cfg-env-payments-url", {
              key: "PAYMENTS_URL",
              source: "secretKeyRef:payments-endpoint/url",
              target: "wallet-api",
            }),
            fact("cfg-secret-payments-url", {
              key: "url",
              value: secretValue,
              cite: {
                file: "openshift/payments-endpoint.yaml",
                line: 7,
                value: "url",
              },
            }),
          ],
        },
        callee("forge-payments", "payments-api", "payments.apps.forge.internal"),
      ],
    });

  it("joins by a Secret's value that is only a host", () => {
    expect(joinOf(run("https://payments.apps.forge.internal"), "c-post-payment")).toMatchObject([
      {
        how: "host",
        through: [{ fact: "cfg-env-payments-url" }, { fact: "cfg-secret-payments-url" }],
      },
    ]);
  });

  it("never reads a Secret's value that carries more than a host", () => {
    for (const v of [
      "https://svc:hunter2@payments.apps.forge.internal",
      "https://payments.apps.forge.internal/hook/T0K3N",
      "https://payments.apps.forge.internal?key=abc",
    ]) {
      const [j] = joinOf(run(v), "c-post-payment");
      expect(j?.through).toBeUndefined();
      expect(j?.how).not.toBe("host");
    }
  });
});
