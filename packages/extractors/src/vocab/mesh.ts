import { MESH_KEY, type CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import { loadManifests, MANIFEST_GLOBS, type K8sObject } from "../platform/manifests.js";
import { arr, at, componentFor, envOf, isObj, str } from "../platform/util.js";
import { ev, setting } from "./common.js";

/**
 * Service mesh (ADR 0040). Two kinds of facts, for merge to use:
 *
 * - Membership: a Setting with key `mesh` (kind config, value the mesh: istio or linkerd) on
 *   each component whose pods get a sidecar: workloads in a namespace labelled
 *   `istio-injection: enabled` (or `istio.io/rev`) or annotated `linkerd.io/inject: enabled`,
 *   workloads whose pod template asks for injection, and the in-cluster hosts that mesh
 *   routing rules name (every VirtualService route destination, with or without a policy). Merge marks a direct synchronous call between two members `via: mesh`.
 * - Policies, as Settings of the destination component (`mesh.timeout`, `mesh.retry`,
 *   `mesh.pool`, `mesh.outlier`; per named route `mesh.<route>.<policy>`): Istio
 *   VirtualService timeouts and retries, DestinationRule connection pools (pool) and outlier
 *   detection (circuit-breaker), Linkerd ServiceProfile route timeouts, retryable routes and
 *   retry budgets. A host's component is its first label; the environment comes from the
 *   namespace.
 */

const RELEVANT =
  /istio|linkerd|\bkind["']?\s*:\s*["']?(VirtualService|DestinationRule|ServiceProfile|Namespace|Deployment|StatefulSet|DaemonSet|DeploymentConfig)\b/;
const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet", "DeploymentConfig"]);

/** `cart.shop.svc.cluster.local` or `cart` → `cart`; external hosts give nothing. */
function hostComponent(host: string | undefined): string | undefined {
  if (!host || host.includes("*")) return undefined;
  const internal = !host.includes(".") || /\.svc(\.|$)/.test(host);
  return internal ? host.split(".")[0] : undefined;
}

/** `{ a: 1, b: { c: 2 } }` → `a=1 b.c=2`, in document order. */
function flat(v: unknown, prefix = ""): string[] {
  if (!isObj(v)) return str(v) !== undefined ? [`${prefix}=${str(v)}`] : [];
  return Object.entries(v).flatMap(([k, x]) => flat(x, prefix ? `${prefix}.${k}` : k));
}

export const meshExtractor = defineExtractor({
  id: "mesh",
  version: "0.1.1",
  claims: MANIFEST_GLOBS,
  async *scan(repo, ctx) {
    const set = await loadManifests(repo, ctx, RELEVANT);
    const objs = set.objects;
    const envFor = (o: K8sObject) =>
      envOf({ namespace: o.namespace, path: o.file, name: o.name }) ?? "default";
    const evOf = (o: K8sObject, path?: (string | number)[]) =>
      ev(repo, "infrastructure", o.file, o.line(path));

    // ---- membership
    const members = new Map<
      string,
      { component: string; env: string; mesh: string; evidence: ReturnType<typeof ev>[] }
    >();
    const member = (component: string, env: string, mesh: string, e: ReturnType<typeof ev>) => {
      const key = `${component}|${env}`;
      const m = members.get(key) ?? { component, env, mesh, evidence: [] };
      if (!m.evidence.some((x) => x.path === e.path && x.line === e.line)) m.evidence.push(e);
      members.set(key, m);
    };
    const meshOfMeta = (labels: unknown, annotations: unknown): string | undefined => {
      if (str(at(labels, "istio-injection")) === "enabled" || str(at(labels, "istio.io/rev")))
        return "istio";
      if (str(at(labels, "sidecar.istio.io/inject")) === "true") return "istio";
      if (str(at(annotations, "sidecar.istio.io/inject")) === "true") return "istio";
      if (str(at(annotations, "linkerd.io/inject")) === "enabled") return "linkerd";
      return undefined;
    };
    const meshedNamespaces = new Map<string, { mesh: string; o: K8sObject }>();
    for (const o of objs) {
      if (o.kind !== "Namespace") continue;
      const mesh = meshOfMeta(
        at(o.obj, "metadata", "labels"),
        at(o.obj, "metadata", "annotations"),
      );
      if (mesh) meshedNamespaces.set(o.name, { mesh, o });
    }
    for (const o of objs) {
      if (!WORKLOADS.has(o.kind)) continue;
      const pod = at(o.obj, "spec", "template", "metadata");
      const own = meshOfMeta(at(pod, "labels"), at(pod, "annotations"));
      const ns = o.namespace ? meshedNamespaces.get(o.namespace) : undefined;
      const mesh = own ?? ns?.mesh;
      if (!mesh) continue;
      const component = componentFor(ctx, [
        o.labels.app,
        o.labels["app.kubernetes.io/name"],
        o.name,
      ]);
      if (ns && !own) member(component, envFor(o), mesh, evOf(ns.o));
      member(component, envFor(o), mesh, evOf(o));
    }

    // ---- policies
    const out: CatalogRecord[] = [];
    const policy = (
      o: K8sObject,
      host: string | undefined,
      settingKind: "timeout" | "retry" | "pool" | "circuit-breaker",
      key: string,
      value: string,
      line: (string | number)[],
      mesh: string,
    ) => {
      const c = hostComponent(host);
      if (!c) return;
      const component = componentFor(ctx, [c]);
      member(component, envFor(o), mesh, evOf(o));
      out.push(
        setting({
          repo,
          component,
          env: envFor(o),
          settingKind,
          key,
          value,
          source: "infrastructure",
          path: o.file,
          line: o.line(line),
        }),
      );
    };
    for (const o of objs) {
      if (o.kind === "VirtualService" && o.apiVersion.startsWith("networking.istio.io/")) {
        // A routing rule names the services it sends traffic to, whether or not it sets a
        // timeout or retries: those services are in the mesh.
        for (const proto of ["http", "tls", "tcp"])
          for (const rule of arr(at(o.obj, "spec", proto)))
            for (const r of arr(at(rule, "route"))) {
              const c = hostComponent(str(at(r, "destination", "host")));
              if (c) member(componentFor(ctx, [c]), envFor(o), "istio", evOf(o));
            }
        arr(at(o.obj, "spec", "http")).forEach((h, i) => {
          const name = str(at(h, "name"));
          const k = (p: string) => (name ? `mesh.${name}.${p}` : `mesh.${p}`);
          const dest =
            str(at(h, "route", 0, "destination", "host")) ?? str(at(o.obj, "spec", "hosts", 0));
          const timeout = str(at(h, "timeout"));
          if (timeout)
            policy(
              o,
              dest,
              "timeout",
              k("timeout"),
              timeout,
              ["spec", "http", i, "timeout"],
              "istio",
            );
          const retries = at(h, "retries");
          if (isObj(retries))
            policy(
              o,
              dest,
              "retry",
              k("retry"),
              flat(retries).join(" "),
              ["spec", "http", i, "retries"],
              "istio",
            );
        });
      } else if (o.kind === "DestinationRule" && o.apiVersion.startsWith("networking.istio.io/")) {
        const host = str(at(o.obj, "spec", "host"));
        const pool = at(o.obj, "spec", "trafficPolicy", "connectionPool");
        if (isObj(pool))
          policy(
            o,
            host,
            "pool",
            "mesh.pool",
            flat(pool).join(" "),
            ["spec", "trafficPolicy", "connectionPool"],
            "istio",
          );
        const outlier = at(o.obj, "spec", "trafficPolicy", "outlierDetection");
        if (isObj(outlier))
          policy(
            o,
            host,
            "circuit-breaker",
            "mesh.outlier",
            flat(outlier).join(" "),
            ["spec", "trafficPolicy", "outlierDetection"],
            "istio",
          );
      } else if (o.kind === "ServiceProfile" && o.apiVersion.startsWith("linkerd.io/")) {
        arr(at(o.obj, "spec", "routes")).forEach((r, i) => {
          const name = str(at(r, "name")) ?? `route-${i + 1}`;
          const timeout = str(at(r, "timeout"));
          if (timeout)
            policy(
              o,
              o.name,
              "timeout",
              `mesh.${name}.timeout`,
              timeout,
              ["spec", "routes", i, "timeout"],
              "linkerd",
            );
          if (at(r, "isRetryable") === true)
            policy(
              o,
              o.name,
              "retry",
              `mesh.${name}.retry`,
              "retryable",
              ["spec", "routes", i, "isRetryable"],
              "linkerd",
            );
        });
        const budget = at(o.obj, "spec", "retryBudget");
        if (isObj(budget))
          policy(
            o,
            o.name,
            "retry",
            "mesh.retry-budget",
            flat(budget).join(" "),
            ["spec", "retryBudget"],
            "linkerd",
          );
      }
    }

    for (const m of members.values()) {
      const s = setting({
        repo,
        component: m.component,
        env: m.env,
        settingKind: "config",
        key: MESH_KEY,
        value: m.mesh,
        source: "infrastructure",
        path: m.evidence[0]!.path,
        line: m.evidence[0]!.line,
      });
      s.evidence = m.evidence;
      yield s;
    }
    yield* out;
  },
});
