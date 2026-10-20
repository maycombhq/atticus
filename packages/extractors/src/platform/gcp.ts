import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor, type RepoHandle, type ScanContext } from "@maycombhq/sdk";
import { looseEnd, splitUrl } from "../facts.js";
import { attrOf, child, type HclValue } from "./hcl.js";
import { loadManifests, MALFORMED_YAML, readYamlDocs } from "./manifests.js";
import {
  findResource,
  loadTerraform,
  refsIn,
  resolve,
  TF_GLOBS,
  tfInt,
  tfObject,
  tfString,
  type TfModule,
  type TfResource,
} from "./terraform.js";
import {
  at,
  clipId,
  componentFor,
  deployment,
  envOf,
  ev,
  int,
  isObj,
  ownComponent,
  readOrWarn,
  resourcesOf,
  slug,
  str,
  topicId,
} from "./util.js";

const APP_ENGINE = ["**/app.yaml", "**/app.yml"];
const KNATIVE = /serving\.knative\.dev/;

/**
 * Google Cloud: Cloud Run services (Knative YAML and Terraform v1 and v2) and App Engine
 * app.yaml files become Deployments; Pub/Sub topics become event-topic Endpoints and
 * subscriptions with a known subscriber become event-subscribe loose ends; IAM members and
 * bindings for service accounts and groups become AccessGrants. Cloud SQL instances are left
 * to the infra extractor, which already reads them; Cloud Scheduler jobs to the batch one.
 */
export const gcpExtractor = defineExtractor({
  id: "gcp",
  version: "0.1.0",
  claims: [...TF_GLOBS, "**/*.yaml", "**/*.yml"],
  async *scan(repo, ctx) {
    // ---- Cloud Run service YAML
    const knative = await loadManifests(repo, ctx, KNATIVE, ["**/*.yaml", "**/*.yml"]);
    for (const o of knative.objects) {
      if (o.kind !== "Service" || !KNATIVE.test(o.apiVersion)) continue;
      const env = envOf({ path: o.file, name: o.name }) ?? "default";
      const ann = at(o.obj, "spec", "template", "metadata", "annotations");
      const min = int(at(ann, "autoscaling.knative.dev/minScale"));
      const max = int(at(ann, "autoscaling.knative.dev/maxScale"));
      const resources = resourcesOf(at(o.obj, "spec", "template", "spec", "containers", 0));
      yield deployment({
        component: componentFor(ctx, [o.labels.app, o.name]),
        env,
        platform: "cloud-run",
        ...(resources ? { resources } : {}),
        ...(max ? { autoscaling: { min: min ?? 0, max } } : {}),
        evidence: [ev(repo, "infrastructure", o.file, o.line())],
      });
    }

    // ---- App Engine
    yield* appEngine(repo, ctx);

    // ---- Terraform
    for (const mod of await loadTerraform(repo, ctx, /\bgoogle_/)) {
      for (const r of mod.resources) {
        if (r.type === "google_cloud_run_v2_service" || r.type === "google_cloud_run_service") {
          const d = cloudRun(repo, ctx, mod, r);
          if (d) yield d;
        } else if (r.type === "google_pubsub_topic") {
          const name = tfString(mod, attrOf(r.block, "name"));
          if (name) yield topicEndpoint(repo, r, name);
        } else if (r.type === "google_pubsub_subscription") {
          const l = subscription(repo, ctx, mod, r);
          if (l) yield l;
        } else if (/^google_\w+_iam_(member|binding)$/.test(r.type)) {
          yield* iamGrants(repo, mod, r);
        }
      }
    }
  },
});

