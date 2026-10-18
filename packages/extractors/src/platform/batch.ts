import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor, type RepoHandle, type ScanContext } from "@maycombhq/sdk";
import { componentOf, repoConfig, splitUrl, type Ev } from "../facts.js";
import { relaxedKey, type ConfigValue } from "../lang/config.js";
import { attr, findAnnotation, parseJava, type Decl } from "../lang/java.js";
import { topicName } from "./gcp.js";
import { attrOf, child } from "./hcl.js";
import { loadManifests, MANIFEST_GLOBS, warnSkipped } from "./manifests.js";
import { findResource, loadTerraform, refsIn, TF_GLOBS, tfString } from "./terraform.js";
import {
  at,
  componentFor,
  configSetting,
  deployment,
  envOf,
  ev,
  ownComponent,
  readOrWarn,
  resourcesOf,
  str,
  topicId,
} from "./util.js";

const CRONJOB = /\bkind["']?\s*:\s*["']?CronJob\b/;
const JAVA = ["**/*.java", "**/*.kt"];
const CONFIG = ["**/application*.yml", "**/application*.yaml", "**/application*.properties"];

/** A time zone goes in front as CRON_TZ=, a convention cron and Kubernetes both know, so the value stays one string. */
const withZone = (cron: string, zone?: string) => (zone ? `CRON_TZ=${zone} ${cron}` : cron);

/**
 * Batch jobs and their schedules. A schedule is a config Setting with key `schedule.<job>`
 * and the cron expression as its value (C1 has no schedule field, and a Setting keeps the
 * value with its provenance): Kubernetes CronJobs (also a Deployment of the batch component),
 * Spring @Scheduled methods (cron, with placeholders resolved from application config, or a
 * fixed rate or delay), Quartz cron triggers and Cloud Scheduler jobs in Terraform. Control-M
 * and Autosys exports are out of scope.
 */
export const batchExtractor = defineExtractor({
  id: "batch",
  version: "0.1.0",
  claims: [...MANIFEST_GLOBS, ...JAVA, ...TF_GLOBS],
  async *scan(repo, ctx) {
    yield* cronJobs(repo, ctx);
    yield* springAndQuartz(repo, ctx);
    yield* cloudScheduler(repo, ctx);
  },
});

async function* cronJobs(repo: RepoHandle, ctx: ScanContext): AsyncGenerator<CatalogRecord> {
  const set = await loadManifests(repo, ctx, CRONJOB);
  warnSkipped(ctx, set, new Set(["CronJob"]));
  const deployments = new Map<string, { fields: Parameters<typeof deployment>[0] }>();
  const settings: CatalogRecord[] = [];
  for (const o of set.objects) {
    if (o.kind !== "CronJob") continue;
    const schedule = str(at(o.obj, "spec", "schedule"));
    if (!schedule) continue;
    const pod = at(o.obj, "spec", "jobTemplate", "spec", "template");
    const podLabels = at(pod, "metadata", "labels");
    const env = envOf({ namespace: o.namespace, path: o.file, name: o.name }) ?? "default";
    const component = componentFor(ctx, [
      o.labels.app,
      o.labels["app.kubernetes.io/name"],
      str(at(podLabels, "app")),
      o.name,
    ]);
    const resources = resourcesOf(at(pod, "spec", "containers", 0));
    const evidence = ev(repo, "infrastructure", o.file, o.line());
    // Two jobs of one component in one environment are one deployment with both as evidence.
    const key = `${component}|${env}`;
    const d = deployments.get(key);
    if (d) d.fields.evidence.push(evidence);
    else
      deployments.set(key, {
        fields: {
          component,
          env,
          platform: "kubernetes",
          ...(resources ? { resources } : {}),
          evidence: [evidence],
        },
      });
    settings.push(
      configSetting({
        component,
        env,
        key: `schedule.${o.name}`,
        value: withZone(schedule, str(at(o.obj, "spec", "timeZone"))),
        evidence: [ev(repo, "infrastructure", o.file, o.line(["spec", "schedule"]))],
      }),
    );
  }
  for (const d of deployments.values()) yield deployment(d.fields);
  yield* settings;
}

/** Find a config value by key, relaxed as Spring does (read-timeout = readTimeout). */
function lookup(config: Map<string, ConfigValue>, key: string): ConfigValue | undefined {
  const exact = config.get(key);
  if (exact) return exact;
  for (const [k, v] of config) if (relaxedKey(k) === relaxedKey(key)) return v;
  return undefined;
}

async function* springAndQuartz(repo: RepoHandle, ctx: ScanContext): AsyncGenerator<CatalogRecord> {
  const component = componentOf(repo, ctx);
  let config: Map<string, ConfigValue> | undefined;
  /** A value with ${key} or ${key:default} resolved, and the config line it came from. */
  const resolveValue = async (raw: string): Promise<{ value: string; from?: ConfigValue }> => {
    const m = /^\$\{([^}:]+)(?::([^}]*))?\}$/.exec(raw.trim());
    if (!m) return { value: raw };
    config ??= await repoConfig(repo, CONFIG);
    const found = lookup(config, m[1]!);
    if (found) return { value: found.value, from: found };
    return { value: m[2] ?? raw };
  };
  const evidence = (path: string, line: number, from?: ConfigValue): Ev[] => [
    ev(repo, "code", path, line),
    ...(from ? [ev(repo, "config", from.file, from.line)] : []),
  ];

  for await (const path of repo.listFiles(JAVA)) {
    if (/(^|\/)src\/test\//.test(path)) continue;
    const src = await readOrWarn(repo, ctx, path);
    if (src === undefined || !/@Scheduled|cronSchedule|setCronExpression/.test(src)) continue;
    const file = parseJava(src);

    // Spring @Scheduled on methods.
    for (const d of file.decls) {
      if (d.kind !== "method") continue;
      const a = findAnnotation(d, "Scheduled");
      if (!a) continue;
      const owner = (d.parent as Decl | undefined)?.name ?? "";
      const key = `schedule.${owner ? `${owner}.` : ""}${d.name}`;
      const cron = attr(a, "cron");
      if (cron !== undefined) {
        const r = await resolveValue(cron);
        if (r.value === "-") continue; // Spring's "disabled"
        yield configSetting({
          component,
          key,
          value: withZone(r.value, attr(a, "zone")),
          evidence: evidence(path, a.line, r.from),
        });
        continue;
      }
      for (const kind of ["fixedRate", "fixedDelay"]) {
        const raw = attr(a, kind) ?? attr(a, `${kind}String`);
        if (raw === undefined) continue;
        const r = await resolveValue(raw);
        yield configSetting({
          component,
          key,
          value: `${kind}=${r.value}`,
          evidence: evidence(path, a.line, r.from),
        });
        break;
      }
    }

    // Quartz: CronScheduleBuilder.cronSchedule("...") and CronTriggerFactoryBean.setCronExpression("...").
    for (const c of file.calls) {
      if ((c.method !== "cronSchedule" && c.method !== "setCronExpression") || !c.args[0]) continue;
      const nameCall = c.method === "cronSchedule" ? "withIdentity" : "setName";
      const named = file.calls
        .filter((x) => x.method === nameCall && x.args[0] && x.inMethod === c.inMethod)
        .sort((x, y) => Math.abs(x.line - c.line) - Math.abs(y.line - c.line))[0];
      const job =
        named?.args[0] ??
        [c.inType?.name, c.inMethod?.name].filter((x): x is string => !!x).join(".");
      const r = await resolveValue(c.args[0]);
      yield configSetting({
        component,
        key: `schedule.${job || "quartz"}`,
        value: r.value,
        evidence: evidence(path, c.line, r.from),
      });
    }
  }
}

