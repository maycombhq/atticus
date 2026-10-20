import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { CatalogRecord } from "@maycombhq/core";
import { fsRepo, memoryRepo, scanRepo, type Extractor, type ScanContext } from "@maycombhq/sdk";
import {
  dropUnknown,
  Evaluator,
  Output,
  parseTemplate,
  TemplateUnreadable,
  UNKNOWN,
} from "../src/platform/gotemplate.js";
import { mergeValues, renderCharts, valuesEnv } from "../src/platform/helm.js";
import { applyJson6902, buildKustomizations, smp } from "../src/platform/kustomize.js";
import { loadManifests } from "../src/platform/manifests.js";
import { openshiftExtractor } from "../src/platform/openshift.js";
import { ingressExtractor } from "../src/vocab/ingress.js";

/**
 * Helm charts and Kustomize overlays read without running either tool (ADR 0064): golden
 * records over two invented repos, and the template reader, values layering, strategic merge
 * and JSON 6902 patches on their own.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures/platform");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const AT = "2026-10-18T08:00:00Z";

type Rec = Record<string, unknown> & { kind: string; id?: string };

function strip(r: CatalogRecord): Rec {
  const out = { ...(r as unknown as Rec) };
  out.evidence = r.evidence.map((e) => {
    const { commit: _c, scannedAt: _s, extractor: _x, ...rest } = e;
    return rest;
  });
  return out;
}

const sortKey = (r: Rec) => `${r.kind}|${r.id ?? ""}`;
const byWarning = (a: { path: string; message: string }, b: { path: string; message: string }) =>
  `${a.path}${a.message}`.localeCompare(`${b.path}${b.message}`);

async function golden(name: string, extractor: Extractor, repoName: string, expectedFile: string) {
  const s = await scanRepo({
    repo: fsRepo(repoName, join(FIXTURES, name, "repo"), SHA),
    extractors: [extractor],
    scannedAt: AT,
    repoInfo: { repoType: "infra" },
  });
  expect(s.rejected).toEqual([]);
  expect(s.runs.map((r) => r.status)).toEqual(["ran"]);
  const want = parse(readFileSync(join(FIXTURES, name, expectedFile), "utf8")) as {
    records: Rec[];
    warnings: { path: string; message: string }[];
  };
  const got = s.records.map(strip);
  const expected = want.records.map((r) => ({ schemaVersion: 2, status: "current", ...r }));
  expect(got.map(sortKey).sort()).toEqual(expected.map(sortKey).sort());
  for (const e of expected)
    expect(
      got.find((x) => sortKey(x) === sortKey(e)),
      sortKey(e),
    ).toEqual(e);
  expect(s.warnings.map(({ path, message }) => ({ path: path!, message })).sort(byWarning)).toEqual(
    [...want.warnings].sort(byWarning),
  );
  return s.records;
}

// ------------------------------------------------------------------ golden

describe("helm: golden", () => {
  it("openshift reads Deployments, autoscaling, images and env vars per values file", async () => {
    await golden("helm", openshiftExtractor, "forge-storefront-deploy", "expected.yaml");
  });
  it("ingress reads the Ingress hosts per values file", async () => {
    await golden("helm", ingressExtractor, "forge-storefront-deploy", "expected-ingress.yaml");
  });
});

describe("kustomize: golden", () => {
  it("openshift reads each overlay's Deployment, autoscaling, policies, images and env vars", async () => {
    await golden("kustomize", openshiftExtractor, "tide-ledger-deploy", "expected.yaml");
  });
  it("ingress reads each overlay's hosts, following renames and patches", async () => {
    await golden("kustomize", ingressExtractor, "tide-ledger-deploy", "expected-ingress.yaml");
  });
});

// ------------------------------------------------------------------ the template reader

/** Render one template over values the way a chart named `forge-api` would. */
function render(src: string, values: Record<string, unknown> = {}, helpers = ""): string {
  const tpl = parseTemplate(src);
  const defines = new Map([...parseTemplate(helpers).defines, ...tpl.defines]);
  const out = new Output();
  new Evaluator({ defines }).render(
    tpl.nodes,
    {
      Values: values,
      Release: { Name: "forge-api", Namespace: UNKNOWN, Service: "Helm" },
      Chart: { Name: "forge-api", Version: "0.1.0", AppVersion: "3.2.0" },
      Capabilities: UNKNOWN,
      Files: UNKNOWN,
    },
    out,
  );
  return out.text();
}