async function* appEngine(repo: RepoHandle, ctx: ScanContext): AsyncGenerator<CatalogRecord> {
  for await (const path of repo.listFiles(APP_ENGINE)) {
    const text = await readOrWarn(repo, ctx, path);
    if (text === undefined || !/^runtime\s*:/m.test(text)) continue;
    const docs = readYamlDocs(text, { cache: repo.parseCache, path });
    if (!docs) {
      ctx.warn(MALFORMED_YAML, path);
      continue;
    }
    const doc = docs[0];
    const v = doc?.value;
    if (!doc || !isObj(v) || !str(v.runtime)) continue;
    const service = str(v.service) ?? str(v.module);
    const env = envOf({ path }) ?? "default";
    // The "default" service is the app itself: the repo's component.
    const component =
      service && service !== "default"
        ? componentFor(ctx, [service])
        : (ctx.component ?? repo.name);
    const auto = v.automatic_scaling;
    const minA = int(at(auto, "min_instances")) ?? int(at(auto, "min_num_instances"));
    const maxA = int(at(auto, "max_instances")) ?? int(at(auto, "max_num_instances"));
    const replicas = int(at(v, "manual_scaling", "instances"));
    const cpu = str(at(v, "resources", "cpu"));
    const gb = str(at(v, "resources", "memory_gb"));
    yield deployment({
      component,
      env,
      platform: "app-engine",
      ...(replicas !== undefined ? { replicas } : {}),
      ...(cpu || gb
        ? { resources: { ...(cpu ? { cpu } : {}), ...(gb ? { memory: `${gb}GB` } : {}) } }
        : {}),
      ...(maxA ? { autoscaling: { min: minA ?? 0, max: maxA } } : {}),
      evidence: [ev(repo, "infrastructure", path, doc.line(["runtime"]))],
    });
  }
}

function cloudRun(
  repo: RepoHandle,
  ctx: ScanContext,
  mod: TfModule,
  r: TfResource,
): CatalogRecord | undefined {
  const name = tfString(mod, attrOf(r.block, "name"));
  if (!name) return undefined;
  const tpl = child(r.block, "template");
  let min: number | undefined;
  let max: number | undefined;
  let limits: Record<string, HclValue> | undefined;
  if (r.type === "google_cloud_run_v2_service") {
    const scaling = child(tpl, "scaling") ?? child(r.block, "scaling");
    min = tfInt(mod, attrOf(scaling, "min_instance_count"));
    max = tfInt(mod, attrOf(scaling, "max_instance_count"));
    limits = tfObject(mod, attrOf(child(child(tpl, "containers"), "resources"), "limits"));
  } else {
    const ann = tfObject(mod, attrOf(child(tpl, "metadata"), "annotations"));
    min = tfInt(mod, ann?.["autoscaling.knative.dev/minScale"]);
    max = tfInt(mod, ann?.["autoscaling.knative.dev/maxScale"]);
    const c = child(child(tpl, "spec"), "containers");
    limits = tfObject(mod, attrOf(child(c, "resources"), "limits"));
  }
  const cpu = str(limits?.cpu);
  const memory = str(limits?.memory);
  const env = envOf({ path: r.file, name }) ?? "default";
  return deployment({
    component: componentFor(ctx, [name]),
    env,
    platform: "cloud-run",
    ...(cpu || memory
      ? { resources: { ...(cpu ? { cpu } : {}), ...(memory ? { memory } : {}) } }
      : {}),
    ...(max ? { autoscaling: { min: min ?? 0, max } } : {}),
    evidence: [ev(repo, "infrastructure", r.file, r.block.line)],
  });
}

function topicEndpoint(repo: RepoHandle, r: TfResource, name: string): CatalogRecord {
  return {
    schemaVersion: 1,
    kind: "Endpoint",
    id: topicId(name),
    status: "current",
    confidence: "verified",
    // The publisher isn't written in Terraform; merge fills it from the code that publishes.
    component: "unknown",
    endpointType: "event-topic",
    pathOrTopic: name,
    schemaRefs: [],
    evidence: [ev(repo, "infrastructure", r.file, r.block.line, "definition")],
  } as unknown as CatalogRecord;
}

/** The topic a subscription or job names: a topic resource's name or id, or "projects/p/topics/<name>". */
export function topicName(mod: TfModule, v: HclValue | undefined): string | undefined {
  for (const ref of refsIn(v)) {
    if (ref.type !== "google_pubsub_topic") continue;
    const t = findResource(mod, ref.type, ref.name);
    const n = t ? tfString(mod, attrOf(t.block, "name")) : undefined;
    if (n) return n;
  }
  const s = tfString(mod, v);
  if (!s) return undefined;
  return s.includes("/topics/") ? s.slice(s.lastIndexOf("/topics/") + "/topics/".length) : s;
}

