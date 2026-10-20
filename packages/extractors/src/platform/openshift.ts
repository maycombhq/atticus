import { defineExtractor, globToRegExp } from "@maycombhq/sdk";
import { infraExtractor } from "../more.js";
import {
  CHART_GLOBS,
  loadManifests,
  MANIFEST_GLOBS,
  sameScope,
  selects,
  warnSkipped,
  type K8sObject,
} from "./manifests.js";
import {
  at,
  arr,
  componentFor,
  configSetting,
  deployment,
  envOf,
  ev,
  int,
  isObj,
  resourcesOf,
  slug,
  str,
  type IngressRoute,
} from "./util.js";

const RELEVANT =
  /\bkind["']?\s*:\s*["']?(DeploymentConfig|Deployment|HorizontalPodAutoscaler|NetworkPolicy|Route|Service|Template|List)\b/;
const HANDLED = new Set([
  "DeploymentConfig",
  "Deployment",
  "HorizontalPodAutoscaler",
  "NetworkPolicy",
  "Route",
  "Service",
]);
const INFRA_PATHS = infraExtractor.claims.map(globToRegExp);

/**
 * True when the infra extractor emits this Deployment itself: it reads only the first
 * document of YAML files in its folders. This extractor then adds only what infra can't
 * see (autoscaling, network policies), under infra's id, and merge joins the two.
 */
const infraSees = (o: K8sObject) =>
  o.kind === "Deployment" &&
  !o.origin &&
  !o.nested &&
  o.docIndex === 0 &&
  !o.file.endsWith(".json") &&
  INFRA_PATHS.some((re) => re.test(o.file));

interface Workload {
  o: K8sObject;
  component: string;
  env: string;
  podLabels: Record<string, string>;
}

const labelsOf = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (isObj(v)) for (const [k, x] of Object.entries(v)) if (str(x) !== undefined) out[k] = str(x)!;
  return out;
};

/**
 * OpenShift (and the Kubernetes objects around it): DeploymentConfigs become Deployments
 * (platform openshift) with replicas, resources, autoscaling from a HorizontalPodAutoscaler
 * and the NetworkPolicies that select their pods. Plain Deployments are emitted when the
 * infra extractor can't see them, or to add autoscaling and policies to the ones it does.
 * Templates are processed with their parameter defaults first.
 *
 * A Route is an ingress host, not an API gateway route, so it doesn't fit C1's GatewayRoute;
 * it is a `Deployment.ingress` entry (ADR 0040; before that a `route.<name>` config Setting) of
 * the deployment behind the Service it points to. A Route whose workload isn't in this repo
 * gives a Deployment with only its ingress, which merge joins to the full one by id.
 */