const rendered = (src: string, values?: Record<string, unknown>, helpers?: string) =>
  dropUnknown(parse(render(src, values, helpers))) as Record<string, unknown>;

describe("go templates: the forms that are read", () => {
  it("fills .Values, .Release.Name and .Chart fields, default and quote", () => {
    expect(
      rendered(
        [
          "name: {{ .Release.Name }}-{{ .Chart.Name }}",
          "replicas: {{ .Values.replicas }}",
          'image: "{{ .Values.image.repo }}:{{ .Values.image.tag | default .Chart.AppVersion }}"',
          'tier: {{ .Values.tier | default "web" | quote }}',
          "debug: {{ .Values.debug }}",
        ].join("\n"),
        { replicas: 2, image: { repo: "registry.forge.example/api", tag: "" }, debug: false },
      ),
    ).toEqual({
      name: "forge-api-forge-api",
      replicas: 2,
      image: "registry.forge.example/api:3.2.0",
      tier: "web",
      debug: false,
    });
  });

  it("reads the standard fullname helper, with and without an override", () => {
    const helpers = readFileSync(
      join(FIXTURES, "helm/repo/deploy/storefront/templates/_helpers.tpl"),
      "utf8",
    ).replace(/storefront\./g, "chart.");
    expect(rendered('name: {{ include "chart.fullname" . }}', {}, helpers)).toEqual({
      name: "forge-api",
    });
    expect(
      rendered('name: {{ include "chart.fullname" . }}', { fullnameOverride: "ledger" }, helpers),
    ).toEqual({ name: "ledger" });
    expect(
      rendered('name: {{ include "chart.fullname" . }}', { nameOverride: "web" }, helpers),
    ).toEqual({ name: "forge-api-web" });
    expect(
      rendered('labels:\n  {{- include "chart.selectorLabels" . | nindent 2 }}', {}, helpers),
    ).toEqual({
      labels: { "app.kubernetes.io/name": "forge-api", "app.kubernetes.io/instance": "forge-api" },
    });
  });

  it("evaluates if/else if/else, with, range over lists and maps, and variables", () => {
    const src = [
      "{{- if .Values.a }}",
      "mode: a",
      "{{- else if .Values.b }}",
      "mode: b",
      "{{- else }}",
      "mode: none",
      "{{- end }}",
      "{{- with .Values.svc }}",
      "port: {{ .port }}",
      "{{- end }}",
      "{{- $root := . }}",
      "hosts:",
      "{{- range .Values.hosts }}",
      "  - {{ . }}.{{ $root.Values.domain }}",
      "{{- end }}",
      "env:",
      "{{- range $k, $v := .Values.env }}",
      "  {{ $k }}: {{ $v | quote }}",
      "{{- end }}",
    ].join("\n");
    expect(
      rendered(src, {
        b: true,
        svc: { port: 8080 },
        hosts: ["shop", "api"],
        domain: "forge.example",
        env: { Z_LAST: 1, A_FIRST: "x" },
      }),
    ).toEqual({
      mode: "b",
      port: 8080,
      hosts: ["shop.forge.example", "api.forge.example"],
      env: { A_FIRST: "x", Z_LAST: "1" },
    });
  });

  it("toYaml with nindent, printf, trunc and trimSuffix", () => {
    expect(
      rendered(
        [
          "resources:",
          "  {{- toYaml .Values.resources | nindent 2 }}",
          'name: {{ printf "%s-%s" .Release.Name "worker-pool-with-a-long-name" | trunc 20 | trimSuffix "-" }}',
        ].join("\n"),
        { resources: { limits: { cpu: "500m", memory: "1Gi" } } },
      ),
    ).toEqual({
      resources: { limits: { cpu: "500m", memory: "1Gi" } },
      name: "forge-api-worker-poo",
    });
  });

  it("maps every rendered line back to its template line, through trimming", () => {
    const src = "{{- if .Values.on }}\nkind: Deployment\n{{- end }}\nname: x\n";
    const tpl = parseTemplate(src);
    const out = new Output();
    new Evaluator({ defines: tpl.defines }).render(tpl.nodes, { Values: { on: true } }, out);
    expect(out.text()).toBe("\nkind: Deployment\nname: x\n");
    expect(out.lines(src)).toEqual([1, 2, 4]);
  });
});

