import { defineExtractor } from "@maycombhq/sdk";
import {
  loadManifests,
  MANIFEST_GLOBS,
  sameScope,
  selects,
  type K8sObject,
} from "../platform/manifests.js";
import {
  arr,
  at,
  componentFor,
  deployment,
  envOf,
  isObj,
  str,
  type IngressRoute,
} from "../platform/util.js";
import { ev } from "./common.js";

/**
 * Ingress routes (ADR 0040): Kubernetes `Ingress` rules and Gateway API `HTTPRoute`s become
 * `Deployment.ingress` entries `{ host, path, tls }` of the deployment behind the Service they
 * send traffic to (the workload the Service selects, else a component named after the
 * Service). An Ingress host listed under `spec.tls` is TLS; an HTTPRoute is TLS when a parent
 * Gateway in the repo has an HTTPS or TLS listener, and says nothing about TLS otherwise.
 * An Istio `VirtualService` bound to a Gateway (`spec.gateways`, not just `mesh`) publishes each
 * of its literal hosts there: the path is the URI prefix (or exact path) its rule matches, the
 * deployment is the destination host's service, and the route is TLS when a server of the
 * Gateway that covers the host speaks HTTPS or TLS. A VirtualService with no Gateway is
 * in-mesh routing, not ingress. Manifests of other kinds (Services, workloads, Gateways) are read
 * from any file of the repo, not only the one holding the route. The
 * Deployment carries only the routes (platform kubernetes, or openshift for a
 * DeploymentConfig); merge joins it to the full Deployment of the same id.
 */

const RELEVANT =
  /\bkind["']?\s*:\s*["']?(Ingress|HTTPRoute|VirtualService|Gateway|Service|Deployment|DeploymentConfig|StatefulSet)\b/;
const WORKLOADS = new Set(["Deployment", "DeploymentConfig", "StatefulSet"]);

const labelsOf = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (isObj(v)) for (const [k, x] of Object.entries(v)) if (str(x) !== undefined) out[k] = str(x)!;
  return out;
};

/** Whether a Gateway server's host entry (`host`, `ns/host`, `*`, `*.example.com`) covers `host`. */
function serverHostMatches(entry: string | undefined, host: string): boolean {
  const pattern = entry?.includes("/") ? entry.slice(entry.indexOf("/") + 1) : entry;
  if (!pattern) return false;
  if (pattern === "*") return true;
  return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : pattern === host;
}

