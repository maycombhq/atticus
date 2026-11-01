import { describe, expect, it } from "vitest";
import { Fact } from "@maycombhq/core";
import { verifyFacts, type FileSource } from "../src/index.js";

/**
 * J1 (ADR 0143): an exposure fact (a deploy fact's `host` and `basePath`) is checked as every
 * value is: the host and the base path must be written on the cited line or one of its
 * `cite.with` parts, a templated host citing the values file's line that sets it. An exposure
 * read in a deploy repo names the component it reaches, which must be one of the estate's.
 */

const FILES: Record<string, string> = {
  "apps/accounts/route.yaml": [
    "apiVersion: route.openshift.io/v1",
    "kind: Route",
    "metadata:",
    "  name: accounts-api",
    "spec:",
    "  host: apps.forge.internal",
    "  path: /forge-svc/accounts",
    "  to:",
    "    kind: Service",
    "    name: accounts-api",
  ].join("\n"),
  "charts/payments/templates/route.yaml": [
    "apiVersion: route.openshift.io/v1",
    "kind: Route",
    "metadata:",
    "  name: payments-api",
    "spec:",
    "  host: {{ .Values.route.host }}",
    "  path: /forge-svc/payments",
  ].join("\n"),
  "charts/payments/values-prod.yaml": ["route:", "  host: apps.forge.internal"].join("\n"),
  // J1 gaps: an Ingress whose path is a regular expression, and a Service's in-cluster address.
  "apps/limits/ingress.yaml": [
    "apiVersion: networking.k8s.io/v1",
    "kind: Ingress",
    "metadata:",
    "  name: limits-api",
    "spec:",
    "  rules:",
    "    - host: apps.forge.internal",
    "      http:",
    "        paths:",
    "          - path: /forge/limits(/|$)(.*)",
    "            pathType: ImplementationSpecific",
    "            backend:",
    "              service:",
    "                name: limits-api",
  ].join("\n"),
  "apps/accounts/service.yaml": [
    "apiVersion: v1",
    "kind: Service",
    "metadata:",
    "  labels:",
    "    team: accounts",
    "  name: accounts-api",
    "spec:",
    "  selector:",
    "    app: accounts-api",
    "  ports:",
    "    - port: 8080",
    "      targetPort: http",
  ].join("\n"),
  "apps/accounts/kustomization.yaml": [
    "resources:",
    "  - service.yaml",
    "namespace: forge-accounts",
  ].join("\n"),
};
const source: FileSource = { list: () => Object.keys(FILES), read: (p) => FILES[p] };
const C = "e5e0010";
const route = (o: Record<string, unknown>): Fact =>
  Fact.parse({
    kind: "deploy",
    id: "route.accounts",
    repo: "forge-deploy",
    commit: C,
    platform: "openshift",
    resourceType: "route",
    resourceName: "accounts-api",
    exposes: "accounts-api",
    host: "apps.forge.internal",
    basePath: "/forge-svc/accounts",
    cite: {
      file: "apps/accounts/route.yaml",
      line: 4,
      value: "accounts-api",
      with: [
        { file: "apps/accounts/route.yaml", line: 6, value: "apps.forge.internal" },
        { file: "apps/accounts/route.yaml", line: 7, value: "/forge-svc/accounts" },
      ],
    },
    ...o,
  });
const ESTATE = { components: ["accounts-api", "payments-api", "forge-accounts", "deploy-config"] };
const run = (facts: Fact[], estate: { components: string[] } | null = ESTATE) =>
  verifyFacts({ facts, source, commit: C, ...(estate ? { estate } : {}) });
const codes = async (f: Fact) => (await run([f])).rejected.map((r) => [r.code, r.message]);