const RUN_TYPES = new Set([
  "google_cloud_run_v2_service",
  "google_cloud_run_service",
  "google_cloudfunctions2_function",
  "google_cloudfunctions_function",
]);

/**
 * Cloud Scheduler jobs. An HTTP target names the component it calls (a referenced Cloud Run
 * service or function, else the URL's first host label); an App Engine target its service; a
 * Pub/Sub target belongs to the repo's own component and points at the topic (Setting.target).
 */
async function* cloudScheduler(repo: RepoHandle, ctx: ScanContext): AsyncGenerator<CatalogRecord> {
  for (const mod of await loadTerraform(repo, ctx, /\bgoogle_cloud_scheduler_job\b/)) {
    for (const r of mod.resources) {
      if (r.type !== "google_cloud_scheduler_job") continue;
      const name = tfString(mod, attrOf(r.block, "name")) ?? r.name;
      const schedule = tfString(mod, attrOf(r.block, "schedule"));
      if (!schedule) continue;
      const zone = tfString(mod, attrOf(r.block, "time_zone"));
      let candidate: string | undefined;
      let target: string | undefined;
      const http = child(r.block, "http_target");
      const appEngine = child(r.block, "app_engine_http_target");
      const pubsub = child(r.block, "pubsub_target");
      if (http) {
        const uri = attrOf(http, "uri");
        for (const ref of refsIn(uri)) {
          if (!RUN_TYPES.has(ref.type)) continue;
          const svc = findResource(mod, ref.type, ref.name);
          candidate ??= svc ? tfString(mod, attrOf(svc.block, "name")) : undefined;
        }
        const url = tfString(mod, uri);
        candidate ??= url ? splitUrl(url).host?.split(":")[0]?.split(".")[0] : undefined;
      } else if (appEngine) {
        candidate = tfString(mod, attrOf(child(appEngine, "app_engine_routing"), "service"));
      } else if (pubsub) {
        const topic = topicName(mod, attrOf(pubsub, "topic_name"));
        if (topic) target = topicId(topic);
      }
      const env = envOf({ path: r.file });
      const component = candidate
        ? componentFor(ctx, [candidate])
        : (ownComponent(ctx) ?? "unknown");
      yield configSetting({
        component,
        ...(env ? { env } : {}),
        key: `schedule.${name}`,
        value: withZone(schedule, zone),
        ...(target ? { target } : {}),
        evidence: [ev(repo, "infrastructure", r.file, r.block.line)],
      });
    }
  }
}
