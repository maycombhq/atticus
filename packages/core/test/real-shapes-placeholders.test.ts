import { describe, expect, it } from "vitest";
import { joinFacts, placeholderIn, type Fact, type JoinRepo } from "../src/index.js";

/**
 * Property tests for placeholder resolution (J0) on the forms public projects write
 * (`fixtures/real-shapes/README.md`): Spring's `${KEY}` and `${KEY:default}` (a default that is a
 * URL with its own `:` and `/`, or another placeholder), with spaces inside the braces; Camel's and
 * Mustache's `{{key}}` and `{{ key }}`; Maven filtering's and Apigee's `@key@`; `env:KEY`. Each is
 * drawn with text before and after it, and `placeholderIn` must give back its name, default and the
 * text around it. Then through the join: a call whose host is a placeholder joins the repo that
 * answers on the host its setting gives, whichever relaxed-binding spelling the code and the setting
 * use (`forge.rates-url`, `forge.ratesUrl`, `FORGE_RATES_URL`), or on its default when nothing sets
 * it. A small seeded generator (fast-check isn't a dependency): the same cases every run.
 */

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return { int, bool: (p = 0.5) => next() < p, pick: <T>(xs: readonly T[]) => xs[int(xs.length)]! };
}
type Rng = ReturnType<typeof rng>;
const SEEDS = Array.from({ length: 200 }, (_, i) => 0x9a7e0000 + i);

/** Text around a placeholder that holds none: a scheme, a path, a query. */
const AROUND_BEFORE = [
  "",
  "https://",
  "http4://",
  "lb://",
  "jdbc:postgresql://",
  "https://api.forge.example/",
];
const AROUND_AFTER = [
  "",
  "/v1",
  "/accounts/{id}",
  ":8443/ledger",
  "?bridgeEndpoint=true&throwExceptionOnFailure=false",
  "/rates",
];
const KEYS = [
  "forge.ledger.base-uri",
  "RATES_URL",
  "forge.clients.rates.base-url",
  "targetUrl",
  "ledger_host",
  "a",
];
const DEFAULTS = [
  "http://forge-rates.rates.svc.cluster.local:8080/rates",
  "localhost:8080",
  "https://ledger.forge.example",
  "${FALLBACK_URL:http://localhost}",
  "8080",
];

interface Drawn {
  value: string;
  want: { name: string; fallback?: string; before: string; after: string };
}

function draw(r: Rng): Drawn {
  const name = r.pick(KEYS);
  const before = r.pick(AROUND_BEFORE);
  const after = r.pick(AROUND_AFTER);
  const sp = () => r.pick(["", "", " "]);
  const form = r.pick(["spring", "spring-default", "mustache", "token", "env"] as const);
  if (form === "env") return { value: `env:${name}`, want: { name, before: "", after: "" } };
  if (form === "spring")
    return { value: `${before}\${${sp()}${name}${sp()}}${after}`, want: { name, before, after } };
  if (form === "spring-default") {
    const fallback = r.pick(DEFAULTS);
    return {
      value: `${before}\${${name}:${fallback}}${after}`,
      want: { name, fallback, before, after },
    };
  }
  if (form === "mustache")
    return { value: `${before}{{${sp()}${name}${sp()}}}${after}`, want: { name, before, after } };
  return { value: `${before}@${name}@${after}`, want: { name, before, after } };
}

describe("placeholderIn on generated real-world values", () => {
  it("gives each form's name, default and the text around it", () => {
    for (const seed of SEEDS) {
      const d = draw(rng(seed));
      expect(placeholderIn(d.value), `seed ${seed}: ${d.value}`).toEqual(d.want);
    }
  });

  it("takes no Helm expression for a setting", () => {
    for (const v of [
      "{{ .Values.ingress.host }}",
      "{{ .host | quote }}",
      '{{ include "forge-rates.fullname" . }}',
    ])
      expect(placeholderIn(v), v).toBeUndefined();
  });

  // known bug: placeholderIn looks for `${` before any other form, so in Camel's `{{base}}/accounts/${header.id}` it takes the simple expression `${header.id}`, not the first placeholder, `{{base}}`
  it.fails("takes the first placeholder of a value that mixes forms", () => {
    expect(placeholderIn("{{forge.ledger.base-uri}}/accounts/${header.id}")).toEqual({
      name: "forge.ledger.base-uri",
      before: "",
      after: "/accounts/${header.id}",
    });
    expect(placeholderIn("@targetUrl@/v1/${request.path}")).toMatchObject({ name: "targetUrl" });
  });
});