describe("J1: an exposure's host and base path are checked on their lines", () => {
  it("keeps a Route whose host and path are on its cited lines", async () => {
    const r = await run([route({})]);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(1);
  });

  it("keeps a templated host cited on the values file's line that sets it", async () => {
    const f = route({
      id: "route.payments",
      resourceName: "payments-api",
      exposes: "payments-api",
      env: "prod",
      basePath: "/forge-svc/payments",
      cite: {
        file: "charts/payments/templates/route.yaml",
        line: 4,
        value: "payments-api",
        with: [
          { file: "charts/payments/templates/route.yaml", line: 6, value: ".Values.route.host" },
          { file: "charts/payments/values-prod.yaml", line: 2, value: "apps.forge.internal" },
          { file: "charts/payments/templates/route.yaml", line: 7, value: "/forge-svc/payments" },
        ],
      },
    });
    expect((await run([f])).rejected).toEqual([]);
  });

  it("rejects a host no cited line writes", async () => {
    expect(await codes(route({ host: "apps.forge.example" }))).toEqual([
      [
        "claim-not-on-line",
        'deploy route.accounts host claims "apps.forge.example", which apps/accounts/route.yaml:4 (or the line either side) and its parts does not name',
      ],
    ]);
  });

  it("rejects a base path no cited line writes", async () => {
    const got = await codes(route({ basePath: "/forge-svc/limits" }));
    expect(got.map(([code]) => code)).toEqual(["claim-not-on-line"]);
  });

  it("rejects a host written as a template: the values file's line is cited instead", async () => {
    expect(await codes(route({ host: "{{ .Values.route.host }}" }))).toEqual([
      [
        "exposure-template",
        'deploy route.accounts host "{{ .Values.route.host }}" is a template: give the host the values file sets, with that line in cite.with (one fact per environment\'s values file, each with its env)',
      ],
    ]);
  });
});

describe("J1: an exposure names a component of the estate", () => {
  it("rejects one whose exposes is no component or repo of the estate", async () => {
    expect(await codes(route({ exposes: "ghost-api" }))).toEqual([
      [
        "exposure-component",
        'deploy route.accounts exposes "ghost-api", which is no component or repo of the estate (repos.manifest.yaml): name the component the route reaches, or write a question when no file says which',
      ],
    ]);
  });

  it("resolves a component by its slug, and a repo's id too", async () => {
    expect(await codes(route({ exposes: "Accounts-API" }))).toEqual([]);
    expect(await codes(route({ exposes: "forge-accounts" }))).toEqual([]);
  });

  it("checks nothing of the name with no estate to check it against", async () => {
    expect((await run([route({ exposes: "ghost-api" })], null)).rejected).toEqual([]);
  });

  it("rejects an exposure with no exposes in a repo whose facts serve nothing (a deploy repo)", async () => {
    const f = route({});
    delete (f as { exposes?: string }).exposes;
    expect(await codes(f)).toEqual([
      [
        "exposure-component",
        "deploy route.accounts says where a component is reached and names none: this repo's facts serve nothing, so its routes reach another repo's component; name it in exposes (one of the estate's components), or write a question when no file says which",
      ],
    ]);
  });

  it("keeps an exposure with no exposes in a repo that serves its own entries", async () => {
    const f = route({});
    delete (f as { exposes?: string }).exposes;
    const e = Fact.parse({
      kind: "entry",
      id: "entry.get.accounts",
      repo: "forge-deploy",
      commit: C,
      entryType: "rest",
      method: "GET",
      path: "accounts-api",
      cite: { file: "apps/accounts/route.yaml", line: 10, value: "accounts-api" },
    });
    expect((await run([f, e])).rejected).toEqual([]);
  });
});

describe("J1: an Ingress path written as a regular expression", () => {
  const ingress = (basePath: string, part = "/forge/limits(/|$)(.*)") =>
    route({
      id: "ingress.limits",
      resourceType: "ingress",
      resourceName: "limits-api",
      exposes: "limits-api",
      host: "apps.forge.internal",
      basePath,
      cite: {
        file: "apps/limits/ingress.yaml",
        line: 4,
        value: "limits-api",
        with: [
          { file: "apps/limits/ingress.yaml", line: 7, value: "apps.forge.internal" },
          { file: "apps/limits/ingress.yaml", line: 10, value: part },
        ],
      },
    });
  const estate = { components: [...ESTATE.components, "limits-api"] };

  it("keeps the plain prefix as the base path, the regex on the cited line", async () => {
    expect((await run([ingress("/forge/limits")], estate)).rejected).toEqual([]);
    expect((await run([ingress("/forge/limits", "/forge/limits")], estate)).rejected).toEqual([]);
  });

  it("rejects the regex itself as the base path: the plain prefix is written", async () => {
    const r = await run([ingress("/forge/limits(/|$)(.*)")], estate);
    expect(r.rejected.map((x) => [x.code, x.message])).toEqual([
      [
        "exposure-regex",
        'deploy ingress.limits basePath "/forge/limits(/|$)(.*)" is a regular expression: write its plain prefix, "/forge/limits" (the segments before the first pattern), and keep the line that writes the expression cited',
      ],
    ]);
  });

  it("still rejects a prefix the line doesn't write", async () => {
    const r = await run([ingress("/forge/caps")], estate);
    expect(r.rejected.map((x) => x.code)).toEqual(["claim-not-on-line"]);
  });
});