describe("go templates: anything else is unknown, never guessed", () => {
  const unknownForms = [
    ["tpl", "{{ tpl .Values.t . }}"],
    ["lookup", '{{ (lookup "v1" "Secret" "forge" "db").data.password }}'],
    [".Files", '{{ .Files.Get "config.ini" }}'],
    [".Capabilities", "{{ .Capabilities.KubeVersion.Version }}"],
    [".Release.Namespace", "{{ .Release.Namespace }}"],
    ["an unknown function", "{{ randAlphaNum 8 }}"],
    ["sha256sum", '{{ include "x" . | sha256sum }}'],
    ["a key of a missing map", "{{ .Values.missing.key }}"],
    ["a number in exponent form", "{{ .Values.big }}"],
    ["a map printed as text", "{{ .Values.map }}"],
  ] as const;
  for (const [what, form] of unknownForms)
    it(`leaves out a value from ${what}`, () => {
      let value: unknown;
      try {
        value = rendered(`known: yes\nfield: ${form}\nquoted: "prefix-${form}"`, {
          t: "x",
          big: 2000000,
          map: { a: 1 },
        });
      } catch (e) {
        // A form the parser itself doesn't read makes the template unreadable: also not a guess.
        expect(e).toBeInstanceOf(TemplateUnreadable);
        return;
      }
      expect(value).toEqual({ known: "yes" });
    });

  it("makes a template unreadable when a condition or range depends on an unknown value", () => {
    expect(() => render('{{ if .Capabilities.APIVersions.Has "x/v1" }}a: 1{{ end }}')).toThrow(
      TemplateUnreadable,
    );
    expect(() => render("{{ range tpl .Values.t . }}- x{{ end }}", { t: "y" })).toThrow(
      TemplateUnreadable,
    );
    expect(() => render('{{ if eq .Release.Namespace "prod" }}a: 1{{ end }}')).toThrow(
      TemplateUnreadable,
    );
  });

  it("reports syntax it doesn't know instead of reading around it", () => {
    expect(() => parseTemplate("{{ range .x }}{{ break }}{{ end }}")).toThrow(TemplateUnreadable);
    expect(() => parseTemplate("{{ if .x }}a")).toThrow(TemplateUnreadable);
    expect(() => parseTemplate("{{ .x ")).toThrow(TemplateUnreadable);
  });
});

// ------------------------------------------------------------------ charts and values

