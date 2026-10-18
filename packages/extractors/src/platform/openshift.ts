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
  configSetting,
  deployment,
  envOf,
  ev,
  int,
  isObj,
  resourcesOf,
  slug,
  str,
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
 * its public URL is kept as a config Setting (`route.<name>`) of the component behind it.
 */
export const openshiftExtractor = defineExtractor({
  id: "openshift",
  version: "0.1.0",
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

    const hpas = of("HorizontalPodAutoscaler");
    const policies = of("NetworkPolicy");
    for (const w of workloads) {
      const hpa = hpas.filter(
        (h) =>
          str(at(h.obj, "spec", "scaleTargetRef", "kind")) === w.o.kind &&
          str(at(h.obj, "spec", "scaleTargetRef", "name")) === w.o.name &&
          sameScope(h, w.o),
      );
      const nps = policies.filter(
        (p) => sameScope(p, w.o) && selects(at(p.obj, "spec", "podSelector"), w.podLabels),
      );
      if (w.o.kind === "Deployment" && infraSees(w.o) && hpa.length === 0 && nps.length === 0)
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
        evidence: [w.o, ...hpa, ...nps].map((x) => ev(repo, "infrastructure", x.file, x.line())),
      });
    }

    // Routes: the public URL of the component behind the Service a Route points to.
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
      const env = w?.env ?? envOf({ namespace: r.namespace, path: r.file });
      const component = w?.component ?? componentFor(ctx, [toName]);
      const path = str(at(r.obj, "spec", "path")) ?? "";
      const scheme = isObj(at(r.obj, "spec", "tls")) ? "https" : "http";
      yield configSetting({
        component,
        ...(env ? { env } : {}),
        key: `route.${r.name}`,
        value: `${scheme}://${host}${path}`,
        evidence: [r, ...(svc ? [svc] : [])].map((x) =>
          ev(repo, "infrastructure", x.file, x.line()),
        ),
      });
    }
  },
});