/** The ways one setting is spelled: as Spring's relaxed binding reads it, one key. */
const SPELLINGS = [
  ["forge.rates-url", "forge.ratesUrl", "FORGE_RATESURL", "forge.rates_url", "FORGE_RATES_URL"],
  ["ledger.base-uri", "LEDGER_BASEURI", "ledger.baseUri", "LEDGER_BASE_URI"],
] as const;

const fact = (f: Record<string, unknown>) =>
  ({ verified: "line", by: "assistant", conf: "declared", ...f }) as Fact;
const cite = (file: string, line: number, value: string) => ({ file, line, value });

function estateFor(r: Rng) {
  const spellings = r.pick(SPELLINGS);
  const inCode = r.pick(spellings);
  const inSetting = r.pick(spellings);
  const set = r.bool(0.75);
  const port = r.bool(0.3) ? ":8443" : "";
  const hostValue = `https://svc.forge.example${port}`;
  // set: maybe a default too, which the setting overrides; not set: the default is the host
  const fallback = set ? (r.bool(0.5) ? ":http://wrong.forge.example" : "") : `:${hostValue}`;
  const host = `\${${inCode}${fallback}}`;
  const caller: Fact[] = [
    fact({
      kind: "call",
      id: "call.get.items-id",
      repo: "forge-caller",
      commit: "abc1234",
      callType: "rest",
      method: "GET",
      path: "/items/{id}",
      host,
      cite: cite("src/main/java/forge/caller/Client.java", 9, "/items/{id}"),
    }),
    ...(set
      ? [
          fact({
            kind: "config",
            id: "config.svc-url",
            repo: "forge-caller",
            commit: "abc1234",
            settingKind: "config",
            key: inSetting,
            value: hostValue,
            cite: cite("src/main/resources/application.properties", 3, inSetting),
          }),
        ]
      : []),
  ];
  const callee: Fact[] = [
    fact({
      kind: "entry",
      id: "entry.get.items-id",
      repo: "forge-svc",
      commit: "def5678",
      entryType: "rest",
      method: "GET",
      path: "/items/{id}",
      cite: cite("src/main/java/forge/svc/Items.java", 12, "/items/{id}"),
    }),
  ];
  const decoy: Fact[] = [
    fact({
      kind: "entry",
      id: "entry.get.items-id",
      repo: "forge-wrong",
      commit: "0aa1234",
      entryType: "rest",
      method: "GET",
      path: "/items/{id}",
      cite: cite("src/main/java/forge/wrong/Items.java", 12, "/items/{id}"),
    }),
  ];
  const repos: JoinRepo[] = [
    { repo: "forge-caller", facts: caller },
    { repo: "forge-svc", facts: callee, hosts: [`svc.forge.example${port}`] },
    { repo: "forge-wrong", facts: decoy, hosts: ["wrong.forge.example"] },
  ];
  return { repos, label: `${host} set as ${set ? `${inSetting}=${hostValue}` : "nothing"}` };
}

describe("a placeholder host through the join, on generated spellings", () => {
  it("joins the repo on the host the setting gives (any relaxed spelling), else on the default", () => {
    for (const seed of SEEDS) {
      const { repos, label } = estateFor(rng(seed));
      const out = joinFacts({ repos });
      expect(
        out.joins.map((j) => `${j.call.fact} -> ${j.entry.repo}`),
        `seed ${seed}: ${label}`,
      ).toEqual(["call.get.items-id -> forge-svc"]);
    }
  });
});
