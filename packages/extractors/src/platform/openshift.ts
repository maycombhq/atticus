import { defineExtractor, globToRegExp } from "@maycombhq/sdk";
import { infraExtractor } from "../more.js";
import {
  loadManifests,
  MANIFEST_GLOBS,
  sameScope,
  selects,
  warnSkipped,
  type K8sObject,
} from "./manifests.js";
import {
  at,
  componentFor,
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
  version: "0.2.0",
  claims: MANIFEST_GLOBS,
  async *scan(repo, ctx) {
    const set = await loadManifests(repo, ctx, RELEVANT);
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
        : (envOf({ namespace: o.namespace, path: o.file, name: o.name }) ?? "default");
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
        const env = envOf({ namespace: r.namespace, path: r.file }) ?? "default";
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
        evidence: [w.o, ...hpa, ...nps, ...(ingress?.objs ?? [])].map((x) =>
          ev(repo, "infrastructure", x.file, x.line()),
        ),
      });
    }

    for (const o of orphans.values())
      yield deployment({
        component: o.component,
        env: o.env,
        platform: "openshift",
        ingress: o.routes,
        evidence: o.objs.map((x) => ev(repo, "infrastructure", x.file, x.line())),
      });
  },
});