describe("helm charts", () => {
  it("knows the usual names of environment values files", () => {
    expect(valuesEnv("values-prod.yaml")).toBe("prod");
    expect(valuesEnv("values.uat.yml")).toBe("uat");
    expect(valuesEnv("values_dev.yaml")).toBe("dev");
    expect(valuesEnv("environments/sit/values.yaml")).toBe("sit");
    expect(valuesEnv("envs/perf.yaml")).toBe("perf");
    expect(valuesEnv("values/staging.yaml")).toBe("staging");
    expect(valuesEnv("values.yaml")).toBeUndefined();
    expect(valuesEnv("ci/lint-values.yaml")).toBeUndefined();
  });

  it("layers values: maps merge, lists are replaced, null removes a key", () => {
    expect(
      mergeValues(
        { a: { b: 1, c: 2 }, list: [1, 2], gone: "x" },
        { a: { c: 3 }, list: [9], gone: null },
      ),
    ).toEqual({ a: { b: 1, c: 3 }, list: [9] });
  });

  it("renders a chart with no environment files once, and reads environments/<env>/values.yaml", async () => {
    const chart = (dir: string) => ({
      [`${dir}/Chart.yaml`]: "apiVersion: v2\nname: harbor-ui\nversion: 0.1.0\n",
      [`${dir}/values.yaml`]: "replicas: 1\n",
      [`${dir}/templates/deployment.yaml`]: [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: {{ .Chart.Name }}",
        "spec:",
        "  replicas: {{ .Values.replicas }}",
        "",
      ].join("\n"),
    });
    const files: Record<string, string> = {
      ...chart("plain"),
      ...chart("layered"),
      "layered/environments/sit/values.yaml": "replicas: 5\n",
    };
    const res = await renderCharts(Object.keys(files).sort(), async (p) => files[p]);
    expect(res.warnings).toEqual([]);
    expect(
      res.rendered.map((r) => ({
        file: r.file,
        env: r.env,
        replicas: parse(r.text).spec.replicas,
      })),
    ).toEqual([
      { file: "layered/templates/deployment.yaml", env: "sit", replicas: 5 },
      { file: "plain/templates/deployment.yaml", env: undefined, replicas: 1 },
    ]);
    // The value read came from the environment's file, which overrides values.yaml.
    expect(res.rendered[0]!.sources).toEqual([
      { file: "layered/environments/sit/values.yaml", line: 1 },
    ]);
  });

  it("gives an aliased subchart its values under the alias, and skips one whose condition is false", async () => {
    const files: Record<string, string> = {
      "Chart.yaml": [
        "apiVersion: v2",
        "name: harbor",
        "version: 1.0.0",
        "dependencies:",
        "  - { name: worker, alias: billing-worker, condition: billing-worker.enabled }",
        "  - { name: worker, alias: audit-worker, condition: audit-worker.enabled }",
        "  - { name: worker, alias: fraud-worker, condition: fraud-worker.enabled }",
        "",
      ].join("\n"),
      "values.yaml": [
        "billing-worker: { enabled: true, queue: billing }",
        "audit-worker: { enabled: true, queue: audit }",
        "fraud-worker: { enabled: false, queue: fraud }",
        "",
      ].join("\n"),
      "charts/worker/Chart.yaml": "apiVersion: v2\nname: worker\nversion: 0.2.0\n",
      "charts/worker/values.yaml": "queue: default\n",
      "charts/worker/templates/job.yaml":
        "kind: Deployment\nmetadata:\n  name: {{ .Release.Name }}-{{ .Chart.Name }}\nqueue: {{ .Values.queue }}\n",
    };
    const res = await renderCharts(Object.keys(files).sort(), async (p) => files[p]);
    expect(res.rendered.map((r) => parse(r.text))).toEqual([
      { kind: "Deployment", metadata: { name: "harbor-billing-worker" }, queue: "billing" },
      { kind: "Deployment", metadata: { name: "harbor-audit-worker" }, queue: "audit" },
    ]);
  });

  it("leaves chart templates out of plain reads: only readers that ask get rendered objects", async () => {
    const repo = fsRepo("forge-storefront-deploy", join(FIXTURES, "helm/repo"), SHA);
    const ctx: ScanContext = { dialects: [], scannedAt: AT, warn: () => {} };
    const plain = await loadManifests(repo, ctx, /kind/);
    expect(plain.objects).toEqual([]);
    const built = await loadManifests(repo, ctx, /kind/, undefined, { rendered: true });
    expect(built.objects.map((o) => `${o.env}:${o.kind}/${o.name}`).sort()).toEqual([
      "prod:Deployment/storefront",
      "prod:Deployment/storefront-cart",
      "prod:HorizontalPodAutoscaler/storefront",
      "prod:Ingress/storefront",
      "prod:Service/storefront",
      "uat:Deployment/storefront",
      "uat:Ingress/storefront",
      "uat:Service/storefront",
    ]);
  });
});

// ------------------------------------------------------------------ kustomize