export const ingressExtractor = defineExtractor({
  id: "ingress",
  version: "0.1.1",
  claims: MANIFEST_GLOBS,
  async *scan(repo, ctx) {
    const set = await loadManifests(repo, ctx, RELEVANT);
    const objs = set.objects;
    const services = objs.filter((o) => o.kind === "Service" && o.apiVersion === "v1");
    const workloads = objs.filter((o) => WORKLOADS.has(o.kind));
    const byKey = new Map<
      string,
      {
        component: string;
        env: string;
        platform: string;
        routes: IngressRoute[];
        objs: K8sObject[];
      }
    >();

    const route = (
      from: K8sObject,
      serviceName: string | undefined,
      r: IngressRoute,
      extra: K8sObject[] = [],
    ) => {
      if (!serviceName) return;
      const svc = services.find((s) => s.name === serviceName && sameScope(s, from));
      const selector = at(svc?.obj, "spec", "selector");
      const w =
        svc && isObj(selector) && Object.keys(selector).length > 0
          ? workloads.find(
              (x) =>
                sameScope(x, svc) &&
                selects(selector, labelsOf(at(x.obj, "spec", "template", "metadata", "labels"))),
            )
          : undefined;
      const component = componentFor(
        ctx,
        w ? [w.labels.app, w.labels["app.kubernetes.io/name"], w.name] : [serviceName],
      );
      const env =
        envOf({ namespace: (w ?? from).namespace, path: (w ?? from).file, name: w?.name }) ??
        "default";
      const key = `${component}|${env}`;
      const e = byKey.get(key) ?? {
        component,
        env,
        platform: w?.kind === "DeploymentConfig" ? "openshift" : "kubernetes",
        routes: [],
        objs: [],
      };
      if (!e.routes.some((x) => x.host === r.host && x.path === r.path)) e.routes.push(r);
      for (const o of [from, ...(svc ? [svc] : []), ...extra])
        if (!e.objs.includes(o)) e.objs.push(o);
      byKey.set(key, e);
    };

    for (const o of objs) {
      if (o.kind === "Ingress" && o.apiVersion.startsWith("networking.k8s.io/")) {
        const tlsHosts = new Set(
          arr(at(o.obj, "spec", "tls")).flatMap((t) => arr(at(t, "hosts")).map((h) => str(h))),
        );
        for (const rule of arr(at(o.obj, "spec", "rules"))) {
          const host = str(at(rule, "host"));
          if (!host) continue;
          for (const p of arr(at(rule, "http", "paths"))) {
            const path = str(at(p, "path"));
            route(o, str(at(p, "backend", "service", "name")), {
              host,
              ...(path ? { path } : {}),
              tls: tlsHosts.has(host),
            });
          }
        }
      } else if (o.kind === "HTTPRoute" && o.apiVersion.startsWith("gateway.networking.k8s.io/")) {
        const gateways = arr(at(o.obj, "spec", "parentRefs"))
          .map((p) =>
            objs.find(
              (g) => g.kind === "Gateway" && g.name === str(at(p, "name")) && sameScope(g, o),
            ),
          )
          .filter((g): g is K8sObject => !!g);
        const tls = gateways.some((g) =>
          arr(at(g.obj, "spec", "listeners")).some((l) =>
            /^(HTTPS|TLS)$/.test(str(at(l, "protocol")) ?? ""),
          ),
        );
        for (const host of arr(at(o.obj, "spec", "hostnames"))
          .map((h) => str(h))
          .filter((h): h is string => !!h))
          for (const rule of arr(at(o.obj, "spec", "rules"))) {
            const paths = arr(at(rule, "matches")).map((m) => str(at(m, "path", "value")));
            for (const path of paths.length ? paths : [undefined])
              for (const b of arr(at(rule, "backendRefs")))
                route(
                  o,
                  str(at(b, "name")),
                  { host, ...(path ? { path } : {}), ...(tls ? { tls: true } : {}) },
                  gateways,
                );
          }
      } else if (o.kind === "VirtualService" && o.apiVersion.startsWith("networking.istio.io/")) {
        // A VirtualService bound to a Gateway (not just the mesh) publishes its hosts there.
        const gateways = arr(at(o.obj, "spec", "gateways"))
          .map((g) => str(g))
          .filter((g): g is string => !!g && g !== "mesh")
          .map((ref) => {
            const [ns, name] = ref.includes("/") ? ref.split("/") : [undefined, ref];
            return objs.find(
              (g) =>
                g.kind === "Gateway" &&
                g.apiVersion.startsWith("networking.istio.io/") &&
                g.name === name &&
                (ns === undefined || g.namespace === ns),
            );
          })
          .filter((g): g is K8sObject => !!g);
        if (gateways.length === 0) continue;
        for (const host of arr(at(o.obj, "spec", "hosts"))
          .map((h) => str(h))
          .filter((h): h is string => !!h && !h.includes("*"))) {
          const tls = gateways.some((g) =>
            arr(at(g.obj, "spec", "servers")).some(
              (s) =>
                /^(HTTPS|TLS)$/.test(str(at(s, "port", "protocol")) ?? "") &&
                arr(at(s, "hosts")).some((h) => serverHostMatches(str(h), host)),
            ),
          );
          for (const rule of arr(at(o.obj, "spec", "http"))) {
            const paths = arr(at(rule, "match"))
              .map((m) => str(at(m, "uri", "prefix")) ?? str(at(m, "uri", "exact")))
              .filter((p): p is string => !!p);
            for (const path of paths.length ? paths : [undefined])
              for (const d of arr(at(rule, "route")))
                route(
                  o,
                  str(at(d, "destination", "host"))?.split(".")[0],
                  { host, ...(path ? { path } : {}), ...(tls ? { tls: true } : {}) },
                  gateways,
                );
          }
        }
      }
    }

    for (const e of byKey.values())
      yield deployment({
        component: e.component,
        env: e.env,
        platform: e.platform,
        ingress: e.routes,
        evidence: e.objs.map((x) => ev(repo, "infrastructure", x.file, x.line())),
      });
  },
});