describe("J1: a Service's in-cluster address", () => {
  const service = (host: string, o: Record<string, unknown> = {}) =>
    route({
      id: "service.accounts",
      resourceType: "service",
      resourceName: "accounts-api",
      host,
      cite: {
        file: "apps/accounts/service.yaml",
        line: 6,
        value: "accounts-api",
        with: [
          { file: "apps/accounts/kustomization.yaml", line: 3, value: "forge-accounts" },
          { file: "apps/accounts/service.yaml", line: 11, value: "8080" },
        ],
      },
      ...o,
    });
  const without = (f: Fact) => {
    delete (f as { basePath?: string }).basePath;
    return f;
  };

  it("keeps <name>.<namespace>.svc.cluster.local:<port>, each part on a cited line", async () => {
    for (const h of [
      "accounts-api.forge-accounts.svc.cluster.local:8080",
      "accounts-api.forge-accounts.svc.cluster.local",
    ])
      expect((await run([without(service(h))])).rejected, h).toEqual([]);
  });

  it("rejects a namespace or a port no cited line writes", async () => {
    const r = await run([
      without(service("accounts-api.forge-ledger.svc.cluster.local:8080")),
      without(service("accounts-api.forge-accounts.svc.cluster.local:9090", { id: "service.b" })),
    ]);
    expect(r.rejected.map((x) => [x.code, x.message])).toEqual([
      [
        "claim-not-on-line",
        'deploy service.accounts host\'s namespace claims "forge-ledger", which apps/accounts/service.yaml:6 (or the line either side) and its parts does not name',
      ],
      [
        "claim-not-on-line",
        'deploy service.b host\'s port claims "9090", which apps/accounts/service.yaml:6 (or the line either side) and its parts does not name',
      ],
    ]);
  });

  it("reads such a host on anything but a Service as written, so it must be on a line", async () => {
    const r = await run([
      without(service("accounts-api.forge-accounts.svc.cluster.local", { resourceType: "route" })),
    ]);
    expect(r.rejected.map((x) => x.code)).toEqual(["claim-not-on-line"]);
  });
});

describe("J1: a module the manifest doesn't list, named <repo>/<module>", () => {
  const estate = {
    components: ESTATE.components,
    repoComponents: { "forge-accounts": ["accounts-api", "statements"] },
  };
  const named = (exposes: string, id = "route.accounts") => route({ exposes, id });

  it("keeps a module the repo's facts name", async () => {
    expect((await run([named("forge-accounts/statements")], estate)).rejected).toEqual([]);
    expect((await run([named("forge-accounts/Statements")], estate)).rejected).toEqual([]);
  });

  it("rejects a module the repo's facts don't name, and a repo the estate hasn't", async () => {
    const r = await run(
      [named("forge-accounts/ghost"), named("forge-ghost/statements", "route.ghost")],
      estate,
    );
    expect(r.rejected.map((x) => [x.code, x.message])).toEqual([
      [
        "exposure-component",
        'deploy route.accounts exposes "forge-accounts/ghost": forge-accounts\'s facts name no component ghost (they name accounts-api, statements); name the module as its facts do, or write a question when no file says which',
      ],
      [
        "exposure-component",
        'deploy route.ghost exposes "forge-ghost/statements", which is no component or repo of the estate (repos.manifest.yaml): name the component the route reaches, or write a question when no file says which',
      ],
    ]);
  });

  it("keeps the module of a repo whose facts aren't written yet: the join says if it names none", async () => {
    const r = await run([named("deploy-config/anything")], estate);
    expect(r.rejected).toEqual([]);
  });
});
