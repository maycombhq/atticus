import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  interfaceId,
  JOINED_BY_FOLDER_NAME,
  JOINED_BY_PATH,
  JOINED_BY_PLATFORM_SETTING,
  joinFacts,
  joinRecords,
  parseFacts,
  type Fact,
  type JoinRepo,
} from "../src/index.js";

/**
 * J0: a call whose base URL (or a topic) is a config placeholder — `${X}`, Spring's `${X:default}`,
 * `env:X` — is resolved through the config facts that set `X`: in the caller's own repo, or in any
 * repo of the estate where the setting is for the caller's component (its folder, its deployment,
 * its `component` or `target`). Every environment's value a manifest host or base path claims is
 * accepted, and the join cites both lines: the placeholder and the value. No model.
 */

const DIR = join(__dirname, "..", "..", "..", "fixtures", "estate-facts", "placeholders");
const read = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const estate = (o: { config?: boolean } = {}): JoinRepo[] => [
  { repo: "forge-pay", component: "pay-api", facts: read("forge-pay") },
  ...(o.config === false ? [] : [{ repo: "forge-config", facts: read("forge-config") }]),
  {
    repo: "forge-payments",
    component: "payments-api",
    hosts: ["apps.ocp.forge.internal"],
    basePath: "/forge/payments",
    facts: read("forge-payments"),
  },
  {
    repo: "forge-limits",
    component: "limits-api",
    hosts: ["limits.apps.forge.internal"],
    facts: read("forge-limits"),
  },
  {
    repo: "forge-ledger",
    component: "ledger-api",
    hosts: ["ledger.forge.internal"],
    facts: read("forge-ledger"),
  },
  {
    repo: "forge-risk",
    component: "risk-api",
    hosts: ["risk.apps.forge.internal"],
    facts: read("forge-risk"),
  },
  {
    repo: "forge-risk-v2",
    component: "risk-v2-api",
    hosts: ["risk-v2.apps.forge.internal"],
    facts: read("forge-risk-v2"),
  },
];
const joinOf = (out: ReturnType<typeof joinFacts>, call: string) =>
  out.joins.filter((j) => j.call.fact === call);