describe("kustomize", () => {
  it("strategic merge: lists of containers and env vars merge by name, $patch: delete removes", () => {
    const target = {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "app",
                image: "a:1",
                env: [
                  { name: "A", value: "1" },
                  { name: "B", value: "2" },
                ],
              },
              { name: "sidecar", image: "s:1" },
            ],
          },
        },
      },
    };
    const patch = {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "app",
                env: [
                  { name: "B", value: "3" },
                  { name: "C", value: "4" },
                ],
              },
              { name: "sidecar", $patch: "delete" },
            ],
          },
        },
      },
    };
    expect(smp(target, patch, [])).toEqual({
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "app",
                image: "a:1",
                env: [
                  { name: "A", value: "1" },
                  { name: "B", value: "3" },
                  { name: "C", value: "4" },
                ],
              },
            ],
          },
        },
      },
    });
  });

  it("JSON 6902: add, replace, remove, and a clear message for a path that isn't there", () => {
    const obj = { spec: { rules: [{ host: "a" }], tls: [] as unknown[] } };
    expect(
      applyJson6902(obj, [
        { op: "replace", path: "/spec/rules/0/host", value: "b" },
        { op: "add", path: "/spec/rules/-", value: { host: "c" } },
        { op: "remove", path: "/spec/tls" },
      ]),
    ).toEqual({ spec: { rules: [{ host: "b" }, { host: "c" }] } });
    expect(applyJson6902(obj, [{ op: "replace", path: "/spec/missing/x", value: 1 }])).toBe(
      "/spec/missing/x does not exist",
    );
    expect(obj.spec.rules[0]!.host).toBe("a"); // the input is left alone
  });

  it("nameSuffix, labels with selectors, and a warning for a patch that matches nothing", async () => {
    const files: Record<string, string> = {
      "k/kustomization.yaml": [
        "resources: [svc.yaml]",
        "nameSuffix: -blue",
        "labels:",
        "  - pairs: { team: payments }",
        "    includeSelectors: true",
        "patches:",
        "  - patch: |-",
        "      kind: Service",
        "      metadata: { name: nothing-here }",
        "",
      ].join("\n"),
      "k/svc.yaml":
        "apiVersion: v1\nkind: Service\nmetadata:\n  name: harbor-api\nspec:\n  selector: { app: harbor-api }\n",
    };
    const res = await buildKustomizations(Object.keys(files), async (p) => files[p]);
    expect(res.overlays).toHaveLength(1);
    expect(res.overlays[0]!.objects.map((o) => o.obj)).toEqual([
      {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: "harbor-api-blue", labels: { team: "payments" } },
        spec: { selector: { app: "harbor-api", team: "payments" } },
      },
    ]);
    expect(res.warnings).toEqual([
      {
        path: "k/kustomization.yaml",
        message: "Patch k/kustomization.yaml (inline patch) matches no object; not applied.",
      },
    ]);
    expect([...res.consumed]).toEqual(["k/svc.yaml"]);
  });

  it("builds only kustomizations no other one uses, and never fetches a remote base", async () => {
    const files: Record<string, string> = {
      "base/kustomization.yaml": "resources: [cm.yaml]\n",
      "base/cm.yaml":
        "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: harbor }\ndata: { a: '1' }\n",
      "overlays/sit/kustomization.yaml":
        "resources:\n  - ../../base\n  - github.com/forge-example/platform//base?ref=v1\n",
    };
    const res = await buildKustomizations(Object.keys(files), async (p) => files[p]);
    expect(res.overlays.map((o) => [o.file, o.env, o.objects.length])).toEqual([
      ["overlays/sit/kustomization.yaml", "sit", 1],
    ]);
    expect(res.warnings.map((w) => w.message)).toEqual([
      "Remote base github.com/forge-example/platform//base?ref=v1 is not fetched; its objects are not read.",
    ]);
  });

  it("is read by plain-manifest readers as before when they don't ask for builds", async () => {
    const repo = memoryRepo("r", SHA, {
      "k/kustomization.yaml": "resources: [d.yaml]\nnamePrefix: x-\n",
      "k/d.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: harbor }\n",
    });
    const ctx: ScanContext = { dialects: [], scannedAt: AT, warn: () => {} };
    expect((await loadManifests(repo, ctx, /kind/)).objects.map((o) => o.name)).toEqual(["harbor"]);
    expect(
      (await loadManifests(repo, ctx, /kind/, undefined, { rendered: true })).objects.map(
        (o) => o.name,
      ),
    ).toEqual(["x-harbor"]);
  });
});
