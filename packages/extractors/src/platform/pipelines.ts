import type { CatalogRecord, FrameworkModel } from "@maycombhq/core";
import {
  defineExtractor,
  type ParseCache,
  type RepoHandle,
  type ScanContext,
} from "@maycombhq/sdk";
import { componentOf, type Ev } from "../facts.js";
import { MALFORMED_YAML, readYamlDocs, type PathSeg, type YamlDoc } from "./manifests.js";
import { arr, at, dirOf, ev, isEnvWord, isObj, readOrWarn, slug, str, type Obj } from "./util.js";
import { groovyCalls } from "../lang/groovy.js";
import { addEntry, templateMatches } from "../pipeline-models.js";

/**
 * CI/CD pipelines: Azure Pipelines (with local templates expanded), GitHub Actions
 * workflows, GitLab CI (with local includes) and Jenkins declarative pipelines. Each becomes
 * a QualityAsset `pipeline` with its stages, triggers, environments, deploy targets and the
 * test steps found; published test results and coverage become `test-suite` and
 * `coverage-report` assets of the same pipeline. Evidence source `pipeline`.
 *
 * Words are normalised across tools so pipelines compare: triggers are push, pull-request,
 * manual, tag, release, "schedule <cron>", "pipeline <name>"; deploy targets are kubernetes,
 * openshift, helm, cloud-run, app-engine, terraform, azure-web-app and azure-functions.
 */

const AZURE = [
  "**/azure-pipelines*.yml",
  "**/azure-pipelines*.yaml",
  "**/.azure-pipelines/**/*.yml",
  "**/.azure-pipelines/**/*.yaml",
  "**/.azuredevops/**/*.yml",
  "**/.azuredevops/**/*.yaml",
];
const GITHUB = ["**/.github/workflows/*.yml", "**/.github/workflows/*.yaml"];
const GITLAB = ["**/.gitlab-ci.yml", "**/.gitlab-ci.yaml"];
const JENKINS = ["**/Jenkinsfile", "**/Jenkinsfile.*", "**/*.jenkinsfile", "**/*.Jenkinsfile"];

interface Report {
  files: string[];
  format?: string;
  tool?: string;
  path: string;
  line?: number;
}

/** What one pipeline says, gathered across its files. */
class Facts {
  stages: string[] = [];
  jobs: string[] = [];
  triggers: string[] = [];
  environments: string[] = [];
  deployTargets: string[] = [];
  testSteps: string[] = [];
  templates: string[] = [];
  files: string[] = [];
  /** Model entries a pipeline's library steps matched (ADR 0062), as details.modelled. */
  modelled: string[] = [];
  /** Actions a GitHub step uses: kept as templates when a pipeline model names them (ADR 0062). */
  actions: string[] = [];
  tests: Report[] = [];
  coverage: Report[] = [];

  add(list: string[], v: string | undefined) {
    const s = v?.trim();
    if (s && !list.includes(s)) list.push(s);
  }

  /** Look at one step: its label (name, else the command) and the text to match on. */
  step(label: string | undefined, text: string) {
    for (const [re, target] of DEPLOY) if (re.test(text)) this.add(this.deployTargets, target);
    if (TEST.some((re) => re.test(text))) this.add(this.testSteps, label ?? firstLine(text));
  }
}

const firstLine = (s: string) => s.trim().split(/\r?\n/)[0]!.trim();

const DEPLOY: [RegExp, string][] = [
  [
    /\bKubernetesManifest@\d|\bKubernetes@\d|\bkubectl\s+(apply|create|replace|rollout|set\s+image)\b|azure\/k8s-deploy/i,
    "kubernetes",
  ],
  [
    /\boc\s+(apply|create|replace|rollout|new-app|process|start-build|set\s+image)\b|\bOpenShift\w*@\d|redhat-actions\/oc-/i,
    "openshift",
  ],
  [/\bHelmDeploy@\d|\bhelm\s+(upgrade|install)\b/i, "helm"],
  [/\bgcloud\s+run\s+deploy\b|deploy-cloudrun/i, "cloud-run"],
  [/\bgcloud\s+app\s+deploy\b|deploy-appengine/i, "app-engine"],
  [/\bterraform\s+apply\b|\bTerraform\w*@\d[^\n]*\bcommand=apply\b/i, "terraform"],
  [/\bAzureWebApp@\d|\bAzureRmWebAppDeployment@\d|azure\/webapps-deploy/i, "azure-web-app"],
  [/\bAzureFunctionApp@\d|azure\/functions-action/i, "azure-functions"],
];