describe("J0: config placeholders resolved through the config that sets them", () => {
  const out = joinFacts({ repos: estate() });

  it("joins ${PAYMENTS_URL} by the host a config repo's prod value gives, citing both lines", () => {
    const [j, ...more] = joinOf(out, "c-post-payment");
    expect(more).toEqual([]);
    expect(j).toMatchObject({
      entry: { repo: "forge-payments", fact: "e-post-payments" },
      how: "host",
      tie: {
        repo: "forge-pay",
        fact: "cfg-payments-url",
        at: "src/main/resources/application.yml:4",
      },
      // dev's host is nobody's, so only prod's line is the evidence; statements-api's is not pay-api's
      through: [
        {
          repo: "forge-config",
          fact: "cfg-pay-payments-url-prod",
          at: "apps/pay-api/values-prod.yaml:12",
        },
      ],
    });
    expect(j!.inferred).toBeUndefined();
  });

  it("takes the repo's own ConfigMap over a Spring default", () => {
    const [j] = joinOf(out, "c-get-limit");
    expect(j).toMatchObject({
      entry: { repo: "forge-limits", fact: "e-get-limit" },
      how: "host",
      tie: { fact: "cfg-limits-url" },
      through: [
        { repo: "forge-pay", fact: "cfg-limits-url-env", at: "openshift/configmap.yaml:7" },
      ],
    });
  });

  it("uses a Spring default nobody overrides, cited on its own line", () => {
    const [j] = joinOf(out, "c-get-balance");
    expect(j).toMatchObject({
      entry: { repo: "forge-ledger", fact: "e-get-balance" },
      how: "host",
      tie: { fact: "cfg-ledger-url" },
    });
    expect(j!.through).toBeUndefined();
  });

  it("asks when environments set the variable to hosts different repos answer on", () => {
    expect(joinOf(out, "c-post-risk-check")).toEqual([]);
    const ask = out.asks.find((a) => a.call.fact === "c-post-risk-check");
    expect(ask?.reason).toBe("ambiguous");
    expect(ask?.candidates.map((c) => c.repo)).toEqual(["forge-risk", "forge-risk-v2"]);
  });

  it("joins a publish and a listener whose topics are placeholders set to the same name", () => {
    const [j, ...more] = joinOf(out, "c-publish-payment-made");
    expect(more).toEqual([]);
    expect(j).toMatchObject({
      entry: { repo: "forge-ledger", fact: "e-on-payment-made" },
      how: "topic",
      path: "forge.payment.made",
      interface: interfaceId("pay-api", "ledger-api", undefined, "forge.payment.made"),
      through: [{ repo: "forge-pay", fact: "cfg-payment-made-topic" }],
      entryThrough: [{ repo: "forge-config", fact: "cfg-ledger-topic" }],
    });
  });

  it("puts the placeholder's line and the value's line in the Interface's evidence", () => {
    const records = joinRecords(out, estate());
    const pay = records.find(
      (r) => r.kind === "Interface" && r.from === "pay-api" && r.to === "payments-api",
    ) as {
      flags?: string[];
      confidence: string;
      evidence: { repo: string; path: string; line: number; side?: string }[];
    };
    // the prod value is pay-api's only because its file is in a folder named pay-api: a guess (J0)
    expect(pay.flags).toEqual([JOINED_BY_FOLDER_NAME]);
    expect(pay.confidence).toBe("inferred");
    expect(pay.evidence.map((e) => `${e.side}:${e.repo}:${e.path}:${e.line}`)).toEqual([
      "caller:forge-pay:src/main/java/forge/pay/PaymentsClient.java:21",
      "caller:forge-pay:src/main/resources/application.yml:4",
      "caller:forge-config:apps/pay-api/values-prod.yaml:12",
      "callee:forge-payments:src/main/java/forge/payments/PaymentsController.java:20",
    ]);
    const topic = records.find(
      (r) =>
        r.kind === "Interface" &&
        r.from === "pay-api" &&
        r.to === "ledger-api" &&
        r.via === "event-bus",
    ) as { normalizedPath: string; evidence: { repo: string; path: string; side?: string }[] };
    expect(topic.normalizedPath).toBe("forge.payment.made");
    // the listener's topic is set in apps/ledger-api/: found by the folder's name, a guess
    expect(topic).toMatchObject({ confidence: "inferred", flags: [JOINED_BY_FOLDER_NAME] });
    expect(topic.evidence.map((e) => `${e.side}:${e.repo}:${e.path}`)).toEqual([
      "caller:forge-pay:src/main/java/forge/pay/PaymentEvents.java",
      "caller:forge-pay:src/main/resources/application.yml",
      "callee:forge-ledger:src/main/java/forge/ledger/PaymentMadeListener.java",
      "callee:forge-config:apps/ledger-api/configmap.yaml",
    ]);
  });

  it("is the same whatever order the repos come in", () => {
    expect(joinFacts({ repos: [...estate()].reverse() })).toEqual(out);
  });

  it("without the config repo, ${PAYMENTS_URL} has no host and falls to the path, as before", () => {
    const bare = joinFacts({ repos: estate({ config: false }) });
    const [j] = joinOf(bare, "c-post-payment");
    expect(j).toMatchObject({ how: "path", inferred: { within: "estate" } });
    expect(j!.through).toBeUndefined();
    const records = joinRecords(bare, estate({ config: false }));
    const pay = records.find((r) => r.kind === "Interface" && r.to === "payments-api") as {
      flags?: string[];
    };
    expect(pay.flags).toEqual([JOINED_BY_PATH]);
    // and the listener's topic, set only in the config repo, is no one's
    expect(joinOf(bare, "c-publish-payment-made")).toEqual([]);
  });
});

