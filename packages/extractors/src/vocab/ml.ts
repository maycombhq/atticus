import { normalizePath, type CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import {
  callsIn,
  descendants,
  lineOf,
  stringValue,
  withTree,
  type CodeCall,
} from "../lang/code-tree.js";
import { attrOf } from "../platform/hcl.js";
import { loadManifests, readYamlDocs } from "../platform/manifests.js";
import { loadTerraform, tfString } from "../platform/terraform.js";
import {
  arr,
  at,
  componentFor,
  deployment,
  envOf,
  int,
  resourcesOf,
  str,
} from "../platform/util.js";
import { component, endpoint, ev, lineAt, loose, own, read, slug, sources } from "./common.js";

/**
 * Machine-learning models and feature stores (ADR 0040).
 *
 * - MLflow `MLproject`: the repo's component is an `ml-model` (runtime mlflow).
 * - Model serving: KServe `InferenceService` manifests and SageMaker endpoints in Terraform
 *   (`aws_sagemaker_endpoint`) are `ml-model` components by name (runtime and Deployment
 *   platform kserve or sagemaker), each with its inference route as a REST Endpoint: KServe
 *   `POST /v1/models/<name>:predict` (or `POST /v2/models/<name>/infer` for protocol v2), where
 *   <name> is the container's `--model_name` when it sets one, else the service's name; the
 *   Deployment carries the predictor's resources and its min and max replicas as autoscaling.
 *   SageMaker `POST /endpoints/<name>/invocations`.
 * - Feast: `feature_store.yaml` is a `feature-store` DataStore owned by the repo's component,
 *   named by the host of its online store's connection (the cache cluster, which is also what
 *   Terraform calls it), else `<project>-feature-store`; each `FeatureView(name="x")` is a Table
 *   of it; features read with `get_online_features`/`get_historical_features` (`"view:feature"`
 *   strings) are db-access read loose ends of the reading component. With a Redshift offline
 *   store (`cluster_id`), each `RedshiftSource(table="t")` makes the component a reader of table
 *   `t` of that cluster's warehouse DataStore.
 */

const MLPROJECT = ["**/MLproject"];
const MANIFESTS = ["**/*.yaml", "**/*.yml"];
const FEAST = ["**/feature_store.yaml"];
const PY = ["**/*.py"];

/**
 * The name a KServe predictor serves its model under: the `--model_name` argument of its model or
 * containers (`--model_name=x` or `--model_name x`), else the InferenceService's own name.
 */
function modelName(serviceName: string, args: unknown[]): string {
  const list = args.map((a) => str(a)).filter((a): a is string => a !== undefined);
  for (const [i, a] of list.entries()) {
    const m = /^--model[_-]name(?:=(.+))?$/.exec(a);
    if (m) return (m[1] ?? list[i + 1] ?? serviceName).trim();
  }
  return serviceName;
}

/** The first host label a Feast store connection names (`harbor-features.abc.cache.example:6379,ssl=true`). */
function storeHost(connection: string | undefined): string | undefined {
  const host = connection
    ?.replace(/^\w+:\/\//, "")
    .replace(/^.*@/, "")
    .split(/[:,/]/)[0]
    ?.toLowerCase();
  if (!host || !/[a-z]/.test(host) || host === "localhost") return undefined;
  return host.split(".")[0];
}

export const mlExtractor = defineExtractor({
  id: "ml",
  version: "0.1.1",
  claims: [...MLPROJECT, ...MANIFESTS, ...PY, "**/*.tf"],
  async *scan(repo, ctx) {
    const self = own(repo, ctx);
    const components = new Map<string, CatalogRecord>();
    const addComponent = (
      id: string,
      runtime: string,
      source: "config" | "infrastructure",
      path: string,
      line?: number,
    ) => {
      const cur = components.get(id);
      if (cur) {
        (cur as unknown as Record<string, unknown>).runtime = runtime; // serving says where it runs
        cur.evidence.push(ev(repo, source, path, line));
      } else
        components.set(
          id,
          component({
            repo,
            ctx,
            id,
            type: "ml-model",
            runtime,
            source,
            path,
            ...(line ? { line } : {}),
          }),
        );
    };
    const rest: CatalogRecord[] = [];

    for (const path of await sources(repo, MLPROJECT)) {
      const text = await read(repo, ctx, path);
      if (text !== undefined && /^name\s*:/m.test(text))
        addComponent(self, "mlflow", "config", path, lineAt(text, text.search(/^name\s*:/m)));
    }

    const set = await loadManifests(repo, ctx, /InferenceService/, MANIFESTS);
    for (const o of set.objects) {
      if (o.kind !== "InferenceService" || !o.apiVersion.startsWith("serving.kserve.io/")) continue;
      const comp = componentFor(ctx, [o.labels.app, o.name]);
      const env = envOf({ namespace: o.namespace, path: o.file, name: o.name }) ?? "default";
      addComponent(comp, "kserve", "infrastructure", o.file, o.line());
      const predictor = at(o.obj, "spec", "predictor");
      const containers = arr(at(predictor, "containers"));
      const resources = resourcesOf(containers[0] ?? at(predictor, "model"));
      const min = int(at(predictor, "minReplicas"));
      const max = int(at(predictor, "maxReplicas"));
      rest.push(
        deployment({
          component: comp,
          env,
          platform: "kserve",
          ...(resources ? { resources } : {}),
          ...(max ? { autoscaling: { min: min ?? 0, max } } : {}),
          evidence: [
            ev(
              repo,
              "infrastructure",
              o.file,
              min !== undefined || max
                ? o.line(["spec", "predictor", min !== undefined ? "minReplicas" : "maxReplicas"])
                : o.line(),
            ),
          ],
        }),
      );
      const model = modelName(o.name, [
        ...arr(at(predictor, "model", "args")),
        ...containers.flatMap((c) => [...arr(at(c, "command")), ...arr(at(c, "args"))]),
      ]);
      const v2 = str(at(predictor, "model", "protocolVersion")) === "v2";
      const path = v2 ? `/v2/models/${model}/infer` : `/v1/models/${model}:predict`;
      rest.push(
        endpoint({
          repo,
          component: comp,
          endpointType: "rest",
          prefix: "inference",
          name: v2 ? "infer" : "predict",
          method: "POST",
          pathOrTopic: path,
          normalizedPath: normalizePath(path),
          source: "infrastructure",
          path: o.file,
          line: o.line(["metadata", "name"]),
        }),
      );
    }

    for (const mod of await loadTerraform(repo, ctx, /\baws_sagemaker_endpoint\b/)) {
      for (const r of mod.resources) {
        if (r.type !== "aws_sagemaker_endpoint") continue;
        const name = tfString(mod, attrOf(r.block, "name")) ?? r.name;
        const comp = componentFor(ctx, [name]);
        addComponent(comp, "sagemaker", "infrastructure", r.file, r.block.line);
        const env = envOf({ path: r.file, name }) ?? "default";
        rest.push(
          deployment({
            component: comp,
            env,
            platform: "sagemaker",
            evidence: [ev(repo, "infrastructure", r.file, r.block.line)],
          }),
        );
        const path = `/endpoints/${name}/invocations`;
        rest.push(
          endpoint({
            repo,
            component: comp,
            endpointType: "rest",
            prefix: "inference",
            name: "invocations",
            method: "POST",
            pathOrTopic: path,
            normalizedPath: normalizePath(path),
            source: "infrastructure",
            path: r.file,
            line: r.block.line,
          }),
        );
      }
    }

    // Feast
    let store: string | undefined;
    /** The warehouse a Redshift offline store reads from: its cluster, the id dbt and Terraform give it. */
    let offline: string | undefined;
    for (const path of await sources(repo, FEAST)) {
      const text = await read(repo, ctx, path);
      const doc = text !== undefined ? readYamlDocs(text)?.[0] : undefined;
      const project = str(at(doc?.value, "project"));
      if (!doc || !project) continue;
      // The feature store is its online store when that names a host (the cache cluster Terraform
      // calls the same thing), else the project's own.
      const key = ["connection_string", "host"].find(
        (k) => storeHost(str(at(doc.value, "online_store", k))) !== undefined,
      );
      const host = key ? storeHost(str(at(doc.value, "online_store", key))) : undefined;
      store = host ? slug(host) : `${slug(project)}-feature-store`;
      const cluster = str(at(doc.value, "offline_store", "cluster_id"));
      if (str(at(doc.value, "offline_store", "type")) === "redshift" && cluster)
        offline = slug(cluster);
      rest.push({
        schemaVersion: 2,
        kind: "DataStore",
        id: store,
        status: "current",
        confidence: "verified",
        storeType: "feature-store",
        ownerComponent: self,
        entitiesHeld: [],
        evidence: [ev(repo, "config", path, doc.line(key ? ["online_store", key] : ["project"]))],
      } as unknown as CatalogRecord);
    }
    for (const path of await sources(repo, PY)) {
      const text = await read(repo, ctx, path);
      if (text === undefined || !/\bfeast\b/.test(text)) continue;
      const found = await withTree("python", text, (root) => {
        const views: { name: string; line: number }[] = [];
        const sourcesRead: { table: string; line: number }[] = [];
        const reads: { view: string; line: number }[] = [];
        const kw = (c: CodeCall, k: string) => {
          const v = c.kwargs.get(k);
          const s = stringValue(v);
          return v && s !== undefined ? { value: s, line: lineOf(v.parent ?? v) } : undefined;
        };
        for (const c of callsIn(root)) {
          const name = c.name === "FeatureView" ? kw(c, "name") : undefined;
          if (name && /^[\w-]+$/.test(name.value))
            views.push({ name: name.value, line: name.line });
          const table = c.name === "RedshiftSource" ? kw(c, "table") : undefined;
          if (table && /^[\w.]+$/.test(table.value))
            sourcesRead.push({ table: table.value, line: table.line });
          if (/^get_(online|historical)_features$/.test(c.name)) {
            const named = new Set<string>();
            for (const a of [...c.args, ...c.kwargs.values()])
              for (const n of descendants(a)) {
                const v = stringValue(n);
                const m = v !== undefined ? /^([\w-]+):[\w-]+$/.exec(v) : null;
                if (m) named.add(m[1]!);
              }
            for (const view of named) reads.push({ view, line: c.line });
          }
        }
        return { views, sourcesRead, reads };
      });
      // The name argument defines the view, whatever line `FeatureView(` is on.
      if (store)
        for (const v of found.views)
          rest.push({
            schemaVersion: 2,
            kind: "Table",
            id: `${store}.${slug(v.name)}`,
            status: "current",
            confidence: "verified",
            dataStore: store,
            name: v.name,
            tableKind: "table",
            ownerComponent: self,
            readers: [],
            writers: [self],
            evidence: [ev(repo, "code", path, v.line)],
          } as unknown as CatalogRecord);
      // A Redshift source reads a table of the offline warehouse: the repo's component is a
      // reader of that table (merge joins this to the table the pipeline writes).
      if (offline)
        for (const s of found.sourcesRead) {
          const name = s.table.split(".").pop()!;
          rest.push({
            schemaVersion: 2,
            kind: "Table",
            id: `${offline}.${slug(name)}`,
            status: "current",
            confidence: "inferred",
            dataStore: offline,
            name,
            tableKind: "table",
            readers: [self],
            writers: [],
            evidence: [ev(repo, "code", path, s.line, "caller")],
          } as unknown as CatalogRecord);
        }
      for (const r of found.reads)
        rest.push(loose(repo, self, "db-access", `read ${r.view}`, path, r.line));
    }

    yield* components.values();
    yield* rest;
  },
});