const TEST: RegExp[] = [
  /\b(mvn|mvnw)\b[^\n]*\b(test|verify)\b/i,
  /\b(gradle|gradlew)\b[^\n]*\b(test|check)\b/i,
  /\b(npm|pnpm|yarn)\s+(run\s+)?test\b/i,
  /\b(pytest|tox|phpunit)\b/i,
  /\b(go|cargo|dotnet)\s+test\b/i,
  /\b(jest|vitest|mocha|karma)\b/i,
  /\bMaven@\d[^\n]*\bgoals=[^\n]*\b(test|verify)\b/i,
  /\bGradle@\d[^\n]*\btasks=[^\n]*\b(test|check)\b/i,
  /\bDotNetCoreCLI@\d[^\n]*\bcommand=test\b/i,
  /\bVSTest@\d/i,
];

/** Pipeline ids: the path without .github/workflows/, extension and leading dots, slugged. */
function pipelineSlug(path: string): string {
  const p = path
    .replace(/(^|\/)\.github\/workflows\//, "$1")
    .replace(/\.(ya?ml)$/i, "")
    .split("/")
    .map((s) => s.replace(/^\.+/, ""))
    .join("-");
  return slug(p);
}

const baseName = (path: string) =>
  (path.split("/").pop() ?? path).replace(/\.(ya?ml)$/i, "").replace(/^\.+/, "");

const lines = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v])
    .map((x) => str(x))
    .filter((x): x is string => !!x)
    .flatMap((x) => x.split(/[\n,]/))
    .map((x) => x.trim())
    .filter(Boolean);

export const pipelinesExtractor = defineExtractor({
  id: "pipelines",
  version: "0.1.0",
  claims: [...AZURE, ...GITHUB, ...GITLAB, ...JENKINS],
  async *scan(repo, ctx) {
    const component = componentOf(repo, ctx);
    const models = ctx.frameworks ?? [];
    const uses = models.flatMap((m) => m.pipeline.flatMap((e) => (e.uses ? [e.uses] : [])));
    const emit = (tool: string, path: string, name: string, f: Facts) => {
      // An action a pipeline model names is a template of the pipeline, like a reusable workflow.
      for (const a of f.actions) if (uses.some((u) => templateMatches(a, u))) f.add(f.templates, a);
      return records(repo, component, tool, path, name, f);
    };

    // ---- Azure Pipelines: a file another one uses as a template isn't a pipeline itself.
    const azure: { path: string; doc: YamlDoc }[] = [];
    for await (const path of repo.listFiles(AZURE)) {
      const doc = await readDoc(repo, ctx, path);
      if (doc && isObj(doc.value)) azure.push({ path, doc });
    }
    const used = new Set<string>();
    for (const a of azure)
      for (const t of templateRefs(a.doc.value)) used.add(templatePath(a.path, t));
    for (const a of azure) {
      if (used.has(a.path)) continue;
      const v = a.doc.value as Obj;
      if (!("stages" in v || "jobs" in v || "steps" in v)) continue;
      const f = new Facts();
      await azurePipeline(repo, ctx, a.path, a.doc, f);
      yield* emit("azure-pipelines", a.path, baseName(a.path), f);
    }

    // ---- GitHub Actions
    for await (const path of repo.listFiles(GITHUB)) {
      const doc = await readDoc(repo, ctx, path);
      const v = doc?.value;
      if (!doc || !isObj(v) || !isObj(v.jobs)) continue;
      const f = githubWorkflow(path, doc);
      yield* emit("github-actions", path, str(v.name) ?? baseName(path), f);
    }

    // ---- GitLab CI
    for await (const path of repo.listFiles(GITLAB)) {
      const doc = await readDoc(repo, ctx, path);
      if (!doc || !isObj(doc.value)) continue;
      const f = await gitlabPipeline(repo, ctx, path, doc);
      yield* emit("gitlab-ci", path, baseName(path), f);
    }

    // ---- Jenkins
    for await (const path of repo.listFiles(JENKINS)) {
      const text = await readOrWarn(repo, ctx, path);
      if (text === undefined) continue;
      const f = await jenkinsPipeline(path, text, models, repo.parseCache);
      if (f) yield* emit("jenkins", path, path.split("/").pop() ?? path, f);
    }
  },
});