describe("J0: which settings count for a component, and the forms a placeholder takes", () => {
  const fact = (repo: string, id: string, kind: string, extra: Record<string, unknown>): Fact =>
    ({
      kind,
      id,
      repo,
      commit: "8888ccc",
      cite: { file: "src/app.ts", line: 3, value: "x" },
      verified: "line",
      by: "assistant",
      conf: "declared",
      ...extra,
    }) as Fact;
  const limits: JoinRepo = {
    repo: "forge-limits",
    component: "limits-api",
    hosts: ["limits.apps.forge.internal"],
    facts: [
      fact("forge-limits", "e-get-limit", "entry", {
        entryType: "rest",
        method: "GET",
        path: "/limits/{id}",
      }),
    ],
  };
  const getLimit = (extra: Record<string, unknown>) =>
    fact("forge-web", "c-get-limit", "call", {
      callType: "rest",
      method: "GET",
      path: "/limits/{id}",
      ...extra,
    });

  it("reads `env:X` on the call's own base, set in the repo's own config", () => {
    const out = joinFacts({
      repos: [
        {
          repo: "forge-web",
          facts: [
            getLimit({ base: "env:LIMITS_URL" }),
            fact("forge-web", "cfg-limits", "config", {
              key: "LIMITS_URL",
              value: "https://limits.apps.forge.internal",
              cite: { file: "deploy/configmap.yaml", line: 5, value: "LIMITS_URL" },
            }),
          ],
        },
        limits,
      ],
    });
    expect(out.joins).toMatchObject([
      { call: { fact: "c-get-limit" }, how: "host", through: [{ fact: "cfg-limits" }] },
    ]);
    expect(out.joins[0]!.tie).toBeUndefined();
  });

  it("reads a placeholder in a config fact's `source`, with Spring's relaxed names, through a deployment the config file names", () => {
    const out = joinFacts({
      repos: [
        {
          repo: "forge-web",
          facts: [
            getLimit({ base: "limits.base-url" }),
            fact("forge-web", "cfg-limits", "config", {
              key: "limits.base-url",
              source: "${forge.limits.url}",
            }),
          ],
        },
        {
          repo: "forge-deploy",
          facts: [
            fact("forge-deploy", "d-web", "deploy", {
              platform: "openshift",
              resourceName: "forge-web",
              cite: { file: "web/deployment.yaml", line: 4, value: "forge-web" },
            }),
            fact("forge-deploy", "cfg-web-limits", "config", {
              key: "FORGE_LIMITS_URL",
              value: "https://limits.apps.forge.internal",
              cite: { file: "web/deployment.yaml", line: 21, value: "FORGE_LIMITS_URL" },
            }),
            // the same variable, in a file for nobody in particular: not forge-web's
            fact("forge-deploy", "cfg-loose", "config", {
              key: "FORGE_LIMITS_URL",
              value: "https://nobody.forge.internal",
              cite: { file: "shared/defaults.yaml", line: 2, value: "FORGE_LIMITS_URL" },
            }),
          ],
        },
        limits,
      ],
    });
    expect(out.asks).toEqual([]);
    expect(out.joins).toMatchObject([
      {
        call: { fact: "c-get-limit" },
        how: "host",
        tie: { fact: "cfg-limits" },
        through: [{ repo: "forge-deploy", fact: "cfg-web-limits" }],
      },
    ]);
    // the setting's own file deploys forge-web: cited, not guessed
    expect(out.joins[0]!.guesses).toBeUndefined();
  });

  it("puts a placeholder inside a URL together with its value", () => {
    const out = joinFacts({
      repos: [
        {
          repo: "forge-web",
          facts: [
            getLimit({ base: "limits.url" }),
            fact("forge-web", "cfg-limits", "config", {
              key: "limits.url",
              value: "https://${LIMITS_HOST}/v2",
            }),
            fact("forge-web", "cfg-limits-host", "config", {
              key: "LIMITS_HOST",
              value: "limits.apps.forge.internal",
              target: "forge-web",
              cite: { file: "deploy/values.yaml", line: 8, value: "LIMITS_HOST" },
            }),
          ],
        },
        {
          ...limits,
          facts: [
            fact("forge-limits", "e-get-limit", "entry", {
              entryType: "rest",
              method: "GET",
              path: "/v2/limits/{id}",
            }),
          ],
        },
      ],
    });
    expect(out.joins).toMatchObject([
      { how: "host", entry: { fact: "e-get-limit" }, through: [{ fact: "cfg-limits-host" }] },
    ]);
    // a setting whose target is the component is for it by its own word
    expect(out.joins[0]!.guesses).toBeUndefined();
  });

  it("reads a platform-wide setting only when nothing sets the variable for the component", () => {
    const platform = (value: string, file: string, id: string) =>
      fact("forge-deploy", id, "config", {
        key: "LIMITS_URL",
        value,
        cite: { file, line: 2, value: "LIMITS_URL" },
      });
    const web = (extra: Fact[]): JoinRepo[] => [
      {
        repo: "forge-web",
        facts: [
          getLimit({ base: "limits.url" }),
          fact("forge-web", "cfg-limits", "config", { key: "limits.url", value: "${LIMITS_URL}" }),
        ],
      },
      {
        repo: "forge-deploy",
        facts: [
          platform("https://limits.apps.forge.internal", "charts/platform/values.yaml", "cfg-all"),
          ...extra,
        ],
      },
      limits,
    ];
    // a platform chart sets it for every service: used, and cited, but a guess (nobody aimed it)
    const all = joinFacts({ repos: web([]) });
    expect(all.joins).toMatchObject([
      {
        how: "host",
        through: [{ repo: "forge-deploy", fact: "cfg-all" }],
        guesses: [JOINED_BY_PLATFORM_SETTING],
      },
    ]);
    expect(joinRecords(all, web([])).find((r) => r.kind === "Interface")).toMatchObject({
      confidence: "inferred",
      flags: [JOINED_BY_PLATFORM_SETTING],
    });
    // the component's own value comes first: the platform's isn't read
    const own = joinFacts({
      repos: web([
        platform("https://nobody.forge.internal", "apps/forge-web/values.yaml", "cfg-web"),
      ]),
    });
    expect(own.joins).toEqual([]);
    expect(own.asks).toMatchObject([{ reason: "unknown-host", host: "nobody.forge.internal" }]);
  });

  it("gives up on a placeholder that refers back to itself, without a host", () => {
    const out = joinFacts({
      repos: [
        {
          repo: "forge-web",
          facts: [
            getLimit({ base: "A" }),
            fact("forge-web", "cfg-a", "config", { key: "A", value: "${B}" }),
            fact("forge-web", "cfg-b", "config", { key: "B", value: "${A}" }),
          ],
        },
        limits,
      ],
    });
    // no host: the fallback's guess by path, as for any call with none
    expect(out.joins).toMatchObject([{ how: "path", inferred: { within: "estate" } }]);
  });
});