/**
 * A subscription's subscriber, in order: a component/app/service label, the host of a push
 * endpoint (its first label), the repo's own component. With none, nothing is emitted: the
 * topic record already shows the topic, and an owner-less loose end can't be resolved.
 */
function subscription(
  repo: RepoHandle,
  ctx: ScanContext,
  mod: TfModule,
  r: TfResource,
): CatalogRecord | undefined {
  const topic = topicName(mod, attrOf(r.block, "topic"));
  if (!topic) return undefined;
  const labels = tfObject(mod, attrOf(r.block, "labels"));
  const label = str(labels?.component) ?? str(labels?.app) ?? str(labels?.service);
  const push = tfString(mod, attrOf(child(r.block, "push_config"), "push_endpoint"));
  const host = push ? splitUrl(push).host?.split(":")[0]?.split(".")[0] : undefined;
  const owner = label ?? host ?? ownComponent(ctx);
  if (!owner) return undefined;
  return looseEnd(repo, { ...ctx, component: slug(owner) }, "event-subscribe", topic, {
    source: "infrastructure",
    path: r.file,
    line: r.block.line,
    side: "definition",
  });
}

/** Which attribute names the resource an IAM member or binding is on, per resource type. */
const IAM_TARGET: Record<string, string> = {
  project: "project",
  folder: "folder",
  organization: "org_id",
  pubsub_topic: "topic",
  pubsub_subscription: "subscription",
  storage_bucket: "bucket",
  secret_manager_secret: "secret_id",
  cloud_run_service: "service",
  cloud_run_v2_service: "name",
  service_account: "service_account_id",
  bigquery_dataset: "dataset_id",
  spanner_database: "database",
  kms_crypto_key: "crypto_key_id",
};

const SUBJECT_KIND: Record<string, string> = {
  serviceAccount: "service-account",
  group: "group",
};

/**
 * One AccessGrant per service account or group in a google_*_iam_member or _binding.
 * Users and domains are left out: they aren't services, and a person's address is never recorded.
 */
function* iamGrants(repo: RepoHandle, mod: TfModule, r: TfResource): Generator<CatalogRecord> {
  const m = /^google_(\w+)_iam_(member|binding)$/.exec(r.type)!;
  const resType = m[1]!;
  const role = tfString(mod, attrOf(r.block, "role"));
  if (!role) return;
  const targetAttr = IAM_TARGET[resType];
  const rawTarget = targetAttr ? attrOf(r.block, targetAttr) : undefined;
  const targetValue =
    tfString(mod, rawTarget) ??
    (rawTarget !== undefined ? JSON.stringify(resolve(mod, rawTarget)) : undefined) ??
    r.name;
  const resource = `${resType.replace(/_/g, "-")}/${targetValue.replace(/^projects\//, "")}`;
  const members =
    m[2] === "member"
      ? [attrOf(r.block, "member")]
      : (() => {
          const v = resolve(mod, attrOf(r.block, "members"));
          return Array.isArray(v) ? v : [];
        })();
  const env = envOf({ path: r.file });
  for (const raw of members) {
    const member = tfString(mod, raw as HclValue | undefined);
    if (!member) continue;
    const colon = member.indexOf(":");
    const kind = SUBJECT_KIND[member.slice(0, colon)];
    if (colon < 0 || !kind) continue;
    const subject = member.slice(colon + 1);
    const local = subject.split("@")[0]!;
    yield {
      schemaVersion: 1,
      kind: "AccessGrant",
      id: clipId(`${slug(local)}.iam.${slug(resource)}.${slug(role.replace(/^roles\//, ""))}`),
      status: "current",
      confidence: "verified",
      subjectKind: kind,
      subject,
      resource,
      scopesOrPermissions: [role],
      ...(env ? { env } : {}),
      evidence: [ev(repo, "infrastructure", r.file, r.block.line)],
    } as unknown as CatalogRecord;
  }
}