async function readDoc(
  repo: RepoHandle,
  ctx: ScanContext,
  path: string,
): Promise<YamlDoc | undefined> {
  const text = await readOrWarn(repo, ctx, path);
  if (text === undefined) return undefined;
  const docs = readYamlDocs(text, { cache: repo.parseCache, path });
  if (!docs) {
    ctx.warn(MALFORMED_YAML, path);
    return undefined;
  }
  return docs[0];
}

function* records(
  repo: RepoHandle,
  component: string,
  tool: string,
  path: string,
  name: string,
  f: Facts,
): Generator<CatalogRecord> {
  const s = pipelineSlug(path);
  const pipelineId = `${component}.pipeline.${s}`;
  const base = (id: string, assetKind: string, details: Obj, evidence: Ev[]) =>
    ({
      schemaVersion: 1,
      kind: "QualityAsset",
      id,
      status: "current",
      confidence: "verified",
      component,
      assetKind,
      details,
      evidence,
    }) as unknown as CatalogRecord;
  yield base(
    pipelineId,
    "pipeline",
    {
      tool,
      name,
      stages: f.stages.length > 0 ? f.stages : f.jobs,
      triggers: f.triggers,
      environments: f.environments,
      deployTargets: f.deployTargets,
      testSteps: f.testSteps,
      ...(f.templates.length > 0 ? { templates: f.templates } : {}),
      ...(f.modelled.length > 0 ? { modelled: f.modelled } : {}),
    },
    [path, ...f.files.filter((x) => x !== path)].map((p) => ev(repo, "pipeline", p)),
  );
  const report = (kind: string, list: Report[]) => {
    if (list.length === 0) return undefined;
    const files: string[] = [];
    for (const r of list) for (const x of r.files) if (!files.includes(x)) files.push(x);
    const format = list.find((r) => r.format)?.format;
    const tool = list.find((r) => r.tool)?.tool;
    return base(
      `${component}.${kind}.${s}`,
      kind,
      { pipeline: pipelineId, files, ...(format ? { format } : {}), ...(tool ? { tool } : {}) },
      list.map((r) => ev(repo, "pipeline", r.path, r.line)),
    );
  };
  const t = report("test-suite", f.tests);
  if (t) yield t;
  const c = report("coverage-report", f.coverage);
  if (c) yield c;
}

// ------------------------------------------------------------------ Azure Pipelines

/** Template references in a document (any `template:` value), for telling templates from pipelines. */
function templateRefs(v: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (isObj(x)) {
      const t = str(x.template);
      if (t && !t.includes("@")) out.push(t);
      Object.values(x).forEach(walk);
    }
  };
  walk(v);
  return out;
}

/** Azure template paths are relative to the file that uses them; a leading slash means the repo root. */
const templatePath = (from: string, ref: string) => {
  if (ref.startsWith("/")) return ref.slice(1);
  const parts = [...(dirOf(from) ? dirOf(from).split("/") : []), ...ref.split("/")];
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
};

interface AzCtx {
  repo: RepoHandle;
  ctx: ScanContext;
  file: string;
  doc: YamlDoc;
  params: Map<string, unknown>;
  depth: number;
  stack: string[];
}

const PARAM_REF = /\$\{\{\s*parameters\.([\w-]+)\s*\}\}/g;

function substitute(v: unknown, params: Map<string, unknown>): unknown {
  if (typeof v === "string") {
    const whole = /^\$\{\{\s*parameters\.([\w-]+)\s*\}\}$/.exec(v);
    if (whole && params.has(whole[1]!)) return params.get(whole[1]!);
    return v.replace(PARAM_REF, (m, k: string) => {
      const p = params.get(k);
      return str(p) ?? m;
    });
  }
  if (Array.isArray(v)) return v.map((x) => substitute(x, params));
  if (isObj(v))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, params)]));
  return v;
}