export const openshiftExtractor = defineExtractor({
  id: "openshift",
  version: "0.3.0",
  claims: [...MANIFEST_GLOBS, ...CHART_GLOBS],
  async *scan(repo, ctx) {
    const set = await loadManifests(repo, ctx, RELEVANT, MANIFEST_GLOBS, { rendered: true });
    const evOf = (x: K8sObject) => [
      ev(repo, "infrastructure", x.file, x.line()),
      ...(x.sources ?? []).map((s) => ev(repo, "infrastructure", s.file, s.line)),
    ];
    warnSkipped(ctx, set, HANDLED);
    const objects = set.objects;
    const of = (kind: string) => objects.filter((o) => o.kind === kind);

    const workloads: Workload[] = [];
    for (const o of [...of("DeploymentConfig"), ...of("Deployment")]) {
      if (o.kind === "Deployment" && !/^(apps|extensions)\//.test(o.apiVersion)) continue;
      const seen = infraSees(o);
      // Same environment and component rules as the infra extractor for what it reads.
      const env = seen
        ? (o.namespace ?? "default")
        : (o.env ?? envOf({ namespace: o.namespace, path: o.file, name: o.name }) ?? "default");
      const component = seen
        ? slug(o.name)
        : componentFor(ctx, [o.labels.app, o.labels["app.kubernetes.io/name"], o.name]);
      const podLabels = labelsOf(at(o.obj, "spec", "template", "metadata", "labels"));
      const sel = at(o.obj, "spec", "selector");
      const selLabels = labelsOf(o.kind === "DeploymentConfig" ? sel : at(sel, "matchLabels"));
      workloads.push({
        o,
        component,
        env,
        podLabels: Object.keys(podLabels).length > 0 ? podLabels : selLabels,
      });
    }

    // Routes: the ingress of the workload behind the Service a Route points to.
    const routed = new Map<Workload, { routes: IngressRoute[]; objs: K8sObject[] }>();
    const orphans = new Map<
      string,
      { component: string; env: string; routes: IngressRoute[]; objs: K8sObject[] }
    >();
    const services = of("Service").filter((s) => s.apiVersion === "v1");
    for (const r of of("Route")) {
      const host = str(at(r.obj, "spec", "host"));
      if (!host) continue; // OpenShift generates one at deploy time: nothing to record.
      const toKind = str(at(r.obj, "spec", "to", "kind")) ?? "Service";
      const toName = str(at(r.obj, "spec", "to", "name"));
      if (toKind !== "Service" || !toName) continue;
      const svc = services.find((s) => s.name === toName && sameScope(s, r));
      const selector = at(svc?.obj, "spec", "selector");
      const w =
        (svc && isObj(selector) && Object.keys(selector).length > 0
          ? workloads.find((x) => sameScope(x.o, svc) && selects(selector, x.podLabels))
          : undefined) ?? workloads.find((x) => x.o.name === toName && sameScope(x.o, r));
      const path = str(at(r.obj, "spec", "path"));
      const route: IngressRoute = {
        host,
        ...(path ? { path } : {}),
        tls: isObj(at(r.obj, "spec", "tls")),
      };
      const objs = [r, ...(svc ? [svc] : [])];
      if (w) {
        const e = routed.get(w) ?? { routes: [], objs: [] };
        e.routes.push(route);
        e.objs.push(...objs);
        routed.set(w, e);
      } else {
        const env = r.env ?? envOf({ namespace: r.namespace, path: r.file }) ?? "default";
        const component = componentFor(ctx, [toName]);
        const key = `${component}|${env}`;
        const e = orphans.get(key) ?? { component, env, routes: [], objs: [] };
        e.routes.push(route);
        e.objs.push(...objs);
        orphans.set(key, e);
      }
    }

    const hpas = of("HorizontalPodAutoscaler");
    const policies = of("NetworkPolicy");
    for (const w of workloads) {
      const ingress = routed.get(w);
      const hpa = hpas.filter(
        (h) =>
          str(at(h.obj, "spec", "scaleTargetRef", "kind")) === w.o.kind &&
          str(at(h.obj, "spec", "scaleTargetRef", "name")) === w.o.name &&
          sameScope(h, w.o),
      );
      const nps = policies.filter(
        (p) => sameScope(p, w.o) && selects(at(p.obj, "spec", "podSelector"), w.podLabels),
      );
      if (
        w.o.kind === "Deployment" &&
        infraSees(w.o) &&
        hpa.length === 0 &&
        nps.length === 0 &&
        !ingress
      )
        continue;
      const max = int(at(hpa[0]?.obj, "spec", "maxReplicas"));
      const min = int(at(hpa[0]?.obj, "spec", "minReplicas")) ?? 1;
      const replicas = int(at(w.o.obj, "spec", "replicas"));
      const resources = resourcesOf(at(w.o.obj, "spec", "template", "spec", "containers", 0));
      yield deployment({
        component: w.component,
        env: w.env,
        platform: w.o.kind === "DeploymentConfig" ? "openshift" : "kubernetes",
        ...(replicas !== undefined ? { replicas } : {}),
        ...(resources ? { resources } : {}),
        ...(max ? { autoscaling: { min, max } } : {}),
        networkPolicies: nps.map((p) => p.name),
        ...(ingress ? { ingress: ingress.routes } : {}),
        evidence: dedupe([w.o, ...hpa, ...nps, ...(ingress?.objs ?? [])].flatMap(evOf)),
      });
      // Built from a chart or an overlay: its images and environment variables, per environment.
      if (w.o.origin) yield* containerSettings(repo, w, of("ConfigMap"));
    }

    for (const o of orphans.values())
      yield deployment({
        component: o.component,
        env: o.env,
        platform: "openshift",
        ingress: o.routes,
        evidence: dedupe(o.objs.flatMap(evOf)),
      });
  },
});

type Evidence = ReturnType<typeof ev>;

const dedupe = (list: Evidence[]) =>
  list.filter((e, i) => list.findIndex((x) => x.path === e.path && x.line === e.line) === i);

/**
 * Settings for a workload built from a Helm chart or a Kustomize overlay (ADR 0064): each
 * container's image (`image`, or `image.<container>` when there are several) and environment
 * variables (`env.<NAME>`, or `env.<container>.<NAME>`). A value from a ConfigMap built in the
 * same release or overlay is filled in; a Secret stays a reference (`secret:<name>/<key>`),
 * never a value. A value the template reader left unknown gives no setting.
 */
function* containerSettings(
  repo: Parameters<typeof ev>[0],
  w: Workload,
  configMaps: K8sObject[],
): Generator<ReturnType<typeof configSetting>> {
  const base = ["spec", "template", "spec", "containers"];
  const containers = arr(at(w.o.obj, ...base));
  const single = containers.length === 1;
  const sources = (w.o.sources ?? []).map((s) => ev(repo, "infrastructure", s.file, s.line));
  const evAt = (path: (string | number)[]) =>
    dedupe([ev(repo, "infrastructure", w.o.file, w.o.line(path) ?? w.o.line()), ...sources]);
  const cmOf = (name: string | undefined) =>
    name ? configMaps.find((c) => c.name === name && sameScope(c, w.o)) : undefined;
  const seen = new Set<string>();
  const out: ReturnType<typeof configSetting>[] = [];
  const add = (key: string, value: string, evidence: Evidence[]) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(configSetting({ component: w.component, env: w.env, key, value, evidence }));
  };
  containers.forEach((c, i) => {
    if (!isObj(c)) return;
    const cname = str(c.name) ?? String(i);
    const image = str(c.image);
    if (image) add(single ? "image" : `image.${cname}`, image, evAt([...base, i, "image"]));
    const envKey = (n: string) => (single ? `env.${n}` : `env.${cname}.${n}`);
    arr(c.env).forEach((e, j) => {
      const name = str(at(e, "name"));
      if (!name) return;
      const path = [...base, i, "env", j];
      const literal = str(at(e, "value"));
      if (literal !== undefined) return add(envKey(name), literal, evAt(path));
      const cmRef = at(e, "valueFrom", "configMapKeyRef");
      const secretRef = at(e, "valueFrom", "secretKeyRef");
      const fieldPath = str(at(e, "valueFrom", "fieldRef", "fieldPath"));
      if (isObj(cmRef)) {
        const cmName = str(cmRef.name);
        const key = str(cmRef.key);
        const cm = cmOf(cmName);
        const v = key ? str(at(cm?.obj, "data", key)) : undefined;
        if (v !== undefined && cm && key)
          add(envKey(name), v, dedupe([...evAt(path), ...evOfCm(repo, cm, key)]));
        else if (cmName && key) add(envKey(name), `configmap:${cmName}/${key}`, evAt(path));
      } else if (isObj(secretRef)) {
        const sName = str(secretRef.name);
        const key = str(secretRef.key);
        if (sName && key) add(envKey(name), `secret:${sName}/${key}`, evAt(path));
      } else if (fieldPath) add(envKey(name), `field:${fieldPath}`, evAt(path));
    });
    arr(c.envFrom).forEach((e, j) => {
      const cm = cmOf(str(at(e, "configMapRef", "name")));
      const data = at(cm?.obj, "data");
      if (!cm || !isObj(data)) return;
      const prefix = str(at(e, "prefix")) ?? "";
      for (const key of Object.keys(data).sort()) {
        const v = str(data[key]);
        if (v === undefined) continue;
        add(
          envKey(prefix + key),
          v,
          dedupe([...evAt([...base, i, "envFrom", j]), ...evOfCm(repo, cm, key)]),
        );
      }
    });
  });
  yield* out;
}

function evOfCm(repo: Parameters<typeof ev>[0], cm: K8sObject, key: string): Evidence[] {
  return [
    ev(repo, "infrastructure", cm.file, cm.line(["data", key]) ?? cm.line()),
    ...(cm.sources ?? []).map((s) => ev(repo, "infrastructure", s.file, s.line)),
  ];
}