/** Declared parameters with their defaults: a list of { name, default } or a map of name: default. */
function declaredParams(v: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const p = at(v, "parameters");
  if (Array.isArray(p)) {
    for (const x of p) {
      const name = str(at(x, "name"));
      if (name && at(x, "default") !== undefined) out.set(name, at(x, "default"));
    }
  } else if (isObj(p)) for (const [k, x] of Object.entries(p)) if (!isObj(x)) out.set(k, x);
  return out;
}

async function azurePipeline(
  repo: RepoHandle,
  ctx: ScanContext,
  path: string,
  doc: YamlDoc,
  f: Facts,
) {
  const params = declaredParams(doc.value);
  const v = substitute(doc.value, params) as Obj;
  f.add(f.files, path);
  // Triggers: CI runs on push unless `trigger: none`; PR only when `pr` is given.
  if (!("trigger" in v) || str(v.trigger) !== "none") f.add(f.triggers, "push");
  if ("pr" in v && str(v.pr) !== "none") f.add(f.triggers, "pull-request");
  for (const s of arr(v.schedules))
    f.add(f.triggers, str(at(s, "cron")) && `schedule ${str(at(s, "cron"))}`);
  for (const p of arr(at(v, "resources", "pipelines")))
    if (at(p, "trigger") !== undefined)
      f.add(f.triggers, `pipeline ${str(at(p, "source")) ?? str(at(p, "pipeline"))}`);
  const c: AzCtx = { repo, ctx, file: path, doc, params, depth: 0, stack: [path] };
  await azureSection(v, [], c, f);
}

/** Walk the stages, jobs or steps at the top of a pipeline or template. */
async function azureSection(v: Obj, base: PathSeg[], c: AzCtx, f: Facts) {
  if (Array.isArray(v.stages)) await azureList("stages", v.stages, [...base, "stages"], c, f);
  else if (Array.isArray(v.jobs)) await azureList("jobs", v.jobs, [...base, "jobs"], c, f);
  else if (Array.isArray(v.steps)) await azureList("steps", v.steps, [...base, "steps"], c, f);
}

async function azureList(
  level: "stages" | "jobs" | "steps",
  list: unknown[],
  base: PathSeg[],
  c: AzCtx,
  f: Facts,
) {
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!isObj(item)) continue;
    const here = [...base, i];
    const tpl = str(item.template);
    if (tpl) {
      await azureTemplate(tpl, item.parameters, c, f);
      continue;
    }
    if (level === "stages") {
      f.add(f.stages, str(item.stage));
      if (Array.isArray(item.jobs)) await azureList("jobs", item.jobs, [...here, "jobs"], c, f);
    } else if (level === "jobs") {
      f.add(f.jobs, str(item.job) ?? str(item.deployment));
      const envName = str(item.environment) ?? str(at(item, "environment", "name"));
      if (item.deployment !== undefined) f.add(f.environments, envName);
      if (Array.isArray(item.steps)) await azureList("steps", item.steps, [...here, "steps"], c, f);
      for (const strategy of ["runOnce", "rolling", "canary"]) {
        const steps = at(item, "strategy", strategy, "deploy", "steps");
        if (Array.isArray(steps))
          await azureList("steps", steps, [...here, "strategy", strategy, "deploy", "steps"], c, f);
      }
    } else azureStep(item, here, c, f);
  }
}

function azureStep(step: Obj, path: PathSeg[], c: AzCtx, f: Facts) {
  const task = str(step.task);
  const inputs = isObj(step.inputs) ? step.inputs : {};
  const script = ["script", "bash", "powershell", "pwsh"].map((k) => str(step[k])).find(Boolean);
  const text = [
    task ?? "",
    ...Object.entries(inputs).map(([k, x]) => `${k}=${str(x) ?? ""}`),
    script ?? "",
  ].join(" ");
  const label = str(step.displayName) ?? str(step.name) ?? (script ? firstLine(script) : task);
  f.step(label, text);
  const line = c.doc.line(path);
  if (task && /^PublishTestResults@/i.test(task)) {
    const format = str(inputs.testResultsFormat);
    f.tests.push({
      files: lines(inputs.testResultsFiles ?? "**/TEST-*.xml"),
      ...(format ? { format } : {}),
      path: c.file,
      ...(line ? { line } : {}),
    });
  }
  if (task && /^PublishCodeCoverageResults@/i.test(task)) {
    const tool = str(inputs.codeCoverageTool);
    f.coverage.push({
      files: lines(inputs.summaryFileLocation),
      ...(tool ? { tool } : {}),
      path: c.file,
      ...(line ? { line } : {}),
    });
  }
}

async function azureTemplate(ref: string, passed: unknown, c: AzCtx, f: Facts) {
  if (ref.includes("@")) {
    f.add(f.templates, ref); // in another repository: can't be read from here
    return;
  }
  const path = templatePath(c.file, ref);
  if (c.depth >= 10 || c.stack.includes(path)) return;
  let text: string;
  try {
    text = await c.repo.readText(path);
  } catch {
    c.ctx.warn(`Template ${ref} was not found; skipped it.`, c.file);
    return;
  }
  const doc = readYamlDocs(text, { cache: c.repo.parseCache, path })?.[0];
  if (!doc || !isObj(doc.value)) {
    c.ctx.warn(MALFORMED_YAML, path);
    return;
  }
  const params = declaredParams(doc.value);
  if (isObj(passed))
    for (const [k, x] of Object.entries(passed)) params.set(k, substitute(x, c.params));
  const v = substitute(doc.value, params) as Obj;
  f.add(f.files, path);
  await azureSection(
    v,
    [],
    { ...c, file: path, doc, params, depth: c.depth + 1, stack: [...c.stack, path] },
    f,
  );
}

// ------------------------------------------------------------------ GitHub Actions

const GH_EVENTS: Record<string, string> = {
  push: "push",
  pull_request: "pull-request",
  pull_request_target: "pull-request",
  workflow_dispatch: "manual",
  release: "release",
  workflow_call: "called",
};

function githubWorkflow(path: string, doc: YamlDoc): Facts {
  const f = new Facts();
  const v = doc.value as Obj;
  const on = v.on;
  const events: [string, unknown][] =
    typeof on === "string"
      ? [[on, undefined]]
      : Array.isArray(on)
        ? on.map((e) => [str(e) ?? "", undefined])
        : isObj(on)
          ? Object.entries(on)
          : [];
  for (const [e, cfg] of events) {
    if (e === "schedule")
      for (const s of arr(cfg))
        f.add(f.triggers, str(at(s, "cron")) && `schedule ${str(at(s, "cron"))}`);
    else if (e === "workflow_run")
      for (const w of arr(at(cfg, "workflows"))) f.add(f.triggers, `pipeline ${str(w)}`);
    else f.add(f.triggers, GH_EVENTS[e] ?? e);
  }
  const jobs = v.jobs as Obj;
  for (const [id, job] of Object.entries(jobs)) {
    f.add(f.jobs, id);
    if (!isObj(job)) continue;
    f.add(f.environments, str(job.environment) ?? str(at(job, "environment", "name")));
    const uses = str(job.uses);
    if (uses) f.add(f.templates, uses);
    arr(job.steps).forEach((step, i) => {
      if (!isObj(step)) return;
      const run = str(step.run);
      const action = str(step.uses);
      if (action) f.add(f.actions, action);
      const w = isObj(step.with) ? step.with : {};
      // An action's inputs are left out: "reporter: jest-junit" doesn't make a step a test run.
      const text = [action ?? "", run ?? ""].join(" ");
      f.step(str(step.name) ?? (run ? firstLine(run) : action), text);
      const line = doc.line(["jobs", id, "steps", i]);
      const where = { path, ...(line ? { line } : {}) };
      const a = action?.split("@")[0]?.toLowerCase() ?? "";
      if (a === "codecov/codecov-action")
        f.coverage.push({ files: lines(w.files ?? w.file), tool: "codecov", ...where });
      else if (a === "coverallsapp/github-action")
        f.coverage.push({ files: lines(w["path-to-lcov"] ?? w.file), tool: "coveralls", ...where });
      else if (a === "dorny/test-reporter") {
        const format = str(w.reporter);
        f.tests.push({ files: lines(w.path), ...(format ? { format } : {}), ...where });
      } else if (
        a === "enricomi/publish-unit-test-result-action" ||
        a === "mikepenz/action-junit-report"
      )
        f.tests.push({
          files: lines(w.files ?? w.junit_files ?? w.report_paths),
          format: "junit",
          ...where,
        });
    });
  }
  f.add(f.files, path);
  return f;
}

// ------------------------------------------------------------------ GitLab CI

const GITLAB_RESERVED = new Set([
  "stages",
  "variables",
  "include",
  "default",
  "workflow",
  "image",
  "services",
  "before_script",
  "after_script",
  "cache",
  "pages:deploy",
]);
const GL_SOURCES: Record<string, string> = {
  merge_request_event: "pull-request",
  external_pull_request_event: "pull-request",
  push: "push",
  schedule: "schedule",
  web: "manual",
  api: "api",
  trigger: "pipeline",
  pipeline: "pipeline",
  parent_pipeline: "pipeline",
};

function gitlabTriggers(rules: unknown, f: Facts) {
  for (const r of arr(rules)) {
    const cond = str(at(r, "if")) ?? "";
    for (const m of cond.matchAll(/\$CI_PIPELINE_SOURCE\s*==\s*["']?(\w+)["']?/g))
      f.add(f.triggers, GL_SOURCES[m[1]!] ?? m[1]!);
    if (/\$CI_COMMIT_BRANCH\b/.test(cond)) f.add(f.triggers, "push");
    if (/\$CI_COMMIT_TAG\b/.test(cond)) f.add(f.triggers, "tag");
  }
}

async function gitlabPipeline(
  repo: RepoHandle,
  ctx: ScanContext,
  path: string,
  root: YamlDoc,
): Promise<Facts> {
  const f = new Facts();
  const docs: { path: string; doc: YamlDoc }[] = [{ path, doc: root }];
  const v = root.value as Obj;
  const includes = Array.isArray(v.include)
    ? v.include
    : v.include !== undefined
      ? [v.include]
      : [];
  for (const inc of includes) {
    const local = typeof inc === "string" && !/^https?:/.test(inc) ? inc : str(at(inc, "local"));
    if (!local) {
      f.add(
        f.templates,
        str(at(inc, "project")) ??
          str(at(inc, "remote")) ??
          str(at(inc, "template")) ??
          str(at(inc, "component")),
      );
      continue;
    }
    const p = local.replace(/^\/+/, "");
    let text: string;
    try {
      text = await repo.readText(p);
    } catch {
      ctx.warn(`Include ${local} was not found; skipped it.`, path);
      continue;
    }
    const doc = readYamlDocs(text, { cache: repo.parseCache, path: p })?.[0];
    if (!doc) {
      ctx.warn(MALFORMED_YAML, p);
      continue;
    }
    docs.push({ path: p, doc });
  }
  for (const s of arr(v.stages)) f.add(f.stages, str(s));
  gitlabTriggers(at(v, "workflow", "rules"), f);
  const seen = new Set<string>();
  for (const d of docs) {
    f.add(f.files, d.path);
    if (!isObj(d.doc.value)) continue;
    for (const [name, job] of Object.entries(d.doc.value)) {
      if (GITLAB_RESERVED.has(name) || name.startsWith(".") || !isObj(job) || seen.has(name))
        continue;
      if (!("script" in job || "trigger" in job || "extends" in job || "stage" in job)) continue;
      seen.add(name);
      f.add(f.jobs, str(job.stage) ?? "test");
      f.add(f.environments, str(job.environment) ?? str(at(job, "environment", "name")));
      gitlabTriggers(job.rules, f);
      for (const k of ["before_script", "script", "after_script"])
        for (const cmd of Array.isArray(job[k]) ? job[k] : [job[k]]) {
          const s = str(cmd);
          if (s) f.step(undefined, s);
        }
      const junit = at(job, "artifacts", "reports", "junit");
      if (junit !== undefined) {
        const line = d.doc.line([name, "artifacts", "reports", "junit"]);
        f.tests.push({
          files: lines(junit),
          format: "junit",
          path: d.path,
          ...(line ? { line } : {}),
        });
      }
      const cov = at(job, "artifacts", "reports", "coverage_report");
      if (isObj(cov)) {
        const line = d.doc.line([name, "artifacts", "reports", "coverage_report"]);
        const format = str(cov.coverage_format);
        f.coverage.push({
          files: lines(cov.path),
          ...(format ? { format } : {}),
          path: d.path,
          ...(line ? { line } : {}),
        });
      }
    }
  }
  if (f.triggers.length === 0) f.add(f.triggers, "push");
  return f;
}

// ------------------------------------------------------------------ Jenkins

/**
 * A declarative (or scripted) Jenkins pipeline, from its Groovy syntax tree (ADR 0060): stages,
 * triggers, shell steps, test results and coverage reports are calls, and their arguments are
 * read as the tree has them. Comments are never read.
 */
async function jenkinsPipeline(
  path: string,
  raw: string,
  models: readonly FrameworkModel[] = [],
  cache?: ParseCache,
): Promise<Facts | undefined> {
  const calls = await groovyCalls(raw, { cache, path });
  // A shared-library step a pipeline model names (ADR 0062): deployToProd(app: 'cards').
  const steps = models.flatMap((m) =>
    m.pipeline.flatMap((e) => (e.step ? [{ m, e, step: e.step }] : [])),
  );
  const modelledStep = (name: string) => steps.filter((x) => x.step === name);
  if (
    !calls.some((c) => c.name === "stage" || c.name === "pipeline" || modelledStep(c.name).length)
  )
    return undefined;
  const f = new Facts();
  const details: Record<string, unknown> = {};
  for (const c of calls) {
    for (const { m, e } of modelledStep(c.name)) {
      const env = e.environmentFrom ? c.named[e.environmentFrom] : undefined;
      addEntry(details, e, m.name, env);
      f.add(f.templates, `step:${c.name}`);
    }
    const first = c.args[0];
    switch (c.name) {
      case "stage":
        if (first === undefined) break;
        f.add(f.stages, first);
        if (/deploy/i.test(first))
          f.add(
            f.environments,
            first
              .split(/[^A-Za-z0-9-]+/)
              .find((w) => isEnvWord(w))
              ?.toLowerCase(),
          );
        break;
      case "cron":
        if (first !== undefined) f.add(f.triggers, `schedule ${first}`);
        break;
      case "pollSCM":
        if (first !== undefined) f.add(f.triggers, `poll ${first}`);
        break;
      case "githubPush":
      case "gitlab":
        f.add(f.triggers, "push");
        break;
      case "upstream": {
        const up = c.named.upstreamProjects ?? first;
        if (up !== undefined) f.add(f.triggers, `pipeline ${up}`);
        break;
      }
      case "sh":
      case "bat":
      case "powershell":
      case "pwsh": {
        const script = c.named.script ?? first;
        if (script !== undefined) f.step(undefined, script);
        break;
      }
      case "junit": {
        const results = c.named.testResults ?? first;
        if (results !== undefined)
          f.tests.push({ files: lines(results), format: "junit", path, line: c.line });
        break;
      }
      case "jacoco": {
        const pattern = c.named.execPattern;
        f.coverage.push({
          files: pattern ? lines(pattern) : [],
          tool: "jacoco",
          path,
          line: c.line,
        });
        break;
      }
      case "recordCoverage":
      case "publishCoverage": {
        const pattern = c.named.pattern;
        f.coverage.push({
          files: pattern ? lines(pattern) : [],
          tool: "coverage",
          path,
          line: c.line,
        });
        break;
      }
    }
  }
  for (const k of ["stages", "environments", "deployTargets", "testSteps"] as const)
    for (const v of (details[k] as string[] | undefined) ?? []) f.add(f[k], v);
  f.modelled = (details.modelled as string[] | undefined) ?? [];
  f.add(f.files, path);
  return f;
}
